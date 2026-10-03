/**
 * 建设者「喂 → 判」测试（MERIDIAN_MOCK_ENGINE=1，不调 LLM）。
 *
 * 运行：node test/builder-judge.test.mjs
 *
 * 守住：
 *  1. 待判口径（shared/judge.js）：只有"待复核"和"还没挂原子"的活证据才待判；判过的不再出现；
 *  2. chain:judgeEvidence 四种结论落账正确——佐证 / 反对写表态边并按原子强度更新，中立只挂原子，不相关驳回；
 *     判给别的原子 / 别的结论时，旧挂载与旧表态边都不残留；同结论重放幂等，不同结论拒绝；
 *  3. 判卡队列（renderer/lib/judge-queue.js）把模型建议与待判证据排成一列，判完即出队；
 *  4. theme:feed：提到原子 → 表态建议进待判；没提到 → 整条原文作为未挂原子数据进待判，不写新建原子建议；
 *     同一段原文不重复计入；上次没落账的条目复用重跑；判完后读者页按结论计数。
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCommandTestHarness } from './runtime-harness.mjs'

const DATA = join(tmpdir(), `meridian-builder-judge-${process.pid}`)
process.env.MERIDIAN_USER_DATA_DIR = DATA
process.env.MERIDIAN_MOCK_ENGINE = '1'
rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const { registry, invoke } = createCommandTestHarness(DATA)
const store = await import('../src/main/store.js')
const { registerDomainCommands } = await import('../src/main/domain-commands.js')
const { appendEvent, getEvents } = await import('../src/main/chain-events.js')
const { projectEvents, appendUnmappedEvidence } = await import('../src/main/chain-projector.js')
const { evidenceJudgeState } = await import('../src/shared/judge.js')
const { buildJudgeQueue } = await import('../src/renderer/lib/judge-queue.js')
const { buildAtomBoard } = await import('../src/renderer/lib/reader-board.js')
registerDomainCommands({ registry })
store.load()

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) pass++
  else fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}
const attempt = async (fn) => {
  try {
    const value = await fn()
    return value?.ok === false ? { ok: false, error: value.error, value } : { ok: true, value }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

/* ---------- 0. 共享口径：来源链接 / 要点 / 权重 ---------- */
{
  const { checkSourceUrl, normalizePoints, sourceHostOf } = await import('../src/shared/evidence-source.js')
  const { SOURCE_QUALITY, suggestWeight, weightOf, weightTier } = await import('../src/shared/evidence-weight.js')
  check('来源链接：合格的规范化（域名小写、去尾点前后空白）', checkSourceUrl(' https://WWW.Reuters.com/a?b=1 ').url === 'https://www.reuters.com/a?b=1'
    && checkSourceUrl('https://www.reuters.com./a').ok && checkSourceUrl('https://例子.中国/a').ok && sourceHostOf('https://www.reuters.com/a') === 'reuters.com')
  check('来源链接：非字符串 / 空 / 有空格 / 超长 → 拒绝', [null, undefined, 42, '', '   ', 'https://www.reuters.com/a b', `https://www.reuters.com/${'a'.repeat(2050)}`]
    .every((value) => checkSourceUrl(value).ok === false))
  check('来源链接：保留顶级域与示例二级域一律拒绝', ['test', 'example', 'invalid', 'localhost', 'local', 'internal', 'arpa', 'onion']
    .every((tld) => !checkSourceUrl(`https://site.${tld}/a`).ok) && ['example.com', 'example.net', 'example.org'].every((d) => !checkSourceUrl(`https://www.${d}/a`).ok))
  check('来源链接：IPv6 / 非法标签 / 数字顶级域 → 拒绝', !checkSourceUrl('http://[::1]/a').ok && !checkSourceUrl('https://-bad.com/a').ok
    && !checkSourceUrl('https://site.123/a').ok)
  check('要点：最多 12 条、每条最多 200 字、去重保序、非数组为空', normalizePoints(Array.from({ length: 20 }, (_, i) => `p${i}`)).length === 12
    && normalizePoints(['x'.repeat(300)])[0].length === 200 && JSON.stringify(normalizePoints(['b', { text: 'a' }, ' b ', null, 3])) === '["b","a"]'
    && normalizePoints('a').length === 0)
  check('权重：7 类来源 × 2 档硬度全部按整数分精确计算', JSON.stringify(SOURCE_QUALITY.map(([type]) => [weightOf({ sourceType: type, hardness: 'hard' }).value, weightOf({ sourceType: type, hardness: 'soft' }).value]))
    === JSON.stringify([[0.95, 0.67], [0.9, 0.63], [0.8, 0.56], [0.65, 0.46], [0.5, 0.35], [0.35, 0.25], [0.2, 0.14]]))
  check('权重：类型 / 硬度不合法 → null；传入的 value 被忽略', weightOf({ sourceType: '其他', hardness: 'hard' }) === null
    && weightOf({ sourceType: '自媒体', hardness: 'medium' }) === null && weightOf(null) === null && weightOf({ sourceType: '自媒体', hardness: 'hard', value: 1 }).value === 0.5)
  check('权重档：≥0.75 高，≥0.45 中，其余低', weightTier({ value: 0.75 }) === 'high' && weightTier({ value: 0.74 }) === 'mid'
    && weightTier({ value: 0.45 }) === 'mid' && weightTier({ value: 0.44 }) === 'low' && weightTier(null) === null)
  const via = (input) => { const s = suggestWeight(input); return [s.weight.sourceType, s.sourceVia, s.weight.hardness, s.hardnessVia] }
  check('建议权重：域名 > 打标 > 旧类型 > 关键词 > 独立媒体；硬度先看陈述类型，再看剔掉日期后有没有数字',
    JSON.stringify([
      via({ url: 'https://mp.weixin.qq.com/s/x', labelType: '财报 / 公告', text: '营收 3 亿' }),
      via({ url: 'https://www.unknown-site.cn/x', labelType: '券商研报', legacyType: '自媒体', text: '2026年' }),
      via({ labelType: '手工喂入', legacyType: '自媒体', text: '没有数字' }),
      via({ sourceLabel: '某公众号', text: '据说', statementType: 'hard' }),
      via({ text: '2026 年 3 月的事' }),
    ]) === JSON.stringify([
      ['自媒体', 'domain', 'hard', 'quantity'], ['券商研报', 'label', 'soft', 'quantity'], ['自媒体', 'legacy', 'soft', 'quantity'],
      ['自媒体', 'keywords', 'hard', 'statement'], ['独立媒体', 'default', 'soft', 'quantity'],
    ]))
}

/* ---------- 1. 待判口径 ---------- */
const ev = (fields) => ({ id: 'e', nodeType: 'evidence', kind: 'evidence', targetNodeIds: [], ...fields })
check('待复核且没决定 → pending', evidenceJudgeState(ev({ pendingReview: true, targetNodeIds: ['a'] })) === 'pending')
check('已有复核决定 → 不待判', evidenceJudgeState(ev({ pendingReview: false, reviewDecision: 'accepted' })) === null)
check('没目标、没表态边 → unmapped', evidenceJudgeState(ev({})) === 'unmapped')
check('没目标但有未驳回的表态边 → 不待判', evidenceJudgeState(ev({}), [{ from: 'e', to: 'a', rel: 'supports' }]) === null)
check('只有被驳回的表态边 → 仍是 unmapped', evidenceJudgeState(ev({}), [{ from: 'e', to: 'a', rel: 'supports', reviewDecision: 'rejected' }]) === 'unmapped')
check('只有关联边（非表态）→ 仍是 unmapped', evidenceJudgeState(ev({}), [{ from: 'e', to: 'a', rel: 'related' }]) === 'unmapped')
check('已挂原子、不待复核 → 不待判', evidenceJudgeState(ev({ targetNodeIds: ['a'] })) === null)
check('归档 / 失效 / 外部 / 非证据 → 不待判', [ev({ archived: true }), ev({ invalidated: true }), ev({ external: true }),
  { id: 'n', nodeType: 'viewpoint' }, null].every((node) => evidenceJudgeState(node) === null))

/* ---------- 2. chain:judgeEvidence ---------- */
const theme = store.addTheme('判定隔离主题')
const atomA = appendEvent(theme.id, { actor: 'user', type: 'claim.created', payload: { title: '北岸盐运', confidence: 60, status: 'pending', sourceRef: 'synthetic:a' } })
const atomB = appendEvent(theme.id, { actor: 'user', type: 'claim.created', payload: { title: '牲口损失', confidence: 50, status: 'pending', sourceRef: 'synthetic:b' } })
const pendingEvidence = (text, extra = {}) => appendEvent(theme.id, {
  actor: 'user', type: 'evidence.appended', payload: { text, sourceLabel: '合成来源', targetNodeId: atomA.id, pendingReview: true, ...extra },
})
const relation = (evidenceId, atomId, rel, extra = {}) => appendEvent(theme.id, {
  actor: 'user', type: 'relation.declared', payload: { rel, from: { eventId: evidenceId }, to: { eventId: atomId }, ...extra },
})
const projection = () => projectEvents(getEvents(theme.id))
const nodeOf = (id) => projection().nodes.find((node) => node.id === id)
const board = () => {
  const { nodes, edges } = projection()
  return buildAtomBoard({ nodes, edges, today: '2026-10-04' })
}
const rowsOf = (atomId, evidenceId) => {
  const atom = board().atoms.find((candidate) => candidate.id === atomId)
  return ['independent', 'related', 'pending', 'origin'].flatMap((bucket) => (atom?.[bucket] || [])
    .filter((row) => row.evidenceId === evidenceId).map((row) => row.stance))
}
const judge = (evidenceId, input) => attempt(() => invoke('chain:judgeEvidence', theme.id, evidenceId, input))

const e1 = pendingEvidence('运量增长了三成')
check('判之前：待复核证据在原子 A 上显示为待确认', JSON.stringify(rowsOf(atomA.id, e1.id)) === '["pending"]', JSON.stringify(rowsOf(atomA.id, e1.id)))
const beforeB = nodeOf(atomB.id).confidence
const r1 = await judge(e1.id, { stance: 'supports', atomId: atomB.id })
check('判给另一个原子 B 为佐证：成功', r1.ok, r1.error)
check('改判原子后：A 身上不残留，B 上计为佐证',
  rowsOf(atomA.id, e1.id).length === 0 && JSON.stringify(rowsOf(atomB.id, e1.id)) === '["support"]',
  JSON.stringify({ a: rowsOf(atomA.id, e1.id), b: rowsOf(atomB.id, e1.id) }))
check('佐证按手工补证同一公式更新原子强度', nodeOf(atomB.id).confidence > beforeB, `${beforeB} → ${nodeOf(atomB.id).confidence}`)
check('判过的证据不再待判', evidenceJudgeState(nodeOf(e1.id), projection().edges) === null)
const eventCount = getEvents(theme.id).length
const replay = await judge(e1.id, { stance: 'supports', atomId: atomB.id })
check('同结论重放：幂等，不追加事件', replay.ok && replay.value.replayed === true && getEvents(theme.id).length === eventCount)
const conflict = await judge(e1.id, { stance: 'contradicts', atomId: atomB.id })
check('不同结论重判：拒绝', !conflict.ok && /已经判过/.test(conflict.error), conflict.error)

const e2 = pendingEvidence('冬天牲口冻死不少')
relation(e2.id, atomA.id, 'supports')
const r2 = await judge(e2.id, { stance: 'contradicts', atomId: atomA.id })
check('旧建议边是佐证、判为反对：成功', r2.ok, r2.error)
check('旧佐证边被驳回，只计反对（不是"既佐证又反对"）', JSON.stringify(rowsOf(atomA.id, e2.id)) === '["against"]',
  JSON.stringify(rowsOf(atomA.id, e2.id)))

const e3 = pendingEvidence('盐运价格回升')
relation(e3.id, atomA.id, 'supports', { reviewStatus: 'pending-review' })
const relationCount = () => getEvents(theme.id).filter((event) => event.type === 'relation.declared' && !event.payload.reviewOf).length
const relationsBefore = relationCount()
const confidenceBefore = nodeOf(atomA.id).confidence
const r3 = await judge(e3.id, { stance: 'supports', atomId: atomA.id })
check('待复核的佐证边与结论一致：确认它，不重复声明、不重复更新强度',
  r3.ok && relationCount() === relationsBefore && nodeOf(atomA.id).confidence === confidenceBefore
  && JSON.stringify(rowsOf(atomA.id, e3.id)) === '["support"]',
  JSON.stringify({ ok: r3.ok, error: r3.error, rows: rowsOf(atomA.id, e3.id), relations: [relationsBefore, relationCount()] }))

const unmappedNeutral = appendUnmappedEvidence(theme.id, { text: '北岸来了新商队', sourceLabel: '合成来源', sourceKind: 'fed-evidence' }).at(-1)
check('未挂原子的数据：判之前待判且不出现在任何原子上', evidenceJudgeState(nodeOf(unmappedNeutral.id), projection().edges) === 'unmapped'
  && rowsOf(atomA.id, unmappedNeutral.id).length === 0)
const confidenceA = nodeOf(atomA.id).confidence
const r4 = await judge(unmappedNeutral.id, { stance: 'related', atomId: atomA.id })
check('中立：只挂原子、不写表态边、不动强度', r4.ok && JSON.stringify(rowsOf(atomA.id, unmappedNeutral.id)) === '["neutral"]'
  && nodeOf(atomA.id).confidence === confidenceA
  && !projection().edges.some((edge) => edge.from === unmappedNeutral.id), JSON.stringify({ error: r4.error, rows: rowsOf(atomA.id, unmappedNeutral.id) }))

const unmappedIrrelevant = appendUnmappedEvidence(theme.id, { text: '今天天气晴', sourceLabel: '合成来源', sourceKind: 'fed-evidence' }).at(-1)
const r5 = await judge(unmappedIrrelevant.id, { stance: 'irrelevant', atomId: atomA.id })
check('不相关：驳回，不计入任何原子', r5.ok && nodeOf(unmappedIrrelevant.id).reviewDecision === 'rejected'
  && board().atoms.every((atom) => rowsOf(atom.id, unmappedIrrelevant.id).length === 0), r5.error)

const e6 = pendingEvidence('另一条旧数据', { targetNodeId: atomB.id })
relation(e6.id, atomB.id, 'contradicts')
const r6 = await judge(e6.id, { stance: 'irrelevant' })
check('不相关时旧表态边一并驳回', r6.ok && projection().edges.filter((edge) => edge.from === e6.id)
  .every((edge) => edge.reviewDecision === 'rejected'), r6.error)

const mapped = appendEvent(theme.id, { actor: 'user', type: 'evidence.appended', payload: { text: '已定论的数据', targetNodeId: atomA.id } })
check('已挂原子、不待复核的证据：拒绝判', !(await judge(mapped.id, { stance: 'supports', atomId: atomA.id })).ok)
const e7 = pendingEvidence('还没判')
check('结论不在四种之内：拒绝', !(await judge(e7.id, { stance: 'derives', atomId: atomA.id })).ok)
check('佐证没选原子：拒绝', !(await judge(e7.id, { stance: 'supports' })).ok)
check('判给证据节点：拒绝', !(await judge(e7.id, { stance: 'supports', atomId: mapped.id })).ok)
check('找不到的证据：拒绝', !(await judge('evt:missing', { stance: 'related', atomId: atomA.id })).ok)
check('拒绝的尝试不留任何事件', evidenceJudgeState(nodeOf(e7.id), projection().edges) === 'pending')

/* ---------- 3 + 4. theme:feed → 判卡队列 → 读者页 ---------- */
const feedTheme = store.addTheme('喂数据隔离主题')
const saltAtom = appendEvent(feedTheme.id, { actor: 'user', type: 'claim.created', payload: { title: '北岸盐运', confidence: 60, status: 'pending', sourceRef: 'synthetic:salt' } })
const herdAtom = appendEvent(feedTheme.id, { actor: 'user', type: 'claim.created', payload: { title: '牲口损失', confidence: 60, status: 'pending', sourceRef: 'synthetic:herd' } })
const feed = (input) => attempt(() => invoke('theme:feed', feedTheme.id, input))
const queue = () => {
  const events = getEvents(feedTheme.id)
  const { nodes, edges } = projectEvents(events)
  return buildJudgeQueue({ events, nodes, edges })
}
const feedBoard = () => {
  const { nodes, edges } = projectEvents(getEvents(feedTheme.id))
  return buildAtomBoard({ nodes, edges, today: '2026-10-04' })
}

const SALT_URL = 'https://www.reuters.com/world/salt-route'
check('空原文：拒绝', !(await feed({ text: '   ', url: SALT_URL })).ok)
check('链接无效：拒绝', !(await feed({ text: '', url: 'not a url' })).ok)
check('主题不存在：拒绝', !(await attempt(() => invoke('theme:feed', 'theme-missing', { text: '北岸盐运增长', url: SALT_URL }))).ok)
{
  const inboxBefore = store.load().inbox.length
  const noUrl = await feed({ text: '北岸盐运增长了。', sourceLabel: '没有链接' })
  const fakeUrl = await feed({ text: '北岸盐运增长了。', url: 'https://example.test/salt' })
  const ipUrl = await feed({ text: '北岸盐运增长了。', url: 'http://10.0.0.8/salt' })
  check('喂数据没带来源链接：拒绝（missing-source-url），不落收件箱', !noUrl.ok && noUrl.value?.reason === 'missing-source-url'
    && store.load().inbox.length === inboxBefore, JSON.stringify(noUrl))
  check('来源链接是示例域名 / IP：拒绝（invalid-source-url），不落收件箱', !fakeUrl.ok && fakeUrl.value?.reason === 'invalid-source-url'
    && !ipUrl.ok && ipUrl.value?.reason === 'invalid-source-url' && store.load().inbox.length === inboxBefore, JSON.stringify([fakeUrl, ipUrl]))
}

const matchedText = '商队在大雪封路前把盐运到北岸，运量增长了30%。那年冬天牲口损失加剧。'
const fed = await feed({ text: matchedText, url: SALT_URL, sourceLabel: '商队日志', publishedAt: '2026-06-30' })
check('提到原子：成功，给出 2 条表态建议，未走未挂原子分支', fed.ok && fed.value.stanceProposals === 2 && fed.value.unmapped === false
  && fed.value.mocked === true, JSON.stringify(fed.value || fed.error))
const fedItem = store.load().inbox.find((item) => item.id === fed.value?.inboxId)
check('喂入条目已接受（不留在今日待处理）', fedItem?.status === 'accepted' && fedItem.label?.kind === '手工喂入')
let q = queue()
check('判卡队列：2 条模型建议，原子、结论、出处、发布日期都带上', q.counts.proposal === 2 && q.items.every((item) => item.kind === 'proposal'
  && item.quoteVerified && item.suggestion.atomId && item.sourceName === '商队日志' && item.date?.kind === '发布' && item.date?.day === '2026-06-30'),
JSON.stringify(q.items.map((item) => [item.suggestion, item.sourceName, item.date])))
check('喂入返回的建议 id 正是判卡队列里的那几条（界面据此直接选中第一条）',
  JSON.stringify([...(fed.value?.proposalEventIds || [])].sort()) === JSON.stringify(q.items.map((item) => item.id).sort()) && fed.value.evidenceId === null)
const supportItem = q.items.find((item) => item.suggestion.atomId === saltAtom.id)
check('建议结论来自 mock 的线索词', supportItem?.suggestion.stance === 'supports'
  && q.items.find((item) => item.suggestion.atomId === herdAtom.id)?.suggestion.stance === 'related')
check('判卡带来源链接与默认权重：来源类型按链接域名（reuters → 独立媒体），硬度按这一句（有 30% → 硬数据）',
  supportItem?.url === SALT_URL && JSON.stringify(supportItem?.weight?.weight) === JSON.stringify({ sourceType: '独立媒体', hardness: 'hard', value: 0.65 })
  && supportItem.weight.source === 'suggested'
  && q.items.find((item) => item.suggestion.atomId === herdAtom.id)?.weight?.weight?.hardness === 'soft',
JSON.stringify(q.items.map((item) => [item.url, item.weight])))

const saltBefore = projectEvents(getEvents(feedTheme.id)).nodes.find((node) => node.id === saltAtom.id).confidence
const accept = await attempt(() => invoke('chain:reviewEngineRecommendation', feedTheme.id, supportItem.id, 'accepted',
  { targetNodeId: saltAtom.id, rel: 'supports', weight: { sourceType: '财报 / 公告', hardness: 'hard', value: 0.01 } }))
check('判卡接受模型建议：成功', accept.ok, accept.error)
{
  const events = getEvents(feedTheme.id)
  const evidence = events.find((event) => event.type === 'evidence.appended' && event.payload?.recommendationId && event.payload?.weight)
  const confidence = events.find((event) => event.type === 'confidence.updated' && event.payload?.evidenceEventId === evidence?.id)
  const expected = Math.round((saltBefore / 100 + (1 - saltBefore / 100) * 0.95 * 0.3) * 100)
  check('接受时改了来源类型：权重按表重算（不信任传入的 0.01），证据记下权重与来源链接，强度按权重 0.95 更新',
    JSON.stringify(evidence?.payload.weight) === JSON.stringify({ sourceType: '财报 / 公告', hardness: 'hard', value: 0.95 })
    && evidence?.payload.sourceUrl === SALT_URL && confidence?.payload.strength === 0.95 && confidence?.payload.strengthSource === 'source-weight'
    && confidence?.payload.newConfidence === expected,
  JSON.stringify({ weight: evidence?.payload.weight, url: evidence?.payload.sourceUrl, confidence: confidence?.payload, expected }))
}
q = queue()
check('判完即出队', q.counts.proposal === 1 && !q.items.some((item) => item.id === supportItem.id))
const saltBoard = feedBoard().atoms.find((atom) => atom.id === saltAtom.id)
check('读者页：北岸盐运计 1 条佐证，出处、发布日期、来源链接、判定时的权重跟着证据走', saltBoard?.tallies.support === 1
  && saltBoard.independent[0]?.sourceName === '商队日志' && saltBoard.independent[0]?.date?.day === '2026-06-30'
  && saltBoard.independent[0]?.url === SALT_URL && saltBoard.independent[0]?.weight?.value === 0.95 && saltBoard.independent[0]?.weightSource === 'judged',
JSON.stringify(saltBoard?.independent))
const herdItem = q.items[0]
const corrected = await attempt(() => invoke('chain:reviewEngineRecommendation', feedTheme.id, herdItem.id, 'corrected',
  { targetNodeId: herdAtom.id, rel: 'contradicts' }))
check('判卡改判模型建议（中立 → 反对）：成功并计为反对', corrected.ok
  && feedBoard().atoms.find((atom) => atom.id === herdAtom.id)?.tallies.against === 1, corrected.error)

const duplicate = await feed({ text: `\n  ${matchedText}\n\n`, url: SALT_URL })
check('同一段原文（首尾空白不同）再喂：拒绝，不重复计入', !duplicate.ok && duplicate.value?.duplicate === true, duplicate.error)

const proposalsBefore = getEvents(feedTheme.id).filter((event) => event.type === 'engine.recommendation.proposed').length
const unrelated = await feed({ text: '今天下雨。明天放晴。', url: 'https://weather.example-station.cn/today', sourceLabel: '天气站' })
check('没提到原子：成功，整条原文作为未挂原子数据', unrelated.ok && unrelated.value.stanceProposals === 0 && unrelated.value.unmapped === true,
  JSON.stringify(unrelated.value || unrelated.error))
check('没提到原子时不写新建原子建议（同一条数据只有一个落点）',
  getEvents(feedTheme.id).filter((event) => event.type === 'engine.recommendation.proposed').length === proposalsBefore)
q = queue()
const unmappedItem = q.items.find((item) => item.kind === 'unmapped')
check('判卡队列：未挂原子数据带出处、入账日期，没有建议原子', q.counts.unmapped === 1 && unmappedItem?.sourceName === '天气站'
  && unmappedItem.quote === '今天下雨。明天放晴。' && unmappedItem.suggestion.atomId === null && unmappedItem.date?.kind === '摄入',
JSON.stringify(unmappedItem))
check('喂入返回的证据 id 就是这条未挂原子数据', unrelated.value?.evidenceId === unmappedItem?.id
  && Array.isArray(unrelated.value?.proposalEventIds) && unrelated.value.proposalEventIds.length === 0)

const stale = store.addInboxItem({
  text: '北岸盐运又增长了。', title: '北岸盐运又增长了。', extracted: true, extractedThemeId: feedTheme.id,
  createdAt: '2026-07-03T08:00:00.000Z', label: { kind: '手工喂入' }, provenance: { sourceLabel: '旧日志', platform: '手工喂入' },
})
const retried = await feed({ text: '北岸盐运又增长了。', url: 'https://www.caixin.com/salt-again', sourceLabel: '新填的来源' })
check('上次没落账的同文条目：复用重跑，出处沿用原条目，这次带的链接写回条目与建议', retried.ok && retried.value.inboxId === stale.id
  && store.load().inbox.find((item) => item.id === stale.id)?.status === 'accepted'
  && store.load().inbox.find((item) => item.id === stale.id)?.provenance?.url === 'https://www.caixin.com/salt-again'
  && queue().items.some((item) => item.kind === 'proposal' && item.sourceName === '旧日志' && item.url === 'https://www.caixin.com/salt-again'),
JSON.stringify(retried.value || retried.error))

/* ---------- 5. 今日「交给主题」：inbox:dispatch 与 theme:judgeCounts ---------- */
const { countJudgeItems } = await import('../src/shared/judge.js')
const { setInboxEnginePipeline } = await import('../src/main/chain-store.js')
const primary = store.addTheme('分拣主主题')
const secondary = store.addTheme('分拣副主题')
const gone = store.addTheme('分拣已删主题')
store.removeTheme(gone.id)
const claimIn = (themeId, title) => appendEvent(themeId, { actor: 'user', type: 'claim.created',
  payload: { title, confidence: 60, status: 'pending', sourceRef: `synthetic:${themeId}:${title}` } })
const primaryAtom = claimIn(primary.id, '北岸盐运')
const secondaryAtom = claimIn(secondary.id, '北岸盐运')
const queueOf = (themeId) => {
  const events = getEvents(themeId)
  const { nodes, edges } = projectEvents(events)
  return buildJudgeQueue({ events, nodes, edges })
}
const proposalsIn = (themeId) => getEvents(themeId).filter((event) => event.type === 'engine.recommendation.proposed').length
const dispatch = (id, themeIds) => attempt(() => invoke('inbox:dispatch', id, themeIds))
const inboxItem = (id) => store.load().inbox.find((item) => item.id === id)
const PROBE_URL = 'https://www.cninfo.com.cn/probe'
const rawItem = (text, extra = {}) => store.addInboxItem({ text, title: text, extracted: false, createdAt: '2026-09-02T08:00:00.000Z',
  provenance: { sourceLabel: '探针来源', platform: '探针', publishedAt: '2026-09-01', url: PROBE_URL }, ...extra })

const raw = rawItem('北岸盐运今年增长了。', { lemmas: [{ title: '盐运增长' }, { title: ' 盐运增长 ' }, { title: '北岸' }] })
check('分拣没选主题：拒绝', !(await dispatch(raw.id, [])).ok)
check('只选了已删 / 不存在的主题：拒绝，且不改条目主题', !(await dispatch(raw.id, [gone.id, 'theme-missing'])).ok
  && store.getInboxThemeIds(inboxItem(raw.id)).length === 0)
check('读数条目：拒绝', !(await dispatch(store.addInboxItem({ text: '良率 85%', kind: 'reading' }).id, [primary.id])).ok)
check('没有原文：拒绝', !(await dispatch(store.addInboxItem({ text: '   ' }).id, [primary.id])).ok)
check('找不到的条目：拒绝', !(await dispatch('inbox-missing', [primary.id])).ok)

const d1 = await dispatch(raw.id, [primary.id, gone.id, secondary.id, primary.id])
check('交给两个主题：成功；已删主题与重复项被剔除，第一个是主主题', d1.ok
  && JSON.stringify(d1.value.themeIds) === JSON.stringify([primary.id, secondary.id])
  && d1.value.stanceProposals === 1 && d1.value.evidenceId === null && d1.value.mocked === true
  && d1.value.others.length === 1 && d1.value.others[0].themeId === secondary.id && Boolean(d1.value.others[0].evidenceId),
JSON.stringify(d1.value || d1.error))
const pq = queueOf(primary.id)
check('主主题判卡：表态建议挂主主题自己的原子，出处 / 发布日期随条目', pq.counts.proposal === 1
  && pq.items[0]?.suggestion.atomId === primaryAtom.id && pq.items[0]?.sourceName === '探针来源' && pq.items[0]?.date?.day === '2026-09-01',
JSON.stringify(pq.items.map((item) => [item.suggestion, item.sourceName, item.date])))
const sq = queueOf(secondary.id)
check('副主题判卡：整条原文作为未挂原子数据，不写建议', sq.counts.unmapped === 1 && sq.counts.proposal === 0
  && sq.items[0]?.id === d1.value?.others?.[0]?.evidenceId && sq.items[0]?.quote === '北岸盐运今年增长了。' && sq.items[0]?.sourceName === '探针来源',
JSON.stringify(sq.items))
check('要点跟着原文进主题：主主题建议记 sourcePoints，副主题证据记 points（归一去重），判卡两边都带出要点',
  JSON.stringify(pq.items[0]?.points) === '["盐运增长","北岸"]' && JSON.stringify(sq.items[0]?.points) === '["盐运增长","北岸"]'
  && getEvents(primary.id).some((event) => event.type === 'engine.recommendation.proposed' && JSON.stringify(event.payload.sourcePoints) === '["盐运增长","北岸"]'),
JSON.stringify({ primary: pq.items[0]?.points, secondary: sq.items[0]?.points }))
check('副主题证据记下建议权重：来源类型按链接域名（cninfo → 财报 / 公告），整条原文没有数字 → 观点（0.95 × 0.7 = 0.67）',
  JSON.stringify(sq.items[0]?.weight) === JSON.stringify({ weight: { sourceType: '财报 / 公告', hardness: 'soft', value: 0.67 }, source: 'suggested', sourceVia: null })
  && sq.items[0]?.url === PROBE_URL, JSON.stringify(sq.items[0]?.weight))
check('只落账、不裁决：条目仍待处理，主题按选择顺序记下', inboxItem(raw.id).status === 'pending'
  && JSON.stringify(store.getInboxThemeIds(inboxItem(raw.id))) === JSON.stringify([primary.id, secondary.id]))
check('缓存的流水线记下算它的主题', inboxItem(raw.id).enginePipeline?.themeId === primary.id)

const counted = [getEvents(primary.id).length, getEvents(secondary.id).length]
const d2 = await dispatch(raw.id, [primary.id, secondary.id])
check('重试分拣：幂等，两个主题都不追加事件，返回同一批 id', d2.ok
  && getEvents(primary.id).length === counted[0] && getEvents(secondary.id).length === counted[1]
  && JSON.stringify(d2.value.proposalEventIds) === JSON.stringify(d1.value.proposalEventIds)
  && d2.value.others[0]?.evidenceId === d1.value.others[0]?.evidenceId, JSON.stringify(d2.value || d2.error))
await invoke('inbox:resolve', raw.id, 'accept')
check('接受后再交：拒绝', inboxItem(raw.id).status === 'accepted' && !(await dispatch(raw.id, [primary.id])).ok)

const offTopic = rawItem('今天下雨。明天放晴。')
const d3 = await dispatch(offTopic.id, [primary.id])
check('没提到原子：主主题收一条未挂原子数据，不写新建原子建议', d3.ok && d3.value.stanceProposals === 0
  && Boolean(d3.value.evidenceId) && proposalsIn(primary.id) === pq.counts.proposal
  && queueOf(primary.id).items.some((item) => item.kind === 'unmapped' && item.id === d3.value.evidenceId), JSON.stringify(d3.value || d3.error))
check('跳过的新建原子结果仍留在流水线缓存里（缓存不随落账口径收窄）',
  (inboxItem(offTopic.id).enginePipeline?.results || []).some((result) => result.kind === 'new-proposition'))

const rerouted = rawItem('北岸盐运去年也增长了。', { extracted: true, extractedThemeId: primary.id })
const ran = await attempt(() => invoke('engine:runPipeline', rerouted.id))
check('先在原主题跑过引擎', ran.ok && inboxItem(rerouted.id).enginePipeline?.themeId === primary.id, ran.error)
const legacy = { ...inboxItem(rerouted.id).enginePipeline }
delete legacy.themeId
setInboxEnginePipeline(rerouted.id, legacy)
const primaryProposals = proposalsIn(primary.id)
const d4 = await dispatch(rerouted.id, [secondary.id])
const reroutedProposals = queueOf(secondary.id).items.filter((item) => item.kind === 'proposal')
check('改交别的主题：不复用别的主题算的流水线（老缓存也不），建议挂副主题自己的原子', d4.ok && d4.value.stanceProposals === 1
  && reroutedProposals.length === 1 && reroutedProposals[0].suggestion.atomId === secondaryAtom.id
  && inboxItem(rerouted.id).enginePipeline?.themeId === secondary.id, JSON.stringify(reroutedProposals.map((item) => item.suggestion)))
check('原主题不因改交多出建议', proposalsIn(primary.id) === primaryProposals)

const homed = rawItem('北岸盐运前年同样增长了。', { extracted: true, extractedThemeId: primary.id })
await invoke('engine:runPipeline', homed.id)
setInboxEnginePipeline(homed.id, { ...inboxItem(homed.id).enginePipeline, themeId: undefined, ranAt: 'legacy-marker' })
const homedProposals = proposalsIn(primary.id)
const d5 = await dispatch(homed.id, [primary.id])
check('老缓存交回算它的主题：复用（不重跑模型），不多写建议，并补记主题', d5.ok && d5.value.stanceProposals === 1
  && inboxItem(homed.id).enginePipeline?.ranAt === 'legacy-marker' && inboxItem(homed.id).enginePipeline?.themeId === primary.id
  && proposalsIn(primary.id) === homedProposals, JSON.stringify(d5.value || d5.error))

const counts = await invoke('theme:judgeCounts')
const expectedOf = (themeId) => queueOf(themeId).counts
check('各主题待判数与建设者待判队列同口径', counts.ok
  && [primary.id, secondary.id, feedTheme.id, theme.id].every((themeId) => {
    const expected = expectedOf(themeId)
    const got = counts.counts[themeId]
    return got && ['proposal', 'pending', 'unmapped', 'total'].every((key) => got[key] === expected[key])
  }), JSON.stringify({ got: counts.counts?.[secondary.id], expected: expectedOf(secondary.id) }))
check('已删主题不计待判', counts.ok && !Object.hasOwn(counts.counts, gone.id))
check('副主题：1 条建议 + 1 条未挂原子', counts.counts?.[secondary.id]?.proposal === 1 && counts.counts?.[secondary.id]?.unmapped === 1
  && counts.counts?.[secondary.id]?.total === 2)
const emptyCounts = countJudgeItems()
check('countJudgeItems 无参：全零', ['proposal', 'pending', 'unmapped', 'total'].every((key) => emptyCounts[key] === 0))

const poisoned = rawItem('北岸盐运大前年也增长了。', { extracted: true, extractedThemeId: primary.id })
await invoke('engine:runPipeline', poisoned.id)
setInboxEnginePipeline(poisoned.id, { ...inboxItem(poisoned.id).enginePipeline, themeId: undefined })
appendEvent(secondary.id, { actor: 'engine', type: 'engine.recommendation.proposed', payload: {
  pendingReview: true, recommendationId: 'engine:legacy-cross-theme', inboxId: poisoned.id,
  recommendation: { kind: 'evidence', rel: 'supports', propositionId: primaryAtom.id, title: '北岸盐运' }, statement: {},
} })
const d6 = await dispatch(poisoned.id, [secondary.id])
const poisonedProposals = queueOf(secondary.id).items.filter((item) => item.kind === 'proposal' && d6.value?.proposalEventIds?.includes(item.id))
check('老缓存引用的是别的主题的原子：即使目标主题账本里有旧版跨主题写下的建议，也不复用，重算后挂目标主题自己的原子',
  d6.ok && inboxItem(poisoned.id).enginePipeline?.themeId === secondary.id
  && poisonedProposals.length === 1 && poisonedProposals[0].suggestion.atomId === secondaryAtom.id,
JSON.stringify({ result: d6.value || d6.error, suggestions: poisonedProposals.map((item) => item.suggestion) }))

const judgedOnce = rawItem('北岸盐运上个月增长了。')
const d7 = await dispatch(judgedOnce.id, [primary.id])
const judgedProposal = d7.value?.proposalEventIds?.[0]
const accepted = judgedProposal && await attempt(() => invoke('chain:reviewEngineRecommendation', primary.id, judgedProposal, 'accepted',
  { targetNodeId: primaryAtom.id, rel: 'supports' }))
const settled = getEvents(primary.id).length
const d8 = await dispatch(judgedOnce.id, [primary.id])
check('表态建议已经判过再交：不再算作待判，也不补未挂原子证据，不追加事件', d7.ok && accepted?.ok && d8.ok
  && d8.value.stanceProposals === 0 && d8.value.proposalEventIds.length === 0 && d8.value.evidenceId === null
  && getEvents(primary.id).length === settled, JSON.stringify({ d7: d7.value || d7.error, accepted: accepted?.error, d8: d8.value || d8.error }))

/* ---------- 6. 来源链接硬性要求：inbox:dispatch 拦截、inbox:setSourceUrl 补链接 ---------- */
const setUrl = (id, url) => attempt(() => invoke('inbox:setSourceUrl', id, url))
const noLink = rawItem('北岸盐运本周增长了。', { provenance: { sourceLabel: '口头转述', platform: '探针' } })
const primaryEventsBefore = getEvents(primary.id).length
const blocked = await dispatch(noLink.id, [primary.id])
check('没有来源链接：交给主题被拒（missing-source-url），不写主题账本、不改条目主题', !blocked.ok && blocked.value?.reason === 'missing-source-url'
  && getEvents(primary.id).length === primaryEventsBefore && store.getInboxThemeIds(inboxItem(noLink.id)).length === 0, JSON.stringify(blocked))
const fakeLink = rawItem('北岸盐运本月增长了。', { provenance: { sourceLabel: '假链接', url: 'https://example.com/a' } })
check('记下的链接是示例域名：同样被拒', !(await dispatch(fakeLink.id, [primary.id])).ok && getEvents(primary.id).length === primaryEventsBefore)
for (const [label, bad] of [['不是网址', 'not a url'], ['非 http(s)', 'ftp://files.cninfo.com.cn/a'], ['带账号密码', 'https://u:p@www.cninfo.com.cn/a'],
  ['示例域名', 'https://foo.example/a'], ['内网域名', 'https://wiki.internal/a'], ['IP 地址', 'http://127.0.0.1/a'], ['没有点的域名', 'https://intranet/a']]) {
  const res = await setUrl(noLink.id, bad)
  check(`补链接：${label} → 拒绝，不改条目`, !res.ok && !inboxItem(noLink.id).provenance?.url, JSON.stringify(res))
}
const fixed = await setUrl(noLink.id, '  https://WWW.Cninfo.com.cn/notice?id=7  ')
check('补链接：合格的网址规范化后写入，来源名保留原值、平台保留原值', fixed.ok && fixed.value.url === 'https://www.cninfo.com.cn/notice?id=7'
  && inboxItem(noLink.id).provenance.url === 'https://www.cninfo.com.cn/notice?id=7'
  && inboxItem(noLink.id).provenance.sourceLabel === '口头转述' && inboxItem(noLink.id).provenance.platform === '探针', JSON.stringify(fixed))
const bare = store.addInboxItem({ text: '没有来源信息的条目', title: '没有来源信息的条目' })
const bareFixed = await setUrl(bare.id, 'https://www.thepaper.cn/news/1')
check('补链接：原来没有来源名的条目用域名（去掉 www.）补上来源名 / 平台', bareFixed.ok && inboxItem(bare.id).provenance.sourceLabel === 'thepaper.cn'
  && inboxItem(bare.id).provenance.platform === 'thepaper.cn', JSON.stringify(inboxItem(bare.id).provenance))
check('补链接之后可以交给主题', (await dispatch(noLink.id, [primary.id])).ok)
await invoke('inbox:resolve', noLink.id, 'accept')
check('已处理的条目：不能再改来源链接', !(await setUrl(noLink.id, 'https://www.cninfo.com.cn/other')).ok
  && inboxItem(noLink.id).provenance.url === 'https://www.cninfo.com.cn/notice?id=7')
check('读数条目 / 找不到的条目：拒绝补链接', !(await setUrl(store.addInboxItem({ text: '良率 85%', kind: 'reading' }).id, PROBE_URL)).ok
  && !(await setUrl('inbox-missing', PROBE_URL)).ok)

/* ---------- 7. 权重：chain:judgeEvidence 落账与重放 ---------- */
const weightTheme = store.addTheme('权重隔离主题')
const weightAtom = appendEvent(weightTheme.id, { actor: 'user', type: 'claim.created', payload: { title: '北岸盐运', confidence: 40, status: 'pending', sourceRef: 'synthetic:w' } })
const weightNode = (id) => projectEvents(getEvents(weightTheme.id)).nodes.find((node) => node.id === id)
const judgeW = (evidenceId, input) => attempt(() => invoke('chain:judgeEvidence', weightTheme.id, evidenceId, input))
const unmapped = (text, extra = {}) => appendUnmappedEvidence(weightTheme.id, { text, sourceLabel: '合成来源', sourceKind: 'fed-evidence', ...extra }).at(-1)

const suggested = unmapped('盐运量增长 12%', { url: 'https://www.cicc.com/report/1', weight: { sourceType: '券商研报', hardness: 'hard' } })
check('进主题时记下的建议权重：投影带出（suggested）', JSON.stringify(weightNode(suggested.id).weight) === JSON.stringify({ sourceType: '券商研报', hardness: 'hard', value: 0.8 })
  && weightNode(suggested.id).weightSource === 'suggested')
const w0 = weightNode(weightAtom.id).confidence
const wDefault = await judgeW(suggested.id, { stance: 'supports', atomId: weightAtom.id })
const wDefaultConfidence = getEvents(weightTheme.id).find((event) => event.type === 'confidence.updated' && event.payload.evidenceEventId === suggested.id)
check('判的时候没给权重：用建议权重 0.80，强度按它更新，投影改为 judged',
  wDefault.ok && wDefaultConfidence?.payload.strength === 0.8 && wDefaultConfidence.payload.strengthSource === 'source-weight'
  && wDefaultConfidence.payload.newConfidence === Math.round((w0 / 100 + (1 - w0 / 100) * 0.8 * 0.3) * 100)
  && weightNode(suggested.id).weightSource === 'judged', JSON.stringify({ error: wDefault.error, confidence: wDefaultConfidence?.payload }))
const wEvents = getEvents(weightTheme.id).length
check('同结论不带权重重放：权重取判定时的那个，幂等', (await judgeW(suggested.id, { stance: 'supports', atomId: weightAtom.id })).value?.replayed === true
  && getEvents(weightTheme.id).length === wEvents)
check('同结论带同一权重重放：幂等', (await judgeW(suggested.id, { stance: 'supports', atomId: weightAtom.id, weight: { sourceType: '券商研报', hardness: 'hard' } })).value?.replayed === true)
check('同结论换权重：拒绝（改判要追加更正）', !(await judgeW(suggested.id, { stance: 'supports', atomId: weightAtom.id, weight: { sourceType: '自媒体', hardness: 'soft' } })).ok
  && getEvents(weightTheme.id).length === wEvents)

const overridden = unmapped('有人说盐运要涨', { weight: { sourceType: '独立媒体', hardness: 'soft' } })
const w1 = weightNode(weightAtom.id).confidence
const wOverride = await judgeW(overridden.id, { stance: 'contradicts', atomId: weightAtom.id, weight: { sourceType: '群聊转发', hardness: 'soft', value: 0.99 } })
const wOverrideConfidence = getEvents(weightTheme.id).find((event) => event.type === 'confidence.updated' && event.payload.evidenceEventId === overridden.id)
check('判的时候改了来源类型：分值按表重算（0.35 × 0.7 = 0.25，不信任传入的 0.99），反对按它更新强度',
  wOverride.ok && JSON.stringify(weightNode(overridden.id).weight) === JSON.stringify({ sourceType: '群聊转发', hardness: 'soft', value: 0.25 })
  && wOverrideConfidence?.payload.strength === 0.25 && wOverrideConfidence.payload.newConfidence === Math.round((w1 / 100 - (w1 / 100) * 0.25 * 0.5) * 100),
JSON.stringify({ error: wOverride.error, weight: weightNode(overridden.id).weight, confidence: wOverrideConfidence?.payload }))

const legacyEvidence = unmapped('旧数据没有权重')
const badWeight = await judgeW(legacyEvidence.id, { stance: 'supports', atomId: weightAtom.id, weight: { sourceType: '乱写', hardness: 'hard' } })
check('权重不合法：拒绝，不写事件', !badWeight.ok && /权重无效/.test(badWeight.error) && weightNode(legacyEvidence.id).weightSource === null)
const neutralW = await judgeW(legacyEvidence.id, { stance: 'related', atomId: weightAtom.id })
check('旧数据没记权重、判为中立：按同一规则现算（没线索 → 独立媒体，没数字 → 观点 0.46）并记下，不动强度',
  neutralW.ok && JSON.stringify(weightNode(legacyEvidence.id).weight) === JSON.stringify({ sourceType: '独立媒体', hardness: 'soft', value: 0.46 })
  && !getEvents(weightTheme.id).some((event) => event.type === 'confidence.updated' && event.payload.evidenceEventId === legacyEvidence.id),
JSON.stringify(weightNode(legacyEvidence.id)))
const irrelevantW = unmapped('不相关的数据', { weight: { sourceType: '自媒体', hardness: 'soft' } })
await judgeW(irrelevantW.id, { stance: 'irrelevant', weight: { sourceType: '财报 / 公告', hardness: 'hard' } })
const irrelevantReview = getEvents(weightTheme.id).find((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === irrelevantW.id)
check('不相关：不记权重（不计入任何原子）', irrelevantReview?.payload.decision === 'rejected' && !Object.hasOwn(irrelevantReview.payload, 'weight')
  && weightNode(irrelevantW.id).weightSource === 'suggested')

/* ---------- 8. 建议早于补链接：判卡展示与采纳落账都用原条目当前的链接 ---------- */
const lateTheme = store.addTheme('补链接隔离主题')
const lateAtom = appendEvent(lateTheme.id, { actor: 'user', type: 'claim.created', payload: { title: '北岸盐运', confidence: 40, status: 'pending', sourceRef: 'synthetic:late' } })
const LATE_URL = 'https://www.cninfo.com.cn/late?id=9'
const lateProposal = (inboxId, tag, extra = {}) => appendEvent(lateTheme.id, { actor: 'engine', type: 'engine.recommendation.proposed', payload: {
  pendingReview: true, recommendationId: `engine:late:${tag}`, inboxId, sourceLabel: '补链接探针',
  recommendation: { kind: 'evidence', rel: 'supports', propositionId: lateAtom.id, title: '北岸盐运' },
  statement: { sourceText: `北岸盐运增长 ${tag}%`, sourceQuoteVerified: true, type: 'hard' }, ...extra,
} })
const linkedLater = rawItem('北岸盐运增长 7%', { provenance: { sourceLabel: '补链接探针', url: LATE_URL } })
const stillNoLink = rawItem('北岸盐运增长 8%', { provenance: { sourceLabel: '补链接探针' } })
const fakeLater = rawItem('北岸盐运增长 9%', { provenance: { sourceLabel: '补链接探针', url: 'https://www.example.com/a' } })
const pLate = lateProposal(linkedLater.id, '7')
const pNoLink = lateProposal(stillNoLink.id, '8')
const pRecorded = lateProposal(linkedLater.id, '6', { sourceUrl: PROBE_URL })
lateProposal(fakeLater.id, '9')

const urlsRes = await invoke('inbox:sourceUrls', [linkedLater.id, stillNoLink.id, fakeLater.id, 'inbox-missing', '', null, linkedLater.id])
check('inbox:sourceUrls：只返回合格链接；没链接 / 示例域名 / 找不到 / 空 id 都不出现', urlsRes.ok
  && JSON.stringify(urlsRes.urls) === JSON.stringify({ [linkedLater.id]: LATE_URL }), JSON.stringify(urlsRes))
check('inbox:sourceUrls：非数组入参 → 空表', JSON.stringify((await invoke('inbox:sourceUrls', 'x')).urls) === '{}'
  && JSON.stringify((await invoke('inbox:sourceUrls')).urls) === '{}')

const lateQueue = (inboxSourceUrls) => {
  const events = getEvents(lateTheme.id)
  const { nodes, edges } = projectEvents(events)
  return buildJudgeQueue({ events, nodes, edges, inboxSourceUrls })
}
const lateItem = (queue, id) => queue.items.find((item) => item.id === id)
const withUrls = lateQueue(urlsRes.urls)
check('判卡：建议没记链接 → 用原条目当前的链接（urlVia=inbox），建议权重按这个链接的域名现算（cninfo 财报 / 公告 × 硬数据 = 0.95）',
  lateItem(withUrls, pLate.id)?.url === LATE_URL && lateItem(withUrls, pLate.id)?.urlVia === 'inbox'
  && JSON.stringify(lateItem(withUrls, pLate.id)?.weight) === JSON.stringify({ weight: { sourceType: '财报 / 公告', hardness: 'hard', value: 0.95 }, source: 'estimated', sourceVia: 'domain' }),
JSON.stringify(lateItem(withUrls, pLate.id)))
check('判卡：建议自己记了合格链接 → 用记下的（urlVia=proposal），不被原条目链接覆盖',
  lateItem(withUrls, pRecorded.id)?.url === PROBE_URL && lateItem(withUrls, pRecorded.id)?.urlVia === 'proposal')
check('判卡：原条目也没有合格链接 → 仍是缺链接', lateItem(withUrls, pNoLink.id)?.url === null && lateItem(withUrls, pNoLink.id)?.urlVia === null)
check('判卡：兜底表里的不合格链接被忽略；不传兜底表时与旧行为一致', lateItem(lateQueue({ [linkedLater.id]: 'https://foo.example/a' }), pLate.id)?.url === null
  && lateItem(lateQueue(), pLate.id)?.url === null && lateItem(lateQueue(null), pLate.id)?.url === null)

const FORGED = 'https://www.thepaper.cn/forged'
const lateAccept = await attempt(() => invoke('chain:reviewEngineRecommendation', lateTheme.id, pLate.id, 'accepted',
  { targetNodeId: lateAtom.id, rel: 'supports', fallbackSourceUrl: FORGED }))
const lateEvidence = getEvents(lateTheme.id).find((event) => event.type === 'evidence.appended' && event.payload.recommendationId === 'engine:late:7')
check('采纳：证据写进原条目当前的链接（与判卡展示一致），调用方伪造的 fallbackSourceUrl 被丢弃',
  lateAccept.ok && lateEvidence?.payload.sourceUrl === LATE_URL
  && JSON.stringify(lateEvidence.payload.evidenceRefs) === JSON.stringify([{ type: 'url', id: LATE_URL, title: '补链接探针' }]),
JSON.stringify({ error: lateAccept.error, payload: lateEvidence?.payload }))
const lateRows = buildAtomBoard(projectEvents(getEvents(lateTheme.id))).atoms?.flatMap((atom) => atom.independent || []) || []
check('采纳后读者页这条证据带原文链接', lateRows.some((row) => row.url === LATE_URL), JSON.stringify(lateRows.map((row) => row.url)))
const lateCount = getEvents(lateTheme.id).length
check('采纳重放：链接不参与意图比对，幂等不追加', (await attempt(() => invoke('chain:reviewEngineRecommendation', lateTheme.id, pLate.id, 'accepted',
  { targetNodeId: lateAtom.id, rel: 'supports' }))).value?.replayed === true && getEvents(lateTheme.id).length === lateCount)
const noLinkAccept = await attempt(() => invoke('chain:reviewEngineRecommendation', lateTheme.id, pNoLink.id, 'accepted',
  { targetNodeId: lateAtom.id, rel: 'supports', fallbackSourceUrl: FORGED }))
const noLinkEvidence = getEvents(lateTheme.id).find((event) => event.type === 'evidence.appended' && event.payload.recommendationId === 'engine:late:8')
check('采纳：原条目也没链接 → 证据不带链接（伪造的兜底同样丢弃）', noLinkAccept.ok && noLinkEvidence
  && !Object.hasOwn(noLinkEvidence.payload, 'sourceUrl') && noLinkEvidence.payload.evidenceRefs.length === 0, JSON.stringify(noLinkEvidence?.payload))
const recordedAccept = await attempt(() => invoke('chain:reviewEngineRecommendation', lateTheme.id, pRecorded.id, 'accepted', { targetNodeId: lateAtom.id, rel: 'supports' }))
const recordedEvidence = getEvents(lateTheme.id).find((event) => event.type === 'evidence.appended' && event.payload.recommendationId === 'engine:late:6')
check('采纳：建议自己记了合格链接 → 用记下的', recordedAccept.ok && recordedEvidence?.payload.sourceUrl === PROBE_URL)


console.log(`\nBuilder judge: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
