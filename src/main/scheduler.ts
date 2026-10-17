import { loadConfig } from './config'
import { logger } from './logger'
import { queue } from './download/queue'
import { checkUpdates } from './track'

/**
 * 定时检查追更。
 *
 * 原版靠 GitHub Actions 定时，桌面端没有那个东西。
 * 这里用单个长 setTimeout 自我续期：比 setInterval 好，
 * 错过的窗口不会堆积成一串连续补跑。
 *
 * 间隔为 0 表示不启用。
 */

let timer: NodeJS.Timeout | null = null
/** 跑检查期间置位，避免手动点"检查更新"和定时器撞在一起重复入队 */
let running = false

function fmtAt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function startScheduler(): void {
  reschedule()
}

export function reschedule(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }

  const hours = loadConfig().global.auto_check_interval_hours
  if (!hours || hours <= 0) {
    logger.info('定时追更未启用')
    return
  }

  const ms = hours * 3600_000
  const at = Date.now() + ms
  logger.info(`定时追更已启用：每 ${hours} 小时检查一次，下次 ${fmtAt(at)}`)
  timer = setTimeout(() => void tick(), ms)
  // 别因为挂着一个长定时器就让窗口关不掉
  timer.unref?.()
}

async function tick(): Promise<void> {
  if (!running) {
    running = true
    try {
      // 队列正忙就跳过这一轮，等下一轮
      if (queue.isBusy()) {
        logger.info('下载队列正忙，本次定时检查跳过')
      } else {
        logger.info('===== 定时检查更新 =====')
        await checkUpdates()
      }
    } catch (e) {
      logger.error('定时检查失败: ' + String(e))
    } finally {
      running = false
      reschedule()
    }
  } else {
    reschedule()
  }
}
