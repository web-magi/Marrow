/**
 * migrate.ts — 数据库迁移版本管理器
 *
 * 规则：
 * - 迁移文件位于 <项目根>/migrations/NNNN_name.sql，按文件名数字前缀排序
 * - 已应用的迁移记录在 schema_migrations 表（版本、文件名、SHA-256 校验和、应用时间）
 * - 已应用文件的校验和与磁盘内容不一致时直接失败（防止已上线迁移被篡改）
 * - 每个迁移在单独事务中执行：SQL 与版本记录同生共死
 * - 重复执行安全（幂等）：已全部应用时输出 nothing to do
 *
 * 运行：npm run db:migrate
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getDb, closeDb } from './connection.js';

interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** 读取并校验 migrations 目录 */
function loadMigrationFiles(): MigrationFile[] {
  const dir = join(process.cwd(), 'migrations');
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const files: MigrationFile[] = [];
  const seenVersions = new Set<number>();

  for (const filename of filenames) {
    const match = /^(\d+)_(.+)\.sql$/.exec(filename);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`迁移文件名不符合 NNNN_name.sql 规范: ${filename}`);
    }
    const version = parseInt(match[1], 10);
    if (seenVersions.has(version)) {
      throw new Error(`迁移版本号重复: ${version}`);
    }
    seenVersions.add(version);

    const sql = readFileSync(join(dir, filename), 'utf-8');
    files.push({
      version,
      name: match[2],
      filename,
      checksum: sha256(sql),
      sql,
    });
  }

  return files;
}

async function main(): Promise<void> {
  const sql = getDb();

  // 版本记录表（引导创建，本身不算迁移文件）
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER      PRIMARY KEY,
      name        TEXT         NOT NULL,
      checksum    TEXT         NOT NULL,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `;

  const applied = await sql<
    { version: number; checksum: string }[]
  >`SELECT version, checksum FROM schema_migrations ORDER BY version`;
  const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

  const files = loadMigrationFiles();
  let appliedCount = 0;

  for (const file of files) {
    const recordedChecksum = appliedMap.get(file.version);
    if (recordedChecksum !== undefined) {
      // 已应用：校验和必须一致，防止历史迁移被篡改
      if (recordedChecksum !== file.checksum) {
        throw new Error(
          `迁移 ${file.filename} 已被应用，但文件内容已变更（checksum 不匹配）。` +
            `已上线迁移不可修改，请新增迁移文件。`,
        );
      }
      console.log(`[skip] ${file.filename}（已应用）`);
      continue;
    }

    console.log(`[apply] ${file.filename} ...`);
    await sql.begin(async (tx) => {
      // sql.unsafe 用于执行多语句迁移脚本；内容来自受控的本地文件
      await tx.unsafe(file.sql);
      await tx`
        INSERT INTO schema_migrations (version, name, checksum)
        VALUES (${file.version}, ${file.name}, ${file.checksum})
      `;
    });
    appliedCount++;
    console.log(`[ok] ${file.filename}`);
  }

  if (appliedCount === 0) {
    console.log('nothing to do：所有迁移均已应用');
  }

  // 连接测试 + 结果摘要
  const [{ version: pgVersion }] = await sql<[{ version: string }]>`
    SELECT version()
  `;
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' ORDER BY tablename
  `;
  const [{ count: eventCount }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM events
  `;

  console.log('--- 连接测试 ---');
  console.log(`PostgreSQL: ${pgVersion}`);
  console.log(`public 表: ${tables.map((t) => t.tablename).join(', ')}`);
  console.log(`events 行数: ${eventCount}`);

  await closeDb();
}

main().catch(async (err) => {
  console.error('[migrate] 失败:', err);
  await closeDb();
  process.exit(1);
});
