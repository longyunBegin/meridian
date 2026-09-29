import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const host = '127.0.0.1'
const token = process.env.MERIDIAN_SIDECAR_TOKEN
if (!token) throw new Error('MERIDIAN_SIDECAR_TOKEN is required')

function defaultDataDir() {
  if (process.env.MERIDIAN_USER_DATA_DIR) return process.env.MERIDIAN_USER_DATA_DIR
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '脉络')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', '脉络')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), '脉络')
}

const userData = defaultDataDir()
mkdirSync(userData, { recursive: true })
const handlers = new Map()
const events = []
const emit = (name, payload = null) => {
  events.push({ name, payload })
  if (events.length > 500) events.splice(0, events.length - 500)
}
const ipcMain = {
  handle: (name, fn) => handlers.set(name, fn),
  on: (name, fn) => handlers.set(name, fn),
  removeHandler: (name) => handlers.delete(name),
}
const app = {
  isPackaged: true,
  getPath: (name) => name === 'appData' ? (process.env.APPDATA || homedir()) : userData,
  on: () => {},
  quit: () => process.exit(0),
}
function openNative(target, external = false) {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  const child = spawn(command, [target], { detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', () => {})
  child.unref()
  return Promise.resolve(external ? true : '')
}
const shell = { openPath: (path) => openNative(path), openExternal: (url) => openNative(url, true) }
const clipboard = { readText: () => '' }
const webContents = { send: emit, once: () => {}, on: () => {} }
const mainWindow = { webContents, isMinimized: () => false, isVisible: () => true, show: () => {}, focus: () => {}, restore: () => {} }
globalThis.__electron = { app, ipcMain, shell, clipboard, BrowserWindow: { getAllWindows: () => [mainWindow] } }

const { load } = await import('../main/store.js')
const { register } = await import('../main/ipc.js')
const { startAgentServer } = await import('../main/agent-server.js')
const { ingestReadings } = await import('../main/reading-ingest.js')
const { startSyncServer } = await import('../main/sync-server.js')
const { startScheduler } = await import('../main/scheduler.js')
const store = await import('../main/store.js')

load()
const startupPrune = store.lastInboxPrune()
if (startupPrune?.removed) emit('inbox:pruned', startupPrune)
let agentServer = null
let agentError = null
register({
  getMainWindow: () => mainWindow,
  getAgentConnection: () => ({
    available: !!agentServer, host: store.settings().agentHost || host,
    port: agentServer?.port || null, path: join(userData, 'agent-port.json'),
    requireToken: agentServer?.requireToken, error: agentError,
  }),
  enableOutbox: true,
})

try { await startSyncServer() } catch (error) { console.error('[sync] optional endpoint unavailable:', error.message) }
try {
  agentServer = await startAgentServer({
    userData, ingest: ingestReadings, getIntent: store.exportIntent,
    onChanged: () => emit('db:changed'), host: store.settings().agentHost || host,
    port: Number(store.settings().agentPort) || 0, requireToken: store.settings().agentToken !== false,
  })
} catch (error) {
  agentError = error.message || 'Local ingestion service unavailable'
  console.error('[meridian] local ingestion service unavailable:', agentError)
}

const stopScheduler = startScheduler({
  due: () => store.dueSettlements(),
  notify: (notice) => emit('system:notification', notice),
  badge: () => {}, onClick: () => emit('due:notify'),
})

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 10 * 1024 * 1024) throw new Error('request-too-large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
function reply(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.headers['x-meridian-token'] !== token) return reply(response, 403, { error: 'forbidden' })
  if (request.url === '/events') return reply(response, 200, events.splice(0, events.length))
  if (request.url !== '/invoke') return reply(response, 404, { error: 'not-found' })
  try {
    const body = await readBody(request)
    if (typeof body.channel !== 'string' || !Array.isArray(body.args)) return reply(response, 400, { error: 'invalid-request' })
    const handler = handlers.get(body.channel)
    if (!handler) return reply(response, 404, { error: `unknown-channel:${body.channel}` })
    const result = await handler({ sender: webContents }, ...body.args)
    return reply(response, 200, { result: result === undefined ? null : result })
  } catch (error) {
    console.error('[sidecar] command failed:', error?.stack || error)
    return reply(response, 500, { error: error?.message || 'command-failed' })
  }
})
server.listen(0, host, () => {
  const { port } = server.address()
  process.stdout.write(`${JSON.stringify({ ready: true, host, port })}\n`)
})

function shutdown() {
  stopScheduler?.()
  server.close()
  agentServer?.close?.()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
