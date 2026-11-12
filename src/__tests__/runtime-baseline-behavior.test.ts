/**
 * runtime-baseline-behavior.test.ts — M1.6.2 当前 Runtime 基线行为实验
 *
 * 纯内存构造事件 + 手动 applyEvent 驱动 RuntimeState，验证：
 *   1A 即时历史效应：多次 insult vs 多次 compliment 造成可区分的瞬时状态
 *   1B 瞬时状态消退：差异随 Tick 衰减
 *   2  时间衰减效应：同一段历史在不同时间间隔后影响不同
 *   3  新证据修正：多次 insult + 多次 comfort 能否修正瞬时 trust/defensiveness
 *
 * 每轮实验都附带：同事件链 replayPersistedEvents → 验证确定性。
 * 隔离 identity：所有事件在测试内存中构造，不写入生产 identity。
 *
 * 严禁：调用真实 LLM / 修改生产代码 / 新增 EventType / 修改 RuntimeState 接口。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent,
  createInitialState,
  type MarrowState,
} from '../state.js';
import { appraise, type AppraisalContext, type AppraisalResult } from '../appraisal.js';
import { replayPersistedEvents } from '../recovery.js';
import { type PersistedEventRow } from '../storage.js';
import type {
  DialogueEvent,
  ObservationEvent,
  AppraisalEvent,
  TickEvent,
  GenesisEvent,
  DialogueAction,
  MarrowEvent,
} from '../events.js';

// ==================================================================
// 辅助：确定性时间戳（避免 Date.now() / Math.random()）
// ==================================================================

const BASE_TS = '2026-11-11T00:00:00.000Z';
const BASE_SEC = Date.parse(BASE_TS) / 1000;

function iso(offsetSec: number): string {
  return new Date((BASE_SEC + offsetSec) * 1000).toISOString();
}

// ==================================================================
// 辅助：构造各类事件（纯函数，无随机、无墙钟、无 LLM）
// ==================================================================

let counter = 0;
function nextId(tag: string): string {
  counter += 1;
  return `${tag}-${String(counter).padStart(4, '0')}`;
}

function genesis(ts: string): GenesisEvent {
  return {
    type: 'genesis',
    id: nextId('genesis'),
    timestamp: ts,
    payload: {
      initialState: createInitialState(ts),
      configVersion: 2,
      initializedBy: 'runtime-baseline-test',
      seedEpisodicIds: [],
    },
  };
}

function tick(ts: string, deltaSeconds = 10): TickEvent {
  return {
    type: 'tick',
    id: nextId('tick'),
    timestamp: ts,
    payload: { deltaSeconds },
  };
}

function observation(
  ts: string,
  action: DialogueAction,
  intensity: number,
): ObservationEvent {
  return {
    type: 'observation',
    id: nextId('obs'),
    timestamp: ts,
    payload: {
      source: 'user_text',
      content: `test input: ${action} intensity=${intensity}`,
      action,
      intensity,
      confidence: 0.9,
      uncertainty: 0.1,
      facts: [
        { claim: action, confidence: 0.9 },
        { claim: String(intensity), confidence: 0.9 },
      ],
      extractorVersion: 'extractor-test',
      experienceValenceStatus: action === 'insult' ? 'observed' :
        action === 'compliment' || action === 'comfort' ? 'observed' : 'neutral',
      experienceValence: action === 'insult' ? -0.7 :
        action === 'compliment' ? 0.7 :
        action === 'comfort' ? 0.5 : 0,
    },
  };
}

function appraisal(ts: string, result: AppraisalResult, obsId: string): AppraisalEvent {
  return {
    type: 'appraisal',
    id: nextId('appr'),
    timestamp: ts,
    payload: {
      sourceObservationId: obsId,
      valenceDelta: result.valenceDelta,
      arousalDelta: result.arousalDelta,
      energyDelta: result.energyDelta,
      confidence: result.confidence,
      evidenceAssociationIds: [],
    },
  };
}

function userDialogue(
  ts: string, text: string, action: DialogueAction, intensity: number,
  moodDelta: number, observationId: string, appraisalId: string,
): DialogueEvent {
  return {
    type: 'dialogue',
    id: nextId('dlg'),
    timestamp: ts,
    payload: {
      direction: 'user_input', text, action, intensity, moodDelta,
      salience: 0.3, wordCount: text.length, observationId, appraisalId,
    },
  };
}

function companionOutput(ts: string, text: string, replyToEventId: string): DialogueEvent {
  return {
    type: 'dialogue',
    id: nextId('dlg'),
    timestamp: ts,
    payload: {
      direction: 'companion_output', text, moodDelta: 0, salience: 0.3,
      wordCount: text.length, candidateText: text, filtered: false, replyToEventId,
    },
  };
}

function toRow(seq: number, event: MarrowEvent, identityId: string): PersistedEventRow {
  return {
    sequence: String(seq),
    event_id: event.id,
    identity_id: identityId,
    timestamp: event.timestamp,
    event_type: event.type,
    schema_version: 2,
    engine_version: 'marrow@test',
    causation_id: null,
    correlation_id: null,
    previous_event_hash: seq > 1 ? 'prev-hash' + seq : null,
    event_hash: `hash-${seq}`,
    payload: event,
  };
}

function toAppraisalContext(state: MarrowState): AppraisalContext {
  return {
    associationWeight: state.associationWeight,
    trust: state.trust,
    defensiveness: state.defensiveness,
    moodBaseline: state.moodBaseline,
    needValidation: state.needValidation,
    needNovelty: state.needNovelty,
    needSecurity: state.needSecurity,
    traits: state.traits,
    confidence: 0.9,
    evidenceAssociationIds: [],
  };
}

// ==================================================================
// 辅助：完整构造一轮对话 + 推进状态
// ==================================================================

interface DialogueTurn {
  events: MarrowEvent[];
  finalState: MarrowState;
  appraisalResult: AppraisalResult;
  moodDelta: number;
  trustDelta: number;
}

function runDialogueTurn(
  prevState: MarrowState, action: DialogueAction, intensity: number,
  offsetSec: number, nextUserText: string,
): DialogueTurn {
  const obs = observation(iso(offsetSec), action, intensity);
  const apprResult = appraise(action, intensity, toAppraisalContext(prevState));
  const appr = appraisal(iso(offsetSec + 1), apprResult, obs.id);

  let state = prevState;
  state = applyEvent(state, obs);
  state = applyEvent(state, appr);

  const userEvent = userDialogue(iso(offsetSec + 2), nextUserText, action, intensity,
    apprResult.valenceDelta, obs.id, appr.id);
  state = applyEvent(state, userEvent);
  // applyDialogue 内部再次调用 appraise，重算 trustDelta/needDeltas
  const recomputed = appraise(action, intensity, toAppraisalContext(state));
  const companion = companionOutput(iso(offsetSec + 3), '收到', userEvent.id);
  state = applyEvent(state, companion);

  return {
    events: [obs, appr, userEvent, companion],
    finalState: state,
    appraisalResult: apprResult,
    moodDelta: apprResult.valenceDelta,
    trustDelta: recomputed.trustDelta,
  };
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
    events.push(t);
    offset += 10;
  }
  return { events, finalState: state, finalOffsetSec: offset };
}

// ==================================================================
// 实验 1A：即时历史效应
// ==================================================================

function buildHistory(
  initial: MarrowState, action: DialogueAction, intensity: number,
  count: number, baseOffsetSec: number,
): { events: MarrowEvent[]; finalState: MarrowState; finalOffsetSec: number } {
  let state = initial;
  const events: MarrowEvent[] = [];
  let offset = baseOffsetSec;
  for (let i = 0; i < count; i += 1) {
    const turn = runDialogueTurn(state, action, intensity, offset, `${action}#${i + 1}`);
    events.push(...turn.events);
    state = turn.finalState;
    offset += 4;
  }
  return { events, finalState: state, finalOffsetSec: offset };
}

test('实验 1A：即时历史效应 — 多次 insult vs compliment 造成可区分的瞬时状态', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  // 用 25×insult 把 mood 推到 40 以下、trust 推到 30 以下，才能同时触发
  // defensiveness 上升的双门控（trust < 30 AND mood < 40）
  const neg = buildHistory(initial, 'insult', 0.95, 25, 100);
  const pos = buildHistory(initial, 'compliment', 0.9, 25, 100);

  console.log('\n[1A] 25×insult vs 25×compliment 即时状态（无 Tick）');
  console.log(`  field              neg             pos             diff`);
  console.log(`  trust              ${neg.finalState.trust.toFixed(3).padEnd(14)}${pos.finalState.trust.toFixed(3).padEnd(14)}${(neg.finalState.trust - pos.finalState.trust).toFixed(3)}`);
  console.log(`  moodBaseline       ${neg.finalState.moodBaseline.toFixed(3).padEnd(14)}${pos.finalState.moodBaseline.toFixed(3).padEnd(14)}${(neg.finalState.moodBaseline - pos.finalState.moodBaseline).toFixed(3)}`);
  console.log(`  arousal            ${neg.finalState.arousal.toFixed(3).padEnd(14)}${pos.finalState.arousal.toFixed(3).padEnd(14)}${(neg.finalState.arousal - pos.finalState.arousal).toFixed(3)}`);
  console.log(`  defensiveness      ${neg.finalState.defensiveness.toFixed(3).padEnd(14)}${pos.finalState.defensiveness.toFixed(3).padEnd(14)}${(neg.finalState.defensiveness - pos.finalState.defensiveness).toFixed(3)}`);
  console.log(`  cognitiveLoad      ${neg.finalState.cognitiveLoad.toFixed(3).padEnd(14)}${pos.finalState.cognitiveLoad.toFixed(3).padEnd(14)}${(neg.finalState.cognitiveLoad - pos.finalState.cognitiveLoad).toFixed(3)}`);
  console.log(`  energy             ${neg.finalState.energy.toFixed(3).padEnd(14)}${pos.finalState.energy.toFixed(3).padEnd(14)}${(neg.finalState.energy - pos.finalState.energy).toFixed(3)}`);
  console.log(`  needSecurity       ${neg.finalState.needSecurity.toFixed(3).padEnd(14)}${pos.finalState.needSecurity.toFixed(3).padEnd(14)}${(neg.finalState.needSecurity - pos.finalState.needSecurity).toFixed(3)}`);
  console.log(`  needValidation     ${neg.finalState.needValidation.toFixed(3).padEnd(14)}${pos.finalState.needValidation.toFixed(3).padEnd(14)}${(neg.finalState.needValidation - pos.finalState.needValidation).toFixed(3)}`);

  // === Runtime 门控事实 ===
  // defensiveness 上升需要双门控：trust < TRUST_LOW_THRESHOLD(30) AND mood < MOOD_LOW_THRESHOLD(40)
  // cognitiveLoad 上升需要：mood < 40 AND defensiveness > 60
  // insult(0.95) ACTION_VALUE = -0.9, moodDelta = -0.9 * 0.95 * 1.0 * trustMul
  // trust 初始 50 → trustMul = 1.0 → 每 insult moodDelta ≈ -0.855
  // 25 次 insult → mood ≈ 50 - 25*0.855 = 50 - 21.4 = 28.6 (< 40 ✓)
  // trustDelta ≈ -0.9 * 0.95 * 2 * (2 - 1.0) / 1.0 = -3.42 → 25 次 → trust ≈ 50 - 85.5 → clamp 到 0
  // trust = 0 (< 30 ✓) AND mood = 28.6 (< 40 ✓) → defensiveness 开始上升
  assert.ok(neg.finalState.trust < pos.finalState.trust, 'neg trust 必须低于 pos');
  assert.ok(neg.finalState.moodBaseline < pos.finalState.moodBaseline, 'neg mood 必须低于 pos');
});

test('实验 1B：瞬时状态消退 — 差异随 Tick 衰减，但 trust 不衰减', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  const negBase = buildHistory(initial, 'insult', 0.95, 25, 100);
  const posBase = buildHistory(initial, 'compliment', 0.9, 25, 100);

  console.log('\n[1B] 不同 Tick 后的 neg-pos 差异');
  console.log('  ticks   trust    mood     arousal   def      cog      energy');
  for (const tCount of [0, 10, 100, 300, 1000, 3000]) {
    const negT = runTicks(negBase.finalState, tCount, negBase.finalOffsetSec).finalState;
    const posT = runTicks(posBase.finalState, tCount, posBase.finalOffsetSec).finalState;
    const diff = {
      trust: negT.trust - posT.trust,
      mood: negT.moodBaseline - posT.moodBaseline,
      arousal: negT.arousal - posT.arousal,
      def: negT.defensiveness - posT.defensiveness,
      cog: negT.cognitiveLoad - posT.cognitiveLoad,
      energy: negT.energy - posT.energy,
    };
    console.log(`  ${String(tCount).padEnd(8)}${Object.values(diff).map((v) => v.toFixed(2)).join('  ')}`);
  }

  const negLong = runTicks(negBase.finalState, 3000, negBase.finalOffsetSec).finalState;
  const posLong = runTicks(posBase.finalState, 3000, posBase.finalOffsetSec).finalState;

  // trust 不衰减，差异长期保持
  assert.ok(negLong.trust < posLong.trust, 'trust 差异应长期保持');

  // arousal 初始两组合都饱和到 100（25 次 insult/compliment 每次都推高 arousal），
  // tick 中均值回归 + 确定性随机游走；两组初始值相同 → 最终都接近 baseline 10。
  // 这里检查绝对值而非差异：neg arousal 应明显低于初始饱和值 100
  console.log(`  arousal 绝对值: negLong=${negLong.arousal.toFixed(2)}  posLong=${posLong.arousal.toFixed(2)}`);
  assert.ok(negLong.arousal < 50, 'neg arousal 应从 100 衰减到 50 以下');

  // moodBaseline 有稳态回归机制（非睡眠态，defensiveness<60 时向 50 回归）。
  // neg 组初始 mood=0（已 clamp 到下限），canRegress 可能不成立（看 defensiveness）；
  // pos 组初始 mood=67 → 回归到 50 附近。
  console.log(`  mood 绝对值: negLong=${negLong.moodBaseline.toFixed(2)}  posLong=${posLong.moodBaseline.toFixed(2)}`);

  // defensiveness 如果触发过双门控(tick 中上升)，长 tick 后应衰减到 0 附近
  console.log(`  defensiveness 绝对值: negLong=${negLong.defensiveness.toFixed(2)}  posLong=${posLong.defensiveness.toFixed(2)}`);
});

// ==================================================================
// 实验 2：时间衰减效应
// ==================================================================

test('实验 2：时间衰减效应 — 同历史在不同时间间隔后差异不同', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  let state = initial;
  const events: MarrowEvent[] = [];
  let offset = 100;
  // 前 3 次 comfort
  for (let i = 0; i < 3; i += 1) {
    const t = runDialogueTurn(state, 'comfort', 0.7, offset, `comfort#${i + 1}`);
    events.push(...t.events); state = t.finalState; offset += 4;
  }
  // 第 4 次 insult
  const insult = runDialogueTurn(state, 'insult', 0.9, offset, 'insult#4');
  events.push(...insult.events); state = insult.finalState; offset += 4;

  const X = state; // 立即
  const Y = runTicks(state, 3000, offset).finalState; // 3000 Tick ≈ 8.3h

  console.log('\n[2] 立即 vs 3000 Tick 后（8.3h）');
  console.log(`  field              X               Y               变化方向`);
  console.log(`  trust              ${X.trust.toFixed(2).padEnd(14)}${Y.trust.toFixed(2).padEnd(14)}${X.trust === Y.trust ? '(tick 不修改 trust)' : '?'}`);
  console.log(`  moodBaseline       ${X.moodBaseline.toFixed(2).padEnd(14)}${Y.moodBaseline.toFixed(2).padEnd(14)}`);
  console.log(`  arousal            ${X.arousal.toFixed(2).padEnd(14)}${Y.arousal.toFixed(2).padEnd(14)}  ↓（均值回归 10）`);
  console.log(`  defensiveness      ${X.defensiveness.toFixed(2).padEnd(14)}${Y.defensiveness.toFixed(2).padEnd(14)}  ↓（每秒 -1.2）`);
  console.log(`  cognitiveLoad      ${X.cognitiveLoad.toFixed(2).padEnd(14)}${Y.cognitiveLoad.toFixed(2).padEnd(14)}  ↓（每秒 -1.5）`);
  console.log(`  energy             ${X.energy.toFixed(2).padEnd(14)}${Y.energy.toFixed(2).padEnd(14)}  ↓（每秒 -0.05）`);

  assert.equal(X.trust, Y.trust, 'trust 在 tick 中不应变化');
  assert.ok(Y.arousal < X.arousal, 'arousal 必须回归基线');
  assert.ok(Y.defensiveness <= X.defensiveness, 'defensiveness 不应该上升');
  assert.ok(Y.cognitiveLoad <= X.cognitiveLoad, 'cognitiveLoad 不应该上升');
});

// ==================================================================
// 实验 3：新证据修正
// ==================================================================

test('实验 3：新证据修正 — 10×insult + 10×comfort 让 trust 回升', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  let Astate = initial;
  let Bstate = initial;
  let offsetA = 100;
  let offsetB = 100;

  for (let i = 0; i < 10; i += 1) {
    const A = runDialogueTurn(Astate, 'insult', 0.9, offsetA, `A-insult#${i + 1}`);
    Astate = A.finalState; offsetA += 4;
    const B = runDialogueTurn(Bstate, 'insult', 0.9, offsetB, `B-insult#${i + 1}`);
    Bstate = B.finalState; offsetB += 4;
  }
  // B 再做 15×comfort，让 trust 回升超过 30（可能拉回 mood 到 40 以上）
  for (let i = 0; i < 15; i += 1) {
    const B = runDialogueTurn(Bstate, 'comfort', 0.7, offsetB, `B-comfort#${i + 1}`);
    Bstate = B.finalState; offsetB += 4;
  }

  const Aend = Astate; // 10×insult 结束后（立即，无 Tick）
  const Bend = Bstate; // 10×insult+15×comfort 结束后（立即，无 Tick）
  const Await = runTicks(Astate, 100, offsetA).finalState;
  const Bwait = runTicks(Bstate, 100, offsetB).finalState;

  console.log('\n[3] 10×insult vs 10×insult+15×comfort');
  console.log('  === 即时（无 Tick）===');
  console.log(`  field              A (仅 insult)    B (insult+comfort)  B-A diff`);
  console.log(`  trust              ${Aend.trust.toFixed(2).padEnd(19)}${Bend.trust.toFixed(2).padEnd(19)}${(Bend.trust - Aend.trust).toFixed(2)}`);
  console.log(`  moodBaseline       ${Aend.moodBaseline.toFixed(2).padEnd(19)}${Bend.moodBaseline.toFixed(2).padEnd(19)}${(Bend.moodBaseline - Aend.moodBaseline).toFixed(2)}`);
  console.log(`  defensiveness      ${Aend.defensiveness.toFixed(2).padEnd(19)}${Bend.defensiveness.toFixed(2).padEnd(19)}${(Bend.defensiveness - Aend.defensiveness).toFixed(2)}`);
  console.log(`  arousal            ${Aend.arousal.toFixed(2).padEnd(19)}${Bend.arousal.toFixed(2).padEnd(19)}${(Bend.arousal - Aend.arousal).toFixed(2)}`);
  console.log(`  needSecurity       ${Aend.needSecurity.toFixed(2).padEnd(19)}${Bend.needSecurity.toFixed(2).padEnd(19)}${(Bend.needSecurity - Aend.needSecurity).toFixed(2)}`);

  console.log('\n  === 100 Tick 后 ===');
  console.log(`  trust              ${Await.trust.toFixed(2).padEnd(19)}${Bwait.trust.toFixed(2).padEnd(19)}${(Bwait.trust - Await.trust).toFixed(2)}`);
  console.log(`  moodBaseline       ${Await.moodBaseline.toFixed(2).padEnd(19)}${Bwait.moodBaseline.toFixed(2).padEnd(19)}${(Bwait.moodBaseline - Await.moodBaseline).toFixed(2)}`);
  console.log(`  defensiveness      ${Await.defensiveness.toFixed(2).padEnd(19)}${Bwait.defensiveness.toFixed(2).padEnd(19)}${(Bwait.defensiveness - Await.defensiveness).toFixed(2)}`);

  // 即时断言：comfort 必须让 trust 和 mood 回升
  assert.ok(Bend.trust > Aend.trust, '15×comfort 必须让 trust 回升（即时）');
  assert.ok(Bend.moodBaseline > Aend.moodBaseline, 'mood 必须回升（即时）');

  // 100 Tick 后：trust 差异依然存在（trust 不衰减）；
  //              mood 差异可能缩小（moodBaseline 有稳态回归 → 两组都向 50 靠拢）
  assert.ok(Bwait.trust > Await.trust, 'trust 差异在 100 Tick 后仍保持');
  console.log(`\n  mood 注意：100 Tick 后 mood 差异 = ${(Bwait.moodBaseline - Await.moodBaseline).toFixed(2)}`);
  console.log(`  （moodBaseline 在 tick 中有稳态回归机制 → 差异缩小是预期结果，不是失败）`);

  // 关键门控状态
  console.log(`\n  即时 defensiveness 门控 A: trust=${Aend.trust.toFixed(1)}<30? ${Aend.trust < 30}  mood=${Aend.moodBaseline.toFixed(1)}<40? ${Aend.moodBaseline < 40}`);
  console.log(`  即时 defensiveness 门控 B: trust=${Bend.trust.toFixed(1)}<30? ${Bend.trust < 30}  mood=${Bend.moodBaseline.toFixed(1)}<40? ${Bend.moodBaseline < 40}`);
});

// ==================================================================
// Replay 一致性验证
// ==================================================================

function toRows(events: MarrowEvent[], identity: string): PersistedEventRow[] {
  return events.map((e, i) => toRow(i + 1, e, identity));
}

test('Replay 1：长 insult 历史重跑最终状态完全相等', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  const hist = buildHistory(initial, 'insult', 0.95, 25, 100);
  const rows = toRows([genesis(BASE_TS), ...hist.events], 'test-replay-1');
  const replay = replayPersistedEvents('test-replay-1', rows);
  assert.equal(replay.verdict, 'valid', `Replay 失败: ${replay.errors[0]?.message}`);
  assert.deepEqual(replay.finalState, hist.finalState, 'Replay 最终状态必须完全相等');
});

test('Replay 2：相同事件链两次 Replay 结果完全相等', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  const hist = buildHistory(initial, 'compliment', 0.9, 25, 100);
  const rows = toRows([genesis(BASE_TS), ...hist.events], 'test-replay-2');
  const first = replayPersistedEvents('test-replay-2', rows);
  const second = replayPersistedEvents('test-replay-2', rows);
  assert.equal(first.verdict, 'valid');
  assert.equal(second.verdict, 'valid');
  assert.deepEqual(first.finalState, second.finalState);
});

test('Replay 3：历史 + 3000 Tick 完整链', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  let state = initial;
  const events: MarrowEvent[] = [];
  let offset = 100;
  for (let i = 0; i < 3; i += 1) {
    const t = runDialogueTurn(state, 'comfort', 0.7, offset, `c${i}`);
    events.push(...t.events); state = t.finalState; offset += 4;
  }
  const ins = runDialogueTurn(state, 'insult', 0.9, offset, 'ins');
  events.push(...ins.events); state = ins.finalState; offset += 4;
  const ticks = runTicks(state, 3000, offset);
  events.push(...ticks.events);

  const rows = toRows([genesis(BASE_TS), ...events], 'test-replay-3');
  const replay = replayPersistedEvents('test-replay-3', rows);
  assert.equal(replay.verdict, 'valid', `Replay 失败: ${replay.errors[0]?.message}`);
  assert.deepEqual(replay.finalState, ticks.finalState);
});

test('Replay 4：insult + comfort 混合历史 + 100 Tick', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);

  let state = initial;
  const events: MarrowEvent[] = [];
  let offset = 100;
  for (let i = 0; i < 10; i += 1) {
    const t = runDialogueTurn(state, 'insult', 0.9, offset, `i${i}`);
    events.push(...t.events); state = t.finalState; offset += 4;
  }
  for (let i = 0; i < 15; i += 1) {
    const t = runDialogueTurn(state, 'comfort', 0.7, offset, `c${i}`);
    events.push(...t.events); state = t.finalState; offset += 4;
  }
  const ticks = runTicks(state, 100, offset);
  events.push(...ticks.events);

  const rows = toRows([genesis(BASE_TS), ...events], 'test-replay-4');
  const replay = replayPersistedEvents('test-replay-4', rows);
  assert.equal(replay.verdict, 'valid', `Replay 失败: ${replay.errors[0]?.message}`);
  assert.deepEqual(replay.finalState, ticks.finalState);
});
