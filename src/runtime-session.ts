/**
 * runtime-session.ts — 单 identity 运行时调度器（M1.2.2 C1 / C2 / C3）
 *
 * 职责：
 * - 每个 identity 一个 RuntimeSession（模块级注册表保证唯一写入权）
 * - 同一 session 内只有一个任务执行器（running 槽），Chat 与 Tick 共用
 * - Chat Admission 负责容量、FIFO、等待超时与完成通知
 * - LLM 提取在 admission 的 reserved 阶段进行，不占用执行器，
 *   但计入容量并按 admission 顺序排队
 * - Tick 由 requestTick() 进入同一队列：等待中/执行中的重复请求合并，
 *   上一轮 Tick 失败后下一轮自动升级为 recovery-tick（最高优先级）
 *
 * C3 生命周期与可靠性：
 * - 每个 admission 持有 AbortSignal：超时 / 主动释放 / shutdown 移除时触发，
 *   用于取消底层 LLM 提取请求；迟到结果由 markReady 的 reserved 检查丢弃
 * - shutdown() 优雅关闭：停止接受新任务、排空等待队列（逐一拒绝并 abort）、
 *   丢弃合并的 pendingTick、等待执行中任务完成（带宽限期，不打断持久化临界区）
 * - shutdown 幂等：多次调用返回同一个 Promise
 *
 * 状态机（C1）：
 *   reserved  → ready    （提取完成，进入 FIFO 队列）
 *   reserved  → removed  （超时 / 主动释放 / 提取失败 / shutdown）
 *   ready     → running  （排到队首且执行器空闲）
 *   ready     → waiting  （前面的 admission 仍在 extracting，FIFO 阻塞）
 *   waiting   → ready    （前面的 admission 结束，FIFO 晋升）
 *   ready     → removed
 *   waiting   → removed
 *   running   → completed / failed
 *   禁止 removed → ready，禁止任何终态继续迁移
 *
 * 与 A 阶段的关系：
 * - RuntimeSession 已完全取代 identity-lock（C3 移除该临时模块）
 * - ObservationInbox / 观测恢复屏障语义不变，屏障检查在执行器任务内部
 */

import { randomUUID } from 'node:crypto';

/** Chat Admission 状态 */
export type ChatAdmissionState =
  | 'reserved'
  | 'ready'
  | 'waiting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'removed';

/** Chat 成功完成时返回给 HTTP 调用方的结果 */
export interface ChatOutcome {
  reply: string;
  filtered: boolean;
  filterReason: string | null;
}

/** 执行器任务：状态变更 + 持久化 + 内存状态发布，全部串行执行 */
export type ChatTask = () => Promise<ChatOutcome>;

/** 执行器任务类型（Chat 与 Tick 共用同一单执行器） */
export type RuntimeTaskKind = 'chat' | 'tick' | 'recovery-tick';

/** Tick 的两种优先级类型 */
type TickKind = 'tick' | 'recovery-tick';

/**
 * Chat Admission 对外视图
 *
 * state 是实时快照；completion 在成功时解析为 ChatOutcome，
 * 失败 / 超时 / 取消时以明确异常拒绝。
 */
export interface ChatAdmission {
  readonly id: string;
  /** admission 顺序号（FIFO 唯一依据） */
  readonly sequence: number;
  readonly admittedAt: number;
  readonly state: ChatAdmissionState;
  readonly completion: Promise<ChatOutcome>;
  /**
   * 提取阶段取消信号（C3）
   *
   * 在 admission 被移除（超时 / 主动释放 / shutdown）时触发。
   * 调用方应把它传给 LLM 提取请求：信号触发后尝试取消底层请求；
   * 即使底层不支持取消，迟到结果也会被 markReady 的 reserved 检查丢弃，
   * 绝不提交事件、发布状态或覆盖已产生的明确结果。
   */
  readonly signal: AbortSignal;
}

/** 容量已满（必须在调用 LLM 提取前同步抛出） */
export class RuntimeQueueFullError extends Error {
  readonly code = 'chat_queue_full' as const;

  constructor(identityId: string, maxAcceptedChats: number) {
    super(`identity ${identityId} 的 Chat 准入容量已满（上限 ${maxAcceptedChats}）`);
    this.name = 'RuntimeQueueFullError';
  }
}

/** 等待超时（从 reserveChat 开始计时） */
export class ChatWaitTimeoutError extends Error {
  readonly code = 'chat_wait_timeout' as const;

  constructor(timeoutMs: number) {
    super(`Chat 等待超过 ${timeoutMs}ms，已从队列移除`);
    this.name = 'ChatWaitTimeoutError';
  }
}

/** 主动释放 / 提取失败 / 取消 */
export class ChatAdmissionRemovedError extends Error {
  readonly code = 'chat_removed' as const;

  constructor(reason: string) {
    super(`Chat admission 已移除：${reason}`);
    this.name = 'ChatAdmissionRemovedError';
  }
}

/** RuntimeSession 已关闭（C3）：不再接受任何新任务 */
export class RuntimeSessionClosedError extends Error {
  readonly code = 'runtime_session_closed' as const;

  constructor(identityId: string) {
    super(`identity ${identityId} 的 RuntimeSession 已关闭，不再接受新任务`);
    this.name = 'RuntimeSessionClosedError';
  }
}

/** 队列快照中的单个条目 */
export interface QueueSnapshotEntry {
  id: string;
  state: ChatAdmissionState;
  sequence: number;
  admittedAt: number;
}

/**
 * 队列快照
 *
 * reserved = 正在提取（extracting）
 * ready    = 提取完成且可被调度（队首）
 * waiting  = 提取完成但被更早的 extracting 阻塞（FIFO）
 * running  = 正在执行状态变更
 */
export interface QueueSnapshot {
  identityId: string;
  maxAcceptedChats: number;
  /** 会话是否已关闭（C3）：关闭后拒绝一切新任务 */
  closed: boolean;
  /** 计入容量的活动 admission 数（reserved/ready/waiting/running） */
  active: number;
  reserved: number;
  ready: number;
  waiting: number;
  /** 执行器是否忙碌（0/1），不区分 Chat 与 Tick */
  running: number;
  runningChatId: string | null;
  /** 当前正在执行的任务类型（null 表示空闲） */
  runningTaskKind: RuntimeTaskKind | null;
  /** Tick 调度状态（Tick 不占用 Chat 容量） */
  tick: {
    /** 是否有合并后的 Tick 在等待执行 */
    pending: boolean;
    /** 是否有 Tick 正在执行 */
    running: boolean;
    /** 当前排队或执行中的 Tick 类型 */
    kind: TickKind | null;
    /** 上一轮 Tick 失败，下一轮需要恢复未确认观测 */
    recoveryRequired: boolean;
  };
  /** 仅包含 Chat 条目；Tick 状态见 tick 字段 */
  entries: QueueSnapshotEntry[];
}

export interface RuntimeSessionOptions {
  /** 容量上限，统计 extracting/ready/waiting/running 全部状态 */
  maxAcceptedChats?: number;
  /** 从 reserveChat 开始计算的等待超时 */
  chatWaitTimeoutMs?: number;
}

export interface RuntimeSessionShutdownOptions {
  /**
   * 等待执行中任务完成的宽限期（毫秒）。
   * 超时后 shutdown 返回 drained=false，执行中任务继续在后台运行；
   * 不打断持久化临界区，避免数据库事务被强制中断。
   * 调用方必须依据 ShutdownResult.drained 决定后续动作（见 index.ts 关闭流程）。
   */
  graceMs?: number;
}

/**
 * shutdown 的结构化结果（C3.1）
 *
 * 调用方据此判断数据库连接池是否可以安全关闭：
 * - drained=true 才允许 closeDb
 * - drained=false 时必须 waitForIdle() 等待执行中任务真正结束，禁止立即 closeDb
 */
export interface ShutdownResult {
  /** true = 返回时执行器已无 running 任务（基于真实 runningTask 状态，非超时推断） */
  readonly drained: boolean;
  /** 返回时仍在执行的任务数（0/1） */
  readonly running: number;
  /** true = 因宽限期超时返回；drained=false 时恒为 true */
  readonly timedOut: boolean;
  /** 排空阶段移除的等待中 Chat 数量（reserved/ready/waiting） */
  readonly drainedChats: number;
  /** 是否丢弃了合并的 pendingTick */
  readonly discardedTick: boolean;
}

/** waitForIdle 的返回：执行器最后一个 running 任务的结局 */
export type IdleOutcome = 'idle' | 'completed' | 'failed';

/** 默认容量（R3.2 定义） */
const DEFAULT_MAX_ACCEPTED_CHATS = 32;
/** 默认等待超时 */
const DEFAULT_CHAT_WAIT_TIMEOUT_MS = 30_000;
/** 默认 shutdown 宽限期 */
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/** 允许的状态迁移（removed → ready 明确禁止） */
const ALLOWED_TRANSITIONS: Record<
  ChatAdmissionState,
  readonly ChatAdmissionState[]
> = {
  reserved: ['ready', 'removed'],
  ready: ['waiting', 'running', 'removed'],
  waiting: ['ready', 'removed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  removed: [],
};

function isTerminal(state: ChatAdmissionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'removed';
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Admission 内部可变实现（对外只暴露只读视图） */
class AdmissionImpl implements ChatAdmission {
  readonly id: string;
  readonly sequence: number;
  readonly admittedAt = Date.now();
  readonly completion: Promise<ChatOutcome>;

  private _state: ChatAdmissionState = 'reserved';
  private readonly deferred: Deferred<ChatOutcome>;
  private timer: NodeJS.Timeout | null = null;
  /** 提取阶段取消信号：仅在 remove() 时触发（超时 / 释放 / shutdown） */
  private readonly abortController = new AbortController();

  /** 执行器任务，markReady 时写入 */
  task: ChatTask | null = null;

  constructor(
    readonly sessionId: string,
    sequence: number,
  ) {
    this.id = `chat-${randomUUID()}`;
    this.sequence = sequence;
    this.deferred = createDeferred<ChatOutcome>();
    this.completion = this.deferred.promise;
    // 即使调用方尚未 await，也不产生 unhandled rejection
    void this.completion.catch(() => undefined);
  }

  get state(): ChatAdmissionState {
    return this._state;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** 触发取消信号（幂等），reason 与 completion 的拒绝原因一致 */
  abort(reason: Error): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
  }

  transition(next: ChatAdmissionState): void {
    if (next === this._state) return;
    const allowed = ALLOWED_TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new Error(`非法状态迁移：${this._state} → ${next}（admission ${this.id}）`);
    }
    this._state = next;
  }

  setTimer(timer: NodeJS.Timeout): void {
    this.timer = timer;
  }

  clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resolve(outcome: ChatOutcome): void {
    this.deferred.resolve(outcome);
  }

  reject(error: unknown): void {
    this.deferred.reject(error);
  }
}

/**
 * 一个 Tick 请求（同一时刻最多只有一个排队/执行）
 *
 * completion 在成功时解析为任务工厂的返回值，失败时以原始异常拒绝。
 * 重复的 Tick 请求合并到同一 entry，任务工厂只执行一次。
 */
interface TickEntry {
  readonly id: string;
  readonly kind: TickKind;
  readonly completion: Promise<unknown>;
  readonly deferred: Deferred<unknown>;
  task: (() => Promise<unknown>) | null;
}

/** 执行器当前持有的任务（Chat 或 Tick） */
type RunningTask =
  | { readonly kind: 'chat'; readonly admission: AdmissionImpl }
  | { readonly kind: TickKind; readonly entry: TickEntry };

/**
 * 单 identity 运行时调度器
 *
 * 生产环境必须通过 getRuntimeSession(identityId) 获取，
 * 保证同一 identity 只有一个写入权所有者。
 */
export class RuntimeSession {
  readonly identityId: string;
  readonly maxAcceptedChats: number;
  readonly chatWaitTimeoutMs: number;

  /** FIFO 队列：按 admission 顺序排列，包含 reserved/ready/waiting */
  private readonly queue: AdmissionImpl[] = [];
  /** 单执行器槽：Chat 与 Tick 互斥 */
  private runningTask: RunningTask | null = null;
  /** 合并后的待执行 Tick（最多一个） */
  private pendingTick: TickEntry | null = null;
  /** 上一轮 Tick 失败：下一次 Tick 必须升级为 recovery-tick */
  private recoveryRequired = false;
  /** 最近完成的任务类型，供 Chat/Tick 公平调度 */
  private lastExecutedKind: RuntimeTaskKind | null = null;
  /** 活动 admission 数（容量与释放的唯一计数） */
  private activeCount = 0;
  private nextSequence = 1;
  /** C3：关闭标志。true 时拒绝一切新任务，pump 不再调度 */
  private closed = false;
  /** shutdown 幂等：多次调用返回同一个 Promise */
  private shutdownPromise: Promise<ShutdownResult> | null = null;

  constructor(identityId: string, options: RuntimeSessionOptions = {}) {
    this.identityId = identityId;

    const maxAccepted =
      options.maxAcceptedChats ?? DEFAULT_MAX_ACCEPTED_CHATS;
    if (!Number.isInteger(maxAccepted) || maxAccepted <= 0) {
      throw new Error(`maxAcceptedChats 必须是正整数，收到 ${maxAccepted}`);
    }
    this.maxAcceptedChats = maxAccepted;

    const timeout =
      options.chatWaitTimeoutMs ?? DEFAULT_CHAT_WAIT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`chatWaitTimeoutMs 必须是正数，收到 ${timeout}`);
    }
    this.chatWaitTimeoutMs = timeout;
  }

  /**
   * 预留一个 Chat 准入名额（同步）
   *
   * 第 maxAcceptedChats + 1 个请求会在此同步抛出 RuntimeQueueFullError，
   * 调用方因此不会进入 LLM 提取阶段。
   */
  reserveChat(): ChatAdmission {
    if (this.closed) {
      throw new RuntimeSessionClosedError(this.identityId);
    }
    if (this.activeCount >= this.maxAcceptedChats) {
      throw new RuntimeQueueFullError(this.identityId, this.maxAcceptedChats);
    }

    const admission = new AdmissionImpl(this.identityId, this.nextSequence++);
    this.activeCount += 1;

    const timer = setTimeout(() => {
      this.handleWaitTimeout(admission);
    }, this.chatWaitTimeoutMs);
    // 不阻止进程退出；仍在运行时照常触发
    timer.unref();
    admission.setTimer(timer);

    // 先入队：FIFO 依据 reserveChat 顺序，而不是提取完成顺序
    this.queue.push(admission);
    return admission;
  }

  /**
   * 提取完成，提交执行任务
   *
   * 只有仍处于 reserved 的 admission 会进入队列执行。
   * 已超时 / 已释放 / 已完成的晚到结果直接丢弃，返回 false。
   */
  markReady(admission: ChatAdmission, task: ChatTask): boolean {
    const target = this.requireOwned(admission);
    if (target.state !== 'reserved') return false;
    if (typeof task !== 'function') {
      throw new Error('markReady 必须传入可执行任务');
    }

    target.task = task;
    target.transition('ready');
    this.refreshFifoStates();
    this.pump();
    return true;
  }

  /**
   * 请求执行一轮 Tick（M1.2.2-C2）
   *
   * - 与 Chat 共用同一执行器，绝不并发执行
   * - 同一时刻最多一个 Tick 排队：等待中/执行中的重复请求直接合并，
   *   返回同一个 completion Promise，任务工厂只执行一次
   * - 上一轮 Tick 失败后，下一次 Tick 自动升级为 recovery-tick（最高优先级）
   *
   * 调用方只需 await 返回的 Promise；被合并的请求共享同一结果。
   */
  requestTick<T>(task: () => Promise<T>): Promise<T> {
    if (typeof task !== 'function') {
      throw new Error('requestTick 必须传入可执行任务');
    }
    if (this.closed) {
      return Promise.reject(new RuntimeSessionClosedError(this.identityId));
    }

    const running = this.runningTask;
    if (
      running &&
      (running.kind === 'tick' || running.kind === 'recovery-tick')
    ) {
      // 执行中的 Tick 会在下一次请求时覆盖这段时间差，合并而非重复排队
      return running.entry.completion as Promise<T>;
    }
    if (this.pendingTick) {
      return this.pendingTick.completion as Promise<T>;
    }

    const kind: TickKind = this.recoveryRequired ? 'recovery-tick' : 'tick';
    const deferred = createDeferred<unknown>();
    // 合并请求可能无人直接 await，预先挂空 catch 避免 unhandled rejection
    void deferred.promise.catch(() => undefined);

    const entry: TickEntry = {
      id: `tick-${randomUUID()}`,
      kind,
      task,
      completion: deferred.promise,
      deferred,
    };
    this.pendingTick = entry;
    this.pump();
    return entry.completion as Promise<T>;
  }

  /**
   * 释放 admission（幂等）
   *
   * - 已处于终态：no-op
   * - running：不打断执行中的持久化临界区（C3 由 shutdown 宽限期等待其完成）
   * - reserved/ready/waiting：移出队列、释放容量、触发取消信号并以异常拒绝 completion
   */
  release(admission: ChatAdmission, reason = 'admission released'): void {
    const target = this.requireOwned(admission);
    if (isTerminal(target.state)) return;
    if (target.state === 'running') return;

    this.remove(target, new ChatAdmissionRemovedError(reason));
  }

  /** 当前队列快照（同步、无副作用） */
  snapshot(): QueueSnapshot {
    const runningTick =
      this.runningTask && this.runningTask.kind !== 'chat'
        ? this.runningTask.entry
        : null;
    const tickEntry = runningTick ?? this.pendingTick;

    const snapshot: QueueSnapshot = {
      identityId: this.identityId,
      maxAcceptedChats: this.maxAcceptedChats,
      closed: this.closed,
      active: this.activeCount,
      reserved: 0,
      ready: 0,
      waiting: 0,
      running: this.runningTask ? 1 : 0,
      runningChatId:
        this.runningTask && this.runningTask.kind === 'chat'
          ? this.runningTask.admission.id
          : null,
      runningTaskKind: this.runningTask ? this.runningTask.kind : null,
      tick: {
        pending: this.pendingTick !== null,
        running: runningTick !== null,
        kind: tickEntry ? tickEntry.kind : null,
        recoveryRequired: this.recoveryRequired,
      },
      entries: [],
    };

    for (const admission of this.queue) {
      switch (admission.state) {
        case 'reserved':
          snapshot.reserved += 1;
          break;
        case 'ready':
          snapshot.ready += 1;
          break;
        case 'waiting':
          snapshot.waiting += 1;
          break;
        default:
          break;
      }
      snapshot.entries.push({
        id: admission.id,
        state: admission.state,
        sequence: admission.sequence,
        admittedAt: admission.admittedAt,
      });
    }

    if (this.runningTask && this.runningTask.kind === 'chat') {
      const admission = this.runningTask.admission;
      snapshot.entries.push({
        id: admission.id,
        state: admission.state,
        sequence: admission.sequence,
        admittedAt: admission.admittedAt,
      });
    }

    return snapshot;
  }

  /** 会话是否已关闭 */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 优雅关闭（C3，幂等；C3.1 返回结构化 ShutdownResult）
   *
   * 顺序保证：
   * 1. 置 closed：此后 reserveChat 同步抛错、requestTick 返回拒绝
   * 2. 排空等待队列：reserved/ready/waiting 全部转为 removed，
   *    触发各自 AbortSignal（取消进行中的 LLM 提取）并以明确异常拒绝 completion
   * 3. 丢弃合并的 pendingTick（未开始执行，直接拒绝）
   * 4. 等待执行中任务完成（带宽限期）：执行中任务持有数据库事务，
   *    绝不强制中断；宽限期超时返回 drained=false、timedOut=true，
   *    绝不把"等待超时"误报为"任务已完成"
   *
   * 多次调用返回同一个 Promise（同一 ShutdownResult 实例）。
   */
  shutdown(options: RuntimeSessionShutdownOptions = {}): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown(options);
    return this.shutdownPromise;
  }

  /**
   * 等待执行器真正空闲（C3.1）
   *
   * 用于 shutdown 返回 drained=false 之后：调用方必须等本方法返回，
   * 确认 running 任务真正结束（成功或失败都会被体现）后才允许 closeDb。
   * - 无 running 任务：立即返回 'idle'
   * - running 任务成功：'completed'
   * - running 任务失败：'failed'
   */
  async waitForIdle(): Promise<IdleOutcome> {
    const running = this.runningTask;
    if (!running) return 'idle';
    const completion =
      running.kind === 'chat'
        ? running.admission.completion
        : running.entry.completion;
    try {
      await completion;
      return 'completed';
    } catch {
      return 'failed';
    }
  }

  private async doShutdown(options: RuntimeSessionShutdownOptions): Promise<ShutdownResult> {
    this.closed = true;

    // 排空等待队列（复制快照：remove 会原地修改 queue）
    // remove 内部会调用 pump，但 closed=true 时 pump 不再调度新任务
    let drainedChats = 0;
    for (const admission of [...this.queue]) {
      this.remove(admission, new ChatAdmissionRemovedError('session shutdown'));
      drainedChats += 1;
    }

    // 丢弃尚未开始执行的 pendingTick
    const pendingTick = this.pendingTick;
    let discardedTick = false;
    if (pendingTick) {
      this.pendingTick = null;
      pendingTick.task = null;
      pendingTick.deferred.reject(new RuntimeSessionClosedError(this.identityId));
      discardedTick = true;
    }

    // 等待执行中任务完成（不打断持久化临界区）
    const running = this.runningTask;
    let timedOut = false;
    if (running) {
      const completion =
        running.kind === 'chat'
          ? running.admission.completion
          : running.entry.completion;
      const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      let timer: NodeJS.Timeout | null = null;
      try {
        timedOut = await Promise.race([
          // 执行中任务的失败由调用方处理，shutdown 只关心"结束"本身
          completion.then(
            () => false,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), graceMs);
            // 不阻止进程退出
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // drained 基于真实 runningTask 状态，禁止把超时推断为完成
    const stillRunning = this.runningTask !== null;
    return {
      drained: !stillRunning,
      running: stillRunning ? 1 : 0,
      timedOut,
      drainedChats,
      discardedTick,
    };
  }

  /** 校验 admission 归属，禁止跨 session 混用 */
  private requireOwned(admission: ChatAdmission): AdmissionImpl {
    if (
      !(admission instanceof AdmissionImpl) ||
      admission.sessionId !== this.identityId
    ) {
      throw new Error('admission 不属于当前 RuntimeSession');
    }
    return admission;
  }

  /**
   * 按 FIFO 刷新 ready/waiting：
   * 队列中第一个仍在 extracting（reserved）的 admission 会阻塞其后所有
   * 已完成提取的 admission，使它们处于 waiting，直到前者结束。
   */
  private refreshFifoStates(): void {
    let blockedByEarlier = false;
    for (const admission of this.queue) {
      if (admission.state === 'reserved') {
        blockedByEarlier = true;
        continue;
      }
      if (admission.state === 'ready' || admission.state === 'waiting') {
        const next: ChatAdmissionState = blockedByEarlier ? 'waiting' : 'ready';
        if (admission.state !== next) {
          admission.transition(next);
        }
      }
    }
  }

  /** 调度：执行器空闲时按优先级选择下一个任务 */
  private pump(): void {
    if (this.closed) return;
    if (this.runningTask) return;

    const next = this.pickNext();
    if (!next) return;

    if (next === 'tick') {
      const entry = this.pendingTick;
      if (!entry) return;
      this.pendingTick = null;
      this.runningTask = { kind: entry.kind, entry };
      this.refreshFifoStates();
      void this.executeTickTask(entry);
      return;
    }

    const head = this.queue[0];
    if (!head || head.state !== 'ready') return;

    this.queue.shift();
    this.runningTask = { kind: 'chat', admission: head };
    head.transition('running');
    head.clearTimer();
    this.refreshFifoStates();
    void this.executeChatTask(head);
  }

  /**
   * 选择下一个任务（C2 调度策略）
   *
   * 1. recovery-tick 最高优先级：存在未确认观测时先恢复，Chat 不得插队
   * 2. 普通 Tick 执行后，若有等待 Chat，必须先放行一个 Chat（防饥饿）
   * 3. 其余情况 Chat 与普通 Tick 交替执行；只有单一任务类型时直接执行
   */
  private pickNext(): 'chat' | 'tick' | null {
    const head = this.queue[0];
    const chatReady = head && head.state === 'ready' ? head : null;
    const tick = this.pendingTick;

    if (tick && tick.kind === 'recovery-tick') return 'tick';
    if (chatReady && !tick) return 'chat';
    if (tick && !chatReady) return 'tick';
    if (chatReady && tick) {
      const afterTick =
        this.lastExecutedKind === 'tick' ||
        this.lastExecutedKind === 'recovery-tick';
      return afterTick ? 'chat' : 'tick';
    }
    return null;
  }

  /** 单执行器：Chat 任务串行执行，失败不会阻塞后续任务 */
  private async executeChatTask(admission: AdmissionImpl): Promise<void> {
    try {
      if (!admission.task) {
        throw new Error(`admission ${admission.id} 没有可执行任务`);
      }
      const outcome = await admission.task();
      admission.transition('completed');
      admission.resolve(outcome);
    } catch (err) {
      admission.transition('failed');
      admission.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      admission.clearTimer();
      admission.task = null;
      this.runningTask = null;
      this.lastExecutedKind = 'chat';
      this.activeCount -= 1;
      this.refreshFifoStates();
      this.pump();
    }
  }

  /**
   * 单执行器：Tick 任务串行执行
   *
   * 失败时把 recoveryRequired 置为 true，下一轮 Tick 自动升级为 recovery-tick；
   * 成功则清除标记（本轮已恢复并确认所有 pending 观测）。
   */
  private async executeTickTask(entry: TickEntry): Promise<void> {
    try {
      if (!entry.task) {
        throw new Error(`tick ${entry.id} 没有可执行任务`);
      }
      const result = await entry.task();
      this.recoveryRequired = false;
      entry.deferred.resolve(result);
    } catch (err) {
      this.recoveryRequired = true;
      entry.deferred.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      entry.task = null;
      this.runningTask = null;
      this.lastExecutedKind = entry.kind;
      this.refreshFifoStates();
      this.pump();
    }
  }

  /** 等待超时：只移除仍在 reserved/ready/waiting 的 admission */
  private handleWaitTimeout(admission: AdmissionImpl): void {
    if (
      admission.state === 'reserved' ||
      admission.state === 'ready' ||
      admission.state === 'waiting'
    ) {
      this.remove(admission, new ChatWaitTimeoutError(this.chatWaitTimeoutMs));
    }
  }

  /** 移除 admission：释放容量且只释放一次，同时触发取消信号 */
  private remove(admission: AdmissionImpl, error: Error): void {
    if (isTerminal(admission.state)) return;

    admission.transition('removed');
    admission.clearTimer();
    admission.task = null;
    // 先触发取消信号再拒绝 completion：
    // 提取阶段的底层请求尽早取消，迟到结果由 markReady 的 reserved 检查丢弃
    admission.abort(error);

    const index = this.queue.indexOf(admission);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }

    this.activeCount -= 1;
    admission.reject(error);

    this.refreshFifoStates();
    this.pump();
  }
}

/** identity → RuntimeSession（唯一写入权所有者） */
const sessions = new Map<string, RuntimeSession>();

/**
 * 获取（或创建）指定 identity 的唯一 RuntimeSession
 *
 * 已存在时忽略 options，防止运行中改变容量/超时。
 */
export function getRuntimeSession(
  identityId: string,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const existing = sessions.get(identityId);
  if (existing) return existing;

  const session = new RuntimeSession(identityId, options);
  sessions.set(identityId, session);
  return session;
}
