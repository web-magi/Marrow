/**
 * shutdown.pg.test.ts — Shutdown 与数据库连接池竞态集成测试（M1.2.2-C3.1）
 *
 * 使用真实 PostgreSQL 验证 C3 审查发现的核心竞态：
 * - 真实写库事务执行过程中触发 shutdown（graceMs 极短，必然超时）
 * - shutdown 返回 drained=false 时，连接池必须仍然可用
 *   （shutdown 自身绝不触碰连接池，禁止超时后静默关闭数据库）
 * - waitForIdle() 等待 running 任务真正结束：
 *   - 任务成功：事件真实入库后返回 'completed'，之后才允许 closeDb
 *   - 任务失败：事务回滚无残留，返回 'failed'，之后仍允许安全 closeDb
 *
 * 数据库不可用时全部用例跳过。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, generateEventId } from '../storage.js';
import { closeDb, getDb } from '../db/connection.js';
import { getRuntimeSession } from '../runtime-session.js';
import type { DialogueEvent } from '../events.js';

/** 本阶段测试 identity 统一前缀（便于一次性清理） */
const TEST_PREFIX = 'marrow-test-c31';
const ID_OK = `${TEST_PREFIX}-shutdown-ok`;
const ID_FAIL = `${TEST_PREFIX}-shutdown-fail`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatEvent(id: string, timestamp: string): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp,
    payload: {
      direction: 'user_input',
      text: 'shutdown-during-transaction',
      moodDelta: 0,
      salience: 0.3,
      wordCount: 1,
    },
  };
}

async function countRows(identityId: string): Promise<number> {
  const sql = getDb();
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM events WHERE identity_id = ${identityId}
  `;
  return Number(count);
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
  // 全部用例的真实任务都已结束后才允许关闭连接池（与 index.ts 关闭流程一致）
  await closeDb();
});

test('真实事务执行中触发 shutdown：drained=false 时连接池保持可用，任务完成后才允许关闭', { skip }, async () => {
  const session = getRuntimeSession(ID_OK);
  const eventId = `${ID_OK}-${generateEventId()}`;

  const admission = session.reserveChat();
  session.markReady(admission, async () => {
    // 人为拉长执行窗口，确保 shutdown 的 30ms 宽限期必然先到期
    await sleep(200);
    // 真实 PostgreSQL 写入（独立事务）
    await appendEvent(chatEvent(eventId, new Date().toISOString()), {
      identityId: ID_OK,
    });
    return { reply: 'ok', filtered: false, filterReason: null };
  });

  await sleep(20);
  assert.equal(session.snapshot().running, 1, '任务必须处于执行中');

  // 事务执行过程中触发 shutdown，宽限期必然超时
  const result = await session.shutdown({ graceMs: 30 });
  assert.equal(result.drained, false, '任务未完成时不得报告 drained=true');
  assert.equal(result.running, 1);
  assert.equal(result.timedOut, true, '必须显式报告宽限期超时');

  // 关键断言：shutdown 超时返回后连接池未被关闭，仍可正常查询
  const sql = getDb();
  const [{ one }] = await sql<[{ one: number }]>`SELECT 1 AS one`;
  assert.equal(one, 1, 'shutdown 绝不因宽限期结束而关闭数据库连接池');

  // 等待 running 任务真正结束：成功结局必须被记录
  const outcome = await session.waitForIdle();
  assert.equal(outcome, 'completed');
  await admission.completion;

  // 任务的事务真实提交：事件在 shutdown 返回之后入库
  assert.equal(await countRows(ID_OK), 1, '执行中事务必须完成并真实提交');

  // 只有此刻（drained）之后 closeDb 才被允许——由 after() 统一执行
});

test('真实事务最终失败：waitForIdle 报告 failed，事务回滚无残留，仍允许安全关闭', { skip }, async () => {
  const session = getRuntimeSession(ID_FAIL);
  const eventId = `${ID_FAIL}-${generateEventId()}`;

  const admission = session.reserveChat();
  session.markReady(admission, async () => {
    await sleep(200);
    // 非法 timestamp 让真实 INSERT 失败 → 事务回滚
    await appendEvent(chatEvent(eventId, 'not-a-timestamp'), {
      identityId: ID_FAIL,
    });
    return { reply: 'unreachable', filtered: false, filterReason: null };
  });

  await sleep(20);
  assert.equal(session.snapshot().running, 1);

  const result = await session.shutdown({ graceMs: 30 });
  assert.equal(result.drained, false);
  assert.equal(result.timedOut, true);

  // 连接池仍然可用
  const sql = getDb();
  await sql`SELECT 1`;

  // 任务最终失败：completion 拒绝，waitForIdle 报告 failed
  const completionRejection = assert.rejects(admission.completion);
  const outcome = await session.waitForIdle();
  assert.equal(outcome, 'failed', '任务最终失败必须被体现');
  await completionRejection;

  // 失败事务完整回滚：无任何残留事件
  assert.equal(await countRows(ID_FAIL), 0, '失败事务不得留下部分提交');

  // 失败后执行器已空闲：允许安全 closeDb（after() 统一执行）
  assert.equal(session.snapshot().running, 0);
});
