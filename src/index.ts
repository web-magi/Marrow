/**
 * index.ts — 阶段一运行入口
 *
 * 最小状态机：不接 LLM、不接传感器。
 * 每 10 秒 tick，energy 衰减、mood_baseline 漂移、arousal 衰减。
 * 规则映射输出行为风格。
 *
 * 验收：连续运行 24 小时，无对话输入下产生可观察的行为风格变化。
 */

import { createInitialState, applyEvent, type MarrowState } from './state.js';
import type { TickEvent } from './events.js';
import { replay } from './replay.js';
import { appendEvent, loadEvents, generateEventId } from './storage.js';

/** tick 间隔（毫秒） */
const TICK_INTERVAL_MS = 10_000;

/** 格式化状态输出 */
function formatState(state: MarrowState): string {
  const energy = state.energy.toFixed(1);
  const mood = state.moodBaseline.toFixed(1);
  const arousal = state.arousal.toFixed(1);
  const uptime = Math.floor(state.uptimeSeconds);
  const interruptions = state.interruptionCount;
  const behavior = state.lastBehavior.kind;
  const reason = state.lastBehavior.reason;

  return (
    `[${new Date(state.lastUpdated).toISOString()}] ` +
    `energy=${energy} mood=${mood} arousal=${arousal} ` +
    `uptime=${uptime}s interruptions=${interruptions} ` +
    `behavior=${behavior}(${reason})`
  );
}

/**
 * 创建一个 tick 事件
 */
function createTickEvent(deltaSeconds: number): TickEvent {
  return {
    type: 'tick',
    id: generateEventId(),
    timestamp: new Date().toISOString(),
    payload: { deltaSeconds },
  };
}

/**
 * 主运行循环
 *
 * 1. 加载已有事件日志，重放得到当前状态
 * 2. 每 10 秒产生 tick 事件
 * 3. 应用事件，输出状态，持久化
 */
async function main(): Promise<void> {
  console.log('=== Marrow Phase 1: Minimal State Machine ===');
  console.log(`Tick interval: ${TICK_INTERVAL_MS}ms`);
  console.log('Press Ctrl+C to stop.\n');

  // 加载已有事件并重放
  const existingEvents = loadEvents();
  let state: MarrowState;

  if (existingEvents.length > 0) {
    console.log(`Loaded ${existingEvents.length} existing events, replaying...`);
    state = replay(existingEvents);
    console.log(`State restored. Uptime: ${Math.floor(state.uptimeSeconds)}s\n`);
  } else {
    console.log('No existing events. Starting fresh.\n');
    state = createInitialState(new Date().toISOString());
  }

  console.log(formatState(state));

  let lastTickTime = Date.now();
  let tickCount = 0;

  const interval = setInterval(() => {
    const now = Date.now();
    const deltaSeconds = (now - lastTickTime) / 1000;
    lastTickTime = now;

    const tickEvent = createTickEvent(deltaSeconds);
    appendEvent(tickEvent);

    state = applyEvent(state, tickEvent);
    tickCount++;

    // 每 6 次 tick（约 1 分钟）输出一次状态，避免刷屏
    if (tickCount % 6 === 0) {
      console.log(formatState(state));
    }

    // 每小时输出一次汇总
    if (tickCount % 360 === 0) {
      const hours = (state.uptimeSeconds / 3600).toFixed(2);
      console.log(`\n--- ${hours}h checkpoint ---`);
      console.log(formatState(state));
      console.log('------------------------\n');
    }
  }, TICK_INTERVAL_MS);

  // 优雅关闭
  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    clearInterval(interval);
    console.log(`Final state: ${formatState(state)}`);
    console.log(`Total ticks: ${tickCount}`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
