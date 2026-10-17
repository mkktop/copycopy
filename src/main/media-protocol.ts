import { protocol } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { IMAGE_HEADERS } from './api/copymanga'
import { LIBRARY_SCHEME, REMOTE_SCHEME } from '../shared/ipc'
import { getBaseDir, getOutDir } from './paths'
import { resolveInside, isBlockedRemoteUrl } from './safe-path'
import { logger } from './logger'

/**
 * 两个自定义协议：
 *  - library://  读 out/ 里的本地图片
 *  - remote://   中转站点封面
 */

/** 必须在 app ready 之前登记，否则 <img src="library://..."> 会被拦掉 */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LIBRARY_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    },
    {
      scheme: REMOTE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

function mimeOf(file: string): string | undefined {
  return MIME[path.extname(file).toLowerCase()]
}

/** 按魔数认图片，挡掉 CDN 返回的错误页 / HTML */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return true // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true // JPEG
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return true
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF') return true // WEBP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true // BMP
  return false
}

export function registerLibraryProtocol(): void {
  protocol.handle(LIBRARY_SCHEME, async (request) => {
    try {
      // 先按 / 切再逐段解码：反过来先整体 decodeURIComponent 的话，
      // 段内编码过的 %2F 会被误当成路径分隔符
      const segments = new URL(request.url).pathname
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s))

      // 依然要过包含性校验：渲染层能构造任意 URL
      const file = resolveInside(getOutDir(), ...segments)
      if (!file) return new Response('forbidden', { status: 403 })

      // 只放图片出去，避免同目录下的 PDF、配置之类被 fetch 走
      const mime = mimeOf(file)
      if (!mime) return new Response('forbidden', { status: 403 })

      const stat = await fs.promises.stat(file)
      if (!stat.isFile()) return new Response('not found', { status: 404 })

      const buf = await fs.promises.readFile(file)
      return new Response(new Uint8Array(buf), {
        headers: {
          'content-type': mime,
          'content-length': String(stat.size),
          'cache-control': 'no-cache'
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

/* ---------------- remote:// ---------------- */

/**
 * 渲染层不能直接 <img src="https://站点CDN/...">：
 *  1. 渲染层是 Chromium 的独立网络栈，读不到"设置 → 网络代理"里配的代理
 *  2. 发不出 version/platform/region 这些 CDN 要求的头，容易 403
 * 所以统一由主进程 fetch（自带 ProxyAgent 和 IMAGE_HEADERS）后再返回。
 * 中转地址的 SSRF 防护见 safe-path.ts 的 isBlockedRemoteUrl。
 */

const FETCH_TIMEOUT_MS = 20_000
/** 同一张封面并发请求时共享同一个 promise，避免重复下载 */
const inflight = new Map<string, Promise<Buffer | null>>()

function cacheDir(): string {
  const dir = path.join(getBaseDir(), 'cache', 'remote')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function extFor(url: string): string {
  try {
    const e = path.extname(new URL(url).pathname).toLowerCase()
    return MIME[e] ? e : '.jpg'
  } catch {
    return '.jpg'
  }
}

function cacheFileFor(url: string): string {
  return path.join(cacheDir(), crypto.createHash('sha1').update(url).digest('hex') + extFor(url))
}

async function fetchRemote(url: string): Promise<Buffer | null> {
  if (isBlockedRemoteUrl(url)) return null

  const file = cacheFileFor(url)
  try {
    const st = await fs.promises.stat(file)
    if (st.size > 0) return await fs.promises.readFile(file)
  } catch {
    /* 没缓存，继续下载 */
  }

  try {
    const res = await fetch(url, {
      headers: IMAGE_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow'
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!looksLikeImage(buf)) return null
    await fs.promises.writeFile(file, buf)
    return buf
  } catch {
    return null
  }
}

export function registerRemoteProtocol(): void {
  protocol.handle(REMOTE_SCHEME, async (request) => {
    try {
      // remote://img/<整条 URL 编码后> —— path 里可能带 / 和 ?
      const target = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
      if (!target) return new Response('bad request', { status: 400 })

      let p = inflight.get(target)
      if (!p) {
        p = fetchRemote(target).catch(() => null)
        inflight.set(target, p)
        void p.finally(() => inflight.delete(target))
      }
      const data = await p
      if (!data) return new Response('fetch failed', { status: 502 })

      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': mimeOf(cacheFileFor(target)) ?? 'image/jpeg',
          'cache-control': 'public, max-age=86400'
        }
      })
    } catch (e) {
      logger.warn('remote:// 处理失败: ' + String(e))
      return new Response('error', { status: 500 })
    }
  })
}
