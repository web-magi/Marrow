/**
 * verify-chain.ts — 独立哈希链验证器（M1.2.3）
 *
 * 对 PostgreSQL 中指定 identity 的完整事件链做**只读**完整性验证。
 *
 * 独立性约束（本阶段的根本要求）：
 * - 本模块只 import 只读查询入口（getDb）与纯函数（computeEventHash /
 *   canonicalize），**绝不 import appendEvent / appendEvents 等写入路径**，
 *   验证逻辑与 EventStore 写入流程完全解耦。
 * - 绝不修改、修复、删除或重写任何事件，绝不自动重建哈希链。
 * - 历史版本验证（D 阶段规则）：重算哈希时使用**每行自身**的
 *   schema_version / engine_version，不使用当前全局版本，
 *   否则用今天的版本重算旧哈希必然误报。
 *
 * 与 replay.ts 的 validateEventLog 的关系：
 * - validateEventLog 校验的是"内存中的事件数组"（ID 唯一 + 时间戳单调），
 *   供回放前置检查使用，本阶段不做任何改动、不放宽其语义。
 * - verifyEventChain 校验的是"数据库中的持久化链"，检测篡改、断链、
 *   分叉、顺序异常、版本异常与元数据不一致，二者职责不同、互不替代。
 *
 * 空链语义：空事件链返回 verdict='empty'，与 'valid' 严格区分——
 * 空链不能作为非空事件链验证通过的证据。
 */

import { getDb } from './db/connection.js';
import type { MarrowEvent } from './events.js';
import { computeEventHash } from './storage.js';

/** 验证发现的问题类型 */
export type ChainErrorKind =
  /** 行 identity_id 与查询目标不符（WHERE 过滤下理论上不可达，防御性检查） */
  | 'identity_mismatch'
  /**
   * event_id 重复。
   * 注意：event_id 是全局 UNIQUE 列，真实数据库中无法存在重复行，
   * 本检查为防御性兜底（例如未来约束被移除、或验证对象换成非 PG 数据源时）。
   */
  | 'duplicate_event_id'
  /** event_hash 不是 64 位小写十六进制 */
  | 'invalid_hash_format'
  /** 链中不存在 previous_event_hash 为 NULL 的 genesis 事件（首行即非 genesis） */
  | 'genesis_missing'
  /** genesis 事件（prevHash=NULL）出现在非首行位置 */
  | 'genesis_not_first'
  /** 当前行的 previous_event_hash 未指向前一行（按 sequence 排序）的 event_hash */
  | 'chain_broken'
  /** 同一前驱哈希被多条事件引用（分叉） */
  | 'chain_fork'
  /** sequence 未严格递增（ORDER BY 下理论上不可达，防御性检查） */
  | 'sequence_not_increasing'
  /** schema_version 不是正整数 */
  | 'version_anomaly'
  /** 数据库列与 payload 内容不一致（event_id / event_type / timestamp） */
  | 'metadata_mismatch'
  /** payload.timestamp 未随 sequence 单调递增 */
  | 'timestamp_regression'
  /**
   * 按行自身版本重算的哈希与存储的 event_hash 不一致。
   * 覆盖三类篡改：payload 被改、event_hash 被改、版本字段被改。
   */
  | 'hash_mismatch';

/** 单条验证错误，携带精确定位信息 */
export interface ChainVerificationError {
  /** 错误类型 */
  kind: ChainErrorKind;
  /** 被验证的 identity */
  identityId: string;
  /** 出错行的 sequence（BIGSERIAL，以字符串表示避免精度问题；链级错误为 null） */
  sequence: string | null;
  /** 出错行的 event_id（无法定位到具体行时为 null） */
  eventId: string | null;
  /** 人类可读的错误描述 */
  message: string;
  /** 期望值（可选，用于哈希比对类错误） */
  expected?: string;
  /** 实际值（可选） */
  actual?: string;
}

/** 验证报告 */
export interface ChainVerificationReport {
  /** 被验证的 identity */
  identityId: string;
  /**
   * 验证结论：
   * - 'valid'：链非空且全部检查通过
   * - 'invalid'：发现至少一处问题（详见 errors）
   * - 'empty'：该 identity 无任何事件——空链不是"验证通过"，
   *   不得作为非空链完整性的证据
   */
  verdict: 'valid' | 'invalid' | 'empty';
  /** 事件总数 */
  eventCount: number;
  /** 首行 sequence（空链为 null） */
  firstSequence: string | null;
  /** 末行 sequence（空链为 null） */
  lastSequence: string | null;
  /** genesis 事件的 event_hash（空链为 null） */
  headHash: string | null;
  /** 链尾事件的 event_hash（空链为 null） */
  tailHash: string | null;
  /** 全部错误（收集而非停在第一处，便于一次审计定位所有问题） */
  errors: ChainVerificationError[];
  /** 本次验证执行时间（ISO 8601） */
  checkedAt: string;
}

/** events 表行结构（sequence::text 取出，避免 BIGINT 精度问题） */
interface EventRow {
  sequence: string;
  event_id: string;
  identity_id: string;
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

/** 64 位小写十六进制（SHA-256 的规范输出形式） */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function timestampMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * 验证指定 identity 的完整事件链（只读，绝不写入）。
 *
 * 执行一次 SELECT 拉取全链后，在内存中完成全部检查：
 * 1. 逐行检查：identity 一致性、event_hash 格式、schema_version 合法性、
 *    列与 payload 一致性、按行自身版本重算哈希
 * 2. 链级检查：genesis 唯一且在首位、逐环链接、分叉、sequence 递增、
 *    payload.timestamp 单调
 *
 * @param identityId 目标身份 ID
 * @returns 验证报告（valid / invalid / empty）
 */
export async function verifyEventChain(
  identityId: string,
): Promise<ChainVerificationReport> {
  const sql = getDb();

  // 唯一的数据库访问：只读 SELECT。本函数绝不执行任何 INSERT/UPDATE/DELETE。
  const rows = await sql<EventRow[]>`
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

  const checkedAt = new Date().toISOString();

  // 空链：独立判定，不得与 valid 混淆
  if (rows.length === 0) {
    return {
      identityId,
      verdict: 'empty',
      eventCount: 0,
      firstSequence: null,
      lastSequence: null,
      headHash: null,
      tailHash: null,
      errors: [],
      checkedAt,
    };
  }

  const errors: ChainVerificationError[] = [];
  const push = (err: ChainVerificationError): void => {
    errors.push(err);
  };

  const seenEventIds = new Set<string>();
  const predecessorRefs = new Set<string>();
  let genesisCount = 0;
  let lastSequence = -1n;
  let lastPayloadTimestamp: number | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const at = `sequence=${row.sequence} event_id=${row.event_id}`;

    // ---- 逐行检查 ----

    // 1. identity 一致性（WHERE 过滤下不可达，防御性）
    if (row.identity_id !== identityId) {
      push({
        kind: 'identity_mismatch',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message: `行 identity_id 与验证目标不一致（${at}）`,
        expected: identityId,
        actual: row.identity_id,
      });
    }

    // 2. event_id 重复（全局 UNIQUE 约束下不可达，防御性）
    if (seenEventIds.has(row.event_id)) {
      push({
        kind: 'duplicate_event_id',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message: `event_id 重复（${at}）`,
      });
    }
    seenEventIds.add(row.event_id);

    // 3. event_hash 格式
    if (!HASH_PATTERN.test(row.event_hash)) {
      push({
        kind: 'invalid_hash_format',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message: `event_hash 不是 64 位小写十六进制（${at}）`,
        actual: row.event_hash,
      });
    }

    // 4. schema_version 合法性（正整数）
    if (!Number.isInteger(row.schema_version) || row.schema_version <= 0) {
      push({
        kind: 'version_anomaly',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message: `schema_version 非法（${at}）`,
        actual: String(row.schema_version),
      });
    }

    // 5. 列与 payload 一致性（篡改者可能只改了列或只改了 payload）
    const payload = row.payload as unknown as Record<string, unknown> | null;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      push({
        kind: 'metadata_mismatch',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message: `payload 不是对象，无法校验列一致性（${at}）`,
      });
    } else {
      if (payload.id !== row.event_id) {
        push({
          kind: 'metadata_mismatch',
          identityId,
          sequence: row.sequence,
          eventId: row.event_id,
          message: `payload.id 与 event_id 列不一致（${at}）`,
          expected: row.event_id,
          actual: String(payload.id),
        });
      }
      if (payload.type !== row.event_type) {
        push({
          kind: 'metadata_mismatch',
          identityId,
          sequence: row.sequence,
          eventId: row.event_id,
          message: `payload.type 与 event_type 列不一致（${at}）`,
          expected: row.event_type,
          actual: String(payload.type),
        });
      }
      if (
        typeof payload.timestamp !== 'string' ||
        timestampMs(row.timestamp) !== new Date(payload.timestamp).getTime()
      ) {
        push({
          kind: 'metadata_mismatch',
          identityId,
          sequence: row.sequence,
          eventId: row.event_id,
          message: `payload.timestamp 与 timestamp 列不一致（${at}）`,
          expected: new Date(timestampMs(row.timestamp)).toISOString(),
          actual: String(payload.timestamp),
        });
      }
    }

    // 6. 按行自身版本重算哈希（D 阶段版本感知规则）
    //    payload 篡改、event_hash 篡改、版本字段篡改都会在此暴露。
    //    注意：即使 schema_version 非法也照常重算——版本异常已单独报告，
    //    重算结果提供额外证据，不冲突。
    const recomputed = computeEventHash({
      identityId: row.identity_id,
      schemaVersion: row.schema_version,
      engineVersion: row.engine_version,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      previousEventHash: row.previous_event_hash,
      event: row.payload,
    });
    if (recomputed !== row.event_hash) {
      push({
        kind: 'hash_mismatch',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message:
          `按行自身版本（schema=${row.schema_version}, engine=${row.engine_version}）` +
          `重算哈希与存储值不一致（${at}）`,
        expected: recomputed,
        actual: row.event_hash,
      });
    }

    // ---- 链级检查 ----

    // 7. genesis：prevHash 为 NULL 的事件全链必须恰好一条，且位于首行
    if (row.previous_event_hash === null) {
      genesisCount++;
      if (i > 0) {
        push({
          kind: 'genesis_not_first',
          identityId,
          sequence: row.sequence,
          eventId: row.event_id,
          message: `genesis 事件（previous_event_hash=NULL）出现在非首行（${at}）`,
        });
      }
    }

    // 8. 逐环链接：当前行 prevHash 必须等于前一行 event_hash
    if (i > 0 && row.previous_event_hash !== rows[i - 1]!.event_hash) {
      push({
        kind: 'chain_broken',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message: `哈希链断裂：previous_event_hash 未指向前一行（${at}）`,
        expected: rows[i - 1]!.event_hash,
        actual: row.previous_event_hash ?? 'NULL',
      });
    }

    // 9. 分叉：同一前驱哈希只能被引用一次
    if (row.previous_event_hash !== null) {
      if (predecessorRefs.has(row.previous_event_hash)) {
        push({
          kind: 'chain_fork',
          identityId,
          sequence: row.sequence,
          eventId: row.event_id,
          message: `哈希链分叉：前驱被多条事件引用（${at}）`,
          actual: row.previous_event_hash,
        });
      }
      predecessorRefs.add(row.previous_event_hash);
    }

    // 10. sequence 严格递增（ORDER BY 保证，防御性）
    const seq = BigInt(row.sequence);
    if (seq <= lastSequence) {
      push({
        kind: 'sequence_not_increasing',
        identityId,
        sequence: row.sequence,
        eventId: row.event_id,
        message: `sequence 未严格递增（${at}）`,
        expected: `> ${lastSequence}`,
        actual: row.sequence,
      });
    }
    lastSequence = seq;

    // 11. payload.timestamp 单调递增（与 validateEventLog 的内存检查同向，
    //     但这里针对的是持久化链）
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const tsRaw = (payload as Record<string, unknown>).timestamp;
      if (typeof tsRaw === 'string') {
        const ts = new Date(tsRaw).getTime();
        if (!Number.isNaN(ts)) {
          if (lastPayloadTimestamp !== null && ts < lastPayloadTimestamp) {
            push({
              kind: 'timestamp_regression',
              identityId,
              sequence: row.sequence,
              eventId: row.event_id,
              message: `payload.timestamp 时间倒退（${at}）`,
              expected: `>= ${new Date(lastPayloadTimestamp).toISOString()}`,
              actual: tsRaw,
            });
          }
          lastPayloadTimestamp = ts;
        }
      }
    }
  }

  // genesis 缺失：整条链没有任何 prevHash=NULL 的事件
  if (genesisCount === 0) {
    push({
      kind: 'genesis_missing',
      identityId,
      sequence: rows[0]!.sequence,
      eventId: rows[0]!.event_id,
      message: '事件链缺少 genesis 事件（没有任何 previous_event_hash=NULL 的行）',
    });
  }

  return {
    identityId,
    verdict: errors.length === 0 ? 'valid' : 'invalid',
    eventCount: rows.length,
    firstSequence: rows[0]!.sequence,
    lastSequence: rows[rows.length - 1]!.sequence,
    headHash: rows[0]!.event_hash,
    tailHash: rows[rows.length - 1]!.event_hash,
    errors,
    checkedAt,
  };
}
