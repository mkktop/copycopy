<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, remoteImage } from '../services/api'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/downloads'
import type { Chapter, Comic } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import Paginator from '../components/Paginator.vue'
const route = useRoute()
const router = useRouter()
const app = useAppStore()
const downloads = useDownloadStore()
const comic = ref<Comic | null>(null)
const chapters = ref<Chapter[]>([])
const selected = ref(new Map<string, Chapter>())
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const loading = ref(false)
const chapterLoading = ref(false)
const error = ref('')
const chapterError = ref('')
const busy = ref(false)
const subscribing = ref(false)
const openingFirst = ref(false)
const subscribed = ref(false)
const limit = ref(10)
const rangeFrom = ref(1)
const rangeTo = ref(10)
const coverFailed = ref(false)
const id = computed(() => String(route.params.id))
const allSelected = computed(
  () => chapters.value.length > 0 && chapters.value.every((c) => selected.value.has(c.id))
)
// 章节分页请求号：分页、重试、id 变化都会递增，用于作废旧响应。
let generation = 0
// 作品元数据请求号：与章节请求号分开，避免 loadChapters 递增时误伤 loading。
let metaGeneration = 0
async function loadChapters(target = 1) {
  const active = ++generation
  chapterLoading.value = true
  chapterError.value = ''
  try {
    const result = await api.chapters(id.value, target)
    if (active === generation) {
      chapters.value = result.items
      total.value = result.total
      pageSize.value = result.pageSize || 50
      page.value = target
    }
  } catch (cause) {
    if (active === generation) chapterError.value = String(cause)
  } finally {
    if (active === generation) chapterLoading.value = false
  }
}
watch(
  id,
  async () => {
    const active = ++metaGeneration
    generation++ // id 变化：作废上一部作品尚未返回的章节请求
    loading.value = true
    error.value = ''
    comic.value = null
    selected.value.clear()
    coverFailed.value = false
    try {
      const [result, subs] = await Promise.all([api.comic(id.value), api.subscriptions()])
      if (active !== metaGeneration) return
      comic.value = result
      const sub = subs.find((s) => s.comic.id === id.value)
      subscribed.value = !!sub
      limit.value = sub?.chapterLimit || 10
      await loadChapters()
    } catch (cause) {
      if (active === metaGeneration) error.value = String(cause)
    } finally {
      if (active === metaGeneration) loading.value = false
    }
  },
  { immediate: true }
)
function toggle(chapter: Chapter) {
  if (selected.value.has(chapter.id)) selected.value.delete(chapter.id)
  else selected.value.set(chapter.id, chapter)
}
function togglePage() {
  const remove = allSelected.value
  chapters.value.forEach((c) => {
    if (remove) selected.value.delete(c.id)
    else selected.value.set(c.id, c)
  })
}
async function selectRange() {
  if (
    !Number.isInteger(rangeFrom.value) ||
    !Number.isInteger(rangeTo.value) ||
    rangeFrom.value < 1 ||
    rangeTo.value < rangeFrom.value ||
    rangeTo.value > total.value
  ) {
    app.notify('请输入有效的章节区间', true)
    return
  }
  if (rangeTo.value - rangeFrom.value >= 500) {
    app.notify('每次最多选择 500 章', true)
    return
  }
  busy.value = true
  await app.run(async () => {
    const additions: Chapter[] = []
    const size = pageSize.value
    for (
      let p = Math.floor((rangeFrom.value - 1) / size) + 1;
      p <= Math.ceil(rangeTo.value / size);
      p++
    ) {
      const result = p === page.value ? { items: chapters.value } : await api.chapters(id.value, p)
      additions.push(
        ...result.items.filter((c) => c.index >= rangeFrom.value && c.index <= rangeTo.value)
      )
    }
    additions.forEach((c) => selected.value.set(c.id, c))
  })
  busy.value = false
}
async function download() {
  if (!comic.value || !selected.value.size || busy.value) return
  const book = comic.value
  busy.value = true
  const result = await app.run(
    () =>
      api.enqueue(
        book,
        [...selected.value.values()].sort((a, b) => a.index - b.index)
      ),
    '已加入下载队列'
  )
  if (result) {
    downloads.apply(result)
    selected.value.clear()
  }
  busy.value = false
}
async function subscription() {
  if (!comic.value || subscribing.value) return
  subscribing.value = true
  const book = comic.value
  const result = await app.run(() => api.subscribe(book, limit.value), '追更订阅已保存')
  if (result) subscribed.value = true
  subscribing.value = false
}
function read(chapter: Chapter) {
  void router.push({
    name: 'reader',
    params: { comicId: id.value, chapterId: chapter.id },
    query: { local: '0', index: chapter.index, title: chapter.title }
  })
}
// 「开始在线阅读」固定从第一页首章开始，不能用当前页 chapters[0]（翻页后会从第 51 话起）。
async function readFirst() {
  if (openingFirst.value) return
  openingFirst.value = true
  try {
    let first: Chapter | undefined = chapters.value[0]
    if (page.value !== 1 || !first) first = (await api.chapters(id.value, 1)).items[0]
    if (first) read(first)
    else app.notify('还没有可阅读的章节', true)
  } catch (cause) {
    app.notify(String(cause), true)
  } finally {
    openingFirst.value = false
  }
}
onBeforeUnmount(() => {
  generation++
  metaGeneration++
})
</script>
<template>
  <div class="page">
    <button class="text-btn back-link" @click="router.back()">
      <AppIcon name="back" :size="16" />
      返回
    </button>
    <div v-if="loading" class="loading">
      <span class="spinner" />
      正在打开故事…
    </div>
    <EmptyState v-else-if="error" title="作品暂时无法打开" :description="error" error>
      <RouterLink to="/search" class="btn btn-primary">返回搜索</RouterLink>
    </EmptyState>
    <template v-else-if="comic">
      <section class="book-overview">
        <div class="detail-cover">
          <img
            v-if="comic.cover && !coverFailed"
            :src="remoteImage(comic.cover)"
            :alt="comic.title"
            @error="coverFailed = true"
          />
          <span v-else class="cover-fallback"><AppIcon name="book" :size="56" /></span>
        </div>
        <div class="book-description">
          <div class="eyebrow">ONE MORE STORY</div>
          <h1>{{ comic.title }}</h1>
          <p class="authors">{{ comic.authors.join(' / ') || '作者未署名' }}</p>
          <div class="book-tags">
            <span v-if="comic.alias">{{ comic.alias }}</span>
            <span>{{ total }} 章</span>
            <span v-if="comic.latestChapter">最新：{{ comic.latestChapter }}</span>
          </div>
          <p class="synopsis">{{ comic.description || '故事的精彩，留给阅读时慢慢发现。' }}</p>
          <div class="book-actions">
            <button
              class="btn btn-primary"
              :disabled="!chapters.length || openingFirst"
              @click="readFirst"
            >
              <AppIcon name="book" :size="16" />
              开始在线阅读
            </button>
            <button class="btn btn-secondary" :disabled="subscribing" @click="subscription">
              <AppIcon name="heart" :size="16" />
              {{ subscribed ? '已订阅追更' : '加入追更' }}
            </button>
            <label class="inline-label">
              每次追更
              <input
                v-model.number="limit"
                type="number"
                min="1"
                max="100"
                aria-label="单次追更章数"
              />
              章
            </label>
          </div>
        </div>
      </section>
      <div class="section-heading">
        <h2>
          章节目录
          <small>{{ total }} CHAPTERS</small>
        </h2>
        <span class="hint">点击章节阅读，勾选章节下载</span>
      </div>
      <div class="chapter-toolbar">
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="allSelected"
            :disabled="chapterLoading || !chapters.length"
            @change="togglePage"
          />
          本页全选
        </label>
        <span class="selection-count">已选 {{ selected.size }} 章</span>
        <button v-if="selected.size" class="text-btn" @click="selected.clear()">清空选择</button>
        <div class="range-select">
          <input
            v-model.number="rangeFrom"
            type="number"
            min="1"
            :max="total"
            aria-label="区间起始章节"
          />
          <span>至</span>
          <input
            v-model.number="rangeTo"
            type="number"
            min="1"
            :max="total"
            aria-label="区间结束章节"
          />
          <button
            class="btn btn-secondary btn-sm"
            :disabled="busy || chapterLoading"
            @click="selectRange"
          >
            选取区间
          </button>
        </div>
        <button
          class="btn btn-primary btn-sm"
          :disabled="!selected.size || busy"
          data-download-selected
          @click="download"
        >
          <AppIcon name="download" :size="15" />
          {{ busy ? '处理中…' : '下载已选 ' + selected.size + ' 章' }}
        </button>
      </div>
      <EmptyState v-if="chapterError" title="章节列表未能加载" :description="chapterError" error>
        <button class="btn btn-primary" @click="loadChapters(page)">重试</button>
      </EmptyState>
      <div v-else class="chapter-grid" :aria-busy="chapterLoading">
        <div
          v-for="chapter in chapters"
          :key="chapter.id"
          class="chapter-cell"
          :class="{ selected: selected.has(chapter.id) }"
        >
          <input
            type="checkbox"
            :checked="selected.has(chapter.id)"
            :aria-label="'选择 ' + chapter.title"
            @change="toggle(chapter)"
          />
          <button :title="chapter.title" @click="read(chapter)">
            <span class="chapter-number">{{ String(chapter.index).padStart(2, '0') }}</span>
            <strong>{{ chapter.title }}</strong>
            <small>{{ chapter.pageCount }} 页</small>
          </button>
        </div>
      </div>
      <Paginator
        :page="page"
        :pages="Math.ceil(total / pageSize)"
        :loading="chapterLoading"
        @change="loadChapters"
      />
    </template>
  </div>
</template>
