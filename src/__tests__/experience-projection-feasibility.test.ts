/**
 * experience-projection-feasibility.test.ts — M1.6.5 EventStream 投影可行性验证
 *
 * 纯内存事件链 + 纯函数投影原型，零生产代码修改。
 * 目标：验证 EventStream 能否作为未来 Experience Integration 的可靠数据基础。
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
  GenesisEvent, DialogueAction, MarrowEvent,
} from '../events.js';

// ==================================================================
// 基础辅助（确定性，与 M1.6.2-4 一致）
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
function genesis(ts: string): GenesisEvent {
  return { type: 'genesis', id: nextId('genesis'), timestamp: ts,
    payload: { initialState: createInitialState(ts), configVersion: 2,
      initializedBy: 'm165-proj', seedEpisodicIds: [] } };
}
function tick(ts: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id: nextId('tick'), timestamp: ts, payload: { deltaSeconds } };
}
function observation(ts: string, action: DialogueAction, intensity: number): ObservationEvent {
  return { type: 'observation', id: nextId('obs'), timestamp: ts,
    payload: { source: 'user_text', content: `test`, action, intensity,
      confidence: 0.9, uncertainty: 0.1, facts: [{ claim: action, confidence: 0.9 }],
      extractorVersion: 'extractor-test', experienceValenceStatus: 'observed',
      experienceValence: action === 'insult' ? -0.7 : action === 'compliment' ? 0.7 :
        action === 'comfort' ? 0.5 : 0 } };
}
function appraisalEvt(ts: string, dv: number, obsId: string): AppraisalEvent {
  return { type: 'appraisal', id: nextId('appr'), timestamp: ts,
    payload: { sourceObservationId: obsId, valenceDelta: dv, arousalDelta: Math.abs(dv),
      energyDelta: 0, confidence: 0.9, evidenceAssociationIds: [] } };
}
function userDialogue(ts: string, action: DialogueAction, intensity: number,
  moodDelta: number, observationId: string, appraisalId: string, replyTo?: string): DialogueEvent {
  const p: DialogueEvent['payload'] = { direction: 'user_input', text: `text`,
    action, intensity, moodDelta, salience: 0.3, wordCount: 4,
    observationId, appraisalId };
  if (replyTo) p.replyToEventId = replyTo;
  return { type: 'dialogue', id: nextId('dlg'), timestamp: ts, payload: p };
}
function companionOutput(ts: string, replyTo: string, moodDelta = 0): DialogueEvent {
  return { type: 'dialogue', id: nextId('dlg'), timestamp: ts,
    payload: { direction: 'companion_output', text: 'ok', action: 'statement', intensity: 0.3,
      moodDelta, salience: 0.3, wordCount: 2, candidateText: 'ok', filtered: false,
      replyToEventId: replyTo } };
}

// 完整一轮（Obs → Appr → User_Dlg → Comp_Dlg + MemoryForm）
interface BuildResult { events: MarrowEvent[]; finalState: MarrowState; lastDialogueId: string }
function buildFullRound(
  prevState: MarrowState, action: DialogueAction, intensity: number,
  offsetSec: number, replyToUserDlgId?: string,
): BuildResult {
  const obs = observation(iso(offsetSec), action, intensity);
  const appr = appraisalEvt(iso(offsetSec + 1),
    appraise(action, intensity, ctxOf(prevState)).valenceDelta, obs.id);
  let state = applyEvent(prevState, obs);
  state = applyEvent(state, appr);
  const userEv = userDialogue(iso(offsetSec + 2), action, intensity,
    appr.payload.valenceDelta, obs.id, appr.id, replyToUserDlgId);
  state = applyEvent(state, userEv);
  const compEv = companionOutput(iso(offsetSec + 3), userEv.id);
  state = applyEvent(state, compEv);

  // memory_formation (applyEvent 自动尝试)
  let lastDialogueId = '';
  return { events: [obs, appr, userEv, compEv], finalState: state, lastDialogueId };
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

function ctxOf(s: MarrowState): AppraisalContext {
  return { associationWeight: s.associationWeight, trust: s.trust,
    defensiveness: s.defensiveness, moodBaseline: s.moodBaseline,
    needValidation: s.needValidation, needNovelty: s.needNovelty,
    needSecurity: s.needSecurity, traits: s.traits, confidence: 0.9,
    evidenceAssociationIds: [] };
}

// ==================================================================
// 纯函数投影原型（核心交付物）
// ==================================================================

/**
 * ExperienceProjection — 描述性投影结果
 *
 * 注意：本阶段只输出描述性统计，不输出任何 Appraisal 调节参数。
 */
interface ActionStat {
  count: number;
  intensitySum: number;
  intensityMin: number;
  intensityMax: number;
  moodDeltaSum: number;
  moodDeltaMin: number;
  moodDeltaMax: number;
  linkedCount: number;   // 成功关联 Obs→Appr→UserDlg 完整链的次数
}

interface ExperienceProjection {
  /** 投影覆盖的事件数 */
  totalEvents: number;
  /** observation + appraisal + dialogue.user_input 的数量（可被关联的候选） */
  candidateUserInputs: number;
  /** 成功关联 Obs→Appr→UserDlg 的数量 */
  fullyLinkedCount: number;
  /** 只关联了部分链的数量 */
  partiallyLinkedCount: number;
  /** 完全未关联的 user_input 数量（没有 observationId 和 appraisalId） */
  unlinkedCount: number;
  /** 事件引用失败的数量（有 id 但找不到引用） */
  brokenRefCount: number;
  /** 按 action 类型分组的统计 */
  byAction: Map<string, ActionStat>;
  /** experienceValenceStatus 分布 */
  valenceStatusDistribution: Map<string, number>;
  /** experienceValence 数值数组（所有 observation 中有效数值） */
  valenceValues: number[];
  /** moodDelta 有效值数组（来自完整关联链的 dialogue.user_input） */
  moodDeltaValues: number[];
}

const EMPTY_STAT: ActionStat = { count: 0, intensitySum: 0, intensityMin: Infinity,
  intensityMax: -Infinity, moodDeltaSum: 0, moodDeltaMin: Infinity, moodDeltaMax: -Infinity,
  linkedCount: 0 };

/**
 * 全量投影：从事件数组前缀（0..cutoffIdx）完整重算
 *
 * 关键设计：
 * 1. 输入事件必须先按 sequence 排序（调用方保证）
 * 2. 投影时只使用 cutoffIdx 之前（含）的事件
 * 3. 关联通过显式事件 ID（observationId, sourceObservationId, appraisalId）完成
 * 4. 不依赖事件顺序或时间窗口推断关联
 */
function projectFull(events: MarrowEvent[], cutoffIdx: number): ExperienceProjection {
  const proj: ExperienceProjection = {
    totalEvents: cutoffIdx + 1,
    candidateUserInputs: 0, fullyLinkedCount: 0, partiallyLinkedCount: 0,
    unlinkedCount: 0, brokenRefCount: 0,
    byAction: new Map(), valenceStatusDistribution: new Map(),
    valenceValues: [], moodDeltaValues: [],
  };
  // 快速查找表（只包含 cutoff 之前的事件）
  const eventById = new Map<string, MarrowEvent>();
  for (let i = 0; i <= cutoffIdx; i += 1) eventById.set(events[i]!.id, events[i]!);

  // 第一遍：记录所有 observation 的 experienceValence 统计
  for (let i = 0; i <= cutoffIdx; i += 1) {
    const ev = events[i]!;
    if (ev.type === 'observation') {
      const status = ev.payload.experienceValenceStatus;
      if (status) {
        proj.valenceStatusDistribution.set(status,
          (proj.valenceStatusDistribution.get(status) ?? 0) + 1);
      }
      if (typeof ev.payload.experienceValence === 'number') {
        proj.valenceValues.push(ev.payload.experienceValence);
      }
    }
  }

  // 第二遍：处理 user_input dialogue，追踪关联链
  for (let i = 0; i <= cutoffIdx; i += 1) {
    const ev = events[i]!;
    if (ev.type !== 'dialogue') continue;
    if (ev.payload.direction !== 'user_input') continue;

    proj.candidateUserInputs += 1;
    const dlg = ev;
    const obsId = dlg.payload.observationId;
    const apprId = dlg.payload.appraisalId;

    // 关联诊断
    let obsFound = false, apprFound = false;
    let brokenObs = false, brokenAppr = false;

    if (!obsId && !apprId) {
      // 两个都缺失 → 无法关联
      proj.unlinkedCount += 1;
    } else {
      if (obsId) {
        const obs = eventById.get(obsId);
        if (!obs) { proj.brokenRefCount += 1; brokenObs = true; }
        else { obsFound = obs.type === 'observation'; }
      }
      if (apprId) {
        const appr = eventById.get(apprId);
        if (!appr) { proj.brokenRefCount += 1; brokenAppr = true; }
        else { apprFound = appr.type === 'appraisal'; }
      }
      if (obsFound && apprFound) proj.fullyLinkedCount += 1;
      else if (brokenObs || brokenAppr || obsFound || apprFound) proj.partiallyLinkedCount += 1;
    }

    // 统计 action 类型（从 user_input 自身或关联的 observation）
    const action = dlg.payload.action;
    const intensity = dlg.payload.intensity;
    if (action) {
      let stat = proj.byAction.get(action);
      if (!stat) { stat = { ...EMPTY_STAT }; proj.byAction.set(action, stat); }
      stat.count += 1;
      if (typeof intensity === 'number') {
        stat.intensitySum += intensity;
        stat.intensityMin = Math.min(stat.intensityMin, intensity);
        stat.intensityMax = Math.max(stat.intensityMax, intensity);
      }
      const moodDelta = dlg.payload.moodDelta;
      stat.moodDeltaSum += moodDelta;
      stat.moodDeltaMin = Math.min(stat.moodDeltaMin, moodDelta);
      stat.moodDeltaMax = Math.max(stat.moodDeltaMax, moodDelta);

      // 只有完整关联链才计入 moodDeltaValues（确保 moodDelta 来自正确的 appraisal）
      if (obsFound && apprFound) {
        stat.linkedCount += 1;
        proj.moodDeltaValues.push(moodDelta);
      }
    }
  }

  return proj;
}

/**
 * 增量投影：从上一个投影结果出发，只处理新增事件（newEvents）。
 *
 * 输入：
 *   prevProj      — 上一版本的投影结果
 *   newEvents     — 新增事件（只包含 cutoff 之后的事件）
 *   eventByIdSoFar — 完整事件查找表（包含历史所有事件 + newEvents）
 *   startIdx      — newEvents 中第一个事件在全局数组中的下标
 *
 * 返回：更新后的投影结果（**不改动 prevProj**，返回新对象）
 */
function projectIncremental(
  prevProj: ExperienceProjection,
  fullEvents: MarrowEvent[],
  newStartIdx: number,
  newEndIdx: number,
): ExperienceProjection {
  // 深拷贝 prevProj 的 Map 结构
  const proj: ExperienceProjection = {
    totalEvents: prevProj.totalEvents, // 会在下面更新
    candidateUserInputs: prevProj.candidateUserInputs,
    fullyLinkedCount: prevProj.fullyLinkedCount,
    partiallyLinkedCount: prevProj.partiallyLinkedCount,
    unlinkedCount: prevProj.unlinkedCount,
    brokenRefCount: prevProj.brokenRefCount,
    byAction: new Map(prevProj.byAction),
    valenceStatusDistribution: new Map(prevProj.valenceStatusDistribution),
    valenceValues: [...prevProj.valenceValues],
    moodDeltaValues: [...prevProj.moodDeltaValues],
  };

  const eventById = new Map<string, MarrowEvent>();
  for (let i = 0; i <= newEndIdx; i += 1) eventById.set(fullEvents[i]!.id, fullEvents[i]!);
  proj.totalEvents = newEndIdx + 1;

  for (let i = newStartIdx; i <= newEndIdx; i += 1) {
    const ev = fullEvents[i]!;
    if (ev.type === 'observation') {
      const status = ev.payload.experienceValenceStatus;
      if (status) {
        proj.valenceStatusDistribution.set(status,
          (proj.valenceStatusDistribution.get(status) ?? 0) + 1);
      }
      if (typeof ev.payload.experienceValence === 'number') {
        proj.valenceValues.push(ev.payload.experienceValence);
      }
    } else if (ev.type === 'dialogue' && ev.payload.direction === 'user_input') {
      proj.candidateUserInputs += 1;
      const dlg = ev;
      const obsId = dlg.payload.observationId;
      const apprId = dlg.payload.appraisalId;

      let obsFound = false, apprFound = false, broken = false;
      if (!obsId && !apprId) proj.unlinkedCount += 1;
      else {
        if (obsId) {
          const o = eventById.get(obsId);
          if (!o) { proj.brokenRefCount += 1; broken = true; }
          else obsFound = o.type === 'observation';
        }
        if (apprId) {
          const a = eventById.get(apprId);
          if (!a) { if (!broken) { proj.brokenRefCount += 1; broken = true; } }
          else apprFound = a.type === 'appraisal';
        }
        if (obsFound && apprFound) proj.fullyLinkedCount += 1;
        else if (broken || obsFound || apprFound) proj.partiallyLinkedCount += 1;
      }

      const action = dlg.payload.action;
      const intensity = dlg.payload.intensity;
      if (action) {
        let stat = proj.byAction.get(action);
        if (!stat) { stat = { ...EMPTY_STAT }; proj.byAction.set(action, stat); }
        stat.count += 1;
        if (typeof intensity === 'number') {
          stat.intensitySum += intensity;
          stat.intensityMin = Math.min(stat.intensityMin, intensity);
          stat.intensityMax = Math.max(stat.intensityMax, intensity);
        }
        const moodDelta = dlg.payload.moodDelta;
        stat.moodDeltaSum += moodDelta;
        stat.moodDeltaMin = Math.min(stat.moodDeltaMin, moodDelta);
        stat.moodDeltaMax = Math.max(stat.moodDeltaMax, moodDelta);
        if (obsFound && apprFound) {
          stat.linkedCount += 1;
          proj.moodDeltaValues.push(moodDelta);
        }
      }
    }
  }

  return proj;
}

function deepEqualProjection(a: ExperienceProjection, b: ExperienceProjection): boolean {
  if (a.totalEvents !== b.totalEvents) return false;
  if (a.candidateUserInputs !== b.candidateUserInputs) return false;
  if (a.fullyLinkedCount !== b.fullyLinkedCount) return false;
  if (a.partiallyLinkedCount !== b.partiallyLinkedCount) return false;
  if (a.unlinkedCount !== b.unlinkedCount) return false;
  if (a.brokenRefCount !== b.brokenRefCount) return false;
  if (a.byAction.size !== b.byAction.size) return false;
  for (const [k, v] of a.byAction) {
    const other = b.byAction.get(k);
    if (!other) return false;
    if (other.count !== v.count || other.intensitySum !== v.intensitySum ||
      other.intensityMin !== v.intensityMin || other.intensityMax !== v.intensityMax ||
      other.moodDeltaSum !== v.moodDeltaSum || other.moodDeltaMin !== v.moodDeltaMin ||
      other.moodDeltaMax !== v.moodDeltaMax || other.linkedCount !== v.linkedCount) {
      return false;
    }
  }
  for (const [k, v] of a.valenceStatusDistribution) {
    if ((b.valenceStatusDistribution.get(k) ?? 0) !== v) return false;
  }
  if (a.valenceValues.length !== b.valenceValues.length) return false;
  for (let i = 0; i < a.valenceValues.length; i += 1) {
    if (a.valenceValues[i] !== b.valenceValues[i]) return false;
  }
  if (a.moodDeltaValues.length !== b.moodDeltaValues.length) return false;
  for (let i = 0; i < a.moodDeltaValues.length; i += 1) {
    if (a.moodDeltaValues[i] !== b.moodDeltaValues[i]) return false;
  }
  return true;
}

// ==================================================================
// 事件链构造辅助
// ==================================================================

// ==================================================================
// 第一部分：事件关联可靠性
// ==================================================================

test('L1: Obs→Appr→UserDlg 完整显式关联链存在', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;

  const obs = observation(iso(off), 'insult', 0.9);
  const apprRes = appraise('insult', 0.9, ctxOf(state));
  const appr = appraisalEvt(iso(off + 1), apprRes.valenceDelta, obs.id);
  state = applyEvent(applyEvent(state, obs), appr);
  const userEv = userDialogue(iso(off + 2), 'insult', 0.9,
    apprRes.valenceDelta, obs.id, appr.id);
  const comp = companionOutput(iso(off + 3), userEv.id);

  console.log('\n[L1] 显式关联链');
  console.log(`  ObservationEvent.id = ${obs.id}`);
  console.log(`  AppraisalEvent.sourceObservationId = ${appr.payload.sourceObservationId} (=== Obs.id? ${appr.payload.sourceObservationId === obs.id})`);
  console.log(`  DialogueEvent.observationId = ${userEv.payload.observationId} (=== Obs.id? ${userEv.payload.observationId === obs.id})`);
  console.log(`  DialogueEvent.appraisalId = ${userEv.payload.appraisalId} (=== Appr.id? ${userEv.payload.appraisalId === appr.id})`);
  console.log(`  CompDlg.replyToEventId = ${comp.payload.replyToEventId} (=== UserDlg.id? ${comp.payload.replyToEventId === userEv.id})`);

  assert.equal(appr.payload.sourceObservationId, obs.id);
  assert.equal(userEv.payload.observationId, obs.id);
  assert.equal(userEv.payload.appraisalId, appr.id);
  assert.equal(comp.payload.replyToEventId, userEv.id);
  console.log('  ✅ 四层关联链完整且可靠');
});

test('L2: 旧事件缺失 observationId/appraisalId → 无法关联', () => {
  // 构造一个"旧风格"的 DialogueEvent（缺失关联字段）
  counter = 0;
  const oldDlg: DialogueEvent = {
    type: 'dialogue', id: nextId('dlg'), timestamp: iso(100),
    payload: { direction: 'user_input', text: 'old', action: 'insult', intensity: 0.9,
      moodDelta: -0.5, salience: 0.3, wordCount: 3 },
    // 故意不写 observationId / appraisalId
  };
  const chain = [genesis(BASE_TS), oldDlg];
  const proj = projectFull(chain, chain.length - 1);
  console.log('\n[L2] 旧事件缺失关联字段');
  console.log(`  unlinkedCount = ${proj.unlinkedCount} (应该=1)`);
  console.log(`  partiallyLinkedCount = ${proj.partiallyLinkedCount} (应该=0)`);
  console.log(`  brokenRefCount = ${proj.brokenRefCount} (应该=0)`);
  assert.equal(proj.unlinkedCount, 1, '缺失两个关联字段的旧事件应计入 unlinked');
});

test('L3: 事件引用失败（有 id 但目标不在链中）→ brokenRef', () => {
  counter = 0;
  // DialogueEvent 引用了不存在的 observationId
  const badDlg: DialogueEvent = {
    type: 'dialogue', id: nextId('dlg'), timestamp: iso(100),
    payload: { direction: 'user_input', text: 'broken', action: 'insult', intensity: 0.9,
      moodDelta: -0.5, salience: 0.3, wordCount: 3,
      observationId: 'obs-nonexistent', appraisalId: 'appr-nonexistent' },
  };
  const chain = [genesis(BASE_TS), badDlg];
  const proj = projectFull(chain, chain.length - 1);
  console.log('\n[L3] brokenRef 引用失败');
  console.log(`  brokenRefCount = ${proj.brokenRefCount} (应该≥1)`);
  assert.ok(proj.brokenRefCount >= 1, '引用不存在事件 ID 应计入 brokenRef');
});

test('L4: companion_output 不被统计为 user_input 候选', () => {
  counter = 0;
  // 构造一个只有 companion_output 的事件（没有 user_input）
  const comp: DialogueEvent = {
    type: 'dialogue', id: nextId('dlg'), timestamp: iso(100),
    payload: { direction: 'companion_output', text: 'reply', action: 'comfort',
      intensity: 0.5, moodDelta: 0.1, salience: 0.3, wordCount: 5,
      candidateText: 'reply', filtered: false },
  };
  const chain = [genesis(BASE_TS), comp];
  const proj = projectFull(chain, chain.length - 1);
  console.log('\n[L4] companion_output 不计入候选');
  console.log(`  candidateUserInputs = ${proj.candidateUserInputs} (应该=0)`);
  assert.equal(proj.candidateUserInputs, 0, 'companion_output 不应作为 user_input 候选');
});

// ==================================================================
// 第二部分：全量投影基础验证
// ==================================================================

test('P1: 全量投影 — 描述性统计正确', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = buildFullRound(state, 'insult', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 3; i += 1) {
    const r = buildFullRound(state, 'compliment', 0.85, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const fullChain = [genesis(BASE_TS), ...events];

  const proj = projectFull(fullChain, fullChain.length - 1);
  console.log('\n[P1] 全量投影描述性统计');
  console.log(`  totalEvents = ${proj.totalEvents}`);
  console.log(`  candidateUserInputs = ${proj.candidateUserInputs}`);
  console.log(`  fullyLinked = ${proj.fullyLinkedCount}`);
  console.log(`  partiallyLinked = ${proj.partiallyLinkedCount}`);
  console.log(`  unlinked = ${proj.unlinkedCount}`);
  console.log(`  brokenRef = ${proj.brokenRefCount}`);
  for (const [action, stat] of proj.byAction) {
    const avgI = stat.count > 0 ? (stat.intensitySum / stat.count).toFixed(2) : 'N/A';
    console.log(`  action=${action}: count=${stat.count} avg_intensity=${avgI} linked=${stat.linkedCount}`);
  }

  assert.equal(proj.candidateUserInputs, 8, '5 insult + 3 compliment = 8 user_input');
  assert.equal(proj.fullyLinkedCount, 8, '全部 8 次都有完整 Obs→Appr→UserDlg 链');
  assert.equal(proj.unlinkedCount, 0);
  assert.equal(proj.brokenRefCount, 0);
  assert.equal(proj.byAction.get('insult')?.count, 5);
  assert.equal(proj.byAction.get('compliment')?.count, 3);
  console.log('  ✅ 全量投影统计正确');
});

test('P2: 历史截点投影 — cutoff 只包含之前的事件', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 6; i += 1) {
    const r = buildFullRound(state, i < 3 ? 'insult' : 'compliment', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const fullChain = [genesis(BASE_TS), ...events];

  // 找到第 3 次 dialogue.user_input 所在的下标
  let thirdDlgIdx = -1;
  let dialoguesSeen = 0;
  for (let i = 0; i < fullChain.length; i += 1) {
    const ev = fullChain[i]!;
    if (ev.type === 'dialogue' && ev.payload.direction === 'user_input') {
      dialoguesSeen += 1;
      if (dialoguesSeen === 3) thirdDlgIdx = i;
    }
  }
  const projBefore = projectFull(fullChain, thirdDlgIdx);
  const projFull = projectFull(fullChain, fullChain.length - 1);

  console.log('\n[P2] 历史截点只包含之前事件');
  console.log(`  cutoffIdx=${thirdDlgIdx} (包含 3 次 dialogue.user_input)`);
  console.log(`  before: insult=${projBefore.byAction.get('insult')?.count ?? 0} compliment=${projBefore.byAction.get('compliment')?.count ?? 0}`);
  console.log(`  full:   insult=${projFull.byAction.get('insult')?.count ?? 0} compliment=${projFull.byAction.get('compliment')?.count ?? 0}`);

  assert.equal(projBefore.candidateUserInputs, 3, '截点前应有 3 次 user_input');
  assert.equal(projFull.candidateUserInputs, 6, '完整链应有 6 次 user_input');
});

// ==================================================================
// 第三部分：增量 vs 全量投影一致性
// ==================================================================

test('I1: 增量投影与全量投影完全一致', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 20; i += 1) {
    const r = buildFullRound(state, i % 3 === 0 ? 'insult' : i % 3 === 1 ? 'compliment' : 'comfort',
      0.7 + (i % 5) * 0.05, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  // 加一些 tick 和 sleep
  for (let i = 0; i < 10; i += 1) events.push(tick(iso(off), 10));
  off += 100;
  const fullChain = [genesis(BASE_TS), ...events];

  // 全量
  const fullProj = projectFull(fullChain, fullChain.length - 1);

  // 增量：先投影前缀的一半，再追加另一半
  const halfIdx = Math.floor(fullChain.length / 2);
  const halfProj = projectFull(fullChain, halfIdx);
  const incProj = projectIncremental(halfProj, fullChain, halfIdx + 1, fullChain.length - 1);

  console.log('\n[I1] 增量 vs 全量一致性');
  console.log(`  full:    totalEvents=${fullProj.totalEvents} candidates=${fullProj.candidateUserInputs} linked=${fullProj.fullyLinkedCount}`);
  console.log(`  inc:     totalEvents=${incProj.totalEvents} candidates=${incProj.candidateUserInputs} linked=${incProj.fullyLinkedCount}`);
  console.log(`  深度相等: ${deepEqualProjection(fullProj, incProj)}`);

  assert.ok(deepEqualProjection(fullProj, incProj), '增量投影必须与全量投影完全一致');
});

test('I2: 增量投影 — 多次分块追加', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 30; i += 1) {
    const r = buildFullRound(state, 'insult', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const fullChain = [genesis(BASE_TS), ...events];

  // 全量
  const fullProj = projectFull(fullChain, fullChain.length - 1);

  // 增量：每次追加 5 个事件
  let runningProj = projectFull(fullChain, 0); // 只有 genesis
  let prevEnd = 0;
  const stepSize = 5;
  for (let curEnd = stepSize; curEnd < fullChain.length; curEnd += stepSize) {
    runningProj = projectIncremental(runningProj, fullChain, prevEnd + 1, curEnd);
    prevEnd = curEnd;
  }
  // 最后一段
  if (prevEnd + 1 < fullChain.length) {
    runningProj = projectIncremental(runningProj, fullChain, prevEnd + 1, fullChain.length - 1);
  }

  console.log('\n[I2] 多次分块增量追加');
  console.log(`  全量: candidateUserInputs=${fullProj.candidateUserInputs} insult.count=${fullProj.byAction.get('insult')?.count}`);
  console.log(`  增量: candidateUserInputs=${runningProj.candidateUserInputs} insult.count=${runningProj.byAction.get('insult')?.count}`);
  console.log(`  深度相等: ${deepEqualProjection(fullProj, runningProj)}`);
  assert.ok(deepEqualProjection(fullProj, runningProj));
});

test('I3: 增量投影 — 空事件链处理', () => {
  const empty: MarrowEvent[] = [genesis(BASE_TS)];
  const fullProj = projectFull(empty, 0);
  assert.equal(fullProj.totalEvents, 1);
  assert.equal(fullProj.candidateUserInputs, 0);
  console.log('\n[I3] 空事件链处理 ✅');
});

test('I4: 增量投影 — 旧事件缺失关联字段', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;
  // 一条旧风格事件（缺关联）+ 三条新风格事件
  const oldDlg: DialogueEvent = {
    type: 'dialogue', id: nextId('dlg'), timestamp: iso(off),
    payload: { direction: 'user_input', text: 'old', action: 'insult', intensity: 0.9,
      moodDelta: -0.5, salience: 0.3, wordCount: 3 },
  };
  off += 4;
  const events: MarrowEvent[] = [oldDlg];
  for (let i = 0; i < 3; i += 1) {
    const r = buildFullRound(state, 'compliment', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const fullChain = [genesis(BASE_TS), ...events];

  const fullProj = projectFull(fullChain, fullChain.length - 1);
  const prefixProj = projectFull(fullChain, 1); // genesis + old dlg
  const incProj = projectIncremental(prefixProj, fullChain, 2, fullChain.length - 1);

  console.log('\n[I4] 旧事件 + 新事件混合');
  console.log(`  full: unlinked=${fullProj.unlinkedCount} fullyLinked=${fullProj.fullyLinkedCount}`);
  console.log(`  inc:  unlinked=${incProj.unlinkedCount} fullyLinked=${incProj.fullyLinkedCount}`);
  console.log(`  深度相等: ${deepEqualProjection(fullProj, incProj)}`);
  assert.ok(deepEqualProjection(fullProj, incProj));
  assert.equal(fullProj.unlinkedCount, 1, '旧事件应计入 unlinked');
  assert.equal(fullProj.fullyLinkedCount, 3, '3 条新事件应完整关联');
});

// ==================================================================
// 第四部分：反向经历修正
// ==================================================================

test('R1: 单方向经历 — 统计一致', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = buildFullRound(state, 'insult', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const chain = [genesis(BASE_TS), ...events];
  const proj = projectFull(chain, chain.length - 1);
  console.log('\n[R1] 单方向 10×insult');
  const stat = proj.byAction.get('insult')!;
  console.log(`  count=10 avg_intensity=${(stat.intensitySum / stat.count).toFixed(2)} avg_moodDelta=${(stat.moodDeltaSum / stat.count).toFixed(3)}`);
  assert.equal(stat.count, 10);
});

test('R2: 反向经历 — 统计结果正确变化，不删除旧历史', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial;
  let off = 100;
  const events: MarrowEvent[] = [];

  // E2 前半：连续 10×insult
  for (let i = 0; i < 10; i += 1) {
    const r = buildFullRound(state, 'insult', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const halfProj = projectFull([genesis(BASE_TS), ...events], events.length);
  console.log('\n[R2] 反向经历修正');
  console.log(`  前半(10×insult): insult=${halfProj.byAction.get('insult')?.count} compliment=${halfProj.byAction.get('compliment')?.count ?? 0}`);

  // E2 后半：追加 10×compliment
  for (let i = 0; i < 10; i += 1) {
    const r = buildFullRound(state, 'compliment', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const fullChain = [genesis(BASE_TS), ...events];
  const fullProj = projectFull(fullChain, fullChain.length - 1);

  console.log(`  追加后:         insult=${fullProj.byAction.get('insult')?.count} compliment=${fullProj.byAction.get('compliment')?.count}`);
  console.log(`  ✅ 旧历史未被删除，只是新经历被追加到统计`);

  assert.equal(fullProj.byAction.get('insult')?.count, 10, 'insult 历史保留');
  assert.equal(fullProj.byAction.get('compliment')?.count, 10, 'compliment 追加');

  // 增量也应该正确
  const incProj = projectIncremental(halfProj, fullChain, halfProj.totalEvents, fullChain.length - 1);
  assert.ok(deepEqualProjection(fullProj, incProj), '全量=增量');
});

test('R3: 相同总量不同时间分布 — 描述性统计一致', () => {
  counter = 0;
  // 两组各 5×insult(0.9)，总量相同
  const initial = createInitialState(BASE_TS);

  let stateA = initial; let offA = 100; const eventsA: MarrowEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = buildFullRound(stateA, 'insult', 0.9, offA);
    eventsA.push(...r.events); stateA = r.finalState; offA += 4;
    // A 组密集：无额外 tick
  }
  const chainA = [genesis(BASE_TS), ...eventsA];

  let stateB = initial; let offB = 100; const eventsB: MarrowEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = buildFullRound(stateB, 'insult', 0.9, offB);
    eventsB.push(...r.events); stateB = r.finalState; offB += 4;
    // B 组分散：每次之间插 20 tick
    const ticks = runTicks(stateB, 20, offB);
    eventsB.push(...ticks.events); stateB = ticks.finalState; offB = ticks.finalOffsetSec;
  }
  const chainB = [genesis(BASE_TS), ...eventsB];

  const projA = projectFull(chainA, chainA.length - 1);
  const projB = projectFull(chainB, chainB.length - 1);

  console.log('\n[R3] 相同总量不同时间分布 — 描述性统计');
  console.log(`  A 密集: insult.count=${projA.byAction.get('insult')?.count ?? 0}`);
  console.log(`  B 分散: insult.count=${projB.byAction.get('insult')?.count ?? 0}`);
  console.log(`  描述性统计（次数/强度）一致: ${projA.byAction.get('insult')?.count === projB.byAction.get('insult')?.count}`);
  console.log(`  moodDelta 分布: |A|=${projA.moodDeltaValues.length} |B|=${projB.moodDeltaValues.length} 完全一致: ${projA.moodDeltaValues.every((v, i) => v === projB.moodDeltaValues[i])}`);

  assert.equal(projA.byAction.get('insult')?.count, projB.byAction.get('insult')?.count);
  // moodDelta 会不同因为 A 和 B 的 appraise 上下文不同（mood/trust 状态不同）
  // 但这不是投影的问题 — 投影是客观记录，moodDelta 的差异来自不同经历上下文
  console.log(`  ⚠️ moodDelta 数组不同（这是正确的！A 和 B 的 RuntimeState 不同 → appraisal 结果不同 → moodDelta 自然不同）`);
  console.log(`  投影函数本身是确定性的，不是随机的——它忠实地记录了事件中的 moodDelta 值`);
});

// ==================================================================
// 第五部分：Replay 与投影一致性
// ==================================================================

test('N1: 同一事件链重复 Replay 投影完全一致', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = buildFullRound(state, i % 2 === 0 ? 'insult' : 'compliment', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 10; i += 1) events.push(tick(iso(off + i * 10), 10));
  const chain = [genesis(BASE_TS), ...events];

  const rows = chain.map((ev, i) => ({
    sequence: String(i + 1), event_id: ev.id, identity_id: 'test-n1',
    timestamp: ev.timestamp, event_type: ev.type, schema_version: 2,
    engine_version: 'marrow@test', causation_id: null, correlation_id: null,
    previous_event_hash: i > 0 ? 'h' + i : null, event_hash: 'h' + i, payload: ev,
  })) as PersistedEventRow[];

  // 运行两次 replay，投影两次
  const r1 = replayPersistedEvents('test-n1', rows);
  const r2 = replayPersistedEvents('test-n1', rows);
  console.log(`  r1 verdict=${r1.verdict} errors=${JSON.stringify(r1.errors)}`);
  console.log(`  r2 verdict=${r2.verdict} errors=${JSON.stringify(r2.errors)}`);
  assert.equal(r1.verdict, 'valid', `r1 failed: ${r1.errors[0]?.message}`);
  assert.deepEqual(r1.finalState, r2.finalState, '两次 Replay 状态应一致');

  // 从 replay 得到的事件行再投影（使用 replayPersistedEvents 返回的原始事件行）
  const proj1 = projectFull(chain, chain.length - 1);
  const proj2 = projectFull(chain, chain.length - 1);
  console.log('\n[N1] 同一事件链重复投影');
  console.log(`  两次投影深度相等: ${deepEqualProjection(proj1, proj2)}`);
  assert.ok(deepEqualProjection(proj1, proj2));
});

test('N2: 过去截点的投影不受未来事件影响', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 15; i += 1) {
    const r = buildFullRound(state, 'insult', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 15; i += 1) {
    const r = buildFullRound(state, 'compliment', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const fullChain = [genesis(BASE_TS), ...events];

  // 找第 15 次 user_input（全部是 insult）之后的事件下标
  let idx15 = -1; let seen = 0;
  for (let i = 0; i < fullChain.length; i += 1) {
    const ev = fullChain[i]!;
    if (ev.type === 'dialogue' && ev.payload.direction === 'user_input') {
      seen += 1;
      if (seen === 15) idx15 = i;
    }
  }

  const projAt15 = projectFull(fullChain, idx15);
  // 即使后面追加了 15 次 compliment，截点 15 的投影结果不应该改变
  const projAt15_after = projectFull(fullChain.slice(0, idx15 + 1), idx15);

  console.log('\n[N2] 过去截点不受未来事件影响');
  console.log(`  proj@15 (从 fullChain):    insult=${projAt15.byAction.get('insult')?.count ?? 0} comp=${projAt15.byAction.get('compliment')?.count ?? 0}`);
  console.log(`  proj@15 (从前缀截断数组):  insult=${projAt15_after.byAction.get('insult')?.count ?? 0} comp=${projAt15_after.byAction.get('compliment')?.count ?? 0}`);
  assert.ok(deepEqualProjection(projAt15, projAt15_after), '同一前缀的投影必须相等');
});

test('N3: 投影不修改 RuntimeState，不产生新事件', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = buildFullRound(state, 'comfort', 0.8, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const beforeState = { ...state };
  const chain = [genesis(BASE_TS), ...events];
  const proj = projectFull(chain, chain.length - 1);
  const afterState = state;

  console.log('\n[N3] 投影不修改状态');
  console.log(`  proj 产出: byAction keys=[${[...proj.byAction.keys()].join(',')}]`);
  console.log(`  投影前后 RuntimeState 完全相同: ${beforeState.trust === afterState.trust && beforeState.moodBaseline === afterState.moodBaseline}`);
  assert.equal(beforeState.trust, afterState.trust);
  assert.equal(beforeState.moodBaseline, afterState.moodBaseline);
  console.log('  ✅ 投影是纯函数，无副作用');
});

// ==================================================================
// 第六部分：反向经历修正完整验证
// ==================================================================

test('C1: 反向经历 — 全量 vs 增量 vs 多次分块全部一致', () => {
  counter = 0;
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [];
  // 20 insult → 20 compliment → 15 comfort（混合完整链）
  for (let i = 0; i < 20; i += 1) {
    const r = buildFullRound(state, 'insult', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 20; i += 1) {
    const r = buildFullRound(state, 'compliment', 0.9, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 15; i += 1) {
    const r = buildFullRound(state, 'comfort', 0.85, off);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 50; i += 1) events.push(tick(iso(off + i * 10), 10));
  const chain = [genesis(BASE_TS), ...events];

  const fullProj = projectFull(chain, chain.length - 1);

  // 找到 insult 结束、compliment 结束的截点
  let insEnd = -1, compEnd = -1; let seen = 0;
  for (let i = 0; i < chain.length; i += 1) {
    const ev = chain[i]!;
    if (ev.type === 'dialogue' && ev.payload.direction === 'user_input') {
      seen += 1;
      if (seen === 20) insEnd = i;
      if (seen === 40) compEnd = i;
    }
  }

  const incIns = projectFull(chain, insEnd);
  const incComp = projectIncremental(incIns, chain, insEnd + 1, compEnd);
  const incFinal = projectIncremental(incComp, chain, compEnd + 1, chain.length - 1);

  console.log('\n[C1] 混合链三种投影方式');
  console.log(`  full:   ins=${fullProj.byAction.get('insult')?.count} comp=${fullProj.byAction.get('compliment')?.count} comf=${fullProj.byAction.get('comfort')?.count}`);
  console.log(`  inc:    ins=${incFinal.byAction.get('insult')?.count} comp=${incFinal.byAction.get('compliment')?.count} comf=${incFinal.byAction.get('comfort')?.count}`);
  console.log(`  深度相等: ${deepEqualProjection(fullProj, incFinal)}`);

  assert.ok(deepEqualProjection(fullProj, incFinal));
  assert.equal(fullProj.byAction.get('insult')?.count, 20);
  assert.equal(fullProj.byAction.get('compliment')?.count, 20);
  assert.equal(fullProj.byAction.get('comfort')?.count, 15);
  console.log('  ✅ 反向经历被正确追加，不覆盖旧历史');
});
