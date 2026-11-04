<script setup lang="ts">
defineProps<{ assoc: any[] }>();
</script>

<template>
  <div class="card two-col">
    <h3>Associations ({{ assoc.length }})</h3>
    <div v-if="assoc.length === 0" class="empty">No associations yet</div>
    <div v-else class="mem-list">
      <div v-for="(a, i) in assoc" :key="a.id" class="mem-item">
        <div class="mem-summary">{{ a.cue }}</div>
        <div class="mem-meta">
          <span>salience: {{ a.salience?.toFixed(3) ?? '—' }}</span>
          <span>valence: {{ a.valence?.toFixed(2) ?? '—' }}</span>
          <span>: {{ a.source }}</span>
          <span v-if="a.isScar" class="tag tag-trauma">SCAR</span>
        </div>
        <div class="bar"><div class="bar-fill" :style="{ width: (a.salience * 100) + '%', background: a.isScar ? 'var(--trauma)' : 'var(--warn)' }"></div></div>
      </div>
    </div>
  </div>
</template>
