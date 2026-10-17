import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { LogLevel, LogLine } from '../shared/types'
import { getLogDir } from './paths'

/**
 * 按天轮转的文件日志 + 内存环形缓冲。
 * 通过 EventEmitter 发出 'line' 事件，index.ts 转发给所有渲染层窗口。
 */
class Logger extends EventEmitter {
  private stream: fs.WriteStream | null = null
  private streamDay = ''
  private buffer: LogLine[] = []
  private readonly bufferLimit = 2000

  private write(level: LogLevel, message: string): void {
    const now = new Date()
    const line: LogLine = {
      time: formatTime(now),
      level,
      message
    }
    const text = `${line.time} - ${level.padEnd(5)} - ${message}`

    this.ensureStream(now)
    this.stream?.write(text + '\n')

    this.buffer.push(line)
    if (this.buffer.length > this.bufferLimit) this.buffer.shift()

    this.emit('line', line)
  }

  private ensureStream(now: Date): void {
    const day = dayKey(now)
    if (this.stream && this.streamDay === day) return

    // 到期关闭，并清理 7 天前的旧日志
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
    const dir = getLogDir()
    const file = path.join(dir, `data_${day}.log`)
    this.stream = fs.createWriteStream(file, { flags: 'a' })
    this.streamDay = day
    this.cleanOldLogs(dir, now)
  }

  private cleanOldLogs(dir: string, now: Date): void {
    try {
      const files = fs.readdirSync(dir)
      for (const f of files) {
        const m = /^data_(\d{4}-\d{2}-\d{2})\.log$/.exec(f)
        if (!m) continue
        // 用本地零点解析。new Date('2026-09-28') 会按 UTC 解析，
        // 东八区就比 today 早 8 小时，7 天边界会误删当天的日志。
        const [y, mo, d] = m[1].split('-').map(Number)
        const age = (now.getTime() - new Date(y, mo - 1, d).getTime()) / 86400000
        if (age > 7) fs.unlinkSync(path.join(dir, f))
      }
    } catch {
      /* 清理失败不影响日志主流程 */
    }
  }

  info(message: string): void {
    this.write('INFO', message)
  }
  warn(message: string): void {
    this.write('WARN', message)
  }
  error(message: string): void {
    this.write('ERROR', message)
  }

  history(limit = 500): LogLine[] {
    return this.buffer.slice(-limit)
  }

  dispose(): void {
    this.stream?.end()
    this.stream = null
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 日志文件名用的日期键，全程本地时区 */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatTime(d: Date): string {
  return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const logger = new Logger()
