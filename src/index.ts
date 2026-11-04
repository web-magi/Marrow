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
import { applyEvent, evokeMemoryFromText, computeEpisodicMemoryCandidate, type MarrowState } from './state.js';
import { appendEvents, IDENTITY_ID, generateEventId, queryEventRows, countEvents, type QueryEventRowsOptions } from './storage.js';
import {
  acquireIdentityOwnership,
  freshStartIdentity,
  recoverIdentityOrThrow,
  releaseIdentityOwnership,
} from './recovery.js';
import { executeTick, type TickSession } from './tick.js';
import {
  assertObservationBarrier,
  InMemoryObservationInbox,
  ObservationBarrierError,
} from './observation.js';
import {
  ChatAdmissionRemovedError,
  ChatWaitTimeoutError,
  getRuntimeSession,
  RuntimeQueueFullError,
  RuntimeSessionClosedError,
  type ChatAdmission,
} from './runtime-session.js';
import { closeDb } from './db/connection.js';
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
  MemoryFormationEvent,
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

/**
 * 传感器观测收件箱（M1.2.2.2-A 单进程过渡实现）
 *
 * 与 Tick、Chat 屏障共用同一实例：Tick 读取后未确认的观测会阻止 Chat 提交，
 * 避免对话事件越过待恢复观测导致事件日志时间倒退。
 * 进程重启会丢失未确认观测；跨进程可靠性留给未来的持久化 Inbox。
 */
const observationInbox = new InMemoryObservationInbox();

/**
 * Chat 等待超时（毫秒）
 *
 * M1.2.2-C1：从 reserveChat() 开始计时，覆盖 extracting/ready/waiting 阶段；
 * 超时后 admission 被物理移出队列并释放容量。
 */
const CHAT_WAIT_TIMEOUT_MS = Math.max(
  1,
  parseInt(process.env.CHAT_WAIT_TIMEOUT_MS ?? '30000', 10),
);

/**
 * 单 identity RuntimeSession（M1.2.2-C，已完成 C1/C2/C3）
 *
 * Chat 与 Tick 的所有状态变更、事件持久化与内存状态发布都在其单执行器内
 * 串行执行；A 阶段的 identity-lock 临时机制已被完全取代并移除（C3）。
 * 优雅关闭时通过 runtimeSession.shutdown() 排空队列并等待执行中任务完成。
 */
const runtimeSession = getRuntimeSession(IDENTITY_ID, {
  chatWaitTimeoutMs: CHAT_WAIT_TIMEOUT_MS,
});

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

  // C1：先占用 admission 容量（同步），第 33 个请求在 LLM 提取前被拒绝
  let admission: ChatAdmission;
  try {
    admission = runtimeSession.reserveChat();
  } catch (err) {
    if (err instanceof RuntimeQueueFullError) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat queue full', code: err.code }));
      return;
    }
    if (err instanceof RuntimeSessionClosedError) {
      // C3：会话正在关闭，不再接受新任务
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session closing', code: err.code }));
      return;
    }
    throw err;
  }

  const state = currentState;
  let candidate: {
    text: string;
    action: import('./events.js').DialogueAction;
    intensity: number;
    extraction: ExtractionResult;
  };

  // 1. 调用 LLM：提取客观事实 + 生成回复文本
  //    LLM 只做意图提取和文本渲染，不计算情绪效价；
  //    extracting 计入容量但不占用执行器。
  //    C3：传入 admission.signal——等待超时/释放/关闭会取消底层请求；
  //    即使模型不支持取消，迟到结果也会被 markReady 丢弃。
  try {
    const snapshot = buildStateSnapshot(state);
    candidate = await llmClient.generateResponse(snapshot, userInput, admission.signal);
  } catch (err) {
    if (admission.signal.aborted) {
      // admission 已因等待超时/关闭被移除：容量已释放，结果不会进入执行器
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat removed', code: 'chat_removed' }));
      return;
    }
    console.error('[LLM] generateResponse failed:', err);
    // 提取失败：释放容量，绝不进入执行器
    runtimeSession.release(admission, 'extraction failed');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'extraction failed', code: 'chat_extraction_failed' }),
    );
    return;
  }

  // C1：把状态变更、持久化、内存状态发布作为单一任务交给执行器串行执行。
  // 事件时间戳在任务真正执行时生成，避免排队等待期间使用过期时间。
  runtimeSession.markReady(admission, async () => {
      // 观测恢复屏障：存在未确认观测时拒绝提交，绝不越过 pending 观测
      await assertObservationBarrier(observationInbox);
      const state = currentState;
      if (!state) throw new Error('system not ready');

      // C2：同一 Chat 任务内事件时间戳必须单调递增。
      // 事件逐条写库时后一条不能早于前一条，否则事件日志时间轴倒退；
      // 与 Tick 的互斥由 RuntimeSession 单执行器保证。
      let lastTimestamp = '';
      const stamp = (): string => {
        const now = new Date().toISOString();
        if (now > lastTimestamp) lastTimestamp = now;
        return lastTimestamp;
      };
      const timestamp = stamp();

    // 2. 构建观察事件（纯事实记录，不驱动状态变化）
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

    // 4. 构建评价事件（主观感受证据链；arousalDelta 由 applyAppraisal 应用）
    const appraisalEvent: AppraisalEvent = {
      type: 'appraisal',
      id: generateEventId(),
      timestamp: stamp(),
      payload: {
        sourceObservationId: observationEvent.id,
        valenceDelta: appraisalResult.valenceDelta,
        arousalDelta: appraisalResult.arousalDelta,
        energyDelta: appraisalResult.energyDelta,
        confidence: appraisalResult.confidence,
        evidenceAssociationIds: appraisalResult.evidenceAssociationIds,
      },
    };
    const stateAfterAppraisal = applyEvent(stateAfterObservation, appraisalEvent);

    // 5. 构建用户输入事件（携带观察/评价溯源 ID）
    //    moodDelta = AppraisalResult.valenceDelta：回放时 applyDialogue 对新格式
    //    事件直接采用该值，保证实跑与回放一致；旧格式事件仍由 appraisal 重算
    const userEvent: DialogueEvent = {
      type: 'dialogue',
      id: generateEventId(),
      // 写在评价事件之后，时间戳必须不小于评价事件，避免日志时间倒退
      timestamp: stamp(),
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
    // applyDialogue 应用 mood/energy/trust/需求变化（新格式直接采用 payload.moodDelta）
    const stateAfterUser = applyEvent(stateAfterAppraisal, userEvent);

    // ══════════════════════════════════════════════════════════════════
    // M1.4.1：EpisodicMemory 事件化 —— 创建 MemoryFormationEvent
    //
    // 单一计算入口：computeEpisodicMemoryCandidate(state, event, evoked, baseValence)
    // 内部封装 weightedMoodDelta + memoryMoodDelta + 沉淀门槛 + 记忆构造
    // 避免 index.ts 与 state.ts 分别维护同一套公式
    // ══════════════════════════════════════════════════════════════════
    const formedMem = computeEpisodicMemoryCandidate(
      stateAfterAppraisal,
      userEvent,
      evoked,
      userEvent.payload.moodDelta ?? 0,
    );

    const memoryFormationEvent: MemoryFormationEvent | null = formedMem
      ? {
          type: 'memory_formation',
          id: generateEventId(),
          timestamp: stamp(),
          payload: {
            sourceDialogueEventId: userEvent.id,
            memory: formedMem,
          },
        }
      : null;

    // 本地内存状态链必须与事件链顺序一致：
    //   Obs → Appr → User → [MemoryFormation] → Companion
    // 这样 finalState = applyEvent(applyEvent(stateAfterUser, mem?), companionEvent)
    // 与回放事件序列逐事件重跑终态完全相同
    let stateAfterChain: MarrowState = stateAfterUser;
    if (memoryFormationEvent) {
      stateAfterChain = applyEvent(stateAfterChain, memoryFormationEvent);
    }

    // 6. 状态机过滤候选行为（interruption_flag 强制拦截）
    const filterResult = filterCandidateBehavior(stateAfterChain, candidate);

    // 7. 构建伴侣输出事件（携带候选文本与过滤结果）
    //    伴侣输出不改变自己的 mood（moodDelta=0），只消耗少量 energy
    const companionEvent: DialogueEvent = {
      type: 'dialogue',
      id: generateEventId(),
      timestamp: stamp(),
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
    const finalState = applyEvent(stateAfterChain, companionEvent);

    // 8. M1.4.1：五事件（或四事件）在同一事务中原子提交。
    //    memoryFormationEvent 仅在满足沉淀门槛时创建；
    //    同一批次中 DialogueEvent(user_input) 必须先于 MemoryFormationEvent，
    //    MemoryFormationEvent 必须先于 DialogueEvent(companion_output)。
    //    事件序号在 batch 内部由 appendEvents 自动分配。
    const batch: Array<ObservationEvent | AppraisalEvent | DialogueEvent | MemoryFormationEvent> = [
      observationEvent,
      appraisalEvent,
      userEvent,
    ];
    if (memoryFormationEvent) batch.push(memoryFormationEvent);
    batch.push(companionEvent);
    await appendEvents(batch);

    // 更新全局状态（所有事件均已持久化，内存状态与事件流一致）
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

      return {
        reply: filterResult.text,
        filtered: filterResult.filtered,
        filterReason: filterResult.filterReason || null,
      };
  });

  // 提取完成时若 admission 已被超时移除，markReady 会丢弃任务；
  // 最终结果统一由 completion 给出（成功或明确异常）。
  try {
    const outcome = await admission.completion;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(outcome));
  } catch (err) {
    if (err instanceof ObservationBarrierError) {
      // 观测恢复屏障：存在未确认观测，拒绝提交本次对话事件，
      // 避免 Chat 越过 pending 观测造成事件日志时间倒退。
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'observations pending', code: err.code }),
      );
      return;
    }
    if (err instanceof ChatWaitTimeoutError) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat wait timeout', code: err.code }));
      return;
    }
    if (err instanceof ChatAdmissionRemovedError) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat removed', code: err.code }));
      return;
    }
    // 写库失败：中止本次请求，不更新全局状态，绝不静默回退
    console.error('[EventStore] 对话事件写入失败，中止本次请求:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'event persistence failed' }));
  }
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
  const server = createServer(async (req, res) => {
    // === 安全头 ===
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${MONITOR_PORT}`);

    // === 只读端点 ===
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        current: currentState,
        history: stateHistory,
        timeScale: TIME_SCALE,
      }));
    } else if (url.pathname === '/api/dialogue') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dialogueHistory));
    } else if (url.pathname === '/api/runtime') {
      // Runtime 状态快照（只读）
      const snapshot = runtimeSession.snapshot();
      const eventCount = await countEvents(IDENTITY_ID);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        identityId: snapshot.identityId,
        closed: snapshot.closed,
        uptimeSeconds: currentState?.uptimeSeconds ?? 0,
        eventCount,
        tick: snapshot.tick,
        queue: {
          active: snapshot.active,
          reserved: snapshot.reserved,
          ready: snapshot.ready,
          waiting: snapshot.waiting,
          running: snapshot.running,
          runningChatId: snapshot.runningChatId,
          runningTaskKind: snapshot.runningTaskKind,
        },
      }));
    } else if (url.pathname === '/api/events') {
      // EventStore 查询（只读，分页/过滤）
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }
      const options: QueryEventRowsOptions = {
        limit: parseInt(url.searchParams.get('limit') ?? '50', 10) || 50,
        offset: parseInt(url.searchParams.get('offset') ?? '0', 10) || 0,
        type: url.searchParams.getAll('type').length > 0
          ? url.searchParams.getAll('type')
          : undefined,
        since: url.searchParams.get('since') ?? undefined,
        until: url.searchParams.get('until') ?? undefined,
      };
      try {
        const rows = await queryEventRows(IDENTITY_ID, options);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    } else if (req.url === '/api/collision' && req.method === 'POST') {
      // 测试端点：手动触发一次碰撞
      const motionSensor = sensors.motion as SimulatedMotionSensor;
      motionSensor.triggerCollision();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'collision triggered' }));
    } else if (req.url?.startsWith('/api/battery') && req.method === 'POST') {
      // 测试端点：设置电池电量
      const level = parseFloat(url.searchParams.get('level') ?? '100');
      const batterySensor = sensors.battery as SimulatedBatterySensor;
      batterySensor.setLevel(level);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, level }));
    } else if (req.url === '/api/chat' && req.method === 'POST') {
      // 阶段四：对话端点
      // 接收用户输入 → LLM 生成候选 → 状态机过滤 → 写入事件 → 返回回复
      handleChatRequest(req, res);
    } else if (url.pathname === '/legacy/monitor') {
      // 旧 Monitor（迁移期保留）
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MONITOR_HTML);
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      // Dashboard V1：优先加载 Vue 构建产物，fallback 到旧 Monitor
      const dashboardIndex = join(process.cwd(), 'dashboard', 'dist', 'index.html');
      if (existsSync(dashboardIndex)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(dashboardIndex));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(MONITOR_HTML);
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(MONITOR_PORT, () => {
    console.log(`Monitor server: http://localhost:${MONITOR_PORT}`);
    console.log(`  GET  /                - Dashboard V1 (Vue, 构建后自动加载)`);
    console.log(`  GET  /legacy/monitor  - Legacy Monitor (内嵌 HTML)`);
    console.log(`  GET  /api/state       - current + history`);
    console.log(`  GET  /api/events      - EventStore 查询 (limit/offset/type/since/until)`);
    console.log(`  GET  /api/runtime     - Runtime 状态快照 (queue/tick/uptime/eventCount)`);
    console.log(`  GET  /api/dialogue    - 对话历史`);
    console.log(`  POST /api/chat        - send message ({"message":"..."})`);
    console.log(`  POST /api/collision   - trigger collision`);
    console.log(`  POST /api/battery?level=N - set battery level`);
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

  // === M1.2.4 启动恢复（先恢复，再开放任何入口） ===
  // 顺序：identity 所有权 → 哈希链验证 → 确定性 Replay → 状态校验。
  // 任何一步失败都会抛出异常，main().catch 使进程以非零状态退出——
  // HTTP 服务器 / Tick 调度器在本块之后才会启动，恢复失败时绝不提前开放。
  await acquireIdentityOwnership(IDENTITY_ID);

  const recovery = await recoverIdentityOrThrow(IDENTITY_ID);
  let state: MarrowState;

  if (recovery.verdict === 'empty') {
    // M1.3 Fresh Start：空 identity 必须在 ownership 锁内调用 freshStartIdentity()
    // 写入 GenesisEvent（首事件锚点）并完成 verify→append→verify→recover→compare 全链路闭环。
    // 不得在此分支直接 createInitialState() 绕过 Genesis——那会导致生产 identity
    // 永远没有首事件锚点，verifyEventChain 报 genesis_missing，每次重启循环 empty。
    //
    // ownership 锁已在 L951 获取并持续持有至 shutdown（L1110 release），
    // freshStartIdentity 内部还会二次 verifyEventChain 作为前置防御，
    // 确保同一 identity 不会被两个进程同时初始化。
    console.log('No existing events. Running Fresh Start → genesis anchor point.\n');
    const fresh = await freshStartIdentity(IDENTITY_ID);
    state = fresh.finalState!;
    console.log(
      `Fresh Start complete: genesis (sequence ${fresh.firstSequence}) written, ` +
        `Replay verified, state recovered.\n`,
    );
  } else {
    state = recovery.finalState!;
    console.log(
      `Recovered ${recovery.eventCount} events (sequence ${recovery.firstSequence}..${recovery.lastSequence}), ` +
        `last event at ${recovery.lastEventTimestamp}`,
    );
    // M1.2.4 停机边界：两次运行之间的停机期间不模拟任何身体/情绪/关系/记忆
    // 变化（停机补偿属后续独立设计）。状态就是最后一个已持久化事件的状态。
    console.log('[M1.2.4] 停机期间未模拟任何状态变化；新 Tick 从本次启动的时间基准开始。\n');
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

  // tick 会话：state / lastTickTime / tickCount 只有在批量事务提交成功后才推进
  const tickSession: TickSession = {
    state,
    // M1.2.4 时间边界：lastTickTime 故意取本次进程启动时刻，而不是
    // 最后一个历史事件的时间——停机期间不模拟，新 Tick 只覆盖本次运行
    // 的真实时间；这不是缺陷，是本阶段明确定义的语义。
    lastTickTime: Date.now(),
    tickCount: 0,
  };

  /**
   * 请求一轮 Tick（M1.2.2-C2）
   *
   * Tick 与 Chat 统一进入 RuntimeSession 的单执行器：
   * - 读取传感器、构建批次、持久化、确认观测、发布内存状态全部串行执行，
   *   不会与 Chat 的事件写入交错（A 阶段的双机制空窗已消除）
   * - 同一时刻最多一个 Tick 排队，重复请求自动合并
   * - 上一轮 Tick 失败后，下一轮自动升级为 recovery-tick（最高优先级）
   *
   * 事件时间戳在任务真正执行时生成；失败时整批回滚，
   * session.state / lastTickTime / tickCount 保持原样，下一轮自然补偿。
   */
  const runTick = async (): Promise<void> => {
    await runtimeSession
      .requestTick(async () => {
        try {
          const batch = await executeTick(
            tickSession,
            sensors,
            observationInbox,
            Date.now(),
            TIME_SCALE,
          );

          // 事务提交成功：发布内存状态与历史快照
          state = tickSession.state;
          currentState = state;
          for (const snapshot of batch.snapshots) {
            stateHistory.push(snapshot);
          }
          while (stateHistory.length > HISTORY_SIZE) {
            stateHistory.shift();
          }

          for (const notice of batch.notices) {
            console.log(notice);
          }

          // 每 6 次 tick（约 1 分钟）输出一次状态，避免刷屏
          if (tickSession.tickCount % 6 === 0) {
            console.log(formatState(state));
          }

          // 每小时输出一次汇总
          if (tickSession.tickCount % 360 === 0) {
            const hours = (state.uptimeSeconds / 3600).toFixed(2);
            console.log(`\n--- ${hours}h checkpoint ---`);
            console.log(formatState(state));
            console.log('------------------------\n');
          }

          return batch;
        } catch (err) {
          // 写库失败：中止本次 tick（不静默回退 JSONL），状态机停在本 tick 起点。
          // 异常继续向上抛出，RuntimeSession 会把下一轮 Tick 升级为 recovery-tick。
          console.error('[EventStore] tick 持久化失败，已中止本次 tick:', err);
          throw err;
        }
      })
      // 被合并的 Tick 请求共享同一结果；失败日志已在任务内输出一次
      .catch(() => undefined);
  };
  const interval = setInterval(() => {
    void runTick();
  }, TICK_INTERVAL_MS);

  // 优雅关闭（C3.1：drained 判定 + 显式 forced 路径）
  //
  // 正常路径：
  //   1. 停止定时 Tick（新任务入口由 RuntimeSession 关闭后同步拒绝）
  //   2. runtimeSession.shutdown()：排空等待队列、取消提取中的 LLM 请求、
  //      带宽限期等待执行中任务
  //   3. drained=true → 执行器已无 running 任务 → 允许 closeDb
  //      drained=false → 禁止立即 closeDb；waitForIdle() 等待 running 任务
  //      真正结束（成功/失败都记录日志），之后才能关闭数据库
  //   4. 数据库安全关闭后才 process.exit(0)
  //
  // forced shutdown（显式路径）：
  //   正常关闭期间再次收到 SIGINT/SIGTERM → 立即 process.exit(1)，
  //   可能中断执行中任务与数据库连接，日志明确标注为强制退出。
  let shutdownStarted = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) {
      console.error(
        `\n[Forced shutdown] 再次收到 ${signal}：立即退出，执行中任务与数据库连接可能被中断`,
      );
      process.exit(1);
    }
    shutdownStarted = true;

    console.log(`\nReceived ${signal}, shutting down...`);
    clearInterval(interval);

    const result = await runtimeSession.shutdown();
    console.log(
      `RuntimeSession shutdown: drained=${result.drained} running=${result.running} ` +
        `timedOut=${result.timedOut} drainedChats=${result.drainedChats} ` +
        `discardedTick=${result.discardedTick}`,
    );

    if (!result.drained) {
      // 禁止静默关闭数据库：执行中任务仍持有数据库事务，必须等它真正结束
      console.warn(
        '执行器未在宽限期内排空，等待 running task 真正结束后再关闭数据库 ' +
          '（再次发送信号可 forced shutdown）...',
      );
      const outcome = await runtimeSession.waitForIdle();
      console.log(`running task 最终结局: ${outcome}`);
    }

    // M1.2.4：先释放 identity 所有权锁（显式 unlock + 归还专用连接），
    // 再关闭连接池——顺序反过来会让所有权锁依赖连接池关闭兜底
    await releaseIdentityOwnership(IDENTITY_ID);
    await closeDb();
    console.log(`Final state: ${formatState(currentState!)}`);
    console.log(`Total ticks: ${tickSession.tickCount}`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
