import { app } from 'electron'
import path from 'path'
import fs from 'fs'

/**
 * 数据根目录。
 * 开发态：项目根目录。
 * 打包态：exe 同级目录（便携版语义），这样 config/out/logs 都能随 exe 走。
 */
let baseDir = ''

export function initBaseDir(): string {
  if (baseDir) return baseDir

  // 显式指定数据根目录。自动化测试用它把自己和开发者的配置、下载目录隔开——
  // 否则跑一次 npm test 就会把开发者真实的 config/comic.yaml 覆盖成测试值。
  const override = process.env.MKK_DATA_DIR
  if (override) {
    baseDir = path.resolve(override)
  } else if (app.isPackaged) {
    // 便携版：electron-builder 会把程序解压到临时目录再运行，
    // process.execPath 指向临时目录，必须用 PORTABLE_EXECUTABLE_DIR 拿到 exe 的真实位置
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    if (portableDir) {
      baseDir = portableDir
    } else {
      // 安装版：Program Files 下不可写时退回用户目录
      const exeDir = path.dirname(process.execPath)
      try {
        fs.accessSync(exeDir, fs.constants.W_OK)
        baseDir = exeDir
      } catch {
        baseDir = path.join(app.getPath('appData'), 'CopyCopy')
      }
    }
  } else {
    baseDir = path.resolve(process.cwd())
  }
  fs.mkdirSync(baseDir, { recursive: true })
  return baseDir
}

export function getBaseDir(): string {
  if (!baseDir) initBaseDir()
  return baseDir
}

export function getConfigDir(): string {
  const dir = path.join(getBaseDir(), 'config')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'comic.yaml')
}

export function getOutDir(): string {
  const dir = path.join(getBaseDir(), 'out')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getLogDir(): string {
  const dir = path.join(getBaseDir(), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 未完成队列的落盘位置，退出不丢任务 */
export function getQueuePath(): string {
  return path.join(getConfigDir(), 'queue.json')
}

/** 远程封面缓存目录 */
export function getCacheDir(): string {
  const dir = path.join(getBaseDir(), 'cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
