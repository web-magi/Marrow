/**
 * explicit-reply-correlation.pg.test.ts — M1.5.4.2 显式回复关联（PostgreSQL 集成）
 *
 * 覆盖：
 *   R2  user_input 与 companion_output 在同一原子批次中写入（真实构造路径）
 *   R16 新增字段写入后哈希链验证仍然有效
 *   R17 批次失败时整批回滚，不会留下带关联的 companion_output
 *   R4  历史无字段事件与新事件混合链仍可恢复
 *
 * 数据库不可用时整体跳过。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendEvents, type PersistedEventRow } from '../storage.js';
import { getDb, closeDb } from '../db/connection.js';
import { freshStartIdentity, recoverIdentity } from '../recovery.js';
import { verifyEventChain } from '../verify-chain.js';
import { buildCompanionOutputEvent } from '../dialogue.js';
import type { DialogueEvent, ObservationEvent } from '../events.js';

const TEST_PREFIX = 'marrow-test-1542';
const ID = `${TEST_PREFIX}-pg`;
const RUN_TAG = `m1542-${Date.now()}`;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function observation(id: string, timestamp: string): ObservationEvent {
  return {
    type: 'observation',
    id,
    timestamp,
    payload: {
      source: 'user_text',
      content: '今天有点累',
      action: 'statement',
      intensity: 0.4,
      confidence: 0.9,
      uncertainty: 0.1,
      facts: [],
      extractorVersion: 'extractor-1.4',
      experienceValenceStatus: 'unknown',
    },
  };
}

function userDialogue(id: string, timestamp: string): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp,
    payload: {
      direction: 'user_input',
      text: '今天有点累',
      action: 'statement',
      intensity: 0.4,
      moodDelta: -1,
      salience: 0.3,
      wordCount: 5,
    },
  };
}

function legacyCompanion(id: string, timestamp: string): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp,
    payload: {
      direction: 'companion_output',
      text: '那就先休息一下吧。',
      moodDelta: 0,
      salience: 0.3,
      wordCount: 10,
      candidateText: '那就先休息一下吧。',
      filtered: false,
    },
  };
}

async function fetchRows(identityId: string): Promise<PersistedEventRow[]> {
  const sql = getDb();
  return await sql<PersistedEventRow[]>`
    SELECT
      sequence::text AS sequence, event_id, identity_id, "timestamp", event_type,
      schema_version, engine_version, causation_id, correlation_id,
      previous_event_hash, event_hash, payload
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

test('R2 原子批次：user_input 与 companion_output 同事务写入并保留显式关联', { skip }, async () => {
  await freshStartIdentity(ID);
  const before = await countRows(ID);

  const t0 = iso(1000);
  const obs = observation(`${RUN_TAG}-obs`, t0);
  const user = userDialogue(`${RUN_TAG}-user`, t0);
  // 真实生产构造路径：replyToEventId 直接使用 user 事件 ID
  const companion = buildCompanionOutputEvent({
    id: `${RUN_TAG}-companion`,
    timestamp: t0,
    filterResult: { text: '那就先休息一下吧。', filtered: false, filterReason: '' },
    candidateText: '那就先休息一下吧。',
    replyToEventId: user.id,
  });

  await appendEvents([obs, user, companion], { identityId: ID });

  const rows = await fetchRows(ID);
  assert.equal(rows.length, before + 3);
  const batchRows = rows.slice(before);
  assert.deepEqual(
    batchRows.map((r) => r.event_type),
    ['observation', 'dialogue', 'dialogue'],
  );

  const sequences = batchRows.map((r) => Number(r.sequence));
  for (let i = 1; i < sequences.length; i += 1) {
    assert.equal(sequences[i], (sequences[i - 1] as number) + 1);
  }

  const persistedCompanion = batchRows[2]?.payload as DialogueEvent;
  const persistedUser = batchRows[1]?.payload as DialogueEvent;
  assert.equal(persistedCompanion.payload.replyToEventId, persistedUser.id);
  assert.ok(!('replyToEventId' in persistedUser.payload));
});

test('R16 哈希链：新增字段随 payload 进入哈希，链验证仍有效', { skip }, async () => {
  const report = await verifyEventChain(ID);
  assert.equal(report.verdict, 'valid');
  assert.equal(report.errors.length, 0);

  const first = await recoverIdentity(ID);
  const second = await recoverIdentity(ID);
  assert.equal(first.verdict, 'valid');
  assert.equal(second.verdict, 'valid');
  assert.deepEqual(first.finalState, second.finalState);
});

test('R4 历史兼容：无字段的旧 companion_output 与新事件混合链可恢复', { skip }, async () => {
  const t0 = iso(2000);
  const legacy = legacyCompanion(`${RUN_TAG}-legacy-companion`, t0);
  await appendEvents([legacy], { identityId: ID });

  const result = await recoverIdentity(ID);
  assert.equal(result.verdict, 'valid');
  assert.equal(result.errors.length, 0);

  const rows = await fetchRows(ID);
  const legacyRow = rows.find((r) => r.event_id === legacy.id)?.payload as DialogueEvent;
  assert.ok(!('replyToEventId' in legacyRow.payload));
});

test('R17 批次失败整批回滚：不留带关联的 companion_output', { skip }, async () => {
  const before = await countRows(ID);
  const rows = await fetchRows(ID);
  const existingId = rows[0]?.event_id as string;

  const t0 = iso(3000);
  const user = userDialogue(`${RUN_TAG}-rollback-user`, t0);
  const companion = buildCompanionOutputEvent({
    id: `${RUN_TAG}-rollback-companion`,
    timestamp: t0,
    filterResult: { text: '回复', filtered: false, filterReason: '' },
    candidateText: '回复',
    replyToEventId: user.id,
  });
  // 第三条复用已存在事件 ID 但内容不同 → 事务冲突，整批必须回滚
  const conflicting: DialogueEvent = {
    type: 'dialogue',
    id: existingId,
    timestamp: t0,
    payload: {
      direction: 'user_input',
      text: 'conflict',
      moodDelta: 0,
      salience: 0.3,
      wordCount: 8,
    },
  };

  await assert.rejects(appendEvents([user, companion, conflicting], { identityId: ID }));

  assert.equal(await countRows(ID), before, '失败批次不得留下任何事件');
  const after = await fetchRows(ID);
  assert.ok(
    !after.some((r) => r.event_id === `${RUN_TAG}-rollback-companion`),
    '回滚后不得存在带关联的 companion_output',
  );
});
