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
    .status-card .value.battery { color: #f59e0b; }
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
  <p class="subtitle">阶段三：环境与中断接入 · 数据每秒刷新 · <span id="timeScale"></span></p>

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
      <div class="label">Battery</div>
      <div class="value battery" id="battery">--</div>
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
        document.getElementById('battery').textContent = (s.batteryLevel ?? 100).toFixed(1) + '%';
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

  // 初始化模拟传感器（阶段三）
  // 阶段六接入真实 MCU（ESP32）时替换为真实实现
  const sensors: SensorProvider = createSimulatedSensors();

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

    // 电池耗尽 → 触发休眠中断
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
        },
      };
      appendEvent(sleepInterruption);
      state = applyEvent(state, sleepInterruption);
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
