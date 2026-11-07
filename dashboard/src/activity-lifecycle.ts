/**
 * activity-lifecycle.ts — 请求生命周期的只读前端映射
 *
 * 目的：把「真实对话记录的新增」映射为生命活动核心的视觉阶段，
 *      不新增 Runtime 状态、不写事件、不依赖定时器随机播放。
 *
 * 映射依据（全部为后端已存在的真实数据）：
 *   - /api/dialogue 中新增 direction = 'user_input' 的记录 → received
 *   - /api/dialogue 中新增 direction = 'companion_output' 的记录 → completed
 *     （注意：Runtime 实际写入的枚举是 'companion_output'，不是 'companion'）
 *   - /api/runtime queue.runningChatId 非空或 active > 0 → processing
 *
 * 约束：
 *   - 首次观测只建立基线，历史记录不会被误判为新请求；
 *   - 相同的轮询结果不会重复触发（按 timestamp 去重）；
 *   - 普通 Tick 不属于对话记录，因此不会被当作用户请求；
 *   - 后端未提供请求失败事件与 requestId，故不产生 ERROR 阶段。
 */

export type ActivityPhase = 'idle' | 'received' | 'processing' | 'completed';

export interface DialogueLike {
  direction: string;
  timestamp: string;
}

export interface QueueLike {
  runningChatId?: string | null;
  active?: number;
}

export interface LifecycleObservation {
  kind: 'none' | 'received' | 'completed';
  at: string | null;
}

function lastOf(rows: readonly DialogueLike[], direction: string): DialogueLike | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && row.direction === direction) return row;
  }
  return undefined;
}

export class LifecycleTracker {
  private baselineReady = false;
  private seenUser = '';
  private seenCompanion = '';

  /**
   * 输入最新一轮真实对话列表，返回本轮观测到的生命周期变化。
   * 纯比较逻辑：同样的输入重复传入只会返回 'none'。
   */
  observe(rows: readonly DialogueLike[]): LifecycleObservation {
    if (!Array.isArray(rows) || rows.length === 0) return { kind: 'none', at: null };

    const lastUser = lastOf(rows, 'user_input');
    const lastCompanion = lastOf(rows, 'companion_output');

    if (!this.baselineReady) {
      this.seenUser = lastUser?.timestamp ?? '';
      this.seenCompanion = lastCompanion?.timestamp ?? '';
      this.baselineReady = true;
      return {
        kind: 'none',
        at: lastCompanion?.timestamp ?? lastUser?.timestamp ?? null,
      };
    }

    if (lastUser && lastUser.timestamp !== this.seenUser) {
      this.seenUser = lastUser.timestamp;
      return { kind: 'received', at: lastUser.timestamp };
    }
    if (lastCompanion && lastCompanion.timestamp !== this.seenCompanion) {
      this.seenCompanion = lastCompanion.timestamp;
      return { kind: 'completed', at: lastCompanion.timestamp };
    }
    return { kind: 'none', at: null };
  }

  reset(): void {
    this.baselineReady = false;
    this.seenUser = '';
    this.seenCompanion = '';
  }
}

/**
 * 阶段优先级：短暂动画阶段（received / completed）优先，
 * 其次是 Runtime 真实执行态（processing），最后才是待机。
 */
export function resolveActivityPhase(
  transient: 'received' | 'completed' | null,
  queue: QueueLike | null | undefined,
): ActivityPhase {
  if (transient === 'received') return 'received';
  if (transient === 'completed') return 'completed';
  if (queue && ((queue.runningChatId ?? null) !== null || (queue.active ?? 0) > 0)) return 'processing';
  return 'idle';
}
