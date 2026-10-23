<script setup lang="ts">
defineProps<{ title: string; description?: string; wide?: boolean }>()
</script>
<template>
  <div class="setting-row" :class="{ 'setting-row--wide': wide }">
    <div class="setting-row__label">
      <h3>{{ title }}</h3>
      <p v-if="description">{{ description }}</p>
      <slot name="description" />
    </div>
    <div class="setting-row__control"><slot /></div>
  </div>
</template>
<style scoped>
.setting-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px;
  gap: 28px;
  align-items: center;
  padding: 20px 0;
  border-bottom: 1px solid var(--c-border);
}
.setting-row:last-child {
  border-bottom: 0;
}
.setting-row__label h3 {
  font-size: 13px;
  font-weight: 500;
  margin: 0;
}
.setting-row__label p {
  font-size: 11px;
  line-height: 1.8;
  color: var(--c-text-3);
  margin: 6px 0 0;
}
.setting-row__control {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
  color: var(--c-text-2);
}
.setting-row__control :deep(.n-input-number) {
  width: 94px;
}
.setting-row--wide {
  grid-template-columns: 1fr;
  gap: 12px;
}
.setting-row--wide .setting-row__control {
  justify-content: flex-start;
}
@media (max-width: 1050px) {
  .setting-row {
    grid-template-columns: minmax(0, 1fr) 180px;
    gap: 16px;
  }
  .setting-row--wide {
    grid-template-columns: 1fr;
  }
}
</style>
