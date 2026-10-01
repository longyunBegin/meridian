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
import { getEvents, appendEvent, appendEvents as appendEventBatch, hasUnmigratedNodeSources, migrateThemeToEvents, verifyChain } from './chain-events.js'
import { digest } from './reading-store.js'
import { randomUUID } from 'node:crypto'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function shortTitle(s, n = 28) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
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

  // 主张 / 推断节点
  for (const e of events) {
    if (e.type !== 'claim.created' && e.type !== 'inference.created') continue
    const p = e.payload || {}
    const node = addNode({
      id: e.id,
      kind: e.type === 'inference.created' ? 'inference' : 'claim',
      title: p.title || '未命名',
      status: p.status || 'pending',
      confidence: p.confidence ?? null,
      correct: null,
      resolved: null,
      archived: false,
      superseded: false,
      currentText: p.coreInfo || p.title || '',
      sourceKind: p.sourceKind || null,
      sourceRef: p.sourceRef || null,
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
      title: shortTitle(p.text || p.reason || '证据'),
      status: 'pending',
      confidence: null,
      correct: null,
      resolved: null,
      archived: false,
      superseded: false,
      currentText: p.text || p.reason || '',
      sourceKind: p.sourceKind || null,
      sourceRef: p.sourceRef || null,
      eventIds: [e.id],
      provenanceEventIds: [e.id],
      external: false,
    })
    nodeOfEvent.set(e.id, node.id)
  }

  // 更正链：沿 supersedes 找到每条主张的最新版本
  for (const e of events) {
    if (e.type !== 'claim.created' && e.type !== 'inference.created') continue
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

  // 外部证据节点（relation 端点引用了账本外对象时）
  const externalNode = (key, title, eventId) => {
    const node = addNode({
      id: key,
      kind: 'evidence',
      title: shortTitle(title || key),
      status: 'pending',
      confidence: null,
      correct: null,
      resolved: null,
      archived: false,
      superseded: false,
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
        if ((n.kind === 'claim' || n.kind === 'inference') && !n.external && n.title === ep.name) return n.id
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
    if (!['supports', 'derives', 'contradicts'].includes(p.rel)) continue
    const from = resolveEndpoint(p.from, e.id)
    const to = resolveEndpoint(p.to, e.id)
    if (!from || !to || from === to) continue
    edges.push({
      id: e.id,
      rel: p.rel,
      from,
      to,
      pendingReview: p.reviewStatus === 'pending-review',
      mapping: p.mapping || '',
      eventId: e.id,
      provenanceEventIds: [e.id],
      sourceRef: p.sourceRef || `event:${e.id}`,
    })
  }

  for (const node of nodes.values()) {
    const evidenceIds = edges.filter((edge) => edge.rel === 'supports'
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

  return { nodes: [...nodes.values()], edges }
}

/**
 * 链视图范围：只渲染"连通的认知"——
 * 有边的节点 + 段骨干（sourceKind=segment，即使孤立）+ 推断节点。
 * 其余（无边的 lemma 等）收进 floating，不进图。
 */
export function chainScope(projection) {
  const connected = new Set()
  for (const e of projection.edges) {
    connected.add(e.from)
    connected.add(e.to)
  }
  const inScope = (n) => connected.has(n.id) || n.sourceKind === 'segment' || n.kind === 'inference'
  const nodes = projection.nodes.filter(inScope)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = projection.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const floating = projection.nodes.filter((n) => !ids.has(n.id))
  return { nodes, edges, floating }
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
  const safeEvents = integrity.ok ? events : events.slice(0, integrity.lastValidSeq || 0)
  const projection = projectEvents(safeEvents)
  const scope = chainScope(projection)
  return {
    themeId,
    eventCount: events.length,
    integrity,
    nodes: scope.nodes,
    edges: scope.edges,
    floatingCount: scope.floating.length,
    floating: scope.floating.map((n) => ({ id: n.id, kind: n.kind, title: n.title, sourceKind: n.sourceKind })),
  }
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

  const evidenceRefsRaw = [
    ...(payload.inboxId ? [{ type: 'inbox', id: payload.inboxId, title: payload.inboxTitle || '' }] : []),
    ...(Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : []),
  ]
  const evidenceRefs = [...new Map(evidenceRefsRaw
    .filter((r) => isObj(r) && r.type && r.id)
    .map((r) => [`${r.type}:${r.id}`, r])).values()]
  const newValue = String(payload.newValue ?? '').trim()
  const evidenceText = String(payload.evidence || '').trim()
  const hasEvidence = !!evidenceText || evidenceRefs.length > 0

  const priorEvents = getEvents(themeId)
  const drafts = []
  const touched = []
  const eventId = (kind, semantic) => `evt:mount:${digest({ themeId, inboxId: payload.inboxId || null, kind, semantic }).slice(0, 32)}`
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
      const stableEvidenceId = eventId('evidence', { name, evidenceText, evidenceRefs })
      const evId = payload.inboxId ? stableEvidenceId : `evt:mount:${randomUUID()}`
      drafts.push({
        id: evId, actor: 'user', type: 'evidence.appended',
        payload: {
          text: evidenceText, reason: String(payload.evidence || ''),
          evidenceRefs, sourceKind: 'mount',
          sourceRef: payload.inboxId ? `inbox:${payload.inboxId}` : `mount:${evId}`,
        },
      })
      drafts.push({
        id: payload.inboxId ? eventId('support', { evidenceId: evId, claimId }) : `evt:mount:${randomUUID()}`,
        actor: 'user', type: 'relation.declared',
        payload: {
          rel: 'supports', from: { eventId: evId }, to: { eventId: claimId },
          sourceKind: 'mount', sourceRef: payload.inboxId ? `inbox:${payload.inboxId}` : `mount:${evId}`,
        },
      })
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
  return { ok: true, events: appended.filter((e) => !e.replayed).length, claims: touched,
    replayed: appended.length > 0 && appended.every((e) => e.replayed) }
}
