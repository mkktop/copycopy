import { computed, ref } from 'vue'
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
  const notices = ref<Array<{ id: number; text: string; error: boolean }>>([])
  const confirmation = ref<{ title: string; message: string; label: string; danger: boolean } | null>(null)
  let answer: ((value: boolean) => void) | null = null
  function confirm(title: string, message: string, label = '确认', danger = false): Promise<boolean> {
    if (answer) answer(false)
    confirmation.value = { title, message, label, danger }
    return new Promise(resolve => { answer = resolve })
  }
  function respond(value: boolean) { confirmation.value = null; answer?.(value); answer = null }
  const systemDark = ref(matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = computed(() => settings.value.appearance === 'system' ? systemDark.value ? 'dark' : 'light' : settings.value.appearance)
  let noticeId = 0
  function notify(text: string, error = false) {
    const id = ++noticeId
    notices.value.push({ id, text, error })
    setTimeout(() => { notices.value = notices.value.filter(item => item.id !== id) }, error ? 6500 : 3500)
  }
  async function run<T>(job: () => Promise<T>, success?: string): Promise<T | undefined> {
    try { const result = await job(); if (success) notify(success); return result }
    catch (error) { notify(String(error), true); return undefined }
  }
  async function save(patch: Partial<Settings>) {
    settings.value = await api.settings(patch)
    paths.value.downloads = settings.value.downloadDirectory
    return settings.value
  }
  return { confirmation, confirm, respond, settings, ready, loading, startupError, paths, notices, systemDark, theme, notify, run, save }
})
