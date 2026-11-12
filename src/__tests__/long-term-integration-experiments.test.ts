/**
 * long-term-integration-experiments.test.ts — M1.6.4 只读验证实验
 *
 * 纯内存事件 + applyEvent，零生产代码修改。
 * 目的：验证 M1.6.4 架构分析的可行性边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, createInitialState, type MarrowState,
} from '../state.js';
import { appraise, type AppraisalContext } from '../appraisal.js';
import { replayPersistedEvents } from '../recovery.js';
import { type PersistedEventRow } from '../storage.js';
import type {
  DialogueEvent, ObservationEvent, AppraisalEvent, TickEvent,
  GenesisEvent, DialogueAction, MarrowEvent, SleepEvent,
} from '../events.js';

const BASE_TS = '2026-11-11T00:00:00.000Z';
const BASE_SEC = Date.parse(BASE_TS) / 1000;
function iso(offsetSec: number): string {
  return new Date((BASE_SEC + offsetSec) * 1000).toISOString();
}
let counter = 0;
function nextId(tag: string): string {
  counter += 1;
  return `${tag}-${String(counter).padStart(4, '0')}`;
}
function genesis(ts: string): GenesisEvent {
  return { type: 'genesis', id: nextId('genesis'), timestamp: ts,
    payload: { initialState: createInitialState(ts), configVersion: 2,
      initializedBy: 'm164-exp', seedEpisodicIds: [] } };
}
function tick(ts: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id: nextId('tick'), timestamp: ts, payload: { deltaSeconds } };
}
function sleep(ts: string, entering: boolean): SleepEvent {
  return { type: 'sleep', id: nextId('sleep'), timestamp: ts,
    payload: { entering, reason: entering ? 'manual' : 'manual' } };
}
function observation(ts: string, action: DialogueAction, intensity: number): ObservationEvent {
  return { type: 'observation', id: nextId('obs'), timestamp: ts,
    payload: { source: 'user_text', content: `exp: ${action}`, action, intensity,
      confidence: 0.9, uncertainty: 0.1, facts: [{ claim: action, confidence: 0.9 }],
      extractorVersion: 'extractor-test', experienceValenceStatus: 'observed',
      experienceValence: action === 'insult' ? -0.7 : action === 'compliment' ? 0.7 :
        action === 'comfort' ? 0.5 : 0 } };
}
function appraisalEvt(ts: string, dv: number, obsId: string): AppraisalEvent {
  return { type: 'appraisal', id: nextId('appr'), timestamp: ts,
    payload: { sourceObservationId: obsId, valenceDelta: dv,
      arousalDelta: Math.abs(dv), energyDelta: 0, confidence: 0.9,
      evidenceAssociationIds: [] } };
}
function userDialogue(ts: string, text: string, action: DialogueAction,
  intensity: number, moodDelta: number, observationId: string, appraisalId: string): DialogueEvent {
  return { type: 'dialogue', id: nextId('dlg'), timestamp: ts,
    payload: { direction: 'user_input', text, action, intensity, moodDelta,
      salience: 0.3, wordCount: text.length, observationId, appraisalId } };
}
function companionOutput(ts: string, replyTo: string): DialogueEvent {
  return { type: 'dialogue', id: nextId('dlg'), timestamp: ts,
    payload: { direction: 'companion_output', text: 'ok', moodDelta: 0,
      salience: 0.3, wordCount: 2, candidateText: 'ok', filtered: false,
      replyToEventId: replyTo } };
}
function toRow(seq: number, ev: MarrowEvent, identityId: string): PersistedEventRow {
  return { sequence: String(seq), event_id: ev.id, identity_id: identityId,
    timestamp: ev.timestamp, event_type: ev.type, schema_version: 2,
    engine_version: 'marrow@test', causation_id: null, correlation_id: null,
    previous_event_hash: seq > 1 ? 'prev' + seq : null, event_hash: 'hash' + seq,
    payload: ev };
}
function toRows(evs: MarrowEvent[], identity: string): PersistedEventRow[] {
  return evs.map((e, i) => toRow(i + 1, e, identity));
}
function toCtx(s: MarrowState): AppraisalContext {
  return { associationWeight: s.associationWeight, trust: s.trust,
    defensiveness: s.defensiveness, moodBaseline: s.moodBaseline,
    needValidation: s.needValidation, needNovelty: s.needNovelty,
    needSecurity: s.needSecurity, traits: s.traits, confidence: 0.9,
    evidenceAssociationIds: [] };
}

interface Turn { events: MarrowEvent[]; finalState: MarrowState; trustDelta: number; moodDelta: number; }
function runTurn(prevState: MarrowState, action: DialogueAction,
  intensity: number, offsetSec: number): Turn {
  const obs = observation(iso(offsetSec), action, intensity);
  const apprResult = appraise(action, intensity, toCtx(prevState));
  const appr = appraisalEvt(iso(offsetSec + 1), apprResult.valenceDelta, obs.id);
  let state = applyEvent(prevState, obs);
  state = applyEvent(state, appr);
  const before = state.trust;
  const beforeMood = state.moodBaseline;
  const userEv = userDialogue(iso(offsetSec + 2), `${action}`, action, intensity,
    apprResult.valenceDelta, obs.id, appr.id);
  state = applyEvent(state, userEv);
  const comp = companionOutput(iso(offsetSec + 3), userEv.id);
  state = applyEvent(state, comp);
  return { events: [obs, appr, userEv, comp], finalState: state,
    trustDelta: state.trust - before, moodDelta: state.moodBaseline - beforeMood };
}
function runTicks(prevState: MarrowState, count: number, startOffsetSec: number): {
  events: MarrowEvent[]; finalState: MarrowState; finalOffsetSec: number;
} {
  let state = prevState;
  const events: MarrowEvent[] = [];
  let offset = startOffsetSec;
  for (let i = 0; i < count; i += 1) {
    const t = tick(iso(offset), 10);
    state = applyEvent(state, t);
    events.push(t); offset += 10;
  }
  return { events, finalState: state, finalOffsetSec: offset };
}
function snap(s: MarrowState): string {
  return `tr=${s.trust.toFixed(2).padStart(6)} mo=${s.moodBaseline.toFixed(2).padStart(6)} ` +
    `ar=${s.arousal.toFixed(2).padStart(6)} def=${s.defensiveness.toFixed(2).padStart(6)} ` +
    `cog=${s.cognitiveLoad.toFixed(2).padStart(6)} en=${s.energy.toFixed(2).padStart(6)}`;
}

// ==================================================================
// E1: 经历序列 → 未来响应
// ==================================================================

test('E1: 不同经历序列 → 相同输入后响应差异', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  let neg = initial;
  let pos = initial;
  let offNeg = 100;
  let offPos = 100;
  const negEvents: MarrowEvent[] = [];
  const posEvents: MarrowEvent[] = [];
  for (let i = 0; i < 15; i += 1) {
    const t1 = runTurn(neg, 'insult', 0.9, offNeg);
    negEvents.push(...t1.events); neg = t1.finalState; offNeg += 4;
    const t2 = runTurn(pos, 'compliment', 0.9, offPos);
    posEvents.push(...t2.events); pos = t2.finalState; offPos += 4;
  }

  // 历史后立即输入相同测试 comfort
  const testNeg = runTurn(neg, 'comfort', 0.8, offNeg + 1000);
  const testPos = runTurn(pos, 'comfort', 0.8, offPos + 1000);

  console.log('\n[E1] 相同初始 → 15×insult vs 15×compliment → 相同测试 comfort');
  console.log(`  neg 历史: ${snap(neg)}`);
  console.log(`  pos 历史: ${snap(pos)}`);
  console.log(`  相同测试后: neg=${snap(testNeg.finalState)}`);
  console.log(`  相同测试后: pos=${snap(testPos.finalState)}`);
  console.log(`  测试 trustDelta: neg=${testNeg.trustDelta.toFixed(3)} pos=${testPos.trustDelta.toFixed(3)}`);
  console.log(`  测试 moodDelta:  neg=${testNeg.moodDelta.toFixed(3)} pos=${testPos.moodDelta.toFixed(3)}`);

  assert.ok(neg.trust < pos.trust, 'neg trust must be lower');
  assert.ok(testNeg.trustDelta < testPos.trustDelta || testNeg.finalState.trust < testPos.finalState.trust,
    '相同正向输入后，负历史组的 trust 应更低（或 trustDelta 更小）');
  assert.ok(neg.moodBaseline < pos.moodBaseline, 'neg mood must be lower');
});

// ==================================================================
// E2: 时间分布 → 长期影响
// ==================================================================

test('E2: 相同负面经历总量 → 不同时间分布 → 长期影响', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  // A: 20×insult 密集（间隔 4 秒/次）
  let A = initial;
  let offA = 100;
  const Aevents: MarrowEvent[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t = runTurn(A, 'insult', 0.9, offA);
    Aevents.push(...t.events); A = t.finalState; offA += 4;
  }
  const AafterTicks = runTicks(A, 100, offA);

  // B: 20×insult 分散（每次之间插 20 tick ≈ 3.3 分钟）
  let B = initial;
  let offB = 100;
  const Bevents: MarrowEvent[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t = runTurn(B, 'insult', 0.9, offB);
    Bevents.push(...t.events); B = t.finalState; offB += 4;
    const midTicks = runTicks(B, 20, offB);
    Bevents.push(...midTicks.events); B = midTicks.finalState; offB = midTicks.finalOffsetSec;
  }
  // 让两组后续 tick 数接近
  void AafterTicks;
  const BextraTicks = runTicks(B, 400, offB); // 让总 tick ≈ 400
  void BextraTicks;

  console.log('\n[E2] 密集 vs 分散 20×insult + 长时间 Tick');
  console.log(`  A (密集)  最终: ${snap(AafterTicks.finalState)}`);
  console.log(`  B (分散)  最终: ${snap(BextraTicks.finalState)}`);
  console.log(`  trust 差异: ${AafterTicks.finalState.trust.toFixed(2)} vs ${BextraTicks.finalState.trust.toFixed(2)}`);
  console.log(`  mood 差异: ${AafterTicks.finalState.moodBaseline.toFixed(2)} vs ${BextraTicks.finalState.moodBaseline.toFixed(2)}`);
  console.log(`  def  差异: ${AafterTicks.finalState.defensiveness.toFixed(2)} vs ${BextraTicks.finalState.defensiveness.toFixed(2)}`);

  // ⚠️ 反直觉发现：trust 居然不同！
  // 因为 Tick 虽然不直接修改 trust，但 Tick 修改 mood → moodFactor 变化 →
  // 下次对话的 trustDelta 不同（trustDelta = actionValue × intensity × 2 × moodFactor）
  console.log(`\n  trust 不同是因为中间 Tick 修改了 mood → moodFactor → 每次 insult 的 trustDelta 不同`);
  console.log(`  这证明：**时间分布对 trust 的长期演化有间接影响**（尽管 Tick 不直接改 trust）`);
  console.log(`  密集组 mood 降得更快 → moodFactor=2−mood/50 更大 → 每次 insult 破坏 trust 更多`);
  console.log(`  分散组中间 Tick 有 mood 波动 → 部分 insult 时 moodFactor 稍小 → trust 破坏稍少`);

  assert.notEqual(AafterTicks.finalState.trust, BextraTicks.finalState.trust,
    '时间分布间接影响 trust（通过 moodFactor）');
});

// ==================================================================
// E3: 正向修复曲线 — 多少 comforts 能打破锁死
// ==================================================================

function buildLocked(): { events: MarrowEvent[]; state: MarrowState; offset: number } {
  counter = 0;
  let state = createInitialState(BASE_TS);
  const events: MarrowEvent[] = [];
  let offset = 100;
  for (let i = 0; i < 25; i += 1) {
    const t = runTurn(state, 'insult', 0.95, offset);
    events.push(...t.events); state = t.finalState; offset += 4;
  }
  for (let i = 0; i < 20; i += 1) {
    const tt = tick(iso(offset), 10);
    state = applyEvent(state, tt); events.push(tt); offset += 10;
  }
  return { events, state, offset };
}

test('E3: 锁死态正向修复曲线 — 多少 comforts 能让 trust≥30', () => {
  const lock = buildLocked();
  let state = lock.state;
  let offset = lock.offset;

  console.log('\n[E3] 锁死态 → 正向修复曲线（每 10 comforts 采样一次）');
  console.log('  comforts   trust    mood     def      cog      双门控   def<60?');

  const records: { n: number; trust: number; mood: number; def: number; cog: number; doubleGateOpen: boolean }[] = [];
  records.push({ n: 0, trust: state.trust, mood: state.moodBaseline, def: state.defensiveness,
    cog: state.cognitiveLoad, doubleGateOpen: state.trust < 30 && state.moodBaseline < 40 });

  let comfortsUsed = 0;
  while (comfortsUsed < 300 && state.trust < 30) {
    for (let i = 0; i < 10; i += 1) {
      const t = runTurn(state, 'comfort', 0.95, offset);
      state = t.finalState; offset = (runTicks(state, 0, 0).finalOffsetSec);
      // 用 turn 结果，更新 offset
      offset += 4;
    }
    comfortsUsed += 10;
    const doubleGateOpen = state.trust < 30 && state.moodBaseline < 40;
    records.push({ n: comfortsUsed, trust: state.trust, mood: state.moodBaseline,
      def: state.defensiveness, cog: state.cognitiveLoad, doubleGateOpen });
    console.log(`  ${String(comfortsUsed).padEnd(10)} ${snap(state)} trust≥30?${state.trust >= 30}`);
  }

  // ⚠️ 关键源码事实：trustDelta 中的 moodFactor 对于正向 = mood/50
  // 当 mood=0 时 moodFactor=0 → trustDelta=0 × intensity × 2 = 完全归零！
  // 再乘以 attentionMod ≤ 0.44 → 正向恢复 trust 的速度实际上为零
  // 所以在锁死态(mood已经接近0)下，comfort 无法让 trust 上升到 30
  assert.ok(state.trust < 30,
    `锁死态下 moodFactor=0 导致正向 trustDelta 完全归零 → 不可能用 comfort 让 trust≥30`);
  console.log(`\n  ⚠️ 发现：锁死态下正向 trustDelta 被 moodFactor=0 完全归零！`);
  console.log(`  最终 trust=${state.trust.toFixed(2)}  mood=${state.moodBaseline.toFixed(2)}`);
  console.log(`  moodFactor for positive = mood/50 = ${(state.moodBaseline / 50).toFixed(4)} → trustDelta 被归零`);
  console.log(`  结论：锁死态通过正向互动恢复 trust **理论上不可能**（源码设计缺陷）`);
});

// ==================================================================
// E4: 单次强烈 vs 多次普通
// ==================================================================

test('E4: 1×insult(1.0) vs 5×insult(0.2) — 相同总强度不同分布', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  let A = initial;
  let B = initial;
  let offA = 100;
  let offB = 100;

  const tA = runTurn(A, 'insult', 1.0, offA);
  A = tA.finalState;

  let cumTrustDeltaB = 0;
  let cumMoodDeltaB = 0;
  for (let i = 0; i < 5; i += 1) {
    const tB = runTurn(B, 'insult', 0.2, offB);
    B = tB.finalState; offB += 4;
    cumTrustDeltaB += tB.trustDelta;
    cumMoodDeltaB += tB.moodDelta;
  }

  console.log('\n[E4] 1×insult(1.0) vs 5×insult(0.2) — 理论总 actionValue×intensity 相同');
  console.log(`  A (1×1.0): trust=${A.trust.toFixed(3)} mood=${A.moodBaseline.toFixed(3)} arousal=${A.arousal.toFixed(3)}`);
  console.log(`  B (5×0.2): trust=${B.trust.toFixed(3)} mood=${B.moodBaseline.toFixed(3)} arousal=${B.arousal.toFixed(3)}`);
  console.log(`  trustDelta 单次: ${tA.trustDelta.toFixed(3)}  5次累计: ${cumTrustDeltaB.toFixed(3)}`);
  console.log(`  moodDelta 单次: ${tA.moodDelta.toFixed(3)}   5次累计: ${cumMoodDeltaB.toFixed(3)}`);

  // 由于 trust clamp [-5, 5]，单次强输入可能被 clamp 截断而多次不会
  // 多次输入还叠加 moodFactor 的变化（每次对话 mood 都变化 → moodFactor 变化）
  console.log(`  差异来源：(1) trustDelta clamp ±5；(2) 多次输入时 moodFactor 逐次变化；(3) arousal 每次都累加（不区分正负）`);

  assert.ok(tA.trustDelta <= 0, 'insult 必须降 trust');
  assert.ok(cumTrustDeltaB <= 0, 'insult 必须降 trust');
});

// ==================================================================
// E5: 先形成判断 → 反向证据修正
// ==================================================================

test('E5: 先形成锁死态 → 持续正向 → 需要多少次才能解锁', () => {
  const lock = buildLocked();
  let state = lock.state;
  let offset = lock.offset;

  console.log('\n[E5] 锁死态 → 持续正向 → 解锁过程（每 20 comforts 采样 + 1 tick 让 def 衰减）');
  console.log('  round  trust    mood     def      cog      双门控  regress  def<60  cog<70');

  let comfortsTotal = 0;
  let ticksAfter = 0;
  let doubleGateClosed = false;
  let defBelow60 = false;
  let canRegress = false;

  for (let round = 0; round < 15 && !canRegress; round += 1) {
    // 20 comforts
    for (let i = 0; i < 20; i += 1) {
      const t = runTurn(state, 'comfort', 0.95, offset);
      state = t.finalState; offset += 4;
    }
    comfortsTotal += 20;

    // 加 20 tick 让 def 衰减
    const t = runTicks(state, 20, offset);
    state = t.finalState; offset = t.finalOffsetSec;
    ticksAfter += 20;

    const doubleGate = state.trust < 30 && state.moodBaseline < 40;
    const regress = !state.sleeping && state.cognitiveLoad < 70 && state.defensiveness < 60;
    if (!doubleGate) doubleGateClosed = true;
    if (state.defensiveness < 60) defBelow60 = true;
    if (regress) canRegress = true;

    console.log(`  ${String(round).padEnd(6)} ${snap(state)}  DG?${!doubleGateClosed} regress?${canRegress} def<60?${state.defensiveness < 60} cog<70?${state.cognitiveLoad < 70}`);
  }

  console.log(`\n  锁死态 → 可以 mood 回归 (canRegress) 需要:`);
  console.log(`    comforts: ${comfortsTotal} 次`);
  console.log(`    中间 tick: ${ticksAfter}`);
  console.log(`    双门控关闭: ${doubleGateClosed}`);
  console.log(`    def < 60:   ${defBelow60}`);
  console.log(`    canRegress: ${canRegress}`);
});

// ==================================================================
// E6: 极端恢复路径比较
// ==================================================================

test('E6: 极端 Def 状态下不同恢复路径比较', () => {
  counter = 0;
  const lock = buildLocked();
  const base = lock.state;
  const baseOff = lock.offset;

  const runPath = (pathName: string, fn: (s: MarrowState, off: number) => { state: MarrowState; off: number; events: MarrowEvent[] }) => {
    let s = base;
    let off = baseOff;
    const evs: MarrowEvent[] = [...lock.events];
    const result = fn(s, off);
    const final = runTicks(result.state, 100, result.off);
    evs.push(...result.events, ...final.events);
    return { pathName, final: final.finalState, events: evs };
  };

  const path1 = runPath('纯 Tick', (s, off) => {
    const r = runTicks(s, 500, off);
    return { state: r.finalState, off: r.finalOffsetSec, events: r.events };
  });

  const path2 = runPath('睡眠', (s, off) => {
    const ent = sleep(iso(off), true); let st = applyEvent(s, ent);
    const tcks = runTicks(st, 50, off + 1); st = tcks.finalState;
    const wk = sleep(iso(tcks.finalOffsetSec), false); st = applyEvent(st, wk);
    const restTick = runTicks(st, 100, tcks.finalOffsetSec + 1);
    return { state: restTick.finalState, off: restTick.finalOffsetSec,
      events: [ent, ...tcks.events, wk, ...restTick.events] };
  });

  const path3 = runPath('200 comforts + tick', (s, off) => {
    let st = s; const evs: MarrowEvent[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t = runTurn(st, 'comfort', 0.95, off);
      evs.push(...t.events); st = t.finalState; off += 4;
    }
    const tcks = runTicks(st, 100, off);
    return { state: tcks.finalState, off: tcks.finalOffsetSec, events: [...evs, ...tcks.events] };
  });

  const path4 = runPath('200 comforts + 睡眠', (s, off) => {
    let st = s; const evs: MarrowEvent[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t = runTurn(st, 'comfort', 0.95, off);
      evs.push(...t.events); st = t.finalState; off += 4;
    }
    const ent = sleep(iso(off), true); st = applyEvent(st, ent); evs.push(ent);
    const tcks = runTicks(st, 50, off + 1); st = tcks.finalState; evs.push(...tcks.events);
    const wk = sleep(iso(tcks.finalOffsetSec), false); st = applyEvent(st, wk); evs.push(wk);
    const restTick = runTicks(st, 50, tcks.finalOffsetSec + 1);
    return { state: restTick.finalState, off: restTick.finalOffsetSec,
      events: [...evs, ...restTick.events] };
  });

  console.log('\n[E6] 极端锁死态不同恢复路径（100 额外 tick 后采样）');
  console.log(`  ${'路径'.padEnd(22)} trust    mood     def      cog      canRegress`);
  for (const p of [path1, path2, path3, path4]) {
    const s = p.final;
    const regress = !s.sleeping && s.cognitiveLoad < 70 && s.defensiveness < 60;
    console.log(`  ${p.pathName.padEnd(22)} ${snap(s)}  regress?${regress}`);
  }

  assert.ok(path3.final.trust > path1.final.trust, '正向应能提高 trust');
});

// ==================================================================
// E7: 记忆衰减 → 长期影响
// ==================================================================

test('E7: EpisodicBuffer 衰减后，长期状态不应不合理消失', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  // 先让 runtime 有一些 episodic memory 形成机会
  let state = initial;
  let offset = 100;
  const events: MarrowEvent[] = [];
  // 10次高强度对话（满足记忆形成门槛 intensity≥0.5 AND |moodDelta|≥1）
  for (let i = 0; i < 10; i += 1) {
    const t = runTurn(state, 'insult', 0.95, offset);
    events.push(...t.events); state = t.finalState; offset += 4;
  }
  // 让 buffer 的 salience 充分衰减 — 跑 365 天的 tick
  const DAY = 86400;
  // 30-day half-life: decay 99% needs 7 half-lives = 210 days
  const runDays = 210;
  const tickCount = Math.floor(DAY * runDays / 10);
  console.log(`\n[E7] 跑 ${runDays} 天 tick (≈ ${tickCount} ticks) 让 episodicBuffer 几乎完全衰减`);
  const r = runTicks(state, tickCount, offset);
  console.log(`  衰减后 trust: ${r.finalState.trust.toFixed(2)} (理论不变)`);
  console.log(`  衰减后 mood:  ${r.finalState.moodBaseline.toFixed(2)}`);
  console.log(`  衰减后 def:   ${r.finalState.defensiveness.toFixed(2)}`);
  console.log(`  buffer.length: ${r.finalState.episodicBuffer.length}`);
  console.log(`  buffer 总 salience: ${r.finalState.episodicBuffer.reduce((a, m) => a + m.salience, 0).toFixed(4)}`);

  // 关键验证：episodicBuffer 完全衰减后，trust/mood/def 等状态不应不合理地回到初始值
  // 这些字段不由 episodicBuffer 驱动（Buffer 只影响 applyDialogue 中的 evokeMemoryFromText）
  assert.equal(r.finalState.trust, state.trust, 'trust 完全不依赖 episodicBuffer 衰减');
});

// ==================================================================
// E8: Replay 确定性 — 完整集成链
// ==================================================================

test('E8: Replay 确定性 — 完整 经历→锁死→修复 链', () => {
  counter = 0;
  // 构造完整链：25×insult→锁死→300 comfort→解锁
  const lock = buildLocked();
  let state = lock.state;
  let offset = lock.offset;
  const allEvents: MarrowEvent[] = [...lock.events];

  for (let i = 0; i < 300; i += 1) {
    const t = runTurn(state, 'comfort', 0.95, offset);
    allEvents.push(...t.events); state = t.finalState; offset += 4;
  }
  const finalTicks = runTicks(state, 100, offset);
  allEvents.push(...finalTicks.events);

  const rows = toRows([genesis(BASE_TS), ...allEvents], 'test-e8');
  const first = replayPersistedEvents('test-e8', rows);
  const second = replayPersistedEvents('test-e8', rows);

  assert.equal(first.verdict, 'valid', `replay 失败: ${first.errors[0]?.message}`);
  assert.equal(second.verdict, 'valid');
  assert.deepEqual(first.finalState, second.finalState, '两次 replay 必须完全一致');
  assert.deepEqual(first.finalState, finalTicks.finalState, 'replay 必须与 direct 完全一致');

  console.log(`\n[E8] 完整链 replay 通过 (${allEvents.length} events, 25×insult→300×comfort→100 ticks)`);
  console.log(`  final: ${snap(finalTicks.finalState)}`);
  console.log(`  verdict: ${first.verdict}`);
});
