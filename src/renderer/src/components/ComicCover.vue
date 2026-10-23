<script setup lang="ts">
import { ref, watch } from 'vue'
import { NIcon } from 'naive-ui'
import { BookOutline } from '@vicons/ionicons5'
const props = defineProps<{ src?: string | null; name: string }>()
const failed = ref(false)
watch(
  () => props.src,
  () => {
    failed.value = false
  }
)
</script>

<template>
  <div class="comic-cover">
    <img
      v-if="src && !failed"
      :src="src"
      :alt="name"
      loading="lazy"
      draggable="false"
      @error="failed = true"
    />
    <div v-else class="comic-cover__fallback" :aria-label="name">
      <NIcon :component="BookOutline" :size="30" />
      <span>{{ name }}</span>
      <small>COPYCOPY LIBRARY</small>
    </div>
    <slot />
  </div>
</template>
