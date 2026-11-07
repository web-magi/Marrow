/**
 * dashboard-api.pg.test.ts — Dashboard 事件查询 PostgreSQL 集成测试
 *
 * 使用真实 PostgreSQL（不可用则跳过），覆盖：
 * - sequence 游标分页（beforeSequence/afterSequence，字符串传递，无精度丢失）
 * - limit/offset 兼容分页
 * - event_type / since / until 过滤
 * - identity 隔离
 * - Dialogue 原始文本经 sanitize 后不泄露
 * - 空事件列表
 * - 数据库查询错误向上抛出（不静默降级）
 *
 * 测试 identity 与正式 identity 完全隔离，结束后清理测试数据。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, IDENTITY_ID, queryEventRows, countEvents } from '../storage.js';
import { buildEventsApiResponse } from '../dashboard-api.js';
import { getDb, closeDb } from '../db/connection.js';
import type { DialogueEvent, TickEvent } from '../events.js';

const TEST_IDENTITY = 'marrow-test-dash-api';
const OTHER_IDENTITY = 'marrow-test-dash-api-other';
const RUN_TAG = `dash-${Date.now()}`;

/** 用户原始文本标记：用于验证响应中绝不出现 */
const SECRET_TEXT = `SECRET_USER_UTTERANCE_${RUN_TAG}`;

function tickEvent(id: string, timestamp: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id, timestamp, payload: { deltaSeconds } };
}

function dialogueEvent(id: string, timestamp: string): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp,
    payload: {
      direction: 'user_input',
      text: `${SECRET_TEXT}-${id}`,
      action: 'statement',
      intensity: 0.5,
      moodDelta: 1,
      salience: 0.6,
    },
  };
}

// ---- 数据库可用性探测 ----
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

before(async () => {
  if (!dbReady) return;
  const sql = getDb();
  await sql`DELETE FROM events WHERE identity_id = ${TEST_IDENTITY}`;
  await sql`DELETE FROM events WHERE identity_id = ${OTHER_IDENTITY}`;

  // 10 条 tick + 2 条 dialogue，时间戳错开便于 since/until 过滤
  for (let i = 0; i < 10; i++) {
    await appendEvent(
      tickEvent(`${RUN_TAG}-tick-${i}`, new Date(Date.parse('2026-02-01T00:00:00.000Z') + i * 10_000).toISOString()),
      { identityId: TEST_IDENTITY },
    );
  }
  await appendEvent(
    dialogueEvent(`${RUN_TAG}-dlg-a`, '2026-02-01T00:02:00.000Z'),
    { identityId: TEST_IDENTITY },
  );
  await appendEvent(
    dialogueEvent(`${RUN_TAG}-dlg-b`, '2026-02-01T00:03:00.000Z'),
    { identityId: TEST_IDENTITY },
  );

  // 另一个 identity 的数据，用于隔离验证
  await appendEvent(
    tickEvent(`${RUN_TAG}-other-0`, '2026-02-01T00:00:00.000Z'),
    { identityId: OTHER_IDENTITY },
  );
});

after(async () => {
  if (dbReady) {
    const sql = getDb();
    await sql`DELETE FROM events WHERE identity_id = ${TEST_IDENTITY}`;
    await sql`DELETE FROM events WHERE identity_id = ${OTHER_IDENTITY}`;
  }
  await closeDb();
});

// ==================================================================
// 分页与过滤
// ==================================================================

test('游标分页：beforeSequence 翻页无重叠无遗漏', { skip }, async () => {
  const page1 = await queryEventRows(TEST_IDENTITY, { limit: 5 });
  assert.equal(page1.length, 5);
  // DESC 序：页内 sequence 递减
  const seqs1 = page1.map((r) => BigInt(r.sequence));
  for (let i = 1; i < seqs1.length; i++) {
    assert.ok(seqs1[i]! < seqs1[i - 1]!, '必须按 sequence DESC 排列');
  }

  const cursor = page1[page1.length - 1]!.sequence;
  const page2 = await queryEventRows(TEST_IDENTITY, { limit: 5, beforeSequence: cursor });
  assert.equal(page2.length, 5);
  for (const row of page2) {
    assert.ok(BigInt(row.sequence) < BigInt(cursor), '第二页必须全部早于游标');
  }
  const ids1 = new Set(page1.map((r) => r.event_id));
  for (const row of page2) {
    assert.ok(!ids1.has(row.event_id), '两页之间不得重叠');
  }

  // 两页合计应覆盖全部 12 条中的前 10 条
  const page3 = await queryEventRows(TEST_IDENTITY, {
    limit: 5,
    beforeSequence: page2[page2.length - 1]!.sequence,
  });
  assert.equal(page3.length, 2, '最后一页为剩余 2 条');
  const total = await countEvents(TEST_IDENTITY);
  assert.equal(page1.length + page2.length + page3.length, total);
});

test('游标分页：afterSequence 只返回比游标更新的事件', { skip }, async () => {
  const all = await queryEventRows(TEST_IDENTITY, { limit: 200 });
  assert.equal(all.length, 12);
  const mid = all[5]!; // DESC 第 6 条
  const newer = await queryEventRows(TEST_IDENTITY, { afterSequence: mid.sequence, limit: 200 });
  assert.equal(newer.length, 5, '游标之后（更新）的事件共 5 条');
  for (const row of newer) {
    assert.ok(BigInt(row.sequence) > BigInt(mid.sequence));
  }
});

test('游标分页：超出 JS 安全整数的 sequence 字符串不丢失精度、不报错', { skip }, async () => {
  // 2^53 + 1：超出 JS Number 安全整数范围，但仍在 BIGINT 范围内。
  // 若以 Number 传递会被精度截断为 9007199254740992；字符串原样传递则无误差。
  const huge = '9007199254740993';
  const rows = await queryEventRows(TEST_IDENTITY, { beforeSequence: huge, limit: 5 });
  assert.equal(rows.length, 5, '所有行 sequence 都小于该大数');
  const newer = await queryEventRows(TEST_IDENTITY, { afterSequence: huge });
  assert.equal(newer.length, 0);
});

test('offset 兼容分页仍然可用', { skip }, async () => {
  const page = await queryEventRows(TEST_IDENTITY, { limit: 5, offset: 10 });
  assert.equal(page.length, 2);
});

test('过滤：type 单值与多值', { skip }, async () => {
  const dialogues = await queryEventRows(TEST_IDENTITY, { type: 'dialogue', limit: 200 });
  assert.equal(dialogues.length, 2);
  assert.ok(dialogues.every((r) => r.event_type === 'dialogue'));

  const both = await queryEventRows(TEST_IDENTITY, { type: ['tick', 'dialogue'], limit: 200 });
  assert.equal(both.length, 12);

  const none = await queryEventRows(TEST_IDENTITY, { type: 'sleep', limit: 200 });
  assert.equal(none.length, 0);
});

test('过滤：since/until 时间范围', { skip }, async () => {
  const rows = await queryEventRows(TEST_IDENTITY, {
    since: '2026-02-01T00:01:30.000Z',
    until: '2026-02-01T00:02:30.000Z',
    limit: 200,
  });
  // 范围内：tick-9 (00:01:30) + dlg-a (00:02:00)
  assert.equal(rows.length, 2);
});

test('identity 隔离：查询不会跨身份泄露', { skip }, async () => {
  const mine = await queryEventRows(TEST_IDENTITY, { limit: 200 });
  assert.ok(mine.every((r) => r.identity_id === TEST_IDENTITY));

  const other = await queryEventRows(OTHER_IDENTITY, { limit: 200 });
  assert.equal(other.length, 1);
  assert.ok(other.every((r) => r.identity_id === OTHER_IDENTITY));

  // 正式 identity 的查询不受测试数据影响
  const primaryCount = await countEvents(IDENTITY_ID);
  const primaryRows = await queryEventRows(IDENTITY_ID, { limit: 200 });
  assert.ok(primaryRows.length <= primaryCount);
  assert.ok(primaryRows.every((r) => r.identity_id === IDENTITY_ID));
});

test('空事件列表：无匹配条件时返回空数组', { skip }, async () => {
  const rows = await queryEventRows(TEST_IDENTITY, { type: 'genesis' });
  assert.equal(rows.length, 0);
  const res = buildEventsApiResponse(rows, 50);
  assert.equal(res.page.count, 0);
  assert.equal(res.page.nextBeforeSequence, null);
});

// ==================================================================
// 敏感内容隔离
// ==================================================================

test('Dialogue 原始文本经 sanitize 后绝不泄露', { skip }, async () => {
  const rows = await queryEventRows(TEST_IDENTITY, { type: 'dialogue', limit: 200 });
  assert.equal(rows.length, 2);
  // 数据库行本身确实包含原文（证明测试有效）
  assert.ok(JSON.stringify(rows).includes(SECRET_TEXT));

  const response = buildEventsApiResponse(rows, 50);
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes(SECRET_TEXT), 'API 响应不得包含用户原始对话文本');
  for (const dto of response.events) {
    assert.equal(dto.summary['text'], undefined);
  }
});

// ==================================================================
// 错误路径
// ==================================================================

test('数据库查询错误向上抛出，不静默降级', { skip }, async () => {
  // 非法游标在调用方校验层抛出（不进入 SQL）
  await assert.rejects(
    queryEventRows(TEST_IDENTITY, { beforeSequence: '12a3' }),
    TypeError,
  );
  // 无法解析的时间戳由 PostgreSQL 报错并向上传播
  await assert.rejects(
    queryEventRows(TEST_IDENTITY, { since: 'not-a-date-at-all' }),
  );
});
