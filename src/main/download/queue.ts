import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import type { DownloadTask, TaskProgress } from '../../shared/types'
import { getChapterPages, getComic } from '../api/copymanga'
import { IMAGE_HEADERS } from '../api/copymanga'
import { loadConfig, markChapterDownloaded } from '../config'
import { coverPathFor, ensureChapterDir, ADS_DIR } from '../library'
import { readMeta, rememberChapterResult, rememberComic } from '../meta'
import { detectAdsForChapter } from '../ai/ad-service'
import { logger } from '../logger'
import { getQueuePath } from '../paths'
import { downloadImage, toJpegUrl } from './image'
import { makePdf } from './pdf'

export interface EnqueueRequest {
  /** 站点 path_word */
  comicPath: string
  /** 展示与建目录用的漫画名 */
  comicName: string
  /** 站点章节列表里的顺序，1 起 */
  chapterIndex: number
  chapterName: string
  uuid: string
  /** 是否作为追更任务（成功后推进 subscriptions 里的 last_chapter） */
  trackSubscription?: boolean
}

/** 一次批次跑完后抛给渲染层/通知的汇总 */
export interface QueueIdleInfo {
  done: number
  failed: number
  canceled: number
  elapsed: number
}

/** 队列里最多保留的历史任务，防止长时间运行后内存无限涨 */
const MAX_HISTORY = 500
/** 落盘节流间隔 */
const SAVE_DEBOUNCE_MS = 800

/**
 * 下载队列。
 *
 * 并发模型沿用原 Python 版：一章之内的图片并发 N 个，章节之间严格串行，
 * 且每章结束后随机等待几秒，避免触发站点限流。
 */
class DownloadQueue extends EventEmitter {
  private tasks = new Map<string, DownloadTask>()
  private order: string[] = []
  private running = false
  private canceled = new Set<string>()
  /** 每个任务一个 AbortController：取消时能真正掐断在途请求，而不是等它们跑完 */
  private aborters = new Map<string, AbortController>()
  private seq = 0
  /** 当前章节结束后的等待秒数，供 UI 展示倒计时 */
  private waitingSeconds = 0
  /** 本批次开始时间，用于算总耗时 */
  private batchStartedAt = 0
  private saveTimer: NodeJS.Timeout | null = null

  list(): DownloadTask[] {
    return this.order.map((id) => this.tasks.get(id)!).filter(Boolean)
  }

  /** 把任务提到队首（还在排队的） */
  moveTop(id: string): void {
    const i = this.order.indexOf(id)
    const task = this.tasks.get(id)
    if (i < 0 || !task || task.status !== 'pending') return
    this.order.splice(i, 1)
    this.order.unshift(id)
    logger.info(`已置顶 ${task.comicName} ${task.chapterName}`)
    this.emitAll()
    this.scheduleSave()
  }

  /** 清空整个队列，包含已完成的历史 */
  clearAll(): void {
    this.cancelAll()
    this.tasks.clear()
    this.order = []
    this.canceled.clear()
    this.aborters.clear()
    logger.info('已清空下载队列')
    this.emitAll()
    this.save()
  }

  stats(): TaskProgress['queue'] {
    let pending = 0
    let running = 0
    let done = 0
    let failed = 0
    for (const t of this.tasks.values()) {
      if (t.status === 'pending') pending++
      else if (t.status === 'running') running++
      else if (t.status === 'done') done++
      else if (t.status === 'failed') failed++
    }
    return { pending, running, done, failed }
  }

  /** 单个任务的最新进度事件 */
  private emitTask(task: DownloadTask, currentPage?: number): void {
    this.emit('progress', {
      task: { ...task },
      currentPage,
      waitingSeconds: this.waitingSeconds || undefined,
      queue: this.stats()
    } satisfies TaskProgress)
  }

  private emitAll(): void {
    for (const t of this.list()) this.emitTask(t)
  }

  enqueue(requests: EnqueueRequest[]): DownloadTask[] {
    const created: DownloadTask[] = []
    for (const req of requests) {
      // 同一章已在队列中就不重复加
      const dup = this.order.find((id) => {
        const t = this.tasks.get(id)
        return (
          t &&
          t.comicPath === req.comicPath &&
          t.uuid === req.uuid &&
          (t.status === 'pending' || t.status === 'running')
        )
      })
      if (dup) {
        logger.info(`队列中已存在 ${req.comicName} ${req.chapterName}，跳过重复添加`)
        continue
      }

      const id = `${req.comicPath}#${req.uuid}#${++this.seq}`
      const task: DownloadTask = {
        id,
        comicName: req.comicName,
        comicPath: req.comicPath,
        chapterName: req.chapterName,
        chapterIndex: req.chapterIndex,
        uuid: req.uuid,
        dir: ensureChapterDir(req.comicName, req.chapterName),
        status: 'pending',
        downloaded: 0,
        total: 0,
        skipped: 0,
        failedPages: [],
        track: req.trackSubscription === true
      }
      this.tasks.set(id, task)
      this.order.push(id)
      created.push(task)
    }

    if (created.length > 0) {
      if (this.batchStartedAt === 0) this.batchStartedAt = Date.now()
      this.trimHistory()
    }
    logger.info(`已加入下载队列：${created.length} 章`)
    this.emitAll()
    void this.run()
    this.scheduleSave()
    return created
  }

  /** 只保留最近的 MAX_HISTORY 条，避免长时间运行后内存无限涨 */
  private trimHistory(): void {
    if (this.order.length <= MAX_HISTORY) return
    const finished = this.order.filter((id) => {
      const s = this.tasks.get(id)?.status
      return s === 'done' || s === 'canceled' || s === 'failed'
    })
    // 从最旧的已完成开始丢，正在排队的绝不能动
    for (const id of finished.slice(0, this.order.length - MAX_HISTORY)) {
      this.tasks.delete(id)
      const i = this.order.indexOf(id)
      if (i >= 0) this.order.splice(i, 1)
    }
  }

  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status === 'done' || task.status === 'canceled') return
    this.canceled.add(id)
    // 掐断在途请求，否则取消后还要等满 5 次 × 30 秒的重试
    this.aborters.get(id)?.abort(new Error('用户取消'))
    if (task.status === 'pending') {
      task.status = 'canceled'
      task.finishedAt = Date.now()
      logger.info(`已取消 ${task.comicName} ${task.chapterName}`)
      this.emitTask(task)
    }
  }

  cancelAll(): void {
    for (const t of this.list()) this.cancel(t.id)
  }

  retry(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    // 允许重跑已完成的任务：用于补下被误删的页（断点续传）
    if (task.status === 'pending' || task.status === 'running') return
    this.canceled.delete(id)
    task.status = 'pending'
    task.downloaded = 0
    task.failedPages = []
    task.error = undefined
    task.finishedAt = undefined
    logger.info(`重新排队 ${task.comicName} ${task.chapterName}`)
    this.emitTask(task)
    void this.run()
  }

  retryAllFailed(): void {
    for (const t of this.list()) {
      if (t.status === 'failed') this.retry(t.id)
    }
  }

  removeFinished(): void {
    const keep: string[] = []
    for (const id of this.order) {
      const t = this.tasks.get(id)!
      if (t.status === 'done' || t.status === 'canceled') {
        this.tasks.delete(id)
        this.canceled.delete(id)
        this.aborters.delete(id)
      } else keep.push(id)
    }
    this.order = keep
    this.emitAll()
    this.scheduleSave()
  }

  isBusy(): boolean {
    return this.stats().pending > 0 || this.stats().running > 0
  }

  private nextPending(): DownloadTask | undefined {
    return this.order
      .map((id) => this.tasks.get(id)!)
      .find((t) => t.status === 'pending' && !this.canceled.has(t.id))
  }

  /** 队列主循环，串行消费 */
  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const task = this.nextPending()
        if (!task) break
        await this.processTask(task)
        // 队列已经空了就不用再空等一轮反限流间隔了
        if (this.nextPending()) await this.waitBetweenChapters()
      }
    } finally {
      this.waitingSeconds = 0
      this.running = false
      this.emitAll()
      this.save()
      this.emitIdleIfFinished()
      logger.info('===== 下载队列已清空 =====')
    }
  }

  /**
   * 本批次从"有活干"变成"没活干"时抛一次 idle 事件。
   * 只在真的处理过任务且耗时超过 5 秒时才抛，避免打开应用就弹通知。
   */
  private emitIdleIfFinished(): void {
    if (this.batchStartedAt === 0) return
    const elapsed = Date.now() - this.batchStartedAt
    this.batchStartedAt = 0
    if (elapsed < 5000) return

    const s = this.stats()
    const canceled = this.list().filter((t) => t.status === 'canceled').length
    if (s.done + s.failed === 0 && canceled === 0) return

    this.emit('idle', { done: s.done, failed: s.failed, canceled, elapsed } satisfies QueueIdleInfo)
  }

  /* ---------- 队列持久化 ---------- */

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  private save(): void {
    try {
      const tasks = this.list()
        // 只存还在排队的：已完成的没必要留，重启后重新加会走断点续传
        .filter((t) => t.status === 'pending')
        .map((t) => ({
          id: t.id,
          comicName: t.comicName,
          comicPath: t.comicPath,
          chapterName: t.chapterName,
          chapterIndex: t.chapterIndex,
          uuid: t.uuid,
          dir: t.dir,
          total: t.total,
          downloaded: t.downloaded,
          skipped: t.skipped,
          failedPages: t.failedPages,
          track: t.track
        }))
      const file = getQueuePath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ seq: this.seq, tasks }, null, 2), 'utf-8')
    } catch (e) {
      logger.warn('保存队列失败: ' + String(e))
    }
  }

  /** 启动时恢复未完成的队列。running 会被降级成 pending 重新排队。 */
  restore(): void {
    try {
      const file = getQueuePath()
      if (!fs.existsSync(file)) return
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        seq?: number
        tasks?: Array<Partial<DownloadTask>>
      }
      if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) return

      for (const t of raw.tasks) {
        if (!t.id || !t.uuid || !t.chapterName) continue
        // 目录可能已经被删了，恢复也没意义
        const dir = ensureChapterDir(String(t.comicName ?? ''), String(t.chapterName))
        const task: DownloadTask = {
          id: String(t.id),
          comicName: String(t.comicName ?? ''),
          comicPath: String(t.comicPath ?? ''),
          chapterName: String(t.chapterName),
          chapterIndex: Number(t.chapterIndex ?? 0),
          uuid: String(t.uuid),
          dir,
          status: 'pending',
          downloaded: Number(t.downloaded ?? 0),
          total: Number(t.total ?? 0),
          skipped: Number(t.skipped ?? 0),
          failedPages: Array.isArray(t.failedPages) ? t.failedPages : [],
          track: t.track === true
        }
        this.tasks.set(task.id, task)
        this.order.push(task.id)
      }
      this.seq = Math.max(this.seq, Number(raw.seq ?? 0))
      logger.info(`已恢复上次未完成的队列：${raw.tasks.length} 章，开始继续下载`)
      this.emitAll()
      // 不 run() 的话恢复出来的任务会一直躺着，直到用户手动操作才动
      this.batchStartedAt = Date.now()
      void this.run()
    } catch (e) {
      logger.warn('恢复队列失败: ' + String(e))
    }
  }

  /** 章节间随机等待，反限流；界面要显示倒计时所以分片等待 */
  private async waitBetweenChapters(): Promise<void> {
    const cfg = loadConfig()
    const min = cfg.global.chapter_delay_min
    const max = Math.max(min, cfg.global.chapter_delay_max)
    if (max <= 0) return

    const total = min + Math.random() * (max - min)
    logger.info(`章节之间随机等待 ${total.toFixed(1)} 秒，避免触发限流…`)
    this.emitAll()

    const endAt = Date.now() + total * 1000
    while (Date.now() < endAt) {
      if (!this.nextPending()) break // 等待期间被清空了就不用继续
      this.waitingSeconds = Math.max(0, (endAt - Date.now()) / 1000)
      await sleep(200)
    }
    this.waitingSeconds = 0
  }

  private async processTask(task: DownloadTask): Promise<void> {
    task.status = 'running'
    task.startedAt = Date.now()
    task.error = undefined
    this.emitTask(task)

    const cfg = loadConfig()
    const aborter = new AbortController()
    this.aborters.set(task.id, aborter)
    const signal = aborter.signal

    try {
      // 1. 取章节页表
      const pages = await getChapterPages(task.comicPath, task.uuid)
      if (!pages.ok) {
        this.failTask(task, `获取章节页面失败：${pages.error}`)
        return
      }

      if (this.canceled.has(task.id)) {
        this.finishCanceled(task)
        return
      }

      const urls = pages.data.urls
      task.total = urls.length
      const comicDirName = pages.data.comicName || task.comicName
      const dir = ensureChapterDir(comicDirName, task.chapterName)
      task.dir = dir
      logger.info(`开始下载《${pages.data.comicName}》${task.chapterName}，共 ${urls.length} 页`)
      this.emitTask(task)

      // 顺手把站点身份落盘：path_word 之后补封面、查更新都靠它，
      // 不用再拿目录名去搜索站反查
      rememberComic(comicDirName, {
        pathWord: task.comicPath,
        name: pages.data.comicName
      })

      // 顺手缓存封面，漫画库卡片要用
      void this.fetchCover(task.comicPath, comicDirName)

      // 2. 并发下载，限制并发数
      const concurrency = cfg.global.concurrency
      // 已经被判定为广告的页（移进了 _ads/）不要再下回来。
      // 原来 001.jpg 被挪走后，续传判定"文件不存在"就会把广告页重新下一遍。
      const adPages = new Set(readMeta(comicDirName)?.chapters?.[task.chapterName]?.ads ?? [])
      let nextIndex = 0
      task.downloaded = 0
      task.skipped = 0
      task.failedPages = []

      const worker = async (): Promise<void> => {
        for (;;) {
          if (this.canceled.has(task.id)) return
          const i = nextIndex++
          if (i >= urls.length) return

          const pageNum = i + 1
          // 广告页：在 _ads/ 里就算"已完成"，别再下一遍
          if (adPages.has(pageNum) && hasArchivedAd(dir, pageNum)) {
            task.skipped++
            this.emitTask(task, pageNum)
            continue
          }

          const res = await downloadImage(urls[i], dir, pageNum, signal)

          if (res.canceled) return
          if (res.ok) {
            if (res.skipped) task.skipped++
            else task.downloaded++
          } else {
            task.failedPages.push(pageNum)
          }
          this.emitTask(task, pageNum)
        }
      }

      const workers = Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, () =>
        worker()
      )
      await Promise.all(workers)

      // 3. 收尾
      if (this.canceled.has(task.id)) {
        this.finishCanceled(task)
        return
      }

      // 失败页要记进元信息：否则这一章在库里和"本来就短"长得一样，
      // 之后也没法只补缺的那几页
      rememberChapterResult(comicDirName, task.chapterName, {
        uuid: task.uuid,
        total: task.total,
        failed: task.failedPages
      })

      const failed = task.failedPages.length
      if (failed > 0) {
        task.status = 'failed'
        task.error = `失败 ${failed} 页：${task.failedPages.slice(0, 20).join(', ')}`
        task.finishedAt = Date.now()
        logger.warn(
          `《${task.comicName}》${task.chapterName} 完成，但有 ${failed} 页失败` +
            `（已下载 ${task.downloaded}，跳过 ${task.skipped}）`
        )
        this.emitTask(task)
        return
      }

      task.status = 'done'
      task.finishedAt = Date.now()
      logger.info(
        `《${task.comicName}》${task.chapterName} 下载完成` +
          `（新下载 ${task.downloaded} 页${task.skipped ? `，跳过已有 ${task.skipped} 页` : ''}）`
      )
      this.emitTask(task)

      // 4. 追更任务才推进订阅进度（手动浏览下载不动 last_chapter），立即落盘保证崩溃安全
      if (task.track) {
        markChapterDownloaded(task.comicPath, task.chapterIndex)
      }

      // 4.5 AI 广告识别。必须在生成 PDF 之前，否则导出的 PDF 里还带着广告。
      //     fail-open：检测失败会自行跳过，不影响这一章的其它流程。
      if (cfg.global.ai_enabled === 1 && cfg.global.ai_auto_detect === 1) {
        try {
          const r = await detectAdsForChapter(comicDirName, task.chapterName)
          if (r.ok && r.moved > 0) {
            logger.info(`《${comicDirName}》${task.chapterName} 已归档 ${r.moved} 页广告`)
          }
        } catch (e) {
          logger.warn('广告检测异常: ' + String(e))
        }
      }

      // 5. 按配置生成 PDF
      if (cfg.global.pdf_switch === 1) {
        const res = await makePdf(dir, { password: cfg.global.pdf_password })
        if (!res.ok) logger.warn('PDF 生成失败: ' + res.error)
      }
    } finally {
      this.aborters.delete(task.id)
    }
  }

  private finishCanceled(task: DownloadTask): void {
    task.status = 'canceled'
    task.finishedAt = Date.now()
    logger.info(`已取消 ${task.comicName} ${task.chapterName}`)
    this.emitTask(task)
  }

  private failTask(task: DownloadTask, error: string): void {
    task.status = 'failed'
    task.error = error
    task.finishedAt = Date.now()
    logger.error(`${task.comicName} ${task.chapterName} -> ${error}`)
    this.emitTask(task)
  }

  /** 下载并缓存封面，已有则跳过 */
  private async fetchCover(comicPath: string, comicName: string): Promise<void> {
    const target = coverPathFor(comicName)
    try {
      if (fs.existsSync(target) && fs.statSync(target).size > 0) return
      const res = await getComic(comicPath)
      const cover = res.ok ? res.data?.cover : undefined
      if (!cover) return
      const r = await fetch(toJpegUrl(cover), {
        headers: IMAGE_HEADERS,
        signal: AbortSignal.timeout(20_000)
      })
      if (!r.ok) return
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 1024) return // 多半是错误页
      // 目录可能还没建出来（漫画名带非法字符时）
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buf)
      logger.info(`已缓存《${comicName}》封面`)
    } catch {
      /* 封面失败不影响下载 */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 某页的广告文件是否真的躺在 _ads/ 里。
 * 元信息和磁盘可能不同步（比如用户手动挪过），所以以磁盘为准。
 */
function hasArchivedAd(chapterDir: string, page: number): boolean {
  const name = `${String(page).padStart(3, '0')}.jpg`
  try {
    return fs.existsSync(path.join(chapterDir, ADS_DIR, name))
  } catch {
    return false
  }
}

/** 生成一段连续的章节序号范围 */
export function expandRange(from: number, to: number): number[] {
  const a = Math.min(from, to)
  const b = Math.max(from, to)
  const out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

export const queue = new DownloadQueue()
