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
import { load, getNode, getRaw } from '../src/main/store.js'
import { registerDomainCommands } from '../src/main/domain-commands.js'
import { recordOutbox } from '../src/main/sync-outbox.js'
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

/**
 * 把一次 inbox:capture 的结果翻译成 VM op，记入本机 outbox（sync-outbox.jsonl）。
 * op 形状与 Mac outbox 完全一致 {id,ts,seq,channel,args}，channel 限 VM_OP_CHANNELS：
 *   - inbox:upsertItem  待裁决条目（pending / route-proposal），按 id 插入
 *   - db:upsertNode     autoImport 新建的节点快照，按 id 插入（已存在跳过，不碰 confidence）
 *   - db:addSource      autoImport merge：给已存在节点追加来源（去重收敛）
 *   - raw:upsert        autoImport 的原文记录，按 id 插入
 * 审计类副作用（intake 事件、trace）不同步，只同步主数据。
 *
 * 导出供测试（test/vm-oplog.test.mjs 用 MERIDIAN_SERVICE_NOLISTEN=1 导入本模块，
 * 不占用 3791 端口）。
 */
export function recordVmCaptureOps(result) {
  try {
    if (!result || typeof result !== 'object') return
    if (result.item) recordOutbox('inbox:upsertItem', [result.item])
    for (const p of result.routeProposals || []) recordOutbox('inbox:upsertItem', [p])
    for (const im of result.imported || []) {
      if (im.action === 'new' && im.id) {
        const node = getNode(im.id)
        if (node) recordOutbox('db:upsertNode', [node])
      } else if (im.action === 'merge' && im.id && im.source) {
        recordOutbox('db:addSource', [im.id, im.source])
      }
    }
    if (result.autoImported && result.rawId) {
      const raw = getRaw(result.rawId)
      if (raw) recordOutbox('raw:upsert', [raw])
    }
  } catch (e) {
    console.error('[meridian-service] VM op 记录失败（已跳过，不影响本次调用）: ' + (e?.message || e))
  }
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
        // 双向 op log 的 VM 一半：VM 本机产生的变更记 op，供桥推给 Mac。
        // 桥重放 Mac op 时带 X-Meridian-Replay 头，那些不记（源头在 Mac，避免回环）。
        // 目前 VM 侧唯一的写入者是主题追踪的 inbox:capture；结果是确定的数据
        // （条目/节点/来源/原文），记成 upsert 类 op，Mac 侧幂等应用。
        // 注意：绝不重放 pipeline 本身（非确定性），只同步结果。
        if (req.headers['x-meridian-replay'] !== '1' && command === 'inbox:capture') {
          recordVmCaptureOps(result)
        }
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


if (!process.env.MERIDIAN_SERVICE_NOLISTEN) {
  server.listen(PORT, HOST, () => {
    console.log(`[meridian-service] listening on http://${HOST}:${PORT} (${registry.names().length} commands, schema v${schemaVersion})`)
    if (!TOKEN) console.warn('[meridian-service] 警告: token 为空，认证默认拒绝全部请求（配好 service/config.json 再用）')
  })
}
