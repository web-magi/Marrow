/**
 * observation.ts — 传感器观测确认层（M1.2.2.2-A）
 *
 * 解决的问题：
 * Tick 读取传感器后、持久化之前若写库失败，碰撞等观测不能丢失；
 * 同时已成功持久化的观测不能被下一轮重复消费。
 *
 * 双时间语义：
 * - observedAt：物理观测发生时间，首次读取后永久稳定，写入事件 payload.observedAt
 * - eventTimestamp：首次构建事件时冻结的日志时间，写入 event.timestamp
 *   两者在重试时都不得改变，否则同一 event_id 会触发 appendEvents 的幂等冲突。
 *
 * 确认语义：
 * - confirm(observationId) 按 ID 精确清除，避免按 kind 误清其他观测
 * - 只有持久化成功后才调用 confirm；失败时 pending 原样保留
 *
 * 一致性边界（M1 过渡实现）：
 * - InMemoryObservationInbox 只保证单进程内"不丢失、不重复"
 * - 进程重启会丢失未确认观测；它们从未持久化，因此不会重复产生状态变化，
 *   但重启窗口内的物理事件（如一次碰撞）无法补回
 * - 跨进程可靠性需要未来的持久化 Inbox / ESP32 硬件确认机制；
 *   接口全部异步，正是为这类实现预留的扩展边界
 */

import { randomUUID } from 'node:crypto';

/** 观测类型（每类传感器同时最多保留一个待确认观测） */
export type ObservationKind = 'battery' | 'motion' | 'environment';

/** 一条待确认的观测 */
export interface PendingObservation<T = unknown> {
  /** 观测唯一 ID，同时作为对应事件的 event.id */
  readonly id: string;
  readonly kind: ObservationKind;
  /** 物理观测发生时间（payload.observedAt） */
  readonly observedAt: string;
  /** 事件日志时间（event.timestamp），首次构建事件时冻结 */
  readonly eventTimestamp: string;
  /** 传感器原始读数，重试时复用 */
  readonly reading: T;
}

/**
 * 观测收件箱接口（全异步）
 *
 * 未来的持久化实现可在 observe() 阶段先落本地持久化队列，
 * confirm() 成功后再删除；ESP32 可实现硬件确认后再清除。
 */
export interface ObservationInbox {
  /** 读取观测；该 kind 已有 pending 时直接复用，不调用 read() */
  observe<T>(
    kind: ObservationKind,
    read: () => T,
  ): Promise<PendingObservation<T>>;
  /** 按观测 ID 确认；未知 ID 为幂等 no-op */
  confirm(observationId: string): Promise<void>;
  /** 查询某类观测的 pending */
  pending(
    kind: ObservationKind,
  ): Promise<PendingObservation<unknown> | undefined>;
  /** 当前存在 pending 的观测类型列表 */
  pendingKinds(): Promise<ObservationKind[]>;
  /** 是否存在未确认观测（观测恢复屏障判定） */
  hasPending(): Promise<boolean>;
}

/**
 * 观测恢复屏障错误
 *
 * 存在未确认观测时，新的状态变更批次不得提交，
 * 否则会把更晚的事件排在待恢复观测之前，造成事件时间轴倒退。
 */
export class ObservationBarrierError extends Error {
  readonly code = 'observations_pending' as const;

  constructor(
    message = '存在未确认的传感器观测，拒绝提交新的状态变更',
  ) {
    super(message);
    this.name = 'ObservationBarrierError';
  }
}

/**
 * 观测恢复屏障断言（INV-A）
 *
 * 存在未确认观测时抛出 ObservationBarrierError。
 * Tick 与 Chat 都必须在各自的 identity 临界区内调用，
 * 否则屏障检查与提交仍可能被其他写入插入。
 */
export async function assertObservationBarrier(
  inbox: ObservationInbox,
): Promise<void> {
  if (await inbox.hasPending()) {
    throw new ObservationBarrierError();
  }
}

/**
 * 进程内观测收件箱（M1 过渡实现）
 *
 * 并发安全说明：所有状态变更都由调用方放在 identity 互斥临界区内，
 * 因此这里不再额外加锁。
 */
export class InMemoryObservationInbox implements ObservationInbox {
  private readonly pendingByKind = new Map<
    ObservationKind,
    PendingObservation<unknown>
  >();

  async observe<T>(
    kind: ObservationKind,
    read: () => T,
  ): Promise<PendingObservation<T>> {
    const existing = this.pendingByKind.get(kind);
    if (existing) {
      // 重试路径：复用首次读取的 ID / 双时间 / 读数，绝不重新读取传感器
      return existing as PendingObservation<T>;
    }

    // 首次读取：observationId 与 observedAt 同时生成
    const observedAt = new Date().toISOString();
    const reading = read();
    const pending: PendingObservation<T> = {
      id: `obs-${randomUUID()}`,
      kind,
      observedAt,
      // 与 observedAt 同一时刻冻结；重试时保持不变
      eventTimestamp: new Date().toISOString(),
      reading,
    };
    this.pendingByKind.set(kind, pending as PendingObservation<unknown>);
    return pending;
  }

  async confirm(observationId: string): Promise<void> {
    for (const [kind, pending] of this.pendingByKind) {
      if (pending.id === observationId) {
        this.pendingByKind.delete(kind);
        return;
      }
    }
    // 未知 ID：幂等 no-op（重复确认或已确认后重试都安全）
  }

  async pending(
    kind: ObservationKind,
  ): Promise<PendingObservation<unknown> | undefined> {
    return this.pendingByKind.get(kind);
  }

  async pendingKinds(): Promise<ObservationKind[]> {
    return [...this.pendingByKind.keys()];
  }

  async hasPending(): Promise<boolean> {
    return this.pendingByKind.size > 0;
  }
}
