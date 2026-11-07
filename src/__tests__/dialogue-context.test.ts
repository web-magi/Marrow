/**
 * dialogue-context.test.ts — M1.4.5 对话上下文连续性（单元测试）
 *
 * 覆盖：
 * - 历史只取 dialogue 事件（内部事件不注入）
 * - user / assistant 顺序正确、只保留完整轮次
 * - 不完整 / 错位历史安全降级
 * - 轮数与字符预算
 * - 情景记忆上下文只映射真实字段，未唤起时不产生上下文
 * - EventStore 读取失败时降级为无历史
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleDialogueHistory,
  buildDialogueContext,
  buildEvokedMemoryContext,
  loadRecentDialogueHistory,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_MEMORY_KEYWORDS,
  MAX_MEMORY_KEYWORD_CHARS,
  MAX_MEMORY_SUMMARY_CHARS,
} from '../dialogue-context.js';
import type { DialogueEvent, EpisodicMemory, MarrowEvent } from '../events.js';

let counter = 0;

/** 构造最简 DialogueEvent（顺序由调用方数组顺序表达） */
function dialogue(
  direction: 'user_input' | 'companion_output',
  text: string,
): DialogueEvent {
  counter += 1;
  return {
    type: 'dialogue',
    id: `dlg-${counter}`,
    timestamp: `2026-01-01T00:00:${String(counter % 60).padStart(2, '0')}.000Z`,
    payload: { direction, text, moodDelta: 0, salience: 0.3 },
  };
}

/** 构造内部事件（只要求 type 不是 dialogue） */
function internal(type: 'tick' | 'observation' | 'appraisal'): MarrowEvent {
  if (type === 'tick') {
    return {
      type: 'tick',
      id: `tick-${counter++}`,
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { deltaSeconds: 10 },
    };
  }
  return {
    type,
    id: `${type}-${counter++}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {},
  } as unknown as MarrowEvent;
}

/** 构造情景记忆 */
function memory(partial: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    id: 'epi-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    summary: '第一次约会的火锅店',
    keywords: ['火锅', '约会'],
    valence: 0.6,
    salience: 0.7,
    sourceEventId: 'dlg-source',
    isTrauma: false,
    ...partial,
  };
}

// ==================================================================
// 一、历史组装
// ==================================================================

test('M1.4.5-1 无历史：返回空数组（单轮不回退的基础）', () => {
  assert.deepEqual(assembleDialogueHistory([]), []);
});

test('M1.4.5-2 user / assistant 顺序与内容正确', () => {
  const messages = assembleDialogueHistory([
    dialogue('user_input', '我昨天去吃了火锅'),
    dialogue('companion_output', '火锅好啊'),
  ]);

  assert.deepEqual(messages, [
    { role: 'user', text: '我昨天去吃了火锅' },
    { role: 'assistant', text: '火锅好啊' },
  ]);
});

test('M1.4.5-3 内部事件（tick / observation / appraisal）不进入历史', () => {
  const messages = assembleDialogueHistory([
    dialogue('user_input', '第一句'),
    internal('observation'),
    internal('appraisal'),
    dialogue('companion_output', '第一答'),
    internal('tick'),
    dialogue('user_input', '第二句'),
    dialogue('companion_output', '第二答'),
  ]);

  assert.deepEqual(messages.map((m) => m.text), ['第一句', '第一答', '第二句', '第二答']);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('M1.4.5-4 只保留最近 4 轮', () => {
  const events: MarrowEvent[] = [];
  for (let i = 1; i <= 5; i++) {
    events.push(dialogue('user_input', `问${i}`));
    events.push(dialogue('companion_output', `答${i}`));
  }

  const messages = assembleDialogueHistory(events);
  assert.equal(messages.length, 8, '4 轮 = 8 条消息');
  assert.equal(messages[0]!.text, '问2', '最旧的一轮被丢弃');
  assert.equal(messages[7]!.text, '答5');
});

test('M1.4.5-5 不完整历史安全降级（不拼接错位对话）', () => {
  // 孤立 assistant：丢弃
  assert.deepEqual(assembleDialogueHistory([dialogue('companion_output', '无源回答')]), []);

  // 连续两条 user_input：前一条无回复，丢弃
  assert.deepEqual(
    assembleDialogueHistory([
      dialogue('user_input', '被吞掉的一句'),
      dialogue('user_input', '保留的一句'),
      dialogue('companion_output', '对应回答'),
    ]),
    [
      { role: 'user', text: '保留的一句' },
      { role: 'assistant', text: '对应回答' },
    ],
  );

  // 尾部未配对 user_input：丢弃
  assert.deepEqual(
    assembleDialogueHistory([
      dialogue('user_input', '完整提问'),
      dialogue('companion_output', '完整回答'),
      dialogue('user_input', '还没回复的提问'),
    ]),
    [
      { role: 'user', text: '完整提问' },
      { role: 'assistant', text: '完整回答' },
    ],
  );

  // 空文本：整轮丢弃
  assert.deepEqual(
    assembleDialogueHistory([
      dialogue('user_input', '   '),
      dialogue('companion_output', '空输入的回答'),
    ]),
    [],
  );
});

test('M1.4.5-6 单条与总字符预算受限', () => {
  const long = '长'.repeat(200);
  const events: MarrowEvent[] = [];
  for (let i = 1; i <= 4; i++) {
    events.push(dialogue('user_input', `${i}${long}`));
    events.push(dialogue('companion_output', `${i}${long}`));
  }

  const messages = assembleDialogueHistory(events);
  for (const message of messages) {
    assert.ok(
      message.text.length <= MAX_HISTORY_MESSAGE_CHARS + 1,
      `单条必须截断到 ${MAX_HISTORY_MESSAGE_CHARS} 字（含省略号），实际 ${message.text.length}`,
    );
  }

  const total = messages.reduce((sum, m) => sum + m.text.length, 0);
  assert.ok(total <= MAX_HISTORY_TOTAL_CHARS, `总字符 ${total} 必须 <= ${MAX_HISTORY_TOTAL_CHARS}`);
});

// ==================================================================
// 二、EventStore 只读查询
// ==================================================================

test('M1.4.5-7 查询结果按 sequence DESC 返回时被还原为事件顺序', async () => {
  // 模拟 EventStore：最新在前
  const rows = [
    { payload: dialogue('companion_output', '第二答') },
    { payload: dialogue('user_input', '第二问') },
    { payload: dialogue('companion_output', '第一答') },
    { payload: dialogue('user_input', '第一问') },
  ];

  const messages = await loadRecentDialogueHistory('marrow-test', async () => rows);
  assert.deepEqual(messages, [
    { role: 'user', text: '第一问' },
    { role: 'assistant', text: '第一答' },
    { role: 'user', text: '第二问' },
    { role: 'assistant', text: '第二答' },
  ]);
});

test('M1.4.5-8 历史读取失败时安全降级为空历史', async () => {
  const messages = await loadRecentDialogueHistory('marrow-test', async () => {
    throw new Error('database unavailable');
  });
  assert.deepEqual(messages, []);
});

// ==================================================================
// 三、情景记忆上下文
// ==================================================================

test('M1.4.5-9 真实唤起记忆只映射 summary/timestamp/keywords/valence/salience', () => {
  const context = buildEvokedMemoryContext(memory());
  assert.deepEqual(context, {
    summary: '第一次约会的火锅店',
    timestamp: '2026-01-02T03:04:05.000Z',
    keywords: ['火锅', '约会'],
    valence: 0.6,
    salience: 0.7,
  });
});

test('M1.4.5-10 未唤起（null）时不产生记忆上下文', () => {
  assert.equal(buildEvokedMemoryContext(null), null);
  // 空摘要同样视为不可注入
  assert.equal(buildEvokedMemoryContext(memory({ summary: '   ' })), null);
});

test('M1.4.5-11 记忆摘要与关键词数量受限', () => {
  const context = buildEvokedMemoryContext(
    memory({
      summary: '记'.repeat(200),
      keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'],
    }),
  );
  assert.ok(context);
  assert.ok(context.summary.length <= MAX_MEMORY_SUMMARY_CHARS + 1);
  assert.equal(context.keywords.length, MAX_MEMORY_KEYWORDS);
  assert.deepEqual(context.keywords, ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
});

test('M1.4.5-11b 超长关键词截断到 16 字符，短关键词保持原样', () => {
  const longKeyword = '长'.repeat(40);
  const context = buildEvokedMemoryContext(
    memory({ keywords: [longKeyword, '火锅'] }),
  );

  assert.ok(context);
  assert.equal(context.keywords[0], '长'.repeat(MAX_MEMORY_KEYWORD_CHARS) + '…');
  assert.equal(context.keywords[0]!.length, MAX_MEMORY_KEYWORD_CHARS + 1);
  assert.equal(context.keywords[1], '火锅', '短关键词不得被改写');
});

test('M1.4.5-11c 原始 EpisodicMemory 不被上下文映射修改', () => {
  const original = memory({
    summary: '记'.repeat(200),
    keywords: ['长'.repeat(40), '火锅'],
  });
  const snapshot = JSON.parse(JSON.stringify(original));

  buildEvokedMemoryContext(original);

  assert.deepEqual(original, snapshot, '只应生成展示副本，不得回写原记忆');
});

test('M1.4.5-12 buildDialogueContext 组合历史与记忆（未唤起时为 null）', () => {
  const history = assembleDialogueHistory([
    dialogue('user_input', '问'),
    dialogue('companion_output', '答'),
  ]);

  const withMemory = buildDialogueContext(history, memory());
  assert.equal(withMemory.history.length, 2);
  assert.equal(withMemory.evokedMemory?.summary, '第一次约会的火锅店');

  const withoutMemory = buildDialogueContext(history, null);
  assert.equal(withoutMemory.evokedMemory, null);
});
