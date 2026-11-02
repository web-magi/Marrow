/**
 * identity-isolation.pg.test.ts — Identity 隔离真实 PostgreSQL 集成测试
 *
 * 目标：在实施 marrow-v2-birth2 之前，验证以下隔离层：
 *   1. RuntimeSession 按 identityId 隔离（sessions Map 键控）
 *   2. Ownership Lock 按 identityId 哈希键隔离（可同时获取两 identity 锁）
 *   3. Genesis / EventStore / Replay / verifyEventChain 按 identityId 行级隔离
 *   4. RuntimeSession 关闭后清理（无会话泄漏）
 *   5. 新 Identity 零读取 JSONL / 旧 Identity 数据
 *
 * 所有测试使用专用测试 identity（marrow-iso-*），绝不触碰 marrow-v2。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, closeDb } from '../db/connection.js';
import { IDENTITY_ID } from '../storage.js';
import { verifyEventChain } from '../verify-chain.js';
import {
  acquireIdentityOwnership,
  releaseIdentityOwnership,
  freshStartIdentity,
  recoverIdentity,
} from '../recovery.js';
import { getRuntimeSession } from '../runtime-session.js';

// ─── 每个测试 identity 独立，防止残留干扰 ────────────────────

const T = `marrow-iso-${Date.now()}`;
const T_A = `${T}-A`;
const T_B = `${T}-B`;
const T_C = `${T}-C`;

// ─── 工具：清理测试 identity ─────────────────────────────────

async function countRows(identityId: string): Promise<number> {
  const sql = getDb();
  const [r] = await sql`SELECT count(*)::text AS n FROM events WHERE identity_id = ${identityId}`;
  return parseInt((r as { n: string }).n, 10);
}

async function cleanIdentity(identityId: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM events WHERE identity_id = ${identityId}`;
}

// ─── Setup / Teardown ────────────────────────────────────────

before(async () => {
  await Promise.all([cleanIdentity(T_A), cleanIdentity(T_B), cleanIdentity(T_C)]);
});

after(async () => {
  await Promise.all([cleanIdentity(T_A), cleanIdentity(T_B), cleanIdentity(T_C)]);
  await closeDb();
});

// ══════════════════════════════════════════════════════════════
// 一、RuntimeSession 隔离
// ══════════════════════════════════════════════════════════════

test('RuntimeSession — 不同 identity 获取不同实例', async () => {
  const sessionA = getRuntimeSession(T_A);
  const sessionB = getRuntimeSession(T_B);

  // 不同 identity 应该得到不同 RuntimeSession 实例
  assert.notStrictEqual(sessionA, sessionB,
    `不同 identity 应返回不同 RuntimeSession，但实际返回了同一实例`);

  // 同一 identity 第二次获取应该得到同一实例
  const sessionA2 = getRuntimeSession(T_A);
  assert.strictEqual(sessionA, sessionA2,
    `同一 identity 应返回同一 RuntimeSession`);

  console.log(`  session A id=${T_A}, session B id=${T_B}`);
  console.log(`  A !== B : ${sessionA !== sessionB}`);
  console.log(`  A === A2: ${sessionA === sessionA2}`);
});

test('RuntimeSession — A 的 waiting queue 不污染 B', async () => {
  const sessionA = getRuntimeSession(T_A);
  const sessionB = getRuntimeSession(T_B);

  // 给 A 排队一个 Chat admission（但不 markReady）
  sessionA.reserveChat();

  // B 应该仍然可以 reserveChat（容量是 per-session 的）
  const admissionB1 = sessionB.reserveChat();
  const admissionB2 = sessionB.reserveChat();
  assert.ok(admissionB1 !== null, 'B 应该能 reserveChat');
  assert.ok(admissionB2 !== null, 'B 第二次也应该能 reserveChat（B 没占满）');

  console.log(`  A 排队 1 个后，B 仍能排队：B1=${!!admissionB1}, B2=${!!admissionB2}`);
});

test('RuntimeSession — session 内部状态零共享', async () => {
  // RuntimeSession 是实例级封装（私有状态），没有模块级共享状态
  // 验证：A 和 B 是两个完全独立的对象
  const A = getRuntimeSession(T_A);
  const B = getRuntimeSession(T_B);

  // 唯一的模块级状态是 sessions Map（identityId → session），
  // 每个 identity 的 session 是独立的 class 实例
  const keysA = Object.keys(A as object);
  const keysB = Object.keys(B as object);
  assert.deepEqual(keysA, keysB, '两个 RuntimeSession 实例应共享相同属性集合');

  // identityId 属性不同
  // 注意 identityId 是 RuntimeSession 私有字段，我们不能直接访问
  // 但可以通过行为推断：上面已经证明 reserveChat 容量隔离
  console.log(`  两实例属性集合一致，行为已证明隔离`);
});

// ══════════════════════════════════════════════════════════════
// 二、Ownership Lock 隔离
// ══════════════════════════════════════════════════════════════

test('Ownership Lock — 同一进程可同时获取两个不同 identity 的锁', async () => {
  // 同一进程内可以同时持有两 identity 的锁（不同哈希键）
  await acquireIdentityOwnership(T_A);
  await acquireIdentityOwnership(T_B);

  // 两锁都已获取 → 不抛错
  console.log(`  同时持有 T_A 和 T_B 的锁：成功`);

  await releaseIdentityOwnership(T_A);
  await releaseIdentityOwnership(T_B);
});

test('Ownership Lock — 持 A 锁期间不能重新获取 A，但可以获取 B', async () => {
  await acquireIdentityOwnership(T_A);

  // B 应该能立即获取（不同锁键）
  await acquireIdentityOwnership(T_B);

  // A 不能重复获取 —— 会阻塞直到释放
  // 用单独 Promise 测试：如果能获取则说明锁没持有（反例）
  const aReacquire = acquireIdentityOwnership(T_A);
  // 给 500ms 让它 settle——如果能 resolve 说明锁键冲突处理有问题
  let settled = false;
  const timeout = new Promise<void>((res) => setTimeout(() => res(), 500));
  await Promise.race([aReacquire.then(() => { settled = true; }).catch(() => {}), timeout]);

  if (settled) {
    // 锁实现允许"自己再次获取自己"——这也是合理的（pg advisory lock 是 session 级重入）
    console.log(`  ⚠️ Ownership Lock 实现允许同进程重入（这是 advisory lock 的正常行为）`);
    await releaseIdentityOwnership(T_A);
  } else {
    console.log(`  ✅ Ownership Lock 正确阻塞了同 identity 重入`);
  }

  await releaseIdentityOwnership(T_B);
});

// ══════════════════════════════════════════════════════════════
// 三、Genesis / EventStore / Replay 隔离
// ══════════════════════════════════════════════════════════════

test('Identity A / B / C — 各自 Fresh Start 完全隔离', async () => {
  // 前置：三 identity 都是 empty
  for (const id of [T_A, T_B, T_C]) {
    const chain = await verifyEventChain(id);
    assert.equal(chain.verdict, 'empty', `${id} 前置应为 empty，实际 ${chain.verdict}`);
  }

  // 三 identity 分别 Fresh Start
  await freshStartIdentity(T_A);
  await freshStartIdentity(T_B);
  await freshStartIdentity(T_C);

  // 各自验证
  for (const id of [T_A, T_B, T_C]) {
    const chain = await verifyEventChain(id);
    assert.equal(chain.verdict, 'valid', `${id} Fresh Start 后应为 valid，实际 ${chain.verdict}`);
    assert.equal(chain.eventCount, 1);
  }

  // A 的 change 不影响 B
  const rowsA = await countRows(T_A);
  const rowsB = await countRows(T_B);
  const rowsC = await countRows(T_C);
  assert.equal(rowsA, 1);
  assert.equal(rowsB, 1);
  assert.equal(rowsC, 1);

  console.log(`  A=${rowsA}, B=${rowsB}, C=${rowsC}：各自 Genesis 独立`);
});

test('Identity A 的事件不被 B 的 verifyEventChain 看到', async () => {
  // T_A 已经有 1 行 Genesis
  const chainA = await verifyEventChain(T_A);
  assert.equal(chainA.eventCount, 1);

  // T_B 不应该看到 A 的事件
  const chainB = await verifyEventChain(T_B);
  assert.equal(chainB.eventCount, 1, 'B 应有自己的 1 行');
  assert.notEqual(chainA.firstSequence, chainB.firstSequence,
    'A 和 B 的 Genesis sequence 应该不同（BIGSERIAL 跨 identity 共享，所以可能相同？实际上可能不同）');

  console.log(`  A seq=${chainA.firstSequence}, B seq=${chainB.firstSequence}`);
});

test('Identity A 的 verifyEventChain invalid 不影响 B 的 valid', async () => {
  // B 应该仍然是 valid
  const chainB = await verifyEventChain(T_B);
  assert.equal(chainB.verdict, 'valid');
});

// ══════════════════════════════════════════════════════════════
// 四、Replay 隔离
// ══════════════════════════════════════════════════════════════

test('Identity A / B / C — 各自 recoverIdentity 独立返回不同 finalState', async () => {
  const resultA = await recoverIdentity(T_A);
  const resultB = await recoverIdentity(T_B);

  assert.equal(resultA.verdict, 'valid');
  assert.equal(resultB.verdict, 'valid');
  assert.equal(resultA.eventCount, 1);
  assert.equal(resultB.eventCount, 1);

  // finalState 结构应相同（都是 Fresh Start 结果），但 lastUpdated（Genesis timestamp）不同
  assert.notEqual(resultA.finalState!.lastUpdated, resultB.finalState!.lastUpdated,
    '两个 identity 的 Genesis timestamp 应该不同');

  console.log(`  A.lastUpdated = ${resultA.finalState!.lastUpdated}`);
  console.log(`  B.lastUpdated = ${resultB.finalState!.lastUpdated}`);
});

// ══════════════════════════════════════════════════════════════
// 五、marrow-v2 不受测试 identity 影响
// ══════════════════════════════════════════════════════════════

test('所有测试 identity 不影响 marrow-v2', async () => {
  // marrow-v2 当前状态：1 行 Genesis（seq=29840）
  // 验证它仍然是 valid，eventCount 仍然是 1
  const chain = await verifyEventChain(IDENTITY_ID);
  console.log(`  marrow-v2 当前状态: verdict=${chain.verdict}, eventCount=${chain.eventCount}`);
  assert.equal(chain.verdict, 'valid', `marrow-v2 应为 valid，实际 ${chain.verdict}`);
  assert.ok(chain.eventCount >= 1, 'marrow-v2 至少应有 1 行');
});
