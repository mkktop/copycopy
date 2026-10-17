import { defineStore } from 'pinia'
import { useAppStore } from './app'

/**
 * AI 广告检测队列。
 *
 * 之前只是个进度计数，且 worker 循环长在 LibraryComicView 里：
 * 检测没跑完就离开页面，进度"消失"但循环还在后台空转。
 * 现在队列状态和 worker 都收进全局 store——
 * 检测队列页、标签栏药丸、详情页进度条看到的是同一份实时状态，
 * 任何页面发起/取消/重试都作用在同一条队列上。
 */

export type AiItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'canceled'

export interface AiQueueItem {
  chapterName: string
  status: AiItemStatus
  /** 本章归档掉的广告页数 */
  moved: number
  error?: string
}

export interface AiRun {
  comicName: string
  items: AiQueueItem[]
  startedAt: number
  /** null = 还在跑 */
  finishedAt: number | null
  /** 用户点了取消：不再领新任务，已发出的检测照常收尾 */
  canceled: boolean
  /** 单章检测（force 重跑，不读 adCheckedAt 缓存） */
  force: boolean
}

type DetectOutcome = Awaited<ReturnType<Window['mkk']['aiDetectChapter']>>

/** 并发上限：跟设置里的 ai_concurrency 走，改动即时生效 */
function workerCount(): number {
  const n = useAppStore().config?.global.ai_concurrency ?? 3
  return Math.max(1, Math.min(5, n))
}

export const useAiStore = defineStore('ai', {
  state: () => ({
    /** 各漫画的检测批次，含正在跑的和最近跑完的（保留给队列页看结果） */
    runs: [] as AiRun[]
  }),
  getters: {
    activeRuns: (s): AiRun[] => s.runs.filter((r) => r.finishedAt === null),
    busy: (s): boolean => s.runs.some((r) => r.finishedAt === null),
    /** 标签栏药丸用的聚合进度（只算正在跑的批次） */
    pillDone: (s): number =>
      s.runs
        .filter((r) => r.finishedAt === null)
        .reduce((a, r) => a + r.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length, 0),
    pillTotal: (s): number =>
      s.runs
        .filter((r) => r.finishedAt === null)
        .reduce((a, r) => a + r.items.length, 0)
  },
  actions: {
    runOf(comicName: string): AiRun | null {
      return this.runs.find((r) => r.comicName === comicName) ?? null
    },
    isActive(comicName: string): boolean {
      const r = this.runOf(comicName)
      return !!r && r.finishedAt === null
    },

    /** worker 领任务：把下一个 pending 标成 running 并返回章节名 */
    claimNext(comicName: string): string | null {
      const r = this.runOf(comicName)
      if (!r || r.finishedAt !== null || r.canceled) return null
      const item = r.items.find((i) => i.status === 'pending')
      if (!item) return null
      item.status = 'running'
      return item.chapterName
    },

    completeItem(comicName: string, chapterName: string, res: DetectOutcome): void {
      const item = this.runOf(comicName)?.items.find((i) => i.chapterName === chapterName)
      if (!item) return
      if (res.ok) {
        item.status = 'done'
        item.moved = res.moved
      } else if (res.skipped) {
        item.status = 'skipped'
        item.moved = 0
        item.error = res.error
      } else {
        item.status = 'failed'
        item.moved = 0
        item.error = res.error
      }
    },

    /** 取消：pending 一律标记取消，正在检测的几章照常收尾 */
    cancel(comicName: string): void {
      const r = this.runOf(comicName)
      if (!r || r.finishedAt !== null) return
      r.canceled = true
      for (const i of r.items) if (i.status === 'pending') i.status = 'canceled'
    },

    /** 丢掉一条已结束的批次记录（正在跑的不允许） */
    removeRun(comicName: string): void {
      this.runs = this.runs.filter((r) => r.comicName !== comicName || r.finishedAt === null)
    },
    clearFinished(): void {
      this.runs = this.runs.filter((r) => r.finishedAt === null)
    },

    /**
     * 发起一次检测并等它跑完。worker 循环在 store 里，
     * 离开发起页面也照常推进；调用方 await 拿到的是整批完成后的批次记录。
     */
    async runDetection(
      comicName: string,
      chapters: string[],
      opts: { force?: boolean } = {}
    ): Promise<AiRun | null> {
      if (!comicName || chapters.length === 0) return null
      if (this.isActive(comicName)) return this.runOf(comicName)

      // 同一部重复检测时，旧批次记录（已结束的）被新批次顶掉，队列页不留重复
      this.removeRun(comicName)
      this.runs.push({
        comicName,
        items: chapters.map((c) => ({ chapterName: c, status: 'pending', moved: 0 })),
        startedAt: Date.now(),
        finishedAt: null,
        canceled: false,
        force: opts.force === true
      })

      await this.drain(comicName, opts.force === true)
      const r = this.runOf(comicName)
      if (r && r.finishedAt === null) r.finishedAt = Date.now()
      return r
    },

    /** 把失败/取消的章节重新排入并再跑一轮 */
    async retryFailed(comicName: string): Promise<void> {
      const r = this.runOf(comicName)
      if (!r || r.finishedAt !== null) return
      const again = r.items.filter((i) => i.status === 'failed' || i.status === 'canceled')
      if (again.length === 0) return
      for (const i of again) {
        i.status = 'pending'
        i.error = undefined
        i.moved = 0
      }
      r.canceled = false
      r.startedAt = Date.now()
      r.finishedAt = null

      await this.drain(comicName, r.force)
      if (r.finishedAt === null) r.finishedAt = Date.now()
    },

    /** worker 池跑到该批次没有 pending 为止（取消或全部完成） */
    async drain(comicName: string, force: boolean): Promise<void> {
      const runOne = async (): Promise<void> => {
        for (;;) {
          const ch = this.claimNext(comicName)
          if (!ch) return
          try {
            const res = await window.mkk.aiDetectChapter(comicName, ch, force)
            this.completeItem(comicName, ch, res)
          } catch (e) {
            this.completeItem(comicName, ch, {
              ok: false,
              skipped: false,
              moved: 0,
              ads: [],
              error: String(e),
              elapsedMs: 0
            })
          }
        }
      }
      const n = Math.min(workerCount(), this.runOf(comicName)?.items.length ?? 1)
      await Promise.all(Array.from({ length: n }, runOne))
    }
  }
})
