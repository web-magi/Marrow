/**
 * appraisal.ts — 评价模块：客观事实与主观情绪的桥梁
 *
 * 核心架构原则：
 * - LLM 只做意图提取（客观事实：action、intensity）
 * - 情绪效价（moodDelta）由本模块基于动态状态计算，不由 LLM 决定
 * - 对话是物理事件，消耗 energy 并影响 mood_baseline
 *
 * 核心公式：
 *   Mood_delta = Action_Value × Association_Weight × Speaker_Affinity
 *
 * 其中：
 * - Action_Value：行为类型的先天效价（-1 ~ +1），常量
 * - Association_Weight：动态关联权重（状态变量，由记忆聚合演化）
 * - Speaker_Affinity：对说话者的信任度 trust（状态变量 0-100，替代亲和度）
 *
 * 注意：不硬编码人格标签。人格从长期的 trust、associationWeight 演化中涌现。
 */

import type { DialogueAction, PersonalityTraits } from './events.js';

/**
 * 行为效价表
 *
 * 每种客观行为类型对应一个先天效价值（-1 ~ +1）。
 * 这不是人格，而是物理世界的"语义重力"——
 * 侮辱天然负向，赞美天然正向，如同碰撞天然拉高 arousal。
 */
export const ACTION_VALUES: Record<DialogueAction, number> = {
  greeting: 0.3,
  farewell: 0.1,
  compliment: 0.8,
  insult: -0.9,
  complaint: -0.5,
  teasing: -0.2,
  question: 0.1,
  statement: 0.0,
  confession: 0.6,
  command: -0.4,
  comfort: 0.7,
  apology: 0.3,
  unknown: 0.0,
};

/** 评价模块需要的动态状态输入 */
export interface AppraisalContext {
  /** 动态关联权重（由记忆聚合演化，初始 1.0） */
  associationWeight: number;
  /** 对说话者的信任度 0-100（替代亲和度） */
  trust: number;
  /** 防御度 0-100（高防御时正向安抚会被削减） */
  defensiveness: number;
  /** 当前 mood_baseline（用于信任度变化的非线性调制与雪中送炭判定） */
  moodBaseline: number;
  /** 被认可/亲密需求 0-100 */
  needValidation: number;
  /** 新鲜感需求 0-100 */
  needNovelty: number;
  /** 安全感需求 0-100 */
  needSecurity: number;
  /**
   * 性格特质（全局底层系数）
   * - agreeableness：反比调制负面行为的信任扣除（宜人性越低，被伤得越狠）
   */
  traits: PersonalityTraits;
}

/** 评价结果 */
export interface AppraisalResult {
  /** 对 mood_baseline 的影响量 */
  moodDelta: number;
  /** 对 energy 的消耗（对话是物理事件） */
  energyCost: number;
  /** 对信任度 trust 的影响量（正行为增、负行为减） */
  trustDelta: number;
  /** 对各心理需求的扣减量（满足时扣减，不满足时可能微增） */
  needDeltas: {
    validation: number;
    novelty: number;
    security: number;
  };
}

/** 单次对话的基础能量消耗 */
const DIALOGUE_BASE_ENERGY_COST = 0.5;

/** 高防御时，正向安抚 moodDelta 的保留比例（削减 80% → 保留 20%） */
const DEFENSIVE_COMFORT_KEEP_RATIO = 0.2;
/** 防御墙阈值：defensiveness 高于此值时，正向安抚被拦截（听不进好话） */
const DEFENSIVENESS_WALL_THRESHOLD = 70;
/**
 * 敷衍解读阈值：defensiveness 高于此值时，正向安抚反被解读为敷衍，
 * 确定性地反转为轻微负向。
 * 注意：不用随机数实现"概率转负"——事件溯源要求回放结果完全一致。
 */
const DEFENSIVENESS_PERFUNCTORY_THRESHOLD = 90;
/** 敷衍解读时的负向强度系数 */
const PERFUNCTORY_REVERSE_RATIO = 0.3;
/** 雪中送炭：被认可需求高阈值 */
const SNOW_CARBON_NEED_THRESHOLD = 80;
/** 雪中送炭：心情低阈值 */
const SNOW_CARBON_MOOD_THRESHOLD = 25;
/** 雪中送炭：额外心情加成 */
const SNOW_CARBON_BONUS = 12;

/**
 * 核心评价函数
 *
 * 纯函数：(action, intensity, context) => AppraisalResult
 *
 * 公式：
 *   moodDelta = Action_Value × intensity × Association_Weight × (trust / 50)
 *
 * trust 归一化为 trust/50：
 * - trust = 50 → 乘数 = 1.0（中性缩放）
 * - trust > 50 → 放大所有情绪影响（信任对方，所以对方的话更有分量）
 * - trust < 50 → 缩小所有情绪影响（不信任对方，所以对方的话影响小）
 *
 * @param action 客观行为类型
 * @param intensity 客观强度 0-1
 * @param context 动态状态上下文
 * @returns 评价结果
 */
export function appraise(
  action: DialogueAction,
  intensity: number,
  context: AppraisalContext,
): AppraisalResult {
  const actionValue = ACTION_VALUES[action] ?? 0;
  const safeIntensity = Math.max(0, Math.min(1, intensity));
  const trustMultiplier = context.trust / 50;

  // === 需求满足度判定 ===
  // 每种行为类型满足/刺激不同的心理需求
  const needSatisfaction = classifyNeedImpact(action, safeIntensity);

  // 需求越高，满足时的加成越大（久旱逢甘霖）
  // 需求越高，被反向刺激时的惩罚越大（伤口撒盐）
  const validationMod = context.needValidation / 50;
  const noveltyMod = context.needNovelty / 50;
  const securityMod = context.needSecurity / 50;

  let needMoodBonus = 0;
  let validationDelta = 0;
  let noveltyDelta = 0;
  let securityDelta = 0;

  // 被认可需求
  if (needSatisfaction.validation === 'satisfy') {
    needMoodBonus += NEED_SATISFACTION_BONUS * validationMod * safeIntensity;
    validationDelta -= NEED_SATISFACTION_AMOUNT * safeIntensity;
  } else if (needSatisfaction.validation === 'stimulate') {
    needMoodBonus -= NEED_STIMULUS_PENALTY * validationMod * safeIntensity;
    validationDelta += NEED_STIMULUS_AMOUNT * safeIntensity;
  }

  // 新鲜感需求
  if (needSatisfaction.novelty === 'satisfy') {
    needMoodBonus += NEED_SATISFACTION_BONUS * noveltyMod * safeIntensity;
    noveltyDelta -= NEED_SATISFACTION_AMOUNT * safeIntensity;
  } else if (needSatisfaction.novelty === 'stimulate') {
    needMoodBonus -= NEED_STIMULUS_PENALTY * noveltyMod * safeIntensity;
    noveltyDelta += NEED_STIMULUS_AMOUNT * safeIntensity;
  }

  // 安全感需求
  if (needSatisfaction.security === 'satisfy') {
    needMoodBonus += NEED_SATISFACTION_BONUS * securityMod * safeIntensity;
    securityDelta -= NEED_SATISFACTION_AMOUNT * safeIntensity;
  } else if (needSatisfaction.security === 'stimulate') {
    needMoodBonus -= NEED_STIMULUS_PENALTY * securityMod * safeIntensity;
    securityDelta += NEED_STIMULUS_AMOUNT * safeIntensity;
  }

  // 核心公式：Mood_delta = Action_Value × Association_Weight × Speaker_Affinity(trust/50)
  let actionMood =
    actionValue * safeIntensity * context.associationWeight * trustMultiplier;

  // === 需求雪中送炭：被认可需求极高 + 心情极低 + 安抚 → 极大正向加成 ===
  const isSoothing =
    action === 'comfort' ||
    action === 'compliment' ||
    action === 'apology' ||
    action === 'confession';
  if (
    isSoothing &&
    context.needValidation > SNOW_CARBON_NEED_THRESHOLD &&
    context.moodBaseline < SNOW_CARBON_MOOD_THRESHOLD
  ) {
    needMoodBonus += SNOW_CARBON_BONUS * safeIntensity;
  }

  let moodDelta = actionMood + needMoodBonus;

  // === 防御墙：拦截正向安抚（听不进好话） ===
  // 作用于总 moodDelta（含需求满足加成与雪中送炭），而非仅 action 分量：
  // 防御姿态下，连"久旱逢甘霖"的安抚也会被挡在墙外。
  if (moodDelta > 0 && context.defensiveness > DEFENSIVENESS_WALL_THRESHOLD) {
    moodDelta *= DEFENSIVE_COMFORT_KEEP_RATIO;
    // 极度防御：好话被解读为敷衍/别有用心，确定性地反转为轻微负向
    if (context.defensiveness > DEFENSIVENESS_PERFUNCTORY_THRESHOLD) {
      moodDelta = -Math.abs(actionValue) * safeIntensity * PERFUNCTORY_REVERSE_RATIO;
    }
  }

  // 能量消耗：基础消耗 + 强度加成
  const energyCost = DIALOGUE_BASE_ENERGY_COST + safeIntensity * 1.5;

  // === 信任度变化 ===
  // 正行为 → trust 上升，负行为 → trust 下降
  // 变化幅度受 mood 调制：mood 高时正反馈更强，mood 低时负反馈更强
  const moodFactor = context.moodBaseline / 50; // 50 → 1.0
  const rawTrustDelta =
    actionValue * safeIntensity * 2 * (actionValue >= 0 ? moodFactor : 2 - moodFactor);
  // 宜人性调制：负面刺激扣除 trust 的幅度反比于 agreeableness
  // （宜人性 0.5 → 双倍扣除；宜人性 2.0 → 减半扣除）
  const trustDelta = clamp(
    rawTrustDelta < 0 ? rawTrustDelta / context.traits.agreeableness : rawTrustDelta,
    -5,
    5,
  );

  return {
    moodDelta,
    energyCost,
    trustDelta,
    needDeltas: {
      validation: validationDelta,
      novelty: noveltyDelta,
      security: securityDelta,
    },
  };
}

/**
 * 需求影响分类
 *
 * 将行为类型映射到对三种心理需求的影响：
 * - 'satisfy'：满足该需求（扣减需求值 + mood 加成）
 * - 'stimulate'：反向刺激该需求（增加需求值 + mood 惩罚）
 * - 'neutral'：无直接影响
 */
type NeedImpact = 'satisfy' | 'stimulate' | 'neutral';

interface NeedImpactMap {
  validation: NeedImpact;
  novelty: NeedImpact;
  security: NeedImpact;
}

function classifyNeedImpact(
  action: DialogueAction,
  _intensity: number,
): NeedImpactMap {
  switch (action) {
    case 'compliment':
    case 'confession':
      // 赞美/表白 → 满足被认可需求
      return { validation: 'satisfy', novelty: 'neutral', security: 'neutral' };
    case 'comfort':
    case 'apology':
      // 安抚/道歉 → 满足安全感需求
      return { validation: 'neutral', novelty: 'neutral', security: 'satisfy' };
    case 'teasing':
    case 'question':
      // 调侃/提问 → 满足新鲜感需求
      return { validation: 'neutral', novelty: 'satisfy', security: 'neutral' };
    case 'insult':
      // 侮辱 → 刺激被认可需求（不被尊重）+ 刺激安全感
      return { validation: 'stimulate', novelty: 'neutral', security: 'stimulate' };
    case 'complaint':
      // 抱怨 → 刺激安全感（对方不满，关系不安）
      return { validation: 'neutral', novelty: 'neutral', security: 'stimulate' };
    case 'command':
      // 命令 → 刺激安全感（失去控制感）+ 刺激被认可（不被尊重）
      return { validation: 'stimulate', novelty: 'neutral', security: 'stimulate' };
    case 'greeting':
    case 'farewell':
    case 'statement':
    default:
      return { validation: 'neutral', novelty: 'neutral', security: 'neutral' };
  }
}

/** 需求满足时的 mood 加成系数 */
const NEED_SATISFACTION_BONUS = 3;
/** 需求被反向刺激时的 mood 惩罚系数 */
const NEED_STIMULUS_PENALTY = 4;
/** 需求满足时扣减的需求量 */
const NEED_SATISFACTION_AMOUNT = 20;
/** 需求被刺激时增加的需求量 */
const NEED_STIMULUS_AMOUNT = 15;

/**
 * 将数值限制在 [min, max] 范围内
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
