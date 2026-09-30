import { invoke } from '@tauri-apps/api/core'
import { dispatchDesktopEvent, createMeridianBridge } from './lib/tauri-bridge.js'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

const meridian = createMeridianBridge()
window.meridian = meridian

async function pollEvents() {
  try {
    const events = await invoke('backend_events')
    for (const event of events || []) {
      dispatchDesktopEvent(event.name, event.payload)
      if (event.name === 'system:notification' && event.payload) {
        let permission = await isPermissionGranted()
        if (!permission) permission = (await requestPermission()) === 'granted'
        if (permission) sendNotification({ title: event.payload.title, body: event.payload.body })
        // 点击通知时 macOS 会激活应用，Rust 侧 RunEvent::Reopen 负责聚焦窗口
      }
      if (event.name === 'system:badge' && event.payload) {
        try {
          await invoke('set_dock_badge', { count: Number(event.payload.count) || 0 })
        } catch (error) {
          console.debug('[meridian] set_dock_badge:', error?.message || error)
        }
      }
    }
  } catch (error) {
    console.debug('[meridian] sidecar event poll:', error?.message || error)
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    // macOS Tauri 透明窗口：加 class 让 CSS 用半透明背景 + vibrancy
    if (navigator.platform?.startsWith('Mac')) document.body.classList.add('tauri-macos')
  } catch { /* 忽略 */ }
  try {
    const settings = await meridian.settings()
    await meridian.configureHotkey(settings?.hotkey)
  } catch (error) {
    console.warn('[meridian] hotkey setup failed:', error)
  }
  window.setInterval(pollEvents, 700)
  await import('./app.js')
  try {
    const { initializeUpdater } = await import('./lib/updater.js')
    initializeUpdater()
  } catch (error) {
    // The updater must never break the main app. Log and continue.
    console.warn('[meridian] updater unavailable:', error?.message || error)
  }
})
