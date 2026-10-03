import { networkNodeType, NODE_TYPE_META } from './theme-network.js'
import { evidenceForNode } from './chain-workbench-model.js'
import { evidenceSourceUrl, normalizePoints } from '../../shared/evidence-source.js'
import { weightOf } from '../../shared/evidence-weight.js'

/**
 * 读者页「原子看板」：主题 = 一组可以被独立验证的原子；外部数据对原子表态（佐证 / 反对 / 中立）；
 * 时间决定数据的先后。读者先看"哪些原子被检验过、结果如何"，再点开单个原子看凭据。
 *
 * 口径（全部来自投影里已有的字段；推不出来就是 null / 空数组，不猜）：
 * - 原子 = 未归档、未作废、非外部、非证据的节点。不要求任何层级结构。
 * - 出处 = 原子被抽出来的那条来源，不计入表态：
 *     · 引擎建原子时，原子与证据写入同一个 sourceRef（engine-recommendation:<id>）→ 证据 sourceRef 等于原子 sourceRef；
 *     · 旧数据迁移时，原子来源被写成 sourceKind = legacy-node-source 的证据。
 * - 表态只认 evidenceForNode（与建设者同口径，已驳回的不计）：supports → 佐证，contradicts → 反对，两者都有 → 两边，
 *   其余挂载 → 中立；但挂载边是 supersedes / derives 的不算表态，归为"修订依据 / 推导依据"。
 * - 还没人确认的不算表态：证据本身待复核，或它对该原子的表态边全都待复核 → 归为"待确认"，照样列出但不计数。
 */

const asArray = (value) => (Array.isArray(value) ? value : [])
const text = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
const finiteOrNull = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null)
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export const SETTLE_SOON_DAYS = 14
export const FEED_LIMIT = 8
export const LEGACY_ORIGIN_SOURCE_KIND = 'legacy-node-source'
const DAY_MS = 24 * 60 * 60 * 1000

export const CLAIM_TYPE_LABEL = { segment: '维度', hypothesis: '假设', observation: '观察', axiom: '公理' }

/* 顺序即看板分组顺序：越值得看的越靠前。tested = 被出处之外的独立数据检验过。 */
export const ATOM_STATES = [
  { key: 'split', label: '有分歧', hint: '既有佐证也有反对——最该看的', tested: true },
  { key: 'against', label: '被反驳', hint: '只有反对的独立数据', tested: true },
  { key: 'support', label: '被佐证', hint: '有出处之外的独立佐证', tested: true },
  { key: 'neutral', label: '只有中立', hint: '有独立数据提到它，但没有表态', tested: true },
  { key: 'origin', label: '只有出处', hint: '只有它被抽出来的那条来源，还没被检验', tested: false },
  { key: 'none', label: '没有外部数据', hint: '既没有出处，也没有独立数据', tested: false },
]
const STATE_KEYS = ATOM_STATES.map((state) => state.key)

export const STANCE_LABEL = {
  support: '佐证', against: '反对', both: '两边', neutral: '中立',
  origin: '出处', revision: '修订依据', derives: '推导依据', pending: '待确认',
}
const INDEPENDENT_STANCES = new Set(['support', 'against', 'both', 'neutral'])

const isLive = (node) => Boolean(node) && !node.archived && !node.invalidated && !node.external
const awaitingReview = (item) => item?.pendingReview === true && item?.reviewDecision == null
const isEvidence = (node) => networkNodeType(node) === 'evidence'
export const isAtom = (node) => isLive(node) && !isEvidence(node)

const seqOf = (node) => finiteOrNull(node?.createdSeq) ?? Number.POSITIVE_INFINITY
const byLedgerOrder = (a, b) => seqOf(a) - seqOf(b) || byCodePoint(String(a?.id ?? ''), String(b?.id ?? ''))

/** YYYY-MM-DD（允许带时间后缀）→ 当天 UTC 0 点毫秒；不存在的日期（如 2026-02-30）返回 null。 */
export function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value))
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const ms = Date.UTC(year, month - 1, day)
  const back = new Date(ms)
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? ms : null
}
const dayString = (ms) => new Date(ms).toISOString().slice(0, 10)

/** 本地日历的"今天"：settleAt 记的是本地日期，比较时也必须用本地日期。 */
export function localToday(now = Date.now()) {
  const date = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const HAS_CLOCK_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
/**
 * 日期字段 → 本地日历日 YYYY-MM-DD。纯日期按字面；带时刻的时间戳先换算成本地时间再取日
 * （2026-09-07T20:00:00Z 在东八区是 09-08）。字面日期不存在则 null（不让 Date.parse 把 02-30 进位成 03-02）；
 * 时间戳本身解析不了时退回字面日期。
 */
export function calendarDay(value) {
  const raw = text(value)
  const literal = parseDay(raw)
  if (literal == null) return null
  if (HAS_CLOCK_TIME.test(raw)) {
    const ms = Date.parse(raw)
    if (Number.isFinite(ms)) return localToday(ms)
  }
  return dayString(literal)
}

/* 原文发布 → 抓取 → 旧数据记录 → 系统摄入原始材料 → 写入本主题账本。后两者是数据进入系统的时间，不冒充发布日。 */
const EVIDENCE_DATE_FIELDS = [
  ['sourcePublishedAt', '发布'], ['sourceFetchedAt', '抓取'], ['legacySourceAt', '记录'],
  ['ingestedAt', '摄入'], ['recordedAt', '入账'],
]
/** 证据日期：按上面的顺序取第一个有效的；同时返回是哪一种，界面照实标注。 */
export function evidenceDate(node) {
  for (const [field, kind] of EVIDENCE_DATE_FIELDS) {
    const day = calendarDay(node?.[field])
    if (day != null) return { day, kind }
  }
  return null
}

/** 证据出处：来源名优先；旧数据只记了来源类型（如「券商研报」），就显示类型。 */
export function evidenceSourceName(node) {
  return text(node?.sourceLabel) || text(node?.provenance?.sourceLabel) || text(node?.sourceCategory) || null
}

/** 证据的来源链接：只认真实可打开的 http(s) 网址（口径见 shared/evidence-source.js），示例 / 内网域名不算。 */
export function evidenceUrl(node) {
  return evidenceSourceUrl(node)
}

export function typeLabelOf(node) {
  return CLAIM_TYPE_LABEL[node?.claimType] || NODE_TYPE_META[networkNodeType(node)]?.label || '观点'
}

/** 见分晓：tone = settled（已结算）| overdue（日期已过未结算）| soon（≤14 天）| later。 */
export function settleInfo(node, todayMs) {
  const ms = parseDay(node?.settleAt)
  if (ms == null || todayMs == null) return null
  const settled = node?.correct === true || node?.correct === false
  const daysLeft = Math.round((ms - todayMs) / DAY_MS)
  const tone = settled ? 'settled' : daysLeft < 0 ? 'overdue' : daysLeft <= SETTLE_SOON_DAYS ? 'soon' : 'later'
  return { day: dayString(ms), daysLeft, tone, settled, correct: settled ? node.correct : null }
}

/** 这条证据是不是该原子的出处（只认账本里明确的字段，不按标题或时间猜）。 */
export function isOriginEvidence(evidence, atom) {
  if (!evidence || !atom) return false
  if (evidence.sourceKind === LEGACY_ORIGIN_SOURCE_KIND) return true
  const ref = text(evidence.sourceRef)
  return Boolean(ref) && ref === text(atom.sourceRef)
}

/** 检验状态：两边都有 → 有分歧；只有反对 → 被反驳；只有佐证 → 被佐证；只有中立 → 只有中立；再看有没有出处。 */
export function atomState({ support = 0, against = 0, both = 0, neutral = 0, origin = 0 } = {}) {
  if (support + both > 0 && against + both > 0) return 'split'
  if (against > 0) return 'against'
  if (support > 0) return 'support'
  if (neutral > 0) return 'neutral'
  if (origin > 0) return 'origin'
  return 'none'
}

/* 行内排序：日期新的在前；同日（或都没日期）按进账本的先后，新的在前；最后按 id 定序。 */
const compareRows = (a, b) => {
  const x = a.date?.day || '', y = b.date?.day || ''
  if (x !== y) return x < y ? 1 : -1
  const sx = a.seq ?? Number.NEGATIVE_INFINITY, sy = b.seq ?? Number.NEGATIVE_INFINITY
  if (sx !== sy) return sy - sx
  return byCodePoint(a.evidenceId, b.evidenceId)
}

const latestDayOf = (rows) => rows.reduce((best, row) => (row.date && row.date.day > best ? row.date.day : best), '') || null

/** 一句话结论：只用计数拼，不编方向。 */
export function verdictText(byState, atomCount) {
  const count = (key) => byState?.[key] || 0
  const tested = ATOM_STATES.filter((state) => state.tested).reduce((sum, state) => sum + count(state.key), 0)
  const parts = [`${atomCount} 个原子`]
  if (tested) {
    const sub = []
    if (count('split')) sub.push(`${count('split')} 个有分歧`)
    if (count('against')) sub.push(`${count('against')} 个被反驳`)
    parts.push(`${tested} 个被出处之外的外部数据检验过${sub.length ? `，其中 ${sub.join('、')}` : ''}`)
  } else {
    parts.push('还没有一个被出处之外的外部数据检验过')
  }
  const rest = []
  if (count('origin')) rest.push(`${count('origin')} 个只有出处`)
  if (count('none')) rest.push(`${count('none')} 个还没有任何外部数据`)
  if (rest.length) parts.push(rest.join('，'))
  return `${parts.join('；')}。`
}

export function buildAtomBoard({ nodes = [], edges = [], today = null, now = Date.now() } = {}) {
  const todayMs = parseDay(today) ?? parseDay(localToday(now))
  const allNodes = asArray(nodes).filter(Boolean)
  const allEdges = asArray(edges).filter(Boolean)
  const projection = { nodes: allNodes, edges: allEdges }

  /* 证据 → 原子 之间的边（已驳回的不算）：关系类型集合用来把"挂载但没表态"再细分出修订 / 推导；
     最新 seq 是这条数据对该原子"落账"的时刻（evidenceForNode 只带回 supports / contradicts 边，修订边要从这里补）。 */
  const between = new Map()
  for (const edge of allEdges) {
    if (edge.reviewDecision === 'rejected' || edge.from === edge.to) continue
    const key = `${edge.from}\u0000${edge.to}`
    const entry = between.get(key) || { rels: new Set(), seq: null }
    entry.rels.add(edge.rel)
    const edgeSeq = finiteOrNull(edge.seq)
    if (edgeSeq != null && (entry.seq == null || edgeSeq > entry.seq)) entry.seq = edgeSeq
    between.set(key, entry)
  }
  const seqOfRow = (source, atom) => {
    const own = finiteOrNull(source?.createdSeq)
    const linked = between.get(`${source.id}\u0000${atom.id}`)?.seq ?? null
    if (own == null) return linked
    return linked == null ? own : Math.max(own, linked)
  }
  const stanceOf = (bucket, source, atom, relations) => {
    if (isOriginEvidence(source, atom)) return 'origin'
    const stanceEdges = asArray(relations)
    if (awaitingReview(source) || (stanceEdges.length && stanceEdges.every(awaitingReview))) return 'pending'
    if (bucket !== 'neutral') return bucket
    const rels = between.get(`${source.id}\u0000${atom.id}`)?.rels
    if (rels?.has('supersedes')) return 'revision'
    if (rels?.has('derives')) return 'derives'
    return 'neutral'
  }

  const atoms = allNodes.filter(isAtom).sort(byLedgerOrder).map((node) => {
    let found = null
    try { found = evidenceForNode({ projection }, node.id) } catch { found = null }
    const buckets = [['support', found?.supports], ['against', found?.against], ['both', found?.both], ['neutral', found?.unclassified]]
    const origin = []
    const independent = []
    const related = []
    const pending = []
    for (const [bucket, list] of buckets) {
      for (const result of asArray(list)) {
        const source = result?.source
        if (!isLive(source)) continue
        const stance = stanceOf(bucket, source, node, result.relations)
        const title = text(source.title) || '（未命名来源）'
        const quote = text(source.currentText)
        const row = {
          evidenceId: String(source.id),
          stance,
          title,
          quote: quote && quote !== title ? quote : null,
          sourceName: evidenceSourceName(source),
          url: evidenceUrl(source),
          date: evidenceDate(source),
          seq: seqOfRow(source, node),
          points: normalizePoints(source.points),
          /* 只展示账本里记下的权重（判定时确认的，或进主题时的建议）；旧数据没记就是 null，不拿现算的冒充。 */
          weight: weightOf(source.weight),
          weightSource: weightOf(source.weight) ? (source.weightSource === 'judged' ? 'judged' : 'suggested') : null,
        }
        if (stance === 'origin') origin.push(row)
        else if (stance === 'pending') pending.push(row)
        else if (INDEPENDENT_STANCES.has(stance)) independent.push(row)
        else related.push(row)
      }
    }
    for (const list of [origin, independent, related, pending]) list.sort(compareRows)
    const tallies = { support: 0, against: 0, both: 0, neutral: 0 }
    for (const row of independent) tallies[row.stance] += 1
    const title = text(node.title) || '未命名'
    const current = text(node.currentText)
    return {
      id: String(node.id),
      title,
      currentText: current && current !== title ? current : null,
      typeLabel: typeLabelOf(node),
      state: atomState({ ...tallies, origin: origin.length }),
      tallies,
      independentCount: independent.length,
      origin,
      independent,
      related,
      pending,
      latestDay: latestDayOf(independent),
      settle: settleInfo(node, todayMs),
      falsifier: text(node.falsifier) || null,
      seq: finiteOrNull(node.createdSeq),
    }
  })
  const rank = new Map(atoms.map((atom, index) => [atom.id, index]))

  /* 组内：独立数据多的在前 → 最近日期新的在前 → 账本顺序（atoms 已按账本排好）。 */
  const groupOrder = (a, b) => {
    if (a.independentCount !== b.independentCount) return b.independentCount - a.independentCount
    const x = a.latestDay || '', y = b.latestDay || ''
    if (x !== y) return x < y ? 1 : -1
    return rank.get(a.id) - rank.get(b.id)
  }
  const byState = Object.fromEntries(STATE_KEYS.map((key) => [key, 0]))
  for (const atom of atoms) byState[atom.state] += 1
  const groups = ATOM_STATES
    .map((state) => ({ ...state, items: atoms.filter((atom) => atom.state === state.key).sort(groupOrder) }))
    .filter((group) => group.items.length)

  /* 总量：表态按"原子 × 数据"计（一条数据对两个原子表态算两次）；出处 / 独立数据按证据去重计条数。 */
  const stances = { support: 0, against: 0, both: 0, neutral: 0 }
  const originIds = new Set()
  const independentIds = new Set()
  const pendingIds = new Set()
  for (const atom of atoms) {
    for (const key of Object.keys(stances)) stances[key] += atom.tallies[key]
    for (const row of atom.origin) originIds.add(row.evidenceId)
    for (const row of atom.independent) independentIds.add(row.evidenceId)
    for (const row of atom.pending) pendingIds.add(row.evidenceId)
  }

  /* 最近进来的外部数据：按进账本的先后（证据或表态边里最新的 seq），新的在前。出处也列，单独标注。 */
  const feedRows = []
  for (const atom of atoms) {
    for (const row of [...atom.origin, ...atom.independent, ...atom.related, ...atom.pending]) {
      feedRows.push({ ...row, atomId: atom.id, atomTitle: atom.title })
    }
  }
  feedRows.sort((a, b) => {
    const sx = a.seq ?? Number.NEGATIVE_INFINITY, sy = b.seq ?? Number.NEGATIVE_INFINITY
    if (sx !== sy) return sy - sx
    return compareRows(a, b) || rank.get(a.atomId) - rank.get(b.atomId)
  })

  /* 接下来看什么：写了见分晓日期的原子。未结算的按日期最早在前；已结算的排后，最近结算的在前。 */
  const watch = atoms.filter((atom) => atom.settle).map((atom) => ({
    id: atom.id, title: atom.title, typeLabel: atom.typeLabel, settle: atom.settle, falsifier: atom.falsifier,
  }))
  watch.sort((a, b) => {
    if (a.settle.settled !== b.settle.settled) return a.settle.settled ? 1 : -1
    if (a.settle.day !== b.settle.day) return a.settle.settled ? byCodePoint(b.settle.day, a.settle.day) : byCodePoint(a.settle.day, b.settle.day)
    return rank.get(a.id) - rank.get(b.id)
  })

  return {
    today: todayMs == null ? null : dayString(todayMs),
    atoms,
    groups,
    byState,
    verdict: verdictText(byState, atoms.length),
    totals: {
      atoms: atoms.length,
      tested: ATOM_STATES.filter((state) => state.tested).reduce((sum, state) => sum + byState[state.key], 0),
      stances,
      originSources: originIds.size,
      independentSources: independentIds.size,
      pendingSources: pendingIds.size,
      latestIndependentDay: latestDayOf(atoms.flatMap((atom) => atom.independent)),
    },
    feed: { total: feedRows.length, items: feedRows.slice(0, FEED_LIMIT) },
    watch,
  }
}
