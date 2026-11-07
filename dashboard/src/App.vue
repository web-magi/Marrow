<script setup lang="ts">
/**
 * App.vue — Dashboard 最终观察布局
 *
 * 四个核心观察区域：
 *   - MEMORY CONSTELLATION：真实情景记忆星体 + 真实关联记忆（替代原 Life Activity Core）
 *   - PERSONALITY：四项真实人格特质
 *   - BODY STATE OBSERVATORY：八项身体状态 + 真实历史曲线
 *   - LIFE CHRONICLE：对话经历与 Runtime 事件合并的统一生命历程
 *
 * 生命周期映射只用于「最近交互」时间（数据仍来自 /api/dialogue 的真实对话记录），
 * 不再驱动任何独立的核心面板动画。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, type StateResponse, type RuntimeResponse } from './api/runtime';
import { LifecycleTracker } from './activity-lifecycle';
import TopStatusBar from './components/TopStatusBar.vue';
import TraitsPanel from './components/TraitsPanel.vue';
import BodyStateObservatory from './components/BodyStateObservatory.vue';
import MemoryConstellation from './components/MemoryConstellation.vue';
import LifeChronicle from './components/LifeChronicle.vue';

const stateData = ref<StateResponse | null>(null);
const runtimeData = ref<RuntimeResponse | null>(null);
const connected = ref(true);
const lastOkAt = ref<number | null>(null);
let pollTimer: number | undefined;
// 轮询互斥：上一轮请求未返回前不再发起新请求，避免慢响应时多个轮询叠加，
// 防止较旧的响应覆盖较新的状态快照。
let refreshing = false;
let observing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  let anyOk = false;
  try {
    try {
      const s = await api.state();
      if (s) { stateData.value = s; anyOk = true; }
    } catch { /* ignore */ }
    try {
      const r = await api.runtime();
      if (r) { runtimeData.value = r; anyOk = true; }
    } catch { /* ignore */ }
  } finally {
    refreshing = false;
  }

  if (anyOk) {
    connected.value = true;
    lastOkAt.value = Date.now();
  } else {
    // 请求失败时只切换连接状态，保留最后一次有效数据，绝不用空数据覆盖
    connected.value = false;
  }
}

// ---------------- 最近交互时间（真实对话记录驱动） ----------------
const lastInteractionAt = ref<string | null>(null);
const tracker = new LifecycleTracker();

async function pollLifecycle(): Promise<void> {
  if (observing) return;
  observing = true;
  try {
    const d = await api.dialogue();
    const obs = tracker.observe(Array.isArray(d) ? d : []);
    if (obs.at) lastInteractionAt.value = obs.at;
  } finally {
    observing = false;
  }
}

// ---------------- 记忆 → 生命历程 跨区域溯源 ----------------
interface ChronicleHandle {
  focusSourceEvent: (eventId: string, timestamp: string, kind?: string) => Promise<void>;
}
const chronicleRef = ref<ChronicleHandle | null>(null);
function onJumpSource(p: { eventId: string; timestamp: string; kind: 'episodic' | 'association' }): void {
  chronicleRef.value?.focusSourceEvent(p.eventId, p.timestamp, p.kind);
}

onMounted(() => {
  refresh();
  pollLifecycle();
  pollTimer = window.setInterval(() => {
    refresh();
    pollLifecycle();
  }, 3000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

const stale = computed(() => {
  if (!lastOkAt.value) return true;
  return Date.now() - lastOkAt.value > 12000;
});
</script>

<template>
  <TopStatusBar :runtime="runtimeData" :connected="connected" />

  <div v-if="!connected" class="stale-banner">
    <template v-if="stateData || runtimeData">
      连接中断 — 显示的是最后一次成功获取的数据
      <template v-if="lastOkAt">
        · 上次成功 {{ new Date(lastOkAt).toLocaleTimeString('zh-CN', { hour12: false }) }}
      </template>
    </template>
    <template v-else>等待运行时连接（localhost:8787）</template>
  </div>

  <div :class="['dash-layout', { stale }]">
    <!-- 第一行：记忆星图（主视觉，9 列） + 人格特征（3 列） -->
    <div class="col-memory">
      <MemoryConstellation
        :episodic="stateData?.current?.episodicBuffer ?? []"
        :associations="stateData?.current?.associations ?? []"
        @jump-source="onJumpSource"
      />
    </div>
    <div class="col-persona">
      <TraitsPanel :traits="stateData?.current?.traits ?? null" />
    </div>

    <!-- 第二行：身体状态观测中心（当前状态 + 趋势，全宽） -->
    <div class="col-obs">
      <BodyStateObservatory
        v-if="stateData?.current"
        :state="stateData.current"
        :history="stateData.history ?? []"
      />
      <div v-else class="panel empty-state">
        <div class="empty-orb"></div>
        <div class="empty-text">等待身体状态数据</div>
      </div>
    </div>

    <!-- 第三行：生命历程（对话 + 运行事件 + 原始审计） -->
    <div class="col-chronicle">
      <LifeChronicle ref="chronicleRef" :last-interaction-at="lastInteractionAt" />
    </div>
  </div>
</template>
