/**
 * dashboard-api.test.ts — Dashboard API 契约纯函数测试（无需数据库）
 *
 * 覆盖：
 * - sanitizeEventRow 字段白名单：Dialogue 原文 / Observation 原文与 facts /
 *   MemoryFormation 摘要与关键词一律不下发；未知事件类型 fail-closed
 * - buildEventsApiResponse 分页信封（nextBeforeSequence 游标）
 * - parseEventsQueryParams 非法参数拒绝（400 前置，绝不带进 SQL）
 * - buildRuntimeApiResponse 在 RuntimeSession 关闭时的行为
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEventsApiResponse,
  buildRuntimeApiResponse,
  parseEventsQueryParams,
  sanitizeEventRow,
} from '../dashboard-api.js';
import type { PersistedEventRow } from '../storage.js';
import type { DialogueEvent, MarrowEvent, ObservationEvent, TickEvent } from '../events.js';

/** 构造一条持久化事件行夹具 */
function makeRow(event: MarrowEvent, sequence: string): PersistedEventRow {
  return {
    sequence,
    event_id: event.id,
    identity_id: 'marrow-test-dash',
    timestamp: event.timestamp,
    event_type: event.type,
    schema_version: 2,
    engine_version: 'marrow@test',
    causation_id: null,
    correlation_id: null,
    previous_event_hash: 'a'.repeat(64),
    event_hash: 'b'.repeat(64),
    payload: event,
  };
}

// ==================================================================
// sanitizeEventRow：字段白名单
// ==================================================================

test('sanitize: DialogueEvent 绝不下发 text / candidateText', () => {
  const event: DialogueEvent = {
    type: 'dialogue',
    id: 'dlg-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      direction: 'user_input',
      text: 'SECRET_USER_TEXT_原始对话内容',
      action: 'statement',
      intensity: 0.7,
      moodDelta: 1.5,
      salience: 0.6,
      wordCount: 12,
      candidateText: 'SECRET_CANDIDATE_TEXT',
      filtered: false,
      observationId: 'obs-1',
      appraisalId: 'app-1',
    },
  };
  const dto = sanitizeEventRow(makeRow(event, '42'));

  // 元数据完整
  assert.equal(dto.sequence, '42');
  assert.equal(dto.eventId, 'dlg-1');
  assert.equal(dto.eventType, 'dialogue');
  assert.equal(dto.eventHash, 'b'.repeat(64));

  // 白名单字段保留
  assert.equal(dto.summary['direction'], 'user_input');
  assert.equal(dto.summary['moodDelta'], 1.5);
  assert.equal(dto.summary['observationId'], 'obs-1');

  // 原始文本绝不下发（含 JSON 序列化后的整体检查）
  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('SECRET_USER_TEXT'), '不得包含用户原始文本');
  assert.ok(!serialized.includes('SECRET_CANDIDATE_TEXT'), '不得包含候选文本');
  assert.equal(dto.summary['text'], undefined);
  assert.equal(dto.summary['candidateText'], undefined);
});

test('sanitize: ObservationEvent 绝不下发 content / facts 文本，仅返回 factsCount', () => {
  const event: ObservationEvent = {
    type: 'observation',
    id: 'obs-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      source: 'user_text',
      content: 'SECRET_OBSERVATION_CONTENT',
      action: 'statement',
      intensity: 0.5,
      confidence: 0.9,
      uncertainty: 0.1,
      facts: [
        { claim: 'SECRET_CLAIM_1', confidence: 0.8 },
        { claim: 'SECRET_CLAIM_2', confidence: 0.7, evidence: 'SECRET_EVIDENCE' },
      ],
      extractorVersion: 'test-extractor',
    },
  };
  const dto = sanitizeEventRow(makeRow(event, '43'));

  assert.equal(dto.summary['source'], 'user_text');
  assert.equal(dto.summary['confidence'], 0.9);
  assert.equal(dto.summary['factsCount'], 2, 'facts 只返回条数');

  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('SECRET_OBSERVATION_CONTENT'));
  assert.ok(!serialized.includes('SECRET_CLAIM_1'));
  assert.ok(!serialized.includes('SECRET_EVIDENCE'));
});

test('sanitize: MemoryFormationEvent 不下发 memory.summary / keywords', () => {
  const event: MarrowEvent = {
    type: 'memory_formation',
    id: 'mem-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      sourceDialogueEventId: 'dlg-1',
      memory: {
        id: 'ep-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        summary: 'SECRET_MEMORY_SUMMARY',
        keywords: ['SECRET_KEYWORD'],
        valence: 0.8,
        salience: 0.9,
        sourceEventId: 'dlg-1',
        isTrauma: false,
      },
    },
  };
  const dto = sanitizeEventRow(makeRow(event, '44'));

  const memory = dto.summary['memory'] as Record<string, unknown>;
  assert.equal(memory['id'], 'ep-1');
  assert.equal(memory['valence'], 0.8);
  assert.equal(memory['isTrauma'], false);

  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('SECRET_MEMORY_SUMMARY'));
  assert.ok(!serialized.includes('SECRET_KEYWORD'));
});

test('sanitize: TickEvent 只暴露 deltaSeconds', () => {
  const event: TickEvent = {
    type: 'tick',
    id: 'tick-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { deltaSeconds: 10 },
  };
  const dto = sanitizeEventRow(makeRow(event, '45'));
  assert.deepEqual(dto.summary, { deltaSeconds: 10 });
});

test('sanitize: 未知事件类型 fail-closed，仅返回元数据', () => {
  const weird = {
    type: 'totally_unknown_type',
    id: 'x-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { secret: 'SECRET_UNKNOWN_PAYLOAD', anything: 1 },
  } as unknown as MarrowEvent;
  const dto = sanitizeEventRow(makeRow(weird, '46'));

  assert.deepEqual(dto.summary, {}, '未知类型摘要必须为空');
  assert.equal(dto.eventType, 'totally_unknown_type');
  assert.ok(!JSON.stringify(dto).includes('SECRET_UNKNOWN_PAYLOAD'));
});

test('sanitize: undefined 的 optional 字段不下发', () => {
  const event: DialogueEvent = {
    type: 'dialogue',
    id: 'dlg-2',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      direction: 'companion_output',
      text: 'x',
      moodDelta: 0,
      salience: 0.3,
      // action / intensity / filtered 等 optional 字段缺失
    },
  };
  const dto = sanitizeEventRow(makeRow(event, '47'));
  assert.ok(!('action' in dto.summary), 'undefined 字段不得出现在摘要中');
  assert.ok(!('filtered' in dto.summary));
});

// ==================================================================
// buildEventsApiResponse：分页信封
// ==================================================================

test('buildEventsApiResponse: 满页时给出 nextBeforeSequence 游标，否则为 null', () => {
  const rows = [
    makeRow({ type: 'tick', id: 't1', timestamp: '2026-01-01T00:00:00.000Z', payload: { deltaSeconds: 10 } }, '30'),
    makeRow({ type: 'tick', id: 't2', timestamp: '2026-01-01T00:00:10.000Z', payload: { deltaSeconds: 10 } }, '29'),
  ];

  const full = buildEventsApiResponse(rows, 2);
  assert.equal(full.page.nextBeforeSequence, '29', '满页时游标指向本页最旧一条');
  assert.equal(full.page.count, 2);

  const partial = buildEventsApiResponse(rows, 50);
  assert.equal(partial.page.nextBeforeSequence, null, '不足一页说明没有更多历史');

  const empty = buildEventsApiResponse([], 50);
  assert.equal(empty.page.count, 0);
  assert.equal(empty.page.nextBeforeSequence, null);
});

// ==================================================================
// parseEventsQueryParams：非法参数前置拒绝
// ==================================================================

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

test('parse: 默认值 limit=50', () => {
  const r = parseEventsQueryParams(params(''));
  assert.ok(r.ok);
  assert.equal(r.options.limit, 50);
});

test('parse: limit 超上限钳制到 200，非数字拒绝', () => {
  const clamped = parseEventsQueryParams(params('limit=9999'));
  assert.ok(clamped.ok);
  assert.equal(clamped.options.limit, 200);

  assert.equal(parseEventsQueryParams(params('limit=abc')).ok, false);
  assert.equal(parseEventsQueryParams(params('limit=-1')).ok, false);
  assert.equal(parseEventsQueryParams(params('limit=0')).ok, false);
  assert.equal(parseEventsQueryParams(params('limit=1.5')).ok, false);
});

test('parse: sequence 游标必须是十进制数字字符串', () => {
  const ok = parseEventsQueryParams(params('beforeSequence=12345678901234567890123'));
  assert.ok(ok.ok);
  assert.equal(ok.options.beforeSequence, '12345678901234567890123', '大数必须原样保留字符串');

  assert.equal(parseEventsQueryParams(params('beforeSequence=12a3')).ok, false);
  assert.equal(parseEventsQueryParams(params('beforeSequence=-5')).ok, false);
  assert.equal(parseEventsQueryParams(params('afterSequence=1.5')).ok, false);
  assert.equal(
    parseEventsQueryParams(params("beforeSequence=1' OR '1'='1")).ok,
    false,
    'SQL 注入形态必须被拒绝',
  );
});

test('parse: beforeSequence 与 afterSequence 互斥', () => {
  const r = parseEventsQueryParams(params('beforeSequence=10&afterSequence=20'));
  assert.equal(r.ok, false);
});

test('parse: type 可多值，空串拒绝', () => {
  const ok = parseEventsQueryParams(params('type=tick&type=dialogue'));
  assert.ok(ok.ok);
  assert.deepEqual(ok.options.type, ['tick', 'dialogue']);

  assert.equal(parseEventsQueryParams(params('type=')).ok, false);
});

test('parse: since/until 必须是可解析日期', () => {
  const ok = parseEventsQueryParams(params('since=2026-01-01T00:00:00.000Z'));
  assert.ok(ok.ok);

  assert.equal(parseEventsQueryParams(params('since=not-a-date')).ok, false);
  assert.equal(parseEventsQueryParams(params('until=2026-13-99')).ok, false);
});

// ==================================================================
// buildRuntimeApiResponse：Runtime 关闭时仍返回明确快照
// ==================================================================

test('buildRuntimeApiResponse: session 关闭时 closed=true 正常返回', () => {
  const closedSnapshot = {
    identityId: 'marrow-test-dash',
    closed: true,
    active: 0,
    reserved: 0,
    ready: 0,
    waiting: 0,
    running: 0,
    runningChatId: null,
    runningTaskKind: null,
    tick: { pending: false, running: false, kind: null, recoveryRequired: false },
  };
  const res = buildRuntimeApiResponse(closedSnapshot, 123, 456);
  assert.equal(res.closed, true);
  assert.equal(res.uptimeSeconds, 123);
  assert.equal(res.eventCount, 456);
  assert.equal(res.queue.active, 0);
});
