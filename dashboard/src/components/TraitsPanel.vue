<script setup lang="ts">
defineProps<{ traits: any }>();
const keys = ['neuroticism', 'extraversion', 'openness', 'agreeableness', 'conscientiousness'];
</script>

<template>
  <div class="card two-col">
    <h3>Personality Traits (Big Five)</h3>
    <div v-if="traits" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;">
      <div v-for="k in keys" :key="k" style="text-align: center;">
        <div class="stat-label">{{ k.slice(0, 3).toUpperCase() }}</div>
        <div class="stat" style="font-size: 16px;">{{ Number(traits[k]).toFixed(2) }}</div>
      </div>
    </div>
    <div v-else class="empty">No traits</div>
  </div>
</template>
