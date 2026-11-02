/**
 * runtime-session-lifecycle.test.ts — RuntimeSession 生命周期与可靠性测试（M1.2.2-C3 / C3.1）
 *
 * 覆盖：
 * - AbortSignal：release / 等待超时被移除时触发取消信号（用于取消 LLM 提取）
 * - AbortSignal 传入 LLM 提取层：取消后中止底层 fetch 请求，且不降级 mock
 * - shutdown：拒绝新 reserveChat / requestTick，QueueSnapshot.closed 准确
 * - shutdown：排空等待队列（reserved/ready/waiting 全部 removed 并 abort）
 * - shutdown：执行中任务不被打断，完成后 shutdown 才返回
 * - shutdown：丢弃合并的 pendingTick
 * - shutdown：幂等（多次调用返回同一个 Promise / 同一个 ShutdownResult）
 * - ShutdownResult（C3.1）：宽限期内 drained=true；超时 drained=false 且 timedOut=true，
 *   绝不把等待超时误报为任务完成；drainedChats / discardedTick 计数准确
 * - waitForIdle（C3.1）：无任务 'idle' / 成功 'completed' / 失败 'failed'，
 *   drained=false 之后可据此安全关闭数据库
 * - 并发竞态：并发 reserve/markReady/release 与 shutdown 交错后状态一致，
 *   被排空的任务绝不执行，removed 不得复活
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatAdmissionRemovedError,
  ChatWaitTimeoutError,
  RuntimeSession,
  RuntimeSessionClosedError,
  type ChatAdmission,
  type ChatOutcome,
} from '../runtime-session.js';
import { buildStateSnapshot, createLLMClient } from '../llm.js';
import { createInitialState } from '../state.js';

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

// ==================================================================
// 一、AbortSignal：移除时触发取消信号
// ==================================================================

test('AbortSignal：release 触发取消信号并拒绝 completion', async () => {
  const session = new RuntimeSession('life-signal-release', { chatWaitTimeoutMs: 10_000 });
  const admission = session.reserveChat();

  assert.equal(admission.signal.aborted, false, '预留时信号不得中止');

  session.release(admission, 'test release');

  assert.equal(admission.signal.aborted, true, 'release 必须触发取消信号');
  assert.ok(
    admission.signal.reason instanceof ChatAdmissionRemovedError,
    '取消原因必须与 completion 拒绝原因一致',
  );
  assert.equal(admission.state, 'removed');
  await assert.rejects(admission.completion, ChatAdmissionRemovedError);
  assert.equal(session.snapshot().active, 0, '容量必须释放');
});

test('AbortSignal：等待超时自动触发取消信号', async () => {
  const session = new RuntimeSession('life-signal-timeout', { chatWaitTimeoutMs: 30 });
  const admission = session.reserveChat();

  await assert.rejects(admission.completion, ChatWaitTimeoutError);
  assert.equal(admission.signal.aborted, true, '超时移除必须触发取消信号');
  assert.ok(admission.signal.reason instanceof ChatWaitTimeoutError);
  assert.equal(session.snapshot().active, 0, '超时必须释放容量');
});

test('AbortSignal：取消信号传入 LLM 提取层并中止底层请求，且不降级 mock', async (t) => {
  // 让 createLLMClient 选择真实客户端（baseUrl 非 OpenAI 默认地址即判定为本地服务）
  const prevBaseUrl = process.env.LLM_BASE_URL;
  const prevApiKey = process.env.LLM_API_KEY;
  process.env.LLM_BASE_URL = 'http://llm.invalid';
  delete process.env.LLM_API_KEY;
  t.after(() => {
    if (prevBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = prevBaseUrl;
    if (prevApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = prevApiKey;
  });

  // mock 底层 fetch：模拟永不返回的模型服务，仅在取消信号触发时拒绝
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', ((_input: unknown, init?: { signal?: AbortSignal | null }) => {
    fetchCalls += 1;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // 无信号：永不返回
      const rejectWithReason = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      };
      if (signal.aborted) {
        rejectWithReason();
        return;
      }
      signal.addEventListener('abort', rejectWithReason, { once: true });
    });
  }) as typeof fetch);

  const client = createLLMClient();
  const controller = new AbortController();
  const snapshot = buildStateSnapshot(createInitialState(new Date().toISOString()));

  const pending = client.generateResponse(snapshot, '你好', controller.signal);
  const rejection = assert.rejects(pending, /test abort/);
  controller.abort(new Error('test abort'));
  await rejection;

  assert.equal(fetchCalls, 1, '取消后不得降级 mock 重试，底层请求只发出一次');
});

// ==================================================================
// 二、shutdown：拒绝新任务
// ==================================================================

test('shutdown：关闭后拒绝新的 reserveChat 与 requestTick，快照 closed 准确', async () => {
  const session = new RuntimeSession('life-closed');

  assert.equal(session.isClosed, false);
  assert.equal(session.snapshot().closed, false);

  await session.shutdown();

  assert.equal(session.isClosed, true);
  assert.equal(session.snapshot().closed, true);
  assert.throws(
    () => session.reserveChat(),
    (err: unknown) => err instanceof RuntimeSessionClosedError,
  );
  await assert.rejects(
    session.requestTick(async () => 'x'),
    (err: unknown) => err instanceof RuntimeSessionClosedError,
  );
});

// ==================================================================
// 三、shutdown：排空等待队列，执行中任务不被打断
// ==================================================================

test('shutdown：排空等待队列（abort + 拒绝），执行中任务正常完成后才返回', async () => {
  const session = new RuntimeSession('life-drain', { chatWaitTimeoutMs: 10_000 });
  const gate = deferred<void>();

  // 执行中任务
  const running = session.reserveChat();
  session.markReady(running, async () => {
    await gate.promise;
    return outcome('running');
  });
  // 仍在提取（reserved）
  const extracting = session.reserveChat();
  // 已就绪但被 FIFO 阻塞（waiting：前面有 reserved）
  const queued = session.reserveChat();
  let queuedExecuted = false;
  session.markReady(queued, async () => {
    queuedExecuted = true;
    return outcome('queued');
  });

  await flush();
  assert.equal(session.snapshot().active, 3);
  assert.equal(session.snapshot().running, 1);

  let shutdownResolved = false;
  const shutdownResultPromise = session.shutdown();
  const shutdownPromise = shutdownResultPromise.then(() => {
    shutdownResolved = true;
  });

  // 等待中的 admission 立即被移除并触发取消信号
  await assert.rejects(extracting.completion, (err: unknown) => {
    assert.ok(err instanceof ChatAdmissionRemovedError);
    assert.match(err.message, /shutdown/);
    return true;
  });
  await assert.rejects(queued.completion, ChatAdmissionRemovedError);
  assert.equal(extracting.signal.aborted, true, '被排空时必须触发取消信号');
  assert.equal(queued.signal.aborted, true);
  assert.equal(queuedExecuted, false, '被排空的任务绝不执行');
  assert.equal(session.snapshot().active, 1, '只剩执行中任务计入容量');

  // 执行中任务未完成前，shutdown 必须等待
  await flush();
  assert.equal(shutdownResolved, false, '执行中任务未完成时 shutdown 不得返回');

  // 执行中任务不被打断，正常完成后 shutdown 才返回
  gate.resolve();
  assert.deepEqual(await running.completion, outcome('running'));
  await shutdownPromise;
  const result = await shutdownResultPromise;
  assert.equal(shutdownResolved, true);
  assert.equal(result.drained, true, '执行中任务已完成：必须报告 drained=true');
  assert.equal(result.running, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.drainedChats, 2, '排空计数必须覆盖 reserved + waiting 两个等待任务');
  assert.equal(result.discardedTick, false);
  assert.equal(session.snapshot().active, 0);
});

// ==================================================================
// 四、shutdown：丢弃合并的 pendingTick
// ==================================================================

test('shutdown：丢弃尚未执行的 pendingTick 并以关闭错误拒绝', async () => {
  const session = new RuntimeSession('life-pending-tick', { chatWaitTimeoutMs: 10_000 });
  const gate = deferred<void>();

  const chat = session.reserveChat();
  session.markReady(chat, async () => {
    await gate.promise;
    return outcome();
  });
  await flush();
  assert.equal(session.snapshot().runningTaskKind, 'chat');

  let tickExecuted = false;
  const tick = session.requestTick(async () => {
    tickExecuted = true;
    return 'tick-result';
  });
  assert.equal(session.snapshot().tick.pending, true);

  const tickRejection = assert.rejects(tick, (err: unknown) => {
    assert.ok(err instanceof RuntimeSessionClosedError);
    return true;
  });

  const shutdownPromise = session.shutdown();
  await tickRejection;
  assert.equal(tickExecuted, false, '未开始执行的 Tick 必须被丢弃');
  assert.equal(session.snapshot().tick.pending, false);

  gate.resolve();
  await chat.completion;
  const result = await shutdownPromise;
  assert.equal(result.discardedTick, true, 'ShutdownResult 必须报告 pendingTick 被丢弃');
  assert.equal(result.drained, true);
});

// ==================================================================
// 五、shutdown：幂等
// ==================================================================

test('shutdown：多次调用返回同一个 Promise 与同一份最终结果（幂等）', async () => {
  const session = new RuntimeSession('life-idempotent');

  const first = session.shutdown();
  const second = session.shutdown();

  assert.equal(first, second, '多次 shutdown 必须返回同一个 Promise');
  const r1 = await first;
  const r2 = await second;
  assert.equal(r1, r2, '多次 shutdown 必须返回同一份 ShutdownResult');
  assert.equal(r1.drained, true);
  assert.equal(session.isClosed, true);
});

// ==================================================================
// 六、ShutdownResult：宽限期与 drained 语义（C3.1）
// ==================================================================

test('ShutdownResult：宽限期内任务完成时 drained=true 且 timedOut=false', async () => {
  const session = new RuntimeSession('life-grace-ok', { chatWaitTimeoutMs: 10_000 });
  const chat = session.reserveChat();
  session.markReady(chat, async () => outcome('fast'));

  const result = await session.shutdown({ graceMs: 5_000 });

  assert.equal(result.drained, true);
  assert.equal(result.running, 0);
  assert.equal(result.timedOut, false, '宽限期内完成不得误报为超时');
  assert.deepEqual(await chat.completion, outcome('fast'));
});

test('ShutdownResult：宽限期超时 drained=false，waitForIdle 等待任务真正完成', async () => {
  const session = new RuntimeSession('life-grace-timeout', { chatWaitTimeoutMs: 10_000 });
  const gate = deferred<void>();
  let taskEnded = false;

  const chat = session.reserveChat();
  session.markReady(chat, async () => {
    await gate.promise;
    taskEnded = true;
    return outcome();
  });
  await flush();
  assert.equal(session.snapshot().running, 1);

  const startedAt = Date.now();
  const result = await session.shutdown({ graceMs: 50 });

  assert.ok(Date.now() - startedAt < 5_000, '宽限期超时后 shutdown 必须返回');
  assert.equal(result.drained, false, '任务仍在执行时必须报告 drained=false');
  assert.equal(result.running, 1);
  assert.equal(result.timedOut, true, '必须显式报告超时，不得误报为任务已完成');
  assert.equal(taskEnded, false, '执行中任务绝不因 shutdown 被打断');
  assert.equal(session.isClosed, true);

  // drained=false 之后的唯一安全路径：等待任务真正结束（数据库才能安全关闭）
  const idlePromise = session.waitForIdle();
  gate.resolve();
  assert.equal(await idlePromise, 'completed');
  assert.equal(taskEnded, true);
  assert.equal(session.snapshot().running, 0);
});

test('waitForIdle：running 任务最终失败后返回 failed，会话仍可安全关闭', async () => {
  const session = new RuntimeSession('life-grace-fail', { chatWaitTimeoutMs: 10_000 });
  const gate = deferred<void>();

  const chat = session.reserveChat();
  session.markReady(chat, async () => {
    await gate.promise;
    throw new Error('task failed after shutdown timeout');
  });
  await flush();

  const result = await session.shutdown({ graceMs: 50 });
  assert.equal(result.drained, false);

  const completionRejection = assert.rejects(chat.completion, /task failed/);
  const idlePromise = session.waitForIdle();
  gate.resolve();
  await completionRejection;
  assert.equal(await idlePromise, 'failed', '任务最终失败必须被体现为 failed');

  // 失败不等于卡死：执行器已空闲，允许安全关闭数据库
  assert.equal(session.snapshot().running, 0);
  assert.equal(session.snapshot().active, 0);
  assert.equal(session.isClosed, true);
});

test('waitForIdle：无 running 任务时立即返回 idle', async () => {
  const session = new RuntimeSession('life-idle');
  assert.equal(await session.waitForIdle(), 'idle');
  await session.shutdown();
  assert.equal(await session.waitForIdle(), 'idle', '关闭后无任务仍为 idle');
});

// ==================================================================
// 七、并发竞态：并发操作与 shutdown 交错后状态一致
// ==================================================================

test('并发竞态：并发 reserve/markReady/release 与 shutdown 交错后状态一致', async () => {
  const session = new RuntimeSession('life-race', {
    maxAcceptedChats: 8,
    chatWaitTimeoutMs: 5_000,
  });
  const gate = deferred<void>();

  // 长任务占用执行器
  const longRunner = session.reserveChat();
  session.markReady(longRunner, async () => {
    await gate.promise;
    return outcome('long');
  });

  const admissions: ChatAdmission[] = [];
  for (let i = 0; i < 6; i++) {
    admissions.push(session.reserveChat());
  }
  let executedReady = false;
  // 一半 markReady，一半保持 extracting，穿插 release
  session.markReady(admissions[0]!, async () => {
    executedReady = true;
    return outcome('a0');
  });
  session.release(admissions[1]!, 'race release');
  session.markReady(admissions[2]!, async () => outcome('a2'));
  // admissions[3]/[4]/[5] 保持 reserved（提取中）

  const shutdownPromise = session.shutdown();

  // 关闭后新请求同步拒绝
  assert.throws(() => session.reserveChat(), RuntimeSessionClosedError);

  // 排队中的全部以 removed 拒绝（主动 release 的早已拒绝）
  await assert.rejects(admissions[0]!.completion, ChatAdmissionRemovedError);
  await assert.rejects(admissions[1]!.completion, ChatAdmissionRemovedError);
  await assert.rejects(admissions[2]!.completion, ChatAdmissionRemovedError);
  await assert.rejects(admissions[3]!.completion, ChatAdmissionRemovedError);
  await assert.rejects(admissions[4]!.completion, ChatAdmissionRemovedError);
  await assert.rejects(admissions[5]!.completion, ChatAdmissionRemovedError);
  assert.equal(executedReady, false, '关闭时被排空的就绪任务绝不执行');

  // 执行中任务正常完成
  gate.resolve();
  assert.deepEqual(await longRunner.completion, outcome('long'));
  await shutdownPromise;

  const snap = session.snapshot();
  assert.equal(snap.closed, true);
  assert.equal(snap.active, 0, '关闭并排空后容量必须归零');
  assert.equal(snap.entries.length, 0, '队列必须为空');
  assert.equal(snap.tick.pending, false);

  // 已移除的 admission 不允许复活（迟到结果丢弃）
  assert.equal(
    session.markReady(admissions[3]!, async () => outcome('late')),
    false,
    'removed 不得重新 ready，迟到提取结果必须丢弃',
  );
});
