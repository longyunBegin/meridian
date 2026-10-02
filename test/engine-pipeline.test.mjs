import assert from 'node:assert/strict'
import {
  extractStatements, classifyStatements, matchPropositions, runEnginePipeline,
} from '../src/main/engine-pipeline.js'
import { estimateStrength } from '../src/main/engine-confidence.js'

const source = 'Q2营收 28%。库存有增长。A影响B。数据未独立核实。'
const responses = async (system, user) => {
  if (system.includes('抽取新闻')) return JSON.stringify({ statements: [
    { subject: '公司', attribute: 'Q2营收', value: '28%', time_window: '2026Q2', quote: 'Q2营收 28%' },
    { subject: '公司', attribute: '库存', value: '有增长', time_window: '', quote: '库存有增长' },
    { subject: 'A', attribute: '影响B', value: '关系待验证', time_window: '', quote: 'A影响B' },
    { subject: '数据', attribute: '来源', value: '未独立核实', time_window: '', quote: '数据未独立核实' },
  ] })
  if (system.includes('将每条陈述分类')) return JSON.stringify({ types: [
    { index: 0, type: 'hard' }, { index: 1, type: 'soft' },
    { index: 2, type: 'relational' }, { index: 3, type: 'meta' },
  ] })
  if (system.includes('判断陈述与命题的语义')) {
    const unknownWindow = user.includes('库存=有增长')
    return JSON.stringify({ matches: [
      { proposition_index: 0, semantic: true, subject: true, temporal: !unknownWindow, score: 0.9, reason: 'synthetic' },
      { proposition_index: 0, semantic: 'false', subject: true, temporal: true, score: 1, reason: 'must reject string booleans' },
      { proposition_index: 999, semantic: true, subject: true, temporal: true, score: 1, reason: 'invalid index' },
    ] })
  }
  if (system.includes('判断陈述与命题的关系')) return JSON.stringify({
    rel: 'supports', strength: 0.62, reason: '合成复核理由',
    change: { direction: 'improving', nature: 'quantitative', themeTag: '营收' },
  })
  throw new Error(`unexpected prompt: ${system}`)
}

const standalone = await extractStatements(responses, {
  themeName: '隔离主题', title: 'synthetic', text: source, source: 'fixture', inboxId: 'synthetic-inbox',
})
assert.equal(standalone.length, 4, 'unknown time window remains a valid atomic statement')
assert.equal(standalone[1].timeWindow, '')
assert.equal(standalone[0].sourceQuoteVerified, true)
assert.equal(standalone[0].inboxId, 'synthetic-inbox')
const missingClass = await classifyStatements(async (system) => system.includes('将每条陈述分类')
  ? JSON.stringify({ types: [{ index: '0', type: 'hard' }, { index: 99, type: 'hard' }] }) : '{}', [standalone[0]])
assert.equal(missingClass[0].classificationMissing, true, 'malformed/missing classifications fail closed to review-only soft')
assert.equal(missingClass[0].type, 'soft')

const propositions = [{ id: 'viewpoint-1', title: '公司营收持续增长', status: 'pending' }]
const unknownMatch = await matchPropositions(responses, standalone[1], propositions)
assert.equal(unknownMatch.length, 1, 'unknown temporal dimension is a review warning, not a silent filter')
assert.equal(unknownMatch[0].requiresTemporalReview, true)
assert.equal(unknownMatch[0].timeWindowKnown, false)
const knownTimeFalse = await matchPropositions(async (system) => system.includes('语义')
  ? JSON.stringify({ matches: [{ proposition_index: 0, semantic: true, subject: true, temporal: false, score: 0.8 }] }) : '{}', standalone[0], propositions)
assert.equal(knownTimeFalse.length, 0, 'explicit temporal mismatch remains ineligible')
const stringBoolean = await matchPropositions(async (system) => system.includes('语义')
  ? JSON.stringify({ matches: [{ proposition_index: 0, semantic: 'false', subject: true, temporal: true, score: 1 }] }) : '{}', standalone[0], propositions)
assert.equal(stringBoolean.length, 0, 'truthy "false" must never pass strict match validation')

const pipeline = await runEnginePipeline(responses, {
  themeName: '隔离主题', title: 'synthetic', text: source, source: 'fixture', inboxId: 'synthetic-inbox', propositions,
})
assert.equal(pipeline.statements.length, 4)
assert.equal(pipeline.metaCount, 1)
assert.equal(pipeline.metaMultiplier, 0.85)
assert.equal(pipeline.results.length, 3, 'two matched evidence suggestions plus one relational new-proposition suggestion')
assert.equal(pipeline.results.filter((item) => item.kind === 'evidence').length, 2)
assert.equal(pipeline.results.filter((item) => item.kind === 'new-proposition').length, 1)
assert.equal(pipeline.results.find((item) => item.statement.subject === '公司' && !item.statement.timeWindow).requiresTemporalReview, true)
assert.equal(pipeline.diagnostics.length, 0)
assert.equal(pipeline.results[0].attribution.strength, 0.62)
assert.equal(estimateStrength({ isHardFact: true, hasUrl: true, attributionStrength: 0.62, metaMultiplier: 0.85 }), 0.62 * 0.85)
assert.equal(estimateStrength({ isHardFact: false, hasUrl: false, attributionStrength: 0.5 }), 0.35)
console.log('Engine pipeline: unknown-time review, strict booleans, conservative classification, relational/meta routing, quote verification and effective strength passed')
