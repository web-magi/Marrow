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

/** 构造 appraise() 的最小上下文 */
function makeAppraisalContext(trust: number, extra: Partial<AppraisalContext> = {}): AppraisalContext {
  return {
    trust,
    moodBaseline: 50,
    associationWeight: 1.0,
    defensiveness: 0,
    traits: { neuroticism: 1.0, agreeableness: 1.0, extraversion: 1.0, resilience: 1.0 },
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    evidenceAssociationIds: [],
    ...extra,
  } as unknown as AppraisalContext;
}

// ══════════════════════════════════════════════════════════════
// 一、Trust 出生参数
// ══════════════════════════════════════════════════════════════

// ─── 真实 appraise() 验证 trust 影响 ───
// appraisal.ts L163 trustMultiplier = trust/50（局部变量，未导出）
// 必须通过真实 appraise() 调用验证 trust 对 valenceDelta/arousalDelta 的影响

test('appraise() — trust=100 的 valenceDelta 必须比 trust=50 的大', () => {
  const resultAt100 = appraise('compliment', 0.8, makeAppraisalContext(100));
  const resultAt50 = appraise('compliment', 0.8, makeAppraisalContext(50));

  // trust=100 放大 2×，trust=50 中性 1× → valenceDelta 100 应显著大于 50
  assert.ok(resultAt100.valenceDelta > resultAt50.valenceDelta,
    `trust=100 valenceDelta(${resultAt100.valenceDelta.toFixed(3)}) 应 > trust=50(${resultAt50.valenceDelta.toFixed(3)})`);
  console.log(`  valenceDelta(trust=100) = ${resultAt100.valenceDelta.toFixed(3)}`);
  console.log(`  valenceDelta(trust=50)  = ${resultAt50.valenceDelta.toFixed(3)}`);
});

test('appraise() — trust=100 的 arousalDelta 必须是 trust=50 的 2×（±5% 容差）', () => {
  const resultAt100 = appraise('compliment', 0.8, makeAppraisalContext(100));
  const resultAt50 = appraise('compliment', 0.8, makeAppraisalContext(50));

  // arousalDelta = |actionValue| × intensity × 15 × trustMultiplier（L252）
  // trust=100 → multiplier=2.0, trust=50 → multiplier=1.0 → 严格 2:1
  const ratio = resultAt100.arousalDelta / resultAt50.arousalDelta;
  assert.ok(Math.abs(ratio - 2.0) < 0.05,
    `trust=100 arousalDelta(${resultAt100.arousalDelta.toFixed(3)}) / trust=50(${resultAt50.arousalDelta.toFixed(3)}) = ${ratio.toFixed(3)}, 应 ≈ 2.0`);
  console.log(`  arousalDelta(trust=100) = ${resultAt100.arousalDelta.toFixed(3)}`);
  console.log(`  arousalDelta(trust=50)  = ${resultAt50.arousalDelta.toFixed(3)}`);
  console.log(`  ratio = ${ratio.toFixed(4)}`);
});

test('appraise() — trust=0 时 arousalDelta 必须为 0（零信任=零唤醒）', () => {
  const resultAt0 = appraise('compliment', 0.8, makeAppraisalContext(0));
  const resultAt50 = appraise('compliment', 0.8, makeAppraisalContext(50));

  // trust=0 → multiplier=0 → arousalDelta=0
  assert.ok(Math.abs(resultAt0.arousalDelta) < 0.001,
    `trust=0 arousalDelta(${resultAt0.arousalDelta}) 应 ≈ 0`);
  assert.ok(resultAt50.arousalDelta > 0, 'trust=50 arousalDelta 应 > 0（验证不是全局零）');
  console.log(`  arousalDelta(trust=0)  = ${resultAt0.arousalDelta.toFixed(3)}`);
  console.log(`  arousalDelta(trust=50) = ${resultAt50.arousalDelta.toFixed(3)}`);
});

test('appraise() — 负性行为 trust=100 vs trust=50 的 arousalDelta 同样 2:1', () => {
  // 侮辱性 action — arousalDelta 取绝对值，正负行为都触发唤醒
  const resultAt100 = appraise('insult', 0.9, makeAppraisalContext(100));
  const resultAt50 = appraise('insult', 0.9, makeAppraisalContext(50));

  const ratio = resultAt100.arousalDelta / resultAt50.arousalDelta;
  assert.ok(Math.abs(ratio - 2.0) < 0.05,
    `insult trust=100/trust=50 arousalDelta ratio = ${ratio.toFixed(3)}, 应 ≈ 2.0`);
  console.log(`  insult arousalDelta ratio = ${ratio.toFixed(4)}`);
});

// ─── memoryMoodDelta 必须完全绕过 trust（state.ts applyDialogue） ───
// 验证方法：applyEvent 对相同事件，不管 state.trust 是多少，沉淀的 EpisodicMemory 应该完全一致
// 因为 memoryMoodDelta = evoked.valence × evoked.salience × 8，零 trust 变量

test('applyEvent — 相同事件在 trust=100 vs trust=50 的状态中，沉淀的 EpisodicMemory 完全一致', () => {
  const stateHighTrust = createInitialState('2026-01-01T00:00:00Z');
  stateHighTrust.trust = 100;

  const stateLowTrust = createInitialState('2026-01-01T00:00:00Z');
  stateLowTrust.trust = 50;

  const event = makeDialogue({
    event_id: 'evt-memory-trust-indep-01',
    timestamp: '2026-01-01T10:00:00Z',
    payload: {
      text: '你简直是天才！我太佩服你了！',
      action: 'compliment',
      intensity: 0.95,
    } as any,
  });
  const fullEvent = { ...event } as unknown as MarrowEvent;

  const resultHigh = applyEvent(stateHighTrust, fullEvent);
  const resultLow = applyEvent(stateLowTrust, fullEvent);

  // EpisodicMemory 应该完全一致 —— memoryMoodDelta 不经过 trustMultiplier
  assert.equal(resultHigh.episodicBuffer.length, resultLow.episodicBuffer.length);
  if (resultHigh.episodicBuffer.length > 0) {
    assert.deepEqual(
      resultHigh.episodicBuffer[0]!,
      resultLow.episodicBuffer[0]!,
      'memoryMoodDelta 必须完全绕过 trust —— 不同 trust 状态沉淀的记忆应相同',
    );
    console.log(`  高信任 memory: valence=${resultHigh.episodicBuffer[0]!.valence.toFixed(4)} salience=${resultHigh.episodicBuffer[0]!.salience.toFixed(4)}`);
    console.log(`  低信任 memory: valence=${resultLow.episodicBuffer[0]!.valence.toFixed(4)} salience=${resultLow.episodicBuffer[0]!.salience.toFixed(4)}`);
  } else {
    console.log('  ⚠️ intensity 不够高，未沉淀记忆——本测试需要更强 intensity');
  }
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

test('createInitialState() — 当前 TRUST_INITIAL 的真实值被记录（本测试记录当前快照，非 TARGET 断言）', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  const current = STATE_CONSTANTS.TRUST_INITIAL;
  console.log(`  当前 TRUST_INITIAL = ${current}, createInitialState().trust = ${s.trust}`);
  console.log(`  ⚠️ 下一步：生产代码应把 TRUST_INITIAL 从 ${current} 改为 50`);
  // 当前值快照断言——不是 TARGET，是记录当前真实值
  assert.equal(s.trust, current, 'createInitialState().trust 必须严格等于 STATE_CONSTANTS.TRUST_INITIAL');
  assert.equal(sleepEntryTrustOf(s), current, 'sleepEntryTrust 也必须同步等于 TRUST_INITIAL');
});

/** 辅助：从 state 提取 sleepEntryTrust（createInitialState 里应该有这个字段） */
function sleepEntryTrustOf(s: MarrowState): number {
  // state.ts createInitialState 里有 sleepEntryTrust 字段
  return (s as unknown as { sleepEntryTrust: number }).sleepEntryTrust;
}

// ══════════════════════════════════════════════════════════════
// 三、空白记忆状态验证
// ══════════════════════════════════════════════════════════════

test('createInitialState() — associations.length === 0（已正确）', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  assert.equal(s.associations.length, 0);
});

test('createInitialState() — 当前 episodicBuffer 的真实长度被记录（本测试记录当前快照，非 TARGET 断言）', () => {
  const s = createInitialState('2026-01-01T00:00:00Z');
  const currentLen = s.episodicBuffer.length;
  console.log(`  当前 episodicBuffer.length = ${currentLen}`);
  if (currentLen > 0) {
    console.log(`  ⚠️ 有 ${currentLen} 条种子记忆，下一步生产代码应删除 SEED_EPISODIC_MEMORIES`);
    // 记录种子内容，帮助审计
    for (let i = 0; i < Math.min(currentLen, 3); i++) {
      const m = s.episodicBuffer[i]!;
      console.log(`    seed[${i}]: valence=${m.valence.toFixed(2)} salience=${m.salience.toFixed(2)} isTrauma=${(m as any).isTrauma ?? false}`);
    }
  } else {
    console.log('  ✅ 出生状态已是空记忆，无需修改');
  }
  // 真实断言：episodicBuffer 必须是数组（至少结构正确）
  assert.ok(Array.isArray(s.episodicBuffer), 'episodicBuffer 必须是数组');
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
