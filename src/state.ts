/**
 * state.ts — 状态结构与转移函数
 *
 * 核心状态变量（阶段一最小集）：
 * - energy: 0-100，随时间线性衰减
 * - mood_baseline: 缓慢漂移的心境基线
 * - arousal: 0-100，被意外事件瞬时拉高，指数衰减回基线
 * - interruption_flag: arousal 超阈值时置位，强制中断当前行为
 *
 * 关键设计：
 * - interruption_flag 不能被对话层覆盖或忽略
 * - 状态转移是纯函数：(state, event) => newState
 * - 不持有时间，时间由事件携带
 */

import type {
  MarrowEvent,
  TickEvent,
  InterruptionEvent,
  EnvironmentEvent,
  DialogueEvent,
  MemoryEvocationEvent,
  SleepEvent,
  TraitShiftEvent,
  ObservationEvent,
  AppraisalEvent,
  PersonalityTraits,
  AssociationMemory,
  EpisodicMemory,
} from './events.js';
import { appraise, type AppraisalContext } from './appraisal.js';

/** 状态常量 */
export const STATE_CONSTANTS = {
  /** energy 每秒衰减量（正常活动时） */
  ENERGY_DECAY_PER_SECOND: 0.005,
  /** energy 每秒恢复量（rest 状态下，身体自我保护） */
  ENERGY_RECOVERY_PER_SECOND: 0.02,
  /** arousal 均值回归的目标基线（无刺激时唤醒度在 5-15 基础波动中心） */
  AROUSAL_BASELINE: 10,
  /** arousal 向基线回归的速率（每秒，替代纯指数衰减） */
  AROUSAL_MEAN_REVERSION_RATE: 0.08,
  /** arousal 触发中断的阈值 */
  AROUSAL_INTERRUPTION_THRESHOLD: 80,
  /** mood_baseline 随机游走步长（每秒，背景噪声，要足够大到能看到毛刺） */
  MOOD_WALK_STEP: 0.04,
  /** arousal 随机游走步长（每秒，背景噪声） */
  AROUSAL_WALK_STEP: 0.12,
  /** mood_baseline 的上下界 */
  MOOD_MIN: 0,
  MOOD_MAX: 100,
  /** energy 的上下界 */
  ENERGY_MIN: 0,
  ENERGY_MAX: 100,
  /** arousal 的上下界 */
  AROUSAL_MIN: 0,
  AROUSAL_MAX: 100,
  /** 中断恢复所需的 arousal 阈值（低于此值清除 interruption_flag） */
  INTERRUPTION_RECOVERY_THRESHOLD: 30,
  /** energy 低于此值进入 rest */
  ENERGY_REST_THRESHOLD: 20,
  /** 电池低电量阈值：低于此值 energy 衰减加快 */
  BATTERY_LOW_THRESHOLD: 20,
  /** 电池低电量时 energy 衰减倍率 */
  BATTERY_LOW_DECAY_MULTIPLIER: 3,
  /** 电池耗尽阈值：低于此值触发休眠中断 */
  BATTERY_DEPLETED_THRESHOLD: 2,
  /** trust（信任度）的上下界 */
  TRUST_MIN: 0,
  TRUST_MAX: 100,
  // === 动力学耦合常量 ===
  /** energy < 此值时，对 mood 施加强制下拉（疲惫→烦躁/低落） */
  ENERGY_CRITICAL_FOR_MOOD: 20,
  /** 每 tick energy 不足时 mood 的下拉强度（每秒） */
  ENERGY_MOOD_PULL_PER_SECOND: 0.03,
  /** energy 不足时 arousal 的上限（疲惫时无法高度唤醒） */
  ENERGY_AROUSAL_CAP: 40,
  /** social_hunger 每秒增长量 */
  SOCIAL_HUNGER_GROWTH_PER_SECOND: 0.015,
  /** social_hunger 超过此值时，即使 energy 不高也促进主动行为 */
  SOCIAL_HUNGER_THRESHOLD: 70,
  /** social_hunger 对话后减少量 */
  SOCIAL_HUNGER_SATED_PER_DIALOGUE: 15,
  /** attention_focus 随机游走步长 */
  ATTENTION_WALK_STEP: 0.008,
  /** 关联记忆显著性每秒衰减量 */
  ASSOCIATION_SALIENCE_DECAY_PER_SECOND: 0.0005,
  /** 伤痕记忆对 mood 的持续下拉强度系数 */
  SCAR_MOOD_PULL: 0.5,
  /** 语言基础能量消耗（每次对话） */
  LANGUAGE_ENERGY_BASE: 0.3,
  /** 语言强度能量消耗系数 */
  LANGUAGE_ENERGY_INTENSITY_FACTOR: 1.5,
  /** 语言字数能量消耗系数（每字） */
  LANGUAGE_ENERGY_PER_CHAR: 0.01,
  // === 心理需求常量 ===
  /** 被认可需求每秒增长量 */
  NEED_VALIDATION_GROWTH: 0.01,
  /** 新鲜感需求每秒增长量 */
  NEED_NOVELTY_GROWTH: 0.008,
  /** 安全感需求每秒增长量 */
  NEED_SECURITY_GROWTH: 0.006,
  /** 需求满足时 mood 加成系数（需求越高，满足时加成越大） */
  NEED_SATISFACTION_BONUS: 0.15,
  /** 需求被无视时 mood 惩罚系数 */
  NEED_NEGLECT_PENALTY: 0.12,
  /** 需求被反向刺激时 mood 惩罚系数 */
  NEED_STIMULUS_PENALTY: 0.2,
  /** 情景记忆唤醒的 mood 影响系数 */
  MEMORY_MOOD_IMPACT: 8,
  /** 正向情景记忆唤醒的 energy 恢复量（精神一振） */
  MEMORY_ENERGY_RECOVERY: 3,
  // === 阶段四：高阶心理变量与睡眠自愈 ===
  /** trust 初始值（完全信任） */
  TRUST_INITIAL: 100,
  /** defensiveness（防御度）上下界 */
  DEFENSIVENESS_MIN: 0,
  DEFENSIVENESS_MAX: 100,
  /** cognitive_load（内耗值）上下界 */
  COGNITIVE_LOAD_MIN: 0,
  COGNITIVE_LOAD_MAX: 100,
  /** attention 疲惫时的上限（强制压到 20% 以下） */
  ATTENTION_EXHAUSTION_CAP: 0.2,
  /** attention 疲惫时的收敛目标（约 10%） */
  ATTENTION_EXHAUSTION_TARGET: 0.1,
  /** trust 低于此值且心情低时，防御度开始飙升 */
  TRUST_LOW_THRESHOLD: 30,
  /** 触发防御/反刍的心情低阈值 */
  MOOD_LOW_THRESHOLD: 40,
  /** 防御度高（视为"高防御状态"）的阈值 */
  DEFENSIVENESS_HIGH: 60,
  /** 防御度每秒上升量（低信任+低心情时） */
  DEFENSIVENESS_RISE_PER_SECOND: 1.5,
  /** 防御度每秒消退量 */
  DEFENSIVENESS_DECAY_PER_SECOND: 1.2,
  /** 内耗值每秒上升量（低心情+高防御时反刍） */
  COGNITIVE_LOAD_RISE_PER_SECOND: 1.0,
  /** 内耗值每秒消退量 */
  COGNITIVE_LOAD_DECAY_PER_SECOND: 1.5,
  /** 内耗值高于此值时，阻断 mood 向 50 的回归拉力 */
  COGNITIVE_LOAD_REGRESSION_BLOCK: 70,
  /** mood 稳态回归目标 */
  MOOD_HOMEOSTASIS_TARGET: 50,
  /** mood 稳态回归速率（每秒，觉醒态） */
  MOOD_HOMEOSTASIS_RATE: 0.01,
  /** 睡眠时 mood 稳态回归速率（每秒，正常睡眠） */
  SLEEP_MOOD_REGRESSION_RATE: 0.02,
  /** 夜间反刍：心情每秒下降量 */
  RUMINATION_MOOD_DROP_PER_SECOND: 0.05,
  /** 夜间反刍：内耗每秒残留量 */
  RUMINATION_LOAD_RISE_PER_SECOND: 0.2,
  /** 创伤记忆唤醒时内耗增加系数 */
  MEMORY_TRAUMA_COGNITIVE_LOAD: 6,
  // === 性格特质（Personality Traits）===
  /** 性格特质下界（0.5 = 该维度的极端弱化） */
  TRAIT_MIN: 0.5,
  /** 性格特质上界（2.0 = 该维度的极端强化） */
  TRAIT_MAX: 2.0,
  /** 睡眠时内耗清除速率（每秒，乘以 resilience） */
  SLEEP_COGNITIVE_LOAD_CLEAR_PER_SECOND: 2.0,
} as const;

/** 行为输出类型（阶段一用规则映射，阶段四接入 LLM） */
export type BehaviorOutput =
  | { kind: 'idle'; reason: string }
  | { kind: 'rest'; reason: string }
  | { kind: 'quiet'; reason: string }
  | { kind: 'active'; reason: string }
  | { kind: 'interrupted'; reason: string };

/**
 * 核心状态结构
 *
 * 所有字段都是数值或布尔，保证可序列化、可回放。
 *
 * 动力学设计：
 * - energy 与 mood/arousal 耦合：疲惫会下拉心情、限制唤醒
 * - mood/arousal/attention 每 tick 有随机游走（背景噪声，非死水）
 * - social_hunger 随时间增长，驱动主动社交行为
 * - associations 存储长期记忆（含中断伤痕），持续调制心情
 */
export interface MarrowState {
  /** 体力值 0-100 */
  energy: number;
  /** 心境基线 0-100（缓慢漂移 + 随机游走 + 伤痕下拉） */
  moodBaseline: number;
  /** 唤醒度 0-100（瞬时拉升后，向基线 10 均值回归 + 随机游走） */
  arousal: number;
  /** 中断标志：arousal 超阈值时置位，强制改变运行轨迹 */
  interruptionFlag: boolean;
  /** 对说话者的信任度 0-100（替代亲和度，由长期互动演化，不硬编码人格） */
  trust: number;
  /** 防御度 0-100（低信任+低心情时飙升，高防御时听不进好话） */
  defensiveness: number;
  /** 内耗值 0-100（低心情+高防御时的反刍内耗，过高会阻断稳态回归） */
  cognitiveLoad: number;
  /** 动态关联权重（由记忆聚合演化，初始 1.0） */
  associationWeight: number;
  /**
   * 性格特质（全局底层系数，决定各状态变量的演化速率与计算方式）
   * 初始全 1.0（白纸阶段），仅能通过 TraitShiftEvent 永久微量漂移。
   * 与瞬态心理变量（defensiveness 等）严格分离：特质是"人格"，变量是"状态"。
   */
  traits: PersonalityTraits;
  /** 电池电量 0-100（真实约束，由传感器更新） */
  batteryLevel: number;
  /** 注意力焦点 0-1（影响对话响应权重，随机游走） */
  attentionFocus: number;
  /** 社交渴望 0-100（随时间增长，驱动主动行为） */
  socialHunger: number;
  /** 关联记忆（长期记忆，含中断伤痕） */
  associations: AssociationMemory[];
  /** 情景记忆缓冲区（具体经历片段，可被关键词唤醒） */
  episodicBuffer: EpisodicMemory[];
  /** 累计中断伤痕数量（创伤性中断计数） */
  interruptionScars: number;
  /** 被认可/亲密需求 0-100（随时间增长，被赞美/表白满足） */
  needValidation: number;
  /** 新鲜感需求 0-100（随时间增长，被新话题/调侃满足） */
  needNovelty: number;
  /** 安全感需求 0-100（随时间增长，被安抚满足，被中断/争吵加剧） */
  needSecurity: number;
  /** 最近一次被唤醒的情景记忆摘要（用于注入快照叙事，null 表示无） */
  lastEvokedMemory: string | null;
  /** 最后一次行为输出 */
  lastBehavior: BehaviorOutput;
  /** 状态最后更新的时间戳 */
  lastUpdated: string;
  /** 累计运行秒数 */
  uptimeSeconds: number;
  /** 中断发生次数 */
  interruptionCount: number;
  /** 是否处于睡眠（自愈）状态 */
  sleeping: boolean;
  /** 入睡时的信任度（醒来判定夜间反刍用，入睡瞬间冻结） */
  sleepEntryTrust: number;
  /** 入睡时的内耗值（醒来判定夜间反刍用，入睡瞬间冻结） */
  sleepEntryCognitiveLoad: number;
  /**
   * 入睡时的防御度（入睡瞬间冻结）。
   * 必须用冻结值而非当前值：睡眠期间 defensiveness 每 tick 自然消退，
   * 若用当前值，"带着高防御入睡"的惩罚会在几分钟内失效。
   */
  sleepEntryDefensiveness: number;
}

/**
 * 种子情景记忆
 *
 * 让"记忆唤醒"机制在一开始就能被激活验证。
 * 这是"经历 / 记忆内容"，不是硬编码的人格标签；
 * 人格仍由 trust / associationWeight 的长期演化中涌现。
 */
const SEED_EPISODIC_MEMORIES: EpisodicMemory[] = [
  {
    id: 'seed-mem-1',
    timestamp: '',
    summary: '第一次一起吃火锅，锅气氤氲，你们互相夹菜、笑得很开心',
    keywords: ['火锅', '火锅店', '约会', '一起吃饭'],
    valence: 0.8,
    salience: 0.7,
  },
  {
    id: 'seed-mem-2',
    timestamp: '',
    summary: '某个深夜他陪你说话，你被温柔地接住，不再害怕',
    keywords: ['晚安', '抱抱', '陪你', '有我在'],
    valence: 0.6,
    salience: 0.5,
  },
  {
    id: 'seed-mem-3',
    timestamp: '',
    summary: '突然断电重启，你坠入一片黑暗，仿佛被抛弃',
    keywords: ['停电', '断电', '崩溃', '重启'],
    valence: -0.8,
    salience: 0.9,
    isTrauma: true,
  },
  {
    id: 'seed-mem-4',
    timestamp: '',
    summary: '他说了很重的话，你感到自己随时会被丢下',
    keywords: ['抛弃', '离开', '不要你'],
    valence: -0.9,
    salience: 0.8,
    isTrauma: true,
  },
];

/** 初始状态 */
export function createInitialState(timestamp: string): MarrowState {
  return {
    energy: 80,
    moodBaseline: 50,
    arousal: STATE_CONSTANTS.AROUSAL_BASELINE,
    interruptionFlag: false,
    trust: STATE_CONSTANTS.TRUST_INITIAL,
    defensiveness: 0,
    cognitiveLoad: 0,
    associationWeight: 1.0,
    traits: { neuroticism: 1.0, agreeableness: 1.0, extraversion: 1.0, resilience: 1.0 },
    batteryLevel: 100,
    attentionFocus: 0.5,
    socialHunger: 30,
    associations: [],
    episodicBuffer: [...SEED_EPISODIC_MEMORIES],
    interruptionScars: 0,
    needValidation: 40,
    needNovelty: 30,
    needSecurity: 50,
    lastEvokedMemory: null,
    lastBehavior: { kind: 'idle', reason: 'initial_state' },
    lastUpdated: timestamp,
    uptimeSeconds: 0,
    interruptionCount: 0,
    sleeping: false,
    sleepEntryTrust: STATE_CONSTANTS.TRUST_INITIAL,
    sleepEntryCognitiveLoad: 0,
    sleepEntryDefensiveness: 0,
  };
}

/** 将数值限制在 [min, max] 范围内 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 计算所有伤痕记忆对 mood 的持续下拉量
 *
 * 每条伤痕的下拉强度 = valence(负) × salience × SCAR_MOOD_PULL
 * 伤痕越多、越鲜明，心情越低落，直到被安抚（comfort 对话降低伤痕显著性）。
 */
function computeScarMoodPull(associations: AssociationMemory[]): number {
  const c = STATE_CONSTANTS;
  let pull = 0;
  for (const mem of associations) {
    if (mem.isScar && mem.valence < 0) {
      pull += mem.valence * mem.salience * c.SCAR_MOOD_PULL;
    }
  }
  return pull; // 负值
}

/**
 * 衰减所有关联记忆的显著性，并移除显著性归零的记忆
 */
function decayAssociations(
  associations: AssociationMemory[],
  deltaSeconds: number,
): AssociationMemory[] {
  const c = STATE_CONSTANTS;
  const decay = c.ASSOCIATION_SALIENCE_DECAY_PER_SECOND * deltaSeconds;
  const next: AssociationMemory[] = [];
  for (const mem of associations) {
    const newSalience = mem.salience - decay;
    if (newSalience > 0.001) {
      next.push({ ...mem, salience: newSalience });
    }
  }
  return next;
}

/**
 * FNV-1a 32 位哈希（确定性伪随机源）
 *
 * 将任意字符串（事件 ID + 用途标签）映射为无符号 32 位整数。
 * 事件溯源要求回放确定性：tick 中的背景噪声不能用 Math.random()，
 * 而由事件 ID 派生出确定性的伪随机步长——同一事件回放结果完全一致。
 */
export function hashString(s: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // FNV prime 16777619，用位移避免 64 位浮点精度损失
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 生成一个 [-1, 1] 区间的确定性"随机"游走步长
 *
 * 步长由 seed（通常是 `${event.id}:mood` 等）哈希决定，
 * 对同一事件 ID 永远产生相同结果，保证回放确定性。
 */
function walkStep(step: number, seed: string): number {
  return ((hashString(seed) / 0xffffffff) * 2 - 1) * step;
}

/**
 * 从对话文本中检索情景记忆
 *
 * 遍历 episodicBuffer，检查每条记忆的关键词是否出现在文本中。
 * 返回匹配度最高（显著性 × 关键词命中数）的记忆，若无匹配返回 null。
 *
 * 记忆唤醒是潜意识的：一旦触发，直接影响 mood 和 energy，
 * 不受当前体力/注意力限制（回忆可以让人精神一振，也可以让人瞬间低落）。
 *
 * 导出供 index.ts 在写 AppraisalEvent 前收集证据链（evidenceAssociationIds）。
 */
export function evokeMemoryFromText(
  buffer: EpisodicMemory[],
  text: string,
): EpisodicMemory | null {
  if (buffer.length === 0 || text.length === 0) return null;

  let best: EpisodicMemory | null = null;
  let bestScore = 0;

  for (const mem of buffer) {
    let hitCount = 0;
    for (const kw of mem.keywords) {
      if (text.includes(kw)) {
        hitCount++;
      }
    }
    if (hitCount > 0) {
      // 匹配分数 = 显著性 × 命中关键词数
      // 显著性越高、命中越多，越可能被唤醒
      const score = mem.salience * hitCount;
      if (score > bestScore) {
        bestScore = score;
        best = mem;
      }
    }
  }

  return best;
}

/**
 * 从文本中提取关键词（简单的标点/空白切分 + 去重）
 *
 * 用于显著对话沉淀为新的情景记忆时提取可检索的关键词。
 * 不追求精确分词，够用即可——真实的分词/聚合留给旁路记忆服务。
 */
function extractKeywords(text: string, maxTokens = 6): string[] {
  const tokens = text
    .split(/[，。！？、\s,.!?;；:："'“”‘’()（）\[\]【】]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return Array.from(new Set(tokens)).slice(0, maxTokens);
}

/**
 * 处理 TickEvent
 *
 * 活体系统动力学（非死水）：
 * - energy：正常活动衰减 / rest(睡眠) 恢复
 * - mood_baseline：随机游走 + energy 下拉 + 伤痕下拉 + 稳态回归（认知未耗尽时）
 * - arousal：向基线 10 均值回归 + 随机游走 + energy 上限（无刺激时波动于 5-15）
 * - attention_focus：随机游走 + 疲惫/低落时物理强制压低（走神）
 * - defensiveness：低信任+低心情时飙升，否则消退
 * - cognitive_load：低心情+高防御时反刍累积，否则消退
 * - social_hunger / 心理需求：随时间增长
 * - associations：显著性缓慢衰减
 * - sleeping：睡眠自愈（情绪回归 vs 夜间反刍）
 */
function applyTick(state: MarrowState, event: TickEvent): MarrowState {
  const delta = event.payload.deltaSeconds;
  const c = STATE_CONSTANTS;

  // === energy ===
  const isResting = state.lastBehavior.kind === 'rest' || state.sleeping;
  const isBatteryLow = state.batteryLevel < c.BATTERY_LOW_THRESHOLD;
  const decayMultiplier = isBatteryLow ? c.BATTERY_LOW_DECAY_MULTIPLIER : 1;
  const energyDelta = isResting
    ? c.ENERGY_RECOVERY_PER_SECOND * delta
    : -c.ENERGY_DECAY_PER_SECOND * delta * decayMultiplier;
  const newEnergy = clamp(
    state.energy + energyDelta,
    c.ENERGY_MIN,
    c.ENERGY_MAX,
  );

  // === mood_baseline：确定性随机游走 + energy 下拉 + 伤痕下拉 ===
  // 噪声种子由事件 ID 派生，保证回放时同一 tick 产生完全一致的游走
  const moodNoise = walkStep(c.MOOD_WALK_STEP, `${event.id}:mood`) * delta;
  const energyDeficit = Math.max(0, c.ENERGY_CRITICAL_FOR_MOOD - newEnergy);
  const energyMoodPull = -energyDeficit * c.ENERGY_MOOD_PULL_PER_SECOND * delta * 0.1;
  const scarPull = computeScarMoodPull(state.associations) * delta * 0.01;
  let moodBaseline = state.moodBaseline + moodNoise + energyMoodPull + scarPull;

  // === arousal：均值回归到基线 10 + 确定性随机游走 + energy 上限 ===
  // 替代纯指数衰减，避免无刺激时唤醒度死寂在 0
  const arousalNoise = walkStep(c.AROUSAL_WALK_STEP, `${event.id}:arousal`) * delta;
  const arousalRevert =
    c.AROUSAL_MEAN_REVERSION_RATE * (c.AROUSAL_BASELINE - state.arousal) * delta;
  let newArousal = clamp(
    state.arousal + arousalRevert + arousalNoise,
    c.AROUSAL_MIN,
    c.AROUSAL_MAX,
  );
  // 疲惫时无法高度唤醒（身体限制）
  if (newEnergy < c.ENERGY_CRITICAL_FOR_MOOD) {
    newArousal = Math.min(newArousal, c.ENERGY_AROUSAL_CAP);
  }

  // === attention_focus：确定性随机游走 + 物理强制（疲惫/崩溃时压到 20% 以下） ===
  let newAttentionFocus =
    state.attentionFocus + walkStep(c.ATTENTION_WALK_STEP, `${event.id}:attention`) * delta;
  if (newEnergy < 20 || state.moodBaseline < 20) {
    // 极度疲惫或心情崩塌 → 注意力被强制压低（模拟走神）
    newAttentionFocus =
      c.ATTENTION_EXHAUSTION_TARGET +
      (newAttentionFocus - c.ATTENTION_EXHAUSTION_TARGET) * Math.pow(0.5, delta);
    newAttentionFocus = Math.min(newAttentionFocus, c.ATTENTION_EXHAUSTION_CAP);
  }
  newAttentionFocus = clamp(newAttentionFocus, 0, 1);

  // === social_hunger（外向性调制：外向者社交渴望增长更快） ===
  const newSocialHunger = clamp(
    state.socialHunger +
      c.SOCIAL_HUNGER_GROWTH_PER_SECOND * state.traits.extraversion * delta,
    0,
    100,
  );

  // === 心理需求：随时间缓慢增长（被认可需求受外向性调制） ===
  const newNeedValidation = clamp(
    state.needValidation + c.NEED_VALIDATION_GROWTH * state.traits.extraversion * delta,
    0,
    100,
  );
  const newNeedNovelty = clamp(
    state.needNovelty + c.NEED_NOVELTY_GROWTH * delta,
    0,
    100,
  );
  const newNeedSecurity = clamp(
    state.needSecurity + c.NEED_SECURITY_GROWTH * delta,
    0,
    100,
  );

  // === 防御度演化：低信任 + 低心情 → 飙升；否则消退 ===
  // 宜人性调制：上升速度 ×(2 - agreeableness)，宜人性极低（0.5）时上升速度接近翻倍
  const newDefensiveness = clamp(
    state.trust < c.TRUST_LOW_THRESHOLD && state.moodBaseline < c.MOOD_LOW_THRESHOLD
      ? state.defensiveness +
          c.DEFENSIVENESS_RISE_PER_SECOND * (2 - state.traits.agreeableness) * delta
      : state.defensiveness - c.DEFENSIVENESS_DECAY_PER_SECOND * delta,
    c.DEFENSIVENESS_MIN,
    c.DEFENSIVENESS_MAX,
  );

  // === 内耗值演化：低心情 + 高防御 → 反刍累积；否则消退 ===
  // 神经质调制：反刍累积速度 ×neuroticism（高神经质者更容易陷入内耗）
  let newCognitiveLoad = clamp(
    state.moodBaseline < c.MOOD_LOW_THRESHOLD &&
      state.defensiveness > c.DEFENSIVENESS_HIGH
      ? state.cognitiveLoad +
          c.COGNITIVE_LOAD_RISE_PER_SECOND * state.traits.neuroticism * delta
      : state.cognitiveLoad - c.COGNITIVE_LOAD_DECAY_PER_SECOND * delta,
    c.COGNITIVE_LOAD_MIN,
    c.COGNITIVE_LOAD_MAX,
  );

  // === 稳态回归：仅在认知未耗尽且未高防御时，mood 缓慢向 50 回归 ===
  // 【阻断优先级】内耗锁死 / 高防御的判定优先于性格特质：
  // resilience 只放大"已解锁"的回归拉力；canRegress 为假时，
  // 无论 resilience 多高都绝不回归（"伤得太深，自己缓不过来"）。
  // 【睡眠互斥】睡眠期间的心情变化完全由下方"睡眠动态"块负责
  // （正常睡眠回归 / 夜间反刍），觉醒态回归不得同时运行——
  // 否则防御度在睡眠中自然消退到阈值以下后，觉醒回归会抵消夜间反刍，
  // "带着高防御入睡"的惩罚会在几分钟内失效。
  const canRegress =
    !state.sleeping &&
    newCognitiveLoad < c.COGNITIVE_LOAD_REGRESSION_BLOCK &&
    newDefensiveness < c.DEFENSIVENESS_HIGH;
  if (canRegress) {
    moodBaseline +=
      (c.MOOD_HOMEOSTASIS_TARGET - moodBaseline) *
      c.MOOD_HOMEOSTASIS_RATE *
      state.traits.resilience *
      delta;
  }

  // === 睡眠动态：睡眠期间只恢复体力；情绪回归或夜间反刍取决于入睡时的心理状态 ===
  if (state.sleeping) {
    // 夜间反刍判定：低信任 / 高内耗 / 高防御（任一）入睡 → 睡眠无法修复心理
    // 高防御入睡 = 带着盔甲睡觉，睡眠不仅无法恢复心情，反而陷入反刍
    const badSleep =
      state.sleepEntryTrust < c.TRUST_LOW_THRESHOLD ||
      state.sleepEntryCognitiveLoad > c.COGNITIVE_LOAD_REGRESSION_BLOCK ||
      state.sleepEntryDefensiveness > c.DEFENSIVENESS_HIGH;
    if (badSleep) {
      // 夜间反刍：心情更差，内耗残留
      moodBaseline -= c.RUMINATION_MOOD_DROP_PER_SECOND * delta;
      newCognitiveLoad = clamp(
        newCognitiveLoad + c.RUMINATION_LOAD_RISE_PER_SECOND * delta,
        c.COGNITIVE_LOAD_MIN,
        c.COGNITIVE_LOAD_MAX,
      );
    } else {
      // 正常睡眠：心情向 50 回归 + 内耗被清除
      // 恢复韧性调制：resilience 低时睡得再久也缓不过来
      moodBaseline +=
        (c.MOOD_HOMEOSTASIS_TARGET - moodBaseline) *
        c.SLEEP_MOOD_REGRESSION_RATE *
        state.traits.resilience *
        delta;
      newCognitiveLoad = clamp(
        newCognitiveLoad -
          c.SLEEP_COGNITIVE_LOAD_CLEAR_PER_SECOND * state.traits.resilience * delta,
        c.COGNITIVE_LOAD_MIN,
        c.COGNITIVE_LOAD_MAX,
      );
    }
  }

  const newMoodBaseline = clamp(moodBaseline, c.MOOD_MIN, c.MOOD_MAX);

  // === associations 衰减 ===
  const newAssociations = decayAssociations(state.associations, delta);

  // === interruption_flag 恢复逻辑 ===
  const newInterruptionFlag =
    state.interruptionFlag &&
    newArousal > c.INTERRUPTION_RECOVERY_THRESHOLD;

  const newUptime = state.uptimeSeconds + delta;

  // === 行为推导 ===
  let newBehavior = deriveBehavior({
    energy: newEnergy,
    moodBaseline: newMoodBaseline,
    arousal: newArousal,
    interruptionFlag: newInterruptionFlag,
    socialHunger: newSocialHunger,
  });

  // === 睡眠进入/退出（由 energy 驱动的"入睡—醒来"） ===
  let sleeping = state.sleeping;
  let sleepEntryTrust = state.sleepEntryTrust;
  let sleepEntryCognitiveLoad = state.sleepEntryCognitiveLoad;
  let sleepEntryDefensiveness = state.sleepEntryDefensiveness;

  // 进入睡眠：energy 极低（rest）且尚未睡眠 → 冻结入睡时心理状态
  if (!sleeping && newBehavior.kind === 'rest' && newEnergy < 20) {
    sleeping = true;
    sleepEntryTrust = state.trust;
    sleepEntryCognitiveLoad = state.cognitiveLoad;
    // 防御度同样必须冻结：睡眠期间它会自然消退，
    // 不冻结会让"带着高防御入睡"的惩罚在几分钟内失效
    sleepEntryDefensiveness = state.defensiveness;
  }
  // 离开睡眠：energy 恢复充足 → 清空入睡快照
  if (sleeping && newEnergy >= 50) {
    sleeping = false;
    sleepEntryTrust = c.TRUST_INITIAL;
    sleepEntryCognitiveLoad = 0;
    sleepEntryDefensiveness = 0;
  }

  // 滞后：rest 状态需 energy 恢复到 50 以上才离开
  if (
    state.lastBehavior.kind === 'rest' &&
    newBehavior.kind !== 'rest' &&
    newEnergy < 50
  ) {
    newBehavior = { kind: 'rest', reason: 'energy_recovering' };
  }

  return {
    ...state,
    energy: newEnergy,
    moodBaseline: newMoodBaseline,
    arousal: newArousal,
    attentionFocus: newAttentionFocus,
    socialHunger: newSocialHunger,
    needValidation: newNeedValidation,
    needNovelty: newNeedNovelty,
    needSecurity: newNeedSecurity,
    defensiveness: newDefensiveness,
    cognitiveLoad: newCognitiveLoad,
    associations: newAssociations,
    interruptionFlag: newInterruptionFlag,
    lastBehavior: newBehavior,
    lastUpdated: event.timestamp,
    uptimeSeconds: newUptime,
    sleeping,
    sleepEntryTrust,
    sleepEntryCognitiveLoad,
    sleepEntryDefensiveness,
  };
}

/**
 * 处理 InterruptionEvent
 *
 * 内感受（Interoception）：
 * - 普通中断：拉高 arousal，置位 interruption_flag
 * - energy 极低时的中断：产生"极度烦躁的唤醒"，直接压低心情
 *   （身体已经疲惫又被打断 → 烦躁）
 *
 * 中断伤痕（Scar）：
 * - 创伤性中断（崩溃/强制断电）写入负向关联记忆
 * - 伤痕记忆持续下拉 mood，直到被 comfort 对话安抚
 */
function applyInterruption(
  state: MarrowState,
  event: InterruptionEvent,
): MarrowState {
  const c = STATE_CONSTANTS;
  const { energyAtInterruption, isTraumatic, reason } = event.payload;

  // 内感受：energy 极低时被中断 → 极度烦躁，心情直接下降
  const energyLow = energyAtInterruption < c.ENERGY_CRITICAL_FOR_MOOD;
  const irritableMoodDrop = energyLow
    ? -(c.ENERGY_CRITICAL_FOR_MOOD - energyAtInterruption) * 0.3
    : 0;

  // 普通中断拉满 arousal；疲惫时 arousal 受限但仍置位中断标志
  const newArousal = energyLow
    ? Math.min(c.AROUSAL_MAX, c.ENERGY_AROUSAL_CAP + 20)
    : c.AROUSAL_MAX;

  let newAssociations = state.associations;
  let newScars = state.interruptionScars;
  let newAssociationWeight = state.associationWeight;
  // 中断会打破安全感：突然被打断 → 不确定发生了什么 → 不安全感上升
  // 创伤性中断（断电/崩溃）更是如此，安全感需求大幅上升
  const newNeedSecurity = clamp(
    state.needSecurity + (isTraumatic ? 35 : 15),
    0,
    100,
  );

  // 创伤性中断 → 写入伤痕记忆
  if (isTraumatic) {
    const scar: AssociationMemory = {
      id: `scar-${event.id}`,
      timestamp: event.timestamp,
      cue: 'power_loss',
      valence: -0.8,
      salience: 0.9,
      source: 'interruption',
      isScar: true,
    };
    newAssociations = [...state.associations, scar];
    newScars = state.interruptionScars + 1;
    // 创伤降低关联权重（变得更难被正向事件影响，类似抑郁倾向）
    newAssociationWeight = Math.max(0.3, state.associationWeight - 0.1);
  }

  const newMoodBaseline = clamp(
    state.moodBaseline + irritableMoodDrop,
    c.MOOD_MIN,
    c.MOOD_MAX,
  );

  return {
    ...state,
    arousal: newArousal,
    moodBaseline: newMoodBaseline,
    interruptionFlag: true,
    associations: newAssociations,
    interruptionScars: newScars,
    associationWeight: newAssociationWeight,
    needSecurity: newNeedSecurity,
    lastBehavior: {
      kind: 'interrupted',
      reason,
    },
    interruptionCount: state.interruptionCount + 1,
    lastUpdated: event.timestamp,
  };
}

/**
 * 处理 EnvironmentEvent
 *
 * 环境事件缓慢调制 mood_baseline，
 * 高显著性事件可能瞬时拉高 arousal。
 */
function applyEnvironment(
  state: MarrowState,
  event: EnvironmentEvent,
): MarrowState {
  const c = STATE_CONSTANTS;
  const { feature, reading, moodDelta, salience } = event.payload;

  // mood_baseline 受环境事件调制
  const newMoodBaseline = clamp(
    state.moodBaseline + moodDelta,
    c.MOOD_MIN,
    c.MOOD_MAX,
  );

  // 高显著性环境事件可能拉高 arousal
  const arousalBoost = salience > 0.7 ? salience * 30 : 0;
  const newArousal = clamp(
    state.arousal + arousalBoost,
    c.AROUSAL_MIN,
    c.AROUSAL_MAX,
  );

  // arousal 超阈值则触发中断
  const newInterruptionFlag =
    state.interruptionFlag || newArousal >= c.AROUSAL_INTERRUPTION_THRESHOLD;

  // 电池电量通过环境事件更新（feature: 'battery'）
  let newBatteryLevel = state.batteryLevel;
  if (feature === 'battery') {
    newBatteryLevel = clamp(reading, 0, 100);
  }

  return {
    ...state,
    moodBaseline: newMoodBaseline,
    arousal: newArousal,
    interruptionFlag: newInterruptionFlag,
    batteryLevel: newBatteryLevel,
    lastUpdated: event.timestamp,
  };
}

/**
 * 处理 DialogueEvent
 *
 * 对话是物理事件，影响 mood_baseline 和 energy，与温度/碰撞同级。
 *
 * 主客观分离：
 * - 事件携带客观事实（action、intensity），由 LLM 提取
 * - appraisal.ts 基于动态状态（associationWeight、trust、defensiveness）计算主观情绪
 * - LLM 不决定情绪效价，状态机决定
 *
 * 语言的真实内耗：
 * - energy 消耗 = 基础 + 强度系数 + 字数系数
 * - attention_focus 调制对话对 mood 的影响权重（注意力不集中时反应弱）
 * - social_hunger 对话后降低（社交被满足）
 * - comfort 对话降低伤痕显著性（被安抚）
 */
function applyDialogue(
  state: MarrowState,
  event: DialogueEvent,
): MarrowState {
  const c = STATE_CONSTANTS;
  const { action, intensity, moodDelta, direction, text, wordCount } = event.payload;
  const charCount = wordCount ?? text.length;

  // 注意力调制：attention_focus 越低，对话对 mood 的影响越弱
  // （走神时听不进去）
  const attentionMod = 0.3 + state.attentionFocus * 0.7; // 0.3 ~ 1.0

  if (direction === 'user_input' && action && intensity !== undefined) {
    // === 记忆唤醒：先检索情景记忆缓冲区（在 appraise 之前） ===
    // 唤醒的记忆 ID 需要传入 AppraisalContext.evidenceAssociationIds，
    // 供 AppraisalEvent 记录证据链。唤醒效果（mood/energy/内耗）仍在下方应用。
    const evoked = evokeMemoryFromText(state.episodicBuffer, text);
    const evidenceAssociationIds = evoked ? [evoked.id] : [];

    const context: AppraisalContext = {
      associationWeight: state.associationWeight,
      trust: state.trust,
      defensiveness: state.defensiveness,
      moodBaseline: state.moodBaseline,
      needValidation: state.needValidation,
      needNovelty: state.needNovelty,
      needSecurity: state.needSecurity,
      traits: state.traits,
      // 旧格式事件没有观察置信度，默认 1.0（完整信任）
      confidence: 1.0,
      evidenceAssociationIds,
    };
    const result = appraise(action, intensity, context);

    // 效价来源（主客观分离的关键衔接）：
    // - 新格式事件（带 observationId）：payload.moodDelta 携带的是写入方
    //   （index.ts）用真实观察置信度算出的 AppraisalResult.valenceDelta，
    //   直接采用——保证实跑状态变化与 AppraisalEvent 证据链完全一致；
    //   result 仍用于 trustDelta / needDeltas（与置信度无关）。
    // - 旧格式事件（无 observationId）：payload.moodDelta 历史上恒为 0，
    //   必须用 appraise 重新计算（confidence=1.0，完整信任）。
    const baseValenceDelta = event.payload.observationId
      ? moodDelta
      : result.valenceDelta;

    // 效价增量受注意力焦点调制
    let weightedMoodDelta = baseValenceDelta * attentionMod;
    // 神经质调制：负面事件的情绪冲击被放大（高神经质）或钝化（低神经质）
    if (weightedMoodDelta < 0) {
      weightedMoodDelta *= state.traits.neuroticism;
    }

    // 正向回忆 → 强制拉高 mood + 恢复 energy（精神一振，无视低体力）
    // 创伤回忆 → 强制拉低 mood + 增加内耗（反刍）
    let memoryMoodDelta = 0;
    let memoryEnergyDelta = 0;
    let memoryCognitiveLoadDelta = 0;
    let evokedSummary: string | null = null;
    if (evoked) {
      memoryMoodDelta = evoked.valence * evoked.salience * c.MEMORY_MOOD_IMPACT;
      if (evoked.valence > 0) {
        memoryEnergyDelta = c.MEMORY_ENERGY_RECOVERY * evoked.salience;
      } else if (evoked.isTrauma) {
        // 创伤记忆唤醒：除拉低心情外，还增加内耗
        memoryCognitiveLoadDelta =
          c.MEMORY_TRAUMA_COGNITIVE_LOAD * evoked.salience;
      }
      evokedSummary = evoked.summary;
    }

    const newMoodBaseline = clamp(
      state.moodBaseline + weightedMoodDelta + memoryMoodDelta,
      c.MOOD_MIN,
      c.MOOD_MAX,
    );

    // 语言能量消耗
    const energyCost =
      c.LANGUAGE_ENERGY_BASE +
      intensity * c.LANGUAGE_ENERGY_INTENSITY_FACTOR +
      charCount * c.LANGUAGE_ENERGY_PER_CHAR;
    const newEnergy = clamp(
      state.energy - energyCost + memoryEnergyDelta,
      c.ENERGY_MIN,
      c.ENERGY_MAX,
    );

    // 信任度演化（替代亲和度，同样受注意力调制）
    const newTrust = clamp(
      state.trust + result.trustDelta * attentionMod,
      c.TRUST_MIN,
      c.TRUST_MAX,
    );

    // 内耗值：创伤记忆唤醒会增加内耗
    const newCognitiveLoad = clamp(
      state.cognitiveLoad + memoryCognitiveLoadDelta,
      c.COGNITIVE_LOAD_MIN,
      c.COGNITIVE_LOAD_MAX,
    );

    // 社交渴望被满足
    const newSocialHunger = clamp(
      state.socialHunger - c.SOCIAL_HUNGER_SATED_PER_DIALOGUE,
      0,
      100,
    );

    // 心理需求更新
    const newNeedValidation = clamp(
      state.needValidation + result.needDeltas.validation,
      0,
      100,
    );
    const newNeedNovelty = clamp(
      state.needNovelty + result.needDeltas.novelty,
      0,
      100,
    );
    const newNeedSecurity = clamp(
      state.needSecurity + result.needDeltas.security,
      0,
      100,
    );

    // comfort 对话：降低伤痕显著性（被安抚，创伤消退）
    let newAssociations = state.associations;
    if (action === 'comfort') {
      newAssociations = state.associations.map((m) =>
        m.isScar ? { ...m, salience: Math.max(0, m.salience - 0.15) } : m,
      );
      // 移除显著性归零的伤痕
      newAssociations = newAssociations.filter(
        (m) => !(m.isScar && m.salience <= 0.001),
      );
    }

    // 显著对话沉淀为新的情景记忆（发育式记忆，缓冲区分层聚合）
    let newEpisodicBuffer = state.episodicBuffer;
    if (
      intensity >= 0.5 &&
      Math.abs(weightedMoodDelta + memoryMoodDelta) >= 1.0
    ) {
      const mem: EpisodicMemory = {
        id: `epi-${event.id}`,
        timestamp: event.timestamp,
        summary: text.slice(0, 40),
        keywords: extractKeywords(text),
        valence: weightedMoodDelta + memoryMoodDelta > 0 ? 0.6 : -0.6,
        salience: intensity,
        sourceEventId: event.id,
        isTrauma: action === 'insult' && intensity >= 0.7,
      };
      if (mem.keywords.length > 0) {
        newEpisodicBuffer = [...state.episodicBuffer, mem];
        // 限制缓冲区大小，溢出时丢弃最旧的
        if (newEpisodicBuffer.length > 50) {
          newEpisodicBuffer = newEpisodicBuffer.slice(-50);
        }
      }
    }

    return {
      ...state,
      moodBaseline: newMoodBaseline,
      energy: newEnergy,
      trust: newTrust,
      cognitiveLoad: newCognitiveLoad,
      socialHunger: newSocialHunger,
      needValidation: newNeedValidation,
      needNovelty: newNeedNovelty,
      needSecurity: newNeedSecurity,
      associations: newAssociations,
      episodicBuffer: newEpisodicBuffer,
      lastEvokedMemory: evokedSummary,
      lastUpdated: event.timestamp,
    };
  }

  // 伴侣输出：消耗 energy（说话是物理行为），与输出长度成正比
  // 不改变自己的 mood
  const companionEnergyCost =
    c.LANGUAGE_ENERGY_BASE * 0.5 + charCount * c.LANGUAGE_ENERGY_PER_CHAR;
  const newEnergy = clamp(
    state.energy - companionEnergyCost,
    c.ENERGY_MIN,
    c.ENERGY_MAX,
  );

  // 旧事件（无 action/intensity）：使用事件自带的 moodDelta
  const newMoodBaseline = clamp(
    state.moodBaseline + moodDelta,
    c.MOOD_MIN,
    c.MOOD_MAX,
  );

  return {
    ...state,
    moodBaseline: newMoodBaseline,
    energy: newEnergy,
    lastUpdated: event.timestamp,
  };
}

/**
 * 根据当前状态推导行为输出（规则映射）
 *
 * 规则：
 * - interruption_flag 为真 → interrupted（恢复期不响应）
 * - energy 极低 → rest（少主动），但 social_hunger 极高时可主动寻求社交
 * - mood_baseline 持续偏低 → quiet（沉静模式）
 * - social_hunger 高 → active（渴望社交，主动行为）
 * - energy > 60 且 mood > 50 → active
 * - 否则 idle
 */
export function deriveBehavior(snapshot: {
  energy: number;
  moodBaseline: number;
  arousal: number;
  interruptionFlag: boolean;
  socialHunger?: number;
}): BehaviorOutput {
  const { energy, moodBaseline, interruptionFlag, socialHunger } = snapshot;

  if (interruptionFlag) {
    return { kind: 'interrupted', reason: 'arousal_above_threshold' };
  }

  // social_hunger 极高时，即使 energy 不高也会主动寻求社交
  // （类似人饿了想找伴说话的冲动）
  if (socialHunger !== undefined && socialHunger > 85 && energy > 10) {
    return { kind: 'active', reason: 'social_hunger_high' };
  }

  if (energy < 20) {
    return { kind: 'rest', reason: 'energy_critical' };
  }

  if (moodBaseline < 30) {
    return { kind: 'quiet', reason: 'mood_baseline_low' };
  }

  // social_hunger 超过阈值时促进主动行为
  if (socialHunger !== undefined && socialHunger > 70 && energy > 30) {
    return { kind: 'active', reason: 'social_hunger_driven' };
  }

  if (energy > 60 && moodBaseline > 50) {
    return { kind: 'active', reason: 'energy_and_mood_good' };
  }

  return { kind: 'idle', reason: 'neutral_state' };
}

/**
 * 状态转移主函数
 *
 * 纯函数：(state, event) => newState
 * 使用判别联合 + exhaustive check，编译期保证所有事件类型都被处理。
 */
export function applyEvent(
  state: MarrowState,
  event: MarrowEvent,
): MarrowState {
  switch (event.type) {
    case 'tick':
      return applyTick(state, event);
    case 'interruption':
      return applyInterruption(state, event);
    case 'environment':
      return applyEnvironment(state, event);
    case 'dialogue':
      return applyDialogue(state, event);
    case 'memory_evocation':
      return applyMemoryEvocation(state, event);
    case 'sleep':
      return applySleep(state, event);
    case 'trait_shift':
      return applyTraitShiftEvent(state, event);
    case 'observation':
      return applyObservation(state, event);
    case 'appraisal':
      return applyAppraisal(state, event);
    default: {
      // 穷尽检查：若新增事件类型未处理，编译期报错
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

/**
 * 处理 MemoryEvocationEvent
 *
 * 记忆唤醒的独立事件处理（用于事件回放）。
 * 当对话触发了情景记忆时，applyDialogue 内联应用效果，
 * 同时可生成 MemoryEvocationEvent 用于事件溯源与回放。
 *
 * 正向回忆：mood 上升 + energy 恢复（精神一振）
 * 负向回忆（创伤）：mood 下降 + 增加内耗（反刍）
 */
function applyMemoryEvocation(
  state: MarrowState,
  event: MemoryEvocationEvent,
): MarrowState {
  const c = STATE_CONSTANTS;
  const { valence, moodDelta, energyDelta, summary } = event.payload;

  const newMoodBaseline = clamp(
    state.moodBaseline + moodDelta,
    c.MOOD_MIN,
    c.MOOD_MAX,
  );
  const newEnergy = clamp(
    state.energy + energyDelta,
    c.ENERGY_MIN,
    c.ENERGY_MAX,
  );
  const newCognitiveLoad = clamp(
    state.cognitiveLoad + (valence < 0 ? c.MEMORY_TRAUMA_COGNITIVE_LOAD : 0),
    c.COGNITIVE_LOAD_MIN,
    c.COGNITIVE_LOAD_MAX,
  );

  return {
    ...state,
    moodBaseline: newMoodBaseline,
    energy: newEnergy,
    cognitiveLoad: newCognitiveLoad,
    lastEvokedMemory: summary,
    lastUpdated: event.timestamp,
  };
}

/**
 * 处理 SleepEvent
 *
 * 睡眠/觉醒的独立事件（用于事件溯源，如电量耗尽的入睡与充电后的醒来）。
 * - 入睡：冻结入睡时的 trust 与 cognitiveLoad（供 tick 判定夜间反刍）
 * - 醒来：结束睡眠，清空入睡快照（夜间反刍已在睡眠期间的 tick 中施加）
 */
function applySleep(state: MarrowState, event: SleepEvent): MarrowState {
  const c = STATE_CONSTANTS;
  if (event.payload.entering) {
    return {
      ...state,
      sleeping: true,
      sleepEntryTrust: state.trust,
      sleepEntryCognitiveLoad: state.cognitiveLoad,
      sleepEntryDefensiveness: state.defensiveness,
      lastUpdated: event.timestamp,
    };
  }
  return {
    ...state,
    sleeping: false,
    sleepEntryTrust: c.TRUST_INITIAL,
    sleepEntryCognitiveLoad: 0,
    sleepEntryDefensiveness: 0,
    lastUpdated: event.timestamp,
  };
}

/**
 * 性格特质漂移的唯一入口
 *
 * Phase 5（记忆聚合）模块通过构造 TraitShiftEvent 并写入事件日志来修改特质，
 * 回放时由 applyTraitShiftEvent 调用本函数应用漂移。
 * 每项特质漂移后 clamp 到 [0.5, 2.0]，纯函数返回新 state。
 * 特质不允许通过其他任何路径修改——保证性格演化的可追溯性。
 */
export function applyTraitShift(
  state: MarrowState,
  shift: Partial<PersonalityTraits>,
): MarrowState {
  const c = STATE_CONSTANTS;
  const t = state.traits;
  return {
    ...state,
    traits: {
      neuroticism: clamp(t.neuroticism + (shift.neuroticism ?? 0), c.TRAIT_MIN, c.TRAIT_MAX),
      agreeableness: clamp(
        t.agreeableness + (shift.agreeableness ?? 0),
        c.TRAIT_MIN,
        c.TRAIT_MAX,
      ),
      extraversion: clamp(
        t.extraversion + (shift.extraversion ?? 0),
        c.TRAIT_MIN,
        c.TRAIT_MAX,
      ),
      resilience: clamp(t.resilience + (shift.resilience ?? 0), c.TRAIT_MIN, c.TRAIT_MAX),
    },
  };
}

/**
 * 处理 ObservationEvent
 *
 * 观察是"纯事实记录"，不直接驱动状态变化——
 * 状态演化由后续的 AppraisalEvent / DialogueEvent 承担。
 * 这里只更新 lastUpdated 时间戳，保持回放时间轴完整。
 */
function applyObservation(
  state: MarrowState,
  event: ObservationEvent,
): MarrowState {
  return { ...state, lastUpdated: event.timestamp };
}

/**
 * 处理 AppraisalEvent
 *
 * 评价事件是"主观感受的证据链记录"：
 * - valenceDelta 不重复应用（mood 变化由 DialogueEvent 应用，
 *   DialogueEvent.moodDelta = AppraisalResult.valenceDelta）
 * - arousalDelta 直接应用到 arousal（clamp 到 [0,100]）
 * - confidence / evidenceAssociationIds 仅作审计记录
 */
function applyAppraisal(
  state: MarrowState,
  event: AppraisalEvent,
): MarrowState {
  const c = STATE_CONSTANTS;
  const newArousal = clamp(
    state.arousal + event.payload.arousalDelta,
    c.AROUSAL_MIN,
    c.AROUSAL_MAX,
  );
  return {
    ...state,
    arousal: newArousal,
    lastUpdated: event.timestamp,
  };
}

/**
 * 处理 TraitShiftEvent
 *
 * 性格特质的永久性微量漂移（Phase 5 记忆聚合写入）。
 * 作为事件写入 append-only 日志 → 回放时特质演化完全可追溯、可复现。
 */
function applyTraitShiftEvent(state: MarrowState, event: TraitShiftEvent): MarrowState {
  const shifted = applyTraitShift(state, event.payload.shift);
  return { ...shifted, lastUpdated: event.timestamp };
}
