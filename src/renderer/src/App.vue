<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  darkTheme,
  lightTheme,
  zhCN,
  dateZhCN,
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  NButton,
  NIcon,
  NDrawer,
  NDrawerContent,
  NTag,
  NScrollbar,
  NEmpty,
  NDropdown,
  NInput,
  type GlobalThemeOverrides
} from 'naive-ui'
import {
  BookOutline,
  CompassOutline,
  LibraryOutline,
  CloudDownloadOutline,
  SparklesOutline,
  BookmarkOutline,
  SettingsOutline,
  DocumentTextOutline,
  SunnyOutline,
  MoonOutline,
  ChevronForwardOutline,
  ArrowForwardOutline,
  SearchOutline
} from '@vicons/ionicons5'
import { useUpdateStore } from './stores/update'
import { useAppStore } from './stores/app'
import { useDownloadStore } from './stores/download'
import { useAiStore } from './stores/ai'
import { usePreferencesStore, type Appearance } from './stores/preferences'

const router = useRouter()
const route = useRoute()
const app = useAppStore()
const update = useUpdateStore()
const dl = useDownloadStore()
const ai = useAiStore()
const preferences = usePreferencesStore()
const version = __APP_VERSION__
const startupError = ref(false)
const logFilter = ref('')
const errorOnly = ref(false)
const logLines = computed(() =>
  app.logs.filter(
    (line) =>
      (!errorOnly.value || line.level !== 'INFO') &&
      (!logFilter.value ||
        `${line.time} ${line.level} ${line.message}`
          .toLowerCase()
          .includes(logFilter.value.toLowerCase()))
  )
)
const navGroups = [
  {
    label: '我的空间',
    items: [
      { path: '/search', label: '发现漫画', icon: CompassOutline },
      { path: '/library', label: '我的书架', icon: LibraryOutline },
      { path: '/subscriptions', label: '追更订阅', icon: BookmarkOutline }
    ]
  },
  {
    label: '任务与整理',
    items: [
      { path: '/downloads', label: '下载管理', icon: CloudDownloadOutline },
      { path: '/ai-queue', label: '广告整理', icon: SparklesOutline }
    ]
  }
]
const activePath = computed(() =>
  route.path.startsWith('/comic/')
    ? '/search'
    : route.path.startsWith('/library')
      ? '/library'
      : route.path
)
const isReader = computed(() => route.name === 'reader')
const pageName = computed(() =>
  route.path === '/settings'
    ? '偏好设置'
    : navGroups.flatMap((group) => group.items).find((item) => item.path === activePath.value)
        ?.label || 'CopyCopy'
)
const runningCount = computed(() => dl.stats.running + dl.stats.pending)
const progress = computed(() => {
  const task = dl.runningTask
  return task?.total
    ? Math.min(100, Math.round(((task.downloaded + task.skipped) / task.total) * 100))
    : 0
})
const themeOptions = [
  { label: '跟随系统', key: 'system' },
  { label: '浅色模式', key: 'light' },
  { label: '深色模式', key: 'dark' }
]
const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    primaryColor: preferences.dark ? '#aba0ff' : '#6558d9',
    primaryColorHover: preferences.dark ? '#c0b8ff' : '#7a6de5',
    primaryColorPressed: preferences.dark ? '#9486ed' : '#5144c5',
    primaryColorSuppl: preferences.dark ? '#aba0ff' : '#6558d9',
    bodyColor: preferences.dark ? '#161820' : '#f6f7fa',
    cardColor: preferences.dark ? '#1c1f2a' : '#ffffff',
    modalColor: preferences.dark ? '#1c1f2a' : '#ffffff',
    popoverColor: preferences.dark ? '#242836' : '#ffffff',
    textColor1: preferences.dark ? '#e7e9f4' : '#24283d',
    textColor2: preferences.dark ? '#b0b6cc' : '#646b82',
    textColor3: preferences.dark ? '#9099b2' : '#7d859b',
    borderColor: preferences.dark ? '#2b3040' : '#e8eaf0',
    dividerColor: preferences.dark ? '#2b3040' : '#e8eaf0',
    borderRadius: '8px',
    fontFamily: 'inherit',
    fontSize: '13px'
  },
  Button: { heightMedium: '36px', fontWeight: '500' },
  Input: { heightMedium: '36px' },
  Card: {
    borderRadius: '14px',
    titleFontSizeSmall: '15px',
    titleFontWeight: '600'
  }
}))
const cleanups: Array<() => void> = []
async function initialize(): Promise<void> {
  const results = await Promise.allSettled([
    app.loadConfig(),
    app.loadPaths(),
    dl.refresh(),
    app.loadLogs(),
    update.refresh()
  ])
  startupError.value = results.some((result) => result.status === 'rejected')
}
function focusSearch(): void {
  void router
    .push('/search')
    .then(() => document.querySelector<HTMLInputElement>('[data-search-input]')?.focus())
}
function onKey(event: KeyboardEvent): void {
  if (isReader.value || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
  event.preventDefault()
  focusSearch()
}
onMounted(() => {
  cleanups.push(
    window.mkk.onAppUpdate(update.applyState),
    window.mkk.onDownloadProgress(dl.applyProgress),
    window.mkk.onLogLine(app.pushLog),
    window.mkk.onQueueIdle(() => {
      void app.loadConfig().catch(() => {
        startupError.value = true
      })
    }),
    window.mkk.onNavigate((path) => {
      void router.push(path)
    })
  )
  window.addEventListener('keydown', onKey)
  void initialize()
})
onBeforeUnmount(() => {
  cleanups.forEach((cleanup) => cleanup())
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <NConfigProvider
    :theme="preferences.dark ? darkTheme : lightTheme"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NMessageProvider>
      <NDialogProvider>
        <NNotificationProvider>
          <div class="app-shell" :class="{ 'app-shell--reading': isReader }">
            <aside v-if="!isReader" class="sidebar" aria-label="主导航">
              <button class="brand" type="button" @click="router.push('/search')">
                <span class="brand-mark"><NIcon :component="BookOutline" :size="23" /></span>
                <span>
                  <strong>
                    CopyCopy
                    <span class="brand-dot">.</span>
                  </strong>
                  <small>让好故事留在身边</small>
                </span>
              </button>
              <nav class="nav-groups">
                <div v-for="group in navGroups" :key="group.label" class="nav-group">
                  <div class="nav-label">{{ group.label }}</div>
                  <RouterLink
                    v-for="item in group.items"
                    :key="item.path"
                    :to="item.path"
                    class="nav-item"
                    :class="{ selected: activePath === item.path }"
                    :aria-current="activePath === item.path ? 'page' : undefined"
                  >
                    <NIcon :component="item.icon" :size="19" />
                    <span class="nav-text">{{ item.label }}</span>
                    <span v-if="item.path === '/downloads' && runningCount" class="nav-count">
                      {{ runningCount }}
                    </span>
                    <span v-if="item.path === '/ai-queue' && ai.busy" class="nav-count">
                      {{ ai.pillDone }}/{{ ai.pillTotal }}
                    </span>
                  </RouterLink>
                </div>
              </nav>
              <button
                v-if="runningCount"
                class="sidebar-task"
                type="button"
                @click="router.push('/downloads')"
              >
                <span class="sidebar-task__heading">
                  <span class="status-dot" />
                  正在下载
                  <NIcon :component="ArrowForwardOutline" />
                </span>
                <strong>{{ dl.runningTask?.comicName || `${runningCount} 个章节等待下载` }}</strong>
                <small>{{ dl.runningTask?.chapterName || '队列会自动继续' }}</small>
                <span class="mini-progress"><span :style="{ width: `${progress}%` }" /></span>
                <small>
                  {{ progress }}%
                  <span>{{ runningCount }} 个进行中的任务</span>
                </small>
              </button>
              <div v-else class="sidebar-note">
                <NIcon :component="BookOutline" :size="19" />
                <span>你的故事，随时离线阅读。</span>
              </div>
              <div class="sidebar-bottom">
                <RouterLink
                  to="/settings"
                  class="nav-item"
                  :class="{ selected: activePath === '/settings' }"
                >
                  <NIcon :component="SettingsOutline" :size="19" />
                  <span class="nav-text">偏好设置</span>
                </RouterLink>
                <button type="button" class="nav-item" @click="app.logOpen = true">
                  <NIcon :component="DocumentTextOutline" :size="19" />
                  <span class="nav-text">运行日志</span>
                </button>
                <div class="sidebar-version">
                  <span>CopyCopy</span>
                  <span>v{{ version }}</span>
                </div>
              </div>
            </aside>
            <div class="workspace">
              <header v-if="!isReader" class="workspace-bar">
                <div class="breadcrumbs">
                  <span>工作台</span>
                  <NIcon :component="ChevronForwardOutline" :size="12" />
                  <strong>{{ pageName }}</strong>
                </div>
                <div class="workspace-bar__right">
                  <NButton
                    v-if="update.hasUpdate"
                    size="small"
                    secondary
                    type="primary"
                    data-update-badge
                    @click="router.push('/settings?tab=updates')"
                  >
                    {{ update.state?.status === 'downloaded' ? '更新已就绪' : '发现新版本' }}
                  </NButton>
                  <button class="quick-search" type="button" @click="focusSearch">
                    <NIcon :component="SearchOutline" :size="15" />
                    <span>搜索漫画</span>
                    <kbd>Ctrl K</kbd>
                  </button>
                  <span class="bar-divider" />
                  <NDropdown
                    :options="themeOptions"
                    :value="preferences.appearance"
                    @select="(key: string) => (preferences.appearance = key as Appearance)"
                  >
                    <NButton quaternary circle aria-label="切换外观" title="切换外观">
                      <template #icon>
                        <NIcon :component="preferences.dark ? MoonOutline : SunnyOutline" />
                      </template>
                    </NButton>
                  </NDropdown>
                </div>
              </header>
              <div v-if="startupError" class="startup-error" role="alert">
                部分数据未能加载，请重试。
                <NButton size="tiny" quaternary @click="initialize">重新加载</NButton>
              </div>
              <main class="workspace-content">
                <RouterView v-slot="{ Component }">
                  <KeepAlive include="SearchView"><component :is="Component" /></KeepAlive>
                </RouterView>
              </main>
            </div>
          </div>
          <NDrawer v-model:show="app.logOpen" width="min(760px, 88vw)" placement="right">
            <NDrawerContent title="运行日志" closable>
              <div class="toolbar">
                <NInput
                  v-model:value="logFilter"
                  placeholder="搜索日志内容"
                  clearable
                  style="flex: 1"
                />
                <NButton
                  size="small"
                  :type="errorOnly ? 'primary' : 'default'"
                  @click="errorOnly = !errorOnly"
                >
                  只看警告与错误
                </NButton>
              </div>
              <p class="muted" style="font-size: 12px">
                显示 {{ logLines.length }} 行 · 保留最近 2000 行
              </p>
              <NScrollbar style="height: calc(100% - 92px)">
                <div class="log-pane">
                  <div v-for="(line, index) in logLines" :key="index" class="log-line">
                    <span class="log-time">{{ line.time }}</span>
                    <NTag
                      size="tiny"
                      :bordered="false"
                      :type="
                        line.level === 'ERROR'
                          ? 'error'
                          : line.level === 'WARN'
                            ? 'warning'
                            : 'default'
                      "
                    >
                      {{ line.level }}
                    </NTag>
                    <span>{{ line.message }}</span>
                  </div>
                  <NEmpty v-if="!logLines.length" description="没有匹配的日志" />
                </div>
              </NScrollbar>
            </NDrawerContent>
          </NDrawer>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100dvh;
  background: var(--c-app);
}
.sidebar {
  display: flex;
  flex-direction: column;
  width: 214px;
  flex: 0 0 214px;
  background: var(--c-sidebar);
  border-right: 1px solid var(--c-border);
  padding: 30px 16px 0;
  overflow-y: auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 7px;
  border: 0;
  background: none;
  cursor: pointer;
  text-align: left;
}
.brand-mark {
  width: 38px;
  height: 42px;
  border-radius: 12px;
  background: var(--c-accent);
  color: var(--c-accent-fg);
  display: grid;
  place-items: center;
  transform: rotate(-5deg);
}
.brand strong {
  display: block;
  font-size: 21px;
  letter-spacing: -0.8px;
  line-height: 1.4;
}
.brand-dot {
  color: var(--c-accent);
}
.brand small {
  display: block;
  font-size: 9px;
  color: var(--c-text-3);
  letter-spacing: 1.2px;
  margin-top: 3px;
}
.nav-groups {
  margin-top: 40px;
}
.nav-group + .nav-group {
  margin-top: 28px;
}
.nav-label {
  color: var(--c-text-3);
  font-size: 10px;
  margin: 0 14px 12px;
  letter-spacing: 1px;
}
.nav-item {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 12px;
  padding: 12px 14px;
  margin: 4px 0;
  border: 0;
  background: transparent;
  border-radius: 9px;
  color: var(--c-text-2);
  cursor: pointer;
  text-decoration: none;
  font-size: 13px;
  transition: background 0.15s;
}
.nav-item:hover {
  background: var(--c-elevated-hover);
}
.nav-item.selected {
  background: var(--c-accent-soft);
  color: var(--c-accent);
  font-weight: 600;
}
.nav-text {
  flex: 1;
  text-align: left;
  white-space: nowrap;
}
.nav-count {
  font-size: 10px;
  font-weight: 600;
  background: var(--c-surface);
  border-radius: 5px;
  padding: 1px 6px;
}
.sidebar-task {
  margin: auto 2px 20px;
  background: var(--c-accent-soft);
  border: 1px solid var(--c-accent-border);
  border-radius: 12px;
  padding: 14px;
  text-align: left;
  cursor: pointer;
}
.sidebar-task__heading {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--c-accent);
  margin-bottom: 12px;
}
.sidebar-task__heading .n-icon {
  margin-left: auto;
}
.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--c-accent);
}
.sidebar-task > strong {
  display: block;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-task > small {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--c-text-2);
  margin-top: 5px;
}
.mini-progress {
  display: block;
  height: 4px;
  margin: 12px 0 8px;
  border-radius: 4px;
  background: var(--c-accent-border);
  overflow: hidden;
}
.mini-progress > span {
  display: block;
  height: 100%;
  background: var(--c-accent);
  transition: width 0.2s;
}
.sidebar-note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--c-text-3);
  font-size: 10px;
  margin: auto 0 22px;
  padding-top: 20px;
}
.sidebar-bottom {
  border-top: 1px solid var(--c-border);
  padding-top: 12px;
  flex-shrink: 0;
}
.sidebar-version {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--c-text-3);
  padding: 18px 14px;
  letter-spacing: 0.4px;
}
.workspace {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.workspace-bar {
  display: flex;
  height: 65px;
  flex: 0 0 65px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 36px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-surface);
}
.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 11px;
  color: var(--c-text-3);
}
.breadcrumbs strong {
  color: var(--c-text-2);
  font-weight: 500;
}
.workspace-bar__right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.quick-search {
  display: flex;
  align-items: center;
  gap: 7px;
  background: transparent;
  border: 0;
  font-size: 11px;
  cursor: pointer;
  color: var(--c-text-3);
}
.quick-search kbd {
  margin-left: 20px;
  padding: 1px 5px;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  font-size: 9px;
  font-family: inherit;
}
.bar-divider {
  height: 18px;
  border-left: 1px solid var(--c-border);
}
.workspace-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.startup-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--c-warn-bg);
  color: var(--c-warn-fg);
  padding: 8px;
  font-size: 12px;
}
.log-pane {
  font:
    11px/1.8 Consolas,
    monospace;
}
.log-line {
  display: flex;
  gap: 9px;
  align-items: baseline;
  padding: 6px 0;
  border-bottom: 1px solid var(--c-border);
}
.log-line > :last-child {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log-time {
  color: var(--c-text-3);
  flex-shrink: 0;
}
@media (max-width: 1050px) {
  .sidebar {
    width: 188px;
    flex-basis: 188px;
    padding: 24px 12px 0;
  }
  .brand strong {
    font-size: 19px;
  }
  .brand small {
    font-size: 8px;
  }
  .workspace-bar {
    padding: 0 24px;
  }
}
@media (max-height: 760px) {
  .sidebar {
    padding-top: 20px;
  }
  .nav-groups {
    margin-top: 24px;
  }
  .nav-group + .nav-group {
    margin-top: 18px;
  }
  .nav-item {
    padding-top: 10px;
    padding-bottom: 10px;
  }
  .sidebar-note {
    display: none;
  }
  .sidebar-task {
    padding: 10px;
    margin-top: 16px;
    margin-bottom: 12px;
  }
  .sidebar-bottom {
    margin-top: auto;
  }
  .sidebar-version {
    padding-top: 12px;
    padding-bottom: 12px;
  }
}
</style>
