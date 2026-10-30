/**
 * filter.test.ts — 候选行为过滤链测试
 *
 * 验证五级确定性过滤的硬约束：
 * - interruption_flag 置位时任意候选文本被强制拦截
 * - 高防御冷暴力替换的选词确定性（同一状态调用两次结果一致）
 *
 * 全部固定输入，无网络、无 LLM、无随机数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCandidateBehavior } from '../dialogue.js';
import { createInitialState, type MarrowState } from '../state.js';
import type { CandidateBehavior } from '../llm.js';

const FIXED_TS = '2026-01-01T00:00:00.000Z';

/** 构造测试状态（覆盖指定字段） */
function makeState(overrides: Partial<MarrowState>): MarrowState {
  return { ...createInitialState(FIXED_TS), ...overrides };
}

/** 构造候选行为（extraction 仅作占位，过滤层不消费） */
function makeCandidate(text: string, action: CandidateBehavior['action']): CandidateBehavior {
  return {
    text,
    action,
    intensity: 0.5,
    extraction: { action, intensity: 0.5, confidence: 0.6, facts: [], uncertainty: 0.4 },
  };
}

test('interruption_flag=true：任意候选文本被强制拦截', () => {
  const state = makeState({ interruptionFlag: true, arousal: 90 });

  const candidates = [
    makeCandidate('你好呀，今天过得怎么样？', 'greeting'),
    makeCandidate('我永远爱你', 'confession'),
    makeCandidate('滚开', 'insult'),
  ];

  for (const candidate of candidates) {
    const result = filterCandidateBehavior(state, candidate);
    assert.equal(result.filtered, true);
    assert.equal(result.filterReason, 'interruption_flag_set');
    assert.equal(result.text, '...（正在恢复，请稍候）');
    assert.ok(!result.text.includes(candidate.text), '候选文本不得泄露到放出结果');
  }
});

test('防御冷暴力：同一状态调用两次返回相同文本（确定性选词）', () => {
  const state = makeState({ defensiveness: 80 });
  const candidate = makeCandidate('没关系啦，我会一直陪着你的', 'comfort');

  const first = filterCandidateBehavior(state, candidate);
  const second = filterCandidateBehavior(state, candidate);

  assert.equal(first.filtered, true);
  assert.equal(first.filterReason, 'defensive_cold_shoulder');
  assert.deepStrictEqual(first, second);
  // 选词来自固定冷暴力表（长度取模，确定性）
  assert.ok(['哦', '随便你', '嗯', '知道了', '你说是就是吧'].includes(first.text));
});
