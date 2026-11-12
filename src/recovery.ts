/**
 * recovery.ts — M1.2.4 确定性 Replay 与启动恢复
 *
 * 核心目标：
 *   进程正常关闭 / 异常退出 / 崩溃重启后，仅凭 PostgreSQL 中已成功提交的
 *   事件日志，确定性地恢复到最后一个已持久化事件所代表的状态。
 *
 * 确定性红线（本模块全部遵守）：
 * - 不调用 LLM 重新生成历史判断（本模块不 import llm.ts）
 * - 不读取传感器重建历史数据（本模块不 import sensors.ts）
 * - 不使用 Date.now() / Math.random() 生成历史状态；
 *   状态演化中的噪声由 state.ts 内部以 hashString(event.id) 派生，天然可复现
 * - 不丢弃、不重复应用已提交事件（数据库按 sequence 全量读取，逐条应用一次）
 * - 恢复失败绝不伪装成全新身份：verdict='invalid' 时调用方必须阻止启动
 *
 * 派生运行时状态的 A/B/C 分类（本模块只负责 A 类）：
 * - A. 可从事件日志确定性恢复：MarrowState 全部字段、lastEventTimestamp、
 *      eventCount —— 由 replayPersistedEvents 产出
 * - B. 只属于当前进程的临时状态：TickSession.lastTickTime / tickCount、
 *      状态历史缓冲区、ObservationInbox、RuntimeSession 队列 ——
 *      重启后按本次启动重新初始化，不写入 Replay
 * - C. 无法从历史事件恢复的外部状态：崩溃前未确认（未持久化）的 Observation、
 *      LLM 连接 —— 明确不补造、不伪造
 *
 * 停机时间规则（重要边界）：
 *   恢复只回到「最后一个已持久化事件」的状态；两次运行之间的停机期间
 *   不模拟任何身体恢复 / 情绪变化 / 关系变化 / 记忆变化（停机补偿属于
 *   后续独立设计）。新 Tick 的时间基准从本次进程启动时刻起算，
 *   lastTickTime=启动时刻 是本阶段有意为之的语义，不是缺陷。
 */
import type postgres from 'postgres';
import {
  VALID_OBSERVATION_SOURCES,
  type EventType,
  type GenesisEvent,
} from './events.js';
import {
  applyEvent,
  applyGenesis,
  createInitialState,
  type MarrowState,
} from './state.js';
import {
  ENGINE_VERSION,
  IDENTITY_ID,
  SCHEMA_VERSION,
  appendEvents,
  canonicalize,
  loadEventRows,
  type PersistedEventRow,
} from './storage.js';
import { getDb } from './db/connection.js';
import { verifyEventChain } from './verify-chain.js';
import { validateExperienceValenceFields } from './experience-valence.js';

// ==================================================================
// 错误与结果类型
// ==================================================================

/** 恢复失败的可定位错误类型 */
export type ReplayErrorKind =
  /** 启动前置的哈希链验证失败（篡改 / 断链 / 分叉 / 版本字段异常等） */
  | 'chain_verification_failed'
  /** 数据库读取失败（连接不可达、查询错误等） */
  | 'store_read_failed'
  /** 事件类型不在已知判别联合内（拒绝静默跳过） */
  | 'unknown_event_type'
  /** 必要 payload 字段缺失或非法（拒绝随意默认值兜底） */
  | 'invalid_payload'
  /** 历史 schema_version 不在支持集合内 */
  | 'unsupported_schema_version'
  /** 历史 engine_version 不在支持集合内 */
  | 'unsupported_engine_version'
  /** 显式回复关联 replyToEventId 指向非法目标（不存在 / 跨 identity / 非 user_input / 不在之前） */
  | 'invalid_reference'
  /** 恢复出的最终状态违反状态不变量（量程 / 有限性） */
  | 'state_invariant_violation';

/** 单条恢复错误，携带精确定位信息 */
export interface ReplayError {
  identityId: string;
  /** 出错行的 sequence（字符串避免 BIGINT 精度问题；链级错误为 null） */
  sequence: string | null;
  eventId: string | null;
  eventType: string | null;
  schemaVersion: number | null;
  engineVersion: string | null;
  kind: ReplayErrorKind;
  message: string;
}

/** Replay / 恢复结果 */
export interface ReplayResult {
  identityId: string;
  /**
   * - valid：完整恢复成功
   * - empty：没有持久化事件，属于合法的新身份状态（不是恢复失败）
   * - invalid：历史事件损坏或无法恢复（必须阻止正常启动）
   */
  verdict: 'valid' | 'empty' | 'invalid';
  eventCount: number;
  firstSequence: string | null;
  lastSequence: string | null;
  /** 恢复出的最终状态（empty / invalid 时为 null） */
  finalState: MarrowState | null;
  /** 最后一个已持久化事件的事件时间（empty / invalid 时为 null） */
  lastEventTimestamp: string | null;
  /** 执行本次恢复的引擎 / schema 版本（当前运行代码的版本） */
  engineVersion: string;
  schemaVersion: number;
  errors: ReplayError[];
}

/** 恢复失败异常：携带完整 ReplayResult，供启动流程记录后拒绝启动 */
export class RecoveryError extends Error {
  readonly code = 'recovery_failed' as const;
  readonly result: ReplayResult;

  constructor(result: ReplayResult) {
    super(
      `身份 ${result.identityId} 恢复失败（${result.errors.length} 个错误）：` +
        (result.errors[0]
          ? `[${result.errors[0].kind}] ${result.errors[0].message}`
          : '未知错误'),
    );
    this.name = 'RecoveryError';
    this.result = result;
  }
}

// ==================================================================
// 历史版本兼容策略（显式定义，非猜测性转换）
// ==================================================================

/**
 * 支持的 schema_version 集合。
 *
 * 策略说明（D 阶段版本感知规则的延续）：
 * - schema 2：当前版本，V2 判别联合 payload 语义
 * - schema 1：早期 M1.2 PG 写入的未打版本行，payload 同为 V2 判别联合格式
 *   （V1 JSONL 历史数据遵循 Fresh Start 策略从未导入 PG，
 *   因此 PG 中不存在 V1 格式事件，schema 1 可按同一 payload 语义解释）
 * - 其他版本：没有经设计确认的转换规则，明确拒绝恢复，
 *   绝不编写猜测性的升级逻辑
 */
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/**
 * 支持的 engine_version 判定：
 * - null：早期未打版本行（与 schema 1 同期的合法历史形态）
 * - 'marrow@' 前缀：本项目引擎写入
 * 其他取值（包括其他引擎写入的事件）明确拒绝。
 */
function isSupportedEngineVersion(engineVersion: string | null): boolean {
  return engineVersion === null || engineVersion.startsWith('marrow@');
}

// ==================================================================
// 事件 payload 校验（逐类型，缺失必要字段即失败，不用默认值兜底）
// ==================================================================

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'genesis',
  'tick',
  'interruption',
  'environment',
  'dialogue',
  'memory_evocation',
  'memory_formation',
  'sleep',
  'trait_shift',
  'observation',
  'appraisal',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * memory_formation payload 契约校验（纯函数，可测试）。
 * 返回 null 表示通过，返回 string 表示错误消息。
 *
 * 覆盖 EpisodicMemory 完整必需字段 + sourceDialogueEventId 与
 * memory.sourceEventId 一致性约束。
 */
export function validateMemoryFormationPayload(payload: unknown): string | null {
  if (!isPlainObject(payload)) return 'memory_formation payload 不是对象';
  const p = payload as Record<string, unknown>;
  if (!isNonEmptyString(p.sourceDialogueEventId)) return 'memory_formation 缺少 sourceDialogueEventId';
  const mem = p.memory;
  if (!isPlainObject(mem)) return 'memory_formation 缺少 payload.memory 对象';
  if (!isNonEmptyString(mem.id)) return 'memory_formation 缺少 memory.id';
  if (!isNonEmptyString(mem.timestamp)) return 'memory_formation 缺少 memory.timestamp';
  if (!isNonEmptyString(mem.summary)) return 'memory_formation 缺少 memory.summary';
  if (!Array.isArray(mem.keywords) || mem.keywords.length === 0) return 'memory_formation 缺少 memory.keywords';
  if (!mem.keywords.every((k: unknown) => typeof k === 'string')) return 'memory_formation memory.keywords 包含非 string 元素';
  if (!isFiniteNumber(mem.valence)) return 'memory_formation 缺少 memory.valence';
  if (!isFiniteNumber(mem.salience)) return 'memory_formation 缺少 memory.salience';
  if (!isNonEmptyString(mem.sourceEventId)) return 'memory_formation 缺少 memory.sourceEventId';
  if (typeof mem.isTrauma !== 'boolean') return 'memory_formation 缺少 memory.isTrauma';
  if (p.sourceDialogueEventId !== mem.sourceEventId) {
    return 'memory_formation.sourceDialogueEventId 与 memory.sourceEventId 不一致';
  }
  return null;
}

/**
 * 校验单行事件是否可被确定性 Replay。
 *
 * 通过条件（全部满足）：
 * 1. payload 是纯对象，id / timestamp 非空且 timestamp 可解析
 * 2. type 属于已知 9 种事件类型
 * 3. schema_version / engine_version 在支持集合内
 * 4. 按类型的必要 payload 字段齐全且为有限数值 / 合法枚举
 *
 * @returns 校验失败时返回错误消息（不含 kind，由调用方按失败点归类）
 */
function validateRowForReplay(row: PersistedEventRow): ReplayError | null {
  const at = `sequence=${row.sequence} event_id=${row.event_id}`;
  const base = {
    identityId: row.identity_id,
    sequence: row.sequence,
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
  };
  const fail = (kind: ReplayErrorKind, message: string): ReplayError => ({
    ...base,
    kind,
    message: `${message}（${at}）`,
  });

  // ---- 版本兼容（先于 payload 解释：旧版本未经确认不得按当前规则解释） ----
  if (!SUPPORTED_SCHEMA_VERSIONS.has(row.schema_version)) {
    return fail(
      'unsupported_schema_version',
      `不支持的 schema_version=${row.schema_version}（支持集合: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}）`,
    );
  }
  if (!isSupportedEngineVersion(row.engine_version)) {
    return fail(
      'unsupported_engine_version',
      `不支持的 engine_version=${String(row.engine_version)}`,
    );
  }

  // ---- payload 基础结构 ----
  const event = row.payload as unknown;
  if (!isPlainObject(event)) {
    return fail('invalid_payload', 'payload 不是纯对象');
  }
  if (!isNonEmptyString(event.id)) {
    return fail('invalid_payload', 'payload.id 缺失或为空');
  }
  if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) {
    return fail('invalid_payload', 'payload.timestamp 缺失或不可解析');
  }
  if (typeof event.type !== 'string' || !KNOWN_EVENT_TYPES.has(event.type as EventType)) {
    return fail(
      'unknown_event_type',
      `未知事件类型 ${String(event.type)}（拒绝静默跳过）`,
    );
  }
  const payload = event.payload;
  if (!isPlainObject(payload)) {
    return fail('invalid_payload', `事件 ${event.type} 缺少 payload 对象`);
  }

  // ---- 按类型的必要字段校验 ----
  // 说明：PG 中的全部事件都由 V2 代码写入，必要字段必然存在；
  // 这里严格校验而不是用默认值兜底，是为了让「数据损坏 / 未知来源写入」
  // 在启动时明确暴露，而不是被静默吞掉后产出错误状态。
  switch (event.type as EventType) {
    case 'genesis': {
      // 校验 DB 反序列化的 payload 对象的字段存在性——这里不假设具体 TS 类型，
      // 因为 DB JSONB 可以包含任何东西；使用 any 是有意为之：只要字段缺失即 fail-closed
      const s: any = payload.initialState;
      if (
        !s ||
        typeof s !== 'object' ||
        !isFiniteNumber(s.energy) ||
        !isFiniteNumber(s.moodBaseline) ||
        !isFiniteNumber(s.arousal) ||
        typeof s.interruptionFlag !== 'boolean' ||
        !isFiniteNumber(s.trust) ||
        !isFiniteNumber(s.defensiveness) ||
        !isFiniteNumber(s.cognitiveLoad) ||
        !isFiniteNumber(s.associationWeight) ||
        !s.traits ||
        typeof s.traits !== 'object' ||
        !isFiniteNumber(s.traits.neuroticism) ||
        !isFiniteNumber(s.traits.agreeableness) ||
        !isFiniteNumber(s.traits.extraversion) ||
        !isFiniteNumber(s.traits.resilience) ||
        !isFiniteNumber(s.batteryLevel) ||
        !isFiniteNumber(s.attentionFocus) ||
        !isFiniteNumber(s.socialHunger) ||
        !Array.isArray(s.associations) ||
        !Array.isArray(s.episodicBuffer) ||
        !isFiniteNumber(s.interruptionScars) ||
        !isFiniteNumber(s.needValidation) ||
        !isFiniteNumber(s.needNovelty) ||
        !isFiniteNumber(s.needSecurity) ||
        typeof s.sleeping !== 'boolean' ||
        !isFiniteNumber(s.uptimeSeconds) ||
        !isFiniteNumber(s.interruptionCount)
      ) {
        return fail('invalid_payload', 'genesis.initialState 缺少必要字段或类型错误');
      }
      if (!isFiniteNumber(payload.configVersion)) {
        return fail('invalid_payload', 'genesis 缺少 configVersion');
      }
      if (!isNonEmptyString(payload.initializedBy)) {
        return fail('invalid_payload', 'genesis 缺少 initializedBy');
      }
      if (!Array.isArray(payload.seedEpisodicIds)) {
        return fail('invalid_payload', 'genesis 缺少 seedEpisodicIds 数组');
      }
      return null;
    }

    case 'tick':
      if (!isFiniteNumber(payload.deltaSeconds)) {
        return fail('invalid_payload', 'tick 缺少有限数值 payload.deltaSeconds');
      }
      return null;

    case 'interruption':
      if (!isNonEmptyString(payload.reason)) {
        return fail('invalid_payload', 'interruption 缺少 payload.reason');
      }
      if (
        !isFiniteNumber(payload.energyAtInterruption) ||
        !isFiniteNumber(payload.moodBaselineAtInterruption) ||
        !isFiniteNumber(payload.arousalAtInterruption)
      ) {
        return fail('invalid_payload', 'interruption 缺少中断时刻状态快照数值');
      }
      if (typeof payload.lastBehavior !== 'string') {
        return fail('invalid_payload', 'interruption 缺少 payload.lastBehavior');
      }
      return null;

    case 'environment':
      if (!isNonEmptyString(payload.feature)) {
        return fail('invalid_payload', 'environment 缺少 payload.feature');
      }
      if (
        !isFiniteNumber(payload.reading) ||
        !isFiniteNumber(payload.moodDelta) ||
        !isFiniteNumber(payload.salience)
      ) {
        return fail('invalid_payload', 'environment 缺少 reading/moodDelta/salience 数值');
      }
      return null;

    case 'dialogue': {
      if (payload.direction !== 'user_input' && payload.direction !== 'companion_output') {
        return fail('invalid_payload', 'dialogue 的 direction 非法');
      }
      if (typeof payload.text !== 'string') {
        return fail('invalid_payload', 'dialogue 缺少 payload.text');
      }
      // moodDelta 是对话效价的事实记录，缺失时绝不用 appraise 重算兜底——
      // 重算依赖当前代码版本，会让同一历史事件在不同版本下恢复出不同状态
      if (!isFiniteNumber(payload.moodDelta) || !isFiniteNumber(payload.salience)) {
        return fail('invalid_payload', 'dialogue 缺少 moodDelta/salience 数值');
      }
      // M1.5.4.2 第一层（Payload Validation）：显式回复关联字段
      // - 历史事件缺失该字段是合法状态（不补齐、不推断）
      // - 只允许 companion_output 携带；user_input 携带一律拒绝
      // - 值必须是非空字符串（null / 非字符串 / 空串 / 纯空白均拒绝）
      // 目标是否存在 / 是否在前 / 是否同 identity / 是否为 user_input
      // 属于第二层 Identity-level Referential Validation（见 replayPersistedEvents）
      if (Object.prototype.hasOwnProperty.call(payload, 'replyToEventId')) {
        const replyTo = payload.replyToEventId;
        if (payload.direction !== 'companion_output') {
          return fail(
            'invalid_payload',
            'dialogue.replyToEventId 仅允许出现在 companion_output（user_input 不得携带）',
          );
        }
        if (typeof replyTo !== 'string' || replyTo.length === 0) {
          return fail('invalid_payload', 'dialogue.replyToEventId 必须是非空字符串');
        }
        if (replyTo.trim().length === 0) {
          return fail('invalid_payload', 'dialogue.replyToEventId 不得为纯空白字符串');
        }
      }
      return null;
    }

    case 'memory_evocation':
      if (
        !isNonEmptyString(payload.memoryId) ||
        typeof payload.cue !== 'string' ||
        typeof payload.summary !== 'string'
      ) {
        return fail('invalid_payload', 'memory_evocation 缺少 memoryId/cue/summary');
      }
      if (
        !isFiniteNumber(payload.valence) ||
        !isFiniteNumber(payload.salience) ||
        !isFiniteNumber(payload.moodDelta) ||
        !isFiniteNumber(payload.energyDelta)
      ) {
        return fail('invalid_payload', 'memory_evocation 缺少 valence/salience/moodDelta/energyDelta');
      }
      return null;

    case 'memory_formation': {
      const err = validateMemoryFormationPayload(payload);
      if (err) return fail('invalid_payload', err);
      return null;
    }

    case 'sleep':
      if (typeof payload.entering !== 'boolean') {
        return fail('invalid_payload', 'sleep 缺少布尔 payload.entering');
      }
      return null;

    case 'trait_shift':
      if (!isPlainObject(payload.shift)) {
        return fail('invalid_payload', 'trait_shift 缺少 payload.shift 对象');
      }
      for (const key of ['neuroticism', 'agreeableness', 'extraversion', 'resilience']) {
        const v = payload.shift[key];
        if (v !== undefined && !isFiniteNumber(v)) {
          return fail('invalid_payload', `trait_shift.shift.${key} 不是有限数值`);
        }
      }
      if (typeof payload.reason !== 'string') {
        return fail('invalid_payload', 'trait_shift 缺少 payload.reason');
      }
      return null;

    case 'observation':
      // source 合法性校验必须与 events.ts 的 VALID_OBSERVATION_SOURCES 保持同源——
      // 不允许 recovery 放宽为任意字符串，恢复层严格 fail-closed
      if (
        typeof payload.source !== 'string' ||
        !VALID_OBSERVATION_SOURCES.includes(payload.source) ||
        typeof payload.content !== 'string'
      ) {
        return fail(
          'invalid_payload',
          `observation.source="${String(payload.source)}" 不在合法集合 ${JSON.stringify(VALID_OBSERVATION_SOURCES)} 内，或缺少 content`,
        );
      }
      if (!isFiniteNumber(payload.confidence) || !isFiniteNumber(payload.uncertainty)) {
        return fail('invalid_payload', 'observation 缺少 confidence/uncertainty');
      }
      if (!Array.isArray(payload.facts)) {
        return fail('invalid_payload', 'observation 缺少 facts 数组');
      }
      for (const fact of payload.facts) {
        if (!isPlainObject(fact) || typeof fact.claim !== 'string' || !isFiniteNumber(fact.confidence)) {
          return fail('invalid_payload', 'observation.facts 元素缺少 claim/confidence');
        }
      }
      if (typeof payload.extractorVersion !== 'string') {
        return fail('invalid_payload', 'observation 缺少 extractorVersion');
      }
      // M1.5.4.1：体验性质字段的可选校验（旧事件缺失合法；存在则必须自洽）
      // 规则与提取阶段共用同一纯函数，不重复维护第二套语义。
      const valenceError = validateExperienceValenceFields(payload);
      if (valenceError) {
        return fail('invalid_payload', valenceError);
      }
      return null;

    case 'appraisal':
      if (typeof payload.sourceObservationId !== 'string') {
        return fail('invalid_payload', 'appraisal 缺少 sourceObservationId');
      }
      if (
        !isFiniteNumber(payload.valenceDelta) ||
        !isFiniteNumber(payload.arousalDelta) ||
        !isFiniteNumber(payload.energyDelta) ||
        !isFiniteNumber(payload.confidence)
      ) {
        return fail('invalid_payload', 'appraisal 缺少 valenceDelta/arousalDelta/energyDelta/confidence');
      }
      if (!Array.isArray(payload.evidenceAssociationIds)) {
        return fail('invalid_payload', 'appraisal 缺少 evidenceAssociationIds 数组');
      }
      return null;
  }
}

// ==================================================================
// 恢复状态不变量校验
// ==================================================================

/** 数值量程（与 state.ts 的 clamp 边界一致） */
const STATE_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['energy', 0, 100],
  ['moodBaseline', 0, 100],
  ['arousal', 0, 100],
  ['trust', 0, 100],
  ['defensiveness', 0, 100],
  ['cognitiveLoad', 0, 100],
  ['batteryLevel', 0, 100],
  ['attentionFocus', 0, 1],
  ['socialHunger', 0, 100],
  ['needValidation', 0, 100],
  ['needNovelty', 0, 100],
  ['needSecurity', 0, 100],
];

/**
 * 校验恢复出的最终状态满足状态不变量。
 * 任何字段越界 / 非有限都说明事件流或转移逻辑已损坏，必须拒绝启动。
 */
function validateRecoveredState(state: MarrowState): string | null {
  for (const [field, min, max] of STATE_RANGES) {
    const value = state[field as keyof MarrowState];
    if (!isFiniteNumber(value) || value < min || value > max) {
      return `状态字段 ${field}=${String(value)} 越出量程 [${min}, ${max}]`;
    }
  }
  if (!isFiniteNumber(state.associationWeight) || state.associationWeight <= 0) {
    return `associationWeight=${String(state.associationWeight)} 非法`;
  }
  if (!isFiniteNumber(state.uptimeSeconds) || state.uptimeSeconds < 0) {
    return `uptimeSeconds=${String(state.uptimeSeconds)} 非法`;
  }
  for (const key of ['neuroticism', 'agreeableness', 'extraversion', 'resilience'] as const) {
    const v = state.traits[key];
    if (!isFiniteNumber(v) || v < 0.5 || v > 2.0) {
      return `traits.${key}=${String(v)} 越出 [0.5, 2.0]`;
    }
  }
  if (Number.isNaN(Date.parse(state.lastUpdated))) {
    return `lastUpdated=${state.lastUpdated} 不可解析`;
  }
  return null;
}

// ==================================================================
// 确定性 Replay
// ==================================================================

// ==================================================================
// 显式回复关联：第二层 Identity-level Referential Validation（M1.5.4.2）
// ==================================================================

/**
 * 读取 companion_output 事件携带的 replyToEventId。
 *
 * 第一层 validateRowForReplay 已保证该字段若存在必为非空字符串，
 * 这里只负责提取；其它事件类型返回 null。
 */
function readReplyToEventId(row: PersistedEventRow): string | null {
  if (row.event_type !== 'dialogue') return null;
  const event = row.payload as unknown;
  if (!isPlainObject(event)) return null;
  const payload = event.payload;
  if (!isPlainObject(payload)) return null;
  if (payload.direction !== 'companion_output') return null;
  const raw = payload.replyToEventId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** 构造引用校验失败错误（携带精确定位） */
function replyReferenceError(row: PersistedEventRow, message: string): ReplayError {
  return {
    identityId: row.identity_id,
    sequence: row.sequence,
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    kind: 'invalid_reference',
    message: `${message}（sequence=${row.sequence} event_id=${row.event_id}）`,
  };
}

/**
 * 判断某行是否为 DialogueEvent(direction='user_input')。
 * 只用于建立已见事件索引，不参与状态演化。
 */
function isUserInputRow(row: PersistedEventRow): boolean {
  if (row.event_type !== 'dialogue') return false;
  const event = row.payload as unknown;
  if (!isPlainObject(event)) return false;
  const payload = event.payload;
  return isPlainObject(payload) && payload.direction === 'user_input';
}

/**
 * 从持久化事件行确定性重建状态（纯函数，不访问数据库 / LLM / 传感器）。
 *
 * 相同 identityId + 相同事件序列 + 相同版本 + 相同兼容规则
 *   ⇒ 最终恢复状态 deepEqual。
 *
 * 逐事件处理规则：
 * - 顺序严格遵循数据库 sequence（调用方必须已按 sequence ASC 排序）
 * - 每条事件先经 validateRowForReplay 校验，再交给 state.ts applyEvent
 * - 首个错误即返回 invalid（错误携带精确定位），绝不静默跳过、
 *   绝不用默认值兜底、绝不重复应用
 * - 初始状态以首条事件的时间戳构建（与 replay.ts 的既有语义一致）
 */
export function replayPersistedEvents(
  identityId: string,
  rows: PersistedEventRow[],
): ReplayResult {
  const base: Omit<ReplayResult, 'verdict' | 'errors'> = {
    identityId,
    eventCount: rows.length,
    firstSequence: rows[0]?.sequence ?? null,
    lastSequence: rows[rows.length - 1]?.sequence ?? null,
    finalState: null,
    lastEventTimestamp: null,
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };

  if (rows.length === 0) {
    return { ...base, verdict: 'empty', errors: [] };
  }

  // ---- 首事件必须是 genesis（M1.3 Fresh Start），否则用 createInitialState 兼容旧链 ----
  // 说明：首事件不是 genesis 时也能 Replay，createInitialState 会以首事件 timestamp
  // 构建空状态再依次 applyEvent——这是兼容 M1.2 历史链（无 genesis）的回退路径；
  // 但新 identity 必须创建 genesis，否则 Fresh Start 流程会拒绝。
  const firstType = rows[0]!.event_type;
  let state: MarrowState;
  if (firstType === 'genesis') {
    // applyGenesis 从快照直接产出完整状态，不需要前置 state
    // rows[0] 来自 DB，payload 类型是 MarrowEvent——在 firstType==='genesis' 分支
    // 语义上它必定是 GenesisEvent，但 TS 判别联合不跨数据库行类型自动收窄，
    // 需要显式断言
    const initialSnapshot = applyGenesis(rows[0]!.payload as GenesisEvent);
    state = initialSnapshot;
  } else {
    state = createInitialState(rows[0]!.payload.timestamp);
  }

  // genesis 在首行时 state 已由 applyGenesis 初始化，循环从 index 1 开始，
  // 避免对 genesis 行重复执行 applyEvent（applyEvent 对 genesis 调 applyGenesis 但
  // 不会改变已由 createInitialState 构建的内容——这里显式跳过，语义更清晰）
  //
  // M1.5.4.2 第二层引用校验索引（只使用本次恢复已加载的完整事件链，不新增查询）：
  // - allEventIds：本 identity 全链事件 ID，用于区分「未来事件」与「不存在/其他 identity」
  // - seenEventIds：已通过校验的事件 ID（严格位于当前行之前）
  // - seenUserInputIds：已通过的 user_input 事件 ID
  // 事件 ID 在 events 表中全局 UNIQUE，因此其他 identity 的事件不会出现在本链中，
  // 引用它会自然落入「不存在于当前 identity 事件链」分支并被拒绝。
  const allEventIds = new Set<string>();
  for (const row of rows) allEventIds.add(row.event_id);
  const seenEventIds = new Set<string>();
  const seenUserInputIds = new Set<string>();
  if (firstType === 'genesis') {
    seenEventIds.add(rows[0]!.event_id);
  }

  for (let i = firstType === 'genesis' ? 1 : 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.event_type === 'genesis') {
      // 同一 identity 不允许出现两个 genesis——DB 层约束已保证，但 Replay 必须再确认一次
      return {
        ...base,
        verdict: 'invalid',
        errors: [
          {
            identityId,
            sequence: row.sequence,
            eventId: row.event_id,
            eventType: row.event_type,
            schemaVersion: row.schema_version,
            engineVersion: row.engine_version,
            kind: 'invalid_payload',
            message: '同一 identity 事件链中出现多个 genesis（Replay fail-closed）',
          },
        ],
      };
    }
    const invalid = validateRowForReplay(row);
    if (invalid) {
      return { ...base, verdict: 'invalid', errors: [invalid] };
    }

    // M1.5.4.2 第二层：显式回复关联的引用完整性
    // 必须在 applyEvent 与索引登记之前执行（自引用 / 未来引用一律不通过）
    const replyTo = readReplyToEventId(row);
    if (replyTo !== null) {
      if (!seenEventIds.has(replyTo)) {
        const laterInChain = allEventIds.has(replyTo);
        return {
          ...base,
          verdict: 'invalid',
          errors: [
            replyReferenceError(
              row,
              laterInChain
                ? `replyToEventId=${replyTo} 位于当前回复之后（禁止引用未来事件或自引用）`
                : `replyToEventId=${replyTo} 不存在于当前 identity 事件链（可能属于其他 identity 或从未写入）`,
            ),
          ],
        };
      }
      if (!seenUserInputIds.has(replyTo)) {
        return {
          ...base,
          verdict: 'invalid',
          errors: [
            replyReferenceError(
              row,
              `replyToEventId=${replyTo} 指向的事件不是 DialogueEvent(user_input)`,
            ),
          ],
        };
      }
    }

    seenEventIds.add(row.event_id);
    if (isUserInputRow(row)) seenUserInputIds.add(row.event_id);

    state = applyEvent(state, row.payload);
  }

  const invariantViolation = validateRecoveredState(state);
  if (invariantViolation) {
    const last = rows[rows.length - 1]!;
    return {
      ...base,
      verdict: 'invalid',
      errors: [
        {
          identityId,
          sequence: last.sequence,
          eventId: last.event_id,
          eventType: last.event_type,
          schemaVersion: last.schema_version,
          engineVersion: last.engine_version,
          kind: 'state_invariant_violation',
          message: `恢复状态校验失败：${invariantViolation}`,
        },
      ],
    };
  }

  return {
    ...base,
    verdict: 'valid',
    finalState: state,
    lastEventTimestamp: rows[rows.length - 1]!.payload.timestamp,
    errors: [],
  };
}

// ==================================================================
// 启动恢复（验证哈希链 → 读取事件 → Replay → 校验）
// ==================================================================

/**
 * 恢复指定身份的历史状态（只读，绝不写入任何事件）。
 *
 * 执行顺序：
 * 1. verifyEventChain：只读验证哈希链完整性（M1.2.3 独立验证器）
 * 2. 空链 → verdict='empty'（合法新身份，由调用方创建 V2 初始状态）
 * 3. loadEventRows 读取全链 → replayPersistedEvents 确定性重建
 *
 * 哈希链验证失败 / 数据库读取失败 / Replay 失败都会得到 verdict='invalid'
 * 的结果；本函数本身不抛业务异常（数据库连接异常会被归类为
 * store_read_failed 写入 result，而不是上抛），是否中止启动由
 * recoverIdentityOrThrow / 调用方决定。
 */
export async function recoverIdentity(
  identityId: string = IDENTITY_ID,
): Promise<ReplayResult> {
  const base: Omit<ReplayResult, 'verdict' | 'errors'> = {
    identityId,
    eventCount: 0,
    firstSequence: null,
    lastSequence: null,
    finalState: null,
    lastEventTimestamp: null,
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
  const fail = (
    kind: ReplayErrorKind,
    message: string,
    extra?: Partial<ReplayError>,
  ): ReplayResult => ({
    ...base,
    verdict: 'invalid',
    errors: [
      {
        identityId,
        sequence: null,
        eventId: null,
        eventType: null,
        schemaVersion: null,
        engineVersion: null,
        ...extra,
        kind,
        message,
      },
    ],
  });

  // 1. 哈希链验证（独立于写入路径的只读验证器）
  let chain;
  try {
    chain = await verifyEventChain(identityId);
  } catch (err) {
    return fail(
      'store_read_failed',
      `哈希链验证执行失败（数据库不可达或查询错误）：${String(err)}`,
    );
  }

  if (chain.verdict === 'invalid') {
    return {
      ...base,
      verdict: 'invalid',
      eventCount: chain.eventCount,
      firstSequence: chain.firstSequence,
      lastSequence: chain.lastSequence,
      errors: chain.errors.map((e) => ({
        identityId,
        sequence: e.sequence,
        eventId: e.eventId,
        eventType: null,
        schemaVersion: null,
        engineVersion: null,
        kind: 'chain_verification_failed' as const,
        message: `[${e.kind}] ${e.message}`,
      })),
    };
  }

  if (chain.verdict === 'empty') {
    return { ...base, verdict: 'empty', errors: [] };
  }

  // 2. 读取完整事件行
  let rows: PersistedEventRow[];
  try {
    rows = await loadEventRows(identityId);
  } catch (err) {
    return fail('store_read_failed', `事件日志读取失败：${String(err)}`);
  }

  // 3. 确定性 Replay
  return replayPersistedEvents(identityId, rows);
}

/**
 * 恢复身份，失败即抛 RecoveryError（启动流程专用）。
 *
 * empty 不算失败（合法新身份）；只有 invalid 才抛出。
 */
export async function recoverIdentityOrThrow(
  identityId: string = IDENTITY_ID,
): Promise<ReplayResult> {
  const result = await recoverIdentity(identityId);
  if (result.verdict === 'invalid') {
    throw new RecoveryError(result);
  }
  return result;
}

// ==================================================================
// M1.3 Fresh Start：创建全新身份的 genesis
// ==================================================================

/**
 * Fresh Start：在空 identity 上原子创建 genesis 事件并验证 Replay 一致性。
 *
 * 严格前置条件：
 * - 调用方必须已持有该 identity 的 ownership lock（防并发初始化）
 * - 调用方已先 verifyEventChain 且 verdict=empty（防重复创建 genesis）
 *
 * 执行流程：
 * 1. 用 createInitialState 构建初始状态 → 写入 GenesisEvent.payload.initialState
 * 2. appendEvents 原子写入（单事件单事务）
 * 3. 再次 verifyEventChain —— 必须 valid，首行是 genesis（prevHash=NULL）
 * 4. recoverIdentity —— 必须 valid
 * 5. 比较 genesis.payload.initialState 与 replayResult.finalState 的业务字段
 *    （lastUpdated 允许不同——applyGenesis 会把它覆盖为 event.timestamp）
 * 6. 返回 recoverIdentity 结果（调用方据此取得 finalState）
 *
 * 为什么不把 Fresh Start 内联到 main() 里：
 * - 需要 appendEvents 写入 + verify + recover 完整闭环验证，
 *   散落在 main() 会让启动路径变复杂且难以测试
 * - 这是唯一允许"向数据库写第一条事件"的公开入口，集中在一个函数里
 *   方便审计谁在什么时候写入了 genesis
 *
 * commit-unknown 安全：appendEvents 使用 ON CONFLICT (event_id) DO NOTHING +
 * 全量不可变元数据冲突检查，重试时原批次零新增。
 */
export async function freshStartIdentity(
  identityId: string = IDENTITY_ID,
): Promise<ReplayResult> {
  // 前置防御：确认调用方已执行 verify + ownership
  const preChain = await verifyEventChain(identityId);
  if (preChain.verdict === 'invalid') {
    throw new Error(
      `freshStartIdentity 前置哈希链验证失败：${preChain.errors[0]?.message ?? 'unknown'}`,
    );
  }
  if (preChain.verdict === 'valid') {
    // 已经有 genesis——调用方没检查 empty 就调用了，属于编程错误
    throw new Error(
      `freshStartIdentity 拒绝：identity ${identityId} 已存在事件链（${preChain.eventCount} 条），不得重复 Fresh Start`,
    );
  }
  // preChain.verdict === 'empty' → 正常继续

  // 1. 构建初始状态快照
  const genesisTimestamp = new Date().toISOString();
  const initial = createInitialState(genesisTimestamp);

  // 从 createInitialState 结果里提取种子情景记忆 ID（genesis 里必须显式声明）
  const seedEpisodicIds = initial.episodicBuffer.map((m) => m.id);

  const genesis: GenesisEvent = {
    type: 'genesis',
    // event id 由 appendEvents 内 generateEventId 统一分配——freshStartIdentity
    // 不显式指定，避免与 storage.ts 的 id 生成规则分裂
    id: '', // 占位，appendEvents 内部会覆盖
    timestamp: genesisTimestamp,
    payload: {
      initialState: {
        energy: initial.energy,
        moodBaseline: initial.moodBaseline,
        arousal: initial.arousal,
        interruptionFlag: initial.interruptionFlag,
        trust: initial.trust,
        defensiveness: initial.defensiveness,
        cognitiveLoad: initial.cognitiveLoad,
        associationWeight: initial.associationWeight,
        traits: { ...initial.traits },
        batteryLevel: initial.batteryLevel,
        attentionFocus: initial.attentionFocus,
        socialHunger: initial.socialHunger,
        associations: [...initial.associations],
        episodicBuffer: [...initial.episodicBuffer],
        interruptionScars: initial.interruptionScars,
        needValidation: initial.needValidation,
        needNovelty: initial.needNovelty,
        needSecurity: initial.needSecurity,
        lastEvokedMemory: initial.lastEvokedMemory,
        lastBehavior: { ...initial.lastBehavior },
        uptimeSeconds: initial.uptimeSeconds,
        interruptionCount: initial.interruptionCount,
        sleeping: initial.sleeping,
        sleepEntryTrust: initial.sleepEntryTrust,
        sleepEntryCognitiveLoad: initial.sleepEntryCognitiveLoad,
        sleepEntryDefensiveness: initial.sleepEntryDefensiveness,
      },
      configVersion: 1,
      initializedBy: 'system',
      seedEpisodicIds,
    },
  };
  // appendEvents 会给事件分配 id、prevHash、计算哈希——这里传空 id 让它处理
  const genesisToWrite: GenesisEvent = {
    ...genesis,
    id: `genesis-${identityId}-${genesisTimestamp}`,
  };

  // 2. 原子写入
  await appendEvents([genesisToWrite], { identityId });

  // 3. 再次验证哈希链
  const postChain = await verifyEventChain(identityId);
  if (postChain.verdict !== 'valid') {
    throw new Error(
      `Fresh Start 后哈希链验证失败：${postChain.errors.map((e) => e.message).join('; ')}`,
    );
  }
  if (postChain.eventCount !== 1) {
    throw new Error(
      `Fresh Start 事件数异常：预期 1 条 genesis，实际 ${postChain.eventCount} 条`,
    );
  }

  // 4. Replay
  const replayResult = await recoverIdentity(identityId);
  if (replayResult.verdict !== 'valid') {
    throw new RecoveryError(replayResult);
  }

  // 5. 比较 genesis.payload.initialState 与 Replay 结果
  // 关键细节：traits / episodicBuffer / associations / lastBehavior 都是
  // 嵌套对象或数组，经过 DB JSONB 往返后 JavaScript 返回的对象键序可能变化
  // （JSON 规范不保证对象键序；postgres.js 解析 JSONB 返回 plain object）。
  // 因此这里用 canonicalize（storage.ts 导出的稳定键序 JSON）做嵌套比较，
  // 而非直接 JSON.stringify 或 === —— 它们会被键序差异误伤。
  const recovered = replayResult.finalState!;
  const snap = genesis.payload.initialState;
  const mismatch =
    recovered.energy !== snap.energy ||
    recovered.moodBaseline !== snap.moodBaseline ||
    recovered.arousal !== snap.arousal ||
    recovered.interruptionFlag !== snap.interruptionFlag ||
    recovered.trust !== snap.trust ||
    recovered.defensiveness !== snap.defensiveness ||
    recovered.cognitiveLoad !== snap.cognitiveLoad ||
    recovered.associationWeight !== snap.associationWeight ||
    canonicalize(recovered.traits) !== canonicalize(snap.traits) ||
    recovered.batteryLevel !== snap.batteryLevel ||
    recovered.attentionFocus !== snap.attentionFocus ||
    recovered.socialHunger !== snap.socialHunger ||
    canonicalize(recovered.associations) !== canonicalize(snap.associations) ||
    canonicalize(recovered.episodicBuffer) !== canonicalize(snap.episodicBuffer) ||
    recovered.interruptionScars !== snap.interruptionScars ||
    recovered.needValidation !== snap.needValidation ||
    recovered.needNovelty !== snap.needNovelty ||
    recovered.needSecurity !== snap.needSecurity ||
    recovered.lastEvokedMemory !== snap.lastEvokedMemory ||
    canonicalize(recovered.lastBehavior) !== canonicalize(snap.lastBehavior) ||
    recovered.uptimeSeconds !== snap.uptimeSeconds ||
    recovered.interruptionCount !== snap.interruptionCount ||
    recovered.sleeping !== snap.sleeping ||
    recovered.sleepEntryTrust !== snap.sleepEntryTrust ||
    recovered.sleepEntryCognitiveLoad !== snap.sleepEntryCognitiveLoad ||
    recovered.sleepEntryDefensiveness !== snap.sleepEntryDefensiveness;

  if (mismatch) {
    throw new Error(
      'Fresh Start Replay 结果与 genesis.initialState 不一致——确定性失败，拒绝启动',
    );
  }

  return replayResult;
}

// ==================================================================
// identity 所有权（启动排他）
// ==================================================================

/**
 * 当前进程持有的 identity 所有权专用连接。
 * 会话级 advisory lock 绑定在连接上：进程崩溃 / 连接断开时由
 * PostgreSQL 自动释放；主动释放必须显式 pg_advisory_unlock 后再归还连接
 * （连接归还连接池不会释放会话级锁）。
 */
let ownershipConnection: postgres.ReservedSql | null = null;

/**
 * 获取指定 identity 的进程级所有权（启动恢复前必须调用）。
 *
 * 锁键设计（重要）：pg_advisory_lock 采用双参数形式
 *   (hashtext('marrow.identity.ownership'), hashtext(identityId))
 * 第一个参数是与事件写入不同的独立命名空间——事件写入路径使用
 * 单参数 pg_advisory_xact_lock(hashtext(identityId))（见 storage.ts），
 * 若此处也用单参数 hashtext(identityId)，启动所有权锁会与
 * appendEvents 的写入锁同键，进程自己对自己的 tick 写入产生死锁。
 *
 * 取不到锁说明已有进程持有该 identity（多开冲突），直接抛错阻止启动。
 * 锁持有至进程结束；崩溃时由 PostgreSQL 在连接断开时自动释放。
 */
export async function acquireIdentityOwnership(
  identityId: string = IDENTITY_ID,
): Promise<void> {
  if (ownershipConnection) return; // 幂等：本进程已持有

  const sql = getDb();
  const reserved = await sql.reserve();
  try {
    const rows = await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        hashtext('marrow.identity.ownership'),
        hashtext(${identityId})
      ) AS acquired
    `;
    if (rows[0]?.acquired !== true) {
      reserved.release();
      throw new Error(
        `身份 ${identityId} 已被其他进程持有（identity ownership 冲突），拒绝启动`,
      );
    }
    ownershipConnection = reserved;
  } catch (err) {
    // 查询本身失败（如连接中断）：归还连接后上抛
    try {
      reserved.release();
    } catch {
      // 归还失败说明连接已损坏，无需额外处理
    }
    throw err;
  }
}

/**
 * 释放 identity 所有权（优雅关闭时在 closeDb 之前调用，幂等）。
 *
 * 先显式 pg_advisory_unlock 再归还连接——会话级锁不会随连接归还连接池
 * 而释放，不显式解锁会让池中连接带着残留锁继续被复用。
 */
export async function releaseIdentityOwnership(
  identityId: string = IDENTITY_ID,
): Promise<void> {
  const conn = ownershipConnection;
  ownershipConnection = null;
  if (!conn) return;
  try {
    await conn`
      SELECT pg_advisory_unlock(
        hashtext('marrow.identity.ownership'),
        hashtext(${identityId})
      )
    `;
  } finally {
    conn.release();
  }
}
