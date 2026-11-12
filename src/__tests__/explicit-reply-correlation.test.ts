/**
 * explicit-reply-correlation.test.ts — M1.5.4.2 显式回复关联（纯逻辑）
 *
 * 覆盖任务书 R1 / R3 / R4 / R5 / R6 / R7 / R8 / R9 / R10 / R11 / R12 / R13 / R14 / R15 / R17。
 * R2（批次原子性）与 R16（哈希链）在 explicit-reply-correlation.pg.test.ts 中覆盖。
 *
 * 所有用例为纯内存构造：不连接数据库、不调用 LLM、不读墙钟、不使用随机数。
 * R1/R3 使用生产构造函数 buildCompanionOutputEvent，而不是手写 payload。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanionOutputEvent } from '../dialogue.js';
import { buildInteractionLedger, type InteractionRecord } from '../interaction-ledger.js';
import { replayPersistedEvents } from '../recovery.js';
import type { PersistedEventRow } from '../storage.js';
import type { DialogueEvent, MarrowEvent, ObservationEvent } from '../events.js';

const ID = 'marrow-test-1542-pure';
const TS = '2026-01-01T00:00:00.000Z';

function at(records: readonly InteractionRecord[], index: number): InteractionRecord {
  const record = records[index];
  assert.ok(record, `缺少第 ${index} 条记录`);
  return record;
}

function row(sequence: number, payload: MarrowEvent, identityId: string = ID): PersistedEventRow {
  return {
    sequence: String(sequence),
    event_id: payload.id,
    identity_id: identityId,
    timestamp: payload.timestamp,
    event_type: payload.type,
    schema_version: 2,
    engine_version: 'marrow@test',
    causation_id: null,
    correlation_id: null,
    previous_event_hash: null,
    event_hash: `hash-${sequence}`,
    payload,
  };
}

function userDialogue(
  id: string,
  text = '你好',
  extra?: Partial<DialogueEvent['payload']>,
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
      ...extra,
    },
  };
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
      intensity: 0.5,
      confidence: 0.9,
      uncertainty: 0.1,
      facts: [],
      extractorVersion: 'extractor-test',
      experienceValenceStatus: 'unknown',
    },
  };
}

/** 生产构造路径：通过 buildCompanionOutputEvent 生成 companion_output */
function companionOutput(
  id: string,
  replyToEventId: string,
  text = '听起来今天很不容易。',
): DialogueEvent {
  return buildCompanionOutputEvent({
    id,
    timestamp: TS,
    filterResult: { text, filtered: false, filterReason: '' },
    candidateText: text,
    replyToEventId,
  });
}

/** 直接构造带任意 replyToEventId 的 companion（用于非法值测试，绕过生产构建器） */
function rawCompanion(id: string, replyToEventId: unknown): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp: TS,
    payload: {
      direction: 'companion_output',
      text: 'x',
      moodDelta: 0,
      salience: 0.3,
      replyToEventId: replyToEventId as string,
    },
  };
}

/** 历史事件：没有 replyToEventId 的 companion_output */
function legacyCompanion(id: string, text = '旧回复'): DialogueEvent {
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
      filtered: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// R1：新生产回复关联（真实构造路径）
// ─────────────────────────────────────────────────────────────────────
test('R1 生产构造：replyToEventId 精确等于同批次 user_input 事件 ID', () => {
  const userEvent = userDialogue('user-event-001');
  const companionEvent = companionOutput('companion-event-002', userEvent.id);

  assert.equal(companionEvent.payload.replyToEventId, 'user-event-001');
  // 生产构造函数不得写入其它任何关联字段
  assert.equal(companionEvent.payload.direction, 'companion_output');
  assert.ok(!('replyToEventId' in userEvent.payload));

  const records = buildInteractionLedger([row(1, userEvent), row(2, companionEvent)]);
  assert.equal(records.length, 1);
  const record = at(records, 0);
  assert.equal(record.userInputEventId, 'user-event-001');
  assert.equal(record.companionOutputEventId, 'companion-event-002');
  assert.equal(record.pairingStatus, 'paired');
  assert.equal(record.pairingRule, 'explicit_reply_to');
  assert.equal(record.pairingConfidence, 'high');
  assert.equal(record.replyLinkSource, 'explicit');
  assert.equal(record.replyToEventId, 'user-event-001');
});

// ─────────────────────────────────────────────────────────────────────
// R3：多输出关联（多个 companion_output → 同一 user_input）
// ─────────────────────────────────────────────────────────────────────
test('R3 多输出：多个 companion_output 可显式引用同一 user_input，且记录 ID 全部唯一', () => {
  const userEvent = userDialogue('u-1');
  const c1 = companionOutput('c-1', 'u-1', '第一条回复');
  const c2 = companionOutput('c-2', 'u-1', '补充一条回复');

  const records = buildInteractionLedger([row(1, userEvent), row(2, c1), row(3, c2)]);
  assert.equal(records.length, 2);
  // M1.5.4.2.1：核心修复——同 anchor 下多条回复的 ID 必须不同
  const ids = records.map((r) => r.id);
  assert.equal(new Set(ids).size, records.length, '多条回复指向同一输入时记录 ID 不得重复');
  assert.notEqual(records[0]?.id, records[1]?.id);
  assert.match(records[0]?.id ?? '', /^ledger:1:2$/);
  assert.match(records[1]?.id ?? '', /^ledger:1:3$/);
  for (const record of records) {
    assert.equal(record.userInputEventId, 'u-1');
    assert.equal(record.replyLinkSource, 'explicit');
    assert.equal(record.pairingConfidence, 'high');
    assert.equal(record.replyToEventId, 'u-1');
  }
});

// ─────────────────────────────────────────────────────────────────────
// R4：历史事件兼容（无 replyToEventId）
// ─────────────────────────────────────────────────────────────────────
test('R4 历史兼容：无 replyToEventId 的旧 companion_output 仍可恢复且按顺序推断', () => {
  const rows = [
    row(1, observation('o-1')),
    row(2, legacyCompanion('c-1')),
    row(3, userDialogue('u-1', '你好', { observationId: 'o-1' })),
  ];

  const result = replayPersistedEvents(ID, rows);
  assert.equal(result.verdict, 'valid');
  assert.equal(result.errors.length, 0);

  const records = buildInteractionLedger(rows);
  const record = at(records, 0);
  assert.equal(record.pairingStatus, 'paired');
  assert.equal(record.pairingRule, 'unique_preceding_companion');
  assert.equal(record.replyLinkSource, 'inferred');
  assert.equal(record.replyToEventId, null);
  // 历史推断永远不会升格为 high
  assert.notEqual(record.pairingConfidence, 'high');
});

// ─────────────────────────────────────────────────────────────────────
// R5：user_input 非法携带 replyToEventId
// ─────────────────────────────────────────────────────────────────────
test('R5 user_input 携带 replyToEventId：Recovery 拒绝', () => {
  const invalidUser = userDialogue('u-bad', '你好', { replyToEventId: 'target-1' });
  const result = replayPersistedEvents(ID, [row(1, invalidUser)]);

  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_payload');
  assert.match(result.errors[0]?.message ?? '', /replyToEventId/);
});

// ─────────────────────────────────────────────────────────────────────
// R6：空字符串 / null / 非字符串
// ─────────────────────────────────────────────────────────────────────
test('R6 空字符串：Recovery 拒绝', () => {
  const result = replayPersistedEvents(ID, [
    row(1, userDialogue('u-1')),
    row(2, rawCompanion('c-1', '')),
  ]);
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_payload');
});

test('R6 null / 非字符串：Recovery 拒绝', () => {
  for (const value of [null, 123, false, {}]) {
    const bad = rawCompanion('c-bad', value);
    const result = replayPersistedEvents(ID, [row(1, userDialogue('u-1')), row(2, bad)]);
    assert.equal(result.verdict, 'invalid', `值 ${JSON.stringify(value)} 必须被拒绝`);
    assert.equal(result.errors[0]?.kind, 'invalid_payload');
  }
});

test('R6 纯空白字符串：Recovery 拒绝', () => {
  const result = replayPersistedEvents(ID, [
    row(1, userDialogue('u-1')),
    row(2, rawCompanion('c-1', '   ')),
  ]);
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_payload');
});

// ─────────────────────────────────────────────────────────────────────
// R7：目标事件不存在
// ─────────────────────────────────────────────────────────────────────
test('R7 目标不存在：Identity-level Validator 拒绝', () => {
  const result = replayPersistedEvents(ID, [
    row(1, userDialogue('u-1')),
    row(2, companionOutput('c-1', 'ghost-event')),
  ]);
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_reference');
  assert.match(result.errors[0]?.message ?? '', /不存在于当前 identity 事件链/);
});

// ─────────────────────────────────────────────────────────────────────
// R8：引用其他 identity
// ─────────────────────────────────────────────────────────────────────
test('R8 引用其他 identity：不在本 identity 链中，必须拒绝', () => {
  // events 表 event_id 全局 UNIQUE：其他 identity 的事件不会出现在本链，
  // 因此跨 identity 引用必然表现为「不存在于当前 identity 事件链」。
  const result = replayPersistedEvents(ID, [
    row(1, userDialogue('u-1')),
    row(2, companionOutput('c-1', 'other-identity-user-event')),
  ]);
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_reference');
});

// ─────────────────────────────────────────────────────────────────────
// R9：引用 companion_output
// ─────────────────────────────────────────────────────────────────────
test('R9 引用 companion_output：必须拒绝', () => {
  const result = replayPersistedEvents(ID, [
    row(1, userDialogue('u-1')),
    row(2, legacyCompanion('c-old')),
    row(3, companionOutput('c-1', 'c-old')),
  ]);
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_reference');
  assert.match(result.errors[0]?.message ?? '', /不是 DialogueEvent\(user_input\)/);
});

// ─────────────────────────────────────────────────────────────────────
// R10：引用未来 user_input / 自引用
// ─────────────────────────────────────────────────────────────────────
test('R10 引用未来 user_input：必须拒绝', () => {
  const result = replayPersistedEvents(ID, [
    row(1, companionOutput('c-1', 'u-2')),
    row(2, userDialogue('u-2')),
  ]);
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_reference');
  assert.match(result.errors[0]?.message ?? '', /位于当前回复之后/);
});

test('R10 自引用：必须拒绝', () => {
  const selfRef: DialogueEvent = {
    type: 'dialogue',
    id: 'c-self',
    timestamp: TS,
    payload: {
      direction: 'companion_output',
      text: 'x',
      moodDelta: 0,
      salience: 0.3,
      replyToEventId: 'c-self',
    },
  };
  const result = replayPersistedEvents(ID, [row(1, selfRef)]);
  assert.equal(result.verdict, 'invalid');
  assert.equal(result.errors[0]?.kind, 'invalid_reference');
});

// ─────────────────────────────────────────────────────────────────────
// R11：显式关联优先级（不得被顺序覆盖）
// ─────────────────────────────────────────────────────────────────────
test('R11 显式优先：replyToEventId 指向较早输入时，顺序不覆盖显式关联', () => {
  const records = buildInteractionLedger([
    row(1, userDialogue('u-1', '第一句')),
    row(2, userDialogue('u-2', '第二句')),
    row(3, companionOutput('c-1', 'u-1', '回复第一句')),
  ]);

  const explicit = records.find((r) => r.companionOutputEventId === 'c-1');
  assert.ok(explicit, '必须存在 c-1 的记录');
  assert.equal(explicit.userInputEventId, 'u-1');
  assert.equal(explicit.replyLinkSource, 'explicit');
  assert.equal(explicit.pairingRule, 'explicit_reply_to');
  assert.equal(explicit.pairingConfidence, 'high');

  // 最近的 user_input (u-2) 不得覆盖显式关联
  assert.ok(!records.some((r) => r.userInputEventId === 'u-2' && r.companionOutputEventId === 'c-1'));
});

test('R11 显式优先：显式关联的回复不会被后续 user_input 顺序复用', () => {
  const records = buildInteractionLedger([
    row(1, userDialogue('u-1', '第一句')),
    row(2, companionOutput('c-1', 'u-1', '回复第一句')),
    row(3, userDialogue('u-2', '第二句')),
  ]);

  const c1 = records.find((r) => r.companionOutputEventId === 'c-1');
  assert.ok(c1);
  assert.equal(c1.userInputEventId, 'u-1');
  assert.equal(c1.replyLinkSource, 'explicit');

  // u-2 没有前置的、未被显式消费的 companion → unlinked，不得猜测
  const u2 = records.find((r) => r.userInputEventId === 'u-2');
  assert.ok(u2);
  assert.equal(u2.companionOutputEventId, null);
  assert.equal(u2.replyLinkSource, 'unlinked');
});

// ─────────────────────────────────────────────────────────────────────
// R12：历史推断保持 inferred
// ─────────────────────────────────────────────────────────────────────
test('R12 历史推断：无显式字段时保留原规则并标记 inferred', () => {
  const records = buildInteractionLedger([
    row(1, legacyCompanion('c-1')),
    row(2, userDialogue('u-1')),
  ]);
  const record = at(records, 0);
  assert.equal(record.pairingStatus, 'paired');
  assert.equal(record.pairingRule, 'unique_preceding_companion');
  assert.equal(record.replyLinkSource, 'inferred');
  assert.equal(record.replyToEventId, null);
});

// ─────────────────────────────────────────────────────────────────────
// R13：无法关联 → unlinked，不猜测
// ─────────────────────────────────────────────────────────────────────
test('R13 无法关联：孤立输入与孤立输出均为 unlinked', () => {
  const records = buildInteractionLedger([
    row(1, userDialogue('u-1')),
    row(2, legacyCompanion('c-1')),
  ]);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.replyLinkSource, 'unlinked');
    assert.equal(record.pairingConfidence, 'none');
  }
});

test('R13 显式引用无效：标记 invalid_reply_reference，不退回顺序推断', () => {
  const records = buildInteractionLedger([
    row(1, userDialogue('u-1')),
    // 引用一个不存在的目标
    row(2, companionOutput('c-bad', 'ghost-user')),
    row(3, userDialogue('u-2')),
  ]);

  const bad = records.find((r) => r.companionOutputEventId === 'c-bad');
  assert.ok(bad);
  assert.equal(bad.pairingStatus, 'unpaired');
  assert.equal(bad.pairingRule, 'invalid_reply_reference');
  assert.equal(bad.replyLinkSource, 'unlinked');
  assert.equal(bad.pairingConfidence, 'none');
  assert.equal(bad.replyToEventId, 'ghost-user');
  assert.ok(bad.limitations.includes('invalid_reply_reference'));

  // 损坏关联的 companion 不得被后续 user_input 顺序配对
  const u2 = records.find((r) => r.userInputEventId === 'u-2');
  assert.ok(u2);
  assert.equal(u2.companionOutputEventId, null);
});

// ─────────────────────────────────────────────────────────────────────
// R14：显式关联 ≠ 反馈
// ─────────────────────────────────────────────────────────────────────
test('R14 explicit 不等于反馈：正负 moodDelta 产生完全相同的关联记录', () => {
  const positive = buildInteractionLedger([
    row(1, userDialogue('u-1', '今天很开心', { moodDelta: 3 })),
    row(2, companionOutput('c-1', 'u-1')),
  ]);
  const negative = buildInteractionLedger([
    row(1, userDialogue('u-1', '今天很难过', { moodDelta: -3 })),
    row(2, companionOutput('c-1', 'u-1')),
  ]);

  assert.deepEqual(positive, negative);
  const record = at(positive, 0);
  // 记录中不存在任何反馈/满意度字段
  assert.ok(!('feedback' in record));
  assert.ok(!('satisfaction' in record));
  assert.ok(!('userFeedback' in record));
});

// ─────────────────────────────────────────────────────────────────────
// R15：Replay 确定性
// ─────────────────────────────────────────────────────────────────────
test('R15 Replay 确定性：同一事件链多次 Replay / Ledger 结果一致', () => {
  const rows = [
    row(1, observation('o-1')),
    row(2, userDialogue('u-1', '你好', { observationId: 'o-1' })),
    row(3, companionOutput('c-1', 'u-1')),
    row(4, legacyCompanion('c-2')),
    row(5, userDialogue('u-2', '旧格式之后的输入')),
  ];

  const first = replayPersistedEvents(ID, rows);
  const second = replayPersistedEvents(ID, rows);
  assert.equal(first.verdict, 'valid');
  assert.equal(second.verdict, 'valid');
  assert.deepEqual(first.finalState, second.finalState);
  assert.equal(first.lastEventTimestamp, second.lastEventTimestamp);

  const ledgerA = JSON.stringify(buildInteractionLedger(rows));
  const ledgerB = JSON.stringify(buildInteractionLedger([...rows].reverse()));
  assert.equal(ledgerA, ledgerB);
});

// ─────────────────────────────────────────────────────────────────────
// R17：生产失败路径不得构造虚假关联
// ─────────────────────────────────────────────────────────────────────
test('R17 生产构造 fail-closed：缺少/空 replyToEventId 直接抛错，不产生事件', () => {
  for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
    assert.throws(
      () =>
        buildCompanionOutputEvent({
          id: 'c-x',
          timestamp: TS,
          filterResult: { text: 'x', filtered: false, filterReason: '' },
          candidateText: 'x',
          replyToEventId: bad,
        }),
      /replyToEventId/,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────
// M1.5.4.2.1：InteractionRecord ID 唯一性修复
// ─────────────────────────────────────────────────────────────────────

test('M1.5.4.2.1-1 三输出同一输入：全部 ID 唯一', () => {
  const userEvent = userDialogue('u-1');
  const c1 = companionOutput('c-1', 'u-1', '第一条');
  const c2 = companionOutput('c-2', 'u-1', '第二条');
  const c3 = companionOutput('c-3', 'u-1', '第三条');
  const records = buildInteractionLedger([row(1, userEvent), row(2, c1), row(3, c2), row(4, c3)]);
  assert.equal(records.length, 3);
  const ids = records.map((r) => r.id);
  assert.equal(new Set(ids).size, 3);
  // 预期格式：ledger:1:2 / ledger:1:3 / ledger:1:4
  assert.deepEqual(ids, ['ledger:1:2', 'ledger:1:3', 'ledger:1:4']);
});

test('M1.5.4.2.1-2 重复构建确定性：相同输入两次构建的 ID 完全一致', () => {
  const rows = [
    row(1, userDialogue('u-1')),
    row(2, companionOutput('c-1', 'u-1')),
    row(3, companionOutput('c-2', 'u-1', '补充')),
  ];
  const first = buildInteractionLedger(rows).map((r) => r.id);
  const second = buildInteractionLedger(rows).map((r) => r.id);
  assert.deepEqual(first, second);
});

test('M1.5.4.2.1-3 反转输入顺序：记录 ID 与原结果一致（ledger 按 sequence 内部排序）', () => {
  const rowsAsc = [
    row(1, userDialogue('u-1')),
    row(2, companionOutput('c-1', 'u-1')),
  ];
  const rowsDesc = [...rowsAsc].reverse();
  const idsAsc = buildInteractionLedger(rowsAsc).map((r) => r.id);
  const idsDesc = buildInteractionLedger(rowsDesc).map((r) => r.id);
  assert.deepEqual(idsAsc, idsDesc);
});

test('M1.5.4.2.1-4 历史 inferred 配对：不同输入的 inferred 记录 ID 唯一', () => {
  const records = buildInteractionLedger([
    row(1, legacyCompanion('c-1')),
    row(2, userDialogue('u-1')),
    row(3, legacyCompanion('c-2')),
    row(4, userDialogue('u-2', '第二句')),
  ]);
  assert.equal(records.length, 2);
  const ids = records.map((r) => r.id);
  assert.equal(new Set(ids).size, 2);
  for (const record of records) {
    assert.equal(record.replyLinkSource, 'inferred');
    assert.match(record.id, /^ledger:\d+:\d+$/);
  }
});

test('M1.5.4.2.1-5 unpaired 记录：user-only 与 companion-only 的 ID 唯一', () => {
  const records = buildInteractionLedger([
    row(1, userDialogue('u-alone')),
    row(2, legacyCompanion('c-alone')),
  ]);
  assert.equal(records.length, 2);
  const ids = records.map((r) => r.id);
  assert.equal(new Set(ids).size, 2);

  const userOnly = records.find((r) => r.userInputEventId === 'u-alone');
  assert.ok(userOnly);
  assert.equal(userOnly.companionOutputEventId, null);
  // user-only：anchor 是 user 的 sequence（1），无 companion → 'none'
  assert.equal(userOnly.id, 'ledger:1:none');
  assert.equal(userOnly.replyLinkSource, 'unlinked');

  const companionOnly = records.find((r) => r.companionOutputEventId === 'c-alone');
  assert.ok(companionOnly);
  assert.equal(companionOnly.userInputEventId, null);
  // companion-only：anchor 是 companion 自身的 sequence（2）
  assert.equal(companionOnly.id, 'ledger:2:2');
  assert.equal(companionOnly.replyLinkSource, 'unlinked');
});

test('M1.5.4.2.1-6 全链唯一：混合 explicit/inferred/unpaired 的完整链上无重复 ID', () => {
  const rows = [
    row(1, legacyCompanion('c-historical')),
    row(2, userDialogue('u-historical')),
    row(3, userDialogue('u-explicit')),
    row(4, companionOutput('c-explicit-a', 'u-explicit')),
    row(5, companionOutput('c-explicit-b', 'u-explicit', '补充')),
    row(6, userDialogue('u-unpaired')),
  ];
  const records = buildInteractionLedger(rows);
  const ids = records.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `记录 ID 必须全部唯一：${ids.join(', ')}`);
});
