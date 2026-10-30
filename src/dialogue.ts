/**
 * dialogue.ts — 阶段四：对话处理与行为过滤
 *
 * 对话作为输出通道，而非架构中心。
 * LLM 输出候选行为 → 状态机过滤 → 放出（或拦截）。
 *
 * 核心约束（来自架构决策）：
 * - interruption_flag 不能被对话层覆盖或忽略，必须强制改变运行轨迹
 * - 中断恢复期（interruption_flag=true）时，候选行为被强制拦截
 *
 * 过滤规则（按优先级，前两条短路）：
 * 1. interruption_flag = true → 强制拦截，返回恢复期提示
 * 2. defensiveness > 70 且候选为热情/顺从类 → 替换为冷暴力短句（确定性选取）
 * 3. energy < 20 或 cognitive_load > 80 → 发言限 15 字；内耗过载附加"没有力气说话"指示
 * 4. mood_baseline 持续偏低（quiet） → 回复限长
 * 5. attention_focus < 0.2 → 前缀插入走神表现（舞台指示，不占发言字数）
 */

import type { MarrowState } from './state.js';
import type { DialogueAction } from './events.js';
import { buildStateSnapshot, type CandidateBehavior, type StateSnapshot } from './llm.js';

/** 过滤结果 */
export interface FilterResult {
  /** 最终放出的文本 */
  text: string;
  /** 是否被过滤（true 表示候选行为被修改或拦截） */
  filtered: boolean;
  /** 过滤原因（filtered 为 true 时有值） */
  filterReason: string;
}

/** 恢复期提示（中断时放出，不暴露内部机制） */
const RECOVERY_MESSAGE = '...（正在恢复，请稍候）';

/** 虚脱状态（体力耗尽或内耗过载）下的最大发言字数（舞台指示不计入） */
const EXHAUSTED_MAX_LENGTH = 15;

/** quiet 状态下的最大回复长度 */
const QUIET_MAX_LENGTH = 24;

/** 触发冷暴力替换的防御度阈值（与 appraisal 的防御墙阈值对齐） */
const DEFENSIVE_COLD_THRESHOLD = 70;

/** 触发"没有力气说话"前缀的内耗阈值 */
const NUMB_COGNITIVE_LOAD_THRESHOLD = 80;

/** 触发走神插入的注意力阈值（attention_focus 域为 0-1） */
const WANDER_ATTENTION_THRESHOLD = 0.2;

/** 走神前缀（舞台指示，不占发言字数） */
const WANDER_PREFIX = '……你刚才说什么？（愣了一下）';

/** 内耗过载前缀（舞台指示） */
const NUMB_PREFIX = '（没有力气说话）';

/**
 * 高防御时的冷暴力回复表。
 * 选取必须确定性（用候选文本长度取模），不允许随机数——
 * 事件溯源要求回放结果与实跑完全一致。
 */
const COLD_REPLIES = ['哦', '随便你', '嗯', '知道了', '你说是就是吧'] as const;

/** 会被防御墙视为"热情/顺从"而拦截的行为类型 */
const WARM_ACTIONS: ReadonlySet<DialogueAction> = new Set([
  'compliment',
  'comfort',
  'confession',
  'apology',
  'greeting',
]);

/**
 * 行为过滤函数
 *
 * 纯函数：(state, candidate) => FilterResult
 * 状态机决定候选行为是否放出，LLM 不能绕过。
 *
 * @param state 当前状态
 * @param candidate LLM 输出的候选行为
 * @returns 过滤结果
 */
export function filterCandidateBehavior(
  state: MarrowState,
  candidate: CandidateBehavior,
): FilterResult {
  // 规则 1：中断恢复期 → 强制拦截
  // interruption_flag 是硬约束，对话层无法覆盖
  if (state.interruptionFlag) {
    return {
      text: RECOVERY_MESSAGE,
      filtered: true,
      filterReason: 'interruption_flag_set',
    };
  }

  // 规则 2：高防御 → 热情/顺从回复被替换为冷暴力短句（短路，不再叠加其他修饰）
  // 防御姿态下任何示好都被视为别有用心；选取确定性（长度取模），保证回放一致
  if (state.defensiveness > DEFENSIVE_COLD_THRESHOLD && WARM_ACTIONS.has(candidate.action)) {
    return {
      text: COLD_REPLIES[candidate.text.length % COLD_REPLIES.length] ?? '哦',
      filtered: true,
      filterReason: 'defensive_cold_shoulder',
    };
  }

  let text = candidate.text;
  let filtered = false;
  let filterReason = '';

  // 规则 3：虚脱（体力耗尽或内耗过载）→ 发言限 15 字
  // 内耗过载时附加"没有力气说话"的舞台指示（括号指示不占发言字数）
  if (state.energy < 20 || state.cognitiveLoad > NUMB_COGNITIVE_LOAD_THRESHOLD) {
    const truncated = truncate(text, EXHAUSTED_MAX_LENGTH);
    if (state.cognitiveLoad > NUMB_COGNITIVE_LOAD_THRESHOLD) {
      text = NUMB_PREFIX + truncated;
      filtered = true;
      filterReason = 'cognitive_overload_numb';
    } else {
      text = truncated;
      if (truncated !== candidate.text) {
        filtered = true;
        filterReason = 'energy_too_low';
      }
    }
  } else if (state.moodBaseline < 30) {
    // 规则 4：心境持续偏低（quiet）→ 回复限长
    const truncated = truncate(text, QUIET_MAX_LENGTH);
    text = truncated;
    if (truncated !== candidate.text) {
      filtered = true;
      filterReason = 'mood_baseline_low';
    }
  }

  // 规则 5（最后叠加）：注意力极度涣散 → 前缀插入走神表现
  // 放在限长之后：走神是无意识的舞台指示，不应被字数硬约束截断
  if (state.attentionFocus < WANDER_ATTENTION_THRESHOLD) {
    text = WANDER_PREFIX + text;
    filtered = true;
    filterReason = filterReason ? `${filterReason}+attention_wander` : 'attention_wander';
  }

  return { text, filtered, filterReason };
}

/**
 * 截断文本到指定长度（按字符数，保留省略号）
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

/**
 * 构建状态快照（委托给 llm.ts，保持单一数据源）
 */
export function getStateSnapshot(state: MarrowState): StateSnapshot {
  return buildStateSnapshot(state);
}
