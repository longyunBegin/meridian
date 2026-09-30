/**
 * Sidecar 端到端验证：HTTP/MCP 入库 + 同步端点走真实链路。
 *
 * 用临时数据目录拉起 sidecar（backend.mjs），不碰真实账本：
 * 1. Agent server：POST /readings 入库 → 查账本确认落盘
 * 2. Agent server：POST /mcp 走 JSON-RPC
 * 3. Sync server：GET /sync/health → POST /sync/ops 发 op → 确认应用
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const root = resolve(new URL('..', import.meta.url).pathname)
const work = mkdtempSync(join(tmpdir(), 'meridian-e2e-'))
const dataDir = join(work, 'data')
mkdirSync(dataDir, { recursive: true })

// 最小账本骨架
writeFileSync(join(dataDir, 'meridian.json'), JSON.stringify({
  version: 4, settings: {}, themes: [], nodes: [], verdicts: [],
  conflicts: [], feeds: [], inbox: [], traces: [], intakeEvents: [],
  readings: [], sources: [], researchNotes: [],
}))

// Sync server 需要 token 才会启动（fail-closed）；用固定测试端口
const syncToken = 'e2e-sync-test-token'
const syncPort = 13821
writeFileSync(join(dataDir, 'sync.config.json'), JSON.stringify({
  token: syncToken, host: '127.0.0.1', port: syncPort,
}))

const sidecarToken = 'e2e-sidecar-secret'
const child = spawn(process.execPath, [join(root, 'src/tauri/backend.mjs')], {
  cwd: root,
  env: { ...process.env, MERIDIAN_SIDECAR_TOKEN: sidecarToken, MERIDIAN_USER_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.setEncoding('utf8').on('data', (t) => { stderr += t })
const lines = readline.createInterface({ input: child.stdout })
let resolveReady
const ready = new Promise((res, rej) => {
  resolveReady = res
  setTimeout(() => rej(new Error(`sidecar 启动超时: ${stderr.slice(-500)}`)), 25000).unref()
})
lines.on('line', (line) => {
  try {
    const v = JSON.parse(line)
    if (v.ready && Number.isInteger(v.port)) resolveReady(v)
  } catch { /* 诊断行忽略 */ }
})
child.once('exit', (code, signal) => resolveReady(new Error(`sidecar 退出 (${code ?? signal}): ${stderr.slice(-500)}`)))

try {
  const { port: rpcPort } = await ready
  const rpcBase = `http://127.0.0.1:${rpcPort}`

  // --- 1. Agent server：读 discovery 文件 ---
  const discoveryPath = join(dataDir, 'agent-port.json')
  assert.ok(existsSync(discoveryPath), 'agent server 应写 discovery 文件')
  const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'))
  assert.ok(discovery.port > 0, 'agent server 应有端口')
  const agentBase = `http://${discovery.host}:${discovery.port}`
  const agentHeaders = { 'content-type': 'application/json' }
  if (discovery.requireToken) agentHeaders['authorization'] = `Bearer ${discovery.token}`

  // --- 2. POST /readings 入库 ---
  const reading = {
    schema: 'meridian.reading.v1',
    readings: [{
      indicator: 'E2E 测试指标',
      value: 42,
      unit: 'test',
      period: { start: '2026-09-30', end: '2026-09-30' },
      at: new Date().toISOString(),
      source: { url: 'https://example.com/e2e', label: 'E2E 测试' },
    }],
  }
  const ingestRes = await fetch(`${agentBase}/readings`, {
    method: 'POST', headers: agentHeaders, body: JSON.stringify(reading),
  })
  assert.equal(ingestRes.status, 200, '/readings 应返回 200')
  const ingestBody = await ingestRes.json()
  assert.ok(ingestBody.accepted > 0 || ingestBody.ok !== false, '读数应被接受')

  // 确认落盘：用 /invoke 查 readings
  const invoke = (command, args) => fetch(`${rpcBase}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-meridian-token': sidecarToken },
    body: JSON.stringify({ command, args }),
  }).then((r) => r.json())
  const latestRes = await invoke('reading:latest', [])
  const items = latestRes?.result?.items || []
  const found = items.some((r) => r.indicator === 'E2E 测试指标')
  assert.ok(found, '读数应可通过 reading:latest 查到')

  // --- 3. POST /mcp 走 JSON-RPC ---
  const mcpRes = await fetch(`${agentBase}/mcp`, {
    method: 'POST',
    headers: { ...agentHeaders, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  assert.equal(mcpRes.status, 200, '/mcp 应返回 200')
  const mcpBody = await mcpRes.json()
  assert.equal(mcpBody.jsonrpc, '2.0', '应为 JSON-RPC 响应')
  assert.ok(mcpBody.result || mcpBody.error, '应有 result 或 error')

  // --- 4. Sync server：health（带重试，sync server 可能稍晚于 sidecar 就绪） ---
  const syncBase = `http://127.0.0.1:${syncPort}`
  const syncHeaders = { 'authorization': `Bearer ${syncToken}` }
  let healthRes = null
  for (let i = 0; i < 10; i++) {
    try {
      healthRes = await fetch(`${syncBase}/sync/health`, { headers: syncHeaders })
      if (healthRes.status === 200) break
    } catch { /* 连接中，重试 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.ok(healthRes, 'sync server 应可连接')
  if (healthRes.status !== 200) {
    console.log('health body:', (await healthRes.text()).slice(0, 300))
  }
  assert.equal(healthRes.status, 200, '/sync/health 应返回 200')
  const health = await healthRes.json()
  assert.equal(health.ok, true, 'health 应为 ok')
  assert.equal(health.oplog, true, '应有 oplog 标记')

  // --- 5. Sync /sync/ops：发一个 inbox:upsertItem（幂等，已存在则跳过） ---
  const opsRes = await fetch(`${syncBase}/sync/ops`, {
    method: 'POST',
    headers: { ...syncHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      entries: [{ id: 'e2e-op-1', seq: 1, channel: 'inbox:upsertItem', args: [{ id: 'e2e-inbox-1', text: 'E2E 测试条目', source: 'e2e' }] }],
    }),
  })
  assert.equal(opsRes.status, 200, '/sync/ops 应返回 200')
  const opsBody = await opsRes.json()
  if (!opsBody.ok) console.log('ops error:', JSON.stringify(opsBody).slice(0, 200))
  assert.equal(opsBody.ok, true, 'op 应被应用')

  console.log('  ✓ sync health + ops 通过')
  console.log('  ✓ e2e 入库链路验证通过')
} finally {
  child.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 500))
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}

console.log('sidecar e2e: 全部通过')
