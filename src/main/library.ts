import fs from 'fs'
import path from 'path'
import type { LibraryChapter, LibraryComic } from '../shared/types'
import { getOutDir } from './paths'
import { logger } from './logger'
import { getComic, searchComic } from './api/copymanga'
import { IMAGE_HEADERS } from './api/copymanga'
import { toJpegUrl } from './download/image'
import { dropMeta, forgetChapter, isChapterComplete, readMeta } from './meta'
import { resolveInside, sanitizeName } from './safe-path'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp'])

/** 被 AI 判定为广告的页移到这里。正文目录里就干净了 */
export const ADS_DIR = '_ads'

export function isImageFile(file: string): boolean {
  return IMAGE_EXT.has(path.extname(file).toLowerCase())
}

/** 漫画目录下的封面缓存文件 */
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp']

export function coverPathFor(comicName: string): string {
  // 必须和 ensureChapterDir 用同一套清洗，否则漫画名带 '/' 时两边会算出不同的目录
  return path.join(getOutDir(), sanitizeName(comicName), COVER_NAMES[0])
}

function findCover(comicDir: string): string | undefined {
  for (const n of COVER_NAMES) {
    const f = path.join(comicDir, n)
    if (fs.existsSync(f)) return f
  }
  return undefined
}

/**
 * 扫描本地漫画库。
 *
 * 用 fs.promises 而不是 readdirSync：目录多的时候同步遍历会把主进程事件循环
 * 堵死，窗口跟着卡住。异步版本每层目录之间都会让出控制权。
 *
 * 刻意不返回每页的文件名——上千页的库序列化过去要几百 KB 起步，
 * 而渲染层只用得上"第一页"来预览，需要时再单独问。
 */
export async function listLibrary(): Promise<LibraryComic[]> {
  const outDir = getOutDir()
  const comics: LibraryComic[] = []

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(outDir, { withFileTypes: true })
  } catch (e) {
    logger.error('扫描漫画库失败: ' + String(e))
    return comics
  }

  for (const comicDir of entries) {
    if (!comicDir.isDirectory()) continue
    const comicPath = path.join(outDir, comicDir.name)
    const meta = readMeta(comicDir.name)

    const chapters: LibraryChapter[] = []
    let totalPages = 0

    let chapterDirs: fs.Dirent[]
    try {
      chapterDirs = await fs.promises.readdir(comicPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const cd of chapterDirs) {
      if (!cd.isDirectory()) continue
      // .copycopy.json 之类，以及 _ads 广告目录，都不是正文章节
      if (cd.name.startsWith('.') || cd.name === ADS_DIR) continue
      const dir = path.join(comicPath, cd.name)

      let pageCount = 0
      try {
        for (const f of await fs.promises.readdir(dir)) {
          if (isImageFile(f)) pageCount++
        }
      } catch {
        continue
      }
      if (pageCount === 0) continue

      totalPages += pageCount
      const pdfPath = path.join(comicPath, cd.name + '.pdf')
      const rec = meta?.chapters?.[cd.name]
      const complete = isChapterComplete(meta, cd.name, pageCount)

      chapters.push({
        name: cd.name,
        dir,
        pageCount,
        index: chapterIndexFromName(cd.name, chapters.length + 1),
        pdfPath: fs.existsSync(pdfPath) ? pdfPath : undefined,
        expectedPages: rec?.total,
        failedPages: rec?.failed?.length ? rec.failed : undefined,
        complete,
        adCount: rec?.ads?.length ?? 0,
        adChecked: !!rec?.adCheckedAt
      })
    }

    if (chapters.length === 0) continue
    chapters.sort((a, b) => a.index - b.index || naturalCompare(a.name, b.name))
    comics.push({
      name: comicDir.name,
      cover: findCover(comicPath),
      path: comicDir.name,
      chapters,
      totalPages,
      meta: meta ?? undefined,
      incompleteCount: chapters.filter((c) => c.complete === false).length,
      hasPdfCount: chapters.filter((c) => !!c.pdfPath).length
    })
  }

  comics.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return comics
}

/**
 * 从章节目录名里推章节号。目录名是站点给的，各种写法都有：
 *   "第12话"  "第 12 章"  "#12"  "No.12"  "12话"  "001"
 *   "合集 1001-1002"  ← 区间要取起点，取末尾会变成 1002
 * 认不出来时返回 fallback（readdir 顺序里的位置），保证列表不会乱序。
 */
function chapterIndexFromName(name: string, fallback: number): number {
  let m = /第\s*(\d+)/.exec(name)
  if (m) return toIndex(m[1])

  // 区间：取第一个数字
  m = /(\d+)\s*[-~～—]\s*\d+/.exec(name)
  if (m) return toIndex(m[1])

  m = /(?:#|no\.?\s*)(\d+)/i.exec(name)
  if (m) return toIndex(m[1])

  m = /(\d+)\s*$/.exec(name)
  if (m) return toIndex(m[1])

  return fallback
}

function toIndex(s: string): number {
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : 1
}

/** "10.jpg" 排在 "9.jpg" 后面 */
function naturalCompare(a: string, b: string): number {
  const ra = /^(\d+)/.exec(a)
  const rb = /^(\d+)/.exec(b)
  if (ra && rb) {
    const d = parseInt(ra[1], 10) - parseInt(rb[1], 10)
    if (d !== 0) return d
  }
  return a.localeCompare(b, 'zh')
}

/** 找某个漫画的章节目录，不存在则创建 */
export function ensureChapterDir(comicName: string, chapterName: string): string {
  const dir = path.join(getOutDir(), sanitizeName(comicName), sanitizeName(chapterName))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 列出某章的图片（预览用，按阅读顺序） */
export function listChapterFiles(dir: string): string[] {
  const target = resolveInside(getOutDir(), dir)
  if (!target) return []
  try {
    return fs
      .readdirSync(target)
      .filter(isImageFile)
      .sort(naturalCompare)
      .map((f) => path.join(target, f))
  } catch {
    return []
  }
}

/**
 * 删除章节 / 整部漫画。
 *
 * 名字来自渲染层，必须解析回 out/ 之内再动手——
 * 否则 deleteComic('../../Windows') 会把整个 Windows 目录递归删掉。
 */
export function deleteChapter(comicName: string, chapterName: string): boolean {
  const dir = resolveInside(getOutDir(), comicName, chapterName)
  if (!dir) {
    logger.warn(`拒绝删除越界路径: ${comicName} / ${chapterName}`)
    return false
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    const pdf = dir + '.pdf'
    if (fs.existsSync(pdf)) fs.rmSync(pdf, { force: true })
    // 元信息里也要抹掉，否则删完还会显示"不完整"
    forgetChapter(comicName, chapterName)
    logger.info(`已删除 ${comicName} / ${chapterName}`)
    return true
  } catch (e) {
    logger.error('删除章节失败: ' + String(e))
    return false
  }
}

/** 批量删除，返回成功/失败数。逐个走 deleteChapter，越界的自动跳过。 */
export function deleteChapters(
  items: Array<{ comicName: string; chapterName: string }>
): { ok: number; failed: number } {
  let ok = 0
  let failed = 0
  for (const it of items) {
    if (deleteChapter(String(it?.comicName ?? ''), String(it?.chapterName ?? ''))) ok++
    else failed++
  }
  return { ok, failed }
}

/** 删除整部漫画（含封面与所有 PDF） */
export function deleteComic(comicName: string): boolean {
  const dir = resolveInside(getOutDir(), comicName)
  if (!dir) {
    logger.warn(`拒绝删除越界路径: ${comicName}`)
    return false
  }
  try {
    if (!fs.existsSync(dir)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    dropMeta(comicName)
    logger.info('已删除整部漫画：' + comicName)
    return true
  } catch (e) {
    logger.error('删除漫画失败: ' + String(e))
    return false
  }
}

/** 库里所有"已知下缺页"的章节，元信息里带 uuid 的才能直接重排 */
export function listIncompleteChapters(): Array<{
  comicName: string
  chapterName: string
  uuid: string
  comicPath: string
}> {
  const out: Array<{ comicName: string; chapterName: string; uuid: string; comicPath: string }> = []
  for (const entry of safeReadDir(getOutDir())) {
    if (!entry.isDirectory()) continue
    const meta = readMeta(entry.name)
    if (!meta?.pathWord) continue
    for (const [chapterName, rec] of Object.entries(meta.chapters ?? {})) {
      if (rec.failed?.length && rec.uuid) {
        out.push({
          comicName: entry.name,
          chapterName,
          uuid: rec.uuid,
          comicPath: meta.pathWord
        })
      }
    }
  }
  return out
}

/* ---------------- 广告页归档 ---------------- */

/**
 * 把判为广告的页移进 <章节目录>/_ads/。
 *
 * 为什么不删：AI 会误判，删掉就找不回来了。移到子目录里，
 * 正文目录自然变干净（readdir + isImageFile 会自动跳过目录），
 * 想恢复只要移回去。
 */
export function moveAdsToArchive(
  comicName: string,
  chapterName: string,
  pageFiles: string[]
): { moved: number; failed: number } {
  const dir = resolveInside(getOutDir(), comicName, chapterName)
  if (!dir) return { moved: 0, failed: pageFiles.length }

  const adsDir = path.join(dir, ADS_DIR)
  let moved = 0
  let failed = 0
  try {
    fs.mkdirSync(adsDir, { recursive: true })
  } catch (e) {
    logger.error(`创建 ${ADS_DIR} 目录失败: ${String(e)}`)
    return { moved: 0, failed: pageFiles.length }
  }

  for (const file of pageFiles) {
    // 必须在章节目录之内，不能让 pageFiles 把文件搬去别处
    if (!resolveInside(dir, path.basename(file))) {
      failed++
      continue
    }
    try {
      const target = path.join(adsDir, path.basename(file))
      if (fs.existsSync(target)) fs.rmSync(target, { force: true })
      fs.renameSync(file, target)
      moved++
    } catch {
      failed++
    }
  }
  return { moved, failed }
}

/** 把广告页移回正文，撤销归档。pages 传全部则清空 _ads/。 */
export function restoreAds(
  comicName: string,
  chapterName: string,
  pages?: number[]
): number {
  const dir = resolveInside(getOutDir(), comicName, chapterName)
  if (!dir) return 0
  const adsDir = path.join(dir, ADS_DIR)
  if (!fs.existsSync(adsDir)) return 0

  let want: Set<string> | null = null
  if (Array.isArray(pages) && pages.length > 0) {
    want = new Set(pages.map((p) => `${String(p).padStart(3, '0')}.jpg`))
  }

  let restored = 0
  for (const entry of safeReadDir(adsDir)) {
    const name = entry.name
    if (!isImageFile(name)) continue
    if (want && !want.has(name)) continue
    const from = path.join(adsDir, name)
    const to = path.join(dir, name)
    // 正文里已经有同名文件就不覆盖，宁可留着 _ads 里
    if (fs.existsSync(to)) continue
    try {
      fs.renameSync(from, to)
      restored++
    } catch {
      /* 单个失败不影响其它 */
    }
  }
  return restored
}

/** 该章当前在 _ads/ 里的页码（1 起） */
export function listArchivedAdPages(chapterDir: string): number[] {
  const target = resolveInside(getOutDir(), chapterDir)
  if (!target) return []
  const adsDir = path.join(target, ADS_DIR)
  if (!fs.existsSync(adsDir)) return []
  const out: number[] = []
  for (const entry of safeReadDir(adsDir)) {
    if (!isImageFile(entry.name)) continue
    const m = /^(\d+)/.exec(entry.name)
    if (m) out.push(Number(m[1]))
  }
  return out.sort((a, b) => a - b)
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 补全封面。
 *
 * 优先用 .copycopy.json 里记着的 path_word 直接查详情（1 次请求）；
 * 老版本下载的没有元信息，才退回"按目录名搜索反查"（3 次请求，还可能认错）。
 */
export async function syncCover(comicName: string): Promise<boolean> {
  const target = coverPathFor(comicName)
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return true
  } catch {
    /* 继续 */
  }

  let pathWord = readMeta(comicName)?.pathWord
  let cover: string | undefined

  if (pathWord) {
    const detail = await getComic(pathWord)
    cover = detail.ok ? detail.data?.cover : undefined
  } else {
    // 没有元信息，只能按名字搜。优先完全同名的结果
    const res = await searchComic(comicName, 1)
    if (!res.ok) return false
    const list = res.data?.list ?? []
    if (list.length === 0) return false
    const hit = list.find((c) => c.name === comicName) ?? list[0]
    pathWord = hit.path_word
    const detail = await getComic(pathWord)
    cover = (detail.ok ? detail.data?.cover : null) ?? hit.cover
  }

  if (!cover) return false

  try {
    const r = await fetch(toJpegUrl(cover), {
      headers: IMAGE_HEADERS,
      signal: AbortSignal.timeout(20_000)
    })
    if (!r.ok) return false
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 1024) return false
    // 目录可能还不存在（漫画名带非法字符时清洗结果和真实目录对不上）
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, buf)
    logger.info('已补全封面：' + comicName)
    return true
  } catch (e) {
    logger.warn('封面补全失败 ' + comicName + ': ' + String(e))
    return false
  }
}
