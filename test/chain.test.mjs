/**
 * 主题认知链 · 数据层测试。
 *
 * 运行：node test/chain.test.mjs
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/chain-data')
process.env.MERIDIAN_USER_DATA_DIR = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const store = await import('../src/main/store.js')
const chain = await import('../src/main/chain-store.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

store.load()
const theme = store.addTheme('链测试主题')

console.log('\n— getChain 归一化 —')
const c0 = chain.getChain(theme.id)
ok('空链 segments 为空数组', Array.isArray(c0.segments) && c0.segments.length === 0)
ok('空链 readingMap 为对象', c0.readingMap && typeof c0.readingMap === 'object')

console.log('\n— mountToChain 新建段 —')
const m1 = chain.mountToChain(theme.id, {
  mountId: 'mount-1',
  segmentNames: ['激光器良率'],
  coreInfo: '激光器良率从 55% 提升到 68%',
  oldValue: '55%', newValue: '68%',
  evidence: '公司 Q3 电话会披露',
  evidenceRefs: [{ type: 'inbox', id: 'inbox-1', title: 'Q3 电话会' }],
})
ok('挂载返回 1 个段', m1.segments.length === 1)
ok('新建段名记录', m1.created.length === 1 && m1.created[0] === '激光器良率')
const seg = chain.getChain(theme.id).segments[0]
ok('段 id 稳定', typeof seg.id === 'string' && seg.id.length > 0)
ok('段状态 pending', seg.status === 'pending')
ok('变化 log 有 1 条', seg.changeLog.length === 1)
ok('log 带 hash', typeof seg.changeLog[0].hash === 'string' && seg.changeLog[0].hash.length === 64)
ok('首条 prevHash 为 GENESIS', seg.changeLog[0].prevHash === 'GENESIS')
ok('证据引用已挂', seg.evidenceRefs.length === 1)

console.log('\n— mountToChain 同段追加 + hash 链 —')
chain.mountToChain(theme.id, {
  mountId: 'mount-2',
  segmentNames: ['激光器良率'],
  oldValue: '68%', newValue: '72%',
  evidence: 'Q4 电话会披露',
})
const seg2 = chain.getChain(theme.id).segments[0]
ok('仍是 1 个段（同名聚合）', chain.getChain(theme.id).segments.length === 1)
ok('log 追加到 2 条', seg2.changeLog.length === 2)
ok('第二条 prevHash 指向第一条 hash', seg2.changeLog[1].prevHash === seg2.changeLog[0].hash)
ok('hash 各不相同', seg2.changeLog[0].hash !== seg2.changeLog[1].hash)

console.log('\n— mountToChain 幂等 —')
chain.mountToChain(theme.id, { mountId: 'mount-2', segmentNames: ['激光器良率'], newValue: '72%' })
ok('同一 mountId 重放不重复', chain.getChain(theme.id).segments[0].changeLog.length === 2)

console.log('\n— updateChainSegment 改名保留 id —')
const oldId = seg2.id
chain.updateChainSegment(theme.id, oldId, { name: '激光器良率（修正）' }, null)
const seg3 = chain.getChain(theme.id).segments[0]
ok('改名后 id 不变', seg3.id === oldId)
ok('名字已更新', seg3.name === '激光器良率（修正）')

console.log('\n— mergeChainSegments —')
chain.mountToChain(theme.id, { mountId: 'mount-3', segmentNames: ['光模块出货'], newValue: '100万/月' })
const segs = chain.getChain(theme.id).segments
const fromSeg = segs.find((s) => s.name === '光模块出货')
const intoSeg = segs.find((s) => s.name === '激光器良率（修正）')
const mr = chain.mergeChainSegments(theme.id, [fromSeg.id], intoSeg.id, '同一产线')
ok('合并返回 from 名', mr.merged.length === 1 && mr.merged[0] === '光模块出货')
const after = chain.getChain(theme.id)
ok('from 段已关闭', after.segments.find((s) => s.id === fromSeg.id).status === 'closed')
ok('from 段标了汇入', after.segments.find((s) => s.id === fromSeg.id).mergedInto.includes('激光器良率（修正）'))
ok('目标段记录了合并来源', after.segments.find((s) => s.id === intoSeg.id).mergedFrom.includes('光模块出货'))
ok('合并幂等（重放不重复）', chain.mergeChainSegments(theme.id, [fromSeg.id], intoSeg.id).merged.length === 0)

console.log('\n— addChainSubsegment + closeChainBranch —')
const sub = chain.addChainSubsegment(theme.id, intoSeg.id, {
  name: '资本开支路径 A', kind: 'conditional', convergeCondition: 'Q1 财报验证',
})
ok('分支已创建', typeof sub.id === 'string')
ok('条件分叉段状态 forking', chain.getChain(theme.id).segments.find((s) => s.id === intoSeg.id).status === 'forking')
chain.closeChainBranch(theme.id, intoSeg.id, sub.id, 'Q1 财报证伪，路径 B 胜出')
const closed = chain.getChain(theme.id).segments.find((s) => s.id === intoSeg.id).subsegments[0]
ok('分支已关闭', closed.status === 'closed')
ok('关闭留痕', closed.closeReason.includes('证伪'))
ok('关闭幂等', chain.closeChainBranch(theme.id, intoSeg.id, sub.id, 'x').status === 'closed')

console.log('\n— readingMap —')
chain.setReadingMap(theme.id, { '激光器良率': '激光器良率（修正）' })
ok('映射表可读写', chain.getReadingMap(theme.id)['激光器良率'] === '激光器良率（修正）')

console.log(`\nchain: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
