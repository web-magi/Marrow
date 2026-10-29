/**
 * storage.ts — 事件日志持久化
 *
 * 阶段一：简单的 JSON 文件追加写入。
 * 后续阶段可替换为更高效的存储（如 SQLite、专用事件存储）。
 *
 * 设计原则：
 * - append-only，只追加不修改
 * - 每个事件一行（JSONL 格式），便于流式读取
 * - 崩溃安全：写入后立即 flush
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventLog, MarrowEvent } from './events.js';

/** 事件日志文件路径 */
export const EVENT_LOG_PATH = join(process.cwd(), 'data', 'events.jsonl');

/**
 * 确保数据目录存在
 */
function ensureDataDir(): void {
  const dir = dirname(EVENT_LOG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 追加一个事件到日志文件
 *
 * @param event 要追加的事件
 */
export function appendEvent(event: MarrowEvent): void {
  ensureDataDir();
  const line = JSON.stringify(event) + '\n';
  appendFileSync(EVENT_LOG_PATH, line, 'utf-8');
}

/**
 * 从日志文件加载所有事件
 *
 * @returns 事件日志
 */
export function loadEvents(): EventLog {
  if (!existsSync(EVENT_LOG_PATH)) {
    return [];
  }

  const content = readFileSync(EVENT_LOG_PATH, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');

  return lines.map((line) => JSON.parse(line) as MarrowEvent);
}

/**
 * 生成事件唯一 ID
 *
 * 格式：timestamp-random
 */
export function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
