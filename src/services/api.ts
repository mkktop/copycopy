import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import type {
  Chapter,
  Comic,
  LibraryBook,
  Page,
  PdfResult,
  QueueSnapshot,
  ReadingProgress,
  Settings,
  Snapshot,
  Subscription
} from '../types'
export const api = {
  snapshot: () => invoke<Snapshot>('app_snapshot'),
  search: (keyword: string, page = 1, kind = '') =>
    invoke<Page<Comic>>('search_comics', { keyword, page, kind }),
  comic: (comicId: string) => invoke<Comic>('get_comic', { comicId }),
  chapters: (comicId: string, page = 1) => invoke<Page<Chapter>>('get_chapters', { comicId, page }),
  queue: () => invoke<QueueSnapshot>('get_queue'),
  enqueue: (comic: Comic, chapters: Chapter[]) =>
    invoke<QueueSnapshot>('enqueue_downloads', {
      items: chapters.map((chapter) => ({ comic, chapter }))
    }),
  queueAction: (
    action: 'cancel' | 'cancelAll' | 'retry' | 'retryFailed' | 'clearFinished' | 'moveTop',
    id: string | null = null
  ) => invoke<QueueSnapshot>('queue_action', { action, id }),
  library: () => invoke<LibraryBook[]>('get_library'),
  deleteDownloads: (comicId: string, chapterIds: string[] = []) =>
    invoke<number>('delete_downloads', { comicId, chapterIds }),
  exportPdf: (comicId: string, chapterIds: string[]) =>
    invoke<PdfResult[]>('export_pdf', { comicId, chapterIds }),
  retryIncomplete: () => invoke<QueueSnapshot>('retry_incomplete'),
  readerPages: (comicId: string, chapterId: string, local: boolean) =>
    invoke<{ count: number; urls: string[] }>('get_reader_pages', { comicId, chapterId, local }),
  progress: (comicId: string, local = true) =>
    invoke<ReadingProgress | null>('get_reading_progress', { comicId, local }),
  saveProgress: (progress: ReadingProgress, local: boolean) =>
    invoke<void>('save_reading_progress', { progress, local }),
  subscriptions: () => invoke<Subscription[]>('get_subscriptions'),
  subscribe: (comic: Comic, chapterLimit = 10) =>
    invoke<Subscription>('set_subscription', { comic, chapterLimit }),
  unsubscribe: (comicId: string) => invoke<void>('remove_subscription', { comicId }),
  checkSubscriptions: () =>
    invoke<{ checked: number; queued: number; errors: string[] }>('check_subscriptions'),
  settings: (patch: Partial<Settings>) => invoke<Settings>('update_settings', { patch }),
  pickDirectory: () => invoke<string | null>('pick_download_directory'),
  openLocation: (kind: 'data' | 'downloads' | 'cache') => invoke<void>('open_location', { kind }),
  openChapter: (comicId: string, chapterId: string, pdf = false) =>
    invoke<void>('open_chapter', { comicId, chapterId, pdf }),
  clearCache: () => invoke<void>('clear_image_cache')
}
export const remoteImage = (url: string) => (url ? convertFileSrc('remote/' + url, 'copyimg') : '')
export const localImage = (comicId: string, chapterId: string, page: number) =>
  convertFileSrc('local/' + JSON.stringify({ comicId, chapterId, page }), 'copyimg')
