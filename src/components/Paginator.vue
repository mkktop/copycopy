<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
const props = withDefaults(defineProps<{ page: number; pages: number; loading?: boolean }>(), {
  loading: false
})
const emit = defineEmits<{ (e: 'change', page: number): void }>()
const items = computed<(number | '…')[]>(() => {
  const { page, pages } = props
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const keep = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1])
  const out: (number | '…')[] = []
  let prev = 0
  for (const n of [...keep].filter((v) => v >= 1 && v <= pages).sort((a, b) => a - b)) {
    if (n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
})
function go(target: number) {
  if (props.loading || target < 1 || target > props.pages || target === props.page) return
  emit('change', target)
}
// 页码直跳：输入数字后回车（或失焦）跳转，非法输入回退为当前页。
const draft = ref(String(props.page))
watch(
  () => props.page,
  (p) => {
    draft.value = String(p)
  }
)
function submitJump() {
  const target = parseInt(draft.value, 10)
  if (Number.isInteger(target) && target >= 1 && target <= props.pages) {
    if (target === props.page) draft.value = String(props.page)
    else go(target)
  } else {
    draft.value = String(props.page)
  }
}
</script>
<template>
  <div v-if="pages > 1" class="paginator" role="navigation" aria-label="分页">
    <button
      class="page-btn nav"
      :disabled="loading || page <= 1"
      aria-label="上一页"
      @click="go(page - 1)"
    >
      <AppIcon name="chevron-left" :size="14" />
    </button>
    <template v-for="(item, i) in items" :key="i">
      <span v-if="item === '…'" class="page-ellipsis">…</span>
      <button
        v-else
        class="page-btn"
        :class="{ active: item === page }"
        :disabled="loading"
        @click="go(item)"
      >
        {{ item }}
      </button>
    </template>
    <button
      class="page-btn nav"
      :disabled="loading || page >= pages"
      aria-label="下一页"
      @click="go(page + 1)"
    >
      <AppIcon name="chevron-right" :size="14" />
    </button>
    <span class="page-info"
      >第<input
        v-model="draft"
        class="page-jump"
        inputmode="numeric"
        maxlength="5"
        aria-label="输入页码跳转"
        :disabled="loading"
        @focus="($event.target as HTMLInputElement).select()"
        @keyup.enter="($event.target as HTMLInputElement).blur()"
        @blur="submitJump"
      />/ {{ pages }} 页</span
    >
  </div>
</template>
<style scoped>
.paginator {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 30px 0;
}
.page-btn {
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
  transition: var(--transition);
}
.page-btn:hover:not(:disabled):not(.active) {
  border-color: var(--accent);
  color: var(--accent);
}
.page-btn.active {
  background: var(--accent-glow);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.page-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.page-ellipsis {
  color: var(--text-muted);
  font-size: 11px;
  padding: 0 2px;
}
.page-info {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.page-jump {
  width: 36px;
  height: 24px;
  text-align: center;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 5px;
  outline: none;
  transition: var(--transition);
}
.page-jump:focus {
  border-color: var(--accent);
}
.page-jump:disabled {
  opacity: 0.45;
}
@media (max-width: 760px) {
  .page-info {
    width: 100%;
    text-align: center;
    margin: 4px 0 0;
  }
}
</style>
