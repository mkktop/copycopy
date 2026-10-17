<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  NButton,
  NCheckbox,
  NDivider,
  NEmpty,
  NInputNumber,
  NSpace,
  NSpin,
  NTag,
  NText,
  useMessage,
  useDialog
} from 'naive-ui'
import type { ChapterItem, ChapterListResult, ComicDetail } from '@shared/types'
import type { EnqueuePayload } from '@shared/ipc'
import { useAppStore } from '../stores/app'

const route = useRoute()
const message = useMessage()
const dialog = useDialog()
const app = useAppStore()

const PAGE_SIZE = 50

const detail = ref<ComicDetail | null>(null)
const chapters = ref<ChapterItem[]>([])
const total = ref(0)
const page = ref(1)
const loadingDetail = ref(false)
const loadingChapters = ref(false)
const errorMsg = ref('')

/** 勾选的章节：key 是全局章节序号（1 起） */
const selected = ref<Set<number>>(new Set())
const rangeStart = ref<number | null>(null)
const rangeEnd = ref<number | null>(null)
const trackAfter = ref(false)
const enqueueing = ref(false)
const briefExpanded = ref(false)

const pathWord = computed(() => String(route.params.pathWord ?? ''))
const allPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
/** 本页每个条目对应的全局序号 */
const rows = computed(() =>
  chapters.value.map((c, i) => ({ chapter: c, index: (page.value - 1) * PAGE_SIZE + i + 1 }))
)
const selectedCount = computed(() => selected.value.size)
const pageAllSelected = computed(
  () => rows.value.length > 0 && rows.value.every((r) => selected.value.has(r.index))
)

/**
 * 本地漫画库里这部漫画的章节状态：目录名 -> 是否完整。
 * 应用明明知道 out/ 里下过什么，章节列表却长得一模一样，
 * 只能盲选、然后靠"秒完成"反推。这里直接把状态标出来。
 */
const localState = ref<Record<string, { complete: boolean; pageCount: number }>>({})

async function loadLocalState(): Promise<void> {
  try {
    const list = await window.mkk.libraryList()
    const c = list.find((x) => x.name === (detail.value?.name ?? ''))
    if (!c) {
      localState.value = {}
      return
    }
    const map: Record<string, { complete: boolean; pageCount: number }> = {}
    for (const ch of c.chapters) map[ch.name] = { complete: ch.complete !== false, pageCount: ch.pageCount }
    localState.value = map
  } catch {
    localState.value = {}
  }
}

const downloadedCount = computed(() => Object.keys(localState.value).length)

function stateOf(name: string): 'none' | 'ok' | 'partial' {
  const s = localState.value[name]
  if (!s) return 'none'
  return s.complete ? 'ok' : 'partial'
}

async function loadDetail(): Promise<void> {
  loadingDetail.value = true
  errorMsg.value = ''
  try {
    const res = await window.mkk.comic(pathWord.value)
    if (!res.ok) {
      errorMsg.value = res.error
      detail.value = null
      return
    }
    detail.value = res.data
    void loadLocalState()
  } finally {
    loadingDetail.value = false
  }
}

async function loadChapters(p = 1): Promise<void> {
  loadingChapters.value = true
  try {
    const res = await window.mkk.chapters(pathWord.value, p)
    if (!res.ok) {
      message.error('获取章节列表失败：' + res.error)
      return
    }
    const data: ChapterListResult = res.data
    chapters.value = data.list ?? []
    total.value = data.total ?? 0
    page.value = data.offset / PAGE_SIZE + 1
  } finally {
    loadingChapters.value = false
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
  if (pageAllSelected.value) rows.value.forEach((r) => next.delete(r.index))
  else rows.value.forEach((r) => next.add(r.index))
  selected.value = next
}

function selectRange(): void {
  if (!rangeStart.value || !rangeEnd.value) {
    message.warning('请填写起始与结束章节')
    return
  }
  const a = Math.max(1, Math.min(rangeStart.value, rangeEnd.value))
  const b = Math.min(total.value, Math.max(rangeStart.value, rangeEnd.value))
  const next = new Set(selected.value)
  for (let i = a; i <= b; i++) next.add(i)
  selected.value = next
  message.success(`已选择第 ${a} ~ ${b} 章`)
}

function clearSelection(): void {
  selected.value = new Set()
}

/** 一键选中本地还没有的章节——重追、续下最常用的操作 */
function selectUndownloaded(): void {
  const next = new Set(selected.value)
  let added = 0
  for (const r of rows.value) {
    if (stateOf(r.chapter.name) === 'none') {
      next.add(r.index)
      added++
    }
  }
  selected.value = next
  message.success(added > 0 ? `已选中 ${added} 个未下载的章节` : '本页章节都已经有了')
}

async function enqueue(): Promise<void> {
  if (selected.value.size === 0) {
    message.warning('请先选择章节')
    return
  }
  const indexes = [...selected.value].sort((x, y) => x - y)

  dialog.warning({
    title: '确认下载',
    content: `即将下载 ${indexes.length} 章《${detail.value?.name ?? ''}》，确认加入队列？`,
    positiveText: '加入队列',
    negativeText: '取消',
    onPositiveClick: async () => {
      enqueueing.value = true
      try {
        // 需要跨页取章节信息，逐页补齐 uuid
        const byIndex = new Map<number, ChapterItem>()
        const firstPage = Math.floor((indexes[0] - 1) / PAGE_SIZE) + 1
        const lastPage = Math.floor((indexes[indexes.length - 1] - 1) / PAGE_SIZE) + 1
        for (let p = firstPage; p <= lastPage; p++) {
          const res = await window.mkk.chapters(pathWord.value, p)
          if (!res.ok) continue
          const offset = res.data.offset
          res.data.list.forEach((c, i) => byIndex.set(offset + i + 1, c))
        }

        const payload: EnqueuePayload[] = []
        for (const i of indexes) {
          const c = byIndex.get(i)
          if (!c) continue
          payload.push({
            comicPath: pathWord.value,
            comicName: detail.value?.name ?? '',
            chapterIndex: i,
            chapterName: c.name,
            uuid: c.uuid,
            trackSubscription: trackAfter.value
          })
        }

        if (payload.length === 0) {
          message.error('未能获取到章节信息，请重试')
          return
        }

        if (trackAfter.value) {
          await window.mkk.subscribe(
            { name: detail.value?.name ?? '', path: pathWord.value },
            Math.max(payload.length, 10)
          )
        }

        const created = await window.mkk.enqueue(payload)
        message.success(`已加入队列 ${created.length} 章`)
        selected.value = new Set()
        // 已经下过的章节现在会标出来，刷新一下本地状态
        void loadLocalState()
      } finally {
        enqueueing.value = false
      }
    }
  })
}

async function subscribeOnly(): Promise<void> {
  await window.mkk.subscribe({ name: detail.value?.name ?? '', path: pathWord.value })
  message.success('已加入追更订阅，可在设置页检查更新')
}

watch(pathWord, () => {
  selected.value = new Set()
  void loadDetail()
  void loadChapters(1)
})

onMounted(() => {
  void loadDetail()
  void loadChapters(1)
})
</script>

<template>
  <div class="page">
    <NSpin :show="loadingDetail">
      <div v-if="detail" class="head">
        <div class="head-cover">
          <img v-if="app.remoteImg(detail.cover)" :src="app.remoteImg(detail.cover)!" alt="" />
        </div>
        <div class="head-info">
          <h2 class="page-title" style="margin-bottom: 6px">
            {{ detail.name }}
            <NTag v-if="detail.alias" size="small" :bordered="false" style="margin-left: 8px">
              {{ detail.alias }}
            </NTag>
          </h2>
          <NText depth="3" style="font-size: 12px">
            更新于 {{ detail.datetime_updated }} · 最新章节 {{ detail.last_chapter?.name ?? '未知' }}
            · 共 {{ total }} 章
          </NText>
          <p class="brief" :class="{ clamped: !briefExpanded }" @click="briefExpanded = !briefExpanded">
            {{ detail.brief || '暂无简介' }}
          </p>
          <div class="head-actions">
            <NButton size="small" @click="subscribeOnly">加入追更订阅</NButton>
            <NButton
              size="small"
              quaternary
              :disabled="!detail.brief"
              @click="briefExpanded = !briefExpanded"
            >
              {{ briefExpanded ? '收起简介' : '展开简介' }}
            </NButton>
          </div>
        </div>
      </div>

      <div v-else-if="errorMsg" class="empty">加载失败：{{ errorMsg }}</div>
    </NSpin>

    <NDivider v-if="chapters.length" />

    <div v-if="chapters.length" class="toolbar">
      <NButton size="small" @click="togglePage">
        {{ pageAllSelected ? '取消本页' : '选择本页' }}
      </NButton>
      <NButton size="small" @click="clearSelection">清空选择</NButton>
      <NButton size="small" quaternary @click="selectUndownloaded">
        只选未下载的
      </NButton>
      <NText depth="3" class="meta-text">已选 {{ selectedCount }} 章</NText>
      <NTag v-if="downloadedCount" size="tiny" type="success" :bordered="false">
        本地已有 {{ downloadedCount }} 章
      </NTag>

      <NSpace :size="6" align="center">
        <NInputNumber v-model:value="rangeStart" :min="1" :max="total" size="small" placeholder="起" style="width: 90px" />
        <span>~</span>
        <NInputNumber v-model:value="rangeEnd" :min="1" :max="total" size="small" placeholder="止" style="width: 90px" />
        <NButton size="small" @click="selectRange">选择区间</NButton>
      </NSpace>

      <NSpace :size="8" align="center">
        <NCheckbox v-model:checked="trackAfter">同时加入追更</NCheckbox>
        <NButton type="primary" size="small" :loading="enqueueing" :disabled="selectedCount === 0" @click="enqueue">
          加入下载队列
        </NButton>
      </NSpace>
    </div>

    <NSpin :show="loadingChapters">
      <div v-if="chapters.length" class="chapter-list">
        <div
          v-for="r in rows"
          :key="r.chapter.uuid"
          class="chapter"
          :class="{ picked: selected.has(r.index), owned: stateOf(r.chapter.name) !== 'none' }"
          @click="toggle(r.index)"
        >
          <span class="idx">第 {{ r.index }} 章</span>
          <span class="name" :title="r.chapter.name">{{ r.chapter.name }}</span>
          <NTag v-if="stateOf(r.chapter.name) === 'ok'" size="tiny" type="success" :bordered="false">
            已下载
          </NTag>
          <NTag v-else-if="stateOf(r.chapter.name) === 'partial'" size="tiny" type="warning" :bordered="false">
            缺页
          </NTag>
          <NText depth="3" style="font-size: 12px; min-width: 46px; text-align: right">
            {{ r.chapter.size }} P
          </NText>
        </div>
      </div>
      <NEmpty v-else-if="!loadingChapters" description="没有章节信息" class="empty" />
    </NSpin>

    <div v-if="allPages > 1" class="pager">
      <NButton :disabled="page <= 1" size="small" @click="loadChapters(page - 1)">上一页</NButton>
      <span>{{ page }} / {{ allPages }}</span>
      <NButton :disabled="page >= allPages" size="small" @click="loadChapters(page + 1)">
        下一页
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  gap: 18px;
}

.head-cover {
  width: 150px;
  flex: 0 0 150px;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  overflow: hidden;
  background: var(--c-placeholder);
}

.head-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.head-info {
  flex: 1;
  min-width: 0;
}

.brief {
  color: var(--c-text-2);
  font-size: 13px;
  line-height: 1.7;
  margin: 10px 0;
  cursor: pointer;
}
/* 折叠态用 -webkit-line-clamp，不要 max-height+滚动：
   内嵌滚动条会把下面的工具条挤得很难看 */
.brief.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.meta-text {
  font-size: 13px;
  color: var(--c-text-2);
}

.chapter-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chapter {
  display: grid;
  grid-template-columns: 80px 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--c-elevated);
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 13px;
}
.chapter.owned {
  background: var(--c-selected);
}

.chapter:hover {
  background: var(--c-elevated-hover);
}

.chapter.picked {
  border-color: var(--c-accent);
  background: var(--c-selected);
}

.idx {
  color: var(--c-text-3);
  font-variant-numeric: tabular-nums;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pager {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;
  margin-top: 18px;
  font-size: 13px;
  color: var(--c-text-2);
}
</style>
