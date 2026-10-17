import { logger } from '../logger'

/**
 * MiniMax 开放平台客户端（OpenAI 兼容格式）。
 *
 * 实测确认的几件事，别凭印象改：
 *  - 正确域名是 api.minimaxi.com。api.minimax.io 是国际站，Key 不通用，直接 401
 *  - M3 默认会输出 <think>…</think> 的思考过程，会污染 JSON 解析。
 *    关掉的方式是 thinking: { type: 'disabled' }；enable_thinking=false 无效
 *  - 关闭 thinking 后同样的任务 332 token -> 204 token，又快又便宜
 *  - 但 M3.1-Flash-Preview 这类模型强制要求 adaptive thinking，禁用会被拒
 *    （code 2013）。所以先按"禁用"发，撞上 2013 就去掉 thinking 参数重发一次，
 *    多花的思考 token 由 stripThink 兜底清理
 *  - 直连即可（国内服务），但本进程用的是全局 dispatcher，
 *    用户在设置里开了代理时这里也会走代理
 */

export const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1'

/** 模型拒绝 thinking:disabled 时的报错特征（"requires adaptive thinking" / code 2013） */
const ADAPTIVE_REQUIRED = /requires adaptive thinking|"code"\s*:\s*2013/i

export interface ChatContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface ChatOptions {
  model: string
  baseUrl: string
  apiKey: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string | ChatContentPart[] }>
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ChatResult {
  ok: boolean
  content: string
  error?: string
  /** 是否因为限流/服务端错误，值得退避后重试 */
  retryable?: boolean
  elapsedMs: number
}

/** 去掉可能混入的 <think> 思考块和 markdown 代码围栏 */
export function stripThink(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^﻿/, '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

export async function chatCompletion(opts: ChatOptions): Promise<ChatResult> {
  const started = Date.now()
  const base = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeout = opts.timeoutMs ?? 60_000

  // 外部取消信号和超时合并
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error('请求超时')), timeout)
  const onAbort = (): void => ctl.abort(opts.signal?.reason)
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const send = async (disableThinking: boolean): Promise<Response> =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 1024,
          // 关掉思考：这个任务只是二分类，不需要长推理，
          // 留着 <think> 既费 token 又会污染 JSON
          ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
          stream: false
        }),
        signal: ctl.signal
      })

    let res = await send(true)
    let text = await res.text()

    // 强制 adaptive thinking 的模型（如 M3.1-Flash-Preview）会拒掉
    // thinking:disabled（code 2013）。去掉该参数按模型默认重发一次
    if (!res.ok && ADAPTIVE_REQUIRED.test(text)) {
      res = await send(false)
      text = await res.text()
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, content: '', error: 'API Key 无效或无权限', elapsedMs: Date.now() - started }
    }
    if (res.status === 429) {
      return {
        ok: false,
        content: '',
        error: '触发限流，请稍后再试',
        retryable: true,
        elapsedMs: Date.now() - started
      }
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = JSON.parse(text)
        msg = j?.error?.message || j?.message || msg
      } catch {
        msg = `${msg} ${text.slice(0, 120)}`
      }
      return {
        ok: false,
        content: '',
        error: msg,
        retryable: res.status >= 500,
        elapsedMs: Date.now() - started
      }
    }

    let j: {
      choices?: Array<{ message?: { content?: string } }>
    }
    try {
      j = JSON.parse(text)
    } catch {
      return { ok: false, content: '', error: '接口返回的不是 JSON', elapsedMs: Date.now() - started }
    }

    const content = j.choices?.[0]?.message?.content ?? ''
    if (!content) {
      return { ok: false, content: '', error: '接口返回内容为空', elapsedMs: Date.now() - started }
    }
    return { ok: true, content: stripThink(content), elapsedMs: Date.now() - started }
  } catch (e) {
    const canceled = opts.signal?.aborted
    const reason = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      content: '',
      error: canceled ? '已取消' : `请求失败：${reason}`,
      // 取消不是"可重试"，别让上层一直重试
      retryable: !canceled,
      elapsedMs: Date.now() - started
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** 「测试连接」用：只发一句话，确认 Key / 域名 / 模型三样都对 */
export async function testConnection(opts: {
  baseUrl: string
  apiKey: string
  model: string
}): Promise<{ ok: boolean; message: string; elapsedMs?: number }> {
  if (!opts.apiKey) return { ok: false, message: '尚未填写 API Key' }
  const r = await chatCompletion({
    model: opts.model,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    maxTokens: 32,
    timeoutMs: 20_000
  })
  if (r.ok) return { ok: true, message: `连接正常（${r.elapsedMs}ms）`, elapsedMs: r.elapsedMs }

  // 国际站域名最容易踩，给个针对性提示
  if (/api\.minimax\.io/i.test(opts.baseUrl)) {
    logger.warn('检测到国际站域名，Key 与国内站不通用')
  }
  return { ok: false, message: r.error ?? '连接失败' }
}
