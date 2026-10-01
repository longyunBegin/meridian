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

console.log('\n— 视图源码断言（分层渲染） —')
const { readFileSync: readFileSyncChain } = await import('node:fs')
const chainViewSrc = readFileSyncChain(join(ROOT, 'src/renderer/views/chain.js'), 'utf8')
ok('视图定义默认层名（展示分组）', chainViewSrc.includes("DEFAULT_LAYER_NAMES = ['第一层', '第二层', '第三层']"))
ok('视图渲染 chain-layers', chainViewSrc.includes('chain-layers'))
ok('视图无因果连接徽标', !chainViewSrc.includes('chain-link-badge') && !chainViewSrc.includes('拆解为'))
ok('层数可增（+ 加一层）', chainViewSrc.includes('chain-layer-add'))
ok('层名可重命名', chainViewSrc.includes('chainSetLayers'))
ok('节点卡保留 data-seg-id（墓碑查看跳转）', chainViewSrc.includes("class: 'cnode', 'data-seg-id'"))
ok('已关闭段收到底部 strip', chainViewSrc.includes('chain-closed'))
ok('抽屉可切换层级', chainViewSrc.includes('chain-role-select'))
const vaultViewSrc = readFileSyncChain(join(ROOT, 'src/renderer/views/vault.js'), 'utf8')
ok('墓碑复活不再抬 confidence（公理1）', !vaultViewSrc.includes('Math.max(25, n.confidence)'))
ok('墓碑关闭日期优先用 closedAt', vaultViewSrc.includes('seg.closedAt || seg.updatedAt'))
ok('链轨线只走 CSS（纯结构，不表方向）', chainViewSrc.includes('chain-rail'))
ok('连线只画真实关系（drawChainEdges + computeChainEdges）',
  chainViewSrc.includes('drawChainEdges') && chainViewSrc.includes('computeChainEdges'))
ok('链轨居中', readFileSyncChain(join(ROOT, 'src/renderer/styles.css'), 'utf8').includes('.chain-rail') &&
  readFileSyncChain(join(ROOT, 'src/renderer/styles.css'), 'utf8').includes('left: 50%'))
ok('连线统一样式：起点圆点 + 终点箭头',
  chainViewSrc.includes('chain-edge-dot') && chainViewSrc.includes("marker-end', 'url(#chainArrow)"))
ok('连线 SVG 在卡片下层（不穿过卡片）', chainViewSrc.includes('layers.append(edgeSvg, stack)'))
ok('连线脚注拆分节点与关系状态',
  chainViewSrc.includes('节点标签只表示该段事实的确认状态；连线表示的段间关系仍待检验，不表示因果已成立。'))
ok('节点状态标签只谈事实', chainViewSrc.includes("label: '事实已确认'") && chainViewSrc.includes("label: '事实待验证'"))
ok('层是分组的提示可见', chainViewSrc.includes('层只是分组，点击层名可重命名'))
ok('详情抽屉对齐 demo：节点详情标题 + kicker 行',
  chainViewSrc.includes("class: 'chain-drawer-title' }, '节点详情'") && chainViewSrc.includes('chain-drawer-kicker'))
ok('详情抽屉：关联节点 chips 可点击跳转',
  chainViewSrc.includes('关联节点') && chainViewSrc.includes('chain-rel-chip') && chainViewSrc.includes('点击跳转'))
ok('详情抽屉：支撑线索可收起',
  chainViewSrc.includes('支撑线索') && chainViewSrc.includes('chain-sect-toggle'))
ok('详情抽屉不用 demo 的固定因果角色',
  !chainViewSrc.includes('核心命题') && !chainViewSrc.includes('驱动因素') && !chainViewSrc.includes('观察信号'))

console.log('\n— computeChainEdges 纯函数 —')
const { computeChainEdges } = await import('../src/renderer/lib/chain-edges.js')
const eSegs = [
  { id: 'a', name: '推理负载上移', mergedFrom: [], affects: ['单柜连接更密'] },
  { id: 'b', name: '单柜连接更密', mergedFrom: ['推理负载上移'], affects: [] },
  { id: 'c', name: '规格迭代节奏', mergedFrom: [], affects: ['不存在的段'] },
]
const edges = computeChainEdges(eSegs)
ok('同对段多关系只画一条线（曲线重叠）', edges.filter((e) => e.from === 'a' && e.to === 'b').length === 1)
ok('解析不到的段名不画线', !edges.some((e) => e.to === 'c' || e.from === 'c'))
const mEdges = computeChainEdges([
  { id: 'm1', name: '旧段', mergedFrom: [], affects: [] },
  { id: 'm2', name: '新段', mergedFrom: ['旧段'], affects: [] },
])
ok('mergedFrom 解析为边',
  mEdges.length === 1 && mEdges[0].from === 'm1' && mEdges[0].to === 'm2' && mEdges[0].kind === 'merged')
const aEdges = computeChainEdges([
  { id: 'a1', name: '上游', mergedFrom: [], affects: ['下游'] },
  { id: 'a2', name: '下游', mergedFrom: [], affects: [] },
])
ok('affects 解析为边',
  aEdges.length === 1 && aEdges[0].from === 'a1' && aEdges[0].to === 'a2' && aEdges[0].kind === 'affects')
ok('自环不画线', !computeChainEdges([{ id: 'x', name: '自指', mergedFrom: ['自指'], affects: [] }]).length)
ok('空输入返回空数组', Array.isArray(computeChainEdges(null)) && computeChainEdges(null).length === 0)
ok('重名段取第一个', (() => {
  const es = computeChainEdges([
    { id: 'p1', name: '重名', mergedFrom: [], affects: [] },
    { id: 'p2', name: '重名', mergedFrom: [], affects: [] },
    { id: 'q', name: '下游', mergedFrom: ['重名'], affects: [] },
  ])
  return es.length === 1 && es[0].from === 'p1' && es[0].to === 'q'
})())


console.log('\n— 视图源码断言（卡片精简 + 方向连线） —')
ok('卡片只留结论＋关键证据＋状态（cnode-key）', chainViewSrc.includes("class: 'cnode-key'"))
ok('卡片不再显示依据数量', !chainViewSrc.includes("class: 'cnode-ev'"))
ok('卡片不再显示分支数/详情箭头', !chainViewSrc.includes("class: 'cnode-foot'"))
ok('卡片不再直接渲染核心信息（收进抽屉）', !chainViewSrc.includes("class: 'cnode-core'"))
ok('关键证据取首条引用标题', chainViewSrc.includes('keyEvidenceTitle'))
ok('连线按关系区分样式（affects 虚线）', chainViewSrc.includes("is-affects"))

console.log(`\nchain: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
