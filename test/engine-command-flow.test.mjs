import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCommandTestHarness } from './runtime-harness.mjs'

const DATA = join(tmpdir(), `meridian-engine-flow-${process.pid}`)
process.env.MERIDIAN_USER_DATA_DIR = DATA
rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const { registry, invoke } = createCommandTestHarness(DATA)
const store = await import('../src/main/store.js')
const { registerDomainCommands } = await import('../src/main/domain-commands.js')
const { deriveReaderModel } = await import('../src/renderer/lib/reader-model.js')
const { estimateStrength, updateConfidence } = await import('../src/main/engine-confidence.js')
const { appendEvent } = await import('../src/main/chain-events.js')
registerDomainCommands({ registry })
store.load()

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) pass++
  else fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const theme = store.addTheme('合成引擎闭环主题')
const targetSeed = appendEvent(theme.id, {
  actor: 'user', type: 'claim.created', payload: { title: '营收判断', confidence: 60, status: 'pending', sourceRef: 'synthetic:engine-flow-target' },
})
const targetId = targetSeed?.id
const sourceText = '营收同比增长 28%；生产成本下降 8%；供应链影响交付周期；该数据来自公司公告。'
const inbox = store.addInboxItem({
  text: sourceText,
  title: '合成来源条目',
  extracted: true,
  extractedThemeId: theme.id,
  provenance: { platform: 'synthetic-test', sourceLabel: '隔离合成来源', url: 'https://example.test/synthetic-report' },
})
await invoke('settings:set', { apiKey: 'synthetic-test-key', baseUrl: 'https://llm.example.test/v1', model: 'synthetic-fixture' })

const llmSystems = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, options = {}) => {
  const request = JSON.parse(options.body || '{}')
  const system = String(request.messages?.[0]?.content || '')
  llmSystems.push(system)
  let answer
  if (system.includes('抽取新闻中可核验的原子陈述')) {
    answer = { statements: [
      { subject: '合成公司', attribute: '营收', value: '同比增长 28%', time_window: '', quote: '营收同比增长 28%' },
      { subject: '合成公司', attribute: '生产成本', value: '下降 8%', time_window: '2026Q2', quote: '生产成本下降 8%' },
      { subject: '供应链', attribute: '影响', value: '交付周期变化', time_window: '', quote: '供应链影响交付周期' },
      { subject: '来源', attribute: '类型', value: '公司公告', time_window: '', quote: '该数据来自公司公告' },
    ] }
  } else if (system.includes('将每条陈述分类为 hard、soft、relational 或 meta')) {
    answer = { types: [
      { index: 0, type: 'hard' }, { index: 1, type: 'soft' },
      { index: 2, type: 'relational' }, { index: 3, type: 'meta' },
    ] }
  } else if (system.includes('判断陈述与命题的语义、主体、时间是否匹配')) {
    const user = String(request.messages?.[1]?.content || '')
    const knownWindow = user.includes('生产成本=下降 8%')
    answer = { matches: [{ proposition_index: 0, semantic: true, subject: true, temporal: knownWindow, score: 0.91, reason: '隔离匹配' }] }
  } else if (system.includes('判断陈述与命题的关系')) {
    answer = { rel: 'supports', strength: 0.62, reason: '合成归因建议', change: { direction: 'improving', nature: 'quantitative', themeTag: '成本' } }
  } else {
    throw new Error(`未预期的合成模型阶段：${system.slice(0, 80)}`)
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

try {
  check('合成主题与目标观点通过真实 domain command 创建', Boolean(targetId)
    && (await invoke('chain:getProjection', theme.id)).nodes.some((node) => node.id === targetId))

  const generated = await invoke('engine:runPipeline', inbox.id)
  const pipeline = generated?.pipeline
  const proposalsBefore = (await invoke('chain:getEvents', theme.id)).events
  const proposalEvents = proposalsBefore.filter((event) => event.type === 'engine.recommendation.proposed')
  check('engine:runPipeline 经真实 registry 调用四阶段流水线并持久化三类建议', generated?.ok === true
    && pipeline?.status === 'done' && pipeline.results?.length === 3 && proposalEvents.length === 3
    && llmSystems.length === 6, `模型调用 ${llmSystems.length} 次，建议 ${proposalEvents.length} 条`)
  check('生成建议阶段没有提前追加事实、关系或置信度更新', !proposalsBefore.some((event) => ['evidence.appended', 'relation.declared', 'confidence.updated'].includes(event.type)))
  const byStatement = new Map(pipeline.results.map((result) => [result.statement.attribute, result]))
  const unknownTime = byStatement.get('营收')
  const knownTime = byStatement.get('生产成本')
  const relational = pipeline.results.find((result) => result.kind === 'new-proposition')
  check('未知时间候选保留为需人工复核建议', unknownTime?.requiresTemporalReview === true
    && unknownTime.statement.sourceQuoteVerified === true)
  check('meta 提示不建事实，且降低 UI/后端共用的有效强度', pipeline.metaCount === 1
    && Math.abs(knownTime?.recommendation?.effectiveStrength - estimateStrength({
      isHardFact: false, hasUrl: true, attributionStrength: 0.62, metaMultiplier: 0.85,
    })) < 1e-12)
  check('relational 陈述只生成新观点建议，不伪造现存目标观点', relational?.kind === 'new-proposition'
    && !relational.proposition && relational.recommendation.rel === 'related')

  const rejected = await invoke('chain:reviewEngineRecommendation', theme.id, unknownTime.proposalEventId, 'rejected', {})
  const evidenceChange = { direction: 'improving', nature: 'quantitative', themeTag: '成本' }
  const acceptedEvidence = await invoke('chain:reviewEngineRecommendation', theme.id, knownTime.proposalEventId, 'accepted', {
    rel: 'supports', targetNodeId: targetId, change: evidenceChange,
  })
  const acceptedRelation = await invoke('chain:reviewEngineRecommendation', theme.id, relational.proposalEventId, 'accepted', {
    title: '用户确认的供应链交付观点', change: { direction: 'stable', nature: 'structural', themeTag: '供应链' },
  })
  check('驳回只追加审核决定，未写入该建议的证据', rejected?.ok === true
    && !rejected.events.some((event) => event.type === 'evidence.appended'))
  check('确认证据在一个真实追加批次中写入 evidence/relation/confidence/review', acceptedEvidence?.ok === true
    && ['evidence.appended', 'relation.declared', 'confidence.updated', 'signal.reviewed']
      .every((type) => acceptedEvidence.events.some((event) => event.type === type)), JSON.stringify(acceptedEvidence?.events?.map((event) => event.type)))
  check('关系陈述必须经用户命名，并由真实事务创建新节点/证据/关系', acceptedRelation?.ok === true
    && acceptedRelation.events.some((event) => event.type === 'node.created' && event.payload.title === '用户确认的供应链交付观点')
    && acceptedRelation.events.some((event) => event.type === 'evidence.appended'))

  const afterReview = (await invoke('chain:getEvents', theme.id)).events
  const beforeSeq = proposalsBefore.at(-1)?.seq || 0
  const historyProjection = await invoke('chain:getProjectionAt', theme.id, beforeSeq)
  const currentProjection = await invoke('chain:getProjection', theme.id)
  const confidenceEvent = afterReview.find((event) => event.type === 'confidence.updated')
  const effectiveStrength = estimateStrength({ isHardFact: false, hasUrl: true, attributionStrength: 0.62, metaMultiplier: 0.85 })
  const expectedConfidence = Math.round(updateConfidence(0.6, effectiveStrength, 'supports') * 100)
  const currentTarget = currentProjection.nodes.find((node) => node.id === targetId)
  const historicTarget = historyProjection.nodes.find((node) => node.id === targetId)
  check('confidence.updated 的旧/新值按 0–100 百分比并与实际 strength 公式一致', confidenceEvent?.payload.oldConfidence === 60
    && confidenceEvent?.payload.newConfidence === expectedConfidence
    && Math.abs(confidenceEvent?.payload.strength - effectiveStrength) < 1e-12
    && currentTarget?.confidence === expectedConfidence, JSON.stringify({ expectedConfidence, event: confidenceEvent?.payload, projected: currentTarget?.confidence }))
  check('按序号历史回放保留旧观点与旧置信度；当前 projection 显示用户确认的新观点', historicTarget?.confidence === 60
    && !historyProjection.nodes.some((node) => node.title === '用户确认的供应链交付观点')
    && currentProjection.nodes.some((node) => node.title === '用户确认的供应链交付观点'), JSON.stringify({ beforeSeq, historyNodes: historyProjection.nodes.map((node) => [node.title, node.confidence]), currentNames: currentProjection.nodes.map((node) => node.title) }))
  const historicalModel = deriveReaderModel(historyProjection, proposalsBefore)
  const currentModel = deriveReaderModel(currentProjection, afterReview)
  const historicalReaderNode = Object.values(historicalModel.nodesByDirection).flat().find((node) => node.id === targetId)
  const currentReaderNode = Object.values(currentModel.nodesByDirection).flat().find((node) => node.id === targetId)
  check('Node 可安全导入的 reader model 显示历史/当前百分比差异', historicalReaderNode?.confidence === 60
    && currentReaderNode?.confidence === expectedConfidence)

  const duplicateCount = afterReview.length
  const replayed = await invoke('chain:reviewEngineRecommendation', theme.id, knownTime.proposalEventId, 'accepted', {
    rel: 'supports', targetNodeId: targetId, change: evidenceChange,
  })
  const cachedRun = await invoke('engine:runPipeline', inbox.id)
  const afterReplay = (await invoke('chain:getEvents', theme.id)).events
  check('重复确认与再次运行 pipeline 均幂等，不重复追加事件或重新调模型', replayed?.ok === true
    && replayed.replayed === true && afterReplay.length === duplicateCount
    && llmSystems.length === 6 && cachedRun?.ok === true, JSON.stringify({ replayed, before: duplicateCount, after: afterReplay.length, llmCalls: llmSystems.length, cachedOk: cachedRun?.ok }))
  check('重进后由追加 signal.reviewed 还原三条建议的真实接受/驳回状态', cachedRun.pipeline.results.length === 3
    && cachedRun.pipeline.results.every((result) => ['accepted', 'rejected'].includes(result.reviewDecision)))
  check('最终哈希账本完整可验证', (await invoke('chain:verify', theme.id)).integrity?.ok === true)
} finally {
  globalThis.fetch = originalFetch
}

console.log(`Engine command flow: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
