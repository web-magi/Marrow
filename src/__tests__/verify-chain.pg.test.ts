/**
 * verify-chain.pg.test.ts — 独立哈希链验证器集成测试（M1.2.3）
 *
 * 覆盖：
 * 1. 正常完整哈希链通过
 * 2. payload 篡改被发现（hash_mismatch，且不误报 metadata_mismatch）
 * 3. event_hash 篡改被发现
 * 4. previous_event_hash 断裂被发现（chain_broken）
 * 5. sequence 顺序异常被发现（乱序即断链）
 * 6. 混合 schema_version / engine_version 的历史链按行自身版本验证通过
 * 6b. 历史行版本字段被篡改被发现
 * 7. 不同 identity 数据隔离
 * 8. 空链返回独立 verdict='empty'（不得与 valid 混淆）
 * 9. 大规模事件链（2000 条）验证
 * 10. 验证过程绝不修改数据库原始数据（对已篡改链验证，前后逐行一致）
 * 11. genesis 缺失被发现
 *
 * 说明：
 * - 夹具搭建允许使用 appendEvents（"验证器独立于写入流程"约束的是
 *   verify-chain.ts 模块本身，测试准备阶段不在约束范围内）；
 *   篡改一律通过直接 SQL UPDATE 完成，模拟绕过写入路径的破坏。
 * - duplicate_event_id 分支无法通过真实 PostgreSQL 触发（event_id 是全局
 *   UNIQUE 列，重复行物理上不可能存在），该检查为防御性兜底，无对应用例。
 * - 测试 identity 统一使用 m123- 前缀，与正式身份及其他测试完全隔离。
 * - 数据库不可用时全部用例跳过（不影响纯逻辑测试）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEvents,
  computeEventHash,
  SCHEMA_VERSION,
  ENGINE_VERSION,
} from '../storage.js';
import { getDb, closeDb } from '../db/connection.js';
import { verifyEventChain } from '../verify-chain.js';
import type { MarrowEvent, TickEvent } from '../events.js';

/** 本次运行的 identity 前缀，避免与历史测试数据冲突 */
const RUN_TAG = `m123-${Date.now()}`;

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

async function fetchRows(identityId: string): Promise<EventRow[]> {
  const sql = getDb();
  return await sql<EventRow[]>`
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

/** 固定 ISO 时间戳 */
function iso(offsetMs: number, base = '2026-01-01T00:00:00.000Z'): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function tickEvent(id: string, timestamp: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id, timestamp, payload: { deltaSeconds } };
}

/** 向指定 identity 追加 n 条 tick 事件（时间戳单调递增） */
async function appendTickBatch(
  identityId: string,
  n: number,
  idPrefix: string,
  offsetStart = 0,
  stepMs = 1000,
): Promise<void> {
  const events: TickEvent[] = Array.from({ length: n }, (_, i) =>
    tickEvent(`${idPrefix}-${i}`, iso(offsetStart + i * stepMs)),
  );
  await appendEvents(events, { identityId });
}

// ---- 数据库可用性探测（顶层 await，可用时启用集成用例） ----
let dbReady = false;
if (process.env.DATABASE_URL) {
  try {
    const sql = getDb();
    await sql`SELECT 1`;
    dbReady = true;
  } catch {
    dbReady = false;
  }
}

const skip = !dbReady ? 'PostgreSQL 不可用，跳过集成测试' : false;

before(async () => {
  if (!dbReady) return;
  const sql = getDb();
  await sql`DELETE FROM events WHERE identity_id LIKE 'm123-%'`;
});

after(async () => {
  if (dbReady) {
    const sql = getDb();
    await sql`DELETE FROM events WHERE identity_id LIKE 'm123-%'`;
  }
  await closeDb();
});

// ==================================================================
// 1. 正常完整哈希链通过
// ==================================================================
test('正常链：10 条事件验证通过', { skip }, async () => {
  const identity = `${RUN_TAG}-ok`;
  await appendTickBatch(identity, 10, `${identity}-e`);

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'valid');
  assert.equal(report.eventCount, 10);
  assert.equal(report.errors.length, 0);
  assert.ok(report.firstSequence !== null);
  assert.ok(report.lastSequence !== null);
  assert.ok(report.headHash !== null);
  assert.ok(report.tailHash !== null);

  const rows = await fetchRows(identity);
  assert.equal(report.headHash, rows[0]!.event_hash, 'headHash 必须是 genesis 的哈希');
  assert.equal(report.tailHash, rows[rows.length - 1]!.event_hash, 'tailHash 必须是链尾哈希');
});

// ==================================================================
// 2. payload 篡改被发现
// ==================================================================
test('篡改检测：payload 内容被修改（列与版本不动）→ hash_mismatch', { skip }, async () => {
  const identity = `${RUN_TAG}-tamper-payload`;
  await appendTickBatch(identity, 3, `${identity}-e`);

  const rows = await fetchRows(identity);
  const victim = rows[1]!;

  // 只改 payload 内部的 deltaSeconds，保持 payload.id/type/timestamp 与列一致：
  // 证明验证器能把"内容篡改"精确定位为 hash_mismatch，而非笼统的元数据不一致
  const tamperedPayload = {
    ...(victim.payload as unknown as Record<string, unknown>),
    payload: { deltaSeconds: 999 },
  };
  const sql = getDb();
  await sql`
    UPDATE events
    SET payload = ${sql.json(tamperedPayload)}
    WHERE event_id = ${victim.event_id}
  `;

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'invalid');

  const hashErrors = report.errors.filter(
    (e) => e.kind === 'hash_mismatch' && e.eventId === victim.event_id,
  );
  assert.equal(hashErrors.length, 1, '被篡改行必须产生恰好一条 hash_mismatch');
  assert.equal(hashErrors[0]!.sequence, victim.sequence, '错误必须携带正确定位');
  assert.equal(hashErrors[0]!.identityId, identity);
  assert.ok(hashErrors[0]!.expected !== undefined && hashErrors[0]!.actual !== undefined);

  // 精确定位：不应误报 metadata_mismatch（列与 payload 标识仍一致）
  assert.equal(
    report.errors.filter((e) => e.kind === 'metadata_mismatch').length,
    0,
    '只改 payload 内容不应触发 metadata_mismatch',
  );
});

// ==================================================================
// 3. event_hash 篡改被发现
// ==================================================================
test('篡改检测：末行 event_hash 被改写 → hash_mismatch，且不误报断链', { skip }, async () => {
  const identity = `${RUN_TAG}-tamper-hash`;
  await appendTickBatch(identity, 3, `${identity}-e`);

  const rows = await fetchRows(identity);
  const victim = rows[rows.length - 1]!; // 篡改末行，避免波及后续行的链接检查

  const sql = getDb();
  await sql`
    UPDATE events
    SET event_hash = ${'f'.repeat(64)}
    WHERE event_id = ${victim.event_id}
  `;

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'invalid');

  const hashErrors = report.errors.filter(
    (e) => e.kind === 'hash_mismatch' && e.eventId === victim.event_id,
  );
  assert.equal(hashErrors.length, 1, '被篡改行必须产生 hash_mismatch');
  assert.equal(
    report.errors.filter((e) => e.kind === 'chain_broken').length,
    0,
    '末行哈希被改不应造成断链误报（没有后续行引用它）',
  );
});

// ==================================================================
// 4. previous_event_hash 断裂被发现
// ==================================================================
test('篡改检测：中间行 previous_event_hash 指向未知哈希 → chain_broken', { skip }, async () => {
  const identity = `${RUN_TAG}-broken`;
  await appendTickBatch(identity, 4, `${identity}-e`);

  const rows = await fetchRows(identity);
  const victim = rows[2]!;

  const sql = getDb();
  // 指向一个未被任何事件引用的全新哈希（避开部分唯一索引）
  await sql`
    UPDATE events
    SET previous_event_hash = ${'a'.repeat(64)}
    WHERE event_id = ${victim.event_id}
  `;

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'invalid');

  const broken = report.errors.filter(
    (e) => e.kind === 'chain_broken' && e.eventId === victim.event_id,
  );
  assert.equal(broken.length, 1, '断链必须定位到被篡改行');
  assert.equal(broken[0]!.sequence, victim.sequence);
  assert.equal(broken[0]!.expected, rows[1]!.event_hash, '期望值必须是前一行的 event_hash');
  assert.equal(broken[0]!.actual, 'a'.repeat(64));
});

// ==================================================================
// 5. sequence 顺序异常被发现
// ==================================================================
test('篡改检测：相邻两行 sequence 被交换 → 读出顺序错乱即断链', { skip }, async () => {
  const identity = `${RUN_TAG}-seq`;
  await appendTickBatch(identity, 4, `${identity}-e`);

  const rows = await fetchRows(identity);
  const rowB = rows[1]!;
  const rowC = rows[2]!;

  // 交换 B/C 的 sequence（经 -1 中转避免主键冲突）
  const sql = getDb();
  await sql`UPDATE events SET sequence = -1 WHERE event_id = ${rowB.event_id}`;
  await sql`UPDATE events SET sequence = ${Number(rowB.sequence)} WHERE event_id = ${rowC.event_id}`;
  await sql`UPDATE events SET sequence = ${Number(rowC.sequence)} WHERE event_id = ${rowB.event_id}`;

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'invalid');

  // 乱序后按 sequence 读出的行序与哈希链指向不再一致 → chain_broken
  const broken = report.errors.filter((e) => e.kind === 'chain_broken');
  assert.ok(broken.length >= 1, 'sequence 乱序必须以 chain_broken 形式暴露');
  // 被交换的两行都参与了断链（C 的前驱变成 A；D 的前驱变成 B）
  const brokenIds = new Set(broken.map((e) => e.eventId));
  assert.ok(
    brokenIds.has(rowC.event_id) || brokenIds.has(rowB.event_id),
    '断链必须定位到被交换的行',
  );
});

// ==================================================================
// 6. 混合 schema_version / engine_version 的历史链验证
// ==================================================================
test('混合版本链：schema=1/engine=NULL 的 genesis + 当前版本后续事件 → valid', { skip }, async () => {
  const identity = `${RUN_TAG}-mixed`;
  const genesisEvent = tickEvent(`${identity}-legacy-genesis`, iso(0), 10);

  // 直接插入旧版本 genesis（模拟历史行：写入时用旧 schema、无引擎版本）
  const legacySchema = SCHEMA_VERSION - 1;
  const legacyHash = computeEventHash({
    identityId: identity,
    schemaVersion: legacySchema,
    engineVersion: null, // 历史行允许 engine_version 为 NULL
    causationId: null,
    correlationId: null,
    previousEventHash: null,
    event: genesisEvent,
  });

  const sql = getDb();
  await sql`
    INSERT INTO events (
      event_id, identity_id, "timestamp", event_type, schema_version,
      engine_version, causation_id, correlation_id,
      previous_event_hash, event_hash, payload
    ) VALUES (
      ${genesisEvent.id}, ${identity}, ${genesisEvent.timestamp}::timestamptz, 'tick',
      ${legacySchema}, NULL, NULL, NULL,
      NULL, ${legacyHash},
      ${sql.json(genesisEvent as unknown as Record<string, unknown>)}
    )
  `;

  // 后续事件走正常写入路径（当前版本），挂在旧版本 genesis 之后
  await appendTickBatch(identity, 3, `${identity}-e`, 1000);

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'valid', '混合版本链必须按各行自身版本验证通过');
  assert.equal(report.eventCount, 4);
  assert.equal(report.errors.length, 0);

  // 确认行版本未被改写（验证器只读）
  const rows = await fetchRows(identity);
  assert.equal(rows[0]!.schema_version, legacySchema);
  assert.equal(rows[0]!.engine_version, null);
  assert.equal(rows[1]!.schema_version, SCHEMA_VERSION);
  assert.equal(rows[1]!.engine_version, ENGINE_VERSION);
});

// ==================================================================
// 6b. 历史行版本字段被篡改被发现
// ==================================================================
test('混合版本链：genesis 的 schema_version 被改写 → hash_mismatch', { skip }, async () => {
  const identity = `${RUN_TAG}-mixed-tampered`;
  const genesisEvent = tickEvent(`${identity}-legacy-genesis`, iso(0), 10);

  const legacySchema = SCHEMA_VERSION - 1;
  const legacyHash = computeEventHash({
    identityId: identity,
    schemaVersion: legacySchema,
    engineVersion: null,
    causationId: null,
    correlationId: null,
    previousEventHash: null,
    event: genesisEvent,
  });

  const sql = getDb();
  await sql`
    INSERT INTO events (
      event_id, identity_id, "timestamp", event_type, schema_version,
      engine_version, causation_id, correlation_id,
      previous_event_hash, event_hash, payload
    ) VALUES (
      ${genesisEvent.id}, ${identity}, ${genesisEvent.timestamp}::timestamptz, 'tick',
      ${legacySchema}, NULL, NULL, NULL,
      NULL, ${legacyHash},
      ${sql.json(genesisEvent as unknown as Record<string, unknown>)}
    )
  `;

  // 篡改：把历史行的版本改成当前版本（版本参与哈希，改动必然暴露）
  await sql`
    UPDATE events SET schema_version = ${SCHEMA_VERSION}
    WHERE event_id = ${genesisEvent.id}
  `;

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'invalid');
  const hashErrors = report.errors.filter(
    (e) => e.kind === 'hash_mismatch' && e.eventId === genesisEvent.id,
  );
  assert.equal(hashErrors.length, 1, '版本篡改必须以 hash_mismatch 暴露');
});

// ==================================================================
// 7. 不同 identity 的数据隔离
// ==================================================================
test('identity 隔离：篡改 B 不影响 A 的验证结论', { skip }, async () => {
  const identityA = `${RUN_TAG}-iso-a`;
  const identityB = `${RUN_TAG}-iso-b`;
  await appendTickBatch(identityA, 3, `${identityA}-e`);
  await appendTickBatch(identityB, 3, `${identityB}-e`);

  // 篡改 B 的一条 payload
  const rowsB = await fetchRows(identityB);
  const victim = rowsB[0]!;
  const tamperedPayload = {
    ...(victim.payload as unknown as Record<string, unknown>),
    payload: { deltaSeconds: 777 },
  };
  const sql = getDb();
  await sql`
    UPDATE events
    SET payload = ${sql.json(tamperedPayload)}
    WHERE event_id = ${victim.event_id}
  `;

  const reportA = await verifyEventChain(identityA);
  assert.equal(reportA.verdict, 'valid', 'A 的链未被篡改，必须验证通过');
  assert.equal(reportA.eventCount, 3, 'A 的验证不得计入 B 的事件');

  const reportB = await verifyEventChain(identityB);
  assert.equal(reportB.verdict, 'invalid');
  assert.equal(reportB.eventCount, 3);
  assert.ok(
    reportB.errors.every((e) => e.identityId === identityB),
    'B 的错误必须全部归属 B，不得串到 A',
  );
});

// ==================================================================
// 8. 空链处理
// ==================================================================
test('空链：返回独立 verdict=empty，不得作为验证通过的证据', { skip }, async () => {
  const report = await verifyEventChain(`${RUN_TAG}-nonexistent`);
  assert.equal(report.verdict, 'empty');
  assert.notEqual(report.verdict, 'valid', '空链绝不得判定为 valid');
  assert.equal(report.eventCount, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.firstSequence, null);
  assert.equal(report.lastSequence, null);
  assert.equal(report.headHash, null);
  assert.equal(report.tailHash, null);
});

// ==================================================================
// 9. 大规模事件链验证
// ==================================================================
test('大规模链：2000 条事件验证通过', { skip }, async () => {
  const identity = `${RUN_TAG}-large`;
  // 分 8 批写入，每批 250 条（覆盖 appendEvents 批量路径 + 链持续增长）
  for (let batch = 0; batch < 8; batch++) {
    const events: TickEvent[] = Array.from({ length: 250 }, (_, i) => {
      const n = batch * 250 + i;
      return tickEvent(`${identity}-e-${n}`, iso(n * 100));
    });
    await appendEvents(events, { identityId: identity });
  }

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'valid');
  assert.equal(report.eventCount, 2000);
  assert.equal(report.errors.length, 0);

  const rows = await fetchRows(identity);
  assert.equal(report.headHash, rows[0]!.event_hash);
  assert.equal(report.tailHash, rows[rows.length - 1]!.event_hash);
});

// ==================================================================
// 10. 验证过程不会修改数据库原始数据
// ==================================================================
test('只读保证：对已篡改链执行验证，数据库行逐字节不变（不自动修复）', { skip }, async () => {
  const identity = `${RUN_TAG}-readonly`;
  await appendTickBatch(identity, 3, `${identity}-e`);

  // 先制造篡改（中间行 event_hash 被改写 → 链无效）
  const rows = await fetchRows(identity);
  const victim = rows[1]!;
  const sql = getDb();
  await sql`
    UPDATE events SET event_hash = ${'d'.repeat(64)}
    WHERE event_id = ${victim.event_id}
  `;

  const beforeRows = await fetchRows(identity);
  const report = await verifyEventChain(identity);
  const afterRows = await fetchRows(identity);

  assert.equal(report.verdict, 'invalid', '前置条件：链确实无效');
  assert.ok(report.errors.length > 0);

  // 验证器发现问题后绝不做任何修复/重写
  assert.deepEqual(afterRows, beforeRows, '验证过程不得修改任何数据库行');
});

// ==================================================================
// 11. genesis 缺失被发现
// ==================================================================
test('篡改检测：首行 previous_event_hash 被改为非 NULL → genesis_missing', { skip }, async () => {
  const identity = `${RUN_TAG}-no-genesis`;
  await appendTickBatch(identity, 3, `${identity}-e`);

  const rows = await fetchRows(identity);
  const genesis = rows[0]!;

  const sql = getDb();
  await sql`
    UPDATE events SET previous_event_hash = ${'b'.repeat(64)}
    WHERE event_id = ${genesis.event_id}
  `;

  const report = await verifyEventChain(identity);
  assert.equal(report.verdict, 'invalid');

  const missing = report.errors.filter((e) => e.kind === 'genesis_missing');
  assert.equal(missing.length, 1, '必须报告 genesis 缺失');
  assert.equal(missing[0]!.identityId, identity);
});
