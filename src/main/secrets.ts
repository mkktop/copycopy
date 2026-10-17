import { safeStorage } from 'electron'
import { logger } from './logger'

/**
 * API Key 的存储。
 *
 * 明文写进 comic.yaml 的话，谁拿到数据目录（便携版是整个文件夹）就能看到。
 * Windows 上 safeStorage 走 DPAPI，用当前用户凭据加密，换机器解不开——
 * 这正是我们想要的：Key 不跟着文件夹到处跑。
 *
 * 解密失败（换机、换了 Windows 账号）时不能抛错打断整个配置加载，
 * 只能当"没配过 Key"处理，提示用户重新填。
 */

const PREFIX = 'safeStorage:'

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptSecret(plain: string): string | null {
  if (!plain) return null
  if (!isEncryptionAvailable()) {
    // 没有加密能力就不写盘，宁可让用户每次填，也不能明文落盘
    logger.warn('系统加密不可用，API Key 不会保存到磁盘')
    return null
  }
  try {
    return PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch (e) {
    logger.warn('加密 API Key 失败: ' + String(e))
    return null
  }
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null
  if (!stored.startsWith(PREFIX)) {
    // 老版本可能明文存过，直接当明文读，便于升级
    return stored
  }
  try {
    if (!isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'))
  } catch {
    logger.warn('API Key 解密失败（可能换了机器或系统账号），需要重新填写')
    return null
  }
}
