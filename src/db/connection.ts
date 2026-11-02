/**
 * connection.ts — PostgreSQL 连接模块（postgres.js）
 *
 * M1.1 职责：
 * - 从 DATABASE_URL 创建 postgres.js 客户端（惰性单例）
 * - 提供 closeDb 供迁移脚本/测试优雅退出
 *
 * 注意：
 * - index.ts 已有自己的 .env 加载器；本模块自带一个最小加载，
 *   保证迁移脚本等独立入口在未经过 index.ts 时也能读到 DATABASE_URL。
 * - 若 DATABASE_URL 缺失则直接抛错，绝不静默回退到 JSONL。
 */

import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 最小 .env 加载器（与 index.ts 同款逻辑，独立入口兜底用）。
 * 不覆盖已存在的环境变量。
 */
function loadEnvFile(): void {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

let client: postgres.Sql | null = null;
/**
 * C3.1 连接生命周期状态：
 * - closed=false：允许 getDb 惰性建池
 * - closed=true：连接层已关闭，getDb 必须拒绝，禁止惰性重建连接池
 * closeDb 一开始即置 closed，防止关闭期间仍有新调用方拿到/创建连接池。
 */
let closed = false;
/** closeDb 幂等 + 并发安全：多次/并发调用共享同一个 Promise */
let closingPromise: Promise<void> | null = null;

/** 数据库连接层已关闭（C3.1）：关闭后任何访问都属于编程错误或生命周期竞态 */
export class DbClosedError extends Error {
  readonly code = 'db_closed' as const;

  constructor() {
    super('数据库连接层已关闭，禁止在 closeDb 后继续访问或重建连接池');
    this.name = 'DbClosedError';
  }
}

/**
 * 获取数据库客户端（惰性单例）。
 * DATABASE_URL 缺失时抛错——PostgreSQL 是唯一正式写入路径，不允许静默降级。
 * closeDb 之后抛 DbClosedError——禁止关闭后惰性重建连接池（C3.1）。
 */
export function getDb(): postgres.Sql {
  if (closed) throw new DbClosedError();
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. PostgreSQL 是 M1 起唯一正式写入路径，拒绝静默回退。',
    );
  }

  client = postgres(url, {
    // 事件写入是低频高一致性的操作，连接池保持小
    max: 5,
    // 数据库不可达时快速失败（默认等待过久：故障时应尽早暴露，而不是挂起）
    connect_timeout: 10,
    // 让 TIMESTAMPTZ 以 ISO 字符串返回，避免时区隐式转换影响回放一致性
    connection: { timezone: 'UTC' },
  });
  return client;
}

/**
 * 关闭连接池（迁移脚本/进程退出前调用）
 *
 * C3.1 生命周期语义：
 * - 幂等且并发安全：多次/并发调用返回同一个 Promise，连接池只关闭一次
 * - 调用一开始就拒绝新的 getDb（closed=true），在途查询由 postgres.js 的
 *   end({ timeout: 5 }) 宽限处理
 * - 本阶段不实现 reopenDb：关闭是终态
 */
export function closeDb(): Promise<void> {
  if (closingPromise) return closingPromise;
  closed = true;
  closingPromise = (async () => {
    const current = client;
    client = null;
    if (current) {
      await current.end({ timeout: 5 });
    }
  })();
  return closingPromise;
}

/**
 * 【仅测试使用】重置连接层全部状态（M1.2.2 故障注入测试专用）
 *
 * 用途：测试需要模拟"数据库不可达 → 恢复"场景，必须丢弃当前连接池并让
 * 下一次 getDb 用新的 DATABASE_URL 重建连接。
 *
 * 与 closeDb 的区别：不进入 closed 终态，允许后续 getDb 重新建池。
 * 生产代码禁止调用本函数——关闭路径只允许走 closeDb（终态）。
 */
export async function resetDbForTest(): Promise<void> {
  const current = client;
  client = null;
  closed = false;
  closingPromise = null;
  if (current) {
    await current.end({ timeout: 5 });
  }
}
