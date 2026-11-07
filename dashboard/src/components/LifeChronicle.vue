<script setup lang="ts">
/**
 * LifeChronicle.vue — 生命历程
 *
 * 合并原「经历记录（Dialogue History）」与「运行记录（Runtime Event Log）」为统一时间线：
 *   - 全部：对话条目 + Runtime 事件按真实时间倒序合并（对话事件不重复展示）；
 *   - 对话：GET /api/dialogue（Runtime 内存对话历史）；
 *   - 运行事件：GET /api/events（元数据 + 白名单摘要）；
 *   - 原始审计：GET /api/events 原始行（sequence / eventId / hash / 摘要），支持游标翻页。
 *
 * 只读：不写事件、不改顺序、不参与 Replay。
 * 溯源：focusSourceEvent(eventId, timestamp) 通过 since/until 查询真实来源时间窗，
 *       找到则高亮展示该事件，找不到则明确提示，不伪造来源。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, type EventsListResponse } from '../api/runtime';

interface DialogueMsg { direction: string; text: string; timestamp: string }
type EventRow = EventsListResponse['events'][number];

const props = defineProps<{ lastInteractionAt?: string | null }>();

const TYPE_LABEL: Record<string, string> = {
  genesis: '诞生',
  tick: '周期心跳',
  interruption: '中断',
  environment: '环境感知',
  dialogue: '对话',
  observation: '观测提取',
  appraisal: '评价',
  memory_formation: '记忆形成',
  memory_evocation: '记忆唤起',
  sleep: '睡眠',
  trait_shift: '特质偏移',
};

const tab = ref<'all' | 'dialogue' | 'events' | 'raw'>('all');
const dialogue = ref<DialogueMsg[]>([]);
const events = ref<EventRow[]>([]);
const failed = ref(false);
const loading = ref(true);
let timer: number | undefined;

async function load(): Promise<void> {
  const [d, e] = await Promise.all([api.dialogue(), api.events({ limit: 20 })]);
  const dOk = Array.isArray(d);
  if (dOk) dialogue.value = d as DialogueMsg[];
  if (e) events.value = e.events;
  failed.value = !dOk || !e;
  loading.value = false;
}

// ---------------- 统一时间线 ----------------
interface TimelineRow {
  key: string;
  t: number;
  kind: 'dialogue' | 'event';
  direction?: string;
  text?: string;
  eventType?: string;
  summary?: Record<string, unknown>;
}

const timeline = computed<TimelineRow[]>(() => {
  const rows: TimelineRow[] = [];
  for (const d of dialogue.value) {
    rows.push({
      key: `d-${d.direction}-${d.timestamp}`,
      t: Date.parse(d.timestamp),
      kind: 'dialogue',
      direction: d.direction,
      text: d.text,
    });
  }
  // 「对话」事件与 /api/dialogue 条目同源，全部视图中避免重复展示
  for (const e of events.value) {
    if (e.eventType === 'dialogue') continue;
    rows.push({
      key: `e-${e.sequence}`,
      t: Date.parse(e.timestamp),
      kind: 'event',
      eventType: e.eventType,
      summary: e.summary,
    });
  }
  return rows.filter((r) => Number.isFinite(r.t)).sort((a, b) => b.t - a.t).slice(0, 60);
});

const eventRows = computed<EventRow[]>(() =>
  [...events.value].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
);
const dialogueRows = computed<DialogueMsg[]>(() => [...dialogue.value].reverse());

// ---------------- 原始审计（游标翻页） ----------------
const rawRows = ref<EventRow[]>([]);
const rawCursor = ref<string | null>(null);
const rawLoading = ref(false);
const rawFailed = ref(false);

async function loadRaw(reset: boolean): Promise<void> {
  if (rawLoading.value) return;
  rawLoading.value = true;
  try {
    const r = reset
      ? await api.events({ limit: 50 })
      : await api.events({ limit: 50, beforeSequence: rawCursor.value ?? undefined });
    if (!r) { rawFailed.value = true; return; }
    rawRows.value = reset ? [...r.events] : [...rawRows.value, ...r.events];
    rawCursor.value = r.page.nextBeforeSequence;
    rawFailed.value = false;
  } finally {
    rawLoading.value = false;
  }
}

watch(tab, (v) => {
  if (v === 'raw' && rawRows.value.length === 0) void loadRaw(true);
});

// ---------------- 来源事件溯源 ----------------
const focusMeta = ref<{ eventId: string; timestamp: string; kind: string } | null>(null);
const focusRow = ref<EventRow | null>(null);
const focusMiss = ref(false);
const focusLoading = ref(false);

async function focusSourceEvent(eventId: string, timestamp: string, kind = 'episodic'): Promise<void> {
  focusMeta.value = { eventId, timestamp, kind };
  focusRow.value = null;
  focusMiss.value = false;
  const t = Date.parse(timestamp);
  const since = Number.isFinite(t) ? new Date(t - 120000).toISOString() : undefined;
  const until = Number.isFinite(t) ? new Date(t + 120000).toISOString() : undefined;
  focusLoading.value = true;
  try {
    const r = await api.events({ limit: 200, since, until });
    const found = r?.events.find((x) => x.eventId === eventId) ?? null;
    focusRow.value = found;
    focusMiss.value = !found;
  } finally {
    focusLoading.value = false;
  }
  tab.value = 'events';
  await nextTick();
  document.getElementById('lc-focus')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

defineExpose({ focusSourceEvent });

// ---------------- 格式化 ----------------
function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function summaryText(summary: Record<string, unknown> | undefined): string {
  const s = summary ?? {};
  const prefer = ['direction', 'action', 'reason', 'feature', 'source', 'deltaSeconds'];
  for (const k of prefer) {
    const v = s[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return `${k} ${v}`;
  }
  const keys = Object.keys(s);
  if (keys.length === 0) return '';
  return keys.slice(0, 2).join(' · ');
}
function typeLabel(type: string | undefined): string {
  if (!type) return '—';
  return TYPE_LABEL[type] ?? type;
}
function dirLabel(dir: string | undefined): string {
  return dir === 'user_input' ? '用户' : '同伴';
}
const lastInteraction = computed(() => {
  const iso = props.lastInteractionAt;
  if (!iso) return '暂无交互';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
});

onMounted(() => {
  load();
  timer = window.setInterval(load, 4000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="panel chronicle-panel">
    <div class="panel-header">
      <span class="zh">生命历程</span>
      <span class="en">LIFE CHRONICLE · DIALOGUE &amp; RUNTIME EVENTS</span>
      <span class="corner-id">012</span>
      <span class="corner-tr"></span>
      <span class="corner-bl"></span>
      <span class="corner-br"></span>
    </div>

    <div class="lc-meta">
      <span class="lc-stat">最近交互 <b>{{ lastInteraction }}</b></span>
      <span class="lc-stat">对话 <b>{{ dialogue.length }}</b></span>
      <span class="lc-stat">事件 <b>{{ events.length }}</b></span>
      <div class="lc-tabs">
        <button :class="['lc-tab', { active: tab === 'all' }]" @click="tab = 'all'">全部</button>
        <button :class="['lc-tab', { active: tab === 'dialogue' }]" @click="tab = 'dialogue'">对话</button>
        <button :class="['lc-tab', { active: tab === 'events' }]" @click="tab = 'events'">运行事件</button>
        <button :class="['lc-tab', { active: tab === 'raw' }]" @click="tab = 'raw'">原始审计</button>
      </div>
    </div>

    <div v-if="failed" class="lc-error">接口暂不可用 · 显示的不是实时数据</div>

    <div v-if="focusMeta" id="lc-focus" class="lc-focus">
      <div class="lc-focus-head">
        <span>来源事件溯源 · {{ focusMeta.kind === 'association' ? '关联记忆' : '情景记忆' }}</span>
        <button class="lc-focus-close" @click="focusMeta = null; focusRow = null; focusMiss = false">×</button>
      </div>
      <div class="lc-focus-body">
        <span class="lc-focus-id">{{ focusMeta.eventId }}</span>
        <template v-if="focusLoading">查询来源时间窗中…</template>
        <template v-else-if="focusRow">
          <span :class="['ev-type', 'ev-' + focusRow.eventType]">{{ typeLabel(focusRow.eventType) }}</span>
          <span class="lc-focus-summary">{{ summaryText(focusRow.summary) }}</span>
          <span class="lc-focus-time">{{ fmtTime(focusRow.timestamp) }}</span>
          <span class="lc-focus-seq">SEQ {{ focusRow.sequence }}</span>
        </template>
        <template v-else-if="focusMiss">来源时间窗（±2 分钟）内未找到该事件记录</template>
      </div>
    </div>

    <!-- 全部 -->
    <div v-if="tab === 'all'" class="lc-list">
      <div v-if="!loading && timeline.length === 0" class="empty-state">
        <div class="empty-text">暂无生命历程记录</div>
      </div>
      <div v-for="row in timeline" :key="row.key" class="lc-row">
        <span class="ev-time">{{ fmtTime(new Date(row.t).toISOString()) }}</span>
        <span v-if="row.kind === 'dialogue'" :class="['ev-type', row.direction === 'user_input' ? 'ev-user' : 'ev-companion']">
          {{ dirLabel(row.direction) }}
        </span>
        <span v-else :class="['ev-type', 'ev-' + row.eventType]">{{ typeLabel(row.eventType) }}</span>
        <span class="lc-text">{{ row.kind === 'dialogue' ? row.text : summaryText(row.summary) }}</span>
      </div>
    </div>

    <!-- 对话 -->
    <div v-else-if="tab === 'dialogue'" class="lc-list">
      <div v-if="!loading && dialogueRows.length === 0" class="empty-state">
        <div class="empty-text">暂无对话经历</div>
      </div>
      <div v-for="(d, i) in dialogueRows" :key="'d-' + i" class="lc-row">
        <span class="ev-time">{{ fmtTime(d.timestamp) }}</span>
        <span :class="['ev-type', d.direction === 'user_input' ? 'ev-user' : 'ev-companion']">
          {{ dirLabel(d.direction) }}
        </span>
        <span class="lc-text">{{ d.text }}</span>
      </div>
    </div>

    <!-- 运行事件 -->
    <div v-else-if="tab === 'events'" class="lc-list">
      <div v-if="!loading && eventRows.length === 0" class="empty-state">
        <div class="empty-text">暂无运行事件</div>
      </div>
      <div v-for="row in eventRows" :key="row.sequence" class="lc-row">
        <span class="ev-time">{{ fmtTime(row.timestamp) }}</span>
        <span :class="['ev-type', 'ev-' + row.eventType]">{{ typeLabel(row.eventType) }}</span>
        <span class="lc-text">{{ summaryText(row.summary) }}</span>
      </div>
    </div>

    <!-- 原始审计 -->
    <div v-else class="lc-list">
      <div v-if="rawFailed" class="lc-error">事件查询失败 · 显示的不是实时数据</div>
      <div v-for="row in rawRows" :key="'raw-' + row.sequence" class="lc-row lc-raw-row">
        <span class="ev-time">{{ fmtTime(row.timestamp) }}</span>
        <span class="lc-raw-seq">SEQ {{ row.sequence }}</span>
        <span :class="['ev-type', 'ev-' + row.eventType]">{{ typeLabel(row.eventType) }}</span>
        <span class="lc-raw-id" :title="row.eventId">{{ row.eventId.slice(0, 12) }}</span>
        <span class="lc-text">{{ summaryText(row.summary) || '—' }}</span>
        <span class="lc-raw-hash" :title="row.eventHash">{{ row.eventHash.slice(0, 10) }}</span>
      </div>
      <div class="lc-raw-foot">
        <button class="lc-more" :disabled="rawLoading || !rawCursor" @click="loadRaw(false)">
          {{ rawLoading ? '加载中…' : rawCursor ? '加载更早 50 条' : '已到最早' }}
        </button>
      </div>
    </div>

    <div class="lc-foot">
      仅只读展示 · 原始审计含 sequence / eventId / eventHash，不含原始对话文本之外的隐私字段
    </div>
  </div>
</template>

<style scoped>
.chronicle-panel { min-height: 360px; }

.lc-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 14px;
  padding: 6px 2px 8px;
  border-bottom: 1px solid var(--border-dim);
  font-size: 11px; color: var(--text-secondary);
}
.lc-stat b { color: var(--text-primary); font-family: "JetBrains Mono", monospace; font-weight: 600; }
.lc-tabs { margin-left: auto; display: flex; gap: 6px; }
.lc-tab {
  background: transparent; border: 1px solid var(--border-dim);
  color: var(--text-secondary); font-size: 11px; padding: 2px 10px;
  cursor: pointer; font-family: inherit;
}
.lc-tab.active { border-color: rgba(0, 229, 255, 0.5); color: var(--text-primary); }

.lc-list {
  flex: 1 1 auto; min-height: 0;
  max-height: 360px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px;
}
.lc-row {
  display: flex; align-items: center; gap: 8px;
  padding: 3px 2px;
  border-bottom: 1px dashed rgba(0, 229, 255, 0.07);
  font-size: 12px;
}
.ev-time { color: var(--text-label); font-family: "JetBrains Mono", monospace; font-size: 11px; flex: 0 0 auto; }
.ev-type {
  flex: 0 0 auto;
  color: var(--text-glow);
  border: 1px solid rgba(0, 229, 255, 0.22);
  padding: 0 5px; font-size: 11px;
  font-family: "PingFang SC", "Microsoft YaHei", monospace;
}
.ev-user { border-color: rgba(0, 229, 255, 0.45); color: #9FE9FF; }
.ev-companion { border-color: rgba(139, 92, 255, 0.4); color: #C7B4FF; }
.ev-dialogue { border-color: rgba(139, 92, 255, 0.4); color: #C7B4FF; }
.ev-interruption { border-color: rgba(255, 69, 101, 0.45); color: #FF8FA3; }
.ev-sleep { border-color: rgba(77, 159, 255, 0.4); color: #9CC7FF; }
.ev-tick { border-color: rgba(0, 229, 255, 0.16); color: var(--text-secondary); }
.lc-text { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-raw-row { font-size: 11px; }
.lc-raw-seq { color: var(--text-label); font-family: "JetBrains Mono", monospace; flex: 0 0 auto; }
.lc-raw-id { color: var(--text-label); font-family: "JetBrains Mono", monospace; flex: 0 0 auto; }
.lc-raw-hash { margin-left: auto; color: rgba(74, 96, 120, 0.8); font-family: "JetBrains Mono", monospace; flex: 0 0 auto; }
.lc-raw-foot { display: flex; justify-content: center; padding: 8px 0; }
.lc-more {
  background: transparent; border: 1px dashed rgba(0, 229, 255, 0.35);
  color: var(--text-secondary); font-size: 11px; padding: 3px 10px;
  cursor: pointer; font-family: inherit;
}
.lc-more:disabled { opacity: 0.45; cursor: not-allowed; }
.lc-error {
  margin: 6px 0; padding: 4px 8px; font-size: 12px;
  color: var(--status-danger);
  border: 1px solid rgba(255, 69, 101, 0.35);
  background: rgba(255, 69, 101, 0.06);
}
.lc-focus {
  margin: 8px 0; padding: 6px 10px;
  border: 1px solid rgba(139, 92, 255, 0.45);
  background: rgba(139, 92, 255, 0.08);
}
.lc-focus-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: #C7B4FF; letter-spacing: 0.08em;
}
.lc-focus-close { background: transparent; border: none; color: var(--text-label); font-size: 15px; cursor: pointer; }
.lc-focus-body { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--text-secondary); }
.lc-focus-id { font-family: "JetBrains Mono", monospace; color: var(--text-label); }
.lc-focus-summary { color: var(--text-primary); }
.lc-focus-time, .lc-focus-seq { font-family: "JetBrains Mono", monospace; color: var(--text-label); }
.lc-foot { flex: 0 0 auto; margin-top: 8px; font-size: 11px; color: var(--text-label); }

@media (max-width: 1023px) {
  .lc-tabs { margin-left: 0; }
}
</style>
