/**
 * tick.ts — tick 批次的构建与原子持久化（M1.2.2.1 / M1.2.2.2-A）
 *
 * 把「生成事件 → 在本地状态上模拟 → 单事务批量写入 → 成功后发布」
 * 从 index.ts 中抽出，使这条关键链路可以直接用真实 PostgreSQL 测试，
 * 包括在指定子步注入插入失败的场景。
 *
 * 核心保证：
 * - 整轮 tick 的所有事件在同一个事务中写入（appendEvents）
 * - 只有事务提交成功后才推进 state / lastTickTime / tickCount
 * - 任意一条事件写入失败 → 整批回滚，会话状态原样保留，下一轮 tick
 *   会自然补偿这段失败的时间差
 *
 * M1.2.2.2-A 观测确认：
 * - 传感器读数先进入 ObservationInbox，事件 ID / observedAt / eventTimestamp
 *   在首次读取时冻结
 * - 失败重试复用同一观测，不重新读取传感器，不改变事件 ID / 时间戳
 * - 恢复批次把待确认观测放在最前（按冻结的事件时间排序），保证事件时间轴单调
 * - 只有持久化成功后才 confirm；非碰撞运动读数无事件、无状态影响，立即确认
 */

import { applyEvent, type MarrowState } from './state.js';
import type {
  MarrowEvent,
  TickEvent,
  EnvironmentEvent,
  InterruptionEvent,
  SleepEvent,
} from './events.js';
import type {
  SensorProvider,
  BatteryReading,
  MotionReading,
  EnvironmentReading,
} from './sensors.js';
import { appendEvents, generateEventId } from './storage.js';
import type {
  ObservationInbox,
  ObservationKind,
  PendingObservation,
} from './observation.js';

/** tick 运行时会话（只有批量事务成功后才允许推进） */
export interface TickSession {
  state: MarrowState;
  /** 上一次成功提交的 tick 的真实时间（毫秒） */
  lastTickTime: number;
  tickCount: number;
}

/** 一轮 tick 的完整批次 */
export interface TickBatch {
  /** 本轮完整事件列表（按哈希链顺序） */
  events: MarrowEvent[];
  /** 本地模拟后的最终状态 */
  nextState: MarrowState;
  /** 每个子步/事件应用后的状态快照（供历史曲线） */
  snapshots: MarrowState[];
  /** 成功提交后才应输出的日志 */
  notices: string[];
  /** 本轮覆盖的真实时间（秒） */
  realDeltaSeconds: number;
  /** 持久化成功后需要确认的观测 ID（按观测 ID 精确确认） */
  observationIdsToConfirm: string[];
}

/** 子步进上限：把大 delta 拆成多个 ≤10 秒的小步 */
const SUB_STEP_SECONDS = 10;

function createTickEvent(deltaSeconds: number): TickEvent {
  return {
    type: 'tick',
    id: generateEventId(),
    timestamp: new Date().toISOString(),
    payload: { deltaSeconds },
  };
}

/**
 * 构建一轮 tick 的完整事件批次与状态快照（纯内存，不写库）。
 *
 * 正常路径的事件顺序与 M1.2.2.1 完全一致：
 *   子步 tick → 电池（含唤醒/断电入睡）→ 碰撞中断 → 环境
 *
 * 恢复路径（存在未确认观测）：
 *   待确认观测按冻结的 event.timestamp 升序放在最前，然后才是本轮子步 tick，
 *   本轮新读取的观测仍留在自然位置。
 *   这样既保持事件时间轴单调，也保证待恢复观测不会排在更晚的提交之后。
 */
export async function buildTickBatch(
  session: TickSession,
  sensors: SensorProvider,
  inbox: ObservationInbox,
  now: number,
  timeScale: number,
): Promise<TickBatch> {
  const realDeltaSeconds = (now - session.lastTickTime) / 1000;

  // 应用时间缩放因子：真实时间 × 缩放 = 模拟时间
  const totalDeltaSeconds = realDeltaSeconds * timeScale;

  // 子步进：保证 arousal 指数衰减、mood 随机游走等过程的数值精度
  const numSubSteps = Math.max(1, Math.ceil(totalDeltaSeconds / SUB_STEP_SECONDS));
  const subStepDelta = totalDeltaSeconds / numSubSteps;

  let nextState = session.state;
  const events: MarrowEvent[] = [];
  const snapshots: MarrowState[] = [];
  const notices: string[] = [];
  const observationIdsToConfirm: string[] = [];

  const apply = (event: MarrowEvent): void => {
    events.push(event);
    nextState = applyEvent(nextState, event);
    snapshots.push(nextState);
  };

  /** 电池观测 → 电量事件 + 唤醒 / 断电入睡派生事件（时间戳与观测一致） */
  const applyBatteryObservation = (
    observation: PendingObservation<BatteryReading>,
  ): void => {
    const battery = observation.reading;
    const batteryEvent: EnvironmentEvent = {
      type: 'environment',
      id: observation.id,
      timestamp: observation.eventTimestamp,
      payload: {
        feature: 'battery',
        reading: battery.level,
        moodDelta: 0,
        salience: battery.level < 20 ? 0.8 : 0.1,
        observedAt: observation.observedAt,
      },
    };
    apply(batteryEvent);
    observationIdsToConfirm.push(observation.id);

    // 电池恢复 → 唤醒（结束睡眠/夜间反刍）
    if (battery.level >= 20 && nextState.sleeping) {
      const wakeEvent: SleepEvent = {
        type: 'sleep',
        id: generateEventId(),
        // 派生事件复用观测时间：恢复批次中不会排到更晚的观测之后
        timestamp: observation.eventTimestamp,
        payload: { entering: false, reason: 'battery_recovered' },
      };
      apply(wakeEvent);
      notices.push('[SLEEP] battery recovered, waking up');
    }

    // 电池耗尽 → 触发休眠中断（创伤性：断电=被抛弃）
    if (battery.level < 2 && nextState.lastBehavior.kind !== 'interrupted') {
      const sleepInterruption: InterruptionEvent = {
        type: 'interruption',
        id: generateEventId(),
        timestamp: observation.eventTimestamp,
        payload: {
          reason: `battery_depleted: level ${battery.level.toFixed(1)}%, entering sleep`,
          energyAtInterruption: nextState.energy,
          moodBaselineAtInterruption: nextState.moodBaseline,
          arousalAtInterruption: nextState.arousal,
          lastBehavior: nextState.lastBehavior.kind,
          isTraumatic: true,
          observedAt: observation.observedAt,
        },
      };
      apply(sleepInterruption);

      // 入睡事件：冻结入睡时的信任度与内耗（供夜间反刍判定）
      const sleepOnset: SleepEvent = {
        type: 'sleep',
        id: generateEventId(),
        timestamp: observation.eventTimestamp,
        payload: { entering: true, reason: 'battery_depleted' },
      };
      apply(sleepOnset);
      notices.push('[INTERRUPTION] battery depleted, entering sleep');
    }
  };

  /** 运动观测 → 碰撞中断（仅 collision=true 时产生事件） */
  const applyMotionObservation = (
    observation: PendingObservation<MotionReading>,
  ): void => {
    const motion = observation.reading;
    const collisionInterruption: InterruptionEvent = {
      type: 'interruption',
      id: observation.id,
      timestamp: observation.eventTimestamp,
      payload: {
        reason: `collision: acceleration ${motion.magnitude.toFixed(1)} m/s² exceeded threshold`,
        energyAtInterruption: nextState.energy,
        moodBaselineAtInterruption: nextState.moodBaseline,
        arousalAtInterruption: nextState.arousal,
        lastBehavior: nextState.lastBehavior.kind,
        observedAt: observation.observedAt,
      },
    };
    apply(collisionInterruption);
    observationIdsToConfirm.push(observation.id);
    notices.push(
      `[INTERRUPTION] collision detected (${motion.magnitude.toFixed(1)} m/s²)`,
    );
  };

  /** 环境观测 → 缓慢调制 mood_baseline */
  const applyEnvironmentObservation = (
    observation: PendingObservation<EnvironmentReading>,
  ): void => {
    const env = observation.reading;
    // 舒适温度范围 18-26°C，偏离越大 mood 影响越大
    const tempComfort = 1 - Math.min(1, Math.abs(env.temperature - 22) / 15);
    // 光照影响：白天（强光）略正向，夜晚略负向
    const lightEffect = (env.light - 500) / 1000; // -0.5 ~ 0.5
    const envMoodDelta = (tempComfort - 0.5) * 2 + lightEffect * 0.5;
    const envEvent: EnvironmentEvent = {
      type: 'environment',
      id: observation.id,
      timestamp: observation.eventTimestamp,
      payload: {
        feature: 'environment',
        reading: env.temperature,
        moodDelta: envMoodDelta * 0.01, // 小时级时间常数，缓慢调制
        salience: 0.05,
        observedAt: observation.observedAt,
      },
    };
    apply(envEvent);
    observationIdsToConfirm.push(observation.id);
  };

  // === 恢复批次：先取出上一轮失败遗留的待确认观测 ===
  const carriedKinds = new Set<ObservationKind>(await inbox.pendingKinds());
  const carried: Array<{
    kind: ObservationKind;
    observation: PendingObservation<unknown>;
  }> = [];

  for (const kind of ['battery', 'motion', 'environment'] as const) {
    if (!carriedKinds.has(kind)) continue;
    const observation = await inbox.pending(kind);
    if (!observation) continue;

    if (kind === 'motion' && !(observation.reading as MotionReading).collision) {
      // 防御性分支：非碰撞读数无事件、无状态影响，不应长期保留为 pending
      await inbox.confirm(observation.id);
      continue;
    }

    carried.push({ kind, observation });
  }

  // 按首次构建时冻结的事件时间升序应用，保证日志时间轴单调
  carried.sort((a, b) => {
    const ta = a.observation.eventTimestamp;
    const tb = b.observation.eventTimestamp;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  for (const item of carried) {
    switch (item.kind) {
      case 'battery':
        applyBatteryObservation(
          item.observation as PendingObservation<BatteryReading>,
        );
        break;
      case 'motion':
        applyMotionObservation(
          item.observation as PendingObservation<MotionReading>,
        );
        break;
      case 'environment':
        applyEnvironmentObservation(
          item.observation as PendingObservation<EnvironmentReading>,
        );
        break;
    }
  }

  // === 本轮子步 tick（恢复批次中排在待恢复观测之后） ===
  // 每个子步都必须独立进入批次（携带各自的 subStepDelta）：
  // 只写第一个子步会让 replay 与实际运行出现数值分叉。
  for (let i = 0; i < numSubSteps; i++) {
    apply(createTickEvent(subStepDelta));
  }

  // === 本轮新读取的观测（自然位置：电池 → 运动 → 环境） ===
  if (!carriedKinds.has('battery')) {
    const batteryObservation = await inbox.observe<BatteryReading>(
      'battery',
      () => sensors.battery.read(),
    );
    applyBatteryObservation(batteryObservation);
  }

  if (!carriedKinds.has('motion')) {
    const motionObservation = await inbox.observe<MotionReading>(
      'motion',
      () => sensors.motion.read(),
    );
    if (motionObservation.reading.collision) {
      applyMotionObservation(motionObservation);
    } else {
      // 无碰撞：没有对应事件与状态变化，立即确认，避免永久 pending 阻塞屏障
      await inbox.confirm(motionObservation.id);
    }
  }

  if (!carriedKinds.has('environment')) {
    const environmentObservation = await inbox.observe<EnvironmentReading>(
      'environment',
      () => sensors.environment.read(),
    );
    applyEnvironmentObservation(environmentObservation);
  }

  return {
    events,
    nextState,
    snapshots,
    notices,
    realDeltaSeconds,
    observationIdsToConfirm,
  };
}

/**
 * 执行一轮 tick：生成 → 本地模拟 → 单事务批量持久化 → 成功后确认观测并发布。
 *
 * 失败时异常向上抛出（不吞异常）：
 * - 同批次已插入的行随事务一起回滚
 * - 未确认观测保留在 Inbox 中，下一轮复用同一 ID / 时间戳 / 读数
 * - session.state / lastTickTime / tickCount 均不变
 * - 下一轮 tick 以未推进的 lastTickTime 计算 delta，自然补偿失败的时间差
 *
 * @param inbox 观测收件箱（调用方必须与 Chat 屏障共用同一实例）
 * @param persist 持久化函数（默认 appendEvents；测试可注入真实 PG 故障）
 */
export async function executeTick(
  session: TickSession,
  sensors: SensorProvider,
  inbox: ObservationInbox,
  now: number,
  timeScale: number,
  persist: (events: MarrowEvent[]) => Promise<void> = (events) =>
    appendEvents(events),
): Promise<TickBatch> {
  const batch = await buildTickBatch(session, sensors, inbox, now, timeScale);

  // 整批单事务写入；任一条失败 → 抛出，以下确认与发布逻辑不会执行
  await persist(batch.events);

  // 事务提交成功后才确认观测、推进内存状态与时间基准
  for (const observationId of batch.observationIdsToConfirm) {
    await inbox.confirm(observationId);
  }
  session.state = batch.nextState;
  session.lastTickTime = now;
  session.tickCount += 1;

  return batch;
}
