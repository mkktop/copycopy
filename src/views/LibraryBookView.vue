<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, remoteImage } from '../services/api'
import type { LibraryBook, LocalChapter } from '../types'
import { useAppStore } from '../stores/app'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
const app = useAppStore()
const route = useRoute()
const router = useRouter()
const book = ref<LibraryBook | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const managing = ref(false)
const selected = ref(new Set<string>())
const query = ref('')
const visible = computed(
  () =>
    book.value?.chapters.filter((c) => c.title.toLowerCase().includes(query.value.toLowerCase())) ||
    []
)
const allSelected = computed(
  () => visible.value.length > 0 && visible.value.every((c) => selected.value.has(c.id))
)
async function load() {
  loading.value = true
  error.value = ''
  try {
    book.value = (await api.library()).find((b) => b.comic.id === String(route.params.id)) || null
  } catch (cause) {
    error.value = String(cause)
  } finally {
    loading.value = false
  }
}
function read(chapter?: LocalChapter) {
  if (!book.value) return
  const target =
    chapter ||
    book.value.chapters.find((c) => c.id === book.value?.progress?.chapterId) ||
    book.value.chapters[0]
  if (!target) return
  void router.push({
    name: 'reader',
    params: { comicId: book.value.comic.id, chapterId: target.id },
    query: { local: '1', title: target.title, index: target.index }
  })
}
function manage() {
  managing.value = !managing.value
  selected.value.clear()
}
function toggle(id: string) {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
}
function selectAll() {
  const remove = allSelected.value
  visible.value.forEach((c) => {
    if (remove) selected.value.delete(c.id)
    else selected.value.add(c.id)
  })
}
async function exportSelected(ids = [...selected.value]) {
  if (!book.value || !ids.length || busy.value) return
  busy.value = true
  const id = book.value.comic.id
  const results = await app.run(() => api.exportPdf(id, ids))
  if (results) {
    app.notify('已导出 ' + results.length + ' 个 PDF')
    await load()
  }
  busy.value = false
}
async function removeSelected() {
  if (!book.value || !selected.value.size || busy.value) return
  if (
    !(await app.confirm(
      '删除所选章节？',
      '将删除这些章节的图片和 PDF，之后需要重新下载。',
      '删除章节',
      true
    ))
  )
    return
  busy.value = true
  const id = book.value.comic.id
  const result = await app.run(() => api.deleteDownloads(id, [...selected.value]), '所选章节已删除')
  if (result !== undefined) {
    selected.value.clear()
    await load()
  }
  busy.value = false
}
onMounted(load)
</script>
<template>
  <div class="page">
    <RouterLink to="/library" class="text-btn back-link">
      <AppIcon name="back" :size="16" />
      返回书库
    </RouterLink>
    <div v-if="loading && !book" class="loading">
      <span class="spinner" />
      正在打开书库…
    </div>
    <EmptyState v-else-if="error" title="章节未能加载" :description="error" error>
      <button class="btn btn-primary" @click="load">重新加载</button>
    </EmptyState>
    <EmptyState
      v-else-if="!book"
      title="这部作品尚未下载"
      description="回到发现页，下载想看的章节。"
    >
      <RouterLink to="/" class="btn btn-primary">发现故事</RouterLink>
    </EmptyState>
    <template v-else>
      <div class="local-book-header">
        <img v-if="book.comic.cover" :src="remoteImage(book.comic.cover)" :alt="book.comic.title" />
        <div>
          <div class="eyebrow">SAVED FOR YOUR NEXT CHAPTER</div>
          <h1>{{ book.comic.title }}</h1>
          <p>
            {{ book.chapters.length }} 章 · {{ book.totalPages.toLocaleString() }} 页
            <span v-if="book.incompleteCount">· {{ book.incompleteCount }} 章有缺页</span>
          </p>
        </div>
        <button class="btn btn-primary" @click="read()">
          <AppIcon name="book" :size="16" />
          {{ book.progress ? '继续阅读' : '开始阅读' }}
        </button>
      </div>
      <div class="section-heading">
        <h2>
          本地章节
          <small>READY TO READ</small>
        </h2>
        <button class="btn btn-secondary btn-sm" :disabled="busy" @click="manage">
          {{ managing ? '退出管理' : '管理章节' }}
        </button>
      </div>
      <div class="filter-bar">
        <label class="filter-search">
          <AppIcon name="search" :size="16" />
          <input v-model="query" aria-label="筛选本地章节" placeholder="寻找章节…" />
        </label>
        <span class="hint">{{ visible.length }} 个章节</span>
      </div>
      <div v-if="managing" class="batch-bar" data-chapter-batch>
        <label class="checkbox-label">
          <input type="checkbox" :checked="allSelected" @change="selectAll" />
          全选当前结果
        </label>
        <span>已选 {{ selected.size }} 章</span>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="!selected.size || busy"
          @click="exportSelected()"
        >
          {{ busy ? '处理中…' : '导出 PDF' }}
        </button>
        <button
          class="btn btn-danger btn-sm"
          :disabled="!selected.size || busy"
          @click="removeSelected"
        >
          删除章节
        </button>
      </div>
      <EmptyState
        v-if="!visible.length"
        title="没有找到这个章节"
        description="试试更短的关键词。"
      />
      <div v-else class="local-chapter-list">
        <article v-for="chapter in visible" :key="chapter.id" class="local-chapter-row">
          <input
            v-if="managing"
            type="checkbox"
            :checked="selected.has(chapter.id)"
            :aria-label="'选择 ' + chapter.title"
            @change="toggle(chapter.id)"
          />
          <span class="local-chapter-number">{{ String(chapter.index).padStart(2, '0') }}</span>
          <button class="chapter-title-button" @click="read(chapter)">
            <strong>{{ chapter.title }}</strong>
            <span>{{ chapter.pageCount }} / {{ chapter.total }} 页</span>
          </button>
          <span class="status-pill" :class="chapter.complete ? 'success' : 'warning'">
            {{ chapter.complete ? '已保存' : '有缺页' }}
          </span>
          <button
            v-if="chapter.pdfPath"
            class="text-btn"
            @click="app.run(() => api.openChapter(book!.comic.id, chapter.id, true))"
          >
            打开 PDF
          </button>
          <button v-else class="text-btn" :disabled="busy" @click="exportSelected([chapter.id])">
            导出 PDF
          </button>
          <button class="icon-btn" :aria-label="'阅读 ' + chapter.title" @click="read(chapter)">
            <AppIcon name="chevron-right" :size="17" />
          </button>
        </article>
      </div>
    </template>
  </div>
</template>
