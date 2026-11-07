/**
 * dialogue-context.ts — M1.4.5 对话上下文连续性
 *
 * 职责（只做组装，不引入记忆/回放语义）：
 * - 从 EventStore 的 dialogue 事件中恢复最近 N 轮真实对话（user / companion_output）
 * - 组装为 LLM messages 所需的 user / assistant 顺序
 * - 将 Runtime 本轮真实唤起的情景记忆映射为只读上下文
 *
 * 约束：
 * - 只读：不写事件、不改 EventStore、不影响 Replay
 * - 内部事件（observation / appraisal / tick / memory_formation / environment）
 *   一律不进入历史
 * - 历史不完整时安全降级（丢弃孤立 assistant、未配对的 user、空文本），
 *   绝不拼接错位对话
 */

import type { MarrowEvent } from './events.js';
import type { EpisodicMemory } from './events.js';
import { queryEventRows, type QueryEventRowsOptions } from './storage.js';
import type {
  DialogueHistoryMessage,
  EvokedMemoryContext,
  LlmDialogueContext,
} from './llm.js';

/** 最多注入的历史轮数（一轮 = user + companion） */
export const MAX_HISTORY_TURNS = 4;

/** 单条历史消息最大字符数 */
export const MAX_HISTORY_MESSAGE_CHARS = 80;

/** 历史消息合计最大字符数（超出时丢弃最旧的轮次） */
export const MAX_HISTORY_TOTAL_CHARS = 480;

/** 记忆摘要最大字符数 */
export const MAX_MEMORY_SUMMARY_CHARS = 80;

/** 记忆关键词最大个数 */
export const MAX_MEMORY_KEYWORDS = 6;

/**
 * 单个记忆关键词最大字符数
 *
 * 关键词来自用户原话（按标点切分，单段可能很长），只在 LLM 上下文展示层
 * 截断，不修改 EpisodicMemory 存储结构，也不影响记忆形成时的提取规则。
 */
export const MAX_MEMORY_KEYWORD_CHARS = 16;

/**
 * 查询上限：一轮 2 条事件，额外预留余量以吸收孤立/未配对事件。
 * 具体保留几轮由 assembleDialogueHistory 决定。
 */
export const HISTORY_QUERY_LIMIT = 12;

/** 截断文本（按字符数，保留省略号） */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

/** 一组完整对话轮次（内部结构，展开后才是 messages 序列） */
interface DialogueTurn {
  user: string;
  assistant: string;
}

/**
 * 将按事件顺序（sequence 升序）排列的事件组装为最近 N 轮对话。
 *
 * 配对规则（安全降级）：
 * - user_input 开启一轮，紧随其后的 companion_output 才完成这一轮；
 * - 孤立的 companion_output（没有前置 user）丢弃；
 * - 连续两条 user_input：前一条没有回复，丢弃，以最新一条为准；
 * - 尾部未配对的 user_input（尚未产生回复）丢弃；
 * - 任一侧文本为空则整轮丢弃。
 *
 * 预算：单条截断到 MAX_HISTORY_MESSAGE_CHARS，
 * 合计超过 MAX_HISTORY_TOTAL_CHARS 时从最旧轮次开始丢弃。
 *
 * @param events 按 sequence 升序（调用方负责反转 DESC 查询结果）
 * @returns 按时间顺序展开的 user / assistant 消息序列
 */
export function assembleDialogueHistory(
  events: ReadonlyArray<MarrowEvent>,
): DialogueHistoryMessage[] {
  const turns: DialogueTurn[] = [];
  let pendingUser: string | null = null;

  for (const event of events) {
    // 只接受对话事件：observation / appraisal / tick 等内部事件全部跳过
    if (event.type !== 'dialogue') continue;

    const { direction, text } = event.payload;
    const normalized = text.trim();

    if (direction === 'user_input') {
      pendingUser = normalized.length > 0 ? normalized : null;
      continue;
    }

    if (direction === 'companion_output') {
      // 没有可配对的 user，或本轮有任一侧为空 → 整轮丢弃
      if (pendingUser === null || normalized.length === 0) {
        pendingUser = null;
        continue;
      }
      turns.push({ user: pendingUser, assistant: normalized });
      pendingUser = null;
    }
  }

  // 只保留最近的 N 轮
  const recent = turns.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    user: truncateText(turn.user, MAX_HISTORY_MESSAGE_CHARS),
    assistant: truncateText(turn.assistant, MAX_HISTORY_MESSAGE_CHARS),
  }));

  // 总字符预算：从最旧轮次开始丢弃
  let totalChars = recent.reduce(
    (sum, turn) => sum + turn.user.length + turn.assistant.length,
    0,
  );
  while (recent.length > 0 && totalChars > MAX_HISTORY_TOTAL_CHARS) {
    const dropped = recent.shift();
    if (!dropped) break;
    totalChars -= dropped.user.length + dropped.assistant.length;
  }

  // 展开为 LLM 需要的 user / assistant 顺序
  return recent.flatMap((turn) => [
    { role: 'user' as const, text: turn.user },
    { role: 'assistant' as const, text: turn.assistant },
  ]);
}

/**
 * 将 Runtime 本轮真实唤起的记忆映射为只读上下文。
 *
 * 只做字段提取与截断，绝不修改原记忆，也绝不补充/推测任何内容。
 * 未唤起（null）时返回 null —— 调用方据此完全不注入记忆上下文。
 */
export function buildEvokedMemoryContext(
  memory: EpisodicMemory | null,
): EvokedMemoryContext | null {
  if (!memory) return null;

  const summary = truncateText(memory.summary.trim(), MAX_MEMORY_SUMMARY_CHARS);
  if (summary.length === 0) return null;

  return {
    summary,
    timestamp: memory.timestamp,
    keywords: memory.keywords
      .map((keyword) => truncateText(keyword.trim(), MAX_MEMORY_KEYWORD_CHARS))
      .filter((keyword) => keyword.length > 0)
      .slice(0, MAX_MEMORY_KEYWORDS),
    valence: memory.valence,
    salience: memory.salience,
  };
}

/** 可注入的只读查询（测试可替换；默认走 EventStore） */
type DialogueQuery = (
  identityId: string,
  options: QueryEventRowsOptions,
) => Promise<Array<{ payload: MarrowEvent }>>;

const defaultDialogueQuery: DialogueQuery = (identityId, options) =>
  queryEventRows(identityId, options);

/**
 * 从 EventStore 读取最近对话并组装上下文。
 *
 * 查询路径：queryEventRows(type='dialogue', limit=12) → sequence DESC
 * → 反转为事件顺序 → assembleDialogueHistory。
 *
 * 任何读取失败都安全降级为「无历史」，绝不让上下文问题阻断对话主流程。
 */
export async function loadRecentDialogueHistory(
  identityId: string,
  query: DialogueQuery = defaultDialogueQuery,
): Promise<DialogueHistoryMessage[]> {
  try {
    const rows = await query(identityId, {
      type: 'dialogue',
      limit: HISTORY_QUERY_LIMIT,
    });
    // 查询按 sequence DESC，这里反转回事件顺序（不可按时间戳排序：
    // 同一批次内多条事件的时间戳可能完全相同）
    const chronological = [...rows].reverse().map((row) => row.payload);
    return assembleDialogueHistory(chronological);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[DialogueContext] 历史读取失败，降级为无历史: ${message}`);
    return [];
  }
}

/** 组装完整 LLM 上下文（历史 + 本轮唤起记忆） */
export function buildDialogueContext(
  history: DialogueHistoryMessage[],
  memory: EpisodicMemory | null,
): LlmDialogueContext {
  return {
    history,
    evokedMemory: buildEvokedMemoryContext(memory),
  };
}
