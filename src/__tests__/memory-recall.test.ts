/**
 * memory-recall.test.ts — M1.4.6.1 记忆召回确定性测试
 *
 * 本文件只验证现有生产行为，不引入任何生产代码改动。
 *
 * 覆盖范围：
 *   A. 召回算法（evokeMemoryFromText）
 *   B. 召回边界（子串匹配 / 大小写 / 短语 / 标点 / FIFO / 衰减 / 关键词提取）
 *   C. 召回对状态的影响（applyEvent / computeEpisodicMemoryCandidate 真实链路）
 *
 * 已由既有测试覆盖、本文件不再重复的项：
 *   - 空 buffer / 无命中返回 null：birth-state.test.ts（空白记忆状态验证）
 *   - FIFO 容量与最旧记忆淘汰：golden-state.test.ts [D3]
 *   - Tick 衰减幅度与分段一致性：golden-state.test.ts [D4] / [D5]
 *   - 相同初始 salience 下 trauma 衰减慢于普通记忆：golden-state.test.ts [D2]
 *
 * 约束：
 *   - 固定时间戳、固定 ID，不依赖网络 / LM Studio / PostgreSQL
 *   - 不复制生产公式替代真实函数调用（C 组用 A/B 对照状态隔离召回效果）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_CONSTANTS,
  createInitialState,
  applyEvent,
  evokeMemoryFromText,
  extractEpisodicMemory,
  computeEpisodicMemoryCandidate,
  type MarrowState,
} from '../state.js';
import type {
  EpisodicMemory,
  DialogueEvent,
  TickEvent,
  MemoryFormationEvent,
} from '../events.js';

// ─── 确定性工具 ────────────────────────────────────────────────

const T0 = '2026-01-01T00:00:00.000Z';

function makeMemory(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    id: overrides.id ?? 'mem-001',
    timestamp: overrides.timestamp ?? T0,
    summary: overrides.summary ?? '一次关于火锅的对话',
    keywords: overrides.keywords ?? ['火锅'],
    valence: overrides.valence ?? 0.6,
    salience: overrides.salience ?? 0.8,
    sourceEventId: overrides.sourceEventId ?? 'evt-source-001',
    isTrauma: overrides.isTrauma ?? false,
  };
}

/** 用给定 buffer 构造初始状态（其余字段保持出生值） */
function stateWith(memories: EpisodicMemory[]): MarrowState {
  return { ...createInitialState(T0), episodicBuffer: memories };
}

/** 构造确定性的 user_input DialogueEvent */
function makeUserDialogue(
  id: string,
  text: string,
  overrides: Partial<DialogueEvent['payload']> = {},
): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp: T0,
    payload: {
      direction: 'user_input',
      text,
      moodDelta: 0,
      salience: 0.5,
      action: 'statement',
      intensity: 0.8,
      ...overrides,
    },
  };
}

/** 构造确定性的 TickEvent */
function makeTick(id: string, deltaSeconds: number): TickEvent {
  return { type: 'tick', id, timestamp: T0, payload: { deltaSeconds } };
}

// ══════════════════════════════════════════════════════════════
// A. 召回算法
// ══════════════════════════════════════════════════════════════

test('[A1] 单条记忆命中任一关键词，返回该记忆', () => {
  const mem = makeMemory({ id: 'mem-a1', keywords: ['火锅', '好吃'] });
  const recalled = evokeMemoryFromText([mem], '今天想吃火锅');

  assert.notEqual(recalled, null);
  assert.equal(recalled!.id, 'mem-a1');
});

test('[A2] 同一记忆命中两个关键词时 hitCount 累加（score = salience × 2）', () => {
  // 若 hitCount 未累加：mem-two 得分 0.6，会被 mem-single（1.0）击败
  // 若正确累加：mem-two 得分 1.2 > 1.0，应由 mem-two 胜出
  const memTwo = makeMemory({ id: 'mem-two', keywords: ['火锅', '好吃'], salience: 0.6 });
  const memSingle = makeMemory({ id: 'mem-single', keywords: ['好吃'], salience: 1.0 });

  const recalled = evokeMemoryFromText([memTwo, memSingle], '火锅真好吃');

  assert.equal(recalled!.id, 'mem-two', '命中 2 个关键词应使 score 翻倍并胜出');
});

test('[A3] 多条记忆竞争时返回 score（salience × hitCount）最高者', () => {
  const memLow = makeMemory({ id: 'mem-low', keywords: ['火锅'], salience: 0.4 });
  const memHigh = makeMemory({ id: 'mem-high', keywords: ['火锅'], salience: 0.9 });

  // 故意把低分放在前面，确保结果不是「取第一条命中」
  const recalled = evokeMemoryFromText([memLow, memHigh], '今晚吃火锅');

  assert.equal(recalled!.id, 'mem-high');
});

test('[A4] score 相同时返回 buffer 中较早出现的记忆', () => {
  const first = makeMemory({ id: 'mem-first', keywords: ['火锅'], salience: 0.5 });
  const second = makeMemory({ id: 'mem-second', keywords: ['火锅'], salience: 0.5 });

  // 两条 score 均为 0.5；严格大于比较使先出现者保留
  assert.equal(evokeMemoryFromText([first, second], '火锅')!.id, 'mem-first');
  // 顺序反转后结论对称，证明是「先出现者」而非固定 ID
  assert.equal(evokeMemoryFromText([second, first], '火锅')!.id, 'mem-second');
});

test('[A5] salience 为 0 的记忆不会被召回', () => {
  const zero = makeMemory({ id: 'mem-zero', keywords: ['火锅'], salience: 0 });
  const unrelated = makeMemory({ id: 'mem-unrelated', keywords: ['天气'], salience: 0.9 });

  // score = 0 不满足 score > bestScore(0)，且没有其它命中 → null
  assert.equal(evokeMemoryFromText([zero, unrelated], '火锅'), null);
});

test('[A6] salience 低于最低召回门槛（1e-6）时不再召回', () => {
  const tiny = makeMemory({ id: 'mem-tiny', keywords: ['火锅'], salience: 1e-12 });
  const valid = makeMemory({ id: 'mem-valid', keywords: ['火锅'], salience: 1e-3 });

  assert.equal(evokeMemoryFromText([tiny], '火锅'), null, 'M1.4.8 起设最低显著性门槛');
  assert.equal(evokeMemoryFromText([valid], '火锅')!.id, 'mem-valid');
});

test('[A7] 多条记忆同时命中时最多返回一条', () => {
  const a = makeMemory({ id: 'mem-a', keywords: ['火锅'], salience: 0.3 });
  const b = makeMemory({ id: 'mem-b', keywords: ['火锅'], salience: 0.8 });
  const c = makeMemory({ id: 'mem-c', keywords: ['火锅'], salience: 0.5 });

  const recalled = evokeMemoryFromText([a, b, c], '火锅');

  assert.notEqual(recalled, null);
  assert.equal(Array.isArray(recalled), false, '返回值必须是单条记忆而非数组');
  assert.equal(recalled!.id, 'mem-b');
});

test('[A8] 空 buffer / 空文本 / 无命中均返回 null', () => {
  const mem = makeMemory({ id: 'mem-a8', keywords: ['火锅'] });

  assert.equal(evokeMemoryFromText([], '火锅'), null, '空 buffer 应返回 null');
  assert.equal(evokeMemoryFromText([mem], ''), null, '空文本应返回 null');
  assert.equal(evokeMemoryFromText([mem], '今天下雨了'), null, '无关键词命中应返回 null');
});

// ══════════════════════════════════════════════════════════════
// B. 召回边界
// ══════════════════════════════════════════════════════════════

test('[B1] 子串匹配：关键词「你好」会命中「你好意思拒绝吗」', () => {
  const mem = makeMemory({ id: 'mem-b1', keywords: ['你好'] });

  const recalled = evokeMemoryFromText([mem], '你好意思拒绝吗');

  assert.notEqual(recalled, null, '当前实现是 text.includes(keyword) 的子串匹配');
  assert.equal(recalled!.id, 'mem-b1');
});

test('[B2] 大小写敏感：关键词「Coffee」不命中「coffee」', () => {
  const mem = makeMemory({ id: 'mem-b2', keywords: ['Coffee'] });

  assert.equal(evokeMemoryFromText([mem], 'coffee'), null);
  // 对照：大小写一致时命中，确认不是关键词本身失效
  assert.equal(evokeMemoryFromText([mem], 'Coffee')!.id, 'mem-b2');
});

test('[B3] 无关短语不命中：「今天天气真好」不命中「明天要开会」', () => {
  const mem = makeMemory({ id: 'mem-b3', keywords: ['今天天气真好'] });

  assert.equal(evokeMemoryFromText([mem], '明天要开会'), null);
});

test('[B9] 中文近似短语可命中：「今天天气真好」命中「今天天气不错」', () => {
  const mem = makeMemory({ id: 'mem-b9', keywords: ['今天天气真好'] });

  // 公共子串「今天天气」= 4 字，覆盖率 4/6 → 部分匹配权重 0.82
  const recalled = evokeMemoryFromText([mem], '今天天气不错');

  assert.equal(recalled!.id, 'mem-b9', 'M1.4.8 支持中文短语改写召回');
});

test('[B4] 标点不阻止子串命中：关键词「火锅」命中「火锅！」', () => {
  const mem = makeMemory({ id: 'mem-b4', keywords: ['火锅'] });

  const recalled = evokeMemoryFromText([mem], '火锅！');

  assert.equal(recalled!.id, 'mem-b4');
});

test('[B5] FIFO 淘汰最旧记忆后，该记忆不再可召回', () => {
  const CAP = STATE_CONSTANTS.EPISODIC_BUFFER_CAPACITY;
  const oldest = makeMemory({ id: 'mem-oldest', keywords: ['旧暗号'] });
  const fillers = Array.from({ length: CAP - 1 }, (_, i) =>
    makeMemory({ id: `mem-fill-${i}`, keywords: [`填充词${i}`] }),
  );
  const before = stateWith([oldest, ...fillers]);

  // 淘汰前：最旧记忆可被召回
  assert.equal(evokeMemoryFromText(before.episodicBuffer, '旧暗号')!.id, 'mem-oldest');

  const formation: MemoryFormationEvent = {
    type: 'memory_formation',
    id: 'evt-memform-b5',
    timestamp: T0,
    payload: {
      sourceDialogueEventId: 'evt-dialogue-b5',
      memory: makeMemory({ id: 'mem-newest', keywords: ['新暗号'] }),
    },
  };
  const after = applyEvent(before, formation);

  assert.equal(after.episodicBuffer.length, CAP);
  assert.equal(after.episodicBuffer.some((m) => m.id === 'mem-oldest'), false);
  assert.equal(evokeMemoryFromText(after.episodicBuffer, '旧暗号'), null, '已淘汰记忆不应再被召回');
});

test('[B6] Tick 衰减可改变竞争记忆的排序', () => {
  // 初始：普通记忆 0.6 > trauma 0.55 → 普通记忆胜出
  const normal = makeMemory({
    id: 'mem-normal',
    keywords: ['火锅'],
    salience: 0.6,
    valence: 0.4,
    isTrauma: false,
  });
  const trauma = makeMemory({
    id: 'mem-trauma',
    keywords: ['火锅'],
    salience: 0.55,
    valence: -0.6,
    isTrauma: true,
  });

  const before = stateWith([normal, trauma]);
  assert.equal(evokeMemoryFromText(before.episodicBuffer, '火锅')!.id, 'mem-normal');

  // 30 天后：普通记忆按标准速率衰减，trauma 按 ×0.2 速率衰减 → 排序反转
  const after = applyEvent(before, makeTick('evt-tick-b6', 2_592_000));
  assert.equal(after.episodicBuffer.length, 2, 'Tick 只衰减不删除记忆');

  const normalSal = after.episodicBuffer.find((m) => m.id === 'mem-normal')!.salience;
  const traumaSal = after.episodicBuffer.find((m) => m.id === 'mem-trauma')!.salience;
  assert.ok(traumaSal > normalSal, `trauma(${traumaSal}) 应已超过 normal(${normalSal})`);

  assert.equal(evokeMemoryFromText(after.episodicBuffer, '火锅')!.id, 'mem-trauma');
});

test('[B8] 形成记忆时 keywords 去重且不超过 6 个', () => {
  const event = makeUserDialogue(
    'evt-b8',
    '苹果，苹果，香蕉，橙子，葡萄，西瓜，草莓，芒果',
    { intensity: 1.0 },
  );

  const memory = extractEpisodicMemory(event, 2.0);

  assert.notEqual(memory, null);
  const keywords = memory!.keywords;
  assert.ok(keywords.length <= 6, `keywords 不应超过 6 个，实际 ${keywords.length}`);
  assert.equal(new Set(keywords).size, keywords.length, 'keywords 必须去重');
  assert.equal(keywords.filter((k) => k === '苹果').length, 1, '重复的「苹果」只能保留一次');
});

// ══════════════════════════════════════════════════════════════
// C. 状态影响（真实 applyEvent / computeEpisodicMemoryCandidate）
//
// 方法：对同一个 DialogueEvent 分别作用于「含命中记忆」与「空 buffer」的
// 相同状态，A/B 差值即召回带来的净效果，其余 appraisal / 能量消耗完全抵消。
// ══════════════════════════════════════════════════════════════

test('[C1] 正向记忆唤醒拉高 mood（净值 = valence × salience × MEMORY_MOOD_IMPACT）', () => {
  const mem = makeMemory({
    id: 'mem-c1',
    keywords: ['火锅'],
    valence: 0.6,
    salience: 0.5,
    isTrauma: false,
  });
  const event = makeUserDialogue('evt-c1', '火锅');

  const withMemory = applyEvent(stateWith([mem]), event);
  const withoutMemory = applyEvent(stateWith([]), event);

  const moodDiff = withMemory.moodBaseline - withoutMemory.moodBaseline;
  const expected = mem.valence * mem.salience * STATE_CONSTANTS.MEMORY_MOOD_IMPACT;

  assert.ok(moodDiff > 0, `正向记忆应拉高 mood，实际差值 ${moodDiff}`);
  assert.ok(Math.abs(moodDiff - expected) < 1e-9, `mood 差值 ${moodDiff} 应等于 ${expected}`);
});

test('[C2] 正向记忆唤醒恢复 energy（净值 = MEMORY_ENERGY_RECOVERY × salience）', () => {
  const mem = makeMemory({
    id: 'mem-c2',
    keywords: ['火锅'],
    valence: 0.6,
    salience: 0.5,
    isTrauma: false,
  });
  const event = makeUserDialogue('evt-c2', '火锅');

  const withMemory = applyEvent(stateWith([mem]), event);
  const withoutMemory = applyEvent(stateWith([]), event);

  const energyDiff = withMemory.energy - withoutMemory.energy;
  const expected = STATE_CONSTANTS.MEMORY_ENERGY_RECOVERY * mem.salience;

  assert.ok(energyDiff > 0, `正向记忆应恢复 energy，实际差值 ${energyDiff}`);
  assert.ok(Math.abs(energyDiff - expected) < 1e-9, `energy 差值 ${energyDiff} 应等于 ${expected}`);
});

test('[C3] 负向 trauma 记忆拉低 mood 并增加 cognitiveLoad', () => {
  const mem = makeMemory({
    id: 'mem-c3',
    keywords: ['火锅'],
    valence: -0.6,
    salience: 0.5,
    isTrauma: true,
  });
  const event = makeUserDialogue('evt-c3', '火锅');

  const withMemory = applyEvent(stateWith([mem]), event);
  const withoutMemory = applyEvent(stateWith([]), event);

  const moodDiff = withMemory.moodBaseline - withoutMemory.moodBaseline;
  const loadDiff = withMemory.cognitiveLoad - withoutMemory.cognitiveLoad;
  const expectedMood = mem.valence * mem.salience * STATE_CONSTANTS.MEMORY_MOOD_IMPACT;
  const expectedLoad = STATE_CONSTANTS.MEMORY_TRAUMA_COGNITIVE_LOAD * mem.salience;

  assert.ok(moodDiff < 0, `创伤记忆应拉低 mood，实际差值 ${moodDiff}`);
  assert.ok(Math.abs(moodDiff - expectedMood) < 1e-9, `mood 差值 ${moodDiff} 应等于 ${expectedMood}`);
  assert.ok(Math.abs(loadDiff - expectedLoad) < 1e-9, `cognitiveLoad 差值 ${loadDiff} 应等于 ${expectedLoad}`);
});

test('[C4] 负向非 trauma 记忆拉低 mood，但不增加 trauma cognitiveLoad', () => {
  const mem = makeMemory({
    id: 'mem-c4',
    keywords: ['火锅'],
    valence: -0.6,
    salience: 0.5,
    isTrauma: false,
  });
  const event = makeUserDialogue('evt-c4', '火锅');

  const withMemory = applyEvent(stateWith([mem]), event);
  const withoutMemory = applyEvent(stateWith([]), event);

  const moodDiff = withMemory.moodBaseline - withoutMemory.moodBaseline;
  const loadDiff = withMemory.cognitiveLoad - withoutMemory.cognitiveLoad;

  assert.ok(moodDiff < 0, `负向记忆应拉低 mood，实际差值 ${moodDiff}`);
  assert.equal(loadDiff, 0, '非 trauma 负向记忆不应增加 trauma cognitiveLoad');
});

test('[C5] 召回旧记忆不再参与新记忆形成门槛（M1.4.8）', () => {
  const state = createInitialState(T0); // attentionFocus=0.5 → attentionMod=0.65
  const event = makeUserDialogue('evt-c5', '火锅真好吃', {
    intensity: 0.9,
    action: 'statement',
  });

  // baseValenceDelta=1.0 → weightedMoodDelta=0.65 < 1.0，当前输入自身不足门槛
  assert.equal(
    computeEpisodicMemoryCandidate(state, event, 1.0),
    null,
    '当前输入自身情绪不足时不应形成记忆',
  );

  // 即使 buffer 中存在高显著性、可被当前文本召回的记忆，也不得越过门槛
  const evoked = makeMemory({
    id: 'mem-c5',
    keywords: ['火锅'],
    valence: 0.6,
    salience: 0.9,
    isTrauma: false,
  });
  assert.equal(evokeMemoryFromText([evoked], event.payload.text)!.id, 'mem-c5');
  assert.equal(
    computeEpisodicMemoryCandidate(state, event, 1.0),
    null,
    'memoryMoodDelta 不得单独触发新记忆（只影响状态，不影响形成）',
  );
});

test('[C6] 当前输入自身情绪足够时仍可正常形成记忆', () => {
  const state = createInitialState(T0);

  const positive = makeUserDialogue('evt-c6a', '火锅真好吃', {
    intensity: 0.9,
    action: 'statement',
  });
  // baseValenceDelta=2.0 → weightedMoodDelta=1.3 >= 1.0
  // M1.4.9：效价来自经历本身，不再由 baseValenceDelta 的符号推导
  const mem = computeEpisodicMemoryCandidate(state, positive, 2.0, 0.6);
  assert.notEqual(mem, null, '当前经历自身达到阈值时应正常形成');
  assert.equal(mem!.valence, 0.6);

  const negative = makeUserDialogue('evt-c6b', '火锅真难吃', {
    intensity: 0.9,
    action: 'complaint',
  });
  const negMem = computeEpisodicMemoryCandidate(state, negative, -2.0, -0.6);
  assert.notEqual(negMem, null, '负向当前经历同样应正常形成');
  assert.equal(negMem!.valence, -0.6);
});
