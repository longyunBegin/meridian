import { networkNodeStatus, networkNodeType, readerStateKey, truncateGraphemes } from './theme-network.js'

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
  /* Number(null) === 0：缺强度必须返回 null，否则会显示成"强度 0%"（与"还没有强度"是两回事）。 */
  if (value == null || value === '') return null
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

/** 证据行：投影节点自带出处（P0-3），这里只挑展示需要的字段。 */
function evidenceRow(source) {
  const refs = asArray(source?.evidenceRefs)
  const urlRef = refs.find((ref) => ref?.type === 'url' && ref.id)
  const candidate = String(source?.sourceUrl || urlRef?.id || '').trim()
  let url = null
  try { url = /^https?:$/i.test(new URL(candidate).protocol) ? candidate : null } catch { url = null }
  return {
    id: source?.id || '',
    title: String(source?.title || source?.currentText || '外部数据').trim() || '外部数据',
    text: String(source?.currentText || source?.detail || '').trim(),
    sourceLabel: String(source?.sourceLabel || '').trim() || null,
    sourcePublishedAt: String(source?.sourcePublishedAt || '').trim() || null,
    applicability: String(source?.applicability || '').trim() || null,
    url,
  }
}

/**
 * R1 论证大纲：结论 → 要点（支持 / 挑战 / 未表态分组）。
 * 图没有唯一阅读顺序，大纲有；数据全部来自投影（证据节点自带出处），只做分组，不改写账本。
 */
export function buildArgumentOutline(nodes = [], evidenceForNodeFn = null) {
  const rows = asArray(nodes).filter((node) => node && !node.archived && networkNodeType(node) !== 'evidence')
  return rows.map((node) => {
    const summary = typeof evidenceForNodeFn === 'function' ? evidenceForNodeFn(node.id) : null
    const map = (list) => asArray(list).map((row) => evidenceRow(row?.source || row)).filter((row) => row.id)
    const supports = map(summary?.supports)
    const against = map(summary?.against)
    const unclassified = map(summary?.unclassified)
    return {
      id: node.id,
      title: titleOf(node),
      state: readerStateKey(node, summary),
      strength: confidenceValue(node.confidence),
      category: nodeCategory(node),
      supports, against, unclassified,
      counts: { supports: supports.length, against: against.length, unclassified: unclassified.length },
    }
  })
}

/**
 * R3 双边清单（§10.1 第 4 项）：支持一列 / 挑战一列 / 中间当前强度。
 * 图里"反驳"只是一条红线，极易被忽略；并排两列才能直接读"争议点到底在哪"。
 * 只列有支持的或有的挑战的原子（两边都空的不算争议），按"两边都多"优先排序。
 */
export function buildDebateBoard(nodes = [], evidenceForNodeFn = null) {
  const rows = asArray(nodes).filter((node) => node && !node.archived && networkNodeType(node) !== 'evidence')
  return rows.map((node) => {
    const summary = typeof evidenceForNodeFn === 'function' ? evidenceForNodeFn(node.id) : null
    const map = (list) => asArray(list).map((row) => evidenceRow(row?.source || row)).filter((row) => row.id)
    const supports = map(summary?.supports)
    const against = map(summary?.against)
    return {
      id: node.id,
      title: titleOf(node),
      strength: confidenceValue(node.confidence),
      supports, against,
      contested: supports.length > 0 && against.length > 0,
    }
  }).filter((row) => row.supports.length || row.against.length)
    .sort((a, b) => (Number(b.contested) - Number(a.contested))
      || (b.supports.length + b.against.length) - (a.supports.length + a.against.length)
      || String(a.title).localeCompare(String(b.title)))
}

/**
 * R4 编年史（§10.1 第 5 项）：一行一条外部数据——日期 · 来源 · 归入哪个原子 · 支持/挑战 ·
 * 这次归因带来的强度变化。人话模板来自 P0-4；日期用真实摄入/事件时间，不出现 seq/哈希。
 */
export function buildChronicle({ events = [], nodes = [] } = {}) {
  const rows = asArray(events).filter((event) => event && event.type === 'evidence.appended')
  const byId = new Map(asArray(nodes).map((node) => [node.id, node]))
  const stanceByEvidence = new Map()
  for (const event of asArray(events)) {
    if (!event || event.type !== 'relation.declared') continue
    const from = event.payload?.from?.eventId || event.payload?.from
    const rel = event.payload?.rel
    if (from && (rel === 'supports' || rel === 'contradicts')) stanceByEvidence.set(from, rel)
  }
  const strengthByEvidence = new Map()
  for (const event of asArray(events)) {
    if (!event || event.type !== 'confidence.updated') continue
    const evidenceId = event.payload?.evidenceEventId
    if (!evidenceId) continue
    const before = confidenceValue(event.payload?.oldConfidence)
    const after = confidenceValue(event.payload?.newConfidence)
    strengthByEvidence.set(evidenceId, before == null ? `→ ${after}%` : `${before}% → ${after}%`)
  }
  return rows.map((event) => {
    const payload = event.payload || {}
    const node = byId.get(event.id)
    const targets = asArray(node?.targetNodeIds)
    const urlRef = asArray(node?.evidenceRefs || payload.evidenceRefs).find((ref) => ref?.type === 'url' && ref.id)
    const rel = stanceByEvidence.get(event.id)
    return {
      id: event.id,
      at: event.at || null,
      date: String(event.at || '').slice(0, 10) || '—',
      text: String(payload.text || payload.reason || node?.title || '外部数据').trim().slice(0, 120),
      sourceLabel: String(node?.sourceLabel || payload.sourceLabel || '').trim() || null,
      atomTitles: targets.map((id) => titleOf(byId.get(id))).filter((title) => title && title !== '未命名'),
      stance: rel === 'supports' ? 'supports' : rel === 'contradicts' ? 'contradicts' : 'unstated',
      strengthChange: strengthByEvidence.get(event.id) || null,
      url: (() => {
        const candidate = String(node?.sourceUrl || urlRef?.id || '').trim()
        try { return /^https?:$/i.test(new URL(candidate).protocol) ? candidate : null } catch { return null }
      })(),
    }
  }).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
}

/**
 * R5 缺口清单：模型的一半价值在"知道哪里还不知道"。
 * 四类缺口全部来自投影/收件箱的既有事实，不猜测：
 * ① 无任何证据的原子 ② 待复核的归因 ③ 适用时间已过的证据 ④ 跨主题未归位的收件箱条目
 */
export function parseApplicabilityEnd(value) {
  const text = String(value || '').trim()
  if (!text) return null
  let match = /^(\d{4})\s*[Qq]([1-4])$/.exec(text)
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) * 3, 0, 23, 59, 59)
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59)
  match = /^(\d{4})-(\d{1,2})$/.exec(text)
  if (match) return Date.UTC(Number(match[1]), Number(match[2]), 0, 23, 59, 59)
  match = /^(\d{4})$/.exec(text)
  if (match) return Date.UTC(Number(match[1]), 11, 31, 23, 59, 59)
  return null
}

export function buildGapList({ nodes = [], edges = [], inboxItems = [], now = Date.now() } = {}) {
  const rows = asArray(nodes).filter((node) => node && !node.archived)
  const evidenceRows = rows.filter((node) => networkNodeType(node) === 'evidence')
  const gaps = []
  for (const node of rows) {
    if (networkNodeType(node) === 'evidence') continue
    const linked = new Set(asArray(node.evidenceNodeIds))
    for (const evidence of evidenceRows) if (asArray(evidence.targetNodeIds).includes(node.id)) linked.add(evidence.id)
    if (!linked.size && !(Number(node.evidenceCount) > 0)) {
      gaps.push({
        key: `no-evidence:${node.id}`, kind: 'no-evidence', nodeId: node.id,
        title: titleOf(node), detail: '这个原子还没有任何外部数据',
        todo: `为「${titleOf(node)}」补一条外部数据`,
      })
    }
  }
  for (const evidence of evidenceRows) {
    if (evidence.pendingReview !== true || evidence.reviewDecision) continue
    gaps.push({
      key: `pending-review:${evidence.id}`, kind: 'pending-review', nodeId: evidence.id,
      title: titleOf(evidence), detail: '这条外部数据的归因还没人工复核',
      todo: `复核「${titleOf(evidence)}」的归因`,
    })
  }
  for (const evidence of evidenceRows) {
    const end = parseApplicabilityEnd(evidence.applicability)
    if (end == null || end >= now) continue
    gaps.push({
      key: `expired-evidence:${evidence.id}`, kind: 'expired-evidence', nodeId: evidence.id,
      title: titleOf(evidence), detail: `适用时间（${evidence.applicability}）已经过去`,
      todo: `更新「${titleOf(evidence)}」的适用时间或补一条新数据`,
    })
  }
  for (const item of asArray(inboxItems)) {
    if (!item || item.status !== 'pending' || item.kind === 'todo' || item.extractedThemeId) continue
    gaps.push({
      key: `unassigned-inbox:${item.id}`, kind: 'unassigned-inbox', nodeId: null,
      title: String(item.title || item.text || '未归位条目').slice(0, 40),
      detail: '收件箱里这条还没有归到任何主题',
      todo: `把「${String(item.title || item.text || '').slice(0, 24)}」归到主题`,
    })
  }
  /* 关系层面的待复核：投影里带 pendingReview 且还没有决定的边。 */
  for (const edge of asArray(edges)) {
    if (!edge || edge.reviewDecision || edge.pendingReview !== true) continue
    gaps.push({
      key: `pending-review-edge:${edge.id}`, kind: 'pending-review', nodeId: edge.to || null,
      title: `${edge.from || '?'} → ${edge.to || '?'}`, detail: '这条关系还没人工复核',
      todo: '复核一条待确认的关系',
    })
  }
  const order = { 'no-evidence': 0, 'pending-review': 1, 'expired-evidence': 2, 'unassigned-inbox': 3 }
  return gaps.sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.title).localeCompare(String(b.title)))
}

/**
 * R2 小倍数网格的 sparkline：由 confidence 历史算出折线点。
 * 少于两个点就不画线（enough=false）——一个点连不成趋势，别硬画成"平稳"。
 */
export function strengthSparkline(node, { width = 72, height = 22 } = {}) {
  const values = asArray(node?.confidenceHistory)
    .map((row) => confidenceValue(row?.newConfidence ?? row?.oldConfidence))
    .filter((value) => value != null)
  if (values.length < 2) return { points: '', values, min: null, max: null, enough: false }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width
    const y = height - ((value - min) / span) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return { points, values, min, max, enough: true }
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
