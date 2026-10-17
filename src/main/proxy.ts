import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import tls from 'tls'
import { setGlobalDispatcher, ProxyAgent, Agent } from 'undici'
import { logger } from './logger'
import { getBaseDir } from './paths'

/**
 * 网络代理与证书。
 *
 * Node / Electron 的 fetch 既不读系统代理，也不自带较新的 CA 根证书，
 * 所以这里两者都要自己处理：
 *  - 代理：MKK_PROXY > HTTPS_PROXY/HTTP_PROXY > Windows 系统代理
 *  - 证书：内置 Let's Encrypt 的 ISRG Root YE（2025 年新增），
 *          Electron 33 自带的 Node 尚未收录，不加会报
 *          UNABLE_TO_GET_ISSUER_CERT_LOCALLY。
 */

let currentProxy: string | null = null
let dispatcherReady = false

/**
 * 补充根证书的候选路径。
 *
 * 文件名必须和 electron-builder.yml 的 extraResources 一致（isrg-roots.pem），
 * 否则开发态和发布版都找不到，等于这个修复根本没生效。
 */
const EXTRA_CA_FILES = ['isrg-roots.pem', 'isrg-root-ye.pem']

/** 系统根证书 + 内置的补充根证书 */
function buildCa(): string[] {
  const ca = [...tls.rootCertificates]
  try {
    // 打包后 extraResources 在 exe 旁边的 resources/，开发态在项目根的 resources/
    const dirs = [path.join(getBaseDir(), 'resources'), process.resourcesPath]
    for (const dir of dirs) {
      if (!dir) continue
      for (const name of EXTRA_CA_FILES) {
        const f = path.join(dir, name)
        if (!fs.existsSync(f)) continue
        const pem = fs.readFileSync(f, 'utf-8')
        if (pem.trim() && !ca.includes(pem)) ca.push(pem)
        break
      }
    }
  } catch (e) {
    logger.warn('加载内置根证书失败，使用系统根证书: ' + String(e))
  }
  return ca
}

/** 重建全局 dispatcher。proxyUrl 为 null 表示直连。 */
export function setupProxy(proxyUrl?: string | null): string | null {
  const url = proxyUrl === undefined ? getProxyUrl() : proxyUrl ? normalize(proxyUrl) : null
  try {
    const connect = { ca: buildCa() }
    if (url) {
      setGlobalDispatcher(new ProxyAgent({ uri: url, connect }) as never)
      currentProxy = url
      logger.info(`已启用代理：${url}`)
    } else {
      setGlobalDispatcher(new Agent({ connect }) as never)
      if (currentProxy) logger.info('已关闭代理，恢复直连')
      currentProxy = null
    }
    dispatcherReady = true
  } catch (e) {
    logger.error('网络设置应用失败：' + String(e))
  }
  return currentProxy
}

/** 探测可用的代理地址 */
export function getProxyUrl(): string | null {
  const explicit = process.env.MKK_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  if (explicit && explicit.trim()) return normalize(explicit.trim())

  try {
    // 两个值一次查完：串行两次 execFileSync 最坏要在建窗前白等 6 秒
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true }
    )
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return null
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)
    return m ? normalize(m[1]) : null
  } catch {
    return null
  }
}

/** "127.0.0.1:7897" -> "http://127.0.0.1:7897"，兼容分协议写法 */
function normalize(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v
  if (v.includes(';')) {
    const host = /https=([^;]+)/.exec(v)?.[1] || /http=([^;]+)/.exec(v)?.[1]
    return host ? `http://${host.trim()}` : null
  }
  return `http://${v}`
}

export function getCurrentProxy(): string | null {
  return currentProxy
}

export function isDispatcherReady(): boolean {
  return dispatcherReady
}
