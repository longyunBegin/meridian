/**
 * Mac 端同步端点（Tailscale 反向同步 Phase 3-1）。
 *
 * 在 main process 内独立运行的轻量 HTTP 服务，与 Electron 窗口无关，
 * app ready 后由 main.js 启动。VM 上的同步桥经 Tailscale 调用它：
 *
 *   GET  /sync/health       → { ok, outbox: 待同步条数 }
 *   GET  /sync/outbox       → { ok, entries: [{ id, ts, channel, args }] }
 *   POST /sync/outbox/ack   → { ids: [...] } → { ok, acked }
 *   POST /sync/snapshot     → body 为账本快照对象（readingSnapshot 形状）；
 *                              仅 outbox 为空时接受（否则 409，避免覆盖未 ack 的用户操作）；
 *                              Mac 已启用 SQLite 持久层时拒绝（409），避免 meridian.json 被 load() 忽略导致静默发散；
 *                              原子写盘（tmp+rename）→ 失效内存缓存 → load() 重载 → 广播 db:changed。
 *
 * 全部 Bearer token 认证（constant-time 比较）。token 来自 {userData}/sync.config.json，
 * 无配置文件或 token 为空则服务不启动（fail-closed）。默认监听 0.0.0.0:3821：
 * macOS 防火墙首次会弹窗询问是否允许传入连接，点「允许」即可（仅 Tailscale 网内可达，
 * 不暴露到公网——VM 本就没有公网 IP，Mac 的 Tailscale 地址也只在 tailnet 内可见）。
 *
 * settings 永不同步：apiKey 等与机器绑定，apply 时保留本机 settings。
 * readings.jsonl（读数哈希链）不同步：红区，本阶段 Mac 保留自己的读数账本。
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { readOutbox, ackOutbox, outboxCount } from './sync-outbox.js'
import { load, invalidateDbCache } from './store.js'

export const SYNC_CONFIG_NAME = 'sync.config.json'
const BODY_LIMIT = 32 * 1024 * 1024 // 快照约 MB 级

export function readSyncConfig(userDataDir) {
  const file = join(userDataDir, SYNC_CONFIG_NAME)
  if (!existsSync(file)) return null
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    return cfg && typeof cfg === 'object' ? cfg : null
  } catch {
    return null
  }
}

function checkAuth(req, token) {
  const h = req.headers.authorization || ''
  const p = 'Bearer '
  if (!h.startsWith(p)) return false
  const a = Buffer.from(h.slice(p.length))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); reject(new Error('body too large')) }
      else chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try { resolve(raw ? JSON.parse(raw) : {}) }
      catch (e) { reject(new Error('非法 JSON body: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

/**
 * 快照落盘（默认实现，可被测试注入替换）。
 * settings 与机器绑定，永不同步——保留本机 settings 后再写盘。
 */
export function applySnapshotToDisk(userDataDir, snapshot, getRawSettings) {
  const merged = { ...snapshot, settings: getRawSettings() }
  const file = join(userDataDir, 'meridian.json')
  const tmp = file + '.sync-tmp'
  writeFileSync(tmp, JSON.stringify(merged, null, 2))
  renameSync(tmp, file)
  invalidateDbCache()
  load()
}

/** main.js 用的真实依赖。 */
export function defaultSyncDeps() {
  const { app, BrowserWindow } = globalThis.__electron
  const userDataDir = app.getPath('userData')
  const cfg = readSyncConfig(userDataDir) || {}
  return {
    token: cfg.token || '',
    host: cfg.host || '0.0.0.0',
    port: Number(cfg.port) || 3821,
    outboxDir: userDataDir,
    hasSqlite: () => existsSync(join(userDataDir, 'meridian.sqlite')),
    getRawSettings: () => load().settings,
    applySnapshot: (snapshot) => applySnapshotToDisk(userDataDir, snapshot, () => load().settings),
    broadcast: () => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('db:changed') } catch { /* 窗口已关 */ }
      }
    },
  }
}

export function createSyncServer(deps) {
  const { token, host, port, outboxDir, hasSqlite, applySnapshot, broadcast } = deps
  if (!token) throw new Error('[sync] token 缺失，服务拒绝启动')

  const server = createServer(async (req, res) => {
    try {
      if (!checkAuth(req, token)) return json(res, 401, { ok: false, error: 'unauthorized' })
      const url = new URL(req.url, 'http://localhost')

      if (req.method === 'GET' && url.pathname === '/sync/health') {
        return json(res, 200, { ok: true, outbox: outboxCount(outboxDir) })
      }
      if (req.method === 'GET' && url.pathname === '/sync/outbox') {
        return json(res, 200, { ok: true, entries: readOutbox(outboxDir) })
      }
      if (req.method === 'POST' && url.pathname === '/sync/outbox/ack') {
        let body
        try { body = await readJsonBody(req) } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
        const ids = Array.isArray(body.ids) ? body.ids.filter((i) => typeof i === 'string') : []
        return json(res, 200, { ok: true, acked: ackOutbox(ids, outboxDir) })
      }
      if (req.method === 'POST' && url.pathname === '/sync/snapshot') {
        if (hasSqlite()) {
          return json(res, 409, { ok: false, error: 'mac-sqlite-enabled', message: 'Mac 端已启用 SQLite 持久层，快照覆盖 meridian.json 会被 load() 忽略，已拒绝' })
        }
        if (outboxCount(outboxDir) > 0) {
          return json(res, 409, { ok: false, error: 'outbox-not-empty', message: 'outbox 还有未 ack 的用户操作，拒绝覆盖' })
        }
        let snapshot
        try { snapshot = await readJsonBody(req) } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
        if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.nodes)) {
          return json(res, 400, { ok: false, error: 'bad-snapshot', message: '快照必须是含 nodes 数组的账本对象' })
        }
        await applySnapshot(snapshot)
        broadcast()
        return json(res, 200, { ok: true })
      }
      return json(res, 404, { ok: false, error: 'unknown route' })
    } catch (e) {
      return json(res, 500, { ok: false, error: e?.message || String(e) })
    }
  })

  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve({ host, port: server.address().port }))
    }),
    stop: () => new Promise((resolve) => server.close(resolve)),
    server,
  }
}

/** main.js 调用：读配置 → 起服务。无 token 则不启动并打日志（fail-closed）。 */
export async function startSyncServer() {
  const deps = defaultSyncDeps()
  if (!deps.token) {
    console.warn('[sync] sync.config.json 缺失或 token 为空，Mac 同步端点未启动。按 src/main/sync.config.example.json 创建后再重启 App。')
    return null
  }
  const srv = createSyncServer(deps)
  await srv.start()
  console.log(`[sync] 同步端点已启动 http://${deps.host}:${deps.port}（Tailscale 内网 + Bearer 认证）`)
  return srv
}
