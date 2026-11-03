export interface Comic {
  id: string
  title: string
  alias: string
  cover: string
  authors: string[]
  description: string
  updatedAt: string
  latestChapter: string
}
export interface Chapter {
  id: string
  title: string
  index: number
  pageCount: number
  updatedAt: string
}
export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
export interface Settings {
  appearance: 'system' | 'light' | 'dark'
  sidebarCollapsed: boolean
  compactCards: boolean
  parallelImages: number
  chapterDelayMin: number
  chapterDelayMax: number
  exportPdfAfterDownload: boolean
  pdfPassword: string | null
  checkUpdatesOnLaunch: boolean
  checkSubscriptionsOnLaunch: boolean
  subscriptionIntervalHours: number
  notifyOnDone: boolean
  proxyMode: 'system' | 'direct' | 'custom'
  proxyUrl: string
  downloadDirectory: string
  imageCacheLimitMb: number
}
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'
export interface DownloadTask {
  id: string
  comic: Comic
  chapter: Chapter
  directory: string
  status: TaskStatus
  completed: number
  total: number
  skipped: number
  failedPages: number[]
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}
export interface QueueSnapshot {
  revision: number
  tasks: DownloadTask[]
}
export interface LocalChapter {
  id: string
  comicId: string
  title: string
  index: number
  directory: string
  total: number
  pageCount: number
  failedPages: number[]
  complete: boolean
  pdfPath: string | null
}
export interface LibraryBook {
  progress: ReadingProgress | null
  comic: Comic
  chapters: LocalChapter[]
  totalPages: number
  incompleteCount: number
}
export interface ReadingProgress {
  comicId: string
  chapterId: string
  page: number
  updatedAt: number
}
export interface Subscription {
  comic: Comic
  lastChapter: number
  chapterLimit: number
  checkedAt: number | null
  error: string | null
}
export interface Snapshot {
  version: string
  settings: Settings
  queue: QueueSnapshot
  paths: { data: string; downloads: string; cache: string }
}
export interface PdfResult {
  path: string
  pages: number
}
export const defaultSettings: Settings = {
  appearance: 'system',
  sidebarCollapsed: false,
  compactCards: false,
  parallelImages: 5,
  chapterDelayMin: 3,
  chapterDelayMax: 6,
  exportPdfAfterDownload: false,
  pdfPassword: null,
  checkUpdatesOnLaunch: true,
  checkSubscriptionsOnLaunch: false,
  subscriptionIntervalHours: 0,
  notifyOnDone: true,
  proxyMode: 'system',
  proxyUrl: '',
  downloadDirectory: '',
  imageCacheLimitMb: 256
}
