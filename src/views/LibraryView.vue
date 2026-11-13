<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import type { LibraryBook } from '../types'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/downloads'
import AppIcon from '../components/AppIcon.vue'
import ComicCard from '../components/ComicCard.vue'
import ComicSkeleton from '../components/ComicSkeleton.vue'
import EmptyState from '../components/EmptyState.vue'
defineOptions({ name: 'LibraryView' })
const app = useAppStore()
const downloads = useDownloadStore()
const router = useRouter()
const books = ref<LibraryBook[]>([])
const query = ref('')
// 过滤输入防抖：避免每次按键都全量 filter + localeCompare 排序。
const debouncedQuery = ref('')
let queryTimer: ReturnType<typeof setTimeout> | undefined
watch(query, (value) => {
  clearTimeout(queryTimer)
  queryTimer = setTimeout(() => (debouncedQuery.value = value), 200)
})
onBeforeUnmount(() => clearTimeout(queryTimer))
const incomplete = ref(false)
const order = ref('title')
const loading = ref(false)
const error = ref('')
const stats = computed(() => ({
  books: books.value.length,
  chapters: books.value.reduce((sum, b) => sum + b.chapters.length, 0),
  pages: books.value.reduce((sum, b) => sum + b.totalPages, 0)
}))
const visible = computed(() =>
  books.value
    .filter(
      (book) =>
        (!incomplete.value || book.incompleteCount) &&
        (book.comic.title + book.comic.authors.join(' '))
          .toLowerCase()
          .includes(debouncedQuery.value.toLowerCase())
    )
    .sort((a, b) =>
      order.value === 'pages'
        ? b.totalPages - a.totalPages
        : a.comic.title.localeCompare(b.comic.title, 'zh-CN', { numeric: true })
    )
)
async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    books.value = await api.library()
  } catch (cause) {
    error.value = String(cause)
  } finally {
    loading.value = false
  }
}
function read(book: LibraryBook) {
  const chapter = book.chapters.find((c) => c.id === book.progress?.chapterId) || book.chapters[0]
  if (!chapter) return
  void router.push({
    name: 'reader',
    params: { comicId: book.comic.id, chapterId: chapter.id },
    query: { local: '1', title: chapter.title, index: chapter.index }
  })
}
async function remove(book: LibraryBook) {
  if (
    !(await app.confirm(
      '删除这部漫画的本地下载？',
      '图片和已导出的 PDF 都会删除，之后可以重新下载。',
      '删除下载',
      true
    ))
  )
    return
  const result = await app.run(() => api.deleteDownloads(book.comic.id), '本地下载已删除')
  if (result !== undefined) await load()
}
async function retry() {
  const result = await app.run(() => api.retryIncomplete(), '已将缺页章节加入下载队列')
  if (result) downloads.apply(result)
}
function resetFilters() {
  clearTimeout(queryTimer)
  query.value = ''
  debouncedQuery.value = ''
  incomplete.value = false
}
onActivated(load)
</script>
<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="eyebrow">YOUR OWN LITTLE LIBRARY</div>
        <h1>本地书库</h1>
        <p>喜欢的故事已经留在这里，随时打开，慢慢阅读。</p>
      </div>
      <button
        class="btn btn-secondary btn-sm"
        @click="app.run(() => api.openLocation('downloads'))"
      >
        <AppIcon name="folder" :size="15" />
        打开下载目录
      </button>
    </div>
    <div class="stats-strip">
      <div>
        <AppIcon name="library" />
        <span>
          <strong>{{ stats.books }}</strong>
          部作品
        </span>
      </div>
      <div>
        <AppIcon name="layers" />
        <span>
          <strong>{{ stats.chapters }}</strong>
          个章节
        </span>
      </div>
      <div>
        <AppIcon name="book" />
        <span>
          <strong>{{ stats.pages.toLocaleString() }}</strong>
          页故事
        </span>
      </div>
      <span class="stats-note">留给自己的阅读时光。</span>
    </div>
    <div class="filter-bar">
      <label class="filter-search">
        <AppIcon name="search" :size="16" />
        <input v-model="query" aria-label="筛选书库" placeholder="在书库中寻找…" />
      </label>
      <label class="checkbox-label">
        <input v-model="incomplete" type="checkbox" />
        只看缺页
      </label>
      <select v-model="order" class="input compact-input" aria-label="书库排序">
        <option value="title">按作品名称</option>
        <option value="pages">按本地页数</option>
      </select>
      <button class="icon-btn" title="刷新书库" :disabled="loading" @click="load">
        <AppIcon name="refresh" :size="17" />
      </button>
      <button
        v-if="books.some((b) => b.incompleteCount)"
        class="btn btn-secondary btn-sm"
        @click="retry"
      >
        补齐缺页
      </button>
    </div>
    <ComicSkeleton v-if="loading && !books.length" />
    <EmptyState v-else-if="error" title="书库暂时无法打开" :description="error" error>
      <button class="btn btn-primary" @click="load">重新扫描</button>
    </EmptyState>
    <EmptyState
      v-else-if="!books.length"
      title="为第一个故事留个位置"
      description="发现喜欢的作品后，下载章节，就会出现在你的本地书库。"
      icon="library"
    >
      <RouterLink to="/" class="btn btn-primary">发现故事</RouterLink>
    </EmptyState>
    <EmptyState
      v-else-if="!visible.length"
      title="没有符合筛选的漫画"
      description="试试其他关键词，或关闭「只看缺页」。"
    >
      <button class="btn btn-secondary" @click="resetFilters">清除筛选</button>
    </EmptyState>
    <div v-else class="comic-grid library-grid">
      <article v-for="book in visible" :key="book.comic.id" class="library-tile">
        <ComicCard
          :comic="book.comic"
          :badge="book.incompleteCount ? '有缺页' : '本地已下载'"
          :caption="book.chapters.length + ' 章 · ' + book.totalPages + ' 页'"
          @click="router.push('/library/' + encodeURIComponent(book.comic.id))"
        />
        <div class="library-tile-actions">
          <button class="text-btn" @click="read(book)">
            <AppIcon name="book" :size="14" />
            {{ book.progress ? '继续阅读' : '开始阅读' }}
          </button>
          <button
            class="icon-btn small"
            :aria-label="'删除下载 ' + book.comic.title"
            @click="remove(book)"
          >
            <AppIcon name="close" :size="14" />
          </button>
        </div>
      </article>
    </div>
  </div>
</template>
