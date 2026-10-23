// This factory is substituted by esbuild in the test runner only. It is never
// imported by the production build and exposes no test switches through IPC.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { createApplicationUpdater as createRealUpdater } from '../../src/main/update/index'
import { ApplicationUpdater } from '../../src/main/update/controller'

export function createApplicationUpdater(): ApplicationUpdater {
  const data = process.env.MKK_DATA_DIR!
  const base = process.env.MKK_UPDATE_FIXTURE_URL!
  const openRelease = async (version?: string): Promise<void> => {
    fs.writeFileSync(path.join(data, 'opened-release.txt'), version || 'releases')
  }
  if (process.env.MKK_UPDATE_FIXTURE_MODE === 'portable') {
    return new ApplicationUpdater(
      app.getVersion(),
      'portable',
      {
        async check() {
          const response = await fetch(`${base}/release.json`)
          return response.json()
        },
        async download() {
          throw new Error('Portable must not download installers')
        },
        install() {
          throw new Error('Portable must not install')
        },
        openRelease
      },
      () => null
    )
  }
  const updater = new NsisUpdater({ provider: 'generic', url: base })
  updater.forceDevUpdateConfig = true
  updater.disableDifferentialDownload = true
  updater.logger = null
  updater.on('error', (error) => console.error('UPDATER_FIXTURE:', error.message))
  const updateConfigPath = path.join(data, 'update-config.yml')
  updater.updateConfigPath = updateConfigPath
  fs.writeFileSync(
    updateConfigPath,
    JSON.stringify({ provider: 'generic', url: base, updaterCacheDirName: 'fixture' })
  )
  Object.defineProperty((updater as unknown as { app: object }).app, 'baseCachePath', {
    value: path.join(data, 'update-cache')
  })
  updater.quitAndInstall = () => {
    fs.writeFileSync(path.join(data, 'install-requested'), 'yes')
  }
  return createRealUpdater({
    updater,
    mode: 'installer',
    blocker: () =>
      fs.existsSync(path.join(data, 'busy')) ? 'PDF 正在导出，请等待导出完成后再安装。' : null,
    openRelease
  })
}
