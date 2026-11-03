<script setup lang="ts">
import AppIcon from './AppIcon.vue'
withDefaults(
  defineProps<{ icon?: string; title: string; description?: string; error?: boolean }>(),
  { icon: 'book' }
)
</script>
<template>
  <div class="empty-state" :class="{ 'is-error': error }" :role="error ? 'alert' : 'status'">
    <span class="empty-illustration"><AppIcon :name="error ? 'alert' : icon" :size="32" /></span>
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.default" class="empty-actions"><slot /></div>
  </div>
</template>
