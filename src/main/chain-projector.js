/**
 * 认知链 · 投影（P2）
 *
 * 事件 → 当前认知图（只读投影）。纯函数，可重放：
 * - claim.created / inference.created → 主张 / 推断节点
 * - evidence.appended → 证据节点
 * - correction.appended → 不建节点；沿 supersedes 链找到最新版本，节点显示当前值并标记已更正
 * - relation.declared → 语义边（supports / derives / contradicts）
 * - settlement.recorded → 节点标记已结算（correct=false 即已证伪）
 * - node.archived → 节点标记已归档
 * - node.parked / node.unparked → 外部数据冷冻 / 解冻（冷库；不碰置信度）
 * - topic.linked → 主题归属隐含在事件 themeId 中，投影不单独成边
 *
 * 端点解析：{eventId} → 对应节点；{ref} → 已有节点或外部证据节点；
 * {name} → 按标题找主张节点，找不到则为外部节点。
 */
import { getEvents, appendEvent, appendEvents as appendEventBatch, hasUnmigratedNodeSources, migrateThemeToEvents, NODE_TYPES, REL_TYPES } from './chain-events.js'
import { updateConfidence, estimateStrength } from './engine-confidence.js'
import { digest } from './reading-store.js'
import { JUDGE_STANCES, STANCE_RELS, evidenceJudgeState } from '../shared/judge.js'
import { normalizePoints, sourceUrlOf } from '../shared/evidence-source.js'
import { evidenceWeightOf, weightOf } from '../shared/evidence-weight.js'
import { randomUUID } from 'node:crypto'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const copyValue = (v) => JSON.parse(JSON.stringify(v ?? null))

function evidenceRefKey(ref) {
  if (!isObj(ref) || !ref.type || !ref.id) return null
  return JSON.stringify([String(ref.type).trim(), String(ref.id).trim()])
}

/** http(s) 判定（P0-2）：账本只接受可打开的链接，写入侧就挡住 javascript: 之类脏 ref。 */
function isHttpUrl(value) {
  const text = String(value || '').trim()
  if (!text) return false
  try { return /^https?:$/.test(new URL(text).protocol) } catch { return false }
}

/**
 * 脏 ref 判定：只挡"带非 http(s) 协议头"的值（javascript: / data: / file: …）。
 * 不带协议头的普通标识符（如 'source-1'、lemma id）不是 URL，按原样保留——
 * 挂载路径历史上就在用这种引用，不能因为收紧协议就把它们判成脏数据。
 */
function isDirtyUrlRef(value) {
  const text = String(value || '').trim()
  if (!text || isHttpUrl(text)) return false
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)
}

/** Preserve first-seen order; for duplicate keys, retain the first ref and fill a missing title. */
function uniqueEvidenceRefs(refs) {
  const ordered = new Map()
  for (const raw of Array.isArray(refs) ? refs : []) {
    const key = evidenceRefKey(raw)
    if (!key) continue
    const prior = ordered.get(key)
    if (prior) {
      if (!prior.title && raw.title) prior.title = raw.title
      continue
    }
    ordered.set(key, { ...copyValue(raw), type: String(raw.type).trim(), id: String(raw.id).trim() })
  }
  return [...ordered.values()]
}

function explicitEvidenceTargetIds(payload) {
  const candidates = [
    ...(Array.isArray(payload?.targetNodeIds) ? payload.targetNodeIds : []),
    payload?.targetNodeId,
    payload?.targetClaimId,
    payload?.claimId,
    payload?.nodeId,
  ]
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))]
}

function graphemes(value) {
  const text = String(value || '')
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
  }
  return Array.from(text)
}

function shortTitle(s, n = 28) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  const parts = graphemes(t)
  return parts.length > n ? parts.slice(0, n - 1).join('') + '…' : t
}

const trimmedOrNull = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '') || null

/**
 * 旧数据迁移写过一类"只改分层"的修订（oldValue/newValue 都是「未分层 / 第N层」）。
 * 投影不再使用分层（节点上的 layerNote 已写明），这类修订不能覆盖观点的现状文本。
 */
const LAYER_MARK = /^(未分层|第[一二三四五六七八九十百零〇0-9]+层)$/
function isLayerOnlyCorrection(payload) {
  return LAYER_MARK.test(String(payload?.oldValue ?? '').trim()) && LAYER_MARK.test(String(payload?.newValue ?? '').trim())
}

/** 观察计划（旧 lemma 的 scaffold）：关键问题、跟踪指标（含频率）、推翻条件；形状不对就是 null。 */
function normalizeScaffold(raw) {
  if (!isObj(raw)) return null
  const questions = (Array.isArray(raw.answer) ? raw.answer : [raw.answer])
    .map(trimmedOrNull).filter(Boolean)
  const seen = new Set()
  const indicators = []
  for (const item of Array.isArray(raw.indicators) ? raw.indicators : []) {
    const name = trimmedOrNull(isObj(item) ? item.name : item)
    if (!name) continue
    const cadence = isObj(item) ? trimmedOrNull(item.cadence) : null
    const key = `${name}\u0000${cadence || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    indicators.push({ name, cadence })
  }
  const falsifier = trimmedOrNull(raw.falsifier)
  return questions.length || indicators.length || falsifier ? { questions, indicators, falsifier } : null
}

/**
 * claimLineage(events, claimEventId) → { head, lineage }
 * 沿 supersedes 链走到最新版本。head = 最新事件 id（可能是更正事件）。
 */
export function claimLineage(events, claimEventId) {
  const byTarget = new Map()
  for (const e of events) {
    if (e.type === 'correction.appended' && e.supersedes) {
      if (!byTarget.has(e.supersedes)) byTarget.set(e.supersedes, [])
      byTarget.get(e.supersedes).push(e)
    }
  }
  const lineage = [claimEventId]
  let cur = claimEventId
  for (;;) {
    const next = (byTarget.get(cur) || []).slice().sort((a, b) => a.seq - b.seq).at(-1)
    if (!next) break
    cur = next.id
    lineage.push(cur)
  }
  return { head: cur, lineage }
}

/**
 * projectEvents(events) → { nodes, edges }
 * node: { id, kind: 'claim'|'inference'|'evidence', title, status, confidence,
 *         correct: null|true|false, archived, superseded, currentText,
 *         sourceKind, sourceRef, eventIds, external }
 * edge: { id, rel, from, to, pendingReview, mapping }
 */
export function projectEvents(events) {
  const byId = new Map(events.map((e) => [e.id, e]))
  const nodes = new Map() // nodeId -> node
  const nodeOfEvent = new Map() // eventId -> nodeId（含被取代事件 → 其主张节点）

  const addNode = (node) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
    return nodes.get(node.id)
  }

  // Legacy claim/inference records remain readable as viewpoints; generic node.created
  // events project only the five canonical network types.
  for (const e of events) {
    const genericType = e.type === 'node.created' ? e.payload?.nodeType : null
    if (e.type !== 'claim.created' && e.type !== 'inference.created'
      && !(e.type === 'node.created' && NODE_TYPES.includes(genericType))) continue
    const p = e.payload || {}
    const nodeType = genericType || 'viewpoint'
    const kind = nodeType === 'viewpoint'
      ? (e.type === 'inference.created' ? 'inference' : 'claim') : nodeType
    const node = addNode({
      id: e.id,
      kind,
      nodeType,
      title: p.title || '未命名',
      status: p.status || 'pending',
      confidence: p.confidence ?? null,
      correct: null,
      resolved: null,
      archived: false,
      superseded: false,
      createdSeq: e.seq,
      currentText: p.detail ?? p.coreInfo ?? p.title ?? '',
      detail: p.detail ?? p.coreInfo ?? '',
      /* L2：原子分类来自主题自定义词表；没有分类时保持 null，不在事件里编造领域类型。 */
      atomCategory: String(p.atomCategory || '').trim() || null,
      applicability: String(p.applicability || '').trim() || null,
      /* 旧 lemma 的结构字段：segment = 主题的维度；读者页用它们画骨架与"接下来看什么"。 */
      claimType: trimmedOrNull(p.claimType),
      falsifier: trimmedOrNull(p.falsifier),
      settleAt: trimmedOrNull(p.settleAt),
      scaffold: normalizeScaffold(p.scaffold),
      tags: [...new Set((Array.isArray(p.tags) ? p.tags : []).map(trimmedOrNull).filter(Boolean))],
      sourceKind: p.sourceKind || null,
      sourceRef: p.sourceRef || `event:${e.id}`,
      eventIds: [e.id],
      provenanceEventIds: [e.id],
      external: false,
    })
    nodeOfEvent.set(e.id, node.id)
  }

  // 证据节点
  for (const e of events) {
    if (e.type !== 'evidence.appended') continue
    const p = e.payload || {}
    /* 旧格式证据把出处放在 legacySource 里：label 实测等于 kind（"券商研报"），是来源类型而非来源名，
       所以只进 sourceCategory，不冒充 sourceLabel（否则"按来源名去重"会把类型当成独立来源）。
       legacySource.at 是记录日期（实测与抓取日同日、晚于原文日期），不冒充发布日期。 */
    const legacy = isObj(p.legacySource) ? p.legacySource : {}
    const legacyUrl = isHttpUrl(legacy.url) ? String(legacy.url).trim() : null
    const node = addNode({
      id: e.id,
      kind: 'evidence',
      nodeType: 'evidence',
      title: shortTitle(p.text || p.reason || '证据'),
      status: 'pending',
      pendingReview: p.pendingReview === true,
      reviewDecision: null,
      confidence: null,
      correct: null,
      resolved: null,
      archived: false,
      cold: false,
      superseded: false,
      createdSeq: e.seq,
      currentText: p.text || p.reason || '',
      sourceKind: p.sourceKind || null,
      /* 无显式 sourceRef 时用事件 id 兜底，保证归档 / 恢复 / 冷冻能按同一键找到这条外部数据。 */
      sourceRef: p.sourceRef || `event:${e.id}`,
      /* P0-3：投影证据节点也要带出处。否则任何从投影出发的 UI（图谱证据节点、检视器、
         未来的快照/回放）都拿不到 URL 与来源，回放出来的模型就失去溯源。 */
      evidenceRefs: uniqueEvidenceRefs(p.evidenceRefs || []),
      sourceLabel: String(p.sourceLabel || '').trim() || null,
      sourceUrl: String(p.sourceUrl || '').trim() || legacyUrl,
      sourcePublishedAt: p.sourcePublishedAt || null,
      sourceFetchedAt: p.sourceFetchedAt || trimmedOrNull(legacy.fetchedAt),
      sourceCategory: trimmedOrNull(legacy.kind),
      legacySourceAt: trimmedOrNull(legacy.at),
      ingestedAt: p.ingestedAt || null,
      recordedAt: trimmedOrNull(e.at),
      applicability: String(p.applicability || '').trim() || null,
      targetNodeIds: explicitEvidenceTargetIds(p),
      /* 要点：抽取出来的要点跟着原文进主题，当判的上下文，不单独计数。 */
      points: normalizePoints(p.points),
      /* 权重：引擎复核落下的证据，权重是人确认时给的；其余进主题时记的是建议，判的时候由 signal.reviewed 覆盖。 */
      weight: weightOf(p.weight),
      weightSource: weightOf(p.weight) ? (p.sourceKind === 'engine-reviewed' ? 'judged' : 'suggested') : null,
      eventIds: [e.id],
      provenanceEventIds: [e.id],
      external: false,
    })
    nodeOfEvent.set(e.id, node.id)
  }

  // 更正链：沿 supersedes 找到旧主张或新 viewpoint 节点的最新版本
  for (const e of events) {
    if (e.type !== 'claim.created' && e.type !== 'inference.created'
      && !(e.type === 'node.created' && e.payload?.nodeType === 'viewpoint')) continue
    const nodeId = nodeOfEvent.get(e.id)
    const node = nodes.get(nodeId)
    const { head, lineage } = claimLineage(events, e.id)
    node.eventIds = lineage
    for (const eid of lineage) nodeOfEvent.set(eid, nodeId)
    if (head !== e.id) {
      node.superseded = true
      const textCorrection = lineage.slice(1).map((id) => byId.get(id))
        .filter((event) => event && !isLayerOnlyCorrection(event.payload)).at(-1) || null
      if (textCorrection) {
        const p = textCorrection.payload || {}
        if (String(p.newValue ?? '').trim()) node.currentText = String(p.newValue)
        node.correctionReason = p.reason || ''
        if (Object.hasOwn(p, 'applicability')) node.applicability = String(p.applicability || '').trim() || null
      } else {
        node.correctionReason = byId.get(head)?.payload?.reason || ''
      }
    }
  }

  // Renames and invalidations alter only projections at/after their event; the
  // append-only event list remains the authoritative name and validity history.
  for (const e of events) {
    if (e.type !== 'node.renamed' && e.type !== 'node.invalidated' && e.type !== 'node.categorized') continue
    const p = e.payload || {}
    for (const node of nodes.values()) {
      if (node.external || node.id !== p.nodeId || node.sourceRef !== p.sourceRef) continue
      node.provenanceEventIds ||= [...node.eventIds]
      if (!node.provenanceEventIds.includes(e.id)) node.provenanceEventIds.push(e.id)
      if (!node.eventIds.includes(e.id)) node.eventIds.push(e.id)
      if (e.type === 'node.categorized') {
        /* 归类：追加式，保留历史分类（旧分类不删）。 */
        node.categoryHistory ||= []
        node.categoryHistory.push({ eventId: e.id, seq: e.seq, at: e.at, category: p.category })
        node.atomCategory = p.category || null
        node.categorizedAt = e.at || null
      } else if (e.type === 'node.renamed') {
        node.nameHistory ||= []
        node.nameHistory.push({ eventId: e.id, seq: e.seq, at: e.at, previousTitle: p.previousTitle, title: p.newTitle })
        node.originalTitle ??= p.previousTitle
        node.title = p.newTitle
        node.renamedAt = e.at || null
      } else {
        node.invalidated = true
        node.invalidationReason = p.reason || ''
        node.invalidatedAt = p.invalidatedAt || e.at || null
      }
    }
  }

  // 外部证据节点（relation 端点引用了账本外对象时）
  const externalNode = (key, title, eventId) => {
    const node = addNode({
      id: key,
      kind: 'evidence',
      nodeType: 'evidence',
      title: shortTitle(title || '来源未解析'),
      status: 'pending',
      confidence: null,
      correct: null,
      resolved: null,
      archived: false,
      superseded: false,
      createdSeq: byId.get(eventId)?.seq ?? null,
      currentText: '',
      sourceKind: 'external',
      sourceRef: key,
      eventIds: [],
      provenanceEventIds: [],
      external: true,
    })
    if (eventId && !node.provenanceEventIds.includes(eventId)) node.provenanceEventIds.push(eventId)
    if (eventId && !node.eventIds.includes(eventId)) node.eventIds.push(eventId)
    return node
  }

  const resolveEndpoint = (ep, eventId) => {
    if (!isObj(ep)) return null
    if (ep.eventId && nodeOfEvent.has(ep.eventId)) return nodeOfEvent.get(ep.eventId)
    if (isObj(ep.ref)) {
      const ref = ep.ref
      if (ref.type === 'lemma' || ref.type === 'branch') {
        const nid = `evt:node:${ref.id}`
        if (nodes.has(nid)) return nid
      }
      return externalNode(`ext:ref:${ref.type || 'unknown'}:${ref.id || 'noid'}`, ref.title, eventId).id
    }
    if (ep.name) {
      for (const n of nodes.values()) {
        if ((n.nodeType === 'viewpoint' || n.kind === 'claim' || n.kind === 'inference') && !n.external && n.title === ep.name) return n.id
      }
      return externalNode(`ext:name:${ep.name}`, ep.name, eventId).id
    }
    return null
  }

  // 语义边
  const edges = []
  for (const e of events) {
    if (e.type !== 'relation.declared') continue
    const p = e.payload || {}
    if (p.reviewOf) continue
    if (!REL_TYPES.includes(p.rel)) continue
    const from = resolveEndpoint(p.from, e.id)
    const to = resolveEndpoint(p.to, e.id)
    if (!from || !to || from === to) continue
    edges.push({
      id: e.id,
      rel: p.rel,
      relationGroup: ['supports', 'derives', 'contradicts'].includes(p.rel) ? 'argument'
        : p.rel === 'supersedes' ? 'revision' : 'association',
      from,
      to,
      pendingReview: p.reviewStatus ? p.reviewStatus === 'pending-review' : p.rel === 'derives',
      reviewDecision: null,
      reviewReason: '',
      reviewEventId: null,
      reviewedAt: null,
      reviewedBy: null,
      mapping: p.mapping || '',
      eventId: e.id,
      seq: e.seq,
      provenanceEventIds: [e.id],
      sourceRef: p.sourceRef || `event:${e.id}`,
    })
  }

  for (const e of events) {
    if (e.type !== 'relation.declared' || !e.payload?.reviewOf) continue
    const edge = edges.find((candidate) => candidate.eventId === e.payload.reviewOf)
    if (!edge) continue
    edge.pendingReview = false
    edge.reviewDecision = e.payload.reviewDecision
    edge.reviewReason = e.payload.decisionReason || ''
    edge.reviewEventId = e.id
    edge.reviewedAt = e.at || null
    edge.reviewedBy = e.actor || null
    edge.provenanceEventIds.push(e.id)
  }

  /* signal.reviewed：标记信号已判决，存储确认的三层 */
  const reviewedSignals = new Map() // signalEventId -> review event
  for (const e of events) {
    if (e.type !== 'signal.reviewed') continue
    const p = e.payload || {}
    if (p.signalEventId) reviewedSignals.set(p.signalEventId, e)
  }
  for (const [signalEventId, reviewEvent] of reviewedSignals) {
    const review = reviewEvent.payload || {}
    const targetEvent = byId.get(signalEventId)
    const target = targetEvent?.type === 'evidence.appended' ? nodes.get(signalEventId) : null
    const edge = targetEvent?.type === 'relation.declared'
      ? edges.find((candidate) => candidate.eventId === signalEventId) : null
    const reviewed = target || edge
    if (!reviewed) continue
    reviewed.pendingReview = false
    reviewed.reviewDecision = review.decision || null
    reviewed.reviewReason = review.reason || ''
    reviewed.reviewEventId = reviewEvent.id
    reviewed.reviewedAt = reviewEvent.at || null
    reviewed.reviewedBy = reviewEvent.actor || null
    reviewed.reviewChange = review.change || null
    reviewed.provenanceEventIds ||= []
    if (!reviewed.provenanceEventIds.includes(reviewEvent.id)) reviewed.provenanceEventIds.push(reviewEvent.id)
    if (target) {
      target.eventIds ||= []
      if (!target.eventIds.includes(reviewEvent.id)) target.eventIds.push(reviewEvent.id)
      /* 「判」把证据判给某个原子：复核里写明的目标原子取代原先建议的目标（旧挂载只是待复核的建议），
         否则换原子判过之后，原来那个原子身上还会残留一条"中立"。只认现存的非证据节点。 */
      const judgedTarget = review.decision === 'rejected' ? null : nodes.get(trimmedOrNull(review.targetNodeId))
      if (judgedTarget && !judgedTarget.external && judgedTarget.kind !== 'evidence') target.targetNodeIds = [judgedTarget.id]
      const judgedWeight = review.decision === 'rejected' ? null : weightOf(review.weight)
      if (judgedWeight) {
        target.weight = judgedWeight
        target.weightSource = 'judged'
      }
    }
  }

  for (const node of nodes.values()) {
    node.evidenceNodeIds = []
    node.evidenceEventIds = []
  }
  const linkEvidence = (target, evidence) => {
    if (!target || target.external || target.kind === 'evidence' || !evidence || evidence.kind !== 'evidence') return
    if (!target.evidenceNodeIds.includes(evidence.id)) target.evidenceNodeIds.push(evidence.id)
    if (!evidence.external && evidence.eventIds?.includes(evidence.id)
      && !target.evidenceEventIds.includes(evidence.id)) target.evidenceEventIds.push(evidence.id)
  }
  // An evidence event may carry an explicit target without making a semantic edge.
  // Never infer a target from event counts, title similarity, or a shared sourceRef.
  for (const evidence of nodes.values()) {
    if (evidence.kind !== 'evidence' || evidence.external) continue
    evidence.targetNodeIds = [...new Set((evidence.targetNodeIds || []).filter((id) => {
      const target = nodes.get(id)
      return target && !target.external && target.kind !== 'evidence'
    }))]
    for (const targetId of evidence.targetNodeIds) linkEvidence(nodes.get(targetId), evidence)
  }
  // Semantic evidence links remain independent relation events. Only evidence →
  // target supports/contradicts declarations enter the corresponding evidence list.
  for (const edge of edges) {
    if (!['supports', 'contradicts'].includes(edge.rel) || edge.reviewDecision === 'rejected') continue
    linkEvidence(nodes.get(edge.to), nodes.get(edge.from))
  }
  for (const node of nodes.values()) {
    node.evidenceCount = node.evidenceNodeIds.length
  }

  // 结算 / 归档 / 恢复 / 冷冻 / 解冻：按 sourceRef 找到节点，状态只由追加事件顺序决定。
  for (const e of events) {
    if (!['settlement.recorded', 'node.archived', 'node.restored', 'node.parked', 'node.unparked'].includes(e.type)) continue
    const p = e.payload || {}
    if (!p.sourceRef) continue
    const matched = [...nodes.values()].filter((n) => !n.external && n.sourceRef === p.sourceRef)
    for (const node of matched) {
      node.provenanceEventIds ||= [...node.eventIds]
      if (!node.provenanceEventIds.includes(e.id)) node.provenanceEventIds.push(e.id)
      if (!node.eventIds.includes(e.id)) node.eventIds.push(e.id)
      if (e.type === 'settlement.recorded') {
        node.correct = p.correct ?? null
        node.resolved = p.resolved ?? null
        node.settledAt = p.date || null
        node.settlementEventId = e.id
      } else if (e.type === 'node.archived') {
        node.archived = true
        node.archiveReason = p.reason || ''
        node.archivedAt = p.archivedAt || e.at || null
        node.archiveEventIds ||= []
        node.archiveEventIds.push(e.id)
      } else if (e.type === 'node.restored') {
        node.archived = false
        node.restoredAt = e.at || null
        node.restoreEventIds ||= []
        node.restoreEventIds.push(e.id)
      } else if (e.type === 'node.parked') {
        node.cold = true
        node.status = 'cold'
        node.parkReason = p.reason || ''
        node.parkedAt = p.parkedAt || e.at || null
        node.parkEventIds ||= []
        node.parkEventIds.push(e.id)
      } else {
        node.cold = false
        if (node.status === 'cold') node.status = 'pending'
        node.unparkedAt = e.at || null
        node.unparkEventIds ||= []
        node.unparkEventIds.push(e.id)
      }
    }
  }

  /* Confidence changes address a node id, not sourceRef; replay them independently. */
  for (const e of events) {
    if (e.type !== 'confidence.updated') continue
    const p = e.payload || {}
    const node = nodes.get(p.nodeId || p.claimId)
    if (!node || node.nodeType !== 'viewpoint') continue
    const oldConfidence = p.oldConfidence ?? p.before ?? null
    const newConfidence = p.newConfidence ?? p.after ?? null
    node.confidenceHistory ||= []
    node.confidenceHistory.push({
      eventId: e.id, seq: e.seq, at: e.at, oldConfidence, newConfidence,
      reason: p.reason || '', evidenceEventId: p.evidenceEventId || null,
      strength: p.strength ?? null,
    })
    if (Number.isFinite(newConfidence)) node.confidence = newConfidence
    if (!node.eventIds.includes(e.id)) node.eventIds.push(e.id)
    if (!node.provenanceEventIds.includes(e.id)) node.provenanceEventIds.push(e.id)
  }

  return { nodes: [...nodes.values()], edges, reviewedSignals }
}

/**
 * 主题视图范围：所有事件投影节点都属于同一认知网络；关系筛选和搜索负责密度。
 * 主题本身仅为范围元数据，不虚构一个根节点。
 */
export function chainScope(projection) {
  return { nodes: projection.nodes, edges: projection.edges, floating: [] }
}

/** 主题投影（含幂等懒迁移：兼容空账本及旧节点来源尚未事件化的部分升级数据）。 */
export function getChainProjection(themeId, options = {}) {
  const migrateLegacy = options.migrateLegacy ?? options.migrateIfEmpty ?? true
  let events = getEvents(themeId)
  if (migrateLegacy && (events.length === 0 || hasUnmigratedNodeSources(themeId))) {
    const { created } = migrateThemeToEvents(themeId)
    if (created > 0) {
      events = getEvents(themeId)
    }
  }
  return projectionResult(themeId, events)
}

function projectionResult(themeId, events, history = null) {
  const projection = projectEvents(events)
  const scope = chainScope(projection)
  return {
    themeId,
    eventCount: events.length,
    nodes: scope.nodes,
    edges: scope.edges,
    allNodes: projection.nodes,
    allEdges: projection.edges,
    floatingCount: scope.floating.length,
    floating: scope.floating,
    ...(history || {}),
    reviewedSignals: projection.reviewedSignals
      ? Object.fromEntries(projection.reviewedSignals)
      : {},
}
}

/** Deterministic, read-only replay. It never migrates legacy data or writes the ledger. */
export function getChainProjectionAt(themeId, sequence) {
  if (!Number.isSafeInteger(sequence)) throw new Error('回放序号必须是安全整数')
  const events = getEvents(themeId)
  const selectedSeq = Math.max(0, Math.min(events.length, sequence))
  const replayEvents = events.slice(0, selectedSeq)
  return projectionResult(themeId, replayEvents, {
    replayed: true,
    selectedSeq,
    requestedSeq: sequence,
    selectedAt: selectedSeq ? replayEvents.at(-1)?.at || null : null,
  })
}

/** Archive browsing is deliberately read-only and does not trigger legacy migration. */
export function getArchivedProjectionNodes(themeId) {
  const events = getEvents(themeId)
  const projection = projectEvents(events)
  return {
    themeId,
    nodes: projection.nodes.filter((n) => n.archived),
    edges: projection.edges,
  }
}

/** Restore is a new event; the archived event remains in the verified history. */
export function restoreProjectedNode(themeId, sourceRef, reason = '') {
  return restoreProjectedNodes(themeId, [sourceRef], reason)[0]
}

/** Create one user-authored node; no content is synthesized from the topic name. */
export function createProjectedNode(themeId, input = {}) {
  const nodeType = String(input.nodeType || '').trim()
  const title = String(input.title || '').trim()
  const detail = String(input.detail || '').trim()
  if (!NODE_TYPES.includes(nodeType)) throw new Error('请选择概念、对象、事件、观点或证据类型')
  if (!title || title.length > 180) throw new Error('标题必须为 1–180 个字符')
  if (detail.length > 10000) throw new Error('说明不能超过 10000 个字符')
  const id = `evt:node:${randomUUID()}`
  return appendEvent(themeId, {
    id,
    actor: 'user',
    type: 'node.created',
    payload: {
      nodeType, title, detail,
      status: ['pending', 'verified', 'disputed'].includes(input.status) ? input.status : 'pending',
      sourceKind: 'user-authored',
      sourceRef: `theme-node:${id}`,
      ...(String(input.atomCategory || '').trim() ? { atomCategory: String(input.atomCategory).trim().slice(0, 40) } : {}),
      ...(String(input.applicability || '').trim() ? { applicability: String(input.applicability).trim().slice(0, 160) } : {}),
    },
  })
}

/** 建设者手动设定某条观点的强度：追加一条 confidence.updated（该类型早已批准，不新增事件类型）。
 *  手动值带 source:'manual' 便于区分"模型算出来的"与"人定的"；此前没有强度记录时如实记 oldConfidence:0
 *  并在理由里写明，不假装历史上有过某个值。 */
export function setProjectedConfidence(themeId, nodeId, value, reason = '') {
  const next = Math.round(Number(value))
  if (!Number.isFinite(next) || next < 0 || next > 100) throw new Error('强度必须是 0–100 的整数')
  const node = projectEvents(getEvents(themeId)).nodes.find((candidate) => candidate.id === nodeId && !candidate.external)
  if (!node) throw new Error('节点不存在')
  if (node.archived || node.invalidated) throw new Error('已失效或归档节点不能设定强度')
  const hasCurrent = Number.isFinite(Number(node.confidence))
  const before = hasCurrent ? Math.round(Number(node.confidence)) : 0
  if (hasCurrent && before === next) throw new Error('强度没有变化')
  const note = String(reason || '').trim()
  return appendEvent(themeId, {
    actor: 'user',
    type: 'confidence.updated',
    payload: {
      nodeId: node.id,
      oldConfidence: before,
      newConfidence: next,
      source: 'manual',
      reason: [
        hasCurrent ? '用户手动设定强度' : '用户手动设定强度（此前没有强度记录，前值按 0 记录）',
        note,
      ].filter(Boolean).join('：'),
    },
  })
}

/** Categorize a live node by appending its new category (append-only; history kept). */
export function categorizeProjectedNode(themeId, nodeId, category) {
  const value = String(category || '').trim().slice(0, 24)
  const node = projectEvents(getEvents(themeId)).nodes.find((candidate) => candidate.id === nodeId && !candidate.external)
  if (!node) throw new Error('节点不存在')
  if (node.archived || node.invalidated) throw new Error('已失效或归档节点不能改分类')
  if (String(node.atomCategory || '') === value) throw new Error('分类没有变化')
  return appendEvent(themeId, {
    actor: 'user',
    type: 'node.categorized',
    payload: { nodeId: node.id, sourceRef: node.sourceRef, category: value },
  })
}

/** Rename a live node by appending both old and new display names. */
export function renameProjectedNode(themeId, nodeId, newTitle, reason = '') {
  const title = String(newTitle || '').trim()
  if (!title || title.length > 180) throw new Error('新名称必须为 1–180 个字符')
  const node = projectEvents(getEvents(themeId)).nodes.find((candidate) => candidate.id === nodeId && !candidate.external)
  if (!node) throw new Error('节点不存在')
  if (node.archived || node.invalidated) throw new Error('已失效或归档节点不能改名')
  if (node.title === title) throw new Error('新名称与当前名称相同')
  return appendEvent(themeId, {
    actor: 'user',
    type: 'node.renamed',
    payload: {
      nodeId: node.id,
      sourceRef: node.sourceRef,
      previousTitle: node.title,
      newTitle: title,
      reason: String(reason || '').trim(),
    },
  })
}

/** Revise a user-authored viewpoint as an append-only correction; safe to retry with requestId. */
export function correctProjectedNode(themeId, nodeId, input = {}) {
  const newValue = String(input.newValue || '').trim()
  const reason = String(input.reason || '').trim()
  const applicability = String(input.applicability || '').trim().slice(0, 160)
  const requestId = String(input.requestId || '').trim().slice(0, 200)
  if (!newValue || newValue.length > 10000) throw new Error('修订后的观点说明必须为 1–10000 个字符')
  if (!reason || reason.length > 1000) throw new Error('请填写不超过 1000 个字符的修订原因')
  const events = getEvents(themeId)
  const eventId = requestId
    ? `evt:manual-correction:${digest({ themeId, nodeId, requestId }).slice(0, 24)}`
    : `evt:manual-correction:${randomUUID()}`
  const prior = events.find((event) => event.id === eventId)
  if (prior) {
    const sameRequest = prior.type === 'correction.appended' && prior.payload?.nodeId === nodeId
      && prior.payload?.newValue === newValue && prior.payload?.reason === reason
      && (prior.payload?.applicability || null) === (applicability || null)
    if (sameRequest) return { ...prior, replayed: true }
    throw new Error('此修订请求标识已用于其他内容；请重新载入后再编辑')
  }
  const node = projectEvents(events).nodes.find((candidate) => candidate.id === nodeId && !candidate.external)
  if (!node || node.nodeType !== 'viewpoint') throw new Error('目前仅支持修订观点节点；其他节点可使用追加式改名')
  if (node.archived || node.invalidated) throw new Error('已失效或归档节点不能修订')
  const { head } = claimLineage(events, nodeId)
  const oldValue = String(node.currentText || node.title || '')
  const nextApplicability = applicability || null
  if (oldValue === newValue && (node.applicability || null) === nextApplicability) throw new Error('修订内容与当前版本相同')
  const payload = {
    oldValue, newValue, reason, nodeId, sourceRef: node.sourceRef,
    applicability: nextApplicability, sourceKind: 'user-authored-correction',
  }
  return appendEvent(themeId, { id: eventId, actor: 'user', type: 'correction.appended', supersedes: head, payload })
}

/** Mark a node invalid by appending an event; it remains visible as a historical ghost. */
export function invalidateProjectedNode(themeId, nodeId, reason = '') {
  const invalidationReason = String(reason || '').trim()
  if (!invalidationReason) throw new Error('请填写失效原因')
  const node = projectEvents(getEvents(themeId)).nodes.find((candidate) => candidate.id === nodeId && !candidate.external)
  if (!node) throw new Error('节点不存在')
  if (node.archived || node.invalidated) throw new Error('该节点已失效或归档')
  return appendEvent(themeId, {
    actor: 'user',
    type: 'node.invalidated',
    payload: {
      nodeId: node.id,
      sourceRef: node.sourceRef,
      title: node.title,
      reason: invalidationReason,
      invalidatedAt: new Date().toISOString(),
    },
  })
}

/** Append user-authored evidence and an explicit supports relation to a live non-evidence node. */
export function appendEvidenceToProjectedNode(themeId, targetNodeId, input = {}) {
  const text = String(input.text || '').trim()
  if (!text) throw new Error('请填写证据摘要或原文摘录')
  /* 佐证与反驳是同一种动作的两种方向：用户显式选择，AI 只建议不决定。 */
  const rel = input.rel === 'contradicts' ? 'contradicts' : 'supports'
  const target = projectEvents(getEvents(themeId)).nodes.find((node) => node.id === targetNodeId
    && !node.external && !node.archived && !node.invalidated && node.nodeType !== 'evidence')
  if (!target) throw new Error('请选择一个未归档、未失效的非证据节点')

  const evidenceId = `evt:evidence:${randomUUID()}`
  const sourceRef = `manual-evidence:${evidenceId}`
  const sourceUrl = String(input.url || '').trim()
  /* 手工补证也要过 http(s) 判定（P0-2）：脏 ref 不进账本，显示层兜底不是写入侧的理由。 */
  const evidenceRefs = isHttpUrl(sourceUrl)
    ? [{ type: 'url', id: sourceUrl, title: String(input.sourceLabel || '').trim() || sourceUrl }]
    : []
  const reason = String(input.reason || '').trim()
  const events = [
    {
      id: evidenceId,
      actor: 'user',
      type: 'evidence.appended',
      payload: {
        text, sourceLabel: String(input.sourceLabel || '').trim(), sourceKind: 'manual-evidence', sourceRef, evidenceRefs,
        targetNodeId,
        ...(String(input.sourcePublishedAt || '').trim() ? { sourcePublishedAt: String(input.sourcePublishedAt).trim().slice(0, 100) } : {}),
        ...(String(input.applicability || '').trim() ? { applicability: String(input.applicability).trim().slice(0, 160) } : {}),
      },
    },
    {
      actor: 'user',
      type: 'relation.declared',
      payload: {
        rel,
        from: { eventId: evidenceId },
        to: { eventId: target.id },
        sourceKind: 'manual-evidence',
        sourceRef,
        ...(reason ? { reason } : {}),
      },
    },
  ]
  /* 置信度更新（红区已批准）：用户确认归因后，系统机械应用贝叶斯公式 */
  if ((rel === 'supports' || rel === 'contradicts') && target.confidence != null && Number.isFinite(Number(target.confidence))) {
    const oldConf = Number(target.confidence) / 100 /* 存的是 0-100，转为 0-1 */
    const strength = estimateStrength({ isHardFact: false, hasUrl: !!sourceUrl })
    const newConf = updateConfidence(oldConf, strength, rel)
    if (newConf != null && newConf !== oldConf) {
      events.push({
        actor: 'user',
        type: 'confidence.updated',
        payload: {
          nodeId: target.id,
          oldConfidence: Math.round(oldConf * 100),
          newConfidence: Math.round(newConf * 100),
          reason: `${rel === 'supports' ? '支持' : '反驳'}证据：${text.slice(0, 50)}`,
          evidenceEventId: evidenceId,
        },
      })
    }
  }
  return appendEventBatch(themeId, events)
}

/** 多主题分发：向主题账本追加一条未映射的证据（不关联到具体原子）。
 * 用于一条数据属于多个主题时：已在主主题归位到原子，其他主题各追加一次证据，
 * 证据在账本里待归因，保持"每主题一本账"各自自洽。
 * （红区加法：新增函数，不修改现有逻辑） */
export function appendUnmappedEvidence(themeId, input = {}) {
  const text = String(input.text || input.statement || '').trim()
  if (!text) throw new Error('请填写证据摘要或原文摘录')
  const evidenceId = `evt:evidence:${randomUUID()}`
  const sourceRef = `multi-theme-evidence:${evidenceId}`
  const sourceUrl = String(input.url || '').trim()
  const evidenceRefs = isHttpUrl(sourceUrl)
    ? [{ type: 'url', id: sourceUrl, title: String(input.sourceLabel || '').trim() || sourceUrl }]
    : []
  const points = normalizePoints(input.points)
  const weight = weightOf(input.weight)
  // 保留来源条目引用，便于追溯
  const events = [
    {
      id: evidenceId,
      actor: 'user',
      type: 'evidence.appended',
      payload: {
        text,
        sourceLabel: String(input.sourceLabel || '').trim(),
        sourceKind: String(input.sourceKind || '').trim() === 'fed-evidence' ? 'fed-evidence' : 'multi-theme-evidence',
        sourceRef,
        evidenceRefs,
        ...(isHttpUrl(sourceUrl) ? { sourceUrl } : {}),
        ...(String(input.sourcePublishedAt || '').trim() ? { sourcePublishedAt: String(input.sourcePublishedAt).trim().slice(0, 100) } : {}),
        ...(String(input.ingestedAt || '').trim() ? { ingestedAt: String(input.ingestedAt).trim().slice(0, 100) } : {}),
        // 未映射：没有 targetNodeId，等待该主题内用户归因
        ...(input.sourceItemId ? { sourceItemId: String(input.sourceItemId) } : {}),
        ...(input.sourceItemTitle ? { sourceItemTitle: String(input.sourceItemTitle).slice(0, 200) } : {}),
        ...(input.sourceOrigin ? { sourceOrigin: String(input.sourceOrigin).slice(0, 100) } : {}),
        ...(points.length ? { points } : {}),
        ...(weight ? { weight } : {}),
      },
    },
  ]
  return appendEventBatch(themeId, events)
}

/** Persist one engine recommendation decision and its consequences as one append-only batch. */
export function reviewEngineRecommendation(themeId, recommendationEventId, decision, input = {}) {
  if (!['accepted', 'corrected', 'rejected'].includes(decision)) throw new Error('请选择接受、修正或驳回')
  const events = getEvents(themeId)
  const proposal = events.find((event) => event.id === recommendationEventId && event.type === 'engine.recommendation.proposed')
  if (!proposal) throw new Error('找不到待审核的引擎建议')
  const priorReview = events.find((event) => event.type === 'signal.reviewed' && event.payload?.signalEventId === proposal.id)
  const recommendation = proposal.payload.recommendation
  /* 用户可以在确认时**自己给这条证据的权重**（=证据强度，0–1）：给了就用它，没给才用引擎算的。
     不新增事件类型——权重本来就在证据/置信度事件的载荷里，这里只是允许人工覆盖，
     并在载荷里标 strengthSource 便于区分"模型算的"与"人定的"。 */
  /* 建设者「判」给的是 { 来源类型, 硬度 }：分值由 shared/evidence-weight 重算（不信任外部数值），
     并作为这条证据的权重落账；老的复核卡仍可直接给 0–1 的数值。 */
  const sourceWeight = decision === 'rejected' ? null : weightOf(input?.weight)
  const manualWeight = sourceWeight ? sourceWeight.value : (() => {
    if (input?.weight == null || input.weight === '' || typeof input.weight === 'object') return null
    const value = Number(input.weight)
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
  })()
  const strengthSource = sourceWeight ? 'source-weight' : 'manual'
  /* change 从"写死的方向/性质/标签"收敛为一句自由备注：可选、不做枚举校验、不参与强度计算。
     旧账本里的 {direction,nature,themeTag} 归一成 {note} 后仍能比对重放意图。 */
  const normalizeChange = (value) => {
    if (!value || typeof value !== 'object') return null
    const note = typeof value.note === 'string' ? value.note
      : (typeof value.themeTag === 'string' ? value.themeTag : '')
    return { note: note.trim().slice(0, 200) }
  }
  const change = decision === 'rejected' ? null : normalizeChange(input.change || recommendation.change)
  const targetNodeId = input.targetNodeId || recommendation.propositionId || null
  const relation = input.rel || recommendation.rel
  const reviewIntent = { decision, change, targetNodeId, rel: relation, title: String(input.title || '').trim(), weight: sourceWeight }
  if (priorReview) {
    const priorIntent = {
      decision: priorReview.payload.decision,
      change: normalizeChange(priorReview.payload.change),
      targetNodeId: priorReview.payload.targetNodeId || null,
      rel: priorReview.payload.rel || null,
      title: priorReview.payload.title || '',
      weight: weightOf(priorReview.payload.weight),
    }
    if (JSON.stringify(priorIntent) === JSON.stringify(reviewIntent)) return { ok: true, replayed: true, events: [], review: priorReview }
    throw new Error('该建议已有决定；不能通过重放改变已确认内容')
  }

  const statement = proposal.payload.statement
  const sourceQuote = String(statement.sourceText || '').trim()
  const sourceQuoteVerified = statement.sourceQuoteVerified === true
  const recommendationId = proposal.payload.recommendationId
  const stableId = (kind) => `evt:engine:${kind}:${digest({ themeId, recommendationId }).slice(0, 24)}`
  const drafts = []

  if (decision !== 'rejected') {
    if (!sourceQuote || !sourceQuoteVerified) throw new Error('原文摘录无法与来源核验，不能将它作为证据追加')
    /* 链接顺序与建设者判卡展示一致（renderer/lib/judge-queue.js proposalUrl）：建议里记的合格链接 →
       原条目当前的链接（建议早于补链接时；由主进程按 payload.inboxId 查出后传入 fallbackSourceUrl）→ 建议里记的原值。 */
    const recordedUrl = String(proposal.payload.sourceUrl || '').trim()
    const sourceUrl = sourceUrlOf(recordedUrl) ? recordedUrl : (sourceUrlOf(input?.fallbackSourceUrl) || recordedUrl)
    const validUrl = isHttpUrl(sourceUrl)
    const evidenceId = stableId('evidence')
    const sourceRef = `engine-recommendation:${recommendationId}`
    const sourceLabel = String(proposal.payload.sourceLabel || '').trim()
    const evidenceTargetNodeId = recommendation.kind === 'new-proposition' ? stableId('node') : targetNodeId
    const evidencePayload = {
      text: sourceQuote, sourceLabel, sourceKind: 'engine-reviewed', sourceRef,
      ...(evidenceTargetNodeId ? { targetNodeId: evidenceTargetNodeId } : {}),
      evidenceRefs: validUrl ? [{ type: 'url', id: sourceUrl, title: sourceLabel || sourceUrl }] : [],
      ...(change ? { change } : {}),
      recommendationId,
      ...(proposal.payload.sourcePublishedAt ? { sourcePublishedAt: proposal.payload.sourcePublishedAt } : {}),
      ...(proposal.payload.sourceFetchedAt ? { sourceFetchedAt: proposal.payload.sourceFetchedAt } : {}),
      ...(proposal.payload.ingestedAt ? { ingestedAt: proposal.payload.ingestedAt } : {}),
      ...(statement.timeWindow ? { applicability: statement.timeWindow } : {}),
      ...(validUrl ? { sourceUrl } : {}),
      ...(normalizePoints(proposal.payload.sourcePoints).length ? { points: normalizePoints(proposal.payload.sourcePoints) } : {}),
      ...(sourceWeight ? { weight: sourceWeight } : {}),
      scores: {
        ...(Number.isFinite(recommendation.matchScore) ? { matchScore: recommendation.matchScore } : {}),
        ...(Number.isFinite(recommendation.strength) ? { attributionStrength: recommendation.strength } : {}),
        ...(manualWeight != null ? { effectiveStrength: manualWeight, strengthSource }
          : (Number.isFinite(recommendation.effectiveStrength) ? { effectiveStrength: recommendation.effectiveStrength } : {})),
        ...(Number.isFinite(proposal.payload.metaMultiplier) ? { metaMultiplier: proposal.payload.metaMultiplier } : {}),
      },
    }

    if (recommendation.kind === 'new-proposition') {
      const title = String(input.title || recommendation.title || '').trim()
      if (!title || title.length > 180) throw new Error('新命题标题必须为 1–180 个字符')
      const nodeId = stableId('node')
      /* 观点以引擎算好的强度落账：estimateStrength 的结果（0-1）存成 0-100。
         没有这一步，后续 relation.declared 的强度更新会因 old == null 直接返回 null，
         观点永远停在"没有强度记录"——读者页的强度与强度曲线也就永远画不出来。
         只认 effectiveStrength：老事件里没有这个字段就保持 null，不拿 strength 冒充。 */
      /* 注意 Number(null) === 0：必须先判 null/undefined，否则"没有强度"会被写成"强度 0"。 */
      const rawEffective = manualWeight != null ? manualWeight : recommendation.effectiveStrength
      const initialConfidence = rawEffective == null || !Number.isFinite(Number(rawEffective))
        ? null
        : Math.round(Math.max(0, Math.min(1, Number(rawEffective))) * 100)
      drafts.push({ id: nodeId, actor: 'user', type: 'node.created', payload: {
        nodeType: 'viewpoint', title, detail: sourceQuote, status: 'pending',
        sourceKind: 'engine-reviewed', sourceRef,
        ...(initialConfidence == null ? {} : { confidence: initialConfidence }),
      } })
      drafts.push({ id: evidenceId, actor: 'user', type: 'evidence.appended', payload: evidencePayload })
      drafts.push({ id: stableId('relation'), actor: 'user', type: 'relation.declared', payload: {
        rel: 'supports', from: { eventId: evidenceId }, to: { eventId: nodeId },
        sourceKind: 'engine-reviewed', sourceRef, reason: '用户确认创建建议命题并关联可核验原文',
      } })
    } else {
      if (!['supports', 'contradicts', 'derives', 'supersedes', 'related'].includes(relation)) throw new Error('关系类型无效')
      const projection = projectEvents(events)
      const target = projection.nodes.find((node) => node.id === targetNodeId && !node.external
        && !node.archived && !node.invalidated && node.nodeType !== 'evidence')
      if (!target) throw new Error('请选择当前有效的目标观点')
      drafts.push({ id: evidenceId, actor: 'user', type: 'evidence.appended', payload: evidencePayload })
      if (relation === 'supersedes') {
        const { head } = claimLineage(events, target.id)
        drafts.push({ id: stableId('correction'), actor: 'user', type: 'correction.appended', supersedes: head, payload: {
        oldValue: String(target.currentText || target.title), newValue: sourceQuote,
        reason: String(recommendation.reason || '用户确认以新证据修正当前表述'),
        evidenceRefs: validUrl ? [{ type: 'url', id: sourceUrl, title: sourceLabel || sourceUrl }] : [],
        sourceKind: 'engine-reviewed', text: sourceQuote, sourceLabel,
        ...(validUrl ? { sourceUrl } : {}),
        ...(proposal.payload.sourcePublishedAt ? { sourcePublishedAt: proposal.payload.sourcePublishedAt } : {}),
        ...(proposal.payload.sourceFetchedAt ? { sourceFetchedAt: proposal.payload.sourceFetchedAt } : {}),
        ...(proposal.payload.ingestedAt ? { ingestedAt: proposal.payload.ingestedAt } : {}),
        ...(statement.timeWindow ? { applicability: statement.timeWindow } : {}),
          scores: evidencePayload.scores, evidenceEventId: evidenceId, recommendationId,
        } })
        drafts.push({ id: stableId('relation'), actor: 'user', type: 'relation.declared', payload: {
          rel: 'supersedes', from: { eventId: evidenceId }, to: { eventId: target.id },
          sourceKind: 'engine-reviewed', sourceRef, reason: String(recommendation.reason || '用户确认了版本修订关系'),
        } })
      } else {
        drafts.push({ id: stableId('relation'), actor: 'user', type: 'relation.declared', payload: {
          rel: relation, from: { eventId: evidenceId }, to: { eventId: target.id },
          ...(relation === 'derives' ? { reviewStatus: 'confirmed' } : {}),
          sourceKind: 'engine-reviewed', sourceRef, reason: String(recommendation.reason || ''),
        } })
      }
      if ((relation === 'supports' || relation === 'contradicts') && target.confidence != null && Number.isFinite(Number(target.confidence))) {
        const oldPercent = Number(target.confidence)
        const effectiveStrength = manualWeight != null ? manualWeight : estimateStrength({
          isHardFact: statement.type === 'hard', hasUrl: validUrl,
          attributionStrength: Number(recommendation.strength), metaMultiplier: Number(proposal.payload.metaMultiplier ?? 1),
        })
        const newFraction = updateConfidence(oldPercent / 100, effectiveStrength, relation)
        const newPercent = newFraction == null ? oldPercent : Math.round(newFraction * 100)
        if (newPercent !== oldPercent) drafts.push({ id: stableId('confidence'), actor: 'user', type: 'confidence.updated', payload: {
          nodeId: target.id, oldConfidence: oldPercent, newConfidence: newPercent,
          strength: effectiveStrength, attributionStrength: recommendation.strength,
          strengthSource: manualWeight != null ? strengthSource : 'engine',
          reason: `${relation === 'supports' ? '支持' : '反驳'}证据：${sourceQuote.slice(0, 50)}`,
          evidenceEventId: evidenceId,
        } })
      }
    }
  }

  const reviewPayload = {
    signalEventId: proposal.id, decision,
    ...(change ? { change } : {}),
    ...(targetNodeId ? { targetNodeId } : {}),
    ...(relation ? { rel: relation } : {}),
    ...(String(input.title || '').trim() ? { title: String(input.title).trim() } : {}),
    ...(sourceWeight ? { weight: sourceWeight } : {}),
  }
  drafts.push({ id: stableId('review'), actor: 'user', type: 'signal.reviewed', payload: reviewPayload })
  const appended = appendEventBatch(themeId, drafts)
  return { ok: true, replayed: false, events: appended.filter((event) => !event.replayed), review: appended.at(-1) }
}

/**
 * 建设者「判」：对一条待判证据下结论，一个批次原子追加。
 * - 佐证 / 反对：relation.declared（证据 → 原子）+ signal.reviewed(accepted, targetNodeId)；原子有强度时按手工补证同一公式更新；
 * - 中立：只写 signal.reviewed(accepted, targetNodeId)——证据挂到原子上、没有表态边，就是中立；
 * - 不相关：signal.reviewed(rejected)，证据从此不计入任何原子。
 * 证据身上已有的佐证 / 反驳边：与结论一致的保留（待复核则追加确认，不重复声明、不重复更新强度），其余追加驳回。
 * 只接 evidenceJudgeState 认定的待判证据；事件 id 由 (主题, 证据) 决定，同一结论重放返回 replayed，不同结论拒绝。
 */
export function judgeEvidence(themeId, evidenceId, input = {}) {
  const stance = String(input?.stance || '')
  if (!JUDGE_STANCES.includes(stance)) throw new Error('请选择佐证、反对、中立或不相关')
  const events = getEvents(themeId)
  const stableId = (kind) => `evt:judge:${kind}:${digest({ themeId, evidenceId: String(evidenceId) }).slice(0, 24)}`
  const atomId = stance === 'irrelevant' ? null : String(input?.atomId || '').trim() || null
  if (input?.weight != null && !weightOf(input.weight)) throw new Error('权重无效：请选择来源类型与硬度')
  const projection = projectEvents(events)
  const evidence = projection.nodes.find((node) => node.id === evidenceId && node.nodeType === 'evidence' && !node.external)
  /* 权重：判的时候给了 { 来源类型, 硬度 } 就用它；没给就用证据当前的权重（进主题时的建议 / 旧数据按同一规则现算）。
     判过之后投影里的权重就是判定时的那个，所以同一结论不带权重重放时仍然一致。不相关不记权重。 */
  const weight = atomId && evidence ? weightOf(input?.weight) || evidenceWeightOf(evidence).weight : null
  const reviewPayload = {
    signalEventId: String(evidenceId),
    decision: stance === 'irrelevant' ? 'rejected' : 'accepted',
    ...(atomId ? { targetNodeId: atomId, rel: stance } : {}),
    ...(weight ? { weight } : {}),
    reason: '建设者判定',
  }
  const priorReview = events.find((event) => event.id === stableId('review'))
  if (priorReview) {
    if (JSON.stringify(priorReview.payload) === JSON.stringify(reviewPayload)) return { ok: true, replayed: true, events: [] }
    throw new Error('这条证据已经判过；如需改判，请追加更正')
  }

  if (!evidence) throw new Error('找不到这条证据')
  if (evidence.archived || evidence.invalidated) throw new Error('这条证据已归档或失效')
  if (!evidenceJudgeState(evidence, projection.edges)) throw new Error('这条证据已经判过；如需改判，请追加更正')

  const drafts = []
  const atom = stance === 'irrelevant' ? null : projection.nodes.find((node) => node.id === atomId && !node.external
    && !node.archived && !node.invalidated && node.nodeType !== 'evidence')
  if (stance !== 'irrelevant' && !atom) throw new Error('请选择一个未归档、未失效的原子')
  /* 待复核证据身上可能带着旧的佐证 / 反驳边（同样只是建议）。判定即定论：与结论一致的那条保留
     （仍待复核就追加确认，不再重复声明），其余一律追加驳回——否则改判后旧原子上会残留一条表态。 */
  const stanceEdges = projection.edges.filter((edge) => edge.from === evidence.id && STANCE_RELS.has(edge.rel)
    && edge.reviewDecision !== 'rejected')
  const kept = atom && STANCE_RELS.has(stance) ? stanceEdges.find((edge) => edge.rel === stance && edge.to === atom.id) || null : null
  const eventById = new Map(events.map((event) => [event.id, event]))
  const reviewEdge = (edge, decision) => {
    const original = eventById.get(edge.eventId)?.payload || {}
    drafts.push({
      id: `evt:judge:edge-review:${digest({ themeId, evidenceId: String(evidenceId), edge: edge.eventId }).slice(0, 24)}`,
      actor: 'user', type: 'relation.declared', payload: {
        rel: edge.rel, from: copyValue(original.from), to: copyValue(original.to),
        reviewStatus: 'pending-review', reviewOf: edge.eventId, reviewDecision: decision,
        decisionReason: decision === 'rejected' ? '建设者判定为其他结论' : '建设者判定',
        sourceKind: 'user-judged', sourceRef: `judge:${evidence.id}`,
      },
    })
  }
  for (const edge of stanceEdges) {
    if (edge !== kept) reviewEdge(edge, 'rejected')
    else if (edge.pendingReview) reviewEdge(edge, 'confirmed')
  }
  if (atom) {
    if (STANCE_RELS.has(stance) && !kept) {
      drafts.push({ id: stableId('relation'), actor: 'user', type: 'relation.declared', payload: {
        rel: stance, from: { eventId: evidence.id }, to: { eventId: atom.id },
        sourceKind: 'user-judged', sourceRef: `judge:${evidence.id}`,
      } })
      if (atom.confidence != null && Number.isFinite(Number(atom.confidence))) {
        const oldPercent = Number(atom.confidence)
        const strength = weight.value
        const newFraction = updateConfidence(oldPercent / 100, strength, stance)
        const newPercent = newFraction == null ? oldPercent : Math.round(newFraction * 100)
        if (newPercent !== oldPercent) drafts.push({ id: stableId('confidence'), actor: 'user', type: 'confidence.updated', payload: {
          nodeId: atom.id, oldConfidence: oldPercent, newConfidence: newPercent, strength, strengthSource: 'source-weight',
          reason: `${stance === 'supports' ? '支持' : '反驳'}证据：${String(evidence.currentText || evidence.title || '').slice(0, 50)}`,
          evidenceEventId: evidence.id,
        } })
      }
    }
  }
  drafts.push({ id: stableId('review'), actor: 'user', type: 'signal.reviewed', payload: reviewPayload })
  const appended = appendEventBatch(themeId, drafts)
  return { ok: true, replayed: false, events: appended.filter((event) => !event.replayed) }
}

/** Declare a user-authored semantic edge; this records a relationship, not verified causality. */
export function declareProjectedRelation(themeId, fromNodeId, toNodeId, rel) {
  if (!REL_TYPES.includes(rel)) throw new Error('请选择有效的关系类型')
  if (rel === 'supersedes') throw new Error('版本修订关系必须与观点更正事件一并追加')
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) throw new Error('请选择两个不同的节点')
  const nodes = projectEvents(getEvents(themeId)).nodes
  const from = nodes.find((node) => node.id === fromNodeId && !node.external && !node.archived && !node.invalidated)
  const to = nodes.find((node) => node.id === toNodeId && !node.external && !node.archived && !node.invalidated)
  if (!from || !to) throw new Error('关系端点必须是当前未归档的图谱节点')
  const projection = projectEvents(getEvents(themeId))
  if (projection.edges.some((edge) => edge.rel === rel && edge.from === fromNodeId && edge.to === toNodeId
    && edge.reviewDecision !== 'rejected')) {
    throw new Error('这条关系已经存在')
  }
  return appendEvent(themeId, {
    actor: 'user',
    type: 'relation.declared',
    payload: {
      rel,
      from: { eventId: fromNodeId },
      to: { eventId: toNodeId },
      ...(rel === 'derives' ? { reviewStatus: 'pending-review' } : {}),
      sourceKind: ['supports', 'derives', 'contradicts'].includes(rel) ? 'user-declared-argument' : 'user-declared-association',
      sourceRef: `relation:${fromNodeId}:${toNodeId}`,
    },
  })
}

/** Record a human decision as a new relation.declared event; never edit the original edge. */
export function reviewProjectedRelation(themeId, relationEventId, decision, reason) {
  if (!['confirmed', 'rejected'].includes(decision)) throw new Error('请选择确认或驳回')
  const decisionReason = String(reason || '').trim()
  if (!decisionReason) throw new Error('请填写复核理由')
  const events = getEvents(themeId)
  const original = events.find((event) => event.id === relationEventId
    && event.type === 'relation.declared' && !event.payload?.reviewOf
    && (event.payload?.reviewStatus === 'pending-review' || event.payload?.rel === 'derives'))
  if (!original) throw new Error('找不到待复核关系')
  if (events.some((event) => event.type === 'relation.declared' && event.payload?.reviewOf === relationEventId)) {
    throw new Error('该关系已有复核决定；如需改变判断，请追加一条新的关系声明')
  }
  return appendEvent(themeId, {
    actor: 'user',
    type: 'relation.declared',
    payload: {
      rel: original.payload.rel,
      from: copyValue(original.payload.from),
      to: copyValue(original.payload.to),
      reviewStatus: 'pending-review',
      reviewOf: original.id,
      reviewDecision: decision,
      decisionReason,
      sourceKind: 'relation-review',
      sourceRef: original.payload.sourceRef || `event:${original.id}`,
    },
  })
}

/** Restore a node and any archived descendants in one atomic append batch. */
export function restoreProjectedNodes(themeId, sourceRefs = [], reason = '') {
  const requested = [...new Set((sourceRefs || []).filter((ref) => typeof ref === 'string' && ref))]
  if (!requested.length) throw new Error('sourceRef 无效')
  const nodes = projectEvents(getEvents(themeId)).nodes
  const targets = requested.map((sourceRef) => nodes.find((n) => !n.external && n.sourceRef === sourceRef && n.archived)).filter(Boolean)
  if (!targets.length || !targets.some((n) => n.sourceRef === requested[0])) throw new Error('该节点当前未归档')
  return appendEventBatch(themeId, targets.map((node) => ({
    actor: 'user',
    type: 'node.restored',
    payload: {
      sourceRef: node.sourceRef,
      reason: String(reason || '').trim(),
      restoredArchiveEventId: [...(node.archiveEventIds || [])].at(-1) || null,
      title: node.title,
    },
  })))
}

/** Archive changes only the current projection; no source claim or confidence is rewritten. */
export function archiveProjectedNode(themeId, sourceRef, reason = '') {
  if (!sourceRef || typeof sourceRef !== 'string') throw new Error('sourceRef 无效')
  const node = projectEvents(getEvents(themeId)).nodes.find((n) => !n.external && n.sourceRef === sourceRef)
  if (!node) throw new Error('节点不存在')
  if (node.archived) throw new Error('该节点已归档')
  return appendEvent(themeId, {
    actor: 'user',
    type: 'node.archived',
    payload: {
      sourceRef,
      title: node.title,
      reason: String(reason || '').trim(),
      evidenceCount: node.evidenceCount || 0,
      archivedAt: new Date().toISOString(),
    },
  })
}

/** 冷冻外部数据：只改投影 cold/status，不碰置信度；可在侧栏冷库解冻。 */
export function parkProjectedNode(themeId, sourceRef, reason = '') {
  if (!sourceRef || typeof sourceRef !== 'string') throw new Error('sourceRef 无效')
  const node = projectEvents(getEvents(themeId)).nodes.find((n) => !n.external && n.sourceRef === sourceRef)
  if (!node) throw new Error('节点不存在')
  if (node.archived) throw new Error('已归档的数据请先恢复再冷冻，或直接留在归档')
  if (node.cold) throw new Error('该数据已在冷库')
  if (node.nodeType !== 'evidence') throw new Error('冷冻只针对外部数据（证据）')
  return appendEvent(themeId, {
    actor: 'user',
    type: 'node.parked',
    payload: {
      sourceRef,
      title: node.title,
      reason: String(reason || '').trim(),
      parkedAt: new Date().toISOString(),
    },
  })
}

/** 解冻：追加 node.unparked，不改写冷冻历史。 */
export function unparkProjectedNode(themeId, sourceRef, reason = '') {
  if (!sourceRef || typeof sourceRef !== 'string') throw new Error('sourceRef 无效')
  const node = projectEvents(getEvents(themeId)).nodes.find((n) => !n.external && n.sourceRef === sourceRef)
  if (!node) throw new Error('节点不存在')
  if (!node.cold) throw new Error('该数据不在冷库')
  return appendEvent(themeId, {
    actor: 'user',
    type: 'node.unparked',
    payload: {
      sourceRef,
      title: node.title,
      reason: String(reason || '').trim() || '从冷库解冻',
      unparkedAt: new Date().toISOString(),
    },
  })
}

/**
 * 建设者判卡「归档 / 冷冻」：维度是外部数据。
 * - evidence（pending/unmapped）：直接 archive / park
 * - proposal：驳回建议 + 落入未挂原子证据 + 立刻 archive / park（一条批次，队列立刻清空该项）
 */
export function shelfJudgeItem(themeId, input = {}) {
  const mode = input.mode === 'park' ? 'park' : input.mode === 'archive' ? 'archive' : null
  if (!mode) throw new Error('请选择归档或冷冻')
  const reason = String(input.reason || '').trim()
  if (mode === 'archive' && !reason) throw new Error('请填写归档原因')
  const kind = String(input.kind || '')
  const id = String(input.id || '').trim()
  if (!id) throw new Error('缺少条目')

  if (kind === 'pending' || kind === 'unmapped' || kind === 'evidence') {
    const projection = projectEvents(getEvents(themeId))
    const evidence = projection.nodes.find((node) => node.id === id && node.nodeType === 'evidence' && !node.external)
    if (!evidence) throw new Error('找不到这条外部数据')
    const sourceRef = evidence.sourceRef || `event:${evidence.id}`
    const event = mode === 'archive'
      ? archiveProjectedNode(themeId, sourceRef, reason)
      : parkProjectedNode(themeId, sourceRef, reason)
    return { ok: true, mode, kind: 'evidence', sourceRef, event }
  }

  if (kind !== 'proposal') throw new Error('只能归档或冷冻外部数据')

  const events = getEvents(themeId)
  const proposal = events.find((event) => event.id === id && event.type === 'engine.recommendation.proposed')
  if (!proposal) throw new Error('找不到这条模型建议')
  if (events.some((event) => event.type === 'signal.reviewed' && event.payload?.signalEventId === proposal.id)) {
    throw new Error('这条建议已有决定，不能再归档或冷冻')
  }
  const recommendationId = proposal.payload?.recommendationId || proposal.id
  const stableId = (suffix) => `evt:shelf:${suffix}:${digest({ themeId, recommendationId, mode }).slice(0, 24)}`
  const quote = String(proposal.payload?.statement?.sourceText || proposal.payload?.recommendation?.title || '').trim()
    || '（无引文的外部数据）'
  const sourceRef = `shelved-proposal:${recommendationId}`
  const sourceUrl = sourceUrlOf(proposal.payload?.sourceUrl) || sourceUrlOf(input.fallbackSourceUrl) || ''
  const sourceLabel = String(proposal.payload?.sourceLabel || '').trim()
  const evidenceId = stableId('evidence')
  const drafts = [
    {
      id: evidenceId, actor: 'user', type: 'evidence.appended',
      payload: {
        text: quote,
        sourceLabel,
        sourceKind: 'shelved-proposal',
        sourceRef,
        ...(sourceUrl ? { sourceUrl, evidenceRefs: [{ type: 'url', id: sourceUrl, title: sourceLabel || sourceUrl }] } : { evidenceRefs: [] }),
        ...(proposal.payload?.sourcePublishedAt ? { sourcePublishedAt: proposal.payload.sourcePublishedAt } : {}),
        ...(proposal.payload?.ingestedAt ? { ingestedAt: proposal.payload.ingestedAt } : {}),
        ...(normalizePoints(proposal.payload?.sourcePoints).length ? { points: normalizePoints(proposal.payload.sourcePoints) } : {}),
      },
    },
    {
      id: stableId('review'), actor: 'user', type: 'signal.reviewed',
      payload: { signalEventId: proposal.id, decision: 'rejected', reason: mode === 'park' ? '冷冻入库' : '归档' },
    },
    {
      id: stableId(mode), actor: 'user',
      type: mode === 'archive' ? 'node.archived' : 'node.parked',
      payload: mode === 'archive'
        ? { sourceRef, title: quote.slice(0, 180), reason, evidenceCount: 0, archivedAt: new Date().toISOString() }
        : { sourceRef, title: quote.slice(0, 180), reason, parkedAt: new Date().toISOString() },
    },
  ]
  const appended = appendEventBatch(themeId, drafts)
  return { ok: true, mode, kind: 'proposal', sourceRef, events: appended }
}

/** 冷库浏览：主题投影里 cold 的外部证据（不触发迁移）。 */
export function getParkedProjectionNodes(themeId) {
  const projection = projectEvents(getEvents(themeId))
  return {
    themeId,
    nodes: projection.nodes.filter((n) => n.cold && n.nodeType === 'evidence' && !n.archived && !n.external),
    edges: projection.edges,
  }
}

/**
 * 收件箱提案草稿 → 事件账本（P2：挂载流跟上新模型）。
 *
 * 旧 mountToChain 写 theme.chain.segments；新挂载只追加事件：
 * - 名字命中已有主张 → 有明确证据文本/来源引用时追加 evidence.appended + relation.declared(supports)，
 *   若 newValue 与当前值不同再追 correction.appended
 * - 名字是新的 → claim.created；有明确证据文本/来源引用时再追加证据与 supports
 * 不创建 ledger node，不碰 lemma/confidence（公理1）。
 */
export function mountDraftToEvents(themeId, payload = {}) {
  const names = [...(payload.segmentNames || []), payload.newSegmentName]
    .map((s) => String(s || '').trim()).filter(Boolean)
  const unique = [...new Set(names)]
  if (!unique.length) throw new Error('请选择或输入要挂载的主张')

  const rawEvidenceRefs = [
    ...(payload.inboxId ? [{ type: 'inbox', id: payload.inboxId, title: payload.inboxTitle || '' }] : []),
    ...(Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : []),
    /* url 类 ref 不允许脏协议（P0-2）；其余类型与普通标识符照旧保留。 */
  ].filter((ref) => !isObj(ref) || ref.type !== 'url' || !isDirtyUrlRef(ref.id))
  // Keep the old deterministic identity available for already-written inbox mounts.
  const legacyEvidenceRefs = [...new Map(rawEvidenceRefs
    .filter((r) => isObj(r) && r.type && r.id)
    .map((r) => [`${r.type}:${r.id}`, r])).values()]
  const evidenceRefs = uniqueEvidenceRefs(rawEvidenceRefs)
  const newValue = String(payload.newValue ?? '').trim()
  const evidenceText = String(payload.evidence || '').trim()
  const hasEvidence = !!evidenceText || evidenceRefs.length > 0

  const priorEvents = getEvents(themeId)
  const drafts = []
  const touched = []
  const eventId = (kind, semantic) => `evt:mount:${digest({ themeId, inboxId: payload.inboxId || null, kind, semantic }).slice(0, 32)}`
  const intentExists = (id) => [...priorEvents, ...drafts].some((event) => event?.id === id)
  const addReplayDraft = (event) => drafts.push({
    id: event.id, actor: event.actor, type: event.type, payload: copyValue(event.payload),
    supersedes: event.supersedes ?? null,
  })
  const addSupport = (evidenceId, claimId) => {
    const fresh = [...priorEvents, ...drafts]
    const exists = fresh.some((event) => event.type === 'relation.declared'
      && !event.payload?.reviewOf && event.payload?.rel === 'supports'
      && event.payload?.from?.eventId === evidenceId && event.payload?.to?.eventId === claimId)
    const supportId = payload.inboxId
      ? eventId('support', { evidenceId, claimId }) : `evt:mount:${randomUUID()}`
    const replay = fresh.find((event) => event.id === supportId)
    if (replay) { addReplayDraft(replay); return }
    if (exists) return
    drafts.push({
      id: supportId, actor: 'user', type: 'relation.declared',
      payload: {
        rel: 'supports', from: { eventId: evidenceId }, to: { eventId: claimId },
        sourceKind: 'mount', sourceRef: payload.inboxId ? `inbox:${payload.inboxId}` : `mount:${evidenceId}`,
      },
    })
  }

  for (const name of unique) {
    // 按标题找现存主张（未归档、非外部）
    const proj = projectEvents([...priorEvents, ...drafts])
    let node = proj.nodes.find(
      (n) => (n.kind === 'claim' || n.kind === 'inference') && !n.archived && !n.external && n.title === name)
    let claimId
    if (!node) {
      claimId = payload.inboxId
        ? eventId('claim', { name })
        : `evt:mount:${randomUUID()}`
      drafts.push({
        id: claimId, actor: 'user', type: 'claim.created',
        payload: {
          nodeKind: 'claim', claimType: 'segment', title: name,
          coreInfo: String(payload.coreInfo || ''), falsifier: String(payload.falsifier || ''),
          confidence: null, status: 'pending',
          sourceKind: 'segment', sourceRef: payload.inboxId ? `mount:${payload.inboxId}:${name}` : `mount:${claimId}`,
        },
      })
    } else {
      claimId = node.id
    }
    touched.push(name)

    if (hasEvidence) {
      const fresh = [...priorEvents, ...drafts]
      const legacyStableId = payload.inboxId
        ? eventId('evidence', { name, evidenceText, evidenceRefs: legacyEvidenceRefs }) : null
      const existingReplay = legacyStableId && fresh.find((event) => event.id === legacyStableId
        && event.type === 'evidence.appended')
      const byRef = new Map()
      for (const event of fresh) {
        if (event.type !== 'evidence.appended') continue
        for (const ref of uniqueEvidenceRefs(event.payload?.evidenceRefs || [])) {
          const key = evidenceRefKey(ref)
          if (key && !byRef.has(key)) byRef.set(key, event.id)
        }
      }

      let evidenceIds = []
      if (existingReplay) {
        addReplayDraft(existingReplay)
        evidenceIds = [existingReplay.id]
      } else {
        const referencedIds = [...new Set(evidenceRefs.map((ref) => byRef.get(evidenceRefKey(ref))).filter(Boolean))]
        const unseenRefs = evidenceRefs.filter((ref) => !byRef.has(evidenceRefKey(ref)))
        evidenceIds = [...new Set(referencedIds)]

        // A repeated source ref reuses its first event; prose alone is not an
        // identity key, so each intentional evidence append remains auditable.
        const createEvidence = unseenRefs.length > 0 || Boolean(evidenceText)
        if (createEvidence) {
          const refsForNewEvent = unseenRefs
          const semantic = { name, evidenceText, evidenceRefs }
          const stableId = payload.inboxId
            ? eventId('evidence', semantic) : `evt:mount:${randomUUID()}`
          const evidencePayload = {
            text: evidenceText, reason: String(payload.evidence || ''),
            evidenceRefs: refsForNewEvent, sourceKind: 'mount',
            sourceRef: payload.inboxId ? `inbox:${payload.inboxId}` : `mount:${stableId}`,
            /* 出处随事件走（P0-1）：收件箱条目有 30 天 TTL，账本不能靠它活着。
               快照/回放从投影出发也要拿得到 URL（P0-3 依赖这些字段落进 payload）。 */
            ...(isHttpUrl(payload.sourceUrl) ? { sourceUrl: String(payload.sourceUrl).trim() } : {}),
            ...(String(payload.sourceLabel || '').trim() ? { sourceLabel: String(payload.sourceLabel).trim() } : {}),
            ...(payload.sourcePublishedAt ? { sourcePublishedAt: payload.sourcePublishedAt } : {}),
            ...(payload.sourceFetchedAt ? { sourceFetchedAt: payload.sourceFetchedAt } : {}),
            ...(payload.ingestedAt ? { ingestedAt: payload.ingestedAt } : {}),
            ...(String(payload.applicability || '').trim() ? { applicability: String(payload.applicability).trim().slice(0, 160) } : {}),
          }
          /* 三层演化数据：如果 payload 带有 change，直接写入事件 */
          if (payload.change && typeof payload.change === 'object') {
            const ch = payload.change
            if (['improving', 'declining', 'stable'].includes(ch.direction)) {
              evidencePayload.change = {
                direction: ch.direction,
                nature: ['quantitative', 'pivot', 'epistemic', 'structural'].includes(ch.nature) ? ch.nature : 'quantitative',
                themeTag: (typeof ch.themeTag === 'string' ? ch.themeTag : '').slice(0, 20),
              }
            }
          }
          const oldStableEvent = payload.inboxId && fresh.find((event) => event.id === stableId)
          if (oldStableEvent) addReplayDraft(oldStableEvent)
          else drafts.push({ id: stableId, actor: 'user', type: 'evidence.appended', payload: evidencePayload })
          evidenceIds.push(stableId)
        }
      }
      for (const evidenceId of new Set(evidenceIds)) addSupport(evidenceId, claimId)
    }

    if (newValue) {
      const fresh = [...priorEvents, ...drafts]
      const { head } = claimLineage(fresh, claimId)
      const headEvent = [...fresh].reverse().find((e) => e.id === head)
      const hp = headEvent?.payload || {}
      const curText = String(headEvent?.type === 'correction.appended' ? hp.newValue : hp.coreInfo || hp.title || '').trim()
      if (curText !== newValue) {
        drafts.push({
          id: payload.inboxId ? eventId('correction', { claimId, newValue, reason: String(payload.evidence || '') }) : `evt:mount:${randomUUID()}`,
          actor: 'user', type: 'correction.appended', supersedes: head,
          payload: {
            oldValue: curText, newValue, reason: String(payload.evidence || ''),
            evidenceRefs, sourceKind: 'mount',
          },
        })
      }
    }
  }
  const appended = appendEventBatch(themeId, drafts)
  const stableIntentIds = unique.flatMap((name) => [
    ...(payload.inboxId ? [eventId('claim', { name })] : []),
  ])
  const replayed = appended.length
    ? appended.every((event) => event.replayed)
    : Boolean(payload.inboxId && stableIntentIds.some(intentExists))
  return { ok: true, events: appended.filter((e) => !e.replayed).length, claims: touched,
    replayed }
}
