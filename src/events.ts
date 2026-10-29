/**
 * events.ts — 事件类型判别联合
 *
 * 所有状态变化都以事件形式写入 append-only 日志。
 * 中断本身也是事件，重启时重放并显式消费。
 *
 * 设计原则：
 * - 判别联合（discriminated union）+ 编译期穷尽检查
 * - 每个事件携带 timestamp，保证时间轴可追溯
 * - 事件一旦写入不可修改（事件溯源）
 */

/** 事件类型判别字段 */
export type EventType =
  | 'tick'
  | 'interruption'
  | 'environment'
  | 'dialogue';

/** 事件基类：所有事件共享的字段 */
export interface BaseEvent {
  /** 事件类型（判别字段） */
  type: EventType;
  /** 事件发生的时间戳（ISO 8601） */
  timestamp: string;
  /** 事件唯一 ID（可用于去重和追踪） */
  id: string;
}

/**
 * TickEvent —— 心跳事件
 *
 * 状态机每 10 秒产生一次 tick，驱动 energy 衰减、
 * mood_baseline 漂移、arousal 指数衰减。
 */
export interface TickEvent extends BaseEvent {
  type: 'tick';
  payload: {
    /** 距上一次 tick 的秒数（用于补偿不精确的定时器） */
    deltaSeconds: number;
  };
}

/**
 * InterruptionEvent —— 中断事件
 *
 * arousal 超阈值时置位 interruption_flag，强制中断当前行为。
 * 携带中断发生时的状态快照，供重启时消费。
 *
 * 关键：interruption_flag 不能被对话层覆盖或忽略。
 */
export interface InterruptionEvent extends BaseEvent {
  type: 'interruption';
  payload: {
    /** 中断原因（碰撞、低电量、意外事件等） */
    reason: string;
    /** 中断时的 energy 值 */
    energyAtInterruption: number;
    /** 中断时的 mood_baseline 值 */
    moodBaselineAtInterruption: number;
    /** 中断时的 arousal 值 */
    arousalAtInterruption: number;
    /** 中断时正在执行的行为 */
    lastBehavior: string;
    /** 中断时长（秒），重启时填入 */
    interruptionDurationSeconds?: number;
  };
}

/**
 * EnvironmentEvent —— 环境事件
 *
 * 温度、湿度、光照等环境变化。
 * 阶段三接入真实传感器，阶段一可用模拟数据。
 */
export interface EnvironmentEvent extends BaseEvent {
  type: 'environment';
  payload: {
    /** 环境特征名称（temperature、humidity、light 等） */
    feature: string;
    /** 传感器读数 */
    reading: number;
    /** 该事件对 mood 的影响量（可正可负） */
    moodDelta: number;
    /** 显著性（0-1，越高越难被遗忘） */
    salience: number;
  };
}

/**
 * DialogueEvent —— 对话事件
 *
 * 用户输入或伴侣输出。阶段四接入 LLM，阶段一仅占位。
 * 对话是输出通道，不是人格来源。
 */
export interface DialogueEvent extends BaseEvent {
  type: 'dialogue';
  payload: {
    /** 对话方向 */
    direction: 'user_input' | 'companion_output';
    /** 文本内容 */
    text: string;
    /** 该对话对 mood 的影响量 */
    moodDelta: number;
    /** 显著性 */
    salience: number;
  };
}

/** 事件联合类型 */
export type MarrowEvent =
  | TickEvent
  | InterruptionEvent
  | EnvironmentEvent
  | DialogueEvent;

/**
 * 穷尽检查辅助类型
 *
 * 在 switch(event.type) 的 default 分支使用：
 *   const _exhaustive: never = event;
 * 若新增事件类型但未处理，编译期报错。
 */
export type ExhaustiveCheck = never;

/**
 * 事件日志类型
 * append-only，只追加不修改。
 */
export type EventLog = MarrowEvent[];
