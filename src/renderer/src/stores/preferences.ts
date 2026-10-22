import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type Appearance = 'system' | 'light' | 'dark'
const KEY = 'copycopy.appearance'

export const usePreferencesStore = defineStore('preferences', () => {
  let initial: Appearance = 'system'
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') initial = saved
  } catch {
    /* 系统主题仍可正常使用 */
  }
  const appearance = ref<Appearance>(initial)
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const systemDark = ref(media.matches)
  const dark = computed(() =>
    appearance.value === 'system' ? systemDark.value : appearance.value === 'dark'
  )
  const updateSystem = (event: MediaQueryListEvent): void => {
    systemDark.value = event.matches
  }
  media.addEventListener('change', updateSystem)
  onScopeDispose(() => media.removeEventListener('change', updateSystem))
  watch(appearance, (value) => {
    try {
      localStorage.setItem(KEY, value)
    } catch {
      /* 本次会话仍保留选择 */
    }
  })
  watch(
    dark,
    (value) => {
      document.documentElement.dataset.theme = value ? 'dark' : 'light'
    },
    { immediate: true }
  )
  return { appearance, dark }
})
