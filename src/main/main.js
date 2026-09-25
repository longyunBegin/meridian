const { app, BrowserWindow, globalShortcut, clipboard } = globalThis.__electron
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, settings, lastInboxPrune, dueIndicators, exportIntent } from './store.js'
import { startAgentServer } from './agent-server.js'
import { ingestReadings } from './reading-ingest.js'

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
let agentServer = null
let stopScheduler = null
let closing = false
let closed = false
let agentError = null

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
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' } : {}),
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
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
import { dueSettlements, allChannels } from './store.js'
import { availableFetchers, METRIC_FETCHERS } from './fetchers.js'

// ---------------------------------------------------------------- boot

app.whenReady().then(async () => {
  if (isMac) {
    const { session } = globalThis.__electron
    const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      })
    })
  }
  load()
  createMain()
  // 收件箱启动清理的告知。删的是「30 天以上没人看的待确认」，
  // 但即便是该删的也不能静默删。必须放在 createMain() 之后——mainWin 在此之前是 null。
  const pruned = lastInboxPrune()
  if (pruned?.removed > 0) {
    mainWin.webContents.once('did-finish-load', () => {
      mainWin.webContents.send('inbox:pruned', pruned)
    })
  }
  const { runChannelFetch } = register({
    getMainWindow: () => mainWin,
    getAgentConnection: () => ({
      available: !!agentServer, host: '127.0.0.1', port: agentServer?.port || null,
      path: join(app.getPath('userData'), 'agent-port.json'),
      inboxPaths: agentServer?.inboxPaths || [],
      error: agentError,
    }),
  })
  try {
    agentServer = await startAgentServer({
      userData: app.getPath('userData'), ingest: ingestReadings, getIntent: exportIntent,
      onChanged: () => mainWin?.webContents.send('db:changed'),
      // 默认投递点之外，用户自己配的路径——助手输出在哪儿就读哪儿
      inboxPaths: settings().readingInboxPaths || [],
    })
    agentServer.pollFile()
    app.on('browser-window-focus', () => agentServer?.pollFile())
  } catch (e) {
    agentError = e.message || '本地摄入服务未启动'
    console.error('[meridian] 本地摄入服务未启动：', agentError)
  }

  // 到期结算通知 + 通道轮询
  stopScheduler = startScheduler({
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
    channels: () => allChannels(),
    indicators: (now) => dueIndicators(now),
    metricFetchers: METRIC_FETCHERS,
    runChannel: async (ch) => runChannelFetch(ch.id),
    fetchers: () => availableFetchers(),
  })

  const hk = settings().hotkey
  if (!globalShortcut.register(hk, () => {
    if (!mainWin) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
    mainWin.webContents.send('inbox:paste', clipboard.readText().trim())
  })) {
    console.warn('[meridian] 全局快捷键注册失败：', hk)
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain() })
})

app.on('before-quit', (event) => {
  stopScheduler?.()
  if (closed || !agentServer) return
  event.preventDefault()
  if (closing) return
  closing = true
  agentServer.close().finally(() => { closed = true; app.quit() })
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
