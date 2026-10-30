/**
 * appraisal.test.ts — 评价模块单元测试
 *
 * 验证主客观分离的核心计算：
 * - 防御墙对正向安抚的衰减与反转
 * - 关联权重对情绪效价的调制
 * - 低观察置信度的线性衰减
 *
 * 全部固定输入，无网络、无 LLM、无随机数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appraise, type AppraisalContext } from '../appraisal.js';

/** 构造基准评价上下文（可通过 overrides 覆盖单字段） */
function baseContext(overrides: Partial<AppraisalContext> = {}): AppraisalContext {
  return {
    associationWeight: 1.0,
    trust: 100,
    defensiveness: 0,
    moodBaseline: 50,
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    traits: { neuroticism: 1.0, agreeableness: 1.0, extraversion: 1.0, resilience: 1.0 },
    confidence: 1.0,
    evidenceAssociationIds: [],
    ...overrides,
  };
}

test('防御墙：相同输入下 defensiveness 80 的正向效价被衰减为 ×0.2', () => {
  const low = appraise('compliment', 0.8, baseContext({ defensiveness: 0 }));
  const high = appraise('compliment', 0.8, baseContext({ defensiveness: 80 }));

  assert.notEqual(low.valenceDelta, high.valenceDelta);
  assert.ok(low.valenceDelta > 0, '低防御时赞美应为正向');
  assert.ok(high.valenceDelta > 0, '防御墙只衰减不反转（80 < 90）');
  // 高防御（>70）正向效价保留 20%
  assert.ok(
    Math.abs(high.valenceDelta - low.valenceDelta * 0.2) < 1e-9,
    `期望 ${low.valenceDelta * 0.2}，实际 ${high.valenceDelta}`,
  );
});

test('关联权重：相同输入下 associationWeight 1.0 与 0.5 产生不同结果', () => {
  const full = appraise('compliment', 0.8, baseContext({ associationWeight: 1.0 }));
  const half = appraise('compliment', 0.8, baseContext({ associationWeight: 0.5 }));

  assert.notEqual(full.valenceDelta, half.valenceDelta);
  // 需求加成不受关联权重影响，因此半权重的效价更小但不为一半
  assert.ok(Math.abs(half.valenceDelta) < Math.abs(full.valenceDelta));
});

test('低置信衰减：confidence 0.2 的效价冲击严格小于 confidence 1.0', () => {
  const highConf = appraise('insult', 0.8, baseContext({ confidence: 1.0 }));
  const lowConf = appraise('insult', 0.8, baseContext({ confidence: 0.2 }));

  assert.ok(
    Math.abs(lowConf.valenceDelta) < Math.abs(highConf.valenceDelta),
    `低置信 |${lowConf.valenceDelta}| 应严格小于高置信 |${highConf.valenceDelta}|`,
  );
  // 线性衰减系数 = 0.2 / 0.4 = 0.5
  assert.ok(
    Math.abs(lowConf.valenceDelta - highConf.valenceDelta * 0.5) < 1e-9,
    '低置信衰减应为线性 ×0.5',
  );
});

test('防御墙：defensiveness 95 时正向安抚被解读为敷衍而转负', () => {
  const result = appraise('comfort', 0.8, baseContext({ defensiveness: 95 }));

  assert.ok(
    result.valenceDelta < 0,
    `极度防御下安抚应反转为负向，实际 ${result.valenceDelta}`,
  );
});

test('多维结果：arousalDelta 由效价绝对值驱动且 clamp 在 [-30, 30]', () => {
  const result = appraise('insult', 1.0, baseContext());

  assert.ok(result.arousalDelta > 0, '强烈侮辱应拉高唤醒度');
  assert.ok(result.arousalDelta <= 30 && result.arousalDelta >= -30);
  assert.equal(result.confidence, 1.0);
  assert.deepEqual(result.evidenceAssociationIds, []);
});
