import { app, shell } from 'electron'
import { autoUpdater, type AppUpdater, type UpdateInfo } from 'electron-updater'
import { fetch } from 'undici'
import type { AppRelease, AppUpdateMode } from '../../shared/app-update'
import { aiActiveCount } from '../ai/ad-service'
import { pdfActiveCount } from '../download/pdf'
import { queue } from '../download/queue'
import { getCurrentProxy } from '../proxy'
import { ApplicationUpdater, type UpdateBackend } from './controller'

const RELEASES_URL = 'https://github.com/mkktop/copycopy/releases'
const LATEST_API = 'https://api.github.com/repos/mkktop/copycopy/releases/latest'

function releaseFromInfo(info: UpdateInfo): AppRelease {
  const notes = info.releaseNotes
  return {
    version: info.version,
    notes:
      typeof notes === 'string' ? notes : notes?.map((note) => note.note || '').join('\n\n') || '',
    publishedAt: info.releaseDate
  }
}

export function installationBlocker(): string | null {
  if (queue.isBusy()) return '漫画仍在下载，请等待任务完成或取消下载后再安装。'
  if (aiActiveCount() > 0) return 'AI 广告整理仍在运行，请等待整理完成后再安装。'
  if (pdfActiveCount() > 0) return 'PDF 正在导出，请等待导出完成后再安装。'
  return null
}

/** The updater has its own Electron session; undici proxy settings do not affect it. */
async function configureProxy(updater: AppUpdater): Promise<void> {
  const proxy = getCurrentProxy()
  await updater.netSession.setProxy(
    proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'direct' }
  )
}

export function createApplicationUpdater(
  options: {
    updater?: AppUpdater
    mode?: AppUpdateMode
    blocker?: () => string | null
    openRelease?: (version?: string) => Promise<void>
  } = {}
): ApplicationUpdater {
  const mode =
    options.mode ??
    (!app.isPackaged
      ? 'development'
      : process.platform !== 'win32'
        ? 'manual'
        : process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE
          ? 'portable'
          : 'installer')
  const updater = options.updater ?? autoUpdater
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.disableWebInstaller = true

  const backend: UpdateBackend = {
    async check() {
      if (mode === 'installer') {
        await configureProxy(updater)
        const result = await updater.checkForUpdates()
        if (!result) throw new Error('Update metadata unavailable')
        return releaseFromInfo(result.updateInfo)
      }
      const response = await fetch(LATEST_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `CopyCopy/${app.getVersion()}`
        },
        signal: AbortSignal.timeout(20000)
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 404) {
          throw Object.assign(new Error('No published release'), {
            code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
          })
        }
        throw new Error(`Release request failed: ${response.status}`)
      }
      const release = (await response.json()) as {
        tag_name?: string
        body?: string
        published_at?: string
        draft?: boolean
        prerelease?: boolean
      }
      if (!release.tag_name || release.draft || release.prerelease)
        throw new Error('No stable release available')
      return {
        version: release.tag_name.replace(/^v/, ''),
        notes: typeof release.body === 'string' ? release.body : '',
        publishedAt: release.published_at
      }
    },
    async download(onProgress) {
      await configureProxy(updater)
      updater.on('download-progress', onProgress)
      try {
        await updater.downloadUpdate()
      } finally {
        updater.removeListener('download-progress', onProgress)
      }
    },
    install() {
      updater.quitAndInstall(false, true)
    },
    openRelease:
      options.openRelease ??
      ((version) =>
        shell.openExternal(
          version ? `${RELEASES_URL}/tag/v${encodeURIComponent(version)}` : RELEASES_URL
        ))
  }
  const controller = new ApplicationUpdater(
    app.getVersion(),
    mode,
    backend,
    options.blocker ?? installationBlocker
  )
  // Installation failures may be emitted instead of thrown by the native updater.
  updater.on('error', () => controller.installationFailed())
  return controller
}
