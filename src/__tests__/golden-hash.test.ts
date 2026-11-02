/**
 * golden-hash.test.ts — computeEventHash 固定预期值测试向量（M1.2.5）
 *
 * 核心目的：防御 computeEventHash 定义本身漂移。
 *   共享 computeEventHash 的所有模块（写入方、verifyEventChain、replayPersistedEvents）
 *   都依赖同一哈希定义；若 canonicalize 或 SHA-256 更新出现回归，
 *   固定预期值测试会在 CI 里立即暴露。
 *
 * 关键约束：
 * - 测试向量预期值是**硬编码**的固定字符串，不通过当前实现动态生成；
 *   这是本测试防止共模失效的根本——如果把预期值设为 computeEventHash(...) 再 assertEqual，
 *   实现漂移会同时让"生成的预期值"和"被测值"一起变化，失去检测能力。
 * - 不改变现有哈希算法；不重写历史事件；不修改已存在的数据库记录。
 * - 本测试只验证**确定性与稳定性**，不访问数据库，不涉及 PG 集成。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, computeEventHash } from '../storage.js';

// ==================================================================
// 固定输入 —— 预期值是一次性手工计算并硬编码的 SHA-256 十六进制
// ==================================================================

/** Vector 1: Genesis tick，identity='golden-test'，schema=2，engine=marrow@0.1.0，prevHash=null */
const V1_INPUT = {
  identityId: 'golden-test',
  schemaVersion: 2,
  engineVersion: 'marrow@0.1.0',
  causationId: null,
  correlationId: null,
  previousEventHash: null as string | null,
  event: {
    type: 'tick' as const,
    id: 'golden-genesis-0',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { deltaSeconds: 10 },
  },
};
const V1_HASH = '21ffe1d59ccea2cb502fecbcef9a3e78610217160ce34c4cea7220a2a71bbcd0';

/** Vector 2: Tick #1，prevHash=Vector 1 的 hash（连续链） */
const V2_INPUT = {
  ...V1_INPUT,
  previousEventHash: V1_HASH,
  event: {
    type: 'tick' as const,
    id: 'golden-seq-1',
    timestamp: '2026-01-01T00:00:10.000Z',
    payload: { deltaSeconds: 100 },
  },
};
const V2_HASH = '90c9a14b10298b4b8eda17c6a36ffbf64ab14eaea9bd2f781d4c711c25672491';

/** Vector 3: Dialogue user_input，prevHash=Vector 2 的 hash */
const V3_INPUT = {
  ...V1_INPUT,
  previousEventHash: V2_HASH,
  event: {
    type: 'dialogue' as const,
    id: 'golden-chat',
    timestamp: '2026-01-01T00:00:20.000Z',
    payload: { direction: 'user_input' as const, text: 'hello world', moodDelta: 2, salience: 0.5 },
  },
};
const V3_HASH = '667724abd9c8c60dea9e2b8e1e993619fe6c0669ba249a9a02a1d63a448694f1';

/** Vector 4: Sleep 事件（最小合法 payload） */
const V4_INPUT = {
  ...V1_INPUT,
  previousEventHash: null,
  event: {
    type: 'sleep' as const,
    id: 'golden-sleep',
    timestamp: '2026-01-01T00:00:30.000Z',
    payload: { entering: true },
  },
};
const V4_HASH = '700c9683046786bed3eb89009f453f63465ccdda3ad2180ec181accc27f8db8a';

/** Vector 5: 旧版本 schema=1 + engine=null（V5 单独 prevHash=null） */
const V5_INPUT = {
  identityId: 'golden-test',
  schemaVersion: 1,
  engineVersion: null,
  causationId: null,
  correlationId: null,
  previousEventHash: null as string | null,
  event: {
    type: 'tick' as const,
    id: 'golden-legacy',
    timestamp: '2026-01-01T00:00:40.000Z',
    payload: { deltaSeconds: 60 },
  },
};
const V5_HASH = '62707a88e48ecd1b14d44c47e823c671d65afc8f02bd5abc20416b4ab22f0e20';

/** Vector 6: 嵌套 environment（带 causation/correlation + 嵌套对象与数组） */
const V6_INPUT = {
  identityId: 'golden-test',
  schemaVersion: 2,
  engineVersion: 'marrow@0.1.0',
  causationId: 'cause-abc',
  correlationId: 'corr-xyz',
  previousEventHash: null as string | null,
  event: {
    type: 'environment' as const,
    id: 'golden-env',
    timestamp: '2026-01-01T00:00:50.000Z',
    payload: {
      feature: 'light',
      reading: 3.14159,
      moodDelta: 0.5,
      salience: 0.3,
      nested: { a: 1, b: [true, null] },
    },
  },
};
const V6_HASH = 'e33167dc03f24d52d1c0c8e6bf9c0bc222c99a3d0edb11896f4f5f7ee958b75d';

// ==================================================================
// canonicalize 固定预期值（依赖对象键排序）
// ==================================================================
const V1_CANONICAL =
  '{"causation_id":null,"correlation_id":null,"engine_version":"marrow@0.1.0",' +
  '"event":{"id":"golden-genesis-0","payload":{"deltaSeconds":10},' +
  '"timestamp":"2026-01-01T00:00:00.000Z","type":"tick"},' +
  '"identity_id":"golden-test","previous_event_hash":null,"schema_version":2}';

// ==================================================================
// 测试
// ==================================================================

test('canonicalize 固定预期值：对象键按字典序、null 显式、嵌套结构正确', () => {
  const canonical = canonicalize({
    causation_id: null,
    correlation_id: null,
    engine_version: 'marrow@0.1.0',
    event: {
      payload: { deltaSeconds: 10 },
      timestamp: '2026-01-01T00:00:00.000Z',
      id: 'golden-genesis-0',
      type: 'tick',
    },
    identity_id: 'golden-test',
    previous_event_hash: null,
    schema_version: 2,
  });
  assert.equal(
    canonical,
    V1_CANONICAL,
    'canonicalize 输出键序或格式与固定预期值不一致——哈希依赖此格式',
  );
});

test('Golden Hash V1：genesis tick（prevHash=null）', () => {
  assert.equal(computeEventHash(V1_INPUT), V1_HASH);
});

test('Golden Hash V2：tick #1，prevHash=V1（连续链）', () => {
  assert.equal(computeEventHash(V2_INPUT), V2_HASH);
});

test('Golden Hash V3：dialogue user_input，prevHash=V2（连续链）', () => {
  assert.equal(computeEventHash(V3_INPUT), V3_HASH);
});

test('Golden Hash V4：sleep 最小 payload', () => {
  assert.equal(computeEventHash(V4_INPUT), V4_HASH);
});

test('Golden Hash V5：旧版本 schema=1 + engine=null（版本参数影响哈希）', () => {
  assert.equal(computeEventHash(V5_INPUT), V5_HASH);
});

test('Golden Hash V6：嵌套 environment + causation/correlation + 嵌套对象/数组', () => {
  assert.equal(computeEventHash(V6_INPUT), V6_HASH);
});

test('连续哈希链稳定性：V1→V2→V3 同 identity 严格单调推进', () => {
  const chain = [V1_INPUT, V2_INPUT, V3_INPUT];
  const expected = [V1_HASH, V2_HASH, V3_HASH];
  const results = chain.map((c) => computeEventHash(c));
  assert.deepStrictEqual(results, expected);
  // 链式推进：每步 previousEventHash 必须等于上一步 hash
  assert.equal(V2_INPUT.previousEventHash, V1_HASH);
  assert.equal(V3_INPUT.previousEventHash, V2_HASH);
});

test('engine_version 参数改变 → 哈希改变（防版本化哈希漂移）', () => {
  const samePayloadDifferentEngine = {
    ...V1_INPUT,
    engineVersion: 'marrow@0.2.0',
  };
  assert.notEqual(
    computeEventHash(samePayloadDifferentEngine),
    V1_HASH,
    'engine_version 必须参与哈希计算',
  );
});

test('schema_version 参数改变 → 哈希改变', () => {
  const samePayloadDifferentSchema = { ...V1_INPUT, schemaVersion: 1 };
  assert.notEqual(
    computeEventHash(samePayloadDifferentSchema),
    V1_HASH,
    'schema_version 必须参与哈希计算',
  );
});

test('identityId 改变 → 哈希改变', () => {
  const otherIdentity = { ...V1_INPUT, identityId: 'other-test' };
  assert.notEqual(
    computeEventHash(otherIdentity),
    V1_HASH,
    'identity_id 必须参与哈希计算',
  );
});
