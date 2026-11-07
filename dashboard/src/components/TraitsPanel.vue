<script setup lang="ts">
/**
 * TraitsPanel.vue — 全息精密参数仪表
 * RES = 恢复韧性（已核实代码注释）
 */
const props = defineProps<{ traits: any | null }>();
const traitDefs = [
  { key: 'neuroticism', label: '神经质', en: 'NEU', min: '情绪不稳', max: '情绪稳定', color: '#8B5CFF' },
  { key: 'agreeableness',  label: '宜人性', en: 'AGR', min: '冷峻', max: '温和',     color: '#00F5A0' },
  { key: 'extraversion',   label: '外向性', en: 'EXT', min: '内向', max: '外向',     color: '#00E5FF' },
  { key: 'resilience',     label: '恢复韧性', en: 'RES', min: '脆弱', max: '韧性',   color: '#168BFF' },
] as const;
</script>

<template>
  <div class="panel">
    <div class="panel-header">
      <span class="zh">人格特征</span>
      <span class="en">PERSONALITY · PSYCHOMETRIC</span>
      <span class="corner-id">009</span>
      <span class="corner-tr"></span>
      <span class="corner-bl"></span>
      <span class="corner-br"></span>
    </div>

    <div v-if="!traits" class="empty-state">
      <div class="empty-orb"></div>
      <div class="empty-text">尚未初始化 · NOT INITIALIZED</div>
    </div>

    <div v-else class="traits-wrap">
      <div v-for="t in traitDefs" :key="t.key" class="trait-row">
        <div class="trait-head">
          <span class="zh">{{ t.label }}</span>
          <span class="en">{{ t.en }}</span>
        </div>
        <div class="trait-bar">
          <div class="center"></div>
          <div class="fill"
               :style="{
                 width: Math.max(0, Math.min(100, ((traits as any)[t.key] ?? 0) * 50)) + '%',
                 background: `linear-gradient(90deg, transparent, ${t.color})`,
                 boxShadow: `0 0 8px ${t.color}55`,
               }"></div>
          <div class="val-marker"
               :style="{ left: Math.max(0, Math.min(100, ((traits as any)[t.key] ?? 0) * 50)) + '%', background: t.color, boxShadow: `0 0 6px ${t.color}` }"></div>
        </div>
        <div class="trait-foot">
          <span>{{ t.min }}</span>
          <span class="num">{{ ((traits as any)[t.key] ?? 0).toFixed(2) }}</span>
          <span>{{ t.max }}</span>
        </div>
      </div>

      <div class="trait-note">
        ⓘ 以上为出生时的底层系数，当前数值不代表已稳定形成的人格标签。
      </div>
    </div>
  </div>
</template>
