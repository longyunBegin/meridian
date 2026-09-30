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
      }
    }
  } catch (error) {
    console.debug('[meridian] sidecar event poll:', error?.message || error)
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const settings = await meridian.settings()
    await meridian.configureHotkey(settings?.hotkey)
  } catch (error) {
    console.warn('[meridian] hotkey setup failed:', error)
  }
  window.setInterval(pollEvents, 700)
  await import('./app.js')
  const { initializeUpdater } = await import('./lib/updater.js')
  initializeUpdater()
})
