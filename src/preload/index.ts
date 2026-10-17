import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MkkApi, type QueueIdleSummary } from '../shared/ipc'
import type { LogLine, TaskProgress } from '../shared/types'

/**
 * 只暴露白名单方法，渲染层拿不到 ipcRenderer 本身，也拿不到 Node API。
 */
const api: MkkApi = {
  search: (keyword, page, qType) => ipcRenderer.invoke(IPC.search, keyword, page, qType),
  comic: (pathWord) => ipcRenderer.invoke(IPC.comic, pathWord),
  chapters: (pathWord, page) => ipcRenderer.invoke(IPC.chapters, pathWord, page),

  enqueue: (items) => ipcRenderer.invoke(IPC.queueEnqueue, items),
  queueList: () => ipcRenderer.invoke(IPC.queueList),
  cancel: (id) => ipcRenderer.invoke(IPC.queueCancel, id),
  cancelAll: () => ipcRenderer.invoke(IPC.queueCancelAll),
  retry: (id) => ipcRenderer.invoke(IPC.queueRetry, id),
  retryFailed: () => ipcRenderer.invoke(IPC.queueRetryFailed),
  removeFinished: () => ipcRenderer.invoke(IPC.queueRemoveFinished),
  moveTop: (id) => ipcRenderer.invoke(IPC.queueMoveTop, id),
  clear: () => ipcRenderer.invoke(IPC.queueClear),

  libraryList: () => ipcRenderer.invoke(IPC.libraryList),
  deleteComic: (comicName: string) => ipcRenderer.invoke(IPC.libraryDeleteComic, comicName),
  syncCover: (comicName: string) => ipcRenderer.invoke(IPC.librarySyncCover, comicName),
  exportPdfBatch: (dirs, opts) => ipcRenderer.invoke(IPC.libraryExportPdf, dirs, opts),
  deleteChapter: (comicName, chapterName) =>
    ipcRenderer.invoke(IPC.libraryDeleteChapter, comicName, chapterName),
  deleteChapters: (items) => ipcRenderer.invoke(IPC.libraryDeleteChapters, items),
  openPath: (target) => ipcRenderer.invoke(IPC.libraryOpenPath, target),
  openPdf: (pdfPath) => ipcRenderer.invoke(IPC.libraryOpenPdf, pdfPath),
  chapterFiles: (dir) => ipcRenderer.invoke(IPC.libraryChapterFiles, dir),
  retryMissing: () => ipcRenderer.invoke(IPC.libraryRetryMissing),

  exportPdf: (payload) => ipcRenderer.invoke(IPC.pdfExport, payload),

  getConfig: () => ipcRenderer.invoke(IPC.configGet),
  setConfig: (patch) => ipcRenderer.invoke(IPC.configSet, patch),

  aiStatus: () => ipcRenderer.invoke(IPC.aiStatus),
  aiTest: (opts) => ipcRenderer.invoke(IPC.aiTest, opts),
  aiDetectChapter: (comicName, chapterName, force) =>
    ipcRenderer.invoke(IPC.aiDetectChapter, comicName, chapterName, force),
  aiUncheckedCount: () => ipcRenderer.invoke(IPC.aiUncheckedCount),
  aiUndo: (comicName, chapterName) =>
    ipcRenderer.invoke(IPC.aiUndo, comicName, chapterName),
  aiModels: () => ipcRenderer.invoke(IPC.aiModels),

  checkUpdates: () => ipcRenderer.invoke(IPC.trackCheck),
  subscribe: (comic, downloadLimit) =>
    ipcRenderer.invoke(IPC.trackSubscribe, comic, downloadLimit),
  unsubscribe: (comicPath) => ipcRenderer.invoke(IPC.trackUnsubscribe, comicPath),

  logHistory: (limit) => ipcRenderer.invoke(IPC.logHistory, limit),
  paths: () => ipcRenderer.invoke(IPC.appPaths),

  proxyGet: () => ipcRenderer.invoke(IPC.proxyGet),
  proxySet: (url) => ipcRenderer.invoke(IPC.proxySet, url),

  onDownloadProgress(cb: (p: TaskProgress) => void) {
    const handler = (_e: unknown, p: TaskProgress) => cb(p)
    ipcRenderer.on(IPC.eventDownloadProgress, handler)
    return () => ipcRenderer.removeListener(IPC.eventDownloadProgress, handler)
  },
  onLogLine(cb: (l: LogLine) => void) {
    const handler = (_e: unknown, l: LogLine) => cb(l)
    ipcRenderer.on(IPC.eventLogLine, handler)
    return () => ipcRenderer.removeListener(IPC.eventLogLine, handler)
  },
  onQueueIdle(cb: (s: QueueIdleSummary) => void) {
    const handler = (_e: unknown, s: QueueIdleSummary) => cb(s)
    ipcRenderer.on(IPC.eventQueueIdle, handler)
    return () => ipcRenderer.removeListener(IPC.eventQueueIdle, handler)
  },
  /** 主进程让窗口跳到某个路由（完成通知点击时用） */
  onNavigate(cb: (path: string) => void) {
    const handler = (_e: unknown, p: string) => cb(p)
    ipcRenderer.on(IPC.eventNavigate, handler)
    return () => ipcRenderer.removeListener(IPC.eventNavigate, handler)
  }
}

contextBridge.exposeInMainWorld('mkk', api)
