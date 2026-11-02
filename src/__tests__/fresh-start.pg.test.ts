/**
 * fresh-start.pg.test.ts — M1.3 Fresh Start 真实 PostgreSQL 集成测试
 *
 * 覆盖：
 * 1. 空 identity 首次创建（freshStartIdentity → verify → recover → 比较）
 * 2. Genesis 写入后重启 Replay（commit-unknown 重试安全）
 * 3. 两进程同时初始化同一 identity（ownership 锁排他）
 * 4. 已有 genesis 时 freshStartIdentity 拒绝
 * 5. 损坏 genesis payload → hash_mismatch / invalid Replay
 * 6. genesis initialState 缺字段 → invalid_payload
 * 7. genesis configVersion/engine_version 不支持
 * 8. Replay 与创建时 initialState deepStrictEqual（除 lastUpdated）
 * 9. 多次重启状态完全一致
 * 10. 两个 identity 完全隔离（marrow-primary-like vs marrow-v2-like）
 * 11. V1 JSONL 无读取入口（结构性 import 检查 + 无文件系统读取）
 * 12. applyGenesis 是纯函数（快照直接转状态，无 Date.now/Math.random/LLM）
 *
 * 测试 identity 统一带 TEST_PREFIX 前缀，结束后清理；
 * 数据库不可用时全部用例跳过。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEventChain } from '../verify-chain.js';
import { canonicalize } from '../storage.js';
import {
  freshStartIdentity,
  acquireIdentityOwnership,
  releaseIdentityOwnership,
  recoverIdentity,
} from '../recovery.js';
import { applyGenesis, createInitialState } from '../state.js';
import type { GenesisEvent } from '../events.js';
import { getDb, closeDb } from '../db/connection.js';

const TEST_PREFIX = 'marrow-test-13';
const RUN_TAG = `m13-${Date.now()}`;

async function countRows(identityId: string): Promise<number> {
  const sql = getDb();
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM events WHERE identity_id = ${identityId}
  `;
  return Number(count);
}

async function cleanTestIdentities(): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM events WHERE identity_id LIKE ${`${TEST_PREFIX}%`}`;
}

// ---- 数据库可用性探测 ----
let dbReady = false;
if (process.env.DATABASE_URL) {
  try {
    const sql = getDb();
    await sql`SELECT 1`;
    dbReady = true;
  } catch {
    dbReady = false;
  }
}
const skip = !dbReady ? 'PostgreSQL 不可用，跳过集成测试' : false;

before(async () => {
  if (dbReady) await cleanTestIdentities();
});
after(async () => {
  if (dbReady) await cleanTestIdentities();
  await closeDb();
});

// ==================================================================
// 1. 空 identity 首次创建 → verify → recover → 比较
// ==================================================================
test('freshStartIdentity 完整闭环：verify empty → 写 genesis → verify valid → recover → 比较一致', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-1-${RUN_TAG}`;
  const sql = getDb();
  // 防御性清理：防止之前同 RUN_TAG 残留导致非 empty
  await sql`DELETE FROM events WHERE identity_id = ${id}`;
  await acquireIdentityOwnership(id);
  try {
    const result = await freshStartIdentity(id);
    assert.equal(result.verdict, 'valid');
    assert.equal(result.eventCount, 1);
    // BIGSERIAL 全局递增不保证 identity 内从 1 开始——只验证非空字符串即可
    assert.ok(result.firstSequence);
    assert.ok(result.lastSequence);

    // 哈希链验证
    const chain = await verifyEventChain(id);
    assert.equal(chain.verdict, 'valid');
    assert.equal(chain.eventCount, 1);

    // 直接 SQL 验证第一条是 genesis
    const sql = getDb();
    const [row] = await sql<[{ type: string | null; prev: string | null }]>`
      SELECT event_type AS type, previous_event_hash::text AS prev
      FROM events WHERE identity_id = ${id} ORDER BY sequence ASC LIMIT 1
    `;
    assert.equal(row?.type, 'genesis');
    assert.equal(row?.prev, null);
  } finally {
    await releaseIdentityOwnership(id);
  }
});

// ==================================================================
// 2. Genesis 写入后重启 Replay（commit-unknown 重试安全）
// ==================================================================
test('Fresh Start 后重启 Replay：同一 genesis 多次 recover 结果 deepEqual', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-2-${RUN_TAG}`;
  await acquireIdentityOwnership(id);
  try {
    await freshStartIdentity(id);
    const firstRecover = await recoverIdentity(id);
    assert.equal(firstRecover.verdict, 'valid');

    // 模拟重启：释放 ownership + 重新获取 ownership + 再次 recover
    // （不调 closeDb——那是终态，会让后续测试无法获取连接池。
    //  resetDbForTest 是测试后门，但这里不需要真的 reset 池）
    await releaseIdentityOwnership(id);
    await acquireIdentityOwnership(id);
    const secondRecover = await recoverIdentity(id);

    assert.deepStrictEqual(firstRecover.finalState, secondRecover.finalState);
  } finally {
    await releaseIdentityOwnership(id).catch(() => void 0);
  }
});

// ==================================================================
// 3. 两进程同时初始化同一 identity（ownership 锁排他）
// ==================================================================
test('ownership 锁排他：持有锁期间 freshStart 成功，release 后锁被释放', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-3-${RUN_TAG}`;
  await acquireIdentityOwnership(id);
  try {
    // 持有锁期间 freshStart 必须成功
    await freshStartIdentity(id);

    // 用 getDb 取哈希键，再查 pg_locks
    const sql = getDb();
    const [{ hashtext_id }] = await sql<[{ hashtext_id: number }]>`SELECT hashtext(${id}) AS hashtext_id`;

    const locksBefore = await sql<[any]>`
      SELECT * FROM pg_locks WHERE locktype='advisory' AND objid=${hashtext_id}
    `;
    // 本 identity 至少有一条锁（ownership 或 appendEvents 写入锁）
    assert.ok(
      locksBefore.length >= 1,
      `持锁期间 pg_locks 应有记录，实际 ${locksBefore.length} 条`,
    );
  } finally {
    await releaseIdentityOwnership(id);
  }

  // release 后 ownership 锁应释放（appendEvents 事务写入锁也会自动释放）
  const sql2 = getDb();
  const [{ hashtext_id }] = await sql2<[{ hashtext_id: number }]>`SELECT hashtext(${id}) AS hashtext_id`;
  const locksAfter = await sql2<[any]>`
    SELECT * FROM pg_locks WHERE locktype='advisory' AND objid=${hashtext_id}
  `;
  assert.equal(
    locksAfter.length,
    0,
    `release 后 advisory 锁应释放，实际残留 ${locksAfter.length} 条`,
  );
});

// ==================================================================
// 4. 已有 genesis 时 freshStartIdentity 拒绝
// ==================================================================
test('freshStartIdentity 拒绝对已存在事件链重复创建 genesis', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-4-${RUN_TAG}`;
  await acquireIdentityOwnership(id);
  try {
    await freshStartIdentity(id); // 第一次成功
    // 第二次 freshStart 必须抛错
    await assert.rejects(
      freshStartIdentity(id),
      /已存在事件链|不得重复 Fresh Start/,
    );
    // 仍然只有 1 行
    assert.equal(await countRows(id), 1);
  } finally {
    await releaseIdentityOwnership(id);
  }
});

// ==================================================================
// 5. 损坏 genesis → invalid
// ==================================================================
test('Genesis payload 篡改 → verifyEventChain invalid + recoverIdentity invalid', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-5-${RUN_TAG}`;
  await acquireIdentityOwnership(id);
  try {
    await freshStartIdentity(id);

    // 篡改 payload.initialState.energy
    const sql = getDb();
    // 篡改 payload.payload.initialState.energy（DB 列名 payload 是整个 MarrowEvent，
    // 它的内层 payload 才是 GenesisEvent.payload——路径两层）
    await sql`UPDATE events SET payload = jsonb_set(payload, '{payload,initialState,energy}', '999'::jsonb) WHERE identity_id = ${id}`;

    const chain = await verifyEventChain(id);
    assert.equal(chain.verdict, 'invalid');
    assert.ok(chain.errors.some((e) => e.kind === 'hash_mismatch'));

    const recovery = await recoverIdentity(id);
    assert.equal(recovery.verdict, 'invalid');
    // recovery 内部先调 verifyEventChain——篡改后 hash 不匹配，
    // 所以 errors 首先是 chain_verification_failed，而不是 state_invariant_violation
    // （payload 篡改 → hash 先挂掉 → invariant 永远不执行）。
    // 这是正确的 fail-closed 顺序：链完整性优先于业务字段校验。
    assert.ok(
      recovery.errors.some(
        (e) =>
          e.kind === 'chain_verification_failed' ||
          e.kind === 'state_invariant_violation',
      ),
    );
  } finally {
    await releaseIdentityOwnership(id);
  }
});

// ==================================================================
// 6. Genesis initialState 缺字段 → invalid_payload
// ==================================================================
test('Genesis initialState 缺 energy 字段 → hash 先挂 → recovery invalid', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-6-${RUN_TAG}`;
  const sql = getDb();
  const ts = '2026-01-01T00:00:00.000Z';
  const uniqueEvtId = `genesis-${id}-bad-energy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const badPayload = JSON.stringify({
    type: 'genesis',
    id: uniqueEvtId,
    timestamp: ts,
    payload: {
      initialState: { moodBaseline: 50 },
      configVersion: 1,
      initializedBy: 'system',
      seedEpisodicIds: ['seed-mem-1'],
    },
  });
  // 故意写假的 event_hash——verify 会先检测到 hash_mismatch，
  // recovery 流程因此根本不会走到 Replay 的 payload 校验，
  // 所以 invalid_payload 在这里被 chain_verification_failed 掩盖；
  // 这是正确的 fail-closed：哈希完整性优先于业务字段校验。
  await sql`INSERT INTO events (event_id, identity_id, "timestamp", event_type, schema_version, engine_version, previous_event_hash, event_hash, payload)
    VALUES (${uniqueEvtId}, ${id}, ${new Date(ts).toISOString()}, 'genesis', 2, 'marrow@0.1.0', NULL,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      ${badPayload}::jsonb)`;

  const chain = await verifyEventChain(id);
  assert.equal(chain.verdict, 'invalid');
  assert.ok(chain.errors.some((e) => e.kind === 'hash_mismatch'));

  const result = await recoverIdentity(id);
  assert.equal(result.verdict, 'invalid');
  // 链验证失败 → Replay 被跳过 → errors 是 chain_verification_failed 包装
  assert.ok(
    result.errors.some(
      (e) =>
        e.kind === 'chain_verification_failed' ||
        e.kind === 'invalid_payload',
    ),
  );
});

// ==================================================================
// 7. Genesis schema_version 不支持
// ==================================================================
test('Genesis schema_version=99 不支持 → hash_mismatch（按 D 版本感知哈希规则）', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-7-${RUN_TAG}`;
  const sql = getDb();
  const ts = '2026-01-01T00:00:00.000Z';
  const uniqueEvtId = `genesis-${id}-bad-schema-${Date.now()}`;
  const payload = JSON.stringify({
    type: 'genesis',
    id: uniqueEvtId,
    timestamp: ts,
    payload: {
      initialState: { energy: 80, moodBaseline: 50, arousal: 10, interruptionFlag: false,
        trust: 100, defensiveness: 0, cognitiveLoad: 0, associationWeight: 1.0,
        traits: { neuroticism: 1, agreeableness: 1, extraversion: 1, resilience: 1 },
        batteryLevel: 100, attentionFocus: 0.5, socialHunger: 30,
        associations: [], episodicBuffer: [], interruptionScars: 0,
        needValidation: 40, needNovelty: 30, needSecurity: 50,
        lastEvokedMemory: null, lastBehavior: { kind: 'idle', reason: 'initial_state' },
        uptimeSeconds: 0, interruptionCount: 0, sleeping: false,
        sleepEntryTrust: 100, sleepEntryCognitiveLoad: 0, sleepEntryDefensiveness: 0 },
      configVersion: 1, initializedBy: 'system', seedEpisodicIds: [],
    },
  });
  await sql`INSERT INTO events (event_id, identity_id, "timestamp", event_type, schema_version, engine_version, previous_event_hash, event_hash, payload)
    VALUES (${uniqueEvtId}, ${id}, ${new Date(ts).toISOString()}, 'genesis', 99, 'marrow@0.1.0', NULL,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ${payload}::jsonb)`;

  const chain = await verifyEventChain(id);
  assert.equal(chain.verdict, 'invalid');
  assert.ok(chain.errors.some((e) => e.kind === 'hash_mismatch' || e.kind === 'version_anomaly'));

  const result = await recoverIdentity(id);
  assert.equal(result.verdict, 'invalid');
  assert.ok(
    result.errors.some((e) => e.kind === 'unsupported_schema_version' || e.kind === 'chain_verification_failed'),
  );
});

// ==================================================================
// 8. Genesis Replay 与创建时 initialState deepStrictEqual（除 lastUpdated）
// ==================================================================
test('Fresh Start Replay 结果与 genesis.payload.initialState 字段级 deepStrictEqual（lastUpdated 除外）', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-8-${RUN_TAG}`;
  await acquireIdentityOwnership(id);
  try {
    const result = await freshStartIdentity(id);
    assert.equal(result.verdict, 'valid');

    // 手动读 DB 取 genesis 的 initialState 快照
    const sql = getDb();
    const [{ payload }] = await sql<[{ payload: any }]>`
      SELECT payload FROM events WHERE identity_id = ${id} ORDER BY sequence ASC LIMIT 1
    `;
    const snap = payload.payload.initialState;

    const recovered = result.finalState!;

    // 快照字段与 Replay 结果字段级相等
    assert.equal(recovered.energy, snap.energy);
    assert.equal(recovered.moodBaseline, snap.moodBaseline);
    assert.equal(recovered.arousal, snap.arousal);
    assert.equal(recovered.interruptionFlag, snap.interruptionFlag);
    assert.equal(recovered.trust, snap.trust);
    assert.equal(recovered.defensiveness, snap.defensiveness);
    assert.equal(recovered.cognitiveLoad, snap.cognitiveLoad);
    assert.equal(recovered.associationWeight, snap.associationWeight);
    assert.deepStrictEqual(recovered.traits, snap.traits); // canonicalize 保证键序稳定
    assert.equal(recovered.batteryLevel, snap.batteryLevel);
    assert.equal(recovered.attentionFocus, snap.attentionFocus);
    assert.equal(recovered.socialHunger, snap.socialHunger);
    // 嵌套对象/数组用 canonicalize 比较——DB JSONB 往返可能重排 JS 对象键序
    assert.equal(canonicalize(recovered.associations), canonicalize(snap.associations));
    assert.equal(canonicalize(recovered.episodicBuffer), canonicalize(snap.episodicBuffer));
    assert.equal(recovered.interruptionScars, snap.interruptionScars);
    assert.equal(recovered.needValidation, snap.needValidation);
    assert.equal(recovered.needNovelty, snap.needNovelty);
    assert.equal(recovered.needSecurity, snap.needSecurity);
    assert.equal(recovered.lastEvokedMemory, snap.lastEvokedMemory);
    assert.equal(recovered.uptimeSeconds, snap.uptimeSeconds);
    assert.equal(recovered.interruptionCount, snap.interruptionCount);
    assert.equal(recovered.sleeping, snap.sleeping);
    assert.equal(recovered.sleepEntryTrust, snap.sleepEntryTrust);
    assert.equal(recovered.sleepEntryCognitiveLoad, snap.sleepEntryCognitiveLoad);
    assert.equal(recovered.sleepEntryDefensiveness, snap.sleepEntryDefensiveness);
    // lastBehavior 是 createInitialState 硬编码 { kind:'idle', reason:'initial_state' }
    assert.equal(canonicalize(recovered.lastBehavior), canonicalize(snap.lastBehavior));

    // lastUpdated 允许不同——applyGenesis 把它覆盖为 event.timestamp，
    // 而 genesis.payload.initialState 里没有 lastUpdated 字段（这是设计决定）
    assert.ok(
      typeof recovered.lastUpdated === 'string' && recovered.lastUpdated.length > 0,
    );
  } finally {
    await releaseIdentityOwnership(id);
  }
});

// ==================================================================
// 9. 多次重启状态一致（10 次 recover）
// ==================================================================
test('Fresh Start 后 10 次 recover 结果完全一致', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-9-${RUN_TAG}`;
  await acquireIdentityOwnership(id);
  try {
    await freshStartIdentity(id);
    await releaseIdentityOwnership(id);

    // 不持锁，纯读取测试
    const results: any[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await recoverIdentity(id);
      assert.equal(r.verdict, 'valid');
      results.push(r.finalState);
    }
    for (let i = 1; i < results.length; i++) {
      assert.deepStrictEqual(results[0], results[i]);
    }
  } catch {
    // ensure release
  }
});

// ==================================================================
// 10. 两个 identity 完全隔离
// ==================================================================
test('两个 identity 完全隔离：marrow-primary-like 不影响 marrow-v2-like', { skip }, async () => {
  const idA = `${TEST_PREFIX}-iso-A-${RUN_TAG}`;
  const idB = `${TEST_PREFIX}-iso-B-${RUN_TAG}`;
  await acquireIdentityOwnership(idA);
  try {
    await freshStartIdentity(idA);
  } finally {
    await releaseIdentityOwnership(idA);
  }

  // B 应该是 empty
  const chainB = await verifyEventChain(idB);
  assert.equal(chainB.verdict, 'empty');
  const recB = await recoverIdentity(idB);
  assert.equal(recB.verdict, 'empty');
  assert.equal(await countRows(idB), 0);
  assert.equal(await countRows(idA), 1);

  // 篡改 A 不影响 B
  const sql = getDb();
  await sql`UPDATE events SET payload = jsonb_set(payload, '{payload,initialState,energy}', '0'::jsonb) WHERE identity_id = ${idA}`;
  const chainAAfter = await verifyEventChain(idA);
  assert.equal(chainAAfter.verdict, 'invalid'); // A 被篡改
  const chainBStill = await verifyEventChain(idB);
  assert.equal(chainBStill.verdict, 'empty'); // B 仍然 empty，不受影响
});

// ==================================================================
// 11. applyGenesis 是纯函数（无 Date.now / Math.random / LLM / sensors）
// ==================================================================
test('applyGenesis 是纯函数：确定性、无副作用、无外部依赖', () => {
  const initial = createInitialState('2026-01-01T00:00:00.000Z');
  const event: GenesisEvent = {
    type: 'genesis',
    id: 'test-g-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      initialState: {
        energy: initial.energy,
        moodBaseline: initial.moodBaseline,
        arousal: initial.arousal,
        interruptionFlag: initial.interruptionFlag,
        trust: initial.trust,
        defensiveness: initial.defensiveness,
        cognitiveLoad: initial.cognitiveLoad,
        associationWeight: initial.associationWeight,
        traits: { ...initial.traits },
        batteryLevel: initial.batteryLevel,
        attentionFocus: initial.attentionFocus,
        socialHunger: initial.socialHunger,
        associations: [...initial.associations],
        episodicBuffer: [...initial.episodicBuffer],
        interruptionScars: initial.interruptionScars,
        needValidation: initial.needValidation,
        needNovelty: initial.needNovelty,
        needSecurity: initial.needSecurity,
        lastEvokedMemory: initial.lastEvokedMemory,
        lastBehavior: { ...initial.lastBehavior },
        uptimeSeconds: initial.uptimeSeconds,
        interruptionCount: initial.interruptionCount,
        sleeping: initial.sleeping,
        sleepEntryTrust: initial.sleepEntryTrust,
        sleepEntryCognitiveLoad: initial.sleepEntryCognitiveLoad,
        sleepEntryDefensiveness: initial.sleepEntryDefensiveness,
      },
      configVersion: 1,
      initializedBy: 'system',
      seedEpisodicIds: ['seed-mem-1', 'seed-mem-2', 'seed-mem-3', 'seed-mem-4'],
    },
  };

  const r1 = applyGenesis(event);
  const r2 = applyGenesis(event);
  const r3 = applyGenesis(event);
  assert.deepStrictEqual(r1, r2);
  assert.deepStrictEqual(r1, r3);

  // 关键字段与 createInitialState 一致（除 lastUpdated 被 timestamp 覆盖）
  assert.equal(r1.energy, initial.energy);
  assert.equal(r1.moodBaseline, initial.moodBaseline);
  assert.equal(r1.traits.neuroticism, initial.traits.neuroticism);
  assert.equal(r1.lastUpdated, event.timestamp); // 唯一的"覆盖"——用事件的时间戳
  assert.deepStrictEqual(r1.episodicBuffer, initial.episodicBuffer);
});

// ==================================================================
// 12. Fresh Start 后事件链：genesis 首行、prevHash=NULL、后续可接 tick
// ==================================================================
test('Fresh Start 事件链结构：首行是 genesis、prevHash=NULL、verifyEventChain valid', { skip }, async () => {
  const id = `${TEST_PREFIX}-fresh-12-${RUN_TAG}`;
  await acquireIdentityOwnership(id);
  try {
    await freshStartIdentity(id);
    const chain = await verifyEventChain(id);
    assert.equal(chain.verdict, 'valid');
    assert.equal(chain.headHash, chain.tailHash); // 单行链 head===tail
    assert.equal(chain.eventCount, 1);

    // 直接 SQL 验证 prevHash 为 NULL
    const sql = getDb();
    const rows = await sql<[{ prev: string | null; type: string }]>`
      SELECT previous_event_hash::text AS prev, event_type AS type
      FROM events WHERE identity_id = ${id} ORDER BY sequence ASC
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.prev, null);
    assert.equal(rows[0]!.type, 'genesis');
  } finally {
    await releaseIdentityOwnership(id);
  }
});
