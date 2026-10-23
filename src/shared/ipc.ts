/** IPC 通道名与 preload 暴露的类型契约 */

import type { AppUpdateState } from './app-update'
import type {
  ApiResult,
  AppConfig,
  ChapterListResult,
  ComicDetail,
  ComicSubscription,
  DownloadTask,
  LibraryComic,
  LogLine,
  SearchResult,
  TaskProgress
} from './types'

export const IPC = {
  search: 'api:search',
  comic: 'api:comic',
  chapters: 'api:chapters',

  queueEnqueue: 'queue:enqueue',
  queueList: 'queue:list',
  queueCancel: 'queue:cancel',
  queueCancelAll: 'queue:cancelAll',
  queueRetry: 'queue:retry',
  queueRetryFailed: 'queue:retryFailed',
  queueRemoveFinished: 'queue:removeFinished',
  queueMoveTop: 'queue:moveTop',
  queueClear: 'queue:clear',

  libraryList: 'library:list',
  libraryDeleteComic: 'library:deleteComic',
  librarySyncCover: 'library:syncCover',
  libraryExportPdf: 'library:exportPdf',
  libraryDeleteChapter: 'library:deleteChapter',
  libraryDeleteChapters: 'library:deleteChapters',
  libraryOpenPath: 'library:openPath',
  libraryOpenPdf: 'library:openPdf',
  libraryChapterFiles: 'library:chapterFiles',
  libraryRetryMissing: 'library:retryMissing',

  pdfExport: 'pdf:export',

  configGet: 'config:get',
  configSet: 'config:set',

  /* AI 广告识别 */
  aiStatus: 'ai:status',
  aiTest: 'ai:test',
  aiDetectChapter: 'ai:detectChapter',
  aiUncheckedCount: 'ai:uncheckedCount',
  aiUndo: 'ai:undo',
  aiModels: 'ai:models',

  trackCheck: 'track:check',
  trackSubscribe: 'track:subscribe',
  trackUnsubscribe: 'track:unsubscribe',

  logHistory: 'log:history',
  proxyGet: 'proxy:get',
  proxySet: 'proxy:set',
  appPaths: 'app:paths',
  appUpdateState: 'app-update:state',
  appUpdateCheck: 'app-update:check',
  appUpdateDownload: 'app-update:download',
  appUpdateInstall: 'app-update:install',
  appUpdateOpenRelease: 'app-update:open-release',

  /** 主进程 -> 渲染层 */
  eventDownloadProgress: 'download:progress',
  eventLogLine: 'log:line',
  eventQueueIdle: 'queue:idle',
  eventNavigate: 'app:navigate',
  eventAppUpdate: 'app-update:changed'
} as const

/**
 * 读取 out/ 下本地图片的自定义协议。
 * 走它而不是 base64 过 IPC：体积不涨 1/3，翻页不卡主进程。
 * 必须在渲染层 CSP 的 img-src 里放行。
 */
export const LIBRARY_SCHEME = 'library'

/**
 * 远程图片（站点封面）的中转协议。
 *
 * 渲染层直接 <img src="https://站点CDN/..."> 有两个问题：
 * 渲染层是 Chromium 的独立网络栈，读不到应用设置的代理；
 * 而且发不出 version/platform/region 这些 CDN 要求的请求头。
 * 走这个协议由主进程 fetch（自带代理和请求头）后再返回。
 */
export const REMOTE_SCHEME = 'remote'

export interface EnqueuePayload {
  comicPath: string
  comicName: string
  chapterIndex: number
  chapterName: string
  uuid: string
  trackSubscription?: boolean
}

export interface PdfExportPayload {
  dir: string
  password?: string | null
  /** 留空则用全局配置的密码 */
  useGlobalPassword?: boolean
}

export interface AppPaths {
  base: string
  out: string
  config: string
  logs: string
}

export interface MkkApi {
  search(keyword: string, page?: number, qType?: string): Promise<ApiResult<SearchResult>>
  comic(pathWord: string): Promise<ApiResult<ComicDetail>>
  chapters(pathWord: string, page?: number): Promise<ApiResult<ChapterListResult>>

  enqueue(items: EnqueuePayload[]): Promise<DownloadTask[]>
  queueList(): Promise<DownloadTask[]>
  cancel(id: string): Promise<void>
  cancelAll(): Promise<void>
  retry(id: string): Promise<void>
  retryFailed(): Promise<void>
  removeFinished(): Promise<void>
  /** 把任务提到队首 */
  moveTop(id: string): Promise<void>
  /** 清空整个队列（含已完成） */
  clear(): Promise<void>

  libraryList(): Promise<LibraryComic[]>
  deleteComic(comicName: string): Promise<boolean>
  syncCover(comicName: string): Promise<boolean>
  exportPdfBatch(
    dirs: string[],
    opts: { password?: string | null; useGlobalPassword?: boolean }
  ): Promise<{ ok: number; failed: number; error?: string }>
  deleteChapter(comicName: string, chapterName: string): Promise<boolean>
  /** 批量删除，返回成功数 */
  deleteChapters(
    items: Array<{ comicName: string; chapterName: string }>
  ): Promise<{ ok: number; failed: number }>
  openPath(target: string): Promise<string>
  /** 用系统默认阅读器直接打开该章 PDF */
  openPdf(pdfPath: string): Promise<string>
  /** 某章的图片绝对路径列表，按阅读顺序（预览/阅读器用） */
  chapterFiles(dir: string): Promise<string[]>
  /** 把库里所有"下缺页"的章节重新排进下载队列 */
  retryMissing(): Promise<number>

  exportPdf(payload: PdfExportPayload): Promise<{ ok: boolean; pdfPath?: string; error?: string }>

  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig['global']>): Promise<AppConfig>

  /* ---- AI 广告识别 ---- */
  /** 是否已启用、是否已配 Key */
  aiStatus(): Promise<{ enabled: boolean; hasKey: boolean; model: string; baseUrl: string }>
  /** 测试连接：传 useSavedKey 则用已保存的 Key，接口地址/模型可临时覆盖 */
  aiTest(opts: {
    baseUrl: string
    apiKey?: string
    model: string
    useSavedKey?: boolean
  }): Promise<{ ok: boolean; message: string; elapsedMs?: number }>
  /** 检测单个章节 */
  aiDetectChapter(
    comicName: string,
    chapterName: string,
    force?: boolean
  ): Promise<{
    ok: boolean
    skipped?: boolean
    moved: number
    ads: number[]
    verdicts?: Array<{
      page: number
      isAd: boolean
      adType?: string
      confidence: number
      reason?: string
    }>
    error?: string
    elapsedMs: number
  }>
  /** 库里还没检测过的章节数 */
  aiUncheckedCount(): Promise<number>
  /** 撤销某章的广告归档 */
  aiUndo(comicName: string, chapterName: string): Promise<number>
  /** 可选模型列表 */
  aiModels(): Promise<string[]>

  checkUpdates(): Promise<{ checked: number; queued: number }>
  subscribe(comic: { name: string; path: string }, downloadLimit?: number): Promise<AppConfig>
  unsubscribe(comicPath: string): Promise<AppConfig>

  logHistory(limit?: number): Promise<LogLine[]>
  paths(): Promise<AppPaths>

  proxyGet(): Promise<string | null>
  proxySet(url: string | null): Promise<string | null>

  appUpdateState(): Promise<AppUpdateState>
  appUpdateCheck(): Promise<AppUpdateState>
  appUpdateDownload(): Promise<AppUpdateState>
  appUpdateInstall(): Promise<AppUpdateState>
  appUpdateOpenRelease(): Promise<void>
  onAppUpdate(cb: (state: AppUpdateState) => void): () => void

  onDownloadProgress(cb: (p: TaskProgress) => void): () => void
  onLogLine(cb: (l: LogLine) => void): () => void
  /** 队列从"忙"变"闲"时触发，参数为本次统计 */
  onQueueIdle(cb: (summary: QueueIdleSummary) => void): () => void
  /** 主进程让窗口跳到某个路由 */
  onNavigate(cb: (path: string) => void): () => void
}

/** 一次下载批次跑完后的汇总，用于系统通知 */
export interface QueueIdleSummary {
  done: number
  failed: number
  canceled: number
  /** 本次批次耗时（毫秒） */
  elapsed: number
}

declare global {
  interface Window {
    mkk: MkkApi
  }
}
