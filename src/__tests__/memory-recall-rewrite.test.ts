/**
 * memory-recall-rewrite.test.ts — M1.4.8 自然语言改写召回回归
 *
 * 背景：M1.4.7.1 真实对话验收发现召回强依赖完整关键词片段，
 * 用户改写表达后无法召回（P1-1）。本文件锁定新的确定性匹配契约：
 *   - 精确子串命中仍然可靠（权重 1）
 *   - 中文短语允许 >= 3 字的最长公共子串部分命中（权重 0.45~1）
 *   - 2 字常见短词、语用填充词不能单独构成召回证据
 *   - 低显著性 / 弱匹配不通过
 *   - 同输入同 buffer 结果完全确定
 *
 * 约束：固定时间戳与 ID，不依赖网络 / 数据库 / LLM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evokeMemoryFromText } from '../state.js';
import type { EpisodicMemory } from '../events.js';

const T0 = '2026-01-01T00:00:00.000Z';

function makeMemory(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    id: overrides.id ?? 'mem-r-001',
    timestamp: overrides.timestamp ?? T0,
    summary: overrides.summary ?? '一次真实的对话经历',
    keywords: overrides.keywords ?? ['火锅'],
    valence: overrides.valence ?? 0.6,
    salience: overrides.salience ?? 0.8,
    sourceEventId: overrides.sourceEventId ?? 'evt-source-r-001',
    isTrauma: overrides.isTrauma ?? false,
  };
}

/** M1.4.7.1 真实形成的记忆关键词（原样复刻） */
const PRODUCTION_KEYWORDS = [
  '说实话',
  '这段时间我压力特别大',
  '好几次都觉得自己肯定做不好',
  '差点就放弃了',
  '现在回想起来还是很后怕',
  '也挺累的',
];

test('[R1] 精确关键词命中仍然可靠', () => {
  const mem = makeMemory({ id: 'mem-r1', keywords: ['火锅'] });

  assert.equal(evokeMemoryFromText([mem], '今晚吃火锅')!.id, 'mem-r1');
});

test('[R2] 标点与空白差异不阻断召回', () => {
  const mem = makeMemory({ id: 'mem-r2', keywords: ['差点就放弃了'] });

  // 归一化后为「我差点就放弃了」，与关键词完全一致
  const recalled = evokeMemoryFromText([mem], '我，差点 就 放弃 了！');

  assert.equal(recalled!.id, 'mem-r2');
});

test('[R3] 中文短语改写可召回（M1.4.7.1 C2 真实原话）', () => {
  const mem = makeMemory({ id: 'mem-r3', keywords: PRODUCTION_KEYWORDS });

  const recalled = evokeMemoryFromText(
    [mem],
    '你还记得我之前那个一直担心做不好、后来终于完成的项目吗？',
  );

  assert.equal(recalled?.id, 'mem-r3', '「做不好」构成 3 字公共子串，应召回原记忆');
});

test('[R4] 多个有意义关键词共同命中时置信度更高并胜出', () => {
  const twoHits = makeMemory({
    id: 'mem-r4-two',
    keywords: ['压力特别大', '差点就放弃了'],
    salience: 0.6,
  });
  const oneHit = makeMemory({
    id: 'mem-r4-one',
    keywords: ['压力特别大'],
    salience: 0.6,
  });

  const recalled = evokeMemoryFromText(
    [oneHit, twoHits],
    '压力特别大，差点就放弃了',
  );

  assert.equal(recalled!.id, 'mem-r4-two');
});

test('[R5] 只有 2 字常见短词命中时不召回', () => {
  const project = makeMemory({ id: 'mem-r5-project', keywords: ['完成项目很开心'] });
  const coffee = makeMemory({ id: 'mem-r5-coffee', keywords: ['喜欢咖啡'] });

  assert.equal(evokeMemoryFromText([project], '我觉得项目挺开心'), null);
  assert.equal(evokeMemoryFromText([coffee], '我挺喜欢这杯的'), null);
});

test('[R6] 低信息量填充词命中不构成召回证据', () => {
  const filler = makeMemory({ id: 'mem-r6', keywords: ['说实话'] });

  assert.equal(evokeMemoryFromText([filler], '说实话今天好累'), null);

  // 同一记忆存在有效关键词时，填充词不会阻止正常召回
  const mixed = makeMemory({ id: 'mem-r6-mixed', keywords: ['说实话', '差点就放弃了'] });
  assert.equal(
    evokeMemoryFromText([mixed], '说实话我差点就放弃了')!.id,
    'mem-r6-mixed',
  );
});

test('[R7] 无关文本返回 null', () => {
  const mem = makeMemory({ id: 'mem-r7', keywords: PRODUCTION_KEYWORDS });

  assert.equal(evokeMemoryFromText([mem], '今天东京的天气怎么样？'), null);
});

test('[R8] 相同输入与 buffer 必须得到相同结果', () => {
  const a = makeMemory({ id: 'mem-r8-a', keywords: ['火锅'], salience: 0.7 });
  const b = makeMemory({ id: 'mem-r8-b', keywords: ['火锅'], salience: 0.7 });

  const first = evokeMemoryFromText([a, b], '想吃火锅');
  const second = evokeMemoryFromText([a, b], '想吃火锅');

  assert.equal(first!.id, 'mem-r8-a', '同分保留 buffer 前项');
  assert.equal(second!.id, first!.id, '重复调用结果必须一致');
});

test('[R9] 低显著性或弱匹配不通过最低召回条件', () => {
  const decayed = makeMemory({
    id: 'mem-r9-decayed',
    keywords: ['好几次都觉得自己肯定做不好'],
    salience: 1e-7,
  });
  assert.equal(
    evokeMemoryFromText([decayed], '一直担心做不好'),
    null,
    'salience 低于 1e-6 不召回',
  );

  const weak = makeMemory({ id: 'mem-r9-weak', keywords: ['今天天气真好'] });
  assert.equal(
    evokeMemoryFromText([weak], '天气不错'),
    null,
    '公共子串 < 3 字不构成部分匹配',
  );
});
