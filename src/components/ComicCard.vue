<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { remoteImage } from '../services/api'
import type { Comic } from '../types'
import AppIcon from './AppIcon.vue'
const props = defineProps<{ comic: Comic; badge?: string; caption?: string }>()
defineEmits<{ click: [] }>()
const failed = ref(false)
const src = computed(() => remoteImage(props.comic.cover))
watch(src, () => { failed.value = false })
</script>
<template>
  <button class="comic-card" :aria-label="'查看 ' + comic.title" @click="$emit('click')">
    <span class="comic-cover">
      <img v-if="src && !failed" :src="src" :alt="comic.title" loading="lazy" @error="failed = true"/>
      <span v-else class="cover-fallback"><AppIcon name="book" :size="38"/><span>COPYCOPY LIBRARY</span></span>
      <span v-if="badge" class="cover-status">{{ badge }}</span>
      <span class="cover-overlay"><span>打开故事 <AppIcon name="arrow" :size="16"/></span></span>
    </span>
    <span class="comic-info">
      <strong class="comic-title" :title="comic.title">{{ comic.title }}</strong>
      <span class="comic-author">{{ comic.authors.join(' / ') || '作者未署名' }}</span>
      <span class="comic-meta"><span>{{ caption || comic.alias || comic.latestChapter || '发现一个新故事' }}</span><AppIcon name="chevron-right" :size="12"/></span>
    </span>
  </button>
</template>
