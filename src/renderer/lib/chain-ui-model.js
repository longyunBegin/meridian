export const LEDGER_PAGE_SIZE = 40
export const FLOATING_PAGE_SIZE = 40
export const GRAPH_FRAME_NODE_LIMIT = 60
export const GRAPH_FRAME_EDGE_LIMIT = 72

let pendingEventJump = null

export function verifiedLedgerPrefix(events = [], integrity) {
  const rows = Array.isArray(events) ? events : []
  const length = integrity?.ok === true
    ? rows.length
    : Number.isSafeInteger(integrity?.lastValidSeq)
      ? Math.max(0, Math.min(rows.length, integrity.lastValidSeq)) : 0
  return rows.slice(0, length)
}

export function eventsThroughSequence(events = [], integrity, selectedSeq = null) {
  const verified = verifiedLedgerPrefix(events, integrity)
  if (selectedSeq == null) return verified
  const end = Math.max(0, Math.min(verified.length, Math.floor(Number(selectedSeq) || 0)))
  return verified.slice(0, end)
}

export function requestChainEventJump(themeId, eventId) {
  pendingEventJump = { themeId, eventId }
}

export function consumeChainEventJump(themeId) {
  if (pendingEventJump?.themeId !== themeId) return null
  const request = pendingEventJump
  pendingEventJump = null
  return request
}

export function affectedNodeIdForEvent(event, projection, allEvents = []) {
  const nodes = projection?.allNodes || projection?.nodes || []
  const ids = new Set()
  const addEndpoint = (endpoint) => {
    if (endpoint?.eventId) ids.add(endpoint.eventId)
    if (endpoint?.ref) {
      const match = nodes.find((node) => node.sourceRef === `${endpoint.ref.type}:${endpoint.ref.id}`)
      if (match) ids.add(match.id)
    }
  }
  let source = event
  if (event?.payload?.reviewOf) source = allEvents.find((row) => row.id === event.payload.reviewOf) || event
  const payload = source?.payload || {}
  if (source?.id) ids.add(source.id)
  if (source?.supersedes) ids.add(source.supersedes)
  if (payload.reviewOf) ids.add(payload.reviewOf)
  if (source?.type === 'relation.declared') { addEndpoint(payload.from); addEndpoint(payload.to) }
  const matching = nodes.filter((node) => node.id === source?.id
    || (node.eventIds || []).includes(source?.id)
    || (node.provenanceEventIds || []).includes(source?.id)
    || (payload.sourceRef && node.sourceRef === payload.sourceRef)
    || [...ids].some((id) => node.id === id || (node.eventIds || []).includes(id)))
  return matching.find((node) => !node.external)?.id || matching[0]?.id || null
}

export function paginate(items, page = 1, pageSize = 40) {
  const rows = Array.isArray(items) ? items : []
  const size = Math.max(1, Math.floor(Number(pageSize) || 1))
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const current = Math.max(1, Math.min(pages, Math.floor(Number(page) || 1)))
  const start = (current - 1) * size
  return {
    page: current,
    pageSize: size,
    pages,
    total: rows.length,
    start,
    end: Math.min(start + size, rows.length),
    items: rows.slice(start, start + size),
  }
}

export function floatingStatusKey(node) {
  if (node?.archived) return 'archived'
  if (node?.correct === false) return 'disproved'
  if (node?.superseded) return 'superseded'
  if (node?.resolved === true) return 'resolved'
  if (node?.correct === true) return 'confirmed'
  return String(node?.status || 'pending')
}

export function countFloating(nodes = []) {
  const byKind = Object.create(null)
  const byStatus = Object.create(null)
  for (const node of nodes) {
    const kind = String(node?.kind || 'unknown')
    const status = floatingStatusKey(node)
    byKind[kind] = (byKind[kind] || 0) + 1
    byStatus[status] = (byStatus[status] || 0) + 1
  }
  return { total: nodes.length, byKind, byStatus }
}

/**
 * Return a deterministic, bounded graph frame. With a focus node, breadth-first
 * traversal keeps the directly affected neighborhood visible; otherwise the
 * newest non-archived graph nodes take priority. The full projection is untouched.
 */
export function selectGraphWindow(projection, {
  focusNodeId = null,
  maxNodes = GRAPH_FRAME_NODE_LIMIT,
  maxEdges = GRAPH_FRAME_EDGE_LIMIT,
} = {}) {
  const graphNodes = Array.isArray(projection?.nodes) ? projection.nodes : []
  const allNodes = Array.isArray(projection?.allNodes) ? projection.allNodes : graphNodes
  const edges = Array.isArray(projection?.edges) ? projection.edges : []
  const byId = new Map(allNodes.map((node) => [node.id, node]))
  const candidates = [...graphNodes]
  const focused = focusNodeId ? byId.get(focusNodeId) : null
  if (focused && !candidates.some((node) => node.id === focused.id)) candidates.push(focused)

  const nodeLimit = Math.max(1, Math.floor(maxNodes))
  const edgeLimit = Math.max(0, Math.floor(maxEdges))
  const selected = new Set()
  if (focusNodeId && byId.has(focusNodeId)) {
    const adjacency = new Map(candidates.map((node) => [node.id, []]))
    for (const edge of edges) {
      if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue
      adjacency.get(edge.from).push({ edge, neighbor: edge.to })
      adjacency.get(edge.to).push({ edge, neighbor: edge.from })
    }
    for (const rows of adjacency.values()) rows.sort((a, b) =>
      (Number(b.edge.seq) || 0) - (Number(a.edge.seq) || 0)
      || String(a.neighbor).localeCompare(String(b.neighbor)))
    const queue = [focusNodeId]
    selected.add(focusNodeId)
    for (let cursor = 0; cursor < queue.length && selected.size < nodeLimit; cursor++) {
      for (const { neighbor } of adjacency.get(queue[cursor]) || []) {
        if (selected.has(neighbor)) continue
        selected.add(neighbor)
        queue.push(neighbor)
        if (selected.size >= nodeLimit) break
      }
    }
  } else {
    const recent = [...candidates].sort((a, b) => {
      const liveBias = Number(Boolean(a.archived)) - Number(Boolean(b.archived))
      return liveBias || (Number(b.createdSeq) || 0) - (Number(a.createdSeq) || 0)
        || String(a.id).localeCompare(String(b.id))
    })
    for (const node of recent.slice(0, nodeLimit)) selected.add(node.id)
  }

  const nodeRows = candidates.filter((node) => selected.has(node.id))
  const edgeRows = edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .sort((a, b) => {
      const aDirect = focusNodeId && (a.from === focusNodeId || a.to === focusNodeId) ? 1 : 0
      const bDirect = focusNodeId && (b.from === focusNodeId || b.to === focusNodeId) ? 1 : 0
      return bDirect - aDirect || (Number(b.seq) || 0) - (Number(a.seq) || 0)
        || String(a.id).localeCompare(String(b.id))
    })
  const visibleEdges = edgeRows.slice(0, edgeLimit)
  return {
    nodes: nodeRows,
    edges: visibleEdges,
    totalNodes: graphNodes.length,
    totalEdges: edges.length,
    truncated: nodeRows.length < graphNodes.length || visibleEdges.length < edges.length,
    focusNodeId: focusNodeId && selected.has(focusNodeId) ? focusNodeId : null,
  }
}
