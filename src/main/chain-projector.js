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
 * - topic.linked → 主题归属隐含在事件 themeId 中，投影不单独成边
 *
 * 端点解析：{eventId} → 对应节点；{ref} → 已有节点或外部证据节点；
 * {name} → 按标题找主张节点，找不到则为外部节点。
 */
import { getEvents, appendEvent, appendEvents as appendEventBatch, hasUnmigratedNodeSources, migrateThemeToEvents, verifyChain, NODE_TYPES, REL_TYPES } from './chain-events.js'
import { updateConfidence, estimateStrength } from './engine-confidence.js'
import { digest } from './reading-store.js'
import { randomUUID } from 'node:crypto'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const copyValue = (v) => JSON.parse(JSON.stringify(v ?? null))

function evidenceRefKey(ref) {
  if (!isObj(ref) || !ref.type || !ref.id) return null
  return JSON.stringify([String(ref.type).trim(), String(ref.id).trim()])
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
    const node = addNode({
      id: e.id,
      kind: 'evidence',
      nodeType: 'evidence',
      title: shortTitle(p.text || p.reason || '证据'),
      status: 'pending',
      confidence: null,
      correct: null,
      resolved: null,
      archived: false,
      superseded: false,
      createdSeq: e.seq,
      currentText: p.text || p.reason || '',
      sourceKind: p.sourceKind || null,
      sourceRef: p.sourceRef || null,
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
      const lastCorrection = byId.get(head)
      node.superseded = true
      const p = lastCorrection?.payload || {}
      if (String(p.newValue ?? '').trim()) node.currentText = String(p.newValue)
      node.correctionReason = p.reason || ''
    }
  }

  // Renames and invalidations alter only projections at/after their event; the
  // append-only event list remains the authoritative name and validity history.
  for (const e of events) {
    if (e.type !== 'node.renamed' && e.type !== 'node.invalidated') continue
    const p = e.payload || {}
    for (const node of nodes.values()) {
      if (node.external || node.id !== p.nodeId || node.sourceRef !== p.sourceRef) continue
      node.provenanceEventIds ||= [...node.eventIds]
      if (!node.provenanceEventIds.includes(e.id)) node.provenanceEventIds.push(e.id)
      if (!node.eventIds.includes(e.id)) node.eventIds.push(e.id)
      if (e.type === 'node.renamed') {
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
      relationGroup: ['supports', 'derives', 'contradicts'].includes(p.rel) ? 'argument' : 'association',
      from,
      to,
      pendingReview: p.reviewStatus === 'pending-review' || p.rel === 'derives',
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

  for (const node of nodes.values()) {
    const evidenceIds = edges.filter((edge) => edge.rel === 'supports'
      && edge.reviewDecision !== 'rejected'
      && (edge.from === node.id || edge.to === node.id))
      .map((edge) => edge.from === node.id ? edge.to : edge.from)
      .filter((id) => nodes.get(id)?.kind === 'evidence')
    node.evidenceCount = new Set(evidenceIds).size
  }

  // 结算 / 归档 / 恢复：按 sourceRef 找到节点，状态只由追加事件顺序决定。
  for (const e of events) {
    if (!['settlement.recorded', 'node.archived', 'node.restored'].includes(e.type)) continue
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
      } else if (e.type === 'confidence.updated') {
        /* 置信度更新（红区已批准）：记录历史，更新当前值 */
        node.confidenceHistory ||= []
        node.confidenceHistory.push({
          eventId: e.id, seq: e.seq, at: e.at,
          oldConfidence: p.oldConfidence ?? null,
          newConfidence: p.newConfidence ?? null,
          reason: p.reason || '',
          evidenceEventId: p.evidenceEventId || null,
        })
        if (Number.isFinite(p.newConfidence)) node.confidence = p.newConfidence
      } else if (e.type === 'node.archived') {
        node.archived = true
        node.archiveReason = p.reason || ''
        node.archivedAt = p.archivedAt || e.at || null
        node.archiveEventIds ||= []
        node.archiveEventIds.push(e.id)
      } else {
        node.archived = false
        node.restoredAt = e.at || null
        node.restoreEventIds ||= []
        node.restoreEventIds.push(e.id)
      }
    }
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
  let integrity = verifyChain(themeId)
  if (migrateLegacy && integrity.ok && (events.length === 0 || hasUnmigratedNodeSources(themeId))) {
    const { created } = migrateThemeToEvents(themeId)
    if (created > 0) {
      events = getEvents(themeId)
      integrity = verifyChain(themeId)
    }
  }
  return projectionResult(themeId, events, integrity)
}

function projectionResult(themeId, events, integrity, history = null) {
  const safeEvents = integrity.ok ? events : events.slice(0, integrity.lastValidSeq || 0)
  const projection = projectEvents(safeEvents)
  const scope = chainScope(projection)
  return {
    themeId,
    eventCount: events.length,
    integrity,
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
  const integrity = verifyChain(themeId)
  const validPrefixSeq = integrity.ok ? events.length : (integrity.lastValidSeq || 0)
  const selectedSeq = Math.max(0, Math.min(validPrefixSeq, sequence))
  const replayEvents = events.slice(0, selectedSeq)
  const replayIntegrity = { ...integrity, replayed: true, selectedSeq, validPrefixSeq }
  return projectionResult(themeId, replayEvents, replayIntegrity, {
    replayed: true,
    selectedSeq,
    requestedSeq: sequence,
    validPrefixSeq,
    selectedAt: selectedSeq ? replayEvents.at(-1)?.at || null : null,
  })
}

/** Archive browsing is deliberately read-only and does not trigger legacy migration. */
export function getArchivedProjectionNodes(themeId) {
  const events = getEvents(themeId)
  const integrity = verifyChain(themeId)
  const safeEvents = integrity.ok ? events : events.slice(0, integrity.lastValidSeq || 0)
  const projection = projectEvents(safeEvents)
  return {
    themeId,
    integrity,
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
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
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
    },
  })
}

/** Rename a live node by appending both old and new display names. */
export function renameProjectedNode(themeId, nodeId, newTitle, reason = '') {
  const title = String(newTitle || '').trim()
  if (!title || title.length > 180) throw new Error('新名称必须为 1–180 个字符')
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
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

/** Mark a node invalid by appending an event; it remains visible as a historical ghost. */
export function invalidateProjectedNode(themeId, nodeId, reason = '') {
  const invalidationReason = String(reason || '').trim()
  if (!invalidationReason) throw new Error('请填写失效原因')
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
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
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
  const target = projectEvents(getEvents(themeId)).nodes.find((node) => node.id === targetNodeId
    && !node.external && !node.archived && !node.invalidated && node.nodeType !== 'evidence')
  if (!target) throw new Error('请选择一个未归档、未失效的非证据节点')

  const evidenceId = `evt:evidence:${randomUUID()}`
  const sourceRef = `manual-evidence:${evidenceId}`
  const sourceUrl = String(input.url || '').trim()
  const evidenceRefs = sourceUrl
    ? [{ type: 'url', id: sourceUrl, title: String(input.sourceLabel || '').trim() || sourceUrl }]
    : []
  const reason = String(input.reason || '').trim()
  const events = [
    {
      id: evidenceId,
      actor: 'user',
      type: 'evidence.appended',
      payload: { text, sourceLabel: String(input.sourceLabel || '').trim(), sourceKind: 'manual-evidence', sourceRef, evidenceRefs },
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

/** Declare a user-authored semantic edge; this records a relationship, not verified causality. */
export function declareProjectedRelation(themeId, fromNodeId, toNodeId, rel) {
  if (!REL_TYPES.includes(rel)) throw new Error('请选择有效的关系类型')
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) throw new Error('请选择两个不同的节点')
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
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
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
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
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
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
  const integrity = verifyChain(themeId)
  if (!integrity.ok) throw new Error(`事件账本校验失败：${integrity.reason}`)
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
  ]
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
