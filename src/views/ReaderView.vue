<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { api, localImage, remoteImage } from '../services/api'
import type { Chapter } from '../types'
import { useAppStore } from '../stores/app'
import { preference, savePreference } from '../readerPreferences'
import AppIcon from '../components/AppIcon.vue'
import WindowControls from '../components/WindowControls.vue'
import { dragWindow } from '../utils/desktopWindow'
const app = useAppStore()
const route = useRoute()
const router = useRouter()
const comicId = computed(() => String(route.params.comicId))
const chapterId = computed(() => String(route.params.chapterId))
const local = computed(() => route.query.local !== '0')
const title = ref(String(route.query.title || '阅读'))
const bookTitle = ref('')
const loading = ref(true)
const error = ref('')
const urls = ref<string[]>([])
const count = ref(0)
const page = ref(0)
const pageDraft = ref(1)
const mode = ref(preference('mode', 'scroll'))
const fit = ref(preference('fit', 'width'))
const zoom = ref(Number(preference('zoom', '100')) || 100)
const chapterIndex = ref(Number(route.query.index) || 1)
const chapters = ref<Chapter[]>([])
const totalChapters = ref(0)
const failed = ref(new Set<number>())
const stage = ref<HTMLElement>()
const imageStyle = computed(() => ({
  zoom: zoom.value / 100,
  width: fit.value === 'width' ? 'min(960px, calc(100vw - 60px))' : 'auto',
  maxHeight: fit.value === 'height' ? 'calc(100vh - 145px)' : 'none'
}))
const source = (index: number) =>
  local.value
    ? localImage(comicId.value, chapterId.value, index)
    : remoteImage(urls.value[index] || '')
let generation = 0
let observer: IntersectionObserver | null = null
let progressTimer: ReturnType<typeof setTimeout> | undefined
async function persist() {
  clearTimeout(progressTimer)
  if (loading.value || error.value || !count.value) return
  try {
    await api.saveProgress(
      {
        comicId: comicId.value,
        chapterId: chapterId.value,
        page: page.value,
        updatedAt: Date.now()
      },
      local.value
    )
  } catch (cause) {
    app.notify('阅读进度未能保存：' + String(cause), true)
  }
}
watch(page, (value) => {
  pageDraft.value = value + 1
  clearTimeout(progressTimer)
  progressTimer = setTimeout(persist, 500)
})
watch([mode, fit, zoom], () => {
  savePreference('mode', mode.value)
  savePreference('fit', fit.value)
  savePreference('zoom', String(zoom.value))
})
async function observePages() {
  observer?.disconnect()
  if (mode.value !== 'scroll' || loading.value) return
  await nextTick()
  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
      if (visible[0]) page.value = Number((visible[0].target as HTMLElement).dataset.readerPage)
    },
    { root: stage.value, threshold: [0, 0.1, 0.25, 0.5, 0.75] }
  )
  stage.value
    ?.querySelectorAll('[data-reader-page]')
    .forEach((element) => observer?.observe(element))
}
watch(mode, observePages)
async function load() {
  const active = ++generation
  loading.value = true
  error.value = ''
  urls.value = []
  count.value = 0
  page.value = 0
  failed.value.clear()
  try {
    const [pages, progress] = await Promise.all([
      api.readerPages(comicId.value, chapterId.value, local.value),
      api.progress(comicId.value, local.value)
    ])
    if (active !== generation) return
    if (!pages.count) throw new Error('该章节还没有可阅读的图片')
    urls.value = pages.urls
    count.value = pages.count
    if (local.value) {
      const book = (await api.library()).find((b) => b.comic.id === comicId.value)
      if (active !== generation) return
      bookTitle.value = book?.comic.title || '本地书库'
      chapters.value =
        book?.chapters.map((c) => ({
          id: c.id,
          title: c.title,
          index: c.index,
          pageCount: c.pageCount,
          updatedAt: ''
        })) || []
      const chapter = chapters.value.find((c) => c.id === chapterId.value)
      title.value = chapter?.title || title.value
      chapterIndex.value = chapter?.index || chapterIndex.value
      totalChapters.value = chapters.value.length
    } else {
      const [book, chapterPage] = await Promise.all([
        api.comic(comicId.value),
        api.chapters(comicId.value, Math.floor((chapterIndex.value - 1) / 50) + 1)
      ])
      if (active !== generation) return
      bookTitle.value = book.title
      chapters.value = chapterPage.items
      totalChapters.value = chapterPage.total
      title.value = chapters.value.find((c) => c.id === chapterId.value)?.title || title.value
    }
    if (progress?.chapterId === chapterId.value)
      page.value = Math.min(count.value - 1, Math.max(0, progress.page))
    loading.value = false
    await observePages()
    if (mode.value === 'scroll' && page.value) await jump(page.value + 1)
  } catch (cause) {
    if (active === generation) {
      error.value = String(cause)
      loading.value = false
    }
  }
}
async function jump(value = pageDraft.value) {
  if (!count.value) return
  const target = Math.max(0, Math.min(count.value - 1, Math.floor(value) - 1))
  page.value = target
  if (mode.value === 'scroll') {
    await nextTick()
    stage.value
      ?.querySelector('[data-reader-page="' + target + '"]')
      ?.scrollIntoView({ block: 'start' })
  }
}
async function nextChapter(direction: number) {
  if (loading.value) return
  await persist()
  let chapter: Chapter | undefined
  if (local.value) {
    const index = chapters.value.findIndex((c) => c.id === chapterId.value)
    chapter = chapters.value[index + direction]
  } else {
    const index = chapterIndex.value + direction
    if (index >= 1 && index <= totalChapters.value) {
      chapter = chapters.value.find((c) => c.index === index)
      if (!chapter)
        chapter = (
          await app.run(() => api.chapters(comicId.value, Math.floor((index - 1) / 50) + 1))
        )?.items.find((c) => c.index === index)
    }
  }
  if (!chapter) {
    app.notify(direction > 0 ? '已经到最后一章了' : '这是第一章')
    return
  }
  await router.replace({
    name: 'reader',
    params: { comicId: comicId.value, chapterId: chapter.id },
    query: { local: local.value ? '1' : '0', index: chapter.index, title: chapter.title }
  })
}
function back() {
  void router.push((local.value ? '/library/' : '/comic/') + encodeURIComponent(comicId.value))
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    back()
    return
  }
  if ((event.target as HTMLElement)?.closest('input, select, textarea, button')) return
  if (['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp'].includes(event.key)) {
    event.preventDefault()
    const direction = ['ArrowRight', 'PageDown'].includes(event.key) ? 1 : -1
    if (page.value + direction < 0 || page.value + direction >= count.value)
      void nextChapter(direction)
    else void jump(page.value + direction + 1)
  }
}
onBeforeRouteLeave(async () => {
  await persist()
})
onMounted(() => {
  window.addEventListener('keydown', keyboard)
  void load()
})
onBeforeUnmount(() => {
  generation++
  clearTimeout(progressTimer)
  observer?.disconnect()
  window.removeEventListener('keydown', keyboard)
})
</script>
<template>
  <section class="reader-shell" aria-label="漫画阅读器">
    <header class="reader-topbar" @mousedown="dragWindow">
      <button class="icon-btn" aria-label="返回作品" @click="back">
        <AppIcon name="back" :size="20" />
      </button>
      <div class="reader-heading">
        <strong>{{ bookTitle }}</strong>
        <span>
          {{ title }}
          <small v-if="local">本地阅读</small>
        </span>
      </div>
      <div class="reader-controls">
        <select v-model="mode" aria-label="阅读模式">
          <option value="scroll">纵向滚动</option>
          <option value="paged">逐页阅读</option>
        </select>
        <select v-model="fit" aria-label="画面适应">
          <option value="width">适应宽度</option>
          <option value="height">适应高度</option>
          <option value="original">原始尺寸</option>
        </select>
        <label class="reader-zoom">
          <input
            v-model.number="zoom"
            type="range"
            min="50"
            max="180"
            step="10"
            aria-label="阅读缩放"
          />
          <span>{{ zoom }}%</span>
        </label>
      </div>
      <WindowControls />
    </header>
    <div ref="stage" class="reader-stage" :class="{ paged: mode === 'paged' }">
      <div v-if="loading" class="reader-message">
        <span class="spinner" />
        <p>正在翻开下一页…</p>
      </div>
      <div v-else-if="error" class="reader-message" role="alert">
        <AppIcon name="alert" :size="34" />
        <h2>这一章暂时没有打开</h2>
        <p>{{ error }}</p>
        <button class="btn btn-primary" @click="load">重新加载</button>
      </div>
      <template v-else>
        <template
          v-for="index in mode === 'paged' ? [page] : Array.from({ length: count }, (_, i) => i)"
          :key="chapterId + '-' + index"
        >
          <div class="reader-page" :data-reader-page="index">
            <div v-if="failed.has(index)" class="reader-image-error">
              <AppIcon name="image" :size="30" />
              <p>第 {{ index + 1 }} 页加载失败</p>
              <button class="btn btn-secondary btn-sm" @click="failed.delete(index)">
                重试这页
              </button>
            </div>
            <img
              v-else
              :src="source(index)"
              :alt="title + ' 第 ' + (index + 1) + ' 页'"
              :loading="mode === 'paged' || index < 2 ? 'eager' : 'lazy'"
              :style="imageStyle"
              draggable="false"
              @error="failed.add(index)"
            />
          </div>
        </template>
        <div v-if="mode === 'scroll'" class="reader-end">
          <span>这一章，就读到这里。</span>
          <button class="btn btn-primary" @click="nextChapter(1)">
            接着读下一章
            <AppIcon name="arrow" :size="16" />
          </button>
        </div>
      </template>
    </div>
    <footer class="reader-footer">
      <button class="text-btn" :disabled="loading" @click="nextChapter(-1)">
        <AppIcon name="chevron-left" :size="16" />
        上一章
      </button>
      <div class="reader-pagination">
        <button
          class="icon-btn"
          :disabled="!page || loading"
          aria-label="上一张图片"
          @click="jump(page)"
        >
          <AppIcon name="chevron-left" :size="16" />
        </button>
        <label>
          <input
            v-model.number="pageDraft"
            type="number"
            min="1"
            :max="count || 1"
            aria-label="阅读页码"
            @change="jump()"
          />
          <span>/ {{ count || '—' }} 页</span>
        </label>
        <button
          class="icon-btn"
          :disabled="page >= count - 1 || loading"
          aria-label="下一张图片"
          @click="jump(page + 2)"
        >
          <AppIcon name="chevron-right" :size="16" />
        </button>
      </div>
      <button class="text-btn" :disabled="loading" @click="nextChapter(1)">
        下一章
        <AppIcon name="chevron-right" :size="16" />
      </button>
    </footer>
  </section>
</template>
