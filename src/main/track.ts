import type { ComicSubscription } from '../shared/types'
import { getChapters, getTotalChapters } from './api/copymanga'
import { loadConfig, markChecked, upsertSubscription } from './config'
import { logger } from './logger'
import { queue, type EnqueueRequest } from './download/queue'

/**
 * 追更检查：对每个订阅漫画比对总章节数，把新增章节按 download_limit 投进下载队列。
 * 这是原 Python 版 check_and_download_comics 的桌面端等价物。
 */
export async function checkUpdates(): Promise<{ checked: number; queued: number }> {
  const config = loadConfig()
  if (config.comics.length === 0) {
    logger.info('没有配置任何追更漫画，跳过检查')
    return { checked: 0, queued: 0 }
  }

  logger.info('===== 开始检查更新 =====')
  const requests: EnqueueRequest[] = []
  let checked = 0

  for (const sub of config.comics) {
    if (queue.isBusy()) {
      logger.warn('下载队列正忙，本次检查中止（可在队列空闲后重试）')
      break
    }

    const total = await getTotalChapters(sub.path)
    if (!total.ok) {
      logger.warn(`《${sub.name}》检查失败: ${total.error}`)
      continue
    }
    checked++

    const latest = total.data
    const from = sub.last_chapter + 1
    if (latest <= sub.last_chapter) {
      logger.info(`《${sub.name}》已更新至第 ${latest} 章，无新章节`)
      markChecked(sub.path)
      continue
    }

    // 按 download_limit 截断，从旧到新
    const end = Math.min(latest, sub.last_chapter + sub.download_limit)
    logger.info(
      `《${sub.name}》检测到更新：最新 ${latest} 章，本次下载第 ${from}~${end} 章`
    )

    const fetched = await fetchChapters(sub.path, from, end)
    for (const ch of fetched) {
      requests.push({
        comicPath: sub.path,
        comicName: sub.name,
        chapterIndex: ch.index,
        chapterName: ch.name,
        uuid: ch.uuid,
        trackSubscription: true
      })
    }
  }

  if (requests.length > 0) {
    queue.enqueue(requests)
  }
  logger.info('===== 检查更新完成 =====')
  return { checked, queued: requests.length }
}

/** 拉取 [from, to] 区间的章节（跨 50 一页的分页边界） */
async function fetchChapters(
  comicPath: string,
  from: number,
  to: number
): Promise<Array<{ index: number; name: string; uuid: string }>> {
  const out: Array<{ index: number; name: string; uuid: string }> = []
  const PAGE = 50

  let page = Math.floor((from - 1) / PAGE) + 1
  const lastPage = Math.ceil(to / PAGE)

  while (page <= lastPage) {
    const res = await getChapters(comicPath, page)
    if (!res.ok) {
      logger.warn(`获取章节列表失败: ${res.error}`)
      break
    }
    const offset = res.data.offset
    for (let i = 0; i < res.data.list.length; i++) {
      const index = offset + i + 1
      if (index < from || index > to) continue
      const ch = res.data.list[i]
      out.push({ index, name: ch.name, uuid: ch.uuid })
    }
    page++
  }

  out.sort((a, b) => a.index - b.index)
  return out
}

/** 加入追更订阅 */
export function subscribe(comic: { name: string; path: string }, downloadLimit?: number) {
  const config = upsertSubscription(comic, downloadLimit)
  logger.info(`已加入追更订阅：${comic.name}`)
  return config
}
