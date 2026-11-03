import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

export function desktopWindow() {
  return isTauri() ? getCurrentWindow() : null
}

export async function dragWindow(event: MouseEvent) {
  if (event.button !== 0 || !(event.target instanceof Element)) return
  if (event.target.closest('button, a, input, select, textarea, [data-window-controls]')) return
  const appWindow = desktopWindow()
  if (!appWindow) return
  event.preventDefault()
  try {
    if (event.detail === 2) await appWindow.toggleMaximize()
    else await appWindow.startDragging()
  } catch (error) {
    console.error('Window drag failed:', error)
  }
}

export async function syncWindowTheme(theme: string) {
  try {
    await desktopWindow()?.setTheme(theme === 'dark' ? 'dark' : 'light')
  } catch (error) {
    console.error('Window theme update failed:', error)
  }
}
