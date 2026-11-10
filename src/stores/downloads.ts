import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../services/api'
import type { QueueSnapshot, TaskStatus } from '../types'
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
  function apply(snapshot: QueueSnapshot) {
    if (snapshot.revision > state.value.revision) state.value = snapshot
  }
  async function refresh() {
    apply(await api.queue())
  }
  return { tasks, counts, busy, apply, refresh }
})
