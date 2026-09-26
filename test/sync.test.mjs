/**
 * 反向同步测试（Mac 端）：outbox 白名单 + sync-server 端点。
 *
 * 运行：node test/sync.test.mjs（已接入 npm test）
 * 隔离：MERIDIAN_TEST_DATA 指向 test/.tmp/sync-data，绝不碰真实账本。
 */
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/sync-data')
process.env.MERIDIAN_TEST_DATA = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const stub = await import('./electron-stub.mjs')
globalThis.__electron = stub

const store = await import('../src/main/store.js')
const { register: registerIpc } = await import('../src/main/ipc.js')
const outbox = await import('../src/main/sync-outbox.js')
const syncSrv = await import('../src/main/sync-server.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const fire = async (ch, ...args) => stub.__handlers.get(ch)({}, ...args)

store.load()
registerIpc({ getMainWindow: () => undefined, enableOutbox: true })

console.log('\n— outbox 白名单 —')
ok('白名单含 inbox:resolve', outbox.OUTBOX_CHANNELS.has('inbox:resolve'))
for (const ch of ['inbox:prune', 'inbox:clear', 'inbox:clearUnextracted', 'db:resolveConflict', 'db:settle', 'theme:rename', 'theme:update']) {
  ok(`白名单含 ${ch}`, outbox.OUTBOX_CHANNELS.has(ch))
}
for (const ch of ['db:addNode', 'db:updateNode', 'db:removeNode', 'inbox:capture', 'inbox:import', 'inbox:extract',
  'inbox:undoAutoImport', 'reading:add', 'reading:push', 'settings:set', 'theme:add', 'theme:remove',
  'theme:regenerate', 'io:import', 'raw:clear']) {
  ok(`白名单排除 ${ch}`, !outbox.OUTBOX_CHANNELS.has(ch))
}

console.log('\n— outbox 记录 —')
const item = store.addInboxItem({ text: '同步测试条目', title: '同步测试' })
const r1 = await fire('inbox:resolve', item.id, 'reject')
ok('inbox:resolve 成功', r1?.status === 'rejected')
let entries = outbox.readOutbox(DATA)
ok('记录了 1 条', entries.length === 1, `实际 ${entries.length}`)
ok('channel 正确', entries[0]?.channel === 'inbox:resolve')
ok('args 正确', JSON.stringify(entries[0]?.args) === JSON.stringify([item.id, 'reject']))
ok('entry 有唯一 id', typeof entries[0]?.id === 'string' && entries[0].id.length > 0)
ok('entry 有 ts', typeof entries[0]?.ts === 'number')

console.log('\n— 重放幂等（bridge 崩在 apply/ack 之间会重放）—')
const r2 = await fire('inbox:resolve', item.id, 'reject')
ok('重复裁决不抛错', r2?.status === 'rejected')
ok('重复裁决又记了一条（重放安全由 VM 端幂等保证）', outbox.readOutbox(DATA).length === 2)

console.log('\n— 非白名单不记录 —')
await fire('db:stats')
await fire('inbox:list', {})
ok('读操作不记录', outbox.readOutbox(DATA).length === 2)
const n0 = outbox.readOutbox(DATA).length
ok('db:addNode（lemma 变更）不在白名单', !outbox.OUTBOX_CHANNELS.has('db:addNode'))

console.log('\n— 记录失败不影响用户操作 —')
const circular = {}
circular.self = circular
const rid = outbox.recordOutbox('inbox:resolve', [circular], DATA)
ok('不可序列化 args 返回 null 不抛错', rid === null)
ok('坏记录没写进文件', outbox.readOutbox(DATA).length === n0)

console.log('\n— ack —')
const ids = outbox.readOutbox(DATA).map((e) => e.id)
ok('ack 第一条返回 1', outbox.ackOutbox([ids[0]], DATA) === 1)
ok('还剩 1 条', outbox.readOutbox(DATA).length === 1)
ok('ack 不存在的 id 返回 0', outbox.ackOutbox(['no-such-id'], DATA) === 0)
ok('ack 剩余', outbox.ackOutbox([ids[1]], DATA) === 1)
ok('outbox 空了', outbox.outboxCount(DATA) === 0)

console.log('\n— sync-server 端点 —')
const TOKEN = 'test-sync-token'
let appliedSnapshot = null
let broadcastCount = 0
const srv = syncSrv.createSyncServer({
  token: TOKEN,
  host: '127.0.0.1',
  port: 0,
  outboxDir: DATA,
  hasSqlite: () => false,
  applySnapshot: async (s) => { appliedSnapshot = s },
  broadcast: () => { broadcastCount++ },
})
const { port } = await srv.start()
const BASE = `http://127.0.0.1:${port}`
const H = { authorization: `Bearer ${TOKEN}` }
const jget = async (path, headers = {}) => {
  const r = await fetch(BASE + path, { headers })
  return { status: r.status, body: await r.json() }
}
const jpost = async (path, body, headers = {}) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

let h = await jget('/sync/health')
ok('无 token → 401', h.status === 401)
h = await jget('/sync/health', { authorization: 'Bearer wrong' })
ok('错 token → 401', h.status === 401)
h = await jget('/sync/health', H)
ok('health 200', h.status === 200 && h.body.ok === true)
ok('health 带 outbox 计数', h.body.outbox === 0)

outbox.recordOutbox('db:settle', ['node1', true], DATA)
let ob = await jget('/sync/outbox', H)
ok('outbox 200 且有 1 条', ob.status === 200 && ob.body.entries.length === 1)
ok('entry 形状完整', ob.body.entries[0].channel === 'db:settle' && Array.isArray(ob.body.entries[0].args))

let snap = await jpost('/sync/snapshot', { nodes: [], version: 4 }, H)
ok('outbox 非空时快照 → 409', snap.status === 409 && snap.body.error === 'outbox-not-empty')

const ackId = ob.body.entries[0].id
const ack = await jpost('/sync/outbox/ack', { ids: [ackId] }, H)
ok('ack → 200', ack.status === 200 && ack.body.acked === 1)
ob = await jget('/sync/outbox', H)
ok('ack 后 outbox 空', ob.body.entries.length === 0)

snap = await jpost('/sync/snapshot', { nodes: [{ id: 'n1' }], version: 4 }, H)
ok('快照 200', snap.status === 200 && snap.body.ok === true)
ok('applySnapshot 被调用', appliedSnapshot?.nodes?.[0]?.id === 'n1')
ok('广播了 db:changed', broadcastCount === 1)

snap = await jpost('/sync/snapshot', { noNodes: true }, H)
ok('坏快照 → 400', snap.status === 400)
const nf = await jget('/nope', H)
ok('未知路由 → 404', nf.status === 404)
await srv.stop()

console.log('\n— hasSqlite 时拒绝快照 —')
const srv2 = syncSrv.createSyncServer({
  token: TOKEN, host: '127.0.0.1', port: 0, outboxDir: DATA,
  hasSqlite: () => true, applySnapshot: async () => {}, broadcast: () => {},
})
const p2 = await srv2.start()
const r409 = await fetch(`http://127.0.0.1:${p2.port}/sync/snapshot`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ nodes: [], version: 4 }),
})
ok('sqlite 已启用 → 409', r409.status === 409)
await srv2.stop()

console.log('\n— 快照落盘保留本机 settings —')
const localSettings = store.load().settings
const snapshot = { version: 4, nodes: [{ id: 's1', title: '快照节点' }], themes: [], inbox: [], settings: { apiKey: 'vm 的密钥，必须被丢弃' } }
syncSrv.applySnapshotToDisk(DATA, snapshot, () => store.load().settings)
const written = JSON.parse(readFileSync(join(DATA, 'meridian.json'), 'utf8'))
ok('settings 被本机值覆盖', JSON.stringify(written.settings) === JSON.stringify(localSettings))
ok('快照数据写进去了', written.nodes?.[0]?.id === 's1')
ok('load() 重读到新数据（缓存已失效）', store.load().nodes.some((n) => n.id === 's1'))

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
