<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch, type VNode } from 'vue'
import {
  darkTheme,
  lightTheme,
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NMenu,
  NButton,
  NDrawer,
  NDrawerContent,
  NScrollbar,
  NSpace,
  NTag,
  NText,
  NEmpty,
  NTooltip,
  type MenuOption,
  type GlobalThemeOverrides
} from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from './stores/app'
import { useDownloadStore } from './stores/download'
import { useAiStore } from './stores/ai'

const router = useRouter()
const route = useRoute()
const app = useAppStore()
const dl = useDownloadStore()
const ai = useAiStore()

/**
 * 跟随系统深浅色。
 * 之前写死暗色，Windows 开着浅色主题时整个窗口和任务栏格格不入。
 */
const prefersDark = ref(
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
)

/**
 * naive-ui 的主题切换只管组件层；各视图的自定义配色走 styles.css 的
 * CSS 变量。必须两边一起切，否则就是组件浅色、页面深色的花屏。
 */
function applyTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
watch(prefersDark, applyTheme, { immediate: true })

let mql: MediaQueryList | null = null
let onSchemeChange: ((e: MediaQueryListEvent) => void) | null = null
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  mql = window.matchMedia('(prefers-color-scheme: dark)')
  onSchemeChange = (e: MediaQueryListEvent) => {
    prefersDark.value = e.matches
  }
  mql.addEventListener?.('change', onSchemeChange)
}

/**
 * 浅色主题下 naive-ui 的配色覆盖。
 * 这些值必须和 styles.css 里的浅色 token 对齐，否则组件和页面
 * 的底色/文字色会差半档，看起来还是花的。
 */
const LIGHT_OVERRIDES: GlobalThemeOverrides = {
  common: {
    primaryColor: '#12a37a',
    primaryColorHover: '#0e8f6a',
    primaryColorPressed: '#0b7a59',
    primaryColorSuppl: '#12a37a',
    bodyColor: '#f4f5f7',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    textColorBase: '#1f2329',
    textColor1: '#1f2329',
    textColor2: '#5b6169',
    textColor3: '#868d96',
    borderColor: '#e3e6ea',
    dividerColor: '#e3e6ea',
    hoverColor: '#f0f2f5',
    actionColor: '#f0f2f5'
  }
}

const themeOverrides = computed<GlobalThemeOverrides>(() =>
  prefersDark.value ? {} : LIGHT_OVERRIDES
)

const activeKey = computed(() => {
  if (route.path.startsWith('/comic')) return 'search'
  if (route.path.startsWith('/library')) return 'library'
  const k = route.path.replace('/', '')
  return ['search', 'downloads', 'ai-queue', 'library', 'settings'].includes(k) ? k : 'search'
})

const runningCount = computed(() => dl.stats.running + dl.stats.pending)

/** 日志抽屉宽度跟着窗口走，窄屏上别把 640px 的抽屉铺满 */
const vw = ref(typeof window === 'undefined' ? 1280 : window.innerWidth)
let onResize = (): void => {
  vw.value = window.innerWidth
}
if (typeof window !== 'undefined') window.addEventListener('resize', onResize)
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('resize', onResize)
  if (mql && onSchemeChange) mql.removeEventListener?.('change', onSchemeChange)
})
const drawerWidth = computed(() => Math.min(720, Math.max(320, Math.floor(vw.value * 0.55))))

/**
 * 菜单项自己带角标。
 * 之前把下载计数挂在「日志」按钮上——语义完全对不上，
 * 用户点进去看日志，莫名其妙多一个下载数字。
 * 这里只用普通 span 画药丸，不去和 NBadge 的定位较劲。
 */
function countPill(n: number): VNode {
  return h('span', { class: 'count-pill' }, n > 99 ? '99+' : String(n))
}

/**
 * AI 检测的进度药丸，挂在「检测队列」标签上。
 * 检测是后台跑的，有了它和检测队列页，任何页面都能知道检测的状态。
 */
function aiPill(): VNode {
  return h('span', { class: 'count-pill count-pill--ai' }, `AI ${ai.pillDone}/${ai.pillTotal}`)
}

const menuOptions = computed<MenuOption[]>(() => [
  { label: '搜索', key: 'search' },
  {
    label: () =>
      h('span', { class: 'menu-item' }, [
        h('span', '下载队列'),
        runningCount.value > 0 ? countPill(runningCount.value) : null
      ]),
    key: 'downloads'
  },
  {
    label: () =>
      h('span', { class: 'menu-item' }, [
        h('span', '检测队列'),
        ai.busy ? aiPill() : null
      ]),
    key: 'ai-queue'
  },
  { label: '漫画库', key: 'library' },
  { label: '设置', key: 'settings' }
])

function go(key: string): void {
  router.push('/' + key)
}

onMounted(async () => {
  await Promise.all([app.loadConfig(), app.loadPaths(), dl.refresh(), app.loadLogs()])
  window.mkk.onDownloadProgress(dl.applyProgress)
  window.mkk.onLogLine(app.pushLog)
  // 点系统通知时主进程会让窗口跳到下载队列页
  window.mkk.onNavigate((p) => router.push(p))
})

onBeforeUnmount(() => mql?.removeEventListener?.('change', () => {}))
</script>

<template>
  <NConfigProvider :theme="prefersDark ? darkTheme : lightTheme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <NNotificationProvider>
          <NLayout position="absolute" class="shell">
            <NLayoutHeader bordered class="topbar">
              <span class="brand">CopyCopy</span>
              <NMenu
                mode="horizontal"
                :value="activeKey"
                :options="menuOptions"
                class="menu"
                @update:value="go"
              />
              <NTooltip trigger="hover" placement="bottom">
                <template #trigger>
                  <NButton size="small" quaternary class="ghost-btn" @click="app.logOpen = true">
                    日志
                  </NButton>
                </template>
                打开运行日志
              </NTooltip>
            </NLayoutHeader>

            <NLayoutContent content-style="height: 100%;">
              <RouterView />
            </NLayoutContent>
          </NLayout>

          <NDrawer v-model:show="app.logOpen" :width="drawerWidth" placement="right">
            <NDrawerContent title="运行日志" closable>
              <NSpace align="center" style="padding: 0 4px 10px">
                <NTag size="tiny" :bordered="false" type="success">INFO</NTag>
                <NText depth="3" style="font-size: 12px">
                  共 {{ app.logs.length }} 行（应用内保留最近 2000 行，磁盘上按天轮转）
                </NText>
              </NSpace>
              <NScrollbar style="height: calc(100% - 34px)">
                <div class="log-pane">
                  <div v-for="(l, i) in app.logs" :key="i" class="log-line">
                    <span class="log-time">{{ l.time }}</span>
                    <NTag
                      size="tiny"
                      :bordered="false"
                      :type="l.level === 'ERROR' ? 'error' : l.level === 'WARN' ? 'warning' : 'success'"
                      class="log-level"
                    >
                      {{ l.level }}
                    </NTag>
                    <span class="log-msg">{{ l.message }}</span>
                  </div>
                  <NEmpty v-if="app.logs.length === 0" description="暂无日志" />
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
.shell {
  background: var(--c-app);
}

.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  height: 52px;
}

.brand {
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.5px;
  white-space: nowrap;
  user-select: none;
}

.menu {
  flex: 1;
  min-width: 0;
}

.ghost-btn {
  position: relative;
  white-space: nowrap;
}

/* 下载计数的药丸。用普通 span 而不是 NBadge：
   NBadge 要靠子元素撑定位，塞 0 尺寸的占位再覆盖 position 并不稳。 */
.count-pill {
  display: inline-block;
  min-width: 17px;
  height: 17px;
  line-height: 17px;
  padding: 0 5px;
  margin-left: 6px;
  border-radius: 9px;
  background: var(--c-pill);
  color: var(--c-accent-on);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/* AI 检测进度药丸：蓝色区别于下载计数的绿色，内容是 "AI 3/82" */
.count-pill--ai {
  background: var(--c-accent-2);
  padding: 0 7px;
}
.menu-item {
  display: inline-flex;
  align-items: center;
}

.log-pane {
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  line-height: 1.7;
  padding: 0 4px;
}

.log-line {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 1px 0;
  border-bottom: 1px solid transparent;
}
.log-line:hover {
  background: rgba(127, 127, 127, 0.08);
  border-radius: 3px;
}

.log-time {
  color: var(--c-text-3);
  flex: 0 0 auto;
}
.log-level {
  flex: 0 0 auto;
}
.log-msg {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-text-1);
}
</style>
