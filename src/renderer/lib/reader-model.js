import { networkNodeStatus, networkNodeType, truncateGraphemes } from './theme-network.js'

export const DIRECTION_META = {
  improving: { label: '好转', color: 'var(--green)', icon: '↑' },
  declining: { label: '恶化', color: 'var(--red)', icon: '↓' },
  stable: { label: '稳定', color: 'var(--text-3)', icon: '→' },
  undetermined: { label: '待观察', color: 'var(--text-3)', icon: '·' },
}
export const NATURE_META = {
  quantitative: { label: '量变', icon: '·' },
  pivot: { label: '质变', icon: '⇄' },
  epistemic: { label: '认识', icon: '◉' },
  structural: { label: '结构', icon: '⑂' },
}

const ARG_RELS = new Set(['supports', 'derives'])
const CHANGE_NATURES = new Set(['quantitative', 'pivot', 'epistemic', 'structural'])
const DATE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000
const asArray = (value) => Array.isArray(value) ? value : []
const titleOf = (node) => String(node?.title || node?.currentText || '未命名').trim() || '未命名'
const eventAt = (event) => {
  const ms = new Date(event?.at || event?.timestamp || 0).getTime()
  return Number.isFinite(ms) ? ms : 0
}
const eventDate = (event) => {
  const ms = eventAt(event)
  return ms ? new Date(ms).toISOString().slice(0, 10) : '—'
}
const confidenceValue = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null
}

export const UNCATEGORIZED_LABEL = '未分类'

/**
 * 合成轴（设计提案 01）：强度（线）× 外部数据（点）× 确认/修订（台阶）画在同一条日期轴上。
 * 全部来自账本事件与投影里的 confidenceHistory，不做叙事化插值——没有强度记录就如实空着。
 */
export function buildSynthesisAxis({ events = [], node = null } = {}) {
  const rows = asArray(events).filter((event) => event && event.type && Number.isFinite(Date.parse(event.at)))
  const times = rows.map((event) => Date.parse(event.at))
  const start = times.length ? Math.min(...times) : null
  const end = times.length ? Math.max(...times) : null
  const span = start != null && end != null ? Math.max(1, end - start) : 1
  const positionOf = (value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) && start != null ? Math.min(1, Math.max(0, (time - start) / span)) : 0
  }
  const relationOfEvidence = new Map()
  const steps = []
  for (const event of rows) {
    if (event.type === 'relation.declared') {
      const from = event.payload?.from?.eventId || event.payload?.from
      const rel = event.payload?.rel
      if (from && (rel === 'supports' || rel === 'contradicts')) relationOfEvidence.set(from, rel)
      if (rel === 'supersedes') steps.push({ id: event.id, at: event.at, t: positionOf(event.at), kind: 'revision', label: '版本修订' })
    } else if (event.type === 'signal.reviewed') {
      const decision = String(event.payload?.decision || '').trim()
      steps.push({
        id: event.id, at: event.at, t: positionOf(event.at),
        kind: decision === 'rejected' ? 'rejected' : 'review',
        label: decision === 'rejected' ? '驳回建议' : '确认归因',
      })
    }
  }
  const evidence = rows.filter((event) => event.type === 'evidence.appended').map((event) => {
    const rel = relationOfEvidence.get(event.id)
    return {
      id: event.id, at: event.at, t: positionOf(event.at),
      kind: rel === 'supports' ? 'supports' : rel === 'contradicts' ? 'contradicts' : 'unstated',
      label: truncateGraphemes(String(event.payload?.text || event.payload?.reason || '外部数据'), 48),
    }
  })
  /* 强度线＝该原子的 confidence 历史（投影已解析好）；没有历史但有当前强度时画一个点，
     避免"有强度却没有线"的错觉。 */
  const series = asArray(node?.confidenceHistory)
    .map((row) => ({
      at: row.at, t: positionOf(row.at),
      value: Number(row.newConfidence ?? row.oldConfidence),
      reason: String(row.reason || ''),
    }))
    .filter((point) => Number.isFinite(point.value))
  /* 只有真的存在当前强度、且不是 null/undefined 时才补一个点：
     注意 Number(null) === 0，直接判 Number.isFinite 会凭空画出一个 0% 的假点。 */
  const currentStrength = node?.confidence ?? node?.strength
  if (!series.length && currentStrength != null && Number.isFinite(Number(currentStrength))) {
    series.push({ at: end ? new Date(end).toISOString() : null, t: 1, value: Number(currentStrength), reason: '当前强度' })
  }
  return {
    start, end, evidence, series, steps,
    counts: {
      evidence: evidence.length,
      supports: evidence.filter((point) => point.kind === 'supports').length,
      contradicts: evidence.filter((point) => point.kind === 'contradicts').length,
      unstated: evidence.filter((point) => point.kind === 'unstated').length,
      steps: steps.length,
    },
  }
}

/** 原子的主题分类（L2 主题自定义层）：分类是用户自己的词，空值统一归到"未分类"。 */
export function nodeCategory(node) {
  return String(node?.atomCategory || '').trim() || UNCATEGORIZED_LABEL
}

/** Filter only the visible graph frame; never mutate or remove ledger projection nodes. */
export function filterReaderNodes(nodes = [], type = 'all', status = 'all', category = 'all') {
  if (!Array.isArray(nodes)) return []
  return nodes.filter((node) => node && (type === 'all' || networkNodeType(node) === type)
    && (status === 'all' || networkNodeStatus(node) === status)
    && (category === 'all' || nodeCategory(node) === category))
}

function liveEdges(projection) {
  const edges = projection?.allEdges || projection?.edges || []
  return asArray(edges).filter((edge) => edge && edge.reviewDecision !== 'rejected')
}

function liveNodes(projection) {
  const nodes = projection?.allNodes || projection?.nodes || []
  return asArray(nodes).filter((node) => node && !node.archived)
}

function eventNodeId(event) {
  const payload = event?.payload || {}
  return payload.nodeId || payload.claimId || payload.targetId || null
}

function natureFromEvent(event) {
  const payload = event?.payload || {}
  const explicit = payload.change?.nature || payload.nature
  if (CHANGE_NATURES.has(explicit)) return explicit
  if (event?.type === 'confidence.updated') return 'quantitative'
  if (event?.type === 'relation.declared') return 'structural'
  if (event?.type === 'claim.created') return 'epistemic'
  return payload.rel === 'contradicts' ? 'epistemic' : 'quantitative'
}

function themeTagFromEvent(event) {
  const payload = event?.payload || {}
  return String(payload.change?.themeTag || payload.themeTag || (
    event?.type === 'confidence.updated' ? '置信度变化'
      : event?.type === 'relation.declared' ? '关系建立'
        : event?.type === 'claim.created' ? '新命题'
          : payload.rel === 'contradicts' ? '假设挑战' : '证据更新'
  ))
}

/** Keep the description grounded in recorded source text; this shortens but never invents a claim. */
function distillJudgment(rawText) {
  const text = String(rawText || '').trim()
  if (!text) return '状态待更新'
  const sentences = text.split(/[。；;\n]/).map((part) => part.trim()).filter(Boolean)
  const selected = text.length > 60
    ? (sentences.find((part) => /\d+%|\d+\.?\d*亿|增长|下降|提升|突破|创/.test(part)) || sentences[0] || text)
    : text
  return truncateGraphemes(selected, 80)
}

function normalizeNodesAndEvidence(nodes, edges, events) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const eventsById = new Map(asArray(events).map((event) => [event?.id, event]))
  const stats = new Map()
  for (const node of nodes) {
    if (networkNodeType(node) === 'viewpoint') stats.set(node.id, {
      supports: 0, contradicts: 0, latestEv: null, latestAt: 0, evidenceIds: new Set(),
    })
  }
  for (const edge of edges) {
    const stat = stats.get(edge.to)
    if (!stat) continue
    if (ARG_RELS.has(edge.rel)) stat.supports++
    else if (edge.rel === 'contradicts') stat.contradicts++
    const source = nodesById.get(edge.from)
    if (source && networkNodeType(source) === 'evidence') stat.evidenceIds.add(source.id)
  }
  for (const [nodeId, stat] of stats) {
    for (const evidenceId of stat.evidenceIds) {
      const event = eventsById.get(evidenceId)
      if (!event || event.type !== 'evidence.appended') continue
      const at = eventAt(event)
      if (at >= stat.latestAt) { stat.latestEv = event; stat.latestAt = at }
    }
  }
  /* Legacy event producers may have stored an explicit nodeId on evidence. */
  for (const event of asArray(events)) {
    if (event?.type !== 'evidence.appended') continue
    const nodeId = eventNodeId(event)
    const stat = stats.get(nodeId)
    if (!stat) continue
    const at = eventAt(event)
    if (at >= stat.latestAt) { stat.latestEv = event; stat.latestAt = at }
  }
  return { nodesById, stats }
}

/** Pure projection/events -> reader model; confidence is consistently 0–100 at this boundary. */
export function deriveReaderModel(projection = {}, events = [], { now = Date.now() } = {}) {
  const nodes = liveNodes(projection)
  const edges = liveEdges(projection)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const eventList = asArray(events)
  const model = {
    empty: nodes.length === 0,
    nodeCount: nodes.length,
    eventCount: eventList.length,
    oneLiner: null,
    drivers: [], evolutions: [], boundaries: [], disputes: [], pending: [], recent: [],
    status: nodes.length ? '建设中' : '尚未开始',
    directionCounts: { improving: 0, declining: 0, stable: 0, undetermined: 0 },
    nodesByDirection: { improving: [], declining: [], stable: [], undetermined: [] },
    turningPoints: [],
  }
  if (model.empty) return model

  const thirtyDaysAgo = now - DATE_LIMIT_MS
  const confChanges = new Map()
  for (const event of eventList) {
    if (event?.type !== 'confidence.updated') continue
    const nodeId = eventNodeId(event)
    if (!nodeId || !byId.has(nodeId)) continue
    const at = eventAt(event)
    if (!at || at < thirtyDaysAgo || at > now) continue
    const payload = event.payload || {}
    const before = confidenceValue(payload.before ?? payload.oldConfidence)
    const after = confidenceValue(payload.after ?? payload.newConfidence)
    if (before == null || after == null) continue
    if (!confChanges.has(nodeId)) confChanges.set(nodeId, { net: 0, latest: null, latestAt: 0 })
    const change = confChanges.get(nodeId)
    change.net += after - before // stored and displayed as percentage points (0–100)
    if (at >= change.latestAt) { change.latest = event; change.latestAt = at }
  }

  const { nodesById, stats } = normalizeNodesAndEvidence(nodes, edges, eventList)
  const viewpoints = nodes.filter((node) => networkNodeType(node) === 'viewpoint')
  for (const node of viewpoints) {
    const change = confChanges.get(node.id)
    const stat = stats.get(node.id) || { supports: 0, contradicts: 0, latestEv: null }
    let direction = 'undetermined'
    if (change) {
      direction = change.net > 5 ? 'improving' : change.net < -5 ? 'declining' : 'stable'
    } else {
      const explicitDirection = eventList
        .filter((event) => eventNodeId(event) === node.id)
        .sort((a, b) => eventAt(b) - eventAt(a))
        .map((event) => event?.payload?.change?.direction)
        .find((value) => ['improving', 'declining', 'stable'].includes(value))
      if (explicitDirection) direction = explicitDirection
    }

    const latestEvent = stat.latestEv || change?.latest || null
    const latestPayload = latestEvent?.payload || {}
    const nature = latestEvent ? natureFromEvent(latestEvent) : 'quantitative'
    const themeTag = latestEvent ? themeTagFromEvent(latestEvent) : '暂无标签'
    const confidence = confidenceValue(node.confidence)
    const rawText = latestPayload.title || latestPayload.text || titleOf(node)
    let state = distillJudgment(rawText)
    if (stat.supports > 0 || stat.contradicts > 0) {
      const confidenceText = confidence == null ? '置信度未评估' : `置信度 ${Math.round(confidence)}%`
      state += `（${stat.supports} 支持/${stat.contradicts} 反驳，${confidenceText}）`
    }

    let latest = null
    let latestSrc = null
    if (latestEvent) {
      latest = latestPayload.title || latestPayload.text || (latestEvent.type === 'confidence.updated' ? '置信度变化' : '新证据')
      latestSrc = latestPayload.sourceLabel || latestPayload.url || '来源未记录'
    }

    const nodeEvents = []
    for (const event of eventList) {
      const payload = event?.payload || {}
      const direct = eventNodeId(event) === node.id || (event?.type === 'claim.created' && event.id === node.id)
      const linked = event?.type === 'relation.declared'
        && (payload.to?.eventId === node.id || payload.nodeId === node.id || payload.targetId === node.id)
      if (!direct && !linked) continue
      if (!['confidence.updated', 'evidence.appended', 'relation.declared', 'claim.created', 'inference.created', 'node.created'].includes(event.type)) continue
      if (event.type === 'relation.declared' && payload.reviewStatus === 'rejected') continue
      nodeEvents.push(event)
    }
    nodeEvents.sort((a, b) => eventAt(a) - eventAt(b) || (a.seq || 0) - (b.seq || 0))
    const evolution = nodeEvents.slice(-12).map((event) => {
      const payload = event.payload || {}
      const before = confidenceValue(payload.before ?? payload.oldConfidence)
      const after = confidenceValue(payload.after ?? payload.newConfidence)
      let eventDirection = payload.change?.direction
      if (!DIRECTION_META[eventDirection]) {
        if (event.type === 'confidence.updated') eventDirection = before == null || after == null || before === after ? 'stable' : after > before ? 'improving' : 'declining'
        else eventDirection = 'undetermined'
      }
      const text = payload.title || payload.text || (event.type === 'confidence.updated' && before != null && after != null
        ? `置信度 ${Math.round(before)}% → ${Math.round(after)}%` : titleOf(node))
      return {
        date: eventDate(event), direction: eventDirection,
        nature: payload.change?.nature || natureFromEvent(event),
        themeTag: payload.change?.themeTag || themeTagFromEvent(event),
        text: distillJudgment(text), eventId: event.id,
      }
    })

    model.nodesByDirection[direction].push({
      id: node.id, title: titleOf(node), direction, nature, themeTag, state,
      latest, latestSrc, confidence, evolution,
    })
    model.directionCounts[direction]++
  }

  for (const direction of ['improving', 'declining', 'stable']) {
    model.nodesByDirection[direction].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1))
  }

  const turningCandidates = []
  for (const [nodeId, change] of confChanges) {
    if (Math.abs(change.net) < 10) continue
    const node = byId.get(nodeId)
    if (!node) continue
    turningCandidates.push({
      date: eventDate(change.latest), timestamp: change.latestAt,
      direction: change.net > 0 ? 'improving' : 'declining',
      nature: natureFromEvent(change.latest), themeTag: themeTagFromEvent(change.latest),
      text: `${titleOf(node)}：置信度变化 ${Math.round(change.net)} 个百分点`,
      nodeIds: [nodeId], nodeTitles: [titleOf(node)],
    })
  }
  turningCandidates.sort((a, b) => b.timestamp - a.timestamp)
  model.turningPoints = turningCandidates.slice(0, 5)

  /* A theme-wide conclusion must be an explicit, evidence-linked synthesis;
     relationship counts or graph shape are not a substitute for one. */
  model.oneLiner = null
  if (!model.oneLiner && viewpoints.length === 0) model.status = '暂无观点节点'
  else if (!model.oneLiner && model.directionCounts.undetermined === viewpoints.length) model.status = '方向待观察'
  return model
}

export const estimateReadSeconds = (model) => {
  if (model.empty) return 0
  const nodeCount = model.nodesByDirection.improving.length + model.nodesByDirection.declining.length
    + model.nodesByDirection.stable.length + model.nodesByDirection.undetermined.length
  return Math.max(30, Math.round(20 + nodeCount * 8 + model.turningPoints.length * 6))
}

/**
 * 计算综合理解横幅数据：最强共识与最大分歧
 * @param {Array} nodes - 投影节点列表
 * @param {Function} evidenceForNode - 获取节点证据的函数
 * @returns {Object|null} { strongest, mostDisputed, nodeCount } 或 null
 */
export function synthesisSummary(nodes = [], evidenceForNodeFn = null) {
  const viewpoints = nodes.filter(n => n && !n.archived && (n.nodeType === 'viewpoint' || n.kind === 'claim'));
  if (!viewpoints.length) return null;

  let strongest = null;
  let maxStrength = -1;
  let mostDisputed = null;
  let minDiff = Infinity;
  let maxTotal = -1;

  for (const node of viewpoints) {
    const strength = Number(node.confidence ?? node.strength ?? 0);
    // 最强共识：强度最高
    if (strength > maxStrength) {
      maxStrength = strength;
      strongest = node;
    }
    // 最大分歧：支持与挑战最接近且总量最大
    let support = 0, challenge = 0;
    if (evidenceForNodeFn) {
      try {
        const summary = evidenceForNodeFn({ projection: { nodes } }, node.id);
        support = (summary.supports?.length || 0) + (summary.both?.length || 0);
        challenge = (summary.against?.length || 0) + (summary.both?.length || 0);
      } catch { /* 忽略 */ }
    } else {
      // 降级：用 evidenceCount 估算
      const total = node.evidenceCount || 0;
      support = Math.round(total / 2);
      challenge = total - support;
    }
    const diff = Math.abs(support - challenge);
    const total = support + challenge;
    if (total > 0 && (diff < minDiff || (diff === minDiff && total > maxTotal))) {
      minDiff = diff;
      maxTotal = total;
      mostDisputed = { node, support, challenge };
    }
  }

  return {
    nodeCount: viewpoints.length,
    strongest: strongest ? {
      id: strongest.id,
      title: titleOf(strongest),
      strength: Math.round(maxStrength),
    } : null,
    mostDisputed: mostDisputed ? {
      id: mostDisputed.node.id,
      title: titleOf(mostDisputed.node),
      support: mostDisputed.support,
      challenge: mostDisputed.challenge,
    } : null,
  };
}
