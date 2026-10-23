<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NInput, NSelect, NSkeleton, useMessage } from 'naive-ui'
import {
  AddOutline,
  FolderOpenOutline,
  SearchOutline,
  RefreshOutline,
  ArrowDownOutline,
  ArrowUpOutline
} from '@vicons/ionicons5'
import type { LibraryComic } from '@shared/types'
import { useAppStore } from '../stores/app'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ComicCard from '../components/ComicCard.vue'

const router = useRouter()
const message = useMessage()
const app = useAppStore()
const comics = ref<LibraryComic[]>([])
const loading = ref(false)
const error = ref('')
const filter = ref('')
const sortKey = ref('name')
const sortDesc = ref(false)
const onlyIncomplete = ref(false)
const retrying = ref(false)
function clearFilters(): void {
  filter.value = ''
  onlyIncomplete.value = false
}
const sortOptions = [
  { label: '按名称排序', value: 'name' },
  { label: '按章节数量', value: 'chapters' },
  { label: '按图片数量', value: 'pages' }
]
const totals = computed(() => ({
  chapters: comics.value.reduce((sum, comic) => sum + comic.chapters.length, 0),
  pages: comics.value.reduce((sum, comic) => sum + comic.totalPages, 0),
  incomplete: comics.value.filter((comic) => (comic.incompleteCount || 0) > 0).length
}))
const filtered = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  return comics.value
    .filter(
      (comic) =>
        (!onlyIncomplete.value || (comic.incompleteCount || 0) > 0) &&
        (!keyword ||
          comic.name.toLowerCase().includes(keyword) ||
          comic.chapters.some((chapter) => chapter.name.toLowerCase().includes(keyword)))
    )
    .sort(
      (a, b) =>
        (sortKey.value === 'chapters'
          ? a.chapters.length - b.chapters.length
          : sortKey.value === 'pages'
            ? a.totalPages - b.totalPages
            : a.name.localeCompare(b.name, 'zh')) * (sortDesc.value ? -1 : 1)
    )
})
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    comics.value = await window.mkk.libraryList()
  } catch (cause) {
    error.value = String(cause)
  } finally {
    loading.value = false
  }
}
async function retryMissing(): Promise<void> {
  retrying.value = true
  try {
    const count = await window.mkk.retryMissing()
    if (count) message.success(`已将 ${count} 个缺页章节加入下载队列`)
    else message.info('没有需要补下的章节')
  } catch (cause) {
    message.error('补全失败：' + String(cause))
  } finally {
    retrying.value = false
  }
}
async function openFolder(): Promise<void> {
  try {
    if (!app.paths) await app.loadPaths()
    if (app.paths) {
      const result = await window.mkk.openPath(app.paths.out)
      if (result) message.error(result)
    }
  } catch (cause) {
    message.error('无法打开目录：' + String(cause))
  }
}
onMounted(load)
</script>

<template>
  <div class="page">
    <div class="content-width">
      <PageHeader
        title="我的书架"
        eyebrow="YOUR PERSONAL LIBRARY"
        :description="
          comics.length
            ? `收藏了 ${comics.length} 部故事 · ${totals.chapters} 个章节 · ${totals.pages.toLocaleString()} 页离线内容`
            : '每一个下载好的故事，都收在这里。'
        "
      >
        <NButton @click="openFolder">
          <template #icon><NIcon :component="FolderOpenOutline" /></template>
          下载目录
        </NButton>
        <NButton type="primary" @click="router.push('/search')">
          <template #icon><NIcon :component="AddOutline" /></template>
          添加漫画
        </NButton>
      </PageHeader>
      <div class="library-toolbar">
        <div class="filter-tabs" role="tablist" aria-label="书架筛选">
          <button
            type="button"
            role="tab"
            :aria-selected="!onlyIncomplete"
            @click="onlyIncomplete = false"
          >
            全部漫画
            <span>{{ comics.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="onlyIncomplete"
            @click="onlyIncomplete = true"
          >
            需要补全
            <span>{{ totals.incomplete }}</span>
          </button>
        </div>
        <div class="library-controls">
          <NInput
            v-model:value="filter"
            placeholder="搜索书架…"
            clearable
            class="library-search"
            aria-label="搜索本地书架"
          >
            <template #prefix><NIcon :component="SearchOutline" /></template>
          </NInput>
          <NSelect
            v-model:value="sortKey"
            :options="sortOptions"
            class="library-sort"
            aria-label="书架排序"
          />
          <NButton
            quaternary
            circle
            :aria-label="sortDesc ? '改为升序' : '改为降序'"
            @click="sortDesc = !sortDesc"
          >
            <template #icon>
              <NIcon :component="sortDesc ? ArrowDownOutline : ArrowUpOutline" />
            </template>
          </NButton>
          <NButton quaternary circle :loading="loading" aria-label="刷新书架" @click="load">
            <template #icon><NIcon :component="RefreshOutline" /></template>
          </NButton>
        </div>
      </div>
      <div v-if="onlyIncomplete && totals.incomplete" class="repair-banner">
        <span>有 {{ totals.incomplete }} 部漫画存在缺页，可以继续下载补齐。</span>
        <NButton size="small" :loading="retrying" @click="retryMissing">一键补全缺页</NButton>
      </div>
      <div v-if="loading && !comics.length" class="book-grid" aria-busy="true">
        <div v-for="index in 10" :key="index">
          <NSkeleton height="auto" style="aspect-ratio: 3/4; border-radius: 10px" />
          <NSkeleton text style="margin-top: 12px" />
        </div>
      </div>
      <EmptyState v-else-if="error" title="书架暂时无法打开" :description="error">
        <NButton @click="load">重新加载</NButton>
      </EmptyState>
      <div v-else-if="filtered.length" class="book-grid">
        <ComicCard
          v-for="comic in filtered"
          :key="comic.name"
          :name="comic.name"
          :cover="app.imgUrl(comic.cover)"
          :subtitle="`${comic.chapters.length} 章 · ${comic.totalPages.toLocaleString()} 页`"
          :badge="comic.incompleteCount ? `${comic.incompleteCount} 章待补全` : undefined"
          :warning="!!comic.incompleteCount"
          @open="router.push('/library/' + encodeURIComponent(comic.name))"
        />
      </div>
      <EmptyState
        v-else-if="comics.length"
        :title="onlyIncomplete && !filter ? '所有故事都完整了' : '没有符合条件的漫画'"
        :description="
          onlyIncomplete && !filter
            ? '书架中的章节都已完整下载，安心开始阅读吧。'
            : '试试其他关键词，或清除筛选条件。'
        "
      >
        <NButton @click="clearFilters">查看全部漫画</NButton>
      </EmptyState>
      <EmptyState
        v-else-if="!loading"
        title="书架的第一本，会是什么？"
        description="搜索一部喜欢的漫画，选择章节下载，就能在这里开始离线阅读。"
      >
        <NButton type="primary" @click="router.push('/search')">去发现漫画</NButton>
      </EmptyState>
      <div v-if="filtered.length" class="library-footer">
        已显示 {{ filtered.length }} 部漫画
        <span>内容保存在本机，离线也能阅读</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid var(--c-border);
  padding-bottom: 20px;
  margin-bottom: 26px;
  flex-wrap: wrap;
}
.library-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.library-search {
  width: 180px;
}
.library-sort {
  width: 132px;
}
.repair-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  margin-bottom: 24px;
  border-radius: 10px;
  background: var(--c-warn-bg);
  color: var(--c-warn-fg);
  font-size: 12px;
}
.library-footer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 32px;
  padding-top: 18px;
  border-top: 1px solid var(--c-border);
  font-size: 10px;
  color: var(--c-text-3);
}
@media (max-width: 1050px) {
  .library-controls {
    margin-left: auto;
  }
  .library-search {
    width: 160px;
  }
}
</style>
