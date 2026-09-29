#!/usr/bin/env node
/** Meridian single-truth HTTP 服务（Phase 1）。
 *
 * 复用平台无关的账本和领域命令注册器，通过独立 HTTP adapter 暴露
 * POST /api/:command。业务逻辑零 fork——命令就是桌面版用的那一套。
 *
 * 当前独立服务宿主不启用实时事件推送；其余命令与桌面宿主共用相同业务逻辑。
 * 客户端目前靠轮询兜底；SSE/WebSocket 在 Phase 2 前补齐，补齐后接管推送，
 * 轮询逻辑保留作为断线兜底。
 */

import { CommandRegistry } from '../src/main/command-registry.js'
import { load } from '../src/main/store.js'
import { registerDomainCommands } from '../src/main/domain-commands.js'
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
const registry = new CommandRegistry()
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

// 此服务宿主仅注入其支持的代理连接能力；领域事件默认不推送。
registerDomainCommands({
  registry,
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
      return ok(res, { ok: true, version: pkgVersion, schemaVersion, channels: registry.names().length })
    }

    // 其余一律要求 Bearer token。
    if (!checkAuth(req)) {
      return err(res, 401, 'unauthorized: 需要有效的 Authorization: Bearer <token>')
    }

    if (req.method === 'GET' && ['/api/commands', '/api/channels'].includes(url.pathname)) {
      return ok(res, registry.names().sort())
    }

    const m = req.method === 'POST' && /^\/api\/([A-Za-z0-9:_-]+)$/.exec(url.pathname)
    if (m) {
      const command = m[1]
      const known = registry.has(command)
      if (!known) return err(res, 404, `未知命令: ${command}`)

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
        const result = await registry.invoke(command, args)
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
  console.log(`[meridian-service] listening on http://${HOST}:${PORT} (${registry.names().length} channels, schema v${schemaVersion})`)
  if (!TOKEN) console.warn('[meridian-service] 警告: token 为空，认证默认拒绝全部请求（配好 service/config.json 再用）')
})
