<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton,
  NSkeleton,
  NSpace,
  NSelect,
  NTag,
  NText,
  NIcon,
  useMessage
} from 'naive-ui'
import { SearchOutline, CloseOutline } from '@vicons/ionicons5'
import type { AppConfig, LibraryComic, SearchComicItem } from '@shared/types'
import { useDownloadStore } from '../stores/download'
import { useAppStore } from '../stores/app'

const router = useRouter()
const message = useMessage()
const dl = useDownloadStore()
const app = useAppStore()

const RECENT_KEY = 'copycopy.recentSearch'

const HOT_WORDS = ['海贼王', '电锯人', '鬼灭之刃', '咒术回战', '我独自升级', '葬送的芙莉莲']
const SKELETON_COUNT = 10
/** 与后端搜索接口页大小保持一致 */
const PAGE_SIZE = 24
/** 搜索页最多铺多少张封面卡片 */
const SHELF_LIMIT = 12
/** 进页面时顺手补封面的部数上限，每部要打 3 次站点接口 */
const COVER_SYNC_LIMIT = 6

const keyword = ref('')
const loading = ref(false)
const items = ref<SearchComicItem[]>([])
const searched = ref(false)
const page = ref(1)
const total = ref(0)
const recent = ref<string[]>([])
/** 已在本地漫画库里的漫画名，用于卡片上打标 */
const downloaded = ref<Record<string, number>>({})

/** 搜索维度：'' 全部 / name 只看漫画名 / author 只看作者 */
const searchType = ref<string>('')
const searchTypeOptions = [
  { label: '全部', value: '' },
  { label: '按名称', value: 'name' },
  { label: '按作者', value: 'author' }
]

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const showSkeleton = computed(() => loading.value && !searched.value)
const showEmpty = computed(() => searched.value && !loading.value && items.value.length === 0)

// ---- 未搜索时的看板：拿自己的数据填这块地方，比塞陌生推荐有用 ----
const lib = ref<LibraryComic[]>([])
const subs = ref<AppConfig['comics']>([])
const checking = ref(false)

const activeTasks = computed(
  () => dl.tasks.filter((t) => t.status === 'running' || t.status === 'pending')
)
/** 本地库和订阅都为空，说明是刚上手 */
const isFresh = computed(() => lib.value.length === 0 && subs.value.length === 0)

/** 封面直接给 <img> 用 library://，不再走 base64 */
const shelf = computed(() =>
  lib.value.slice(0, SHELF_LIMIT).map((c) => ({
    comic: c,
    cover: app.imgUrl(c.cover)
  }))
)

/**
 * 刷新看板。
 * 之前这里和 loadDownloaded 各自调了一次全量 libraryList()，又对最多 6 部漫画
 * 串行补封面（每部 3 次站点请求）并且等它们全跑完才渲染首屏。
 */
async function refreshBoard(): Promise<void> {
  const list = await window.mkk.libraryList()
  subs.value = (await window.mkk.getConfig()).comics

  const map: Record<string, number> = {}
  for (const c of list) map[c.name] = c.chapters.length
  downloaded.value = map
  lib.value = list

  // 老版本下载的漫画没有 cover.jpg，后台静默补齐，不阻塞首屏
  const missing = list.filter((c) => !c.cover).slice(0, COVER_SYNC_LIMIT)
  if (missing.length > 0) {
    void (async () => {
      for (const c of missing) {
        try {
          await window.mkk.syncCover(c.name)
        } catch {
          /* 单本失败不影响其它 */
        }
      }
      // 补完再刷新一次，卡片才有封面
      try {
        const fresh = await window.mkk.libraryList()
        for (const c of fresh) downloaded.value[c.name] ??= c.chapters.length
        lib.value = fresh
      } catch {
        /* 忽略 */
      }
    })()
  }
}

async function checkUpdates(): Promise<void> {
  checking.value = true
  try {
    const res = await window.mkk.checkUpdates()
    subs.value = (await window.mkk.getConfig()).comics
    if (res.queued > 0) message.success(`发现 ${res.queued} 章更新，已加入下载队列`)
    else message.info('检查完成，暂无更新')
  } finally {
    checking.value = false
  }
}

function openLibrary(comicName: string): void {
  router.push('/library/' + encodeURIComponent(comicName))
}

function loadRecent(): void {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    recent.value = raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    recent.value = []
  }
}

function pushRecent(kw: string): void {
  const next = [kw, ...recent.value.filter((r) => r !== kw)].slice(0, 8)
  recent.value = next
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
}

function removeRecent(kw: string): void {
  recent.value = recent.value.filter((r) => r !== kw)
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
}

/**
 * 请求序号：连续翻页时慢的旧响应可能后到，会把新结果覆盖掉。
 * 只有序号仍是最新的一次才允许写状态。
 */
let searchSeq = 0

async function doSearch(next = 1): Promise<void> {
  const kw = keyword.value.trim()
  if (!kw) {
    message.warning('请输入搜索关键词')
    return
  }
  const seq = ++searchSeq
  loading.value = true
  try {
    const res = await window.mkk.search(kw, next, searchType.value)
    if (seq !== searchSeq) return
    if (!res.ok) {
      message.error('搜索失败：' + res.error)
      return
    }
    page.value = next
    total.value = res.data?.total ?? 0
    items.value = res.data?.list ?? []
    searched.value = true
    if (next === 1) pushRecent(kw)
  } finally {
    if (seq === searchSeq) loading.value = false
  }
}

/** 换个搜索维度要从第一页重来 */
function onSearchTypeChange(): void {
  if (searched.value) void doSearch(1)
}

function useWord(w: string): void {
  keyword.value = w
  void doSearch(1)
}

/** 从结果回到看板（清掉结果、保留最近搜索和推荐词） */
function backToBoard(): void {
  searched.value = false
  items.value = []
  total.value = 0
}

function open(item: SearchComicItem): void {
  router.push('/comic/' + encodeURIComponent(item.path_word))
}

onMounted(() => {
  loadRecent()
  void refreshBoard()
})
</script>

<template>
  <div class="page search-page">
    <!--
      搜索前：完整引导区（标题 + 副标题 + 输入 + 推荐词 + 看板）
      搜索后：压缩成一条贴着顶部的输入栏
      之前 hero 是无条件渲染的，搜完还得往上滚一屏才够得着搜索框。
    -->
    <section class="hero" :class="{ compact: searched }">
      <template v-if="!searched">
        <h1 class="hero-title">CopyCopy</h1>
        <p class="hero-sub">搜索、下载、离线阅读你的漫画</p>
      </template>

      <div class="search-row">
        <NButton
          type="primary"
          size="large"
          circle
          class="search-btn"
          :loading="loading"
          @click="doSearch(1)"
        >
          <template #icon>
            <n-icon :component="SearchOutline" />
          </template>
        </NButton>
        <input
          v-model="keyword"
          class="search-input"
          :placeholder="searched ? '换个关键词继续搜' : '输入漫画名或作者，例如：海贼王'"
          spellcheck="false"
          @keyup.enter="doSearch(1)"
        />
        <NSelect
          v-model:value="searchType"
          :options="searchTypeOptions"
          size="large"
          class="search-type"
          :consistent-menu-width="false"
          @update:value="onSearchTypeChange"
        />
        <NButton
          v-if="searched"
          size="large"
          quaternary
          class="back-btn"
          @click="backToBoard"
        >
          返回看板
        </NButton>
      </div>

      <div v-if="!searched" class="chips">
        <template v-if="recent.length">
          <span class="chips-label">最近搜索</span>
          <span v-for="r in recent" :key="r" class="chip" @click="useWord(r)">
            {{ r }}
            <i class="chip-x" @click.stop="removeRecent(r)">
              <n-icon :component="CloseOutline" :size="11" />
            </i>
          </span>
        </template>
        <template v-if="!searched">
          <span class="chips-label">试试这些</span>
          <span v-for="w in HOT_WORDS" :key="w" class="chip hot" @click="useWord(w)">
            {{ w }}
          </span>
        </template>
      </div>
    </section>

    <!-- ============ 未搜索：个人看板 ============ -->
    <div v-if="!searched" class="board">
      <!-- 正在下载 -->
      <section v-if="activeTasks.length" class="panel">
        <div class="panel-head">
          <span class="panel-title">正在下载</span>
          <span class="panel-sub">{{ activeTasks.length }} 个任务</span>
        </div>
        <div class="task-strip">
          <div v-for="t in activeTasks.slice(0, 6)" :key="t.id" class="task-chip">
            <span class="task-name">{{ t.comicName }} · {{ t.chapterName }}</span>
            <span class="task-meta">
              {{ t.downloaded + t.skipped }}/{{ t.total || '?' }} 页
              <template v-if="t.status === 'pending'">（排队中）</template>
            </span>
          </div>
        </div>
      </section>

      <!-- 继续下载 -->
      <section v-if="lib.length" class="panel">
        <div class="panel-head">
          <span class="panel-title">继续下载</span>
          <span class="panel-sub">本地共 {{ lib.length }} 部</span>
          <span class="panel-more" @click="router.push('/library')">全部 ›</span>
        </div>
        <div class="shelf">
          <div
            v-for="item in shelf"
            :key="item.comic.name"
            class="shelf-item"
            @click="openLibrary(item.comic.name)"
          >
            <div class="shelf-cover">
              <img v-if="item.cover" :src="item.cover" :alt="item.comic.name" />
              <div v-else class="ph">{{ item.comic.name.slice(0, 2) }}</div>
            </div>
            <div class="shelf-name" :title="item.comic.name">{{ item.comic.name }}</div>
            <div class="shelf-meta">
              {{ item.comic.chapters.length }} 章 · {{ item.comic.totalPages }} 页
            </div>
          </div>
        </div>
      </section>

      <!-- 追更订阅 -->
      <section v-if="subs.length" class="panel">
        <div class="panel-head">
          <span class="panel-title">追更订阅</span>
          <NButton size="tiny" :loading="checking" @click="checkUpdates">检查更新</NButton>
        </div>
        <div class="sub-list">
          <div v-for="s in subs" :key="s.path" class="sub-row" @click="openLibrary(s.name)">
            <div class="sub-main">
              <div class="sub-name">{{ s.name }}</div>
              <div class="sub-meta">
                已下载至第 {{ s.last_chapter }} 章 · 单次最多 {{ s.download_limit }} 章 ·
                上次检查 {{ s.last_check_time || '从未' }}
              </div>
            </div>
            <span class="sub-go">›</span>
          </div>
        </div>
      </section>

      <!-- 新手引导 -->
      <section v-if="isFresh" class="panel guide">
        <div class="panel-head"><span class="panel-title">快速上手</span></div>
        <div class="guide-steps">
          <div class="guide-step">
            <span class="step-no">1</span>
            <div>
              <div class="step-title">搜索漫画</div>
              <div class="step-sub">在上方输入名字，或点「试试这些」里的推荐</div>
            </div>
          </div>
          <div class="guide-step">
            <span class="step-no">2</span>
            <div>
              <div class="step-title">勾选章节加入队列</div>
              <div class="step-sub">在详情页支持单选、区间选、整页全选</div>
            </div>
          </div>
          <div class="guide-step">
            <span class="step-no">3</span>
            <div>
              <div class="step-title">离线保存</div>
              <div class="step-sub">图片存到本地，还能一键合并成加密 PDF</div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 结果统计 -->
    <div v-if="searched && !showEmpty" class="result-bar">
      <NText depth="3" style="font-size: 12px">
        「{{ keyword }}」共找到 <b>{{ total }}</b> 条 · 第 {{ page }} / {{ totalPages }} 页
      </NText>
    </div>

    <!-- 结果网格 -->
    <div v-if="showSkeleton" class="grid">
      <div v-for="i in SKELETON_COUNT" :key="i" class="skeleton-card">
        <NSkeleton height="200px" :sharp="false" />
        <div class="skeleton-meta">
          <NSkeleton text :repeat="2" style="width: 80%" />
          <NSkeleton text :repeat="1" style="width: 50%" />
        </div>
      </div>
    </div>

    <div v-else-if="items.length" class="grid" :class="{ dim: loading }">
      <div v-for="c in items" :key="c.path_word" class="card" @click="open(c)">
        <div class="cover-wrap">
          <img v-if="app.remoteImg(c.cover)" :src="app.remoteImg(c.cover)!" class="cover" :alt="c.name" loading="lazy" />
          <div v-else class="cover placeholder">无封面</div>
          <div class="cover-mask">
            <span class="mask-name">{{ c.name }}</span>
          </div>
          <span v-if="downloaded[c.name]" class="badge">已下载 {{ downloaded[c.name] }} 章</span>
        </div>
        <div class="meta">
          <div class="title" :title="c.name">{{ c.name }}</div>
          <div class="author" :title="c.author.map((a) => a.name).join(' / ')">
            {{ c.author.map((a) => a.name).join(' / ') || '未知作者' }}
          </div>
          <NTag v-if="c.alias" size="tiny" :bordered="false" class="alias">
            {{ c.alias }}
          </NTag>
        </div>
      </div>
    </div>

    <div v-else-if="showEmpty" class="empty-box">
      <div class="empty-title">没有找到「{{ keyword }}」</div>
      <div class="empty-sub">换个关键词试试，或从上面的热门推荐里选一个</div>
    </div>

    <!-- 分页 -->
    <div v-if="items.length && totalPages > 1" class="pager">
      <NButton :disabled="page <= 1" size="small" :loading="loading" @click="doSearch(page - 1)">
        上一页
      </NButton>
      <span>{{ page }} / {{ totalPages }}</span>
      <NButton
        :disabled="page >= totalPages"
        size="small"
        :loading="loading"
        @click="doSearch(page + 1)"
      >
        下一页
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.search-page {
  padding-top: 0;
}

/* ---------- 引导区 ---------- */
.hero {
  margin: 0 -22px 20px;
  padding: 40px 22px 28px;
  background:
    radial-gradient(900px 300px at 20% -40%, var(--c-hero-a), transparent 70%),
    radial-gradient(700px 260px at 80% -30%, var(--c-hero-b), transparent 70%),
    var(--c-surface);
  border-bottom: 1px solid var(--c-border);
  transition: padding 0.2s ease, background 0.2s ease;
}

/* 搜完之后收成一条贴着顶部的输入栏，把首屏还给结果 */
.hero.compact {
  padding: 12px 22px;
  margin-bottom: 14px;
  background: var(--c-surface);
}
.hero.compact .search-btn {
  width: 34px;
  height: 34px;
}
.hero.compact .search-row {
  max-width: 860px;
}

.back-btn {
  flex: 0 0 auto;
  margin-left: 4px;
}

.hero-title {
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 1px;
  background: linear-gradient(92deg, var(--c-accent), var(--c-accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.hero-sub {
  margin: 6px 0 20px;
  color: var(--c-text-2);
  font-size: 13px;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 0;
  max-width: 560px;
  background: var(--c-elevated);
  border: 1px solid var(--c-border-strong);
  border-radius: 999px;
  padding: 5px 5px 5px 8px;
  transition: border-color 0.15s ease;
}

.search-row:focus-within {
  border-color: var(--c-accent);
}

.search-btn {
  flex: 0 0 auto;
}

.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--c-text-1);
  font-size: 14px;
  padding: 0 12px;
  font-family: inherit;
}

.search-input::placeholder {
  color: var(--c-text-4);
}

.search-type {
  flex: 0 0 auto;
  width: 104px;
  margin: 4px 4px 4px 6px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-top: 16px;
  max-width: 640px;
}

.chips-label {
  font-size: 11px;
  color: var(--c-text-4);
  margin-right: 2px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 11px;
  font-size: 12px;
  color: var(--c-text-2);
  background: var(--c-elevated);
  border: 1px solid var(--c-border-strong);
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.chip:hover {
  color: var(--c-accent);
  border-color: var(--c-accent-border);
  background: var(--c-accent-soft);
}

.chip.hot:hover {
  color: var(--c-accent-2);
  border-color: var(--c-accent-2-border);
  background: var(--c-accent-2-soft);
}

.chip-x {
  display: inline-flex;
  opacity: 0.5;
  font-style: normal;
}

.chip-x:hover {
  opacity: 1;
  color: var(--c-danger);
}

/* ---------- 结果 ---------- */
.result-bar {
  margin-bottom: 12px;
}

.result-bar b {
  color: var(--c-accent);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 18px;
  transition: opacity 0.15s ease;
}

.grid.dim {
  opacity: 0.45;
}

.card {
  cursor: pointer;
  transition: transform 0.16s ease;
}

.card:hover {
  transform: translateY(-4px);
}

.cover-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  overflow: hidden;
  background: var(--c-placeholder);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
}

.card:hover .cover-wrap {
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.55);
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
  font-size: 12px;
}

.cover-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  padding: 10px;
  background: linear-gradient(to top, var(--c-mask), transparent 55%);
  opacity: 0;
  transition: opacity 0.16s ease;
}

.card:hover .cover-mask {
  opacity: 1;
}

.mask-name {
  color: var(--c-accent-on);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.badge {
  position: absolute;
  top: 7px;
  left: 7px;
  padding: 2px 7px;
  font-size: 10px;
  color: var(--c-accent-fg);
  background: var(--c-accent);
  border-radius: 4px;
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
}

.alias {
  max-width: 100%;
  display: inline-flex;
}

.alias :deep(.n-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta :deep(.n-tag) {
  max-width: 100%;
}

.author {
  margin: 3px 0 4px;
  font-size: 11px;
  color: var(--c-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 骨架屏 ---------- */
.skeleton-meta {
  margin-top: 9px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ---------- 分页 ---------- */
.pager {
  display: flex;
  gap: 14px;
  align-items: center;
  justify-content: center;
  margin-top: 24px;
  font-size: 13px;
  color: var(--c-text-2);
}
</style>

<style scoped>
.empty-box {
  text-align: center;
  padding: 64px 0;
}

.empty-title {
  font-size: 14px;
  color: var(--c-text-2);
}

.empty-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-text-4);
}
</style>

<style scoped>
/* ============ 未搜索时的看板 ============ */
.board {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
}

.panel-sub {
  font-size: 12px;
  color: var(--c-text-3);
}

.panel-more {
  margin-left: auto;
  font-size: 12px;
  color: var(--c-accent);
  cursor: pointer;
}

.panel-more:hover {
  text-decoration: underline;
}

/* 正在下载 */
.task-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.task-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  background: var(--c-elevated);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 12px;
}

.task-name {
  color: var(--c-text-1);
  font-weight: 500;
}

.task-meta {
  color: var(--c-accent);
  font-size: 11px;
}

/* 继续下载 */
.shelf {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 14px;
}

.shelf-item {
  cursor: pointer;
  transition: transform 0.16s ease;
}

.shelf-item:hover {
  transform: translateY(-3px);
}

.shelf-cover {
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 6px;
  overflow: hidden;
  background: var(--c-placeholder);
}

.shelf-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.shelf-cover .ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-4);
  font-size: 20px;
  font-weight: 600;
}

.shelf-name {
  margin-top: 6px;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shelf-meta {
  font-size: 11px;
  color: var(--c-text-3);
  margin-top: 2px;
}

/* 追更订阅 */
.sub-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sub-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--c-elevated);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.sub-row:hover {
  background: var(--c-elevated-hover);
}

.sub-main {
  flex: 1;
  min-width: 0;
}

.sub-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 3px;
}

.sub-meta {
  font-size: 11px;
  color: var(--c-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub-go {
  color: var(--c-text-4);
  font-size: 16px;
}

/* 新手引导 */
.guide-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.guide-step {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px;
  background: var(--c-elevated);
  border: 1px solid var(--c-border);
  border-radius: 8px;
}

.step-no {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--c-accent), var(--c-accent-2));
  color: var(--c-title-fg);
  font-size: 12px;
  font-weight: 700;
}

.step-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 3px;
}

.step-sub {
  font-size: 11px;
  color: var(--c-text-3);
  line-height: 1.6;
}
</style>
