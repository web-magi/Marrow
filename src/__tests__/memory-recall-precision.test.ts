/**
 * memory-recall-precision.test.ts — M1.4.8.1 召回精度校准（困难正负样本）
 *
 * 背景：M1.4.8 引入中文短语部分匹配后，出现了「3 字偶然重叠即召回」的精度问题。
 * 本文件用真实记忆关键词构造困难负样本，锁定校准后的契约：
 *
 * 正样本（必须召回）：
 *   - 原句精确命中 / 标点空格差异
 *   - 有明确回忆意图（还记得/之前…）的自然语言改写
 *   - 多个强命中共同累加
 *   - 无回忆意图但有高覆盖率连续片段（>= 4 字且 >= 64% 覆盖）
 *
 * 困难负样本（必须不召回）：
 *   - 3 字偶然重叠（含反义片段）
 *   - 不同经历共享常见片段
 *   - 多个弱匹配累加 / 弱匹配覆盖可靠匹配
 *   - 只有语用填充词、普通闲聊常见词
 *   - 高显著性但证据不足、低显著性但有回忆意图
 *   - 「还记得」不是万能钥匙：没有任何实质重叠时仍不召回
 *
 * 约束：固定时间戳与 ID，不依赖网络 / 数据库 / LLM，结果完全确定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evokeMemoryFromText } from '../state.js';
import type { EpisodicMemory } from '../events.js';

const T0 = '2026-01-01T00:00:00.000Z';

function makeMemory(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    id: overrides.id ?? 'mem-p-001',
    timestamp: overrides.timestamp ?? T0,
    summary: overrides.summary ?? '一次真实的对话经历',
    keywords: overrides.keywords ?? ['火锅'],
    valence: overrides.valence ?? 0.6,
    salience: overrides.salience ?? 0.8,
    sourceEventId: overrides.sourceEventId ?? 'evt-source-p-001',
    isTrauma: overrides.isTrauma ?? false,
  };
}

/** M1.4.7.1 真实形成的记忆关键词（原样复刻，与 rewrite 测试一致） */
const PRODUCTION_KEYWORDS = [
  '说实话',
  '这段时间我压力特别大',
  '好几次都觉得自己肯定做不好',
  '差点就放弃了',
  '现在回想起来还是很后怕',
  '也挺累的',
];

// ══════════════════════════════════════════════════════════════
// P. 困难正样本：自然语言改写仍必须召回
// ══════════════════════════════════════════════════════════════

test('[P1] 原句精确命中（最可靠的匹配方式）', () => {
  const mem = makeMemory({ id: 'mem-p1', keywords: PRODUCTION_KEYWORDS });

  assert.equal(
    evokeMemoryFromText([mem], '好几次都觉得自己肯定做不好')!.id,
    'mem-p1',
  );
});

test('[P2] 标点与空格差异不阻断召回', () => {
  const mem = makeMemory({ id: 'mem-p2', keywords: ['差点就放弃了'] });

  assert.equal(evokeMemoryFromText([mem], '我，差点 就 放弃 了！')!.id, 'mem-p2');
});

test('[P3] 有明确回忆意图的自然语言改写可召回（M1.4.7.1 C2 原话）', () => {
  const mem = makeMemory({ id: 'mem-p3', keywords: PRODUCTION_KEYWORDS });

  // 「做不好」= 3 字公共子串，覆盖率 3/14：仅因存在回忆意图（还记得）而参与召回
  assert.equal(
    evokeMemoryFromText(
      [mem],
      '你还记得我之前那个一直担心做不好、后来终于完成的项目吗？',
    )!.id,
    'mem-p3',
  );
});

test('[P4] 多个强命中累加后胜出（强匹配允许叠加）', () => {
  const twoHits = makeMemory({
    id: 'mem-p4-two',
    keywords: ['压力特别大', '差点就放弃了'],
    salience: 0.6,
  });
  const oneHit = makeMemory({
    id: 'mem-p4-one',
    keywords: ['压力特别大'],
    salience: 1.0,
  });

  // twoHits: 1 + 1 = 2 → score 1.2；oneHit: 1 → score 1.0
  assert.equal(
    evokeMemoryFromText([oneHit, twoHits], '压力特别大，差点就放弃了')!.id,
    'mem-p4-two',
  );
});

test('[P5] 无回忆意图时，高覆盖率近似短语仍可召回', () => {
  const mem = makeMemory({ id: 'mem-p5', keywords: ['今天天气真好'] });

  // 公共子串「今天天气」= 4 字，覆盖率 4/6 ≈ 0.67 → 权重 0.817 >= 0.8
  assert.equal(evokeMemoryFromText([mem], '今天天气不错')!.id, 'mem-p5');
});

test('[P6] 无回忆意图时，长关键词的过半连续覆盖可召回', () => {
  const mem = makeMemory({ id: 'mem-p6', keywords: ['这段时间我压力特别大'] });

  // 公共子串「这段时间我压力」= 7 字，覆盖率 7/10 = 0.7 → 权重 0.835
  assert.equal(evokeMemoryFromText([mem], '这段时间我压力真的很大')!.id, 'mem-p6');
});

// ══════════════════════════════════════════════════════════════
// N. 困难负样本：不能仅凭偶然片段召回
// ══════════════════════════════════════════════════════════════

test('[N1] 3 字偶然重叠不单独造成无关记忆召回（R3）', () => {
  const mem = makeMemory({ id: 'mem-n1', keywords: PRODUCTION_KEYWORDS });

  // 「做不好」3 字重叠，但语境是烹饪失败，与「项目压力」经历无关
  assert.equal(
    evokeMemoryFromText([mem], '这道菜我怎么做不好，下次不点了。'),
    null,
  );
});

test('[N2] 不同经历恰好共享同一常见片段时不召回', () => {
  const mem = makeMemory({
    id: 'mem-n2',
    keywords: ['早上那一杯咖啡让我觉得很幸福'],
  });

  // 共享「觉得很幸福」5 字，覆盖率 5/15 ≈ 0.33 → 弱匹配，不构成证据
  assert.equal(
    evokeMemoryFromText([mem], '这杯咖啡喝起来不觉得很幸福。'),
    null,
  );
});

test('[N3] 多个弱匹配不能累加越过门槛（R4）', () => {
  const mem = makeMemory({
    id: 'mem-n3',
    // 两个 7 字关键词，各自只有 4 字连续覆盖 → 权重均约 0.764（弱匹配）
    keywords: ['今天早上去跑步', '晚上回家看电影'],
  });

  // 旧算法：0.764 + 0.764 = 1.53 → 错误召回；校准后取最强单项，仍低于 0.8
  assert.equal(
    evokeMemoryFromText([mem], '今天早上出门，晚上回家就睡了'),
    null,
  );
});

test('[N4] 弱匹配不能覆盖另一条可靠匹配（R9）', () => {
  const weak = makeMemory({
    id: 'mem-n4-weak',
    keywords: ['我们周末去公园散步'],
    salience: 1.0,
  });
  const reliable = makeMemory({
    id: 'mem-n4-reliable',
    keywords: ['去公园散步'],
    salience: 0.4,
  });
  const text = '今天和朋友去公园散步';

  // 弱匹配（覆盖率 5/9 ≈ 0.56 → 0.756）单独也不应召回
  assert.equal(evokeMemoryFromText([weak], text), null);
  // 与可靠精确匹配竞争时，必须由可靠匹配胜出
  assert.equal(evokeMemoryFromText([weak, reliable], text)!.id, 'mem-n4-reliable');
});

test('[N5] 只有语用填充词时不召回（R5）', () => {
  const filler = makeMemory({ id: 'mem-n5', keywords: ['说实话', '我觉得'] });

  assert.equal(evokeMemoryFromText([filler], '说实话我觉得今天有点困'), null);
});

test('[N6] 普通闲聊碰巧包含旧记忆常见片段时不召回（R5）', () => {
  const mem = makeMemory({ id: 'mem-n6', keywords: PRODUCTION_KEYWORDS });

  assert.equal(evokeMemoryFromText([mem], '我觉得今天有点困'), null);
  assert.equal(evokeMemoryFromText([mem], '最近工作挺忙的'), null);
});

test('[N7] 两条记忆都只有弱重叠时，都不得召回（R5 / R9）', () => {
  const park = makeMemory({
    id: 'mem-n7-park',
    keywords: ['我们周末去公园散步'],
    salience: 1.0,
  });
  const coffee = makeMemory({
    id: 'mem-n7-coffee',
    keywords: ['附近新开了咖啡店'],
    salience: 1.0,
  });

  assert.equal(
    evokeMemoryFromText([park, coffee], '今天去公园附近转转'),
    null,
  );
});

test('[N8] 高显著性但证据不足时仍不召回（R6）', () => {
  const mem = makeMemory({
    id: 'mem-n8',
    keywords: ['老板今天批评我让我很沮丧'],
    salience: 1.0,
  });

  // 共享「让我很沮丧」5 字，覆盖率 5/12 ≈ 0.42 → 弱匹配
  assert.equal(evokeMemoryFromText([mem], '今天天气让我很沮丧'), null);
});

test('[N9] 反义短片段（3 字重叠）不召回', () => {
  const mem = makeMemory({ id: 'mem-n9', keywords: ['心情不错'] });

  // 「心情不」3 字重叠但语义相反；无回忆意图时 3 字不算证据
  assert.equal(evokeMemoryFromText([mem], '今天心情不好'), null);
});

test('[N10] 「还记得」不是万能钥匙：无实质重叠仍不召回', () => {
  const mem = makeMemory({ id: 'mem-n10', keywords: PRODUCTION_KEYWORDS });

  // 有回忆意图，但与任何关键词都没有 >= 3 字的公共子串
  assert.equal(evokeMemoryFromText([mem], '你还记得上次那家餐厅吗？'), null);
});

test('[N11] 低显著性记忆即使有回忆意图也不召回（R6）', () => {
  const mem = makeMemory({
    id: 'mem-n11',
    keywords: PRODUCTION_KEYWORDS,
    salience: 1e-7,
  });

  assert.equal(
    evokeMemoryFromText([mem], '你还记得之前那个做不好的项目吗？'),
    null,
  );
});

// ══════════════════════════════════════════════════════════════
// D. 确定性（R7）
// ══════════════════════════════════════════════════════════════

test('[D1] 同分保留 buffer 前项，且重复调用结果一致（R7）', () => {
  const a = makeMemory({ id: 'mem-d1-a', keywords: ['火锅'], salience: 0.7 });
  const b = makeMemory({ id: 'mem-d1-b', keywords: ['火锅'], salience: 0.7 });

  const first = evokeMemoryFromText([a, b], '想吃火锅');
  const second = evokeMemoryFromText([a, b], '想吃火锅');

  assert.equal(first!.id, 'mem-d1-a');
  assert.equal(second!.id, first!.id);
  // 顺序反转后结论对称，证明是「先出现者」而非固定 ID
  assert.equal(evokeMemoryFromText([b, a], '想吃火锅')!.id, 'mem-d1-b');
});
