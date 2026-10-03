import assert from 'node:assert/strict'
import { join } from 'node:path'

const [backend, dataDir, phase] = process.argv.slice(2)
if (!['json', 'sqlite'].includes(backend) || !dataDir || !phase) throw new Error('usage: worker <json|sqlite> <dataDir> <write|read>')
process.env.MERIDIAN_USER_DATA_DIR = dataDir
const store = await import('../src/main/store.js')
const chainStore = await import('../src/main/chain-store.js')
const ledger = await import('../src/main/chain-events.js')

if (phase === 'write') {
  store.load()
  const theme = store.addTheme(`persistence-${backend}`)
  const legacyTheme = store.addTheme(`legacy-${backend}`)
  chainStore.mountToChain(legacyTheme.id, { mountId: `old-${backend}`, segmentNames: ['旧版认知段'], coreInfo: '旧版原文' })
  const batch = [
    { id: `evidence:${backend}`, type: 'evidence.appended', payload: { text: '来源材料', sourceKind: 'test', sourceRef: 'fixture:source' } },
    { id: `claim:${backend}`, type: 'claim.created', payload: { nodeKind: 'claim', title: '可持久化主张', coreInfo: '版本一', status: 'pending', sourceKind: 'test', sourceRef: 'fixture:claim' } },
    { id: `relation:${backend}`, type: 'relation.declared', payload: { rel: 'supports', from: { eventId: `evidence:${backend}` }, to: { eventId: `claim:${backend}` }, sourceRef: 'fixture:relation' } },
  ]
  ledger.appendEvents(theme.id, batch)
  assert.equal(ledger.getEvents(theme.id).length, 3)
  assert.throws(() => ledger.appendEvents(theme.id, [
    { id: `partial:${backend}`, type: 'evidence.appended', payload: { text: 'must roll back' } },
    { id: `invalid:${backend}`, type: 'correction.appended', supersedes: 'missing:version', payload: { oldValue: 'a', newValue: 'b' } },
  ]))
  assert.equal(ledger.getEvents(theme.id).length, 3, 'invalid batch must not partially append')

  // Round-trip the actual product export/import path in an isolated temporary data directory.
  const exported = store.exportAll({ withRaw: false })
  const parsed = JSON.parse(exported)
  assert.equal(parsed.themes.find((t) => t.id === theme.id).eventChain.events.length, 3)
  assert.ok(parsed.themes.find((t) => t.id === legacyTheme.id).chain.segments.length > 0)
  assert.equal(Object.hasOwn(parsed.themes.find((t) => t.id === legacyTheme.id), 'eventChain'), false)
  assert.equal(store.importAll(exported), true)
  store.persistLedgerNow()
  const restored = store.allThemes().find((t) => t.id === theme.id)
  assert.equal(restored.eventChain.events.length, 3)
  const restoredLegacy = store.allThemes().find((t) => t.id === legacyTheme.id)
  assert.equal(Object.hasOwn(restoredLegacy, 'eventChain'), false, 'legacy data stays legacy until explicit projection migration')
  console.log(JSON.stringify({ ok: true, backend, themeId: theme.id, legacyThemeId: legacyTheme.id, count: 3 }))
} else if (phase === 'read') {
  store.load()
  const theme = store.allThemes().find((t) => t.name === `persistence-${backend}`)
  const legacyTheme = store.allThemes().find((t) => t.name === `legacy-${backend}`)
  assert.ok(theme, 'theme survived a process restart')
  assert.ok(legacyTheme, 'legacy theme survived a process restart')
  const events = ledger.getEvents(theme.id)
  assert.equal(events.length, 3)
  assert.deepEqual(events.map((e) => e.id), [`evidence:${backend}`, `claim:${backend}`, `relation:${backend}`])
  assert.equal(ledger.getEvents(theme.id).length, 3)
  assert.equal(Object.hasOwn(legacyTheme, 'eventChain'), false)
  assert.equal(legacyTheme.chain.segments[0].name, '旧版认知段')
  console.log(JSON.stringify({ ok: true, backend, count: events.length, verified: true, legacyPreserved: true }))
} else {
  throw new Error(`unknown phase: ${phase}`)
}
