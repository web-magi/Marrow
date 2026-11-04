<script setup lang="ts">
defineProps<{ runtime: any }>();

function formatUptime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
</script>

<template>
  <div class="card four-col">
    <div class="runtime-bar">
      <span>
        <span :class="['dot', !runtime.closed ? 'dot-green' : 'dot-red']"></span>
        Runtime: {{ runtime.closed ? 'CLOSED' : 'running' }}
      </span>
      <span>Uptime: {{ formatUptime(runtime.uptimeSeconds) }}</span>
      <span>Events: {{ runtime.eventCount }}</span>
      <span>Tick: {{ runtime.tick.pending ? 'pending' : runtime.tick.running ? 'running' : 'idle' }}</span>
      <span>Queue: active={{ runtime.queue.active }} reserved={{ runtime.queue.reserved }} ready={{ runtime.queue.ready }} waiting={{ runtime.queue.waiting }} running={{ runtime.queue.running }}</span>
    </div>
  </div>
</template>
