/**
 * service 层 HTTP 测试：service/server.mjs（Phase 1）。
 *
 * 运行：node service/test/service.test.mjs
 *
 * 全部走真实 HTTP：子进程启动 `node service/server.mjs`，
 * 数据目录为 os tmpdir 下的隔离目录（MERIDIAN_DATA_DIR），
 * 端口/ token 全部走 env 覆盖（PORT / MERIDIAN_TOKEN），
 * 永不碰 /home/hatch/.config/脉络，也不碰 service/config.json。
 *
 * 注意：server.mjs 不认 MERIDIAN_CONFIG 这个 env——它只读固定路径
 * service/config.json，但 PORT、HOST、MERIDIAN_TOKEN 支持 env 覆盖，
 * 所以本测试不需要备份/恢复 service/config.json。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'service', 'server.mjs')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const skip = (name, reason) => {
  console.log(` SKIP  ${name}  (${reason})`)
}

// ---------------------------------------------------------------- 隔离环境
// 红线：测试数据只进临时目录，绝不碰真实账本（/home/hatch/.config/脉络）。
const DATA_DIR = mkdtempSync(join(tmpdir(), 'meridian-svc-test-'))
const PORT = 38000 + Math.floor(Math.random() * 1500)
const TOKEN = randomBytes(24).toString('hex')
const BASE = `http://127.0.0.1:${PORT}`

const proc = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, MERIDIAN_DATA_DIR: DATA_DIR, PORT: String(PORT), MERIDIAN_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})
proc.stderr.on('data', (d) => process.stderr.write(`[svc] ${d}`))

async function waitReady(timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.status === 200) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

const post = (channel, { token = TOKEN, body = {}, rawBody, contentType = 'application/json' } = {}) => {
  const headers = { 'content-type': contentType }
  if (token) headers.authorization = `Bearer ${token}`
  return fetch(`${BASE}/api/${channel}`, {
    method: 'POST',
    headers,
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  })
}

async function main() {
  if (!(await waitReady())) {
    console.log(' FAIL  服务未能在 15s 内启动，测试中止')
    cleanup()
    process.exit(1)
  }
  console.log(`服务已就绪：${BASE}（数据目录 ${DATA_DIR}）`)

  // — 1. 认证 —
  console.log('\n— 认证 —')
  {
    const r1 = await post('db:stats', { token: null, body: {} })
    ok('无 token → 401', r1.status === 401, `实际 ${r1.status}`)
    const r2 = await post('db:stats', { token: 'wrong-token', body: {} })
    ok('错误 token → 401', r2.status === 401, `实际 ${r2.status}`)
    const b1 = await r1.json()
    ok('401 返回错误信封', b1?.ok === false && typeof b1?.error?.message === 'string')
  }

  // — 2. healthz 免认证 —
  console.log('\n— GET /healthz —')
  {
    const r = await fetch(`${BASE}/healthz`)
    const b = await r.json()
    ok('GET /healthz 免认证 200', r.status === 200, `实际 ${r.status}`)
    ok('/healthz 含 ok:true', b?.ok === true && b?.result?.ok === true, JSON.stringify(b?.result).slice(0, 80))
  }

  // — 3. db:stats —
  console.log('\n— POST /api/db:stats —')
  {
    const r = await post('db:stats')
    const b = await r.json()
    ok('db:stats 200', r.status === 200, `实际 ${r.status}`)
    ok('db:stats 返回 {ok:true}', b?.ok === true)
    const s = b?.result
    ok('result 有节点统计字段', s && typeof s.lemmas === 'number' && typeof s.branches === 'number' && typeof s.themes === 'number',
      `lemmas=${s?.lemmas} branches=${s?.branches} themes=${s?.themes}`)
  }

  // — 4. 写通道 round-trip：settings:set → settings:get —
  console.log('\n— settings:set → settings:get —')
  {
    const r1 = await post('settings:set', { body: { args: [{ graphZoom: 7 }] } })
    const b1 = await r1.json()
    ok('settings:set 200 且 ok', r1.status === 200 && b1?.ok === true, `实际 ${r1.status}`)
    const r2 = await post('settings:get')
    const b2 = await r2.json()
    ok('settings:get 200 且 ok', r2.status === 200 && b2?.ok === true)
    ok('写入后可读回（graphZoom=7）', b2?.result?.graphZoom === 7, `实际 ${b2?.result?.graphZoom}`)
  }

  // — 5. 未知 channel / 非法 JSON —
  console.log('\n— 404 / 400 —')
  {
    const r1 = await post('nope:channel')
    ok('未知 channel → 404', r1.status === 404, `实际 ${r1.status}`)
    const b1 = await r1.json()
    ok('404 返回错误信封', b1?.ok === false && typeof b1?.error?.message === 'string')
    const r2 = await post('db:stats', { rawBody: '{"broken":' })
    ok('非法 JSON body → 400', r2.status === 400, `实际 ${r2.status}`)
  }

  // — 6. 错误序列化（不泄漏 stack）—
  console.log('\n— 错误序列化 —')
  {
    // db:addNode(null) 必抛 TypeError（读 null.sources），验证 500 信封。
    const r = await post('db:addNode', { body: { args: [null] } })
    const b = await r.json()
    ok('必错调用 → 500', r.status === 500, `实际 ${r.status}`)
    ok('错误信封 {ok:false}', b?.ok === false)
    ok('error.message 是字符串', typeof b?.error?.message === 'string' && b.error.message.length > 0,
      `实际 ${JSON.stringify(b?.error?.message).slice(0, 60)}`)
    ok('不泄漏 stack', !('stack' in (b?.error || {})))
  }

  // — 7. SQLite 落盘验证 —
  console.log('\n— SQLite 落盘 —')
  {
    const sqliteFile = join(DATA_DIR, 'meridian.sqlite')
    if (!existsSync(sqliteFile)) {
      skip('meridian.sqlite 落盘', 'A 的 SQLite durability 改造尚未完成（文件不存在）')
    } else {
      ok('meridian.sqlite 存在', true)
      try {
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(sqliteFile)
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        ok('sqlite 可打开且有表', tables.length > 0, `表数 ${tables.length}`)
        let rows = 0
        for (const t of tables) {
          try { rows += db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c } catch { /* 视图等跳过 */ }
        }
        ok('sqlite 里有数据行', rows > 0, `总行数 ${rows}`)
        db.close()
      } catch (e) {
        ok('sqlite 可打开', false, e.message)
      }
    }
  }

  console.log(`\n${pass} 通过，${fail} 失败`)
  cleanup()
  process.exit(fail ? 1 : 0)
}

function cleanup() {
  try { proc.kill('SIGTERM') } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

main().catch((e) => {
  console.log(' FAIL  测试异常', e?.message || String(e))
  cleanup()
  process.exit(1)
})
