/**
 * recovery.pg.test.ts — M1.2.4 确定性 Replay 与启动恢复集成测试
 *
 * 覆盖规格 26 项（编号与任务书 §9 对应）：
 *
 * A. 确定性
 *  A1  同一事件日志恢复两次，完整结果 deepStrictEqual
 *  A2  resetDbForTest 重建连接池（模拟独立进程实例）后恢复结果一致
 *  A3  恢复不依赖 LLM：recoverIdentity 零必填参数，无 LLM 配置也成功
 *  A4  恢复不读取传感器：recoverIdentity 不接受 SensorProvider
 *  A5  恢复不产生新事件（只读）
 *  A6  两次恢复间隔 wall-clock 后结果仍一致
 *
 * B. 启动恢复
 *  B7  正常「关闭」后恢复状态 == 关闭前最后提交状态 == replay(loadEvents)
 *  B8  模拟异常退出（丢弃全部内存运行时）→ 恢复最后一个完整提交批次
 *  B9  空事件链 → verdict=empty（合法新身份）
 *  B10 不同 identity 状态完全隔离
 *  B11 哈希链损坏 → recoverIdentityOrThrow 抛 RecoveryError（启动被阻止）
 *
 * C. PostgreSQL 事务边界
 *  C12 Tick 批次全部提交后恢复成功且事件数完整
 *  C13 Tick 批次中途失败回滚 → 恢复结果不包含该批次
 *  C14 提交成功后立即「终止」（不做任何内存交接直接恢复）→ 包含完整批次
 *  C15 commit-unknown：服务端已提交 + 客户端报错 → 同批次重试不产生重复事件
 *  C16 Chat 四事件单批恢复全应用；历史部分 Chat 事件按独立语义确定性恢复
 *
 * D. 历史版本
 *  D17 当前版本事件链恢复（版本字段断言）
 *  D18 schema=1/engine=null 的 genesis + 当前版本后续事件 → 恢复成功
 *  D19 不支持的历史 schema_version → unsupported_schema_version 明确失败
 *  D20 篡改事件版本字段 → 哈希链验证失败（hash_mismatch）
 *
 * E. 故障与完整性
 *  E21 篡改 previous_event_hash → 阻止恢复
 *  E22 篡改 payload → 阻止恢复
 *  E23 未知事件类型 → unknown_event_type 阻止恢复
 *  E24 必要 payload 字段缺失 → invalid_payload 阻止恢复
 *  E25 连续恢复 10 次结果全部一致
 *  E26 恢复失败不清空数据、不创建替代 identity
 *
 * 附：identity 所有权锁的排他性与释放语义。
 *
 * 全部使用真实 PostgreSQL；数据库不可用时整体跳过。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEvents,
  computeEventHash,
  ENGINE_VERSION,
  loadEvents,
  SCHEMA_VERSION,
  type PersistedEventRow,
} from '../storage.js';
import { getDb, closeDb, resetDbForTest } from '../db/connection.js';
import { replay } from '../replay.js';
import { createInitialState } from '../state.js';
import { createSimulatedSensors } from '../sensors.js';
import { executeTick, type TickSession } from '../tick.js';
import { InMemoryObservationInbox } from '../observation.js';
import {
  acquireIdentityOwnership,
  recoverIdentity,
  recoverIdentityOrThrow,
  RecoveryError,
  releaseIdentityOwnership,
} from '../recovery.js';
import type {
  AppraisalEvent,
  DialogueEvent,
  MarrowEvent,
  ObservationEvent,
  TickEvent,
} from '../events.js';

/** 本阶段测试 identity 统一前缀 */
const TEST_PREFIX = 'marrow-test-124';

const ID_A1 = `${TEST_PREFIX}-a1`;
const ID_B7 = `${TEST_PREFIX}-b7`;
const ID_B8 = `${TEST_PREFIX}-b8`;
const ID_B9 = `${TEST_PREFIX}-b9-empty`;
const ID_B10A = `${TEST_PREFIX}-b10-a`;
const ID_B10B = `${TEST_PREFIX}-b10-b`;
const ID_B11 = `${TEST_PREFIX}-b11`;
const ID_C13 = `${TEST_PREFIX}-c13`;
const ID_C15 = `${TEST_PREFIX}-c15`;
const ID_C16 = `${TEST_PREFIX}-c16-chat`;
const ID_C16B = `${TEST_PREFIX}-c16-partial`;
const ID_D18 = `${TEST_PREFIX}-d18`;
const ID_D19 = `${TEST_PREFIX}-d19`;
const ID_D20 = `${TEST_PREFIX}-d20`;
const ID_E21 = `${TEST_PREFIX}-e21`;
const ID_E22 = `${TEST_PREFIX}-e22`;
const ID_E23 = `${TEST_PREFIX}-e23`;
const ID_E24 = `${TEST_PREFIX}-e24`;
const ID_E26 = `${TEST_PREFIX}-e26`;
const ID_OWN = `${TEST_PREFIX}-ownership`;

/** 本次运行的 event_id 前缀，避免与历史测试残留冲突 */
const RUN_TAG = `m124-${Date.now()}`;

/** 固定 ISO 时间戳 */
function iso(offsetMs: number, base = '2026-01-01T00:00:00.000Z'): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function tickEvent(id: string, timestamp: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id, timestamp, payload: { deltaSeconds } };
}

async function fetchRows(identityId: string): Promise<PersistedEventRow[]> {
  const sql = getDb();
  return await sql<PersistedEventRow[]>`
    SELECT
      sequence::text AS sequence, event_id, identity_id, "timestamp", event_type,
      schema_version, engine_version, causation_id, correlation_id,
      previous_event_hash, event_hash, payload
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

async function countTestPrefixRows(): Promise<number> {
  const sql = getDb();
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM events WHERE identity_id LIKE ${`${TEST_PREFIX}%`}
  `;
  return Number(count);
}

/**
 * 直接 SQL 插入一行事件（测试专用：构造历史版本 / 未知类型 / 缺字段事件）。
 * 哈希按行自身版本正确计算，使链路验证可以通过——
 * 只有 Replay 层的版本 / 类型 / payload 校验才会拒绝它。
 */
async function insertRawRow(opts: {
  identityId: string;
  event: MarrowEvent;
  schemaVersion: number;
  engineVersion: string | null;
}): Promise<string> {
  const sql = getDb();
  const eventHash = computeEventHash({
    identityId: opts.identityId,
    schemaVersion: opts.schemaVersion,
    engineVersion: opts.engineVersion,
    causationId: null,
    correlationId: null,
    previousEventHash: null,
    event: opts.event,
  });
  await sql`
    INSERT INTO events ${sql({
      event_id: opts.event.id,
      identity_id: opts.identityId,
      timestamp: opts.event.timestamp,
      event_type: opts.event.type,
      schema_version: opts.schemaVersion,
      engine_version: opts.engineVersion,
      causation_id: null,
      correlation_id: null,
      previous_event_hash: null,
      event_hash: eventHash,
      payload: sql.json(opts.event as unknown as Record<string, unknown>),
    })}
  `;
  return eventHash;
}

/** 在指定 identity 上执行一轮成功 tick（12 条事件），返回会话 */
async function runOneTick(identityId: string): Promise<TickSession> {
  const sensors = createSimulatedSensors();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };
  const inbox = new InMemoryObservationInbox();
  await executeTick(session, sensors, inbox, base + 100_000, 1, (events) =>
    appendEvents(events, { identityId }),
  );
  return session;
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
// A. 确定性
// ==================================================================
test('A1/A5/A6：同一事件日志多次恢复结果 deepStrictEqual，且恢复是只读的', { skip }, async () => {
  const session = await runOneTick(ID_A1);
  const rowsBefore = await countRows(ID_A1);

  const first = await recoverIdentity(ID_A1);
  const second = await recoverIdentity(ID_A1);
  assert.equal(first.verdict, 'valid');
  // A1：同一事件日志恢复两次，完整结果（含 finalState）完全一致
  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual(first.finalState, session.state);

  // A5：恢复不产生新事件
  assert.equal(await countRows(ID_A1), rowsBefore, '恢复必须是只读的');

  // A6：间隔 wall-clock 后结果仍一致（不依赖当前时间）
  await new Promise((resolve) => setTimeout(resolve, 60));
  const third = await recoverIdentity(ID_A1);
  assert.deepStrictEqual(third, first);
});

test('A2：重建连接池（模拟独立进程实例）后恢复结果一致', { skip }, async () => {
  const baseline = await recoverIdentity(ID_A1);
  assert.equal(baseline.verdict, 'valid');

  // 丢弃整个连接池，下一次 getDb 用 DATABASE_URL 重建——
  // 相当于另一个进程实例读取同一 identity
  await resetDbForTest();

  const reopened = await recoverIdentity(ID_A1);
  assert.deepStrictEqual(reopened, baseline, '不同进程实例恢复同一 identity 必须一致');
});

test('A3/A4：恢复不调用 LLM、不读取传感器（结构性约束）', { skip }, async () => {
  // recoverIdentity 零必填参数：签名上不存在 LLM 客户端 / SensorProvider 入口
  assert.equal(recoverIdentity.length, 0, 'recoverIdentity 不得要求 LLM/传感器参数');
  // 本测试进程从未初始化任何 LLM 客户端与传感器，恢复仍成功
  const result = await recoverIdentity(ID_A1);
  assert.equal(result.verdict, 'valid');
});

// ==================================================================
// B. 启动恢复
// ==================================================================
test('B7/C12：正常「关闭」后恢复状态 == 关闭前最后提交状态 == replay(loadEvents)', { skip }, async () => {
  const sensors = createSimulatedSensors();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };
  const inbox = new InMemoryObservationInbox();
  const persist = (events: MarrowEvent[]): Promise<void> =>
    appendEvents(events, { identityId: ID_B7 });

  const batch1 = await executeTick(session, sensors, inbox, base + 100_000, 1, persist);
  const batch2 = await executeTick(session, sensors, inbox, base + 200_000, 1, persist);
  const totalEvents = batch1.events.length + batch2.events.length;

  const recovery = await recoverIdentity(ID_B7);
  assert.equal(recovery.verdict, 'valid');
  // C12：事件数完整（两轮完整批次）
  assert.equal(recovery.eventCount, totalEvents);
  // B7：恢复状态与运行态、replay(loadEvents) 三者一致
  assert.deepStrictEqual(recovery.finalState, session.state);
  assert.deepStrictEqual(recovery.finalState, replay(await loadEvents(ID_B7)));
  // 恢复结果的边界元数据正确
  const rows = await fetchRows(ID_B7);
  assert.equal(recovery.firstSequence, rows[0]!.sequence);
  assert.equal(recovery.lastSequence, rows[rows.length - 1]!.sequence);
  assert.equal(recovery.lastEventTimestamp, rows[rows.length - 1]!.payload.timestamp);
});

test('B8/C14：模拟异常退出（丢弃全部内存运行时）→ 恢复最后一个完整提交批次', { skip }, async () => {
  // 「崩溃前」的运行时：提交两轮 tick 后，session/inbox 直接丢弃，不做任何交接
  const crashedSession = await runOneTick(ID_B8);
  const stateBeforeCrash = structuredClone(crashedSession.state);
  const rowsBeforeCrash = await fetchRows(ID_B8);
  // 崩溃点：不再有 currentState / tickSession / inbox 的任何引用

  const recovery = await recoverIdentity(ID_B8);
  assert.equal(recovery.verdict, 'valid');
  assert.equal(recovery.eventCount, rowsBeforeCrash.length, '必须恢复到最后一个完整提交批次');
  assert.deepStrictEqual(recovery.finalState, stateBeforeCrash, '恢复状态必须与崩溃前最后提交状态一致');
  assert.equal(
    recovery.lastEventTimestamp,
    rowsBeforeCrash[rowsBeforeCrash.length - 1]!.payload.timestamp,
  );
});

test('B9：空事件链 → verdict=empty、finalState=null（合法新身份）', { skip }, async () => {
  const recovery = await recoverIdentity(ID_B9);
  assert.equal(recovery.verdict, 'empty');
  assert.equal(recovery.eventCount, 0);
  assert.equal(recovery.finalState, null);
  assert.equal(recovery.firstSequence, null);
  assert.equal(recovery.lastSequence, null);
  assert.equal(recovery.lastEventTimestamp, null);
  assert.deepEqual(recovery.errors, []);
});

test('B10：不同 identity 的恢复状态完全隔离', { skip }, async () => {
  await appendEvents([tickEvent(`${RUN_TAG}-b10a-0`, iso(0), 10)], { identityId: ID_B10A });
  await appendEvents(
    [tickEvent(`${RUN_TAG}-b10b-0`, iso(0), 10), tickEvent(`${RUN_TAG}-b10b-1`, iso(1000), 10)],
    { identityId: ID_B10B },
  );

  const a = await recoverIdentity(ID_B10A);
  const b = await recoverIdentity(ID_B10B);
  assert.equal(a.verdict, 'valid');
  assert.equal(b.verdict, 'valid');
  assert.equal(a.eventCount, 1);
  assert.equal(b.eventCount, 2);
  // uptime 精确反映各自的事件流（10s vs 20s），互不串扰
  assert.equal(a.finalState!.uptimeSeconds, 10);
  assert.equal(b.finalState!.uptimeSeconds, 20);

  // 向 B 追加事件后，A 的恢复结果不变
  const aBefore = await recoverIdentity(ID_B10A);
  await appendEvents([tickEvent(`${RUN_TAG}-b10b-2`, iso(2000), 10)], { identityId: ID_B10B });
  const aAfter = await recoverIdentity(ID_B10A);
  assert.deepStrictEqual(aAfter, aBefore, '其他 identity 的写入不得影响本 identity 的恢复');
});

test('B11：哈希链损坏 → recoverIdentityOrThrow 抛 RecoveryError，启动被阻止', { skip }, async () => {
  await appendEvents(
    [tickEvent(`${RUN_TAG}-b11-0`, iso(0)), tickEvent(`${RUN_TAG}-b11-1`, iso(1000))],
    { identityId: ID_B11 },
  );
  // 篡改：改动第二条事件的 payload（哈希链随之失效）
  const sql = getDb();
  await sql`
    UPDATE events
    SET payload = jsonb_set(payload, '{payload,deltaSeconds}', '999')
    WHERE identity_id = ${ID_B11} AND event_id = ${`${RUN_TAG}-b11-1`}
  `;

  const err = await recoverIdentityOrThrow(ID_B11).then(
    () => assert.fail('恢复失败必须抛错'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof RecoveryError, '必须抛 RecoveryError');
  assert.equal(err.result.verdict, 'invalid');
  assert.equal(err.result.finalState, null, '恢复失败不得产出任何状态');
  assert.equal(err.result.errors[0]!.kind, 'chain_verification_failed');
  // 定位信息完整：identity / sequence / eventId
  assert.equal(err.result.errors[0]!.identityId, ID_B11);
  assert.ok(err.result.errors[0]!.sequence !== null);
  assert.ok(err.result.errors[0]!.eventId !== null);
});

// ==================================================================
// C. PostgreSQL 事务边界
// ==================================================================
test('C13：Tick 批次中途失败回滚 → 恢复结果不包含该批次任何事件', { skip }, async () => {
  const sensors = createSimulatedSensors();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };
  const inbox = new InMemoryObservationInbox();
  const persist = (events: MarrowEvent[]): Promise<void> =>
    appendEvents(events, { identityId: ID_C13 });

  await executeTick(session, sensors, inbox, base + 100_000, 1, persist);
  const stateAfterSuccess = structuredClone(session.state);
  const countAfterSuccess = await countRows(ID_C13);

  // 第二轮：第 5 条事件 INSERT 失败 → 整批回滚
  const failPersist = (events: MarrowEvent[]): Promise<void> => {
    const corrupted = events.map((e, i) =>
      i === 4 ? { ...e, timestamp: 'not-a-timestamp' } : e,
    );
    return appendEvents(corrupted, { identityId: ID_C13 });
  };
  await assert.rejects(
    executeTick(session, sensors, inbox, base + 200_000, 1, failPersist),
    /invalid input syntax|timestamp/i,
  );

  const recovery = await recoverIdentity(ID_C13);
  assert.equal(recovery.verdict, 'valid');
  assert.equal(recovery.eventCount, countAfterSuccess, '回滚批次的任何事件都不得出现在恢复中');
  assert.deepStrictEqual(recovery.finalState, stateAfterSuccess, '恢复必须停在最后一个完整提交批次');
});

test('C15：commit-unknown —— 服务端已提交但客户端报错，同批次重试不产生重复事件', { skip }, async () => {
  const sensors = createSimulatedSensors();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };
  const inbox = new InMemoryObservationInbox();
  const persist = (events: MarrowEvent[]): Promise<void> =>
    appendEvents(events, { identityId: ID_C15 });

  // 模拟 commit-unknown：持久化函数先真实提交（服务端成功），再抛出假网络错误
  const commitUnknownPersist = async (events: MarrowEvent[]): Promise<void> => {
    await appendEvents(events, { identityId: ID_C15 });
    throw new Error('simulated network failure after commit (commit-unknown)');
  };

  await assert.rejects(
    executeTick(session, sensors, inbox, base + 100_000, 1, commitUnknownPersist),
    /commit-unknown/,
  );
  const countAfterUnknown = await countRows(ID_C15);
  assert.ok(countAfterUnknown > 0, '服务端实际已提交完整批次');
  assert.ok(session.pendingBatch, '失败批次必须冻结为 pendingBatch');
  assert.equal(session.tickCount, 0, '客户端视角未提交，内存状态不得推进');

  // 重试：pendingBatch 携带相同 event_id，appendEvents 幂等吸收，零新增
  const retried = await executeTick(session, sensors, inbox, base + 100_000, 1, persist);
  assert.equal(
    await countRows(ID_C15),
    countAfterUnknown,
    'commit-unknown 重试不得产生任何重复事件',
  );
  assert.equal(session.tickCount, 1);
  assert.equal(session.pendingBatch, undefined);

  // 恢复状态与重试后的运行态一致
  const recovery = await recoverIdentity(ID_C15);
  assert.equal(recovery.verdict, 'valid');
  assert.equal(recovery.eventCount, retried.events.length);
  assert.deepStrictEqual(recovery.finalState, session.state);
});

test('C16：Chat 四事件单批恢复全应用；历史部分 Chat 事件按独立语义确定性恢复', { skip }, async () => {
  // ---- 完整 Chat（M1.2.4 起四事件单事务提交） ----
  const obsId = `${RUN_TAG}-c16-obs`;
  const appraisalId = `${RUN_TAG}-c16-app`;
  const observation: ObservationEvent = {
    type: 'observation',
    id: obsId,
    timestamp: iso(1000),
    payload: {
      source: 'user_text',
      content: '今天很开心',
      action: 'statement',
      intensity: 0.5,
      confidence: 0.9,
      uncertainty: 0.1,
      facts: [{ claim: '用户表达了开心', confidence: 0.9 }],
      extractorVersion: 'test-extractor',
    },
  };
  const appraisal: AppraisalEvent = {
    type: 'appraisal',
    id: appraisalId,
    timestamp: iso(2000),
    payload: {
      sourceObservationId: obsId,
      valenceDelta: 2,
      arousalDelta: 5,
      energyDelta: 0,
      confidence: 0.9,
      evidenceAssociationIds: [],
    },
  };
  const userInput: DialogueEvent = {
    type: 'dialogue',
    id: `${RUN_TAG}-c16-user`,
    timestamp: iso(3000),
    payload: {
      direction: 'user_input',
      text: '今天很开心',
      action: 'statement',
      intensity: 0.5,
      moodDelta: 2,
      salience: 0.3,
      wordCount: 5,
      observationId: obsId,
      appraisalId,
    },
  };
  const companion: DialogueEvent = {
    type: 'dialogue',
    id: `${RUN_TAG}-c16-comp`,
    timestamp: iso(4000),
    payload: {
      direction: 'companion_output',
      text: '我也很开心',
      moodDelta: 0,
      salience: 0.3,
      wordCount: 6,
      candidateText: '我也很开心',
      filtered: false,
    },
  };
  await appendEvents([observation, appraisal, userInput, companion], { identityId: ID_C16 });

  const full = await recoverIdentity(ID_C16);
  assert.equal(full.verdict, 'valid');
  assert.equal(full.eventCount, 4, '单批四事件必须全部恢复');
  assert.deepStrictEqual(full.finalState, replay(await loadEvents(ID_C16)));

  // ---- 部分 Chat（历史遗留：只有 observation + appraisal 被提交） ----
  // 语义：每条事件独立应用（observation 只推进时间轴，appraisal 应用
  // arousalDelta），不伪造缺失的 dialogue 事件、不报错、不跳过。
  const partialObs: ObservationEvent = {
    ...observation,
    id: `${RUN_TAG}-c16b-obs`,
    timestamp: iso(10_000),
  };
  const partialAppraisal: AppraisalEvent = {
    ...appraisal,
    id: `${RUN_TAG}-c16b-app`,
    timestamp: iso(11_000),
    payload: { ...appraisal.payload, sourceObservationId: partialObs.id },
  };
  await appendEvents([partialObs, partialAppraisal], { identityId: ID_C16B });

  const partial = await recoverIdentity(ID_C16B);
  assert.equal(partial.verdict, 'valid', '部分 Chat 事件按真实持久化语义确定性恢复');
  assert.equal(partial.eventCount, 2);
  assert.deepStrictEqual(partial.finalState, replay(await loadEvents(ID_C16B)));
  // appraisal.arousalDelta=5 已应用（初始 10 → 15）
  assert.equal(partial.finalState!.arousal, 15);
});

// ==================================================================
// D. 历史版本
// ==================================================================
test('D17：当前版本事件链恢复，ReplayResult 报告执行恢复引擎的版本', { skip }, async () => {
  const recovery = await recoverIdentity(ID_A1);
  assert.equal(recovery.verdict, 'valid');
  assert.equal(recovery.schemaVersion, SCHEMA_VERSION);
  assert.equal(recovery.engineVersion, ENGINE_VERSION);

  const rows = await fetchRows(ID_A1);
  for (const row of rows) {
    assert.equal(row.schema_version, SCHEMA_VERSION);
    assert.equal(row.engine_version, ENGINE_VERSION);
  }
});

test('D18：schema=1/engine=null 的 genesis + 当前版本后续事件 → 混合版本链恢复成功', { skip }, async () => {
  // 早期 M1.2 PG 写入的未打版本行：schema_version=1、engine_version=null，
  // payload 同为 V2 判别联合格式（V1 JSONL 从未导入 PG，不存在旧格式事件）
  const genesis = tickEvent(`${RUN_TAG}-d18-genesis`, iso(0), 10);
  await insertRawRow({
    identityId: ID_D18,
    event: genesis,
    schemaVersion: 1,
    engineVersion: null,
  });
  // 当前版本代码继续在同一身份上追加（正常 appendEvents 路径）
  await appendEvents([tickEvent(`${RUN_TAG}-d18-next`, iso(1000), 10)], { identityId: ID_D18 });

  const recovery = await recoverIdentity(ID_D18);
  assert.equal(recovery.verdict, 'valid', 'schema 1/2 混合链必须可恢复');
  assert.equal(recovery.eventCount, 2);
  assert.equal(recovery.finalState!.uptimeSeconds, 20);
});

test('D19：不支持的历史 schema_version → unsupported_schema_version 明确失败', { skip }, async () => {
  await insertRawRow({
    identityId: ID_D19,
    event: tickEvent(`${RUN_TAG}-d19-genesis`, iso(0), 10),
    schemaVersion: 99,
    engineVersion: null,
  });

  const recovery = await recoverIdentity(ID_D19);
  assert.equal(recovery.verdict, 'invalid');
  assert.equal(recovery.finalState, null);
  assert.equal(recovery.errors[0]!.kind, 'unsupported_schema_version');
  assert.equal(recovery.errors[0]!.identityId, ID_D19);
  assert.equal(recovery.errors[0]!.eventId, `${RUN_TAG}-d19-genesis`);
  assert.equal(recovery.errors[0]!.schemaVersion, 99);
});

test('D20：篡改事件版本字段 → 哈希链验证失败（hash_mismatch）', { skip }, async () => {
  await appendEvents([tickEvent(`${RUN_TAG}-d20-0`, iso(0))], { identityId: ID_D20 });
  // 篡改：把 schema_version 从 2 改成 1（哈希以 2 计算 → 重算不匹配）
  const sql = getDb();
  await sql`
    UPDATE events SET schema_version = 1
    WHERE identity_id = ${ID_D20} AND event_id = ${`${RUN_TAG}-d20-0`}
  `;

  const recovery = await recoverIdentity(ID_D20);
  assert.equal(recovery.verdict, 'invalid');
  assert.equal(recovery.errors[0]!.kind, 'chain_verification_failed');
  assert.match(recovery.errors[0]!.message, /hash_mismatch/);
});

// ==================================================================
// E. 故障与完整性
// ==================================================================
test('E21：篡改 previous_event_hash → 阻止恢复', { skip }, async () => {
  await appendEvents(
    [tickEvent(`${RUN_TAG}-e21-0`, iso(0)), tickEvent(`${RUN_TAG}-e21-1`, iso(1000))],
    { identityId: ID_E21 },
  );
  const sql = getDb();
  await sql`
    UPDATE events SET previous_event_hash = ${'a'.repeat(64)}
    WHERE identity_id = ${ID_E21} AND event_id = ${`${RUN_TAG}-e21-1`}
  `;

  const recovery = await recoverIdentity(ID_E21);
  assert.equal(recovery.verdict, 'invalid');
  assert.equal(recovery.errors[0]!.kind, 'chain_verification_failed');
});

test('E22：篡改 payload → 阻止恢复', { skip }, async () => {
  await appendEvents([tickEvent(`${RUN_TAG}-e22-0`, iso(0))], { identityId: ID_E22 });
  const sql = getDb();
  await sql`
    UPDATE events
    SET payload = jsonb_set(payload, '{payload,deltaSeconds}', '12345')
    WHERE identity_id = ${ID_E22} AND event_id = ${`${RUN_TAG}-e22-0`}
  `;

  const recovery = await recoverIdentity(ID_E22);
  assert.equal(recovery.verdict, 'invalid');
  assert.equal(recovery.errors[0]!.kind, 'chain_verification_failed');
  assert.equal(recovery.finalState, null);
});

test('E23：未知事件类型 → unknown_event_type 阻止恢复（拒绝静默跳过）', { skip }, async () => {
  // 构造类型合法 JSON、哈希正确、但 type 不在判别联合内的事件
  const bogus = {
    type: 'bogus',
    id: `${RUN_TAG}-e23-0`,
    timestamp: iso(0),
    payload: { something: 1 },
  } as unknown as MarrowEvent;
  await insertRawRow({
    identityId: ID_E23,
    event: bogus,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
  });

  const recovery = await recoverIdentity(ID_E23);
  assert.equal(recovery.verdict, 'invalid');
  assert.equal(recovery.errors[0]!.kind, 'unknown_event_type');
  assert.equal(recovery.errors[0]!.eventType, 'bogus');
  assert.equal(recovery.errors[0]!.eventId, `${RUN_TAG}-e23-0`);
});

test('E24：必要 payload 字段缺失 → invalid_payload 阻止恢复（不用默认值兜底）', { skip }, async () => {
  // dialogue 事件缺少 moodDelta：缺失时绝不用 appraise 重算兜底
  const broken = {
    type: 'dialogue',
    id: `${RUN_TAG}-e24-0`,
    timestamp: iso(0),
    payload: { direction: 'user_input', text: '你好', salience: 0.3 },
  } as unknown as MarrowEvent;
  await insertRawRow({
    identityId: ID_E24,
    event: broken,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
  });

  const recovery = await recoverIdentity(ID_E24);
  assert.equal(recovery.verdict, 'invalid');
  assert.equal(recovery.errors[0]!.kind, 'invalid_payload');
  assert.match(recovery.errors[0]!.message, /moodDelta/);
});

test('E25：连续恢复 10 次，完整结果始终 deepStrictEqual', { skip }, async () => {
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(await recoverIdentity(ID_A1));
  }
  for (let i = 1; i < 10; i++) {
    assert.deepStrictEqual(results[i], results[0], `第 ${i + 1} 次恢复结果必须与首次一致`);
  }
});

test('E26：恢复失败不清空数据、不写入新事件、不创建替代 identity', { skip }, async () => {
  // 构造一个必然恢复失败的 identity（不支持的 schema_version）
  await insertRawRow({
    identityId: ID_E26,
    event: tickEvent(`${RUN_TAG}-e26-genesis`, iso(0), 10),
    schemaVersion: 99,
    engineVersion: null,
  });
  const beforeOwn = await countRows(ID_E26);
  const beforeAll = await countTestPrefixRows();

  await assert.rejects(recoverIdentityOrThrow(ID_E26), RecoveryError);

  assert.equal(await countRows(ID_E26), beforeOwn, '失败 identity 的数据不得被清空或修改');
  assert.equal(await countTestPrefixRows(), beforeAll, '恢复失败不得写入任何新事件（含替代 identity）');

  // 邻近 identity 的恢复不受失败影响
  const neighbor = await recoverIdentity(ID_A1);
  assert.equal(neighbor.verdict, 'valid');
});

// ==================================================================
// 附：identity 所有权锁
// ==================================================================
test('identity 所有权：持有期间其他连接取不到锁，释放后可获取', { skip }, async () => {
  await acquireIdentityOwnership(ID_OWN);

  // 另一连接探测同一锁：必须失败（排他）
  const probe = await getDb().reserve();
  try {
    const rows = await probe<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        hashtext('marrow.identity.ownership'), hashtext(${ID_OWN})
      ) AS acquired
    `;
    assert.equal(rows[0]!.acquired, false, '持有期间其他进程/连接必须取不到锁');
  } finally {
    probe.release();
  }

  await releaseIdentityOwnership(ID_OWN);

  // 释放后同一探测可以取得锁（取到后必须显式解锁再归还连接，
  // 会话级锁不会随连接归还连接池而释放）
  const probe2 = await getDb().reserve();
  try {
    const rows = await probe2<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        hashtext('marrow.identity.ownership'), hashtext(${ID_OWN})
      ) AS acquired
    `;
    assert.equal(rows[0]!.acquired, true, '释放后必须可以重新获取');
    await probe2`
      SELECT pg_advisory_unlock(
        hashtext('marrow.identity.ownership'), hashtext(${ID_OWN})
      )
    `;
  } finally {
    probe2.release();
  }
});
