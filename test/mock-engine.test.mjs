/**
 * Mock 引擎测试（MERIDIAN_MOCK_ENGINE=1）。
 *
 * 运行：node test/mock-engine.test.mjs
 *
 * 守住三件事：
 *  1. mock 模式不调 LLM、不需要 API key，只产出可审核建议；
 *  2. mock 数据不预设任何领域——主体取条目标题，属性是中性词，数值只来自原文，
 *     时间窗口只在原文写了时才带；摘录必须是原文逐字片段，否则确认会被核验闸门挡住；
 *  3. 审阅 change 只有 note 字段（去领域化后的形状），且账本哈希链保持完整。
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
const { appendEvent, verifyChain, getEvents } = await import('../src/main/chain-events.js')
registerDomainCommands({ registry })
store.load()

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) pass++
  else fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// 故意用一个与任何领域无关的主题/条目：历史向，且原文里没有时间窗口。
const theme = store.addTheme('去领域化 mock 主题')
const targetSeed = appendEvent(theme.id, {
  actor: 'user', type: 'claim.created',
  payload: { title: '合成目标原子', confidence: 60, status: 'pending', sourceRef: 'synthetic:mock-target' },
})
/* 第二个原子：mock 的反驳案例只在存在第二个候选原子时才生成。 */
appendEvent(theme.id, {
  actor: 'user', type: 'claim.created',
  payload: { title: '合成第二原子', confidence: 60, status: 'pending', sourceRef: 'synthetic:mock-target-2' },
})
const sourceText = '商队在大雪封路前把盐运到了北岸；那年冬天冻死了三分之一的牲口。'
const inbox = store.addInboxItem({
  text: sourceText, title: '北岸盐运记录', extracted: true, extractedThemeId: theme.id,
  createdAt: '2026-07-01T08:30:00.000Z',
  provenance: { platform: 'synthetic-test', sourceLabel: '隔离合成来源' },
})

// 注意：这里刻意不配置 API key / baseUrl——mock 模式不该依赖它们。
const generated = await invoke('engine:runPipeline', inbox.id)
const pipeline = generated?.pipeline
const statements = pipeline?.statements || []
const results = pipeline?.results || []

check('mock 模式无 key 也能跑通并标记 mocked', generated?.ok === true && pipeline?.status === 'done'
  && pipeline?.mocked === true, JSON.stringify({ ok: generated?.ok, status: pipeline?.status, mocked: pipeline?.mocked }))
check('产出三条建议（支持/反驳/新建）', results.length === 3
  && results.some((r) => r.recommendation.rel === 'supports')
  && results.some((r) => r.recommendation.rel === 'contradicts')
  && results.some((r) => r.kind === 'new-proposition'), JSON.stringify(results.map((r) => [r.kind, r.recommendation.rel])))

check('主体取条目标题，不再写死领域公司名', statements.length === 3
  && statements.every((s) => s.subject === inbox.title), JSON.stringify(statements.map((s) => s.subject)))
check('属性是中性词，不预设领域类型', JSON.stringify(statements.map((s) => s.attribute)) === JSON.stringify(['规模', '趋势', '约束']),
  JSON.stringify(statements.map((s) => s.attribute)))
check('数值来自原文数字，抓不到就说未量化', statements.every((s) => /^\d|未量化/.test(s.value)),
  JSON.stringify(statements.map((s) => s.value)))
check('原文没写时间窗口就留空，不编造', statements.every((s) => s.timeWindow === ''),
  JSON.stringify(statements.map((s) => s.timeWindow)))
check('摘录是原文逐字片段，核验闸门放行',
  results.length > 0 && results.every((r) => r.statement.sourceQuoteVerified === true),
  JSON.stringify(results.map((r) => r.statement.sourceQuoteVerified)))
check('每条建议的 change 只有 note', results.every((r) => {
  const keys = Object.keys(r.recommendation.change || {})
  return keys.length === 1 && keys[0] === 'note' && typeof r.recommendation.change.note === 'string'
}), JSON.stringify(results.map((r) => r.recommendation.change)))

const evidenceResult = results.find((r) => r.kind === 'evidence' && r.recommendation.propositionId === targetSeed.id)
const accepted = await invoke('chain:reviewEngineRecommendation', theme.id, evidenceResult.proposalEventId, 'accepted',
  { change: { note: '这是用户的自由备注' } })
const events = getEvents(theme.id)
const recommendationId = events.find((event) => event.id === evidenceResult.proposalEventId)?.payload?.recommendationId
const evidenceEvent = events.find((event) => event.type === 'evidence.appended'
  && event.payload.recommendationId === recommendationId)
const decisionEvent = events.filter((event) => event.type === 'signal.reviewed').at(-1)
check('确认后账本证据事件的 change 只有 note', accepted?.ok === true
  && JSON.stringify(evidenceEvent?.payload.change) === JSON.stringify({ note: '这是用户的自由备注' }), JSON.stringify(evidenceEvent?.payload.change))
check('判决事件同样只带 note', JSON.stringify(decisionEvent?.payload.change) === JSON.stringify({ note: '这是用户的自由备注' }),
  JSON.stringify(decisionEvent?.payload.change))
check('mock 全流程后哈希链完整', verifyChain(theme.id).ok)

console.log(`\nMock engine: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
