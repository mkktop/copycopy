import type {
  ApiResult,
  ChapterListResult,
  ChapterPages,
  ComicDetail,
  SearchResult
} from '../../shared/types'
import { logger } from '../logger'

/**
 * 拷贝漫画（CopyManga）JSON API 客户端。
 * 直接对齐官方 Android 客户端的请求头，服务端不校验登录态，也没有验证码。
 */
/**
 * 接口域名。
 * 站点按年份轮换域名（2025copy.com -> 2026copy.com），历史域名会陆续停服。
 * 允许通过环境变量覆盖：
 *   MKK_API_HOST   只换域名
 *   MKK_API_BASE   换完整基址（调试用，连本地模拟站点时用）
 *
 * 默认取 api.mangacopy.com：它和 api.2026copy.com 是等价域名，接口一致，
 * 但实测响应更快（同一网络下 4 轮采样平均 760ms vs 890ms），
 * 而且不跟着年份走，比年号域名活得久。
 */
export const API_HOST = process.env.MKK_API_HOST || 'api.mangacopy.com'
const API_BASE = process.env.MKK_API_BASE || `https://${API_HOST}`

/**
 * 站点可能升级版本号，这里集中一处方便维护。
 * 2026-10 起 UA COPY/3.x + 2025 版本号会被打 HTTP 210
 * （提示"请更新最新APP"并要求等待 1 小时），必须成对升到 4.x。
 */
export const CLIENT_VERSION = process.env.MKK_API_VERSION || '2026.10.10'

const HEADERS: Record<string, string> = {
  'User-Agent': 'COPY/4.0.0',
  Accept: 'application/json',
  version: CLIENT_VERSION,
  platform: '1',
  webp: '1',
  region: '1'
}

/**
 * 图片请求头：沿用客户端身份，但去掉 webp=1。
 * 带 webp 头时 CDN 会下发 WebP，PDF 无法直接嵌入，本地预览也容易出兼容问题；
 * 不带这个头就稳定返回 JPEG。
 */
export const IMAGE_HEADERS: Record<string, string> = {
  'User-Agent': HEADERS['User-Agent'],
  version: CLIENT_VERSION,
  platform: '1',
  region: '1'
}

// 接口实测最大支持 24 条/页（传 50 会直接返回空），原版只取 5 条导致页面很空
const SEARCH_PAGE_SIZE = 24
const CHAPTER_PAGE_SIZE = 50

async function request<T>(url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...HEADERS, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      // 站点的 4xx/2xx 非常值（如 210 "请更新APP"）都带 JSON 正文，
      // 把 message 透出去，用户在界面上才知道是站点拦而不是程序坏
      let msg = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { message?: string }
        if (body?.message) msg = `${msg} ${body.message}`
      } catch {
        /* 非 JSON 正文就只报状态码 */
      }
      return { ok: false, error: msg }
    }
    const data = (await res.json()) as { code?: number; message?: string; results?: T }
    if (data.code !== 200) {
      return { ok: false, error: data.message || `接口返回 code=${data.code}` }
    }
    return { ok: true, data: data.results as T }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn(`请求失败 ${url} -> ${msg}`)
    return { ok: false, error: msg }
  }
}

function qs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

/** 站点支持的搜索维度。'' = 全部，name = 只匹配漫画名，author = 只匹配作者 */
export type SearchType = '' | 'name' | 'author'

/** 搜索漫画，每页 SEARCH_PAGE_SIZE 条 */
export async function searchComic(
  keyword: string,
  page = 1,
  qType: SearchType = ''
): Promise<ApiResult<SearchResult>> {
  const url =
    `${API_BASE}/api/v3/search/comic?` +
    qs({
      limit: SEARCH_PAGE_SIZE,
      offset: (page - 1) * SEARCH_PAGE_SIZE,
      q: keyword,
      q_type: qType,
      platform: 1
    })
  return request<SearchResult>(url)
}

/** 漫画详情 */
export async function getComic(pathWord: string): Promise<ApiResult<ComicDetail>> {
  const url = `${API_BASE}/api/v3/comic2/${encodeURIComponent(pathWord)}?platform=1`
  const res = await request<{ comic?: ComicDetail }>(url)
  if (!res.ok) return res
  // 接口偶尔会 200 但不带 comic，标成 ok 会让调用方拿到 undefined
  const comic = res.data?.comic
  if (!comic) return { ok: false, error: '接口未返回漫画信息' }
  return { ok: true, data: comic }
}

/** 章节列表，每页 50 */
export async function getChapters(
  pathWord: string,
  page = 1
): Promise<ApiResult<ChapterListResult>> {
  const url =
    `${API_BASE}/api/v3/comic/${encodeURIComponent(pathWord)}/group/default/chapters?` +
    qs({ limit: CHAPTER_PAGE_SIZE, offset: (page - 1) * CHAPTER_PAGE_SIZE })
  return request<ChapterListResult>(url)
}

interface RawChapter {
  contents?: Array<{ url?: string }>
  words?: number[]
  name?: string
}

/**
 * 取某一章的所有页面地址。
 *
 * 关键：contents 是乱序存放的（分卷/批次），words 才是真实阅读顺序，
 * 原版 Python 就是靠 words[i] 去取 contents[word] 才能正确排页。
 */
export async function getChapterPages(
  pathWord: string,
  uuid: string
): Promise<ApiResult<ChapterPages>> {
  const url =
    `${API_BASE}/api/v3/comic/${encodeURIComponent(pathWord)}` +
    `/chapter2/${encodeURIComponent(uuid)}`
  const res = await request<{ chapter: RawChapter; comic: { name: string } }>(url)
  if (!res.ok) return res

  const chapter = res.data?.chapter
  const contents = chapter?.contents ?? []
  const words = chapter?.words ?? []

  const urls: string[] = []
  if (words.length > 0) {
    for (const w of words) {
      const item = contents[w]
      if (item?.url) urls.push(absoluteUrl(item.url))
    }
  } else {
    // 兜底：没有 words 就按 contents 原序
    for (const c of contents) {
      if (c.url) urls.push(absoluteUrl(c.url))
    }
  }

  if (urls.length === 0) {
    return { ok: false, error: '该章节没有可用页面' }
  }

  return {
    ok: true,
    data: {
      comicName: res.data?.comic?.name ?? pathWord,
      chapterName: chapter?.name ?? uuid,
      urls
    }
  }
}

/**
 * 站点返回的图片地址有的是绝对地址，有的是相对路径。
 * 相对路径按接口自身的 origin 解析，避免站点换协议或换域名时拼错。
 */
function absoluteUrl(u: string): string {
  if (u.startsWith('http://') || u.startsWith('https://')) return u
  try {
    return new URL(u, API_BASE + '/').toString()
  } catch {
    return u
  }
}

/** 章节总数（只需拉第一页） */
export async function getTotalChapters(pathWord: string): Promise<ApiResult<number>> {
  const res = await getChapters(pathWord, 1)
  if (!res.ok) return res
  const total = res.data?.total
  if (!Number.isFinite(total)) return { ok: false, error: '接口未返回章节总数' }
  return { ok: true, data: total }
}
