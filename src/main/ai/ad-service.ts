import fs from 'fs'
import path from 'path'
import { loadConfig } from '../config'
import { logger } from '../logger'
import { readMeta, rememberAds, forgetAds } from '../meta'
import { resolveInside } from '../safe-path'
import { getOutDir } from '../paths'
import { isImageFile, listLibrary, moveAdsToArchive, restoreAds, ADS_DIR } from '../library'
import { decryptSecret } from '../secrets'
import { detectChapterAds, type AdVerdict } from './ad-detect'

/**
 * 广告检测的对外接口。
 *
 * 统一在这里做 fail-open 兜底：任何一步失败都不动文件，
 * 只把这次标记为"未检测"，下次还能重试。
 */

export interface DetectChapterOutcome {
  comicName: string
  chapterName: string
  ok: boolean
  skipped?: boolean
  moved: number
  ads: number[]
  /** 逐页判定明细，便于排查误判 */
  verdicts?: AdVerdict[]
  error?: string
  elapsedMs: number
}

interface AiSettings {
  enabled: boolean
  key: string | null
  baseUrl: string
  model: string
  headPages: number
  tailPages: number
  maxAdPages: number
  threshold: number
}

export function readAiSettings(): AiSettings {
  const g = loadConfig().global
  return {
    enabled: g.ai_enabled === 1,
    key: decryptSecret(g.ai_api_key_enc),
    baseUrl: g.ai_base_url,
    model: g.ai_model,
    headPages: g.ai_head_pages,
    tailPages: g.ai_tail_pages,
    maxAdPages: g.ai_max_ad_pages,
    threshold: g.ai_threshold
  }
}

export function isAiReady(): boolean {
  const s = readAiSettings()
  return s.enabled && !!s.key
}

/**
 * 全局并发闸门。
 *
 * 批量检测会一次提交很多章，没闸的话限流和费用都失控。
 * 上限是运行期可改的配置，所以每次 acquire 都重新读——改完立即生效，不用重启。
 */
const gate = { active: 0, waiters: [] as Array<() => void> }

function currentLimit(): number {
  try {
    return Math.max(1, Math.min(5, loadConfig().global.ai_concurrency || 3))
  } catch {
    return 3
  }
}

async function acquireSlot(): Promise<void> {
  if (gate.active < currentLimit()) {
    gate.active++
    return
  }
  await new Promise<void>((resolve) => gate.waiters.push(resolve))
  gate.active++
}

function releaseSlot(): void {
  gate.active = Math.max(0, gate.active - 1)
  gate.waiters.shift()?.()
}

/** 当前并发占用，供 UI 显示 */
export function aiActiveCount(): number {
  return gate.active
}

/** 该章正文目录下的图片，按阅读顺序。不含 _ads（那是目录，本就过滤掉） */
function bodyImages(chapterDir: string): string[] {
  try {
    return fs
      .readdirSync(chapterDir)
      .filter(isImageFile)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((f) => path.join(chapterDir, f))
  } catch {
    return []
  }
}

/**
 * 检测单个章节。force=true 时无视已有的 adCheckedAt 重跑。
 */
export async function detectAdsForChapter(
  comicName: string,
  chapterName: string,
  force = false,
  signal?: AbortSignal
): Promise<DetectChapterOutcome> {
  const base = { comicName, chapterName, moved: 0, ads: [] as number[] }
  const s = readAiSettings()

  if (!s.enabled) return { ...base, ok: false, skipped: true, error: 'AI 功能未启用', elapsedMs: 0 }
  if (!s.key) return { ...base, ok: false, skipped: true, error: '未配置 API Key', elapsedMs: 0 }

  const dir = resolveInside(getOutDir(), comicName, chapterName)
  if (!dir) return { ...base, ok: false, error: '章节路径越界', elapsedMs: 0 }

  const meta = readMeta(comicName)
  const rec = meta?.chapters?.[chapterName]
  if (!force && rec?.adCheckedAt) {
    return {
      ...base,
      ok: true,
      skipped: true,
      ads: rec.ads ?? [],
      elapsedMs: 0
    }
  }

  // 把已归档的广告页挪回来一起判定，否则它们不在正文列表里，
  // 页码和模型返回的 index 就对不上了
  const archived = fs.existsSync(path.join(dir, ADS_DIR))
    ? (function () {
        restoreAds(comicName, chapterName)
        return true
      })()
    : false
  void archived

  const files = bodyImages(dir)
  await acquireSlot()
  let res: Awaited<ReturnType<typeof detectChapterAds>>
  try {
    res = await detectChapterAds(files, {
      baseUrl: s.baseUrl,
      apiKey: s.key,
      model: s.model,
      headPages: s.headPages,
      tailPages: s.tailPages,
      maxAdPages: s.maxAdPages,
      threshold: s.threshold,
      signal
    })
  } finally {
    releaseSlot()
  }

  if (!res.ok) {
    // fail-open：把之前归档的挪回去，保持原样
    if (archived) restoreAds(comicName, chapterName, rec?.ads)
    logger.warn(`《${comicName}》${chapterName} 广告检测跳过: ${res.error}`)
    return { ...base, ok: false, error: res.error, elapsedMs: res.elapsedMs }
  }

  const hits = res.verdicts.filter((v: AdVerdict) => v.isAd && v.confidence >= s.threshold)
  const adPages = hits.map((v) => v.page).sort((a, b) => a - b)

  if (adPages.length > 0) {
    const targets = adPages.map((p) => files[p - 1]).filter(Boolean)
    const { moved } = moveAdsToArchive(comicName, chapterName, targets)
    if (moved < adPages.length) {
      logger.warn(
        `《${comicName}》${chapterName} 有 ${adPages.length - moved} 页广告未能归档`
      )
    }
    logger.info(
      `《${comicName}》${chapterName} 检出 ${adPages.length} 页广告：${adPages.join(', ')}` +
        `（${hits
          .map((h) => `${h.page}页 ${h.adType ?? ''} ${h.confidence}`)
          .join('；')}）`
    )
  }

  rememberAds(comicName, chapterName, adPages, s.model)

  return { ...base, ok: true, moved: adPages.length, ads: adPages, verdicts: res.verdicts, elapsedMs: res.elapsedMs }
}

/** 库里还没检测过的章节 */
export async function listUncheckedChapters(): Promise<
  Array<{ comicName: string; chapterName: string }>
> {
  const out: Array<{ comicName: string; chapterName: string }> = []
  // library.ts 不依赖本模块，直接引不会成环
  for (const c of await listLibrary()) {
    for (const ch of c.chapters) {
      if (!ch.adChecked) out.push({ comicName: c.name, chapterName: ch.name })
    }
  }
  return out
}

/** 撤销某一章的广告归档 */
export function undoAdsForChapter(comicName: string, chapterName: string): number {
  const n = restoreAds(comicName, chapterName)
  forgetAds(comicName, chapterName)
  logger.info(`《${comicName}》${chapterName} 已恢复 ${n} 页广告`)
  return n
}
