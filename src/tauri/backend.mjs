import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CommandRegistry } from '../main/command-registry.js'
import { configurePlatformServices } from '../main/runtime-services.js'
import { OUTBOX_CHANNELS, recordOutbox } from '../main/sync-outbox.js'

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
const events = []
function emit(name, payload = null) {
  events.push({ name, payload })
  if (events.length > 500) events.splice(0, events.length - 500)
}
configurePlatformServices({ dataDirectory: userData, emitEvent: emit })

// 待确认 / 待判变化后立刻刷新 Dock 角标，不等 15 分钟的 scheduler tick。
// store 在 registry 之后才 import，用可变引用延迟绑定。
let refreshBadge = null

const registry = new CommandRegistry({
  onSuccess: (name, args, result) => {
    // 清空类命令按 id 精确同步：录制源头算好的 deletedIds，而非 filter 参数——
    // filter 的 extracted 谓词按设备各自持有状态，重放会删出不同集合（2026-09-30 分叉教训）。
    if ((name === 'inbox:clearUnextracted' || name === 'inbox:clear')
        && result && Array.isArray(result.deletedIds) && result.deletedIds.length > 0) {
      recordOutbox('inbox:deleteIds', [result.deletedIds], userData)
      return
    }
    if (OUTBOX_CHANNELS.has(name)) recordOutbox(name, args, userData)
    // 待确认 / 待判变化后立刻刷新角标，不等 15 分钟 tick
    if (ATTENTION_BADGE_COMMANDS.has(name)) refreshBadge?.()
  },
})
const { load } = await import('../main/store.js')
const { registerDomainCommands } = await import('../main/domain-commands.js')
const { startAgentServer } = await import('../main/agent-server.js')
const { ingestReadings } = await import('../main/reading-ingest.js')
const { startSyncServer } = await import('../main/sync-server.js')
const { startScheduler } = await import('../main/scheduler.js')
const { attentionCount, attentionSnapshot } = await import('../main/attention.js')
const store = await import('../main/store.js')

/** 会改变「待确认 + 待判」角标的命令。 */
const ATTENTION_BADGE_COMMANDS = new Set([
  'inbox:capture', 'inbox:resolve', 'inbox:resolveMany', 'inbox:dispatch',
  'inbox:clear', 'inbox:clearUnextracted', 'inbox:deleteIds', 'inbox:extract',
  'theme:feed', 'chain:judgeEvidence', 'chain:reviewEngineRecommendation',
  'chain:shelfJudgeItem', 'chain:addUnmappedEvidence', 'chain:addEvidence',
])

// 角标 = 待确认 + 待判（与今日摘要同一口径）
refreshBadge = () => {
  try {
    emit('system:badge', { count: attentionCount() })
  } catch {}
}

load()
const startupPrune = store.lastInboxPrune()
if (startupPrune?.removed) emit('inbox:pruned', startupPrune)
let agentServer = null
let agentError = null
registerDomainCommands({
  registry,
  emit,
  getAgentConnection: () => ({
    available: !!agentServer, host: store.settings().agentHost || host,
    port: agentServer?.port || null, path: join(userData, 'agent-port.json'),
    requireToken: agentServer?.requireToken, error: agentError,
  }),
})

try {
  await startSyncServer({
    userDataDir: userData,
    broadcast: () => emit('db:changed'),
    // VM op -> 本地领域命令直调：绕过 onSuccess，不进 Mac outbox，避免回环
    applyOp: (channel, args) => registry.invokeWithoutHooks(channel, args),
  })
} catch (error) { console.error('[sync] optional endpoint unavailable:', error.message) }
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
  attention: () => attentionSnapshot(),
  notify: (notice) => emit('system:notification', notice),
  badge: (count) => emit('system:badge', { count }),
  // 点击通知 → 今日待确认；保留 due:notify 事件名以免旧 renderer 脱节
  onClick: () => emit('due:notify'),
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
    if (typeof body.command !== 'string' || !Array.isArray(body.args)) return reply(response, 400, { error: 'invalid-request' })
    if (!registry.has(body.command)) return reply(response, 404, { error: `unknown-command:${body.command}` })
    const result = await registry.invoke(body.command, body.args)
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

/* Tauri 外壳只在 RunEvent::Exit 时回收本进程；外壳被信号结束（dev 重启、崩溃、kill）时本进程会变成孤儿，
   继续持有过期的内存账本、改写 agent-port.json，之后任何一次整文件写回都会覆盖新实例的数据。
   所以自己盯着父进程：被过继（ppid 变了）或父进程已不存在，就停止接活并退出。 */
const PARENT_POLL_MS = 2000
const EXIT_GRACE_MS = 1000 // > store 的 120ms 落盘防抖：父进程死前已确认的写入先落盘
const parentPid = process.ppid
function parentGone() {
  if (process.ppid !== parentPid) return true
  try {
    process.kill(parentPid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

let shuttingDown = false
function shutdown({ exit = false } = {}) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(parentWatch)
  stopScheduler?.()
  server.close()
  agentServer?.close?.()
  if (exit) setTimeout(() => process.exit(0), EXIT_GRACE_MS)
}
const parentWatch = setInterval(() => {
  if (!parentGone()) return
  console.error(`[sidecar] parent ${parentPid} is gone; shutting down`)
  shutdown({ exit: true })
}, PARENT_POLL_MS)
parentWatch.unref()
process.once('SIGTERM', () => shutdown())
process.once('SIGINT', () => shutdown())
