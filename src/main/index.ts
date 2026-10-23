import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { registerIpc } from './ipc'
import { loadConfig } from './config'
import { logger } from './logger'
import { initBaseDir } from './paths'
import { setupProxy } from './proxy'
import { startScheduler } from './scheduler'
import { queue } from './download/queue'
import { notifyQueueIdle } from './notify'
import {
  registerLibraryProtocol,
  registerRemoteProtocol,
  registerSchemes
} from './media-protocol'
import { checkUpdates } from './track'

let mainWindow: BrowserWindow | null = null

// 自定义协议必须在 app ready 之前登记，否则 <img src="library://..."> 会被拦掉
registerSchemes()

/**
 * 窗口图标。
 *
 * 之前写死 path.join(__dirname, '../../resources/icon.png')，但 resources/ 下
 * 只有证书，图标在 build/（那是 electron-builder 的 buildResources 目录），
 * 于是开发态和打包态都取不到，窗口一直没有图标。
 * 现在按实际布局分两种情况找，找不到就不传——传个不存在的路径只会让 Electron 刷警告。
 */
function resolveIcon(): string | undefined {
  const candidates = [
    // 开发态：主进程产物在 out/main，往上两层是项目根
    path.join(__dirname, '../../build/icon.png'),
    // 打包态：extraResources 落在 exe 旁边的 resources/
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'icon.png')] : [])
  ]
  return candidates.find((p) => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  })
}

function createWindow(): void {
  const icon = resolveIcon()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    // 之前 1000×640，对 1366×768 的笔记本偏紧，横向挤得慌。
    // 900×600 仍能容下搜索页的搜索框 + 4 个菜单项，窄屏上更从容。
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161820' : '#f6f7fa',
    title: 'CopyCopy',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const wc = mainWindow.webContents

  // 外链一律用系统浏览器打开
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 窗口内导航一律拦掉。
  // 之前只挡了 window.open，主窗口还是能跳到外部页面——而 preload 会跟着一起过去，
  // 那个页面就白拿了整套 window.mkk 桥接（读图、删漫画、改配置）。
  wc.on('will-navigate', (event, url) => {
    const current = wc.getURL()
    if (url !== current) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  wc.on('will-redirect', (event) => event.preventDefault())
  // 也不允许挂 webview
  wc.on('will-attach-webview', (event) => event.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void wc.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void wc.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initBaseDir()
  const config = loadConfig()
  logger.info('===== 应用启动 =====')
  registerLibraryProtocol()
  registerRemoteProtocol()
  // fetch 不读系统代理，必须自己挂上
  setupProxy()
  registerIpc()

  // 队列跑完发系统通知
  queue.on('idle', (info) => notifyQueueIdle(info))

  // 恢复上次没下完的（图片还在盘上，重跑会走断点续传）
  queue.restore()

  createWindow()

  if (config.global.auto_check_on_launch === 1) {
    setTimeout(() => {
      void checkUpdates().catch((e) => logger.error('启动检查更新失败: ' + String(e)))
    }, 3000)
  }
  startScheduler()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => logger.dispose())
