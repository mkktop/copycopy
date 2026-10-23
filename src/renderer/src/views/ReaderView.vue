<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  darkTheme,
  NConfigProvider,
  NButton,
  NIcon,
  NSelect,
  NSpace,
  NTag,
  NText,
  useMessage
} from 'naive-ui'
import {
  ChevronBackOutline,
  ChevronForwardOutline,
  ChevronUpOutline,
  ChevronDownOutline,
  CloseOutline
} from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import type { LibraryChapter, LibraryComic } from '@shared/types'

/**
 * 阅读器。
 *
 * 数据链路：libraryList 找到漫画和章 -> chapterFiles 拿该章所有页 ->
 * 每页渲染成 app.imgUrl(file) 的 library:// 地址。
 * 一次只挂载当前页前后各一页，其余等翻到了再挂，翻长章节也不会卡。
 */

const route = useRoute()
const router = useRouter()
const message = useMessage()
const app = useAppStore()

const comicName = computed(() => String(route.params.name ?? ''))
const chapterName = computed(() => String(route.params.chapter ?? ''))

const comic = ref<LibraryComic | null>(null)
const chapter = ref<LibraryChapter | null>(null)
const files = ref<string[]>([])
const page = ref(1)
const loading = ref(false)
/**
 * 工具条初始必须可见。
 * 之前初值是 false，只在 mousemove 时才显示——新用户打开阅读器
 * 看到的就是一张光秃秃的图，根本不知道可以翻页。
 */
const showBar = ref(true)

/** 适应方式：宽度优先 / 高度优先 / 原始大小 */
type Fit = 'width' | 'height' | 'actual'
const fit = ref<Fit>('width')
const zoom = ref(1)

const READ_KEY = 'copycopy.readPos'

/** 只挂载当前页附近，避免长章节一次创建上千个 img */
const WINDOW = 1
const visible = computed(() => {
  const out: Array<{ file: string; index: number }> = []
  for (let i = page.value - WINDOW; i <= page.value + WINDOW; i++) {
    const f = files.value[i - 1]
    if (f) out.push({ file: f, index: i })
  }
  return out
})

const src = (file: string): string | null => app.imgUrl(file)

const fitOptions = [
  { label: '适应宽度', value: 'width' },
  { label: '适应高度', value: 'height' },
  { label: '原始大小', value: 'actual' }
]

/* ---------- 位置记忆 ---------- */

function posKey(): string {
  return `${READ_KEY}:${comicName.value}:${chapterName.value}`
}

function savePos(): void {
  try {
    localStorage.setItem(posKey(), String(page.value))
  } catch {
    /* 无痕模式下写不了，忽略 */
  }
}

function loadPos(): number {
  try {
    const raw = localStorage.getItem(posKey())
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 ? n : 1
  } catch {
    return 1
  }
}

/* ---------- 加载 ---------- */

let loadSequence = 0
async function load(): Promise<void> {
  const request = ++loadSequence
  const name = comicName.value
  const chapterTitle = chapterName.value
  loading.value = true
  page.value = 1
  files.value = []
  try {
    const list = await window.mkk.libraryList()
    if (request !== loadSequence) return
    const c = list.find((x) => x.name === name) ?? null
    comic.value = c
    chapter.value = c?.chapters.find((x) => x.name === chapterTitle) ?? null
    if (!c || !chapter.value) return

    const fs = await window.mkk.chapterFiles(chapter.value.dir)
    if (request !== loadSequence) return
    files.value = fs
    page.value = Math.min(loadPos(), Math.max(1, fs.length))
    try {
      localStorage.setItem('copycopy.lastChapter:' + name, chapterTitle)
    } catch {
      /* 阅读不依赖位置写入 */
    }
  } catch (cause) {
    if (request === loadSequence) message.error('章节加载失败：' + String(cause))
  } finally {
    if (request === loadSequence) loading.value = false
  }
}

function go(delta: number): void {
  const next = page.value + delta
  if (next < 1 || next > files.value.length) return
  page.value = next
  savePos()
}

function goto(n: number): void {
  if (!files.value.length) return
  const next = Math.min(Math.max(1, Math.trunc(n)), files.value.length)
  if (next === page.value) return
  page.value = next
  savePos()
}

/* ---------- 快捷键 ---------- */

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    hideBar()
    void router.push('/library/' + encodeURIComponent(comicName.value))
    return
  }
  if (
    (e.target instanceof Element &&
      e.target.closest(
        'input,textarea,button,select,[contenteditable="true"],[role="combobox"]'
      )) ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey
  )
    return
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case ' ':
    case 'PageDown':
    case 'j':
      e.preventDefault()
      go(1)
      break
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'k':
      e.preventDefault()
      go(-1)
      break
    case 'Home':
      e.preventDefault()
      goto(1)
      break
    case 'End':
      e.preventDefault()
      goto(files.value.length)
      break
    case 'n':
    case 'N':
      e.preventDefault()
      goChapter(nextChapter.value)
      break
    case 'p':
    case 'P':
      e.preventDefault()
      goChapter(prevChapter.value)
      break
    case '+':
    case '=':
      zoom.value = Math.min(3, zoom.value + 0.15)
      break
    case '-':
      zoom.value = Math.max(0.3, zoom.value - 0.15)
      break
    case '0':
      zoom.value = 1
      break
  }
}

/** 点左右半屏翻页 */
function onStageClick(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  go(e.clientX - rect.left < rect.width / 2 ? -1 : 1)
}

let barTimer: ReturnType<typeof setTimeout> | null = null
/** 工具条打开后停留多久再自动收起 */
const BAR_LINGER_MS = 3000

function pokeBar(): void {
  showBar.value = true
  if (barTimer) clearTimeout(barTimer)
  barTimer = setTimeout(() => {
    const focus = document.activeElement
    if (focus instanceof Element && focus.closest('.reader .bar, .reader .foot')) return
    showBar.value = false
  }, BAR_LINGER_MS)
}

function hideBar(): void {
  if (barTimer) clearTimeout(barTimer)
  showBar.value = false
}

/* ---------- 章节切换 ---------- */

const prevChapter = computed<LibraryChapter | null>(() => {
  const list = comic.value?.chapters ?? []
  const i = list.findIndex((c) => c.name === chapterName.value)
  return i > 0 ? list[i - 1] : null
})

const nextChapter = computed<LibraryChapter | null>(() => {
  const list = comic.value?.chapters ?? []
  const i = list.findIndex((c) => c.name === chapterName.value)
  return i >= 0 && i < list.length - 1 ? list[i + 1] : null
})

function goChapter(target: LibraryChapter | null): void {
  if (!target) return
  router.push(`/library/${encodeURIComponent(comicName.value)}/${encodeURIComponent(target.name)}`)
}

/** 翻页后预热后面的图，滚过去时是秒开 */
function prefetch(around: number): void {
  for (let i = around + 1; i <= around + 3 && i <= files.value.length; i++) {
    const u = src(files.value[i - 1])
    if (!u) continue
    const img = new Image()
    img.src = u
  }
}

watch(page, (p) => {
  prefetch(p)
  document.querySelector('.stage')?.scrollTo({ top: 0, left: 0 })
})
watch(
  [comicName, chapterName],
  () => {
    void load()
    pokeBar()
  },
  { immediate: true }
)

onMounted(() => {
  window.addEventListener('keydown', onKey)
  // 打开时先把工具条亮 3 秒，让人看清有哪些操作，之后自动收起
  pokeBar()
})

onBeforeUnmount(() => {
  loadSequence++
  window.removeEventListener('keydown', onKey)
  if (barTimer) clearTimeout(barTimer)
})
</script>

<template>
  <NConfigProvider
    :theme="darkTheme"
    :theme-overrides="{
      common: {
        textColor1: '#e7e9f4',
        textColor2: '#b0b6cc',
        textColor3: '#9099b2',
        primaryColor: '#aba0ff',
        borderColor: '#343848'
      }
    }"
  >
    <div class="reader" @mousemove="pokeBar" @click="pokeBar">
      <!-- 工具条 -->
      <div class="bar" :class="{ hidden: !showBar }">
        <NSpace align="center" :size="10">
          <NButton
            quaternary
            size="small"
            @click.stop="router.push('/library/' + encodeURIComponent(comicName))"
          >
            <template #icon><n-icon :component="CloseOutline" /></template>
            返回
          </NButton>
          <NButton
            size="small"
            quaternary
            :disabled="!prevChapter"
            @click.stop="goChapter(prevChapter)"
          >
            <template #icon><n-icon :component="ChevronBackOutline" /></template>
            上一章
          </NButton>
          <NText depth="2" class="title-text">
            {{ comic?.name ?? comicName }} · {{ chapter?.name ?? chapterName }}
          </NText>
          <NButton
            size="small"
            quaternary
            :disabled="!nextChapter"
            @click.stop="goChapter(nextChapter)"
          >
            下一章
            <template #icon><n-icon :component="ChevronForwardOutline" /></template>
          </NButton>
          <NTag v-if="chapter?.complete === false" size="tiny" type="warning" :bordered="false">
            本章有缺页
          </NTag>
        </NSpace>

        <NSpace align="center" :size="10">
          <NButton size="tiny" quaternary :disabled="page <= 1" @click.stop="go(-1)">
            <template #icon><n-icon :component="ChevronUpOutline" /></template>
          </NButton>
          <NText depth="2" style="font-size: 12px; min-width: 78px; text-align: center">
            {{ page }} / {{ files.length || '?' }}
          </NText>
          <NButton size="tiny" quaternary :disabled="page >= files.length" @click.stop="go(1)">
            <template #icon><n-icon :component="ChevronDownOutline" /></template>
          </NButton>

          <NSelect
            v-model:value="fit"
            :options="fitOptions"
            size="tiny"
            style="width: 96px"
            @update:value="zoom = 1"
          />
          <NButton size="tiny" quaternary @click.stop="zoom = Math.max(0.3, zoom - 0.15)">
            −
          </NButton>
          <NText depth="3" style="font-size: 11px; min-width: 38px; text-align: center">
            {{ Math.round(zoom * 100) }}%
          </NText>
          <NButton size="tiny" quaternary @click.stop="zoom = Math.min(3, zoom + 0.15)">+</NButton>
        </NSpace>
      </div>

      <!-- 正文 -->
      <div class="stage" :class="fit" :style="{ '--zoom': zoom }" @click="onStageClick">
        <div v-if="loading" class="hint">加载中…</div>
        <div v-else-if="!files.length" class="hint">
          {{ chapter ? '这一章还没有图片' : '找不到该章节' }}
          <NButton size="tiny" quaternary style="margin-left: 8px" @click.stop="load">重试</NButton>
        </div>
        <template v-else>
          <img
            v-for="v in visible"
            :key="v.index"
            :src="src(v.file) ?? ''"
            :class="{ 'is-current': v.index === page }"
            :style="
              v.index === page
                ? undefined
                : { position: 'absolute', opacity: 0, pointerEvents: 'none' }
            "
            alt=""
            draggable="false"
          />
        </template>
      </div>

      <!-- 底部页码条 -->
      <div class="foot" :class="{ hidden: !showBar }" @click.stop>
        <input
          class="slider"
          type="range"
          aria-label="阅读页码"
          min="1"
          :max="Math.max(1, files.length)"
          :value="page"
          @input="goto(Number(($event.target as HTMLInputElement).value))"
        />
        <div class="foot-row">
          <NButton size="tiny" quaternary @click.stop="go(-1)" :disabled="page <= 1">
            <template #icon><n-icon :component="ChevronBackOutline" /></template>
          </NButton>
          <NText depth="3" style="font-size: 11px">
            ← → 翻页 · 空格 下一页 · N/P 换章 · +/- 缩放 · Esc 返回
          </NText>
          <NButton size="tiny" quaternary @click.stop="go(1)" :disabled="page >= files.length">
            <template #icon><n-icon :component="ChevronForwardOutline" /></template>
          </NButton>
        </div>
      </div>
    </div>
  </NConfigProvider>
</template>

<style scoped>
.reader {
  color-scheme: dark;
  --c-border: #343848;
  --c-text-3: #a4abc2;
  position: fixed;
  inset: 0;
  background: var(--c-sunken);
  z-index: 10;
  display: flex;
  flex-direction: column;
  user-select: none;
}

.bar,
.foot {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 2;
  background: var(--c-reader-bar);
  backdrop-filter: blur(8px);
  transition: opacity 0.2s ease;
  padding: 10px 16px;
}
.bar {
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
  flex-wrap: wrap;
  gap: 12px;
}
.foot {
  bottom: 0;
  border-top: 1px solid var(--c-border);
}
.bar.hidden,
.foot.hidden {
  opacity: 0;
  pointer-events: none;
}

.stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 52px 0;
}

/* 适应宽度：撑满宽度，长图可上下滚动 */
.stage.width {
  overflow-x: hidden;
  overflow-y: auto;
  align-items: flex-start;
}
.stage.width img {
  max-width: 100%;
  width: auto;
  height: auto;
  transform-origin: top center;
}

/* 适应高度：一屏刚好一页，不滚动 */
.stage.height {
  overflow: hidden;
}
.stage.height img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
}

/* 原始大小：两个方向都可滚 */
.stage.actual {
  overflow: auto;
  align-items: flex-start;
}
.stage.actual img {
  max-width: none;
  max-height: none;
}

img {
  display: block;
  transform: scale(var(--zoom));
  transform-origin: center center;
  transition: opacity 0.12s ease;
}
img.is-current {
  position: relative;
}

.hint {
  color: var(--c-text-3);
  font-size: 13px;
}

.title-text {
  font-size: 13px;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slider {
  width: 100%;
  accent-color: var(--c-accent);
}
.foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}
</style>
