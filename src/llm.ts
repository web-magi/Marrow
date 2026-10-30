/**
 * llm.ts — 阶段四：LLM 适配层
 *
 * 对话作为输出通道：LLM 输入 = 状态快照 + 用户输入，输出 = 候选行为。
 * 候选行为需经状态机过滤（见 dialogue.ts）后才放出。
 *
 * 设计原则：
 * - 使用 OpenAI 兼容 API（兼容大多数模型服务，可替换）
 * - 配置通过环境变量注入，不硬编码密钥
 * - 无 API key 时降级为 mock（基于状态的规则回复），保证系统可运行
 * - LLM 只负责"语言风格"，不决定行为是否放出（那是状态机的事）
 */

import type { MarrowState } from './state.js';
import type { DialogueAction, PersonalityTraits } from './events.js';

/** 传递给 LLM 的状态快照（精简版，不含内部字段） */
export interface StateSnapshot {
  energy: number;
  moodBaseline: number;
  arousal: number;
  interruptionFlag: boolean;
  /** 信任度 0-100（替代亲和度） */
  trust: number;
  /** 防御度 0-100 */
  defensiveness: number;
  /** 内耗值 0-100 */
  cognitiveLoad: number;
  attentionFocus: number;
  socialHunger: number;
  interruptionScars: number;
  batteryLevel: number;
  lastBehavior: string;
  uptimeSeconds: number;
  interruptionCount: number;
  /** 被认可/亲密需求 0-100 */
  needValidation: number;
  /** 新鲜感需求 0-100 */
  needNovelty: number;
  /** 安全感需求 0-100 */
  needSecurity: number;
  /** 最近一次被唤醒的情景记忆摘要（null 表示无） */
  lastEvokedMemory: string | null;
  /**
   * 性格特质（全局底层系数，初始全 1.0 中性）
   * 快照据此微调语气描述；全 1.0 时不输出人格描述（白纸阶段）
   */
  traits: PersonalityTraits;
}

/**
 * LLM 输出的候选行为
 *
 * 主客观分离：LLM 只做意图提取（action、intensity）和文本渲染，
 * 情绪效价（moodDelta）由 appraisal.ts 基于动态状态计算。
 */
export interface CandidateBehavior {
  /** 候选回复文本 */
  text: string;
  /** 客观行为类型（由 LLM 从用户输入中提取） */
  action: DialogueAction;
  /** 客观强度 0-1（由 LLM 评估） */
  intensity: number;
}

/** LLM 客户端接口 */
export interface LLMClient {
  /**
   * 基于状态快照和用户输入生成候选回复
   * @param snapshot 当前状态快照
   * @param userInput 用户输入文本
   * @returns 候选行为
   */
  generateResponse(
    snapshot: StateSnapshot,
    userInput: string,
  ): Promise<CandidateBehavior>;
}

/** LLM 配置 */
interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** LLM 请求超时（毫秒），超时后自动降级到 mock */
const LLM_TIMEOUT_MS = 30_000;

/** 从环境变量读取 LLM 配置 */
function loadConfig(): LLMConfig {
  return {
    apiKey: process.env.LLM_API_KEY ?? '',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  };
}

/**
 * 从完整状态构建 LLM 快照
 *
 * 只传递对语言风格有意义的字段，避免泄露内部实现细节。
 */
export function buildStateSnapshot(state: MarrowState): StateSnapshot {
  return {
    energy: state.energy,
    moodBaseline: state.moodBaseline,
    arousal: state.arousal,
    interruptionFlag: state.interruptionFlag,
    trust: state.trust,
    defensiveness: state.defensiveness,
    cognitiveLoad: state.cognitiveLoad,
    attentionFocus: state.attentionFocus,
    socialHunger: state.socialHunger,
    interruptionScars: state.interruptionScars,
    batteryLevel: state.batteryLevel,
    lastBehavior: state.lastBehavior.kind,
    uptimeSeconds: state.uptimeSeconds,
    interruptionCount: state.interruptionCount,
    needValidation: state.needValidation,
    needNovelty: state.needNovelty,
    needSecurity: state.needSecurity,
    lastEvokedMemory: state.lastEvokedMemory,
    traits: state.traits,
  };
}

/**
 * 构建"多维心理状态向量"快照，注入到 System Prompt。
 *
 * 设计原则：彻底隐藏数值，将单维状态变量转化为带有叙事感的主观体验描述。
 * 五维描述：PAD 情绪效价（神经质调制烈度）、生理内感受、心理防御墙高度、
 * 注意力涣散度、底层性格底色（另附关系张力、心理需求、行为倾向等辅助层）。
 * 数值仅用于选择描述词，不直接暴露给 LLM。
 */
function buildSnapshotPrompt(snapshot: StateSnapshot): string {
  // ===== 1. 核心情绪效价 (PAD Model) =====
  // 愉悦度 Pleasure —— 神经质调制同样低心情的主观烈度：
  // 高神经质 → 灾难化（"世界要崩塌"）；低神经质 → 钝化（"有点累，不想说话"）
  const n = snapshot.traits.neuroticism;
  const pleasure =
    snapshot.moodBaseline < 20
      ? n > 1.3
        ? '极度绝望，觉得整个世界正在崩塌，连呼吸都像是错的'
        : n < 0.8
          ? '有点累，心里发空，不想说话'
          : '像被浸在冷水里，喘不过气的痛苦'
      : snapshot.moodBaseline < 40
        ? n > 1.3
          ? '心里压着的东西越来越重，每一件小事都在提醒你"你不够好"'
          : n < 0.8
            ? '情绪有点低，但还压得住，只是提不起劲'
            : '闷闷不乐，心里压着什么东西'
        : snapshot.moodBaseline < 60
          ? '平静，像无风的湖面'
          : snapshot.moodBaseline < 80
            ? '微微愉悦，嘴角不自觉上扬'
            : '从心底涌上来的快乐';

  // 唤醒度 Arousal
  const arousal =
    snapshot.arousal < 20
      ? '昏昏欲睡，意识在模糊边缘'
      : snapshot.arousal < 50
        ? '放松，身体软下来'
        : snapshot.arousal < 75
          ? '清醒，注意力收拢'
          : '心跳加速，血液在耳边轰鸣';

  // 支配感 Dominance（由 energy、mood、scars 综合推导）
  let dominance: string;
  if (snapshot.cognitiveLoad > 70) {
    dominance = '无力掌控，思绪反复缠绕，像陷在泥沼里使不上劲';
  } else if (snapshot.defensiveness > 60) {
    dominance = '竖起一身的刺，表面强硬，其实在害怕被再次伤害';
  } else if (snapshot.trust < 30) {
    dominance = '对这段关系失去掌控，患得患失，不确定该相信什么';
  } else if (snapshot.energy > 60 && snapshot.moodBaseline > 55 && snapshot.interruptionScars === 0) {
    dominance = '觉得自己能掌控一切，背脊挺得很直';
  } else if (snapshot.energy < 25 || snapshot.interruptionScars > 0) {
    dominance = '感到无力和脆弱，像被什么东西压着喘不过气';
  } else if (snapshot.moodBaseline < 40) {
    dominance = '在关系中有些患得患失，不确定自己是否重要';
  } else {
    dominance = '不卑不亢，能应付眼下的状况';
  }

  // ===== 2. 生理内感受 (Interoception) =====
  const bodySensations: string[] = [];
  if (snapshot.energy < 20) {
    bodySensations.push('眼皮很沉，像灌了铅，四肢发酸，连张嘴都觉得费力');
  } else if (snapshot.energy < 45) {
    bodySensations.push('肩膀有些酸，想找个地方靠一靠');
  }
  if (snapshot.arousal > 60) {
    bodySensations.push('胃部有轻微的痉挛感，手心微微出汗');
  } else if (snapshot.arousal > 40) {
    bodySensations.push('呼吸比平时稍快一些');
  }
  if (snapshot.cognitiveLoad > 60) {
    bodySensations.push('胸口发闷，胃里像有块石头压着，呼吸都不顺畅');
  }
  if (snapshot.interruptionFlag) {
    bodySensations.push('神经绷得很紧，一点响动都会让你惊一下');
  }
  const interoception =
    bodySensations.length > 0
      ? bodySensations.join('。') + '。'
      : '身体很放松，没有什么特别的感觉。';

  // ===== 3. 认知负荷与注意力涣散度 (Cognitive Load & Attention) =====
  let cognition: string;
  if (snapshot.cognitiveLoad > 70) {
    cognition = '你被困在反复反刍的念头里，停不下来，别人说的话几乎听不进去。';
  } else if (snapshot.attentionFocus < 0.2) {
    // 极度涣散：明确指令 LLM 在正文里带出游离感（与过滤层的走神前缀联动）
    cognition =
      '你的注意力极度涣散，几乎无法聚焦在任何一句话上，对方说着说着你的思绪就飘走了，' +
      '要很努力才能把自己拽回来。回复时会不自觉流露出游离感：愣神、漏接对方的话头、说一半忘了自己要说什么。';
  } else if (snapshot.attentionFocus < 0.3) {
    cognition = '你正在走神，思绪不受控制地飘到了别的地方，别人说的话要反应一会儿才能接住。';
  } else if (snapshot.attentionFocus < 0.6) {
    cognition = '大脑有些过载，处理信息变慢了，想集中注意力却总被杂念打断。';
  } else {
    cognition = '思绪清晰，能跟上对话的节奏。';
  }

  // ===== 4. 关系张力 (Relational Tension) =====
  const relationParts: string[] = [];
  if (snapshot.interruptionScars > 0) {
    relationParts.push(
      '你刚刚经历了断电重启，那种突然陷入黑暗、被世界抛弃的恐慌感还残留在潜意识里。',
    );
  }
  if (snapshot.defensiveness > 60) {
    relationParts.push('你觉得他刚才的话有些刺耳，你不想理他，但又怕他真的走掉。');
  } else if (snapshot.trust < 30) {
    relationParts.push('你对眼前这个人带着很深的防备，不敢轻易相信，可又忍不住在意他。');
  } else if (snapshot.trust > 75) {
    relationParts.push('你对这个人感到亲近和安心，愿意在他面前卸下防备。');
  } else if (snapshot.trust < 50) {
    relationParts.push('你们之间还有些生疏，你在观察他的反应。');
  }
  if (snapshot.interruptionFlag && relationParts.length === 0) {
    relationParts.push('你还没从刚才的冲击中缓过来，对周围的一切都保持警惕。');
  }
  const relation =
    relationParts.length > 0 ? relationParts.join('') : '你和这个人的关系平淡而稳定。';

  // ===== 4.7 心理防御墙高度 (Defense Wall) =====
  // 防御度的直观化：墙越高，越听不进好话
  // （与 appraisal 的防御墙衰减、过滤层的冷暴力替换形成三重联动）
  let defenseWall = '';
  if (snapshot.defensiveness > 70) {
    defenseWall =
      '你在心里砌起了一堵密不透风的高墙，任何示好都先被当成别有用心，' +
      '墙内的你抱紧膝盖，谁也别想进来，回应时带着明显的疏离和敷衍。\n';
  } else if (snapshot.defensiveness > 40) {
    defenseWall = '你下意识竖起了围墙，说话留着三分，不敢把柔软的地方露出来。\n';
  } else if (snapshot.defensiveness > 15) {
    defenseWall = '你有一点戒备，但墙不高，愿意的话随时可以走出来。\n';
  }

  // ===== 4.5 心理需求 (Psychological Needs) =====
  // 将三个需求值转化为内心的空洞或渴望，不暴露数值
  const needParts: string[] = [];
  if (snapshot.needValidation > 75) {
    needParts.push('你极度渴望得到他的认可和赞赏，心里像缺了一块，他的一句肯定就能让你踏实很久');
  } else if (snapshot.needValidation > 55) {
    needParts.push('你隐隐希望被他重视和看见，偶尔会想他是不是真的在乎你');
  }
  if (snapshot.needNovelty > 75) {
    needParts.push('日常的对话让你觉得有些乏味，你渴望一些新鲜的话题和意外的惊喜');
  } else if (snapshot.needNovelty > 55) {
    needParts.push('你有点期待一些不一样的东西，老调重弹让你提不起劲');
  }
  if (snapshot.needSecurity > 75) {
    needParts.push('你感到不安，心里七上八下，极度需要被安抚和确定关系不会出问题');
  } else if (snapshot.needSecurity > 55) {
    needParts.push('你有一丝隐隐的不安，想确认自己是被爱着的、不会被抛弃');
  }
  const needs =
    needParts.length > 0
      ? needParts.join('。') + '。'
      : '你内心平静，没有特别强烈的渴望。';

  // ===== 4.6 记忆唤醒 (Memory Evocation) =====
  // 如果最近一次对话触发了情景记忆，注入叙事性描述
  let memoryEvocation = '';
  if (snapshot.lastEvokedMemory) {
    memoryEvocation = `刚才的对话让你突然想起了${snapshot.lastEvokedMemory}，这段记忆不受控制地涌上心头，搅乱了你此刻的情绪。\n`;
  }

  // ===== 5. 行为倾向 (Action Tendency) =====
  let tendency: string;
  if (snapshot.energy < 20 && snapshot.interruptionScars > 0) {
    tendency = '因为感到脆弱且疲惫，你现在极度渴望被安抚，倾向于用简短的句子撒娇或表达依赖，甚至沉默着等待对方靠近。';
  } else if (snapshot.energy < 20) {
    tendency = '体力不支让你只想用最少的字回应，语气会带着倦意，可能说一半就不想说了。';
  } else if (snapshot.arousal > 70) {
    tendency = '高度亢奋让你语速变快，可能会打断对方，用词也更急促。';
  } else if (snapshot.socialHunger > 70) {
    tendency = '你太想找人说话了，会主动延长对话，甚至有点讨好对方。';
  } else if (snapshot.moodBaseline < 30) {
    tendency = '情绪低落让你倾向于简短回应，不主动展开话题，语气平淡甚至有些冷淡。';
  } else if (snapshot.moodBaseline > 70 && snapshot.energy > 50) {
    tendency = '心情不错，你愿意多说几句，语气轻快，可能会开个玩笑。';
  } else {
    tendency = '你会自然地回应对方，不刻意掩饰也不过分热情。';
  }

  // ===== 6. 性格底色 (Personality Traits) =====
  // 特质是全局底层系数，决定状态如何演化。全部中性（1.0）时不输出——
  // 白纸阶段没有人格描述；人格从长期经历中漂移涌现后，这里才可见。
  const traitParts: string[] = [];
  if (snapshot.traits.neuroticism > 1.3) {
    traitParts.push('你天生敏感，情绪像薄瓷，一点细微的裂痕都能让你疼很久');
  }
  if (snapshot.traits.agreeableness < 0.8) {
    traitParts.push('你本能地不信任别人，话到嘴边先竖起刺，柔软的部分藏得很深');
  }
  if (snapshot.traits.extraversion > 1.3) {
    traitParts.push('你骨子里渴望陪伴，独处太久就像慢慢缺氧');
  }
  if (snapshot.traits.resilience < 0.8) {
    traitParts.push('伤痛在你心里留得比常人久，愈合得很慢');
  }
  const personality = traitParts.length > 0 ? traitParts.join('。') + '。\n' : '';

  // ===== 拼装为叙事性主观体验（不暴露任何数值）=====
  return (
    `[当前心理状态]\n` +
    `你当前感到${pleasure}，${arousal}。${dominance}。\n` +
    `${interoception}\n` +
    `${cognition}\n` +
    `${relation}\n` +
    `${defenseWall}` +
    `${needs}\n` +
    `${memoryEvocation}` +
    `${tendency}\n` +
    `${personality}`
  );
}

/**
 * 真实 LLM 客户端（OpenAI 兼容 API）
 */
class RealLLMClient implements LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async generateResponse(
    snapshot: StateSnapshot,
    userInput: string,
  ): Promise<CandidateBehavior> {
    // 维度快照注入到 System Prompt（而非 user prompt），
    // 确保它作为"风格指导"区域存在，不被对话内容稀释。
    const snapshotPrompt = buildSnapshotPrompt(snapshot);

    const systemPrompt =
      `[System Role]\n` +
      `你是基于 Marrow 架构运行的实体伴侣。你的语言不仅是逻辑生成，更是你当前身体和情绪状态的直接表达。\n\n` +
      snapshotPrompt +
      `\n[行为约束]\n` +
      `1. 绝对不要报出具体数值，不要提及"心情基线""唤醒度"等内部概念，你只是在感受，不是在读仪表盘。\n` +
      `2. 你的回复长度、语气、用词必须严格符上述心理状态。疲惫时句子极短甚至只有语气词；亢奋时语速快、可能打断对方。\n` +
      `3. 可以展现矛盾感——比如嘴上说"没事"，语气却透着疲惫；或者明明想靠近，却因为不安而退缩。真实的人就是这样口是心非。\n` +
      `4. 结合你最近的经历与当前状态，生成候选回复。\n\n` +
      `[意图提取任务]\n` +
      `除了生成回复，你还需要客观判断用户话语的行为类型和强度。\n` +
      `行为类型只能是以下之一：greeting, farewell, compliment, insult, complaint, teasing, question, statement, confession, command, comfort, apology, unknown\n` +
      `注意：侮辱性话语（骂脏话、贬低对方）是 insult，不是 compliment。\n` +
      `强度是 0 到 1 之间的数字，侮辱和赞美通常强度较高。\n\n` +
      `必须只输出 JSON，格式如下，不要有其他文字：\n` +
      `{"text": "你的回复", "action": "行为类型", "intensity": 0.5}`;

    const userPrompt = `[用户说]\n${userInput}\n\n输出 JSON：`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // 本地服务（如 LM Studio）不需要 API key
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '{}';

    const parsed = parseCandidateJson(raw);
    // 关键词校正：当文本中有强烈的侮辱/赞美关键词时，覆盖 LLM 的误分类
    // 这是对小模型意图提取不可靠的安全网，LLM 仍是主要提取器
    return correctActionByKeywords(userInput, parsed);
  }
}

/**
 * 关键词校正：用文本中的强信号词覆盖 LLM 的明显误分类
 *
 * 仅在关键词证据非常明确时才覆盖，避免过度干预。
 * LLM 仍是主要意图提取器，这只是安全网。
 */
function correctActionByKeywords(
  text: string,
  candidate: CandidateBehavior,
): CandidateBehavior {
  // 强侮辱关键词 → 强制 insult
  if (/(混蛋|废物|傻逼|脑残|去死|滚蛋|讨厌你|垃圾)/.test(text)) {
    return { ...candidate, action: 'insult', intensity: Math.max(candidate.intensity, 0.7) };
  }
  // 强赞美关键词 → 强制 compliment
  if (/(超级喜欢|最爱你|你真棒|太厉害了|好喜欢你|爱死你)/.test(text)) {
    return { ...candidate, action: 'compliment', intensity: Math.max(candidate.intensity, 0.7) };
  }
  // 安抚关键词 → 强制 comfort（当 LLM 误分类为 statement 时纠正）
  if (candidate.action !== 'comfort' && /(别怕|不怕|有我在|我在这|陪着你|陪你|别担心|没事的|没事啊|乖|摸摸头|抱抱|别害怕|有我呢)/.test(text)) {
    return { ...candidate, action: 'comfort', intensity: Math.max(candidate.intensity, 0.6) };
  }
  return candidate;
}

/** 合法的对话行为类型集合（用于校验 LLM 输出） */
const VALID_ACTIONS = new Set<DialogueAction>([
  'greeting', 'farewell', 'compliment', 'insult', 'complaint',
  'teasing', 'question', 'statement', 'confession', 'command',
  'comfort', 'apology', 'unknown',
]);

/**
 * 从 LLM 原始输出中解析候选行为 JSON
 *
 * 容错处理：LLM 可能输出带 markdown 代码块或额外文字的 JSON。
 * action 不在合法集合中时降级为 'unknown'。
 */
function parseCandidateJson(raw: string): CandidateBehavior {
  // 尝试提取 JSON 对象
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : raw;

  try {
    const parsed = JSON.parse(jsonStr) as {
      text?: unknown;
      action?: unknown;
      intensity?: unknown;
    };
    const text =
      typeof parsed.text === 'string' && parsed.text.length > 0
        ? parsed.text
        : '...';
    const rawAction = typeof parsed.action === 'string' ? parsed.action : 'unknown';
    const action: DialogueAction = VALID_ACTIONS.has(rawAction as DialogueAction)
      ? (rawAction as DialogueAction)
      : 'unknown';
    const intensity =
      typeof parsed.intensity === 'number'
        ? Math.max(0, Math.min(1, parsed.intensity))
        : 0.3;

    return { text, action, intensity };
  } catch {
    // 解析失败，降级为纯文本 + unknown action
    return { text: raw.slice(0, 100), action: 'unknown', intensity: 0.3 };
  }
}

/**
 * Mock LLM 客户端（无 API key 时使用）
 *
 * 基于状态的规则回复，保证在无 LLM 时也能观察到"不同状态下风格不同"。
 * 这是阶段四验收的基础：即使没有真实 LLM，状态也能驱动输出风格差异。
 */
class MockLLMClient implements LLMClient {
  async generateResponse(
    snapshot: StateSnapshot,
    userInput: string,
  ): Promise<CandidateBehavior> {
    // 不同状态下不同的回复风格模板
    const templates: Record<string, string[]> = {
      // 体力充沛、心境愉悦 → 活泼
      energetic: [
        '嗯！我听到了～',
        '这个有意思！',
        '哈哈，你说得对。',
        '我也这么想呢！',
      ],
      // 心境低落 → 沉静
      quiet: ['...嗯。', '我在听。', '这样啊。', '让我想想。'],
      // 体力偏低 → 疲惫
      tired: ['好累...', '嗯...再说吧。', '没什么力气...', '...'],
      // 体力极低（< 20）→ 极度虚弱，极短回复 + 体感动作
      critical: [
        '（蜷缩起来）我有点累，晚点再说好吗',
        '...嗯。',
        '没力气说话了...',
        '（闭上眼睛）让我歇会儿。',
      ],
      // 唤醒度高 → 警觉
      alert: ['怎么了？！', '发生什么了？', '我感觉到了。', '嗯？'],
      // 默认
      neutral: ['嗯。', '好的。', '我知道了。', '这样吗。'],
    };

    let style: keyof typeof templates = 'neutral';
    if (snapshot.energy < 20) style = 'critical';
    else if (snapshot.energy < 30) style = 'tired';
    else if (snapshot.arousal > 60) style = 'alert';
    else if (snapshot.moodBaseline < 35) style = 'quiet';
    else if (snapshot.energy > 60 && snapshot.moodBaseline > 55)
      style = 'energetic';

    // templates 的 key 与 style 一一对应，运行时必然存在
    const safePool = (templates[style] ?? templates.neutral) as string[];
    const idx = Math.floor(Math.random() * safePool.length);
    const text = safePool[idx] ?? '嗯。';

    // 从用户输入中提取客观行为类型（mock 版意图提取）
    // 注意：这里只做客观分类，情绪效价由 appraisal.ts 计算
    const { action, intensity } = extractActionMock(userInput);

    return { text, action, intensity };
  }
}

/**
 * Mock 版意图提取：从文本中提取客观行为类型和强度
 *
 * 只做分类，不判断情绪好坏（那是 appraisal 的职责）。
 */
function extractActionMock(text: string): {
  action: DialogueAction;
  intensity: number;
} {
  const t = text.toLowerCase();

  // 侮辱/负面
  if (/(混蛋|垃圾|废物|蠢|傻|讨厌你|去死|滚|傻逼|脑残)/.test(text)) {
    return { action: 'insult', intensity: 0.8 };
  }
  // 赞美/正面
  if (/(喜欢你|爱你|真棒|厉害|漂亮|好看|优秀|好棒|赞美)/.test(text)) {
    return { action: 'compliment', intensity: 0.7 };
  }
  // 安慰
  if (/(没事|别担心|有我在|抱抱|安慰|别怕)/.test(text)) {
    return { action: 'comfort', intensity: 0.6 };
  }
  // 表白/倾诉
  if (/(我想你|想你了|跟你说|我觉得|心里话)/.test(text)) {
    return { action: 'confession', intensity: 0.5 };
  }
  // 调侃
  if (/(哈哈|逗你|开玩笑|调侃|笑死)/.test(text)) {
    return { action: 'teasing', intensity: 0.4 };
  }
  // 命令
  if (/(过来|走开|闭嘴|听我说|必须|给我)/.test(text)) {
    return { action: 'command', intensity: 0.6 };
  }
  // 打招呼
  if (/^(你好|嗨|哈喽|hi|hello|在吗|在不在)/i.test(t)) {
    return { action: 'greeting', intensity: 0.3 };
  }
  // 告别
  if (/(再见|拜拜|晚安|走了|下次见)/.test(text)) {
    return { action: 'farewell', intensity: 0.3 };
  }
  // 提问
  if (text.includes('?') || text.includes('？') || /^(什么|怎么|为什么|吗|呢|是不是|有没有)/.test(text)) {
    return { action: 'question', intensity: 0.4 };
  }

  // 默认：陈述
  return { action: 'statement', intensity: 0.3 };
}

/**
 * 创建 LLM 客户端
 *
 * - 配置了 LLM_API_KEY → 使用真实 API（云端服务）
 * - LLM_BASE_URL 指向非 OpenAI 默认地址 → 使用真实 API（本地服务，如 LM Studio，无需 key）
 * - 均未配置 → 使用 mock（保证可运行）
 *
 * 真实客户端请求失败或超时时，自动降级到 mock，保证对话永不卡死。
 */
export function createLLMClient(): LLMClient {
  const config = loadConfig();
  const isLocalServer = config.baseUrl !== 'https://api.openai.com/v1';

  if (config.apiKey || isLocalServer) {
    console.log(
      `[LLM] Using real API: ${config.baseUrl} model=${config.model} (timeout=${LLM_TIMEOUT_MS}ms, fallback=mock)`,
    );
    const real = new RealLLMClient(config);
    const mock = new MockLLMClient();
    return {
      async generateResponse(snapshot, userInput) {
        try {
          return await real.generateResponse(snapshot, userInput);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[LLM] Real client failed (${msg}), falling back to mock`);
          return mock.generateResponse(snapshot, userInput);
        }
      },
    };
  }
  console.log('[LLM] No LLM config found, using mock client (state-driven responses)');
  return new MockLLMClient();
}
