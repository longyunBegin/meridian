/**
 * 双向 op log 同步测试（Mac 端）：outbox seq/游标 + sync-server 端点 + VM op 白名单 + upsert 幂等。
 *
 * 运行：node test/sync.test.mjs（已接入 npm test）
 * 隔离：MERIDIAN_TEST_DATA 指向 test/.tmp/sync-data，绝不碰真实账本。
 */
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/sync-data')
process.env.MERIDIAN_USER_DATA_DIR = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const { registry, invoke: fire } = await import('./runtime-harness.mjs').then(({ createCommandTestHarness }) => createCommandTestHarness(DATA, { outbox: true }))

const store = await import('../src/main/store.js')
const { registerDomainCommands } = await import('../src/main/domain-commands.js')
const outbox = await import('../src/main/sync-outbox.js')
const syncSrv = await import('../src/main/sync-server.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

store.load()
registerDomainCommands({ registry })

console.log('\n— outbox 白名单（Mac→VM）—')
ok('白名单含 inbox:resolve', outbox.OUTBOX_CHANNELS.has('inbox:resolve'))
for (const ch of ['inbox:prune', 'inbox:deleteIds', 'inbox:clear', 'inbox:clearUnextracted', 'db:resolveConflict', 'db:settle', 'theme:rename', 'theme:update', 'inbox:extract', 'inbox:import', 'inbox:setTheme']) {
  ok(`白名单含 ${ch}`, outbox.OUTBOX_CHANNELS.has(ch))
}
for (const ch of ['db:addNode', 'db:updateNode', 'db:removeNode', 'inbox:capture', 'inbox:undoAutoImport', 'reading:add', 'reading:push', 'settings:set', 'theme:add', 'theme:remove',
  'theme:regenerate', 'io:import', 'raw:clear']) {
  ok(`白名单排除 ${ch}`, !outbox.OUTBOX_CHANNELS.has(ch))
}

console.log('\n— VM op 白名单（VM→Mac）—')
for (const ch of ['inbox:upsertItem', 'db:upsertNode', 'db:addSource', 'raw:upsert']) {
  ok(`VM 白名单含 ${ch}`, outbox.VM_OP_CHANNELS.has(ch))
}
for (const ch of ['inbox:resolve', 'db:settle', 'inbox:capture', 'db:updateNode', 'db:removeNode', 'settings:set']) {
  ok(`VM 白名单排除 ${ch}`, !outbox.VM_OP_CHANNELS.has(ch))
}
ok('VM op handler 已登记', (() => { try { registry.invokeWithoutHooks('inbox:upsertItem', [null]); return true } catch { return false } })())
ok('未知 channel 抛错', (() => { try { registry.invokeWithoutHooks('nope:nope', []); return false } catch { return true } })())

console.log('\n— outbox 记录带 seq —')
const item = store.addInboxItem({ text: '同步测试条目', title: '同步测试' })
const r1 = await fire('inbox:resolve', item.id, 'reject')
ok('inbox:resolve 成功', r1?.status === 'rejected')
let entries = outbox.readOutbox(DATA)
ok('记录了 1 条', entries.length === 1, `实际 ${entries.length}`)
ok('channel 正确', entries[0]?.channel === 'inbox:resolve')
ok('seq 从 1 开始单调', entries[0]?.seq === 1)
ok('entry 有 ts', typeof entries[0]?.ts === 'number')

console.log('\n— seq 游标拉取/ack —')
await fire('inbox:resolve', item.id, 'ignore')
entries = outbox.readOutbox(DATA)
ok('两条 seq 是 1,2', entries.length === 2 && entries[0].seq === 1 && entries[1].seq === 2)
const later = outbox.readOutbox(DATA, 1)
ok('since=1 只返回 seq>1 的', later.length === 1 && later[0].seq === 2)
ok('ackOutboxCursor(1) 清掉 1 条', outbox.ackOutboxCursor(1, DATA) === 1)
ok('只剩 seq=2', outbox.readOutbox(DATA).length === 1 && outbox.readOutbox(DATA)[0].seq === 2)
ok('ackOutboxCursor(2) 清空', outbox.ackOutboxCursor(2, DATA) === 0 || outbox.readOutbox(DATA).length === 0)

console.log('\n— 老 outbox 无 seq 自动迁移 —')
const LEGACY = join(DATA, 'legacy-dir')
mkdirSync(LEGACY, { recursive: true })
writeFileSync(join(LEGACY, 'sync-outbox.jsonl'),
  JSON.stringify({ id: 'old-a', ts: 1, channel: 'db:settle', args: ['n1', true] }) + '\n' +
  JSON.stringify({ id: 'old-b', ts: 2, channel: 'db:settle', args: ['n2', false] }) + '\n')
const migrated = outbox.readOutbox(LEGACY)
ok('迁移后两条都有 seq 1,2', migrated.length === 2 && migrated[0].seq === 1 && migrated[1].seq === 2)
const rid3 = outbox.recordOutbox('db:settle', ['n3', true], LEGACY)
ok('迁移后新记录 seq=3', outbox.readOutbox(LEGACY).some((e) => e.id === rid3 && e.seq === 3))
ok('seq 计数器文件存在', existsSync(join(LEGACY, 'sync-outbox.seq')))

console.log('\n— 非白名单不记录 —')
await fire('db:stats')
await fire('inbox:list', {})
ok('读操作不记录', outbox.readOutbox(DATA).length === 0)

console.log('\n— 记录失败不影响用户操作 —')
const circular = {}
circular.self = circular
const rid = outbox.recordOutbox('inbox:resolve', [circular], DATA)
ok('不可序列化 args 返回 null 不抛错', rid === null)

console.log('\n— upsertInboxItem 幂等且不覆盖裁决 —')
const vmItem = { id: 'vm-item-1', text: 'VM 来的条目', title: 't', extracted: true, matchScore: 0.9, createdAt: '2026-09-29' }
const u1 = store.upsertInboxItem(vmItem)
ok('首次 upsert added=true', u1.ok && u1.added === true)
// 用户在 Mac 侧裁决了这条
store.resolveInboxItem('vm-item-1', 'accept')
const u2 = store.upsertInboxItem(vmItem)
ok('重复 upsert added=false', u2.ok && u2.added === false)
const kept = store.load().inbox.find((i) => i.id === 'vm-item-1')
ok('用户裁决未被覆盖', kept?.status === 'accepted' && kept?.resolvedAt)
ok('坏条目被拒', store.upsertInboxItem(null).ok === false && store.upsertInboxItem({}).ok === false)

console.log('\n— upsertNodeSnapshot 幂等且不碰 confidence —')
const snapNode = { id: 'vm-node-1', themeId: 'th1', title: 'VM 建的节点', confidence: 42, history: [], sources: [], createdAt: '2026-09-29' }
const un1 = store.upsertNodeSnapshot(snapNode)
ok('首次 upsert added=true', un1.ok && un1.added === true)
// 模拟 confidence 被用户/系统改了，再 upsert 旧快照
store.updateNode('vm-node-1', { confidence: 90 })
const un2 = store.upsertNodeSnapshot({ ...snapNode, confidence: 42 })
ok('重复 upsert added=false', un2.ok && un2.added === false)
ok('confidence 未被覆盖', store.getNode('vm-node-1')?.confidence === 90)
ok('坏节点被拒', store.upsertNodeSnapshot(null).ok === false && store.upsertNodeSnapshot({ id: 'x' }).ok === false)

console.log('\n— upsertRaw 按 id 幂等 —')
const ur1 = store.upsertRaw({ id: 'raw-1', text: '原文内容', sha256: 'abc', createdAt: '2026-09-29' })
ok('首次 upsert added=true', ur1.ok && ur1.added === true)
const ur2 = store.upsertRaw({ id: 'raw-1', text: '原文内容', sha256: 'abc' })
ok('重复 upsert added=false', ur2.ok && ur2.added === false)
ok('坏原文被拒', store.upsertRaw({ id: 'raw-2' }).ok === false)

console.log('\n— 直调 VM op 不进 Mac outbox —')
const before = outbox.outboxCount(DATA)
await registry.invokeWithoutHooks('inbox:upsertItem', [{ id: 'vm-item-2', text: '直接调用', title: 't' }])
ok('本地调用不记 outbox', outbox.outboxCount(DATA) === before)
ok('条目已入库', store.allInbox().some((i) => i.id === 'vm-item-2'))

console.log('\n— sync-server 端点（双向 op log）—')
const TOKEN = 'test-sync-token'
const applied = []
let broadcastCount = 0
const srv = syncSrv.createSyncServer({
  token: TOKEN,
  host: '127.0.0.1',
  port: 0,
  outboxDir: DATA,
  applyOp: async (channel, args) => { applied.push({ channel, args }); return registry.invokeWithoutHooks(channel, args) },
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
ok('health 标 oplog', h.body.oplog === true)
ok('health 带 vmCursor', typeof h.body.vmCursor === 'number')
ok('health 带 outbox 计数', typeof h.body.outbox === 'number')

console.log('\n— /sync/ops 白名单应用 —')
const opsBody = {
  entries: [
    { id: 'op-1', ts: 1, seq: 1, channel: 'inbox:upsertItem', args: [{ id: 'vm-op-item-1', text: 'op 条目', title: 't' }] },
    { id: 'op-2', ts: 2, seq: 2, channel: 'db:upsertNode', args: [{ id: 'vm-op-node-1', themeId: 'th1', title: 'op 节点' }] },
    { id: 'op-3', ts: 3, seq: 3, channel: 'db:addSource', args: ['vm-op-node-1', { kind: '媒体', label: 'l', at: '2026-09-29' }] },
  ],
}
let r = await jpost('/sync/ops', opsBody, H)
ok('/sync/ops 200', r.status === 200 && r.body.ok === true)
ok('三个 op 都应用了', applied.length === 3)
ok('返回 applied=3', r.body.applied === 3)
ok('VM 游标持久化', syncSrv.readVmCursor(DATA) === 3)
ok('op 条目进了收件箱', store.allInbox().some((i) => i.id === 'vm-op-item-1'))
ok('op 节点已创建', !!store.getNode('vm-op-node-1'))
ok('广播了 db:changed', broadcastCount === 1)

console.log('\n— /sync/ops 幂等重放 —')
const before2 = store.allInbox().length
r = await jpost('/sync/ops', opsBody, H)
ok('重放返回 200', r.status === 200)
ok('无重复条目', store.allInbox().length === before2)
ok('applied 仍是 3（seq<=cursor 跳过）', r.body.applied === 3)
ok('count=0（实际没应用）', r.body.count === 0)

console.log('\n— /sync/ops fail-closed —')
r = await jpost('/sync/ops', { entries: [{ id: 'bad-1', ts: 1, seq: 4, channel: 'db:removeNode', args: ['x'] }] }, H)
ok('非白名单 channel → 400', r.status === 400)
ok('游标未动', syncSrv.readVmCursor(DATA) === 3)
r = await jpost('/sync/ops', { entries: [{ id: 'bad-2' }] }, H)
ok('畸形 entry → 400', r.status === 400)
r = await jpost('/sync/ops', { nope: 1 }, H)
ok('entries 非数组 → 400', r.status === 400)

console.log('\n— /sync/outbox 游标拉取 + ack —')
outbox.recordOutbox('db:settle', ['n1', true], DATA)
outbox.recordOutbox('inbox:resolve', ['i1', 'reject'], DATA)
let ob = await jget('/sync/outbox', H)
ok('outbox 200', ob.status === 200)
const allEntries = ob.body.entries
ok('entry 带 seq', allEntries.every((e) => typeof e.seq === 'number'))
const since = allEntries[0].seq
ob = await jget(`/sync/outbox?since=${since}`, H)
ok('since 过滤', ob.body.entries.every((e) => e.seq > since))
const lastSeq = allEntries[allEntries.length - 1].seq
const ack = await jpost('/sync/outbox/ack', { cursor: lastSeq }, H)
ok('按游标 ack → 200', ack.status === 200 && ack.body.acked >= 1)
ob = await jget('/sync/outbox', H)
ok('ack 后 outbox 空', ob.body.entries.length === 0)

const nf = await jget('/nope', H)
ok('未知路由 → 404', nf.status === 404)
r = await jpost('/sync/snapshot', { nodes: [] }, H)
ok('/sync/snapshot 已退役 → 404', r.status === 404)

console.log('\n— 清空类按 id 精确同步（2026-09-30 分叉回归）—')
// 录制侧：源头算好 deletedIds，outbox 里记 inbox:deleteIds 而非 filter 参数
const rc1 = store.addInboxItem({ text: '回归1', title: '回归1', extracted: false })
const rc2 = store.addInboxItem({ text: '回归2', title: '回归2', extracted: false })
const rc3 = store.addInboxItem({ text: '回归3', title: '回归3', extracted: true })
const obBefore = outbox.readOutbox(DATA).length
const clr = await fire('inbox:clearUnextracted')
ok('clearUnextracted 返回 deletedIds', clr.removed === 2 && clr.deletedIds.length === 2, `实际 ${clr.removed}`)
const clearOps = outbox.readOutbox(DATA).slice(obBefore)
ok('outbox 只记 1 条', clearOps.length === 1, `实际 ${clearOps.length}`)
ok('记的是 inbox:deleteIds 而非 inbox:clearUnextracted',
  clearOps[0]?.channel === 'inbox:deleteIds', `实际 ${clearOps[0]?.channel}`)
ok('deleteIds 精确对应源头被删集合',
  JSON.stringify([...clearOps[0].args[0]].sort()) === JSON.stringify([rc1.id, rc2.id].sort()))
ok('源头已抽取条目不在删除列表', !clearOps[0].args[0].includes(rc3.id))
// 回放侧：接收端 extracted 状态与源头不一致时，仍按 id 精确执行，不重算谓词
const rp1 = store.addInboxItem({ text: '回放删1', title: '回放删1', extracted: false })
const rp2 = store.addInboxItem({ text: '回放删2', title: '回放删2', extracted: true })
const rpKeep = store.addInboxItem({ text: '回放保留', title: '回放保留', extracted: false })
const delN = await fire('inbox:deleteIds', [rp1.id, rp2.id, 'ghost-id'])
const restIds = new Set(store.load().inbox.map((i) => i.id))
ok('deleteIds 按 id 删除（不看本地 extracted）', delN === 2 && !restIds.has(rp1.id) && !restIds.has(rp2.id))
ok('不在删除列表的未抽取条目不受影响（旧 filter 回放会误删它）', restIds.has(rpKeep.id))
ok('deleteIds 对未知 id 幂等', (await fire('inbox:deleteIds', ['ghost-id'])) === 0)
ok('deleteIds 空数组返回 0', (await fire('inbox:deleteIds', [])) === 0)
ok('deleteIds 非数组返回 0', (await fire('inbox:deleteIds', null)) === 0)
// inbox:clear 同样走 deleteIds 录制
const cc1 = store.addInboxItem({ text: '回归clear', title: '回归clear', extracted: false })
await fire('inbox:resolve', cc1.id, 'reject')
const obBefore2 = outbox.readOutbox(DATA).length
await fire('inbox:clear')
const clearOps2 = outbox.readOutbox(DATA).slice(obBefore2)
ok('inbox:clear 也录制为 inbox:deleteIds', clearOps2.length === 1 && clearOps2[0]?.channel === 'inbox:deleteIds')
await srv.stop()

console.log('\n— applyOp 缺失 fail-closed —')
let threw = false
try { syncSrv.createSyncServer({ token: TOKEN, host: '127.0.0.1', port: 0, outboxDir: DATA, broadcast: () => {} }) } catch { threw = true }
ok('无 applyOp 拒绝启动', threw)

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
