/**
 * dashboard-api.ts — Dashboard V1 只读 API 契约（DTO + 纯函数）
 *
 * 安全模型（localhost 信任边界）：
 * - Runtime HTTP 仅绑定 127.0.0.1（index.ts），不接受局域网连接；
 *   CORS 不是访问控制手段，本模块不依赖它做任何安全假设。
 * - /api/events 默认只返回事件元数据 + 逐类型白名单的非敏感摘要字段；
 *   未明确允许的 payload 字段一律不下发（fail-closed）。
 * - 原始对话文本（DialogueEvent.text / candidateText、ObservationEvent.content / facts）
 *   只属于 localhost 边界内的 /api/dialogue 与 /api/state，绝不进入事件查询接口。
 *
 * 本模块只包含 DTO 与纯函数，不依赖 Runtime 内部业务实现；
 * Dashboard 前端通过 `import type` 共享这里的 DTO（类型在构建期擦除，
 * 不形成对 Runtime 代码的运行时依赖）。
 */

import type { QueryEventRowsOptions, PersistedEventRow } from './storage.js';

// ==================================================================
// DTO
// ==================================================================

/** 单个事件的元数据 + 非敏感摘要（/api/events 响应元素） */
export interface EventSummaryDto {
  /** BIGSERIAL 序列号（字符串，避免精度丢失） */
  sequence: string;
  eventId: string;
  identityId: string;
  /** 事件日志时间（ISO 8601） */
  timestamp: string;
  eventType: string;
  schemaVersion: number;
  engineVersion: string | null;
  causationId: string | null;
  correlationId: string | null;
  previousEventHash: string | null;
  eventHash: string;
  /**
   * 逐类型白名单过滤后的非敏感摘要。
   * 未知事件类型 fail-closed：恒为空对象（仅返回元数据）。
   */
  summary: Record<string, unknown>;
}

/** GET /api/events 响应 */
export interface EventsListResponse {
  events: EventSummaryDto[];
  page: {
    limit: number;
    count: number;
    /**
     * 下一页（更早事件）的游标：以 beforeSequence=该值 重新查询。
     * null 表示没有更多历史（本页数量不足 limit）。
     */
    nextBeforeSequence: string | null;
  };
}

/** GET /api/runtime 响应 */
export interface RuntimeStatusResponse {
  identityId: string;
  closed: boolean;
  uptimeSeconds: number;
  eventCount: number;
  tick: { pending: boolean; running: boolean; kind: string | null; recoveryRequired: boolean };
  queue: {
    active: number;
    reserved: number;
    ready: number;
    waiting: number;
    running: number;
    runningChatId: string | null;
    runningTaskKind: string | null;
  };
}

/** RuntimeSession.snapshot() 的最小结构（避免反向依赖 runtime-session 模块） */
export interface RuntimeSnapshotLike {
  identityId: string;
  closed: boolean;
  active: number;
  reserved: number;
  ready: number;
  waiting: number;
  running: number;
  runningChatId: string | null;
  runningTaskKind: string | null;
  tick: { pending: boolean; running: boolean; kind: string | null; recoveryRequired: boolean };
}

// ==================================================================
// 事件行 → DTO（字段白名单）
// ==================================================================

/** 逐事件类型允许下发的 payload 摘要字段（除此之外一律丢弃） */
const SUMMARY_FIELD_WHITELIST: Record<string, readonly string[]> = {
  tick: ['deltaSeconds'],
  interruption: [
    'reason',
    'energyAtInterruption',
    'moodBaselineAtInterruption',
    'arousalAtInterruption',
    'lastBehavior',
    'isTraumatic',
    'interruptionDurationSeconds',
  ],
  environment: ['feature', 'reading', 'moodDelta', 'salience'],
  // 注意：绝不包含 text / candidateText（原始对话内容）
  dialogue: [
    'direction',
    'action',
    'intensity',
    'moodDelta',
    'salience',
    'wordCount',
    'filtered',
    'filterReason',
    'observationId',
    'appraisalId',
  ],
  // 注意：绝不包含 content / facts（用户原始输入与事实主张文本）；
  // factsCount 仅返回条数，属于非敏感统计摘要。
  observation: ['source', 'action', 'intensity', 'confidence', 'uncertainty', 'extractorVersion'],
  appraisal: [
    'sourceObservationId',
    'valenceDelta',
    'arousalDelta',
    'energyDelta',
    'confidence',
    'evidenceAssociationIds',
  ],
  // 注意：绝不包含 cue / summary（由用户文本派生）
  memory_evocation: ['memoryId', 'valence', 'salience', 'moodDelta', 'energyDelta'],
  sleep: ['entering', 'reason'],
  // reason 为聚合模块生成的系统文本（非用户输入），shift 为数值增量
  trait_shift: ['shift', 'reason'],
  // genesis / memory_formation：payload 含完整状态快照或记忆文本摘要，
  // 默认不下发任何 payload 字段（memory_formation 的结构化标识单独构造，见下）
  genesis: [],
  memory_formation: [],
};

function pickDefined(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 将持久化事件行转换为只读 DTO。
 *
 * 纯函数：不访问数据库、不读时钟、不修改输入。
 * 白名单之外（含未知事件类型）的 payload 字段一律不下发。
 */
export function sanitizeEventRow(row: PersistedEventRow): EventSummaryDto {
  const event = row.payload;
  const innerPayload = ((event as { payload?: unknown }).payload ?? {}) as Record<string, unknown>;

  const whitelist = SUMMARY_FIELD_WHITELIST[row.event_type];
  let summary: Record<string, unknown>;
  if (whitelist === undefined) {
    // fail-closed：未知事件类型只返回元数据
    summary = {};
  } else {
    summary = pickDefined(innerPayload, whitelist);
    if (row.event_type === 'observation') {
      const facts = innerPayload['facts'];
      summary['factsCount'] = Array.isArray(facts) ? facts.length : 0;
    }
    if (row.event_type === 'memory_formation') {
      // 只暴露结构化标识与数值，不下发 memory.summary / memory.keywords
      const memory = (innerPayload['memory'] ?? {}) as Record<string, unknown>;
      summary = {
        sourceDialogueEventId: innerPayload['sourceDialogueEventId'],
        memory: pickDefined(memory, ['id', 'timestamp', 'valence', 'salience', 'sourceEventId', 'isTrauma']),
      };
    }
  }

  return {
    sequence: row.sequence,
    eventId: row.event_id,
    identityId: row.identity_id,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
    summary,
  };
}

/** 构造 /api/events 响应（纯函数） */
export function buildEventsApiResponse(rows: PersistedEventRow[], limit: number): EventsListResponse {
  return {
    events: rows.map(sanitizeEventRow),
    page: {
      limit,
      count: rows.length,
      nextBeforeSequence:
        rows.length === limit && rows.length > 0 ? rows[rows.length - 1]!.sequence : null,
    },
  };
}

/** 构造 /api/runtime 响应（纯函数；session 关闭时 closed=true 仍正常返回） */
export function buildRuntimeApiResponse(
  snapshot: RuntimeSnapshotLike,
  uptimeSeconds: number,
  eventCount: number,
): RuntimeStatusResponse {
  return {
    identityId: snapshot.identityId,
    closed: snapshot.closed,
    uptimeSeconds,
    eventCount,
    tick: snapshot.tick,
    queue: {
      active: snapshot.active,
      reserved: snapshot.reserved,
      ready: snapshot.ready,
      waiting: snapshot.waiting,
      running: snapshot.running,
      runningChatId: snapshot.runningChatId,
      runningTaskKind: snapshot.runningTaskKind,
    },
  };
}

// ==================================================================
// 查询参数解析与校验（非法参数 → 400，绝不带进 SQL）
// ==================================================================

export type EventsQueryParseResult =
  | { ok: true; options: QueryEventRowsOptions }
  | { ok: false; error: string };

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DIGITS_ONLY = /^\d+$/;

function parseNonNegativeInt(raw: string, name: string): number | { ok: false; error: string } {
  if (!DIGITS_ONLY.test(raw)) {
    return { ok: false, error: `${name} 必须是非负整数字符串，收到: ${raw.slice(0, 32)}` };
  }
  return Number(raw);
}

function isValidIsoDate(raw: string): boolean {
  return !Number.isNaN(Date.parse(raw));
}

/**
 * 解析 /api/events 查询参数。
 *
 * - limit：默认 50，>200 钳制到 200；非数字 → 400
 * - offset：默认 0；非法 → 400（兼容旧分页，新调用方应优先使用游标）
 * - beforeSequence / afterSequence：BIGINT 游标，字符串传递避免精度丢失，
 *   仅接受十进制数字串；两者同时给出 → 400
 * - type：可重复参数，非空字符串
 * - since / until：必须可解析为日期
 */
export function parseEventsQueryParams(searchParams: URLSearchParams): EventsQueryParseResult {
  const options: QueryEventRowsOptions = {};

  const rawLimit = searchParams.get('limit');
  if (rawLimit !== null) {
    const parsed = parseNonNegativeInt(rawLimit, 'limit');
    if (typeof parsed !== 'number') return parsed;
    if (parsed === 0) return { ok: false, error: 'limit 必须大于 0' };
    options.limit = Math.min(parsed, MAX_LIMIT);
  } else {
    options.limit = DEFAULT_LIMIT;
  }

  const rawOffset = searchParams.get('offset');
  if (rawOffset !== null) {
    const parsed = parseNonNegativeInt(rawOffset, 'offset');
    if (typeof parsed !== 'number') return parsed;
    options.offset = parsed;
  }

  const beforeSequence = searchParams.get('beforeSequence');
  const afterSequence = searchParams.get('afterSequence');
  if (beforeSequence !== null && afterSequence !== null) {
    return { ok: false, error: 'beforeSequence 与 afterSequence 不能同时使用' };
  }
  for (const [name, value] of [
    ['beforeSequence', beforeSequence],
    ['afterSequence', afterSequence],
  ] as const) {
    if (value !== null) {
      if (!DIGITS_ONLY.test(value)) {
        return { ok: false, error: `${name} 必须是十进制数字字符串（BIGINT 游标）` };
      }
      if (name === 'beforeSequence') options.beforeSequence = value;
      else options.afterSequence = value;
    }
  }

  const types = searchParams.getAll('type').map((t) => t.trim()).filter((t) => t.length > 0);
  if (searchParams.getAll('type').some((t) => t.trim().length === 0)) {
    return { ok: false, error: 'type 不允许为空字符串' };
  }
  if (types.length > 0) options.type = types;

  const since = searchParams.get('since');
  if (since !== null) {
    if (!isValidIsoDate(since)) return { ok: false, error: `since 不是合法日期: ${since.slice(0, 64)}` };
    options.since = since;
  }
  const until = searchParams.get('until');
  if (until !== null) {
    if (!isValidIsoDate(until)) return { ok: false, error: `until 不是合法日期: ${until.slice(0, 64)}` };
    options.until = until;
  }

  return { ok: true, options };
}
