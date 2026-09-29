/**
 * VM 侧 op 记录测试：recordVmCaptureOps 把 inbox:capture 结果翻译成 op。
 *
 * 运行：node test/vm-oplog.test.mjs（已接入 npm test）
 * 隔离：MERIDIAN_DATA_DIR 指向 test/.tmp/vm-oplog-data；
 *      MERIDIAN_SERVICE_NOLISTEN=1 让 service/server.mjs 不占 3791 端口。
 * 绝不碰真实账本，不触发真实 capture（直接喂合成的 result 对象）。
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/vm-oplog-data')
process.env.MERIDIAN_DATA_DIR = DATA
process.env.MERIDIAN_SERVICE_NOLISTEN = '1'

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const { recordVmCaptureOps } = await import('../service/server.mjs')
const store = await import('../src/main/store.js')
const { readOutbox } = await import('../src/main/sync-outbox.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const ops = () => readOutbox(DATA)
const clearOps = () => { rmSync(join(DATA, 'sync-outbox.jsonl'), { force: true }); rmSync(join(DATA, 'sync-outbox.seq'), { force: true }) }

store.load()

console.log('\n— inbox 待裁决路径 —')
clearOps()
recordVmCaptureOps({ ok: true, autoImported: false, item: { id: 't-item-1', text: '待裁决', title: 't', status: 'pending', createdAt: '2026-09-29' } })
let entries = ops()
ok('记了 1 条 op', entries.length === 1, `实际 ${entries.length}`)
ok('channel 是 inbox:upsertItem', entries[0]?.channel === 'inbox:upsertItem')
ok('白名单内', (await import('../src/main/sync-outbox.js')).VM_OP_CHANNELS.has(entries[0]?.channel))
ok('args[0] 是条目本体', entries[0]?.args?.[0]?.id === 't-item-1')

console.log('\n— route-proposal 路径 —')
clearOps()
recordVmCaptureOps({ ok: true, autoImported: false, routeProposals: [
  { id: 'rp-1', text: 'a', title: 'a', kind: 'route-proposal' },
  { id: 'rp-2', text: 'b', title: 'b', kind: 'route-proposal' },
] })
entries = ops()
ok('记了 2 条 op', entries.length === 2)
ok('都是 inbox:upsertItem', entries.every((e) => e.channel === 'inbox:upsertItem'))

console.log('\n— autoImport 路径（new + merge + raw）—')
clearOps()
const node = store.addNode({ themeId: 'th1', title: 'op 测试节点', type: 'observation', confidence: 60 })
const raw = store.appendRaw({ kind: '独立媒体', label: '测试', text: '原文正文', channel: null })
recordVmCaptureOps({
  ok: true, autoImported: true, rawId: raw.id,
  imported: [
    { title: 'op 测试节点', action: 'new', id: node.id },
    { title: 'op 测试节点', action: 'merge', id: node.id, source: { kind: '媒体', label: 'm', at: '2026-09-29', rawId: raw.id } },
  ],
})
entries = ops()
ok('记了 3 条 op', entries.length === 3, `实际 ${entries.length}`)
const byCh = Object.fromEntries(entries.map((e) => [e.channel, e]))
ok('有 db:upsertNode', !!byCh['db:upsertNode'])
ok('节点快照带 id', byCh['db:upsertNode']?.args?.[0]?.id === node.id)
ok('有 db:addSource', !!byCh['db:addSource'])
ok('addSource args 是 [nodeId, source]', byCh['db:addSource']?.args?.[0] === node.id && byCh['db:addSource']?.args?.[1]?.label === 'm')
ok('有 raw:upsert', !!byCh['raw:upsert'])
ok('原文按 id 引用', byCh['raw:upsert']?.args?.[0]?.id === raw.id)

console.log('\n— new 指向不存在的节点：跳过不记 —')
clearOps()
recordVmCaptureOps({ ok: true, autoImported: true, imported: [{ title: 'x', action: 'new', id: 'no-such-node' }] })
ok('坏节点引用不记 op', ops().length === 0)

console.log('\n— skip/dup 无副作用路径：不记 op —')
clearOps()
recordVmCaptureOps({ ok: true, skipped: 'low-quality', extracted: false, routeProposals: [] })
recordVmCaptureOps({ ok: true, skipped: 'duplicate', routeProposals: [] })
ok('无 item 无 imported 不记', ops().length === 0)

console.log('\n— 坏输入不抛错 —')
clearOps()
let threw = false
try {
  recordVmCaptureOps(null)
  recordVmCaptureOps(undefined)
  recordVmCaptureOps({ ok: false, error: 'boom' })
} catch { threw = true }
ok('不抛错', !threw)
ok('没记 op', ops().length === 0)

console.log('\n— seq 单调 —')
clearOps()
recordVmCaptureOps({ ok: true, autoImported: false, item: { id: 's1', text: 'a', title: 'a' } })
recordVmCaptureOps({ ok: true, autoImported: false, item: { id: 's2', text: 'b', title: 'b' } })
entries = ops()
ok('seq 1,2 单调', entries.length === 2 && entries[0].seq === 1 && entries[1].seq === 2)

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
