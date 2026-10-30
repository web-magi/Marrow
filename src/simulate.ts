/**
 * simulate.ts — 快速模拟 24 小时运行
 *
 * 用于阶段一验收：验证无对话输入下行为风格会变化。
 * 不需要真的等 24 小时，直接生成 24h 的 tick 事件并重放。
 */

import { createInitialState, applyEvent, type MarrowState } from './state.js';
import type { TickEvent } from './events.js';
import { generateEventId, appendEvent } from './storage.js';
import { parseArgs } from 'node:util';

/** 模拟时长（秒） */
const SIMULATION_SECONDS = 24 * 60 * 60; // 24 小时

/** tick 间隔（秒） */
const TICK_SECONDS = 10;

function createTickEvent(
  timestamp: string,
  deltaSeconds: number,
): TickEvent {
  return {
    type: 'tick',
    id: generateEventId(),
    timestamp,
    payload: { deltaSeconds },
  };
}

function formatState(state: MarrowState): string {
  const hours = (state.uptimeSeconds / 3600).toFixed(1);
  return (
    `t=${hours}h ` +
    `energy=${state.energy.toFixed(1)} ` +
    `mood=${state.moodBaseline.toFixed(1)} ` +
    `arousal=${state.arousal.toFixed(2)} ` +
    `behavior=${state.lastBehavior.kind}(${state.lastBehavior.reason})`
  );
}

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      write: { type: 'boolean' },
    },
  });
  const writeToLog = args.values.write === true;

  console.log('=== Marrow Phase 1: 24h Simulation ===\n');

  // M1.2：模拟数据写入独立身份 marrow-sim，与正式身份 marrow-primary 隔离。
  // 绝不触碰 V1 JSONL 归档（原 writeFileSync 清空逻辑已移除）。
  if (writeToLog) {
    console.log('Writing events to PostgreSQL (identity: marrow-sim)...');
  }

  const startTime = new Date();
  let state = createInitialState(startTime.toISOString());

  const totalTicks = Math.floor(SIMULATION_SECONDS / TICK_SECONDS);
  const behaviors = new Map<string, number>();
  let prevBehavior = state.lastBehavior.kind;
  let behaviorChanges = 0;

  console.log('Initial:', formatState(state));
  console.log('');

  for (let i = 0; i < totalTicks; i++) {
    const timestamp = new Date(
      startTime.getTime() + (i + 1) * TICK_SECONDS * 1000,
    ).toISOString();

    const event = createTickEvent(timestamp, TICK_SECONDS);
    if (writeToLog) {
      await appendEvent(event, { identityId: 'marrow-sim' });
    }
    state = applyEvent(state, event);

    // 统计行为
    const behaviorKind = state.lastBehavior.kind;
    behaviors.set(behaviorKind, (behaviors.get(behaviorKind) ?? 0) + 1);

    if (behaviorKind !== prevBehavior) {
      behaviorChanges++;
      prevBehavior = behaviorKind;
    }

    // 每小时输出一次
    if ((i + 1) % 360 === 0) {
      console.log(formatState(state));
    }
  }

  console.log('\n=== Simulation Results ===');
  console.log(`Total ticks: ${totalTicks}`);
  console.log(`Behavior changes: ${behaviorChanges}`);
  console.log('\nBehavior distribution:');
  for (const [kind, count] of behaviors) {
    const pct = ((count / totalTicks) * 100).toFixed(1);
    console.log(`  ${kind}: ${count} ticks (${pct}%)`);
  }

  console.log('\nFinal state:');
  console.log(formatState(state));

  // 验收判断
  const hasVariety = behaviors.size > 1;
  const hasChanges = behaviorChanges > 0;
  console.log(
    `\nAcceptance: ${hasVariety && hasChanges ? 'PASS' : 'FAIL'} ` +
      `(behavior variety=${hasVariety}, changes=${hasChanges})`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
