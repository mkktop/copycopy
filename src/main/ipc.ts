import { BrowserWindow, ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC, type AppPaths, type EnqueuePayload, type PdfExportPayload } from '../shared/ipc'
import type { AppConfig } from '../shared/types'
import * as api from './api/copymanga'
import type { SearchType } from './api/copymanga'
import { loadConfig, removeSubscription, saveConfig, AI_MODELS } from './config'
import { queue, type EnqueueRequest } from './download/queue'
import { makePdf } from './download/pdf'
import {
  deleteChapter,
  deleteChapters,
  deleteComic,
  listChapterFiles,
  listIncompleteChapters,
  listLibrary,
  syncCover
} from './library'
import { logger } from './logger'
import { getBaseDir, getConfigPath, getLogDir, getOutDir } from './paths'
import { getCurrentProxy, setupProxy } from './proxy'
import { reschedule } from './scheduler'
import { decryptSecret, encryptSecret } from './secrets'
import { testConnection } from './ai/client'
import {
  detectAdsForChapter,
  listUncheckedChapters,
  undoAdsForChapter
} from './ai/ad-service'
import { resolveInside } from './safe-path'
import { checkUpdates, subscribe } from './track'

/** 转发进度事件到所有窗口 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function toRequests(items: EnqueuePayload[]): EnqueueRequest[] {
  return items.map((i) => ({
    comicPath: i.comicPath,
    comicName: i.comicName,
    chapterIndex: i.chapterIndex,
    chapterName: i.chapterName,
    uuid: i.uuid,
    trackSubscription: i.trackSubscription
  }))
}

export function registerIpc(): void {
  /* ---------- 站点 API ---------- */
  ipcMain.handle(IPC.search, (_e, keyword: string, page?: number, qType?: string) =>
    api.searchComic(String(keyword ?? ''), clampPage(page), normalizeSearchType(qType))
  )
  ipcMain.handle(IPC.comic, (_e, pathWord: string) => api.getComic(String(pathWord ?? '')))
  ipcMain.handle(IPC.chapters, (_e, pathWord: string, page?: number) =>
    api.getChapters(String(pathWord ?? ''), clampPage(page))
  )

  /* ---------- 下载队列 ---------- */
  ipcMain.handle(IPC.queueEnqueue, (_e, items: EnqueuePayload[]) =>
    queue.enqueue(toRequests(Array.isArray(items) ? items : []))
  )
  ipcMain.handle(IPC.queueList, () => queue.list())
  ipcMain.handle(IPC.queueCancel, (_e, id: string) => queue.cancel(String(id)))
  ipcMain.handle(IPC.queueCancelAll, () => queue.cancelAll())
  ipcMain.handle(IPC.queueRetry, (_e, id: string) => queue.retry(String(id)))
  ipcMain.handle(IPC.queueRetryFailed, () => queue.retryAllFailed())
  ipcMain.handle(IPC.queueRemoveFinished, () => queue.removeFinished())
  ipcMain.handle(IPC.queueMoveTop, (_e, id: string) => queue.moveTop(String(id)))
  ipcMain.handle(IPC.queueClear, () => queue.clearAll())

  /* ---------- 漫画库 ---------- */
  ipcMain.handle(IPC.libraryList, () => listLibrary())
  ipcMain.handle(IPC.libraryDeleteChapter, (_e, comicName: string, chapterName: string) =>
    deleteChapter(String(comicName ?? ''), String(chapterName ?? ''))
  )
  ipcMain.handle(
    IPC.libraryDeleteChapters,
    (_e, items: Array<{ comicName: string; chapterName: string }>) =>
      deleteChapters(Array.isArray(items) ? items : [])
  )
  ipcMain.handle(IPC.librarySyncCover, (_e, comicName: string) => syncCover(String(comicName ?? '')))
  ipcMain.handle(IPC.libraryDeleteComic, (_e, comicName: string) =>
    deleteComic(String(comicName ?? ''))
  )
  ipcMain.handle(IPC.libraryChapterFiles, (_e, dir: string) => listChapterFiles(String(dir ?? '')))
  ipcMain.handle(IPC.libraryRetryMissing, () => {
    const items = listIncompleteChapters()
    if (items.length === 0) return 0
    const created = queue.enqueue(
      items.map((c) => ({
        comicPath: c.comicPath,
        comicName: c.comicName,
        // 补缺页时章节序号不重要，库里的排序靠目录名
        chapterIndex: 0,
        chapterName: c.chapterName,
        uuid: c.uuid
      }))
    )
    logger.info(`已把 ${created.length} 个缺页章节重新排进队列`)
    return created.length
  })
  ipcMain.handle(
    IPC.libraryExportPdf,
    async (
      _e,
      dirs: string[],
      opts: { password?: string | null; useGlobalPassword?: boolean }
    ) => {
      const cfg = loadConfig()
      const password = opts?.useGlobalPassword ? cfg.global.pdf_password : opts?.password
      let ok = 0
      let failed = 0
      let lastError: string | undefined
      for (const dir of Array.isArray(dirs) ? dirs : []) {
        // 导出目标同样要锁在 out/ 之内，否则会往任意路径写文件
        const target = resolveInside(getOutDir(), String(dir))
        if (!target) {
          failed++
          lastError = '导出路径超出下载目录'
          continue
        }
        const res = await makePdf(target, { password })
        if (res.ok) ok++
        else {
          failed++
          lastError = res.error
        }
      }
      return { ok, failed, error: lastError }
    }
  )
  ipcMain.handle(IPC.libraryOpenPath, async (_e, target: string) => {
    // 只允许打开 out/ 之内的路径
    const resolved = resolveInside(getOutDir(), String(target ?? ''))
    if (!resolved) return '仅允许打开下载目录内的路径'
    let toOpen = resolved
    try {
      const stat = await fs.promises.stat(resolved)
      if (!stat.isDirectory()) toOpen = path.dirname(resolved)
    } catch {
      return '路径不存在'
    }
    return await shell.openPath(toOpen)
  })
  ipcMain.handle(IPC.libraryOpenPdf, async (_e, pdfPath: string) => {
    // PDF 也在 out/ 之内，交给系统默认阅读器打开
    const resolved = resolveInside(getOutDir(), String(pdfPath ?? ''))
    if (!resolved) return '仅允许打开下载目录内的路径'
    if (!fs.existsSync(resolved)) return 'PDF 不存在'
    return await shell.openPath(resolved)
  })

  /* ---------- PDF ---------- */
  ipcMain.handle(IPC.pdfExport, async (_e, payload: PdfExportPayload) => {
    const cfg = loadConfig()
    const password = payload?.useGlobalPassword
      ? cfg.global.pdf_password
      : (payload?.password ?? cfg.global.pdf_password)
    const target = resolveInside(getOutDir(), String(payload?.dir ?? ''))
    if (!target) return { ok: false, error: '导出路径超出下载目录' }
    const res = await makePdf(target, { password })
    return { ok: res.ok, pdfPath: res.pdfPath, error: res.error }
  })

  /* ---------- 配置 ---------- */
  ipcMain.handle(IPC.configGet, (): AppConfig => {
    const cfg = loadConfig()
    // 密文绝不过 IPC
    return { ...cfg, global: { ...cfg.global, ai_api_key_enc: undefined } } as AppConfig
  })
  ipcMain.handle(IPC.configSet, (_e, patch: Partial<AppConfig['global']>): AppConfig => {
    const cfg = loadConfig()
    const next = { ...cfg.global, ...patch }

    // API Key 不走明文：渲染层传上来的明文在这里加密，
    // 返回给渲染层的 config 里只保留一个"有没有"的标记
    let keyEnc = cfg.global.ai_api_key_enc
    const rawKey = (patch as { ai_api_key?: string }).ai_api_key
    if (typeof rawKey === 'string') {
      keyEnc = rawKey ? encryptSecret(rawKey) : null
    }

    // 只让调用方能改自己那几个键，防止顺手把 comics 一起覆盖掉
    cfg.global = {
      pdf_switch: Number(next.pdf_switch) ? 1 : 0,
      pdf_password: next.pdf_password === 'None' ? null : (next.pdf_password ?? null),
      concurrency: next.concurrency,
      chapter_delay_min: next.chapter_delay_min,
      chapter_delay_max: next.chapter_delay_max,
      auto_check_on_launch: Number(next.auto_check_on_launch) ? 1 : 0,
      auto_check_interval_hours: next.auto_check_interval_hours,
      notify_on_done: Number(next.notify_on_done) ? 1 : 0,
      search_type: normalizeSearchType(next.search_type),
      ai_enabled: Number(next.ai_enabled) ? 1 : 0,
      ai_auto_detect: Number(next.ai_auto_detect) ? 1 : 0,
      ai_base_url: next.ai_base_url,
      ai_api_key_enc: keyEnc,
      ai_model: AI_MODELS.includes(String(next.ai_model)) ? next.ai_model : 'MiniMax-M3',
      ai_head_pages: next.ai_head_pages,
      ai_tail_pages: next.ai_tail_pages,
      ai_max_ad_pages: next.ai_max_ad_pages,
      ai_threshold: next.ai_threshold,
      ai_concurrency: next.ai_concurrency
    }
    saveConfig(cfg)
    logger.info('设置已保存')
    // 定时追更间隔可能被改，重新排一次
    reschedule()
    // 密文不能外泄，渲染层拿不到
    return { ...cfg, global: { ...cfg.global, ai_api_key_enc: undefined } } as AppConfig
  })

  /* ---------- AI 广告识别 ---------- */
  ipcMain.handle(IPC.aiStatus, () => {
    const g = loadConfig().global
    return {
      enabled: g.ai_enabled === 1,
      hasKey: !!decryptSecret(g.ai_api_key_enc),
      model: g.ai_model,
      baseUrl: g.ai_base_url
    }
  })
  ipcMain.handle(IPC.aiModels, () => AI_MODELS)
  ipcMain.handle(
    IPC.aiTest,
    (_e, opts: { baseUrl: string; apiKey?: string; model: string; useSavedKey?: boolean }) => {
      const g = loadConfig().global
      // 界面上不回显已保存的 Key，所以留空时用已存的那把去测
      const apiKey = opts?.useSavedKey
        ? (decryptSecret(g.ai_api_key_enc) ?? '')
        : String(opts?.apiKey ?? '')
      return testConnection({
        baseUrl: String(opts?.baseUrl ?? g.ai_base_url),
        apiKey,
        model: String(opts?.model ?? g.ai_model)
      })
    }
  )
  ipcMain.handle(IPC.aiDetectChapter, (_e, comicName: string, chapterName: string, force?: boolean) =>
    detectAdsForChapter(String(comicName ?? ''), String(chapterName ?? ''), force === true)
  )
  ipcMain.handle(IPC.aiUncheckedCount, async () => (await listUncheckedChapters()).length)
  ipcMain.handle(IPC.aiUndo, (_e, comicName: string, chapterName: string) =>
    undoAdsForChapter(String(comicName ?? ''), String(chapterName ?? ''))
  )

  /* ---------- 追更 ---------- */
  ipcMain.handle(IPC.trackCheck, () => checkUpdates())
  ipcMain.handle(IPC.trackSubscribe, (_e, comic: { name: string; path: string }, limit?: number) =>
    subscribe(
      { name: String(comic?.name ?? ''), path: String(comic?.path ?? '') },
      Number.isFinite(limit) ? limit : undefined
    )
  )
  ipcMain.handle(IPC.trackUnsubscribe, (_e, comicPath: string) => {
    removeSubscription(String(comicPath ?? ''))
    return loadConfig()
  })

  /* ---------- 代理 ---------- */
  ipcMain.handle(IPC.proxyGet, () => getCurrentProxy())
  ipcMain.handle(IPC.proxySet, (_e, url: string | null) => {
    if (url) process.env.MKK_PROXY = String(url)
    else delete process.env.MKK_PROXY
    return setupProxy(url ? String(url) : null)
  })

  /* ---------- 日志与路径 ---------- */
  ipcMain.handle(IPC.logHistory, (_e, limit?: number) => logger.history(clampLimit(limit)))
  ipcMain.handle(
    IPC.appPaths,
    (): AppPaths => ({
      base: getBaseDir(),
      out: getOutDir(),
      config: getConfigPath(),
      logs: getLogDir()
    })
  )

  /* ---------- 事件转发 ---------- */
  queue.on('progress', (p) => broadcast(IPC.eventDownloadProgress, p))
  queue.on('idle', (s) => broadcast(IPC.eventQueueIdle, s))
  logger.on('line', (l) => broadcast(IPC.eventLogLine, l))
}

/** 页码必须是正整数，否则会被拼成负的 offset */
function clampPage(page: unknown): number {
  const n = Math.trunc(Number(page))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10_000) : 1
}

function clampLimit(limit: unknown): number {
  const n = Math.trunc(Number(limit))
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 5000) : 500
}

function normalizeSearchType(v: unknown): SearchType {
  const s = String(v ?? '')
  return s === 'name' || s === 'author' ? s : ''
}
