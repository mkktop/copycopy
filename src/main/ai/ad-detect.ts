import fs from 'fs'
import path from 'path'
import { logger } from '../logger'
import { chatCompletion, type ChatContentPart } from './client'

/**
 * 首图/尾图广告识别。
 *
 * 设计上的硬性约束：**任何失败都必须保留页面**（fail-open）。
 * 误删正文的代价远大于漏删广告，所以解析失败、超时、限流、字段缺失，
 * 一律当作"没检测出来"，绝不据此移走文件。
 */

export interface AdVerdict {
  /** 1 起的页码 */
  page: number
  isAd: boolean
  adType?: string
  confidence: number
  reason?: string
}

export interface DetectOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 首轮检查头几页 */
  headPages: number
  /** 首轮检查尾几页 */
  tailPages: number
  /** 每侧最多探到第几页（硬上限，防止一路探进正文） */
  maxAdPages: number
  /** 置信度阈值 0~1 */
  threshold: number
  signal?: AbortSignal
}

export interface DetectResult {
  ok: boolean
  verdicts: AdVerdict[]
  error?: string
  elapsedMs: number
  /** 实际送检的图片数 */
  inspected: number
  /** 实际发了几轮请求 */
  rounds: number
}

/** 一次扩展探几页。2 是速度与彻底性的折中 */
const STEP = 2
/** 最多几轮请求，防止两侧都堆满广告时无限探下去 */
const MAX_ROUNDS = 4

const PROMPT = `你是漫画素材审核助手。下面给你同一章漫画的首尾页图片，请逐页判断是否属于【与漫画内容无关的广告】。

判定为广告的典型特征：
- 字幕组 / 汉化组招新、招募翻译
- 求订阅、求打赏、求追更
- QQ 群、微信群、Telegram 等社群宣传
- Patreon / 爱发电 / 咖啡 / 订阅平台推广
- 漫画网站或 App 的推广
- 版权声明页、刊物信息页

以下【不是】广告，不要误判：
- 漫画分镜、角色、剧情画面
- 扉页、彩页、设定资料页
- 片尾的"完"字、下话预告
- 话数标题页（第几话）
- 正文里出现的台标、水印

对每一页输出一个判定。只输出 JSON 数组，不要任何解释文字：
{"pages":[{"index":1,"is_ad":true,"ad_type":"字幕组招新","confidence":0.95,"reason":"含大量QQ群号和招募文案"}]}

其中 index 是图片在本次输入中的序号（从 1 开始），confidence 是 0 到 1 的小数。`

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let p = from; p <= to; p++) if (p >= 1) out.push(p)
  return out
}

/**
 * 从模型返回里稳妥地抠出 JSON 数组。
 * batchPages 是本轮**实际送检**的真实页码，按送检顺序对应模型给的 index。
 */
export function parseVerdicts(raw: string, batchPages: number[]): AdVerdict[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []

  const out: AdVerdict[] = []
  for (const item of arr as Array<Record<string, unknown>>) {
    const idx = Math.trunc(Number(item?.index))
    if (!Number.isFinite(idx) || idx < 1 || idx > batchPages.length) continue
    const conf = Number(item?.confidence)
    out.push({
      page: batchPages[idx - 1],
      isAd: item?.is_ad === true || item?.isAd === true,
      adType: typeof item?.ad_type === 'string' ? item.ad_type : undefined,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
      reason: typeof item?.reason === 'string' ? item.reason.slice(0, 200) : undefined
    })
  }
  return out
}

function isAd(v: AdVerdict | undefined, threshold: number): boolean {
  return !!v && v.isAd && v.confidence >= threshold
}

/* ---------------- 扩展探测策略（纯函数，可脱离网络单测） ---------------- */

export interface ProbeState {
  /** 从头部已探到第几页（0 = 还没探） */
  headProbed: number
  /** 从尾部已探到第几页（0 = 还没探） */
  tailProbed: number
  /** 头部最外侧那页判定为非广告，收手 */
  headDone?: boolean
  /** 尾部最外侧那页判定为非广告，收手 */
  tailDone?: boolean
}

export interface PlanArgs {
  total: number
  /** 首轮头部探几页 */
  headPages: number
  /** 首轮尾部探几页 */
  tailPages: number
  /** 每侧硬上限 */
  cap: number
  step: number
  firstRound: boolean
}

export interface BatchPlan {
  /** 本轮要送检的页，已去掉送过的 */
  pages: number[]
  /** 送完这一轮后的探查深度（还没考虑判定，只是"已发出请求"） */
  next: ProbeState
}

/**
 * 算出下一轮该送检哪些页。
 *
 * 首轮按配置探；之后只有"最外侧那页确实是广告"才会继续往里探，
 * 每次扩 step 页。三条硬约束：
 *  1. 每侧不超过 cap
 *  2. 头尾两侧**绝不能重叠**（否则同一章会被当成两半各标一次）
 *  3. 深度只增不减——之前 Math.min 在空间不足时会让 headProbed 往回退，
 *     于是同一批页被反复规划，陷入死循环
 */
export function planNextBatch(
  st: ProbeState,
  a: PlanArgs,
  sent: Set<number> = new Set()
): BatchPlan {
  const { total, headPages, tailPages, cap, step, firstRound } = a
  const head: number[] = []
  const tail: number[] = []

  if (firstRound) {
    const h = Math.max(0, Math.min(headPages, total - st.tailProbed))
    for (let p = 1; p <= h; p++) head.push(p)
    const t = Math.max(0, Math.min(tailPages, total - h))
    for (let p = total - t + 1; p <= total; p++) tail.push(p)
  } else {
    // 头部最多能探到哪儿：受 cap 和"尾部已探区"双重限制
    const headTo =
      st.headProbed > 0 && !st.headDone
        ? Math.min(st.headProbed + step, cap, total - st.tailProbed)
        : st.headProbed
    for (let p = st.headProbed + 1; p <= headTo; p++) head.push(p)

    // 尾部不能越过头部这一轮要探到的位置
    const tailFloor = Math.max(headTo + 1, total - cap + 1)
    if (st.tailProbed > 0 && !st.tailDone) {
      const tailTo = total - st.tailProbed
      const from = Math.max(tailTo - step + 1, tailFloor)
      for (let p = from; p <= tailTo; p++) tail.push(p)
    }
  }

  const freshHead = head.filter((p) => !sent.has(p))
  const freshTail = tail.filter((p) => !sent.has(p))
  return {
    pages: [...new Set([...freshHead, ...freshTail])].sort((x, y) => x - y),
    next: {
      headProbed: st.headProbed + freshHead.length,
      tailProbed: st.tailProbed + freshTail.length
    }
  }
}

/**
 * 依据已拿到的判定决定每侧是继续还是收手。
 * 最外侧那页不是广告 -> 该侧到此为止。
 *
 * 注意这里**只决定收不收手，不推进深度**。深度由计划器在真正发出请求时
 * 推进；之前在这里就把深度 +step，等于跳过了从没送检的那两页。
 */
export function advanceProbes(
  st: ProbeState,
  isAdAt: (page: number) => boolean,
  a: Pick<PlanArgs, 'total' | 'cap' | 'step'>
): ProbeState {
  const { total, cap } = a
  const { headProbed, tailProbed } = st
  let headDone = st.headDone === true
  let tailDone = st.tailDone === true

  if (headProbed > 0 && !headDone) {
    // 最外侧那页不是广告，或者已经没有可扩的空间了
    headDone = !isAdAt(headProbed) || headProbed >= cap || headProbed >= total - tailProbed
  }
  if (tailProbed > 0 && !tailDone) {
    const edge = total - tailProbed + 1
    tailDone = !isAdAt(edge) || tailProbed >= cap || tailProbed >= total - headProbed
  }
  return { headProbed, tailProbed, headDone, tailDone }
}

/**
 * 从已探到的判定里，取出**从边缘开始的连续广告段**。
 *
 * 章内即使出现广告页也不采纳——那不是要处理的情况。
 * 头尾两段互不重叠：头部段占住前 N 页，尾部段只能从剩下的范围里取。
 */
export function edgeAdPages(
  verdictAt: (page: number) => AdVerdict | undefined,
  isAdPage: (page: number) => boolean,
  total: number
): number[] {
  const head: number[] = []
  for (let p = 1; p <= total; p++) {
    if (!verdictAt(p) || !isAdPage(p)) break
    head.push(p)
  }
  const floor = head.length + 1
  const tail: number[] = []
  for (let p = total; p >= floor; p--) {
    if (!verdictAt(p) || !isAdPage(p)) break
    tail.push(p)
  }
  return [...head, ...tail]
}

/**
 * 对一章的首尾页做广告识别，**边缘连续段会一直往里探**。
 *
 * 译制组的招新往往是连着 2–3 页。只查 1 页的话，把第 1 页移走后第 2 页广告
 * 就暴露在正文开头了。所以规则是：
 *
 *   从首页往内逐页探，连续是广告就继续探，直到撞上非广告为止；尾页同理。
 *   章内页永远不会被标记。
 *
 * 扩展是分轮做的，每轮只发新探到的那几页——没有广告的章节（大多数）
 * 一轮就结束，不会平白多花钱。
 */
export async function detectChapterAds(
  files: string[],
  opts: DetectOptions
): Promise<DetectResult> {
  const t0 = Date.now()
  const total = files.length

  if (!opts.apiKey) {
    return { ok: false, verdicts: [], error: '未配置 API Key', elapsedMs: 0, inspected: 0, rounds: 0 }
  }

  const head = Math.max(0, Math.min(opts.headPages, total))
  const tail = Math.max(0, Math.min(opts.tailPages, total))
  // 每侧上限还要再压一次：短章上 6+6 顶多探掉 12 页，8 页的章就整章没了。
  // 压到两侧加起来也留得下正文为止。
  const cap = Math.max(1, Math.min(opts.maxAdPages, total, Math.floor((total - 1) / 2)))

  // 短章保护：首轮就会覆盖整章时直接不做，否则稍有误判等于把整章端了
  if (total <= head + tail) {
    return {
      ok: false,
      verdicts: [],
      error: `章节只有 ${total} 页，少于检查范围（头${head}+尾${tail}），跳过以免误判整章`,
      elapsedMs: 0,
      inspected: 0,
      rounds: 0
    }
  }

  const verdicts = new Map<number, AdVerdict>()
  const sent = new Set<number>()
  let st: ProbeState = { headProbed: 0, tailProbed: 0 }
  let inspected = 0
  let rounds = 0

  const planArgs: Omit<PlanArgs, 'firstRound'> = {
    total,
    headPages: head,
    tailPages: tail,
    cap,
    step: STEP
  }
  const known = (p: number): boolean => isAd(verdicts.get(p), opts.threshold)

  for (;;) {
    const plan = planNextBatch(st, { ...planArgs, firstRound: rounds === 0 }, sent)
    const fresh = plan.pages.filter((p) => p >= 1 && p <= total && files[p - 1])
    if (fresh.length === 0) break
    if (rounds >= MAX_ROUNDS) {
      logger.warn(`广告检测达到 ${MAX_ROUNDS} 轮上限，停止扩展`)
      break
    }
    fresh.forEach((p) => sent.add(p))
    rounds++
    st = plan.next

    // 贴图。记下"实际送出去的是哪几页"——读不出来的要排除，
    // 否则模型回的 index 会和页码错位
    const parts: ChatContentPart[] = [{ type: 'text', text: PROMPT }]
    const asked: number[] = []
    for (const p of fresh) {
      const data = await readAsDataUrl(files[p - 1])
      if (!data) continue
      parts.push({ type: 'text', text: `第 ${p} 页：` })
      parts.push({ type: 'image_url', image_url: { url: data } })
      asked.push(p)
    }
    if (asked.length === 0) break
    inspected += asked.length

    const r = await chatCompletion({
      model: opts.model,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      messages: [{ role: 'user', content: parts }],
      maxTokens: 1024,
      signal: opts.signal,
      timeoutMs: 90_000
    })

    if (!r.ok) {
      // fail-open：整轮作废，页面一张都不动
      return {
        ok: false,
        verdicts: [],
        error: r.error,
        elapsedMs: Date.now() - t0,
        inspected,
        rounds
      }
    }

    const parsed = parseVerdicts(r.content, asked)
    if (parsed.length === 0) {
      logger.warn(`广告检测无法解析模型输出: ${r.content.slice(0, 120)}`)
      return {
        ok: false,
        verdicts: [],
        error: '无法解析模型返回的 JSON',
        elapsedMs: Date.now() - t0,
        inspected,
        rounds
      }
    }
    for (const v of parsed) verdicts.set(v.page, v)

    // 依据判定决定每侧继续还是收手
    st = advanceProbes(st, known, planArgs)
  }

  const hitPages = edgeAdPages(
    (p) => verdicts.get(p),
    (p) => isAd(verdicts.get(p), opts.threshold),
    total
  )
  const edgeOnly = hitPages.map((p) => verdicts.get(p)!)

  return {
    ok: true,
    verdicts: edgeOnly,
    elapsedMs: Date.now() - t0,
    inspected,
    rounds
  }
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 超过这个大小就跳过并告警，避免 base64 撑爆请求体 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function readAsDataUrl(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const mime = MIME[path.extname(file).toLowerCase()]
      if (!mime) return resolve(null)
      const buf = fs.readFileSync(file)
      if (buf.length > MAX_IMAGE_BYTES) {
        logger.warn(`图片过大，跳过送检: ${file} (${Math.round(buf.length / 1024 / 1024)}MB)`)
        return resolve(null)
      }
      resolve(`data:${mime};base64,${buf.toString('base64')}`)
    } catch {
      resolve(null)
    }
  })
}
