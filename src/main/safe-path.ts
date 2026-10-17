import path from 'path'
import fs from 'fs'

/**
 * 路径安全工具。
 *
 * 下载目录 out/ 里的漫画名、章节名有一部分来自站点接口，属于不可信输入；
 * 另一部分来自渲染层 IPC，同样需要当成不可信处理。
 * 凡是拿这些片段拼路径的地方，都必须先过这里的函数。
 */

/** Windows 保留设备名，目录名撞上这些会指向设备而不是文件系统 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** 单个路径片段的长度上限，留出余量给 out/ 前缀，避免撞上 MAX_PATH */
const MAX_SEGMENT = 100

/**
 * 把若干路径片段解析到 base 目录之内，任何越界都返回 null。
 *
 * 用 path.relative 判断而不是字符串前缀比较：
 *   'D:\\app\\outsecret'.startsWith('D:\\app\\out') === true   ← 前缀写法会被绕过
 *   path.relative('D:\\app\\out', 'D:\\app\\outsecret') === '..\\outsecret'  ← 这里能识别
 *
 * 另外 path.resolve 遇到绝对路径片段会直接丢弃 base（'C:\\Windows' 之类），
 * 这种情况 relative 会返回绝对路径，一并挡掉。
 */
export function resolveInside(base: string, ...segments: string[]): string | null {
  if (segments.length === 0) return null
  // 空段会被 path.resolve 静默丢弃，等于把后面的片段顶到上一层：
  // resolveInside(out, '', '第1话') 会解析成 out/第1话——恰好不越界，
  // 于是带着空漫画名的调用就摸到了顶层路径。空段没有合法语义，直接拒绝。
  if (segments.some((s) => typeof s !== 'string' || s === '')) return null
  const root = path.resolve(base)
  const target = path.resolve(root, ...segments)
  const rel = path.relative(root, target)
  // rel 为空 = target 就是 base 本身；绝对 = 跨盘符；'..' 开头 = 越界。
  // 注意不能简单用 startsWith('..')，'..foo' 是合法的目录名。
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
    return null
  }
  return target
}

/** 站点名 -> 合法且唯一的目录名 */
export function sanitizeName(name: unknown): string {
  let s = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_') // 文件系统非法字符
    .replace(/[\x00-\x1f\x7f]/g, '') // 控制字符
    .trim()

  // '.' / '..' 会被 path.join 当成目录跳转，必须先干掉（'..' 是真值，兜底分支拦不住）
  if (/^\.+$/.test(s)) s = '_'
  // NTFS 会静默丢弃结尾的点和空格，"第1话." 和 "第1话" 会变成同一个目录
  s = s.replace(/[. ]+$/, '')

  if (!s) return '未命名'
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).replace(/[. ]+$/, '') || '未命名'
  if (WINDOWS_RESERVED.test(s)) s = '_' + s
  return s
}

/** 同步判断文件是否存在且非空（断点续传判定用） */
export function existingSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * remote:// 协议的中转地址是否该被拒。
 *
 * 渲染层要是被 XSS 拿到，这个协议就是个现成的 SSRF 口子，
 * 所以只放 http(s)，并挡掉指向本机/内网/云元数据的目标。
 *
 * 已知边界：这里只查主机名和字面量 IP，不做 DNS 解析，
 * 所以"域名解析到 127.0.0.1"这种是挡不住的。彻底堵需要解析 DNS
 * 再校验实际连接地址，还要防 TOCTOU，代价远大于收益——
 * 这里的定位是纵深防御的第一层，不是唯一一道。
 */
export function isBlockedRemoteUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return true
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true

  // IPv4 字面量
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const parts = v4.slice(1).map(Number)
    if (parts.some((n) => !Number.isInteger(n) || n > 255)) return true
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // 云元数据 169.254.169.254
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  }

  // IPv6：:: / ::1 / fe80::(链路本地) / fc,fd(ULA)
  if (host === '::' || host === '::1') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true

  return false
}
