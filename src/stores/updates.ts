import { defineStore } from 'pinia'
import { Channel, invoke } from '@tauri-apps/api/core'

interface UpdateCheck {
  status: 'available' | 'current' | 'unpublished'
  current_version: string
  version: string | null
  notes: string | null
  published_at: string | null
  can_install: boolean
  download_size: number | null
  installer_kind: 'windows' | 'macos' | null
}

interface UpdateProgress {
  downloaded: number
  total: number
}

// Keep the download and its progress alive when navigating away from Settings.
export const useUpdateStore = defineStore('updates', {
  state: () => ({
    currentVersion: '',
    result: null as UpdateCheck | null,
    phase: 'idle' as 'idle' | 'checking' | 'downloading' | 'ready' | 'installing',
    downloaded: 0,
    total: 0,
    message: '',
    error: ''
  }),
  getters: {
    busy: (state) => ['checking', 'downloading', 'installing'].includes(state.phase),
    percent: (state) =>
      state.total > 0 ? Math.min(100, Math.floor((state.downloaded / state.total) * 100)) : 0
  },
  actions: {
    async loadVersion() {
      if (this.currentVersion) return
      try {
        this.currentVersion = await invoke<string>('get_app_version')
      } catch {
        this.error = '无法读取当前版本，请在桌面客户端中检查更新'
      }
    },
    async check() {
      if (this.busy) return
      this.phase = 'checking'
      this.error = ''
      this.message = ''
      this.result = null
      this.downloaded = 0
      this.total = 0
      try {
        const result = await invoke<UpdateCheck>('check_for_updates')
        this.result = result
        this.currentVersion = result.current_version
        this.message =
          result.status === 'unpublished'
            ? '暂未发布正式版本，请稍后再检查'
            : result.status === 'current'
              ? '当前已是最新版本'
              : `发现新版本 v${result.version}`
      } catch (error) {
        this.error = '检查更新失败：' + error
      } finally {
        this.phase = 'idle'
      }
    },
    async download() {
      if (this.busy || !this.result?.can_install || this.phase === 'ready') return
      this.phase = 'downloading'
      this.error = ''
      this.downloaded = 0
      this.total = this.result.download_size || 0
      try {
        const onProgress = new Channel<UpdateProgress>()
        onProgress.onmessage = (progress) => {
          this.downloaded = progress.downloaded
          this.total = progress.total
        }
        await invoke('download_update', { onProgress })
        this.phase = 'ready'
        this.message = '安装包已下载并通过校验，准备安装'
      } catch (error) {
        this.phase = 'idle'
        this.error = '下载更新失败：' + error
      }
    },
    async install() {
      if (this.phase !== 'ready') return
      this.phase = 'installing'
      this.error = ''
      try {
        await invoke('install_update')
      } catch (error) {
        this.phase = 'ready'
        this.error = '安装更新失败：' + error
      }
    },
    async openRelease() {
      try {
        await invoke('open_update_release')
      } catch (error) {
        this.error = String(error)
      }
    }
  }
})
