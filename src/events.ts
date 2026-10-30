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
  | 'dialogue'
  | 'memory_evocation'
  | 'sleep'
  | 'trait_shift'
  | 'observation'
  | 'appraisal';

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
    /**
     * 是否为创伤性中断（崩溃/强制断电等非正常中断）。
     * 创伤性中断会写入负向伤痕记忆，降低后续心情基线，直到被安抚。
     */
    isTraumatic?: boolean;
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
 * 客观对话行为类型
 *
 * 由 LLM 从文本中提取的客观事实，不包含主观情绪判断。
 * LLM 只做意图提取，情绪效价由 appraisal.ts 计算。
 */
export type DialogueAction =
  | 'greeting' // 打招呼
  | 'farewell' // 告别
  | 'compliment' // 赞美
  | 'insult' // 侮辱
  | 'complaint' // 抱怨/不满
  | 'teasing' // 调侃/戏弄
  | 'question' // 提问
  | 'statement' // 陈述
  | 'confession' // 表白/倾诉
  | 'command' // 命令
  | 'comfort' // 安慰
  | 'apology' // 道歉
  | 'unknown'; // 无法识别

/**
 * DialogueEvent —— 对话事件
 *
 * 对话是物理事件，影响 energy 和 mood_baseline，与温度/碰撞同级。
 *
 * 主客观分离：
 * - LLM 提取客观事实：action（行为类型）、intensity（强度 0-1）
 * - appraisal.ts 计算主观情绪：moodDelta = Action_Value * Association_Weight * Speaker_Affinity
 *
 * 阶段四扩展：
 * - companion_output 时携带 LLM 原始候选文本与过滤结果
 * - interruption_flag 为真时，候选行为被强制拦截，不放给用户
 */
export interface DialogueEvent extends BaseEvent {
  type: 'dialogue';
  payload: {
    /** 对话方向 */
    direction: 'user_input' | 'companion_output';
    /** 最终放出的文本（被过滤后可能为空或降级提示） */
    text: string;
    /** 客观行为类型（由 LLM 提取，旧事件可能缺失） */
    action?: DialogueAction;
    /** 客观强度 0-1（由 LLM 提取，旧事件可能缺失） */
    intensity?: number;
    /** 该对话对 mood 的影响量（由 appraisal 计算，非 LLM 决定） */
    moodDelta: number;
    /** 显著性 */
    salience: number;
    /** 文本字数（用于计算语言能量消耗，旧事件可能缺失） */
    wordCount?: number;
    /** LLM 原始候选回复文本（仅 companion_output 时有值） */
    candidateText?: string;
    /** 候选行为是否被状态机过滤（仅 companion_output 时有值） */
    filtered?: boolean;
    /** 过滤原因（filtered 为 true 时有值） */
    filterReason?: string;
    /**
     * 关联的观察事件 ID（阶段四收尾：对话流程的输入溯源）
     * 旧事件可能缺失
     */
    observationId?: string;
    /**
     * 关联的评价事件 ID（阶段四收尾：评价与对话的溯源链）
     * 旧事件可能缺失
     */
    appraisalId?: string;
  };
}

/**
 * ObservationEvent —— 观察事件（阶段四收尾）
 *
 * LLM 对用户输入的"纯观察"结果：
 * - 只提取客观事实：行为类型、强度、事实主张、不确定性
 * - 不包含任何主观情绪判断（moodDelta/valence 等）——那是 appraisal 的职责
 *
 * 观察不直接驱动状态变化，只作为 appraisal 的输入与审计溯源记录。
 * 事件回放时，观察仅更新时间戳，状态演化由 AppraisalEvent/DialogueEvent 承担。
 */
export interface ObservationEvent extends BaseEvent {
  type: 'observation';
  payload: {
    /** 观察来源（目前仅支持用户文本） */
    source: 'user_text';
    /** 被观察的原始文本内容 */
    content: string;
    /** 提取的客观行为类型（可能为 undefined，表示未能识别） */
    action?: DialogueAction;
    /** 提取的客观强度 0-1（可能为 undefined） */
    intensity?: number;
    /** 观察置信度 0-1（提取器对自身输出的确定性评估） */
    confidence: number;
    /** 不确定性 0-1（与 confidence 互补，供下游审计） */
    uncertainty: number;
    /**
     * 提取的事实主张列表（如"用户提到了火锅"）
     * 每条主张带独立置信度，支持未来基于证据的记忆检索
     */
    facts: Array<{
      claim: string;
      confidence: number;
      evidence?: string;
    }>;
    /** 提取器版本（便于回放时按版本兼容旧格式） */
    extractorVersion: string;
  };
}

/**
 * AppraisalEvent —— 评价事件（阶段四收尾）
 *
 * appraisal.ts 基于观察与动态状态计算出的多维情绪增量。
 * 这是"主观评价"的事件溯源记录：
 * - valenceDelta：对 mood_baseline 的效价影响（由 DialogueEvent 重复应用，本事件仅作证据链）
 * - arousalDelta：对 arousal 的唤醒影响（本事件直接应用）
 * - energyDelta：对 energy 的影响（预留，当前 DialogueEvent 已计算能量消耗）
 *
 * 与 DialogueEvent 的关系：
 * - AppraisalEvent 负责"为什么这么感觉"（记录输入观察与计算结果）
 * - DialogueEvent 负责"实际状态怎么变"（携带 moodDelta = AppraisalResult.valenceDelta）
 */
export interface AppraisalEvent extends BaseEvent {
  type: 'appraisal';
  payload: {
    /** 触发本次评价的观察事件 ID（溯源链） */
    sourceObservationId: string;
    /** 对 mood_baseline 的效价增量（valence） */
    valenceDelta: number;
    /** 对 arousal 的唤醒增量 */
    arousalDelta: number;
    /** 对 energy 的能量增量（预留，当前由 DialogueEvent 处理） */
    energyDelta: number;
    /** 观察置信度（低置信时衰减已在 appraise 中完成，此处仅记录） */
    confidence: number;
    /** 被唤醒记忆的 ID 列表（证据链，供回放分析） */
    evidenceAssociationIds: string[];
  };
}

/** 事件联合类型 */
export type MarrowEvent =
  | TickEvent
  | InterruptionEvent
  | EnvironmentEvent
  | DialogueEvent
  | MemoryEvocationEvent
  | SleepEvent
  | TraitShiftEvent
  | ObservationEvent
  | AppraisalEvent;

/**
 * MemoryEvocationEvent —— 记忆唤醒事件
 *
 * 当对话中的关键词触发了情景记忆缓冲区中的高显著度记忆时产生。
 * 正向回忆 → 强制拉高 mood 并稍微恢复 energy（精神一振）
 * 负向回忆 → 强制拉低 mood
 *
 * 这是事件溯源的一部分：记忆唤醒本身也是可重放的事件。
 */
export interface MemoryEvocationEvent extends BaseEvent {
  type: 'memory_evocation';
  payload: {
    /** 触发的记忆 ID */
    memoryId: string;
    /** 记忆的效价 -1 到 1 */
    valence: number;
    /** 记忆显著性 0-1 */
    salience: number;
    /** 触发关键词 */
    cue: string;
    /** 记忆摘要（用于注入快照叙事） */
    summary: string;
    /** 对 mood 的强制影响量 */
    moodDelta: number;
    /** 对 energy 的影响量（正向回忆恢复精神） */
    energyDelta: number;
  };
}

/**
 * SleepEvent —— 睡眠 / 觉醒事件
 *
 * 睡眠是自愈阶段：
 * - 正常睡眠恢复体力，并让心情向 50 稳态回归
 * - 带着极低 trust 或极高 cognitive_load 入睡时，只恢复体力，
 *   甚至触发夜间反刍（醒来心情更低、内耗残留）
 *
 * entering=true 表示入睡（捕获入睡时的信任度与内耗，供醒来判定夜间反刍）；
 * entering=false 表示醒来。
 */
export interface SleepEvent extends BaseEvent {
  type: 'sleep';
  payload: {
    /** true=入睡，false=醒来 */
    entering: boolean;
    /** 入睡/醒来原因（battery_depleted / energy_critical / recovered） */
    reason?: string;
  };
}

/**
 * 性格特质（Personality Traits）
 *
 * 性格不是提示词里的"人设"，而是决定各状态变量如何演化、如何计算的
 * 全局底层系数。初始全部为 1.0（中性，白纸阶段），范围 [0.5, 2.0]。
 *
 * - neuroticism（神经质）：放大负面事件的情绪冲击与内耗累积速度
 * - agreeableness（宜人性）：反比于信任扣除幅度；极低时防御上升速度翻倍
 * - extraversion（外向性）：放大社交渴望与被认可需求的自然增长率
 * - resilience（恢复韧性）：放大心情稳态回归拉力与睡眠时的内耗清除
 *
 * 与瞬态心理变量（defensiveness 等）严格分离：
 * 特质是"人格"，变量是"状态"。特质只能通过 TraitShiftEvent 永久微量漂移。
 */
export interface PersonalityTraits {
  /** 神经质 0.5-2.0，初始 1.0 */
  neuroticism: number;
  /** 宜人性 0.5-2.0，初始 1.0 */
  agreeableness: number;
  /** 外向性 0.5-2.0，初始 1.0 */
  extraversion: number;
  /** 恢复韧性 0.5-2.0，初始 1.0 */
  resilience: number;
}

/**
 * TraitShiftEvent —— 性格特质漂移事件
 *
 * Phase 5（记忆聚合）模块的唯一性格修改入口：
 * 长期事件频率与创伤/愉悦记忆聚合后，生成此事件写入日志，
 * 对特质做永久性微量漂移（如长期受虐 neuroticism += 0.05）。
 *
 * 作为事件写入 append-only 日志 → 回放时特质演化完全可追溯、可复现。
 */
export interface TraitShiftEvent extends BaseEvent {
  type: 'trait_shift';
  payload: {
    /** 各项特质的漂移量（±增量，非绝对值），应用时 clamp 到 [0.5, 2.0] */
    shift: Partial<PersonalityTraits>;
    /** 漂移原因（由记忆聚合模块写入，供回放分析） */
    reason: string;
  };
}

/**
 * 关联记忆（Association Memory）
 *
 * 长期记忆的最小单元。由高显著性事件写入，缓慢衰减。
 * 聚合后影响 associationWeight，从而调制 appraisal 的情绪效价。
 *
 * 中断伤痕（scar）是一种特殊的负向关联记忆：
 * "断电 / 崩溃 = 被抛弃 / 痛苦"，会降低重启后的初始心情，直到被安抚。
 */
export interface AssociationMemory {
  /** 记忆唯一 ID */
  id: string;
  /** 写入时间戳 */
  timestamp: string;
  /** 关联的触发概念（如 'power_loss', 'user_insult', 'warm_comfort'） */
  cue: string;
  /** 效价 -1 到 1（正向为正，负向为负） */
  valence: number;
  /** 显著性 0-1，越高越难被遗忘，也越强地影响当前状态 */
  salience: number;
  /** 记忆来源 */
  source: 'interruption' | 'dialogue' | 'environment';
  /** 是否为中断伤痕（创伤记忆） */
  isScar?: boolean;
}

/**
 * 情景记忆（Episodic Memory）
 *
 * 存储具体的对话片段或事件经历，带有可检索的关键词。
 * 当用户对话中出现匹配关键词时，相关情景记忆被唤醒，
 * 直接影响当前情绪（正向回忆→精神一振，负向回忆→心情低落）。
 *
 * 与 AssociationMemory 的区别：
 * - AssociationMemory 是抽象的概念关联（如 "断电=痛苦"）
 * - EpisodicMemory 是具体的经历片段（如 "第一次约会的火锅店"）
 */
export interface EpisodicMemory {
  /** 记忆唯一 ID */
  id: string;
  /** 写入时间戳 */
  timestamp: string;
  /** 记忆摘要（人类可读的简短描述） */
  summary: string;
  /** 触发关键词列表（用于检索匹配） */
  keywords: string[];
  /** 效价 -1 到 1（美好回忆为正，痛苦回忆为负） */
  valence: number;
  /** 显著性 0-1，越高越容易被唤醒 */
  salience: number;
  /** 关联的对话事件 ID（可溯源） */
  sourceEventId?: string;
  /** 是否为创伤性记忆（唤醒时除拉低心情外还会增加内耗） */
  isTrauma?: boolean;
}

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
