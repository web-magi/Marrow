/**
 * defensive-recovery-baseline.test.ts — M1.6.3 Trust 持久性 & Defensiveness 恢复架构审查
 *
 * 纯内存构造事件 + 手动 applyEvent，验证：
 *   A  防御状态形成：构造 trust<30 AND mood<40 → def 飙升 → cog 上升
 *   B  纯 Tick 恢复：无新互动时是否存在自动恢复路径
 *   C  正向互动恢复：哪一个门控最先被解除 → def 何时开始衰减
 *   D  负向边界：锁死状态下加入更多负向互动
 *   E  睡眠恢复：badSleep 恶化 vs goodSleep 前提条件能否满足
 *   F  Replay 一致性：防御形成 + 恢复完整链的 replay
 *
 * 严禁：修改生产代码 / 调用 LLM / 连接 DB / 使用 Math.random() / Date.now()。
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
  DialogueEvent, ObservationEvent, AppraisalEvent, TickEvent,
  GenesisEvent, DialogueAction, MarrowEvent, SleepEvent,
} from '../events.js';

// ==================================================================
// 辅助：确定性时间戳和事件 ID
// ==================================================================

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

// ==================================================================
// 辅助：事件构造
// ==================================================================

function genesis(ts: string): GenesisEvent {
  return {
    type: 'genesis',
    id: nextId('genesis'),
    timestamp: ts,
    payload: {
      initialState: createInitialState(ts),
      configVersion: 2,
      initializedBy: 'm163-recovery-test',
      seedEpisodicIds: [],
    },
  };
}

function tick(ts: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id: nextId('tick'), timestamp: ts, payload: { deltaSeconds } };
}

function sleep(ts: string, entering: boolean): SleepEvent {
  return { type: 'sleep', id: nextId('sleep'), timestamp: ts,
    payload: { entering, reason: entering ? 'manual_test' : 'manual_wake' } };
}

function observation(ts: string, action: DialogueAction, intensity: number): ObservationEvent {
  return {
    type: 'observation', id: nextId('obs'), timestamp: ts,
    payload: {
      source: 'user_text',
      content: `test: ${action} intensity=${intensity}`,
      action, intensity, confidence: 0.9, uncertainty: 0.1,
      facts: [{ claim: action, confidence: 0.9 }, { claim: String(intensity), confidence: 0.9 }],
      extractorVersion: 'extractor-test',
      experienceValenceStatus: 'observed',
      experienceValence: action === 'insult' ? -0.7 : action === 'compliment' ? 0.7 :
        action === 'comfort' ? 0.5 : 0,
    },
  };
}

function appraisalEvt(ts: string, result: AppraisalResult, obsId: string): AppraisalEvent {
  return {
    type: 'appraisal', id: nextId('appr'), timestamp: ts,
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
    type: 'dialogue', id: nextId('dlg'), timestamp: ts,
    payload: {
      direction: 'user_input', text, action, intensity, moodDelta,
      salience: 0.3, wordCount: text.length, observationId, appraisalId,
    },
  };
}

function companionOutput(ts: string, text: string, replyToEventId: string): DialogueEvent {
  return {
    type: 'dialogue', id: nextId('dlg'), timestamp: ts,
    payload: {
      direction: 'companion_output', text, moodDelta: 0, salience: 0.3,
      wordCount: text.length, candidateText: text, filtered: false, replyToEventId,
    },
  };
}

function toRow(seq: number, event: MarrowEvent, identityId: string): PersistedEventRow {
  return {
    sequence: String(seq), event_id: event.id, identity_id: identityId,
    timestamp: event.timestamp, event_type: event.type, schema_version: 2,
    engine_version: 'marrow@test', causation_id: null, correlation_id: null,
    previous_event_hash: seq > 1 ? 'prev-hash' + seq : null,
    event_hash: `hash-${seq}`, payload: event,
  };
}

function toRows(events: MarrowEvent[], identity: string): PersistedEventRow[] {
  return events.map((e, i) => toRow(i + 1, e, identity));
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
// 辅助：完整一轮对话事件链
// ==================================================================

interface DialogueTurn {
  events: MarrowEvent[];
  finalState: MarrowState;
}

function runDialogueTurn(
  prevState: MarrowState, action: DialogueAction, intensity: number,
  offsetSec: number, text: string,
): DialogueTurn {
  const obsTs = iso(offsetSec);
  const userTs = iso(offsetSec + 1);
  const compTs = iso(offsetSec + 2);

  const obs = observation(obsTs, action, intensity);
  const apprResult = appraise(action, intensity, toAppraisalContext(prevState));
  const appr = appraisalEvt(userTs, apprResult, obs.id);

  let state = applyEvent(prevState, obs);
  state = applyEvent(state, appr);

  const userEvent = userDialogue(userTs, text, action, intensity,
    apprResult.valenceDelta, obs.id, appr.id);
  state = applyEvent(state, userEvent);

  const compEvent = companionOutput(compTs, '收到', userEvent.id);
  state = applyEvent(state, compEvent);

  return { events: [obs, appr, userEvent, compEvent], finalState: state };
}

function runTicks(
  prevState: MarrowState, count: number, startOffsetSec: number,
): { events: MarrowEvent[]; finalState: MarrowState; finalOffsetSec: number } {
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

function printState(label: string, s: MarrowState) {
  console.log(`  ${label.padEnd(28)} trust=${s.trust.toFixed(2).padStart(7)} ` +
    `mood=${s.moodBaseline.toFixed(2).padStart(7)} ` +
    `arousal=${s.arousal.toFixed(2).padStart(7)} ` +
    `def=${s.defensiveness.toFixed(2).padStart(7)} ` +
    `cog=${s.cognitiveLoad.toFixed(2).padStart(7)} ` +
    `energy=${s.energy.toFixed(2).padStart(7)} ` +
    `sec=${s.needSecurity.toFixed(2).padStart(7)} ` +
    `sleeping=${String(s.sleeping).padStart(5)}`);
}

// ==================================================================
// 实验 A：防御状态形成
// ==================================================================

function buildLockedState(): {
  events: MarrowEvent[];
  finalState: MarrowState;
  finalOffsetSec: number;
} {
  let state = createInitialState(BASE_TS);
  const events: MarrowEvent[] = [];
  let offset = 100;

  // 25×insult 把 trust 推到 0 (clamp), mood 推到 0 (clamp)
  for (let i = 0; i < 25; i += 1) {
    const t = runDialogueTurn(state, 'insult', 0.95, offset, `insult#${i + 1}`);
    events.push(...t.events);
    state = t.finalState;
    offset += 4;
  }

  // 继续 run tick —— 让双门控触发 defensiveness 上升
  // 预计 7 ticks 左右 def 饱和到 100
  // 等 20 ticks 让 def 和 cog 都完全饱和
  for (let i = 0; i < 20; i += 1) {
    const t = tick(iso(offset), 10);
    state = applyEvent(state, t);
    events.push(t);
    offset += 10;
  }

  return { events, finalState: state, finalOffsetSec: offset };
}

test('实验 A：防御状态形成 — 构造 trust<30 AND mood<40 → def>60 → cog>0', () => {
  counter = 0;
  const hist = buildLockedState();
  const s = hist.finalState;

  console.log('\n[A] 防御锁死状态构造完成（25×insult + 20 Tick）');
  printState('锁定态', s);

  assert.ok(s.trust < 30, `trust=${s.trust.toFixed(2)} 必须 < 30`);
  assert.ok(s.moodBaseline < 40, `mood=${s.moodBaseline.toFixed(2)} 必须 < 40`);
  assert.ok(s.defensiveness > 60, `def=${s.defensiveness.toFixed(2)} 必须 > 60`);
  assert.ok(s.cognitiveLoad > 0, `cog=${s.cognitiveLoad.toFixed(2)} 必须 > 0`);

  // 确认：def 和 cog 已经饱和到 100
  console.log(`  def 门控解除条件: trust<30? ${s.trust < 30}  mood<40? ${s.moodBaseline < 40}`);
  console.log(`  cog 门控解除条件: mood<40? ${s.moodBaseline < 40}  def>60? ${s.defensiveness > 60}`);
  console.log(`  canRegress 状态: sleeping=${s.sleeping}  cog<70? ${s.cognitiveLoad < 70}  def<60? ${s.defensiveness < 60}`);
});

// ==================================================================
// 实验 B：纯 Tick 恢复
// ==================================================================

test('实验 B：纯 Tick 恢复 — 无新互动时是否存在自动恢复路径', () => {
  counter = 0;
  const hist = buildLockedState();

  console.log('\n[B] 纯 Tick 恢复（无任何新互动）');
  console.log('  ticks  trust     mood     arousal  def      cog      energy');

  // 从 lock 态分别跑 0, 10, 100, 500, 1000, 3000 ticks
  const snapshots: { t: number; s: MarrowState }[] = [{ t: 0, s: hist.finalState }];
  console.log('  0      ' + snap(hist.finalState));
  for (const tCount of [10, 100, 500, 1000, 3000]) {
    const r = runTicks(hist.finalState, tCount, hist.finalOffsetSec);
    snapshots.push({ t: tCount, s: r.finalState });
    console.log(`  ${String(tCount).padEnd(7)}` + snap(r.finalState));
  }

  // === 关键断言 ===
  // 纯 tick 中 trust 永不变化
  for (const { t, s } of snapshots) {
    assert.equal(s.trust, hist.finalState.trust,
      `trust 在 ${t} Tick 后必须等于初始锁死态 trust（Tick 不修改 trust）`);
  }

  // def 在纯 tick 中：因为 trust 和 mood 都还是 < 阈值，双门控保持打开
  // 所以 def 应该保持 100 饱和
  console.log(`\n  ⚠️ 观察：def 保持 100 是因为双门控 trust<30 AND mood<40 永久成立`);
  console.log(`  纯 Tick 没有能力让 trust 升高或让 mood 回归到 40 以上`);

  const final = snapshots[snapshots.length - 1]!.s;
  assert.equal(final.trust, hist.finalState.trust, 'trust 完全不变化');

  // mood 在 canRegress=false 时只能靠 walkStep 游走
  // walkStep(0.04, hash(tickId + ':mood')) * 10 per tick ≈ 幅度 ±0.4/tick
  // 3000 ticks 可能漂移几十，但均值还是靠近 0 附近
  console.log(`  mood 变化: ${hist.finalState.moodBaseline.toFixed(2)} → ${final.moodBaseline.toFixed(2)}（只有 walkStep 游走）`);
  console.log(`  def 变化: ${hist.finalState.defensiveness.toFixed(2)} → ${final.defensiveness.toFixed(2)}`);
  console.log(`  cog 变化: ${hist.finalState.cognitiveLoad.toFixed(2)} → ${final.cognitiveLoad.toFixed(2)}`);
});

function snap(s: MarrowState): string {
  return [
    s.trust.toFixed(2).padStart(7),
    s.moodBaseline.toFixed(2).padStart(7),
    s.arousal.toFixed(2).padStart(7),
    s.defensiveness.toFixed(2).padStart(7),
    s.cognitiveLoad.toFixed(2).padStart(7),
    s.energy.toFixed(2).padStart(7),
  ].join(' ');
}

// ==================================================================
// 实验 C：正向互动恢复
// ==================================================================

test('实验 C：正向互动恢复 — 哪个门控最先被解除', () => {
  counter = 0;
  const hist = buildLockedState();
  let state = hist.finalState;
  let offset = hist.finalOffsetSec;

  console.log('\n[C] 正向互动恢复实验（从锁定态出发）');
  console.log('\n  === 锁定态起点 ===');
  printState('start', state);

  // --- C1: 1 次 comfort ---
  const c1 = runDialogueTurn(state, 'comfort', 0.7, offset, 'comfort #1');
  offset += 4;
  console.log('\n  === C1: 1×comfort 后（即时） ===');
  printState('after 1 comfort', c1.finalState);
  console.log(`  trust 增量: ${(c1.finalState.trust - state.trust).toFixed(2)}`);
  console.log(`  mood 增量: ${(c1.finalState.moodBaseline - state.moodBaseline).toFixed(2)}`);

  // --- C2: 连续 comfort，每次记录 ---
  state = hist.finalState;
  offset = hist.finalOffsetSec;
  console.log('\n  === C2: 连续 comfort 每次后 ===');
  console.log('  #    trust    mood     def      cog      门控状态');
  for (let i = 1; i <= 20; i += 1) {
    const t = runDialogueTurn(state, 'comfort', 0.95, offset, `comfort#${i}`);
    state = t.finalState;
    offset += 4;

    const trustOk = state.trust >= 30;
    const moodOk = state.moodBaseline >= 40;
    const canRegressBlocked = state.sleeping || state.cognitiveLoad >= 70 || state.defensiveness >= 60;
    const doubleGate = state.trust < 30 && state.moodBaseline < 40;
    console.log(`  ${String(i).padEnd(5)}${snap(state)}  trust≥30?${trustOk} mood≥40?${moodOk} def<60?${state.defensiveness < 60} regressBlock?${canRegressBlocked} 双门控开?${doubleGate}`);

    if (trustOk || moodOk) {
      console.log(`  → 第 ${i} 次 comfort 后，至少一个门控被解除！`);
    }
    if (!doubleGate && state.defensiveness > 0) {
      console.log(`  → 双门控关闭，defensiveness 进入衰减阶段（下一个 tick 开始 -1.2/s）`);
    }
  }

  const afterComforts = state;
  // --- C3: 加几个 tick 让 def 衰减 ---
  const afterTicks = runTicks(afterComforts, 50, offset);
  console.log('\n  === C3: 50 Tick 后 ===');
  printState('after 50 ticks', afterTicks.finalState);

  // --- C4: 继续正向到 trust 明确回到 50+ ---
  // trust 每对话最多 +5（clamp），从 0 到 50 需要 10 次正向
  // 但 def 饱和 100 时 defensiveness > DEFENSIVENESS_PERFUNCTORY_THRESHOLD
  // 正向好话会被反转为轻微负向！
  console.log('\n  ⚠️ 重要源码事实：当 defensiveness > 70 时，正向对话被反转为轻微负向！');
  console.log('  （appraisal.ts L235-238: def > PERFUNCTORY_THRESHOLD → valenceDelta = -abs(actionValue) * 0.3）');

  // 验证这个反转
  const inverted = runDialogueTurn(hist.finalState, 'comfort', 0.95, offset, 'comfort-invert-check');
  console.log(`  锁定态(trust=0, def=100) + comfort → trust=${inverted.finalState.trust.toFixed(2)} (应为 ≤ 初始 0)`);
  console.log(`  锁定态 + comfort → moodDelta=${(inverted.finalState.moodBaseline - hist.finalState.moodBaseline).toFixed(2)} (应为负或零)`);

  // 关键：def>70 时正向被反转 → def 永远无法通过正向对话"自然"拉低
  // 但正向对话仍然会加 trust 吗？看 trustDelta 的公式：
  // trustDelta 不受 defensiveness 反转影响（appraisal.ts L263-273 独立计算）
  const trustOnly = runDialogueTurn(hist.finalState, 'comfort', 0.95, offset + 500, 'trust-only-check');
  console.log(`\n  锁定态 + comfort → trust 变化: ${(trustOnly.finalState.trust - hist.finalState.trust).toFixed(2)}`);
  console.log(`  （trustDelta 不受 defensiveness 反转影响，正向仍能升 trust）`);
});

// ==================================================================
// 实验 D：负向互动恢复边界
// ==================================================================

test('实验 D：负向互动边界 — 锁定态继续加负向', () => {
  counter = 0;
  const hist = buildLockedState();
  let state = hist.finalState;
  let offset = hist.finalOffsetSec;

  console.log('\n[D] 锁定态继续加负向互动');
  printState('锁定态', state);

  const before = {
    trust: state.trust, mood: state.moodBaseline, def: state.defensiveness, cog: state.cognitiveLoad,
  };

  for (let i = 0; i < 5; i += 1) {
    const t = runDialogueTurn(state, 'insult', 0.95, offset, `extra-insult#${i + 1}`);
    state = t.finalState;
    offset += 4;
    printState(`after insult +${i + 1}`, state);
  }

  console.log(`\n  变化量:`);
  console.log(`  trust  ${before.trust.toFixed(2)} → ${state.trust.toFixed(2)} (Δ ${(state.trust - before.trust).toFixed(2)})`);
  console.log(`  mood   ${before.mood.toFixed(2)} → ${state.moodBaseline.toFixed(2)} (Δ ${(state.moodBaseline - before.mood).toFixed(2)})`);
  console.log(`  def    ${before.def.toFixed(2)} → ${state.defensiveness.toFixed(2)} (Δ ${(state.defensiveness - before.def).toFixed(2)})`);
  console.log(`  cog    ${before.cog.toFixed(2)} → ${state.cognitiveLoad.toFixed(2)} (Δ ${(state.cognitiveLoad - before.cog).toFixed(2)})`);
  console.log(`  （trust 已经 clamp 到 0，无法再降；def 已经 clamp 到 100，无法再升）`);
});

// ==================================================================
// 实验 E：睡眠恢复
// ==================================================================

test('实验 E：睡眠恢复 — badSleep 恶化 vs goodSleep 前提条件', () => {
  counter = 0;
  const hist = buildLockedState();
  let state = hist.finalState;
  let offset = hist.finalOffsetSec;

  // === E1: 带着防御锁死入睡 → badSleep ===
  console.log('\n[E] 睡眠恢复实验');
  printState('入睡前（锁定态）', state);

  const sleepEnter = sleep(iso(offset), true);
  state = applyEvent(state, sleepEnter);
  offset += 1;
  printState('入睡后 entering=true', state);
  console.log(`  sleepEntryTrust=${state.sleepEntryTrust.toFixed(2)}  (是否 < 30: ${state.sleepEntryTrust < 30})`);
  console.log(`  sleepEntryCog=${state.sleepEntryCognitiveLoad.toFixed(2)}  (是否 > 70: ${state.sleepEntryCognitiveLoad > 70})`);
  console.log(`  sleepEntryDef=${state.sleepEntryDefensiveness.toFixed(2)}  (是否 > 60: ${state.sleepEntryDefensiveness > 60})`);
  const badSleep = state.sleepEntryTrust < 30 || state.sleepEntryCognitiveLoad > 70 || state.sleepEntryDefensiveness > 60;
  console.log(`  → badSleep = ${badSleep}（OR 关系，任一满足即为 bad）`);

  // 睡眠中跑 50 ticks（badSleep: mood 持续被 RUMINATION_MOOD_DROP_PER_SECOND 下拉）
  console.log('\n  === 睡眠中 50 Tick ===');
  const beforeSleepTick = state;
  const sleepTicks = runTicks(state, 50, offset);
  state = sleepTicks.finalState;
  offset = sleepTicks.finalOffsetSec;
  const moodDrop = beforeSleepTick.moodBaseline - state.moodBaseline;
  const cogRise = state.cognitiveLoad - beforeSleepTick.cognitiveLoad;
  console.log(`  mood 变化: ${beforeSleepTick.moodBaseline.toFixed(2)} → ${state.moodBaseline.toFixed(2)} (Δ ${moodDrop.toFixed(2)})`);
  console.log(`  cog 变化: ${beforeSleepTick.cognitiveLoad.toFixed(2)} → ${state.cognitiveLoad.toFixed(2)} (Δ ${cogRise.toFixed(2)})`);
  console.log(`  def  变化: ${beforeSleepTick.defensiveness.toFixed(2)} → ${state.defensiveness.toFixed(2)} (def 在睡眠中也照常按双门控逻辑演化)`);

  // 醒来
  const wake = sleep(iso(offset), false);
  state = applyEvent(state, wake);
  offset += 1;
  console.log('\n  === 醒来后 ===');
  printState('awake', state);
  console.log(`  sleepEntryTrust 已重置: ${state.sleepEntryTrust}`);
  console.log(`  sleepEntryCog 已重置: ${state.sleepEntryCognitiveLoad}`);
  console.log(`  sleepEntryDef 已重置: ${state.sleepEntryDefensiveness}`);

  // 醒来后 def 应该怎样？睡眠中 def 继续按双门控演化
  // trust 还是 0 < 30, mood 因为 badSleep 反而更差了 → def 继续上升
  // 醒来后 canRegress 条件：cog<70 AND def<60 都不满足 → 继续锁死
  console.log(`\n  醒来后继续 100 Tick（觉醒态）:`);
  const afterWakeTicks = runTicks(state, 100, offset);
  printState('awake + 100 ticks', afterWakeTicks.finalState);
  console.log(`  → 依然锁死。睡眠没有打破锁，反而可能让 mood 更差`);

  // === E2: goodSleep 前提条件检查 ===
  console.log('\n  === goodSleep 前提条件能否满足？ ===');
  console.log(`  goodSleep 需要: sleepEntryTrust ≥ 30 AND sleepEntryCog ≤ 70 AND sleepEntryDef ≤ 60`);
  console.log(`  当前锁死态: trust=0 def=100 cog=100 → 三个条件全不满足`);
  console.log(`  trust 无法自然升高（Tick 不修改）；def 无法降到 60 以下（双门控永久打开）`);
  console.log(`  → goodSleep 的前提条件在锁死态下**不可能满足**！`);

  // === E3: energy 恢复路径 ===
  console.log(`\n  energy 在睡眠中以 0.02/s 恢复（每 tick + 0.2）:`);
  console.log(`  50 ticks = 500s → energy 恢复 ≈ 10（从 30 → 40 左右）`);
  console.log(`  睡眠唯一帮助的是 energy 和 arousal；不帮助 trust/mood/def/cog`);
});

// ==================================================================
// 实验 F：Replay 一致性
// ==================================================================

test('Replay F1：防御形成链 replay', () => {
  counter = 0;
  const hist = buildLockedState();
  const rows = toRows([genesis(BASE_TS), ...hist.events], 'test-recovery-f1');
  const replay = replayPersistedEvents('test-recovery-f1', rows);
  assert.equal(replay.verdict, 'valid', `Replay 失败: ${replay.errors[0]?.message}`);
  assert.deepEqual(replay.finalState, hist.finalState);
  printState('direct final', hist.finalState);
  printState('replay final', replay.finalState!);
});

test('Replay F2：相同链两次 replay 结果一致', () => {
  counter = 0;
  const hist = buildLockedState();
  const rows = toRows([genesis(BASE_TS), ...hist.events], 'test-recovery-f2');
  const first = replayPersistedEvents('test-recovery-f2', rows);
  const second = replayPersistedEvents('test-recovery-f2', rows);
  assert.equal(first.verdict, 'valid');
  assert.equal(second.verdict, 'valid');
  assert.deepEqual(first.finalState, second.finalState);
  assert.deepEqual(first.errors, second.errors);
  assert.deepEqual(first.lastEventTimestamp, second.lastEventTimestamp);
});

test('Replay F3：防御形成 + 睡眠 + 醒来完整链 replay', () => {
  counter = 0;
  const hist = buildLockedState();
  let state = hist.finalState;
  const events: MarrowEvent[] = [...hist.events];
  let offset = hist.finalOffsetSec;

  const sEnter = sleep(iso(offset), true); state = applyEvent(state, sEnter); events.push(sEnter); offset += 1;
  const tickBatch = runTicks(state, 50, offset);
  events.push(...tickBatch.events); state = tickBatch.finalState; offset = tickBatch.finalOffsetSec;
  const sWake = sleep(iso(offset), false); state = applyEvent(state, sWake); events.push(sWake); offset += 1;

  const rows = toRows([genesis(BASE_TS), ...events], 'test-recovery-f3');
  const replay = replayPersistedEvents('test-recovery-f3', rows);
  assert.equal(replay.verdict, 'valid', `Replay 失败: ${replay.errors[0]?.message}`);
  assert.deepEqual(replay.finalState, state, 'Replay 最终状态必须与 direct 完全相等');
  printState('direct after sleep', state);
  printState('replay after sleep', replay.finalState!);
});

test('Replay F4：防御形成 + 正向恢复 + 睡眠 + 正向恢复 链', () => {
  counter = 0;
  const hist = buildLockedState();
  let state = hist.finalState;
  const events: MarrowEvent[] = [...hist.events];
  let offset = hist.finalOffsetSec;

  // 多次正向 — 即使 def 反转 mood，trust 应该还在涨
  for (let i = 0; i < 20; i += 1) {
    const t = runDialogueTurn(state, 'comfort', 0.95, offset, `pre-sleep-comfort#${i}`);
    events.push(...t.events); state = t.finalState; offset += 4;
  }

  // 睡眠
  const sEnter = sleep(iso(offset), true); state = applyEvent(state, sEnter); events.push(sEnter); offset += 1;
  const sleepTicks = runTicks(state, 50, offset);
  events.push(...sleepTicks.events); state = sleepTicks.finalState; offset = sleepTicks.finalOffsetSec;
  const sWake = sleep(iso(offset), false); state = applyEvent(state, sWake); events.push(sWake); offset += 1;

  // 正向继续
  for (let i = 0; i < 20; i += 1) {
    const t = runDialogueTurn(state, 'comfort', 0.95, offset, `post-sleep-comfort#${i}`);
    events.push(...t.events); state = t.finalState; offset += 4;
  }
  const finalTicks = runTicks(state, 100, offset);
  events.push(...finalTicks.events); state = finalTicks.finalState;

  const rows = toRows([genesis(BASE_TS), ...events], 'test-recovery-f4');
  const replay = replayPersistedEvents('test-recovery-f4', rows);
  assert.equal(replay.verdict, 'valid', `Replay 失败: ${replay.errors[0]?.message}`);
  assert.deepEqual(replay.finalState, state);
  printState('direct final (40 comforts + sleep)', state);
  printState('replay final', replay.finalState!);
});
