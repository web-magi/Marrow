/**
 * experience-valence.test.ts — M1.5.4.1 用户经历体验性质持久化
 *
 * 覆盖 V1–V11、V13（V12 原子性见 experience-valence.pg.test.ts）：
 *   V1 observed 正值 / V2 observed 负值 / V3 neutral / V4 mixed
 *   V5 unknown / V6 extraction_failed / V7 非法数值 / V8 非法组合
 *   V9 旧事件兼容 / V10 新事件 Replay / V11 Replay 确定性
 *   V13 解析失败与状态缺失不影响其他既有逻辑
 *
 * 纯逻辑测试：不依赖真实 LLM、数据库与网络。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExtraction,
  isMemoryFormationEligible,
  EXTRACTOR_VERSION,
} from '../llm.js';
import {
  EXPERIENCE_VALENCE_MAX,
  EXPERIENCE_VALENCE_MIN,
  normalizeExperienceValence,
  validateExperienceValenceFields,
} from '../experience-valence.js';
import { replay } from '../replay.js';
import type { ObservationEvent } from '../events.js';

const TS = '2026-11-10T10:00:00.000Z';

/** 构造合法的 ObservationEvent（可覆盖体验性质字段） */
function makeObservation(
  id: string,
  extra: Partial<ObservationEvent['payload']> = {},
): ObservationEvent {
  return {
    type: 'observation',
    id,
    timestamp: TS,
    payload: {
      source: 'user_text',
      content: '今天加班到很晚，有点撑不住',
      action: 'statement',
      intensity: 0.6,
      confidence: 0.85,
      uncertainty: 0.15,
      facts: [{ claim: '用户加班到很晚', confidence: 0.9 }],
      extractorVersion: EXTRACTOR_VERSION,
      ...extra,
    },
  };
}

/** 构造模型原始输出（JSON 字符串） */
function raw(payload: Record<string, unknown>): string {
  return JSON.stringify({
    action: 'statement',
    intensity: 0.6,
    confidence: 0.85,
    facts: [],
    uncertainty: 0.15,
    ...payload,
  });
}

// ───────────────────────────── V1 / V2 ─────────────────────────────

test('V1 observed 正值：数值与状态一起进入 ObservationEvent', () => {
  const r = parseExtraction(
    raw({ experienceValence: 0.6, experienceValenceStatus: 'observed' }),
  );
  assert.equal(r.status, 'success');
  assert.equal(r.experienceValenceStatus, 'observed');
  assert.equal(r.experienceValence, 0.6);

  const event = makeObservation('obs-v1', {
    experienceValence: r.experienceValence,
    experienceValenceStatus: r.experienceValenceStatus,
  });
  assert.equal(validateExperienceValenceFields(event.payload), null);
});

test('V2 observed 负值：负向经历极性可被冻结', () => {
  const r = parseExtraction(
    raw({ experienceValence: -0.7, experienceValenceStatus: 'observed' }),
  );
  assert.equal(r.experienceValenceStatus, 'observed');
  assert.equal(r.experienceValence, -0.7);
  assert.equal(
    validateExperienceValenceFields({
      experienceValence: r.experienceValence,
      experienceValenceStatus: r.experienceValenceStatus,
    }),
    null,
  );
});

// ───────────────────────────── V3 / V4 ─────────────────────────────

test('V3 neutral：必须保存数值 0 与 neutral 状态', () => {
  const r = parseExtraction(
    raw({ experienceValence: 0, experienceValenceStatus: 'neutral' }),
  );
  assert.equal(r.experienceValenceStatus, 'neutral');
  assert.equal(r.experienceValence, 0);
  assert.equal(
    validateExperienceValenceFields({
      experienceValence: 0,
      experienceValenceStatus: 'neutral',
    }),
    null,
  );

  // 模型省略数值但明确断言 neutral：按 0 规范化（状态本身已断言中性）
  const omitted = normalizeExperienceValence({
    rawValue: undefined,
    rawStatus: 'neutral',
    extractionSucceeded: true,
  });
  assert.deepEqual(omitted, { status: 'neutral', value: 0 });
});

test('V4 mixed：必须保留 mixed，不得自动转换为 observed / neutral', () => {
  const zero = parseExtraction(
    raw({ experienceValence: 0, experienceValenceStatus: 'mixed' }),
  );
  assert.equal(zero.experienceValenceStatus, 'mixed');
  assert.equal(zero.experienceValence, 0);

  const slight = parseExtraction(
    raw({ experienceValence: 0.2, experienceValenceStatus: 'mixed' }),
  );
  assert.equal(slight.experienceValenceStatus, 'mixed');
  assert.equal(slight.experienceValence, 0.2);

  assert.equal(
    validateExperienceValenceFields({
      experienceValence: 0,
      experienceValenceStatus: 'mixed',
    }),
    null,
  );
  assert.equal(
    validateExperienceValenceFields({
      experienceValence: 0.2,
      experienceValenceStatus: 'mixed',
    }),
    null,
  );
});

// ───────────────────────────── V5 / V6 ─────────────────────────────

test('V5 unknown：没有可靠数值时不得写入数值', () => {
  const noValue = parseExtraction(
    raw({ experienceValenceStatus: 'unknown' }),
  );
  assert.equal(noValue.experienceValenceStatus, 'unknown');
  assert.equal(noValue.experienceValence, undefined);

  // 模型声称 unknown 却给了数值：数值必须被丢弃，绝不保留
  const withValue = parseExtraction(
    raw({ experienceValence: 0, experienceValenceStatus: 'unknown' }),
  );
  assert.equal(withValue.experienceValenceStatus, 'unknown');
  assert.equal(withValue.experienceValence, undefined);

  assert.equal(
    validateExperienceValenceFields({ experienceValenceStatus: 'unknown' }),
    null,
  );
  assert.equal(
    validateExperienceValenceFields({
      experienceValence: 0,
      experienceValenceStatus: 'unknown',
    }) !== null,
    true,
  );
});

test('V6 extraction_failed：解析失败不得保存虚假的 0', () => {
  for (const bad of ['', 'not json', '{"action":"statement"', '{"a":1}{"b":2}']) {
    const r = parseExtraction(bad);
    assert.notEqual(r.status, 'success');
    assert.equal(r.experienceValenceStatus, 'extraction_failed');
    assert.equal(r.experienceValence, undefined);
  }

  assert.equal(
    validateExperienceValenceFields({ experienceValenceStatus: 'extraction_failed' }),
    null,
  );
  assert.equal(
    validateExperienceValenceFields({
      experienceValence: 0,
      experienceValenceStatus: 'extraction_failed',
    }) !== null,
    true,
  );
});

// ───────────────────────────── V7 / V8 ─────────────────────────────

test('V7 非法数值：NaN / Infinity / 越界必须被拒绝', () => {
  const invalid: unknown[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    EXPERIENCE_VALENCE_MAX + 0.01,
    EXPERIENCE_VALENCE_MIN - 0.01,
    2,
    -2,
    '0.5',
  ];
  for (const value of invalid) {
    const error = validateExperienceValenceFields({
      experienceValence: value,
      experienceValenceStatus: 'observed',
    });
    assert.notEqual(error, null, `非法数值 ${String(value)} 应被拒绝`);
  }

  // 提取阶段：越界数值不进入证据链（不是 clamp，而是降级为 unknown）
  const outOfRange = parseExtraction(
    raw({ experienceValence: 1.5, experienceValenceStatus: 'observed' }),
  );
  assert.equal(outOfRange.status, 'success');
  assert.equal(outOfRange.experienceValenceStatus, 'unknown');
  assert.equal(outOfRange.experienceValence, undefined);

  // 非有限数值仍按既有 schema 拒绝（既有行为不变）
  assert.equal(
    parseExtraction(raw({ experienceValence: 'positive' })).status,
    'invalid_schema',
  );
});

test('V8 非法组合：Validator 必须拒绝', () => {
  const invalidCombos: Array<Record<string, unknown>> = [
    { experienceValence: 0.5 }, // 缺 status（部分新格式）
    { experienceValence: 0, experienceValenceStatus: 'observed' }, // observed 为 0
    { experienceValenceStatus: 'observed' }, // observed 缺数值
    { experienceValence: 0.5, experienceValenceStatus: 'neutral' }, // neutral 非 0
    { experienceValenceStatus: 'neutral' }, // neutral 缺数值
    { experienceValenceStatus: 'mixed' }, // mixed 缺数值
    { experienceValence: 0.5, experienceValenceStatus: 'great' }, // 非法状态
    { experienceValence: 0.5, experienceValenceStatus: 1 }, // 非字符串状态
  ];
  for (const combo of invalidCombos) {
    assert.notEqual(
      validateExperienceValenceFields(combo),
      null,
      `组合 ${JSON.stringify(combo)} 应被拒绝`,
    );
  }

  // 合法：旧事件（两个字段都没有）
  assert.equal(validateExperienceValenceFields({}), null);
});

// ───────────────────────── V9 / V10 / V11 ─────────────────────────

test('V9 旧事件兼容：缺少新字段仍可 Replay', () => {
  const legacy = makeObservation('obs-legacy-1');
  assert.ok(!('experienceValence' in legacy.payload));
  assert.ok(!('experienceValenceStatus' in legacy.payload));
  assert.equal(validateExperienceValenceFields(legacy.payload), null);

  const state = replay([legacy]);
  assert.ok(Number.isFinite(state.moodBaseline));
  assert.equal(state.lastUpdated, TS);
});

test('V10 新事件 Replay：字段不参与状态重建，也不改变既有状态结果', () => {
  const legacy = makeObservation('obs-legacy');
  const withValence = makeObservation('obs-new', {
    experienceValence: -0.7,
    experienceValenceStatus: 'observed',
  });
  const withUnknown = makeObservation('obs-unknown', {
    experienceValenceStatus: 'unknown',
  });

  const base = replay([legacy]);
  const newState = replay([withValence]);
  const unknownState = replay([withUnknown]);

  // RuntimeState 不保存体验性质（它是经历证据，不是身体状态）
  assert.deepEqual(newState, base);
  assert.deepEqual(unknownState, base);
  assert.ok(!('experienceValence' in (newState as unknown as Record<string, unknown>)));

  // 事件对象本身在 Replay 中不被改写
  assert.equal(withValence.payload.experienceValence, -0.7);
  assert.equal(withValence.payload.experienceValenceStatus, 'observed');
});

test('V11 Replay 确定性：相同事件链多次 Replay 结果一致', () => {
  const events = [
    makeObservation('obs-a', {
      experienceValence: 0.4,
      experienceValenceStatus: 'observed',
    }),
    makeObservation('obs-b', {
      experienceValence: 0,
      experienceValenceStatus: 'mixed',
    }),
    makeObservation('obs-c', { experienceValenceStatus: 'extraction_failed' }),
  ];
  assert.deepEqual(replay(events), replay(events));
});

// ───────────────────────────── V13 ─────────────────────────────

test('V13 体验性质问题不影响 DialogueAction / 记忆准入等其他既有逻辑', () => {
  const cases: Array<{ label: string; rawText: string; expectStatus: string }> = [
    {
      label: 'status 缺失 + 非 0 数值',
      rawText: raw({ experienceValence: 0.5 }),
      expectStatus: 'observed',
    },
    {
      label: 'status 非法',
      rawText: raw({ experienceValence: 0.5, experienceValenceStatus: 'happy' }),
      expectStatus: 'observed',
    },
    {
      label: 'status 缺失 + 0',
      rawText: raw({ experienceValence: 0 }),
      expectStatus: 'unknown',
    },
    {
      label: '数值越界',
      rawText: raw({ experienceValence: -3, experienceValenceStatus: 'observed' }),
      expectStatus: 'unknown',
    },
    {
      label: 'unknown',
      rawText: raw({ experienceValenceStatus: 'unknown' }),
      expectStatus: 'unknown',
    },
    {
      label: 'neutral',
      rawText: raw({ experienceValence: 0, experienceValenceStatus: 'neutral' }),
      expectStatus: 'neutral',
    },
    {
      label: 'mixed',
      rawText: raw({ experienceValence: 0.1, experienceValenceStatus: 'mixed' }),
      expectStatus: 'mixed',
    },
  ];

  for (const c of cases) {
    const r = parseExtraction(c.rawText);
    assert.equal(r.status, 'success', `${c.label} 不得让整个提取失败`);
    assert.equal(r.action, 'statement', `${c.label} 不得改变 DialogueAction`);
    assert.equal(r.intensity, 0.6, `${c.label} 不得改变 intensity`);
    assert.equal(r.experienceValenceStatus, c.expectStatus, c.label);
    // 记忆准入只看解析状态与 action，不因体验性质未知而改变
    assert.equal(isMemoryFormationEligible(r), true, c.label);
  }

  // JSON 解析失败仍按既有语义整体失败（唯一例外持续存在）
  const broken = parseExtraction('not json');
  assert.equal(broken.status, 'invalid_json');
  assert.equal(isMemoryFormationEligible(broken), false);
});
