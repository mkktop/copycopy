import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../services/api'
import { defaultSettings } from '../types'
import type { Settings } from '../types'
export const useAppStore = defineStore('app', () => {
  const settings = ref<Settings>({ ...defaultSettings })
  const ready = ref(false)
  const loading = ref(false)
  const startupError = ref('')
  const paths = ref({ data: '', downloads: '', cache: '' })
  // 后端 Snapshot.version：保留并在侧栏展示，避免字段存而不用。
  const version = ref('')
  const notices = ref<Array<{ id: number; text: string; error: boolean }>>([])
  const confirmation = ref<{
    title: string
    message: string
    label: string
    danger: boolean
  } | null>(null)
  let answer: ((value: boolean) => void) | null = null
  function confirm(
    title: string,
    message: string,
    label = '确认',
    danger = false
  ): Promise<boolean> {
    if (answer) answer(false)
    confirmation.value = { title, message, label, danger }
    return new Promise((resolve) => {
      answer = resolve
    })
  }
  function respond(value: boolean) {
    confirmation.value = null
    answer?.(value)
    answer = null
  }
  const systemDark = ref(matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = computed(() =>
    settings.value.appearance === 'system'
      ? systemDark.value
        ? 'dark'
        : 'light'
      : settings.value.appearance
  )
  let noticeId = 0
  // 保存所有定时句柄，store 卸载时统一清理，避免卸载后仍改写响应式状态。
  const noticeTimers = new Set<ReturnType<typeof setTimeout>>()
  onScopeDispose(() => {
    for (const timer of noticeTimers) clearTimeout(timer)
    noticeTimers.clear()
  })
  function notify(text: string, error = false) {
    const id = ++noticeId
    notices.value.push({ id, text, error })
    const timer = setTimeout(
      () => {
        notices.value = notices.value.filter((item) => item.id !== id)
        noticeTimers.delete(timer)
      },
      error ? 6500 : 3500
    )
    noticeTimers.add(timer)
  }
  async function run<T>(job: () => Promise<T>, success?: string): Promise<T | undefined> {
    try {
      const result = await job()
      if (success) notify(success)
      return result
    } catch (error) {
      notify(String(error), true)
      return undefined
    }
  }
  async function save(patch: Partial<Settings>) {
    settings.value = await api.settings(patch)
    paths.value.downloads = settings.value.downloadDirectory
    return settings.value
  }
  return {
    confirmation,
    confirm,
    respond,
    settings,
    ready,
    loading,
    startupError,
    paths,
    version,
    notices,
    systemDark,
    theme,
    notify,
    run,
    save
  }
})
