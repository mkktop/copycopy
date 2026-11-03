import type { Page } from '@playwright/test'

export async function installDesktop(page: Page) {
  await page.route('http://copyimg.localhost/**', async (route) => {
    const target = decodeURIComponent(new URL(route.request().url()).pathname.slice(1))
    const index = Number(/cover\/(\d+)/.exec(target)?.[1] || 1)
    const palette = ['#dcb392', '#90a8a0', '#b1a68a', '#a9b08a', '#c5a29b']
    const color = palette[(index - 1) % palette.length]
    const reader = target.includes('local/') || target.includes('pages.example')
    const svg = reader
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="950"><rect width="700" height="950" fill="#eee8d8"/><path d="M0 450Q200 100 450 450T700 400V950H0Z" fill="' +
        color +
        '"/><path d="M0 700Q200 450 450 700T700 650V950H0Z" fill="#3d5a4b"/><circle cx="475" cy="200" r="78" fill="#f8eac5"/><text x="45" y="80" font-size="23" fill="#3d5a4b" font-family="sans-serif">A STORY TO KEEP</text></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><rect width="360" height="480" fill="' +
        color +
        '"/><circle cx="235" cy="145" r="78" fill="#f4e9ca"/><path d="M0 350Q90 130 230 340T360 380V480H0Z" fill="#3e5a4b"/><text x="25" y="55" fill="#fff9e9" font-size="24" font-family="Georgia">STORY No. ' +
        index +
        '</text><text x="26" y="445" fill="#f7f0d8" font-size="10" font-family="sans-serif">A LITTLE ESCAPE · COPYCOPY</text></svg>'
    await route.fulfill({ contentType: 'image/svg+xml', body: svg })
  })
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, any>
    const titles = [
      '雨后的书店',
      '山海之间',
      '漫长的午后',
      '森林来信',
      '直到星星亮起',
      '海边的房间',
      '夏日的回声',
      '旅程 100%',
      '时间的缝隙',
      '小小的冒险'
    ]
    const comics = Array.from({ length: 32 }, (_, i) => ({
      id: 'c' + (i + 1),
      title: titles[i % titles.length] + (i >= titles.length ? ' ' + (i + 1) : ''),
      alias: i % 2 ? '日常 / 连载' : '冒险 / 完结',
      cover: 'https://covers.example/cover/' + (i + 1) + '.jpg',
      authors: [['青木', '林间', '白川'][i % 3]],
      description: '沿着熟悉的小路，走进一个不一样的世界。这是一段关于相遇、远行与回家的故事。',
      updatedAt: '2026-11-03',
      latestChapter: '第52话'
    }))
    const settings = {
      appearance: 'light',
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
      downloadDirectory: 'C:/Users/Reader/Books',
      imageCacheLimitMb: 256
    }
    function chapter(comicId: string, index: number) {
      return {
        id: comicId + '-ch' + index,
        title: '第' + index + '话',
        index,
        pageCount: index === 1 ? 3 : index === 2 ? 5 : 7,
        updatedAt: '2026-11-03'
      }
    }
    function localChapter(comicId: string, index: number) {
      const c = chapter(comicId, index)
      return {
        ...c,
        comicId,
        directory: 'C:/Users/Reader/Books/' + comicId + '/' + c.id,
        total: c.pageCount,
        pageCount: c.pageCount,
        failedPages: [],
        complete: true,
        pdfPath: null
      }
    }
    function book(index: number, length: number) {
      const comic = comics[index]!
      const chapters = Array.from({ length }, (_, i) => localChapter(comic.id, i + 1))
      return {
        comic,
        chapters,
        totalPages: chapters.reduce((n, c) => n + c.pageCount, 0),
        incompleteCount: 0,
        progress: null
      }
    }
    const initial = {
      settings,
      queue: { revision: 0, tasks: [] },
      books: [book(0, 2), book(2, 1), book(4, 3)],
      subscriptions: [],
      reading: {},
      enqueued: [],
      exportCalls: [],
      installRequested: false
    }
    let state: any
    try {
      state = JSON.parse(localStorage.getItem('copycopy-ui-fixture') || 'null') || initial
    } catch {
      state = initial
    }
    const callbacks = new Map<number, (value: unknown) => void>()
    const listeners = new Map<number, { event: string; callback: number }>()
    let sequence = 1
    let updateAvailable = false
    const clone = (value: any) =>
      value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    function flush() {
      localStorage.setItem('copycopy-ui-fixture', JSON.stringify(state))
    }
    function emit() {
      for (const value of listeners.values())
        if (value.event === 'queue-update')
          callbacks.get(value.callback)?.({ event: 'queue-update', payload: clone(state.queue) })
    }
    function updateBooks(task: any) {
      let stored = state.books.find((b: any) => b.comic.id === task.comic.id)
      if (!stored) {
        stored = {
          comic: task.comic,
          chapters: [],
          totalPages: 0,
          incompleteCount: 0,
          progress: null
        }
        state.books.push(stored)
      }
      if (!stored.chapters.some((c: any) => c.id === task.chapter.id))
        stored.chapters.push(localChapter(task.comic.id, task.chapter.index))
      stored.chapters.sort((a: any, b: any) => a.index - b.index)
      stored.totalPages = stored.chapters.reduce((n: number, c: any) => n + c.pageCount, 0)
    }
    w.__copycopyTest = {
      state,
      setUpdateAvailable: (value: boolean) => {
        updateAvailable = value
      }
    }
    w.isTauri = true
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      convertFileSrc: (file: string, protocol: string) =>
        'http://' + protocol + '.localhost/' + encodeURIComponent(file),
      transformCallback: (callback: (value: unknown) => void) => {
        const id = sequence++
        callbacks.set(id, callback)
        return id
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'plugin:event|listen') {
          const id = sequence++
          listeners.set(id, { event: args.event, callback: args.handler })
          return id
        }
        if (command === 'plugin:event|unlisten') {
          listeners.delete(args.eventId)
          return
        }
        if (command.startsWith('plugin:window|'))
          return command.endsWith('is_maximized') ? false : null
        switch (command) {
          case 'app_snapshot':
            return clone({
              version: '2.0.0',
              settings: state.settings,
              queue: state.queue,
              paths: {
                data: 'C:/Users/Reader/CopyCopy',
                downloads: state.settings.downloadDirectory,
                cache: 'C:/Users/Reader/CopyCopy/cache'
              }
            })
          case 'get_app_version':
            return '2.0.0'
          case 'search_comics': {
            const list = args.keyword === '不存在' ? [] : comics
            return clone({
              items: list.slice((args.page - 1) * 24, args.page * 24),
              total: list.length,
              page: args.page,
              pageSize: 24
            })
          }
          case 'get_comic':
            return clone(comics.find((c) => c.id === args.comicId) || comics[0])
          case 'get_chapters':
            return {
              items: Array.from({ length: Math.min(50, 52 - (args.page - 1) * 50) }, (_, i) =>
                chapter(args.comicId, (args.page - 1) * 50 + i + 1)
              ),
              total: 52,
              page: args.page,
              pageSize: 50
            }
          case 'get_queue':
            return clone(state.queue)
          case 'enqueue_downloads': {
            for (const item of args.items) {
              if (
                state.queue.tasks.some(
                  (t: any) =>
                    t.comic.id === item.comic.id &&
                    t.chapter.id === item.chapter.id &&
                    ['pending', 'running'].includes(t.status)
                )
              )
                continue
              state.enqueued.push(item.chapter.id)
              state.queue.tasks.push({
                id: 'task-' + sequence++,
                comic: clone(item.comic),
                chapter: clone(item.chapter),
                directory: 'fixture',
                status: 'running',
                completed: 0,
                total: item.chapter.pageCount,
                skipped: 0,
                failedPages: [],
                error: null,
                startedAt: Date.now(),
                finishedAt: null
              })
            }
            state.queue.revision++
            flush()
            emit()
            setTimeout(() => {
              for (const task of state.queue.tasks)
                if (task.status === 'running') {
                  task.status = 'done'
                  task.completed = task.total
                  task.finishedAt = Date.now()
                  updateBooks(task)
                }
              state.queue.revision++
              flush()
              emit()
            }, 250)
            return clone(state.queue)
          }
          case 'queue_action': {
            if (args.action === 'clearFinished')
              state.queue.tasks = state.queue.tasks.filter((t: any) =>
                ['pending', 'running'].includes(t.status)
              )
            if (args.action === 'cancelAll' || args.action === 'cancel')
              for (const t of state.queue.tasks)
                if (
                  (args.action === 'cancelAll' || t.id === args.id) &&
                  ['pending', 'running'].includes(t.status)
                )
                  t.status = 'canceled'
            state.queue.revision++
            flush()
            emit()
            return clone(state.queue)
          }
          case 'get_library':
            return clone(
              state.books.map((b: any) => ({
                ...b,
                progress: state.reading['local:' + b.comic.id] || null
              }))
            )
          case 'get_reader_pages': {
            const c = state.books
              .find((b: any) => b.comic.id === args.comicId)
              ?.chapters.find((c: any) => c.id === args.chapterId)
            const count = c?.pageCount || 7
            return {
              count,
              urls: args.local
                ? []
                : Array.from(
                    { length: count },
                    (_, i) => 'https://pages.example/' + args.chapterId + '/' + (i + 1) + '.jpg'
                  )
            }
          }
          case 'get_reading_progress':
            return clone(state.reading[(args.local ? 'local:' : 'online:') + args.comicId] || null)
          case 'save_reading_progress':
            state.reading[(args.local ? 'local:' : 'online:') + args.progress.comicId] = clone(
              args.progress
            )
            flush()
            return
          case 'export_pdf': {
            state.exportCalls.push(clone(args))
            const result = args.chapterIds.map((id: string) => {
              const chapter = state.books
                .find((b: any) => b.comic.id === args.comicId)
                .chapters.find((c: any) => c.id === id)
              chapter.pdfPath = chapter.directory + '.pdf'
              return { path: chapter.pdfPath, pages: chapter.pageCount }
            })
            flush()
            return result
          }
          case 'delete_downloads': {
            const book = state.books.find((b: any) => b.comic.id === args.comicId)
            const ids = args.chapterIds.length
              ? args.chapterIds
              : book.chapters.map((c: any) => c.id)
            book.chapters = book.chapters.filter((c: any) => !ids.includes(c.id))
            book.totalPages = book.chapters.reduce((n: number, c: any) => n + c.pageCount, 0)
            state.books = state.books.filter((b: any) => b.chapters.length)
            flush()
            return ids.length
          }
          case 'get_subscriptions':
            return clone(state.subscriptions)
          case 'set_subscription': {
            const old = state.subscriptions.find((s: any) => s.comic.id === args.comic.id)
            const value = {
              comic: clone(args.comic),
              lastChapter: old?.lastChapter || 0,
              chapterLimit: args.chapterLimit,
              checkedAt: null,
              error: null
            }
            state.subscriptions = state.subscriptions.filter(
              (s: any) => s.comic.id !== args.comic.id
            )
            state.subscriptions.push(value)
            flush()
            return clone(value)
          }
          case 'remove_subscription':
            state.subscriptions = state.subscriptions.filter(
              (s: any) => s.comic.id !== args.comicId
            )
            flush()
            return
          case 'check_subscriptions':
            return { checked: state.subscriptions.length, queued: 0, errors: [] }
          case 'update_settings':
            state.settings = { ...state.settings, ...clone(args.patch) }
            flush()
            return clone(state.settings)
          case 'pick_download_directory':
            return 'C:/Users/Reader/NewBooks'
          case 'retry_incomplete':
            return clone(state.queue)
          case 'clear_image_cache':
          case 'open_location':
          case 'open_chapter':
          case 'open_update_release':
            return
          case 'check_for_updates':
            return {
              status: updateAvailable ? 'available' : 'current',
              current_version: '2.0.0',
              version: updateAvailable ? '2.1.0' : null,
              notes: '改进阅读体验\n<img src=x onerror=alert(1)>',
              published_at: '2026-11-03T00:00:00Z',
              can_install: updateAvailable,
              download_size: 1024,
              installer_kind: 'windows'
            }
          case 'download_update':
            return
          case 'install_update': {
            if (state.queue.tasks.some((t: any) => ['pending', 'running'].includes(t.status)))
              throw '请等待下载完成'
            state.installRequested = true
            flush()
            return
          }
          default:
            throw new Error('Unexpected desktop command: ' + command)
        }
      }
    }
  })
}
