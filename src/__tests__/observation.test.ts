/**
 * observation.test.ts — 观察提取解析的单元测试
 *
 * 验证 parseExtraction 的严格 schema 校验与兜底策略：
 * - 合法 JSON 正确解析并 clamp
 * - 垃圾输入返回低置信兜底（绝不伪造高置信度）
 * - 解析结果绝不包含 moodDelta/valence 等主观情绪字段
 *
 * 全部固定输入，无网络、无 LLM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraction, EXTRACTOR_VERSION } from '../llm.js';

test('合法 JSON：正确解析并将越界数值 clamp 到 [0,1]', () => {
  const raw = JSON.stringify({
    text: '谢谢你',
    action: 'compliment',
    intensity: 1.7, // 越界，应 clamp 到 1
    confidence: 0.9,
    uncertainty: -0.3, // 越界，应 clamp 到 0
    facts: [
      { claim: '用户夸了我', confidence: 1.5 }, // confidence 越界 → clamp 到 1
      { claim: '有效主张', confidence: 0.3 },
      { claim: '' }, // 空 claim → 过滤
      { claim: 123 }, // 非字符串 claim → 过滤
      null, // 非对象 → 过滤
    ],
  });

  const result = parseExtraction(raw);

  assert.equal(result.action, 'compliment');
  assert.equal(result.intensity, 1);
  assert.equal(result.confidence, 0.9);
  assert.equal(result.uncertainty, 0);
  assert.equal(result.facts.length, 2);
  assert.equal(result.facts[0]?.claim, '用户夸了我');
  assert.equal(result.facts[0]?.confidence, 1);
  assert.equal(result.facts[1]?.claim, '有效主张');
});

test('垃圾输入：返回兜底结果（低置信 + unknown），绝不抛异常', () => {
  const garbageInputs = [
    'not json at all',
    '',
    '{{{broken',
    '[1,2,3]',
    '{"text":"没有 action 字段"}',
    '{"action":"not_a_valid_action","intensity":0.5}',
  ];

  for (const garbage of garbageInputs) {
    const result = parseExtraction(garbage);
    assert.equal(result.action, 'unknown', `输入 ${JSON.stringify(garbage)} 应回退为 unknown`);
    assert.ok(
      result.confidence <= 0.2,
      `输入 ${JSON.stringify(garbage)} 置信度应 ≤0.2，实际 ${result.confidence}`,
    );
    assert.ok(result.uncertainty >= 0.8, '兜底结果应保持高不确定性');
    assert.deepEqual(result.facts, []);
  }
});

test('解析结果绝不包含主观情绪字段（moodDelta/valence 等）', () => {
  const raw = JSON.stringify({
    action: 'insult',
    intensity: 0.8,
    confidence: 0.9,
    uncertainty: 0.1,
    facts: [],
    moodDelta: -5, // LLM 试图走私主观字段
    valence: -0.9,
  });

  const result = parseExtraction(raw);
  const keys = Object.keys(result).sort();

  assert.deepEqual(keys, ['action', 'confidence', 'facts', 'intensity', 'uncertainty']);
  assert.ok(!('moodDelta' in result), '结果不得包含 moodDelta');
  assert.ok(!('valence' in result), '结果不应包含 valence');
});

test('EXTRACTOR_VERSION 已导出且非空', () => {
  assert.ok(typeof EXTRACTOR_VERSION === 'string' && EXTRACTOR_VERSION.length > 0);
});
