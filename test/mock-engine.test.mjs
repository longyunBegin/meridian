/**
 * Mock 引擎测试（MERIDIAN_MOCK_ENGINE=1）。
 *
 * 运行：node test/mock-engine.test.mjs
 *
 * 守住四件事：
 *  1. mock 模式不调 LLM、不需要 API key，只产出可审核建议；
 *  2. 归因是确定性的字面规则：原子标题的二字组 / 拉丁词在某句命中 ≥ 一半才算提到；表态只看那一句的线索词；
 *  3. 不预设任何领域——主体取条目标题，数值只来自原文（日期不算数值），时间窗口只在原文写了时才带；
 *     摘录必须是原文逐字整句，否则确认会被核验闸门挡住；证据节点不是候选原子；
 *  4. 审阅 change 只有 note 字段；同一条目重跑不重复落账。
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCommandTestHarness } from './runtime-harness.mjs'

const DATA = join(tmpdir(), `meridian-mock-engine-${process.pid}`)
process.env.MERIDIAN_USER_DATA_DIR = DATA
process.env.MERIDIAN_MOCK_ENGINE = '1'
rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const { registry, invoke } = createCommandTestHarness(DATA)
const store = await import('../src/main/store.js')
const { registerDomainCommands } = await import('../src/main/domain-commands.js')
const { appendEvent, getEvents } = await import('../src/main/chain-events.js')
const mock = await import('../src/main/mock-engine.js')
registerDomainCommands({ registry })
store.load()

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) pass++
  else fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ---------- 纯规则 ---------- */
check('切句：按中英文句末标点切，保留标点，末句无标点也保留',
  same(mock.splitSentences('甲。乙！  丙？丁'), ['甲。', '乙！', '丙？', '丁']), JSON.stringify(mock.splitSentences('甲。乙！  丙？丁')))
check('标题匹配单元：中文二字组 + 拉丁词（小写），去重',
  same(mock.titleTokens('光子 AI芯片'), ['光子', '芯片', 'ai']), JSON.stringify(mock.titleTokens('光子 AI芯片')))
check('单字中文标题取单字', same(mock.titleTokens('盐'), ['盐']))
check('表态线索：只有正向 → 佐证', mock.stanceOfSentence('营收增长') === 'supports')
check('表态线索：只有反向 → 反对', mock.stanceOfSentence('交付推迟') === 'contradicts')
check('表态线索：正反都有 → 中立', mock.stanceOfSentence('营收增长但交付推迟') === 'related')
check('表态线索：都没有 → 中立', mock.stanceOfSentence('公司发布公告') === 'related')
check('数量：日期不算数值', mock.quantityOf('2026年3月发布新品') === null)
check('数量：剔掉日期后取第一个数量及单位', same([...(mock.quantityOf('2026年营收增长30%') || [])].slice(1, 3), ['30', '%']))

{
  const atoms = [
    { id: 'low', title: '冬季牲口损失' }, // 5 个二字组，句中只命中「牲口」= 1/5，不够一半
    { id: 'mid', title: '北岸盐运' }, // 北岸 / 岸盐 / 盐运 命中 2/3
    { id: 'top', title: '牲口' }, // 1/1
    { id: 'tie', title: '盐运' }, // 1/1，与 top 同比例同命中数，账本顺序在后
  ]
  const ranked = mock.rankAtomMentions(['商队把盐运到北岸。', '冻死了三分之一的牲口。'], atoms)
  check('命中比例不到一半的原子不算提到', !ranked.some((mention) => mention.atom.id === 'low'), JSON.stringify(ranked.map((m) => m.atom.id)))
  check('排序：比例降序 → 命中数降序 → 账本顺序', same(ranked.map((mention) => mention.atom.id), ['top', 'tie', 'mid']),
    JSON.stringify(ranked.map((m) => [m.atom.id, m.ratio, m.hits])))
}

{
  const item = { title: '北岸盐运记录', text: '商队在大雪封路前把盐运到北岸，运量增长了30%。\n那年冬天牲口损失加剧。' }
  const atoms = [{ id: 'a1', title: '北岸盐运' }, { id: 'a2', title: '牲口损失' }, { id: 'a3', title: '港口吞吐' }]
  const first = mock.buildMockPipeline(item, atoms)
  const second = mock.buildMockPipeline(item, atoms)
  check('同样输入永远同样输出', same(first, second))
  check('只对提到的原子出建议，按比例排序', same(first.results.map((r) => [r.proposition.id, r.attribution.rel]), [['a2', 'related'], ['a1', 'supports']]),
    JSON.stringify(first.results.map((r) => [r.proposition?.id, r.attribution.rel])))
  const byAtom = Object.fromEntries(first.results.map((r) => [r.proposition.id, r.statement]))
  check('引文是原文整句（空白归一后逐字可查）', first.results.every((r) => item.text.replace(/\s+/g, ' ').includes(r.statement.sourceText)),
    JSON.stringify(first.results.map((r) => r.statement.sourceText)))
  check('有数量 → 硬数据 + 取原文数值；没有 → 软数据 + 未量化',
    byAtom.a1.type === 'hard' && byAtom.a1.value === '30%' && byAtom.a2.type === 'soft' && byAtom.a2.value === '未量化',
    JSON.stringify([byAtom.a1, byAtom.a2]))
  check('主体取条目标题，属性取原子标题', byAtom.a1.subject === item.title && byAtom.a1.attribute === '北岸盐运')
  check('原文没写时间窗口就留空', first.statements.every((s) => s.timeWindow === ''))
  check('原文写了时间窗口才带上', mock.buildMockPipeline({ title: 't', text: '2026年 北岸盐运增长。' }, atoms).statements[0]?.timeWindow === '2026年')

  const capped = mock.buildMockPipeline({ title: 't', text: '甲乙丙丁戊己。' },
    [{ id: 'x1', title: '甲乙' }, { id: 'x2', title: '丙丁' }, { id: 'x3', title: '戊己' }])
  check(`最多 ${mock.MAX_TARGETS} 个原子`, capped.results.length === mock.MAX_TARGETS
    && same(capped.results.map((r) => r.proposition.id), ['x1', 'x2']))

  const none = mock.buildMockPipeline({ title: '无关', text: '今天下雨。明天放晴。' }, atoms)
  check('一个原子都没提到 → 只给一条新建原子建议（取第一句）', none.results.length === 1
    && none.results[0].kind === 'new-proposition' && none.results[0].statement.sourceText === '今天下雨。'
    && none.results[0].suggestedTitle === '今天下雨', JSON.stringify(none.results))
  check('空原文不出任何建议', mock.buildMockPipeline({ title: '空', text: '   ' }, atoms).results.length === 0)
}

/* ---------- 命令流程 ---------- */
const theme = store.addTheme('去领域化 mock 主题')
const saltAtom = appendEvent(theme.id, {
  actor: 'user', type: 'claim.created',
  payload: { title: '北岸盐运', confidence: 60, status: 'pending', sourceRef: 'synthetic:salt' },
})
const herdAtom = appendEvent(theme.id, {
  actor: 'user', type: 'claim.created',
  payload: { title: '牲口损失', confidence: 60, status: 'pending', sourceRef: 'synthetic:herd' },
})
/* 一条标题与原文完全重合的证据节点：它不是原子，不能成为候选。 */
const decoy = appendEvent(theme.id, {
  actor: 'user', type: 'evidence.appended',
  payload: { text: '盐运到北岸', targetNodeId: saltAtom.id, sourceLabel: '隔离合成来源' },
})
const sourceText = '商队在大雪封路前把盐运到北岸，运量增长了30%。那年冬天牲口损失加剧。'
const inbox = store.addInboxItem({
  text: sourceText, title: '北岸盐运记录', extracted: true, extractedThemeId: theme.id,
  createdAt: '2026-07-01T08:30:00.000Z',
  provenance: { platform: 'synthetic-test', sourceLabel: '隔离合成来源' },
})

// 注意：这里刻意不配置 API key / baseUrl——mock 模式不该依赖它们。
const generated = await invoke('engine:runPipeline', inbox.id)
const pipeline = generated?.pipeline
const results = pipeline?.results || []
check('mock 模式无 key 也能跑通并标记 mocked', generated?.ok === true && pipeline?.status === 'done'
  && pipeline?.mocked === true, JSON.stringify({ ok: generated?.ok, status: pipeline?.status, mocked: pipeline?.mocked, error: generated?.error }))
check('建议指向提到的两个原子', same(results.map((r) => [r.recommendation.propositionId, r.recommendation.rel]),
  [[herdAtom.id, 'related'], [saltAtom.id, 'supports']]), JSON.stringify(results.map((r) => [r.recommendation.propositionId, r.recommendation.rel])))
check('证据节点不是候选原子', !results.some((r) => r.recommendation.propositionId === decoy.id))
check('摘录是原文逐字片段，核验闸门放行', results.length > 0 && results.every((r) => r.statement.sourceQuoteVerified === true),
  JSON.stringify(results.map((r) => r.statement.sourceQuoteVerified)))
check('每条建议的 change 只有 note', results.every((r) => {
  const keys = Object.keys(r.recommendation.change || {})
  return keys.length === 1 && keys[0] === 'note' && typeof r.recommendation.change.note === 'string'
}), JSON.stringify(results.map((r) => r.recommendation.change)))
const proposals = getEvents(theme.id).filter((event) => event.type === 'engine.recommendation.proposed')
check('建议落账带来源与入账时间', proposals.length === 2 && proposals.every((event) => event.payload.sourceLabel === '隔离合成来源'
  && event.payload.ingestedAt === '2026-07-01T08:30:00.000Z'), JSON.stringify(proposals.map((event) => event.payload.sourceLabel)))
const rerun = await invoke('engine:runPipeline', inbox.id)
check('重跑同一条目不重复落账', rerun?.ok === true
  && getEvents(theme.id).filter((event) => event.type === 'engine.recommendation.proposed').length === 2)

const evidenceResult = results.find((r) => r.recommendation.propositionId === saltAtom.id)
const accepted = await invoke('chain:reviewEngineRecommendation', theme.id, evidenceResult.proposalEventId, 'accepted',
  { change: { note: '这是用户的自由备注' } })
const events = getEvents(theme.id)
const recommendationId = events.find((event) => event.id === evidenceResult.proposalEventId)?.payload?.recommendationId
const evidenceEvent = events.find((event) => event.type === 'evidence.appended'
  && event.payload.recommendationId === recommendationId)
const decisionEvent = events.filter((event) => event.type === 'signal.reviewed').at(-1)
check('确认后账本证据事件的 change 只有 note', accepted?.ok === true
  && same(evidenceEvent?.payload.change, { note: '这是用户的自由备注' }), JSON.stringify(evidenceEvent?.payload.change))
check('判决事件同样只带 note', same(decisionEvent?.payload.change, { note: '这是用户的自由备注' }),
  JSON.stringify(decisionEvent?.payload.change))

const unrelated = store.addInboxItem({
  text: '今天下雨。明天放晴。', title: '天气', extracted: true, extractedThemeId: theme.id,
  createdAt: '2026-07-02T08:30:00.000Z', provenance: { platform: 'synthetic-test', sourceLabel: '隔离合成来源' },
})
const fresh = await invoke('engine:runPipeline', unrelated.id)
check('没提到任何原子 → 一条新建原子建议', fresh?.ok === true && fresh.pipeline.results.length === 1
  && fresh.pipeline.results[0].kind === 'new-proposition', JSON.stringify(fresh?.pipeline?.results?.map((r) => r.kind)))

console.log(`\nMock engine: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
