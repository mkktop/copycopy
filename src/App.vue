<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listen } from '@tauri-apps/api/event'
import { api } from './services/api'
import type { QueueSnapshot } from './types'
import { useAppStore } from './stores/app'
import { useDownloadStore } from './stores/downloads'
import { useUpdateStore } from './stores/updates'
import { dragWindow, syncWindowTheme } from './utils/desktopWindow'
import Sidebar from './components/Sidebar.vue'
import WindowControls from './components/WindowControls.vue'
import AppIcon from './components/AppIcon.vue'
import BrandMark from './components/BrandMark.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
const app = useAppStore()
const downloads = useDownloadStore()
const updates = useUpdateStore()
const route = useRoute()
const router = useRouter()
const query = ref('')
const main = ref<HTMLElement>()
const reader = computed(() => route.name === 'reader')
const pageName = computed(() => ({ home: '发现故事', search: '搜索与探索', comic: '作品详情', library: '本地书库', book: '章节管理', downloads: '下载管理', subscriptions: '追更订阅', settings: '偏好设置' })[String(route.name)] || 'CopyCopy')
const scroll = new Map<string, number>()
const media = matchMedia('(prefers-color-scheme: dark)')
let cleanup = () => {}
function systemTheme(event: MediaQueryListEvent) { app.systemDark = event.matches }
watch([() => app.theme, reader], ([theme, reading]) => { void syncWindowTheme(reading ? 'dark' : theme) }, { immediate: true })
watch(() => route.fullPath, async (_, from) => {
  scroll.set(from, main.value?.scrollTop || 0)
  query.value = String(route.query.q || '')
  await nextTick()
  main.value?.scrollTo({ top: scroll.get(route.fullPath) || 0 })
})
function search() { if (query.value.trim()) void router.push({ path: '/search', query: { q: query.value.trim() } }) }
function shortcut(event: KeyboardEvent) {
  if (!reader.value && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); document.querySelector<HTMLInputElement>('[data-global-search]')?.focus()
  }
}
async function initialize() {
  if (app.loading) return
  app.loading = true; app.startupError = ''
  try {
    const snapshot = await api.snapshot()
    app.settings = snapshot.settings; app.paths = snapshot.paths; downloads.apply(snapshot.queue); app.ready = true
    if (app.settings.checkUpdatesOnLaunch) void updates.check()
  } catch (error) { app.startupError = '无法连接桌面服务：' + String(error) }
  finally { app.loading = false }
}
onMounted(async () => {
  media.addEventListener('change', systemTheme)
  window.addEventListener('keydown', shortcut)
  try { cleanup = await listen<QueueSnapshot>('queue-update', event => downloads.apply(event.payload)) }
  catch { app.notify('下载进度连接失败，可在下载管理中刷新', true) }
  await initialize()
})
onBeforeUnmount(() => { cleanup(); media.removeEventListener('change', systemTheme); window.removeEventListener('keydown', shortcut) })
</script>
<template>
  <div class="app-container" :data-theme="reader ? 'dark' : app.theme" :class="{ 'compact-cards': app.settings.compactCards }">
    <div v-if="!app.ready" class="app-start">
      <BrandMark/><h1>CopyCopy</h1><span v-if="app.loading" class="spinner"/>
      <template v-if="app.startupError"><p role="alert">{{ app.startupError }}</p><button class="btn btn-primary" @click="initialize">重新连接</button></template>
      <p v-else>为下一段故事准备好位置。</p>
    </div>
    <template v-else>
      <Sidebar v-if="!reader"/>
      <div class="workspace" :class="{ collapsed: app.settings.sidebarCollapsed, fullscreen: reader }" data-app-ready>
        <header v-if="!reader" class="topbar" @mousedown="dragWindow">
          <div class="breadcrumb"><span>CopyCopy</span><AppIcon name="chevron-right" :size="13"/><strong>{{ pageName }}</strong></div>
          <form class="global-search" @submit.prevent="search"><AppIcon name="search" :size="17"/><input v-model="query" aria-label="全局搜索" placeholder="搜索漫画、作者或关键词" data-global-search/><kbd>Ctrl K</kbd></form>
          <button v-if="updates.result?.status === 'available'" class="update-badge" @click="router.push('/settings?tab=updates')">{{ updates.phase === 'ready' ? '更新已就绪' : '发现新版本' }}</button>
          <div class="topbar-actions"><button class="icon-btn" aria-label="切换外观" title="切换外观" @click="app.run(() => app.save({ appearance: app.theme === 'light' ? 'dark' : 'light' }))"><AppIcon :name="app.theme === 'light' ? 'moon' : 'sun'"/></button></div>
          <WindowControls/>
        </header>
        <main ref="main" class="main-content" :class="{ fullscreen: reader }">
          <RouterView v-slot="{ Component }"><KeepAlive :include="['HomeView', 'SearchView', 'LibraryView', 'DownloadsView', 'SubscriptionsView']" :max="8"><component :is="Component" :key="route.path"/></KeepAlive></RouterView>
        </main>
      </div>
    </template>
    <div class="toast-stack" aria-live="polite"><div v-for="notice in app.notices" :key="notice.id" class="toast" :class="{ error: notice.error }" :role="notice.error ? 'alert' : 'status'"><AppIcon :name="notice.error ? 'alert' : 'check'" :size="17"/>{{ notice.text }}</div></div>
    <ConfirmDialog/>
  </div>
</template>
