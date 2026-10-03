/**
 * 「判」的共享口径：建设者的待判队列、写入命令、读者页的"待确认"都按这里判断，三处不会各说各话。
 *
 * 一条证据对原子的表态只有四种结论：佐证 / 反对 / 中立 / 不相关。
 * 待判证据只有两类（都还没有人下过结论）：
 * - pending：证据本身待复核（旧账本迁移或外部写入时带 pendingReview，且还没有复核决定）；
 * - unmapped：证据还没挂到任何原子上（没有目标原子，也没有未驳回的佐证 / 反驳关系），例如多主题分发进来的数据。
 * 已经有复核决定（接受或驳回）的证据不再进入队列；改判要追加更正，不能在这里覆盖。
 */

export const JUDGE_STANCES = ['supports', 'contradicts', 'related', 'irrelevant']
export const STANCE_RELS = new Set(['supports', 'contradicts'])

/** 引擎建议里的关系 → 「判」的结论；只有这三种是对数据的表态，其余（推导 / 修订 / 新原子）属于改结构。 */
export const PROPOSAL_STANCE_OF_REL = { supports: 'supports', contradicts: 'contradicts', related: 'related' }

const isLiveEvidence = (node) => Boolean(node) && node.nodeType === 'evidence'
  && !node.external && !node.archived && !node.invalidated

/**
 * @param {object} evidence 投影出的证据节点
 * @param {Array} edges 投影出的边
 * @returns {'pending'|'unmapped'|null}
 */
export function evidenceJudgeState(evidence, edges = []) {
  if (!isLiveEvidence(evidence)) return null
  if (evidence.reviewDecision != null) return null
  if (evidence.pendingReview === true) return 'pending'
  const targets = Array.isArray(evidence.targetNodeIds) ? evidence.targetNodeIds : []
  if (targets.length) return null
  const hasStanceEdge = (Array.isArray(edges) ? edges : []).some((edge) => edge
    && edge.from === evidence.id && STANCE_RELS.has(edge.rel) && edge.reviewDecision !== 'rejected')
  return hasStanceEdge ? null : 'unmapped'
}

/** 账本里已被复核过的信号 id（signal.reviewed 的 signalEventId）。 */
export function reviewedSignalIds(events = []) {
  const ids = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    const id = event?.type === 'signal.reviewed' ? String(event.payload?.signalEventId || '').trim() : ''
    if (id) ids.add(id)
  }
  return ids
}

/** 引擎建议是否仍是一条待判的表态建议：没被复核、不是新原子、关系是佐证 / 反驳 / 相关之一。 */
export function isOpenStanceProposal(event, reviewed) {
  if (event?.type !== 'engine.recommendation.proposed' || !event.id || reviewed?.has(event.id)) return false
  const recommendation = event.payload?.recommendation || {}
  return recommendation.kind !== 'new-proposition' && Object.hasOwn(PROPOSAL_STANCE_OF_REL, recommendation.rel)
}

/** 主题里待判的条数（与建设者待判队列同一口径）。 */
export function countJudgeItems({ events = [], nodes = [], edges = [] } = {}) {
  const counts = { proposal: 0, pending: 0, unmapped: 0, total: 0 }
  const reviewed = reviewedSignalIds(events)
  for (const event of Array.isArray(events) ? events : []) if (isOpenStanceProposal(event, reviewed)) counts.proposal += 1
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const state = evidenceJudgeState(node, edges)
    if (state) counts[state] += 1
  }
  counts.total = counts.proposal + counts.pending + counts.unmapped
  return counts
}
