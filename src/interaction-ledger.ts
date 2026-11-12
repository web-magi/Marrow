/**
 * interaction-ledger.ts — M1.5.1 反馈归因账本（纯派生、只读）
 *
 * 目标：
 * 根据 EventStore 中已有的真实事件序列，确定性地构建「每轮互动」的结构化记录，
 * 标出 companion_output 与后续 user_input 之间的候选序列配对关系。
 *
 * 严格边界：
 * - 不访问数据库、不调用 LLM、不读墙钟、不使用 Math.random；
 * - 不产生事件、不修改 Runtime State、不修改输入事件、无全局可变状态；
 * - 不修改 Event Schema / Prompt / Trait / Memory 算法；
 * - 不做行为分类，不推断满意度，不把序列关系声称为因果关系。
 *
 * 配对语义（重要）：
 * - 只使用事件 sequence 建立「候选前序输出」；
 * - 「最近的前置 companion_output」是确定性的候选来源；
 * - 存在多条 user_input 或多条 companion_output 导致候选不唯一时，标记 ambiguous；
 * - 不根据文本相似度、时间接近、情绪结果反推配对。
 *
 * 配对置信度（重要）：
 * Pairing confidence is structural confidence, not causal confidence.
 * - high：仅当 companion_output payload 携带有效 replyToEventId（Runtime 显式
 *         声明的回复目标）。explicit 只证明「回复指向哪条用户输入」，
 *         不代表用户阅读、接受、满意或认同，不是反馈证据。
 * - medium：基于唯一、无歧义的序列候选关系，且本轮观察/评价引用完整（inferred）。
 * - low：存在候选关系，但存在未消除的歧义或结构缺失（inferred）。
 * - none：没有候选配对（unlinked）。
 *
 * 关联来源（M1.5.4.2）：
 * - explicit：Runtime 明确写入的 replyToEventId，且目标校验通过；
 * - inferred：历史事件无 replyToEventId，按事件顺序推断；
 * - unlinked：无法建立关联（含显式关联引用无效，绝不退回顺序推断冒充 explicit）。
 */

import type { MarrowEvent, DialogueEvent, MemoryFormationEvent } from './events.js';

/**
 * 账本输入事件的最小结构。
 *
 * 只需要 sequence（链顺序，权威排序依据）与 payload（事件本体）。
 * `PersistedEventRow` 结构上兼容本接口，调用方无需转换即可传入。
 * 不要求哈希链字段、行级版本字段——账本不参与校验与回放。
 */
export interface LedgerSourceEvent {
  /** 数据库 sequence（BIGSERIAL 可能超出 JS 安全整数，因此允许 string） */
  readonly sequence: string | number;
  /** 事件本体（必须包含 id / type / timestamp / payload） */
  readonly payload: MarrowEvent;
}

export type PairingStatus = 'paired' | 'unpaired' | 'ambiguous';

export type PairingConfidence = 'high' | 'medium' | 'low' | 'none';

/**
 * 关联来源（M1.5.4.2）
 *
 * - explicit：Runtime 在生成回复时明确声明了 replyToEventId（结构事实，不是反馈）
 * - inferred：历史事件没有 replyToEventId，只能按事件顺序推断
 * - unlinked：无法建立关联（含显式引用无效，绝不猜测）
 */
export type ReplyLinkSource = 'explicit' | 'inferred' | 'unlinked';

/**
 * 配对依据（确定性规则标识，不含任何行为/情绪解释）
 */
export type PairingRule =
  | 'explicit_reply_to'
  | 'invalid_reply_reference'
  | 'unique_preceding_companion'
  | 'multiple_user_inputs_after_same_companion'
  | 'consecutive_companion_outputs_before_user'
  | 'no_preceding_companion'
  | 'no_following_user_input';

/**
 * 单轮互动记录。
 *
 * 所有 ID 均来自真实事件；缺失一律为 null，绝不生成虚构 ID。
 * sequence 使用字符串保存，避免 BIGSERIAL 超出 JS 安全整数时精度丢失。
 */
export interface InteractionRecord {
  /** 账本记录 ID（由锚点 sequence + companion sequence 组合派生，确定性唯一；不是事件 ID） */
  id: string;

  companionOutputEventId: string | null;
  companionOutputSequence: string | null;
  companionOutputTimestamp: string | null;
  companionOutputText: string | null;
  /** 事件未携带该字段（旧事件）时为 null，不默认为 false */
  companionOutputFiltered: boolean | null;
  /** 仅保留事件真实值；无则为 null */
  companionOutputFilterReason: string | null;

  userInputEventId: string | null;
  userInputSequence: string | null;
  userInputTimestamp: string | null;

  /** 仅当 user_input 事件自身的 observationId 可解析时填入 */
  observationEventId: string | null;
  /** 仅当 user_input 事件自身的 appraisalId 可解析时填入 */
  appraisalEventId: string | null;

  /** 仅当 MemoryFormationEvent.sourceDialogueEventId 精确等于本记录 user_input 事件 ID 时填入 */
  memoryFormationEventId: string | null;
  memoryValence: number | null;
  memorySalience: number | null;

  pairingStatus: PairingStatus;
  pairingConfidence: PairingConfidence;
  /** 配对依据（结构性规则，不是因果解释） */
  pairingRule: PairingRule;
  /**
   * companion_output 事件中 Runtime 声明的目标 user_input 事件 ID（原文保留）。
   * 历史事件无该字段时为 null（不推断补齐）。
   * 注意：声明存在不代表引用有效——是否生效由 replyLinkSource 判定。
   */
  replyToEventId: string | null;
  /** 关联来源：explicit / inferred / unlinked（三者互斥，不互相冒充） */
  replyLinkSource: ReplyLinkSource;
  /** 本条记录的结构性限制（不代表因果或情绪结论） */
  limitations: string[];
}

/**
 * 输入结构非法时抛出。
 *
 * 非法包括：sequence 非整数、sequence 重复、事件 ID 重复、事件缺少 id/timestamp、
 * dialogue 事件 direction 非法。明确失败，绝不静默制造错误配对。
 */
export class InteractionLedgerInputError extends Error {
  constructor(message: string) {
    super(`[InteractionLedger] ${message}`);
    this.name = 'InteractionLedgerInputError';
  }
}

/** 当前事件结构不含会话标识，账本无法判断会话边界 */
export const LIMITATION_NO_SESSION = 'session_boundary_unavailable';

/** 一次归一化后的事件 */
interface NormalizedEvent {
  seq: bigint;
  seqText: string;
  event: MarrowEvent;
}

/** 一条对话事件 */
interface DialogueTurn {
  seq: bigint;
  seqText: string;
  event: DialogueEvent;
}

/** 记忆事件索引值 */
interface MemoryIndexEntry {
  event: MemoryFormationEvent;
  duplicate: boolean;
}

/** 将输入 sequence 归一化为 bigint + 规范十进制字符串 */
function normalizeSequence(sequence: string | number): { seq: bigint; seqText: string } {
  if (typeof sequence === 'number') {
    if (!Number.isInteger(sequence)) {
      throw new InteractionLedgerInputError(`sequence 必须是整数，收到: ${sequence}`);
    }
    const seq = BigInt(sequence);
    return { seq, seqText: seq.toString() };
  }
  if (typeof sequence === 'string') {
    const trimmed = sequence.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new InteractionLedgerInputError(`sequence 必须是十进制整数，收到: ${JSON.stringify(sequence)}`);
    }
    const seq = BigInt(trimmed);
    return { seq, seqText: seq.toString() };
  }
  throw new InteractionLedgerInputError('sequence 缺失或类型非法');
}

/**
 * 校验并归一化输入事件，按 sequence 升序排序。
 *
 * 排序依据是 sequence 而非数组顺序或时间戳：
 * 同一批次内多条事件的时间戳可能完全相同。
 */
function normalizeEvents(events: readonly LedgerSourceEvent[]): NormalizedEvent[] {
  const normalized: NormalizedEvent[] = [];
  const seenSequences = new Set<string>();
  const seenEventIds = new Set<string>();

  for (const source of events) {
    if (!source || typeof source !== 'object') {
      throw new InteractionLedgerInputError('存在空的输入事件');
    }
    const { seq, seqText } = normalizeSequence(source.sequence);
    const event = source.payload;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new InteractionLedgerInputError(`事件 sequence=${seqText} 缺少合法 payload`);
    }
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new InteractionLedgerInputError(`事件 sequence=${seqText} 缺少事件 id`);
    }
    if (typeof event.timestamp !== 'string' || event.timestamp.length === 0) {
      throw new InteractionLedgerInputError(`事件 sequence=${seqText} (${event.id}) 缺少 timestamp`);
    }
    if (seenSequences.has(seqText)) {
      throw new InteractionLedgerInputError(`sequence 重复: ${seqText}`);
    }
    if (seenEventIds.has(event.id)) {
      throw new InteractionLedgerInputError(`事件 ID 重复: ${event.id}`);
    }
    seenSequences.add(seqText);
    seenEventIds.add(event.id);
    normalized.push({ seq, seqText, event });
  }

  normalized.sort((a, b) => {
    if (a.seq < b.seq) return -1;
    if (a.seq > b.seq) return 1;
    return 0;
  });
  return normalized;
}

/** 从对话事件中拆分出 user / companion 两个有序序列 */
function collectDialogueTurns(events: readonly NormalizedEvent[]): {
  users: DialogueTurn[];
  companions: DialogueTurn[];
} {
  const users: DialogueTurn[] = [];
  const companions: DialogueTurn[] = [];

  for (const item of events) {
    if (item.event.type !== 'dialogue') continue;
    const dialogue = item.event as DialogueEvent;
    const direction = dialogue.payload?.direction;
    if (direction !== 'user_input' && direction !== 'companion_output') {
      throw new InteractionLedgerInputError(
        `dialogue 事件 ${dialogue.id} 的 direction 非法: ${JSON.stringify(direction)}`,
      );
    }
    const turn: DialogueTurn = { seq: item.seq, seqText: item.seqText, event: dialogue };
    if (direction === 'user_input') users.push(turn);
    else companions.push(turn);
  }

  return { users, companions };
}

/** 建立事件 ID → 事件 的索引（用于校验 observation / appraisal 引用） */
function indexById(events: readonly NormalizedEvent[]): Map<string, MarrowEvent> {
  const map = new Map<string, MarrowEvent>();
  for (const item of events) {
    map.set(item.event.id, item.event);
  }
  return map;
}

/**
 * 建立 sourceDialogueEventId → MemoryFormationEvent 索引。
 *
 * 只允许通过真实来源 ID 关联；同一来源出现多条时标记 duplicate，
 * 由调用方在 limitations 中显式说明，绝不按时间/文本推断。
 */
function indexMemoryFormations(events: readonly NormalizedEvent[]): Map<string, MemoryIndexEntry> {
  const map = new Map<string, MemoryIndexEntry>();
  for (const item of events) {
    if (item.event.type !== 'memory_formation') continue;
    const formation = item.event as MemoryFormationEvent;
    const sourceId = formation.payload?.sourceDialogueEventId;
    if (typeof sourceId !== 'string' || sourceId.length === 0) continue;
    const existing = map.get(sourceId);
    if (existing) {
      existing.duplicate = true;
      continue;
    }
    map.set(sourceId, { event: formation, duplicate: false });
  }
  return map;
}

/** 在某个 user 之前查找最近的 companion（users/companions 均按 sequence 升序） */
function findPreviousCompanion(
  userSeq: bigint,
  companions: readonly DialogueTurn[],
): { companion: DialogueTurn; index: number } | null {
  let found: { companion: DialogueTurn; index: number } | null = null;
  for (let i = 0; i < companions.length; i++) {
    const candidate = companions[i];
    if (!candidate) continue;
    if (candidate.seq < userSeq) {
      found = { companion: candidate, index: i };
    } else {
      break;
    }
  }
  return found;
}

/** 判断 (start, end) 之间是否存在 user_input */
function hasUserBetween(
  startSeq: bigint,
  endSeq: bigint,
  users: readonly DialogueTurn[],
): boolean {
  return users.some((user) => user.seq > startSeq && user.seq < endSeq);
}

/** 读取并校验数值字段 */
function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 构建单条记录。
 */
function buildRecord(params: {
  user: DialogueTurn | null;
  companion: DialogueTurn | null;
  status: PairingStatus;
  confidence: PairingConfidence;
  rule: PairingRule;
  replyLinkSource: ReplyLinkSource;
  /** companion 事件中 Runtime 声明的目标（原文；无则 null） */
  replyToEventId: string | null;
  eventsById: Map<string, MarrowEvent>;
  memoryBySource: Map<string, MemoryIndexEntry>;
}): { record: InteractionRecord; anchorSeq: bigint } {
  const {
    user,
    companion,
    status,
    confidence,
    rule,
    replyLinkSource,
    replyToEventId,
    eventsById,
    memoryBySource,
  } = params;
  const limitations: string[] = [LIMITATION_NO_SESSION];

  // ── companion_output 侧：只保留真实字段 ──────────────────────────
  let companionOutputText: string | null = null;
  let companionOutputFiltered: boolean | null = null;
  let companionOutputFilterReason: string | null = null;

  if (companion) {
    const payload = companion.event.payload;
    companionOutputText = typeof payload.text === 'string' ? payload.text : null;
    companionOutputFiltered = typeof payload.filtered === 'boolean' ? payload.filtered : null;
    companionOutputFilterReason =
      typeof payload.filterReason === 'string' && payload.filterReason.length > 0
        ? payload.filterReason
        : null;

    if (companionOutputFiltered === null) {
      limitations.push('filtered_flag_missing');
    } else if (companionOutputFiltered) {
      // 过滤输出不默认视为用户可见：保留信息，但不做可见性判定
      limitations.push('filtered_output_may_not_be_user_visible');
      if (companionOutputFilterReason === null) {
        limitations.push('filter_reason_missing');
      }
    }
    if (companionOutputText === null || companionOutputText.trim().length === 0) {
      limitations.push('companion_output_text_empty');
    }
  }

  // ── user_input 侧：只使用事件自带的引用字段 ──────────────────────
  let observationEventId: string | null = null;
  let appraisalEventId: string | null = null;
  let memoryFormationEventId: string | null = null;
  let memoryValence: number | null = null;
  let memorySalience: number | null = null;

  if (user) {
    const payload = user.event.payload;
    const rawObservationId =
      typeof payload.observationId === 'string' && payload.observationId.length > 0
        ? payload.observationId
        : null;
    const rawAppraisalId =
      typeof payload.appraisalId === 'string' && payload.appraisalId.length > 0
        ? payload.appraisalId
        : null;

    if (rawObservationId === null) {
      limitations.push('observation_reference_missing');
    } else {
      const referenced = eventsById.get(rawObservationId);
      if (referenced && referenced.type === 'observation') {
        observationEventId = rawObservationId;
      } else {
        limitations.push('observation_reference_unresolved');
      }
    }

    if (rawAppraisalId === null) {
      limitations.push('appraisal_reference_missing');
    } else {
      const referenced = eventsById.get(rawAppraisalId);
      if (referenced && referenced.type === 'appraisal') {
        appraisalEventId = rawAppraisalId;
        const sourceObservationId = (referenced as { payload?: { sourceObservationId?: unknown } })
          .payload?.sourceObservationId;
        if (
          observationEventId !== null &&
          typeof sourceObservationId === 'string' &&
          sourceObservationId !== observationEventId
        ) {
          limitations.push('appraisal_source_observation_mismatch');
        }
      } else {
        limitations.push('appraisal_reference_unresolved');
      }
    }

    // MemoryFormation 只通过真实 sourceDialogueEventId 关联
    const memoryEntry = memoryBySource.get(user.event.id);
    if (memoryEntry) {
      memoryFormationEventId = memoryEntry.event.id;
      memoryValence = finiteNumberOrNull(memoryEntry.event.payload.memory?.valence);
      memorySalience = finiteNumberOrNull(memoryEntry.event.payload.memory?.salience);
      if (memoryEntry.duplicate) {
        limitations.push('multiple_memory_formation_events_for_user');
      }
    }
  }

  // ── 配对状态对应的结构化限制 ────────────────────────────────────
  if (status === 'ambiguous') {
    if (rule === 'multiple_user_inputs_after_same_companion') {
      limitations.push('multiple_user_inputs_after_same_companion');
    } else if (rule === 'consecutive_companion_outputs_before_user') {
      limitations.push('consecutive_companion_outputs_before_user');
    }
  } else if (status === 'unpaired') {
    if (rule === 'invalid_reply_reference') {
      // 显式关联引用无效：保留声明原文，但不产生任何配对结论
      limitations.push('invalid_reply_reference');
    } else {
      limitations.push(
        rule === 'no_preceding_companion' ? 'no_preceding_companion_output' : 'no_following_user_input',
      );
    }
  }

  const anchorSeq = user ? user.seq : (companion as DialogueTurn).seq;
  const anchorSeqText = user ? user.seqText : (companion as DialogueTurn).seqText;

  /**
   * 账本记录 ID（M1.5.4.2.1）：锚点 sequence + companion sequence 组合。
   * 多 companion_output 指向同一 user_input 时，anchor 相同但 companion.seq 不同，
   * 组合保证全局唯一；无 companion 时使用 'none' 明确区分。
   * 全程使用字符串，避免 BIGSERIAL 超出 JS 安全整数的精度问题。
   *
   * 三种典型场景：
   *   paired(user+companion)           → ledger:<userSeq>:<companionSeq>
   *   unpaired(user only, no companion) → ledger:<userSeq>:none
   *   unpaired(companion only)          → ledger:<companionSeq>:<companionSeq>
   * 三者分别唯一。
   */
  const recordId = `ledger:${anchorSeqText}:${companion ? companion.seqText : 'none'}`;

  const record: InteractionRecord = {
    id: recordId,
    companionOutputEventId: companion ? companion.event.id : null,
    companionOutputSequence: companion ? companion.seqText : null,
    companionOutputTimestamp: companion ? companion.event.timestamp : null,
    companionOutputText,
    companionOutputFiltered,
    companionOutputFilterReason,
    userInputEventId: user ? user.event.id : null,
    userInputSequence: user ? user.seqText : null,
    userInputTimestamp: user ? user.event.timestamp : null,
    observationEventId,
    appraisalEventId,
    memoryFormationEventId,
    memoryValence,
    memorySalience,
    pairingStatus: status,
    pairingConfidence: confidence,
    pairingRule: rule,
    replyToEventId,
    replyLinkSource,
    limitations,
  };

  return { record, anchorSeq };
}

/**
 * 构建反馈归因账本。
 *
 * 输出顺序：按记录锚点事件的 sequence 升序（user 优先作为锚点，孤立 companion 用自身 sequence）。
 * 同一输入重复执行，输出结构、顺序、序列化结果完全一致。
 *
 * @throws InteractionLedgerInputError 输入 sequence / 事件 ID / 必要字段非法时
 */
export function buildInteractionLedger(
  events: readonly LedgerSourceEvent[],
): readonly InteractionRecord[] {
  if (!Array.isArray(events)) {
    throw new InteractionLedgerInputError('输入必须是事件数组');
  }

  const normalized = normalizeEvents(events);
  const eventsById = indexById(normalized);
  const memoryBySource = indexMemoryFormations(normalized);
  const { users, companions } = collectDialogueTurns(normalized);

  const sequenceById = new Map<string, bigint>();
  for (const item of normalized) sequenceById.set(item.event.id, item.seq);
  const userById = new Map<string, DialogueTurn>();
  for (const user of users) userById.set(user.event.id, user);

  // ── 显式关联解析（M1.5.4.2）──────────────────────────────────────
  // 只有同时满足以下条件才视为有效 explicit：
  //   1. replyToEventId 为非空字符串；
  //   2. 目标事件存在于本次输入；
  //   3. 目标是 DialogueEvent(direction='user_input')；
  //   4. 目标 sequence 严格早于当前 companion_output。
  // 任一条件不满足 → 记录 invalid_reply_reference（unlinked），
  // 绝不退回顺序推断，也绝不把推断结果标成 explicit。
  const explicitByUser = new Map<string, DialogueTurn[]>();
  const invalidReplyCompanionIds = new Set<string>();
  const hasDeclaredReplyCompanionIds = new Set<string>();
  const declaredReplyTo = new Map<string, string | null>();

  for (const companion of companions) {
    const raw = companion.event.payload.replyToEventId;
    if (raw === undefined) {
      // 历史事件：没有显式关联字段，继续走原有顺序推断
      declaredReplyTo.set(companion.event.id, null);
      continue;
    }
    // 只要 Runtime 声明过 replyToEventId，该回复就不允许再被顺序推断使用：
    // 显式关联要么有效（explicit），要么损坏（invalid → unlinked），
    // 二者都不能退化成 inferred。
    hasDeclaredReplyCompanionIds.add(companion.event.id);
    if (typeof raw !== 'string' || raw.length === 0) {
      declaredReplyTo.set(companion.event.id, typeof raw === 'string' ? raw : null);
      invalidReplyCompanionIds.add(companion.event.id);
      continue;
    }
    declaredReplyTo.set(companion.event.id, raw);

    const target = userById.get(raw);
    const targetSeq = sequenceById.get(raw);
    if (!target || targetSeq === undefined || targetSeq >= companion.seq) {
      invalidReplyCompanionIds.add(companion.event.id);
      continue;
    }

    const list = explicitByUser.get(raw);
    if (list) list.push(companion);
    else explicitByUser.set(raw, [companion]);
  }

  // 声明过显式关联的 companion 不参与顺序推断候选：
  // 有效关联已由 explicit 记录消费，损坏关联标记 unlinked，均不得降级为 inferred
  const inferenceCompanions = companions.filter(
    (companion) => !hasDeclaredReplyCompanionIds.has(companion.event.id),
  );

  const results: Array<{ record: InteractionRecord; anchorSeq: bigint }> = [];
  const referencedCompanionIds = new Set<string>();

  for (const user of users) {
    // 存在有效显式关联：优先使用，且不再用事件顺序覆盖
    const explicitCompanions = explicitByUser.get(user.event.id);
    if (explicitCompanions) {
      for (const companion of explicitCompanions) {
        referencedCompanionIds.add(companion.event.id);
        results.push(
          buildRecord({
            user,
            companion,
            status: 'paired',
            confidence: 'high',
            rule: 'explicit_reply_to',
            replyLinkSource: 'explicit',
            replyToEventId: user.event.id,
            eventsById,
            memoryBySource,
          }),
        );
      }
      continue;
    }

    const previous = findPreviousCompanion(user.seq, inferenceCompanions);

    if (!previous) {
      results.push(
        buildRecord({
          user,
          companion: null,
          status: 'unpaired',
          confidence: 'none',
          rule: 'no_preceding_companion',
          replyLinkSource: 'unlinked',
          replyToEventId: null,
          eventsById,
          memoryBySource,
        }),
      );
      continue;
    }

    const { companion, index } = previous;
    referencedCompanionIds.add(companion.event.id);

    // 同一 companion 之后已出现更早的 user_input：候选不再唯一
    const multipleUsers = hasUserBetween(companion.seq, user.seq, users);
    // 连续多条 companion_output：无法确定用户回应的是哪一条
    let consecutiveCompanions = false;
    if (!multipleUsers && index > 0) {
      const earlier = inferenceCompanions[index - 1];
      consecutiveCompanions =
        earlier !== undefined && !hasUserBetween(earlier.seq, companion.seq, users);
    }

    if (multipleUsers) {
      results.push(
        buildRecord({
          user,
          companion,
          status: 'ambiguous',
          confidence: 'low',
          rule: 'multiple_user_inputs_after_same_companion',
          replyLinkSource: 'inferred',
          replyToEventId: null,
          eventsById,
          memoryBySource,
        }),
      );
      continue;
    }

    if (consecutiveCompanions) {
      results.push(
        buildRecord({
          user,
          companion,
          status: 'ambiguous',
          confidence: 'low',
          rule: 'consecutive_companion_outputs_before_user',
          replyLinkSource: 'inferred',
          replyToEventId: null,
          eventsById,
          memoryBySource,
        }),
      );
      continue;
    }

    // 唯一候选：结构完整为 medium，结构缺失为 low（均为 inferred，不是 explicit）
    const structuralComplete =
      typeof user.event.payload.observationId === 'string' &&
      user.event.payload.observationId.length > 0 &&
      typeof user.event.payload.appraisalId === 'string' &&
      user.event.payload.appraisalId.length > 0 &&
      eventsById.get(user.event.payload.observationId)?.type === 'observation' &&
      eventsById.get(user.event.payload.appraisalId)?.type === 'appraisal';

    results.push(
      buildRecord({
        user,
        companion,
        status: 'paired',
        confidence: structuralComplete ? 'medium' : 'low',
        rule: 'unique_preceding_companion',
        replyLinkSource: 'inferred',
        replyToEventId: null,
        eventsById,
        memoryBySource,
      }),
    );
  }

  // 没有被任何 user_input 记录引用的 companion_output 不能被丢弃
  for (const companion of companions) {
    if (referencedCompanionIds.has(companion.event.id)) continue;

    if (invalidReplyCompanionIds.has(companion.event.id)) {
      // 显式关联引用无效：声明原文保留，结论为无法关联（不猜测）
      results.push(
        buildRecord({
          user: null,
          companion,
          status: 'unpaired',
          confidence: 'none',
          rule: 'invalid_reply_reference',
          replyLinkSource: 'unlinked',
          replyToEventId: declaredReplyTo.get(companion.event.id) ?? null,
          eventsById,
          memoryBySource,
        }),
      );
      continue;
    }

    results.push(
      buildRecord({
        user: null,
        companion,
        status: 'unpaired',
        confidence: 'none',
        rule: 'no_following_user_input',
        replyLinkSource: 'unlinked',
        replyToEventId: declaredReplyTo.get(companion.event.id) ?? null,
        eventsById,
        memoryBySource,
      }),
    );
  }

  results.sort((a, b) => {
    if (a.anchorSeq < b.anchorSeq) return -1;
    if (a.anchorSeq > b.anchorSeq) return 1;
    return 0;
  });

  return results.map((item) => item.record);
}
