<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api, type StateResponse, type RuntimeResponse } from './api/runtime';
import StateCards from './components/StateCards.vue';
import TraitsPanel from './components/TraitsPanel.vue';
import EpisodicBuffer from './components/EpisodicBuffer.vue';
import Associations from './components/Associations.vue';
import DialoguePanel from './components/DialoguePanel.vue';
import RuntimeBar from './components/RuntimeBar.vue';
import TrendChart from './components/TrendChart.vue';

const stateData = ref<StateResponse | null>(null);
const runtimeData = ref<RuntimeResponse | null>(null);
const connected = ref(false);
let timer: number | null = null;

async function refresh() {
  const [s, r] = await Promise.all([api.state(), api.runtime()]);
  stateData.value = s;
  runtimeData.value = r;
  connected.value = !!s && !!r;
}

onMounted(() => {
  refresh();
  timer = window.setInterval(refresh, 3000);
});
onUnmounted(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <div>
    <header class="dash-header">
      <h1>Marrow V2 — Dashboard</h1>
      <div class="sub">
        <span :class="connected ? 'dot dot-green' : 'dot dot-red'"></span>
        {{ connected ? 'Runtime online' : 'Waiting for Runtime at :8787...' }}
        <span v-if="runtimeData">| identity: {{ runtimeData.identityId }}</span>
      </div>
    </header>

    <!-- Observation Layer -->
    <div v-if="stateData?.current" class="dash-grid">
      <StateCards :state="stateData.current" />
      <TraitsPanel :traits="stateData.current.traits" />
      <RuntimeBar v-if="runtimeData" :runtime="runtimeData" />
      <EpisodicBuffer :buffer="stateData.current.episodicBuffer" />
      <Associations :assoc="stateData.current.associations" />
      <DialoguePanel v-if="stateData" />
      <TrendChart v-if="stateData" :history="stateData.history" />
    </div>
    <div v-else class="empty">
      {{ connected ? 'Loading state...' : '请先启动 Marrow Runtime (npm run start)' }}
    </div>
  </div>
</template>
