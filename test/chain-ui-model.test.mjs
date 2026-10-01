import { performance } from 'node:perf_hooks'
import {
  LEDGER_PAGE_SIZE, FLOATING_PAGE_SIZE, GRAPH_FRAME_NODE_LIMIT, GRAPH_FRAME_EDGE_LIMIT,
  paginate, countFloating, floatingStatusKey, selectGraphWindow, affectedNodeIdForEvent,
  requestChainEventJump, consumeChainEventJump, verifiedLedgerPrefix, eventsThroughSequence,
} from '../src/renderer/lib/chain-ui-model.js'

let pass = 0
let fail = 0
function ok(name, condition, extra = '') {
  condition ? pass++ : fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${extra ? `  ${extra}` : ''}`)
}

const floating = Array.from({ length: 537 }, (_, i) => ({
  id: `float-${i}`, kind: ['claim', 'inference', 'evidence'][i % 3],
  status: ['pending', 'confirmed', 'stale'][i % 3], title: `浮动节点 ${i}`,
}))
const count = countFloating(floating)
let reached = []
for (let page = 1; page <= Math.ceil(floating.length / FLOATING_PAGE_SIZE); page++) {
  reached.push(...paginate(floating, page, FLOATING_PAGE_SIZE).items.map((node) => node.id))
}
ok('537 个待归置节点可跨页全部访问且无重复', reached.length === 537 && new Set(reached).size === 537
  && reached.every((id, i) => id === `float-${i}`))
ok('待归置索引提供主题下按类型计数', count.total === 537 && count.byKind.claim === 179 && count.byKind.inference === 179 && count.byKind.evidence === 179)
ok('待归置索引提供按状态计数', count.byStatus.pending === 179 && count.byStatus.confirmed === 179 && count.byStatus.stale === 179)
const specialStates = countFloating([
  { kind: 'claim', status: 'pending', archived: true },
  { kind: 'claim', status: 'pending', correct: false },
  { kind: 'claim', status: 'pending', superseded: true },
  { kind: 'claim', status: 'pending', resolved: true },
  { kind: 'claim', status: 'pending', correct: true },
])
ok('归档、证伪、更正、结案节点具有独立可筛选状态计数', specialStates.byStatus.archived === 1
  && specialStates.byStatus.disproved === 1 && specialStates.byStatus.superseded === 1
  && specialStates.byStatus.resolved === 1 && specialStates.byStatus.confirmed === 1
  && floatingStatusKey({ archived: true, correct: false }) === 'archived')

const ledger = Array.from({ length: 1637 }, (_, i) => ({ id: `event-${i + 1}`, seq: i + 1 }))
const ledgerRows = []
for (let page = 1; page <= Math.ceil(ledger.length / LEDGER_PAGE_SIZE); page++) {
  ledgerRows.push(...paginate(ledger, page, LEDGER_PAGE_SIZE).items)
}
ok('窗口化 chronological ledger 的每条事件均可依序访问', ledgerRows.length === ledger.length
  && ledgerRows.every((event, i) => event.seq === i + 1))

const nodes = Array.from({ length: 537 }, (_, i) => ({
  id: `n-${i}`, kind: i % 4 === 0 ? 'evidence' : 'claim', title: `节点 ${i}`, createdSeq: i + 1,
}))
const edges = Array.from({ length: 2400 }, (_, i) => ({
  id: `r-${i}`, from: `n-${i % nodes.length}`, to: `n-${(i + 1) % nodes.length}`,
  rel: i % 3 === 0 ? 'derives' : 'supports', seq: i + 1,
}))
const started = performance.now()
const frame = selectGraphWindow({ nodes, allNodes: nodes, edges }, {
  maxNodes: GRAPH_FRAME_NODE_LIMIT - 1, maxEdges: GRAPH_FRAME_EDGE_LIMIT - 24,
})
const focusFrame = selectGraphWindow({ nodes, allNodes: nodes, edges }, {
  focusNodeId: 'n-200', maxNodes: GRAPH_FRAME_NODE_LIMIT - 1, maxEdges: GRAPH_FRAME_EDGE_LIMIT - 24,
})
const elapsed = performance.now() - started
ok('含主题根节点/提示线后的单帧 SVG 不超过 60 节点/72 线', frame.nodes.length + 1 <= GRAPH_FRAME_NODE_LIMIT
  && focusFrame.nodes.length + 1 <= GRAPH_FRAME_NODE_LIMIT
  && frame.edges.length + 24 <= GRAPH_FRAME_EDGE_LIMIT
  && focusFrame.edges.length + 24 <= GRAPH_FRAME_EDGE_LIMIT)
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

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
