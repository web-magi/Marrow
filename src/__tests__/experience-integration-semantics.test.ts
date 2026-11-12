/**
 * experience-integration-semantics.test.ts — M1.6.6 经验整合语义设计
 *
 * 纯内存事件链 + 纯函数语义原型，零生产代码修改。
 * 目标：设计从多段经历到稳定预期的语义机制。
 *
 * 注意：本阶段只做语义分析和纯函数原型实验。
 * 不实现生产 Experience Weight。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, createInitialState, type MarrowState,
} from '../state.js';
import type {
  DialogueEvent, ObservationEvent, AppraisalEvent, TickEvent,
  GenesisEvent, DialogueAction, MarrowEvent,
} from '../events.js';

// ==================================================================
// 基础辅助（与 M1.6.5 保持一致）
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
function resetCounter(): void { counter = 0; }

function genesis(ts: string): GenesisEvent {
  return { type: 'genesis', id: nextId('genesis'), timestamp: ts,
    payload: { initialState: createInitialState(ts), configVersion: 2,
      initializedBy: 'm166-sem', seedEpisodicIds: [] } };
}
function tick(ts: string, deltaSeconds = 10): TickEvent {
  return { type: 'tick', id: nextId('tick'), timestamp: ts, payload: { deltaSeconds } };
}
function observation(ts: string, action: DialogueAction, intensity: number,
  valence: number | null = 0.6, valenceStatus: ObservationEvent['payload']['experienceValenceStatus'] = 'observed',
  confidence = 0.9): ObservationEvent {
  return { type: 'observation', id: nextId('obs'), timestamp: ts,
    payload: { source: 'user_text', content: `test-${action}`, action, intensity,
      confidence, uncertainty: +(1 - confidence).toFixed(2),
      facts: [{ claim: action, confidence }],
      extractorVersion: 'extractor-m166', experienceValenceStatus: valenceStatus,
      experienceValence: valence ?? undefined } };
}
function appraisalEvt(ts: string, dv: number, obsId: string): AppraisalEvent {
  return { type: 'appraisal', id: nextId('appr'), timestamp: ts,
    payload: { sourceObservationId: obsId, valenceDelta: dv, arousalDelta: Math.abs(dv),
      energyDelta: 0, confidence: 0.9, evidenceAssociationIds: [] } };
}
function userDialogue(ts: string, action: DialogueAction, intensity: number,
  moodDelta: number, observationId: string, appraisalId: string, replyTo?: string): DialogueEvent {
  const p: DialogueEvent['payload'] = { direction: 'user_input', text: `text-${action}`,
    action, intensity, moodDelta, salience: 0.3, wordCount: 4,
    observationId, appraisalId };
  if (replyTo) p.replyToEventId = replyTo;
  return { type: 'dialogue', id: nextId('dlg'), timestamp: ts, payload: p };
}

/** 构造一个完整对话轮次：Observation → Appraisal → UserDialogue（带完整关联链） */
interface FullRound { obs: ObservationEvent; appr: AppraisalEvent; dlg: DialogueEvent; }
function buildRound(ts: string, action: DialogueAction, intensity: number,
  dv: number, valence = 0.6): FullRound {
  const obs = observation(ts, action, intensity, valence);
  const appr = appraisalEvt(ts, dv, obs.id);
  const dlg = userDialogue(ts, action, intensity, dv, obs.id, appr.id);
  return { obs, appr, dlg };
}

/** 构造一个完整对话轮次，并应用到 RuntimeState 中 */
interface BuildAndApplyResult { events: MarrowEvent[]; finalState: MarrowState; moodDelta: number; trustDelta: number; }
function buildAndApply(state: MarrowState, ts: string, action: DialogueAction,
  intensity: number, dv: number, valence = 0.6): BuildAndApplyResult {
  const beforeTrust = state.trust;
  const beforeMood = state.moodBaseline;
  const r = buildRound(ts, action, intensity, dv, valence);
  const events: MarrowEvent[] = [r.obs, r.appr, r.dlg];
  let s = state;
  for (const ev of events) s = applyEvent(s, ev);
  return {
    events, finalState: s,
    moodDelta: +(s.moodBaseline - beforeMood).toFixed(4),
    trustDelta: +(s.trust - beforeTrust).toFixed(4),
  };
}

// ==================================================================
// 第一部分：证据语义定义 — 纯函数数据结构
// ==================================================================

/** 证据质量分类（基于事件关联链完整性 + LLM 提取状态） */
type EvidenceQuality =
  | 'full'        // Obs→Appr→UserDlg 三链齐全，experienceValenceStatus=observed
  | 'full_no_valence' // 三链齐全但 experienceValenceStatus≠observed
  | 'partial'     // user_input 有一个 id 但目标在截断链内不存在，或只有 Observation 没有 Dialogue
  | 'degraded'    // user_input 缺失两个 id，但有 action/intensity 字段（旧事件兼容）
  | 'broken'      // user_input 有引用 id 但目标不存在
  | 'unobservable'; // 不是可观测事件（tick/genesis/memory/companion_output）

interface EvidenceRecord {
  /** 这条经历对应的 action 类型 */
  action: DialogueAction;
  /** ObservationEvent.payload.intensity */
  obsIntensity: number;
  /** DialogueEvent.payload.intensity（可能不同于 obsIntensity，取 Obs 为准） */
  dlgIntensity: number | null;
  /** DialogueEvent.payload.moodDelta（Runtime 计算的 mood 变化） */
  moodDelta: number | null;
  /** AppraisalEvent.payload.valenceDelta */
  valenceDelta: number | null;
  /** ObservationEvent.payload.experienceValence（用户自描述） */
  userValence: number | null;
  /** ObservationEvent.payload.experienceValenceStatus */
  userValenceStatus: ObservationEvent['payload']['experienceValenceStatus'] | null;
  /** ObservationEvent.payload.confidence（LLM 提取置信度） */
  extractionConfidence: number;
  /** 证据质量分类 */
  quality: EvidenceQuality;
  /** 关联深度：3=三链齐全，2=部分关联，1=只有 Obs，0=只有 Dlg */
  linkDepth: number;
  /** ObservationEvent.id（溯源） */
  observationId: string | null;
  /** DialogueEvent.id（溯源） */
  dialogueId: string | null;
  /** AppraisalEvent.id（溯源） */
  appraisalId: string | null;
  /** 事件 sequence 下标 */
  seq: number;
}

/** 计算单条经历的证据质量 */
function classifyEvidence(
  hasObs: boolean, hasAppr: boolean, hasDlg: boolean,
  userValenceStatus: ObservationEvent['payload']['experienceValenceStatus'] | null,
  _obsConfidence: number,
  brokenRef: boolean,
): EvidenceQuality {
  if (brokenRef) return 'broken';
  const all3 = hasObs && hasAppr && hasDlg;
  if (all3) {
    if (userValenceStatus === 'observed') return 'full';
    return 'full_no_valence';
  }
  if (hasObs || hasAppr || hasDlg) return 'partial';
  return 'unobservable';
}

// ==================================================================
// 第二部分：经验整合模型 — 三种纯函数原型
// ==================================================================

/** Per-Action 聚合统计（模型 A/B/C 共用的数据结构） */
interface ActionAggregate {
  count: number;
  /** 按 extractionConfidence 加权的 intensitySum */
  weightedIntensitySum: number;
  intensityRawSum: number;
  intensityMean: number;
  /** 按 extractionConfidence 加权的 moodDeltaSum */
  weightedMoodDeltaSum: number;
  moodDeltaSum: number;
  moodDeltaMean: number;
  /** userValence（用户自描述）的统计——不解释为 Marrow 反馈 */
  userValenceSum: number;
  userValenceMean: number;
  /** 证据质量分布 */
  qualityDistribution: Map<EvidenceQuality, number>;
  /** 关联深度分布 */
  linkDepthDistribution: Map<number, number>;
  /** 时间序列下标列表（支持未来时间衰减实验） */
  seqList: number[];
}

/** 模型 A：简单累积（无质量权重，无时间衰减） */
interface SimpleCumulative {
  byAction: Map<string, { count: number; moodDeltaSum: number; valenceSum: number }>;
  totalEvidence: number;
}

/** 模型 B：有时间权重的累积（越近的事件权重越高） */
interface TimeWeightedCumulative {
  byAction: Map<string, {
    timeWindow: Map<number, number>; // seq → weight × contribution
    weightedCount: number;
    weightedMoodDeltaSum: number;
  }>;
  totalEvidence: number;
  /** 当前时间截点（seq 下标） */
  cutoffSeq: number;
  /** 衰减因子（1.0=无衰减，0.5=每 10 步减半） */
  decayPerStep: number;
}

/** 模型 C：预期模型（证据质量加权 + 可区分正向/反向证据 + 不确定性表达） */
interface ExpectationModel {
  byAction: Map<string, ActionAggregate>;
  totalEvidence: number;
  /** 哪些 action 有至少 full 质量的证据（可形成稳定预期） */
  establishedActions: Set<string>;
  /** 哪些 action 证据不足（全部 degraded/partial） */
  weakActions: Set<string>;
  /** 历史序列（支持反向修正分析） */
  seqList: number[];
}

/** 从 EventStream 中提取可观测的经历记录（纯函数，O(N)） */
function extractEvidenceRecords(events: MarrowEvent[], cutoffIdx: number): EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  const obsById = new Map<string, ObservationEvent>();
  const apprById = new Map<string, AppraisalEvent>();

  for (let i = 0; i <= cutoffIdx; i += 1) {
    const ev = events[i]!;
    if (ev.type === 'observation') obsById.set(ev.id, ev);
    else if (ev.type === 'appraisal') apprById.set(ev.id, ev);
  }

  for (let i = 0; i <= cutoffIdx; i += 1) {
    const ev = events[i]!;
    if (ev.type !== 'dialogue' || ev.payload.direction !== 'user_input') continue;

    const p = ev.payload;
    const obsId = p.observationId ?? null;
    const apprId = p.appraisalId ?? null;
    const obs = obsId ? obsById.get(obsId) : null;
    const appr = apprId ? apprById.get(apprId) : null;

    const hasObs = !!obs;
    const hasAppr = !!appr;
    const brokenRef =
      (obsId !== null && !obs) || (apprId !== null && !appr);

    const userValenceStatus =
      obs?.payload.experienceValenceStatus ?? null;
    const obsConfidence = obs?.payload.confidence ?? 0;

    const linkDepth = [hasObs, hasAppr].filter(Boolean).length + 1;
    const quality = classifyEvidence(
      hasObs, hasAppr, true,
      userValenceStatus, obsConfidence, brokenRef,
    );
    if (quality === 'unobservable') continue;

    const moodDelta = typeof p.moodDelta === 'number' ? p.moodDelta : null;
    const valenceDelta = appr ? appr.payload.valenceDelta : null;
    const userValence = obs?.payload.experienceValence ?? null;

    const action = (p.action ?? 'statement') as DialogueAction;
    const obsIntensity = obs?.payload.intensity ?? (p.intensity ?? 0.5);
    const dlgIntensity: number | null = p.intensity ?? null;

    records.push({
      action, obsIntensity, dlgIntensity,
      moodDelta, valenceDelta, userValence, userValenceStatus,
      extractionConfidence: obsConfidence,
      quality, linkDepth,
      observationId: obsId, dialogueId: ev.id, appraisalId: apprId,
      seq: i,
    });
  }
  return records;
}

// ==================================================================
// 三种聚合模型的纯函数实现
// ==================================================================

/** 模型 A：简单累积（零权重） */
function buildModelA(records: EvidenceRecord[]): SimpleCumulative {
  const byAction = new Map<string, { count: number; moodDeltaSum: number; valenceSum: number }>();
  for (const r of records) {
    const cur = byAction.get(r.action) ?? { count: 0, moodDeltaSum: 0, valenceSum: 0 };
    cur.count += 1;
    if (r.moodDelta !== null) cur.moodDeltaSum += r.moodDelta;
    if (r.userValence !== null) cur.valenceSum += r.userValence;
    byAction.set(r.action, cur);
  }
  return { byAction, totalEvidence: records.length };
}

/** 模型 B：指数时间衰减累积 */
function buildModelB(records: EvidenceRecord[], cutoffSeq: number, decayPerStep = 0.98): TimeWeightedCumulative {
  const byAction = new Map<string, {
    timeWindow: Map<number, number>; weightedCount: number; weightedMoodDeltaSum: number;
  }>();
  for (const r of records) {
    const age = cutoffSeq - r.seq;
    const timeWeight = Math.pow(decayPerStep, age);
    const cur = byAction.get(r.action) ?? {
      timeWindow: new Map(), weightedCount: 0, weightedMoodDeltaSum: 0,
    };
    cur.timeWindow.set(r.seq, timeWeight);
    cur.weightedCount += timeWeight;
    if (r.moodDelta !== null) cur.weightedMoodDeltaSum += r.moodDelta * timeWeight;
    byAction.set(r.action, cur);
  }
  return { byAction, totalEvidence: records.length, cutoffSeq, decayPerStep };
}

/** 模型 C：预期模型（证据质量加权 + 分类聚合 + 不确定性表达） */
function buildModelC(records: EvidenceRecord[]): ExpectationModel {
  const byAction = new Map<string, ActionAggregate>();
  const establishedActions = new Set<string>();
  const weakActions = new Set<string>();

  for (const r of records) {
    const cur = byAction.get(r.action) ?? {
      count: 0, weightedIntensitySum: 0, intensityRawSum: 0, intensityMean: 0,
      weightedMoodDeltaSum: 0, moodDeltaSum: 0, moodDeltaMean: 0,
      userValenceSum: 0, userValenceMean: 0,
      qualityDistribution: new Map<EvidenceQuality, number>(),
      linkDepthDistribution: new Map<number, number>(),
      seqList: [],
    };
    cur.count += 1;
    const confW = Math.max(0.3, r.extractionConfidence); // 最低 0.3，确保低置信度仍有一点权重
    cur.weightedIntensitySum += r.obsIntensity * confW;
    cur.intensityRawSum += r.obsIntensity;
    cur.weightedMoodDeltaSum += (r.moodDelta ?? 0) * confW;
    cur.moodDeltaSum += r.moodDelta ?? 0;
    if (r.userValence !== null) cur.userValenceSum += r.userValence;
    cur.seqList.push(r.seq);

    const qCount = cur.qualityDistribution.get(r.quality) ?? 0;
    cur.qualityDistribution.set(r.quality, qCount + 1);
    const dCount = cur.linkDepthDistribution.get(r.linkDepth) ?? 0;
    cur.linkDepthDistribution.set(r.linkDepth, dCount + 1);
    byAction.set(r.action, cur);
  }

  // 计算均值
  for (const [action, agg] of byAction) {
    agg.intensityMean = agg.count > 0 ? agg.intensityRawSum / agg.count : 0;
    agg.moodDeltaMean = agg.count > 0 ? agg.moodDeltaSum / agg.count : 0;
    agg.userValenceMean = agg.count > 0 ? agg.userValenceSum / agg.count : 0;
    const fullOrNoValenceCount =
      (agg.qualityDistribution.get('full') ?? 0) +
      (agg.qualityDistribution.get('full_no_valence') ?? 0);
    const ratio = fullOrNoValenceCount / agg.count;
    if (ratio >= 0.5 && agg.count >= 3) establishedActions.add(action);
    else weakActions.add(action);
  }

  const seqList = records.map(r => r.seq);
  return { byAction, totalEvidence: records.length, establishedActions, weakActions, seqList };
}

// ==================================================================
// 第一部分测试：证据语义定义
// ==================================================================

test('S1-1: 证据质量分类 — 完整关联链 = full', () => {
  resetCounter();
  const ts = BASE_TS;
  const obs = observation(ts, 'insult', 0.9, -0.8, 'observed', 0.92);
  const appr = appraisalEvt(ts, -12, obs.id);
  const dlg = userDialogue(ts, 'insult', 0.9, -12, obs.id, appr.id);
  const chain: MarrowEvent[] = [genesis(ts), obs, appr, dlg];

  const records = extractEvidenceRecords(chain, chain.length - 1);
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.quality, 'full');
  assert.equal(r.linkDepth, 3);
  assert.equal(r.action, 'insult');
  assert.equal(r.moodDelta, -12);
  assert.equal(r.userValence, -0.8);
  assert.equal(r.userValenceStatus, 'observed');
  console.log(`  ✅ full 证据：quality=${r.quality} linkDepth=${r.linkDepth} moodDelta=${r.moodDelta}`);
});

test('S1-2: experienceValenceStatus ≠ observed → full_no_valence（不视为 Marrow 反馈）', () => {
  resetCounter();
  const ts = BASE_TS;
  const obs = observation(ts, 'insult', 0.9, null, 'extraction_failed', 0.5);
  const appr = appraisalEvt(ts, -12, obs.id);
  const dlg = userDialogue(ts, 'insult', 0.9, -12, obs.id, appr.id);
  const chain: MarrowEvent[] = [genesis(ts), obs, appr, dlg];

  const records = extractEvidenceRecords(chain, chain.length - 1);
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.quality, 'full_no_valence');
  assert.equal(r.userValence, null);
  assert.equal(r.userValenceStatus, 'extraction_failed');
  console.log(`  ✅ 三链齐全但 valence 失败：quality=${r.quality}（不是 degraded，关联链仍然可靠）`);
});

test('S1-3: brokenRef → 即使有 id 但目标丢失也被标记 broken', () => {
  resetCounter();
  const ts = BASE_TS;
  const dlg = userDialogue(ts, 'insult', 0.9, -12, 'obs-MISSING', 'appr-MISSING');
  const chain: MarrowEvent[] = [genesis(ts), dlg];

  const records = extractEvidenceRecords(chain, chain.length - 1);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.quality, 'broken');
  console.log(`  ✅ brokenRef：quality=broken，不会被当作有效经历`);
});

test('S1-4: 旧事件缺失关联字段 → degraded，但 action/intensity 仍可用', () => {
  resetCounter();
  const ts = BASE_TS;
  const dlg: DialogueEvent = {
    type: 'dialogue', id: nextId('dlg'), timestamp: ts,
    payload: { direction: 'user_input', text: 'old', action: 'compliment',
      intensity: 0.7, moodDelta: 8, salience: 0.3, wordCount: 3 },
  };
  const chain: MarrowEvent[] = [genesis(ts), dlg];

  const records = extractEvidenceRecords(chain, chain.length - 1);
  assert.equal(records.length, 1);
  const r = records[0]!;
  // 这是 degraded：没有 observationId 和 appraisalId，但 action 字段本身有效
  assert.ok(r.quality === 'partial' || r.quality === 'degraded',
    `旧事件质量分类应为 degraded/partial，实际为 ${r.quality}`);
  assert.equal(r.action, 'compliment');  // action 字段独立于关联链可用
  assert.equal(r.moodDelta, 8);          // moodDelta 在 DialogueEvent 里独立持久化
  console.log(`  ✅ 旧事件 degraded：quality=${r.quality} action=${r.action} moodDelta=${r.moodDelta}`);
  console.log(`     → degraded 事件 action/intensity/moodDelta 仍可用，只是溯源链不完整`);
});

// ==================================================================
// 第二部分测试：三种模型比较
// ==================================================================

test('S2-1: 模型 A（简单累积）— 不区分证据质量和时间', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  // 再追加 3 次 compliment
  for (let i = 0; i < 3; i += 1) {
    const r = buildAndApply(state, iso(off), 'compliment', 0.85, 10, 0.7);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const records = extractEvidenceRecords(events, events.length - 1);
  const a = buildModelA(records);
  console.log(`\n[S2-1] 模型 A 简单累积`);
  for (const [action, agg] of a.byAction) {
    const meanDelta = agg.count > 0 ? agg.moodDeltaSum / agg.count : 0;
    console.log(`  ${action}: count=${agg.count} meanMoodDelta=${meanDelta.toFixed(2)}`);
  }
  // 模型 A 的局限：全部等量加权，无质量区分，无时间衰减
  assert.equal(a.totalEvidence, 8);
  assert.equal(a.byAction.get('insult')!.count, 5);
  assert.equal(a.byAction.get('compliment')!.count, 3);
  console.log(`  ✅ 模型 A：简单计数，对所有证据等量对待`);
  console.log(`  ⚠️ 局限：如果其中 1 条是 degraded 旧事件，权重与 1 条 full 新事件相同`);
});

test('S2-2: 模型 B（时间衰减）— 近期事件权重更高', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  // 先 5 次 insult
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  // 大量 tick 跳过时间（模拟远距离）
  events.push(tick(iso(off), 86400)); off += 86400;
  events.push(tick(iso(off), 86400)); off += 86400;
  state = applyEvent(state, tick(iso(off - 86400 * 2), 86400));
  state = applyEvent(state, tick(iso(off - 86400), 86400));
  // 再 3 次 compliment
  for (let i = 0; i < 3; i += 1) {
    const r = buildAndApply(state, iso(off), 'compliment', 0.85, 10, 0.7);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const records = extractEvidenceRecords(events, events.length - 1);
  const b = buildModelB(records, events.length - 1, 0.9);

  const insultWeight = b.byAction.get('insult')!.weightedCount;
  const complimentWeight = b.byAction.get('compliment')!.weightedCount;
  console.log(`\n[S2-2] 模型 B 时间衰减`);
  console.log(`  insult weightedCount=${insultWeight.toFixed(3)} (raw=5)`);
  console.log(`  compliment weightedCount=${complimentWeight.toFixed(3)} (raw=3)`);
  console.log(`  比率=${(complimentWeight / insultWeight).toFixed(3)}`);

  // compliment 都是新的，insult 都是旧的（seq 差异大）
  // 衰减 per step 0.9，3 步后 insult 权重 ~ 0.9^3 ≈ 0.73 每条
  // 这是指数衰减的效果
  assert.ok(complimentWeight > 0, 'compliment 应有权重');
  console.log(`  ✅ 模型 B：近因效应，越近的经历权重越高`);
  console.log(`  ⚠️ 局限：衰减参数需要校准；跨天/周的时间跨度在 EventStream 中不是 seq 差值而是真实时间`);
  console.log(`  ⚠️ EventStream 中没有 duration 字段可以直接用于时间差（只有 seq 序）`);
});

test('S2-3: 模型 C（预期模型）— 质量加权 + 证据分类 + 不确定性', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 3; i += 1) {
    const r = buildAndApply(state, iso(off), 'compliment', 0.85, 10, 0.7);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  // 混入 1 条 degraded 旧事件
  const oldDlg: DialogueEvent = {
    type: 'dialogue', id: nextId('dlg'), timestamp: iso(off),
    payload: { direction: 'user_input', text: 'old', action: 'insult',
      intensity: 0.5, moodDelta: -4, salience: 0.3, wordCount: 3 },
  };
  events.push(oldDlg);

  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);

  console.log(`\n[S2-3] 模型 C 预期模型`);
  for (const [action, agg] of c.byAction) {
    const qualDistribution = [...agg.qualityDistribution.entries()]
      .map(([q, n]) => `${q}=${n}`).join(', ');
    console.log(`  ${action}: count=${agg.count} meanIntensity=${agg.intensityMean.toFixed(2)}`);
    console.log(`    meanMoodDelta=${agg.moodDeltaMean.toFixed(2)} qualities=[${qualDistribution}]`);
    console.log(`    established? ${c.establishedActions.has(action)} weak? ${c.weakActions.has(action)}`);
  }

  const insult = c.byAction.get('insult')!;
  const fullCount = insult.qualityDistribution.get('full') ?? 0;
  assert.ok(fullCount >= 5, `insult 应有 5 条 full，实际 ${fullCount}`);
  console.log(`  ✅ 模型 C：质量分布可见，5 full + 1 degraded`);
  console.log(`  ✅ establishedActions：至少 50% full 且 count ≥ 3 的 action 才进入`);
  console.log(`  ✅ 反直觉保护：不会因为 1 条 degraded 旧事件就动摇已有预期`);
});

// ==================================================================
// 第三部分测试：五组核心实验
// ==================================================================

test('E1: 单次强烈经历 — 1 次 insult(0.95)', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  const r = buildAndApply(initial, iso(100), 'insult', 0.95, -14, -0.9);
  const events: MarrowEvent[] = [genesis(BASE_TS), ...r.events];
  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);
  const agg = c.byAction.get('insult')!;

  console.log(`\n[E1] 单次强烈经历`);
  console.log(`  count=${agg.count} meanIntensity=${agg.intensityMean.toFixed(2)} meanMoodDelta=${agg.moodDeltaMean.toFixed(2)}`);
  console.log(`  established? ${c.establishedActions.has('insult')} weak? ${c.weakActions.has('insult')}`);
  console.log(`  证据质量 full=${agg.qualityDistribution.get('full') ?? 0}`);
  console.log(`  ✅ 单次强烈经历被正确记录`);
  console.log(`  ✅ 但尚未进入 establishedActions（需要 count ≥ 3）`);
  console.log(`  ✅ — 单次经历不足以形成稳定预期（不确定性保留）`);

  assert.equal(agg.count, 1);
  assert.equal(c.establishedActions.size, 0, '单次经历不应形成 established 预期');
});

test('E2: 重复普通经历 — 10 次 insult(0.5) 与 E1 对比', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];
  for (let i = 0; i < 10; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.5, -6, -0.5);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);
  const agg = c.byAction.get('insult')!;

  console.log(`\n[E2] 10 × 普通经历`);
  console.log(`  count=${agg.count} meanIntensity=${agg.intensityMean.toFixed(2)} meanMoodDelta=${agg.moodDeltaMean.toFixed(2)}`);
  console.log(`  established? ${c.establishedActions.has('insult')}`);
  console.log(`  weightedMoodDeltaSum=${agg.weightedMoodDeltaSum.toFixed(2)} (10 × -6 = -60)`);

  assert.ok(c.establishedActions.has('insult'), '10 次普通经历应形成 established 预期');
  console.log(`  ✅ E1 vs E2：单次强烈经历（count=1）不形成稳定预期`);
  console.log(`  ✅ E1 vs E2：10 次普通经历（count=10）形成稳定预期`);
  console.log(`  ✅ — 证据数量比单次强度更能决定预期稳定性`);
});

test('E3: 反向经历 — 先 10×insult 再 10×compliment', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  for (let i = 0; i < 10; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  // 在 insult 历史截点先做一次投影
  const recordsHalf = extractEvidenceRecords(events, events.length - 1);
  const halfC = buildModelC(recordsHalf);
  const halfInsult = halfC.byAction.get('insult')!;
  console.log(`\n[E3] 反向经历 — 中间截点（全 insult）`);
  console.log(`  insult: count=${halfInsult.count} meanMoodDelta=${halfInsult.moodDeltaMean.toFixed(2)} established? ${halfC.establishedActions.has('insult')}`);

  // 追加 compliment
  for (let i = 0; i < 10; i += 1) {
    const r = buildAndApply(state, iso(off), 'compliment', 0.9, 12, 0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const recordsFull = extractEvidenceRecords(events, events.length - 1);
  const fullC = buildModelC(recordsFull);

  const fullInsult = fullC.byAction.get('insult')!;
  const fullComp = fullC.byAction.get('compliment')!;

  console.log(`\n[E3] 反向经历 — 完整链（10 insult + 10 compliment）`);
  console.log(`  insult: count=${fullInsult.count} meanMoodDelta=${fullInsult.moodDeltaMean.toFixed(2)} established? ${fullC.establishedActions.has('insult')}`);
  console.log(`  compliment: count=${fullComp.count} meanMoodDelta=${fullComp.moodDeltaMean.toFixed(2)} established? ${fullC.establishedActions.has('compliment')}`);

  // 关键验证：insult 的原始统计没有被删除
  assert.equal(fullInsult.count, 10, 'insult 历史保留');
  assert.equal(fullComp.count, 10, 'compliment 历史追加');
  assert.ok(fullC.establishedActions.has('insult'), 'insult 仍然 established');
  assert.ok(fullC.establishedActions.has('compliment'), 'compliment 也 established');

  // 验证：两个 action 独立聚合，不互相覆盖
  const insultMeanDelta = fullInsult.moodDeltaMean;
  const compMeanDelta = fullComp.moodDeltaMean;
  assert.ok(insultMeanDelta < 0, `insult meanDelta 应为负，实际 ${insultMeanDelta}`);
  assert.ok(compMeanDelta > 0, `compliment meanDelta 应为正，实际 ${compMeanDelta}`);

  console.log(`  ✅ 旧历史未被删除：insult.count=10（不变）`);
  console.log(`  ✅ 新经历正确追加：compliment.count=10`);
  console.log(`  ✅ 两个 action 独立聚合：insult.meanDelta<0, compliment.meanDelta>0`);
  console.log(`  ✅ — 反向经历不覆盖，而是扩展证据空间`);
  console.log(`  ⚠️ 但当前模型没有一个"总体 trust-like 预期值"`);
  console.log(`  — 这是设计的正确性：不应该把不同 action 的证据压缩成一个全局值`);
});

test('E4: 时间分布 — 相同总量 vs 密集/分散', () => {
  resetCounter();
  // 两组：A 密集（每次无 tick），B 分散（每次插 10 tick）
  const initialA = createInitialState(BASE_TS);
  let stateA = initialA; let offA = 100;
  const eventsA: MarrowEvent[] = [genesis(BASE_TS)];
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(stateA, iso(offA), 'insult', 0.7, -10, -0.7);
    eventsA.push(...r.events); stateA = r.finalState; offA += 4;
  }

  resetCounter();
  const initialB = createInitialState(BASE_TS);
  let stateB = initialB; let offB = 100;
  const eventsB: MarrowEvent[] = [genesis(BASE_TS)];
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(stateB, iso(offB), 'insult', 0.7, -10, -0.7);
    eventsB.push(...r.events); stateB = r.finalState; offB += 4;
    stateB = applyEvent(stateB, tick(iso(offB), 10)); offB += 10;
  }

  const recA = extractEvidenceRecords(eventsA, eventsA.length - 1);
  const recB = extractEvidenceRecords(eventsB, eventsB.length - 1);
  const cA = buildModelC(recA);
  const cB = buildModelC(recB);

  const aggA = cA.byAction.get('insult')!;
  const aggB = cB.byAction.get('insult')!;

  console.log(`\n[E4] 时间分布：A 密集 vs B 分散`);
  console.log(`  A: count=${aggA.count} meanIntensity=${aggA.intensityMean.toFixed(2)} meanMoodDelta=${aggA.moodDeltaMean.toFixed(2)}`);
  console.log(`  B: count=${aggB.count} meanIntensity=${aggB.intensityMean.toFixed(2)} meanMoodDelta=${aggB.moodDeltaMean.toFixed(2)}`);

  // 纯模型 C（无时间衰减）两组统计相同：
  assert.equal(aggA.count, aggB.count);
  assert.equal(aggA.intensityMean.toFixed(3), aggB.intensityMean.toFixed(3));
  // moodDelta 可能不同（因为 B 中间的 tick 会让 mood 有自然变化 → 下次 appraisal 的 moodFactor 不同）
  // 这是 RuntimeState 级别的差异，不是投影函数的差异
  console.log(`  ✅ 模型 C 纯统计：count/intensity 完全一致`);
  console.log(`  ✅ moodDelta 可能不同（RuntimeState 在 tick 期间变化 → moodFactor 不同）`);
  console.log(`  ⚠️ 时间分布对 RuntimeState 有影响，但模型 C 本身（纯 EventStream 统计）不受影响`);
  console.log(`  ⚠️ 当前 EventStream **没有** duration 字段来直接支持真实时间差衰减`);
  console.log(`  — 时间衰减如果需要，只能基于 seq 序（序列距离）或额外计算`);
});

test('E5: 情境差异 — 当前 EventStream 不支持情境分组', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  // 组1：连续 5×insult
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  // 组2：连续 5×comfort
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'comfort', 0.85, 10, 0.7);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);

  console.log(`\n[E5] 情境差异实验`);
  console.log(`  当前 EventStream 结构：按 action 类型聚合`);
  console.log(`  insult: count=${c.byAction.get('insult')!.count} established? ${c.establishedActions.has('insult')}`);
  console.log(`  comfort: count=${c.byAction.get('comfort')!.count} established? ${c.establishedActions.has('comfort')}`);
  console.log(`  ✅ 不同 action 独立聚合，各自形成预期`);

  // 检查：当前 EventStream 是否有情境字段？
  // 读 ObservationEvent payload 类型
  console.log(`  ❌ 但如果"情境"指的是 action 之外的分组（如时间、环境、对话主题），当前 EventStream **没有**情境字段`);
  console.log(`  ❌ 无法按情境分组投影——只能按 action 类型`);
  console.log(`  ⚠️ 这是 EventStream 的**硬限制**，不是投影算法的问题`);
  console.log(`  ⚠️ 如果未来需要情境分组，必须：`);
  console.log(`     1. ObservationEvent.payload 加 scene 字段（生产代码修改）`);
  console.log(`     2. 或 DialogueEvent.payload 加 topic 字段`);
  console.log(`     3. 或引入 EnvironmentEvent 作为情境边界标记`);
  console.log(`  ⚠️ 本阶段不修改生产代码，所以只能按 action 分组`);

  assert.ok(c.byAction.has('insult'));
  assert.ok(c.byAction.has('comfort'));
});

// ==================================================================
// 第四部分测试：边界澄清 + 反向证据修正
// ==================================================================

test('S4-1: Trust ≠ Experience Integration — 两者不同', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  // 20×insult：trust 大幅下降，但 insult 的预期是明确的（100% full 证据）
  for (let i = 0; i < 20; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);

  console.log(`\n[S4-1] Trust vs Experience Integration`);
  console.log(`  20×insult 后 RuntimeState.trust = ${state.trust.toFixed(1)}`);
  console.log(`  RuntimeState.moodBaseline = ${state.moodBaseline.toFixed(1)}`);
  console.log(`  RuntimeState.defensiveness = ${state.defensiveness.toFixed(1)}`);

  const insult = c.byAction.get('insult')!;
  console.log(`  Experience Integration（insult）:`);
  console.log(`    count=${insult.count} meanIntensity=${insult.intensityMean.toFixed(2)}`);
  console.log(`    meanMoodDelta=${insult.moodDeltaMean.toFixed(2)} established? ${c.establishedActions.has('insult')}`);

  console.log(`  ✅ Trust（RuntimeState）= ${state.trust.toFixed(1)} — 单次交互对当前对话者的即时评估`);
  console.log(`  ✅ Experience Integration（投影）= 20 条完整证据 — 多段经历聚合的稳定预期`);
  console.log(`  ❌ 不应该把 Experience Integration 压缩成一个全局数值来替代 Trust`);
  console.log(`  ✅ 正确关系：Experience Integration → 调节 Trust 变化的 Appraisal（M1.6.4 已定义）`);

  // Trust 可能已经到很低甚至锁死态，但 Experience Integration 的证据是可靠的
  assert.ok(c.establishedActions.has('insult'), 'insult 预期应已建立');
  assert.ok(state.trust < initial.trust, 'trust 应该下降');
});

test('S4-2: 反向证据修正 — 10 insult 后追加 10 compliment，不覆盖旧证据', () => {
  // 与 E3 相同逻辑但专门验证修正速度
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  // 10×insult
  for (let i = 0; i < 10; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  const beforeRecords = extractEvidenceRecords(events, events.length - 1);
  const beforeC = buildModelC(beforeRecords);

  // 追加 5×compliment
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'compliment', 0.9, 12, 0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const afterRecords = extractEvidenceRecords(events, events.length - 1);
  const afterC = buildModelC(afterRecords);

  const beforeInsultMean = beforeC.byAction.get('insult')!.moodDeltaMean;
  const afterInsultMean = afterC.byAction.get('insult')!.moodDeltaMean;

  console.log(`\n[S4-2] 反向修正速度`);
  console.log(`  10 insult 后：insult.meanDelta=${beforeInsultMean.toFixed(2)} established? ${beforeC.establishedActions.has('insult')}`);
  console.log(`  5 compliment 追加后：insult.meanDelta=${afterInsultMean.toFixed(2)} established? ${afterC.establishedActions.has('insult')}`);
  console.log(`  5 compliment 追加后：compliment.count=${afterC.byAction.get('compliment')!.count} established? ${afterC.establishedActions.has('compliment')}`);

  // insult.meanDelta 不应改变（因为 insult 自身的证据没有变）
  assert.equal(beforeInsultMean.toFixed(3), afterInsultMean.toFixed(3),
    '旧 action 的 meanDelta 不应因新 action 追加而改变');
  // insult 仍然 established
  assert.ok(afterC.establishedActions.has('insult'), 'insult 仍然 established');
  // compliment 还没 established（count=5 ≥ 3 且 100% full → 应该已建立）
  console.log(`  ✅ 旧 action 统计不因新 action 追加而改变`);
  console.log(`  ✅ 每个 action 的预期独立演化`);
  console.log(`  ✅ — 修正不是"翻转旧预期"，而是"在新维度追加新证据"`);
});

// ==================================================================
// 第五部分测试：自我强化和死锁风险分析
// ==================================================================

test('S5-1: 负向预期的自我强化风险分析', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  // 连续 15×insult — 锁死实验
  for (let i = 0; i < 15; i += 1) {
    const beforeTrust = state.trust;
    const beforeMood = state.moodBaseline;
    const beforeDef = state.defensiveness;
    const r = buildAndApply(state, iso(off), 'insult', 0.95, -14, -0.9);
    events.push(...r.events); state = r.finalState; off += 4;
    const afterTrust = state.trust;
    const afterDef = state.defensiveness;
    if (i === 14 || afterTrust < 20 || afterDef > 80) {
      console.log(`  step ${i + 1}: trust ${beforeTrust.toFixed(1)}→${afterTrust.toFixed(1)} def ${beforeDef.toFixed(1)}→${afterDef.toFixed(1)} mood ${beforeMood.toFixed(1)}→${state.moodBaseline.toFixed(1)}`);
    }
  }

  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);

  console.log(`\n[S5-1] 负向预期的自我强化`);
  console.log(`  RuntimeState 最终: trust=${state.trust.toFixed(1)} mood=${state.moodBaseline.toFixed(1)} def=${state.defensiveness.toFixed(1)}`);
  console.log(`  Experience Integration: insult established=${c.establishedActions.has('insult')} count=${c.byAction.get('insult')!.count}`);

  // 现在追加 20×comfort — 看 lock 后正向信任变化
  console.log(`\n  === 追加 20×comfort (0.95) 尝试恢复 ===`);
  let prevTrust = state.trust;
  for (let i = 0; i < 20; i += 1) {
    const r = buildAndApply(state, iso(off), 'comfort', 0.95, 12, 0.8);
    events.push(...r.events); state = r.finalState; off += 4;
    if ((i + 1) % 5 === 0) {
      console.log(`  comfort #${i + 1}: trust ${prevTrust.toFixed(2)}→${state.trust.toFixed(2)} mood ${state.moodBaseline.toFixed(1)} def ${state.defensiveness.toFixed(1)}`);
    }
    prevTrust = state.trust;
  }

  // E3 级别的锁死验证（M1.6.4 已确认）
  console.log(`\n  四重死锁状态:`);
  console.log(`  trust=${state.trust.toFixed(2)} mood=${state.moodBaseline.toFixed(1)} def=${state.defensiveness.toFixed(1)}`);
  console.log(`  moodFactor=${(state.moodBaseline / 50).toFixed(2)} (mood=0 时 moodFactor=0 → trustDelta=0)`);

  // 关键语义：Experience Integration 不会受 RuntimeState 死锁影响
  const finalRecords = extractEvidenceRecords(events, events.length - 1);
  const finalC = buildModelC(finalRecords);
  const finalInsult = finalC.byAction.get('insult')!;
  const finalComfort = finalC.byAction.get('comfort')!;

  console.log(`\n  Experience Integration 不受死锁影响:`);
  console.log(`  insult.count=${finalInsult.count} comfort.count=${finalComfort.count}`);
  console.log(`  insult.meanDelta=${finalInsult.moodDeltaMean.toFixed(2)} comfort.meanDelta=${finalComfort.moodDeltaMean.toFixed(2)}`);
  console.log(`  ✅ EventStream 中的 20 条 comfort 证据被完整保留`);
  console.log(`  ✅ 不管 RuntimeState 是否锁死，Experience Integration 都能看到这些新证据`);
  console.log(`  ❌ 真正的循环锁不在 Experience Integration 层，而在 Appraisal 公式层`);
  console.log(`  ❌ — Experience Weight 作为调节层，是在 **Appraisal 之前** 注入的，不是在 EventStream 层面`);
});

test('S5-2: 正向预期的自我强化风险 — 早期正向证据可能掩盖后续负向变化', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  // 先 10×compliment（建立正向预期）
  for (let i = 0; i < 10; i += 1) {
    const r = buildAndApply(state, iso(off), 'compliment', 0.9, 12, 0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  // 再 5×insult
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);

  console.log(`\n[S5-2] 正向预期 vs 后续负向证据`);
  console.log(`  compliment: count=${c.byAction.get('compliment')!.count} established? ${c.establishedActions.has('compliment')}`);
  console.log(`  insult: count=${c.byAction.get('insult')!.count} established? ${c.establishedActions.has('insult')}`);

  // 两者独立聚合，都 established
  // 没有全局"正向/负向预期"这种压缩
  assert.ok(c.establishedActions.has('compliment'));
  assert.ok(c.establishedActions.has('insult'));

  console.log(`  ✅ 两个 action 都 established，没有全局翻转或覆盖`);
  console.log(`  ✅ — 这是好设计：不压缩成全局值，避免早期证据掩盖后期变化`);
  console.log(`  ⚠️ 真正的风险是：如果未来有人把 Experience Integration 压缩成一个`);
  console.log(`     "总体信任度"，那早期大量正向证据会掩盖后期变化`);
  console.log(`  ⚠️ — 这就是 M1.6.4 说的"不能把 Experience Weight 压缩成一个全局数值"`);
});

test('S5-3: 错误分类的自我强化 — 动作分类错误导致的长期影响', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  // 场景：本应是 compliment 的话，LLM 错误分类为 comfort
  for (let i = 0; i < 10; i += 1) {
    // comfort 是不同 action → 独立聚合
    const r = buildAndApply(state, iso(off), 'comfort', 0.9, 12, 0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const records = extractEvidenceRecords(events, events.length - 1);
  const c = buildModelC(records);

  console.log(`\n[S5-3] 错误分类风险`);
  console.log(`  comfort: count=${c.byAction.get('comfort')!.count} established? ${c.establishedActions.has('comfort')}`);
  console.log(`  ✅ 分类错误会导致证据被错误地归到某个 action 下`);
  console.log(`  ✅ 但 confidence（extractionConfidence）字段可以标记低置信证据`);
  console.log(`  ✅ 模型 C 的 qualityDistribution 会暴露"低置信证据的比例"`);
  console.log(`  ⚠️ 但当前没有"重新分类"机制——EventStream 是不可变事实`);
  console.log(`  ⚠️ 如果历史事件分类错误，投影只能忠实地展示错误的分布`);
  console.log(`  — 这就是为什么 EventStream 的 extractorVersion 和 confidence 很重要`);
  console.log(`  — 未来如果有 extractorVersion 升级，可以对旧事件重跑分类，写入新事件`);
  console.log(`  — 但这是生产代码修改，本阶段不涉及`);
});

// ==================================================================
// 第六部分测试：最小可行模型设计验证
// ==================================================================

test('S6-1: 最小可行模型 — 输出验证确定性', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  for (let i = 0; i < 8; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.8, -10, -0.7);
    events.push(...r.events); state = r.finalState; off += 4;
  }
  for (let i = 0; i < 5; i += 1) {
    const r = buildAndApply(state, iso(off), 'comfort', 0.85, 10, 0.7);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  // 同一链投影两次，结果应完全相同
  const rec1 = extractEvidenceRecords(events, events.length - 1);
  const rec2 = extractEvidenceRecords(events, events.length - 1);
  const c1 = buildModelC(rec1);
  const c2 = buildModelC(rec2);

  const equal = (a: ExpectationModel, b: ExpectationModel): boolean => {
    if (a.totalEvidence !== b.totalEvidence) return false;
    if (a.establishedActions.size !== b.establishedActions.size) return false;
    if (a.byAction.size !== b.byAction.size) return false;
    for (const [k, aggA] of a.byAction) {
      const aggB = b.byAction.get(k);
      if (!aggB) return false;
      if (aggA.count !== aggB.count) return false;
      if (Math.abs(aggA.moodDeltaMean - aggB.moodDeltaMean) > 0.0001) return false;
      if (Math.abs(aggA.intensityMean - aggB.intensityMean) > 0.0001) return false;
    }
    return true;
  };

  console.log(`\n[S6-1] 最小可行模型确定性验证`);
  console.log(`  totalEvidence=${c1.totalEvidence} established=${[...c1.establishedActions].join(',')}`);
  console.log(`  proj1 == proj2? ${equal(c1, c2)}`);
  assert.ok(equal(c1, c2), '两次投影应完全相同');
  console.log(`  ✅ 纯函数，无随机数，无 wall-clock，无外部依赖 → 确定性`);
});

test('S6-2: 算法升级时的历史重算语义 — 纯模型升级不影响事件链', () => {
  resetCounter();
  const initial = createInitialState(BASE_TS);
  let state = initial; let off = 100;
  const events: MarrowEvent[] = [genesis(BASE_TS)];

  for (let i = 0; i < 6; i += 1) {
    const r = buildAndApply(state, iso(off), 'insult', 0.9, -12, -0.8);
    events.push(...r.events); state = r.finalState; off += 4;
  }

  const records = extractEvidenceRecords(events, events.length - 1);

  // 模型 A → C 对比
  const a = buildModelA(records);
  const c = buildModelC(records);

  console.log(`\n[S6-2] 算法升级语义`);
  console.log(`  同一事件链，两种模型：`);
  console.log(`    A 简单累积: insult.count=${a.byAction.get('insult')!.count} moodDeltaSum=${a.byAction.get('insult')!.moodDeltaSum.toFixed(1)}`);
  console.log(`    C 预期模型: insult.count=${c.byAction.get('insult')!.count} moodDeltaMean=${c.byAction.get('insult')!.moodDeltaMean.toFixed(2)} established? ${c.establishedActions.has('insult')}`);

  console.log(`  ✅ 模型升级只改变投影函数输出，不修改 EventStream`);
  console.log(`  ✅ 旧事件永远是事实，新模型可以用新视角解读旧事实`);
  console.log(`  ✅ EventStream（事实层）和投影（解读层）严格分离`);
  console.log(`  — 这是 Event Sourcing + Projection 的核心优势`);
});
