import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppConfig, LogLine } from '@shared/types'
import type { AppPaths } from '@shared/ipc'
import { LIBRARY_SCHEME, REMOTE_SCHEME } from '@shared/ipc'

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig | null>(null)
  const paths = ref<AppPaths | null>(null)
  const logs = ref<LogLine[]>([])
  const logOpen = ref(false)

  async function loadConfig(): Promise<void> {
    config.value = await window.mkk.getConfig()
  }

  async function saveGlobal(patch: Partial<AppConfig['global']>): Promise<void> {
    config.value = await window.mkk.setConfig(patch)
  }

  async function loadPaths(): Promise<void> {
    paths.value = await window.mkk.paths()
  }

  async function loadLogs(): Promise<void> {
    logs.value = await window.mkk.logHistory(800)
  }

  function pushLog(line: LogLine): void {
    logs.value.push(line)
    if (logs.value.length > 2000) logs.value.shift()
  }

  /**
   * out/ 里的绝对路径 -> library:// URL，交给 <img> 直接加载。
   * 返回 null 时调用方渲染占位图。
   */
  function imgUrl(absPath: string | undefined): string | null {
    const root = paths.value?.out
    if (!absPath || !root) return null
    const rel = absPath.startsWith(root) ? absPath.slice(root.length) : absPath
    const segments = rel
      .split(/[\\/]+/)
      .filter(Boolean)
      .map(encodeURIComponent)
    return segments.length ? `${LIBRARY_SCHEME}://local/${segments.join('/')}` : null
  }

  /**
   * 站点封面 -> remote:// URL。
   *
   * 不能让渲染层直接 <img src="https://CDN/...">：渲染层是 Chromium 的
   * 独立网络栈，既读不到应用配置的代理，也发不出 CDN 要的 version/platform 头。
   * 走这个协议由主进程代理，顺便落盘缓存。
   */
  function remoteImg(url: string | undefined): string | null {
    if (!url) return null
    if (url.startsWith('data:') || url.startsWith(`${LIBRARY_SCHEME}:`)) return url
    // 已经是代理过的就别再套一层
    if (url.startsWith(`${REMOTE_SCHEME}:`)) return url
    return `${REMOTE_SCHEME}://img/${encodeURIComponent(url)}`
  }

  return {
    config,
    paths,
    logs,
    logOpen,
    loadConfig,
    saveGlobal,
    loadPaths,
    loadLogs,
    pushLog,
    imgUrl,
    remoteImg
  }
})
