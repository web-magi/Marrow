/**
 * interaction-ledger.test.ts — M1.5.1 反馈归因账本测试（L1-L12）
 *
 * 覆盖：
 * - 正常一问一答、连续 user_input、连续 companion_output
 * - 孤立输出 / 孤立输入
 * - 过滤输出、跨会话限制、无记忆形成、记忆来源不匹配
 * - 确定性（100 次重复 + 输入倒序）、输入不可变、非法事件序列
 *
 * 所有用例均为纯内存事件构造，不连接数据库、不调用 LLM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInteractionLedger,
  InteractionLedgerInputError,
  LIMITATION_NO_SESSION,
  type InteractionRecord,
  type LedgerSourceEvent,
} from '../interaction-ledger.js';
import type {
  AppraisalEvent,
  DialogueEvent,
  MarrowEvent,
  MemoryFormationEvent,
  ObservationEvent,
  TickEvent,
} from '../events.js';

const TS = '2026-01-01T00:00:00.000Z';

function at(records: readonly InteractionRecord[], index: number): InteractionRecord {
  const record = records[index];
  assert.ok(record, `缺少第 ${index} 条记录`);
  return record;
}

function row(sequence: number | string, payload: MarrowEvent): LedgerSourceEvent {
  return { sequence, payload };
}

function observation(id: string): ObservationEvent {
  return {
    type: 'observation',
    id,
    timestamp: TS,
    payload: {
      source: 'user_text',
      content: 'user text',
      action: 'statement',
      intensity: 0.6,
      confidence: 0.9,
      uncertainty: 0.1,
      facts: [],
      extractorVersion: 'extractor-test',
    },
  };
}

function appraisal(id: string, sourceObservationId: string): AppraisalEvent {
  return {
    type: 'appraisal',
    id,
    timestamp: TS,
    payload: {
      sourceObservationId,
      valenceDelta: 1,
      arousalDelta: 2,
      energyDelta: 0,
      confidence: 0.9,
      evidenceAssociationIds: [],
    },
  };
}

function user(
  id: string,
  text: string,
  refs?: { observationId?: string; appraisalId?: string },
): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp: TS,
    payload: {
      direction: 'user_input',
      text,
      moodDelta: 1,
      salience: 0.3,
      wordCount: text.length,
      observationId: refs?.observationId,
      appraisalId: refs?.appraisalId,
    },
  };
}

function companion(
  id: string,
  text: string,
  options?: { filtered?: boolean; filterReason?: string },
): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp: TS,
    payload: {
      direction: 'companion_output',
      text,
      moodDelta: 0,
      salience: 0.3,
      wordCount: text.length,
      candidateText: text,
      filtered: options?.filtered,
      filterReason: options?.filterReason,
    },
  };
}

function memory(
  id: string,
  sourceDialogueEventId: string,
  valence: number,
  salience: number,
): MemoryFormationEvent {
  return {
    type: 'memory_formation',
    id,
    timestamp: TS,
    payload: {
      sourceDialogueEventId,
      memory: {
        id: 'mem-1',
        timestamp: TS,
        summary: 'summary',
        keywords: ['k'],
        valence,
        salience,
        sourceEventId: sourceDialogueEventId,
        isTrauma: valence < 0,
      },
    },
  };
}

function tick(id: string): TickEvent {
  return { type: 'tick', id, timestamp: TS, payload: { deltaSeconds: 10 } };
}

// ─────────────────────────────────────────────────────────────────────
// L1：正常一问一答
// ─────────────────────────────────────────────────────────────────────
test('L1 正常一问一答：配对与记忆关联正确', () => {
  const events: LedgerSourceEvent[] = [
    row(1, companion('c1', 'reply-1')),
    row(2, observation('o1')),
    row(3, appraisal('a1', 'o1')),
    row(4, user('u1', 'hello', { observationId: 'o1', appraisalId: 'a1' })),
    row(5, memory('m1', 'u1', 0.6, 0.7)),
    row(6, companion('c2', 'reply-2')),
  ];

  const records = buildInteractionLedger(events);
  assert.equal(records.length, 2);

  const first = at(records, 0);
  assert.equal(first.pairingStatus, 'paired');
  assert.equal(first.pairingConfidence, 'medium');
  assert.equal(first.pairingRule, 'unique_preceding_companion');
  assert.equal(first.companionOutputEventId, 'c1');
  assert.equal(first.companionOutputSequence, '1');
  assert.equal(first.userInputEventId, 'u1');
  assert.equal(first.userInputSequence, '4');
  assert.equal(first.observationEventId, 'o1');
  assert.equal(first.appraisalEventId, 'a1');
  assert.equal(first.memoryFormationEventId, 'm1');
  assert.equal(first.memoryValence, 0.6);
  assert.equal(first.memorySalience, 0.7);

  const second = at(records, 1);
  assert.equal(second.pairingStatus, 'unpaired');
  assert.equal(second.pairingConfidence, 'none');
  assert.equal(second.pairingRule, 'no_following_user_input');
  assert.equal(second.companionOutputEventId, 'c2');
  assert.equal(second.userInputEventId, null);
});

// ─────────────────────────────────────────────────────────────────────
// L2：连续 user_input
// ─────────────────────────────────────────────────────────────────────
test('L2 连续 user_input：第一条配对，第二条降级为 ambiguous', () => {
  const records = buildInteractionLedger([
    row(1, companion('c1', 'reply-1')),
    row(2, user('u1', 'first')),
    row(3, user('u2', 'second')),
  ]);

  assert.equal(records.length, 2);
  assert.equal(at(records, 0).userInputEventId, 'u1');
  assert.equal(at(records, 0).pairingStatus, 'paired');
  // 缺少 observationId/appraisalId → 结构不完整，置信度降为 low
  assert.equal(at(records, 0).pairingConfidence, 'low');

  assert.equal(at(records, 1).userInputEventId, 'u2');
  assert.equal(at(records, 1).pairingStatus, 'ambiguous');
  assert.equal(at(records, 1).pairingConfidence, 'low');
  assert.equal(at(records, 1).pairingRule, 'multiple_user_inputs_after_same_companion');
  assert.ok(at(records, 1).limitations.includes('multiple_user_inputs_after_same_companion'));
});

// ─────────────────────────────────────────────────────────────────────
// L3：连续 companion_output
// ─────────────────────────────────────────────────────────────────────
test('L3 连续 companion_output：候选不唯一，标记 ambiguous', () => {
  const records = buildInteractionLedger([
    row(1, companion('c1', 'reply-1')),
    row(2, companion('c2', 'reply-2')),
    row(3, user('u1', 'hello')),
  ]);

  assert.equal(records.length, 2);

  const orphan = at(records, 0);
  assert.equal(orphan.companionOutputEventId, 'c1');
  assert.equal(orphan.userInputEventId, null);
  assert.equal(orphan.pairingStatus, 'unpaired');

  const ambiguous = at(records, 1);
  assert.equal(ambiguous.userInputEventId, 'u1');
  assert.equal(ambiguous.companionOutputEventId, 'c2');
  assert.equal(ambiguous.pairingStatus, 'ambiguous');
  assert.equal(ambiguous.pairingConfidence, 'low');
  assert.equal(ambiguous.pairingRule, 'consecutive_companion_outputs_before_user');
});

// ─────────────────────────────────────────────────────────────────────
// L4：孤立输出
// ─────────────────────────────────────────────────────────────────────
test('L4 孤立 companion_output：保留记录且不丢失', () => {
  const records = buildInteractionLedger([
    row(1, companion('c1', 'reply-1')),
    row(2, tick('t1')),
  ]);

  assert.equal(records.length, 1);
  assert.equal(at(records, 0).companionOutputEventId, 'c1');
  assert.equal(at(records, 0).userInputEventId, null);
  assert.equal(at(records, 0).pairingStatus, 'unpaired');
  assert.equal(at(records, 0).pairingConfidence, 'none');
  assert.ok(at(records, 0).limitations.includes('no_following_user_input'));
});

// ─────────────────────────────────────────────────────────────────────
// L5：孤立输入
// ─────────────────────────────────────────────────────────────────────
test('L5 孤立 user_input：保留记录且 companion 为 null', () => {
  const records = buildInteractionLedger([
    row(1, user('u1', 'hello')),
    row(2, observation('o1')),
    row(3, appraisal('a1', 'o1')),
  ]);

  assert.equal(records.length, 1);
  assert.equal(at(records, 0).userInputEventId, 'u1');
  assert.equal(at(records, 0).companionOutputEventId, null);
  assert.equal(at(records, 0).pairingStatus, 'unpaired');
  assert.equal(at(records, 0).pairingConfidence, 'none');
  assert.equal(at(records, 0).pairingRule, 'no_preceding_companion');
});

// ─────────────────────────────────────────────────────────────────────
// L6：过滤输出
// ─────────────────────────────────────────────────────────────────────
test('L6 过滤输出：保留 filtered/filterReason 并标记可见性限制', () => {
  const records = buildInteractionLedger([
    row(
      1,
      companion('c1', '（状态机降级提示）', {
        filtered: true,
        filterReason: 'interruption_flag',
      }),
    ),
    row(2, user('u1', 'hello')),
  ]);

  assert.equal(records.length, 1);
  assert.equal(at(records, 0).companionOutputFiltered, true);
  assert.equal(at(records, 0).companionOutputFilterReason, 'interruption_flag');
  assert.ok(at(records, 0).limitations.includes('filtered_output_may_not_be_user_visible'));
});

// ─────────────────────────────────────────────────────────────────────
// L7：跨会话边界
// ─────────────────────────────────────────────────────────────────────
test('L7 跨会话：无会话标识时记录限制，不凭 timestamp 推断边界', () => {
  const longAgo: DialogueEvent = {
    ...companion('c1', 'reply-1'),
    timestamp: '2025-01-01T00:00:00.000Z',
  };
  const laterUser: DialogueEvent = {
    ...user('u1', 'hello'),
    timestamp: '2025-03-01T00:00:00.000Z',
  };

  const records = buildInteractionLedger([row(1, longAgo), row(2, laterUser)]);

  assert.equal(records.length, 1);
  assert.equal(at(records, 0).pairingStatus, 'paired');
  assert.ok(at(records, 0).limitations.includes(LIMITATION_NO_SESSION));
});

// ─────────────────────────────────────────────────────────────────────
// L8：无记忆形成
// ─────────────────────────────────────────────────────────────────────
test('L8 无 MemoryFormationEvent：字段为 null，不影响配对', () => {
  const records = buildInteractionLedger([
    row(1, companion('c1', 'reply-1')),
    row(2, observation('o1')),
    row(3, appraisal('a1', 'o1')),
    row(4, user('u1', 'hello', { observationId: 'o1', appraisalId: 'a1' })),
  ]);

  assert.equal(records.length, 1);
  assert.equal(at(records, 0).pairingStatus, 'paired');
  assert.equal(at(records, 0).memoryFormationEventId, null);
  assert.equal(at(records, 0).memoryValence, null);
  assert.equal(at(records, 0).memorySalience, null);
});

// ─────────────────────────────────────────────────────────────────────
// L9：记忆来源不匹配
// ─────────────────────────────────────────────────────────────────────
test('L9 记忆来源不匹配：不得按相邻或时间绑定', () => {
  const records = buildInteractionLedger([
    row(1, companion('c1', 'reply-1')),
    row(2, user('u1', 'hello')),
    row(3, memory('m1', 'some-other-user-event', 0.5, 0.5)),
  ]);

  assert.equal(records.length, 1);
  assert.equal(at(records, 0).memoryFormationEventId, null);
  assert.equal(at(records, 0).memoryValence, null);
});

// ─────────────────────────────────────────────────────────────────────
// L10：确定性
// ─────────────────────────────────────────────────────────────────────
test('L10 确定性：100 次执行结果一致，输入倒序结果一致', () => {
  const events: LedgerSourceEvent[] = [
    row(1, companion('c1', 'reply-1')),
    row(2, observation('o1')),
    row(3, appraisal('a1', 'o1')),
    row(4, user('u1', 'hello', { observationId: 'o1', appraisalId: 'a1' })),
    row(5, memory('m1', 'u1', 0.4, 0.6)),
    row(6, companion('c2', 'reply-2')),
    row(7, user('u2', 'again')),
  ];

  const baseline = JSON.stringify(buildInteractionLedger(events));
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.stringify(buildInteractionLedger(events)), baseline);
  }

  const reversed = [...events].reverse();
  assert.equal(JSON.stringify(buildInteractionLedger(reversed)), baseline);
});

// ─────────────────────────────────────────────────────────────────────
// L11：输入不可变
// ─────────────────────────────────────────────────────────────────────
test('L11 输入不可变：执行前后深度相等', () => {
  const events: LedgerSourceEvent[] = [
    row(1, companion('c1', 'reply-1')),
    row(2, user('u1', 'hello')),
  ];
  const snapshot = structuredClone(events);

  buildInteractionLedger(events);

  assert.deepEqual(events, snapshot);
});

// ─────────────────────────────────────────────────────────────────────
// L12：非法事件序列
// ─────────────────────────────────────────────────────────────────────
test('L12 非法序列：重复 sequence 抛错', () => {
  assert.throws(
    () =>
      buildInteractionLedger([
        row(1, companion('c1', 'reply-1')),
        row(1, user('u1', 'hello')),
      ]),
    InteractionLedgerInputError,
  );
});

test('L12 非法序列：重复 event ID 抛错', () => {
  assert.throws(
    () =>
      buildInteractionLedger([
        row(1, companion('dup', 'reply-1')),
        row(2, user('dup', 'hello')),
      ]),
    InteractionLedgerInputError,
  );
});

test('L12 非法序列：缺少事件 id 或 timestamp 抛错', () => {
  const missingId = {
    type: 'dialogue',
    timestamp: TS,
    payload: {
      direction: 'user_input',
      text: 'hello',
      moodDelta: 0,
      salience: 0.3,
    },
  } as unknown as MarrowEvent;

  assert.throws(
    () => buildInteractionLedger([row(1, missingId)]),
    InteractionLedgerInputError,
  );

  const missingTimestamp = {
    ...companion('c1', 'reply-1'),
    timestamp: '',
  } as MarrowEvent;

  assert.throws(
    () => buildInteractionLedger([row(1, missingTimestamp)]),
    InteractionLedgerInputError,
  );
});

test('L12 非法序列：sequence 倒序输入按 sequence 排序，不报错', () => {
  const records = buildInteractionLedger([
    row(2, user('u1', 'hello')),
    row(1, companion('c1', 'reply-1')),
  ]);

  assert.equal(records.length, 1);
  assert.equal(at(records, 0).pairingStatus, 'paired');
  assert.equal(at(records, 0).companionOutputSequence, '1');
  assert.equal(at(records, 0).userInputSequence, '2');
});

test('L12 非法序列：非整数 sequence 抛错', () => {
  assert.throws(
    () => buildInteractionLedger([row('1.5', companion('c1', 'reply-1'))]),
    InteractionLedgerInputError,
  );
  assert.throws(
    () => buildInteractionLedger([row(Number.NaN, companion('c1', 'reply-1'))]),
    InteractionLedgerInputError,
  );
});
