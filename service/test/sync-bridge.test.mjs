/**
 * sync-bridge 测试（VM 端）：轮询 → 重放 → ack → 快照推送。
 *
 * 运行：node service/test/sync-bridge.test.mjs（standalone，不在 npm test 链里）
 * 隔离：假 Mac 端点 + 假 service 端点全在内存/localhost；bridge 数据目录用 tmp。
 * 绝不碰真实账本。
 */
import { createServer } from 'node:http'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createBridge, loadBridgeConfig, backoffDelayMs, isBenignReplayError,
  deriveTunnelProxy, tunnelAgent, httpJson } =
  await import('../sync-bridge.mjs')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
    catch (e) { reject(e) }
  })
  req.on('error', reject)
})
const send = (res, status, obj) => {
  const d = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) })
  res.end(d)
}

// ---- 假 Mac 端点 ----
function fakeMac() {
  const state = { outbox: [], acked: [], snapshots: [], refuseSnapshot: false }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/sync/outbox') return send(res, 200, { ok: true, entries: state.outbox })
    if (req.method === 'POST' && url.pathname === '/sync/outbox/ack') {
      const body = await readBody(req)
      const ids = new Set(body.ids || [])
      state.acked.push(...ids)
      state.outbox = state.outbox.filter((e) => !ids.has(e.id))
      return send(res, 200, { ok: true, acked: ids.size })
    }
    if (req.method === 'POST' && url.pathname === '/sync/snapshot') {
      if (state.refuseSnapshot) return send(res, 409, { ok: false, error: 'outbox-not-empty' })
      state.snapshots.push(await readBody(req))
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { ok: false, error: 'nope' })
  })
  return { state, server }
}

// ---- 假 service 端点 ----
function fakeService(script = {}) {
  const calls = []
  const server = createServer(async (req, res) => {
    const m = /^\/api\/([A-Za-z0-9:_-]+)$/.exec(new URL(req.url, 'http://localhost').pathname)
    if (req.method === 'POST' && m) {
      const body = await readBody(req)
      calls.push({ channel: m[1], args: body.args })
      if (m[1] === 'sync:snapshot') return send(res, 200, { ok: true, result: { version: 4, nodes: [{ id: 'vm-node' }] } })
      const s = script[m[1]]
      if (s) return send(res, 200, s)
      return send(res, 200, { ok: true, result: null })
    }
    return send(res, 404, { ok: false })
  })
  return { calls, server }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = (server) => new Promise((r) => server.close(r))
const bridgeDir = mkdtempSync(join(tmpdir(), 'sync-bridge-test-'))
const mkBridge = (macPort, svcPort, extra = {}) => createBridge({
  bridgeDir, macUrl: `http://127.0.0.1:${macPort}`, macToken: 'mac-tok',
  serviceUrl: `http://127.0.0.1:${svcPort}`, serviceToken: 'svc-tok',
  intervalMs: 50, maxBackoffMs: 1000, ...extra,
})

console.log('\n— 正常轮询：拉取 → 重放 → ack —')
{
  const mac = fakeMac()
  const svc = fakeService()
  const mp = await listen(mac.server), sp = await listen(svc.server)
  mac.state.outbox = [
    { id: 'e1', ts: 1, channel: 'inbox:resolve', args: ['item1', 'reject'] },
    { id: 'e2', ts: 2, channel: 'db:settle', args: ['node9', true] },
  ]
  const r = await mkBridge(mp, sp).syncOnce()
  ok('syncOnce 返回 apply', r.mode === 'apply' && r.applied === 2)
  ok('service 收到两条重放', svc.calls.length === 2, `实际 ${svc.calls.length}`)
  ok('channel/args 透传', svc.calls[0].channel === 'inbox:resolve' && svc.calls[0].args[1] === 'reject')
  ok('Mac 收到 ack', mac.state.acked.join(',') === 'e1,e2')
  ok('Mac 端 outbox 清空', mac.state.outbox.length === 0)
  await close(mac.server); await close(svc.server)
}

console.log('\n— 幂等重放：“已应用”类错误视为成功并 ack —')
{
  const mac = fakeMac()
  const svc = fakeService({ 'inbox:resolve': { ok: false, error: { message: 'already applied' } } })
  const mp = await listen(mac.server), sp = await listen(svc.server)
  mac.state.outbox = [{ id: 'e1', ts: 1, channel: 'inbox:resolve', args: ['item1', 'reject'] }]
  const r = await mkBridge(mp, sp).syncOnce()
  ok('不抛错', r.mode === 'apply' && r.applied === 1)
  ok('ack 了', mac.state.acked.join(',') === 'e1')
  await close(mac.server); await close(svc.server)
}

console.log('\n— 真错误：停下，不 ack —')
{
  const mac = fakeMac()
  const svc = fakeService({ 'db:settle': { ok: false, error: { message: 'boom' } } })
  const mp = await listen(mac.server), sp = await listen(svc.server)
  mac.state.outbox = [
    { id: 'e1', ts: 1, channel: 'inbox:resolve', args: ['a', 'accept'] },
    { id: 'e2', ts: 2, channel: 'db:settle', args: ['n', true] },
    { id: 'e3', ts: 3, channel: 'theme:rename', args: ['t', '新名'] },
  ]
  let threw = null
  try { await mkBridge(mp, sp).syncOnce() } catch (e) { threw = e }
  ok('抛错', !!threw)
  ok('第一条已调 service', svc.calls.length === 2) // e1 ok, e2 失败停下
  ok('失败条及之后没 ack', mac.state.acked.length === 0)
  ok('outbox 保留 3 条待下轮', mac.state.outbox.length === 3)
  await close(mac.server); await close(svc.server)
}

console.log('\n— outbox 为空：推送快照 —')
{
  const mac = fakeMac()
  const svc = fakeService()
  const mp = await listen(mac.server), sp = await listen(svc.server)
  const r = await mkBridge(mp, sp).syncOnce()
  ok('syncOnce 返回 snapshot', r.mode === 'snapshot' && r.pushed === true)
  ok('Mac 收到快照', mac.state.snapshots.length === 1 && mac.state.snapshots[0].nodes[0].id === 'vm-node')
  await close(mac.server); await close(svc.server)
}

console.log('\n— Mac 409 拒绝快照：不抛错，下轮重试 —')
{
  const mac = fakeMac()
  mac.state.refuseSnapshot = true
  const svc = fakeService()
  const mp = await listen(mac.server), sp = await listen(svc.server)
  const r = await mkBridge(mp, sp).syncOnce()
  ok('pushed=false 且无异常', r.mode === 'snapshot' && r.pushed === false)
  await close(mac.server); await close(svc.server)
}

console.log('\n— Mac 不可达：抛错但不崩，退避增长 —')
{
  const svc = fakeService()
  const sp = await listen(svc.server)
  const b = mkBridge(1, sp) // 127.0.0.1:1 必定拒绝
  let threw = null
  try { await b.syncOnce() } catch (e) { threw = e }
  ok('syncOnce 抛错', !!threw)
  const cfg = loadBridgeConfig({ bridgeDir })
  ok('退避基数', backoffDelayMs(cfg, 0) === cfg.intervalMs)
  ok('退避指数增长', backoffDelayMs(cfg, 2) === Math.min(cfg.intervalMs * 4, cfg.maxBackoffMs))
  ok('退避有上限', backoffDelayMs(cfg, 99) === cfg.maxBackoffMs)
  await close(svc.server)
}

console.log('\n— token 缺失直接拒绝 —')
{
  const b = createBridge({ bridgeDir, macUrl: 'http://127.0.0.1:9', macToken: '', serviceUrl: 'http://127.0.0.1:9', serviceToken: 'x', intervalMs: 50, maxBackoffMs: 1000 })
  let threw = null
  try { await b.syncOnce() } catch (e) { threw = e }
  ok('macToken 为空抛错', !!threw && /macToken/.test(threw.message))
}

console.log('\n— isBenignReplayError —')
{
  ok('already applied', isBenignReplayError({ message: 'already applied' }))
  ok('字符串形式', isBenignReplayError('duplicate key'))
  ok('真错误不算 benign', !isBenignReplayError({ message: 'boom' }))
  ok('null 不算', !isBenignReplayError(null))
}

console.log('\n— 配置：默认目录不指向真实账本 —')
{
  delete process.env.MERIDIAN_BRIDGE_DIR
  const cfg = loadBridgeConfig({})
  ok('默认 bridgeDir 在 home 下', cfg.bridgeDir.includes('.local/share/meridian-sync-bridge'))
  ok('不含真实账本路径', !cfg.bridgeDir.includes('.config/脉络'))
  process.env.MERIDIAN_SYNC_MAC_URL = 'http://10.0.0.9:3821'
  const cfg2 = loadBridgeConfig({})
  ok('环境变量覆盖 macUrl', cfg2.macUrl === 'http://10.0.0.9:3821')
  delete process.env.MERIDIAN_SYNC_MAC_URL
}

console.log('\n— CONNECT 隧道代理 —')
{
  // 假目标 HTTP 服务
  const target = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, via: 'tunnel' }))
  })
  await new Promise((r) => target.listen(0, '127.0.0.1', r))
  const targetPort = target.address().port
  // 假 CONNECT 代理：应答 200 后把 socket 管道到目标
  let gotConnect = false
  const proxy = createNetServer((sock) => {
    let head = ''
    const onData = (chunk) => {
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      sock.off('data', onData)
      const m = head.match(/^CONNECT ([^ :]+):(\d+)/)
      if (!m) { sock.destroy(); return }
      gotConnect = true
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const rest = Buffer.from(head.slice(head.indexOf('\r\n\r\n') + 4), 'latin1')
      const up = netConnect({ host: m[1], port: Number(m[2]) }, () => {
        if (rest.length) up.write(rest)
        sock.pipe(up).pipe(sock)
      })
      up.on('error', () => sock.destroy())
    }
    sock.on('data', onData)
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const proxyPort = proxy.address().port

  const agent = tunnelAgent(`http://127.0.0.1:${proxyPort}`)
  const res = await httpJson(`http://127.0.0.1:${targetPort}/sync/health`, { agent })
  ok('经 CONNECT 隧道拿到目标响应', res.ok && res.body && res.body.via === 'tunnel')
  ok('请求确实走了 CONNECT 隧道（不是直连）', gotConnect)
  ok('无代理时 tunnelAgent 返回 undefined（直连）', tunnelAgent('') === undefined)

  delete process.env.MERIDIAN_SYNC_TUNNEL_PROXY
  delete process.env.HTTPS_PROXY
  delete process.env.HTTP_PROXY
  process.env.HTTPS_PROXY = 'http://user:pw@proxy.example:3128'
  ok('deriveTunnelProxy 只换端口保留认证', deriveTunnelProxy() === 'http://user:pw@proxy.example:3130/')
  delete process.env.HTTPS_PROXY
  ok('无环境变量时返回空', deriveTunnelProxy() === '')

  target.close()
  proxy.close()
}

rmSync(bridgeDir, { recursive: true, force: true })
console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
