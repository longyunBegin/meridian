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

console.log('\n— reviveChainSegment（整段复活） —')
const reviveRes = chain.reviveChainSegment(theme.id, fromSeg.id, '测试复活')
const revivedSeg = chain.getChain(theme.id).segments.find((s) => s.id === fromSeg.id)
ok('关闭段回到 pending', revivedSeg.status === 'pending')
ok('返回 reopened', reviveRes.reopened.length === 1)
ok('复活记日志', revivedSeg.changeLog.some((e) => String(e.reason || '').includes('整段复活')))
// 整段复活含分支：再关一个分支后一起复活
const sub2 = chain.addChainSubsegment(theme.id, revivedSeg.id, { name: '测试分支', kind: 'structural' })
chain.closeChainBranch(theme.id, revivedSeg.id, sub2.id, '测试关闭')
// 先把段重新关闭，模拟"整段带已关闭分支"
chain.updateChainSegment(theme.id, revivedSeg.id, { status: 'closed' })
const reviveAll = chain.reviveChainSegment(theme.id, revivedSeg.id)
const segAfter = chain.getChain(theme.id).segments.find((s) => s.id === fromSeg.id)
ok('段与分支一起复活', segAfter.status === 'pending' && segAfter.subsegments.find((x) => x.id === sub2.id).status === 'pending')
ok('reopened 含段与分支', reviveAll.reopened.length === 2)
ok('复活幂等（已开放无操作）', chain.reviveChainSegment(theme.id, revivedSeg.id).reopened.length === 0)

console.log('\n— readingMap —')
chain.setReadingMap(theme.id, { '激光器良率': '激光器良率（修正）' })
ok('映射表可读写', chain.getReadingMap(theme.id)['激光器良率'] === '激光器良率（修正）')

console.log('\n— 段展示分层 layer（纯页面分组，不限三层） —')
const layerTheme = store.addTheme('分层测试主题')
chain.mountToChain(layerTheme.id, { mountId: 'layer-1', segmentNames: ['默认段'] })
const defaultSeg = chain.getChain(layerTheme.id).segments.find((s) => s.name === '默认段')
ok('缺省 layer 为 0', defaultSeg.layer === 0)
ok('缺省三层', JSON.stringify(chain.getChain(layerTheme.id).layerNames) === JSON.stringify(['第一层', '第二层', '第三层']))
chain.mountToChain(layerTheme.id, { mountId: 'layer-2', segmentNames: ['底层段'], layer: 2 })
ok('建段可指定 layer', chain.getChain(layerTheme.id).segments.find((s) => s.name === '底层段').layer === 2)
chain.mountToChain(layerTheme.id, { mountId: 'layer-3', segmentNames: ['坏层段'], layer: -1 })
ok('非法 layer 回退 0', chain.getChain(layerTheme.id).segments.find((s) => s.name === '坏层段').layer === 0)
chain.updateChainSegment(layerTheme.id, defaultSeg.id, { layer: 2 })
ok('update 可改 layer', chain.getChain(layerTheme.id).segments.find((s) => s.id === defaultSeg.id).layer === 2)
chain.updateChainSegment(layerTheme.id, defaultSeg.id, { layer: 'x' })
ok('非法 layer 更新被忽略', chain.getChain(layerTheme.id).segments.find((s) => s.id === defaultSeg.id).layer === 2)
// 老账本：无 layer 字段的段归一化为 0
const legacy = chain.getChain(layerTheme.id)
legacy.segments.push({ id: 'legacy-seg', name: '老段' })
ok('归一化老段 layer=0', chain.normalizeChain(legacy).segments.find((s) => s.id === 'legacy-seg').layer === 0)
// setChainLayers：增层
const r1 = chain.setChainLayers(layerTheme.id, ['供给侧', '需求侧', '估值', '情绪面', '政策面'])
ok('可增至 5 层', r1.layerNames.length === 5 && r1.layerNames[0] === '供给侧')
chain.mountToChain(layerTheme.id, { mountId: 'layer-4', segmentNames: ['新层段'], layer: 4 })
ok('新层可建段', chain.getChain(layerTheme.id).segments.find((s) => s.name === '新层段').layer === 4)
// 减层：越界段收敛到最后一层
chain.setChainLayers(layerTheme.id, ['甲', '乙'])
ok('减层后越界段收敛', chain.getChain(layerTheme.id).segments.find((s) => s.name === '新层段').layer === 1)
ok('减层后已有段同步收敛', chain.getChain(layerTheme.id).segments.find((s) => s.name === '底层段').layer === 1)
// 空数组回到默认三层
ok('空数组回默认三层', chain.setChainLayers(layerTheme.id, []).layerNames.length === 3)
// 整段复活不碰 layer（此时默认段已被收敛到 1）
chain.updateChainSegment(layerTheme.id, defaultSeg.id, { status: 'closed' })
chain.reviveChainSegment(layerTheme.id, defaultSeg.id)
ok('复活不改 layer', chain.getChain(layerTheme.id).segments.find((s) => s.id === defaultSeg.id).layer === 1)

console.log('\n— 段关闭记 closedAt（墓碑关闭日期） —')
const closeTheme = store.addTheme('关闭日期主题')
chain.mountToChain(closeTheme.id, { mountId: 'close-1', segmentNames: ['待关段'] })
const closeSeg = chain.getChain(closeTheme.id).segments.find((s) => s.name === '待关段')
ok('关闭前无 closedAt', closeSeg.closedAt == null)
chain.updateChainSegment(closeTheme.id, closeSeg.id, { status: 'closed' })
const closedSeg = chain.getChain(closeTheme.id).segments.find((s) => s.id === closeSeg.id)
ok('关闭记 closedAt', typeof closedSeg.closedAt === 'string' && closedSeg.closedAt.length > 0)
chain.mountToChain(closeTheme.id, { mountId: 'close-2', segmentNames: ['目标段'] })
chain.mountToChain(closeTheme.id, { mountId: 'close-3', segmentNames: ['被并段'] })
const targetSeg = chain.getChain(closeTheme.id).segments.find((s) => s.name === '目标段')
const mergedSeg = chain.getChain(closeTheme.id).segments.find((s) => s.name === '被并段')
chain.mergeChainSegments(closeTheme.id, [mergedSeg.id], targetSeg.id, '测试合并')
ok('合并关闭也记 closedAt', !!chain.getChain(closeTheme.id).segments.find((s) => s.id === mergedSeg.id).closedAt)

console.log('\n— 视图源码断言（语义图谱，P2） —')
const { readFileSync: readFileSyncChain } = await import('node:fs')
const { existsSync: existsSyncChain } = await import('node:fs')
const chainViewSrc = readFileSyncChain(join(ROOT, 'src/renderer/views/chain.js'), 'utf8')
const stylesSrcChain = readFileSyncChain(join(ROOT, 'src/renderer/styles.css'), 'utf8')
ok('旧分层渲染已删除', !chainViewSrc.includes('chain-layers') && !chainViewSrc.includes('DEFAULT_LAYER_NAMES'))
ok('旧连线代码已删除', !chainViewSrc.includes('drawChainEdges') && !chainViewSrc.includes('chainArrow'))
ok('chain-edges.js 已删除', !existsSyncChain(join(ROOT, 'src/renderer/lib/chain-edges.js')))
ok('旧段抽屉已删除', !chainViewSrc.includes('openSegmentDetail') && !chainViewSrc.includes('renderSegmentCard'))
ok('新视图画语义图谱 SVG', chainViewSrc.includes('cog-svg') && chainViewSrc.includes("class: 'cog-node'"))
ok('三节点类型语义色', chainViewSrc.includes("label: '主张'") && chainViewSrc.includes("label: '推断'") && chainViewSrc.includes("label: '证据'"))
ok('三种关系语义色', chainViewSrc.includes("label: '支持'") && chainViewSrc.includes("label: '推导'") && chainViewSrc.includes("label: '反驳'"))
ok('待复核边用虚线', chainViewSrc.includes('is-review') && chainViewSrc.includes('cog-arrow-review'))
ok('力导向布局', chainViewSrc.includes('layoutGraph') && chainViewSrc.includes('seededRand'))
ok('节点可拖拽', chainViewSrc.includes('pointerdown') && chainViewSrc.includes('redrawEdges'))
ok('图例', chainViewSrc.includes('cog-legend'))
ok('图谱样式存在', stylesSrcChain.includes('.cog-svg') && stylesSrcChain.includes('.cog-edge'))
ok('节点详情读投影', chainViewSrc.includes('openNodeDetail') && chainViewSrc.includes('chainEvents') && chainViewSrc.includes('chainProjection'))
ok('详情展示历史版本', chainViewSrc.includes('历史版本') && chainViewSrc.includes('TYPE_LABEL'))
ok('挂载走事件账本', chainViewSrc.includes('chainMountEvent') && !chainViewSrc.includes('m.chainMount('))
ok('收件箱挂载函数保留', chainViewSrc.includes('renderProposalDraft'))
ok('证据详情函数保留', chainViewSrc.includes('openEvidenceDetail'))
ok('命题证据可点进右栏', /ref\.type === 'lemma'[\s\S]*?selectNode\(ref\.id\)/.test(chainViewSrc))
ok('节点保留 data-status', chainViewSrc.includes('data-status'))
ok('未连入图谱收进列表', chainViewSrc.includes('cog-float') && chainViewSrc.includes('floatingCount'))


process.exit(fail ? 1 : 0)
