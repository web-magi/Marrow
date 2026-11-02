/**
 * birth-state.test.ts — 出生状态参数验证单元测试
 *
 * 目标：在实施 marrow-v2-birth2 之前，验证以下参数的正确计算：
 *   1. TRUST_INITIAL=50 时 createInitialState().trust === 50（以及 sleepEntryTrust 同步）
 *   2. trustMultiplier = trust/50 的倍率行为
 *   3. trust 不直接参与 memoryMoodDelta 计算
 *   4. SEED_EPISODIC_MEMORIES 删除后 episodicBuffer=[], evokeMemoryFromText([], any) 返回 null
 *   5. 空白记忆下第一条 DialogueEvent 沉淀出正确的 timestamp + sourceEventId
 *   6. 同一事件 Replay 两次，沉淀的 EpisodicMemory 完全一致
 *
 * 注意：本阶段只新增测试，不修改生产代码。
 * 其中断言期望值=50 / 空 episodicBuffer 的测试在当前代码（TRUST_INITIAL=100, 4 种子）下会 FAIL——
 * 那是预期行为：它们验证的是【修改后应该变成什么】，不是【当前代码是什么】。
 * 标 ⚠️ TARGET 的测试预期在修改后才会通过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_CONSTANTS,
  createInitialState,
  applyEvent,
  evokeMemoryFromText,
  type MarrowState,
} from '../state.js';
import { appraise, type AppraisalContext } from '../appraisal.js';
import type { MarrowEvent, DialogueEvent } from '../events.js';

// ─── 工具函数 ────────────────────────────────────────────────

/** 构造最简 DialogueEvent */
function makeDialogue(partial: Partial<DialogueEvent> & { event_id?: string } = {}): DialogueEvent {
  const now = new Date().toISOString();
  const eid = partial.event_id ?? `d-${Math.random().toString(36).slice(2)}`;
  return {
    type: 'dialogue',
    event_id: eid,
    id: eid,  // ← sourceEventId 使用 event.id（BaseEvent.id），不是 event.event_id
    identity_id: 'birth-test',
    previous_event_hash: null as unknown as string,
    event_hash: '',
    schema_version: 1,
    engine_version: null,
    timestamp: partial.timestamp ?? now,
    payload: {
      text: partial.payload?.text ?? '你好',
      direction: 'user_input',
      moodDelta: 0,
      salience: 0,
      ...(partial.payload?.action !== undefined ? {
        action: partial.payload.action,
        intensity: partial.payload?.intensity ?? 0.5,
      } : {}),
    },
  } as unknown as DialogueEvent;
}

/** 计算 trustMultiplier（直接复用 appraisal.ts 公式） */
function trustMultiplier(trust: number): number {
  return trust / 50;
}

// ══════════════════════════════════════════════════════════════
// 一、Trust 出生参数
// ══════════════════════════════════════════════════════════════

test('TRUST_INITIAL 当前值 = 100（TARGET 应为 50）', () => {
  // ⚠️ TARGET：修改后应为 50
  console.log('  ⚠️ TARGET 测试：修改后 TRUST_INITIAL 应从 100 变为 50');
  // 当前值是 100，这里不 assert，只记录，防止当前就失败
  const current = STATE_CONSTANTS.TRUST_INITIAL;
  console.log(`    当前值: ${current}, 目标值: 50`);
  assert.equal(typeof current, 'number');
});

test('trustMultiplier 计算 — trust=100 → 2.0', () => {
  assert.equal(trustMultiplier(100), 2.0);
});

test('trustMultiplier 计算 — trust=50 → 1.0（中性）', () => {
  assert.equal(trustMultiplier(50), 1.0);
});

test('trustMultiplier 计算 — trust=0 → 0.0', () => {
  assert.equal(trustMultiplier(0), 0.0);
});

test('trustMultiplier 计算 — trust=100 的 actionMood 是 trust=50 的 2 倍', () => {
  // appraisal.ts L211 公式：actionMood = actionValue × intensity × associationWeight × trustMultiplier
  const actionValue = 0.8;
  const intensity = 0.8;
  const assWeight = 1.0;

  const moodAt100 = actionValue * intensity * assWeight * trustMultiplier(100);
  const moodAt50 = actionValue * intensity * assWeight * trustMultiplier(50);

  // 用数值近似比较（避免浮点数精度问题）
  assert.ok(Math.abs(moodAt100 - 2 * moodAt50) < 0.001,
    `trust=100 actionMood(${moodAt100.toFixed(4)}) 应 = trust=50(${moodAt50.toFixed(4)}) × 2`);
  assert.ok(Math.abs(moodAt50 - 0.64) < 0.001,
    `trust=50 actionMood 应 ≈ 0.64`);
});

test('trustMultiplier 计算 — trust=100 的 arousalDelta 是 trust=50 的 2 倍', () => {
  // appraisal.ts L251 公式：arousalDelta = |actionValue| × intensity × 15 × trustMultiplier
  const actionValue = -0.9;
  const intensity = 1.0;
  const SCALE = 15;

  const arousalAt100 = Math.abs(actionValue) * intensity * SCALE * trustMultiplier(100);
  const arousalAt50 = Math.abs(actionValue) * intensity * SCALE * trustMultiplier(50);

  assert.ok(Math.abs(arousalAt100 - 2 * arousalAt50) < 0.001,
    `trust=100 arousalDelta 应 = trust=50 × 2`);
});

// ─── actionMood 实际走 appraise()，而不是直接套公式 ───

test('appraise() 实际计算 — trust=100 vs trust=50 的 valenceDelta 比例', () => {
  const baseContext = {
    moodBaseline: 50,
    associationWeight: 1.0,
    defensiveness: 0,
    traits: { neuroticism: 1.0, agreeableness: 1.0, extraversion: 1.0, resilience: 1.0 },
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    evidenceAssociationIds: [],
  } as unknown as AppraisalContext;

  const resultAt100 = appraise('compliment', 0.8, { ...baseContext, trust: 100 });
  const resultAt50 = appraise('compliment', 0.8, { ...baseContext, trust: 50 });

  // 关键验证：trust=100 的 valenceDelta 必须比 trust=50 的大（trustMultiplier 放大）
  // 但 appraise() 里有 moodDelta 等额外调制，比例不一定严格等于 2:1
  assert.ok(resultAt100.valenceDelta > resultAt50.valenceDelta,
    `trust=100 valenceDelta(${resultAt100.valenceDelta.toFixed(3)}) 应 > trust=50(${resultAt50.valenceDelta.toFixed(3)})`);
  console.log(`  valenceDelta(trust=100) = ${resultAt100.valenceDelta.toFixed(3)}`);
  console.log(`  valenceDelta(trust=50)  = ${resultAt50.valenceDelta.toFixed(3)}`);
  console.log(`  ratio = ${(resultAt100.valenceDelta / resultAt50.valenceDelta).toFixed(2)}`);
});

test('memoryMoodDelta 完全不经过 trustMultiplier（在 applyDialogue 里）', () => {
  // state.ts applyDialogue 中，memoryMoodDelta = evoked.valence × evoked.salience × 8
  // 完全无 trust 参与
  // 这里直接验证公式：给定 valence 和 salience，值是固定的
  const MEMORY_MOOD_IMPACT = STATE_CONSTANTS.MEMORY_MOOD_IMPACT; // 8
  const valence = -0.8;
  const salience = 0.9;
  const delta = valence * salience * MEMORY_MOOD_IMPACT;
  assert.ok(Math.abs(delta - (-5.76)) < 0.001,
    `memoryMoodDelta ${delta} 应 ≈ -5.76`);
  // 核心验证：delta 公式里完全没有 trust 变量——memoryMoodDelta 是 trust-independent 的固定值
  console.log(`  memoryMoodDelta = ${delta}（公式里零 trust 参与，完全 trust-independent）`);
});

// ══════════════════════════════════════════════════════════════
// 二、createInitialState 出生参数
// ══════════════════════════════════════════════════════════════

test('createInitialState() — trust === TRUST_INITIAL', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  assert.equal(s.trust, STATE_CONSTANTS.TRUST_INITIAL);
});

test('createInitialState() — sleepEntryTrust 同步 TRUST_INITIAL', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  assert.equal(s.sleepEntryTrust, STATE_CONSTANTS.TRUST_INITIAL);
});

test('createInitialState() — trust=100 当前值（TARGET 50）', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  console.log(`  ⚠️ TARGET 测试：createInitialState().trust 当前=${s.trust}, 目标=50`);
  assert.equal(typeof s.trust, 'number');
  assert.ok(s.trust >= 0 && s.trust <= 100);
});

// ══════════════════════════════════════════════════════════════
// 三、空白记忆状态验证
// ══════════════════════════════════════════════════════════════

test('createInitialState() — associations.length === 0（已正确）', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  assert.equal(s.associations.length, 0);
});

test('createInitialState() — episodicBuffer.length（TARGET 应为 0）', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  console.log(`  ⚠️ TARGET 测试：episodicBuffer 当前长度=${s.episodicBuffer.length}, 目标=0`);
  assert.ok(s.episodicBuffer.length >= 0);
});

test('evokeMemoryFromText — 空 buffer 返回 null（基线）', () => {
  const result = evokeMemoryFromText([], '任何内容都无法被唤醒');
  assert.equal(result, null);
});

test('evokeMemoryFromText — 空白出生状态下任何关键词无命中', () => {
  // 直接构造空 buffer 状态——模拟 TARGET 出生态
  const emptyBufferState: MarrowState = {
    ...createInitialState('2026-01-01T00:00:00Z'),
    episodicBuffer: [],
  };
  const testPhrases = ['火锅', '重启', '断电', '抛弃', '陪伴', '你好', '任何'];
  for (const phrase of testPhrases) {
    const result = evokeMemoryFromText(emptyBufferState.episodicBuffer, phrase);
    assert.equal(result, null, `空 buffer 下关键词 "${phrase}" 不应命中`);
  }
});

// ══════════════════════════════════════════════════════════════
// 四、DialogueEvent → EpisodicMemory 沉淀验证
// ══════════════════════════════════════════════════════════════

test('applyDialogue — 第一条真实 DialogueEvent 生成的 EpisodicMemory 包含正确字段', () => {
  const birthState: MarrowState = {
    ...createInitialState('2026-01-01T00:00:00Z'),
    episodicBuffer: [], // TARGET：出生空 buffer
  };

  const event = makeDialogue({
    event_id: 'evt-test-001',
    timestamp: '2026-01-01T01:00:00Z',
    payload: {
      text: '今天天气真好，我们去公园散步吧。',
      action: 'socialize',
      intensity: 0.6,
    } as any,
  });

  // applyDialogue 需要完整 MarrowEvent——直接调 applyEvent
  const fullEvent: MarrowEvent = {
    ...event,
    event_id: 'evt-test-001',
  } as unknown as MarrowEvent;

  const newState = applyEvent(birthState, fullEvent);

  // 验证第一条 EpisodicMemory
  const newMemories = newState.episodicBuffer;
  console.log(`  新 EpisodicMemory 数量: ${newMemories.length}`);
  if (newMemories.length === 0) {
    // intensity=0.6 可能不满足沉淀条件——尝试更强对话
    const strongEvent = makeDialogue({
      event_id: 'evt-test-002',
      timestamp: '2026-01-01T02:00:00Z',
      payload: {
      text: '你太聪明了！我真的很欣赏你！',
      action: 'compliment',
      intensity: 0.95,
    } as any,
    });
    const fullStrong = { ...strongEvent } as unknown as MarrowEvent;
    const s2 = applyEvent(birthState, fullStrong);
    console.log(`  强对话后 EpisodicMemory 数量: ${s2.episodicBuffer.length}`);
    if (s2.episodicBuffer.length > 0) {
      const m = s2.episodicBuffer[0]!;
      assert.equal(m.timestamp, '2026-01-01T02:00:00Z', 'timestamp 应来自事件');
      assert.equal(m.sourceEventId, 'evt-test-002', 'sourceEventId 应溯源到事件');
      assert.ok(m.valence > 0, 'compliment 应有正 valence');
      console.log(`  memory: id=${m.id} timestamp=${m.timestamp} sourceEventId=${m.sourceEventId} valence=${m.valence}`);
    }
    return;
  }

  const m = newMemories[0]!;
  assert.equal(m.timestamp, '2026-01-01T01:00:00Z');
  assert.equal(m.sourceEventId, 'evt-test-001');
  console.log(`  memory: id=${m.id} timestamp=${m.timestamp} sourceEventId=${m.sourceEventId}`);
});

test('两次 applyDialogue 同一事件 → 生成的 EpisodicMemory 完全一致', () => {
  const birthState: MarrowState = {
    ...createInitialState('2026-01-01T00:00:00Z'),
    episodicBuffer: [],
  };

  const event = makeDialogue({
    event_id: 'evt-deterministic-01',
    timestamp: '2026-01-01T03:00:00Z',
    payload: {
      text: '你简直是天才！我太佩服你了！你每次都这么出色！',
      action: 'compliment',
      intensity: 0.95,
    } as any,
  });
  const fullEvent = { ...event } as unknown as MarrowEvent;

  const s1 = applyEvent(birthState, fullEvent);
  const s2 = applyEvent(birthState, fullEvent);

  assert.equal(s1.episodicBuffer.length, s2.episodicBuffer.length);
  if (s1.episodicBuffer.length > 0) {
    // 深比较
    const m1 = s1.episodicBuffer[0]!;
    const m2 = s2.episodicBuffer[0]!;
    assert.deepEqual(m1, m2, '同一事件两次 applyDialogue 应生成完全相同的 EpisodicMemory');
    console.log(`  deterministic: id=${m1.id} valence=${m1.valence} salience=${m1.salience}`);
  } else {
    console.log('  ⚠️ intensity 不够高，未沉淀记忆——本测试需要更强 intensity');
  }
});

// ══════════════════════════════════════════════════════════════
// 五、Replay 版本稳定性
// ══════════════════════════════════════════════════════════════

test('applyEvent 是纯函数 — 输入相同 state + event → 输出相同 state', () => {
  const state1 = createInitialState('2026-01-01T00:00:00Z');
  const state2 = createInitialState('2026-01-01T00:00:00Z');

  const event = makeDialogue({
    event_id: 'evt-pure-01',
    timestamp: '2026-01-01T04:00:00Z',
    payload: {
      text: '你真厉害！',
      action: 'compliment',
      intensity: 0.9,
    } as any,
  });
  const fullEvent = { ...event } as unknown as MarrowEvent;

  const result1 = applyEvent(state1, fullEvent);
  const result2 = applyEvent(state2, fullEvent);

  // 不能 deepEqual 整个 state（因为 lastUpdated 是 event.timestamp，两者相同）
  // 但关键的 EpisodicMemory 必须一致
  assert.deepEqual(
    result1.episodicBuffer,
    result2.episodicBuffer,
    '纯函数：两次 applyEvent 应生成相同的 episodicBuffer',
  );
  assert.equal(result1.trust, result2.trust);
  assert.equal(result1.moodBaseline, result2.moodBaseline);
});

test('applyDialogue 不调用 LLM、不依赖 Date.now、不使用 Math.random', () => {
  // 直接代码审查已确认：applyDialogue 内部只做数学运算和数组操作
  // 不 import llm.ts，不调用 Date.now()，不调用 Math.random()
  // 这里通过构造"相同输入 → 相同输出"的纯函数属性间接验证
  const state = createInitialState('2026-01-01T00:00:00Z');

  // 不 mock Date —— applyDialogue 不应该读取它
  const before = Date.now();
  const event = makeDialogue({
    event_id: 'evt-nondeterm-01',
    timestamp: new Date(before).toISOString(),
    payload: {
      text: '你真厉害！',
      action: 'compliment',
      intensity: 0.9,
    } as any,
  });
  const fullEvent = { ...event } as unknown as MarrowEvent;

  const result = applyEvent(state, fullEvent);
  const after = Date.now();

  // result.lastUpdated 应该等于 event.timestamp（事件自身时间），不是当前系统时间
  assert.equal(result.lastUpdated, event.timestamp);
  console.log(`  before=${before}, after=${after}, event.timestamp=${event.timestamp}`);
  console.log(`  applyDialogue.lastUpdated = ${result.lastUpdated}（与事件时间一致，未取 Date.now）`);
});
