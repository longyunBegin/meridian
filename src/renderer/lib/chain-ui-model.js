import { truncateGraphemes } from './theme-network.js'

export const LEDGER_PAGE_SIZE = 40
export const GRAPH_FRAME_NODE_LIMIT = 60
export const GRAPH_FRAME_EDGE_LIMIT = 72

let pendingEventJump = null

/* 用户要求删除账本校验的 UI。第一步：界面**不再按校验结果截断事件**，一律显示全部事件。
   函数名与签名保持不变，所有调用点无需改动（integrity 参数被忽略）。
   注意：这一步只动显示；verifyChain 守卫仍在（第二步再处理）。 */
export function verifiedLedgerPrefix(events = []) {
  return Array.isArray(events) ? events : []
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

/* 读者视图 → 建设者视图的跳转请求：目标子页签 + 聚焦节点。 */
let pendingBuilderJump = null

export function requestBuilderPane(themeId, pane) {
  if (!['network', 'propositions', 'attribution'].includes(pane)) return
  pendingBuilderJump = { ...(pendingBuilderJump || {}), themeId, pane }
}

export function requestBuilderNodeFocus(themeId, nodeId) {
  if (!nodeId) return
  pendingBuilderJump = { ...(pendingBuilderJump || {}), themeId, nodeId }
}

export function consumeBuilderJump(themeId) {
  if (pendingBuilderJump?.themeId !== themeId) return null
  const request = pendingBuilderJump
  pendingBuilderJump = null
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

/* P0-4：14 类事件各一句人话模板。用户不该在账本列表里看到 `claim.created` 这种机器名。 */
const EVENT_KIND_SUMMARY = {
  'claim.created': '新增观点',
  'inference.created': '新增推断',
  'node.created': '新增节点',
  'node.renamed': '改名',
  'node.invalidated': '失效',
  'node.archived': '归档',
  'node.restored': '恢复',
  'evidence.appended': '追加证据',
  'relation.declared': '声明关系',
  'correction.appended': '修正',
  'confidence.updated': '强度变化',
  'signal.reviewed': '确认记录',
  'engine.recommendation.proposed': '模型建议',
  'settlement.recorded': '结算',
  'topic.linked': '主题关联',
}
export const RELATION_LABEL = {
  supports: '支持', contradicts: '挑战', derives: '推导', supersedes: '修订', related: '相关',
  influences: '影响', depends_on: '依赖', part_of: '归属', precedes: '时间先于',
}
const SOURCE_KIND_SUMMARY = {
  'primary-data': '一手数据', primary: '一手数据', '一手数据': '一手数据',
  'independent-media': '独立媒体', independent_media: '独立媒体', '独立媒体': '独立媒体',
  'broker-report': '券商研报', '券商研报': '券商研报',
}

function shortSummary(value, limit = 42) {
  return truncateGraphemes(value || '', limit)
}

/** A single-line event disclosure label with a useful discriminator, not duplicated boilerplate. */
export function compactEventSummary(event) {
  const row = event && typeof event === 'object' ? event : {}
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  const kind = EVENT_KIND_SUMMARY[row.type] || row.type || '未识别事件'
  const sourceKind = SOURCE_KIND_SUMMARY[payload.sourceKind]
    || SOURCE_KIND_SUMMARY[payload.legacySource?.kind]
    || (payload.legacySource?.kind === '独立媒体' ? '独立媒体' : '')
  const source = String(payload.sourceLabel || payload.legacySource?.label || '').trim()
  const reference = Array.isArray(payload.evidenceRefs)
    ? payload.evidenceRefs.find((ref) => ref?.title)?.title : ''
  let detail = ''
  if (row.type === 'evidence.appended') {
    /* "追加证据：…（来源 Y）" —— 来源名与正文都给，读的人才知道这条数据是什么、从哪来。 */
    const body = payload.text || payload.reason || reference || payload.title || ''
    detail = [body, source ? `（${source}）` : sourceKind ? `（${sourceKind}）` : ''].join('')
  } else if (row.type === 'correction.appended') {
    const oldValue = String(payload.oldValue || '').trim()
    const newValue = String(payload.newValue || payload.reason || '').trim()
    detail = oldValue && newValue ? `${oldValue} → ${newValue}` : newValue || '观点版本更正'
  } else if (row.type === 'confidence.updated') {
    const before = Number(payload.oldConfidence ?? payload.before)
    const after = Number(payload.newConfidence ?? payload.after)
    detail = Number.isFinite(before) && Number.isFinite(after) ? `${Math.round(before)}% → ${Math.round(after)}%`
      : Number.isFinite(after) ? `→ ${Math.round(after)}%` : '强度更新'
  } else if (row.type === 'signal.reviewed') {
    const decision = String(payload.decision || '').trim()
    detail = decision === 'rejected' ? '驳回' : decision === 'accepted' ? '确认' : decision || '已处理'
  } else if (row.type === 'relation.declared') {
    const rel = RELATION_LABEL[payload.rel] || payload.rel || '关系待识别'
    detail = payload.reviewOf ? `关系${payload.reviewDecision === 'confirmed' ? '确认' : '驳回'}`
      : [rel, String(payload.reason || '').trim()].filter(Boolean).join(' · ')
  } else if (row.type === 'engine.recommendation.proposed') {
    const statement = payload.statement || {}
    detail = [payload.recommendation?.title, statement.subject, statement.attribute, statement.value].filter(Boolean).join(' ') || '待审阅建议'
  } else if (row.type === 'node.renamed') {
    detail = [payload.previousTitle || payload.oldTitle, payload.title || payload.newTitle].filter(Boolean).join(' → ')
  } else {
    detail = payload.title || payload.coreInfo || payload.text || payload.reason || source || sourceKind
  }
  const ordinal = Number.isSafeInteger(row.seq) ? `第 ${row.seq} 条` : '事件记录'
  return `${ordinal} · ${kind}${detail ? `：${shortSummary(detail)}` : ''}`
}

/** Filter all projected node metadata used by the graph search; never mutates the projection. */
export function searchGraphNodes(nodes = [], query = '') {
  const needle = String(query || '').trim().toLocaleLowerCase()
  if (!needle) return []
  const rows = Array.isArray(nodes) ? nodes : []
  return rows.map((node, index) => ({ node, index, title: String(node?.title || '').toLocaleLowerCase() }))
    .filter(({ node }) => [node?.title, node?.originalTitle, ...(node?.nameHistory || []).map((entry) => entry?.previousTitle),
      node?.currentText, node?.detail, node?.sourceRef, node?.sourceKind, node?.nodeType, node?.kind]
      .some((value) => String(value || '').toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(b.title === needle) - Number(a.title === needle)
      || Number(b.title.startsWith(needle)) - Number(a.title.startsWith(needle))
      || a.index - b.index)
    .map(({ node }) => node)
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
  /* 候选节点按"活着优先、越新越前"排序；聚焦时先铺该节点的邻域，
     再用同一顺序把剩余名额填满——聚焦是"强调"，不该把其它节点从画布上删掉。 */
  const recent = [...candidates].sort((a, b) => {
    const liveBias = Number(Boolean(a.archived)) - Number(Boolean(b.archived))
    return liveBias || (Number(b.createdSeq) || 0) - (Number(a.createdSeq) || 0)
      || String(a.id).localeCompare(String(b.id))
  })
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
    for (const node of recent) {
      if (selected.size >= nodeLimit) break
      selected.add(node.id)
    }
  } else {
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
