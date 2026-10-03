import { networkNodeType } from './theme-network.js'

function projectedNodes(projection = {}) {
  return Array.isArray(projection.allNodes) && projection.allNodes.length
    ? projection.allNodes
    : Array.isArray(projection.nodes) ? projection.nodes : []
}

/** Evidence visible for a target comes from navigable evidence nodes and directed review relations. */
export function evidenceForNode(viewState, nodeId) {
  const projection = viewState?.projection || {}
  const edges = (projection.allEdges || projection.edges || []).filter((edge) => edge && edge.reviewDecision !== 'rejected')
  const byId = new Map(projectedNodes(projection).map((node) => [node.id, node]))
  const linked = new Map()
  const addEvidence = (id, edge = null) => {
    const source = byId.get(id)
    if (!source || networkNodeType(source) !== 'evidence') return
    const row = linked.get(id) || { source, relations: [] }
    if (edge) row.relations.push(edge)
    linked.set(id, row)
  }
  const target = byId.get(nodeId)
  for (const id of target?.evidenceNodeIds || []) addEvidence(id)
  for (const source of byId.values()) {
    if (networkNodeType(source) === 'evidence' && (source.targetNodeIds || []).includes(nodeId)) addEvidence(source.id)
  }
  for (const edge of edges) {
    if (edge.to !== nodeId) continue
    if (!['supports', 'contradicts'].includes(edge.rel)) continue
    addEvidence(edge.from, edge)
  }
  const supports = []
  const against = []
  const both = []
  const unclassified = []
  const rejected = []
  for (const row of linked.values()) {
    const directions = new Set(row.relations.map((edge) => edge.rel))
    const result = { source: row.source, edge: row.relations[0] || null, relations: row.relations }
    if (row.source.reviewDecision === 'rejected') rejected.push(result)
    else if (directions.has('supports') && directions.has('contradicts')) both.push(result)
    else if (directions.has('supports')) supports.push(result)
    else if (directions.has('contradicts')) against.push(result)
    else unclassified.push(result)
  }
  return { supports, against, both, unclassified, rejected, total: linked.size }
}

function propositionRecency(node, seqByEventId) {
  let max = Number(node?.createdSeq) || 0
  for (const id of node?.eventIds || []) {
    const seq = seqByEventId.get(id)
    if (Number.isSafeInteger(seq) && seq > max) max = seq
  }
  return max
}

/** Group viewpoints by explicit lifecycle/review state; recency is ordering only, never a trust score. */
export function viewpointGroups(viewState) {
  const projection = viewState?.projection || {}
  const nodes = projectedNodes(projection)
  const edges = projection?.allEdges || projection?.edges || []
  const seqByEventId = new Map((viewState?.events || []).map((event) => [event.id, event.seq]))
  const viewpoints = nodes.filter((node) => networkNodeType(node) === 'viewpoint')
  const contradictCount = new Map()
  const pendingReviewCount = new Map()
  for (const edge of edges) {
    if (edge?.reviewDecision === 'rejected') continue
    if (edge.rel === 'contradicts') contradictCount.set(edge.to, (contradictCount.get(edge.to) || 0) + 1)
    if (edge.pendingReview && edge.reviewDecision == null) pendingReviewCount.set(edge.to, (pendingReviewCount.get(edge.to) || 0) + 1)
  }
  const byRecency = (a, b) => propositionRecency(b, seqByEventId) - propositionRecency(a, seqByEventId)
    || String(a.id).localeCompare(String(b.id))
  const active = viewpoints.filter((node) => !node.archived)
  const pending = active.filter((node) => (node.status || 'pending') === 'pending' || (pendingReviewCount.get(node.id) || 0) > 0)
  const disputed = active.filter((node) => !pending.includes(node) && ((contradictCount.get(node.id) || 0) > 0 || node.status === 'disputed'))
  const established = active.filter((node) => !pending.includes(node) && !disputed.includes(node))
  const archived = viewpoints.filter((node) => node.archived)
  for (const group of [pending, disputed, established, archived]) group.sort(byRecency)
  return { pending, disputed, established, archived }
}
