import assert from 'node:assert/strict'
import { resolveEventReference } from '../src/renderer/lib/chain-reference.js'

const lemmaId = '4sgmaqza1r0y'
const nodeId = `evt:node:${lemmaId}`
const archiveId = `evt:arch:${lemmaId}`
const relationId = `evt:rel:aff:${lemmaId}:0`
const sourceId = `evt:legacy-source:${'a'.repeat(64)}`
const rows = [
  { id: nodeId, type: 'claim.created', payload: { title: '需求会继续增长', sourceRef: `lemma:${lemmaId}`, sourceKind: 'lemma' } },
  { id: archiveId, type: 'node.archived', payload: { sourceRef: `lemma:${lemmaId}`, reason: '被新证据推翻' } },
  { id: 'evt:node:segment-1', type: 'claim.created', payload: { title: '供给变化', sourceRef: 'segment:segment-1', sourceKind: 'segment' } },
  { id: relationId, type: 'relation.declared', payload: { rel: 'derives', from: { eventId: nodeId }, to: { eventId: 'evt:node:segment-1' }, sourceRef: `lemma:${lemmaId}` } },
  { id: sourceId, type: 'evidence.appended', payload: { text: '旧来源标签', legacySource: { label: '公司年报', url: 'https://example.com/report' }, sourceRef: `legacy-source:lemma:${lemmaId}:${'b'.repeat(24)}` } },
]

const byLegacySourceRef = resolveEventReference(rows, `lemma:${lemmaId}`)
assert.equal(byLegacySourceRef.status, 'resolved')
assert.equal(byLegacySourceRef.eventId, nodeId)
assert.equal(byLegacySourceRef.subjectTitle, '需求会继续增长')

const byStableNodeEvent = resolveEventReference(rows, nodeId)
assert.equal(byStableNodeEvent.status, 'resolved')
assert.equal(byStableNodeEvent.subjectTitle, '需求会继续增长')

const byArchiveEvent = resolveEventReference(rows, archiveId)
assert.equal(byArchiveEvent.status, 'resolved')
assert.equal(byArchiveEvent.event.type, 'node.archived')
assert.equal(byArchiveEvent.subjectTitle, '需求会继续增长')

const byRelationEvent = resolveEventReference(rows, relationId)
assert.equal(byRelationEvent.status, 'resolved')
assert.equal(byRelationEvent.event.type, 'relation.declared')

const legacyEvidence = resolveEventReference(rows, sourceId)
assert.equal(legacyEvidence.status, 'resolved')
assert.equal(legacyEvidence.subjectTitle, '公司年报')
assert.equal(resolveEventReference(rows, `legacy-source:lemma:${lemmaId}:${'b'.repeat(24)}`).eventId, sourceId)

const unresolved = resolveEventReference(rows, 'lemma:not-in-fixture')
assert.equal(unresolved.status, 'unresolved')
assert.equal(unresolved.label, '来源未解析')
assert.equal(unresolved.reference, 'lemma:not-in-fixture')
assert.equal(resolveEventReference(rows, '').status, 'missing')

console.log('链事件引用解析：稳定 ID、历史来源引用和未解析引用均按实际账本记录处理')
