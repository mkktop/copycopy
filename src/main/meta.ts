import fs from 'fs'
import path from 'path'
import type { ChapterMeta, ComicMeta } from '../shared/types'
import { getOutDir } from './paths'
import { logger } from './logger'
import { sanitizeName } from './safe-path'

/**
 * 每部漫画目录下一个 .copycopy.json，记录站点信息和每章的下载结果。
 *
 * 之前站点 path_word 完全没有落盘，导致：
 *  - 补封面只能先拿目录名去搜索站点反查（3 次请求，还可能认错漫画）
 *  - 站点改字后目录对不上就认不出来了
 *  - 一章 20 页下成 8 页，在库里和"本来就 8 页的短章"长得一样
 *
 * 下载时 path_word 和站点名本来就在手上，顺手写一份成本几乎为零。
 */

const META_FILE = '.copycopy.json'
/** 缓存漫画名 -> 元信息，避免每次扫描漫画库都重复读盘 */
const cache = new Map<string, ComicMeta | null>()

function metaPathFor(comicName: string): string {
  return path.join(getOutDir(), sanitizeName(comicName), META_FILE)
}

function nowString(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 读一部漫画的元信息。没有就是 null，不要返回空对象冒充存在。 */
export function readMeta(comicName: string): ComicMeta | null {
  const key = sanitizeName(comicName)
  if (cache.has(key)) return cache.get(key) ?? null
  let meta: ComicMeta | null = null
  try {
    const raw = fs.readFileSync(metaPathFor(key), 'utf-8')
    const parsed = JSON.parse(raw) as ComicMeta
    if (parsed && typeof parsed === 'object') meta = parsed
  } catch {
    meta = null // 没有文件，或者坏了，都当没有
  }
  cache.set(key, meta)
  return meta
}

function writeMeta(comicName: string, meta: ComicMeta): void {
  const key = sanitizeName(comicName)
  const file = metaPathFor(key)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(meta, null, 2), 'utf-8')
    cache.set(key, meta)
  } catch (e) {
    logger.warn(`写入漫画元信息失败 ${key}: ${String(e)}`)
  }
}

/** 读-改-写。全程同步，Node 单线程下不会被插队。 */
function updateMeta(comicName: string, mutator: (m: ComicMeta) => void): void {
  const meta = readMeta(comicName) ?? {}
  mutator(meta)
  writeMeta(comicName, meta)
}

/** 漫画被删掉后要清缓存，否则同名目录会读到上一部的元信息 */
export function invalidateMeta(comicName: string): void {
  cache.delete(sanitizeName(comicName))
}

/** 记录站点身份。补封面、查更新都靠 pathWord，不用再拿名字去搜。 */
export function rememberComic(
  comicName: string,
  info: { pathWord?: string; name?: string; author?: string; siteTotal?: number }
): void {
  updateMeta(comicName, (m) => {
    if (info.pathWord) m.pathWord = info.pathWord
    if (info.name) m.name = info.name
    if (info.author) m.author = info.author
    if (Number.isFinite(info.siteTotal)) m.siteTotal = info.siteTotal
    m.lastSyncedAt = nowString()
  })
}

/** 记录一章的下载结果。failed 为空才算完整。 */
export function rememberChapterResult(
  comicName: string,
  chapterName: string,
  result: { uuid?: string; total: number; failed: number[] }
): void {
  updateMeta(comicName, (m) => {
    const chapters = (m.chapters ??= {})
    const prev: ChapterMeta = chapters[chapterName] ?? {}
    const failed = result.failed.slice()
    chapters[chapterName] = {
      uuid: result.uuid ?? prev.uuid,
      total: result.total,
      failed,
      // 这次没失败就盖章；之前失败过、这次补齐了也要盖章
      finishedAt: failed.length === 0 ? (prev.finishedAt ?? nowString()) : prev.finishedAt
    }
  })
}

/** 章节被删除后清掉它的记录，避免"删了但还显示不完整" */
export function forgetChapter(comicName: string, chapterName: string): void {
  updateMeta(comicName, (m) => {
    if (m.chapters) delete m.chapters[chapterName]
  })
}

/**
 * 记录广告检测结果。
 * ads 为最终保留在广告页列表里的页码（1 起，可为空数组 = 查过了，没有广告）。
 */
export function rememberAds(
  comicName: string,
  chapterName: string,
  ads: number[],
  model: string
): void {
  updateMeta(comicName, (m) => {
    const chapters = (m.chapters ??= {})
    const prev: ChapterMeta = chapters[chapterName] ?? {}
    chapters[chapterName] = {
      ...prev,
      ads: [...ads].sort((a, b) => a - b),
      adCheckedAt: nowString(),
      adModel: model
    }
  })
}

/** 撤销广告标记。传 pages 只撤销指定的，否则全清。 */
export function forgetAds(
  comicName: string,
  chapterName: string,
  pages?: number[]
): void {
  updateMeta(comicName, (m) => {
    const rec = m.chapters?.[chapterName]
    if (!rec) return
    if (Array.isArray(pages) && pages.length > 0) {
      const drop = new Set(pages)
      rec.ads = (rec.ads ?? []).filter((p) => !drop.has(p))
    } else {
      delete rec.ads
      delete rec.adCheckedAt
      delete rec.adModel
      // 恢复成"从未检测"，用户可以再点一次
      return
    }
    if (rec.ads && rec.ads.length === 0) {
      delete rec.ads
      delete rec.adCheckedAt
      delete rec.adModel
    }
  })
}

/** 该章是否下全了：没有元信息时按"有图就算完整"处理，不误报 */
export function isChapterComplete(
  meta: ComicMeta | null,
  chapterName: string,
  pageCount: number
): boolean {
  const rec = meta?.chapters?.[chapterName]
  if (!rec) return true
  if (rec.failed?.length) return false
  const total = rec.total
  if (typeof total === 'number' && total > 0) return pageCount >= total
  return true
}

/** 漫画整体删掉时连元信息一起清 */
export function dropMeta(comicName: string): void {
  invalidateMeta(comicName)
  try {
    const file = metaPathFor(comicName)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* 目录可能已经没了 */
  }
}
