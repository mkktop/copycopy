import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppUpdateState } from '@shared/app-update'

export const useUpdateStore = defineStore('app-update', () => {
  const state = ref<AppUpdateState | null>(null)
  const actionError = ref('')
  const hasUpdate = computed(() => !!state.value?.release)

  function applyState(next: AppUpdateState): void {
    // A progress event can arrive before the initial IPC snapshot resolves.
    if (!state.value || next.revision > state.value.revision) state.value = next
  }

  async function refresh(): Promise<void> {
    applyState(await window.mkk.appUpdateState())
  }

  async function run(action: () => Promise<AppUpdateState>): Promise<void> {
    actionError.value = ''
    try {
      applyState(await action())
    } catch {
      actionError.value = '无法完成操作，请重试。'
    }
  }

  async function openRelease(): Promise<void> {
    actionError.value = ''
    try {
      await window.mkk.appUpdateOpenRelease()
    } catch {
      actionError.value = '无法打开浏览器，请访问 github.com/mkktop/copycopy/releases。'
    }
  }

  return {
    state,
    actionError,
    hasUpdate,
    applyState,
    refresh,
    check: () => run(() => window.mkk.appUpdateCheck()),
    download: () => run(() => window.mkk.appUpdateDownload()),
    install: () => run(() => window.mkk.appUpdateInstall()),
    openRelease
  }
})
