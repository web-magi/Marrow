<script setup lang="ts">
defineProps<{ state: any }>();

const stat = (val: number, max = 100) => ({
  val, pct: Math.max(0, Math.min(100, (val / max) * 100)),
  color: val > 70 ? 'var(--good)' : val < 30 ? 'var(--bad)' : 'var(--warn)',
});
</script>

<template>
  <div class="dash-grid">
    <div class="card">
      <div class="stat-label">Energy</div>
      <div class="stat">{{ state.energy?.toFixed(1) ?? '—' }}</div>
      <div class="bar"><div class="bar-fill" :style="{ width: stat(state.energy).pct + '%', background: stat(state.energy).color }"></div></div>
    </div>
    <div class="card">
      <div class="stat-label">Mood Baseline</div>
      <div class="stat">{{ state.moodBaseline?.toFixed(1) ?? '—' }}</div>
      <div class="bar"><div class="bar-fill" :style="{ width: stat(state.moodBaseline).pct + '%', background: state.moodBaseline > 55 ? 'var(--good)' : state.moodBaseline < 45 ? 'var(--bad)' : 'var(--warn)' }"></div></div>
    </div>
    <div class="card">
      <div class="stat-label">Arousal</div>
      <div class="stat">{{ state.arousal?.toFixed(1) ?? '—' }}</div>
      <div class="bar"><div class="bar-fill" :style="{ width: stat(state.arousal, 120).pct + '%', background: stat(state.arousal, 120).color }"></div></div>
    </div>
    <div class="card">
      <div class="stat-label">Trust</div>
      <div class="stat">{{ state.trust?.toFixed(1) ?? '—' }}</div>
      <div class="bar"><div class="bar-fill" :style="{ width: stat(state.trust).pct + '%', background: stat(state.trust).color }"></div></div>
    </div>
    <div class="card">
      <div class="stat-label">Defensiveness</div>
      <div class="stat">{{ state.defensiveness?.toFixed(1) ?? '—' }}</div>
      <div class="bar"><div class="bar-fill" :style="{ width: stat(state.defensiveness).pct + '%', background: state.defensiveness > 60 ? 'var(--bad)' : 'var(--good)' }"></div></div>
    </div>
    <div class="card">
      <div class="stat-label">Cognitive Load</div>
      <div class="stat">{{ state.cognitiveLoad?.toFixed(1) ?? '—' }}</div>
      <div class="bar"><div class="bar-fill" :style="{ width: stat(state.cognitiveLoad, 120).pct + '%', background: state.cognitiveLoad > 80 ? 'var(--bad)' : 'var(--warn)' }"></div></div>
    </div>
    <div class="card">
      <div class="stat-label">Battery</div>
      <div class="stat">{{ state.batteryLevel?.toFixed(0) ?? '—' }}%</div>
      <div class="bar"><div class="bar-fill" :style="{ width: stat(state.batteryLevel ?? 0).pct + '%', background: stat(state.batteryLevel ?? 0).color }"></div></div>
    </div>
    <div class="card">
      <div class="stat-label">Attention</div>
      <div class="stat">{{ (state.attentionFocus * 100)?.toFixed(0) ?? '—' }}%</div>
      <div class="bar"><div class="bar-fill" :style="{ width: (state.attentionFocus * 100) + '%', background: 'var(--accent)' }"></div></div>
    </div>
  </div>
</template>
