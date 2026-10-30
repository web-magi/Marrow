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
import { createInitialState, applyEvent, type MarrowState } from './state.js';
import type { TickEvent } from './events.js';
import { replay } from './replay.js';
import { appendEvent, loadEvents, generateEventId } from './storage.js';

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
    .subtitle { color: #94a3b8; margin-bottom: 20px; font-size: 14px; }
    .status-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
  <p class="subtitle">阶段一：最小状态机 · 数据每秒刷新 · <span id="timeScale"></span></p>

  <div class="status-bar">
    <div class="status-card">
      <div class="label">Energy</div>
      <div class="value energy" id="energy">--</div>
    </div>
    <div class="status-card">
      <div class="label">Mood Baseline</div>
      <div class="value mood" id="mood">--</div>
    </div>
    <div class="status-card">
      <div class="label">Arousal</div>
      <div class="value arousal" id="arousal">--</div>
    </div>
    <div class="status-card">
      <div class="label">Behavior</div>
      <div class="value behavior" id="behavior" style="font-size:18px;">--</div>
    </div>
    <div class="status-card">
      <div class="label">Uptime</div>
      <div class="value" id="uptime" style="font-size:18px;">--</div>
    </div>
    <div class="status-card">
      <div class="label">Interruptions</div>
      <div class="value" id="interruptions" style="font-size:18px;">--</div>
    </div>
  </div>

  <div class="chart-container">
    <h2>状态曲线（实时）</h2>
    <canvas id="stateChart" height="100"></canvas>
  </div>

  <div class="chart-container">
    <h2>行为时间轴（最近 100 个状态）</h2>
    <div class="timeline-bar" id="timelineBar"></div>
    <div class="legend" id="legend"></div>
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

    const ctx = document.getElementById('stateChart').getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Energy', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
          { label: 'Mood', data: [], borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
          { label: 'Arousal', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
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
        document.getElementById('arousal').textContent = s.arousal.toFixed(2);
        document.getElementById('behavior').textContent = (BEHAVIOR_LABELS[s.lastBehavior.kind] || s.lastBehavior.kind) + ' · ' + s.lastBehavior.reason;
        document.getElementById('uptime').textContent = Math.floor(s.uptimeSeconds) + 's';
        document.getElementById('interruptions').textContent = s.interruptionCount;
        document.getElementById('timeScale').textContent = '时间加速 ' + data.timeScale + 'x';

        // 更新曲线
        chart.data.labels = hist.map(h => {
          const d = new Date(h.lastUpdated);
          return d.toLocaleTimeString('zh-CN', { hour12: false });
        });
        chart.data.datasets[0].data = hist.map(h => h.energy);
        chart.data.datasets[1].data = hist.map(h => h.moodBaseline);
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
  </script>
</body>
</html>`;

/** 启动 HTTP 监控服务器 */
function startMonitorServer(): void {
  const server = createServer((req, res) => {
    if (req.url === '/api/state') {
      const response = {
        current: currentState,
        history: stateHistory,
        timeScale: TIME_SCALE,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
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
  console.log('=== Marrow Phase 1: Minimal State Machine ===');
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

  // 启动监控服务器
  startMonitorServer();

  let lastTickTime = Date.now();
  let tickCount = 0;

  const interval = setInterval(() => {
    const now = Date.now();
    const realDelta = (now - lastTickTime) / 1000;
    lastTickTime = now;

    // 应用时间缩放因子：真实时间 × 缩放 = 模拟时间
    const deltaSeconds = realDelta * TIME_SCALE;

    const tickEvent = createTickEvent(deltaSeconds);
    appendEvent(tickEvent);

    state = applyEvent(state, tickEvent);
    currentState = state;
    stateHistory.push(state);

    // 限制历史缓冲区大小
    if (stateHistory.length > HISTORY_SIZE) {
      stateHistory.shift();
    }

    tickCount++;

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
