import { evidenceForNode, viewpointGroups } from '../src/renderer/lib/chain-workbench-model.js'
import { buildWorkbenchEntries, filterWorkbenchEntries } from '../src/renderer/components/builder-workbench.js'

let passed = 0
let failed = 0
function check(name, condition) {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}`)
}

const nodes = [
  { id: 'view-supported', nodeType: 'viewpoint', title: '有支持和挑战', status: 'verified', createdSeq: 1, evidenceNodeIds: ['ev-untagged', 'ev-rejected'], evidenceCount: 4 },
  { id: 'view-pending', nodeType: 'viewpoint', title: '复核中', status: 'verified', createdSeq: 2 },
  { id: 'view-clean', nodeType: 'viewpoint', title: '无显式争议', status: 'verified', createdSeq: 3 },
  { id: 'view-open', nodeType: 'viewpoint', title: '开放观点', status: 'pending', createdSeq: 4 },
  { id: 'view-archived', nodeType: 'viewpoint', title: '旧观点', status: 'verified', archived: true, createdSeq: 5 },
  { id: 'ev-support', nodeType: 'evidence', title: '支持来源', createdSeq: 6 },
  { id: 'ev-against', nodeType: 'evidence', title: '反驳来源', createdSeq: 7 },
  { id: 'ev-rejected', nodeType: 'evidence', title: '已驳回来源', createdSeq: 8, reviewDecision: 'rejected', targetNodeIds: ['view-supported'] },
  { id: 'ev-untagged', nodeType: 'evidence', title: '方向未标来源', createdSeq: 9, targetNodeIds: ['view-supported'] },
]
const edges = [
  { id: 'r-support', from: 'ev-support', to: 'view-supported', rel: 'supports' },
  { id: 'r-against', from: 'ev-against', to: 'view-supported', rel: 'contradicts' },
  { id: 'r-rejected', from: 'ev-rejected', to: 'view-supported', rel: 'contradicts', reviewDecision: 'rejected' },
  { id: 'r-pending', from: 'ev-support', to: 'view-pending', rel: 'supports', pendingReview: true },
]
const state = { projection: { nodes, allNodes: nodes, edges, allEdges: edges }, events: [{ id: 'ev1', seq: 10 }] }
const evidence = evidenceForNode(state, 'view-supported')
check('观点证据按独立有向支持/反驳关系归集', evidence.supports.map((row) => row.source.id).join() === 'ev-support'
  && evidence.against.map((row) => row.source.id).join() === 'ev-against')
check('已驳回证据单列且仍能导航；已驳回关系不冒充有效反驳', evidence.rejected.map((row) => row.source.id).join() === 'ev-rejected'
  && !evidence.against.some((row) => row.source.id === 'ev-rejected'))
check('显式目标证据即使没有语义边也可导航且不伪称支持/反驳', evidence.unclassified.map((row) => row.source.id).join() === 'ev-untagged')
check('支持/反驳/未标方向/已驳回计数与唯一可导航证据总数相符', evidence.total === nodes.find((node) => node.id === 'view-supported').evidenceCount
  && evidence.total === evidence.supports.length + evidence.against.length + evidence.both.length + evidence.unclassified.length + evidence.rejected.length)
const groups = viewpointGroups(state)
check('待复核关系将命题放回待处理组，不伪装为已建立', groups.pending.some((node) => node.id === 'view-pending')
  && !groups.established.some((node) => node.id === 'view-pending'))
check('显式反驳会聚焦争议，纯状态不能取代关系记录', groups.disputed.some((node) => node.id === 'view-supported')
  && groups.established.some((node) => node.id === 'view-clean'))
check('归档观点与活动队列分开保留', groups.archived.length === 1 && groups.archived[0].id === 'view-archived'
  && !groups.pending.includes(groups.archived[0]))

const source = { id: 'source-1', title: '用户接入来源', text: '合成原文' }
const proposal = { id: 'source-2', enginePipeline: { results: [{ proposalEventId: 'proposal-2', recommendation: { rel: 'supports' } }] } }
const oldPending = { id: 'ledger-event-1', text: '历史未决信号', source: 'legacy source' }
const processedSignal = { id: 'ledger-event-2', text: '已有决定的历史信号' }
const processedRelation = { id: 'ledger-relation-3', text: '已有关系决定的历史信号' }
const queue = buildWorkbenchEntries([source, proposal], [oldPending, processedSignal, processedRelation],
  new Map([['proposal-2', { decision: 'accepted' }], ['ledger-event-2', { decision: 'rejected' }], ['ledger-relation-3', { decision: 'confirmed' }]]),
  new Map())
const pendingQueue = filterWorkbenchEntries(queue, 'pending')
const processedQueue = filterWorkbenchEntries(queue, 'processed')
check('Builder 主队列保留外部来源作为真实输入而非主题事实', pendingQueue.some((entry) => entry.kind === 'source' && entry.item.id === 'source-1'))
check('配置引擎的抽取/映射建议成为可审核候选而不是事实', queue.some((entry) => entry.kind === 'proposal' && entry.result.proposalEventId === 'proposal-2'))
check('未决旧账本信号回流到待处理主队列', pendingQueue.some((entry) => entry.kind === 'legacy-signal' && entry.signal.id === 'ledger-event-1'))
check('已有 signal.reviewed 决定只进入已处理筛选，不再重开旧事件', processedQueue.some((entry) => entry.signal?.id === 'ledger-event-2')
  && !pendingQueue.some((entry) => entry.signal?.id === 'ledger-event-2'))
check('旧 relation.reviewed 决定也归入已处理队列', processedQueue.some((entry) => entry.signal?.id === 'ledger-relation-3')
  && !pendingQueue.some((entry) => entry.signal?.id === 'ledger-relation-3'))

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
