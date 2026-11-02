/**
 * storage.test.ts — 规范化序列化 / 哈希 / JSON 安全边界单元测试（M1.2.2）
 *
 * 全部纯函数测试，不连接数据库：
 * - canonicalize 的确定性、键序无关、数组/非纯对象语义
 * - computeEventHash 的确定性与字段敏感性
 * - assertJsonSafe 对会被 JSONB 静默改写的输入显式拒绝
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertJsonSafe,
  canonicalize,
  computeEventHash,
  ENGINE_VERSION,
  SCHEMA_VERSION,
} from '../storage.js';
import type { MarrowEvent, TickEvent } from '../events.js';

/** 固定 tick 事件工厂（无随机、无时钟） */
function tick(id: string, deltaSeconds = 10, timestamp = '2026-01-01T00:00:00.000Z'): TickEvent {
  return { type: 'tick', id, timestamp, payload: { deltaSeconds } };
}

interface HashOptions {
  identityId?: string;
  schemaVersion?: number;
  engineVersion?: string | null;
  causationId?: string;
  correlationId?: string;
  previousEventHash?: string | null;
}

function hashOf(event: MarrowEvent, opts: HashOptions = {}): string {
  return computeEventHash({
    identityId: opts.identityId ?? 'marrow-primary',
    // 默认使用当前全局版本；版本化测试会显式覆盖
    schemaVersion: opts.schemaVersion ?? SCHEMA_VERSION,
    engineVersion: opts.engineVersion ?? ENGINE_VERSION,
    causationId: opts.causationId ?? null,
    correlationId: opts.correlationId ?? null,
    previousEventHash: opts.previousEventHash ?? null,
    event,
  });
}

test('canonicalize：对象键序无关，嵌套对象同样排序', () => {
  assert.equal(
    canonicalize({ b: 1, a: 2, nested: { y: true, x: [3, 1] } }),
    canonicalize({ nested: { x: [3, 1], y: true }, a: 2, b: 1 }),
  );
  assert.equal(
    canonicalize({ a: 2, b: 1 }),
    '{"a":2,"b":1}',
  );
});

test('canonicalize：数组保持顺序，undefined 元素按 JSON 语义转为 null', () => {
  assert.equal(canonicalize([1, 'x', null, true]), '[1,"x",null,true]');
  assert.equal(canonicalize([1, undefined, 2]), '[1,null,2]');
  // 嵌套数组中的 undefined 同理
  assert.equal(canonicalize({ a: [undefined] }), '{"a":[null]}');
});

test('canonicalize：对象属性 undefined 被剔除（与 JSONB 一致）', () => {
  const withUndefined = { a: 1, b: undefined, c: { d: undefined, e: 2 } };
  const without = { a: 1, c: { e: 2 } };
  assert.equal(canonicalize(withUndefined), canonicalize(without));
  assert.equal(canonicalize(withUndefined), '{"a":1,"c":{"e":2}}');
});

test('canonicalize：非纯对象走 JSON.stringify 的 toJSON 语义，不退化为 {}', () => {
  const date = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(canonicalize(date), '"2026-01-01T00:00:00.000Z"');
  assert.equal(canonicalize({ at: date }), '{"at":"2026-01-01T00:00:00.000Z"}');
});

test('canonicalize：顶层 undefined / function 显式抛错，不返回 undefined', () => {
  assert.throws(() => canonicalize(undefined), /顶层值不可序列化/);
  assert.throws(() => canonicalize(() => 1), /顶层值不可序列化/);
});

test('canonicalize：数值规范化与 JSON.stringify 一致（1.0 与 1 等价）', () => {
  assert.equal(canonicalize(1.0), canonicalize(1));
  assert.equal(canonicalize(-123.456), '-123.456');
  assert.equal(canonicalize(0.1 + 0.2), '0.30000000000000004');
});

test('computeEventHash：同一输入恒等，64 位小写十六进制', () => {
  const h1 = hashOf(tick('tick-a'));
  const h2 = hashOf(tick('tick-a'));
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('computeEventHash：对 payload 键序不敏感', () => {
  const a = {
    type: 'tick',
    id: 'tick-k',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { deltaSeconds: 10, extra: { z: 1, a: 2 } },
  } as unknown as TickEvent;
  const b = {
    type: 'tick',
    id: 'tick-k',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { extra: { a: 2, z: 1 }, deltaSeconds: 10 },
  } as unknown as TickEvent;
  assert.equal(hashOf(a), hashOf(b));
});

test('computeEventHash：对 identity / causation / correlation / previous 哈希敏感', () => {
  const event = tick('tick-s');
  const base = hashOf(event);
  assert.notEqual(hashOf(event, { identityId: 'marrow-sim' }), base);
  assert.notEqual(hashOf(event, { causationId: 'cause-1' }), base);
  assert.notEqual(hashOf(event, { correlationId: 'corr-1' }), base);
  assert.notEqual(hashOf(event, { previousEventHash: 'a'.repeat(64) }), base);
});

test('computeEventHash：对事件内容敏感（id / timestamp / payload）', () => {
  const base = hashOf(tick('tick-c'));
  assert.notEqual(hashOf(tick('tick-c', 10, '2026-01-01T00:00:01.000Z')), base);
  assert.notEqual(hashOf(tick('tick-d')), base);
  assert.notEqual(hashOf(tick('tick-c', 11)), base);
});

test('computeEventHash：版本显式参与哈希（同事件不同版本结果不同，同版本稳定）', () => {
  const event = tick('tick-v');
  const base = hashOf(event);

  // 同版本重复计算必须稳定
  assert.equal(hashOf(event, { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION }), base);

  // schemaVersion 不同 → 哈希不同
  assert.notEqual(hashOf(event, { schemaVersion: SCHEMA_VERSION - 1 }), base);

  // engineVersion 不同 → 哈希不同
  assert.notEqual(hashOf(event, { engineVersion: `${ENGINE_VERSION}-legacy` }), base);

  // 两个版本同时不同 → 哈希不同
  assert.notEqual(
    hashOf(event, {
      schemaVersion: SCHEMA_VERSION - 1,
      engineVersion: `${ENGINE_VERSION}-legacy`,
    }),
    base,
  );
});

test('assertJsonSafe：接受合法 JSON 值（含 null / 空数组 / 嵌套 / Unicode）', () => {
  assert.doesNotThrow(() =>
    assertJsonSafe({
      deltaSeconds: 10,
      float: 0.1 + 0.2,
      tiny: 1e-7,
      bigSafe: 9007199254740991,
      nothing: null,
      empty: [],
      nested: { a: { b: [1, 2, { c: '中文' }] } },
      unicode: '中文 emoji 😀 café',
      optional: undefined, // 对象属性 undefined 会被剔除，合法
    }),
  );
});

test('assertJsonSafe：拒绝 NaN / Infinity / BigInt / 非纯对象，-0 按 JSON 语义规范化', () => {
  assert.throws(() => assertJsonSafe({ v: NaN }), /非有限数值/);
  assert.throws(() => assertJsonSafe({ v: Infinity }), /非有限数值/);
  assert.throws(() => assertJsonSafe({ v: -Infinity }), /非有限数值/);
  assert.throws(() => assertJsonSafe({ v: 10n }), /bigint/);
  assert.throws(() => assertJsonSafe({ v: new Date() }), /非纯对象/);
  assert.throws(() => assertJsonSafe({ v: new Map() }), /非纯对象/);
  // -0 会被 JSON.stringify / JSONB 规范化为 0，canonicalize 输出一致，不拒绝
  assert.doesNotThrow(() => assertJsonSafe({ v: -0 }));
  assert.equal(canonicalize(-0), '0');
});

test('assertJsonSafe：拒绝数组元素 undefined 与 U+0000', () => {
  assert.throws(() => assertJsonSafe({ arr: [1, undefined] }), /数组元素为 undefined/);
  assert.throws(() => assertJsonSafe({ s: 'a\u0000b' }), /U\+0000/);
});

test('assertJsonSafe：拒绝顶层 undefined / function / symbol', () => {
  assert.throws(() => assertJsonSafe(undefined), /undefined/);
  assert.throws(() => assertJsonSafe(() => 1), /function/);
  assert.throws(() => assertJsonSafe(Symbol('x')), /symbol/);
});
