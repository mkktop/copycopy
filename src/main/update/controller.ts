import { EventEmitter } from 'node:events'
import { gt, prerelease, valid } from 'semver'
import type {
  AppRelease,
  AppUpdateMode,
  AppUpdateProgress,
  AppUpdateState
} from '../../shared/app-update'

export interface UpdateBackend {
  check(): Promise<AppRelease | null>
  download(onProgress: (progress: AppUpdateProgress) => void): Promise<void>
  install(): void
  openRelease(version?: string): Promise<void>
}

/** Owns update transitions independently of Electron and the renderer. */
export class ApplicationUpdater extends EventEmitter {
  private value: AppUpdateState
  private checking: Promise<AppUpdateState> | null = null
  private downloading: Promise<AppUpdateState> | null = null

  constructor(
    currentVersion: string,
    mode: AppUpdateMode,
    private readonly backend: UpdateBackend,
    private readonly installationBlocker: () => string | null
  ) {
    super()
    this.value = {
      revision: 0,
      mode,
      status: 'idle',
      currentVersion,
      release: null,
      progress: null,
      checkedAt: null,
      error: null
    }
  }

  get state(): AppUpdateState {
    return structuredClone(this.value)
  }

  private patch(patch: Partial<AppUpdateState>): AppUpdateState {
    this.value = { ...this.value, ...patch, revision: this.value.revision + 1 }
    const state = this.state
    this.emit('state', state)
    return state
  }

  check(): Promise<AppUpdateState> {
    if (this.checking) return this.checking
    if (['downloading', 'downloaded', 'installing'].includes(this.value.status))
      return Promise.resolve(this.state)
    if (this.value.mode === 'development') {
      return Promise.resolve(
        this.patch({ status: 'error', error: '开发环境不检查程序升级，请使用正式发行版本。' })
      )
    }
    this.patch({ status: 'checking', error: null, progress: null })
    this.checking = this.performCheck().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async performCheck(): Promise<AppUpdateState> {
    try {
      const release = await this.backend.check()
      if (release && (!valid(release.version) || prerelease(release.version)))
        throw new Error('更新源返回了无效的正式版本号')
      const newer = release && gt(release.version, this.value.currentVersion)
      return this.patch({
        status: newer ? 'available' : 'not-available',
        release: newer ? release : null,
        checkedAt: new Date().toISOString(),
        error: null
      })
    } catch (cause) {
      const code = (cause as { code?: string })?.code
      const unpublished = [
        'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      ].includes(code || '')
      return this.patch({
        status: 'error',
        error: unpublished
          ? '发布页尚未提供可用的正式升级包，请稍后重试或前往发布页查看。'
          : '检查失败，请检查网络或代理设置后重试。也可以打开发布页手动下载。'
      })
    }
  }

  download(): Promise<AppUpdateState> {
    if (this.downloading) return this.downloading
    if (
      this.value.mode !== 'installer' ||
      !this.value.release ||
      !['available', 'error'].includes(this.value.status)
    )
      return Promise.resolve(this.state)
    this.patch({ status: 'downloading', progress: null, error: null })
    this.downloading = this.performDownload().finally(() => {
      this.downloading = null
    })
    return this.downloading
  }

  private async performDownload(): Promise<AppUpdateState> {
    try {
      await this.backend.download((progress) => {
        this.patch({
          progress: {
            ...progress,
            percent: Math.max(0, Math.min(100, progress.percent))
          }
        })
      })
      return this.patch({ status: 'downloaded', error: null })
    } catch {
      return this.patch({
        status: 'error',
        error: '下载或校验失败，安装包未就绪。请检查网络、代理和磁盘空间后重试。'
      })
    }
  }

  install(): AppUpdateState {
    if (this.value.mode !== 'installer' || this.value.status !== 'downloaded') return this.state
    const reason = this.installationBlocker()
    if (reason) return this.patch({ error: reason })
    this.patch({ status: 'installing', error: null })
    try {
      this.backend.install()
      return this.state
    } catch {
      return this.patch({
        status: 'downloaded',
        error: '无法启动安装程序，请重试或从发布页手动下载安装。'
      })
    }
  }

  installationFailed(): void {
    if (this.value.status === 'installing') {
      this.patch({
        status: 'downloaded',
        error: '无法启动安装程序，请重试或从发布页手动下载安装。'
      })
    }
  }

  openRelease(): Promise<void> {
    return this.backend.openRelease(this.value.release?.version)
  }
}
