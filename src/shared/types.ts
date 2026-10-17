/** 主进程与渲染层共享的类型定义 */

/* ---------- API 返回结构（拷贝漫画 / CopyManga） ---------- */

export interface SearchComicItem {
  name: string
  alias: string
  path_word: string
  cover: string
  author: Array<{ name: string }>
}

export interface SearchResult {
  total: number
  limit: number
  offset: number
  list: SearchComicItem[]
}

export interface ComicDetail {
  name: string
  alias: string
  brief: string
  datetime_updated: string
  cover?: string
  last_chapter?: { name: string }
}

export interface ChapterItem {
  name: string
  size: number
  datetime_created: string
  uuid: string
}

export interface ChapterListResult {
  total: number
  limit: number
  offset: number
  list: ChapterItem[]
}

/** 一章的所有页面。按阅读顺序排好的图片地址列表。 */
export interface ChapterPages {
  comicName: string
  chapterName: string
  /** 按 words 还原后的真实阅读顺序，元素为图片完整地址 */
  urls: string[]
}

export interface ApiOk<T> {
  ok: true
  data: T
}
export interface ApiErr {
  ok: false
  error: string
}
export type ApiResult<T> = ApiOk<T> | ApiErr

/* ---------- 配置 ---------- */

export interface AppConfig {
  global: {
    /** 1 = 下载完成后自动生成 PDF，0 = 不生成 */
    pdf_switch: number
    /** null / "None" / 空串 = 不加密 */
    pdf_password: string | null
    /** 章内图片并发数 */
    concurrency: number
    /** 章节之间的随机间隔（秒），反限流用 */
    chapter_delay_min: number
    chapter_delay_max: number
    /** 启动时自动检查追更 */
    auto_check_on_launch: number
    /** 定时检查追更的间隔（小时），0 = 不定时 */
    auto_check_interval_hours: number
    /** 下载队列全部完成时发系统通知 */
    notify_on_done: number
    /** 搜索类型：空串=全部，name=按名称，author=按作者 */
    search_type: string
    /** AI 广告识别总开关 */
    ai_enabled: number
    /** 下载完成后自动跑一次检测 */
    ai_auto_detect: number
    /** MiniMax 接口地址 */
    ai_base_url: string
    /** 加密后的 API Key（safeStorage），不返回给渲染层 */
    ai_api_key_enc?: string | null
    ai_model: string
    /** 检查首图页数 */
    ai_head_pages: number
    /** 检查尾图页数 */
    ai_tail_pages: number
    /**
     * 每侧最多探到第几页。首轮命中广告时会自动往里扩，
     * 连续是广告就一路探到这里为止，防止一路探进正文。
     */
    ai_max_ad_pages: number
    /** 置信度阈值，0~1 */
    ai_threshold: number
    /** 同时进行的检测数，1~5。越大越快，也越容易触发限流 */
    ai_concurrency: number
  }
  comics: ComicSubscription[]
}

export interface ComicSubscription {
  name: string
  /** 站点 path_word，如 haizeiwang */
  path: string
  /** 已下载到的章节序号（1 起）；0 = 尚未下载 */
  last_chapter: number
  /** 单次追更多少章 */
  download_limit: number
  last_check_time: string
}

/* ---------- 下载任务 ---------- */

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'

export interface DownloadTask {
  id: string
  comicName: string
  comicPath: string
  chapterName: string
  /** 该漫画内的全局章节序号（1 起），与站点章节列表顺序一致 */
  chapterIndex: number
  uuid: string
  /** 落盘目录 */
  dir: string
  status: TaskStatus
  /** 已完成的图片数 */
  downloaded: number
  /** 总页数，任务入队时已知 */
  total: number
  /** 跳过（已存在）的页数 */
  skipped: number
  /** 是否作为追更任务（成功后推进 subscriptions 里的 last_chapter） */
  track?: boolean
  /** 下载失败的页码 */
  failedPages: number[]
  error?: string
  startedAt?: number
  finishedAt?: number
}

/** 进度事件负载，主进程通过 webContents.send 推给渲染层 */
export interface TaskProgress {
  task: DownloadTask
  /** 当前正在下载的页码（1 起），用于展示 “正在下载第 N/M 页” */
  currentPage?: number
  /** 当前章节前还需等待的秒数（反限流倒计时），无则 undefined */
  waitingSeconds?: number
  /** 队列整体状态 */
  queue: { pending: number; running: number; done: number; failed: number }
}

/* ---------- 漫画库 ---------- */

export interface LibraryChapter {
  name: string
  /** 章节目录绝对路径 */
  dir: string
  pageCount: number
  /**
   * 序号（按目录名自然排序推导，从 1 起）。
   * 目录名里认不出章节号时退化成 readdir 顺序里的位置。
   */
  index: number
  /** 是否存在同名 PDF */
  pdfPath?: string
  /**
   * 期望页数（站点给出的总页数）。
   * 与 pageCount 不相等说明这一章下缺页了。
   */
  expectedPages?: number
  /** 明确失败的页码，重试时只补这些 */
  failedPages?: number[]
  /** false = 已知下缺页或没下完 */
  complete?: boolean
  /** 被判定为广告并移入 _ads/ 的页数 */
  adCount?: number
  /** true = 已经跑过广告检测 */
  adChecked?: boolean
}

/** 站点信息，随库一起落在 out/<漫画>/.copycopy.json */
export interface ComicMeta {
  /** 站点 path_word，如 haizeiwang。补封面、查更新都要靠它 */
  pathWord?: string
  /** 站点上的漫画名，目录名被改过也不会认错 */
  name?: string
  author?: string
  /** 站点上的总章节数 */
  siteTotal?: number
  lastSyncedAt?: string
  /** 章节目录名 -> 该章的下载结果 */
  chapters?: Record<string, ChapterMeta>
}

export interface ChapterMeta {
  /** 站点 uuid，重试时可直接用 */
  uuid?: string
  /** 期望页数 */
  total?: number
  /** 下载失败的页码 */
  failed?: number[]
  /** 完整下载完成的时间 */
  finishedAt?: string
  /** 被判定为广告的页码（1 起）。文件已移入该章的 _ads/ 目录 */
  ads?: number[]
  /** 广告检测完成时间；没这个字段 = 还没检测过 */
  adCheckedAt?: string
  /** 检测时用的模型，换模型后可以据此判断结论要不要重跑 */
  adModel?: string
}

export interface LibraryComic {
  name: string
  /** 章节目录下的封面图（本地缓存），没有则为 undefined */
  cover?: string
  /** out/ 下的相对目录名，同时也是站点 path_word 的近似来源 */
  path: string
  chapters: LibraryChapter[]
  totalPages: number
  /** 站点元信息，有 .copycopy.json 才有 */
  meta?: ComicMeta
  /** 该漫画里已知下缺页的章节数 */
  incompleteCount?: number
  /** 没有任何章节缺页 */
  hasPdfCount?: number
}

/* ---------- 日志 ---------- */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface LogLine {
  time: string
  level: LogLevel
  message: string
}
