/**
 * Mac 端同步端点（双向 op log）。
 *
 * 独立运行的轻量 HTTP 服务，由桌面 sidecar 显式启动。VM 上的同步桥经 Tailscale 调用它：
 *
 *   GET  /sync/health       → { ok, outbox: 待同步条数, vmCursor, oplog: true }
 *   GET  /sync/outbox?since=N → { ok, entries: [{ id, ts, seq, channel, args }] }（seq > N）
 *   POST /sync/outbox/ack   → { ids: [...] } 或 { cursor: N } → { ok, acked }
 *   POST /sync/ops          → { entries: [{ id, ts, seq, channel, args }] }（VM 侧产生的 op）
 *                              按 VM_OP_CHANNELS 白名单调用本地 handler 应用，
 *                              返回 { ok, applied: cursor }；未知 channel 直接 400（fail-closed）。
 *
 * 两条 op log（Mac 的 sync-outbox.jsonl / VM 的同名文件）都是 append-only + seq 游标，
 * 同步即交换游标之后的新 op，天然幂等，断线重连自动补齐。快照推送已退役。
 *
 * 全部 Bearer token 认证（constant-time 比较）。token 来自 {userData}/sync.config.json，
 * 无配置文件或 token 为空则服务不启动（fail-closed）。默认监听 0.0.0.0:3821：
 * macOS 防火墙首次会弹窗询问是否允许传入连接，点「允许」即可（仅 Tailscale 网内可达，
 * 不暴露到公网——VM 本就没有公网 IP，Mac 的 Tailscale 地址也只在 tailnet 内可见）。
 *
 * settings 永不同步：apiKey 等与机器绑定。readings.jsonl（读数哈希链）不同步：红区。
 * 审计类副作用（intake 事件、trace）不同步：只同步主数据（条目/节点/来源/原文）。
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { readOutbox, ackOutbox, ackOutboxCursor, outboxCount, VM_OP_CHANNELS } from './sync-outbox.js'
import { load, invalidateDbCache } from './store.js'
import { dataDirectory, emitPlatformEvent } from './runtime-services.js'

export const SYNC_CONFIG_NAME = 'sync.config.json'
const BODY_LIMIT = 32 * 1024 * 1024
const VM_CURSOR_NAME = 'sync-vm-cursor.json'

/** Mac 侧已应用的 VM op 游标（持久化，断线重连后续传）。 */
export function readVmCursor(dir) {
  const f = join(dir, VM_CURSOR_NAME)
  if (!existsSync(f)) return 0
  try {
    const n = Number(JSON.parse(readFileSync(f, 'utf8'))?.seq)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  } catch { return 0 }
}

export function writeVmCursor(dir, seq) {
  const f = join(dir, VM_CURSOR_NAME)
  const tmp = f + '.tmp'
  writeFileSync(tmp, JSON.stringify({ seq }) + '\n')
  renameSync(tmp, f)
}

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
 * 快照落盘（灾难恢复用：手动全量恢复，不再参与日常同步）。
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

/** Build sync dependencies from explicit filesystem and event services. */
export function defaultSyncDeps({ userDataDir = dataDirectory(), broadcast = () => emitPlatformEvent('db:changed') } = {}) {
  const cfg = readSyncConfig(userDataDir) || {}
  return {
    token: cfg.token || '',
    host: cfg.host || '0.0.0.0',
    port: Number(cfg.port) || 3821,
    outboxDir: userDataDir,
    // 桌面宿主注入：VM op -> 本地领域命令（backend.mjs 经 registry 直调，绕过 outbox 防回环）
    applyOp: null,
    broadcast,
  }
}

export function createSyncServer(deps) {
  const { token, host, port, outboxDir, applyOp, broadcast } = deps
  if (!token) throw new Error('[sync] token 缺失，服务拒绝启动')
  if (typeof applyOp !== 'function') throw new Error('[sync] applyOp 缺失，服务拒绝启动')

  const server = createServer(async (req, res) => {
    try {
      if (!checkAuth(req, token)) return json(res, 401, { ok: false, error: 'unauthorized' })
      const url = new URL(req.url, 'http://localhost')

      if (req.method === 'GET' && url.pathname === '/sync/health') {
        return json(res, 200, { ok: true, outbox: outboxCount(outboxDir), vmCursor: readVmCursor(outboxDir), oplog: true })
      }
      if (req.method === 'GET' && url.pathname === '/sync/outbox') {
        const since = Number(url.searchParams.get('since')) || 0
        return json(res, 200, { ok: true, entries: readOutbox(outboxDir, since) })
      }
      if (req.method === 'POST' && url.pathname === '/sync/outbox/ack') {
        let body
        try { body = await readJsonBody(req) } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
        if (body && typeof body.cursor === 'number') {
          return json(res, 200, { ok: true, acked: ackOutboxCursor(body.cursor, outboxDir) })
        }
        const ids = Array.isArray(body?.ids) ? body.ids.filter((i) => typeof i === 'string') : []
        return json(res, 200, { ok: true, acked: ackOutbox(ids, outboxDir) })
      }
      if (req.method === 'POST' && url.pathname === '/sync/ops') {
        let body
        try { body = await readJsonBody(req) } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
        const entries = Array.isArray(body?.entries) ? body.entries : null
        if (!entries) return json(res, 400, { ok: false, error: 'entries 必须是数组' })
        let cursor = readVmCursor(outboxDir)
        let appliedCount = 0
        for (const e of entries) {
          if (!e || typeof e.id !== 'string' || typeof e.channel !== 'string' || !Array.isArray(e.args)) {
            return json(res, 400, { ok: false, error: '畸形 op entry', applied: cursor })
          }
          const seq = Number(e.seq) || 0
          if (seq <= cursor) continue // 已应用过，幂等跳过
          if (!VM_OP_CHANNELS.has(e.channel)) {
            return json(res, 400, { ok: false, error: `未知 op channel: ${e.channel}`, applied: cursor })
          }
          try {
            await applyOp(e.channel, e.args)
          } catch (err) {
            return json(res, 500, { ok: false, error: `应用 op 失败 ${e.channel}: ${err?.message || err}`, applied: cursor })
          }
          cursor = seq
          appliedCount++
        }
        if (appliedCount > 0) {
          writeVmCursor(outboxDir, cursor)
          broadcast()
        }
        return json(res, 200, { ok: true, applied: cursor, count: appliedCount })
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

/** 桌面宿主调用：读配置 -> 起服务。无 token 则不启动并打日志（fail-closed）。 */
export async function startSyncServer(overrides = {}) {
  const deps = { ...defaultSyncDeps(), ...overrides }
  if (!deps.token) {
    console.warn('[sync] sync.config.json 缺失或 token 为空，Mac 同步端点未启动。按 src/main/sync.config.example.json 创建后再重启 App。')
    return null
  }
  const srv = createSyncServer(deps)
  await srv.start()
  console.log(`[sync] 同步端点已启动 http://${deps.host}:${deps.port}（Tailscale 内网 + Bearer 认证，双向 op log）`)
  return srv
}
