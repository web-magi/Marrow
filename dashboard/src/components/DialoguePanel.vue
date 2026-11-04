<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api/runtime';

const dialogue = ref<any[]>([]);
let timer: number | null = null;

async function refresh() {
  const d = await api.dialogue();
  if (d) dialogue.value = d;
}
onMounted(() => { refresh(); timer = window.setInterval(refresh, 5000); });
onUnmounted(() => { if (timer) window.clearInterval(timer); });
</script>

<template>
  <div class="card four-col">
    <h3>Dialogue History ({{ dialogue.length }})</h3>
    <div v-if="dialogue.length === 0" class="empty">No dialogue yet</div>
    <div v-else class="dialogue-list">
      <div v-for="(d, i) in dialogue" :key="i" class="dialogue-item">
        <span class="dir" :class="d.direction === 'user_input' ? 'dir-user' : 'dir-companion'">
          {{ d.direction === 'user_input' ? 'USER' : 'COMPANION' }}
        </span>
        {{ d.text }}
      </div>
    </div>
  </div>
</template>
