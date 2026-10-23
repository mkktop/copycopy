import fs from 'fs'
import yaml from 'js-yaml'
import type { AppConfig, ComicSubscription } from '../shared/types'
import { getConfigPath } from './paths'
import { logger } from './logger'
import { DEFAULT_BASE_URL } from './ai/client'

/**
 * 配置读写。保持与原 Python 版 config/comic.yaml 完全同构，
 * 用户可以直接把老配置拷过来用；这里额外补几个桌面端可调项。
 */

export const DEFAULT_CONFIG: AppConfig = {
  global: {
    pdf_switch: 1,
    pdf_password: null,
    concurrency: 5,
    chapter_delay_min: 5,
    chapter_delay_max: 10,
    app_update_check_on_launch: 1,
    auto_check_on_launch: 0,
    auto_check_interval_hours: 0,
    notify_on_done: 1,
    search_type: '',
    ai_enabled: 0,
    ai_auto_detect: 0,
    ai_base_url: DEFAULT_BASE_URL,
    ai_api_key_enc: null,
    ai_model: 'MiniMax-M3',
    ai_head_pages: 1,
    ai_tail_pages: 1,
    ai_max_ad_pages: 4,
    ai_threshold: 0.8,
    ai_concurrency: 3
  },
  comics: []
}

/**
 * 新订阅的单次追更章数上限。
 * 刻意不跟 concurrency 挂钩：并发是"章内同时下几张图"，
 * 拿来推"一次追几章"会把调并发意外变成调追更数量。
 */
const DEFAULT_DOWNLOAD_LIMIT = 10

/** 官方在售的 M 系列模型。M3.1 只走 Token Plan 订阅 Key，和按量 Key 不通用 */
export const AI_MODELS = [
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M3.1-Flash-Preview'
]

function normalizePassword(v: unknown): string | null {
  // 老配置里没用密码时写的是字符串 "None"
  if (v === null || v === undefined || v === 'None' || v === '') return null
  return String(v)
}

function normalize(raw: unknown): AppConfig {
  const obj = (raw ?? {}) as Partial<AppConfig>
  const g = (obj.global ?? {}) as Partial<AppConfig['global']>
  return {
    global: {
      pdf_switch: Number(g.pdf_switch ?? DEFAULT_CONFIG.global.pdf_switch) ? 1 : 0,
      pdf_password: normalizePassword(g.pdf_password),
      concurrency: clampInt(g.concurrency ?? DEFAULT_CONFIG.global.concurrency, 1, 16, 5),
      chapter_delay_min: clampInt(g.chapter_delay_min ?? 5, 0, 300, 5),
      chapter_delay_max: clampInt(g.chapter_delay_max ?? 10, 0, 300, 10),
      app_update_check_on_launch: Number(g.app_update_check_on_launch ?? 1) ? 1 : 0,
      auto_check_on_launch: Number(g.auto_check_on_launch ?? 0) ? 1 : 0,
      auto_check_interval_hours: clampInt(
        g.auto_check_interval_hours ?? DEFAULT_CONFIG.global.auto_check_interval_hours,
        0,
        168,
        0
      ),
      notify_on_done: Number(g.notify_on_done ?? 1) ? 1 : 0,
      search_type: normalizeSearchType(g.search_type),

      // AI：默认全关。不填 Key、不主动发请求，避免用户不知情地产生费用
      ai_enabled: Number(g.ai_enabled ?? 0) ? 1 : 0,
      ai_auto_detect: Number(g.ai_enabled ?? 0) && Number(g.ai_auto_detect ?? 0) ? 1 : 0,
      ai_base_url: normalizeBaseUrl(g.ai_base_url),
      ai_api_key_enc: typeof g.ai_api_key_enc === 'string' ? g.ai_api_key_enc : null,
      ai_model: AI_MODELS.includes(String(g.ai_model)) ? String(g.ai_model) : 'MiniMax-M3',
      ai_head_pages: clampInt(g.ai_head_pages ?? 1, 0, 3, 1),
      ai_tail_pages: clampInt(g.ai_tail_pages ?? 1, 0, 3, 1),
      ai_max_ad_pages: clampInt(
        g.ai_max_ad_pages ?? DEFAULT_CONFIG.global.ai_max_ad_pages,
        1,
        6,
        4
      ),
      ai_threshold: Math.round(clampInt((Number(g.ai_threshold) || 0.8) * 100, 1, 100, 80)) / 100,
      ai_concurrency: clampInt(g.ai_concurrency ?? 3, 1, 5, 3)
    },
    comics: Array.isArray(obj.comics) ? obj.comics.map(normalizeComic) : []
  }
}

function normalizeComic(c: Partial<ComicSubscription>): ComicSubscription {
  return {
    name: String(c.name ?? ''),
    path: String(c.path ?? ''),
    last_chapter: clampInt(c.last_chapter ?? 0, 0, 1_000_000, 0),
    download_limit: clampInt(c.download_limit ?? 10, 1, 10_000, 10),
    last_check_time: String(c.last_check_time ?? '')
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeSearchType(v: unknown): string {
  const s = String(v ?? '')
  return s === 'name' || s === 'author' ? s : ''
}

/** 只收 http(s)，挡掉 file: / javascript: 之类，免得这个字段变成取件器 */
function normalizeBaseUrl(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return DEFAULT_BASE_URL
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_BASE_URL
    return s.replace(/\/+$/, '')
  } catch {
    return DEFAULT_BASE_URL
  }
}

export function loadConfig(): AppConfig {
  const file = getConfigPath()
  if (!fs.existsSync(file)) {
    const cfg = structuredClone(DEFAULT_CONFIG)
    saveConfig(cfg)
    logger.info('未找到配置文件，已生成默认配置: ' + file)
    return cfg
  }
  try {
    const cfg = normalize(yaml.load(fs.readFileSync(file, 'utf-8')))
    return cfg
  } catch (e) {
    logger.error('配置文件解析失败，已回退到默认配置: ' + String(e))
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: AppConfig): void {
  const file = getConfigPath()
  const out = normalize(config)
  try {
    // js-yaml 4 的 allowUnicode 默认为 true，中文会原样写出而不是转义
    fs.writeFileSync(file, yaml.dump(out, { sortKeys: false }), 'utf-8')
  } catch (e) {
    logger.error('配置文件写入失败: ' + String(e))
  }
}

/** 只改 comics 数组，其它配置不动。用于每下载完一章就落盘，保证崩溃安全。 */
export function updateComics(
  mutator: (comics: ComicSubscription[]) => ComicSubscription[]
): AppConfig {
  const config = loadConfig()
  config.comics = mutator(config.comics)
  saveConfig(config)
  return config
}

export function upsertSubscription(
  comic: { name: string; path: string },
  downloadLimit?: number
): AppConfig {
  const config = loadConfig()
  const existing = config.comics.find((c) => c.path === comic.path)
  if (existing) {
    existing.name = comic.name || existing.name
    if (downloadLimit) existing.download_limit = downloadLimit
  } else {
    config.comics.push({
      name: comic.name,
      path: comic.path,
      last_chapter: 0,
      download_limit: downloadLimit ?? DEFAULT_DOWNLOAD_LIMIT,
      last_check_time: ''
    })
  }
  saveConfig(config)
  return config
}

export function removeSubscription(comicPath: string): AppConfig {
  const config = loadConfig()
  config.comics = config.comics.filter((c) => c.path !== comicPath)
  saveConfig(config)
  return config
}

/** 写入下载完成标记 + 检查时间 */
export function markChapterDownloaded(comicPath: string, chapterIndex: number): void {
  updateComics((comics) => {
    const c = comics.find((x) => x.path === comicPath)
    if (c) {
      c.last_chapter = Math.max(c.last_chapter, chapterIndex)
      c.last_check_time = nowString()
    }
    return comics
  })
}

export function markChecked(comicPath: string): void {
  updateComics((comics) => {
    const c = comics.find((x) => x.path === comicPath)
    if (c) c.last_check_time = nowString()
    return comics
  })
}

function nowString(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}
