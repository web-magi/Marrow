<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

const props = defineProps<{ history: any[] }>();
const canvasRef = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

function draw() {
  if (!canvasRef.value || props.history.length === 0) return;

  if (chart) chart.destroy();

  const labels = props.history.map((_, i) => i);
  chart = new Chart(canvasRef.value, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Energy', data: props.history.map(s => s.energy), borderColor: '#3fb950', borderWidth: 1, pointRadius: 0, tension: 0.3 },
        { label: 'Mood', data: props.history.map(s => s.moodBaseline), borderColor: '#58a6ff', borderWidth: 1, pointRadius: 0, tension: 0.3 },
        { label: 'Arousal', data: props.history.map(s => s.arousal), borderColor: '#d29922', borderWidth: 1, pointRadius: 0, tension: 0.3 },
        { label: 'Trust', data: props.history.map(s => s.trust), borderColor: '#a371f7', borderWidth: 1, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#c9d1d9', boxWidth: 12, font: { size: 11 } } },
      },
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 10 }, grid: { color: '#30363d' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
      },
    },
  });
}

watch(() => props.history, () => draw(), { deep: true });
onMounted(draw);
onUnmounted(() => { if (chart) chart.destroy(); });
</script>

<template>
  <div class="card four-col" style="height: 280px;">
    <h3>State Trend (last {{ history.length }} ticks)</h3>
    <canvas ref="canvasRef"></canvas>
  </div>
</template>
