import { isTauri } from '@tauri-apps/api/core'
import { h } from './dom.js'
import { shouldAutoCheck, updateProgress } from './update-policy.js'

const LAST_ATTEMPT_KEY = 'meridian.updater.lastAttemptAt'
const LAST_SUCCESS_KEY = 'meridian.updater.lastSuccessfulCheckAt'
const CHECK_TIMEOUT_MS = 15_000

let checkPromise = null
let checkedThisSession = false
let updateDialog = null
let pluginCache = null

/**
 * Lazily load the updater/process plugins. Returns null if unavailable.
 * This keeps a plugin failure from breaking the entire app at import time:
 * updater.js is transitively imported by app.js via settings.js, so a throw
 * here would blank the whole window.
 */
async function loadPlugins() {
  if (pluginCache !== null) return pluginCache
  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      import('@tauri-apps/plugin-process'),
    ])
    pluginCache = { check, relaunch }
  } catch {
    pluginCache = null
  }
  return pluginCache
}

function storageGet(key) {
  try { return localStorage.getItem(key) } catch { return null }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, String(value)) } catch { /* Storage may be unavailable; keep the app usable. */ }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function presentUpdate(update) {
  if (updateDialog?.isConnected) {
    if (!updateDialog.open) updateDialog.showModal()
    updateDialog.focus()
    return
  }

  let downloaded = false
  let downloading = false
  let installing = false
  let installed = false
  let receivedBytes = 0
  let totalBytes = null

  const status = h('p', { class: 'update-status-line', role: 'status', 'aria-live': 'polite' }, '准备下载…')
  const progress = h('progress', { class: 'update-progress', max: '100', hidden: true })
  const notes = String(update.body || '').trim() || '此版本没有附带更新说明。'
  const mainButton = h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      if (!downloaded) {
        downloading = true
        mainButton.disabled = true
        cancelButton.disabled = true
        mainButton.textContent = '下载中…'
        progress.hidden = false
        status.textContent = '正在下载更新…'
        try {
          await update.download((event) => {
            if (event.event === 'Started') {
              totalBytes = Number(event.data.contentLength) || null
              receivedBytes = 0
            } else if (event.event === 'Progress') {
              receivedBytes += Number(event.data.chunkLength) || 0
            } else if (event.event === 'Finished' && totalBytes) {
              receivedBytes = totalBytes
            }
            const snapshot = updateProgress(receivedBytes, totalBytes)
            if (snapshot.percent == null) {
              progress.removeAttribute('value')
              status.textContent = `正在下载更新 · ${formatBytes(snapshot.downloaded)}`
            } else {
              progress.value = snapshot.percent
              status.textContent = `正在下载更新 · ${snapshot.percent}% (${formatBytes(snapshot.downloaded)} / ${formatBytes(snapshot.total)})`
            }
          })
          downloaded = true
          progress.value = 100
          status.textContent = '下载完成。请确认后安装并重启。'
          mainButton.textContent = '安装并重启'
          mainButton.disabled = false
          cancelButton.disabled = false
        } catch {
          status.textContent = '下载失败。请检查网络后关闭窗口，再手动重试。'
          mainButton.textContent = '下载失败'
          mainButton.disabled = true
          cancelButton.disabled = false
        } finally {
          downloading = false
        }
        return
      }

      if (installing || installed) return
      installing = true
      mainButton.disabled = true
      cancelButton.disabled = true
      mainButton.textContent = '正在安装…'
      status.textContent = '正在安装更新，请不要退出应用…'
      try {
        await update.install({ restartAfterInstall: true })
        installed = true
        status.textContent = '更新已安装，正在重新启动…'
        // Windows NSIS handles restart from the installer; macOS requires an explicit relaunch.
        if (!/Windows/i.test(navigator.userAgent)) {
          const plugins = await loadPlugins()
          if (plugins) await plugins.relaunch()
        }
      } catch {
        if (installed) {
          status.textContent = '更新已安装，但应用未能自动重启。请手动重新打开 Meridian。'
          mainButton.textContent = '已安装'
        } else {
          status.textContent = '安装未完成。请关闭窗口后重试，或手动安装更新包。'
          mainButton.textContent = '重试安装'
          mainButton.disabled = false
          cancelButton.disabled = false
          installing = false
        }
      }
    },
  }, '下载更新')
  const cancelButton = h('button', {
    class: 'btn',
    onclick: () => updateDialog?.close(),
  }, '稍后')

  const dialog = h('dialog', { class: 'update-dialog', 'aria-labelledby': 'update-dialog-title' },
    h('div', { class: 'update-dialog-head' },
      h('div', {},
        h('p', { class: 'update-eyebrow' }, 'MERIDIAN UPDATE'),
        h('h2', { id: 'update-dialog-title' }, `发现新版本 v${update.version}`),
      ),
      h('span', { class: 'update-version-current' }, `当前 v${update.currentVersion}`),
    ),
    h('div', { class: 'update-dialog-body' },
      h('p', { class: 'update-notes' }, notes),
      progress,
      status,
    ),
    h('div', { class: 'update-dialog-actions' }, cancelButton, mainButton),
  )
  updateDialog = dialog
  dialog.addEventListener('cancel', (event) => {
    if (downloading || installing) event.preventDefault()
  })
  dialog.addEventListener('close', () => {
    if (updateDialog === dialog) updateDialog = null
    if (!installed) void update.close().catch(() => {})
  }, { once: true })
  document.body.append(dialog)
  dialog.showModal()
}

/** Check once at launch at most every 24 hours, or bypass that throttle when called manually. */
export async function checkForUpdates({ automatic = false } = {}) {
  if (!isTauri()) return { status: 'unsupported' }
  if (automatic) {
    if (checkedThisSession || !shouldAutoCheck(storageGet(LAST_ATTEMPT_KEY))) return { status: 'throttled' }
    checkedThisSession = true
  }
  if (checkPromise) return checkPromise

  storageSet(LAST_ATTEMPT_KEY, Date.now())
  checkPromise = (async () => {
    try {
      const plugins = await loadPlugins()
      if (!plugins) return { status: 'unsupported' }
      const update = await plugins.check({ timeout: CHECK_TIMEOUT_MS })
      storageSet(LAST_SUCCESS_KEY, Date.now())
      if (!update) return { status: 'current' }
      presentUpdate(update)
      return { status: 'update', version: update.version }
    } catch {
      // Startup checks intentionally fail silently; the manual button returns a status for the UI.
      return { status: 'failed' }
    }
  })()

  try {
    return await checkPromise
  } finally {
    checkPromise = null
  }
}

export function initializeUpdater() {
  if (isTauri()) void checkForUpdates({ automatic: true })
}

export function updaterAvailable() {
  return isTauri()
}
