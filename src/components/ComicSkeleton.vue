<script setup lang="ts">
withDefaults(defineProps<{ count?: number }>(), { count: 10 })
</script>
<template>
  <div class="comic-grid" aria-label="正在加载漫画" aria-busy="true">
    <div v-for="n in count" :key="n" class="skeleton-card">
      <div class="skeleton skeleton-cover" />
      <div class="skeleton skeleton-title" />
      <div class="skeleton skeleton-line" />
    </div>
  </div>
</template>
