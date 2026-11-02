/**
 * observation.pg.test.ts — 观测确认层与 identity 互斥集成测试（M1.2.2.2-A，C3 迁移）
 *
 * 覆盖：
 * - Tick 观测失败后重试：observationId / observedAt / eventTimestamp 全部稳定，
 *   传感器 read() 不重复调用，碰撞恰好一次，validateEventLog 通过，
 *   Replay 与运行态完全一致
 * - 观测恢复屏障：存在 pending 时 Chat 临界区拒绝提交且不写任何对话事件
 * - A-R1（修正预期）：Chat 先执行 → Tick 等待 → Chat 成功 → Tick 观测排在其后，
 *   无 503、事件时间轴单调
 * - A-R2（修正预期）：Tick 先执行成功 → Chat 等待后成功；
 *   Tick 先执行失败 → Chat 等待后 503 且 pending 保留、无对话事件
 *
 * C3：互斥机制由 RuntimeSession 单执行器提供（Chat = reserveChat + markReady，
 * Tick = requestTick），A 阶段的 identity-lock 临时模块已删除。
 *
 * 全部使用真实 PostgreSQL，测试 identity 带统一前缀，结束后清理。
 * 数据库不可用时全部用例跳过。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, appendEvents, loadEvents } from '../storage.js';
import { getDb, closeDb } from '../db/connection.js';
import { replay, validateEventLog } from '../replay.js';
import { createInitialState } from '../state.js';
import {
  createSimulatedSensors,
  type SensorProvider,
  type SimulatedMotionSensor,
} from '../sensors.js';
import { executeTick, type TickSession } from '../tick.js';
import {
  assertObservationBarrier,
  InMemoryObservationInbox,
  ObservationBarrierError,
  type ObservationKind,
  type PendingObservation,
} from '../observation.js';
import { getRuntimeSession } from '../runtime-session.js';
import type {
  DialogueEvent,
  EnvironmentEvent,
  InterruptionEvent,
  MarrowEvent,
} from '../events.js';

/** 本阶段测试 identity 统一前缀（便于一次性清理） */
const TEST_PREFIX = 'marrow-test-a122';

const ID_OBS_RETRY = `${TEST_PREFIX}-obs-retry`;
const ID_BARRIER = `${TEST_PREFIX}-barrier`;
const ID_R1 = `${TEST_PREFIX}-r1-chat-first`;
const ID_R2A = `${TEST_PREFIX}-r2-tick-first-ok`;
const ID_R2B = `${TEST_PREFIX}-r2-tick-first-fail`;

/** 本次运行的 event_id 前缀，避免与历史残留冲突 */
const RUN_TAG = `a122-${Date.now()}`;

interface EventRow {
  sequence: string;
  event_id: string;
  timestamp: string | Date;
  event_type: string;
  payload: MarrowEvent;
}

async function fetchRows(identityId: string): Promise<EventRow[]> {
  const sql = getDb();
  return await sql<EventRow[]>`
    SELECT
      sequence::text AS sequence,
      event_id,
      "timestamp",
      event_type,
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

/** 固定 ISO 时间戳 */
function iso(offsetMs: number, base = '2026-01-01T00:00:00.000Z'): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把批次中第 index 条事件的 timestamp 改成非法值。
 * 让失败发生在真实 PostgreSQL INSERT 阶段，而不是仍停留在内存断言。
 */
function corruptAt(events: MarrowEvent[], index: number): MarrowEvent[] {
  return events.map((event, i) =>
    i === index ? { ...event, timestamp: 'not-a-timestamp' } : event,
  );
}

/**
 * 包装模拟传感器，统计每类 read() 调用次数。
 * 观测确认层的核心保证是：写库失败重试时绝不重新读取传感器。
 */
function instrumentedSensors(): {
  sensors: SensorProvider;
  motion: SimulatedMotionSensor;
  readCounts: Record<ObservationKind, number>;
} {
  const base = createSimulatedSensors();
  const motion = base.motion as SimulatedMotionSensor;
  const readCounts: Record<ObservationKind, number> = {
    battery: 0,
    motion: 0,
    environment: 0,
  };

  return {
    motion,
    readCounts,
    sensors: {
      battery: {
        read: () => {
          readCounts.battery += 1;
          return base.battery.read();
        },
      },
      motion: {
        collisionThreshold: motion.collisionThreshold,
        read: () => {
          readCounts.motion += 1;
          return motion.read();
        },
      },
      environment: {
        read: () => {
          readCounts.environment += 1;
          return base.environment.read();
        },
      },
    },
  };
}

function chatEvent(id: string, timestamp: string): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp,
    payload: {
      direction: 'user_input',
      text: 'hello',
      moodDelta: 0,
      salience: 0.3,
      wordCount: 5,
    },
  };
}

/**
 * 在 RuntimeSession 单执行器中串行执行 Chat 临界区（C3 取代 A 阶段 identity-lock）
 *
 * 与生产路径一致：reserveChat 占用容量 → markReady 提交任务 → completion 取结果。
 * 任务抛出的异常（如观测屏障拒绝）会通过 completion 原样传递给调用方。
 */
async function withRuntimeChat(identityId: string, task: () => Promise<void>): Promise<void> {
  const session = getRuntimeSession(identityId);
  const admission = session.reserveChat();
  session.markReady(admission, async () => {
    await task();
    return { reply: '', filtered: false, filterReason: null };
  });
  await admission.completion;
}

/**
 * 在 RuntimeSession 单执行器中串行执行 Tick 临界区（与 Chat 共用同一执行器）
 */
function withRuntimeTick<T>(identityId: string, task: () => Promise<T>): Promise<T> {
  return getRuntimeSession(identityId).requestTick(task);
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
// 一、Tick 观测失败 → 重试：ID / 双时间 / 读数稳定，恰好一次碰撞
// ==================================================================
test('Tick 观测失败重试：观测 ID 与双时间稳定、传感器不重读、Replay 与运行态一致', { skip }, async () => {
  const { sensors, motion, readCounts } = instrumentedSensors();
  const inbox = new InMemoryObservationInbox();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };

  const persist = (events: MarrowEvent[]): Promise<void> =>
    appendEvents(events, { identityId: ID_OBS_RETRY });
  const failingPersist = (events: MarrowEvent[]): Promise<void> =>
    appendEvents(corruptAt(events, 4), { identityId: ID_OBS_RETRY });

  // 触发一次碰撞：真实传感器读取后即清除，只有 Inbox 才能保证不丢失
  motion.triggerCollision();

  const stateBeforeFail = structuredClone(session.state);
  const lastTickBeforeFail = session.lastTickTime;
  const tickCountBeforeFail = session.tickCount;

  // ---- 第一次 tick：第 5 条事件在真实 INSERT 阶段失败 ----
  await assert.rejects(
    executeTick(session, sensors, inbox, base + 100_000, 1, failingPersist),
    /invalid input syntax|timestamp/i,
  );

  assert.equal(await countRows(ID_OBS_RETRY), 0, '失败 tick 不得写入任何事件');
  assert.equal(session.tickCount, tickCountBeforeFail, 'tickCount 不得推进');
  assert.equal(session.lastTickTime, lastTickBeforeFail, 'lastTickTime 不得推进');
  assert.deepEqual(session.state, stateBeforeFail, '内存状态必须与失败前完全一致');

  // 三类观测全部保留为 pending（都已完成首次读取）
  assert.deepEqual(
    await inbox.pendingKinds(),
    ['battery', 'motion', 'environment'],
    '物理观测必须全部保留，等待恢复',
  );
  assert.equal(await inbox.hasPending(), true);

  // 冻结快照：重试后必须逐字段一致
  const frozen = {
    battery: (await inbox.pending('battery'))!,
    motion: (await inbox.pending('motion'))!,
    environment: (await inbox.pending('environment'))!,
  } as Record<'battery' | 'motion' | 'environment', PendingObservation<unknown>>;

  assert.equal(readCounts.battery, 1, '失败前电池只读一次');
  assert.equal(readCounts.motion, 1, '失败前运动只读一次（碰撞已被消费）');
  assert.equal(readCounts.environment, 1, '失败前环境只读一次');
  assert.equal(frozen.motion.reading !== undefined, true);

  // ---- 第二次 tick：同一观测、同一双时间重试成功 ----
  const batch = await executeTick(session, sensors, inbox, base + 100_000, 1, persist);

  // 恢复批次：3 条遗留观测 + 10 个 tick 子步 = 13 条
  assert.equal(batch.events.length, 13, '恢复批次应有 3 条观测事件 + 10 个子步');
  assert.equal(session.tickCount, 1);
  assert.equal(await inbox.hasPending(), false, '提交成功后必须确认全部观测');

  // 传感器不得被重新读取
  assert.equal(readCounts.battery, 1, '重试不得重新读取电池');
  assert.equal(readCounts.motion, 1, '重试不得重新读取运动（碰撞不能被复制）');
  assert.equal(readCounts.environment, 1, '重试不得重新读取环境');

  const rows = await fetchRows(ID_OBS_RETRY);
  assert.equal(rows.length, 13);

  const findRow = (eventId: string): EventRow => {
    const row = rows.find((r) => r.event_id === eventId);
    assert.ok(row, `数据库中必须存在事件 ${eventId}`);
    return row;
  };

  // 电池 / 环境 / 碰撞三类观测事件的 ID、event.timestamp、payload.observedAt 全部冻结
  const batteryRow = findRow(frozen.battery.id);
  assert.equal(batteryRow.event_type, 'environment');
  assert.equal(
    new Date(batteryRow.timestamp).toISOString(),
    new Date(frozen.battery.eventTimestamp).toISOString(),
    '电池事件时间必须等于冻结的 eventTimestamp',
  );
  const batteryEvent = batteryRow.payload as EnvironmentEvent;
  assert.equal(batteryEvent.type, 'environment');
  assert.equal(
    batteryEvent.payload.observedAt,
    frozen.battery.observedAt,
    '电池 payload.observedAt 必须等于冻结的观测时间',
  );

  const environmentRow = findRow(frozen.environment.id);
  assert.equal(environmentRow.event_type, 'environment');
  assert.equal(
    new Date(environmentRow.timestamp).toISOString(),
    new Date(frozen.environment.eventTimestamp).toISOString(),
    '环境事件时间必须冻结',
  );
  const environmentEvent = environmentRow.payload as EnvironmentEvent;
  assert.equal(environmentEvent.payload.observedAt, frozen.environment.observedAt);

  const collisionRow = findRow(frozen.motion.id);
  assert.equal(collisionRow.event_type, 'interruption');
  assert.equal(
    new Date(collisionRow.timestamp).toISOString(),
    new Date(frozen.motion.eventTimestamp).toISOString(),
    '碰撞事件时间必须冻结',
  );
  const collisionEvent = collisionRow.payload as InterruptionEvent;
  assert.equal(collisionEvent.type, 'interruption');
  assert.equal(collisionEvent.payload.observedAt, frozen.motion.observedAt);
  assert.match(
    collisionEvent.payload.reason,
    /collision/i,
    '恢复的观测必须是碰撞中断',
  );

  const interruptions = rows.filter((r) => r.event_type === 'interruption');
  assert.equal(interruptions.length, 1, '一次碰撞只能产生一条中断事件');
  assert.equal(
    interruptions[0]!.event_id,
    frozen.motion.id,
    '碰撞中断必须复用观测 ID',
  );

  // 事件时间轴单调 + Replay 与运行态一致
  const persisted = await loadEvents(ID_OBS_RETRY);
  const validation = validateEventLog(persisted);
  assert.equal(validation.valid, true, `事件时间轴必须单调：${validation.errors.join('; ')}`);
  assert.deepEqual(replay(persisted), session.state, 'Replay 必须与运行态完全一致');

  console.log(
    `[EVIDENCE] 观测失败重试：观测 ID 稳定=${rows.some(
      (r) => r.event_id === frozen.motion.id,
    )}；read 次数 battery/motion/environment=` +
      `${readCounts.battery}/${readCounts.motion}/${readCounts.environment}；` +
      `中断事件=${interruptions.length}；时间轴合法=${validation.valid}；` +
      `Replay 一致=${JSON.stringify(replay(persisted)) === JSON.stringify(session.state)}`,
  );
});

// ==================================================================
// 二、观测恢复屏障：pending 存在时 Chat 拒绝提交，且不写对话事件
// ==================================================================
test('观测屏障：存在未确认观测时 Chat 临界区拒绝提交，确认后才允许写入', { skip }, async () => {
  const inbox = new InMemoryObservationInbox();
  const pending = await inbox.observe('battery', () => ({
    level: 15,
    charging: false,
  }));

  const chatId = `${RUN_TAG}-barrier-chat`;
  const attemptChat = (): Promise<void> =>
    withRuntimeChat(ID_BARRIER, async () => {
      await assertObservationBarrier(inbox);
      await appendEvent(chatEvent(chatId, new Date().toISOString()), {
        identityId: ID_BARRIER,
      });
    });

  await assert.rejects(attemptChat(), (err: unknown) => {
    assert.ok(err instanceof ObservationBarrierError, '必须抛出观测屏障错误');
    assert.equal(err.code, 'observations_pending');
    return true;
  });
  assert.equal(await countRows(ID_BARRIER), 0, '被屏障拒绝时不得写入任何对话事件');

  // 确认观测后屏障解除，同样的临界区可以正常提交
  await inbox.confirm(pending.id);
  await attemptChat();
  assert.equal(await countRows(ID_BARRIER), 1, '确认观测后对话事件应正常写入');
  assert.equal(await inbox.hasPending(), false);
});

// ==================================================================
// 三、A-R1（修正预期）：Chat 先持锁 → Tick 等待 → Chat 成功 → Tick 观测排在其后
// ==================================================================
test('A-R1：Chat 先持锁时 Tick 必须等待，Chat 成功且时间轴单调（无 503）', { skip }, async () => {
  const inbox = new InMemoryObservationInbox();
  const { sensors, motion } = instrumentedSensors();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };
  motion.triggerCollision();

  const order: string[] = [];
  const chatId = `${RUN_TAG}-r1-chat`;
  const chatTimestamp = new Date().toISOString();

  // Chat 先进入执行器（同一轮同步调用，先就绪者先占用执行器）
  const chatRun = withRuntimeChat(ID_R1, async () => {
    await assertObservationBarrier(inbox);
    await appendEvent(chatEvent(chatId, chatTimestamp), { identityId: ID_R1 });
    order.push('chat');
  });
  const tickRun = withRuntimeTick(ID_R1, async () => {
    const batch = await executeTick(
      session,
      sensors,
      inbox,
      base + 100_000,
      1,
      (events) => appendEvents(events, { identityId: ID_R1 }),
    );
    order.push('tick');
    return batch;
  });

  await chatRun;
  await tickRun;

  assert.deepEqual(order, ['chat', 'tick'], 'Chat 必须先完成，Tick 必须等待');
  assert.equal(session.tickCount, 1, 'Tick 在 Chat 完成后应正常提交');
  assert.equal(await inbox.hasPending(), false, 'Tick 成功后观测已确认');

  const rows = await fetchRows(ID_R1);
  assert.equal(rows[0]!.event_id, chatId, '对话事件必须排在所有 Tick 事件之前，不得时间倒退');

  const persisted = await loadEvents(ID_R1);
  const validation = validateEventLog(persisted);
  assert.equal(validation.valid, true, `事件时间轴必须单调：${validation.errors.join('; ')}`);
});

// ==================================================================
// 四、A-R2（修正预期 a）：Tick 先持锁成功 → Chat 等待后成功
// ==================================================================
test('A-R2a：Tick 先持锁成功时 Chat 等待后成功，屏障不误伤', { skip }, async () => {
  const inbox = new InMemoryObservationInbox();
  const { sensors } = instrumentedSensors();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };

  const order: string[] = [];
  const chatId = `${RUN_TAG}-r2a-chat`;

  const tickRun = withRuntimeTick(ID_R2A, async () => {
    const batch = await executeTick(
      session,
      sensors,
      inbox,
      base + 100_000,
      1,
      async (events) => {
        // 拉长执行时间，确保 Chat 确实在等待而不是恰好后到
        await sleep(30);
        await appendEvents(events, { identityId: ID_R2A });
      },
    );
    order.push('tick');
    return batch;
  });
  const chatRun = withRuntimeChat(ID_R2A, async () => {
    await assertObservationBarrier(inbox);
    await appendEvent(chatEvent(chatId, new Date().toISOString()), {
      identityId: ID_R2A,
    });
    order.push('chat');
  });

  await Promise.all([tickRun, chatRun]);
  assert.deepEqual(order, ['tick', 'chat'], 'Chat 必须等 Tick 完成（包括确认观测）');
  assert.equal(await inbox.hasPending(), false);

  const rows = await fetchRows(ID_R2A);
  assert.equal(rows[rows.length - 1]!.event_id, chatId, 'Chat 事件必须排在 Tick 之后');
  const persisted = await loadEvents(ID_R2A);
  assert.equal(validateEventLog(persisted).valid, true, '事件时间轴必须单调');
});

// ==================================================================
// 五、A-R2（修正预期 b）：Tick 先持锁失败 → Chat 等待后 503，pending 保留
// ==================================================================
test('A-R2b：Tick 先持锁失败时 Chat 等待后拒绝，pending 保留且无对话事件', { skip }, async () => {
  const inbox = new InMemoryObservationInbox();
  const { sensors, motion, readCounts } = instrumentedSensors();
  const base = Date.now();
  const session: TickSession = {
    state: createInitialState(iso(0)),
    lastTickTime: base,
    tickCount: 0,
  };
  motion.triggerCollision();

  const stateBeforeFail = structuredClone(session.state);
  const chatId = `${RUN_TAG}-r2b-chat`;

  const tickRun = withRuntimeTick(ID_R2B, async () => {
    await executeTick(
      session,
      sensors,
      inbox,
      base + 100_000,
      1,
      // 第 5 条事件真实插入失败 → 整批回滚
      (events) => appendEvents(corruptAt(events, 4), { identityId: ID_R2B }),
    );
  });
  const chatRun = withRuntimeChat(ID_R2B, async () => {
    await assertObservationBarrier(inbox);
    await appendEvent(chatEvent(chatId, new Date().toISOString()), {
      identityId: ID_R2B,
    });
  });

  await assert.rejects(tickRun, /invalid input syntax|timestamp/i);
  await assert.rejects(chatRun, (err: unknown) => {
    assert.ok(err instanceof ObservationBarrierError, 'Tick 失败后 Chat 必须被屏障拒绝');
    assert.equal(err.code, 'observations_pending');
    return true;
  });

  assert.equal(await countRows(ID_R2B), 0, 'Tick 回滚且 Chat 被拒绝，数据库必须为空');
  assert.equal(await inbox.hasPending(), true, '失败后观测必须保留，等待下一轮恢复');
  assert.deepEqual(await inbox.pendingKinds(), ['battery', 'motion', 'environment']);
  assert.equal(readCounts.motion, 1, '失败的 Tick 只读取传感器一次');
  assert.deepEqual(session.state, stateBeforeFail, 'Tick 失败不得推进内存状态');

  console.log(
    `[EVIDENCE] A-R2b：DB rows=${await countRows(ID_R2B)}；` +
      `pending=${(await inbox.pendingKinds()).join(',')}；` +
      `motion read=${readCounts.motion}；内存状态一致=${
        JSON.stringify(session.state) === JSON.stringify(stateBeforeFail)
      }`,
  );
});
