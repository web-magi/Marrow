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
import { VALID_OBSERVATION_SOURCES, type EventType } from './events.js';
import { applyEvent, createInitialState, type MarrowState } from './state.js';
import {
  ENGINE_VERSION,
  IDENTITY_ID,
  SCHEMA_VERSION,
  loadEventRows,
  type PersistedEventRow,
} from './storage.js';
import { getDb } from './db/connection.js';
import { verifyEventChain } from './verify-chain.js';

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
  'tick',
  'interruption',
  'environment',
  'dialogue',
  'memory_evocation',
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

    case 'dialogue':
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
      return null;

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

  let state = createInitialState(rows[0]!.payload.timestamp);

  for (const row of rows) {
    const invalid = validateRowForReplay(row);
    if (invalid) {
      return { ...base, verdict: 'invalid', errors: [invalid] };
    }
    // 校验通过后类型已收窄：type 属于已知判别联合
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
