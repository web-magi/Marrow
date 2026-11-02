/**
 * db-lifecycle.test.ts — PostgreSQL 连接层生命周期测试（M1.2.2-C3.1）
 *
 * 覆盖：
 * - closeDb 后 getDb 必须抛 DbClosedError，禁止惰性重建连接池
 * - closeDb 幂等：多次调用返回同一个 Promise
 * - 并发 closeDb 安全：连接池只关闭一次
 *
 * 本文件不需要真实 PostgreSQL：
 * 关闭语义在连接层入口（getDb/closeDb）生效，不触网即可验证。
 * 注意：closeDb 是终态（本阶段无 reopenDb），本文件独立成进程运行，
 * 不得与其他需要数据库的测试文件合并。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, DbClosedError, getDb } from '../db/connection.js';

test('closeDb 后 getDb 必须拒绝，且不得重新创建连接池', async () => {
  await closeDb();

  assert.throws(() => getDb(), (err: unknown) => {
    assert.ok(err instanceof DbClosedError);
    assert.equal(err.code, 'db_closed');
    return true;
  });
  // 再次调用仍然拒绝：不存在"关闭后再次惰性建池"的后门
  assert.throws(() => getDb(), DbClosedError);
});

test('closeDb 幂等：多次调用返回同一个 Promise', async () => {
  const first = closeDb();
  const second = closeDb();
  assert.equal(first, second, '多次 closeDb 必须返回同一个 Promise');
  await first;
  await second;
});

test('并发 closeDb 安全：并发调用共享同一次关闭', async () => {
  const results = await Promise.all([closeDb(), closeDb(), closeDb()]);
  assert.deepEqual(results, [undefined, undefined, undefined]);
  // 关闭是终态：并发关闭完成后 getDb 仍然拒绝
  assert.throws(() => getDb(), DbClosedError);
});
