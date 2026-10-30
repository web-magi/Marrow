/**
 * visualize.ts — 阶段二：生成 HTML 可视化页面
 *
 * 加载事件日志，重放得到状态快照序列，生成一个自包含的 HTML 文件：
 * - energy / mood_baseline / arousal 时间序列曲线图
 * - 行为输出时间轴标注（不同颜色区分行为类型）
 * - 支持人工判断"合理与否"
 *
 * 用法：
 *   node dist/visualize.js              # 生成 data/visualization.html
 *   node dist/visualize.js --output <path>  # 指定输出路径
 */

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEvents } from './storage.js';
import { replayWithSnapshots } from './replay.js';
import type { BehaviorOutput } from './state.js';

/** 行为类型对应的颜色 */
const BEHAVIOR_COLORS: Record<string, string> = {
  idle: '#94a3b8',
  active: '#22c55e',
  rest: '#3b82f6',
  quiet: '#a855f7',
  interrupted: '#ef4444',
};

/** 行为类型对应的中文标签 */
const BEHAVIOR_LABELS: Record<string, string> = {
  idle: '待机',
  active: '活跃',
  rest: '休息',
  quiet: '沉静',
  interrupted: '中断',
};

/**
 * 生成 HTML 页面
 */
function generateHtml(
  labels: string[],
  energyData: number[],
  moodData: number[],
  arousalData: number[],
  behaviors: BehaviorOutput[],
  timestamps: string[],
): string {
  // 行为变化点（用于在时间轴上标注）
  const behaviorChanges: Array<{
    index: number;
    time: string;
    kind: string;
    reason: string;
  }> = [];
  let prevKind = '';
  behaviors.forEach((b, i) => {
    if (b.kind !== prevKind) {
      behaviorChanges.push({
        index: i,
        time: timestamps[i]!,
        kind: b.kind,
        reason: b.reason,
      });
      prevKind = b.kind;
    }
  });

  // behaviorChanges 在下方 HTML 模板中用于显示行为变化次数

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Marrow — State Visualization</title>
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
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 14px; }
    .chart-container {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .chart-container h2 {
      font-size: 16px;
      margin-bottom: 12px;
      color: #cbd5e1;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .summary-card {
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
    }
    .summary-card .label { font-size: 12px; color: #94a3b8; }
    .summary-card .value { font-size: 24px; font-weight: bold; margin-top: 4px; }
    .timeline {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .timeline h2 { font-size: 16px; margin-bottom: 12px; color: #cbd5e1; }
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
      font-size: 11px;
      color: white;
      transition: flex 0.3s;
    }
    .legend { display: flex; gap: 16px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
  </style>
</head>
<body>
  <h1>Marrow — 状态可视化</h1>
  <p class="subtitle">阶段二：事件流重放与状态曲线时间序列可视化</p>

  <div class="summary">
    <div class="summary-card">
      <div class="label">事件总数</div>
      <div class="value">${labels.length}</div>
    </div>
    <div class="summary-card">
      <div class="label">行为变化次数</div>
      <div class="value">${behaviorChanges.length}</div>
    </div>
    <div class="summary-card">
      <div class="label">起始 energy</div>
      <div class="value">${energyData[0]?.toFixed(1) ?? 'N/A'}</div>
    </div>
    <div class="summary-card">
      <div class="label">结束 energy</div>
      <div class="value">${energyData[energyData.length - 1]?.toFixed(1) ?? 'N/A'}</div>
    </div>
  </div>

  <div class="chart-container">
    <h2>状态曲线（Energy / Mood / Arousal）</h2>
    <canvas id="stateChart" height="120"></canvas>
  </div>

  <div class="timeline">
    <h2>行为时间轴</h2>
    <div class="timeline-bar" id="timelineBar"></div>
    <div class="legend" id="legend"></div>
  </div>

  <script>
    const labels = ${JSON.stringify(labels)};
    const energyData = ${JSON.stringify(energyData)};
    const moodData = ${JSON.stringify(moodData)};
    const arousalData = ${JSON.stringify(arousalData)};
    const behaviors = ${JSON.stringify(behaviors)};
    const behaviorColors = ${JSON.stringify(BEHAVIOR_COLORS)};
    const behaviorLabels = ${JSON.stringify(BEHAVIOR_LABELS)};

    // 状态曲线图
    new Chart(document.getElementById('stateChart'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Energy',
            data: energyData,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: 'Mood Baseline',
            data: moodData,
            borderColor: '#a855f7',
            backgroundColor: 'rgba(168, 85, 247, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: 'Arousal',
            data: arousalData,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#cbd5e1' } },
          tooltip: {
            callbacks: {
              afterBody: function(items) {
                const idx = items[0].dataIndex;
                const b = behaviors[idx];
                return '\\n行为: ' + (behaviorLabels[b.kind] || b.kind) + ' (' + b.reason + ')';
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#94a3b8', maxTicksLimit: 12 }, grid: { color: '#334155' } },
          y: { min: 0, max: 100, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        },
      },
    });

    // 行为时间轴
    const timelineBar = document.getElementById('timelineBar');
    const legend = document.getElementById('legend');
    const seenBehaviors = new Set();
    behaviors.forEach((b) => {
      const seg = document.createElement('div');
      seg.className = 'timeline-segment';
      seg.style.backgroundColor = behaviorColors[b.kind] || '#666';
      seg.title = behaviorLabels[b.kind] + ' (' + b.reason + ')';
      timelineBar.appendChild(seg);
      if (!seenBehaviors.has(b.kind)) {
        seenBehaviors.add(b.kind);
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = '<span class="legend-dot" style="background:' + (behaviorColors[b.kind] || '#666') + '"></span>' + (behaviorLabels[b.kind] || b.kind);
        legend.appendChild(item);
      }
    });
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      output: { type: 'string', default: 'data/visualization.html' },
    },
  });

  const outputPath = args.values.output!;
  console.log('Loading events from PostgreSQL...');
  const events = await loadEvents();
  console.log(`Loaded ${events.length} events.`);

  if (events.length === 0) {
    console.log('No events to visualize. Run the state machine first.');
    process.exit(0);
  }

  console.log('Replaying events...');
  const snapshots = replayWithSnapshots(events);

  // 抽样：如果事件太多，每 N 个取一个，避免 HTML 过大
  const sampleRate = Math.max(1, Math.floor(snapshots.length / 500));
  const sampled = snapshots.filter((_, i) => i % sampleRate === 0);

  console.log(`Sampled to ${sampled.length} data points (rate: ${sampleRate}).`);

  const labels = sampled.map((s) => {
    const d = new Date(s.state.lastUpdated);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  });
  const energyData = sampled.map((s) => s.state.energy);
  const moodData = sampled.map((s) => s.state.moodBaseline);
  const arousalData = sampled.map((s) => s.state.arousal);
  const behaviors = sampled.map((s) => s.state.lastBehavior);
  const timestamps = sampled.map((s) => s.state.lastUpdated);

  console.log('Generating HTML...');
  const html = generateHtml(
    labels,
    energyData,
    moodData,
    arousalData,
    behaviors,
    timestamps,
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf-8');
  console.log(`Visualization saved to: ${outputPath}`);
  console.log('Open it in a browser to view state curves and behavior timeline.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
