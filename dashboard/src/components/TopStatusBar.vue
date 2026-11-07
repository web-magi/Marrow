<script setup lang="ts">
/**
 * TopStatusBar.vue — 全息数字生命观测终端状态栏
 * 6 格精密读数 + 角标编号 + 扫描装饰线
 */
import type { RuntimeResponse } from '../api/runtime';

const props = defineProps<{ runtime: RuntimeResponse | null; connected: boolean }>();

function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
}
function fmtTick(r: RuntimeResponse): string {
  if (r.tick.pending) return '待处理';
  if (r.tick.running) return '执行中';
  return '空闲';
}
function fmtQueue(r: RuntimeResponse): string {
  if (r.queue.active === 0) return '队列空';
  return `活动 ${r.queue.active}`;
}
</script>

<template>
  <div class="top-bar">
    <div class="top-title">
      <span class="zh">MARROW V2</span>
      <span class="sub">生命体观测终端 · LIFEFORM OBSERVATION TERMINAL</span>
    </div>

    <div class="top-cell" data-index="002">
      <span class="en">身份标识 · IDENTITY</span>
      <span class="val" style="font-size: 12px; color: var(--text-secondary);">{{ runtime?.identityId ?? '—' }}</span>
    </div>

    <div class="top-cell status" data-index="003">
      <span :class="['dot', runtime?.closed ? 'dot-closed' : connected ? 'dot-online' : 'dot-offline']"></span>
      <span class="status-text">
        <span class="val" :style="{
          color: runtime?.closed ? 'var(--status-warn)' : connected ? 'var(--light-green)' : 'var(--status-danger)',
          textShadow: connected && !runtime?.closed ? '0 0 8px rgba(0, 245, 160, 0.5)' : 'none',
        }">
          {{ !runtime ? '等待中' : runtime.closed ? '已关闭' : connected ? '在线' : '连接中断' }}
        </span>
        <span class="en">运行状态 · STATUS</span>
      </span>
    </div>

    <div class="top-cell" data-index="004">
      <span class="en">运行时长 · UPTIME</span>
      <span class="val">{{ runtime ? fmtUptime(runtime.uptimeSeconds) : '—' }}</span>
    </div>

    <div class="top-cell" data-index="005">
      <span class="en">事件总数 · EVENTS</span>
      <span class="val">{{ runtime?.eventCount ?? '—' }}</span>
    </div>

    <div class="top-cell" data-index="006">
      <span class="en">周期 · 队列 · CYCLE · QUEUE</span>
      <span class="val" style="font-size: 11px; color: var(--text-secondary);">
        <template v-if="runtime">{{ fmtTick(runtime) }} · {{ fmtQueue(runtime) }}</template>
        <template v-else>—</template>
      </span>
    </div>
  </div>
</template>
