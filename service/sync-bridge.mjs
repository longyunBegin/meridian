#!/usr/bin/env node
/**
 * Tailscale 反向同步桥（VM 端，Phase 3-1）。
 *
 * 网络现实：VM 无公网 IP、不接受任何入站，Tailscale 是 client-only。
 * 所以同步方向是 VM 主动 → Mac 被动：
 *
 *   每轮（默认 20s）：
 *   1. GET {mac}/sync/outbox → 用户在本轮内的操作 [{ id, ts, channel, args }]
 *   2. 有条目：逐条 POST 到本地 service（POST /api/:channel，body {args}），
 *      全部成功（或“已应用”类幂等返回）后 POST {mac}/sync/outbox/ack {ids}
 *   3. 无条目：POST /api/sync:snapshot 拿 VM 账本快照 → POST {mac}/sync/snapshot 推回
 *
 * 幂等：bridge 崩在 apply 与 ack 之间会导致重放。白名单 channel 天然幂等
 * （inbox:resolve 非 pending 直接返回原条目等）；重放若返回“已应用”类错误
 * 视为成功并 ack，不中断。真错误则停下、不 ack，留待人工看，下轮重试。
 *
 * Mac 不可达：指数退避（20s → 最高 5min），打日志，不崩溃。
 *
 * 红线：只重放用户 outbox 里的动作，绝不编造；绝不创建/修改/删除 lemmas；
 * 只走 HTTP，不直接读写任何账本文件；默认数据目录可覆盖，绝不指向真实账本。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

const FETCH_TIMEOUT_MS = 15000

// ---------------------------------------------------------------- config

function defaultBridgeDir() {
  return process.env.MERIDIAN_BRIDGE_DIR || join(homedir(), '.local/share/meridian-sync-bridge')
}

export function loadBridgeConfig(overrides = {}) {
  const dir = overrides.bridgeDir || defaultBridgeDir()
  let fileCfg = {}
  const cfgFile = join(dir, 'config.json')
  if (existsSync(cfgFile)) {
    try { fileCfg = JSON.parse(readFileSync(cfgFile, 'utf8')) }
    catch (e) { console.error(`[sync-bridge] 配置解析失败 ${cfgFile}: ${e.message}`); process.exit(1) }
  }
  const env = process.env
  const cfg = {
    bridgeDir: dir,
    // Mac 的 tailnet IP 会变：改配置或环境变量即可，不用改代码
    macUrl: overrides.macUrl || env.MERIDIAN_SYNC_MAC_URL || fileCfg.macUrl || 'http://100.68.175.71:3821',
    macToken: overrides.macToken || env.MERIDIAN_SYNC_MAC_TOKEN || fileCfg.macToken || '',
    serviceUrl: overrides.serviceUrl || env.MERIDIAN_SYNC_SERVICE_URL || fileCfg.serviceUrl || 'http://127.0.0.1:3791',
    serviceToken: overrides.serviceToken || env.MERIDIAN_SYNC_SERVICE_TOKEN || fileCfg.serviceToken || '',
    intervalMs: Number(overrides.intervalMs || env.MERIDIAN_SYNC_INTERVAL_MS || fileCfg.intervalMs) || 20000,
    maxBackoffMs: Number(overrides.maxBackoffMs || env.MERIDIAN_SYNC_MAX_BACKOFF_MS || fileCfg.maxBackoffMs) || 300000,
    // 运行环境要求：访问 tailnet 必须经 HTTP CONNECT 代理（端口 3130）。
    // 默认从 HTTPS_PROXY/HTTP_PROXY 推导（只换端口，保留认证信息），也可显式配置。
    tunnelProxy: overrides.tunnelProxy || env.MERIDIAN_SYNC_TUNNEL_PROXY || fileCfg.tunnelProxy || deriveTunnelProxy(),
  }
  cfg.macUrl = cfg.macUrl.replace(/\/+$/, '')
  cfg.serviceUrl = cfg.serviceUrl.replace(/\/+$/, '')
  return cfg
}

// ---------------------------------------------------------------- http
// 运行环境里直连 tailnet 不通：Mac 侧请求必须经 HTTP CONNECT 代理。
// 用 node:http + 自定义 createConnection 做 CONNECT 隧道，不引入新依赖，
// 代理认证信息只留在内存，不出现在命令行参数里。

/** 从环境变量推导隧道代理地址（HTTPS_PROXY/HTTP_PROXY 只换端口为 3130）。 */
export function deriveTunnelProxy() {
  const raw = process.env.MERIDIAN_SYNC_TUNNEL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  if (!raw) return ''
  try {
    const u = new URL(raw)
    u.port = '3130'
    return u.toString()
  } catch {
    return ''
  }
}

/** 返回一个经 CONNECT 代理的 http.Agent（proxyUrl 为 '' 时返回 undefined，用默认直连）。 */
export function tunnelAgent(proxyUrl) {
  if (!proxyUrl) return undefined
  return new http.Agent({
    createConnection: (opts, oncreate) => {
      let p
      try {
        p = new URL(proxyUrl)
      } catch (e) {
        oncreate(e)
        return
      }
      const sock = net.connect({ host: p.hostname, port: Number(p.port) || 80 })
      const target = `${opts.host}:${opts.port}`
      let proxyAuth = ''
      if (p.username) {
        const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`
        proxyAuth = `Proxy-Authorization: Basic ${Buffer.from(cred).toString('base64')}\r\n`
      }
      sock.on('connect', () => {
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${proxyAuth}\r\n`)
      })
      let head = ''
      const onData = (chunk) => {
        head += chunk.toString('latin1')
        const i = head.indexOf('\r\n\r\n')
        if (i === -1) return
        const status = head.slice(0, head.indexOf('\r\n'))
        if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
          sock.destroy(new Error(`CONNECT 代理失败: ${status}`))
          return
        }
        sock.off('data', onData)
        const rest = Buffer.from(head.slice(i + 4), 'latin1')
        if (rest.length) sock.unshift(rest)
        oncreate(null, sock)
      }
      sock.on('data', onData)
      sock.on('error', oncreate)
    },
  })
}

/** 基于 node:http 的 JSON 请求（可指定 agent 走 CONNECT 隧道）。返回 {status, ok, body}。 */
export function httpJson(url, { method = 'GET', token = '', body, agent, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = lib.request(
      url,
      {
        method,
        agent,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let parsed = null
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            /* 非 JSON，parsed 保持 null */
          }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** 兼容旧名：service 本地调用沿用直连。 */
const fetchJson = (url, opts) => httpJson(url, opts)

const errText = (e) => (e && typeof e === 'object' ? e.message || JSON.stringify(e) : String(e ?? ''))

/** “已应用”类错误：重放幂等命中的安全网，视为成功并 ack。 */
export function isBenignReplayError(error) {
  return /already applied|already resolved|duplicate|already exists|not pending|已应用|已解决|重复/.test(errText(error))
}

// ---------------------------------------------------------------- bridge

export function createBridge(config) {
  const log = (...a) => console.log('[sync-bridge]', ...a)
  // Mac 侧走 CONNECT 隧道代理；service 在本机直连
  const macAgent = tunnelAgent(config.tunnelProxy)
  if (!config.tunnelProxy) log('警告：未配置隧道代理，Mac 侧将尝试直连（本运行环境下直连 tailnet 不通）')
  const macGet = (path) => httpJson(config.macUrl + path, { token: config.macToken, agent: macAgent })
  const macPost = (path, body) =>
    httpJson(config.macUrl + path, { method: 'POST', token: config.macToken, body, agent: macAgent })
  const servicePost = (channel, args) =>
    fetchJson(`${config.serviceUrl}/api/${channel}`, {
      method: 'POST', token: config.serviceToken, body: { args: args || [] },
    })

  async function applyEntries(entries) {
    const acked = []
    for (const e of entries) {
      let res
      try {
        res = await servicePost(e.channel, e.args)
      } catch (err) {
        // service 本地不可达：整批停下，已 ack 的不动，剩下的下轮重试
        throw new Error(`service 调用失败 ${e.channel}：${err.message}`)
      }
      if (res.body?.ok) { acked.push(e.id); continue }
      if (isBenignReplayError(res.body?.error)) {
        log(`重放 ${e.channel} 返回已应用类错误，视为成功并 ack：${errText(res.body?.error)}`)
        acked.push(e.id)
        continue
      }
      // 真错误：停下，不 ack 该条及之后，下轮重试，日志留给人工
      throw new Error(`重放 ${e.channel} 失败（已停，未 ack）：${errText(res.body?.error)}`)
    }
    if (acked.length) {
      const ackRes = await macPost('/sync/outbox/ack', { ids: acked })
      if (!ackRes.body?.ok) throw new Error(`ack 失败：${errText(ackRes.body?.error)}`)
    }
    return { mode: 'apply', applied: acked.length, total: entries.length }
  }

  async function pushSnapshot() {
    const snapRes = await servicePost('sync:snapshot', [])
    if (!snapRes.body?.ok) throw new Error(`快照导出失败：${errText(snapRes.body?.error)}`)
    const macRes = await macPost('/sync/snapshot', snapRes.body.result)
    if (macRes.status === 409) {
      // 预期内：Mac 的 outbox 在拉取后又有新操作，或 Mac 已切 SQLite。下轮重试。
      log(`Mac 拒绝快照（${macRes.body?.error}），下轮重试`)
      return { mode: 'snapshot', pushed: false, reason: macRes.body?.error }
    }
    if (!macRes.body?.ok) throw new Error(`快照推送失败：${errText(macRes.body?.error)}`)
    return { mode: 'snapshot', pushed: true }
  }

  async function syncOnce() {
    if (!config.macToken) throw new Error('macToken 为空：先配好 config.json 再跑')
    if (!config.serviceToken) throw new Error('serviceToken 为空：先配好 config.json 再跑')
    const outboxRes = await macGet('/sync/outbox')
    if (!outboxRes.body?.ok) throw new Error(`拉取 outbox 失败：${errText(outboxRes.body?.error)}`)
    const entries = Array.isArray(outboxRes.body.entries) ? outboxRes.body.entries : []
    if (entries.length > 0) return applyEntries(entries)
    return pushSnapshot()
  }

  return { config, syncOnce, isBenignReplayError }
}

// ---------------------------------------------------------------- state & loop

function stateFile(config) { return join(config.bridgeDir, 'state.json') }

function readState(config) {
  try { return JSON.parse(readFileSync(stateFile(config), 'utf8')) }
  catch { return { consecutiveFailures: 0, lastOkAt: null } }
}

function writeState(config, state) {
  mkdirSync(config.bridgeDir, { recursive: true })
  writeFileSync(stateFile(config), JSON.stringify(state, null, 2))
}

export function backoffDelayMs(config, consecutiveFailures) {
  if (consecutiveFailures <= 0) return config.intervalMs
  return Math.min(config.intervalMs * 2 ** consecutiveFailures, config.maxBackoffMs)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const config = loadBridgeConfig()
  mkdirSync(config.bridgeDir, { recursive: true })
  const bridge = createBridge(config)
  console.log(`[sync-bridge] 启动：mac=${config.macUrl} service=${config.serviceUrl} interval=${config.intervalMs}ms state=${stateFile(config)}`)
  let stopped = false
  process.on('SIGTERM', () => { stopped = true })
  process.on('SIGINT', () => { stopped = true })
  while (!stopped) {
    const state = readState(config)
    try {
      const r = await bridge.syncOnce()
      state.consecutiveFailures = 0
      state.lastOkAt = new Date().toISOString()
      writeState(config, state)
      console.log(`[sync-bridge] ok：${r.mode}${r.mode === 'apply' ? ` applied=${r.applied}/${r.total}` : r.pushed ? ' snapshot 已推送' : ` 快照未推送(${r.reason})`}`)
    } catch (err) {
      state.consecutiveFailures = (state.consecutiveFailures || 0) + 1
      writeState(config, state)
      console.error(`[sync-bridge] 本轮失败（连续 ${state.consecutiveFailures} 次）：${err.message}`)
    }
    const delay = backoffDelayMs(config, readState(config).consecutiveFailures)
    if (!stopped) await sleep(delay)
  }
  console.log('[sync-bridge] 退出')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[sync-bridge] 致命错误：', e.message); process.exit(1) })
}
