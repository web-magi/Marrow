/**
 * experience-valence.pg.test.ts — M1.5.4.1 体验性质持久化（PostgreSQL 集成）
 *
 * 覆盖：
 *   V10 新事件经真实 EventStore 写入后可 Replay，字段原样保留
 *   V11 同一事件链多次恢复结果一致
 *   V12 新增字段不改变 Chat 原子批次语义（单事务、连续 sequence、失败整批回滚）
 *
 * 数据库不可用时整体跳过。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendEvents, loadEvents, type PersistedEventRow } from '../storage.js';
import { getDb, closeDb } from '../db/connection.js';
import {
  freshStartIdentity,
  recoverIdentity,
} from '../recovery.js';
import type {
  AppraisalEvent,
  DialogueEvent,
  ObservationEvent,
  TickEvent,
} from '../events.js';

const TEST_PREFIX = 'marrow-test-1541';
const ID = `${TEST_PREFIX}-v12`;
const RUN_TAG = `m1541-${Date.now()}`;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function observation(
  id: string,
  timestamp: string,
  experienceValence: number | undefined,
  experienceValenceStatus: string | undefined,
): ObservationEvent {
  const payload: ObservationEvent['payload'] = {
    source: 'user_text',
    content: '今天被领导当众批评了，感觉自己很没用',
    action: 'confession',
    intensity: 0.8,
    confidence: 0.85,
    uncertainty: 0.15,
    facts: [{ claim: '用户被当众批评', confidence: 0.9 }],
    extractorVersion: 'extractor-1.4',
    // 测试直接构造事件，此处通过类型断言模拟"新生产格式"
    experienceValenceStatus: experienceValenceStatus as ObservationEvent['payload']['experienceValenceStatus'],
  };
  if (experienceValence !== undefined) {
    payload.experienceValence = experienceValence;
  }
  return { type: 'observation', id, timestamp, payload };
}

function appraisal(
  id: string,
  timestamp: string,
  sourceObservationId: string,
): AppraisalEvent {
  return {
    type: 'appraisal',
    id,
    timestamp,
    payload: {
      sourceObservationId,
      valenceDelta: -4.2,
      arousalDelta: 6.5,
      energyDelta: 0,
      confidence: 0.85,
      evidenceAssociationIds: [],
    },
  };
}

function userDialogue(
  id: string,
  timestamp: string,
  observationId: string,
  appraisalId: string,
): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp,
    payload: {
      direction: 'user_input',
      text: '今天被领导当众批评了，感觉自己很没用',
      action: 'confession',
      intensity: 0.8,
      moodDelta: -4.2,
      salience: 0.3,
      wordCount: 20,
      observationId,
      appraisalId,
    },
  };
}

function companionDialogue(id: string, timestamp: string): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp,
    payload: {
      direction: 'companion_output',
      text: '被当众批评一定很难受，你不用马上证明自己。',
      moodDelta: 0,
      salience: 0.3,
      wordCount: 23,
      candidateText: '被当众批评一定很难受，你不用马上证明自己。',
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

test('V12 Chat 五事件批次：新增字段不改变单事务原子性', { skip }, async () => {
  await freshStartIdentity(ID);
  const before = await countRows(ID);

  const t0 = iso(1000);
  const obs = observation(`${RUN_TAG}-obs`, t0, -0.8, 'observed');
  const app = appraisal(`${RUN_TAG}-app`, t0, obs.id);
  const user = userDialogue(`${RUN_TAG}-user`, t0, obs.id, app.id);
  const companion = companionDialogue(`${RUN_TAG}-companion`, t0);

  // 与 Chat 生产批次同构：Observation → Appraisal → Dialogue(user) → Dialogue(companion)
  await appendEvents([obs, app, user, companion], { identityId: ID });

  const rows = await fetchRows(ID);
  assert.equal(rows.length, before + 4);

  // 一次 appendEvents = 一段连续 sequence，且事件顺序与入参一致
  const batchRows = rows.slice(before);
  assert.deepEqual(
    batchRows.map((r) => r.event_type),
    ['observation', 'appraisal', 'dialogue', 'dialogue'],
  );
  const sequences = batchRows.map((r) => Number(r.sequence));
  for (let i = 1; i < sequences.length; i += 1) {
    assert.equal(sequences[i], (sequences[i - 1] as number) + 1);
  }

  // 新字段原样冻结进 JSONB payload
  const persisted = batchRows[0]?.payload as ObservationEvent;
  assert.equal(persisted.payload.experienceValence, -0.8);
  assert.equal(persisted.payload.experienceValenceStatus, 'observed');
  assert.equal(persisted.payload.extractorVersion, 'extractor-1.4');
});

test('V12 失败批次整批回滚：不留半条互动链', { skip }, async () => {
  const before = await countRows(ID);
  const rows = await fetchRows(ID);
  const existingId = rows[0]?.event_id as string;

  const t0 = iso(2000);
  const obs = observation(`${RUN_TAG}-obs-rollback`, t0, 0.5, 'observed');
  const app = appraisal(`${RUN_TAG}-app-rollback`, t0, obs.id);
  // 第三条复用已存在的事件 ID 但内容不同 → 哈希链/幂等冲突，整批必须回滚
  const conflicting: TickEvent = {
    type: 'tick',
    id: existingId,
    timestamp: t0,
    payload: { deltaSeconds: 999 },
  };

  await assert.rejects(
    appendEvents([obs, app, conflicting], { identityId: ID }),
  );

  assert.equal(await countRows(ID), before, '失败批次不得留下任何事件');
  const after = await fetchRows(ID);
  assert.ok(
    !after.some((r) => r.event_id === `${RUN_TAG}-obs-rollback`),
    '回滚后不得存在该批次的第一条事件',
  );
});

test('V9/V10 Legacy 与新事件混合链可恢复，字段可读', { skip }, async () => {
  const t0 = iso(3000);
  const legacyId = `${RUN_TAG}-legacy-obs`;
  const legacy: ObservationEvent = {
    type: 'observation',
    id: legacyId,
    timestamp: t0,
    payload: {
      source: 'user_text',
      content: '今天没什么特别的',
      action: 'statement',
      intensity: 0.4,
      confidence: 0.8,
      uncertainty: 0.2,
      facts: [],
      extractorVersion: 'extractor-1.3',
    },
  };
  const unknown = observation(`${RUN_TAG}-unknown-obs`, t0, undefined, 'unknown');
  await appendEvents([legacy, unknown], { identityId: ID });

  const result = await recoverIdentity(ID);
  assert.equal(result.verdict, 'valid');
  assert.equal(result.errors.length, 0);

  const rows = await fetchRows(ID);
  const legacyRow = rows.find((r) => r.event_id === legacyId)?.payload as ObservationEvent;
  const unknownRow = rows.find((r) => r.event_id === unknown.id)?.payload as ObservationEvent;
  assert.ok(!('experienceValence' in legacyRow.payload));
  assert.ok(!('experienceValenceStatus' in legacyRow.payload));
  assert.ok(!('experienceValence' in unknownRow.payload));
  assert.equal(unknownRow.payload.experienceValenceStatus, 'unknown');
});

test('V11 Replay 确定性：同一事件链恢复两次结果一致', { skip }, async () => {
  const first = await recoverIdentity(ID);
  const second = await recoverIdentity(ID);
  assert.equal(first.verdict, 'valid');
  assert.equal(second.verdict, 'valid');
  assert.deepEqual(first.finalState, second.finalState);
  assert.equal(first.eventCount, second.eventCount);
});

test('V9 历史兼容：loadEvents 不因缺失新字段丢事件', { skip }, async () => {
  const events = await loadEvents(ID);
  assert.ok(events.length > 0);
  const legacy = events.find((e) => e.type === 'observation' && !('experienceValenceStatus' in e.payload));
  assert.ok(legacy, '旧 observation 事件必须仍然存在且可加载');
});
