/**
 * observation-inbox.test.ts — 观测确认层单元测试（M1.2.2.2-A）
 *
 * 覆盖：
 * - observe() 首次读取生成稳定 id / observedAt / eventTimestamp，重复调用复用
 * - 重试路径绝不重新调用传感器 read()
 * - pending / pendingKinds / hasPending 全部异步接口
 * - confirm() 按 observationId 精确清除；未知 ID 与重复确认均为幂等 no-op
 * - 观测恢复屏障 assertObservationBarrier 的抛出语义
 *
 * 纯内存，无数据库、无网络。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertObservationBarrier,
  InMemoryObservationInbox,
  ObservationBarrierError,
} from '../observation.js';

test('observe 首次读取：生成 id / observedAt / eventTimestamp，并缓存读数', async () => {
  const inbox = new InMemoryObservationInbox();
  const reading = { level: 42, charging: false };
  const pending = await inbox.observe('battery', () => reading);

  assert.equal(pending.kind, 'battery');
  assert.equal(pending.reading, reading, '读数必须原样缓存');
  assert.ok(pending.id.startsWith('obs-'), '观测 ID 必须有可识别前缀');
  assert.ok(!Number.isNaN(Date.parse(pending.observedAt)), 'observedAt 必须是合法 ISO 时间');
  assert.ok(
    !Number.isNaN(Date.parse(pending.eventTimestamp)),
    'eventTimestamp 必须是合法 ISO 时间',
  );
  assert.ok(
    pending.eventTimestamp >= pending.observedAt,
    '事件时间不得早于物理观测时间',
  );
});

test('observe 重试：复用同一 id / 双时间 / 读数，且不再调用 read()', async () => {
  const inbox = new InMemoryObservationInbox();
  let readCount = 0;

  const first = await inbox.observe('motion', () => {
    readCount += 1;
    return { magnitude: 9.8, collision: false };
  });

  // 模拟写库失败后的重试：同一 kind 再次 observe
  const firstSnapshot = { ...first, reading: { ...first.reading } };
  const retry = await inbox.observe('motion', () => {
    readCount += 1;
    return { magnitude: 50, collision: true };
  });

  assert.equal(readCount, 1, '重试不得重新读取传感器');
  assert.equal(retry.id, firstSnapshot.id, '重试必须复用同一观测 ID');
  assert.equal(retry.observedAt, firstSnapshot.observedAt, 'observedAt 必须稳定');
  assert.equal(retry.eventTimestamp, firstSnapshot.eventTimestamp, 'eventTimestamp 必须稳定');
  assert.deepEqual(retry.reading, firstSnapshot.reading, '读数必须复用首次结果');
});

test('不同 kind 的观测互相独立，pending / pendingKinds / hasPending 全异步', async () => {
  const inbox = new InMemoryObservationInbox();
  assert.equal(await inbox.hasPending(), false);
  assert.deepEqual(await inbox.pendingKinds(), []);

  const battery = await inbox.observe('battery', () => ({ level: 100, charging: true }));
  const environment = await inbox.observe('environment', () => ({
    temperature: 22,
    humidity: 60,
    light: 500,
  }));

  assert.equal(await inbox.hasPending(), true);
  assert.deepEqual(await inbox.pendingKinds(), ['battery', 'environment']);
  assert.equal((await inbox.pending('battery'))?.id, battery.id);
  assert.equal((await inbox.pending('environment'))?.id, environment.id);
  assert.equal(await inbox.pending('motion'), undefined, '未观测的 kind 必须为空');

  // battery 与 environment 的观测时间与 ID 必须各自独立
  assert.notEqual(battery.id, environment.id);
});

test('confirm 按 ID 精确清除：只删除目标观测，未知 ID 与重复确认均 no-op', async () => {
  const inbox = new InMemoryObservationInbox();
  const battery = await inbox.observe('battery', () => ({ level: 100, charging: false }));
  const motion = await inbox.observe('motion', () => ({
    x: 0,
    y: 0,
    z: 9.8,
    magnitude: 9.8,
    collision: false,
  }));

  await inbox.confirm(battery.id);
  assert.equal(await inbox.pending('battery'), undefined, '目标观测必须被清除');
  assert.equal((await inbox.pending('motion'))?.id, motion.id, '其他观测不得被误清');
  assert.equal(await inbox.hasPending(), true);

  // 未知 ID：幂等 no-op
  await inbox.confirm('obs-does-not-exist');
  assert.equal((await inbox.pending('motion'))?.id, motion.id);

  // 重复确认：幂等 no-op
  await inbox.confirm(battery.id);
  await inbox.confirm(battery.id);

  await inbox.confirm(motion.id);
  assert.equal(await inbox.hasPending(), false, '全部确认后屏障应解除');
  assert.deepEqual(await inbox.pendingKinds(), []);
});

test('assertObservationBarrier：存在 pending 时抛 ObservationBarrierError，解除后通过', async () => {
  const inbox = new InMemoryObservationInbox();
  const pending = await inbox.observe('motion', () => ({
    x: 0,
    y: 0,
    z: 30,
    magnitude: 30,
    collision: true,
  }));

  await assert.rejects(
    assertObservationBarrier(inbox),
    (err: unknown) => {
      assert.ok(err instanceof ObservationBarrierError, '必须抛出观测屏障错误');
      assert.equal(err.code, 'observations_pending');
      assert.equal(err.name, 'ObservationBarrierError');
      return true;
    },
  );

  await inbox.confirm(pending.id);
  await assert.doesNotReject(assertObservationBarrier(inbox));
});
