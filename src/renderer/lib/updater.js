import { isTauri } from '@tauri-apps/api/core'
import { h } from './dom.js'
import { shouldAutoCheck, updateProgress, updatePresentation, canPerformUpdateAction, canCloseUpdate } from './update-policy.js'

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

/** 把 GitHub 自动生成的 markdown 更新说明转成结构化 DOM（纯展示：只建文本节点，不注入 HTML）。 */
function renderInline(text, parent) {
  const tokenRe = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]+\))/g
  let last = 0
  let m
  for (; (m = tokenRe.exec(text));) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)))
    if (m[2] != null) parent.append(h('strong', {}, m[2]))
    else if (m[3] != null) parent.append(h('code', {}, m[3]))
    else parent.append(document.createTextNode(m[4]))
    last = m.index + m[0].length
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)))
}

/** 自动生成的说明里常带裸 URL（… in https://github.com/…/pull/1），正文里只留文字。 */
function dropBareUrls(text) {
  return String(text || '')
    .replace(/(\s+in)?\s*https?:\/\/\S+/g, '')  // "by @dev in <url>" -> "by @dev"
    .replace(/\s{2,}/g, ' ').trim()
}

function renderNotes(text) {
  const root = h('div', { class: 'update-notes' })
  let list = null
  const closeList = () => { list = null }
  const ensureList = (ordered) => {
    const tag = ordered ? 'ol' : 'ul'
    if (!list || list.tagName.toLowerCase() !== tag) {
      list = h(tag, {})
      root.append(list)
    }
    return list
  }
  for (const raw of String(text || '').split('\n')) {
    const line = dropBareUrls(raw.trim())
    if (!line || /^(-{3,}|\*{3,})$/.test(line)) { closeList(); continue }
    let m
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList()
      const hd = h('h3', { class: 'update-notes-h' })
      renderInline(m[2].trim(), hd)
      if (hd.hasChildNodes()) root.append(hd)
    } else if ((m = /^([*\-+])\s+(.*)$/.exec(line))) {
      const li = h('li', {})
      renderInline(m[2].trim(), li)
      if (li.hasChildNodes()) ensureList(false).append(li)
    } else if ((m = /^(\d+)[.)]\s+(.*)$/.exec(line))) {
      const li = h('li', {})
      renderInline(m[2].trim(), li)
      if (li.hasChildNodes()) ensureList(true).append(li)
    } else {
      closeList()
      const p = h('p', {})
      renderInline(line, p)
      root.append(p)
    }
  }
  if (!root.hasChildNodes()) root.append(h('p', {}, '此版本没有附带更新说明。'))
  return root
}

/** 发布日期展示：只取年月日，解析失败就省略。 */
function formatPubDate(date) {
  if (!date) return ''
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function presentUpdate(update, { focus = false } = {}) {
  if (updateDialog?.isConnected) {
    if (!updateDialog.open) updateDialog.show()
    if (focus) updateDialog.focus()
    return updateDialog
  }

  let phase = 'available'
  let downloaded = false
  let installed = false
  let retryInstall = false
  let receivedBytes = 0
  let totalBytes = null
  let dialog
  let mainButton
  let laterButton
  let closeButton
  const status = h('p', { class: 'update-status-line', role: 'status', 'aria-live': 'polite' }, '')
  const fill = h('span', { class: 'update-progress-fill' })
  const progress = h('div', {
    class: 'update-progress-track', hidden: true,
    role: 'progressbar', 'aria-label': '下载进度', 'aria-valuemin': '0', 'aria-valuemax': '100',
  }, fill)
  /** percent 为 null 时走不确定态（滑动条），否则同步视觉进度与读屏数值。 */
  const setProgress = (percent) => {
    progress.hidden = false
    if (percent == null) {
      progress.classList.add('is-indeterminate')
      progress.removeAttribute('aria-valuenow')
      progress.setAttribute('aria-valuetext', '正在下载')
      fill.style.width = ''
    } else {
      const safePercent = Math.max(0, Math.min(100, percent))
      progress.classList.remove('is-indeterminate')
      progress.setAttribute('aria-valuenow', String(safePercent))
      progress.setAttribute('aria-valuetext', `${safePercent}%`)
      fill.style.width = `${safePercent}%`
    }
  }
  const notes = renderNotes(update.body)
  const heading = h('h2', { id: 'update-dialog-title', 'aria-live': 'polite' }, '')
  const description = h('p', { class: 'update-dialog-sub', id: 'update-dialog-description' }, '')
  const versionMeta = h('p', { class: 'update-version-meta' }, '')

  const setPhase = (next) => {
    phase = next
    const presentation = updatePresentation(phase, { retryInstall })
    dialog.dataset.updateState = phase
    heading.textContent = presentation.title
    description.textContent = presentation.description
    mainButton.textContent = presentation.primaryLabel
    mainButton.hidden = !presentation.primaryLabel
    mainButton.disabled = presentation.primaryDisabled
    mainButton.dataset.action = presentation.primaryAction || ''
    closeButton.disabled = !presentation.canClose
    closeButton.setAttribute('aria-disabled', String(!presentation.canClose))
    closeButton.title = presentation.canClose ? '关闭更新提示' : '当前操作完成前无法关闭'
    laterButton.disabled = !presentation.canClose
    laterButton.title = presentation.canClose ? '稍后处理' : '当前操作完成前无法稍后处理'
    if (phase === 'available' || phase === 'cancelled') progress.hidden = true
    else if (phase === 'downloading') progress.hidden = false
    else if (phase === 'ready') setProgress(100)
    else if (phase === 'error' && !retryInstall) progress.hidden = false
    else if (phase === 'installing' || phase === 'installed') progress.hidden = true
  }

  mainButton = h('button', {
    type: 'button', class: 'btn btn-primary update-primary',
    onclick: () => { void runPrimaryAction() },
  }, '')
  laterButton = h('button', {
    type: 'button', class: 'btn update-later',
    onclick: () => requestClose(),
  }, '稍后')
  closeButton = h('button', {
    type: 'button', class: 'update-close', 'aria-label': '关闭更新提示', title: '关闭更新提示',
    onclick: () => requestClose(),
  }, '×')

  const pubDate = formatPubDate(update.date)
  versionMeta.textContent = `Meridian v${update.version} · 当前版本 v${update.currentVersion}` + (pubDate ? ` · 发布于 ${pubDate}` : '')
  dialog = h('dialog', {
    class: 'update-dialog', tabindex: '-1', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': 'update-dialog-title', 'aria-describedby': 'update-dialog-description',
  },
    h('div', { class: 'update-dialog-head' },
      h('div', { class: 'update-dialog-titles' },
        h('p', { class: 'update-eyebrow' }, '软件更新'),
        heading,
        versionMeta,
      ),
      closeButton,
    ),
    h('div', { class: 'update-dialog-body' },
      description,
      h('h3', { class: 'update-notes-title' }, '更新内容'),
      notes,
      h('div', { class: 'update-download-zone' }, progress, status),
    ),
    h('div', { class: 'update-dialog-actions' }, mainButton, laterButton),
  )

  async function runPrimaryAction() {
    const action = mainButton.dataset.action
    if (!canPerformUpdateAction(phase, action, { retryInstall })) return
    if (action === 'download') {
      retryInstall = false
      setPhase('downloading')
      setProgress(null)
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
          setProgress(snapshot.percent)
          status.textContent = snapshot.percent == null
            ? `正在下载更新 · ${formatBytes(snapshot.downloaded)}`
            : `正在下载更新 · ${snapshot.percent}% (${formatBytes(snapshot.downloaded)} / ${formatBytes(snapshot.total)})`
        })
        downloaded = true
        status.textContent = '下载完成。只有选择下方按钮后才会安装并重新启动。'
        setPhase('ready')
      } catch {
        status.textContent = '下载失败。可以重试下载，或稍后从设置中重新检查。'
        setPhase('error')
      }
      return
    }

    if (action !== 'install' || !downloaded) return
    retryInstall = false
    setPhase('installing')
    status.textContent = '正在安装更新，请不要退出应用…'
    try {
      await update.install({ restartAfterInstall: true })
      installed = true
      status.textContent = '更新已安装，正在重新启动…'
      setPhase('installed')
      // Windows NSIS handles restart from the installer; macOS requires an explicit relaunch.
      if (!/Windows/i.test(navigator.userAgent)) {
        const plugins = await loadPlugins()
        if (plugins) await plugins.relaunch()
        else throw new Error('relaunch-unavailable')
      }
    } catch {
      if (installed) {
        status.textContent = '更新已安装，但应用未能自动重启。请手动重新打开 Meridian。'
        setPhase('restart-error')
      } else {
        retryInstall = true
        status.textContent = '安装未完成。可以重试安装；关闭提示不会自动安装或重启。'
        setPhase('error')
      }
    }
  }

  /** The explicit Later/X/Escape path only dismisses; installation remains behind the ready-state CTA. */
  function requestClose() {
    if (!dialog.isConnected || !dialog.open || dialog.classList.contains('is-closing') || !canCloseUpdate(phase)) return
    if (!installed) {
      setPhase('cancelled')
      status.textContent = '已稍后处理；更新未安装，也未重新启动。'
    }
    dialog.classList.add('is-closing')
    closeButton.disabled = true
    laterButton.disabled = true
    mainButton.disabled = true
    setTimeout(() => dialog.close(), 180)
  }

  updateDialog = dialog
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    requestClose()
  })
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
    }
  })
  dialog.addEventListener('close', () => {
    if (updateDialog === dialog) updateDialog = null
    dialog.remove()
    if (!installed) void update.close().catch(() => {})
  }, { once: true })
  document.body.append(dialog)
  setPhase('available')
  dialog.show()
  if (focus) dialog.focus()
  return dialog
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
      presentUpdate(update, { focus: !automatic })
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
