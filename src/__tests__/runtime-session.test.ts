/**
 * runtime-session.test.ts — RuntimeSession 基础调度器单元测试（M1.2.2-C1）
 *
 * 覆盖：
 * - 同一 identity 的单执行器：Chat 任务不并发
 * - Admission FIFO：后到但先提取完成的任务不能越过仍在 extracting 的早到任务
 * - 32 容量边界：第 33 个在调用提取前同步拒绝
 * - extracting 计入容量
 * - 提取失败 / 等待超时释放容量
 * - 晚到提取结果被丢弃
 * - removed 不能重新 ready
 * - release 幂等，容量只释放一次
 * - 任务失败不阻塞后续任务
 * - completion Promise 准确返回结果 / 异常
 * - QueueSnapshot 在状态转换中准确
 * - 同 identity 注册表唯一实例
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatAdmissionRemovedError,
  ChatWaitTimeoutError,
  getRuntimeSession,
  RuntimeQueueFullError,
  RuntimeSession,
  type ChatAdmission,
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

test('单执行器：同一 identity 的两个 Chat 任务不会并发执行', async () => {
  const session = new RuntimeSession('rt-serial', { chatWaitTimeoutMs: 10_000 });
  const gate = deferred<void>();
  const order: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  const first = session.reserveChat();
  session.markReady(first, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
    concurrent -= 1;
    return outcome('first');
  });

  const second = session.reserveChat();
  session.markReady(second, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push('second:start');
    concurrent -= 1;
    return outcome('second');
  });

  await flush();
  assert.equal(session.snapshot().running, 1, '第一个任务必须在执行');
  assert.equal(session.snapshot().ready, 1, '第二个任务必须等待执行器');
  assert.equal(order.includes('second:start'), false, '第二个任务不得提前开始');

  gate.resolve();
  assert.deepEqual(await first.completion, outcome('first'));
  assert.deepEqual(await second.completion, outcome('second'));

  assert.equal(maxConcurrent, 1, '同一 session 不得并发执行两个 Chat 任务');
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  assert.equal(session.snapshot().active, 0);
});

test('Admission FIFO：后到但先完成提取的 Chat 不能越过仍在 extracting 的早到 Chat', async () => {
  const session = new RuntimeSession('rt-fifo', { chatWaitTimeoutMs: 10_000 });
  const order: string[] = [];

  const first = session.reserveChat();
  const second = session.reserveChat();

  // 后到的 second 先完成提取
  assert.equal(
    session.markReady(second, async () => {
      order.push('second');
      return outcome('second');
    }),
    true,
  );
  await flush();
  assert.equal(order.length, 0, 'second 不得越过仍在 extracting 的 first');
  assert.equal(session.snapshot().waiting, 1, 'second 必须处于 waiting');
  assert.equal(session.snapshot().ready, 0);

  // 早到的 first 后完成提取
  session.markReady(first, async () => {
    order.push('first');
    return outcome('first');
  });

  assert.deepEqual(await first.completion, outcome('first'));
  assert.deepEqual(await second.completion, outcome('second'));
  assert.deepEqual(order, ['first', 'second'], '执行顺序必须按 admission 顺序');
});

test('容量边界：32 个活动 admission，第 33 个在提取前同步拒绝', async () => {
  const session = new RuntimeSession('rt-capacity', { chatWaitTimeoutMs: 10_000 });
  const admissions: ChatAdmission[] = [];

  for (let i = 0; i < 32; i += 1) {
    admissions.push(session.reserveChat());
  }

  const snap = session.snapshot();
  assert.equal(snap.active, 32);
  assert.equal(snap.reserved, 32, 'extracting 必须计入容量');
  assert.equal(snap.maxAcceptedChats, 32);

  // 第 33 个请求：同步抛出，调用方还来不及调用 LLM 提取
  let extractionCalled = false;
  assert.throws(
    () => {
      session.reserveChat();
      // 只有 reserveChat 成功返回后，调用方才会进入 LLM 提取
      extractionCalled = true;
    },
    (err: unknown) => {
      assert.ok(err instanceof RuntimeQueueFullError);
      assert.equal(err.code, 'chat_queue_full');
      return true;
    },
  );
  // 抛出发生在提取之前：提取代码没有机会执行
  assert.equal(extractionCalled, false, '容量检查必须先于任何提取副作用');

  for (const admission of admissions) {
    session.release(admission);
  }
  assert.equal(session.snapshot().active, 0, '全部释放后容量必须归零');

  // 已移除的 completion 全部以 ChatAdmissionRemovedError 拒绝，避免悬挂
  for (const admission of admissions) {
    await assert.rejects(
      admission.completion,
      (err: unknown) => err instanceof ChatAdmissionRemovedError,
    );
  }
});

test('提取失败释放容量：reserved → removed，晚到结果不可再 ready', async () => {
  const session = new RuntimeSession('rt-extract-fail', {
    chatWaitTimeoutMs: 10_000,
  });
  const admission = session.reserveChat();
  assert.equal(session.snapshot().active, 1);

  session.release(admission, 'extraction failed');
  assert.equal(session.snapshot().active, 0, '提取失败必须释放容量');
  assert.equal(admission.state, 'removed');
  await assert.rejects(
    admission.completion,
    (err: unknown) => {
      assert.ok(err instanceof ChatAdmissionRemovedError);
      assert.match(err.message, /extraction failed/);
      return true;
    },
  );

  let ran = false;
  assert.equal(
    session.markReady(admission, async () => {
      ran = true;
      return outcome();
    }),
    false,
    'removed admission 不得重新 ready',
  );
  await flush();
  assert.equal(ran, false);
});

test('等待超时：从 reserveChat 开始计时，超时物理移除并释放容量', async () => {
  const session = new RuntimeSession('rt-timeout', { chatWaitTimeoutMs: 10 });
  const admission = session.reserveChat();
  assert.equal(session.snapshot().active, 1);

  await assert.rejects(
    admission.completion,
    (err: unknown) => {
      assert.ok(err instanceof ChatWaitTimeoutError);
      assert.equal(err.code, 'chat_wait_timeout');
      return true;
    },
  );

  assert.equal(admission.state, 'removed');
  assert.equal(session.snapshot().active, 0, '超时必须释放容量');
  assert.deepEqual(session.snapshot().entries, [], '超时任务必须从队列物理移除');

  // 容量已恢复：可以继续接收新请求
  const next = session.reserveChat();
  assert.equal(session.snapshot().active, 1);
  session.release(next);
  await assert.rejects(next.completion);
});

test('晚到提取结果被丢弃：超时后 markReady 返回 false 且任务不执行', async () => {
  const session = new RuntimeSession('rt-late', { chatWaitTimeoutMs: 10 });
  const admission = session.reserveChat();
  await assert.rejects(admission.completion);

  let ran = false;
  const accepted = session.markReady(admission, async () => {
    ran = true;
    return outcome();
  });

  assert.equal(accepted, false, '晚到结果必须丢弃');
  await flush();
  assert.equal(ran, false, '被丢弃的任务绝不能执行');
  assert.equal(session.snapshot().active, 0);
});

test('release 幂等：重复释放不会重复扣减容量或改变终态', async () => {
  const session = new RuntimeSession('rt-release-idempotent', {
    chatWaitTimeoutMs: 10_000,
  });
  const admission = session.reserveChat();

  session.release(admission);
  session.release(admission);
  session.release(admission);

  assert.equal(admission.state, 'removed');
  assert.equal(session.snapshot().active, 0, '容量只能释放一次');
  await assert.rejects(
    admission.completion,
    (err: unknown) => err instanceof ChatAdmissionRemovedError,
  );

  // 完成任务后再次 release 也必须 no-op
  const done = session.reserveChat();
  session.markReady(done, async () => outcome('done'));
  assert.deepEqual(await done.completion, outcome('done'));
  session.release(done);
  assert.equal(session.snapshot().active, 0);
});

test('任务失败不阻塞后续任务', async () => {
  const session = new RuntimeSession('rt-task-failure', {
    chatWaitTimeoutMs: 10_000,
  });
  const order: string[] = [];

  const failing = session.reserveChat();
  session.markReady(failing, async () => {
    order.push('failing');
    throw new Error('boom');
  });

  const following = session.reserveChat();
  session.markReady(following, async () => {
    order.push('following');
    return outcome('following');
  });

  await assert.rejects(failing.completion, /boom/);
  assert.equal(failing.state, 'failed');
  assert.deepEqual(await following.completion, outcome('following'));
  assert.deepEqual(order, ['failing', 'following'], '失败后必须继续调度后续任务');
  assert.equal(session.snapshot().active, 0);
});

test('completion Promise 准确返回结果与异常', async () => {
  const session = new RuntimeSession('rt-completion', {
    chatWaitTimeoutMs: 10_000,
  });

  const success = session.reserveChat();
  session.markReady(success, async () => ({
    reply: 'hello',
    filtered: true,
    filterReason: 'interrupted',
  }));
  assert.deepEqual(await success.completion, {
    reply: 'hello',
    filtered: true,
    filterReason: 'interrupted',
  });

  const failure = session.reserveChat();
  const expectedError = new Error('persist failed');
  session.markReady(failure, async () => {
    throw expectedError;
  });
  await assert.rejects(
    failure.completion,
    (err: unknown) => err === expectedError,
  );
});

test('QueueSnapshot 在各状态转换时准确', async () => {
  const session = new RuntimeSession('rt-snapshot', {
    chatWaitTimeoutMs: 10_000,
  });
  const gate = deferred<void>();

  const first = session.reserveChat();
  let snap = session.snapshot();
  assert.equal(snap.active, 1);
  assert.equal(snap.reserved, 1);
  assert.equal(snap.ready, 0);
  assert.equal(snap.waiting, 0);
  assert.equal(snap.running, 0);
  assert.equal(snap.entries[0]?.state, 'reserved');

  session.markReady(first, async () => {
    await gate.promise;
    return outcome('first');
  });
  await flush();
  snap = session.snapshot();
  assert.equal(snap.reserved, 0);
  assert.equal(snap.running, 1);
  assert.equal(snap.runningChatId, first.id);
  assert.equal(snap.entries.at(-1)?.state, 'running');

  const second = session.reserveChat();
  snap = session.snapshot();
  assert.equal(snap.active, 2);
  assert.equal(snap.running, 1);
  assert.equal(snap.reserved, 1);

  session.markReady(second, async () => outcome('second'));
  snap = session.snapshot();
  assert.equal(snap.reserved, 0);
  assert.equal(snap.ready, 1, '第二个任务在队列中等待执行器');
  assert.equal(snap.running, 1);

  gate.resolve();
  await first.completion;
  await second.completion;
  snap = session.snapshot();
  assert.equal(snap.active, 0);
  assert.equal(snap.reserved, 0);
  assert.equal(snap.ready, 0);
  assert.equal(snap.waiting, 0);
  assert.equal(snap.running, 0);
  assert.equal(snap.runningChatId, null);
  assert.deepEqual(snap.entries, []);
});

test('同 identity 注册表唯一：重复获取返回同一 RuntimeSession', () => {
  const first = getRuntimeSession('rt-registry');
  const second = getRuntimeSession('rt-registry', { chatWaitTimeoutMs: 5 });

  assert.equal(first, second, '同一 identity 只能有一个写入权所有者');
  assert.equal(first.chatWaitTimeoutMs, 30_000, '已存在的 session 不得被新配置覆盖');
});
