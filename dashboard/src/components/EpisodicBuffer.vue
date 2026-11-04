<script setup lang="ts">
defineProps<{ buffer: any[] }>();
</script>

<template>
  <div class="card two-col">
    <h3>Episodic Buffer ({{ buffer.length }}/50)</h3>
    <div v-if="buffer.length === 0" class="empty">No memories formed yet</div>
    <div v-else class="mem-list">
      <div v-for="(mem, i) in buffer" :key="mem.id" class="mem-item">
        <div class="mem-summary">{{ mem.summary }}</div>
        <div class="mem-meta">
          <span>salience: {{ mem.salience.toFixed(3) }}</span>
          <span>valence: {{ mem.valence?.toFixed(2) }}</span>
          <span>keywords: [{{ (mem.keywords ?? []).join(', ') }}]</span>
          <span :class="['tag', mem.isTrauma ? 'tag-trauma' : '']">{{ mem.isTrauma ? 'TRAUMA' : 'norm' }}</span>
        </div>
        <div class="bar"><div class="bar-fill" :style="{ width: (mem.salience * 100) + '%', background: mem.isTrauma ? 'var(--trauma)' : 'var(--accent)' }"></div></div>
      </div>
    </div>
  </div>
</template>
