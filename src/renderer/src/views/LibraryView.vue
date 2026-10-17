<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCheckbox, NEmpty, NInput, NSelect, NSkeleton, NSpace, NSpin, NTag, NText, useMessage } from 'naive-ui'
import type { LibraryComic } from '@shared/types'
import { useAppStore } from '../stores/app'

const router = useRouter()
const message = useMessage()
const app = useAppStore()

const comics = ref<LibraryComic[]>([])
const loading = ref(false)
const filter = ref('')

/** 排序：名称 / 章节数 / 页数 / 缺页数 */
type SortKey = 'name' | 'chapters' | 'pages' | 'incomplete'
const sortKey = ref<SortKey>('name')
const sortDesc = ref(false)
/** 只看有缺页的 */
const onlyIncomplete = ref(false)

const sortOptions = [
  { label: '按名称', value: 'name' },
  { label: '按章节数', value: 'chapters' },
  { label: '按页数', value: 'pages' },
  { label: '按缺页数', value: 'incomplete' }
]

const filtered = computed(() => {
  const kw = filter.value.trim().toLowerCase()
  let list = comics.value
  if (kw) {
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(kw) ||
        c.chapters.some((ch) => ch.name.toLowerCase().includes(kw))
    )
  }
  if (onlyIncomplete.value) {
    list = list.filter((c) => (c.incompleteCount ?? 0) > 0)
  }

  const dir = sortDesc.value ? -1 : 1
  const sorted = [...list]
  sorted.sort((a, b) => {
    switch (sortKey.value) {
      case 'chapters':
        return (a.chapters.length - b.chapters.length) * dir
      case 'pages':
        return (a.totalPages - b.totalPages) * dir
      case 'incomplete':
        return ((a.incompleteCount ?? 0) - (b.incompleteCount ?? 0)) * dir
      default:
        return a.name.localeCompare(b.name, 'zh') * dir
    }
  })
  return sorted
})

const totals = computed(() => ({
  comics: comics.value.length,
  chapters: comics.value.reduce((s, c) => s + c.chapters.length, 0),
  pages: comics.value.reduce((s, c) => s + c.totalPages, 0),
  incomplete: comics.value.reduce((s, c) => s + (c.incompleteCount ?? 0), 0)
}))

async function load(): Promise<void> {
  loading.value = true
  try {
    comics.value = await window.mkk.libraryList()
  } finally {
    loading.value = false
  }
}

function open(c: LibraryComic): void {
  router.push('/library/' + encodeURIComponent(c.name))
}

async function retryMissing(): Promise<void> {
  const n = await window.mkk.retryMissing()
  if (n > 0) message.success(`已把 ${n} 个缺页章节加入下载队列`)
  else message.info('没有需要补下的章节')
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <NInput
        v-model:value="filter"
        placeholder="按漫画名或章节名筛选"
        style="width: 240px"
        clearable
      />
      <NSelect
        v-model:value="sortKey"
        :options="sortOptions"
        size="small"
        style="width: 120px"
      />
      <NButton size="small" quaternary @click="sortDesc = !sortDesc">
        {{ sortDesc ? '降序 ↓' : '升序 ↑' }}
      </NButton>
      <NCheckbox v-model:checked="onlyIncomplete">
        只看缺页<span v-if="totals.incomplete">（{{ totals.incomplete }}）</span>
      </NCheckbox>
      <NButton size="small" :loading="loading" @click="load">刷新</NButton>
      <NButton
        v-if="totals.incomplete > 0"
        size="small"
        type="primary"
        secondary
        @click="retryMissing"
      >
        补下全部缺页
      </NButton>
      <NText depth="3" style="font-size: 12px">
        共 {{ totals.comics }} 部 · {{ totals.chapters }} 章 · {{ totals.pages }} 页
      </NText>
    </div>

    <NSpin :show="loading">
      <!-- 骨架屏：扫描 out/ 要一点时间，空白闪烁比骨架难看 -->
      <div v-if="loading && !comics.length" class="grid">
        <div v-for="i in 10" :key="i" class="card">
          <NSkeleton height="0" style="padding-top: 133%" :sharp="false" />
          <div class="sk-meta">
            <NSkeleton text :repeat="2" />
          </div>
        </div>
      </div>
      <div v-else-if="filtered.length" class="grid">
        <div v-for="c in filtered" :key="c.name" class="card" @click="open(c)">
          <div class="cover-wrap">
            <img
              v-if="app.imgUrl(c.cover)"
              :src="app.imgUrl(c.cover)!"
              class="cover"
              :alt="c.name"
            />
            <div v-else class="cover placeholder">{{ c.name.slice(0, 2) }}</div>
            <span v-if="c.incompleteCount" class="badge">{{ c.incompleteCount }} 章缺页</span>
          </div>
          <div class="meta">
            <div class="title" :title="c.name">{{ c.name }}</div>
            <div class="tags">
              <NTag size="tiny" :bordered="false">{{ c.chapters.length }} 章</NTag>
              <NTag size="tiny" :bordered="false" type="info">{{ c.totalPages }} 页</NTag>
            </div>
          </div>
        </div>
      </div>
      <NEmpty v-else-if="!loading" description="漫画库还是空的，先去下载一些章节" class="empty" />
    </NSpin>
  </div>
</template>

<style scoped>
.badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--c-warn-fg);
  background: var(--c-warn-bg);
  border-radius: 4px;
}

.sk-meta {
  margin-top: 8px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 16px;
}

.card {
  cursor: pointer;
  border-radius: 8px;
  transition: transform 0.15s ease;
}

.card:hover {
  transform: translateY(-3px);
}

.cover-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  overflow: hidden;
  background: var(--c-placeholder);
}

.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-4);
  font-size: 26px;
  font-weight: 600;
}

.meta {
  margin-top: 8px;
}

.title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 5px;
}

.tags {
  display: flex;
  gap: 5px;
}
</style>
