<script setup lang="ts">
import { NIcon } from 'naive-ui'
import { BookOutline } from '@vicons/ionicons5'
import type { Component } from 'vue'
defineProps<{
  title: string
  description?: string
  icon?: Component
  compact?: boolean
}>()
</script>

<template>
  <div class="empty-state" :class="{ 'empty-state--compact': compact }" role="status">
    <div class="empty-state__icon">
      <NIcon :component="icon || BookOutline" :size="28" />
    </div>
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.default" class="empty-state__actions"><slot /></div>
  </div>
</template>
