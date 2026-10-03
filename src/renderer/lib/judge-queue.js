import { PROPOSAL_STANCE_OF_REL, evidenceJudgeState, isOpenStanceProposal, reviewedSignalIds } from '../../shared/judge.js'
import { calendarDay, evidenceDate, evidenceSourceName, evidenceUrl, isAtom } from './reader-board.js'
import { normalizePoints, sourceUrlOf } from '../../shared/evidence-source.js'
import { evidenceWeightOf, suggestWeight, weightOf } from '../../shared/evidence-weight.js'

/**
 * 建设者「判」的队列：主题里所有还没下结论的数据，一条一项，按进账本先后（旧的在前）排队。
 * 三种来源（口径见 shared/judge.js）：
 * - proposal：引擎（或 mock）对某条数据给出的表态建议，尚未接受 / 驳回；只收佐证 / 反驳 / 相关三种，
 *   推导、修订、新原子属于改结构，不在这里；
 * - pending：证据本身待复核；
 * - unmapped：证据还没挂到任何原子上。
 * 每项给出 suggestion（建议判给哪个原子、什么结论），推不出来就是 null，界面让人选，不替人猜；
 * points 是跟着原文进来的要点（判的上下文）；weight = { weight, source, sourceVia } 是判卡上的默认权重（口径见 shared/evidence-weight.js）。
 */

export const JUDGE_KIND_LABEL = { proposal: '模型建议', pending: '待复核', unmapped: '未挂原子' }
export const JUDGE_STANCE_LABEL = { supports: '佐证', contradicts: '反对', related: '中立', irrelevant: '不相关' }
export const JUDGE_STANCE_ORDER = ['supports', 'contradicts', 'related', 'irrelevant']

const asArray = (value) => (Array.isArray(value) ? value : [])
const text = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
const finiteOr = (value, fallback) => (value != null && Number.isFinite(Number(value)) ? Number(value) : fallback)

const PROPOSAL_DATE_FIELDS = [['sourcePublishedAt', '发布'], ['sourceFetchedAt', '抓取'], ['ingestedAt', '摄入']]
function proposalDate(event) {
  const payload = event?.payload || {}
  for (const [field, kind] of PROPOSAL_DATE_FIELDS) {
    const day = calendarDay(payload[field])
    if (day) return { day, kind }
  }
  const day = calendarDay(event?.at)
  return day ? { day, kind: '入账' } : null
}

/**
 * 模型建议的默认权重：来源类型用进主题时记下的（payload.sourceType），硬度看这一句（statement.type）；
 * 旧建议没记来源类型，按同一规则从链接 / 来源名 / 引文现算。
 */
function proposalWeight(event, url) {
  const payload = event?.payload || {}
  const statementType = payload.statement?.type === 'hard' ? 'hard' : 'soft'
  const recorded = weightOf({ sourceType: payload.sourceType, hardness: statementType })
  if (recorded) return { weight: recorded, source: 'suggested', sourceVia: null }
  const suggestion = suggestWeight({
    url: url || '', sourceLabel: text(payload.sourceLabel),
    text: text(payload.statement?.sourceText), statementType,
  })
  return { weight: suggestion.weight, source: 'estimated', sourceVia: suggestion.sourceVia }
}

/**
 * 建议的来源链接：建议里记的合格链接优先；没有（建议早于补链接）时用原条目当前的链接。
 * 采纳时主进程按同一顺序取链接写进证据（chain:reviewEngineRecommendation），展示与落账一致。
 */
function proposalUrl(event, inboxSourceUrls) {
  const recorded = sourceUrlOf(event?.payload?.sourceUrl)
  if (recorded) return { url: recorded, via: 'proposal' }
  const inboxId = text(event?.payload?.inboxId)
  const fallback = inboxId && Object.hasOwn(inboxSourceUrls, inboxId) ? sourceUrlOf(inboxSourceUrls[inboxId]) : null
  return fallback ? { url: fallback, via: 'inbox' } : { url: null, via: null }
}

/**
 * @param {{ events?: Array, nodes?: Array, edges?: Array, inboxSourceUrls?: Record<string, string> }} input
 *   主题账本事件 + 投影；inboxSourceUrls = 原条目 id → 当前来源链接（给没记链接的旧建议兜底）
 * @returns {{ items: Array, atoms: Array, counts: { proposal: number, pending: number, unmapped: number, total: number } }}
 */
export function buildJudgeQueue({ events = [], nodes = [], edges = [], inboxSourceUrls = {} } = {}) {
  const inboxUrls = inboxSourceUrls && typeof inboxSourceUrls === 'object' ? inboxSourceUrls : {}
  const liveNodes = asArray(nodes).filter(Boolean)
  const atoms = liveNodes.filter(isAtom)
    .sort((a, b) => finiteOr(a.createdSeq, Infinity) - finiteOr(b.createdSeq, Infinity) || String(a.id).localeCompare(String(b.id)))
  const atomIds = new Set(atoms.map((atom) => atom.id))
  const liveEdges = asArray(edges).filter(Boolean)
  const reviewed = reviewedSignalIds(events)

  const items = []
  for (const event of asArray(events)) {
    if (!isOpenStanceProposal(event, reviewed)) continue
    const recommendation = event.payload?.recommendation || {}
    const stance = PROPOSAL_STANCE_OF_REL[recommendation.rel]
    const statement = event.payload?.statement || {}
    const targetId = text(recommendation.propositionId)
    const source = proposalUrl(event, inboxUrls)
    items.push({
      key: `proposal:${event.id}`,
      kind: 'proposal',
      id: event.id,
      seq: finiteOr(event.seq, Infinity),
      quote: text(statement.sourceText) || null,
      quoteVerified: statement.sourceQuoteVerified === true,
      sourceName: text(event.payload?.sourceLabel) || null,
      url: source.url,
      urlVia: source.via,
      date: proposalDate(event),
      points: normalizePoints(event.payload?.sourcePoints),
      weight: proposalWeight(event, source.url),
      suggestion: {
        atomId: atomIds.has(targetId) ? targetId : null,
        atomTitle: text(recommendation.propositionTitle) || null,
        stance,
        reason: text(recommendation.reason) || null,
      },
    })
  }

  for (const node of liveNodes) {
    const state = evidenceJudgeState(node, liveEdges)
    if (!state) continue
    const targets = asArray(node.targetNodeIds).filter((id) => atomIds.has(id))
    const atomId = targets.length === 1 ? targets[0] : null
    const stanceRels = atomId
      ? new Set(liveEdges.filter((edge) => edge.from === node.id && edge.to === atomId && edge.reviewDecision !== 'rejected'
        && (edge.rel === 'supports' || edge.rel === 'contradicts')).map((edge) => edge.rel))
      : new Set()
    items.push({
      key: `evidence:${node.id}`,
      kind: state,
      id: node.id,
      seq: finiteOr(node.createdSeq, Infinity),
      quote: text(node.currentText) || text(node.title) || null,
      quoteVerified: true,
      sourceName: evidenceSourceName(node),
      url: evidenceUrl(node),
      urlVia: null,
      date: evidenceDate(node),
      points: normalizePoints(node.points),
      weight: evidenceWeightOf(node),
      suggestion: {
        atomId,
        atomTitle: atomId ? atoms.find((atom) => atom.id === atomId)?.title || null : null,
        stance: stanceRels.size === 1 ? [...stanceRels][0] : null,
        reason: null,
      },
    })
  }

  items.sort((a, b) => a.seq - b.seq || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const counts = { proposal: 0, pending: 0, unmapped: 0, total: items.length }
  for (const item of items) counts[item.kind] += 1
  return { items, atoms: atoms.map((atom) => ({ id: atom.id, title: text(atom.title) || '未命名原子' })), counts }
}
