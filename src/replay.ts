/**
 * replay.ts — 从事件日志重建状态
 *
 * 事件溯源的核心：状态不是快照，而是事件流的折叠结果。
 * 重启时重放所有事件，得到当前状态。
 *
 * 关键：
 * - 中断事件必须被显式消费（不能跳过）
 * - 重放是纯函数，可重复执行
 * - 支持从任意时间点重放（用于调试和可视化）
 */

import type { EventLog, MarrowEvent } from './events.js';
import { applyEvent, createInitialState, type MarrowState } from './state.js';

/**
 * 从事件日志重建状态
 *
 * @param events 事件日志（按时间顺序）
 * @returns 重放后的最终状态
 */
export function replay(events: EventLog): MarrowState {
  if (events.length === 0) {
    throw new Error('Cannot replay empty event log');
  }

  // 用第一个事件的时间戳作为初始状态时间
  const firstEvent = events[0];
  if (!firstEvent) {
    throw new Error('First event is undefined');
  }

  let state = createInitialState(firstEvent.timestamp);

  for (const event of events) {
    state = applyEvent(state, event);
  }

  return state;
}

/**
 * 从事件日志重建状态，直到指定时间点
 *
 * 用于回放工具：定位一个行为到其历史状态轨迹。
 *
 * @param events 事件日志
 * @param untilTimestamp 重放到此时间戳为止（含）
 */
export function replayUntil(
  events: EventLog,
  untilTimestamp: string,
): MarrowState {
  const filtered = events.filter((e) => e.timestamp <= untilTimestamp);
  return replay(filtered);
}

/**
 * 逐步重放，返回每个事件后的状态快照
 *
 * 用于可视化：在时间轴上标注行为输出。
 *
 * @param events 事件日志
 * @returns 状态快照数组（与事件一一对应）
 */
export function replayWithSnapshots(
  events: EventLog,
): Array<{ event: MarrowEvent; state: MarrowState }> {
  if (events.length === 0) {
    return [];
  }

  const firstEvent = events[0];
  if (!firstEvent) {
    return [];
  }

  let state = createInitialState(firstEvent.timestamp);
  const snapshots: Array<{ event: MarrowEvent; state: MarrowState }> = [];

  for (const event of events) {
    state = applyEvent(state, event);
    snapshots.push({ event, state });
  }

  return snapshots;
}

/**
 * 统计中断事件
 *
 * 中断记忆的衰减速率是开放问题，这里先做基础统计。
 */
export function countInterruptions(events: EventLog): number {
  return events.filter((e) => e.type === 'interruption').length;
}

/**
 * 验证事件日志的完整性
 *
 * - 按时间戳排序检查
 * - 事件 ID 唯一性检查
 */
export function validateEventLog(events: EventLog): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;

    // ID 唯一性
    if (seenIds.has(event.id)) {
      errors.push(`Duplicate event ID at index ${i}: ${event.id}`);
    }
    seenIds.add(event.id);

    // 时间顺序
    if (i > 0) {
      const prev = events[i - 1];
      if (prev && event.timestamp < prev.timestamp) {
        errors.push(
          `Event out of order at index ${i}: ${event.timestamp} < ${prev.timestamp}`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
