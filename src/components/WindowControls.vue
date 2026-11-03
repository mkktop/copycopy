<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { desktopWindow } from '../utils/desktopWindow'
import AppIcon from './AppIcon.vue'

const appWindow = desktopWindow()
const maximized = ref(false)
const error = ref('')
let active = true
let resizeTimer: ReturnType<typeof setTimeout> | undefined

async function updateMaximized() {
  if (!appWindow) return
  try {
    const value = await appWindow.isMaximized()
    if (active) maximized.value = value
  } catch (e) {
    console.error('Window state query failed:', e)
  }
}
function resized() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(updateMaximized, 80)
}
async function control(action: 'minimize' | 'maximize' | 'close') {
  if (!appWindow) return
  error.value = ''
  try {
    if (action === 'minimize') await appWindow.minimize()
    if (action === 'maximize') {
      await appWindow.toggleMaximize()
      await updateMaximized()
    }
    if (action === 'close') await appWindow.close()
  } catch (e) {
    error.value = '窗口操作失败：' + e
  }
}
onMounted(() => {
  if (!appWindow) return
  updateMaximized()
  window.addEventListener('resize', resized)
  window.addEventListener('focus', updateMaximized)
})
onUnmounted(() => {
  active = false
  clearTimeout(resizeTimer)
  window.removeEventListener('resize', resized)
  window.removeEventListener('focus', updateMaximized)
})
</script>

<template>
  <div v-if="appWindow" class="window-controls" data-window-controls @mousedown.stop @dblclick.stop>
    <button
      class="window-button"
      title="最小化窗口"
      aria-label="最小化窗口"
      @click="control('minimize')"
    >
      <AppIcon name="window-minimize" :size="15" />
    </button>
    <button
      class="window-button"
      :title="maximized ? '还原窗口' : '最大化窗口'"
      :aria-label="maximized ? '还原窗口' : '最大化窗口'"
      @click="control('maximize')"
    >
      <AppIcon :name="maximized ? 'window-restore' : 'window-maximize'" :size="15" />
    </button>
    <button
      class="window-button window-close"
      title="关闭窗口"
      aria-label="关闭窗口"
      @click="control('close')"
    >
      <AppIcon name="close" :size="17" />
    </button>
    <span v-if="error" class="window-error" role="alert">{{ error }}</span>
  </div>
</template>
