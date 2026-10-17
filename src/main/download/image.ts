import fs from 'fs'
import path from 'path'
import { IMAGE_HEADERS } from '../api/copymanga'
import { logger } from '../logger'
import { existingSize } from '../safe-path'

const MAX_RETRIES = 5
const TIMEOUT_MS = 30_000
const BASE_BACKOFF_MS = 800
const MAX_BACKOFF_MS = 8000

export interface DownloadImageResult {
  ok: boolean
  /** 已存在且非空，直接跳过 */
  skipped?: boolean
  /** 实际写出的文件名（含扩展名） */
  file?: string
  bytes?: number
  /** 用户主动取消，不是下载失败 */
  canceled?: boolean
}

/**
 * 图片 CDN 无论请求头怎么带都只发 WebP
 * （实测 content-type 恒为 image/webp，去掉 webp 头也一样），
 * 但把 URL 末尾的 .webp 换成 .jpg 就会返回真正的 JPEG。
 * PDF 只能嵌入 JPEG/PNG，所以统一在这里改写。
 */
export function toJpegUrl(url: string): string {
  return url.replace(/\.webp$/i, '.jpg')
}

/** 错误分级：决定还要不要重试 */
type ErrKind = 'permanent' | 'transient' | 'unknown'

/**
 * 4xx（408/429 除外）重试多少次都不会变好，早停省时间也省带宽；
 * 5xx / 超时 / 连接抖动才是真正该退避重试的。
 */
function classify(msg: string): ErrKind {
  const m = /^HTTP (\d{3})/.exec(msg)
  if (m) {
    const code = Number(m[1])
    if (code === 408 || code === 429) return 'transient'
    if (code >= 400 && code < 500) return 'permanent'
    if (code >= 500) return 'transient'
  }
  if (/abort|timeout|timed?\s*out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|network|fetch failed/i.test(msg)) {
    return 'transient'
  }
  return 'unknown'
}

/** 指数退避 + 全抖动，避免多张图同时失败后一起重试打爆站点 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1))
  return Math.round(ceiling * (0.5 + Math.random() * 0.5))
}

/** 把外部取消信号和超时合并成一个 */
function linkAbort(external: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error('请求超时')), ms)
  const onAbort = (): void => ctl.abort(external?.reason)
  if (external) {
    if (external.aborted) onAbort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctl.signal,
    isCanceled: (): boolean => !!external?.aborted,
    dispose: (): void => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 下载单张图片。策略照搬原 Python 版：最多重试 5 次、超时 30 秒、
 * 失败后指数退避；4xx 直接判定不可重试。
 */
export async function downloadImage(
  url: string,
  dir: string,
  pageNum: number,
  external?: AbortSignal
): Promise<DownloadImageResult> {
  const target = path.join(dir, `${String(pageNum).padStart(3, '0')}.jpg`)

  // 断点续传：已有非空文件直接跳过
  const cached = existingSize(target)
  if (cached > 0) {
    return { ok: true, skipped: true, file: target, bytes: cached }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (external?.aborted) return { ok: false, canceled: true }

    const link = linkAbort(external, TIMEOUT_MS)
    try {
      const res = await fetch(toJpegUrl(url), {
        headers: IMAGE_HEADERS,
        signal: link.signal
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) throw new Error('空响应')

      const ext = detectExtension(buf)
      const file = ext === '.jpg' ? target : target.replace(/\.jpg$/i, ext)
      fs.writeFileSync(file, buf)
      return { ok: true, file, bytes: buf.length }
    } catch (e) {
      if (link.isCanceled()) return { ok: false, canceled: true }

      const reason = e instanceof Error ? e.message : String(e)
      const kind = classify(reason)
      const isLast = attempt >= MAX_RETRIES

      if (kind === 'permanent') {
        logger.error(`第 ${pageNum} 页不可重试（${reason}），放弃`)
        return { ok: false }
      }
      if (isLast) {
        logger.error(`第 ${pageNum} 页下载失败，已达最大重试次数: ${reason}`)
        return { ok: false }
      }

      const wait = backoffMs(attempt)
      logger.warn(`第 ${pageNum} 页下载失败(${reason})，${wait}ms 后第 ${attempt + 1}/${MAX_RETRIES} 次重试`)
      await sleep(wait, external)
    } finally {
      link.dispose()
    }
  }
  return { ok: false }
}

/**
 * 站点请求头带了 webp=1，CDN 可能返回 WebP 却仍按 .jpg 下发。
 * 按魔数纠正扩展名，否则 Electron 内置图片预览可能打不开。
 */
function detectExtension(buf: Buffer): string {
  if (buf.length < 12) return '.jpg'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return '.png'
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return '.gif'
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return '.webp'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp'
  return '.jpg'
}

/** 取消时立即返回，不必睡完整个退避时长 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
