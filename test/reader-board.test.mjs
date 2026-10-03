/**
 * 读者页「原子看板」模型：出处判定、检验状态、分组排序、总量、最近数据、接下来看什么。
 * 运行：node test/reader-board.test.mjs
 */
import {
  ATOM_STATES, FEED_LIMIT, LEGACY_ORIGIN_SOURCE_KIND,
  atomState, buildAtomBoard, calendarDay, evidenceDate, evidenceUrl, isOriginEvidence, parseDay, settleInfo, verdictText,
} from '../src/renderer/lib/reader-board.js'

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${condition || !detail ? '' : `  ${detail}`}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

let seq = 0
const atom = (id, extra = {}) => ({ id, nodeType: 'viewpoint', kind: 'claim', title: id, currentText: id, sourceRef: `event:${id}`, createdSeq: ++seq, ...extra })
const evidence = (id, extra = {}) => ({ id, nodeType: 'evidence', kind: 'evidence', title: `据 ${id}`, currentText: `据 ${id}`, sourceRef: null, createdSeq: ++seq, ...extra })
const edge = (id, rel, from, to, extra = {}) => ({ id, rel, from, to, seq: ++seq, ...extra })

/* ---------- 出处判定 ---------- */
check('引擎建的原子：证据 sourceRef 与原子相同 → 出处',
  isOriginEvidence({ sourceRef: 'engine-recommendation:r1' }, { sourceRef: 'engine-recommendation:r1' }))
check('旧数据迁移的来源证据 → 出处', isOriginEvidence({ sourceKind: LEGACY_ORIGIN_SOURCE_KIND, sourceRef: 'legacy-source:x' }, { sourceRef: 'event:a' }))
check('sourceRef 不同 → 不是出处', !isOriginEvidence({ sourceRef: 'engine-recommendation:r2' }, { sourceRef: 'engine-recommendation:r1' }))
check('两边 sourceRef 都为空 → 不算相等', !isOriginEvidence({ sourceRef: '' }, { sourceRef: '' }) && !isOriginEvidence({ sourceRef: null }, { sourceRef: null }))
check('缺参数 → 不是出处', !isOriginEvidence(null, { sourceRef: 'x' }) && !isOriginEvidence({ sourceRef: 'x' }, null))

/* ---------- 检验状态 ---------- */
check('佐证 + 反对 → 有分歧', atomState({ support: 1, against: 1 }) === 'split')
check('只有"两边"那一条 → 有分歧', atomState({ both: 1 }) === 'split')
check('佐证 + 两边 → 有分歧', atomState({ support: 2, both: 1 }) === 'split')
check('只有反对 → 被反驳', atomState({ against: 2, neutral: 1 }) === 'against')
check('只有佐证（加中立）→ 被佐证', atomState({ support: 1, neutral: 3, origin: 1 }) === 'support')
check('只有中立 → 只有中立', atomState({ neutral: 1, origin: 1 }) === 'neutral')
check('只有出处 → 只有出处', atomState({ origin: 2 }) === 'origin')
check('什么都没有 → 没有外部数据', atomState({}) === 'none' && atomState() === 'none')

/* ---------- 日期 ---------- */
check('不存在的日期返回 null', parseDay('2026-02-30') === null && parseDay('2026-02-28') != null)
check('证据日期优先发布日', same(evidenceDate({ sourcePublishedAt: '2026-09-01', sourceFetchedAt: '2026-09-03' }), { day: '2026-09-01', kind: '发布' }))
check('没有发布日退到抓取日，再退到记录日',
  same(evidenceDate({ sourceFetchedAt: '2026-09-03T10:00:00Z' }), { day: '2026-09-03', kind: '抓取' })
  && same(evidenceDate({ legacySourceAt: '2026-09-05' }), { day: '2026-09-05', kind: '记录' })
  && evidenceDate({}) === null)
check('再退到系统摄入、账本入账；无效值跳过',
  same(evidenceDate({ sourcePublishedAt: '2026-02-30', ingestedAt: '2026-09-06', recordedAt: '2026-09-07' }), { day: '2026-09-06', kind: '摄入' })
  && same(evidenceDate({ ingestedAt: 'not-a-date', recordedAt: '2026-09-07' }), { day: '2026-09-07', kind: '入账' }))
const stamp = '2026-09-07T20:30:00.000Z'
const stampLocal = new Date(stamp)
const pad2 = (n) => String(n).padStart(2, '0')
check('带时刻的时间戳按本地日历取日，纯日期按字面',
  calendarDay(stamp) === `${stampLocal.getFullYear()}-${pad2(stampLocal.getMonth() + 1)}-${pad2(stampLocal.getDate())}`
  && calendarDay('2026-09-07') === '2026-09-07'
  && calendarDay('2026-02-30T10:00:00Z') === null
  && calendarDay('') === null && calendarDay(null) === null)
if (process.env.TZ === 'Asia/Shanghai') check('东八区：20:30Z 已是次日', calendarDay(stamp) === '2026-09-08')
const todayMs = parseDay('2026-10-04')
check('见分晓：14 天内 soon、过期 overdue、已结算 settled',
  settleInfo({ settleAt: '2026-10-18' }, todayMs)?.tone === 'soon'
  && settleInfo({ settleAt: '2026-10-19' }, todayMs)?.tone === 'later'
  && settleInfo({ settleAt: '2026-10-01' }, todayMs)?.tone === 'overdue'
  && settleInfo({ settleAt: '2026-10-01', correct: false }, todayMs)?.tone === 'settled'
  && settleInfo({ settleAt: '2026-10-01', correct: false }, todayMs)?.correct === false
  && settleInfo({}, todayMs) === null)

/* ---------- 看板 ---------- */
const A = atom('A', { sourceRef: 'engine-recommendation:r1', settleAt: '2026-10-20', falsifier: 'A 的推翻条件' })
const eA0 = evidence('eA0', { sourceRef: 'engine-recommendation:r1', sourceKind: 'engine-reviewed', sourcePublishedAt: '2026-09-01', sourceLabel: '原始来源' })
const eA1 = evidence('eA1', { sourceKind: 'engine-reviewed', sourceRef: 'engine-recommendation:r7', sourcePublishedAt: '2026-09-10', sourceLabel: '独立来源一', sourceUrl: 'https://www.reuters.com/markets/a1', points: ['要点一', ' 要点一 ', '要点二'], weight: { sourceType: '独立媒体', hardness: 'hard', value: 0.01 }, weightSource: 'judged' })
const eA2 = evidence('eA2', { sourceKind: 'engine-reviewed', sourceRef: 'engine-recommendation:r8', sourcePublishedAt: '2026-09-20', sourceLabel: '独立来源二', sourceUrl: 'javascript:alert(1)' })
const B = atom('B', { settleAt: '2026-10-08' })
const eB0 = evidence('eB0', { sourceKind: LEGACY_ORIGIN_SOURCE_KIND, sourceRef: 'legacy-source:lemma:B', legacySourceAt: '2026-08-01', sourceCategory: '券商研报', targetNodeIds: ['B'] })
const C = atom('C', { claimType: 'observation' })
const eC1 = evidence('eC1', { targetNodeIds: ['C'], sourceFetchedAt: '2026-09-15' })
const D = atom('D', { claimType: 'segment', settleAt: '2026-09-01', correct: true })
const E = atom('E')
const eE1 = evidence('eE1')
const eE2 = evidence('eE2', { reviewDecision: 'rejected', targetNodeIds: ['E'] })
const F = atom('F')
const eF1 = evidence('eF1', { targetNodeIds: ['F'], sourcePublishedAt: '2026-09-25' })
const G = atom('G', { archived: true })
const H = atom('H')
const eH1 = evidence('eH1', { sourcePublishedAt: '2026-09-02' })
const eArchived = evidence('eArchived', { archived: true, targetNodeIds: ['H'] })
const X = atom('X', { external: true })

const nodes = [A, eA0, eA1, eA2, B, eB0, C, eC1, D, E, eE1, eE2, F, eF1, G, H, eH1, eArchived, X]
const edges = [
  edge('r-a0', 'supports', 'eA0', 'A'),
  edge('r-a1', 'supports', 'eA1', 'A'),
  edge('r-a2', 'contradicts', 'eA2', 'A'),
  edge('r-b0', 'supports', 'eB0', 'B'),
  edge('r-e1', 'supports', 'eE1', 'E', { reviewDecision: 'rejected' }),
  edge('r-f1', 'supersedes', 'eF1', 'F'),
  edge('r-h1s', 'supports', 'eH1', 'H'),
  edge('r-h1c', 'contradicts', 'eH1', 'H'),
  edge('r-ab', 'derives', 'A', 'B'),
]
const board = buildAtomBoard({ nodes, edges, today: '2026-10-04' })
const byId = new Map(board.atoms.map((item) => [item.id, item]))

check('原子 = 未归档、非外部、非证据的节点（按账本顺序）', same(board.atoms.map((item) => item.id), ['A', 'B', 'C', 'D', 'E', 'F', 'H']))
check('A：出处 1 条不计入；独立 佐证 1 + 反对 1 → 有分歧',
  byId.get('A').state === 'split' && byId.get('A').origin.length === 1 && byId.get('A').origin[0].evidenceId === 'eA0'
  && same(byId.get('A').tallies, { support: 1, against: 1, both: 0, neutral: 0 }))
check('A 的独立数据按日期新的在前；非 http(s) 链接丢弃',
  same(byId.get('A').independent.map((row) => [row.evidenceId, row.stance, row.url]), [['eA2', 'against', null], ['eA1', 'support', 'https://www.reuters.com/markets/a1']]))
{
  const rowA1 = byId.get('A').independent.find((row) => row.evidenceId === 'eA1')
  const rowA2 = byId.get('A').independent.find((row) => row.evidenceId === 'eA2')
  check('行带要点（归一去重）与账本记下的权重（分值按来源类型 × 硬度重算，不信任存的数值）',
    same(rowA1.points, ['要点一', '要点二']) && same(rowA1.weight, { sourceType: '独立媒体', hardness: 'hard', value: 0.65 }) && rowA1.weightSource === 'judged')
  check('旧数据没记权重：行上权重为 null，不拿现算的冒充', rowA2.weight === null && rowA2.weightSource === null && same(rowA2.points, []))
}
check('来源链接：示例 / 内网域名、IP、带账号密码的都不算；evidenceRefs 里的 url 引用可作来源',
  evidenceUrl({ sourceUrl: 'https://example.test/a' }) === null
  && evidenceUrl({ sourceUrl: 'https://example.com/a' }) === null
  && evidenceUrl({ sourceUrl: 'http://192.168.1.2/a' }) === null
  && evidenceUrl({ sourceUrl: 'https://u:p@www.reuters.com/a' }) === null
  && evidenceUrl({ sourceUrl: 'https://localhost/a' }) === null
  && evidenceUrl({ evidenceRefs: [{ type: 'url', id: 'https://www.cninfo.com.cn/x' }] }) === 'https://www.cninfo.com.cn/x')
check('A 的最近日期只看独立数据', byId.get('A').latestDay === '2026-09-20')
check('B：只有旧数据迁移的来源 → 只有出处；来源名退回来源类型',
  byId.get('B').state === 'origin' && byId.get('B').origin[0].sourceName === '券商研报' && byId.get('B').independentCount === 0)
check('C：挂载但没有表态边 → 只有中立', byId.get('C').state === 'neutral' && byId.get('C').tallies.neutral === 1)
check('D：没有任何数据 → 没有外部数据；类型标签来自 claimType', byId.get('D').state === 'none' && byId.get('D').typeLabel === '维度')
check('E：表态边已驳回、证据本身已驳回 → 都不算', byId.get('E').state === 'none' && byId.get('E').independentCount === 0)
check('F：挂载边是 supersedes → 归为修订依据，不算表态',
  byId.get('F').state === 'none' && byId.get('F').related.length === 1 && byId.get('F').related[0].stance === 'revision')
check('H：同一条数据既支持又反对 → 两边 → 有分歧；已归档证据不计',
  byId.get('H').state === 'split' && same(byId.get('H').tallies, { support: 0, against: 0, both: 1, neutral: 0 }))

check('分组顺序固定，空组不出现', same(board.groups.map((group) => group.key), ['split', 'neutral', 'origin', 'none']))
check('组内：独立数据多的在前（A 两条 > H 一条）', same(board.groups[0].items.map((item) => item.id), ['A', 'H']))
check('没被检验的组内按账本顺序', same(board.groups.find((group) => group.key === 'none').items.map((item) => item.id), ['D', 'E', 'F']))
check('各状态计数', same(board.byState, { split: 2, against: 0, support: 0, neutral: 1, origin: 1, none: 3 }))
check('ATOM_STATES 与 byState 的键一致', same(Object.keys(board.byState), ATOM_STATES.map((state) => state.key)))
check('一句话结论只用计数拼', board.verdict === '7 个原子；3 个被出处之外的外部数据检验过，其中 2 个有分歧；1 个只有出处，3 个还没有任何外部数据。', board.verdict)
check('总量：表态按原子×数据计；出处 / 独立数据按证据去重',
  same(board.totals.stances, { support: 1, against: 1, both: 1, neutral: 1 })
  && board.totals.originSources === 2 && board.totals.independentSources === 4
  && board.totals.tested === 3 && board.totals.latestIndependentDay === '2026-09-20')

check('最近进来的数据按账本先后（证据或表态边的最新 seq），新的在前',
  same(board.feed.items.map((row) => `${row.evidenceId}>${row.atomId}`), ['eH1>H', 'eF1>F', 'eB0>B', 'eA2>A', 'eA1>A', 'eA0>A', 'eC1>C']))
check('feed 带出处与修订依据，并标注所属原子',
  board.feed.total === 7 && board.feed.items.find((row) => row.evidenceId === 'eA0').stance === 'origin'
  && board.feed.items.find((row) => row.evidenceId === 'eF1').atomTitle === 'F')

check('接下来看什么：未结算按日期早的在前，已结算排后',
  same(board.watch.map((item) => [item.id, item.settle.tone]), [['B', 'soon'], ['A', 'later'], ['D', 'settled']]))
check('watch 带推翻条件', board.watch.find((item) => item.id === 'A').falsifier === 'A 的推翻条件')

/* ---------- 待确认 ---------- */
const P = atom('P')
const pSelf = evidence('pSelf', { pendingReview: true, targetNodeIds: ['P'], sourcePublishedAt: '2026-09-30' })
const pEdge = evidence('pEdge', { sourcePublishedAt: '2026-09-29' })
const pMixed = evidence('pMixed', { sourcePublishedAt: '2026-09-28' })
const pDecided = evidence('pDecided', { pendingReview: true, reviewDecision: 'accepted', sourcePublishedAt: '2026-09-27' })
const pending = buildAtomBoard({
  nodes: [P, pSelf, pEdge, pMixed, pDecided],
  edges: [
    edge('pe1', 'supports', 'pEdge', 'P', { pendingReview: true }),
    edge('pe2', 'contradicts', 'pMixed', 'P', { pendingReview: true }),
    edge('pe3', 'contradicts', 'pMixed', 'P'),
    edge('pe4', 'supports', 'pDecided', 'P'),
  ],
  today: '2026-10-04',
})
const pAtom = pending.atoms[0]
check('证据本身待复核、或表态边全部待复核 → 待确认，不计数',
  same(pAtom.pending.map((row) => row.evidenceId), ['pSelf', 'pEdge']) && pAtom.pending.every((row) => row.stance === 'pending'))
check('有一条表态边已确认 → 照常计入；复核已有结论的证据照常计入',
  same(pAtom.independent.map((row) => [row.evidenceId, row.stance]), [['pMixed', 'against'], ['pDecided', 'support']]))
check('待确认不影响状态，单独计总量', pAtom.state === 'split' && pending.totals.pendingSources === 2
  && same(pending.totals.stances, { support: 1, against: 1, both: 0, neutral: 0 }))
check('待确认也出现在最近进来的数据里', pending.feed.items.some((row) => row.stance === 'pending'))

/* ---------- 边界 ---------- */
const many = []
const manyEdges = []
const target = atom('T')
many.push(target)
for (let i = 0; i < FEED_LIMIT + 3; i++) {
  const ev = evidence(`m${i}`, { sourcePublishedAt: '2026-09-01' })
  many.push(ev)
  manyEdges.push(edge(`me${i}`, 'supports', ev.id, 'T'))
}
const big = buildAtomBoard({ nodes: many, edges: manyEdges, today: '2026-10-04' })
check(`feed 最多 ${FEED_LIMIT} 条，total 记全量`, big.feed.items.length === FEED_LIMIT && big.feed.total === FEED_LIMIT + 3)
check('同日数据按进账本先后，新的在前', big.atoms[0].independent[0].evidenceId === `m${FEED_LIMIT + 2}`)

const empty = buildAtomBoard({ nodes: [evidence('lonely')], edges: [] })
check('只有证据、没有原子 → 空看板', empty.atoms.length === 0 && empty.groups.length === 0 && empty.feed.total === 0)
check('空输入不抛错', buildAtomBoard().atoms.length === 0 && buildAtomBoard({ nodes: null, edges: undefined }).atoms.length === 0)
check('还没有任何检验时的结论', verdictText({ origin: 2, none: 1 }, 3) === '3 个原子；还没有一个被出处之外的外部数据检验过；2 个只有出处，1 个还没有任何外部数据。')
check('全部被检验时不写尾巴', verdictText({ support: 2 }, 2) === '2 个原子；2 个被出处之外的外部数据检验过。')

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
