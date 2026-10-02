import { performance } from 'node:perf_hooks'
import {
  LEDGER_PAGE_SIZE, GRAPH_FRAME_NODE_LIMIT, GRAPH_FRAME_EDGE_LIMIT,
  paginate, selectGraphWindow, affectedNodeIdForEvent,
  requestChainEventJump, consumeChainEventJump, verifiedLedgerPrefix, eventsThroughSequence,
  compactEventSummary, searchGraphNodes,
} from '../src/renderer/lib/chain-ui-model.js'

let pass = 0
let fail = 0
function ok(name, condition, extra = '') {
  condition ? pass++ : fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${extra ? `  ${extra}` : ''}`)
}

const ledger = Array.from({ length: 1637 }, (_, i) => ({ id: `event-${i + 1}`, seq: i + 1 }))
const ledgerRows = []
for (let page = 1; page <= Math.ceil(ledger.length / LEDGER_PAGE_SIZE); page++) {
  ledgerRows.push(...paginate(ledger, page, LEDGER_PAGE_SIZE).items)
}
ok('窗口化 chronological ledger 的每条事件均可依序访问', ledgerRows.length === ledger.length
  && ledgerRows.every((event, i) => event.seq === i + 1))

const nodes = Array.from({ length: 537 }, (_, i) => ({
  id: `n-${i}`, nodeType: ['concept', 'object', 'event', 'viewpoint', 'evidence'][i % 5], title: `节点 ${i}`, createdSeq: i + 1,
}))
const edges = Array.from({ length: 2400 }, (_, i) => ({
  id: `r-${i}`, from: `n-${i % nodes.length}`, to: `n-${(i + 1) % nodes.length}`,
  rel: ['supports', 'derives', 'contradicts', 'belongs-to', 'influences', 'depends-on', 'temporal', 'related'][i % 8], seq: i + 1,
}))
const started = performance.now()
const frame = selectGraphWindow({ nodes, allNodes: nodes, edges }, {
  maxNodes: GRAPH_FRAME_NODE_LIMIT, maxEdges: GRAPH_FRAME_EDGE_LIMIT,
})
const focusFrame = selectGraphWindow({ nodes, allNodes: nodes, edges }, {
  focusNodeId: 'n-200', maxNodes: GRAPH_FRAME_NODE_LIMIT, maxEdges: GRAPH_FRAME_EDGE_LIMIT,
})
const elapsed = performance.now() - started
ok('无主题根/提示线的单帧主题网络不超过 60 节点/72 关系', frame.nodes.length <= GRAPH_FRAME_NODE_LIMIT
  && focusFrame.nodes.length <= GRAPH_FRAME_NODE_LIMIT
  && frame.edges.length <= GRAPH_FRAME_EDGE_LIMIT
  && focusFrame.edges.length <= GRAPH_FRAME_EDGE_LIMIT)
ok('搜索/事件聚焦节点保留在有界子图中', focusFrame.focusNodeId === 'n-200' && focusFrame.nodes.some((node) => node.id === 'n-200'))
ok('537 节点与 2400 边两次选择在保护预算内完成', elapsed < 2000, `${Math.round(elapsed)} ms`)

const provenanceProjection = {
  allNodes: [
    { id: 'claim-1', eventIds: ['claim-event', 'correction-1'], provenanceEventIds: ['claim-event'], sourceRef: 'segment:s-1' },
    { id: 'evidence-1', eventIds: ['evidence-event'], provenanceEventIds: ['evidence-event'], sourceRef: 'manual:e-1' },
  ],
}
ok('更正事件联动到其 lineage 节点', affectedNodeIdForEvent({ id: 'correction-1', type: 'correction.appended', supersedes: 'claim-event' }, provenanceProjection) === 'claim-1')
const relation = { id: 'relation-1', type: 'relation.declared', payload: { rel: 'supports', from: { eventId: 'evidence-event' }, to: { eventId: 'claim-event' } } }
ok('关系声明聚焦其直接影响节点', ['claim-1', 'evidence-1'].includes(affectedNodeIdForEvent(relation, provenanceProjection)))
const decision = { id: 'decision-1', type: 'relation.declared', payload: { reviewOf: 'relation-1', reviewDecision: 'confirmed' } }
ok('追加复核决定联动回原关系端点', ['claim-1', 'evidence-1'].includes(affectedNodeIdForEvent(decision, provenanceProjection, [relation, decision])))

requestChainEventJump('theme-fixture', 'event-57')
ok('跨视图账本定位只消费匹配主题请求', consumeChainEventJump('other-theme') === null
  && consumeChainEventJump('theme-fixture')?.eventId === 'event-57'
  && consumeChainEventJump('theme-fixture') === null)

const damagedLedgerFixture = [
  { id: 'relation-valid', seq: 1, type: 'relation.declared', payload: { rel: 'derives' } },
  { id: 'future-invalid-review', seq: 2, type: 'relation.declared', payload: { reviewOf: 'relation-valid', reviewDecision: 'confirmed' } },
]
const verifiedPrefix = verifiedLedgerPrefix(damagedLedgerFixture, { ok: false, lastValidSeq: 1 })
ok('损坏尾部的关系复核决定不进入当前状态或历史节点时间线', verifiedPrefix.length === 1
  && verifiedPrefix[0].id === 'relation-valid')
ok('没有完整性结果时不把原始事件当成已校验前缀', verifiedLedgerPrefix(damagedLedgerFixture, null).length === 0)
const futureLookupFixture = [
  { id: 'v1', seq: 1, type: 'claim.created', payload: { title: '历史观点' } },
  { id: 'v2', seq: 2, type: 'claim.created', payload: { title: '未来观点' } },
]
const historyLookupRows = eventsThroughSequence(futureLookupFixture, { ok: true }, 1)
ok('历史账本名称解析集合不含所选序号之后的未来事件', historyLookupRows.length === 1 && historyLookupRows[0].id === 'v1')

const event681 = compactEventSummary({
  id: 'event-681', seq: 681, type: 'evidence.appended',
  payload: { sourceKind: 'primary-data', text: '年报披露的实际订单数量' },
})
ok('第 681 条事件可折叠为有信息的一行摘要', event681 === '第 681 条 · 新增证据 · 一手数据', event681)
const ledger681 = Array.from({ length: 681 }, (_, i) => ({ id: `event-${i + 1}`, seq: i + 1 }))
const visited681 = []
for (let page = 1; page <= Math.ceil(ledger681.length / LEDGER_PAGE_SIZE); page++) {
  visited681.push(...paginate(ledger681, page, LEDGER_PAGE_SIZE).items.map((row) => row.id))
}
ok('681 条事件仍可分页逐条访问且没有被折叠/分页移除', visited681.length === 681
  && new Set(visited681).size === 681 && visited681.at(-1) === 'event-681')

const searchNodes = [
  { id: 's1', kind: 'claim', title: '需求增长', currentText: '年报预计订单上升' },
  { id: 's2', kind: 'evidence', title: '独立媒体报道', currentText: '港口装运数据' },
  { id: 's3', nodeType: 'concept', title: '现名', originalTitle: '旧名', nameHistory: [{ previousTitle: '旧名' }] },
]
ok('图谱搜索支持正文筛选并可用空查询清空', searchGraphNodes(searchNodes, '年报').length === 1
  && searchGraphNodes(searchNodes, '年报')[0].id === 's1' && searchGraphNodes(searchNodes, '').length === 0)
ok('改名后的旧名仍可从图谱搜索找到节点', searchGraphNodes(searchNodes, '旧名').some((node) => node.id === 's3'))
const family = '👩‍👩‍👧‍👦'
const longUnicodeSummary = compactEventSummary({ seq: 9, type: 'node.created', payload: { title: family.repeat(43) } })
ok('紧凑事件摘要按 grapheme 截断，不拆分复杂 emoji', longUnicodeSummary.endsWith(`${family.repeat(41)}…`))

const largeNodes = Array.from({ length: 5000 }, (_, i) => ({ id: `large-${i}`, nodeType: 'concept', title: `大型主题节点 ${i}`, createdSeq: i + 1 }))
const largeFrame = selectGraphWindow({ nodes: largeNodes, allNodes: largeNodes, edges: [] })
ok('五千节点主题可限定单帧数量并保持完整投影可搜索', largeFrame.nodes.length <= GRAPH_FRAME_NODE_LIMIT
  && largeFrame.totalNodes === 5000 && largeFrame.truncated)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
