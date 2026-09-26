#!/usr/bin/env node
/** Meridian single-truth HTTP 服务（Phase 1）。
 *
 * 复用 src/main/store.js（账本）与 src/main/ipc.js（约 90 个 channel 的 handler），
 * 通过 shim.mjs 喂 Electron 替身，把 ipcMain.handle(channel, fn) 登记的 handler
 * 原样暴露为 POST /api/:channel。业务逻辑零 fork——handler 就是桌面版用的那一个。
 *
 * TODO(推送事件 Phase 2)：ipc.js 里部分 handler 会调用
 *   getMainWindow?.()?.webContents.send('db:changed'|'theme:scaffolded'|'inbox:pruned'|'due:notify'|'reading:progress'|'inbox:changed' 等，…)
 * Phase 1 这里传 getMainWindow: () => null，所以这些推送全部是安全的 no-op。
 * 客户端目前靠轮询兜底；SSE/WebSocket 在 Phase 2 前补齐，补齐后接管推送，
 * 轮询逻辑保留作为断线兜底。
 */

// 顺序不可换：shim 必须在任何业务模块之前 import，
// 因为 store.js / ipc.js 等在模块顶层解构 globalThis.__electron。
import './shim.mjs'
import { __handlers } from './shim.mjs'
import { load } from '../src/main/store.js'
import { register } from '../src/main/ipc.js'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- config
function readConfig() {
  const fallback = { host: '127.0.0.1', port: 3791, token: '' }
  const file = join(HERE, 'config.json')
  if (existsSync(file)) {
    try {
      return { ...fallback, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch (e) {
      console.error(`[meridian-service] config.json 解析失败: ${e.message}`)
      process.exit(1)
    }
  }
  return fallback
}
const config = readConfig()
const HOST = process.env.HOST || config.host || '127.0.0.1'
const PORT = Number(process.env.PORT || config.port || 3791)
const TOKEN = process.env.MERIDIAN_TOKEN || config.token || ''
const DEBUG = process.env.MERIDIAN_DEBUG === '1'

// ---------------------------------------------------------------- boot
// 账本在进程启动时 load() 一次，之后 handler 通过 store 的模块缓存读写（与桌面版一致）。
const ledger = load()
const schemaVersion = Number(ledger?.version) || 4
let pkgVersion = 'unknown'
try { pkgVersion = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version || pkgVersion } catch {}

// handler 里的推送（webContents.send）全部落到 no-op；agent 连接标记为不可用。
register({
  getMainWindow: () => null,
  getAgentConnection: () => ({ available: false }),
})

// ---------------------------------------------------------------- http
function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}
const ok = (res, result) => json(res, 200, { ok: true, result })
const err = (res, status, message, stack) =>
  json(res, status, { ok: false, error: stack ? { message, stack } : { message } })

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); reject(new Error('body too large')) }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function checkAuth(req) {
  if (!TOKEN) return false
  const h = req.headers.authorization || ''
  return h === `Bearer ${TOKEN}`
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    // 免认证：给看门狗用。
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return ok(res, { ok: true, version: pkgVersion, schemaVersion, channels: __handlers.size })
    }

    // 其余一律要求 Bearer token。
    if (!checkAuth(req)) {
      return err(res, 401, 'unauthorized: 需要有效的 Authorization: Bearer <token>')
    }

    if (req.method === 'GET' && url.pathname === '/api/channels') {
      return ok(res, [...__handlers.keys()].sort())
    }

    const m = req.method === 'POST' && /^\/api\/([A-Za-z0-9:_-]+)$/.exec(url.pathname)
    if (m) {
      const channel = m[1]
      const fn = __handlers.get(channel)
      if (!fn) return err(res, 404, `未知 channel: ${channel}`)

      let raw
      try { raw = await readBody(req) } catch (e) { return err(res, 400, e.message) }
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body 必须是 JSON 对象')
      } catch (e) {
        return err(res, 400, `非法 JSON body: ${e.message}`)
      }
      const args = Array.isArray(body.args) ? body.args : []

      try {
        // 与 Electron 调用形态一致：fn(event, ...args)，event 用空对象占位。
        const result = await fn({}, ...args)
        return ok(res, result)
      } catch (e) {
        return err(res, 500, e?.message || String(e), DEBUG ? e?.stack : undefined)
      }
    }

    return err(res, 404, `未知路由: ${req.method} ${url.pathname}`)
  } catch (e) {
    return err(res, 500, e?.message || String(e))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[meridian-service] listening on http://${HOST}:${PORT} (${__handlers.size} channels, schema v${schemaVersion})`)
  if (!TOKEN) console.warn('[meridian-service] 警告: token 为空，认证默认拒绝全部请求（配好 service/config.json 再用）')
})
