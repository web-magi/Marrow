<script setup lang="ts">
/**
 * BodyStateObservatory.vue — 身体状态观测中心
 *
 * 合并原「身体状态」面板与「状态变化趋势」面板，避免同一数值在两处重复出现：
 *   - 左侧：8 项当前状态卡片（2 列 × 4 行），点击卡片切换趋势观察指标；
 *   - 右侧：真实历史趋势图，支持多指标叠加与真实时间范围筛选。
 *
 * 数据真实性：
 *   - 趋势数据只来自 /api/state 返回的真实 history 快照；
 *   - 时间范围按每条快照的 lastUpdated 真实时间戳过滤；
 *   - 数据不足时显示真实可用范围，绝不插值或生成虚构采样点。
 *   - Battery 归为设备资源：默认不进入生命状态趋势，单独作为独立曲线入口。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend);

const props = defineProps<{ state: any; history: any[] }>();

interface MetricDef {
  key: string;
  zh: string;
  en: string;
  color: string;
  unit: string;
  /** 图表缩放：1 = 原值，100 = 0-1 转百分比显示 */
  scale: number;
  advanced?: boolean;
  device?: boolean;
}

const METRICS: MetricDef[] = [
  { key: 'energy', zh: '能量', en: 'ENERGY', color: '#00F5A0', unit: '', scale: 1 },
  { key: 'moodBaseline', zh: '心境', en: 'MOOD', color: '#8B5CFF', unit: '', scale: 1 },
  { key: 'arousal', zh: '唤醒度', en: 'AROUSAL', color: '#00E5FF', unit: '', scale: 1 },
  { key: 'trust', zh: '信任度', en: 'TRUST', color: '#168BFF', unit: '', scale: 1 },
  { key: 'defensiveness', zh: '防御性', en: 'DEFENSIVE', color: '#FF7A45', unit: '', scale: 1, advanced: true },
  { key: 'cognitiveLoad', zh: '认知负荷', en: 'COGNITIVE', color: '#FFB547', unit: '', scale: 1, advanced: true },
  { key: 'batteryLevel', zh: '电量', en: 'BATTERY', color: '#9AE66E', unit: '%', scale: 1, device: true },
  { key: 'attentionFocus', zh: '注意力', en: 'ATTENTION', color: '#4D9FFF', unit: '%', scale: 100, advanced: true },
];

const DEFAULT_MULTI = ['energy', 'moodBaseline', 'arousal', 'trust'];

const mode = ref<'multi' | 'single'>('multi');
const selected = ref<string[]>([...DEFAULT_MULTI]);
const multiSelected = ref<string[]>([...DEFAULT_MULTI]);
const activeCard = ref<string | null>(null);

const RANGES = [
  { key: '15m', label: '最近 15 分钟', ms: 15 * 60 * 1000 },
  { key: '60m', label: '最近 60 分钟', ms: 60 * 60 * 1000 },
  { key: '6h', label: '最近 6 小时', ms: 6 * 60 * 60 * 1000 },
  { key: '24h', label: '最近 24 小时', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '最近 7 天', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: '全部可用历史', ms: 0 },
] as const;
const rangeKey = ref<string>('60m');
const rangeMs = computed(() => RANGES.find((r) => r.key === rangeKey.value)?.ms ?? 60 * 60 * 1000);

// ---------------- 数值格式化 ----------------
function rawValue(key: string): number | null {
  const m = METRICS.find((x) => x.key === key);
  const v = props.state?.[key];
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return v * (m?.scale ?? 1);
}
function fmtCard(key: string): string {
  const v = rawValue(key);
  if (v === null) return '—';
  const m = METRICS.find((x) => x.key === key)!;
  // 单位统一由模板中的 .sc-unit 渲染，避免出现 "93%%" 这类重复
  return m.unit === '%' ? v.toFixed(0) : v.toFixed(1);
}
function barPct(key: string): number {
  const v = rawValue(key);
  if (v === null) return 0;
  const m = METRICS.find((x) => x.key === key)!;
  const max = m.unit === '%' ? 100 : 100;
  return Math.max(0, Math.min(100, (v / max) * 100));
}
function valueColor(key: string): string {
  const v = rawValue(key);
  if (v === null) return 'var(--text-secondary)';
  switch (key) {
    case 'energy': return v > 70 ? '#00F5A0' : v < 30 ? '#FFB547' : '#00E5FF';
    case 'defensiveness': return v > 60 ? '#FF4565' : '#FFB547';
    case 'cognitiveLoad': return v > 60 ? '#FFB547' : '#00E5FF';
    case 'batteryLevel': return v < 20 ? '#FF4565' : v < 50 ? '#FFB547' : '#9AE66E';
    case 'moodBaseline': return '#8B5CFF';
    default: return '#00E5FF';
  }
}

// ---------------- 卡片交互 ----------------
function onCard(key: string): void {
  const m = METRICS.find((x) => x.key === key)!;
  mode.value = 'single';
  selected.value = [key];
  activeCard.value = key;
  void m;
}
function backToMulti(): void {
  mode.value = 'multi';
  selected.value = [...multiSelected.value];
  activeCard.value = null;
}
function toggleAdvanced(key: string): void {
  const m = METRICS.find((x) => x.key === key)!;
  if (m.device) return;
  if (selected.value.includes(key)) {
    if (selected.value.length <= 1) return;
    selected.value = selected.value.filter((k) => k !== key);
  } else {
    selected.value = [...selected.value, key];
  }
  multiSelected.value = [...selected.value];
}
function isSelected(key: string): boolean {
  return selected.value.includes(key);
}

/**
 * Tick 批次会把同一时间戳下的多个子步快照写入 history（4 条/轮，lastUpdated 相同）。
 * 它们都是真实状态，但在按时间轴作图时会产生同一秒内的重复点与垂直跳变。
 * 展示前按时间戳去重，保留该时间戳的最后一条（即该轮次最终状态），
 * 不插值、不丢弃整轮数据、不改变任何字段值。
 */
function dedupeByTimestamp(rows: readonly any[]): any[] {
  const out: any[] = [];
  for (const row of rows) {
    const key = `${row?.lastUpdated ?? ''}`;
    if (out.length > 0 && `${out[out.length - 1]!.lastUpdated ?? ''}` === key) out[out.length - 1] = row;
    else out.push(row);
  }
  return out;
}

const historyRows = computed(() => dedupeByTimestamp(props.history ?? []));

// ---------------- 真实历史过滤 ----------------
function tsOf(item: any): number {
  const t = Date.parse(item?.lastUpdated);
  return Number.isFinite(t) ? t : NaN;
}
const filtered = computed(() => {
  const all = historyRows.value;
  const now = Date.now();
  const cutoff = rangeMs.value === 0 ? null : now - rangeMs.value;
  return all.filter((item) => {
    const t = tsOf(item);
    return Number.isFinite(t) && (cutoff === null || t >= cutoff);
  });
});
const hasData = computed(() => filtered.value.length >= 2);
const availableRange = computed(() => {
  const all = historyRows.value;
  if (all.length === 0) return null;
  const first = tsOf(all[0]!);
  const last = tsOf(all[all.length - 1]!);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const mins = Math.round((last - first) / 60000);
  if (mins < 1) return `${Math.max(1, Math.round((last - first) / 1000))} 秒`;
  if (mins < 90) return `${mins} 分钟`;
  return `${(mins / 60).toFixed(1)} 小时`;
});
const emptyHint = computed(() => {
  if (filtered.value.length === 0) {
    return availableRange.value
      ? `该时间范围内没有真实快照 · 当前可用历史约 ${availableRange.value}`
      : '暂无状态历史';
  }
  return '真实快照不足 2 个点，无法绘制趋势';
});

// ---------------- Chart ----------------
const canvasRef = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;
let lastSig = '';

function labels(rows: any[]): string[] {
  return rows.map((r) => {
    const t = tsOf(r);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  });
}
function datasetsFor(rows: any[]) {
  return selected.value.map((key) => {
    const m = METRICS.find((x) => x.key === key)!;
    return {
      label: `${m.zh} ${m.en}`,
      data: rows.map((r) => {
        const v = r?.[key];
        return typeof v === 'number' && !Number.isNaN(v) ? v * m.scale : null;
      }),
      borderColor: m.color,
      backgroundColor: m.color + '18',
      borderWidth: mode.value === 'single' ? 2.4 : 1.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: mode.value === 'single',
      spanGaps: true,
    };
  });
}

function drawChart(): void {
  if (!canvasRef.value || !hasData.value) return;
  const rows = filtered.value;
  const sig = `${rows.length}:${tsOf(rows[0]!)}:${tsOf(rows[rows.length - 1]!)}:${selected.value.join(',')}:${mode.value}`;
  if (chart && sig === lastSig) return;
  lastSig = sig;

  if (chart) {
    chart.data.labels = labels(rows);
    chart.data.datasets = datasetsFor(rows) as any;
    chart.update('none');
    return;
  }

  chart = new Chart(canvasRef.value, {
    type: 'line',
    data: { labels: labels(rows), datasets: datasetsFor(rows) as any },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          align: 'end',
          labels: {
            color: '#E2F2FF',
            font: { family: 'PingFang SC, Microsoft YaHei, JetBrains Mono, monospace', size: 12 },
            boxWidth: 10,
            usePointStyle: true,
            padding: 12,
          },
        },
        tooltip: {
          backgroundColor: '#040818',
          borderColor: 'rgba(0,229,255,0.4)',
          borderWidth: 1,
          titleColor: '#E2F2FF',
          bodyColor: '#E2F2FF',
          titleFont: { family: 'JetBrains Mono, monospace', size: 11 },
          bodyFont: { family: 'PingFang SC, Microsoft YaHei, JetBrains Mono, monospace', size: 12 },
          padding: 10,
        },
      },
      scales: {
        x: {
          ticks: { color: '#4A6078', maxTicksLimit: 10, font: { family: 'JetBrains Mono, monospace', size: 10 } },
          grid: { color: 'rgba(0,229,255,0.06)', lineWidth: 0.5 },
        },
        y: {
          min: 0,
          max: 100,
          ticks: { color: '#7895B5', font: { family: 'JetBrains Mono, monospace', size: 10 } },
          grid: { color: 'rgba(0,229,255,0.07)', lineWidth: 0.5 },
        },
      },
    },
  });
}

watch([filtered, selected, mode, hasData], () => {
  if (!hasData.value) {
    if (chart) { chart.destroy(); chart = null; lastSig = ''; }
    return;
  }
  drawChart();
});

onMounted(() => { drawChart(); });
onUnmounted(() => { if (chart) chart.destroy(); });
</script>

<template>
  <div class="panel observatory">
    <div class="panel-header">
      <span class="zh">身体状态观测中心</span>
      <span class="en">BODY STATE OBSERVATORY · CURRENT + HISTORY</span>
      <span class="corner-id">008</span>
      <span class="corner-tr"></span>
      <span class="corner-bl"></span>
      <span class="corner-br"></span>
    </div>

    <div class="obs-body">
      <!-- 左侧：8 项当前状态 -->
      <div class="obs-cards">
        <button
          v-for="m in METRICS"
          :key="m.key"
          type="button"
          :class="['state-card', { active: isSelected(m.key), single: mode === 'single' && activeCard === m.key, device: m.device }]"
          :title="m.device ? '设备资源指标：' + m.zh : '点击切换为单指标趋势观察'"
          @click="onCard(m.key)"
        >
          <div class="sc-top">
            <span class="sc-zh">{{ m.zh }}</span>
            <span class="sc-en">{{ m.en }}</span>
            <span v-if="m.device" class="sc-tag">设备资源</span>
          </div>
          <div class="sc-val" :style="{ color: valueColor(m.key) }">{{ fmtCard(m.key) }}<span v-if="m.unit" class="sc-unit">{{ m.unit }}</span></div>
          <div class="sc-bar">
            <div class="sc-bar-fill" :style="{ width: barPct(m.key) + '%', background: valueColor(m.key) }"></div>
          </div>
        </button>
      </div>

      <!-- 右侧：趋势 -->
      <div class="obs-chart">
        <div class="chart-toolbar">
          <div class="mode-switch">
            <button type="button" :class="['tb-btn', { on: mode === 'single' }]" @click="mode === 'single' ? backToMulti() : onCard('energy')">
              {{ mode === 'single' ? '返回对比模式' : '单指标模式' }}
            </button>
          </div>
          <div class="range-group">
            <button
              v-for="r in RANGES"
              :key="r.key"
              type="button"
              :class="['tb-btn', { on: rangeKey === r.key }]"
              @click="rangeKey = r.key"
            >{{ r.label }}</button>
          </div>
        </div>

        <div v-if="mode === 'multi'" class="metric-chips">
          <button
            v-for="m in METRICS.filter((x) => !x.device)"
            :key="m.key"
            type="button"
            :class="['chip', { on: isSelected(m.key), advanced: m.advanced }]"
            @click="toggleAdvanced(m.key)"
          >
            <span class="chip-dot" :style="{ background: m.color }"></span>{{ m.zh }}
            <span v-if="m.advanced" class="chip-tag">高级</span>
          </button>
        </div>

        <div class="chart-area">
          <canvas v-if="hasData" ref="canvasRef"></canvas>
          <div v-else class="chart-empty">
            <div class="empty-orb"></div>
            <div class="empty-text">暂无趋势数据</div>
            <div class="empty-hint">{{ emptyHint }}</div>
          </div>
        </div>

        <div class="chart-foot">
          <span>指标：{{ selected.map((k) => METRICS.find((m) => m.key === k)?.zh).join(' · ') }}</span>
          <span>真实快照 {{ filtered.length }} 点<template v-if="availableRange"> · 可用历史约 {{ availableRange }}</template></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.obs-body { display: flex; gap: 16px; flex: 1 1 auto; min-height: 0; }
.obs-cards {
  flex: 0 0 35%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(74px, 1fr);
  gap: 10px;
}
.state-card {
  position: relative;
  display: flex; flex-direction: column; gap: 3px;
  padding: 9px 11px;
  text-align: left;
  background: linear-gradient(160deg, rgba(0, 229, 255, 0.05), rgba(4, 12, 24, 0.72));
  border: 1px solid var(--border-dim);
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
.state-card:hover { border-color: rgba(0, 229, 255, 0.45); }
.state-card.active { border-color: rgba(0, 229, 255, 0.6); box-shadow: inset 0 0 18px rgba(0, 229, 255, 0.08); }
.state-card.single { border-color: rgba(0, 245, 160, 0.7); box-shadow: 0 0 14px rgba(0, 245, 160, 0.16); }
.state-card.device { border-style: dashed; }
.sc-top { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.sc-zh { font-size: 13px; font-weight: 600; color: var(--text-primary); letter-spacing: 0.06em; }
.sc-en { font-size: 10px; color: var(--text-label); font-family: "JetBrains Mono", monospace; letter-spacing: 0.1em; }
.sc-val { font-size: 22px; font-weight: 700; line-height: 1.15; font-family: "JetBrains Mono", monospace; }
.sc-unit { font-size: 12px; margin-left: 2px; opacity: 0.8; }
.sc-bar { height: 3px; background: rgba(0, 229, 255, 0.14); margin-top: auto; }
.sc-bar-fill { height: 100%; transition: width 0.4s ease; box-shadow: 0 0 8px currentColor; }
.sc-tag {
  font-size: 9px; color: var(--text-label);
  border: 1px dashed rgba(0, 229, 255, 0.2); padding: 0 3px;
  line-height: 1.4;
}

.obs-chart { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.chart-toolbar { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.mode-switch, .range-group { display: flex; gap: 6px; flex-wrap: wrap; }
.tb-btn {
  background: rgba(0, 229, 255, 0.04);
  border: 1px solid var(--border-dim);
  color: var(--text-secondary);
  font-size: 11px; padding: 3px 8px;
  font-family: "PingFang SC", "Microsoft YaHei", monospace;
  cursor: pointer; transition: all 0.15s ease;
}
.tb-btn:hover { border-color: rgba(0, 229, 255, 0.4); color: var(--text-primary); }
.tb-btn.on { border-color: rgba(0, 229, 255, 0.65); color: var(--text-glow); background: rgba(0, 229, 255, 0.1); }

.metric-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: rgba(4, 14, 28, 0.6);
  border: 1px solid var(--border-dim);
  color: var(--text-secondary);
  font-size: 11px; padding: 2px 8px; cursor: pointer;
  font-family: "PingFang SC", "Microsoft YaHei", monospace;
}
.chip.on { border-color: rgba(0, 229, 255, 0.55); color: var(--text-primary); }
.chip-dot { width: 6px; height: 6px; border-radius: 50%; }
.chip-tag { font-size: 9px; color: var(--text-label); border: 1px solid rgba(139, 92, 255, 0.3); padding: 0 3px; }

.chart-area { position: relative; flex: 1 1 auto; min-height: 240px; }
.chart-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  color: var(--text-label);
}
.empty-hint { font-size: 12px; color: var(--text-secondary); text-align: center; padding: 0 12px; }
.chart-foot {
  display: flex; justify-content: space-between; gap: 10px;
  margin-top: 8px; font-size: 11px; color: var(--text-label);
  font-family: "PingFang SC", "Microsoft YaHei", monospace;
}

@media (max-width: 1100px) {
  .obs-body { flex-direction: column; }
  .obs-cards { flex: 0 0 auto; grid-auto-rows: minmax(70px, auto); }
  .chart-area { min-height: 220px; }
}
</style>
