import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { DownloadTask, TaskProgress } from '@shared/types'

/** 速度采样窗口：只看最近这么多秒内的进展，太长的窗口会把 ETA 算得过稳 */
const SPEED_WINDOW_MS = 8000
/** 每个任务保留的采样点上限 */
const MAX_SAMPLES = 20

interface Sample {
  at: number
  done: number
}

export const useDownloadStore = defineStore('download', () => {
  const tasks = ref<DownloadTask[]>([])
  const currentPage = ref<Record<string, number>>({})
  const waiting = ref<number | undefined>()
  const stats = computed(() => ({
    pending: tasks.value.filter((task) => task.status === 'pending').length,
    running: tasks.value.filter((task) => task.status === 'running').length,
    done: tasks.value.filter((task) => task.status === 'done').length,
    failed: tasks.value.filter((task) => task.status === 'failed').length
  }))

  /** 每个任务的速度采样，用来算瞬时速度和剩余时间 */
  const samples = ref<Record<string, Sample[]>>({})
  let revision = 0
  let refreshSequence = 0
  const updates = new Map<string, { revision: number; task: DownloadTask }>()

  function applyProgress(p: TaskProgress): void {
    updates.set(p.task.id, { revision: ++revision, task: p.task })
    const i = tasks.value.findIndex((t) => t.id === p.task.id)
    if (i >= 0) tasks.value[i] = p.task
    else tasks.value.push(p.task)

    if (p.currentPage !== undefined) currentPage.value[p.task.id] = p.currentPage
    waiting.value = p.waitingSeconds

    if (p.task.status === 'running') record(p.task)
    else forget(p.task.id)
  }

  function record(t: DownloadTask): void {
    const list = samples.value[t.id] ?? []
    const now = Date.now()
    const done = t.downloaded + t.skipped
    const last = list[list.length - 1]
    // 同一秒内多次事件不必逐条记
    if (last && now - last.at < 300) return
    list.push({ at: now, done })
    const cutoff = now - SPEED_WINDOW_MS
    while (list.length > 1 && list[0].at < cutoff) list.shift()
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES)
    samples.value[t.id] = list
  }

  function forget(id: string): void {
    if (samples.value[id]) delete samples.value[id]
  }

  /** 页/秒 */
  function speedOf(id: string): number {
    const list = samples.value[id]
    if (!list || list.length < 2) return 0
    const first = list[0]
    const last = list[list.length - 1]
    const dt = (last.at - first.at) / 1000
    if (dt <= 0) return 0
    return (last.done - first.done) / dt
  }

  /** 剩余秒数。速度未知或总数未知时给 null，不要给个假数字 */
  function etaOf(t: DownloadTask): number | null {
    if (t.status !== 'running' || !t.total) return null
    const rate = speedOf(t.id)
    if (rate <= 0.001) return null
    const remaining = t.total - t.downloaded - t.skipped
    if (remaining <= 0) return 0
    return Math.round(remaining / rate)
  }

  const runningTask = computed(() => tasks.value.find((t) => t.status === 'running') ?? null)

  async function refresh(): Promise<void> {
    const request = ++refreshSequence
    const since = revision
    const snapshot = await window.mkk.queueList()
    if (request !== refreshSequence) return
    const merged = new Map(snapshot.map((task) => [task.id, task]))
    for (const [id, update] of updates) {
      if (update.revision > since) merged.set(id, update.task)
      else if (!merged.has(id)) updates.delete(id)
    }
    tasks.value = [...merged.values()]
    const ids = new Set(tasks.value.map((task) => task.id))
    for (const id of Object.keys(samples.value)) if (!ids.has(id)) forget(id)
    for (const id of Object.keys(currentPage.value)) if (!ids.has(id)) delete currentPage.value[id]
  }

  return {
    tasks,
    currentPage,
    waiting,
    stats,
    applyProgress,
    refresh,
    speedOf,
    etaOf,
    runningTask
  }
})
