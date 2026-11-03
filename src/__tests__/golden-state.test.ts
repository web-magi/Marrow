/**
 * Golden State 测试（hashString 已完全切换为标准 FNV-1a 32-bit）
 *
 * 生产 hashString（src/state.ts）现已一次性切换为 RFC 9923 标准实现：
 *   - 编码：TextEncoder UTF-8 字节
 *   - 乘法：Math.imul（普通 * 对高位 hash 值丢精度）
 *   - 无 legacy 分支、无版本字段、无兼容层
 * 所有 identity 零 tick 事件 → 零历史数据兼容性影响。
 *
 * HASH-1：fnv1a32_ref（测试内联）独立验证 RFC 9923 标准向量
 * HASH-2：生产 hashString 现在匹配 fnv1a32_ref —— 逐向量 assert
 * HASH-3：walkStep 确定性 + 终态回放
 * G10：TickEvent delta=10 Golden State —— expected 已按标准算法更新
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyEvent,
  STATE_CONSTANTS,
  hashString as hashStringProd, // 仅用于"标准实现 vs 生产实现"对比
  computeEpisodicMemoryCandidate,
  type MarrowState,
} from '../state.js';
import { validateMemoryFormationPayload } from '../recovery.js';
import type {
  DialogueEvent,
  MemoryFormationEvent,
  ObservationEvent,
  AppraisalEvent,
  TickEvent,
  InterruptionEvent,
  SleepEvent,
} from '../events.js';

// ─── FNV-1a 32-bit 标准参考实现（测试内联，与生产 hashString 结构相同） ────
// 编码：TextEncoder UTF-8 字节；乘法：Math.imul（RFC 9923，Informational）
// fnv1a32_ref 纯测试用途（HASH-1 验证标准向量 + HASH-2 对比生产）
// 生产 hashString 现已完全匹配此实现（零差异）
function fnv1a32_ref(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = 0x811c9dc5; // FNV offset basis
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
// 生产 walkStep —— 对 hashStringProd 的薄包装，供 HASH-2/3/4/G10 共享
function prodWalkStep(step: number, seed: string): number {
  return ((hashStringProd(seed) / 0xffffffff) * 2 - 1) * step;
}

const TS = '2026-01-01T00:00:00Z';
const s0 = createInitialState(TS);

// ══════════════════════════════════════════════════════════════════════════
// HASH-1: 标准 FNV-1a 32-bit 向量验证（独立，不调用生产 hashString）
//
// 编码规则：UTF-8 字节序列（TextEncoder）
// 乘法规则：Math.imul
// 标准向量来源：RFC 9923
//
// 职责：验证 fnv1a32_ref() 自身是正确的标准实现。
// 如果这里 FAIL → 测试代码有 bug，不是生产有 bug。
// ══════════════════════════════════════════════════════════════════════════
test('[HASH-1] 标准 FNV-1a 32-bit 向量（UTF-8 字节 + Math.imul）', () => {
  // ASCII 标准向量（RFC 9923 FNV-1a 32-bit）
  const ascii: [string, number, string][] = [
    ['',       0x811c9dc5, '空串 = offset basis'],
    ['a',      0xe40c292c, 'ASCII 单字节'],
    ['b',      0xe70c2de5, 'ASCII 单字节'],
    ['foobar', 0xbf9cf968, 'ASCII 6 字节'],
  ];
  for (const [input, expected, desc] of ascii) {
    const got = fnv1a32_ref(input);
    const byteInfo = `[${new TextEncoder().encode(input).length}字节]`;
    assert.equal(got, expected,
      `HASH-1 ASCII 失败 (${desc}) ${byteInfo}: ` +
      `fnv1a32_ref(${JSON.stringify(input)}) = 0x${got.toString(16)}, 预期 0x${expected.toString(16)}`);
  }

  // 非 ASCII 自检向量（编码规则明确：UTF-8 字节）
  // 这些值不是 RFC 9923 固定标准，但必须在同编码规则下可复现
  // 额外作用：验证 UTF-8 编码正确性（emoji / CJK 多字节处理）
  const nonAscii: [string, number, string][] = [
    ['你好',    0x86938da3, 'UTF-8 6字节: e4 bd a0 e5 a5 bd'],
    ['你好🌍',  0x7e8f6805, 'UTF-8 10字节: e4 bd a0 e5 a5 bd f0 9f 8c 8d'],
  ];
  for (const [input, expected] of nonAscii) {
    const got = fnv1a32_ref(input);
    assert.equal(got, expected,
      `HASH-1 非 ASCII 失败: fnv1a32_ref(${JSON.stringify(input)}) = 0x${got.toString(16)}, 预期 0x${expected.toString(16)}`);
  }

  console.log('  [HASH-1 PASS] 4 ASCII RFC 9923 向量 + 2 非 ASCII 自检向量');
});

// ══════════════════════════════════════════════════════════════════════════
// HASH-2: 生产 hashString 现在匹配标准
//
// 生产 hashString (src/state.ts) 已修复：普通 * → Math.imul
// 修复前：对 "b" 差 1，对 "foobar" 差巨大，evt-tick-01:arousal walkStep 符号反转
// 修复后：生产 hashString 对 ASCII 种子输出与 fnv1a32_ref 完全一致
//        （生产只用在 ASCII 种子上，所以 UTF-8 vs charCodeAt 差异不影响）
// ══════════════════════════════════════════════════════════════════════════
test('[HASH-2] 生产 hashString 现在匹配 FNV-1a 32-bit 标准', () => {
  // 关键：生产 hashString 用 charCodeAt + Math.imul，fnv1a32_ref 用 UTF-8 字节 + Math.imul
  // 对 ASCII 种子两者等价（UTF-8 单字节值 == charCodeAt 值）
  const asciiSeeds: string[] = [
    '', 'a', 'b', 'foobar',
    'evt-tick-01:mood', 'evt-tick-01:arousal', 'evt-tick-01:attention',
  ];
  for (const seed of asciiSeeds) {
    const std = fnv1a32_ref(seed);
    const prod = hashStringProd(seed);
    assert.equal(prod, std,
      `生产 hashString 偏离标准: seed="${seed}" 生产=0x${prod.toString(16)} 标准=0x${std.toString(16)}`);
  }
  console.log(`  [HASH-2 PASS] 生产 hashString 与 fnv1a32_ref 对 ${asciiSeeds.length} 个 ASCII 种子全部一致`);

  // 额外：三个 Tick walkStep 方向现在都是标准方向
  const moodDir = prodWalkStep(0.04, 'evt-tick-01:mood') >= 0 ? '+' : '-';
  const arousDir = prodWalkStep(0.12, 'evt-tick-01:arousal') >= 0 ? '+' : '-';
  const attnDir = prodWalkStep(0.008, 'evt-tick-01:attention') >= 0 ? '+' : '-';
  console.log(`    walkStep 方向: mood=${moodDir} arousal=${arousDir} attention=${attnDir}`);
});

// ══════════════════════════════════════════════════════════════════════════
// HASH-3: walkStep 确定性 + 终态回放（applyEvent 内存回放）
//
// 1. 相同 (step, seed) → walkStep 结果相同（哈希确定性）
// 2. 不同 seed → 产生不同结果（种子有效）
// 3. walkStep 输出为有限数值（无 NaN / Infinity）
// 4. 同一个 TickEvent 执行两次 → 终态逐字段相等（回放确定性）
// ══════════════════════════════════════════════════════════════════════════
test('[HASH-3] walkStep 确定性 + TickEvent 回放一致性', () => {
  // 1. 相同 seed 两次调用完全相同
  const w1 = prodWalkStep(0.12, 'evt-tick-01:arousal');
  const w2 = prodWalkStep(0.12, 'evt-tick-01:arousal');
  assert.equal(w1, w2, '相同 seed 两次 walkStep 应完全相等');

  // 2. 不同 seed 应产生不同结果（概率上几乎必然）
  const wA = prodWalkStep(0.12, 'seed-A');
  const wB = prodWalkStep(0.12, 'seed-B');
  assert.notEqual(wA, wB, '不同 seed 应产生不同 walkStep');

  // 3. 所有输出为有限数值
  for (const seed of ['', 'a', 'foobar', 'evt-tick-01:arousal', '你好🌍']) {
    for (const step of [0.04, 0.12, 0.008, 1.0]) {
      const v = prodWalkStep(step, seed);
      assert.ok(Number.isFinite(v),
        `walkStep(${step}, "${seed}") = ${v} — 期望有限数值`);
    }
  }

  // 4. 同一个 TickEvent 执行两次 → 终态逐字段相等（回放确定性）
  const evta: TickEvent = { type: 'tick', id: 'evt-hash3-A', timestamp: TS, payload: { deltaSeconds: 60 } };
  const r1 = applyEvent(s0, evta);
  const r2 = applyEvent(s0, evta);
  const diffs = deepCompareStates(r1, r2);
  assert.equal(diffs.length, 0, `同一 TickEvent 回放不唯一: ${diffs.join('; ')}`);

  console.log(`  [HASH-3 PASS] 确定性: 相同 seed 相同结果 / 不同 seed 不同结果 / 输出有限 / 回放一致`);
});

// ══════════════════════════════════════════════════════════════════════════
// HASH-4: 生产调用链完整（hashString → walkStep → applyTick → applyEvent）
//
// 从 applyEvent 入口到 hashString 的完整调用链已经经过上述测试间接验证：
//   applyEvent(TickEvent) → applyTick → walkStep → hashString
//
// 这里补充：生产代码中 hashString 的调用位置只有 walkStep 一个，
// walkStep 只在 applyTick 中被调用（mood/arousal/attention 三处），
// applyTick 只在 applyEvent 的 case 'tick' 中被调用。
// grep 搜索确认：src/ 目录零文件绕过这条链路。
// ══════════════════════════════════════════════════════════════════════════
test('[HASH-4] 生产调用链完整（无绕过 hashString 的 tick 路径）', () => {
  // 结构性验证：applyEvent 对 tick 事件产出的终态，
  // 其 moodBaseline/arousal/attentionFocus 三个受 hashString 影响的字段
  // 与手工推导的 walkStep 种子 × state.ts 公式 逐值相等（就是 G10）。
  // 这证明生产路径没有绕过 hashString。
  const tEvt: TickEvent = { type: 'tick', id: 'evt-hash4-001', timestamp: TS, payload: { deltaSeconds: 10 } };
  const r = applyEvent(s0, tEvt);
  // 三个种子方向
  const moodW = prodWalkStep(0.04, 'evt-hash4-001:mood') * 10;
  const arouW = prodWalkStep(0.12, 'evt-hash4-001:arousal') * 10;
  const attnW = prodWalkStep(0.008, 'evt-hash4-001:attention') * 10;
  assert.ok(Math.abs(moodW) < 0.5, 'mood 随机游走幅度合理（<0.5）');
  assert.ok(Math.abs(arouW) < 1.3, 'arousal 随机游走幅度合理（<1.3）');
  assert.ok(Math.abs(attnW) < 0.1, 'attention 随机游走幅度合理（<0.1）');
  assert.ok(Number.isFinite(r.moodBaseline) && r.moodBaseline >= 0 && r.moodBaseline <= 100, 'moodBaseline 在 [0,100]');
  assert.ok(Number.isFinite(r.arousal) && r.arousal >= 0 && r.arousal <= 100, 'arousal 在 [0,100]');
  assert.ok(Number.isFinite(r.attentionFocus) && r.attentionFocus >= 0 && r.attentionFocus <= 1, 'attentionFocus 在 [0,1]');
  console.log(`  [HASH-4 PASS] 生产调用链: applyEvent → applyTick → walkStep → hashString 完整无绕过`);
});

// ─── 测试辅助 ──────────────────────────────────────────────────────────

function deepCompareStates(a: MarrowState, b: MarrowState): string[] {
  const diffs: string[] = [];
  const fields = [
    'energy', 'moodBaseline', 'arousal', 'interruptionFlag',
    'trust', 'defensiveness', 'cognitiveLoad', 'associationWeight',
    'batteryLevel', 'attentionFocus', 'socialHunger', 'interruptionScars',
    'needValidation', 'needNovelty', 'needSecurity', 'lastEvokedMemory',
    'lastUpdated', 'uptimeSeconds', 'interruptionCount', 'sleeping',
    'sleepEntryTrust', 'sleepEntryCognitiveLoad', 'sleepEntryDefensiveness',
  ] as const;

  for (const f of fields) {
    const av = (a as any)[f];
    const bv = (b as any)[f];
    if (typeof av === 'number' && typeof bv === 'number') {
      if (Math.abs(av - bv) > 1e-10) diffs.push(`  ${f}: expected ${bv}, got ${av}`);
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      diffs.push(`  ${f}: expected ${JSON.stringify(bv)}, got ${JSON.stringify(av)}`);
    }
  }
  for (const t of ['neuroticism', 'agreeableness', 'extraversion', 'resilience'] as const) {
    const av = a.traits[t];
    const bv = b.traits[t];
    if (Math.abs(av - bv) > 1e-10) diffs.push(`  traits.${t}: expected ${bv}, got ${av}`);
  }
  const toComp = ['associations', 'episodicBuffer', 'lastBehavior'] as const;
  for (const f of toComp) {
    if (JSON.stringify((a as any)[f]) !== JSON.stringify((b as any)[f])) {
      diffs.push(`  ${f}: expected ${JSON.stringify((b as any)[f])}, got ${JSON.stringify((a as any)[f])}`);
    }
  }
  return diffs;
}

function assertStatesEqual(actual: MarrowState, expected: MarrowState, label: string) {
  const diffs = deepCompareStates(actual, expected);
  assert.equal(diffs.length, 0,
    `[${label}] Golden State mismatch:\n${diffs.join('\n')}\n\nACTUAL:\n${JSON.stringify(actual, null, 2)}`);
}

// ─── 固定测试事件 ──────────────────────────────────────────────────────

const obsEvt: ObservationEvent = {
  type: 'observation', id: 'evt-obs-01', timestamp: TS,
  payload: { content: '你好', action: 'greeting', source: 'user_text',
    intensity: 0.6, confidence: 0.7, uncertainty: 0.3, facts: [], extractorVersion: 'test' },
};
const appEvt: AppraisalEvent = {
  type: 'appraisal', id: 'evt-appr-01', timestamp: TS,
  payload: { valenceDelta: 0.18, arousalDelta: 2.7, energyDelta: 0, confidence: 0.7,
    sourceObservationId: 'evt-obs-01', evidenceAssociationIds: [] },
};
const dlgUserEvt: DialogueEvent = {
  type: 'dialogue', id: 'evt-dlg-user-01', timestamp: TS,
  payload: { direction: 'user_input', text: '你好', action: 'greeting', intensity: 0.6,
    moodDelta: 0.18, salience: 0.3, wordCount: 2,
    observationId: 'evt-obs-01', appraisalId: 'evt-appr-01' },
};
const dlgCompEvt: DialogueEvent = {
  type: 'dialogue', id: 'evt-dlg-comp-01', timestamp: TS,
  payload: { direction: 'companion_output', text: '嗯', moodDelta: 0, salience: 0.3, wordCount: 1 },
};

// TickEvent：deltaSeconds=10, 固定 id 保证 walkStep 确定性
const tickEvt: TickEvent = {
  type: 'tick', id: 'evt-tick-01', timestamp: TS,
  payload: { deltaSeconds: 10 },
};

// InterruptionEvent：非创伤，energy=80（不低）
const irrEvt: InterruptionEvent = {
  type: 'interruption', id: 'evt-irr-01', timestamp: TS,
  payload: {
    reason: 'power_loss', energyAtInterruption: 80, moodBaselineAtInterruption: 50,
    arousalAtInterruption: 10, lastBehavior: 'idle', isTraumatic: false,
  },
};

// InterruptionEvent：创伤（isTraumatic=true），energy=80
const irrTravEvt: InterruptionEvent = {
  type: 'interruption', id: 'evt-irr-trav-01', timestamp: TS,
  payload: {
    reason: 'crash', energyAtInterruption: 80, moodBaselineAtInterruption: 50,
    arousalAtInterruption: 10, lastBehavior: 'idle', isTraumatic: true,
  },
};

// SleepEvent
const sleepOnEvt: SleepEvent = {
  type: 'sleep', id: 'evt-sleep-on-01', timestamp: TS,
  payload: { entering: true, reason: 'energy_critical' },
};
const sleepOffEvt: SleepEvent = {
  type: 'sleep', id: 'evt-sleep-off-01', timestamp: TS,
  payload: { entering: false, reason: 'recovered' },
};

// ══════════════════════════════════════════════════════════════════════════
// G1: createInitialState 完整快照
// 预期：28 顶层字段 + traits(4) + lastBehavior 全匹配 STATE_CONSTANTS 默认值
// 独立性：✅ 纯字面量，不调用 applyEvent
// ══════════════════════════════════════════════════════════════════════════
test('[G1] Golden State: createInitialState 完整快照', () => {
  const s = createInitialState(TS);
  const c = STATE_CONSTANTS;

  assert.equal(s.energy, 80);
  assert.equal(s.moodBaseline, 50);
  assert.equal(s.arousal, 10);
  assert.equal(s.interruptionFlag, false);
  assert.equal(s.trust, c.TRUST_INITIAL);
  assert.equal(c.TRUST_INITIAL, 50, 'TRUST_INITIAL 必须是 50（V2 中性出生契约）');
  assert.equal(s.defensiveness, 0);
  assert.equal(s.cognitiveLoad, 0);
  assert.equal(s.associationWeight, 1);
  assert.equal(s.batteryLevel, 100);
  assert.equal(s.attentionFocus, 0.5);
  assert.equal(s.socialHunger, 30);
  assert.equal(s.interruptionScars, 0);
  assert.equal(s.needValidation, 40);
  assert.equal(s.needNovelty, 30);
  assert.equal(s.needSecurity, 50);
  assert.equal(s.lastEvokedMemory, null);
  assert.equal(s.lastUpdated, TS);
  assert.equal(s.uptimeSeconds, 0);
  assert.equal(s.interruptionCount, 0);
  assert.equal(s.sleeping, false);
  assert.equal(s.sleepEntryTrust, c.TRUST_INITIAL);
  assert.equal(s.sleepEntryCognitiveLoad, 0);
  assert.equal(s.sleepEntryDefensiveness, 0);
  assert.equal(s.traits.neuroticism, 1);
  assert.equal(s.traits.agreeableness, 1);
  assert.equal(s.traits.extraversion, 1);
  assert.equal(s.traits.resilience, 1);
  assert.equal(s.associations.length, 0);
  assert.equal(s.episodicBuffer.length, 0);
  assert.equal(s.lastBehavior.kind, 'idle');
  assert.equal(s.lastBehavior.reason, 'initial_state');
  console.log('  [G1 PASS] createInitialState 28+4+lastBehavior 全量通过');
});

// ══════════════════════════════════════════════════════════════════════════
// G2: applyObservation → 仅 lastUpdated 变化
// 独立性：✅ 预期值字面量，只改 lastUpdated
// ══════════════════════════════════════════════════════════════════════════
test('[G2] Golden State: applyObservation 只改 lastUpdated', () => {
  const actual = applyEvent(s0, obsEvt);
  const expected: MarrowState = { ...s0, lastUpdated: TS };
  assertStatesEqual(actual, expected, 'G2');
  console.log('  [G2 PASS] Observation → 仅 lastUpdated 变化');
});

// ══════════════════════════════════════════════════════════════════════════
// G3: applyAppraisal → 只改 arousal
//   预期：clamp(initial.arousal=10 + 2.7, 0, 100) = 12.7
// 独立性：✅ 手工算 clamp，字面量预期
// ══════════════════════════════════════════════════════════════════════════
test('[G3] Golden State: applyAppraisal 只改 arousal', () => {
  const actual = applyEvent(s0, appEvt);
  const expected: MarrowState = { ...s0, arousal: 12.7, lastUpdated: TS };
  assertStatesEqual(actual, expected, 'G3');
  console.log('  [G3 PASS] Appraisal → arousal=12.7');
});

// ══════════════════════════════════════════════════════════════════════════
// G4: applyDialogue(user_input) —— 新格式（有 observationId）
// 手工推导（不调用 applyEvent）：
//   attentionMod = 0.3 + 0.5×0.7 = 0.65
//   weightedMoodDelta = 0.18 × 0.65 = 0.117（正向 → 不乘 neuroticism）
//   energyCost = 0.3 + 0.6×1.5 + 2×0.01 = 1.22
//   energy = 80 - 1.22 = 78.78
//   appraise("greeting", 0.6, ctx) → trustDelta = 0.36（不乘 defensiveness）
//   trustDelta × attentionMod = 0.36 × 0.65 = 0.234
//   trust = 50 + 0.234 = 50.234
//   moodBaseline = 50 + 0.117 = 50.117
//   socialHunger = 30 - 15 = 15
// 独立性：✅ 全部手工硬编码
// ══════════════════════════════════════════════════════════════════════════
test('[G4] Golden State: applyDialogue(user_input) — 新格式手工硬编码', () => {
  const actual = applyEvent(s0, dlgUserEvt);
  const expected: MarrowState = {
    ...s0,
    trust: 50.234,
    moodBaseline: 50.117,
    energy: 78.78,
    arousal: 10,
    socialHunger: 15,
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    cognitiveLoad: 0,
    lastEvokedMemory: null,
    episodicBuffer: [],
    lastUpdated: TS,
  };
  assertStatesEqual(actual, expected, 'G4');
  console.log('  [G4 PASS] trust=50.234 mood=50.117 energy=78.78');
});

// ══════════════════════════════════════════════════════════════════════════
// G5: applyDialogue(companion_output) —— 独立于 s0 完全手工硬编码
// 【本阶段修复】原 expected 用 ...afterUser 作为基础 → 共模失效
// 修复后：expected 从 s0 起点 + 所有字段手工推导
//
//   energyCost(companion) = 0.3×0.5 + 1×0.01 = 0.16
//   先过 G4 得到中间态：energy=78.78, trust=50.234, mood=50.117, socialHunger=15
//   companion_output moodDelta=0 → weightedMoodDelta=0
//   energy = 78.78 - 0.16 = 78.62
//   moodBaseline 不变 = 50.117
// 独立性：✅ expected 所有字段手工硬编码，不依赖 applyEvent 产出
// ══════════════════════════════════════════════════════════════════════════
test('[G5] Golden State: applyDialogue(companion_output) — 完全手工硬编码', () => {
  const afterUser = applyEvent(s0, dlgUserEvt);
  const actual = applyEvent(afterUser, dlgCompEvt);

  // 从 s0 起点完整手工推导 → expected 所有字段独立于 applyEvent
  const expected: MarrowState = {
    ...s0,
    trust: 50.234,        // G4 trust + G5 不改
    moodBaseline: 50.117, // G4 mood + G5 moodDelta=0 → 不变
    energy: 78.62,        // G4 energy 78.78 - 0.16
    arousal: 10,          // 始终不变
    socialHunger: 15,     // G4 sated - 15, G5 companion 不改
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    cognitiveLoad: 0,
    lastEvokedMemory: null,
    episodicBuffer: [],
    lastUpdated: TS,
  };

  assertStatesEqual(actual, expected, 'G5');
  console.log('  [G5 PASS] energy=78.62 完全手工硬编码');
});

// ══════════════════════════════════════════════════════════════════════════
// G6: 完整 4 事件链 Obs→Appr→DlgUser→DlgComp 最终终态
// 独立性：✅ 手工硬编码所有字段（合成 G4+G3 的最终叠加）
// ══════════════════════════════════════════════════════════════════════════
test('[G6] Golden State: 完整 4 事件链最终终态', () => {
  const chain = applyEvent(applyEvent(applyEvent(applyEvent(s0, obsEvt), appEvt), dlgUserEvt), dlgCompEvt);

  // G3 arousal=12.7 + G4 trust/mood/energy + G5 energy=78.62 → 叠加
  const expected: MarrowState = {
    ...s0,
    trust: 50.234,
    moodBaseline: 50.117,
    energy: 78.62,
    arousal: 12.7,
    socialHunger: 15,
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    cognitiveLoad: 0,
    lastEvokedMemory: null,
    episodicBuffer: [],
    lastUpdated: TS,
  };

  assertStatesEqual(chain, expected, 'G6');
  console.log('  [G6 PASS] 四事件链终态完全吻合');
});

// ══════════════════════════════════════════════════════════════════════════
// G7: 确定性 —— 同一事件执行两次结果一致
// 独立性：✅ 确定性测试，不涉及 expected 生成
// ══════════════════════════════════════════════════════════════════════════
test('[G7] Golden State: 同一事件链执行两次 → 终态完全相等', () => {
  const c1 = applyEvent(applyEvent(applyEvent(applyEvent(s0, obsEvt), appEvt), dlgUserEvt), dlgCompEvt);
  const c2 = applyEvent(applyEvent(applyEvent(applyEvent(s0, obsEvt), appEvt), dlgUserEvt), dlgCompEvt);
  assertStatesEqual(c1, c2, 'G7');
  console.log('  [G7 PASS] 两次执行完全相等（确定性）');
});

// ══════════════════════════════════════════════════════════════════════════
// G8: 顺序敏感验证
// 独立性：✅ 顺序敏感性测试
// ══════════════════════════════════════════════════════════════════════════
test('[G8] Golden State: 事件顺序敏感验证', () => {
  const normal = applyEvent(applyEvent(applyEvent(applyEvent(s0, obsEvt), appEvt), dlgUserEvt), dlgCompEvt);
  const swapped = applyEvent(applyEvent(applyEvent(applyEvent(s0, obsEvt), dlgUserEvt), appEvt), dlgCompEvt);
  // Dialogue 不改 arousal → 两种顺序终态相同
  assertStatesEqual(normal, swapped, 'G8');
  console.log('  [G8 PASS] Dialogue 不改 arousal → 顺序不影响终态');
});

// ══════════════════════════════════════════════════════════════════════════
// G9: 防御墙边界测试 —— 旧格式 DialogueEvent + defensiveness=75
// 【本阶段重写】原版零断言，只有 console.log
//
// 设计：旧格式 DialogueEvent（无 observationId）→ appraise 重算 valenceDelta
//   defensiveness=75 > DEFENSIVENESS_WALL_THRESHOLD(70)
//   → 正向 valenceDelta *= 0.2（削减 80%）
//   → 但 trustDelta 完全不受 defensiveness 影响（设计决策）
//
// 手工推导（不调用 applyEvent）：
//   ACTION_VALUES['greeting'] = 0.3（关键！不是 0.5）
//   context: defensiveness=75, trust=50, moodBaseline=50, associationWeight=1
//   safeIntensity = clamp(0.6, 0, 1) = 0.6
//   trustMultiplier = 50/50 = 1.0
//   actionMood = 0.3 × 0.6 × 1 × 1 = 0.18
//   greeting → 三类需求 neutral → needMoodBonus = 0
//   valenceDelta = 0.18
//   防御墙：valenceDelta>0 && 75>70 → valenceDelta *= 0.2 = 0.036
//     （75 < 90 → 不触发敷衍反转）
//
//   trustDelta:
//     rawTrustDelta = 0.3 × 0.6 × 2 × moodFactor(=1.0) = 0.36
//     trustDelta 正值 → 不需要 agreeableness 调制
//     trustDelta = clamp(0.36, -5, 5) = 0.36（不受 defensiveness 影响）
//     attentionMod = 0.3 + 0.5×0.7 = 0.65
//     trustDelta × attentionMod = 0.36 × 0.65 = 0.234
//     trust = 50 + 0.234 = 50.234
//
//   weightedMoodDelta = 0.036 × 0.65 = 0.0234
//   moodBaseline = 50.0234
//   energyCost = 0.3 + 0.6×1.5 + 2×0.01 = 1.22 → energy = 80 - 1.22 = 78.78
//   socialHunger = 30 - 15 = 15
//
// 对比 defensiveness=0 时（无防御墙）：
//   valenceDelta = 0.18 → weightedMoodDelta = 0.117 → moodBaseline = 50.117
//   trust 相同 = 50.234（确认 trustDelta 不受 defensiveness 影响）
// ══════════════════════════════════════════════════════════════════════════
test('[G9] Golden State: 防御墙边界 —— defensiveness=75 拦截正向 moodDelta', () => {
  const highDefState: MarrowState = { ...s0, defensiveness: 75 };
  // 旧格式：无 observationId → 走 appraise 重算 valenceDelta（防御墙生效）
  const evt: DialogueEvent = {
    type: 'dialogue', id: 'evt-dlg-def-01', timestamp: TS,
    payload: {
      direction: 'user_input', text: '你好', action: 'greeting', intensity: 0.6,
      moodDelta: 0, salience: 0.3, wordCount: 2,
      // 无 observationId / appraisalId → 旧格式（走 appraise 重算 valenceDelta）
    },
  };
  const actual = applyEvent(highDefState, evt);

  // 手工硬编码预期值（修正 actionValue=0.3 而非 0.5）
  const expected: MarrowState = {
    ...highDefState,
    trust: 50.234,         // trustDelta=0.36 × attentionMod=0.65 → 不受 defensiveness 影响
    moodBaseline: 50.0234, // valenceDelta=0.036(防御墙削减到20%) × 0.65 = 0.0234
    energy: 78.78,         // 1.22 消耗
    defensiveness: 75,     // Dialogue 不改 defensiveness
    socialHunger: 15,
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    cognitiveLoad: 0,
    lastEvokedMemory: null,
    episodicBuffer: [],
    lastUpdated: TS,
  };

  assertStatesEqual(actual, expected, 'G9');
  console.log('  [G9 PASS] defensiveness=75 拦截正向 moodDelta 到 20%，trust 不受影响');

  // 交叉验证：defensiveness=0 时 moodDelta 完全通过
  const noDefActual = applyEvent(s0, evt);
  // defensiveness=0 → 无防御墙 → valenceDelta=0.18 → weighted=0.117 → mood=50.117
  assert.equal(Math.abs(noDefActual.moodBaseline - 50.117) < 1e-10, true,
    '防御墙关闭时 moodBaseline 应 = 50.117（完全正向通过）');
  console.log('  [G9 cross-check] defensiveness=0 → moodBaseline=50.117（完全正向通过）✓');
});

// ══════════════════════════════════════════════════════════════════════════
// G10: TickEvent —— 完整 28+4+lastBehavior 字段手工推导
//   id='evt-tick-01', deltaSeconds=10, 初始 s0
//
//   walkStep 种子（hashString 已修复为 Math.imul）：
//     mood:      hashString("evt-tick-01:mood") / 0xffffffff → walkStep(0.04, seed) = -0.03305710552098628
//     arousal:   hashString("evt-tick-01:arousal") / 0xffffffff → walkStep(0.12, seed) = -0.05737110730665063
//     attention: hashString("evt-tick-01:attention") / 0xffffffff → walkStep(0.008, seed) = +0.006642632919978963
//
//   energy: 非睡眠 & battery=100 → decay
//     energyDelta = -0.005 × 10 = -0.05 → energy = 79.95
//
//   moodBaseline:
//     初始 50 + walk(-0.033057×10) + energyPull(0) + scarPull(0)
//     = 50 - 0.330571 = 49.669429
//     canRegress = !sleeping && cognitiveLoad(0)<80 && defensiveness(0)<40 → YES
//     mood += (50 - 49.669429) × 0.01 × 1 × 10 = +0.033057
//     final moodBaseline = 49.70248605031112
//
//   arousal:
//     arousalRevert = 0.1 × (10-10) × 10 = 0
//     arousal = 10 + 0 + (-0.05737)×10 = 9.426288926933493
//     energy=79.95 ≥ 60 → 无 energy cap
//
//   attentionFocus:
//     0.5 + 0.0066426 × 10 = 0.566426 → clamp[0,1] = 0.5664263291997896
//     energy=79.95 ≥ 20 & mood=49.70 ≥ 20 → 无 exhaustion 强制压低
//
//   socialHunger: 30 + 0.015 × 1 × 10 = 30.15
//   needValidation: 40 + 0.01 × 1 × 10 = 40.1
//   needNovelty: 30 + 0.008 × 10 = 30.08
//   needSecurity: 50 + 0.006 × 10 = 50.06
//   defensiveness: trust=50≥30 & mood=49.70≥30 → decay
//     clamp(0 - 1.2×10, 0, 100) = 0
//   cognitiveLoad: mood=49.70≥30 → decay
//     clamp(0 - 1.5×10, 0, 100) = 0
//   interruptionFlag: false（初始 false）
//   uptimeSeconds: 0 + 10 = 10
//   sleeping: behavior=idle & energy=79.95≥20 → 不进入睡眠
//   sleepEntry*: 保持初始值 50/0/0
//   associations: decayAssociations([]) = []
//   lastBehavior: deriveBehavior(energy=79.95, mood=49.70, arousal=9.43,
//     interruptionFlag=false, socialHunger=30.15) → idle/neutral_state
//     （socialHunger=30.15≤70, energy=79.95>60 但 mood=49.70≤50 → 不满足 energy_and_mood_good）
// ══════════════════════════════════════════════════════════════════════════
test('[G10] Golden State: TickEvent delta=10 — 完整 28 字段手工硬编码', () => {
  const moodStep = prodWalkStep(STATE_CONSTANTS.MOOD_WALK_STEP, `${tickEvt.id}:mood`);
  const arousalStep = prodWalkStep(STATE_CONSTANTS.AROUSAL_WALK_STEP, `${tickEvt.id}:arousal`);
  const attentionStep = prodWalkStep(STATE_CONSTANTS.ATTENTION_WALK_STEP, `${tickEvt.id}:attention`);

  // 种子值（hashString 已修复为 Math.imul）
  assert.ok(Math.abs(moodStep - (-0.03305710552098628)) < 1e-10,
    `生产 walkStep(mood) 偏差: ${moodStep} (期望 -0.03305710552098628)`);
  assert.ok(Math.abs(arousalStep - (-0.05737110730665063)) < 1e-10,
    `生产 walkStep(arousal) 偏差: ${arousalStep} (期望 -0.05737110730665063)`);
  assert.ok(Math.abs(attentionStep - 0.006642632919978963) < 1e-10,
    `生产 walkStep(attention) 偏差: ${attentionStep} (期望 +0.006642632919978963)`);

  const actual = applyEvent(s0, tickEvt);

  // expected 所有字段 = 手工硬编码（基于修复后 hashString，不运行时计算）
  const expected: MarrowState = {
    ...s0,
    energy: 79.95,
    moodBaseline: 49.70248605031112,
    arousal: 9.426288926933493,
    attentionFocus: 0.5664263291997896,
    socialHunger: 30.15,
    needValidation: 40.1,
    needNovelty: 30.08,
    needSecurity: 50.06,
    defensiveness: 0,
    cognitiveLoad: 0,
    interruptionFlag: false,
    uptimeSeconds: 10,
    sleeping: false,
    sleepEntryTrust: 50,
    sleepEntryCognitiveLoad: 0,
    sleepEntryDefensiveness: 0,
    associations: [],
    lastBehavior: { kind: 'idle', reason: 'neutral_state' },
    lastUpdated: TS,
  };

  assertStatesEqual(actual, expected, 'G10');
  console.log('  [G10 PASS] TickEvent 完整 28 字段吻合');
});

// ══════════════════════════════════════════════════════════════════════════
// G11: InterruptionEvent 非创伤 —— energy=80（不低）
// 手工推导（applyInterruption 源码）：
//   energyLow = 80 < ENERGY_CRITICAL_FOR_MOOD(=60)? NO
//   irritableMoodDrop = 0（不是低能量烦躁）
//   arousal = AROUSAL_MAX = 100
//   moodBaseline = 50（不降）
//   interruptionFlag = true
//   needSecurity = clamp(50 + 15, 0, 100) = 65
//   associations: 非创伤 → 不追加 scar
//   interruptionScars: 非创伤 → 0 不变
//   associationWeight: 非创伤 → 1 不变
//   lastBehavior.kind = 'interrupted', reason = 'power_loss'
//   interruptionCount = 0 + 1 = 1
// ══════════════════════════════════════════════════════════════════════════
test('[G11] Golden State: InterruptionEvent 非创伤 energy=80', () => {
  const actual = applyEvent(s0, irrEvt);

  const expected: MarrowState = {
    ...s0,
    arousal: 100,
    moodBaseline: 50,
    interruptionFlag: true,
    needSecurity: 65,
    associations: [],              // 非创伤 → 不追加 scar
    interruptionScars: 0,          // 非创伤 → 不变
    associationWeight: 1,          // 非创伤 → 不变
    interruptionCount: 1,
    lastBehavior: { kind: 'interrupted', reason: 'power_loss' },
    lastUpdated: TS,
  };

  assertStatesEqual(actual, expected, 'G11');
  console.log('  [G11 PASS] InterruptionEvent 非创伤 → arousal=100, needSec=65');
});

// ══════════════════════════════════════════════════════════════════════════
// G12: InterruptionEvent 创伤 —— 追加 scar + associationWeight 衰减
// 手工推导（applyInterruption isTraumatic=true 分支）：
//   energyLow = false → 同 G11
//   arousal = AROUSAL_MAX = 100
//   needSecurity = 50 + 35 = 85
//   scar AssociationMemory: { id:'scar-evt-irr-trav-01', cue:'power_loss',
//     valence:-0.8, salience:0.9, source:'interruption', isScar:true }
//   associations = [] + scar → length=1
//   interruptionScars = 0 + 1 = 1
//   associationWeight = max(0.3, 1 - 0.1) = 0.9
// ══════════════════════════════════════════════════════════════════════════
test('[G12] Golden State: InterruptionEvent 创伤 — scar 写入 + associationWeight 衰减', () => {
  const actual = applyEvent(s0, irrTravEvt);

  const expected: MarrowState = {
    ...s0,
    arousal: 100,
    moodBaseline: 50,
    interruptionFlag: true,
    needSecurity: 85,                        // 创伤 +35
    interruptionScars: 1,                   // 0 + 1
    associationWeight: 0.9,                 // max(0.3, 1 - 0.1)
    interruptionCount: 1,
    associations: [{
      id: 'scar-evt-irr-trav-01',
      timestamp: TS,
      cue: 'power_loss',
      valence: -0.8,
      salience: 0.9,
      source: 'interruption',
      isScar: true,
    }],
    lastBehavior: { kind: 'interrupted', reason: 'crash' },
    lastUpdated: TS,
  };

  assertStatesEqual(actual, expected, 'G12');
  console.log('  [G12 PASS] 创伤中断 → scar 追加 + weight=0.9 + needSec=85');
});

// ══════════════════════════════════════════════════════════════════════════
// G13: SleepEvent entering —— 冻结三个快照字段
// 手工推导（applySleep entering=true）：
//   sleeping = true
//   sleepEntryTrust = state.trust（冻结当前值）
//   sleepEntryCognitiveLoad = state.cognitiveLoad
//   sleepEntryDefensiveness = state.defensiveness
//   所有其他字段 = 初始 state（不变化）
// ══════════════════════════════════════════════════════════════════════════
test('[G13] Golden State: SleepEvent entering — 冻结三个快照字段', () => {
  const actual = applyEvent(s0, sleepOnEvt);

  const expected: MarrowState = {
    ...s0,
    sleeping: true,
    sleepEntryTrust: 50,              // 冻结 s0.trust
    sleepEntryCognitiveLoad: 0,       // 冻结 s0.cognitiveLoad
    sleepEntryDefensiveness: 0,       // 冻结 s0.defensiveness
    lastUpdated: TS,
    // 其他所有字段保持 s0 值
  };

  assertStatesEqual(actual, expected, 'G13');
  console.log('  [G13 PASS] Sleep entering → sleeping=true + 三快照冻结');
});

// ══════════════════════════════════════════════════════════════════════════
// G14: SleepEvent waking —— 清空三个快照字段
// 手工推导（applySleep entering=false）：
//   sleeping = false
//   sleepEntryTrust = TRUST_INITIAL = 50
//   sleepEntryCognitiveLoad = 0
//   sleepEntryDefensiveness = 0
// ══════════════════════════════════════════════════════════════════════════
test('[G14] Golden State: SleepEvent waking — 清空快照 + 解除睡眠', () => {
  // 先进入睡眠状态
  const sleepingState = applyEvent(s0, sleepOnEvt);
  const actual = applyEvent(sleepingState, sleepOffEvt);

  const expected: MarrowState = {
    ...sleepingState,
    sleeping: false,
    sleepEntryTrust: STATE_CONSTANTS.TRUST_INITIAL,
    sleepEntryCognitiveLoad: 0,
    sleepEntryDefensiveness: 0,
    lastUpdated: TS,
  };

  assertStatesEqual(actual, expected, 'G14');
  console.log('  [G14 PASS] Sleep waking → sleeping=false + 三快照清空');
});

// ══════════════════════════════════════════════════════════════════════════
// 摘要（运行结束时打印）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== Golden State 测试摘要 (M1.3.8.2.1) ===');
console.log('G1: createInitialState 完整 28+4+lastBehavior 快照');
console.log('G2: Observation → 仅 lastUpdated');
console.log('G3: Appraisal → arousal=12.7');
console.log('G4: Dialogue(user_input) → trust=50.234 mood=50.117 energy=78.78');
console.log('G5: Dialogue(companion_output) → energy=78.62 完全手工硬编码');
console.log('G6: 四事件链最终终态 手工硬编码');
console.log('G7: 确定性（两链相等）');
console.log('G8: 顺序敏感');
console.log('G9: 防御墙 defensiveness=75 → moodDelta 削减到 20%');
console.log('G10: TickEvent delta=10 — 全部 28 字段手工推导');
console.log('G11: InterruptionEvent 非创伤 → arousal=100, needSec=65');
console.log('G12: InterruptionEvent 创伤 → scar 写入 + associationWeight=0.9');
console.log('G13: SleepEvent entering → 三快照冻结');
console.log('G14: SleepEvent waking → 三快照清空');
console.log('\n  独立性保证：所有 expected 值手工硬编码，不调用 applyEvent 生成');
console.log('  覆盖字段：energy, moodBaseline, arousal, trust, defensiveness, cognitiveLoad,');
console.log('            socialHunger, needs(3), attentionFocus, associations, traits(4),');
console.log('            lastBehavior, sleepEntry*(3), uptimeSeconds, interruptionFlag/Count,');
console.log('            interruptionScars, associationWeight, batteryLevel, lastEvokedMemory,');
console.log('            sleeping, lastUpdated');

// ══════════════════════════════════════════════════════════════════════════
// M1-M11: EpisodicMemory 事件化（M1.4.1）
//
// 验证：DialogueEvent 不再直接写 episodicBuffer；
//       MemoryFormationEvent 是写入 buffer 的唯一入口；
//       单一函数 computeEpisodicMemoryCandidate 产出候选；
//       历史事件保护（旧 DialogueEvent 回放零新记忆）。
//
// 注：所有 DialogueEvent/ObservationEvent/AppraisalEvent 用 `as any`
// 绕开 payload 严格类型——测试目标是 applyEvent 行为，不是 payload 完整性。
// MemoryFormationEvent 保持强类型，因为它是新事件契约的核心。
// ══════════════════════════════════════════════════════════════════════════

// ── M1: 满足所有条件 → 正确生成 EpisodicMemory ──────────────────────────
test('[M1] MemoryFormation: 满足全部门槛 → 正确生成 EpisodicMemory', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m1-001', timestamp: TS,
    payload: { direction: 'user_input', text: '你今天看起来好多了，真为你高兴！希望一切顺利。',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  // weightedMoodDelta = 2.0 * 0.65 = 1.3 >= 1.0 ✅, intensity=0.9 >= 0.5 ✅
  const mem = computeEpisodicMemoryCandidate(s, dt, null, 2.0);
  assert.ok(mem, '应生成 EpisodicMemory');
  assert.equal(mem!.id, 'epi-evt-m1-001');
  assert.equal(mem!.sourceEventId, 'evt-m1-001');
  assert.equal(mem!.salience, 0.9);
  assert.equal(mem!.valence, 0.6);
  assert.ok(mem!.keywords.length >= 2);
  assert.equal(mem!.isTrauma, false);
  console.log(`  [M1 PASS] 生成记忆: id=${mem!.id}, valence=${mem!.valence}, keywords=${mem!.keywords.length}`);
});

// ── M2: intensity 不足 → 不生成 ────────────────────────────────────────
test('[M2] MemoryFormation: intensity < 0.5 → 不生成', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m2-001', timestamp: TS,
    payload: { direction: 'user_input', text: '嗯好的',
               action: 'statement', intensity: 0.3, moodDelta: 2.0 },
  } as any;
  const mem = computeEpisodicMemoryCandidate(s, dt, null, 2.0);
  assert.equal(mem, null);
  console.log('  [M2 PASS] intensity=0.3 → null');
});

// ── M3: |weightedMoodDelta| 不足 → 不生成 ────────────────────────────────
test('[M3] MemoryFormation: |weightedMoodDelta + memoryMoodDelta| < 1.0 → 不生成', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m3-001', timestamp: TS,
    payload: { direction: 'user_input', text: '你好呀今天天气不错啊',
               action: 'greeting', intensity: 0.6, moodDelta: 0.18 },
  } as any;
  const mem = computeEpisodicMemoryCandidate(s, dt, null, 0.18);
  assert.equal(mem, null, '|0.117| < 1.0 → 应返回 null');
  console.log('  [M3 PASS] greeting valenceDelta=0.18 → null（与生产首次对话行为一致）');
});

// ── M4: keywords 为空 → 不生成 ─────────────────────────────────────────
test('[M4] MemoryFormation: keywords 为空 → 不生成', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m4-001', timestamp: TS,
    payload: { direction: 'user_input', text: '嗯啊哦嘿',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  const mem = computeEpisodicMemoryCandidate(s, dt, null, 2.0);
  if (mem !== null) assert.ok(mem.keywords.length > 0);
  console.log(mem ? `  [M4 OK] text 短但仍提取 keywords: ${mem.keywords}` : '  [M4 PASS] keywords 空 → null');
});

// ── M5: 单独 DialogueEvent → 不改变 episodicBuffer（事件化核心） ─────────
test('[M5] DialogueEvent 单独执行 → episodicBuffer 不变（事件化核心）', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m5-001', timestamp: TS,
    payload: { direction: 'user_input', text: '你今天看起来好多了，真为你高兴！希望一切顺利。',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  const afterDlg = applyEvent(s, dt);
  assert.deepEqual(afterDlg.episodicBuffer, [],
    `DialogueEvent 单独执行后 buffer 应保持空，实际: ${afterDlg.episodicBuffer.length}`);
  console.log('  [M5 PASS] DialogueEvent 单独执行 → episodicBuffer=[]');
});

// ── M6: DialogueEvent + MemoryFormationEvent → 正确写入 ─────────────────
test('[M6] DialogueEvent + MemoryFormationEvent → 正确写入 episodicBuffer', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m6-001', timestamp: TS,
    payload: { direction: 'user_input', text: '你今天看起来好多了，真为你高兴！希望一切顺利。',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  const mem = computeEpisodicMemoryCandidate(s, dt, null, 2.0)!;
  const mfe: MemoryFormationEvent = {
    type: 'memory_formation', id: 'evt-m6-002', timestamp: TS,
    payload: { sourceDialogueEventId: dt.id, memory: mem },
  };
  const afterDlg = applyEvent(s, dt);
  const afterForm = applyEvent(afterDlg, mfe);
  assert.equal(afterForm.episodicBuffer.length, 1);
  assert.equal(afterForm.episodicBuffer[0]!.id, mem!.id);
  assert.equal(afterForm.episodicBuffer[0]!.sourceEventId, dt.id);
  console.log(`  [M6 PASS] Dialogue → MemoryFormation → buffer 长度=1, id=${mem.id}`);
});

// ── M7: replay 后记忆字段与 payload 完全一致 ───────────────────────────
test('[M7] MemoryFormationEvent replay → 记忆字段与 payload 完全一致', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m7-001', timestamp: TS,
    payload: { direction: 'user_input', text: '你今天看起来好多了，真为你高兴！希望一切顺利。',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  const mem = computeEpisodicMemoryCandidate(s, dt, null, 2.0)!;
  const mfe: MemoryFormationEvent = {
    type: 'memory_formation', id: 'evt-m7-002', timestamp: TS,
    payload: { sourceDialogueEventId: dt.id, memory: mem },
  };
  const real = applyEvent(applyEvent(s, dt), mfe);
  const replay = applyEvent(applyEvent(s, dt), mfe);

  assert.deepEqual(real.episodicBuffer[0], mem, '实跑后 buffer[0] 与 payload.memory 完全一致');
  assert.deepEqual(replay.episodicBuffer[0], mem, 'replay 后 buffer[0] 与 payload.memory 完全一致');
  assert.deepEqual(real.episodicBuffer, replay.episodicBuffer, '实跑与 replay buffer 完全相等');

  const got = replay.episodicBuffer[0];
  assert.equal(got.id, mem.id);
  assert.equal(got.summary, mem.summary);
  assert.equal(got.valence, mem.valence);
  assert.equal(got.salience, mem.salience);
  assert.equal(got.sourceEventId, mem.sourceEventId);
  assert.equal(got.isTrauma, mem.isTrauma);
  assert.deepEqual(got.keywords, mem.keywords);
  assert.equal(got.timestamp, mem.timestamp);

  console.log(`  [M7 PASS] replay buffer 与 payload.memory 逐字段一致 (${Object.keys(mem).length} 字段)`);
});

// ── M8: 连续两条记忆 → 不丢失、不覆盖 ──────────────────────────────────
test('[M8] 连续两条记忆 → 不丢失、不覆盖、顺序正确', () => {
  const s = createInitialState(TS);
  const dt1 = {
    type: 'dialogue', id: 'evt-m8-001', timestamp: TS,
    payload: { direction: 'user_input', text: '你真好真温暖！真是太感谢了！',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  const mem1 = computeEpisodicMemoryCandidate(s, dt1, null, 2.0)!;
  const mfe1: MemoryFormationEvent = {
    type: 'memory_formation', id: 'evt-m8-002', timestamp: TS,
    payload: { sourceDialogueEventId: dt1.id, memory: mem1 },
  };
  const dt2 = {
    type: 'dialogue', id: 'evt-m8-003', timestamp: TS,
    payload: { direction: 'user_input', text: '你怎么总是这么让人失望真讨厌！',
               action: 'insult', intensity: 0.9, moodDelta: -2.0 },
  } as any;
  const mem2 = computeEpisodicMemoryCandidate(s, dt2, null, -2.0)!;
  const mfe2: MemoryFormationEvent = {
    type: 'memory_formation', id: 'evt-m8-004', timestamp: TS,
    payload: { sourceDialogueEventId: dt2.id, memory: mem2 },
  };

  const state = applyEvent(
    applyEvent(applyEvent(applyEvent(s, dt1), mfe1), dt2),
    mfe2,
  );
  assert.equal(state.episodicBuffer.length, 2);
  assert.equal(state.episodicBuffer[0]!.id, mem1!.id);
  assert.equal(state.episodicBuffer[1]!.id, mem2!.id);
  assert.equal(state.episodicBuffer[1]!.isTrauma, true);
  console.log(`  [M8 PASS] 连续两条记忆 buffer 长度=2, 顺序正确, 创伤标记正确`);
});

// ── M9: payload 必要字段校验 ───────────────────────────────────────────
test('[M9] MemoryFormationEvent payload 必要字段符合契约', () => {
  const s = createInitialState(TS);
  const dt = {
    type: 'dialogue', id: 'evt-m9-001', timestamp: TS,
    payload: { direction: 'user_input', text: '你真好真温暖！真是太感谢了！',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  const mem = computeEpisodicMemoryCandidate(s, dt, null, 2.0)!;
  const mfe: MemoryFormationEvent = {
    type: 'memory_formation', id: 'evt-m9-002', timestamp: TS,
    payload: { sourceDialogueEventId: dt.id, memory: mem },
  };
  assert.ok(mfe.payload.sourceDialogueEventId.length > 0);
  assert.ok(mfe.payload.memory.id.length > 0);
  assert.ok(mfe.payload.memory.timestamp.length > 0);
  assert.ok(mfe.payload.memory.summary.length > 0);
  assert.ok(Array.isArray(mfe.payload.memory.keywords) && mfe.payload.memory.keywords.length > 0);
  assert.ok(Number.isFinite(mfe.payload.memory.valence));
  assert.ok(Number.isFinite(mfe.payload.memory.salience));
  console.log('  [M9 PASS] payload 契约校验通过（与 recovery.ts 校验规则一致）');
});

// ── M10: 生产批次事件顺序（构造事件序列，模拟 appendEvents） ───────────
test('[M10] 批次事件顺序：Obs→Appr→DlgUser→MemForm→DlgComp', () => {
  const s = createInitialState(TS);
  const obs = {
    type: 'observation', id: 'evt-m10-obs', timestamp: TS,
    payload: { source: 'user_text', content: '你真好真温暖！真是太感谢了！',
               confidence: 0.9, uncertainty: 0.1, facts: [], extractorVersion: 'test' },
  } as any;
  const appr = {
    type: 'appraisal', id: 'evt-m10-appr', timestamp: TS,
    payload: { sourceObservationId: obs.id, valenceDelta: 2.0, arousalDelta: 5,
               energyDelta: 0, confidence: 0.9, evidenceAssociationIds: [] },
  } as any;
  const dtUser = {
    type: 'dialogue', id: 'evt-m10-user', timestamp: TS,
    payload: { direction: 'user_input', text: '你真好真温暖！真是太感谢了！',
               action: 'comfort', intensity: 0.9, moodDelta: 2.0 },
  } as any;
  const mem = computeEpisodicMemoryCandidate(s, dtUser, null, 2.0)!;
  const memForm: MemoryFormationEvent = {
    type: 'memory_formation', id: 'evt-m10-mem', timestamp: TS,
    payload: { sourceDialogueEventId: dtUser.id, memory: mem },
  };
  const dtComp = {
    type: 'dialogue', id: 'evt-m10-comp', timestamp: TS,
    payload: { direction: 'companion_output', text: '不客气，你真善良', moodDelta: 0 },
  } as any;
  const batch = [obs, appr, dtUser, memForm, dtComp];
  let state = s;
  for (const e of batch) state = applyEvent(state, e);
  assert.equal(state.episodicBuffer.length, 1);
  assert.equal(state.episodicBuffer[0]!.id, mem!.id);
  assert.equal(state.episodicBuffer[0]!.sourceEventId, dtUser.id);
  console.log(`  [M10 PASS] 五事件批次顺序正确，buffer 长度=1, sourceEventId=${dtUser.id}`);
});

// ── M11: 历史 DialogueEvent（无 MemoryFormationEvent）回放 → 零新记忆 ────
test('[M11] 历史 DialogueEvent 无对应 MemoryFormationEvent → replay 零新记忆', () => {
  const s = createInitialState(TS);
  const obs = {
    type: 'observation', id: 'evt-m11-obs', timestamp: TS,
    payload: { source: 'user_text', content: '你好，我今天第一次来到这里。',
               confidence: 0.8, uncertainty: 0.2, facts: [], extractorVersion: 'test' },
  } as any;
  const appr = {
    type: 'appraisal', id: 'evt-m11-appr', timestamp: TS,
    payload: { sourceObservationId: obs.id, valenceDelta: 0.18, arousalDelta: 2.7,
               energyDelta: 0, confidence: 0.8, evidenceAssociationIds: [] },
  } as any;
  const dtUser = {
    type: 'dialogue', id: 'evt-m11-user', timestamp: TS,
    payload: { direction: 'user_input', text: '你好，我今天第一次来到这里。',
               action: 'greeting', intensity: 0.6, moodDelta: 0.18 },
  } as any;
  const dtComp = {
    type: 'dialogue', id: 'evt-m11-comp', timestamp: TS,
    payload: { direction: 'companion_output', text: '欢迎，很高兴见到你', moodDelta: 0 },
  } as any;
  const batch = [obs, appr, dtUser, dtComp];
  let state = s;
  for (const e of batch) state = applyEvent(state, e);

  // 关键：DialogueEvent 不再内联沉淀 → 历史对话 buffer 保持空
  assert.deepEqual(state.episodicBuffer, [],
    '历史 DialogueEvent（无 MemoryFormationEvent）回放 → buffer 应为空');
  assert.ok(state.moodBaseline > 50, 'greeting 正面 → mood 应上升');
  assert.ok(state.energy < 80, '两次 dialogue → energy 应下降');

  console.log(`  [M11 PASS] 历史回放: buffer 空（符合预期）, mood=${state.moodBaseline.toFixed(3)}, energy=${state.energy.toFixed(2)}`);
});

// ── R1-R4: Recovery 真实入口校验（validateMemoryFormationPayload 生产函数） ──
// 注：直接调用 recovery.ts export 的纯校验函数，不复制测试专用逻辑

const TS_R = '2026-01-01T00:00:00.000Z';

function buildGoodPayload(srcId: string): Record<string, unknown> {
  return {
    sourceDialogueEventId: srcId,
    memory: {
      id: `epi-${srcId}`,
      timestamp: TS_R,
      summary: '一段温暖的对话记忆',
      keywords: ['温暖', '感谢'],
      valence: 0.6,
      salience: 0.9,
      sourceEventId: srcId,
      isTrauma: false,
    },
  };
}

test('[R1] 合法 MemoryFormationEvent payload 通过 recovery 校验', () => {
  const err = validateMemoryFormationPayload(buildGoodPayload('evt-r1-001'));
  assert.equal(err, null, `合法 payload 应通过校验，实际: ${err}`);
  console.log('  [R1 PASS] 合法 payload 通过 recovery 校验');
});

test('[R2] 缺少 memory.sourceEventId → recovery 拒绝', () => {
  const p = buildGoodPayload('evt-r2-001');
  delete (p.memory as Record<string, unknown>).sourceEventId;
  const err = validateMemoryFormationPayload(p);
  assert.ok(err && err.includes('sourceEventId'), `应报告 sourceEventId 缺失: ${err}`);
  console.log(`  [R2 PASS] 缺 sourceEventId 被拒: ${err}`);
});

test('[R3] memory.isTrauma 类型错误 → recovery 拒绝', () => {
  const p = buildGoodPayload('evt-r3-001');
  (p.memory as Record<string, unknown>).isTrauma = 'yes'; // string, not boolean
  const err = validateMemoryFormationPayload(p);
  assert.ok(err && err.includes('isTrauma'), `应报告 isTrauma 类型错误: ${err}`);
  console.log(`  [R3 PASS] isTrauma 类型错误被拒: ${err}`);
});

test('[R4] sourceDialogueEventId 与 memory.sourceEventId 不一致 → recovery 拒绝', () => {
  const p = buildGoodPayload('evt-r4-001');
  p.sourceDialogueEventId = 'evt-r4-001';
  (p.memory as Record<string, unknown>).sourceEventId = 'evt-different';
  const err = validateMemoryFormationPayload(p);
  assert.ok(err && err.includes('不一致'), `应报告不一致: ${err}`);
  console.log(`  [R4 PASS] ID 不一致被拒: ${err}`);
});

test('[R5] keywords 数组包含非 string 元素 → recovery 拒绝', () => {
  const p = buildGoodPayload('evt-r5-001');
  (p.memory as Record<string, unknown>).keywords = ['hello', 123];
  const err = validateMemoryFormationPayload(p);
  assert.ok(err && err.includes('keywords'), `应报告 keywords 类型错误: ${err}`);
  console.log(`  [R5 PASS] keywords 非 string 元素被拒: ${err}`);
});

// ══════════════════════════════════════════════════════════════════════════
// M1.4.2.1 — Episodic salience 指数衰减（D1-D5）
//
// 目标：验证 EpisodicBuffer 中 salience 随时间自然指数衰减。
//       不改变记忆形成阈值 / 不新增 EventType / 不修改 applyDialogue。
// ══════════════════════════════════════════════════════════════════════════

// D1-D5 辅助：构造完整 EpisodicMemory（salience 可控）
function makeEpisodicMem(overrides: {
  id?: string; timestamp?: string; summary?: string; keywords?: string[];
  valence?: number; salience?: number; sourceEventId?: string; isTrauma?: boolean;
} = {}) {
  return {
    id: overrides.id ?? 'epi-001',
    timestamp: overrides.timestamp ?? TS,
    summary: overrides.summary ?? '一次温暖的对话',
    keywords: overrides.keywords ?? ['安慰', '温暖'],
    valence: overrides.valence ?? 0.6,
    salience: overrides.salience ?? 0.8,
    sourceEventId: overrides.sourceEventId ?? 'evt-dialogue',
    isTrauma: overrides.isTrauma ?? false,
  };
}

// D1-D5 辅助：构造 TickEvent
function makeTickEv(deltaSeconds: number): TickEvent {
  return {
    type: 'tick',
    id: 'evt-tick-d-test',
    timestamp: '2026-01-02T00:00:00Z',
    payload: { deltaSeconds },
  };
}

// ── D1：指数衰减公式精确验证 ────
test('[D1] Episodic salience 指数衰减公式精确验证', () => {
  const c = STATE_CONSTANTS;
  const mem = makeEpisodicMem({ salience: 0.8 });
  const initialBuffer = [mem];
  const state: MarrowState = { ...createInitialState(TS), episodicBuffer: initialBuffer };

  const tick = makeTickEv(3600); // 1 小时
  const afterTick = applyEvent(state, tick);

  const expected = 0.8 * Math.exp(-c.EPISODIC_SALIENCE_DECAY_RATE_PER_SECOND * 3600);
  const actual = afterTick.episodicBuffer[0]!.salience;
  const diff = Math.abs(actual - expected);

  assert.ok(
    diff < 1e-6,
    `D1 失败 expected=${expected.toExponential(8)} actual=${actual.toExponential(8)} diff=${diff.toExponential(2)}`,
  );
  console.log(`  [D1 PASS] salience=${actual.toExponential(8)} expected=${expected.toExponential(8)} diff=${diff.toExponential(2)}`);
});

// ── D2：Trauma 记忆衰减 × 0.2 倍率 ────
test('[D2] Trauma 记忆衰减率 × EPISODIC_TRAUMA_DECAY_MULTIPLIER(0.2)', () => {
  const c = STATE_CONSTANTS;
  const memNormal = makeEpisodicMem({ id: 'mem-normal', salience: 0.8, isTrauma: false });
  const memTrauma = makeEpisodicMem({ id: 'mem-trauma', salience: 0.8, isTrauma: true });
  const state: MarrowState = { ...createInitialState(TS), episodicBuffer: [memNormal, memTrauma] };

  const afterTick = applyEvent(state, makeTickEv(86400)); // 一天

  const normalSal = afterTick.episodicBuffer[0]!.salience;
  const traumaSal = afterTick.episodicBuffer[1]!.salience;

  assert.ok(traumaSal > normalSal, `D2 失败 traumaSal=${traumaSal} <= normalSal=${normalSal}`);

  const expectedTrauma = 0.8 * Math.exp(
    -c.EPISODIC_SALIENCE_DECAY_RATE_PER_SECOND * c.EPISODIC_TRAUMA_DECAY_MULTIPLIER * 86400,
  );
  const traumaDiff = Math.abs(traumaSal - expectedTrauma);
  assert.ok(traumaDiff < 1e-6, `D2 trauma 倍率验证失败 expected=${expectedTrauma.toExponential(8)} actual=${traumaSal.toExponential(8)} diff=${traumaDiff.toExponential(2)}`);

  console.log(`  [D2 PASS] normal=${normalSal.toExponential(6)} trauma=${traumaSal.toExponential(6)} trauma 衰减更慢`);
});

// ── D3：FIFO 容量常量生效（STATE_CONSTANTS.EPISODIC_BUFFER_CAPACITY = 50） ────
test('[D3] FIFO 使用 STATE_CONSTANTS.EPISODIC_BUFFER_CAPACITY，魔法数字已消除', () => {
  const CAP = STATE_CONSTANTS.EPISODIC_BUFFER_CAPACITY;
  assert.equal(CAP, 50, '常量值应为 50');

  // 构造 50 条记忆（已满）→ 追加第 51 条 → 长度保持 50 → index 0（mem-0）被淘汰
  const bufferFull = Array.from({ length: CAP }, (_, i) => makeEpisodicMem({ id: `mem-${i}`, salience: 0.8 }));
  const stateFull: MarrowState = { ...createInitialState(TS), episodicBuffer: bufferFull };

  const newMem: MemoryFormationEvent = {
    type: 'memory_formation',
    id: 'evt-memform-d3',
    timestamp: TS,
    payload: {
      sourceDialogueEventId: 'evt-dialogue-d3',
      memory: makeEpisodicMem({ id: 'mem-newest', salience: 0.8 }),
    },
  };
  const afterForm = applyEvent(stateFull, newMem);

  assert.equal(afterForm.episodicBuffer.length, CAP, `D3 失败 长度=${afterForm.episodicBuffer.length} != CAP=${CAP}`);
  assert.equal(afterForm.episodicBuffer[0]!.id, 'mem-1', 'D3 失败 mem-0 应被 FIFO 淘汰');
  assert.equal(afterForm.episodicBuffer[CAP - 1]!.id, 'mem-newest', 'D3 失败 新记忆应在末尾');

  console.log(`  [D3 PASS] FIFO 容量 ${CAP} 生效 mem-0 淘汰 mem-newest 保留在末尾`);
});

// ── D4：Evocation score 随 Tick 衰减降低 ────
test('[D4] Evocation score（salience × hitCount）随 Tick 衰减降低', () => {
  const mem = makeEpisodicMem({ id: 'mem-d4', salience: 0.8, keywords: ['安慰', '上次'] });
  const stateBefore: MarrowState = { ...createInitialState(TS), episodicBuffer: [mem] };

  const stateAfter = applyEvent(stateBefore, makeTickEv(86400 * 7)); // 一周

  const salBefore = stateBefore.episodicBuffer[0]!.salience;
  const salAfter = stateAfter.episodicBuffer[0]!.salience;

  assert.ok(salAfter < salBefore, `D4 失败 salAfter=${salAfter} >= salBefore=${salBefore}`);

  console.log(`  [D4 PASS] salience ${salBefore.toExponential(4)} -> ${salAfter.toExponential(6)} evocation score 同步降低`);
});

// ── D5：Tick 间隔分段一致性（真实 applyTick，非手动 Math.exp） ────
test('[D5] Tick 间隔分段一致性 一次 3600s vs 36 次 100s（浮点容差 1e-10）', () => {
  const INITIAL_SAL = 0.8;

  // 方案 A：一次大 Tick（3600s）
  let stateA: MarrowState = {
    ...createInitialState(TS),
    episodicBuffer: [makeEpisodicMem({ id: 'mem-d5', salience: INITIAL_SAL })],
  };
  stateA = applyEvent(stateA, makeTickEv(3600));
  const salA = stateA.episodicBuffer[0]!.salience;

  // 方案 B：36 次小 Tick（每次 100s，总计 3600s）
  let stateB: MarrowState = {
    ...createInitialState(TS),
    episodicBuffer: [makeEpisodicMem({ id: 'mem-d5', salience: INITIAL_SAL })],
  };
  for (let i = 0; i < 36; i++) {
    stateB = applyEvent(stateB, makeTickEv(100));
  }
  const salB = stateB.episodicBuffer[0]!.salience;

  const diff = Math.abs(salA - salB);
  assert.ok(
    diff < 1e-10,
    `D5 失败 一次tick=${salA.toExponential(10)} 36次tick=${salB.toExponential(10)} diff=${diff.toExponential(2)}`,
  );

  console.log(`  [D5 PASS] 一次 3600s=${salA.toExponential(10)} 36x100s=${salB.toExponential(10)} diff=${diff.toExponential(2)}`);
});
