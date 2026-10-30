/**
 * replay.test.ts — 回放确定性测试
 *
 * 验证事件溯源的核心保证：
 * - 同一事件日志回放两次，最终状态完全一致（tick 背景噪声由事件 ID 哈希派生）
 * - validateEventLog 能检测乱序日志
 *
 * 全部固定输入（固定事件 ID 与时间戳），无网络、无 LLM、无随机数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, validateEventLog } from '../replay.js';
import type { MarrowEvent, TickEvent, InterruptionEvent, DialogueEvent } from '../events.js';

/** 构造固定 ID/时间戳的测试日志：20 个 tick + 1 次中断 + 1 条旧格式对话 */
function buildTestLog(): MarrowEvent[] {
  const events: MarrowEvent[] = [];
  const baseTime = Date.parse('2026-01-01T00:00:00.000Z');

  for (let i = 1; i <= 20; i++) {
    const tick: TickEvent = {
      type: 'tick',
      id: `tick-${i}`,
      timestamp: new Date(baseTime + i * 10_000).toISOString(),
      payload: { deltaSeconds: 10 },
    };
    events.push(tick);
  }

  const interruption: InterruptionEvent = {
    type: 'interruption',
    id: 'interruption-1',
    timestamp: new Date(baseTime + 210_000).toISOString(),
    payload: {
      reason: 'collision: test',
      energyAtInterruption: 70,
      moodBaselineAtInterruption: 50,
      arousalAtInterruption: 20,
      lastBehavior: 'idle',
    },
  };
  events.push(interruption);

  // 旧格式对话事件：无 observationId / appraisalId（模拟存量数据）
  const dialogue: DialogueEvent = {
    type: 'dialogue',
    id: 'dialogue-1',
    timestamp: new Date(baseTime + 220_000).toISOString(),
    payload: {
      direction: 'user_input',
      text: '今天天气不错',
      action: 'statement',
      intensity: 0.3,
      moodDelta: 0, // 旧格式：由 applyDialogue 重算
      salience: 0.3,
      wordCount: 6,
    },
  };
  events.push(dialogue);

  return events;
}

test('回放确定性：同一日志 replay 两次，最终状态 deepStrictEqual', () => {
  const events = buildTestLog();

  const first = replay(events);
  const second = replay(events);

  assert.deepStrictEqual(first, second);
});

test('回放确定性：含 observation/appraisal 事件的日志同样可确定回放', () => {
  const baseTime = Date.parse('2026-01-01T00:00:00.000Z');
  const events: MarrowEvent[] = [
    {
      type: 'tick',
      id: 'tick-a',
      timestamp: new Date(baseTime).toISOString(),
      payload: { deltaSeconds: 10 },
    },
    {
      type: 'observation',
      id: 'obs-a',
      timestamp: new Date(baseTime + 10_000).toISOString(),
      payload: {
        source: 'user_text',
        content: '你真棒',
        action: 'compliment',
        intensity: 0.7,
        confidence: 0.9,
        uncertainty: 0.1,
        facts: [{ claim: '用户在夸伴侣', confidence: 0.9 }],
        extractorVersion: 'extractor-1.1',
      },
    },
    {
      type: 'appraisal',
      id: 'appr-a',
      timestamp: new Date(baseTime + 11_000).toISOString(),
      payload: {
        sourceObservationId: 'obs-a',
        valenceDelta: 2.5,
        arousalDelta: 10,
        energyDelta: 0,
        confidence: 0.9,
        evidenceAssociationIds: [],
      },
    },
    {
      type: 'dialogue',
      id: 'dlg-a',
      timestamp: new Date(baseTime + 12_000).toISOString(),
      payload: {
        direction: 'user_input',
        text: '你真棒',
        action: 'compliment',
        intensity: 0.7,
        moodDelta: 2.5, // 新格式：= AppraisalResult.valenceDelta
        salience: 0.3,
        wordCount: 3,
        observationId: 'obs-a',
        appraisalId: 'appr-a',
      },
    },
  ];

  const first = replay(events);
  const second = replay(events);

  assert.deepStrictEqual(first, second);
  // appraisal 事件的 arousalDelta 应已应用：
  // 基线 10 + tick 确定性噪声（±1.2 以内） + arousalDelta 10 → 落在 [18, 22]
  assert.ok(
    first.arousal >= 18 && first.arousal <= 22,
    `arousal 应在 [18,22]，实际 ${first.arousal}`,
  );
});

test('validateEventLog：乱序日志报错', () => {
  const events = buildTestLog();
  // 人为制造乱序：交换前两个事件的时间戳
  const first = events[0];
  const second = events[1];
  assert.ok(first && second);
  const swapped: MarrowEvent[] = [
    { ...second, id: 'swapped-a' },
    { ...first, id: 'swapped-b' },
  ];

  const result = validateEventLog(swapped);

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0]?.includes('out of order'));
});

test('validateEventLog：重复事件 ID 报错', () => {
  const events = buildTestLog();
  const dup = events[0];
  assert.ok(dup);
  const withDup: MarrowEvent[] = [...events, { ...dup }];

  const result = validateEventLog(withDup);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Duplicate event ID')));
});
