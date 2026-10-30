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

/** V2 主身份 ID（Fresh Start：与 V1 历史数据完全隔离） */
export const IDENTITY_ID = 'marrow-primary';

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
 * - 对象：key 按 UTF-16 字典序排序；值为 undefined 的键剔除（匹配 JSONB 语义）；
 *   嵌套对象递归应用
 * - 数组：保持原有顺序
 * - 原始类型：JSON.stringify 语义
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
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

/**
 * 计算事件哈希（SHA-256）。
 *
 * 输入为规范化后的固定字段集合：
 *   identity_id / schema_version / engine_version /
 *   causation_id / correlation_id / previous_event_hash / event
 * 不包含 event_hash 自身与 sequence（后者由数据库分配）。
 */
export function computeEventHash(params: {
  identityId: string;
  causationId: string | null;
  correlationId: string | null;
  previousEventHash: string | null;
  event: MarrowEvent;
}): string {
  const canonical = canonicalize({
    identity_id: params.identityId,
    schema_version: SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
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
 * 追加一个事件到 PostgreSQL 事件流。
 *
 * 流程（单事务内完成，保证并发下哈希链顺序与提交顺序一致）：
 * 1. 事务级 advisory lock（按 identity 哈希）—— 同一身份的写入串行化
 * 2. 读取链尾事件哈希（genesis 为 NULL）
 * 3. 计算本事件哈希并插入
 * 4. event_id 冲突时：比较已有 payload 与新事件的规范化序列化结果——
 *    相同视为幂等重试成功；不同说明 event_id 碰撞，抛错。
 *    （注意：不能比较 event_hash——同一事件在链增长后重试时
 *      previous_event_hash 已变化，hash 必然不同；幂等语义应针对事件内容本身。）
 *
 * @throws 数据库不可用、event_id 碰撞（内容不一致）时抛错，绝不静默回退
 */
export async function appendEvent(
  event: MarrowEvent,
  opts: AppendEventOptions = {},
): Promise<void> {
  const sql = getDb();
  const identityId = opts.identityId ?? IDENTITY_ID;
  const causationId = opts.causationId ?? null;
  const correlationId = opts.correlationId ?? null;

  await sql.begin(async (tx) => {
    // 1. 事务级 advisory lock：串行化同一身份的写入，
    //    保证哈希链读取-写入的原子性，不依赖 BIGSERIAL 分配顺序
    await tx`SELECT pg_advisory_xact_lock(hashtext(${identityId}))`;

    // 2. 读链尾（genesis 事件 previous_event_hash 为 NULL）
    const tail = await tx<{ event_hash: string }[]>`
      SELECT event_hash FROM events
      WHERE identity_id = ${identityId}
      ORDER BY sequence DESC
      LIMIT 1
    `;
    const previousHash = tail.length > 0 ? tail[0]!.event_hash : null;

    // 3. 计算哈希并插入
    const eventHash = computeEventHash({
      identityId,
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

    if (inserted.length > 0) return; // 正常插入

    // 4. 冲突路径：幂等语义 = 事件内容一致
    const existing = await tx<{ payload: unknown }[]>`
      SELECT payload FROM events WHERE event_id = ${event.id}
    `;
    if (existing.length === 0) {
      // 理论上不可达（ON CONFLICT 未插入却查不到），防御性抛错
      throw new Error(`event_id 冲突但查询不到已有记录: ${event.id}`);
    }
    if (canonicalize(existing[0]!.payload) !== canonicalize(event)) {
      throw new Error(
        `event_id 碰撞：${event.id} 已存在且内容不一致，拒绝覆盖`,
      );
    }
    // 内容一致：幂等重试，视为成功
  });
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
 * 生成事件唯一 ID
 *
 * 格式：timestamp-random
 * 用途：event_id 去重约束 + 哈希种子；不携带任何业务语义。
 */
export function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
