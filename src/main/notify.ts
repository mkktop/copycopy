import { BrowserWindow, Notification } from 'electron'
import { IPC } from '../shared/ipc'
import type { QueueIdleInfo } from './download/queue'
import { loadConfig } from './config'
import { logger } from './logger'

/**
 * 下载完成通知。
 *
 * 后台跑几十分钟很常见，跑完了没有任何提示是最容易被抱怨的点。
 * 全部失败或者只跑了不到一分钟不打扰用户。
 */

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${total % 60} 秒`
  return `${total} 秒`
}

export function notifyQueueIdle(info: QueueIdleInfo): void {
  try {
    if (loadConfig().global.notify_on_done !== 1) return
    if (!Notification.isSupported()) return

    const { done, failed, canceled, elapsed } = info
    if (done + failed + canceled === 0) return

    const parts: string[] = []
    if (done > 0) parts.push(`完成 ${done} 章`)
    if (failed > 0) parts.push(`失败 ${failed} 章`)
    if (canceled > 0) parts.push(`取消 ${canceled} 章`)

    const body = `${parts.join('，')} · 耗时 ${fmtDuration(elapsed)}`
    const n = new Notification({
      title: failed > 0 ? '下载结束（部分失败）' : '下载完成',
      body,
      silent: false
    })
    n.on('click', () => {
      // 点击跳到下载队列页
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        if (win.isMinimized()) win.restore()
        win.focus()
        win.webContents.send(IPC.eventNavigate, '/downloads')
        break
      }
    })
    n.show()
  } catch (e) {
    logger.warn('发送完成通知失败: ' + String(e))
  }
}
