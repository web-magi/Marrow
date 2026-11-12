/**
 * memory-extraction-integrity.test.ts — M1.4.9 记忆提取完整性与情绪语义校准
 *
 * 覆盖：
 *   D1 用户经历极性（experienceValence）
 *   D2 回应动作（action）与经历极性解耦
 *   D3 混合情绪
 *   D4 结构化 JSON 解析的十种边界
 *   D5 记忆形成回归（含解析失败不形成、回忆不回声）
 *   D6 Replay 冻结与确定性
 *
 * 全部使用固定 ID、固定时间戳、固定输入，不依赖真实 LLM / 数据库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExtraction,
  isMemoryFormationEligible,
  type ExtractionResult,
} from '../llm.js';
import {
  applyEvent,
  createInitialState,
  computeEpisodicMemoryCandidate,
  type MarrowState,
} from '../state.js';
import { canonicalize } from '../storage.js';
import type { DialogueEvent, MemoryFormationEvent } from '../events.js';

const TS = '2026-01-01T00:00:00.000Z';

/** 固定 attentionFocus=0.5 → attentionMod=0.65；neuroticism=1.0 */
function makeState(): MarrowState {
  return createInitialState(TS);
}

/** 构造一条 user_input DialogueEvent（只填记忆形成所需字段） */
function makeUserEvent(
  id: string,
  text: string,
  action: DialogueEvent['payload']['action'],
  intensity: number,
): DialogueEvent {
  return {
    type: 'dialogue',
    id,
    timestamp: TS,
    payload: {
      direction: 'user_input',
      text,
      action,
      intensity,
      moodDelta: 2.0,
      salience: 0.3,
      wordCount: text.length,
    },
  } as DialogueEvent;
}

/** 构造一个成功解析的提取 JSON（字段顺序可自定义） */
function extractionJson(
  action: string,
  experienceValence: number,
  intensity = 0.9,
): string {
  return JSON.stringify({
    text: '回复',
    action,
    intensity,
    confidence: 0.8,
    facts: [],
    experienceValence,
    uncertainty: 0.2,
  });
}

/** 解析并计算记忆候选（模拟生产链：解析 → 准入 → 候选） */
function formFrom(
  raw: string,
  state: MarrowState,
  event: DialogueEvent,
  baseValence = 2.0,
) {
  const extraction = parseExtraction(raw);
  if (!isMemoryFormationEligible(extraction)) return null;
  return computeEpisodicMemoryCandidate(
    state,
    event,
    baseValence,
    extraction.experienceValence,
  );
}

// ══════════════════════════════════════════════════════════════════════
// D1：情绪极性
// ══════════════════════════════════════════════════════════════════════

test('D1-1 正面经历 → 正面 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d1-1', '我终于完成了准备很久的项目，非常开心', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0.8), s, ev);
  assert.ok(mem);
  assert.equal(mem!.valence, 0.8);
  assert.ok(mem!.valence > 0);
});

test('D1-2 项目压力经历 → 负面 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d1-2', '项目压力特别大，我担心自己做不好', 'complaint', 0.9);
  const mem = formFrom(extractionJson('complaint', -0.7), s, ev);
  assert.ok(mem);
  assert.equal(mem!.valence, -0.7);
  assert.ok(mem!.valence < 0);
});

test('D1-3 猫走丢 → 负面 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d1-3', '我的猫走丢了，我急得快哭了', 'complaint', 0.9);
  const mem = formFrom(extractionJson('complaint', -0.9), s, ev);
  assert.ok(mem);
  assert.equal(mem!.valence, -0.9);
});

test('D1-4 手冲咖啡幸福 → 正面 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d1-4', '今天手冲咖啡，喝第一口觉得特别幸福', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0.8), s, ev);
  assert.ok(mem);
  assert.equal(mem!.valence, 0.8);
});

test('D1-5 中性日常 → valence 为 0，不强制正负', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d1-5', '今天正常吃了一顿午饭', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0), s, ev);
  assert.ok(mem);
  assert.equal(mem!.valence, 0);
});

test('D1-6 完成但痛苦 → 允许接近中性的混合效价', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d1-6', '项目终于完成了，但过程让我非常痛苦', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', -0.1), s, ev);
  assert.ok(mem);
  assert.equal(mem!.valence, -0.1);
  assert.ok(Math.abs(mem!.valence) < 0.3, '混合情绪不得被压成强正/强负');
});

// ══════════════════════════════════════════════════════════════════════
// D2：回应动作与经历极性解耦
// ══════════════════════════════════════════════════════════════════════

test('D2-1 comfort + 负面经历 → 负面 valence（不被回应动作染成正）', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d2-1', '猫走丢了我很难受', 'comfort', 0.9);
  // Marrow 的 appraisal 对 comfort 是正影响（baseValence=+2.0），但经历本身是负面的
  const mem = formFrom(extractionJson('comfort', -0.6), s, ev, 2.0);
  assert.ok(mem);
  assert.equal(mem!.valence, -0.6);
});

test('D2-2 comfort + 正面经历 → 正面 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d2-2', '今天特别开心', 'comfort', 0.9);
  const mem = formFrom(extractionJson('comfort', 0.6), s, ev, 2.0);
  assert.ok(mem);
  assert.equal(mem!.valence, 0.6);
});

test('D2-3 compliment（鼓励类正向回应）+ 负面经历 → 负面 valence', () => {
  // 说明：当前 DialogueAction 枚举没有独立的 encourage；用同样是正向回应的
  // compliment 代表“鼓励类动作”，验证动作与经历极性解耦（不修改 Event Schema）。
  const s = makeState();
  const ev = makeUserEvent('evt-d2-3', '我担心自己做不好', 'compliment', 0.9);
  const mem = formFrom(extractionJson('compliment', -0.6), s, ev, -2.0);
  assert.ok(mem);
  assert.equal(mem!.valence, -0.6);
});

test('D2-4 question + 正面经历 → 正面 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d2-4', '我最近特别顺利', 'question', 0.9);
  const mem = formFrom(extractionJson('question', 0.6), s, ev, 1.6);
  assert.ok(mem);
  assert.equal(mem!.valence, 0.6);
});

test('D2-5 action=unknown 不得形成记忆，也不得推导正面 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d2-5', '今天发生了一件事', 'unknown', 0.9);
  const mem = formFrom(extractionJson('unknown', 0.8), s, ev, 2.0);
  assert.equal(mem, null);
});

// ══════════════════════════════════════════════════════════════════════
// D3：混合情绪
// ══════════════════════════════════════════════════════════════════════

test('D3-1 离职开心但舍不得同事 → 混合效价接近 0', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d3-1', '终于离职了，很开心，但也舍不得同事', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0.05), s, ev);
  assert.ok(mem);
  assert.ok(Math.abs(mem!.valence) < 0.3);
});

test('D3-2 项目完成但被消耗 → 保留负向但不过度', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d3-2', '项目完成了，但我感觉自己被消耗得很严重', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', -0.2), s, ev);
  assert.ok(mem);
  assert.equal(mem!.valence, -0.2);
  assert.ok(Math.abs(mem!.valence) < 0.5);
});

// ══════════════════════════════════════════════════════════════════════
// D4：JSON 解析十种边界
// ══════════════════════════════════════════════════════════════════════

test('D4-1 正常 JSON → success 且字段正确', () => {
  const r = parseExtraction(extractionJson('complaint', -0.7, 0.8));
  assert.equal(r.status, 'success');
  assert.equal(r.action, 'complaint');
  assert.equal(r.intensity, 0.8);
  assert.equal(r.experienceValence, -0.7);
});

test('D4-2 JSON 前后有说明文字 → success', () => {
  const r = parseExtraction(`好的，下面是结果：\n${extractionJson('statement', 0.5)}\n希望有帮助。`);
  assert.equal(r.status, 'success');
  assert.equal(r.action, 'statement');
  assert.equal(r.experienceValence, 0.5);
});

test('D4-3 Markdown 代码块 → success', () => {
  const r = parseExtraction('```json\n' + extractionJson('comfort', -0.4) + '\n```');
  assert.equal(r.status, 'success');
  assert.equal(r.action, 'comfort');
  assert.equal(r.experienceValence, -0.4);
});

test('D4-4 字段顺序不同 → success', () => {
  const r = parseExtraction(
    '{"experienceValence":0.3,"facts":[],"uncertainty":0.1,"action":"statement","intensity":0.6,"confidence":0.9,"text":"好"}',
  );
  assert.equal(r.status, 'success');
  assert.equal(r.action, 'statement');
  assert.equal(r.experienceValence, 0.3);
  // 模型没有给状态，但有明确非 0 数值 → 按数值派生 observed（不伪造 mixed/neutral）
  assert.equal(r.experienceValenceStatus, 'observed');
});

test('D4-5 合法可选字段缺失 → success 且取保守默认值', () => {
  const r = parseExtraction('{"action":"statement"}');
  assert.equal(r.status, 'success');
  assert.equal(r.intensity, 0.3);
  assert.equal(r.confidence, 0.5);
  assert.deepEqual(r.facts, []);
  assert.equal(r.experienceValence, undefined); // 信息不足 → 无数值，不伪造中性
  assert.equal(r.experienceValenceStatus, 'unknown');
});

test('D4-6 关键字段类型错误 → invalid_schema', () => {
  assert.equal(
    parseExtraction('{"action":"statement","intensity":"0.8"}').status,
    'invalid_schema',
  );
  assert.equal(
    parseExtraction('{"action":"statement","experienceValence":"positive"}').status,
    'invalid_schema',
  );
  assert.equal(parseExtraction('{"action":123}').status, 'invalid_schema');
  assert.equal(
    parseExtraction('{"action":"statement","facts":"not-an-array"}').status,
    'invalid_schema',
  );
});

test('D4-7 JSON 截断 → invalid_json', () => {
  const r = parseExtraction('{"action":"statement","intensity":0.8,"experienceValence":0.5');
  assert.equal(r.status, 'invalid_json');
});

test('D4-8 JSON 内部混入无法解析的文本 → invalid_json', () => {
  const r = parseExtraction('{"action":"statement", oops: 1, "intensity":0.8}');
  assert.equal(r.status, 'invalid_json');
});

test('D4-9 多个顶层 JSON 对象 → ambiguous_output，不随机选取', () => {
  const r = parseExtraction(
    extractionJson('statement', 0.5) + '\n' + extractionJson('complaint', -0.5),
  );
  assert.equal(r.status, 'ambiguous_output');
});

test('D4-10 空内容 / 非 JSON → invalid_json', () => {
  assert.equal(parseExtraction('').status, 'invalid_json');
  assert.equal(parseExtraction('   ').status, 'invalid_json');
  assert.equal(parseExtraction('今天天气不错').status, 'invalid_json');
});

test('D4-11 解析失败不产生记忆（准入被拒绝）', () => {
  const failures = [
    '',
    '今天天气不错',
    '{"action":"statement","intensity":0.8,"experienceValence":0.5',
    '{"action":"statement","experienceValence":"bad"}',
    extractionJson('statement', 0.5) + extractionJson('complaint', -0.5),
  ];
  const s = makeState();
  const ev = makeUserEvent('evt-d4-11', '我今天特别开心', 'unknown', 0.9);
  for (const raw of failures) {
    const r: ExtractionResult = parseExtraction(raw);
    assert.notEqual(r.status, 'success');
    assert.equal(isMemoryFormationEligible(r), false);
    assert.equal(formFrom(raw, s, ev), null);
  }
});

// ══════════════════════════════════════════════════════════════════════
// D5：记忆形成回归
// ══════════════════════════════════════════════════════════════════════

test('D5-1 正面经历正常形成，sourceEventId 指向 user_input DialogueEvent', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d5-1', '今天特别顺利，我很开心', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0.7), s, ev);
  assert.ok(mem);
  assert.equal(mem!.sourceEventId, ev.id);
  assert.equal(mem!.id, `epi-${ev.id}`);
  assert.ok(mem!.keywords.length > 0);
});

test('D5-2 负面经历正常形成（不因 comfort 变正）', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d5-2', '项目压力特别大，我担心自己做不好', 'comfort', 0.9);
  const mem = formFrom(extractionJson('comfort', -0.8), s, ev, 2.0);
  assert.ok(mem);
  assert.ok(mem!.valence < 0);
});

test('D5-3 中性经历不因人为赋值强制成正负；强度不足则不形成', () => {
  const s = makeState();
  const strong = makeUserEvent('evt-d5-3a', '今天正常吃了午饭', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0), s, strong);
  assert.ok(mem);
  assert.equal(mem!.valence, 0);

  const weak = makeUserEvent('evt-d5-3b', '今天正常吃了午饭', 'statement', 0.4);
  assert.equal(formFrom(extractionJson('statement', 0), s, weak), null);
});

test('D5-4 只有回忆、没有新经历 → 不形成记忆（无回声）', () => {
  const s = makeState();
  // 回忆轮次的 payload.moodDelta 为 0；即使 experienceValence 有值也不得沉淀
  const recall = makeUserEvent('evt-d5-4', '你还记得我之前那个项目吗？', 'statement', 0.9);
  recall.payload.moodDelta = 0;
  assert.equal(formFrom(extractionJson('statement', -0.7), s, recall, 0), null);
});

test('D5-5 已有旧记忆时，新体验仍可形成独立记忆', () => {
  const s = makeState();
  const oldMem = formFrom(
    extractionJson('complaint', -0.7),
    s,
    makeUserEvent('evt-d5-old', '项目压力特别大', 'complaint', 0.9),
  );
  assert.ok(oldMem);
  s.episodicBuffer = [oldMem!];

  const ev = makeUserEvent('evt-d5-5', '今天计划成功了，我特别开心', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0.8), s, ev);
  assert.ok(mem);
  assert.notEqual(mem!.id, oldMem!.id);
  assert.notEqual(mem!.sourceEventId, oldMem!.sourceEventId);
  assert.equal(s.episodicBuffer.length, 1, '候选函数本身不写入 buffer');
});

test('D5-6 每轮最多一条记忆事件（候选返回单对象）', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d5-6', '今天特别顺利', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0.6), s, ev);
  assert.ok(mem && !Array.isArray(mem));
});

// ══════════════════════════════════════════════════════════════════════
// D6：Replay / 冻结 / 确定性
// ══════════════════════════════════════════════════════════════════════

function makeFormationEvent(mem: NonNullable<ReturnType<typeof formFrom>>): MemoryFormationEvent {
  return {
    type: 'memory_formation',
    id: 'evt-mf-d6',
    timestamp: TS,
    payload: { sourceDialogueEventId: mem.sourceEventId, memory: mem },
  } as MemoryFormationEvent;
}

test('D6-1 MemoryFormationEvent payload 冻结：Replay 不重算 valence', () => {
  const s = makeState();
  const ev = makeUserEvent('evt-d6-1', '猫走丢了我很难受', 'comfort', 0.9);
  const mem = formFrom(extractionJson('comfort', -0.8), s, ev, 2.0);
  assert.ok(mem);

  const formation = makeFormationEvent(mem!);
  // 篡改 payload 后再回放，回放必须无条件信任 payload（不重跑提取/不修正历史）
  formation.payload.memory.valence = -0.35;
  const replayed = applyEvent(s, formation);
  assert.equal(replayed.episodicBuffer[0]!.valence, -0.35);
});

test('D6-2 同一事件序列回放两次 → 状态深相等', () => {
  const s = makeState();
  const dialogue = makeUserEvent('evt-d6-2', '今天计划成功了', 'statement', 0.9);
  const mem = formFrom(extractionJson('statement', 0.7), s, dialogue);
  assert.ok(mem);
  const formation = makeFormationEvent(mem!);

  const run = () => {
    let st = applyEvent(makeState(), dialogue);
    st = applyEvent(st, formation);
    return st;
  };
  assert.deepEqual(run(), run());
});

test('D6-3 仅有 DialogueEvent 不会形成记忆（Replay 不重新执行提取）', () => {
  const s = makeState();
  const dialogue = makeUserEvent('evt-d6-3', '今天计划成功了', 'statement', 0.9);
  const replayed = applyEvent(s, dialogue);
  assert.equal(replayed.episodicBuffer.length, 0);
});

test('D6-4 MemoryFormationEvent 规范化序列化稳定（Hash 输入确定）', () => {
  const s = makeState();
  const mem = formFrom(
    extractionJson('statement', 0.6),
    s,
    makeUserEvent('evt-d6-4', '今天特别顺利', 'statement', 0.9),
  );
  assert.ok(mem);
  const formation = makeFormationEvent(mem!);
  assert.equal(canonicalize(formation), canonicalize(formation));
  assert.deepEqual(JSON.parse(canonicalize(formation)), JSON.parse(canonicalize(formation)));
});
