import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleTracker, resolveActivityPhase } from '../src/activity-lifecycle.ts';

test('首次加载只建立基线，历史记录不触发动画', () => {
  const t = new LifecycleTracker();
  const first = t.observe([
    { direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' },
    { direction: 'companion_output', timestamp: '2026-11-04T08:00:05.000Z' },
  ]);
  assert.equal(first.kind, 'none');
  assert.equal(first.at, '2026-11-04T08:00:05.000Z');
});

test('新增 user_input 触发 received', () => {
  const t = new LifecycleTracker();
  t.observe([{ direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' }]);
  const obs = t.observe([
    { direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' },
    { direction: 'user_input', timestamp: '2026-11-04T08:10:00.000Z' },
  ]);
  assert.equal(obs.kind, 'received');
  assert.equal(obs.at, '2026-11-04T08:10:00.000Z');
});

test('相同轮询结果重复传入不会重复触发（页面轮询不误判为新请求）', () => {
  const t = new LifecycleTracker();
  const rows = [{ direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' }];
  t.observe(rows);
  assert.equal(t.observe(rows).kind, 'none');
  assert.equal(t.observe([...rows]).kind, 'none');
  assert.equal(t.observe([...rows]).kind, 'none');
});

test('新增 companion_output 触发 completed（Runtime 真实枚举）', () => {
  const t = new LifecycleTracker();
  const base = [
    { direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' },
    { direction: 'companion_output', timestamp: '2026-11-04T08:00:05.000Z' },
  ];
  t.observe(base);
  const obs = t.observe([
    ...base,
    { direction: 'companion_output', timestamp: '2026-11-04T08:10:06.000Z' },
  ]);
  assert.equal(obs.kind, 'completed');
  assert.equal(obs.at, '2026-11-04T08:10:06.000Z');
});

test('错误的 direction 枚举不会误触发 completed（防止旧枚举回归）', () => {
  const t = new LifecycleTracker();
  t.observe([{ direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' }]);
  const obs = t.observe([
    { direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' },
    { direction: 'companion', timestamp: '2026-11-04T08:00:05.000Z' },
  ]);
  assert.equal(obs.kind, 'none');
});

test('空对话列表不产生任何阶段变化（普通 Tick 不是用户请求）', () => {
  const t = new LifecycleTracker();
  assert.equal(t.observe([]).kind, 'none');
  assert.equal(t.observe([]).kind, 'none');
});

test('阶段优先级：received > completed > processing > idle', () => {
  assert.equal(resolveActivityPhase('received', { runningChatId: 'c1', active: 1 }), 'received');
  assert.equal(resolveActivityPhase('completed', { runningChatId: null, active: 3 }), 'completed');
  assert.equal(resolveActivityPhase(null, { runningChatId: 'c1', active: 1 }), 'processing');
  assert.equal(resolveActivityPhase(null, { runningChatId: null, active: 2 }), 'processing');
  assert.equal(resolveActivityPhase(null, { runningChatId: null, active: 0 }), 'idle');
  assert.equal(resolveActivityPhase(null, null), 'idle');
  assert.equal(resolveActivityPhase(null, undefined), 'idle');
});

test('reset 后重新建立基线，不把既有记录当新请求', () => {
  const t = new LifecycleTracker();
  t.observe([{ direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' }]);
  t.reset();
  const obs = t.observe([{ direction: 'user_input', timestamp: '2026-11-04T08:00:00.000Z' }]);
  assert.equal(obs.kind, 'none');
});
