/**
 * storage.pg.test.ts — PostgreSQL 事件链可靠性集成测试（M1.2.2）
 *
 * 覆盖：
 * - 并发写入 50 条事件：全部成功、event_id 唯一、无分叉、链完整、可重算哈希
 * - 幂等性 6 例：不可变内容 + 元数据任一不同即拒绝，冲突后原记录不变
 * - JSONB 序列化边界：浮点/极小数/大安全整数/null/空数组/嵌套/中文/键序
 * - 故障与事务：连接失败报错、插入失败回滚、链不中断、恢复后继续、无 JSONL 回退
 *
 * 测试 identity 与正式 identity 完全隔离，结束后清理测试数据。
 * 数据库不可用时全部用例跳过（不影响纯逻辑测试）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  appendEvent,
  canonicalize,
  computeEventHash,
  ENGINE_VERSION,
  EVENT_LOG_PATH,
  IDENTITY_ID,
  SCHEMA_VERSION,
} from '../storage.js';
import { getDb, closeDb, resetDbForTest } from '../db/connection.js';
import type { MarrowEvent, TickEvent } from '../events.js';

/** 专用测试身份（与 marrow-primary 完全隔离） */
const TEST_IDENTITY = 'marrow-test-122';
const OTHER_IDENTITY = 'marrow-test-122-other';
/** D 阶段：旧版本 genesis 行专用身份 */
const VERSIONED_IDENTITY = 'marrow-test-122-versioned';

/** 本次运行的事件 ID 前缀，避免与历史测试数据冲突 */
const RUN_TAG = `m122-${Date.now()}`;

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

async function countRows(identityId: string): Promise<number> {
  const sql = getDb();
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM events WHERE identity_id = ${identityId}
  `;
  return Number(count);
}

function timestampMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * 全面校验一条身份的哈希链。
 * 任何一条断言失败都会带上具体序号，便于定位。
 *
 * allowHistoricalVersions：
 * - false（默认）：要求每行使用当前全局版本（验证新写入行为）
 * - true：允许混合版本（用于旧版本历史行验证），但仍要求版本字段合法，
 *   哈希重算一律使用行自身版本
 */
function verifyChain(
  rows: EventRow[],
  identityId: string,
  opts: { allowHistoricalVersions?: boolean } = {},
): void {
  assert.ok(rows.length > 0, '事件流不应为空');

  // 1. event_id 全局唯一
  const ids = new Set(rows.map((r) => r.event_id));
  assert.equal(ids.size, rows.length, 'event_id 必须全部唯一');

  // 2. 只有一条 genesis，且必须位于 sequence 最小处
  const genesis = rows.filter((r) => r.previous_event_hash === null);
  assert.equal(genesis.length, 1, '每个身份只能有一条 genesis 事件');
  assert.equal(rows[0]!.previous_event_hash, null, '首条事件的 previous_event_hash 必须为 NULL');

  // 3. sequence 严格递增（链顺序 == 全局顺序）
  let lastSeq = -1n;
  // 4. 无分叉：任一前驱哈希只能被一个事件引用
  const predecessorRefs = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const seq = BigInt(row.sequence);
    assert.ok(seq > lastSeq, `sequence 必须严格递增（第 ${i} 条）`);
    lastSeq = seq;

    assert.equal(row.identity_id, identityId, `identity_id 不一致（第 ${i} 条）`);
    if (opts.allowHistoricalVersions) {
      assert.ok(row.schema_version > 0, `schema_version 非法（第 ${i} 条）`);
    } else {
      assert.equal(row.schema_version, SCHEMA_VERSION, `schema_version 不一致（第 ${i} 条）`);
      assert.equal(row.engine_version, ENGINE_VERSION, `engine_version 不一致（第 ${i} 条）`);
    }

    // 5. previous 链正确指向前一条的 event_hash
    if (i > 0) {
      assert.equal(
        row.previous_event_hash,
        rows[i - 1]!.event_hash,
        `previous_event_hash 未指向前一条事件（第 ${i} 条）`,
      );
    }

    // 6. 分叉检测
    if (row.previous_event_hash !== null) {
      assert.ok(
        !predecessorRefs.has(row.previous_event_hash),
        `哈希链分叉：前驱 ${row.previous_event_hash} 被多条事件引用`,
      );
      predecessorRefs.add(row.previous_event_hash);
    }

    // 7. 元数据与载荷一致
    assert.equal(row.payload.id, row.event_id, `payload.id 与 event_id 不一致（第 ${i} 条）`);
    assert.equal(row.payload.type, row.event_type, `payload.type 与 event_type 不一致（第 ${i} 条）`);
    assert.equal(
      timestampMs(row.timestamp),
      new Date(row.payload.timestamp).getTime(),
      `timestamp 列与载荷不一致（第 ${i} 条）`,
    );

    // 8. 哈希重算一致（必须使用该行自身的版本，而非当前全局版本）
    const recomputed = computeEventHash({
      identityId: row.identity_id,
      schemaVersion: row.schema_version,
      engineVersion: row.engine_version,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      previousEventHash: row.previous_event_hash,
      event: row.payload,
    });
    assert.equal(recomputed, row.event_hash, `哈希重算不一致（第 ${i} 条）`);
  }
}

/** 固定 ISO 时间戳 */
function iso(offsetMs: number, base = '2026-01-01T00:00:00.000Z'): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function tickEvent(id: string, timestamp: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id, timestamp, payload: { deltaSeconds } };
}

/** 读取 V1 JSONL 归档指纹（用于验证"绝不回退/写入 JSONL"） */
function archiveFingerprint(): { size: number; sha256: string } | null {
  if (!existsSync(EVENT_LOG_PATH)) return null;
  const content = readFileSync(EVENT_LOG_PATH, 'utf-8');
  return {
    size: content.length,
    sha256: createHash('sha256').update(content, 'utf-8').digest('hex'),
  };
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
  await sql`DELETE FROM events WHERE identity_id = ${TEST_IDENTITY}`;
  await sql`DELETE FROM events WHERE identity_id = ${OTHER_IDENTITY}`;
  await sql`DELETE FROM events WHERE identity_id = ${VERSIONED_IDENTITY}`;
});

after(async () => {
  if (dbReady) {
    const sql = getDb();
    await sql`DELETE FROM events WHERE identity_id = ${TEST_IDENTITY}`;
    await sql`DELETE FROM events WHERE identity_id = ${OTHER_IDENTITY}`;
    await sql`DELETE FROM events WHERE identity_id = ${VERSIONED_IDENTITY}`;
  }
  await closeDb();
});

// ==================================================================
// 一、并发写入
// ==================================================================
test('并发写入 50 条事件：全部成功且哈希链完整', { skip }, async () => {
  const primaryCountBefore = await countRows(IDENTITY_ID);
  const events: TickEvent[] = Array.from({ length: 50 }, (_, i) =>
    tickEvent(`${RUN_TAG}-conc-${i}`, iso(i * 1000)),
  );

  await Promise.all(
    events.map((event) => appendEvent(event, { identityId: TEST_IDENTITY })),
  );

  const rows = await fetchRows(TEST_IDENTITY);
  assert.equal(rows.length, 50, '50 条并发事件必须全部写入');
  assert.equal(await countRows(TEST_IDENTITY), 50);

  verifyChain(rows, TEST_IDENTITY);

  // 写入的 event_id 与提交集合完全一致
  assert.deepEqual(
    new Set(rows.map((r) => r.event_id)),
    new Set(events.map((e) => e.id)),
  );

  // 与正式身份完全隔离
  assert.equal(await countRows(IDENTITY_ID), primaryCountBefore, '不得写入 marrow-primary');
});

// ==================================================================
// 二、幂等性
// ==================================================================
test('幂等性：相同 event_id + 完全相同内容 → 成功且不重复写入', { skip }, async () => {
  const event: TickEvent = tickEvent(`${RUN_TAG}-idem-base`, iso(60_000), 10);
  const opts = { identityId: TEST_IDENTITY, causationId: 'cause-x', correlationId: 'corr-x' };

  await appendEvent(event, opts);
  await appendEvent(event, opts); // 重试
  assert.equal(await countRows(TEST_IDENTITY) >= 1, true);
  const rows = (await fetchRows(TEST_IDENTITY)).filter((r) => r.event_id === event.id);
  assert.equal(rows.length, 1, '相同 event_id 只能存在一条记录');
});

test('幂等性：链增长后重试同一事件仍成功（不比较 previous_event_hash / event_hash）', { skip }, async () => {
  const retryId = `${RUN_TAG}-idem-retry`;
  const event: TickEvent = tickEvent(retryId, iso(61_000), 10);
  const opts = { identityId: TEST_IDENTITY, causationId: 'cause-retry' };

  await appendEvent(event, opts);
  // 链尾变化：插入一条新事件
  await appendEvent(tickEvent(`${RUN_TAG}-idem-retry-tail`, iso(62_000), 10), {
    identityId: TEST_IDENTITY,
  });
  // 合法重试：此时若按 event_hash 比较必然误判，必须按内容判定
  await appendEvent(event, opts);

  const rows = (await fetchRows(TEST_IDENTITY)).filter((r) => r.event_id === retryId);
  assert.equal(rows.length, 1, '重试不得产生新行');
});

test('幂等性：相同 event_id + 不同 payload → 拒绝且原记录不变', { skip }, async () => {
  const id = `${RUN_TAG}-idem-payload`;
  const original = tickEvent(id, iso(70_000), 10);
  const opts = { identityId: TEST_IDENTITY, causationId: 'cause-p' };

  await appendEvent(original, opts);
  const before = (await fetchRows(TEST_IDENTITY)).find((r) => r.event_id === id)!;

  await assert.rejects(
    appendEvent({ ...original, payload: { deltaSeconds: 11 } }, opts),
    /event_id 碰撞/,
  );

  const afterRow = (await fetchRows(TEST_IDENTITY)).find((r) => r.event_id === id)!;
  assert.deepEqual(afterRow, before, '冲突后原记录不得发生变化');
});

test('幂等性：相同 event_id + 不同 timestamp → 拒绝', { skip }, async () => {
  const id = `${RUN_TAG}-idem-ts`;
  const opts = { identityId: TEST_IDENTITY };
  const original = tickEvent(id, iso(80_000), 10);

  await appendEvent(original, opts);
  await assert.rejects(
    appendEvent({ ...original, timestamp: iso(80_001) }, opts),
    /timestamp/,
  );
});

test('幂等性：相同 event_id + 不同 event_type → 拒绝', { skip }, async () => {
  const id = `${RUN_TAG}-idem-type`;
  const opts = { identityId: TEST_IDENTITY };
  const original = tickEvent(id, iso(90_000), 10);

  await appendEvent(original, opts);
  const otherType = {
    type: 'environment',
    id,
    timestamp: original.timestamp,
    payload: { feature: 'temperature', reading: 22, moodDelta: 0, salience: 0.1 },
  } as unknown as MarrowEvent;

  await assert.rejects(appendEvent(otherType, opts), /event_type/);
});

test('幂等性：相同 event_id + 不同 identity → 明确拒绝（不静默吞掉）', { skip }, async () => {
  const id = `${RUN_TAG}-idem-identity`;
  const timestamp = iso(100_000);
  const event = tickEvent(id, timestamp, 10);

  await appendEvent(event, { identityId: TEST_IDENTITY });
  const original = (await fetchRows(TEST_IDENTITY)).find((r) => r.event_id === id)!;

  await assert.rejects(
    appendEvent(event, { identityId: OTHER_IDENTITY }),
    /identity_id/,
  );

  // 其他身份不得因冲突产生任何行
  assert.equal(await countRows(OTHER_IDENTITY), 0);
  const stillThere = (await fetchRows(TEST_IDENTITY)).find((r) => r.event_id === id)!;
  assert.deepEqual(stillThere, original);
});

// ==================================================================
// 三、JSONB 序列化边界
// ==================================================================
test('JSONB 边界：浮点/极小数/大安全整数/null/空数组/嵌套/Unicode/键序往返一致', { skip }, async () => {
  const id = `${RUN_TAG}-jsonb-edge`;
  const timestamp = iso(110_000);

  const edgePayload = {
    deltaSeconds: 0.1 + 0.2, // 0.30000000000000004
    tiny: 1e-7,
    bigSafe: 9007199254740991,
    nullValue: null,
    emptyArr: [],
    emptyObj: {},
    negative: -123.456,
    negZero: -0,
    trailingZero: 1.0,
    nested: { z: 1, a: { arr: [1, 2, { d: '中文' }], s: 'é😀' }, m: true },
    unicode: '中文 emoji 😀 café',
    keyOrder: { z: 1, a: 2, M: 3, 10: 4, 2: 5 },
  };
  // 注入自定义字段：仅用于存储层边界测试，不参与状态机回放
  const event = {
    type: 'tick',
    id,
    timestamp,
    payload: edgePayload,
  } as unknown as TickEvent;

  await appendEvent(event, { identityId: TEST_IDENTITY });

  const row = (await fetchRows(TEST_IDENTITY)).find((r) => r.event_id === id)!;

  // canonical JSON 语义一致（键序无关）
  assert.equal(
    canonicalize(row.payload),
    canonicalize(event),
    'JSONB 往返后 canonical JSON 必须完全一致',
  );

  const roundTripped = row.payload as unknown as { payload: typeof edgePayload };
  const p = roundTripped.payload;
  assert.equal(p.deltaSeconds, 0.30000000000000004);
  assert.equal(p.tiny, 1e-7);
  assert.equal(p.bigSafe, 9007199254740991);
  assert.equal(p.nullValue, null);
  assert.deepEqual(p.emptyArr, []);
  assert.deepEqual(p.emptyObj, {});
  assert.equal(p.negative, -123.456);
  // -0 经 JSONB 规范化为 +0（canonicalize 同样输出 "0"，哈希不受影响）
  assert.equal(p.negZero, 0);
  assert.equal(p.trailingZero, 1);
  assert.deepEqual(p.nested, { z: 1, a: { arr: [1, 2, { d: '中文' }], s: 'é😀' }, m: true });
  assert.equal(p.unicode, '中文 emoji 😀 café');
  assert.deepEqual(p.keyOrder, { z: 1, a: 2, M: 3, 10: 4, 2: 5 });

  // 哈希重算仍一致（按行自身版本）
  const recomputed = computeEventHash({
    identityId: row.identity_id,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    previousEventHash: row.previous_event_hash,
    event: row.payload,
  });
  assert.equal(recomputed, row.event_hash);
});

// ==================================================================
// 三之二、版本化哈希（D 阶段）
// ==================================================================
test('版本化哈希：旧版本 genesis 行按行自身版本重算匹配，按当前版本重算不匹配', { skip }, async () => {
  const eventId = `${RUN_TAG}-legacy-genesis`;
  const timestamp = iso(200_000);
  const event = tickEvent(eventId, timestamp, 10);

  // 模拟一条历史行：写入时使用的是旧 schema / 旧 engine
  const legacySchema = SCHEMA_VERSION - 1;
  const legacyEngine = 'marrow@0.8.0-legacy';
  const legacyHash = computeEventHash({
    identityId: VERSIONED_IDENTITY,
    schemaVersion: legacySchema,
    engineVersion: legacyEngine,
    causationId: null,
    correlationId: null,
    previousEventHash: null, // genesis
    event,
  });

  // 直接插入旧版本 genesis 行（不回写、不改结构）
  const sql = getDb();
  await sql`
    INSERT INTO events (
      event_id, identity_id, "timestamp", event_type, schema_version,
      engine_version, causation_id, correlation_id,
      previous_event_hash, event_hash, payload
    ) VALUES (
      ${eventId}, ${VERSIONED_IDENTITY}, ${timestamp}::timestamptz, 'tick',
      ${legacySchema}, ${legacyEngine}, NULL, NULL,
      NULL, ${legacyHash},
      ${sql.json(event as unknown as Record<string, unknown>)}
    )
  `;

  const rows = await fetchRows(VERSIONED_IDENTITY);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.previous_event_hash, null, '旧版本 genesis 的前驱必须为 NULL');
  assert.equal(row.schema_version, legacySchema, '行版本不得被改写');
  assert.equal(row.engine_version, legacyEngine, '行引擎版本不得被改写');
  assert.equal(row.event_hash, legacyHash, '历史哈希不得被重写');

  // 链校验：必须用行自身版本，才能重算出匹配的哈希
  verifyChain(rows, VERSIONED_IDENTITY, { allowHistoricalVersions: true });

  // 显式再算一次：按行自身版本 → 匹配
  const fromRow = computeEventHash({
    identityId: row.identity_id,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    previousEventHash: row.previous_event_hash,
    event: row.payload,
  });
  assert.equal(fromRow, row.event_hash, '按行自身版本重算必须匹配');

  // 按当前全局版本重算 → 必须不匹配（证明版本确实参与哈希）
  const fromCurrent = computeEventHash({
    identityId: row.identity_id,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    previousEventHash: row.previous_event_hash,
    event: row.payload,
  });
  assert.notEqual(fromCurrent, row.event_hash, '按当前全局版本重算不得匹配旧哈希');

  console.log(
    `[EVIDENCE] 版本化哈希：行版本 schema=${row.schema_version}/engine=${row.engine_version}；` +
      `按行版本匹配=${fromRow === row.event_hash}；` +
      `按当前版本(schema=${SCHEMA_VERSION}/engine=${ENGINE_VERSION})匹配=${
        fromCurrent === row.event_hash
      }`,
  );
});

// ==================================================================
// 四、数据库链完整性约束
// ==================================================================
test('数据库约束：同一前驱哈希被二次引用（分叉）被拒绝', { skip }, async () => {
  const rows = await fetchRows(TEST_IDENTITY);
  assert.ok(rows.length >= 3, '需要至少 3 条事件才能构造分叉');

  // 取中间事件作为前驱：它已经有一个后继 rows[2]
  const parent = rows[1]!;
  const forkId = `${RUN_TAG}-fork`;
  const forkTimestamp = iso(150_000);
  const sql = getDb();

  await assert.rejects(
    sql`
      INSERT INTO events (
        event_id, identity_id, "timestamp", event_type, schema_version,
        engine_version, causation_id, correlation_id,
        previous_event_hash, event_hash, payload
      ) VALUES (
        ${forkId}, ${TEST_IDENTITY}, ${forkTimestamp}::timestamptz, 'tick',
        ${SCHEMA_VERSION}, ${ENGINE_VERSION}, NULL, NULL,
        ${parent.event_hash}, ${'f'.repeat(64)},
        ${sql.json({ type: 'tick', id: forkId, timestamp: forkTimestamp, payload: { deltaSeconds: 10 } })}
      )
    `,
    /duplicate key|unique/i,
  );

  // 分叉记录不得落库
  const afterRows = await fetchRows(TEST_IDENTITY);
  assert.equal(afterRows.length, rows.length);
  assert.equal(afterRows.some((r) => r.event_id === forkId), false);
});

// ==================================================================
// 五、故障与事务
// ==================================================================
test('故障：插入失败时事务回滚，哈希链不断裂', { skip }, async () => {
  const rowsBefore = await fetchRows(TEST_IDENTITY);
  const tailBefore = rowsBefore[rowsBefore.length - 1]!.event_hash;
  const archiveBefore = archiveFingerprint();

  // 非法 timestamp 会在 INSERT 阶段失败（此时 advisory lock 与读链尾已执行）
  const badEvent = tickEvent(`${RUN_TAG}-bad-insert`, 'not-a-timestamp', 10);
  await assert.rejects(
    appendEvent(badEvent, { identityId: TEST_IDENTITY }),
    /invalid input syntax|timestamp/i,
  );

  const rowsAfterFail = await fetchRows(TEST_IDENTITY);
  assert.equal(rowsAfterFail.length, rowsBefore.length, '失败写入不得留下记录');
  assert.equal(rowsAfterFail[rowsAfterFail.length - 1]!.event_hash, tailBefore, '链尾不得变化');

  // 失败后继续写入：previous_event_hash 必须仍指向失败前的链尾
  const nextEvent = tickEvent(`${RUN_TAG}-after-fail`, iso(120_000), 10);
  await appendEvent(nextEvent, { identityId: TEST_IDENTITY });
  const rowsAfterNext = await fetchRows(TEST_IDENTITY);
  const newRow = rowsAfterNext[rowsAfterNext.length - 1]!;
  assert.equal(newRow.event_id, nextEvent.id);
  assert.equal(newRow.previous_event_hash, tailBefore, '失败写入不得造成链断裂');
  verifyChain(rowsAfterNext, TEST_IDENTITY);

  // 无 JSONL 回退
  if (archiveBefore) {
    assert.deepEqual(archiveFingerprint(), archiveBefore, 'V1 JSONL 归档不得被写入');
  }
});

test('故障：数据库连接失败时 appendEvent 报错，恢复后继续写入', { skip }, async () => {
  const archiveBefore = archiveFingerprint();
  const rowsBefore = await fetchRows(TEST_IDENTITY);
  const tailBefore = rowsBefore[rowsBefore.length - 1]!.event_hash;
  const realUrl = process.env.DATABASE_URL!;

  // 1. 指向不可达端口（ECONNREFUSED，快速失败）
  //    C3.1：故障注入专用 resetDbForTest（丢弃连接池、允许换 URL 重建），
  //    不是生产关闭路径（closeDb 是终态）
  await resetDbForTest();
  process.env.DATABASE_URL = 'postgres://marrow:marrow@127.0.0.1:1/marrow';

  await assert.rejects(
    appendEvent(tickEvent(`${RUN_TAG}-db-down`, iso(130_000), 10), {
      identityId: TEST_IDENTITY,
    }),
    /ECONNREFUSED|connect|CONNECT|connection/i,
  );

  // 2. 无静默 JSONL 回退
  if (archiveBefore) {
    assert.deepEqual(archiveFingerprint(), archiveBefore, '连接失败不得回退写入 JSONL');
  }

  // 3. 恢复连接后继续写入
  await resetDbForTest();
  process.env.DATABASE_URL = realUrl;

  await appendEvent(tickEvent(`${RUN_TAG}-db-recovered`, iso(131_000), 10), {
    identityId: TEST_IDENTITY,
  });

  const rowsAfter = await fetchRows(TEST_IDENTITY);
  const newRow = rowsAfter[rowsAfter.length - 1]!;
  assert.equal(newRow.previous_event_hash, tailBefore, '恢复后必须接着原链尾写入');
  verifyChain(rowsAfter, TEST_IDENTITY);
});

test('故障：DATABASE_URL 缺失时拒绝写入，绝不静默降级', { skip }, async () => {
  const realUrl = process.env.DATABASE_URL!;
  await resetDbForTest();
  delete process.env.DATABASE_URL;

  await assert.rejects(
    appendEvent(tickEvent(`${RUN_TAG}-no-url`, iso(140_000), 10), {
      identityId: TEST_IDENTITY,
    }),
    /DATABASE_URL is not set/,
  );

  process.env.DATABASE_URL = realUrl;
});
