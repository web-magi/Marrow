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
 * 获取数据库客户端（惰性单例）。
 * DATABASE_URL 缺失时抛错——PostgreSQL 是唯一正式写入路径，不允许静默降级。
 */
export function getDb(): postgres.Sql {
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
    // 让 TIMESTAMPTZ 以 ISO 字符串返回，避免时区隐式转换影响回放一致性
    connection: { timezone: 'UTC' },
  });
  return client;
}

/** 关闭连接池（迁移脚本/进程退出前调用） */
export async function closeDb(): Promise<void> {
  if (!client) return;
  await client.end({ timeout: 5 });
  client = null;
}
