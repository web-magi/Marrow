/**
 * runtime-session-scheduling.test.ts — Tick / Chat 统一调度测试（M1.2.2-C2）
 *
 * 覆盖：
 * - Tick 与 Chat 共用单执行器，绝不并发
 * - Tick 合并：等待中 / 执行中的重复请求共享同一 Promise，任务只执行一次
 * - Recovery Tick 最高优先级：Tick 失败后先恢复观测，等待中的 Chat 不得插队
 * - 公平调度：普通 Tick 执行后，等待中的 Chat 必须先于下一轮 Tick 执行
 * - Tick 失败不阻塞后续 Chat / Tick，下一轮自动升级为 recovery-tick
 * - QueueSnapshot 的 Tick 状态在各阶段准确
 *
 * 纯内存，无数据库、无网络。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeSession,
  type ChatOutcome,
} from '../runtime-session.js';

/** 手工控制 Promise */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 刷新微任务 / setImmediate 队列 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function outcome(reply = 'ok'): ChatOutcome {
  return { reply, filtered: false, filterReason: null };
}

test('Tick 与 Chat 共用单执行器：不会并发执行', async () => {
  const session = new RuntimeSession('sched-serial', {
    chatWaitTimeoutMs: 10_000,
  });
  const gate = deferred<void>();
  const order: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  const chat = session.reserveChat();
  session.markReady(chat, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push('chat:start');
    await gate.promise;
    order.push('chat:end');
    concurrent -= 1;
    return outcome('chat');
  });

  const tick = session.requestTick(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push('tick:start');
    concurrent -= 1;
    return 'tick-result';
  });

  await flush();
  assert.deepEqual(order, ['chat:start'], 'Tick 不得与运行中的 Chat 并发');
  assert.equal(session.snapshot().tick.pending, true);
  assert.equal(session.snapshot().tick.running, false);
  assert.equal(session.snapshot().runningTaskKind, 'chat');

  gate.resolve();
  assert.deepEqual(await chat.completion, outcome('chat'));
  assert.equal(await tick, 'tick-result');

  assert.equal(maxConcurrent, 1, '同一 session 不得并发执行 Chat 与 Tick');
  assert.deepEqual(order, ['chat:start', 'chat:end', 'tick:start']);
  assert.equal(session.snapshot().running, 0);
});

test('Tick 合并：等待中的重复请求返回同一 Promise，任务只执行一次', async () => {
  const session = new RuntimeSession('sched-merge-pending', {
    chatWaitTimeoutMs: 10_000,
  });
  const gate = deferred<void>();
  let calls = 0;

  const chat = session.reserveChat();
  session.markReady(chat, async () => {
    await gate.promise;
    return outcome('chat');
  });
  await flush();

  const first = session.requestTick(async () => {
    calls += 1;
    return 'first';
  });
  const second = session.requestTick(async () => {
    calls += 1;
    return 'second';
  });

  assert.equal(second, first, '等待中的重复 Tick 请求必须合并');
  assert.equal(calls, 0, 'Tick 不得越过运行中的 Chat 提前执行');

  gate.resolve();
  await chat.completion;
  assert.equal(await first, 'first');
  assert.equal(calls, 1, '合并后的 Tick 任务工厂只执行一次');
});

test('Tick 合并：执行中的重复请求共享同一 Promise，不再重复排队', async () => {
  const session = new RuntimeSession('sched-merge-running', {
    chatWaitTimeoutMs: 10_000,
  });
  const gate = deferred<void>();
  let calls = 0;

  const first = session.requestTick(async () => {
    calls += 1;
    await gate.promise;
    return 'first';
  });
  await flush();
  assert.equal(session.snapshot().tick.running, true);

  const second = session.requestTick(async () => {
    calls += 1;
    return 'second';
  });
  assert.equal(second, first, '执行中的 Tick 请求必须合并到当前任务');

  gate.resolve();
  assert.equal(await first, 'first');
  assert.equal(calls, 1, '执行中的 Tick 请求不得再排队执行一次');
  assert.equal(session.snapshot().tick.running, false);
});

test('Recovery Tick 最高优先级：Tick 失败后先恢复，等待中的 Chat 不得插队', async () => {
  const session = new RuntimeSession('sched-recovery', {
    chatWaitTimeoutMs: 10_000,
  });
  const gate = deferred<void>();
  const order: string[] = [];

  // 1. 一轮普通 Tick 失败 → 下一轮必须升级为 recovery
  const failed = session.requestTick(async () => {
    order.push('tick:failed');
    throw new Error('db down');
  });
  await assert.rejects(failed, /db down/);
  assert.equal(session.snapshot().tick.recoveryRequired, true);

  // 2. Chat A 正在执行，Chat B 已在等待
  const chatA = session.reserveChat();
  session.markReady(chatA, async () => {
    order.push('chatA:start');
    await gate.promise;
    order.push('chatA:end');
    return outcome('a');
  });
  await flush();

  const chatB = session.reserveChat();
  session.markReady(chatB, async () => {
    order.push('chatB');
    return outcome('b');
  });

  // 3. Recovery Tick 入队
  const recovery = session.requestTick(async () => {
    order.push('recovery-tick');
    return 'recovered';
  });
  assert.equal(session.snapshot().tick.kind, 'recovery-tick');
  assert.equal(session.snapshot().tick.pending, true);

  gate.resolve();
  await chatA.completion;
  await recovery;
  await chatB.completion;

  assert.deepEqual(
    order,
    ['tick:failed', 'chatA:start', 'chatA:end', 'recovery-tick', 'chatB'],
    'recovery-tick 必须在等待中的 Chat 之前执行',
  );
  assert.equal(session.snapshot().tick.recoveryRequired, false, '恢复成功必须清除标记');
});

test('公平调度：普通 Tick 执行后，等待中的 Chat 先于下一轮 Tick 执行', async () => {
  const session = new RuntimeSession('sched-fairness', {
    chatWaitTimeoutMs: 10_000,
  });
  const tickGate = deferred<void>();
  const chatGate = deferred<void>();
  const order: string[] = [];

  // Tick 1 执行中
  const tick1 = session.requestTick(async () => {
    order.push('tick1:start');
    await tickGate.promise;
    order.push('tick1:end');
    return 't1';
  });
  await flush();
  assert.equal(session.snapshot().tick.running, true);

  // Tick 执行期间到达的 Chat
  const chat = session.reserveChat();
  session.markReady(chat, async () => {
    order.push('chat:start');
    await chatGate.promise;
    order.push('chat:end');
    return outcome('chat');
  });
  assert.equal(session.snapshot().ready, 1);

  tickGate.resolve();
  await tick1;
  await flush();

  // Tick 结束后必须立即给等待中的 Chat 一次执行机会
  assert.deepEqual(order, ['tick1:start', 'tick1:end', 'chat:start']);
  assert.equal(session.snapshot().runningTaskKind, 'chat');

  // Chat 执行中请求下一轮 Tick：必须等 Chat 结束
  const tick2 = session.requestTick(async () => {
    order.push('tick2');
    return 't2';
  });
  assert.equal(session.snapshot().tick.pending, true);

  chatGate.resolve();
  await chat.completion;
  assert.equal(await tick2, 't2');

  assert.deepEqual(order, [
    'tick1:start',
    'tick1:end',
    'chat:start',
    'chat:end',
    'tick2',
  ]);
});

test('Tick 失败不阻塞后续任务：Chat 正常执行，下一轮恢复成功后恢复普通 Tick', async () => {
  const session = new RuntimeSession('sched-failure-recovery', {
    chatWaitTimeoutMs: 10_000,
  });
  const order: string[] = [];

  const failed = session.requestTick(async () => {
    order.push('tick:failed');
    throw new Error('persist failed');
  });
  await assert.rejects(failed, /persist failed/);

  // Chat 不被失败的 Tick 阻塞
  const chat = session.reserveChat();
  session.markReady(chat, async () => {
    order.push('chat');
    return outcome('chat');
  });
  assert.deepEqual(await chat.completion, outcome('chat'));

  // 下一轮 Tick 自动成为 recovery-tick 并成功
  const recovery = session.requestTick(async () => {
    order.push('recovery-tick');
    return 'recovered';
  });
  assert.equal(session.snapshot().tick.kind, 'recovery-tick');
  assert.equal(await recovery, 'recovered');
  assert.equal(session.snapshot().tick.recoveryRequired, false);

  // 恢复之后回到普通 Tick
  const normal = session.requestTick(async () => {
    order.push('tick:normal');
    return 'normal';
  });
  assert.equal(session.snapshot().tick.kind, 'tick');
  assert.equal(await normal, 'normal');

  assert.deepEqual(order, ['tick:failed', 'chat', 'recovery-tick', 'tick:normal']);
});

test('QueueSnapshot：Tick 的排队 / 执行 / 恢复标记在各阶段准确', async () => {
  const session = new RuntimeSession('sched-snapshot', {
    chatWaitTimeoutMs: 10_000,
  });

  let snap = session.snapshot();
  assert.deepEqual(snap.tick, {
    pending: false,
    running: false,
    kind: null,
    recoveryRequired: false,
  });
  assert.equal(snap.runningTaskKind, null);
  assert.equal(snap.running, 0);

  const gate = deferred<void>();
  const tick = session.requestTick(async () => {
    await gate.promise;
    return 'tick';
  });
  await flush();

  snap = session.snapshot();
  assert.deepEqual(snap.tick, {
    pending: false,
    running: true,
    kind: 'tick',
    recoveryRequired: false,
  });
  assert.equal(snap.runningTaskKind, 'tick');
  assert.equal(snap.running, 1);
  assert.equal(snap.runningChatId, null);

  gate.resolve();
  await tick;

  snap = session.snapshot();
  assert.deepEqual(snap.tick, {
    pending: false,
    running: false,
    kind: null,
    recoveryRequired: false,
  });
  assert.equal(snap.runningTaskKind, null);

  // 失败后：recoveryRequired=true，下一次请求即为 recovery-tick
  const failed = session.requestTick(async () => {
    throw new Error('boom');
  });
  await assert.rejects(failed, /boom/);
  assert.equal(session.snapshot().tick.recoveryRequired, true);

  const recovery = session.requestTick(async () => 'recovered');
  assert.equal(session.snapshot().tick.kind, 'recovery-tick');
  assert.equal(await recovery, 'recovered');
});
