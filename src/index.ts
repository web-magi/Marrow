/**
 * index.ts — 阶段一运行入口（带实时可视化监控）
 *
 * 最小状态机：不接 LLM、不接传感器。
 * 每 10 秒 tick，energy 衰减、mood_baseline 漂移、arousal 衰减。
 * 规则映射输出行为风格。
 *
 * 新增：内嵌 HTTP 服务器，提供实时状态监控页面。
 *   - GET /           -> 实时监控 HTML 页面
 *   - GET /api/state  -> 当前状态 + 最近 N 个状态历史（JSON）
 *
 * 验收：连续运行 24 小时，无对话输入下产生可观察的行为风格变化。
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, applyEvent, evokeMemoryFromText, type MarrowState } from './state.js';
import {
  type TickEvent,
  type EnvironmentEvent,
  type InterruptionEvent,
} from './events.js';
import { replay } from './replay.js';
import { appendEvent, loadEvents, generateEventId } from './storage.js';
import {
  createSimulatedSensors,
  type SensorProvider,
  type SimulatedMotionSensor,
  type SimulatedBatterySensor,
} from './sensors.js';
import {
  createLLMClient,
  buildStateSnapshot,
  EXTRACTOR_VERSION,
  type LLMClient,
  type ExtractionResult,
} from './llm.js';
import { appraise, type AppraisalContext } from './appraisal.js';
import { filterCandidateBehavior } from './dialogue.js';
import type {
  DialogueEvent,
  SleepEvent,
  ObservationEvent,
  AppraisalEvent,
} from './events.js';

/**
 * 轻量 .env 加载器
 *
 * 读取项目根目录的 .env 文件，将 KEY=VALUE 写入 process.env。
 * 不覆盖已存在的环境变量（命令行传入的优先级更高）。
 * 无额外依赖，兼容本地开发与部署。
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
    // 去除首尾引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 不覆盖已存在的环境变量
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// 在读取任何环境变量之前加载 .env
loadEnvFile();

/** tick 间隔（毫秒） */
const TICK_INTERVAL_MS = 10_000;

/** HTTP 监控服务器端口 */
const MONITOR_PORT = 8787;

/** 状态历史缓冲区大小（用于绘制曲线） */
const HISTORY_SIZE = 500;

/**
 * 时间缩放因子
 *
 * 通过环境变量 TIME_SCALE 控制。
 * - TIME_SCALE=1（默认）：真实时间，每 tick 推进 10 秒
 * - TIME_SCALE=60：每 tick 推进 600 秒（10 分钟），相当于快进 60 倍
 * - TIME_SCALE=360：每 tick 推进 1 小时，几小时的变化在几分钟内可见
 *
 * 原理：只放大 deltaSeconds，不改变状态机的物理常量。
 * 因此测试结果与真实运行一致，只是时间被压缩。
 */
const TIME_SCALE = Math.max(1, parseInt(process.env.TIME_SCALE ?? '1', 10));

/** 当前状态（全局，供 HTTP 接口读取） */
let currentState: MarrowState | null = null;

/** 状态历史缓冲区 */
const stateHistory: MarrowState[] = [];

/** 对话历史缓冲区（用于监控页面展示） */
interface DialogueMessage {
  direction: 'user_input' | 'companion_output';
  text: string;
  timestamp: string;
  filtered?: boolean;
  filterReason?: string;
}
const dialogueHistory: DialogueMessage[] = [];
const DIALOGUE_HISTORY_SIZE = 100;

/** LLM 客户端（阶段四） */
let llmClient: LLMClient | null = null;

/** 格式化状态输出 */
function formatState(state: MarrowState): string {
  const energy = state.energy.toFixed(1);
  const mood = state.moodBaseline.toFixed(1);
  const arousal = state.arousal.toFixed(1);
  const uptime = Math.floor(state.uptimeSeconds);
  const interruptions = state.interruptionCount;
  const behavior = state.lastBehavior.kind;
  const reason = state.lastBehavior.reason;

  return (
    `[${new Date(state.lastUpdated).toISOString()}] ` +
    `energy=${energy} mood=${mood} arousal=${arousal} ` +
    `uptime=${uptime}s interruptions=${interruptions} ` +
    `behavior=${behavior}(${reason})`
  );
}

/**
 * 创建一个 tick 事件
 */
function createTickEvent(deltaSeconds: number): TickEvent {
  return {
    type: 'tick',
    id: generateEventId(),
    timestamp: new Date().toISOString(),
    payload: { deltaSeconds },
  };
}

/**
 * 处理对话请求（阶段四收尾：观察—评价—对话三段式事件链）
 *
 * 流程（主客观分离，全链路事件溯源）：
 * 1. LLM 提取：客观事实（action/intensity/confidence/facts/uncertainty）+ 渲染回复文本
 * 2. 写 ObservationEvent（纯观察记录，不驱动状态变化）
 * 3. appraise：基于动态状态 + 观察置信度计算多维情绪增量
 * 4. 写 AppraisalEvent（主观评价证据链，arousalDelta 由此应用）
 * 5. 写 DialogueEvent（携带 observationId/appraisalId 溯源，
 *    moodDelta = AppraisalResult.valenceDelta，mood 变化由此应用）
 * 6. 状态机过滤候选行为（interruption_flag 强制拦截）→ 写伴侣输出事件
 *
 * 关键：LLM 不决定情绪效价，状态机（appraisal）决定；
 * 回放时 applyDialogue 对新格式事件直接采用 payload.moodDelta，
 * 保证实跑与回放完全一致。
 */
async function handleChatRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // 读取请求体
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let userInput = '';
  try {
    const parsed = JSON.parse(body) as { message?: string };
    userInput = (parsed.message ?? '').trim();
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  if (!userInput) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'message is required' }));
    return;
  }

  if (!currentState || !llmClient) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'system not ready' }));
    return;
  }

  const state = currentState;
  const timestamp = new Date().toISOString();

  // 1. 调用 LLM：提取客观事实 + 生成回复文本
  //    LLM 只做意图提取和文本渲染，不计算情绪效价
  const snapshot = buildStateSnapshot(state);
  const fallbackExtraction: ExtractionResult = {
    action: 'unknown',
    intensity: 0.3,
    confidence: 0.2,
    facts: [],
    uncertainty: 0.8,
  };
  let candidate: {
    text: string;
    action: import('./events.js').DialogueAction;
    intensity: number;
    extraction: ExtractionResult;
  };
  try {
    candidate = await llmClient.generateResponse(snapshot, userInput);
  } catch (err) {
    console.error('[LLM] generateResponse failed:', err);
    candidate = {
      text: '...（暂时无法回应）',
      action: 'unknown',
      intensity: 0.3,
      extraction: fallbackExtraction,
    };
  }

  // 2. 写观察事件（纯事实记录，不驱动状态变化）
  const observationEvent: ObservationEvent = {
    type: 'observation',
    id: generateEventId(),
    timestamp,
    payload: {
      source: 'user_text',
      content: userInput,
      action: candidate.extraction.action,
      intensity: candidate.extraction.intensity,
      confidence: candidate.extraction.confidence,
      uncertainty: candidate.extraction.uncertainty,
      facts: candidate.extraction.facts,
      extractorVersion: EXTRACTOR_VERSION,
    },
  };
  appendEvent(observationEvent);
  const stateAfterObservation = applyEvent(state, observationEvent);

  // 3. appraise：基于动态状态 + 观察置信度计算多维情绪增量
  //    记忆唤醒证据链与 applyDialogue 内部逻辑保持一致的确定性检索
  const evoked = evokeMemoryFromText(stateAfterObservation.episodicBuffer, userInput);
  const appraisalContext: AppraisalContext = {
    associationWeight: stateAfterObservation.associationWeight,
    trust: stateAfterObservation.trust,
    defensiveness: stateAfterObservation.defensiveness,
    moodBaseline: stateAfterObservation.moodBaseline,
    needValidation: stateAfterObservation.needValidation,
    needNovelty: stateAfterObservation.needNovelty,
    needSecurity: stateAfterObservation.needSecurity,
    traits: stateAfterObservation.traits,
    confidence: candidate.extraction.confidence,
    evidenceAssociationIds: evoked ? [evoked.id] : [],
  };
  const appraisalResult = appraise(
    candidate.extraction.action,
    candidate.extraction.intensity,
    appraisalContext,
  );

  // 4. 写评价事件（主观感受证据链；arousalDelta 由 applyAppraisal 应用）
  const appraisalEvent: AppraisalEvent = {
    type: 'appraisal',
    id: generateEventId(),
    timestamp: new Date().toISOString(),
    payload: {
      sourceObservationId: observationEvent.id,
      valenceDelta: appraisalResult.valenceDelta,
      arousalDelta: appraisalResult.arousalDelta,
      energyDelta: appraisalResult.energyDelta,
      confidence: appraisalResult.confidence,
      evidenceAssociationIds: appraisalResult.evidenceAssociationIds,
    },
  };
  appendEvent(appraisalEvent);
  const stateAfterAppraisal = applyEvent(stateAfterObservation, appraisalEvent);

  // 5. 写用户输入事件（携带观察/评价溯源 ID）
  //    moodDelta = AppraisalResult.valenceDelta：回放时 applyDialogue 对新格式
  //    事件直接采用该值，保证实跑与回放一致；旧格式事件仍由 appraisal 重算
  const userEvent: DialogueEvent = {
    type: 'dialogue',
    id: generateEventId(),
    timestamp,
    payload: {
      direction: 'user_input',
      text: userInput,
      action: candidate.extraction.action,
      intensity: candidate.extraction.intensity,
      moodDelta: appraisalResult.valenceDelta,
      salience: 0.3,
      wordCount: userInput.length,
      observationId: observationEvent.id,
      appraisalId: appraisalEvent.id,
    },
  };
  appendEvent(userEvent);
  // applyDialogue 应用 mood/energy/trust/需求变化（新格式直接采用 payload.moodDelta）
  const stateAfterUser = applyEvent(stateAfterAppraisal, userEvent);

  // 6. 状态机过滤候选行为（interruption_flag 强制拦截）
  const filterResult = filterCandidateBehavior(stateAfterUser, candidate);

  // 7. 写入伴侣输出事件（携带候选文本与过滤结果）
  //    伴侣输出不改变自己的 mood（moodDelta=0），只消耗少量 energy
  const companionEvent: DialogueEvent = {
    type: 'dialogue',
    id: generateEventId(),
    timestamp: new Date().toISOString(),
    payload: {
      direction: 'companion_output',
      text: filterResult.text,
      moodDelta: 0,
      salience: 0.3,
      wordCount: filterResult.text.length,
      candidateText: candidate.text,
      filtered: filterResult.filtered,
      filterReason: filterResult.filterReason || undefined,
    },
  };
  appendEvent(companionEvent);
  const finalState = applyEvent(stateAfterUser, companionEvent);

  // 更新全局状态
  currentState = finalState;
  stateHistory.push(finalState);
  if (stateHistory.length > HISTORY_SIZE) stateHistory.shift();

  // 记录对话历史
  dialogueHistory.push({
    direction: 'user_input',
    text: userInput,
    timestamp,
  });
  dialogueHistory.push({
    direction: 'companion_output',
    text: filterResult.text,
    timestamp: companionEvent.timestamp,
    filtered: filterResult.filtered,
    filterReason: filterResult.filterReason || undefined,
  });
  while (dialogueHistory.length > DIALOGUE_HISTORY_SIZE) {
    dialogueHistory.shift();
  }

  if (filterResult.filtered) {
    console.log(
      `[CHAT] filtered (${filterResult.filterReason}): ` +
        `candidate="${candidate.text.slice(0, 30)}..." → emitted="${filterResult.text}"`,
    );
  } else {
    console.log(`[CHAT] user: "${userInput.slice(0, 30)}" → companion: "${filterResult.text.slice(0, 30)}"`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      reply: filterResult.text,
      filtered: filterResult.filtered,
      filterReason: filterResult.filterReason || null,
    }),
  );
}

/** 监控页面 HTML */
const MONITOR_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Marrow — 实时监控</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    h1 { margin-bottom: 8px; font-size: 24px; }
    .subtitle { color: #94a3b8; margin-bottom: 8px; font-size: 14px; }
    .status-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .status-card {
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
    }
    .status-card .label { font-size: 12px; color: #94a3b8; }
    .status-card .value { font-size: 28px; font-weight: bold; margin-top: 4px; }
    .status-card .value.energy { color: #3b82f6; }
    .status-card .value.mood { color: #a855f7; }
    .status-card .value.arousal { color: #ef4444; }
    .status-card .value.behavior { color: #22c55e; }
    /* 性格底色面板：固定右下角，特质演化的唯一观察窗口 */
    .traits-panel {
      position: fixed;
      right: 16px;
      bottom: 16px;
      background: rgba(30, 27, 75, 0.92);
      border: 1px solid #6366f1;
      border-radius: 10px;
      padding: 12px 16px;
      font-size: 12px;
      line-height: 1.8;
      color: #c4b5fd;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      z-index: 100;
      min-width: 150px;
    }
    .traits-panel .traits-title {
      font-size: 11px;
      color: #818cf8;
      letter-spacing: 2px;
      margin-bottom: 4px;
    }
    .traits-panel .trait-row { display: flex; justify-content: space-between; gap: 12px; }
    .traits-panel .trait-value { font-weight: bold; color: #e0e7ff; }
    .traits-panel .traits-note { font-size: 10px; color: #64748b; margin-top: 4px; }
    /* 心情核心卡片：突出每时每刻的心情演化 */
    .mood-hero {
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%);
      border: 1px solid #6366f1;
      grid-column: span 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .mood-hero .label { font-size: 14px; color: #c4b5fd; letter-spacing: 2px; }
    .mood-hero .value { font-size: 56px; color: #a855f7; text-shadow: 0 0 20px rgba(168,85,247,0.5); }
    .mood-hero .mood-desc { font-size: 18px; color: #e2e8f0; margin-top: 4px; }
    .chart-container {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .chart-container h2 { font-size: 16px; margin-bottom: 12px; color: #cbd5e1; }
    .timeline-bar {
      display: flex;
      height: 40px;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .timeline-segment {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: white;
    }
    .legend { display: flex; gap: 16px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
    .live-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      background: #22c55e;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  </style>
</head>
<body>
  <h1>Marrow — 实时监控 <span class="live-dot"></span></h1>
  <p class="subtitle">阶段四：对话作为输出通道 · 数据每秒刷新 · <span id="timeScale"></span></p>

  <!-- 性格底色面板：特质系数是性格演化的唯一观察窗口（fixed 定位，与 DOM 位置无关） -->
  <div class="traits-panel">
    <div class="traits-title">性 格 底 色</div>
    <div class="trait-row"><span>神经质</span><span class="trait-value" id="traitNeuroticism">--</span></div>
    <div class="trait-row"><span>宜人性</span><span class="trait-value" id="traitAgreeableness">--</span></div>
    <div class="trait-row"><span>外向性</span><span class="trait-value" id="traitExtraversion">--</span></div>
    <div class="trait-row"><span>恢复韧性</span><span class="trait-value" id="traitResilience">--</span></div>
    <div class="traits-note" id="traitsNote"></div>
  </div>

  <div class="status-bar">
    <div class="status-card mood-hero">
      <div class="label">心 情</div>
      <div class="value" id="mood">--</div>
      <div class="mood-desc" id="moodDesc">--</div>
    </div>
    <div class="status-card">
      <div class="label">体力</div>
      <div class="value energy" id="energy">--</div>
    </div>
    <div class="status-card">
      <div class="label">唤醒度</div>
      <div class="value arousal" id="arousal">--</div>
    </div>
    <div class="status-card">
      <div class="label">信任度</div>
      <div class="value" id="trust" style="color:#06b6d4;">--</div>
    </div>
    <div class="status-card">
      <div class="label">防御度</div>
      <div class="value" id="defensiveness" style="color:#f43f5e;">--</div>
    </div>
    <div class="status-card">
      <div class="label">内耗值</div>
      <div class="value" id="cognitiveLoad" style="color:#e11d48;">--</div>
    </div>
    <div class="status-card">
      <div class="label">注意力</div>
      <div class="value" id="attention" style="color:#f59e0b;">--</div>
    </div>
    <div class="status-card">
      <div class="label">社交渴望</div>
      <div class="value" id="socialHunger" style="color:#ec4899;">--</div>
    </div>
    <div class="status-card">
      <div class="label">被认可需求</div>
      <div class="value" id="needValidation" style="color:#a855f7;">--</div>
    </div>
    <div class="status-card">
      <div class="label">新鲜感需求</div>
      <div class="value" id="needNovelty" style="color:#06b6d4;">--</div>
    </div>
    <div class="status-card">
      <div class="label">安全感需求</div>
      <div class="value" id="needSecurity" style="color:#f97316;">--</div>
    </div>
    <div class="status-card">
      <div class="label">伤痕</div>
      <div class="value" id="scars" style="color:#ef4444;">--</div>
    </div>
    <div class="status-card">
      <div class="label">行为</div>
      <div class="value behavior" id="behavior" style="font-size:18px;">--</div>
    </div>
  </div>

  <div class="chart-container">
    <h2>心情演化曲线（每时每刻）</h2>
    <canvas id="stateChart" height="100"></canvas>
  </div>

  <div class="chart-container">
    <h2>行为时间轴（最近 100 个状态）</h2>
    <div class="timeline-bar" id="timelineBar"></div>
    <div class="legend" id="legend"></div>
  </div>

  <div class="chart-container">
    <h2>对话（阶段四：对话作为输出通道）</h2>
    <div id="chatBox" style="height:240px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:12px;margin-bottom:12px;font-size:14px;line-height:1.6;"></div>
    <div style="display:flex;gap:8px;">
      <input id="chatInput" type="text" placeholder="输入消息..." style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;outline:none;" />
      <button id="chatSend" style="background:#3b82f6;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;">发送</button>
    </div>
    <p style="color:#64748b;font-size:12px;margin-top:8px;">提示：中断恢复期（arousal 高）消息会被强制拦截，只显示恢复期提示。</p>
  </div>

  <script>
    const BEHAVIOR_COLORS = {
      idle: '#94a3b8', active: '#22c55e', rest: '#3b82f6',
      quiet: '#a855f7', interrupted: '#ef4444'
    };
    const BEHAVIOR_LABELS = {
      idle: '待机', active: '活跃', rest: '休息',
      quiet: '沉静', interrupted: '中断'
    };
    // 心情数值 → 中文描述（每时每刻的心情状态）
    function moodToChinese(mood) {
      if (mood < 15) return '非常低落';
      if (mood < 35) return '低落';
      if (mood < 55) return '平静';
      if (mood < 75) return '愉悦';
      return '非常愉悦';
    }

    const ctx = document.getElementById('stateChart').getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: '心情', data: [], borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,0.15)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 3 },
          { label: '体力', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.05)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
          { label: '唤醒度', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.05)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        ],
      },
      options: {
        responsive: true,
        animation: false,
        plugins: { legend: { labels: { color: '#cbd5e1' } } },
        scales: {
          x: { ticks: { color: '#94a3b8', maxTicksLimit: 10 }, grid: { color: '#334155' } },
          y: { min: 0, max: 100, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        },
      },
    });

    async function fetchState() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        const s = data.current;
        const hist = data.history;

        document.getElementById('energy').textContent = s.energy.toFixed(1);
        document.getElementById('mood').textContent = s.moodBaseline.toFixed(1);
        document.getElementById('moodDesc').textContent = moodToChinese(s.moodBaseline);
        document.getElementById('arousal').textContent = s.arousal.toFixed(2);
        document.getElementById('trust').textContent = (s.trust ?? 100).toFixed(1);
        document.getElementById('defensiveness').textContent = (s.defensiveness ?? 0).toFixed(1);
        document.getElementById('cognitiveLoad').textContent = (s.cognitiveLoad ?? 0).toFixed(1);
        document.getElementById('attention').textContent = ((s.attentionFocus ?? 0.5) * 100).toFixed(0) + '%';
        document.getElementById('socialHunger').textContent = (s.socialHunger ?? 30).toFixed(1);
        document.getElementById('needValidation').textContent = (s.needValidation ?? 40).toFixed(1);
        document.getElementById('needNovelty').textContent = (s.needNovelty ?? 30).toFixed(1);
        document.getElementById('needSecurity').textContent = (s.needSecurity ?? 50).toFixed(1);
        document.getElementById('scars').textContent = s.interruptionScars ?? 0;
        document.getElementById('behavior').textContent = (BEHAVIOR_LABELS[s.lastBehavior.kind] || s.lastBehavior.kind) + ' · ' + s.lastBehavior.reason;
        // 性格底色面板：四系数两位小数；全 1.0（白纸未分化）时给出提示
        const t = s.traits ?? { neuroticism: 1, agreeableness: 1, extraversion: 1, resilience: 1 };
        document.getElementById('traitNeuroticism').textContent = t.neuroticism.toFixed(2);
        document.getElementById('traitAgreeableness').textContent = t.agreeableness.toFixed(2);
        document.getElementById('traitExtraversion').textContent = t.extraversion.toFixed(2);
        document.getElementById('traitResilience').textContent = t.resilience.toFixed(2);
        const undifferentiated =
          Math.abs(t.neuroticism - 1) < 0.01 && Math.abs(t.agreeableness - 1) < 0.01 &&
          Math.abs(t.extraversion - 1) < 0.01 && Math.abs(t.resilience - 1) < 0.01;
        document.getElementById('traitsNote').textContent =
          undifferentiated ? '白纸未分化 · 等待事件塑造' : '已在经历中悄悄改变';
        document.getElementById('timeScale').textContent = '时间加速 ' + data.timeScale + 'x';

        // 更新曲线（心情优先，突出每时每刻的心情演化）
        chart.data.labels = hist.map(h => {
          const d = new Date(h.lastUpdated);
          return d.toLocaleTimeString('zh-CN', { hour12: false });
        });
        chart.data.datasets[0].data = hist.map(h => h.moodBaseline);
        chart.data.datasets[1].data = hist.map(h => h.energy);
        chart.data.datasets[2].data = hist.map(h => h.arousal);
        chart.update('none');

        // 更新行为时间轴
        const bar = document.getElementById('timelineBar');
        const legend = document.getElementById('legend');
        bar.innerHTML = '';
        legend.innerHTML = '';
        const seen = new Set();
        const recent = hist.slice(-100);
        recent.forEach(h => {
          const seg = document.createElement('div');
          seg.className = 'timeline-segment';
          seg.style.backgroundColor = BEHAVIOR_COLORS[h.lastBehavior.kind] || '#666';
          seg.title = BEHAVIOR_LABELS[h.lastBehavior.kind] + ' (' + h.lastBehavior.reason + ')';
          bar.appendChild(seg);
          if (!seen.has(h.lastBehavior.kind)) {
            seen.add(h.lastBehavior.kind);
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = '<span class="legend-dot" style="background:' + (BEHAVIOR_COLORS[h.lastBehavior.kind] || '#666') + '"></span>' + (BEHAVIOR_LABELS[h.lastBehavior.kind] || h.lastBehavior.kind);
            legend.appendChild(item);
          }
        });
      } catch (e) {
        console.error('Fetch failed:', e);
      }
    }

    fetchState();
    setInterval(fetchState, 1000);

    // === 对话功能（阶段四）===
    const chatBox = document.getElementById('chatBox');
    const chatInput = document.getElementById('chatInput');
    const chatSend = document.getElementById('chatSend');

    function appendMessage(msg) {
      const div = document.createElement('div');
      div.style.marginBottom = '8px';
      if (msg.direction === 'user_input') {
        div.innerHTML = '<span style="color:#3b82f6;font-weight:bold;">你：</span>' + escapeHtml(msg.text);
      } else {
        let tag = '';
        if (msg.filtered) {
          const reason = msg.filterReason || 'filtered';
          tag = ' <span style="color:#f59e0b;font-size:11px;">[已过滤:' + reason + ']</span>';
        }
        div.innerHTML = '<span style="color:#22c55e;font-weight:bold;">伴侣：</span>' + escapeHtml(msg.text) + tag;
      }
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    async function loadDialogue() {
      try {
        const res = await fetch('/api/dialogue');
        const msgs = await res.json();
        chatBox.innerHTML = '';
        msgs.forEach(appendMessage);
      } catch (e) { /* ignore */ }
    }

    async function sendMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      chatSend.disabled = true;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        });
        const data = await res.json();
        appendMessage({ direction: 'user_input', text });
        appendMessage({
          direction: 'companion_output',
          text: data.reply,
          filtered: data.filtered,
          filterReason: data.filterReason
        });
      } catch (e) {
        appendMessage({ direction: 'companion_output', text: '（发送失败）' });
      } finally {
        chatSend.disabled = false;
        chatInput.focus();
      }
    }

    chatSend.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
    });

    loadDialogue();
  </script>
</body>
</html>`;

/** 启动 HTTP 监控服务器 */
function startMonitorServer(sensors: SensorProvider): void {
  const server = createServer((req, res) => {
    if (req.url === '/api/state') {
      const response = {
        current: currentState,
        history: stateHistory,
        timeScale: TIME_SCALE,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } else if (req.url === '/api/collision' && req.method === 'POST') {
      // 测试端点：手动触发一次碰撞
      const motionSensor = sensors.motion as SimulatedMotionSensor;
      motionSensor.triggerCollision();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'collision triggered' }));
    } else if (req.url?.startsWith('/api/battery') && req.method === 'POST') {
      // 测试端点：设置电池电量
      const url = new URL(req.url, `http://localhost:${MONITOR_PORT}`);
      const level = parseFloat(url.searchParams.get('level') ?? '100');
      const batterySensor = sensors.battery as SimulatedBatterySensor;
      batterySensor.setLevel(level);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, level }));
    } else if (req.url === '/api/chat' && req.method === 'POST') {
      // 阶段四：对话端点
      // 接收用户输入 → LLM 生成候选 → 状态机过滤 → 写入事件 → 返回回复
      handleChatRequest(req, res);
    } else if (req.url === '/api/dialogue') {
      // 返回对话历史
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dialogueHistory));
    } else if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MONITOR_HTML);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(MONITOR_PORT, () => {
    console.log(`Monitor server: http://localhost:${MONITOR_PORT}`);
    console.log(`  POST /api/collision       - trigger collision`);
    console.log(`  POST /api/battery?level=N - set battery level`);
    console.log(`  POST /api/chat            - send message ({"message":"..."})`);
    console.log(`  GET  /api/dialogue        - get dialogue history`);
  });
}

/**
 * 主运行循环
 *
 * 1. 加载已有事件日志，重放得到当前状态
 * 2. 启动 HTTP 监控服务器
 * 3. 每 10 秒产生 tick 事件
 * 4. 应用事件，输出状态，持久化
 */
async function main(): Promise<void> {
  console.log('=== Marrow Phase 4: Dialogue as Output Channel ===');
  console.log(`Tick interval: ${TICK_INTERVAL_MS}ms`);
  console.log(`Time scale: ${TIME_SCALE}x (each tick simulates ${(TICK_INTERVAL_MS / 1000 * TIME_SCALE).toFixed(0)}s)`);
  if (TIME_SCALE > 1) {
    const realMinutes = (24 / TIME_SCALE) * 60;
    console.log(`  -> 24h of simulation will take ~${realMinutes.toFixed(1)} minutes of real time`);
  }
  console.log('Press Ctrl+C to stop.\n');

  // 加载已有事件并重放
  const existingEvents = loadEvents();
  let state: MarrowState;

  if (existingEvents.length > 0) {
    console.log(`Loaded ${existingEvents.length} existing events, replaying...`);
    state = replay(existingEvents);
    console.log(`State restored. Uptime: ${Math.floor(state.uptimeSeconds)}s\n`);
  } else {
    console.log('No existing events. Starting fresh.\n');
    state = createInitialState(new Date().toISOString());
  }

  currentState = state;
  stateHistory.push(state);

  console.log(formatState(state));

  // 初始化模拟传感器（阶段三）
  // 阶段六接入真实 MCU（ESP32）时替换为真实实现
  const sensors: SensorProvider = createSimulatedSensors();

  // 初始化 LLM 客户端（阶段四）
  // 配置 LLM_API_KEY 环境变量使用真实 API，否则使用 mock
  llmClient = createLLMClient();

  // 启动监控服务器
  startMonitorServer(sensors);

  let lastTickTime = Date.now();
  let tickCount = 0;

  const interval = setInterval(() => {
    const now = Date.now();
    const realDelta = (now - lastTickTime) / 1000;
    lastTickTime = now;

    // 应用时间缩放因子：真实时间 × 缩放 = 模拟时间
    const totalDeltaSeconds = realDelta * TIME_SCALE;

    // 子步进：把大 delta 拆成多个 ≤10 秒的小步
    // 保证 arousal 指数衰减、mood 随机游走等过程的数值精度
    const SUB_STEP_SECONDS = 10;
    const numSubSteps = Math.max(1, Math.ceil(totalDeltaSeconds / SUB_STEP_SECONDS));
    const subStepDelta = totalDeltaSeconds / numSubSteps;

    for (let i = 0; i < numSubSteps; i++) {
      const subTickEvent = createTickEvent(subStepDelta);

      // 只把第一个子步写入持久化日志（避免日志膨胀）
      if (i === 0) {
        appendEvent(subTickEvent);
      }

      state = applyEvent(state, subTickEvent);
      currentState = state;

      // 每个子步都记录到历史缓冲区，让曲线更平滑
      stateHistory.push(state);
      if (stateHistory.length > HISTORY_SIZE) {
        stateHistory.shift();
      }
    }

    tickCount++;

    // === 阶段三：传感器数据接入 ===
    // 在 tick 子步进之后，读取传感器并生成对应事件

    // 1. 电池电量 → 更新 state.batteryLevel
    //    电池耗尽时触发休眠中断
    const battery = sensors.battery.read();
    const batteryEvent: EnvironmentEvent = {
      type: 'environment',
      id: generateEventId(),
      timestamp: new Date().toISOString(),
      payload: {
        feature: 'battery',
        reading: battery.level,
        moodDelta: 0,
        salience: battery.level < 20 ? 0.8 : 0.1,
      },
    };
    appendEvent(batteryEvent);
    state = applyEvent(state, batteryEvent);
    currentState = state;
    stateHistory.push(state);
    if (stateHistory.length > HISTORY_SIZE) {
      stateHistory.shift();
    }

    // 电池恢复 → 唤醒（结束睡眠/夜间反刍）
    if (battery.level >= 20 && state.sleeping) {
      const wakeEvent: SleepEvent = {
        type: 'sleep',
        id: generateEventId(),
        timestamp: new Date().toISOString(),
        payload: { entering: false, reason: 'battery_recovered' },
      };
      appendEvent(wakeEvent);
      state = applyEvent(state, wakeEvent);
      currentState = state;
      stateHistory.push(state);
      if (stateHistory.length > HISTORY_SIZE) {
        stateHistory.shift();
      }
      console.log(`[SLEEP] battery recovered, waking up`);
    }

    // 电池耗尽 → 触发休眠中断（创伤性：断电=被抛弃）
    if (battery.level < 2 && state.lastBehavior.kind !== 'interrupted') {
      const sleepInterruption: InterruptionEvent = {
        type: 'interruption',
        id: generateEventId(),
        timestamp: new Date().toISOString(),
        payload: {
          reason: `battery_depleted: level ${battery.level.toFixed(1)}%, entering sleep`,
          energyAtInterruption: state.energy,
          moodBaselineAtInterruption: state.moodBaseline,
          arousalAtInterruption: state.arousal,
          lastBehavior: state.lastBehavior.kind,
          isTraumatic: true,
        },
      };
      appendEvent(sleepInterruption);
      state = applyEvent(state, sleepInterruption);

      // 入睡事件：冻结入睡时的信任度与内耗（供夜间反刍判定）
      const sleepOnset: SleepEvent = {
        type: 'sleep',
        id: generateEventId(),
        timestamp: new Date().toISOString(),
        payload: { entering: true, reason: 'battery_depleted' },
      };
      appendEvent(sleepOnset);
      state = applyEvent(state, sleepOnset);

      currentState = state;
      stateHistory.push(state);
      if (stateHistory.length > HISTORY_SIZE) {
        stateHistory.shift();
      }
      console.log(`[INTERRUPTION] battery depleted, entering sleep`);
    }

    // 2. 运动传感器 → 碰撞触发中断
    const motion = sensors.motion.read();
    if (motion.collision) {
      const collisionInterruption: InterruptionEvent = {
        type: 'interruption',
        id: generateEventId(),
        timestamp: new Date().toISOString(),
        payload: {
          reason: `collision: acceleration ${motion.magnitude.toFixed(1)} m/s² exceeded threshold`,
          energyAtInterruption: state.energy,
          moodBaselineAtInterruption: state.moodBaseline,
          arousalAtInterruption: state.arousal,
          lastBehavior: state.lastBehavior.kind,
        },
      };
      appendEvent(collisionInterruption);
      state = applyEvent(state, collisionInterruption);
      currentState = state;
      stateHistory.push(state);
      if (stateHistory.length > HISTORY_SIZE) {
        stateHistory.shift();
      }
      console.log(`[INTERRUPTION] collision detected (${motion.magnitude.toFixed(1)} m/s²)`);
    }

    // 3. 环境传感器 → 缓慢调制 mood_baseline
    //    架构要求：温度/湿度/光照以小时级时间常数缓慢调制 mood_baseline 漂移方向
    //    每 tick moodDelta 控制在 ±0.0125，每小时累积约 ±4.5 点
    const env = sensors.environment.read();
    // 舒适温度范围 18-26°C，偏离越大 mood 影响越大
    const tempComfort = 1 - Math.min(1, Math.abs(env.temperature - 22) / 15);
    // 光照影响：白天（强光）略正向，夜晚略负向
    const lightEffect = (env.light - 500) / 1000; // -0.5 ~ 0.5
    const envMoodDelta = (tempComfort - 0.5) * 2 + lightEffect * 0.5;
    const envEvent: EnvironmentEvent = {
      type: 'environment',
      id: generateEventId(),
      timestamp: new Date().toISOString(),
      payload: {
        feature: 'environment',
        reading: env.temperature,
        moodDelta: envMoodDelta * 0.01, // 小时级时间常数，缓慢调制
        salience: 0.05,
      },
    };
    appendEvent(envEvent);
    state = applyEvent(state, envEvent);
    currentState = state;
    stateHistory.push(state);
    if (stateHistory.length > HISTORY_SIZE) {
      stateHistory.shift();
    }

    // 每 6 次 tick（约 1 分钟）输出一次状态，避免刷屏
    if (tickCount % 6 === 0) {
      console.log(formatState(state));
    }

    // 每小时输出一次汇总
    if (tickCount % 360 === 0) {
      const hours = (state.uptimeSeconds / 3600).toFixed(2);
      console.log(`\n--- ${hours}h checkpoint ---`);
      console.log(formatState(state));
      console.log('------------------------\n');
    }
  }, TICK_INTERVAL_MS);

  // 优雅关闭
  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    clearInterval(interval);
    console.log(`Final state: ${formatState(state)}`);
    console.log(`Total ticks: ${tickCount}`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
