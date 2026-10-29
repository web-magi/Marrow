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
} from './events.js';

/** 状态常量 */
export const STATE_CONSTANTS = {
  /** energy 每秒衰减量（正常活动时） */
  ENERGY_DECAY_PER_SECOND: 0.005,
  /** energy 每秒恢复量（rest 状态下，身体自我保护） */
  ENERGY_RECOVERY_PER_SECOND: 0.02,
  /** arousal 每秒衰减系数（指数衰减） */
  AROUSAL_DECAY_FACTOR: 0.95,
  /** arousal 触发中断的阈值 */
  AROUSAL_INTERRUPTION_THRESHOLD: 80,
  /** mood_baseline 每秒漂移幅度（随机游走的步长上限） */
  MOOD_DRIFT_MAX_PER_SECOND: 0.002,
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
 */
export interface MarrowState {
  /** 体力值 0-100 */
  energy: number;
  /** 心境基线 0-100（缓慢漂移） */
  moodBaseline: number;
  /** 唤醒度 0-100（瞬时拉升，指数衰减） */
  arousal: number;
  /** 中断标志：arousal 超阈值时置位，强制改变运行轨迹 */
  interruptionFlag: boolean;
  /** 最后一次行为输出 */
  lastBehavior: BehaviorOutput;
  /** 状态最后更新的时间戳 */
  lastUpdated: string;
  /** 累计运行秒数 */
  uptimeSeconds: number;
  /** 中断发生次数 */
  interruptionCount: number;
}

/** 初始状态 */
export function createInitialState(timestamp: string): MarrowState {
  return {
    energy: 80,
    moodBaseline: 50,
    arousal: 10,
    interruptionFlag: false,
    lastBehavior: { kind: 'idle', reason: 'initial_state' },
    lastUpdated: timestamp,
    uptimeSeconds: 0,
    interruptionCount: 0,
  };
}

/** 将数值限制在 [min, max] 范围内 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 处理 TickEvent
 *
 * - energy 线性衰减
 * - mood_baseline 缓慢随机漂移
 * - arousal 指数衰减
 * - interruption_flag 在 arousal 低于恢复阈值时清除
 */
function applyTick(state: MarrowState, event: TickEvent): MarrowState {
  const delta = event.payload.deltaSeconds;
  const c = STATE_CONSTANTS;

  // energy：正常活动时衰减，rest 状态下自我恢复（身体的自我保护）
  const isResting = state.lastBehavior.kind === 'rest';
  const energyDelta = isResting
    ? c.ENERGY_RECOVERY_PER_SECOND * delta
    : -c.ENERGY_DECAY_PER_SECOND * delta;
  const newEnergy = clamp(
    state.energy + energyDelta,
    c.ENERGY_MIN,
    c.ENERGY_MAX,
  );

  // mood_baseline 缓慢随机漂移
  // 阶段一用简单的随机游走，后续阶段接入记忆聚合调制
  const drift =
    (Math.random() * 2 - 1) * c.MOOD_DRIFT_MAX_PER_SECOND * delta;
  const newMoodBaseline = clamp(
    state.moodBaseline + drift,
    c.MOOD_MIN,
    c.MOOD_MAX,
  );

  // arousal 指数衰减
  const newArousal = clamp(
    state.arousal * Math.pow(c.AROUSAL_DECAY_FACTOR, delta),
    c.AROUSAL_MIN,
    c.AROUSAL_MAX,
  );

  // interruption_flag 恢复逻辑
  const newInterruptionFlag =
    state.interruptionFlag &&
    newArousal > c.INTERRUPTION_RECOVERY_THRESHOLD;

  const newUptime = state.uptimeSeconds + delta;

  // 规则映射行为输出，带滞后机制：
  // - 进入 rest：energy < 20
  // - 离开 rest：energy > 40（需要恢复到一定程度，避免边界振荡）
  let newBehavior = deriveBehavior({
    energy: newEnergy,
    moodBaseline: newMoodBaseline,
    arousal: newArousal,
    interruptionFlag: newInterruptionFlag,
  });

  // 滞后：如果当前在 rest，只有 energy 恢复到 50 以上才离开
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
    interruptionFlag: newInterruptionFlag,
    lastBehavior: newBehavior,
    lastUpdated: event.timestamp,
    uptimeSeconds: newUptime,
  };
}

/**
 * 处理 InterruptionEvent
 *
 * 强制置位 interruption_flag，拉高 arousal。
 * interruption_flag 不能被对话层覆盖。
 */
function applyInterruption(
  state: MarrowState,
  event: InterruptionEvent,
): MarrowState {
  const c = STATE_CONSTANTS;

  return {
    ...state,
    arousal: c.AROUSAL_MAX,
    interruptionFlag: true,
    lastBehavior: {
      kind: 'interrupted',
      reason: event.payload.reason,
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
  const { moodDelta, salience } = event.payload;

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

  return {
    ...state,
    moodBaseline: newMoodBaseline,
    arousal: newArousal,
    interruptionFlag: newInterruptionFlag,
    lastUpdated: event.timestamp,
  };
}

/**
 * 处理 DialogueEvent
 *
 * 阶段一：对话仅影响 mood，不参与决策。
 * 阶段四：LLM 输出候选行为，经状态机过滤后放出。
 */
function applyDialogue(
  state: MarrowState,
  event: DialogueEvent,
): MarrowState {
  const c = STATE_CONSTANTS;
  const { moodDelta } = event.payload;

  const newMoodBaseline = clamp(
    state.moodBaseline + moodDelta,
    c.MOOD_MIN,
    c.MOOD_MAX,
  );

  return {
    ...state,
    moodBaseline: newMoodBaseline,
    lastUpdated: event.timestamp,
  };
}

/**
 * 根据当前状态推导行为输出（规则映射，阶段一）
 *
 * 规则：
 * - interruption_flag 为真 → interrupted（恢复期不响应）
 * - energy 极低 → rest（少主动）
 * - mood_baseline 持续偏低 → quiet（沉静模式）
 * - 否则 active 或 idle
 */
export function deriveBehavior(snapshot: {
  energy: number;
  moodBaseline: number;
  arousal: number;
  interruptionFlag: boolean;
}): BehaviorOutput {
  const { energy, moodBaseline, interruptionFlag } = snapshot;

  if (interruptionFlag) {
    return { kind: 'interrupted', reason: 'arousal_above_threshold' };
  }

  if (energy < 20) {
    return { kind: 'rest', reason: 'energy_critical' };
  }

  if (moodBaseline < 30) {
    return { kind: 'quiet', reason: 'mood_baseline_low' };
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
    default: {
      // 穷尽检查：若新增事件类型未处理，编译期报错
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}
