import {
  NETWORK_NODE_TYPES, ARGUMENT_RELATIONS, REVISION_RELATIONS, ASSOCIATION_RELATIONS, NODE_TYPE_META, RELATION_META,
  networkNodeType, networkNodeStatus, truncateGraphemes, splitNetworkTitle,
  buildDensityTimeline, timelinePointForDay, timelineChangeSummary, layoutThemeNetwork,
} from '../src/renderer/lib/theme-network.js'

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? `  ${detail}` : ''}`)
}

check('节点类型白名单严格为概念、对象、事件、观点、证据', NETWORK_NODE_TYPES.join(',') === 'concept,object,event,viewpoint,evidence'
  && Object.keys(NODE_TYPE_META).sort().join(',') === [...NETWORK_NODE_TYPES].sort().join(','))
check('九类关系区分有向论证、版本修订与弱主题关联', ARGUMENT_RELATIONS.length === 3 && REVISION_RELATIONS.length === 1 && ASSOCIATION_RELATIONS.length === 5
  && ARGUMENT_RELATIONS.every((rel) => RELATION_META[rel].group === 'argument')
  && REVISION_RELATIONS.every((rel) => RELATION_META[rel].group === 'revision')
  && ASSOCIATION_RELATIONS.every((rel) => RELATION_META[rel].group === 'association'))
check('旧 claim/inference 投影均兼容为观点而不是旧节点类型', networkNodeType({ kind: 'claim' }) === 'viewpoint'
  && networkNodeType({ kind: 'inference' }) === 'viewpoint'
  && networkNodeType({ kind: 'evidence' }) === 'evidence')
check('生命周期状态在标签层与归档/失效优先级保持清楚', networkNodeStatus({ archived: true, invalidated: true }) === 'archived'
  && networkNodeStatus({ invalidated: true, correct: true }) === 'invalidated'
  && networkNodeStatus({ correct: false }) === 'disputed')

const family = '👩‍👩‍👧‍👦'
const familyText = `${family.repeat(3)}abcdef`
check('通用截断按完整 grapheme 计算长度', truncateGraphemes(familyText, 5) === `${family.repeat(3)}a…`)
check('节点标题分行不会拆分复杂 emoji', splitNetworkTitle(`${family.repeat(18)}后缀`, 14, 2).join('').includes(family.repeat(14)))
check('空标题使用有意义占位文本', splitNetworkTitle('')[0] === '未命名')

const events = [
  { id: 'e1', seq: 1, type: 'node.created', at: '2026-09-01T08:00:00Z', payload: { nodeType: 'concept' } },
  { id: 'e2', seq: 2, type: 'node.created', at: '2026-09-01T12:00:00Z', payload: { nodeType: 'viewpoint' } },
  { id: 'e3', seq: 3, type: 'relation.declared', at: '2026-09-01T15:00:00Z', payload: { rel: 'derives' } },
  { id: 'e4', seq: 4, type: 'node.renamed', at: '2026-09-03T15:00:00Z', payload: { previousTitle: '旧名', newTitle: '新名' } },
  { id: 'e5', seq: 5, type: 'node.invalidated', at: '2026-09-03T17:00:00Z', payload: { reason: '变化' } },
  { id: 'e6', seq: 6, type: 'relation.declared', at: '2026-09-03T18:00:00Z', payload: { reviewOf: 'e3', reviewDecision: 'confirmed' } },
  { id: 'e7', seq: 7, type: 'settlement.recorded', at: '日期无法识别', payload: {} },
]
const timeline = buildDensityTimeline(events)
check('时间轴按有事件日期聚合密度而非每个账本事件重复打点', timeline.length === 3
  && timeline[0].date === '2026-09-01' && timeline[0].count === 3 && timeline[0].density === 2
  && timeline[1].date === '2026-09-03' && timeline[1].count === 3)
check('日期刻度按日历顺序和日期间距定位，能取最近不晚于目标日', timeline[0].position === 0
  && timeline[1].position === 100 && timelinePointForDay(timeline, Date.parse('2026-09-02T00:00:00Z') / 86400000)?.date === '2026-09-01')
check('缺日期事件进入有标记的末端桶且仍可回放', timeline.at(-1).date === '日期未记录' && timeline.at(-1).seq === 7)
const summary = timelineChangeSummary(events, 3, 6)
check('时间轴变化摘要能说明改名、失效和关系确认数量', summary.includes('改名 1')
  && summary.includes('失效 1') && summary.includes('确认 1'))
check('空时间跨度明确报告没有新增事件', timelineChangeSummary(events, 4, 4).includes('没有新增账本事件'))

const nodes = Array.from({ length: 120 }, (_, index) => ({
  id: `n-${String(index).padStart(3, '0')}`,
  nodeType: NETWORK_NODE_TYPES[index % NETWORK_NODE_TYPES.length],
  title: `合成节点 ${index}`,
  createdSeq: index + 1,
}))
const edges = Array.from({ length: 185 }, (_, index) => ({
  id: `r-${index}`,
  from: nodes[index % nodes.length].id,
  to: nodes[(index * 17 + 5) % nodes.length].id,
  rel: [...ARGUMENT_RELATIONS, ...REVISION_RELATIONS, ...ASSOCIATION_RELATIONS][index % 9],
  pendingReview: index % 11 === 0,
}))
const first = layoutThemeNetwork(nodes, edges, 1120)
const second = layoutThemeNetwork([...nodes].reverse(), [...edges].reverse(), 1120)
let stable = true
let valid = true
let overlaps = 0
for (const node of nodes) {
  const a = first.pos.get(node.id)
  const b = second.pos.get(node.id)
  const size = first.size.get(node.id)
  if (!a || !b || a.x !== b.x || a.y !== b.y) stable = false
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < size.w / 2 || a.x > first.width - size.w / 2
    || a.y < size.h / 2 || a.y > first.height - size.h / 2) valid = false
}
for (let i = 0; i < nodes.length; i++) {
  const a = nodes[i]
  const pa = first.pos.get(a.id)
  const sa = first.size.get(a.id)
  for (let j = i + 1; j < nodes.length; j++) {
    const b = nodes[j]
    const pb = first.pos.get(b.id)
    const sb = first.size.get(b.id)
    if (Math.abs(pa.x - pb.x) < (sa.w + sb.w) / 2 && Math.abs(pa.y - pb.y) < (sa.h + sb.h) / 2) overlaps++
  }
}
check('120 节点、多类型与 185 种混合关系的力导布局可用', valid, `H=${first.height}`)
check('固定同一完整网络布局与输入顺序无关，可用于全部历史帧', stable)
check('密集合成网络碰撞控制在小范围而非糊团', overlaps <= 8, `矩形重叠 ${overlaps}`)

const started = performance.now()
const largeNodes = Array.from({ length: 500 }, (_, index) => ({ id: `large-${index}`, nodeType: 'concept' }))
const largeLayout = layoutThemeNetwork(largeNodes, [], 1120)
const elapsed = performance.now() - started
check('500 节点无关系合成主题布局在合理时间完成', largeLayout.pos.size === 500 && elapsed < 5000, `${Math.round(elapsed)} ms`)

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
