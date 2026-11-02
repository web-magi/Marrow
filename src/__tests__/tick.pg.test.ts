/**
 * tick.pg.test.ts — Tick 批量事务原子性集成测试（M1.2.2.1）
 *
 * 覆盖：
 * - appendEvents 整批 10 条全部成功、哈希链完整、sequence 与链顺序一致
 * - 第 1 / 5 / 最后一条事件插入失败 → 整批回滚，数据库 0 条新增
 * - 失败后原链尾不变，重试同一批次可成功写入
 * - 批量写入与并发单条/其他批量写入不交错（同 identity 连续）
 * - executeTick 失败时 state / lastTickTime / tickCount 不推进，
 *   下一轮 tick 补偿时间差，重试成功后 replay == session.state
 *
 * 全部使用真实 PostgreSQL，测试 identity 带统一前缀，结束后清理。
 * 数据库不可用时全部用例跳过（不影响纯逻辑测试）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEvent,
  appendEvents,
  computeEventHash,
  ENGINE_VERSION,
  loadEvents,
  SCHEMA_VERSION,
} from '../storage.js';
import { getDb, closeDb } from '../db/connection.js';
import { replay } from '../replay.js';
import { createInitialState } from '../state.js';
import { createSimulatedSensors } from '../sensors.js';
import { executeTick, type TickSession } from '../tick.js';
import { InMemoryObservationInbox } from '../observation.js';
import type { MarrowEvent, TickEvent } from '../events.js';

/** 本阶段测试 identity 统一前缀（便于一次性清理） */
const TEST_PREFIX = 'marrow-test-1221';

/** 各用例独立 identity，互不干扰 */
const ID_BATCH = `${TEST_PREFIX}-batch`;
const ID_FAIL_FIRST = `${TEST_PREFIX}-fail-first`;
const ID_FAIL_MID = `${TEST_PREFIX}-fail-mid`;
const ID_FAIL_LAST = `${TEST_PREFIX}-fail-last`;
const ID_RETRY = `${TEST_PREFIX}-retry`;
const ID_CONC = `${TEST_PREFIX}-conc`;
const ID_TICK = `${TEST_PREFIX}-tick`;

/** 本次运行的 event_id 前缀，避免与历史测试残留冲突 */
const RUN_TAG = `m1221-${Date.now()}`;

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

/** 链尾哈希（空链为 null） */
async function tailHash(identityId: string): Promise<string | null> {
  const rows = await fetchRows(identityId);
  const last = rows[rows.length - 1];
  return last ? last.event_hash : null;
}

/** 固定 ISO 时间戳 */
function iso(offsetMs: number, base = '2026-01-01T00:00:00.000Z'): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function tickEvent(id: string, timestamp: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id, timestamp, payload: { deltaSeconds } };
}

/** 生成一批 10 条连续 tick 事件（event_id 唯一） */
function makeBatch(tag: string, count = 10): TickEvent[] {
  return Array.from({ length: count }, (_, i) =>
    tickEvent(`${RUN_TAG}-${tag}-${i}`, iso(1_000_000 + i * 1000), 10),
  );
}

/**
 * 把批次中第 index 条事件的 timestamp 改成非法值。
 * assertJsonSafe 允许任意字符串，因此失败发生在 PostgreSQL INSERT 阶段，
 * 恰好用于验证「前 N 条已插入 → 整批回滚」。
 */
function corruptAt(events: MarrowEvent[], index: number): MarrowEvent[] {
  return events.map((event, i) =>
    i === index ? { ...event, timestamp: 'not-a-timestamp' } : event,
  );
}

/** 全面校验哈希链：唯一性、genesis、sequence 递增、前驱链接、哈希重算 */
function verifyChain(rows: EventRow[], identityId: string): void {
  assert.ok(rows.length > 0, '事件流不应为空');

  const ids = new Set(rows.map((r) => r.event_id));
  assert.equal(ids.size, rows.length, 'event_id 必须全部唯一');

  const genesis = rows.filter((r) => r.previous_event_hash === null);
  assert.equal(genesis.length, 1, '每个身份只能有一条 genesis 事件');
  assert.equal(rows[0]!.previous_event_hash, null);

  let lastSeq = -1n;
  const predecessorRefs = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const seq = BigInt(row.sequence);
    assert.ok(seq > lastSeq, `sequence 必须严格递增（第 ${i} 条）`);
    lastSeq = seq;

    assert.equal(row.identity_id, identityId, `identity_id 不一致（第 ${i} 条）`);
    assert.equal(row.schema_version, SCHEMA_VERSION, `schema_version 不一致（第 ${i} 条）`);
    assert.equal(row.engine_version, ENGINE_VERSION, `engine_version 不一致（第 ${i} 条）`);

    if (i > 0) {
      assert.equal(
        row.previous_event_hash,
        rows[i - 1]!.event_hash,
        `previous_event_hash 未指向前一条事件（第 ${i} 条）`,
      );
    }

    if (row.previous_event_hash !== null) {
      assert.ok(
        !predecessorRefs.has(row.previous_event_hash),
        `哈希链分叉：前驱 ${row.previous_event_hash} 被多条事件引用`,
      );
      predecessorRefs.add(row.previous_event_hash);
    }

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

// ---- 数据库可用性探测（顶层 await） ----
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

async function cleanTestIdentities(): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM events WHERE identity_id LIKE ${`${TEST_PREFIX}%`}`;
}

before(async () => {
  if (dbReady) await cleanTestIdentities();
});

after(async () => {
  if (dbReady) await cleanTestIdentities();
  await closeDb();
});

// ==================================================================
// 一、批量写入成功路径
// ==================================================================
test('批量写入：10 条事件同一事务全部提交，sequence 与链顺序一致', { skip }, async () => {
  const batch = makeBatch('batch', 10);
  await appendEvents(batch, { identityId: ID_BATCH });

  const rows = await fetchRows(ID_BATCH);
  assert.equal(rows.length, 10, '整批 10 条必须全部写入');
  assert.equal(await countRows(ID_BATCH), 10);

  // 事件顺序与数组顺序完全一致
  assert.deepEqual(
    rows.map((r) => r.event_id),
    batch.map((e) => e.id),
    'sequence 顺序必须与批次数组顺序一致',
  );

  // sequence 必须单调递增（sequence 是全局 BIGSERIAL，跨 identity 可能与其他
  // 测试进程交错分配，因此这里只校验同一身份内的递增顺序，连续性由哈希链保证）
  const seqs = rows.map((r) => BigInt(r.sequence));
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i]! > seqs[i - 1]!, 'sequence 必须严格递增');
  }

  verifyChain(rows, ID_BATCH);
});

// ==================================================================
// 二、批量写入失败回滚
// ==================================================================
test('批量失败：第 1 条插入失败 → 数据库 0 条新增', { skip }, async () => {
  // 先建立 2 条基线事件，用于验证链尾不变
  await appendEvent(tickEvent(`${RUN_TAG}-f1-seed-0`, iso(0)), { identityId: ID_FAIL_FIRST });
  await appendEvent(tickEvent(`${RUN_TAG}-f1-seed-1`, iso(1000)), { identityId: ID_FAIL_FIRST });

  const rowsBefore = await fetchRows(ID_FAIL_FIRST);
  const tailBefore = rowsBefore[rowsBefore.length - 1]!.event_hash;
  const batch = makeBatch('f1', 10);

  await assert.rejects(
    appendEvents(corruptAt(batch, 0), { identityId: ID_FAIL_FIRST }),
    /invalid input syntax|timestamp/i,
  );

  assert.equal(await countRows(ID_FAIL_FIRST), 2, '失败批次不得新增任何记录');
  assert.equal(await tailHash(ID_FAIL_FIRST), tailBefore, '链尾不得变化');
  const rowsAfter = await fetchRows(ID_FAIL_FIRST);
  assert.equal(rowsAfter.some((r) => r.event_id === batch[0]!.id), false);
});

test('批量失败（关键场景）：第 5 条插入失败 → 前 4 条一并回滚', { skip }, async () => {
  await appendEvent(tickEvent(`${RUN_TAG}-f5-seed-0`, iso(0)), { identityId: ID_FAIL_MID });
  await appendEvent(tickEvent(`${RUN_TAG}-f5-seed-1`, iso(1000)), { identityId: ID_FAIL_MID });

  const rowsBefore = await fetchRows(ID_FAIL_MID);
  const tailBefore = rowsBefore[rowsBefore.length - 1]!.event_hash;
  const batch = makeBatch('f5', 10);

  await assert.rejects(
    appendEvents(corruptAt(batch, 4), { identityId: ID_FAIL_MID }),
    /invalid input syntax|timestamp/i,
  );

  const rowsAfter = await fetchRows(ID_FAIL_MID);
  assert.equal(rowsAfter.length, 2, '前 4 条已插入的记录必须随事务回滚');
  assert.equal(await tailHash(ID_FAIL_MID), tailBefore, '链尾不得变化');
  // 前 4 条也不得残留
  for (let i = 0; i < 4; i++) {
    assert.equal(rowsAfter.some((r) => r.event_id === batch[i]!.id), false);
  }

  console.log(
    `[EVIDENCE] 第5条失败：rows ${rowsBefore.length} → ${rowsAfter.length}；` +
      `链尾 ${tailBefore.slice(0, 16)}… → ${(await tailHash(ID_FAIL_MID))?.slice(0, 16)}…；` +
      `批次残留 ${rowsAfter.filter((r) => batch.some((e) => e.id === r.event_id)).length} 条`,
  );
});

test('批量失败：最后一条插入失败 → 前面 9 条一并回滚', { skip }, async () => {
  await appendEvent(tickEvent(`${RUN_TAG}-f10-seed-0`, iso(0)), { identityId: ID_FAIL_LAST });
  await appendEvent(tickEvent(`${RUN_TAG}-f10-seed-1`, iso(1000)), { identityId: ID_FAIL_LAST });

  const rowsBefore = await fetchRows(ID_FAIL_LAST);
  const tailBefore = rowsBefore[rowsBefore.length - 1]!.event_hash;
  const batch = makeBatch('f10', 10);

  await assert.rejects(
    appendEvents(corruptAt(batch, 9), { identityId: ID_FAIL_LAST }),
    /invalid input syntax|timestamp/i,
  );

  assert.equal(await countRows(ID_FAIL_LAST), 2, '前 9 条必须随事务回滚');
  assert.equal(await tailHash(ID_FAIL_LAST), tailBefore, '链尾不得变化');
});

// ==================================================================
// 三、失败后重试
// ==================================================================
test('失败后重试：同一批次修正后成功写入，链完整且不重复', { skip }, async () => {
  await appendEvent(tickEvent(`${RUN_TAG}-retry-seed-0`, iso(0)), { identityId: ID_RETRY });
  await appendEvent(tickEvent(`${RUN_TAG}-retry-seed-1`, iso(1000)), { identityId: ID_RETRY });

  const tailBefore = await tailHash(ID_RETRY);
  const batch = makeBatch('retry', 10);

  // 第一次：第 5 条失败，整批回滚
  await assert.rejects(
    appendEvents(corruptAt(batch, 4), { identityId: ID_RETRY }),
    /invalid input syntax|timestamp/i,
  );
  assert.equal(await countRows(ID_RETRY), 2);
  assert.equal(await tailHash(ID_RETRY), tailBefore);

  // 第二次：同一批 event_id，修正 timestamp 后重试成功
  await appendEvents(batch, { identityId: ID_RETRY });

  const rowsAfter = await fetchRows(ID_RETRY);
  assert.equal(rowsAfter.length, 12, '重试必须写入完整 10 条且不重复');
  assert.deepEqual(
    rowsAfter.slice(2).map((r) => r.event_id),
    batch.map((e) => e.id),
    '重试批次顺序必须一致',
  );
  verifyChain(rowsAfter, ID_RETRY);

  // 第三条事件（新批次首条）的 previous 必须指向失败前的链尾
  assert.equal(rowsAfter[2]!.previous_event_hash, tailBefore, '重试必须接在原链尾之后');
});

// ==================================================================
// 四、并发隔离
// ==================================================================
test('并发隔离：多个批量写入 + 单条写入不互相穿插', { skip }, async () => {
  const batches = [
    makeBatch('conc-a', 4),
    makeBatch('conc-b', 4),
    makeBatch('conc-c', 4),
  ];
  const singles = [
    tickEvent(`${RUN_TAG}-conc-s0`, iso(2_000_000)),
    tickEvent(`${RUN_TAG}-conc-s1`, iso(2_001_000)),
  ];

  await Promise.all([
    appendEvents(batches[0]!, { identityId: ID_CONC }),
    appendEvents(batches[1]!, { identityId: ID_CONC }),
    appendEvent(singles[0]!, { identityId: ID_CONC }),
    appendEvents(batches[2]!, { identityId: ID_CONC }),
    appendEvent(singles[1]!, { identityId: ID_CONC }),
  ]);

  const rows = await fetchRows(ID_CONC);
  assert.equal(rows.length, 14, '3×4 + 2 条必须全部写入');
  verifyChain(rows, ID_CONC);

  // 每个批次内部的事件在全局 sequence 上必须连续：证明没有其他写入插入中间
  for (let b = 0; b < batches.length; b++) {
    const positions = rows
      .map((row, idx) => (batches[b]!.some((e) => e.id === row.event_id) ? idx : -1))
      .filter((idx) => idx >= 0);
    assert.equal(positions.length, 4);
    for (let i = 1; i < positions.length; i++) {
      assert.equal(
        positions[i],
        positions[i - 1]! + 1,
        `批次 conc-${b} 的事件被其他写入插入（位置 ${positions[i - 1]} → ${positions[i]}）`,
      );
    }
  }
});

// ==================================================================
// 五、executeTick 原子发布
// ==================================================================
test('tick 原子性：第 5 条事件失败 → DB 0 新增、内存/时间基准不变、下一轮补偿、重试后 Replay 一致', { skip }, async () => {
  const sensors = createSimulatedSensors();
  const base = Date.now();
  const persist = (events: MarrowEvent[]): Promise<void> =>
    appendEvents(events, { identityId: ID_TICK });

  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };
  const inbox = new InMemoryObservationInbox();

  // ---- 第一次 tick：成功，建立基线 ----
  const first = await executeTick(session, sensors, inbox, base + 100_000, 1, persist);
  assert.equal(first.realDeltaSeconds, 100, '100 秒真实时间');
  // 10 个子步（每步 10 秒）+ 电池 + 环境 = 12 条事件
  assert.equal(first.events.length, 12, '应生成 10 个 tick 子步 + 2 条环境事件');
  assert.equal(session.tickCount, 1);

  const rowsAfterFirst = await fetchRows(ID_TICK);
  assert.equal(rowsAfterFirst.length, first.events.length);
  verifyChain(rowsAfterFirst, ID_TICK);

  // ---- 第二次 tick：第 5 条事件在 INSERT 阶段失败 ----
  const lastTickBeforeFail = session.lastTickTime;
  const tickCountBeforeFail = session.tickCount;
  const stateBeforeFail = structuredClone(session.state);
  const rowsBeforeFail = await countRows(ID_TICK);
  const tailBeforeFail = await tailHash(ID_TICK);

  const failPersist = (events: MarrowEvent[]): Promise<void> =>
    appendEvents(corruptAt(events, 4), { identityId: ID_TICK });

  await assert.rejects(
    executeTick(session, sensors, inbox, lastTickBeforeFail + 100_000, 1, failPersist),
    /invalid input syntax|timestamp/i,
  );

  // 数据库：0 条新增，链尾不变
  assert.equal(await countRows(ID_TICK), rowsBeforeFail, '失败 tick 不得写入任何事件');
  assert.equal(await tailHash(ID_TICK), tailBeforeFail, '链尾不得变化');

  // 内存：状态与时间基准完全不变
  assert.equal(session.tickCount, tickCountBeforeFail, 'tickCount 不得推进');
  assert.equal(session.lastTickTime, lastTickBeforeFail, 'lastTickTime 不得推进');
  assert.deepEqual(session.state, stateBeforeFail, '内存状态必须与失败前完全一致');

  console.log(
    `[EVIDENCE] tick 第5条失败：DB rows ${rowsBeforeFail} → ${await countRows(ID_TICK)}；` +
      `链尾 ${String(tailBeforeFail).slice(0, 16)}… → ${String(await tailHash(ID_TICK)).slice(0, 16)}…；` +
      `tickCount ${tickCountBeforeFail} → ${session.tickCount}；` +
      `lastTickTime ${lastTickBeforeFail} → ${session.lastTickTime}；` +
      `内存状态一致=${JSON.stringify(session.state) === JSON.stringify(stateBeforeFail)}`,
  );

  // ---- 第三次 tick：补偿上一轮失败的时间差 ----
  const compensated = await executeTick(
    session,
    sensors,
    inbox,
    lastTickBeforeFail + 300_000,
    1,
    persist,
  );
  assert.equal(
    compensated.realDeltaSeconds,
    300,
    '补偿后的 delta 必须覆盖失败轮次（200 秒等待 → 从上次成功点算 300 秒）',
  );
  assert.equal(session.tickCount, tickCountBeforeFail + 1);

  // ---- Replay 必须与运行状态完全一致 ----
  const persistedEvents = await loadEvents(ID_TICK);
  const replayed = replay(persistedEvents);
  assert.deepEqual(replayed, session.state, 'Replay 结果必须与运行态内存状态一致');
  verifyChain(await fetchRows(ID_TICK), ID_TICK);

  console.log(
    `[EVIDENCE] 补偿与重放：补偿 delta=${compensated.realDeltaSeconds}s；` +
      `事件总数=${persistedEvents.length}；` +
      `Replay 与运行态一致=${JSON.stringify(replayed) === JSON.stringify(session.state)}`,
  );

  // 最终事件数 = 首轮 12 + 补偿轮 32（300s → 30 子步 + 2）
  assert.equal(persistedEvents.length, 12 + 32);
});
