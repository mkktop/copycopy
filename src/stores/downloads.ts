import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../services/api'
import type { DownloadTask, QueueSnapshot, TaskStatus } from '../types'
export const useDownloadStore = defineStore('downloads', () => {
  const state = ref<QueueSnapshot>({ revision: -1, tasks: [] })
  const tasks = computed(() => state.value.tasks)
  const counts = computed(() => {
    const value: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      canceled: 0
    }
    tasks.value.forEach((task) => {
      value[task.status]++
    })
    return value
  })
  const busy = computed(() => counts.value.pending + counts.value.running > 0)
  // 全量快照：revision 单调递增守卫，旧版本一律丢弃。
  function apply(snapshot: QueueSnapshot) {
    if (snapshot && snapshot.revision > state.value.revision) state.value = snapshot
  }
  // 增量事件：后端若改为只推变化的 task/tasks，按 id 合并；revision 更大才接受。
  function merge(payload: QueueSnapshot & { task?: DownloadTask; tasks?: DownloadTask[] }) {
    if (!payload) return
    // 带完整 tasks 列表的视为全量快照（兼容现有后端 emit snapshot）。
    if (Array.isArray(payload.tasks) && !payload.task) {
      apply(payload as QueueSnapshot)
      return
    }
    if (payload.revision <= state.value.revision) return
    const changed = payload.task ? [payload.task] : payload.tasks || []
    if (!changed.length) {
      state.value = { revision: payload.revision, tasks: state.value.tasks }
      return
    }
    const byId = new Map(state.value.tasks.map((t) => [t.id, t]))
    for (const task of changed) byId.set(task.id, task)
    state.value = { revision: payload.revision, tasks: [...byId.values()] }
  }
  async function refresh() {
    apply(await api.queue())
  }
  return { tasks, counts, busy, apply, merge, refresh }
})
