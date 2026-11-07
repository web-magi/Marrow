/**
 * storage.ts — PostgreSQL 事件存储（M1.2：PG EventStore）
 *
 * M1.2 起，事件的唯一正式写入路径是 PostgreSQL events 表。
 * 原 JSONL 写入路径已废弃；V1 data/events.jsonl（5412 行）仅作为
 * 只读历史归档保留，任何代码不得再写入该文件。
 *
 * 设计原则：
 * - append-only：只追加不修改
 * - 哈希链：每条事件携带 previous_event_hash + event_hash（SHA-256），
 *   写入顺序由事务级 advisory lock 保证，不依赖 BIGSERIAL 的分配顺序
 * - 幂等：event_id 冲突时比较事件内容，内容相同视为重复提交成功，不同则抛错
 * - 规范化序列化：canonical JSON（递归 key 排序、剔除 undefined、数组保序），
 *   保证哈希计算与回放校验的确定性
 *
 * 写前一致性原则（调用方约束）：
 *   appendEvent 成功后才允许 applyEvent；写库失败必须中止当前 tick/请求，
 *   保证「内存状态 == replay(已持久化事件流)」的一致前缀。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog, MarrowEvent } from './events.js';
import { getDb } from './db/connection.js';

/**
 * V2 主身份 ID（M1.3 Fresh Start）。
 * - 与 M1.3 之前的 marrow-primary 完全隔离：两个身份各有独立的事件链、
 *   独立的 identity ownership 锁、独立的运行时状态。
 * - V1 JSONL 继续作为独立封存档案，本 ID 启动的任何流程都不读取 V1 数据。
 * - 同一 PostgreSQL 数据库中，两个 identity 通过 identity_id 列自然隔离。
 */
export const IDENTITY_ID = 'marrow-v2-birth2';

/** M1 起新写入事件的 schema 版本 */
export const SCHEMA_VERSION = 2;

/**
 * V1 历史事件日志文件路径（只读归档引用）。
 * 保留此导出仅用于归档查看/审计；任何运行时代码不得向该路径写入。
 */
export const EVENT_LOG_PATH = join(process.cwd(), 'data', 'events.jsonl');

/**
 * 运行时读取 package.json 生成引擎版本标识。
 * （rootDir=./src 不能 import json，改用文件读取。）
 */
function readEngineVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { name?: string; version?: string };
    return `${pkg.name ?? 'marrow'}@${pkg.version ?? '0.0.0'}`;
  } catch {
    return 'marrow@unknown';
  }
}

/** 引擎版本（写入每条事件，供回放环境追溯） */
export const ENGINE_VERSION = readEngineVersion();

/**
 * 规范化 JSON 序列化（canonical JSON）。
 *
 * 规则（全链路固定，哈希链与幂等比较的唯一依据）：
 * - 纯对象：key 按 UTF-16 字典序排序；值为 undefined 的键剔除（匹配 JSONB 语义）；
 *   嵌套对象递归应用
 * - 数组：保持原有顺序；元素为 undefined 时按 JSON 语义转为 null
 *   （与 JSON.stringify / JSONB 落库结果保持一致，不能产出 `[,]` 这种非法形式）
 * - 原始类型：JSON.stringify 语义
 * - 非纯对象（Date/Buffer 等）：走 JSON.stringify 的 toJSON 语义，
 *   不能按"无键对象"退化成 `{}`
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalize(item)))
      .join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      // 非纯对象：交给 JSON.stringify（会调用 toJSON）
      const serialized = JSON.stringify(value) as string | undefined;
      if (serialized === undefined) {
        throw new TypeError(
          `canonicalize: 无法序列化的非纯对象 ${Object.prototype.toString.call(value)}`,
        );
      }
      return serialized;
    }

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`,
    );
    return `{${parts.join(',')}}`;
  }

  const serialized = JSON.stringify(value) as string | undefined;
  if (serialized === undefined) {
    // 顶层 undefined / function / symbol 无法进入 JSON / JSONB
    throw new TypeError(
      `canonicalize: 顶层值不可序列化（typeof=${typeof value}）`,
    );
  }
  return serialized;
}

/**
 * 校验事件载荷能否无损往返 JSON / JSONB。
 *
 * 明确拒绝会被 JSONB 静默改变语义的输入，而不是让它们悄悄变成别的值：
 * - NaN / Infinity → JSON.stringify 会写成 null
 * - BigInt / function / symbol → 无法序列化
 * - 数组元素为 undefined → 会变成 null（语义改变）
 * - 非纯对象（Date/Map/Buffer 等）→ 落库后类型信息丢失
 * - 循环引用 → 无法序列化
 *
 * 对象属性值为 undefined 是合法的：会被 JSON.stringify / JSONB 剔除，
 * canonicalize 也按相同规则剔除，二者语义一致。
 *
 * @throws TypeError 载荷触碰上述边界时抛出，appendEvent 在写库前直接失败
 */
export function assertJsonSafe(value: unknown, path = '$'): void {
  if (value === null) return;

  switch (typeof value) {
    case 'string':
      if (value.includes('\u0000')) {
        throw new TypeError(
          `payload${path}: 字符串包含 U+0000，PostgreSQL JSONB 无法存储`,
        );
      }
      return;
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `payload${path}: 非有限数值（NaN/Infinity）无法无损写入 JSONB`,
        );
      }
      // -0 不拒绝：JSON.stringify 与 JSONB 都会把它规范化为 0，
      // canonicalize 也输出 "0"，哈希与落库结果一致；数值计算上 -0 与 0 等价。
      return;
    case 'undefined':
      throw new TypeError(`payload${path}: undefined 无法写入 JSONB`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`payload${path}: ${typeof value} 无法写入 JSONB`);
    case 'object':
      break;
  }

  const obj = value as object;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const item = (obj as unknown[])[i];
      if (item === undefined) {
        throw new TypeError(
          `payload${path}[${i}]: 数组元素为 undefined，JSONB 会写成 null`,
        );
      }
      assertJsonSafe(item, `${path}[${i}]`);
    }
    return;
  }

  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `payload${path}: 非纯对象 ${Object.prototype.toString.call(obj)} 无法无损写入 JSONB`,
    );
  }

  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    // 对象属性 undefined：JSON.stringify / JSONB 会剔除该键，canonicalize 同规则
    if (item === undefined) continue;
    assertJsonSafe(item, `${path}.${key}`);
  }
}

/**
 * 计算事件哈希（SHA-256）。
 *
 * 输入为规范化后的固定字段集合：
 *   identity_id / schema_version / engine_version /
 *   causation_id / correlation_id / previous_event_hash / event
 * 不包含 event_hash 自身与 sequence（后者由数据库分配）。
 *
 * 版本显式传入（D 阶段）：
 * - 函数内部禁止读取全局 SCHEMA_VERSION / ENGINE_VERSION
 * - 新写入时调用方传当前全局版本
 * - 历史事件验证时调用方必须传数据库行自身的版本，
 *   否则用今天的版本去重算旧哈希必然不匹配
 *
 * engineVersion 允许为 null：数据库列可为 NULL，
 * 历史行按其原值参与规范化，不做兜底替换（否则会改变旧哈希语义）。
 */
export interface ComputeEventHashParams {
  identityId: string;
  schemaVersion: number;
  engineVersion: string | null;
  causationId: string | null;
  correlationId: string | null;
  previousEventHash: string | null;
  event: MarrowEvent;
}

export function computeEventHash(params: ComputeEventHashParams): string {
  const canonical = canonicalize({
    identity_id: params.identityId,
    schema_version: params.schemaVersion,
    engine_version: params.engineVersion,
    causation_id: params.causationId,
    correlation_id: params.correlationId,
    previous_event_hash: params.previousEventHash,
    event: params.event,
  });
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/** appendEvent 的可选溯源参数 */
export interface AppendEventOptions {
  /** 因果链：引发本事件的上游事件 ID */
  causationId?: string;
  /** 相关链：同一逻辑操作内的关联 ID（如一次对话的请求 ID） */
  correlationId?: string;
  /** 身份覆盖（默认 marrow-primary；模拟工具用 marrow-sim 隔离） */
  identityId?: string;
}

/**
 * 批量追加事件到 PostgreSQL 事件流（M1.2.2.1）。
 *
 * 整批事件在**同一个事务**中写入：
 * 1. 事务开始时只获取一次 pg_advisory_xact_lock(hashtext(identity))——
 *    锁持有到事务提交，其他同 identity 的写入无法插入到这批事件中间
 * 2. 只读取一次链尾（genesis 为 NULL）
 * 3. 按数组顺序逐条计算 previous_event_hash / event_hash 并插入，
 *    形成一条连续的哈希链
 * 4. 任意一条插入失败 → 整个事务回滚：本批新增 0 条，链尾不变
 * 5. 只有全部成功才提交
 *
 * 幂等（与单条写入规则一致）：event_id 冲突时比较不可变事件内容 + 元数据
 * （identity_id / event_type / timestamp / payload / causation_id /
 * correlation_id / schema_version / engine_version），全部一致才视为重试成功。
 * 注意：重试命中已存在事件时**不推进批内 previousHash**——
 * 该事件已在链的旧位置，后续新事件必须挂在当前链尾之后，不能错误地接在旧事件后面。
 *
 * @throws 数据库不可用、载荷触碰 JSONB 边界、任一条 event_id 碰撞时抛错，
 *   抛出时整批回滚，绝不静默回退到 JSONL
 */
export async function appendEvents(
  events: MarrowEvent[],
  opts: AppendEventOptions = {},
): Promise<void> {
  if (events.length === 0) return;

  // 写库前先对整批做 JSONB 无损校验：NaN/Infinity/BigInt/非纯对象等会被
  // JSON.stringify 或 PostgreSQL 静默改写，必须在边界处明确拒绝。
  for (const event of events) {
    assertJsonSafe(event);
  }

  const sql = getDb();
  const identityId = opts.identityId ?? IDENTITY_ID;
  const causationId = opts.causationId ?? null;
  const correlationId = opts.correlationId ?? null;

  await sql.begin(async (tx) => {
    // 1. 事务级 advisory lock：整批只加一次锁，持有到 COMMIT/ROLLBACK
    await tx`SELECT pg_advisory_xact_lock(hashtext(${identityId}))`;

    // 2. 读一次链尾（genesis 事件 previous_event_hash 为 NULL）
    const tail = await tx<{ event_hash: string }[]>`
      SELECT event_hash FROM events
      WHERE identity_id = ${identityId}
      ORDER BY sequence DESC
      LIMIT 1
    `;
    let previousHash = tail.length > 0 ? tail[0]!.event_hash : null;

    // 3. 按批次顺序写入，链顺序 == sequence 顺序
    for (const event of events) {
      const eventHash = computeEventHash({
        identityId,
        // 新写入事件固定使用当前版本
        schemaVersion: SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION,
        causationId,
        correlationId,
        previousEventHash: previousHash,
        event,
      });

      // 内联行对象（postgres.js 类型推断要求 payload 为 sql.json 参数类型）
      const inserted = await tx<{ event_hash: string }[]>`
        INSERT INTO events ${tx({
          event_id: event.id,
          identity_id: identityId,
          timestamp: event.timestamp,
          event_type: event.type,
          schema_version: SCHEMA_VERSION,
          engine_version: ENGINE_VERSION,
          causation_id: causationId,
          correlation_id: correlationId,
          previous_event_hash: previousHash,
          event_hash: eventHash,
          payload: sql.json(event as unknown as Record<string, unknown>),
        })}
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_hash
      `;

      if (inserted.length > 0) {
        previousHash = eventHash; // 链尾前移
        continue;
      }

      // 4. 冲突路径：幂等语义 = 不可变事件内容 + 元数据全部一致
      //
      //    只比较 payload 不够：跨身份复用同一 event_id 会被静默吞掉；
      //    timestamp / causation_id / correlation_id / 版本等元数据差异也必须拒绝。
      //    timestamp 用 SQL 侧相等比较，避免 JS Date 只保留毫秒精度造成误判。
      const existing = await tx<
        {
          identity_id: string;
          event_type: string;
          timestamp_equal: boolean;
          payload: unknown;
          causation_id: string | null;
          correlation_id: string | null;
          schema_version: number;
          engine_version: string | null;
        }[]
      >`
        SELECT
          identity_id,
          event_type,
          ("timestamp" = ${event.timestamp}::timestamptz) AS timestamp_equal,
          payload,
          causation_id,
          correlation_id,
          schema_version,
          engine_version
        FROM events
        WHERE event_id = ${event.id}
      `;
      if (existing.length === 0) {
        // 理论上不可达（ON CONFLICT 未插入却查不到），防御性抛错
        throw new Error(`event_id 冲突但查询不到已有记录: ${event.id}`);
      }

      const row = existing[0]!;
      const mismatches: string[] = [];
      if (row.identity_id !== identityId) mismatches.push('identity_id');
      if (row.event_type !== event.type) mismatches.push('event_type');
      if (row.timestamp_equal !== true) mismatches.push('timestamp');
      if (canonicalize(row.payload) !== canonicalize(event)) {
        mismatches.push('payload');
      }
      if (row.causation_id !== causationId) mismatches.push('causation_id');
      if (row.correlation_id !== correlationId) mismatches.push('correlation_id');
      if (row.schema_version !== SCHEMA_VERSION) mismatches.push('schema_version');
      if (row.engine_version !== ENGINE_VERSION) mismatches.push('engine_version');

      if (mismatches.length > 0) {
        throw new Error(
          `event_id 碰撞：${event.id} 已存在且不可变内容不一致` +
            `（字段: ${mismatches.join(', ')}），拒绝覆盖`,
        );
      }
      // 全部一致：幂等重试，数据库原记录保持不变；
      // 关键：不推进 previousHash（该事件在链的旧位置，不是本批的链尾）
    }
  });
}

/**
 * 追加单个事件（原有接口保留）。
 *
 * 内部复用 appendEvents 的同一事务语义，避免无关调用方发生变更。
 *
 * @throws 数据库不可用、载荷触碰 JSONB 边界、event_id 碰撞（内容不一致）时抛错，
 *   绝不静默回退到 JSONL
 */
export async function appendEvent(
  event: MarrowEvent,
  opts: AppendEventOptions = {},
): Promise<void> {
  await appendEvents([event], opts);
}

/**
 * 从 PostgreSQL 加载指定身份的全部事件（按全局顺序）。
 *
 * @param identityId 身份 ID（默认 marrow-primary）
 * @returns 事件日志（回放输入）
 */
export async function loadEvents(
  identityId: string = IDENTITY_ID,
): Promise<EventLog> {
  const sql = getDb();
  const rows = await sql<{ payload: MarrowEvent }[]>`
    SELECT payload FROM events
    WHERE identity_id = ${identityId}
    ORDER BY sequence ASC
  `;
  return rows.map((r) => r.payload);
}

/**
 * 持久化事件行（M1.2.4 启动恢复专用）。
 *
 * 与 loadEvents 的区别：loadEvents 只返回 payload（丢失行级元数据），
 * 本结构携带数据库行的全部不可变元数据——
 * sequence / schema_version / engine_version / 哈希链字段，
 * 供启动恢复做「按行自身版本」的兼容性校验与错误精确定位。
 *
 * sequence 以字符串表示（BIGSERIAL 可能超出 JS 安全整数）。
 */
export interface PersistedEventRow {
  sequence: string;
  event_id: string;
  identity_id: string;
  /** TIMESTAMPTZ 列：连接层配置 timezone=UTC，postgres.js 可能返回 string 或 Date */
  timestamp: string | Date;
  event_type: string;
  schema_version: number;
  engine_version: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  previous_event_hash: string | null;
  event_hash: string;
  payload: MarrowEvent;
}

/**
 * 加载指定身份的全部持久化事件行（含行级元数据，按链顺序）。
 *
 * 只读查询，仅供 M1.2.4 启动恢复路径使用；
 * 常规回放继续使用 loadEvents（只取 payload）。
 */
export async function loadEventRows(
  identityId: string = IDENTITY_ID,
): Promise<PersistedEventRow[]> {
  const sql = getDb();
  return await sql<PersistedEventRow[]>`
    SELECT
      sequence::text AS sequence,
      event_id,
      identity_id,
      "timestamp",
      event_type,
      schema_version,
      engine_version,
      causation_id,
      correlation_id,
      previous_event_hash,
      event_hash,
      payload
    FROM events
    WHERE identity_id = ${identityId}
    ORDER BY events.sequence ASC
  `;
}

/**
 * Dashboard / 开发者层只读查询：事件计数。
 *
 * 用途：/api/runtime 端点返回 eventCount。
 * 只做 SELECT COUNT。绝不影响写入路径。
 */
export async function countEvents(identityId: string = IDENTITY_ID): Promise<number> {
  const sql = getDb();
  const rows = await sql`SELECT COUNT(*)::int AS c FROM events WHERE identity_id = ${identityId}`;
  return (rows[0] as { c: number }).c;
}

/**
 * Dashboard / 开发者层只读查询：分页 + 过滤获取事件行。
 *
 * 用途：Dashboard /api/events 端点、CLI 工具。
 * 与 loadEventRows 的区别：支持 limit/offset/type/since/until。
 *
 * 只做 SELECT。绝不影响任何写入路径或 replay 正确性。
 */
export interface QueryEventRowsOptions {
  /** 上限 200，默认 50 */
  limit?: number;
  /** 默认 0（兼容旧分页；新调用方应优先使用 sequence 游标） */
  offset?: number;
  /**
   * 游标分页：仅返回 sequence < beforeSequence 的行（更早的事件页）。
   * 十进制数字字符串——BIGSERIAL 可能超出 JS 安全整数，禁止传 Number。
   */
  beforeSequence?: string;
  /**
   * 游标分页：仅返回 sequence > afterSequence 的行（比游标更新的事件）。
   * 十进制数字字符串，规则同上。
   */
  afterSequence?: string;
  /** event_type 过滤，可单值或数组 */
  type?: string | string[];
  /** timestamp >= ISO 8601 */
  since?: string;
  /** timestamp <= ISO 8601 */
  until?: string;
}

export async function queryEventRows(
  identityId: string = IDENTITY_ID,
  options: QueryEventRowsOptions = {},
): Promise<PersistedEventRow[]> {
  const sql = getDb();
  const { limit = 50, offset = 0, type, since, until, beforeSequence, afterSequence } = options;

  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const safeOffset = Math.max(0, Math.floor(offset));
  const types = Array.isArray(type) ? type : (type ? [type] : null);

  // 游标必须是十进制数字字符串（调用方契约），参数化 + 显式 bigint 转换，
  // 避免精度丢失，也绝不拼接进 SQL 文本。
  const SEQUENCE_CURSOR_PATTERN = /^\d+$/;
  if (beforeSequence !== undefined && !SEQUENCE_CURSOR_PATTERN.test(beforeSequence)) {
    throw new TypeError(`beforeSequence 必须是十进制数字字符串，收到: ${beforeSequence.slice(0, 32)}`);
  }
  if (afterSequence !== undefined && !SEQUENCE_CURSOR_PATTERN.test(afterSequence)) {
    throw new TypeError(`afterSequence 必须是十进制数字字符串，收到: ${afterSequence.slice(0, 32)}`);
  }

  const whereClauses: any[] = [sql`identity_id = ${identityId}`];
  if (types && types.length > 0) {
    whereClauses.push(sql`event_type IN ${sql(types)}`);
  }
  if (since) {
    whereClauses.push(sql`"timestamp" >= ${since}`);
  }
  if (until) {
    whereClauses.push(sql`"timestamp" <= ${until}`);
  }
  if (beforeSequence !== undefined) {
    whereClauses.push(sql`sequence < ${beforeSequence}::bigint`);
  }
  if (afterSequence !== undefined) {
    whereClauses.push(sql`sequence > ${afterSequence}::bigint`);
  }

  const combined = whereClauses.reduce(
    (acc, clause, i) => (i === 0 ? clause : sql`${acc} AND ${clause}`),
    sql``,
  );

  return (await sql`
    SELECT
      sequence::text AS sequence,
      event_id, identity_id, "timestamp", event_type,
      schema_version, engine_version, causation_id, correlation_id,
      previous_event_hash, event_hash, payload
    FROM events
    WHERE ${combined}
    ORDER BY sequence DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `) as PersistedEventRow[];
}

/**
 * 生成事件唯一 ID
 *
 * 格式：timestamp-random
 * 用途：event_id 去重约束 + 哈希种子；不携带任何业务语义。
 */
export function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
