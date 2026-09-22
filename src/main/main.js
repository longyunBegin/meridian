const { app, BrowserWindow, globalShortcut, screen, clipboard } = globalThis.__electron
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
let captureWin = null
let captureReady = null

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

const CAPTURE_W = 680
const CAPTURE_IDLE = 150

function createCapture() {
  const { workArea } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    width: CAPTURE_W,
    height: CAPTURE_IDLE,
    x: Math.round(workArea.x + (workArea.width - CAPTURE_W) / 2),
    y: Math.round(workArea.y + workArea.height * 0.22),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...(isMac ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
    backgroundColor: 'rgba(0,0,0,0)',
    ...(isMac ? { roundedCorners: true, cornerRadius: 14 } : {}),
    show: false,
    webPreferences: {
      preload: join(HERE, isMac ? 'preload.js' : 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  captureWin = win
  captureReady = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  win.loadFile(join(HERE, '../renderer/capture.html'))
  win.on('blur', () => hideCapture())
  win.on('closed', () => { captureWin = null; captureReady = null })
  return win
}

async function showCapture() {
  const win = captureWin || createCapture()
  if (captureReady) await captureReady
  if (!captureWin) return
  captureWin.setBounds({ width: CAPTURE_W, height: CAPTURE_IDLE })
  captureWin.webContents.send('capture:reset')
  captureWin.show()
  captureWin.focus()

  // 聚焦之后再读剪贴板：macOS 上 app 未激活时读 NSPasteboard 会阻塞主进程
  setTimeout(() => {
    const text = clipboard.readText().trim()
    if (text && captureWin) captureWin.webContents.send('capture:focus', text)
  }, 0)
}

function hideCapture() {
  if (captureWin && captureWin.isVisible()) captureWin.hide()
}

function resizeCapture(height) {
  if (!captureWin) return
  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.round(workArea.x + (workArea.width - CAPTURE_W) / 2)
  captureWin.setBounds({ x, width: CAPTURE_W, height }, true)
}

import { register } from './ipc.js'

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
  register({
    resizeCapture,
    showCapture,
    hideCapture,
    getMainWindow: () => mainWin,
  })

  const hk = settings().hotkey
  if (!globalShortcut.register(hk, () => {
    // ⌘⇧V：读剪贴板 → 发到主窗口收件箱（不再弹 HUD）
    // HUD 保留为降级路径（通过 m.showCapture() 手动唤起）
    const text = clipboard.readText().trim()
    if (text && mainWin) {
      mainWin.webContents.send('inbox:paste', text)
    } else if (mainWin) {
      // 剪贴板空时弹 HUD 让用户手动粘贴
      showCapture()
    }
  })) {
    console.warn('[meridian] 全局快捷键注册失败：', hk)
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain() })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
