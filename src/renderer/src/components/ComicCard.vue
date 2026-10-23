<script setup lang="ts">
import ComicCover from './ComicCover.vue'
defineProps<{
  name: string
  cover?: string | null
  subtitle?: string
  badge?: string
  warning?: boolean
}>()
defineEmits<{ open: [] }>()
</script>

<template>
  <button type="button" class="comic-card" :aria-label="`打开《${name}》`" @click="$emit('open')">
    <ComicCover :src="cover" :name="name">
      <span v-if="badge" class="comic-card__badge" :class="{ warning }">{{ badge }}</span>
      <span class="comic-card__open">查看漫画 ↗</span>
    </ComicCover>
    <span class="comic-card__name" :title="name">{{ name }}</span>
    <span v-if="subtitle" class="comic-card__subtitle" :title="subtitle">{{ subtitle }}</span>
  </button>
</template>
