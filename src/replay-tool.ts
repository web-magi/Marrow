/**
 * replay-tool.ts — 阶段二：CLI 回放工具
 *
 * 功能：
 * 1. 加载事件日志并重放到指定时间点
 * 2. 定位某个行为输出到其历史状态轨迹
 * 3. 输出状态快照序列，支持人工判断"合理与否"
 *
 * 用法：
 *   node dist/replay-tool.js                    # 重放全部事件，输出摘要
 *   node dist/replay-tool.js --until <ISO>      # 重放到指定时间
 *   node dist/replay-tool.js --behavior <idx>   # 定位第 idx 个行为的历史轨迹
 *   node dist/replay-tool.js --list-behaviors   # 列出所有行为输出
 *   node dist/replay-tool.js --validate         # 验证事件日志完整性
 */

import { parseArgs } from 'node:util';
import { loadEvents, EVENT_LOG_PATH } from './storage.js';
import {
  replayUntil,
  replayWithSnapshots,
  validateEventLog,
} from './replay.js';
import type { MarrowState } from './state.js';

/** 格式化状态为单行字符串 */
function formatStateLine(state: MarrowState, index?: number): string {
  const prefix = index !== undefined ? `[${String(index).padStart(5)}] ` : '';
  const t = new Date(state.lastUpdated).toISOString();
  const energy = state.energy.toFixed(1);
  const mood = state.moodBaseline.toFixed(1);
  const arousal = state.arousal.toFixed(2);
  const behavior = `${state.lastBehavior.kind}(${state.lastBehavior.reason})`;
  return `${prefix}${t} energy=${energy} mood=${mood} arousal=${arousal} behavior=${behavior}`;
}

/** 打印摘要 */
function printSummary(states: MarrowState[]): void {
  if (states.length === 0) {
    console.log('No events to replay.');
    return;
  }

  const first = states[0]!;
  const last = states[states.length - 1]!;
  const behaviorKinds = new Set(states.map((s) => s.lastBehavior.kind));

  console.log('=== Replay Summary ===');
  console.log(`Total events: ${states.length}`);
  console.log(`Time range: ${first.lastUpdated} -> ${last.lastUpdated}`);
  console.log(`Uptime: ${Math.floor(last.uptimeSeconds)}s`);
  console.log(`Interruptions: ${last.interruptionCount}`);
  console.log(`Behavior kinds: ${[...behaviorKinds].join(', ')}`);
  console.log('');
  console.log('First state:');
  console.log('  ' + formatStateLine(first));
  console.log('Last state:');
  console.log('  ' + formatStateLine(last));
}

/** 列出所有行为输出（带索引，方便定位） */
function listBehaviors(states: MarrowState[]): void {
  console.log('=== Behavior Timeline ===');
  let prevBehavior = '';
  states.forEach((state, i) => {
    const behavior = state.lastBehavior.kind;
    if (behavior !== prevBehavior) {
      console.log(formatStateLine(state, i));
      prevBehavior = behavior;
    }
  });
}

/** 定位某个行为的历史轨迹 */
function traceBehavior(states: MarrowState[], targetIndex: number): void {
  if (targetIndex < 0 || targetIndex >= states.length) {
    console.error(`Index out of range: ${targetIndex} (valid: 0-${states.length - 1})`);
    process.exit(1);
  }

  const target = states[targetIndex]!;
  console.log(`=== Trace Behavior at Index ${targetIndex} ===`);
  console.log('');
  console.log('Target state:');
  console.log('  ' + formatStateLine(target));
  console.log('');

  // 显示前 5 个和后 5 个状态，展示行为变化的上下文
  const start = Math.max(0, targetIndex - 5);
  const end = Math.min(states.length, targetIndex + 6);

  console.log(`Context (${start} to ${end - 1}):`);
  for (let i = start; i < end; i++) {
    const marker = i === targetIndex ? ' >>>' : '    ';
    console.log(`${marker}${formatStateLine(states[i]!, i)}`);
  }
}

function main(): void {
  const args = parseArgs({
    options: {
      until: { type: 'string' },
      behavior: { type: 'string' },
      'list-behaviors': { type: 'boolean' },
      validate: { type: 'boolean' },
      full: { type: 'boolean' },
    },
  });

  console.log(`Loading events from: ${EVENT_LOG_PATH}`);
  const events = loadEvents();
  console.log(`Loaded ${events.length} events.`);
  console.log('');

  // 验证模式
  if (args.values.validate) {
    const result = validateEventLog(events);
    if (result.valid) {
      console.log('Event log is valid.');
    } else {
      console.log('Event log has errors:');
      result.errors.forEach((e) => console.log(`  - ${e}`));
    }
    return;
  }

  // 加载状态快照
  const snapshots = replayWithSnapshots(events);
  const states = snapshots.map((s) => s.state);

  if (args.values['list-behaviors']) {
    listBehaviors(states);
    return;
  }

  if (args.values.behavior !== undefined) {
    const idx = parseInt(args.values.behavior, 10);
    if (isNaN(idx)) {
      console.error('Invalid behavior index');
      process.exit(1);
    }
    traceBehavior(states, idx);
    return;
  }

  if (args.values.until) {
    const untilState = replayUntil(events, args.values.until);
    console.log(`State at ${args.values.until}:`);
    console.log('  ' + formatStateLine(untilState));
    return;
  }

  if (args.values.full) {
    // 输出全部状态
    states.forEach((state, i) => {
      console.log(formatStateLine(state, i));
    });
    return;
  }

  // 默认：输出摘要
  printSummary(states);
}

main();
