const { app, BrowserWindow, globalShortcut, clipboard } = globalThis.__electron
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, settings } from './store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
const isMac = process.platform === 'darwin'

if (!isMac) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('no-sandbox')
}

let mainWin = null

// ---------------------------------------------------------------- windows

function createMain() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    ...(isMac ? { trafficLightPosition: { x: 20, y: 18 } } : {}),
    ...(isMac ? { vibrancy: 'sidebar', visualEffectState: 'active' } : {}),
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: join(HERE, isMac ? 'preload.js' : 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWin.loadFile(join(HERE, '../renderer/index.html'))
  if (isDev) {
    mainWin.webContents.on('console-message', (_e, _lvl, msg, line, src) =>
      console.log(`[renderer] ${msg}${src ? ` (${src.split('/').pop()}:${line})` : ''}`))
    mainWin.webContents.on('render-process-gone', (_e, d) => console.error('[renderer] gone:', d.reason, d.exitCode, JSON.stringify(d)))
  }
  mainWin.once('ready-to-show', () => mainWin.show())
  mainWin.on('closed', () => { mainWin = null })
  return mainWin
}

import { register } from './ipc.js'
import { startScheduler } from './scheduler.js'
import { dueSettlements } from './store.js'

// ---------------------------------------------------------------- boot

app.whenReady().then(() => {
  if (isMac) {
    const { session } = globalThis.__electron
    const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    session.defaultSession.webRequest.onHeadersReceived((_d, cb) => {
      cb({ responseHeaders: { 'Content-Security-Policy': [CSP] } })
    })
  }
  load()
  createMain()
  register({ getMainWindow: () => mainWin })

  // 到期结算通知
  startScheduler({
    due: () => dueSettlements(),
    notify: (n, onClick) => {
      const { Notification } = globalThis.__electron
      const notification = new Notification({ title: n.title, body: n.body })
      notification.on('click', () => { if (onClick) onClick() })
      notification.show()
    },
    badge: (count) => {
      if (isMac && app.dock) app.dock.setBadge(count > 0 ? String(count) : '')
    },
    onClick: () => {
      if (mainWin) {
        if (mainWin.isMinimized()) mainWin.restore()
        mainWin.show()
        mainWin.focus()
        mainWin.webContents.send('due:notify')
      }
    },
  })

  const hk = settings().hotkey
  if (!globalShortcut.register(hk, () => {
    // ⌘⇧V：读剪贴板 → 发到主窗口收件箱
    const text = clipboard.readText().trim()
    if (text && mainWin) {
      mainWin.webContents.send('inbox:paste', text)
    } else if (mainWin) {
      // 剪贴板空时主窗口带到前台 + 聚焦收件箱输入框
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.show()
      mainWin.focus()
      mainWin.webContents.send('inbox:focus', true)
    }
  })) {
    console.warn('[meridian] 全局快捷键注册失败：', hk)
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain() })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
