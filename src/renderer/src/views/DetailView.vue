<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCheckbox, NIcon, NInputNumber, NSpin, NTag, useMessage } from 'naive-ui'
import {
  ArrowBackOutline,
  BookmarkOutline,
  CloudDownloadOutline,
  CheckmarkOutline
} from '@vicons/ionicons5'
import type { ChapterItem, ComicDetail } from '@shared/types'
import type { EnqueuePayload } from '@shared/ipc'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/download'
import ComicCover from '../components/ComicCover.vue'
import EmptyState from '../components/EmptyState.vue'

const app = useAppStore()
const dl = useDownloadStore()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const PAGE_SIZE = 50
const pathWord = computed(() => String(route.params.pathWord || ''))
const detail = ref<ComicDetail | null>(null)
const chapters = ref<ChapterItem[]>([])
const total = ref(0)
const page = ref(1)
const loadingDetail = ref(false)
const loadingChapters = ref(false)
const error = ref('')
const chapterError = ref('')
const selected = ref(new Set<number>())
const rangeStart = ref<number | null>(null)
const rangeEnd = ref<number | null>(null)
const trackAfter = ref(false)
const enqueueing = ref(false)
const subscribing = ref(false)
const briefExpanded = ref(false)
const localState = ref<Record<string, boolean>>({})
const cache = new Map<number, ChapterItem>()
let detailSequence = 0
let chapterSequence = 0
const rows = computed(() =>
  chapters.value.map((chapter, index) => ({
    chapter,
    index: (page.value - 1) * PAGE_SIZE + index + 1
  }))
)
const allPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selected.value.has(row.index))
)
const subscribed = computed(() => app.config?.comics.some((comic) => comic.path === pathWord.value))

async function loadDetail(): Promise<void> {
  const request = ++detailSequence
  const path = pathWord.value
  loadingDetail.value = true
  error.value = ''
  try {
    const result = await window.mkk.comic(path)
    if (request !== detailSequence) return
    if (!result.ok) throw new Error(result.error)
    detail.value = result.data
    try {
      const library = await window.mkk.libraryList()
      if (request !== detailSequence) return
      const comic = library.find(
        (item) => item.meta?.pathWord === path || item.name === result.data.name
      )
      localState.value = Object.fromEntries(
        comic?.chapters.map((chapter) => [chapter.name, chapter.complete !== false]) || []
      )
    } catch {
      /* 站点详情仍可使用 */
    }
  } catch (cause) {
    if (request === detailSequence) error.value = String(cause)
  } finally {
    if (request === detailSequence) loadingDetail.value = false
  }
}
async function loadChapters(next = 1): Promise<void> {
  const request = ++chapterSequence
  loadingChapters.value = true
  chapterError.value = ''
  try {
    const result = await window.mkk.chapters(pathWord.value, next)
    if (request !== chapterSequence) return
    if (!result.ok) throw new Error(result.error)
    chapters.value = result.data.list || []
    total.value = result.data.total || 0
    page.value = Math.floor(result.data.offset / PAGE_SIZE) + 1
    result.data.list.forEach((chapter, index) => cache.set(result.data.offset + index + 1, chapter))
  } catch (cause) {
    if (request === chapterSequence) chapterError.value = String(cause)
  } finally {
    if (request === chapterSequence) loadingChapters.value = false
  }
}
function toggle(index: number): void {
  const next = new Set(selected.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  selected.value = next
}
function togglePage(): void {
  const next = new Set(selected.value)
  const remove = allSelected.value
  rows.value.forEach((row) => (remove ? next.delete(row.index) : next.add(row.index)))
  selected.value = next
}
function selectMissing(): void {
  const next = new Set(selected.value)
  rows.value
    .filter((row) => localState.value[row.chapter.name] !== true)
    .forEach((row) => next.add(row.index))
  selected.value = next
}
function selectRange(): void {
  if (
    !rangeStart.value ||
    !rangeEnd.value ||
    !Number.isInteger(rangeStart.value) ||
    !Number.isInteger(rangeEnd.value)
  ) {
    message.warning('请填写完整的章节范围')
    return
  }
  const first = Math.max(1, Math.min(rangeStart.value, rangeEnd.value))
  const last = Math.min(total.value, Math.max(rangeStart.value, rangeEnd.value))
  const next = new Set(selected.value)
  for (let index = first; index <= last; index++) next.add(index)
  selected.value = next
}
async function subscribe(): Promise<void> {
  if (!detail.value || subscribing.value) return
  subscribing.value = true
  try {
    app.config = await window.mkk.subscribe({
      name: detail.value.name,
      path: pathWord.value
    })
    message.success('已加入追更，可在「追更订阅」管理')
  } catch (cause) {
    message.error('订阅失败：' + String(cause))
  } finally {
    subscribing.value = false
  }
}
async function enqueue(): Promise<void> {
  if (!detail.value || !selected.value.size || enqueueing.value) return
  const path = pathWord.value
  const name = detail.value.name
  const track = trackAfter.value
  const indexes = [...selected.value].sort((a, b) => a - b)
  const byIndex = new Map(cache)
  enqueueing.value = true
  try {
    // 只获取实际勾选且未缓存的页，跨页失败时保留整个选择，避免悄悄漏章。
    const neededPages = [
      ...new Set(
        indexes
          .filter((index) => !byIndex.has(index))
          .map((index) => Math.floor((index - 1) / PAGE_SIZE) + 1)
      )
    ]
    for (const next of neededPages) {
      const result = await window.mkk.chapters(path, next)
      if (!result.ok) throw new Error(`第 ${next} 页章节获取失败：${result.error}`)
      result.data.list.forEach((chapter, offset) =>
        byIndex.set(result.data.offset + offset + 1, chapter)
      )
    }
    const payload: EnqueuePayload[] = indexes.map((index) => {
      const chapter = byIndex.get(index)
      if (!chapter) throw new Error(`未能获取第 ${index} 章，请刷新章节后重试`)
      return {
        comicPath: path,
        comicName: name,
        chapterIndex: index,
        chapterName: chapter.name,
        uuid: chapter.uuid,
        trackSubscription: track
      }
    })
    if (track) app.config = await window.mkk.subscribe({ name, path })
    const created = await window.mkk.enqueue(payload)
    await dl.refresh()
    message.success(
      created.length ? `${created.length} 个章节已加入下载管理` : '所选章节已经在下载队列中'
    )
    if (pathWord.value === path)
      selected.value = new Set([...selected.value].filter((index) => !indexes.includes(index)))
  } catch (cause) {
    message.error('添加失败：' + String(cause))
  } finally {
    enqueueing.value = false
  }
}
watch(
  pathWord,
  () => {
    detail.value = null
    chapters.value = []
    selected.value = new Set()
    cache.clear()
    total.value = 0
    page.value = 1
    localState.value = {}
    rangeStart.value = null
    rangeEnd.value = null
    briefExpanded.value = false
    void loadDetail()
    void loadChapters()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  detailSequence++
  chapterSequence++
})
</script>

<template>
  <div class="page detail-page">
    <div class="content-width">
      <NButton quaternary size="small" class="back-button" @click="router.push('/search')">
        <template #icon><NIcon :component="ArrowBackOutline" /></template>
        返回发现漫画
      </NButton>
      <NSpin :show="loadingDetail">
        <section v-if="detail" class="comic-hero surface">
          <div class="hero-cover">
            <ComicCover :src="app.remoteImg(detail.cover)" :name="detail.name" />
          </div>
          <div class="hero-info">
            <div class="eyebrow">COMIC DETAILS</div>
            <h1>{{ detail.name }}</h1>
            <p v-if="detail.alias" class="comic-alias">{{ detail.alias }}</p>
            <div class="comic-facts">
              <span>{{ total }} 个章节</span>
              <span>更新于 {{ detail.datetime_updated || '未知' }}</span>
              <span v-if="Object.keys(localState).length">
                本地已有 {{ Object.keys(localState).length }} 章
              </span>
            </div>
            <p class="brief" :class="{ clamped: !briefExpanded }">
              {{ detail.brief || '这个故事还没有简介。' }}
            </p>
            <div class="hero-actions">
              <NButton :disabled="subscribed" :loading="subscribing" @click="subscribe">
                <template #icon>
                  <NIcon :component="subscribed ? CheckmarkOutline : BookmarkOutline" />
                </template>
                {{ subscribed ? '已加入追更' : '加入追更' }}
              </NButton>
              <NButton
                v-if="detail.brief"
                quaternary
                size="small"
                @click="briefExpanded = !briefExpanded"
              >
                {{ briefExpanded ? '收起简介' : '展开简介' }}
              </NButton>
            </div>
          </div>
        </section>
        <EmptyState v-else-if="error" title="漫画详情加载失败" :description="error">
          <NButton @click="loadDetail">重试</NButton>
        </EmptyState>
      </NSpin>
      <div class="section-heading">
        <h2>
          章节目录
          <span class="chapter-total">{{ total }} 章</span>
        </h2>
        <span class="selection-hint">跨页勾选会保留，下载后自动跳过已有图片</span>
      </div>
      <div class="chapter-toolbar">
        <div>
          <NButton size="small" :disabled="loadingChapters || !chapters.length" @click="togglePage">
            {{ allSelected ? '取消本页选择' : '选择本页' }}
          </NButton>
          <NButton
            size="small"
            quaternary
            :disabled="loadingChapters || !chapters.length"
            @click="selectMissing"
          >
            选择本页待下载
          </NButton>
        </div>
        <details class="range-picker">
          <summary>按区间选择</summary>
          <div class="range-fields surface">
            <NInputNumber
              v-model:value="rangeStart"
              :min="1"
              :max="total"
              placeholder="起始章"
              size="small"
              aria-label="起始章节"
            />
            <span>至</span>
            <NInputNumber
              v-model:value="rangeEnd"
              :min="1"
              :max="total"
              placeholder="结束章"
              size="small"
              aria-label="结束章节"
            />
            <NButton size="small" @click="selectRange">选择</NButton>
          </div>
        </details>
      </div>
      <NSpin :show="loadingChapters">
        <EmptyState
          v-if="chapterError"
          title="章节列表加载失败"
          :description="chapterError"
          compact
        >
          <NButton @click="loadChapters(page)">重新加载</NButton>
        </EmptyState>
        <div v-else-if="chapters.length" class="chapter-grid">
          <button
            v-for="row in rows"
            :key="row.chapter.uuid"
            type="button"
            role="checkbox"
            :aria-checked="selected.has(row.index)"
            :aria-label="`第 ${row.index} 章 ${row.chapter.name}`"
            :disabled="enqueueing || loadingChapters"
            class="chapter"
            :class="{ picked: selected.has(row.index) }"
            @click="toggle(row.index)"
          >
            <span class="chapter-checkbox">
              <NIcon v-if="selected.has(row.index)" :component="CheckmarkOutline" :size="13" />
            </span>
            <span class="chapter-index">{{ String(row.index).padStart(2, '0') }}</span>
            <span class="chapter-name" :title="row.chapter.name">{{ row.chapter.name }}</span>
            <NTag
              v-if="localState[row.chapter.name] === true"
              size="tiny"
              :bordered="false"
              type="success"
            >
              已下载
            </NTag>
            <NTag
              v-else-if="localState[row.chapter.name] === false"
              size="tiny"
              :bordered="false"
              type="warning"
            >
              缺页
            </NTag>
            <span class="chapter-pages">{{ row.chapter.size }} 页</span>
          </button>
        </div>
        <EmptyState
          v-else-if="!loadingChapters"
          title="暂时没有章节"
          description="可以先加入追更，等待故事更新。"
          compact
        />
      </NSpin>
      <div v-if="allPages > 1" class="pager">
        <NButton
          size="small"
          :disabled="page <= 1 || loadingChapters"
          @click="loadChapters(page - 1)"
        >
          上一页
        </NButton>
        <span>{{ page }} / {{ allPages }}</span>
        <NButton
          size="small"
          :disabled="page >= allPages || loadingChapters"
          @click="loadChapters(page + 1)"
        >
          下一页
        </NButton>
      </div>
      <footer v-if="detail && total" class="selection-bar surface">
        <div>
          <strong>{{ selected.size }}</strong>
          <span>个章节已选</span>
          <NButton
            v-if="selected.size"
            quaternary
            size="tiny"
            :disabled="enqueueing"
            @click="selected = new Set()"
          >
            清空
          </NButton>
        </div>
        <div>
          <NCheckbox v-model:checked="trackAfter" :disabled="enqueueing">同时加入追更</NCheckbox>
          <NButton type="primary" :disabled="!selected.size" :loading="enqueueing" @click="enqueue">
            <template #icon><NIcon :component="CloudDownloadOutline" /></template>
            下载所选章节
          </NButton>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.back-button {
  margin: -8px 0 18px -8px;
}
.comic-hero {
  display: flex;
  align-items: center;
  gap: 30px;
  padding: 28px;
}
.hero-cover {
  width: 152px;
  flex-shrink: 0;
}
.hero-info {
  min-width: 0;
  flex: 1;
}
.hero-info h1 {
  font-size: 25px;
  font-weight: 650;
  margin: 0 0 8px;
  line-height: 1.5;
}
.comic-alias {
  font-size: 11px;
  color: var(--c-text-3);
  margin: 0 0 9px;
}
.comic-facts {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--c-text-3);
}
.brief {
  margin: 14px 0;
  font-size: 12px;
  color: var(--c-text-2);
  line-height: 1.9;
  white-space: pre-wrap;
}
.brief.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.hero-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.chapter-total {
  font-size: 11px;
  font-weight: 400;
  color: var(--c-text-3);
  margin-left: 12px;
}
.selection-hint {
  font-size: 10px;
  color: var(--c-text-3);
}
.chapter-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
}
.chapter-toolbar > div {
  display: flex;
  gap: 7px;
}
.range-picker {
  position: relative;
  color: var(--c-text-2);
  font-size: 11px;
  align-self: center;
}
.range-picker summary {
  cursor: pointer;
}
.range-fields {
  position: absolute;
  right: 0;
  top: 30px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 15px;
  width: 360px;
  box-shadow: 0 8px 24px #0001;
}
.chapter-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px 12px;
}
.chapter {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 13px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: var(--c-surface);
  cursor: pointer;
  text-align: left;
  min-width: 0;
}
.chapter:hover {
  border-color: var(--c-accent-border);
}
.chapter:disabled {
  cursor: default;
  opacity: 0.65;
}
.chapter.picked {
  background: var(--c-selected);
  border-color: var(--c-accent-border);
}
.chapter-checkbox {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1px solid var(--c-border-strong);
  flex-shrink: 0;
}
.picked .chapter-checkbox {
  background: var(--c-accent);
  border-color: var(--c-accent);
  color: var(--c-accent-fg);
}
.chapter-index {
  font-size: 10px;
  color: var(--c-text-3);
  min-width: 19px;
  font-variant-numeric: tabular-nums;
}
.chapter-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.chapter-pages {
  font-size: 10px;
  color: var(--c-text-3);
  white-space: nowrap;
}
.selection-bar {
  position: sticky;
  bottom: -20px;
  z-index: 4;
  margin-top: 24px;
  padding: 16px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-radius: 12px;
  box-shadow: 0 -4px 20px #00000006;
}
.selection-bar > div {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
}
.selection-bar strong {
  font-size: 22px;
  color: var(--c-accent);
}
.selection-bar > div:first-child > span {
  color: var(--c-text-2);
}
@media (max-width: 1050px) {
  .comic-hero {
    gap: 22px;
    padding: 22px;
  }
  .hero-cover {
    width: 125px;
  }
  .selection-hint {
    display: none;
  }
  .chapter {
    padding: 12px 10px;
    gap: 7px;
  }
}
</style>
