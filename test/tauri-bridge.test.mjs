import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeExternalUrl } from '../src/shared/external-url.js'

const bridge = readFileSync(new URL('../src/renderer/lib/tauri-bridge.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const methodNames = (source) => [...source.matchAll(/\b(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g)].map((match) => match[1])
const exposed = new Set(methodNames(bridge))
const expected = `stats nodes allNodes getNode themes settings labelTest llmTest jevTest jevLabelTest due calibration filterCalibration falseKill falseKillByChannel events conflicts verdicts premises suggestParent addTicker removeTicker tickerLookup tickers addNode updateNode removeNode restoreNode purgeDead repropagate settle addSource resolveConflict spawn addTheme setupNewTheme regenerateTheme themeScaffoldStatus themeScaffoldResult onThemeScaffolded onThemeScaffoldProgress scaffoldExisting removeTheme restoreTheme deletedThemes renameTheme themeUpdate chainGet chainProjection chainProjectionAt chainArchives chainEvents chainVerify chainArchiveNode chainRestoreNode chainAddEvidence chainDeclareRelation chainReviewRelation chainConfirmSignal chainReviewEngineRecommendation engineRunPipeline chainMountEvent chainMount chainUpdateSegment chainMergeSegments chainCloseBranch chainReviveSegment chainSetLayers chainAddSubsegment chainSetDraft chainGenerateDraft chainReadingMap chainSetReadingMap saveSettings readClipboard commonUsGaap exportAll importAll openDataDir openExternal rawStats rawGet rawPrune rawClear process socratic onChanged inboxCapture inboxList inboxIgnored inboxResolve inboxResolveMany inboxImport inboxClear inboxUndoAutoImport inboxLastAutoImport inboxExtract inboxSetTheme inboxClearUnextracted inboxPrune intakeSeries llmUsage traceAll traceByTarget traceModelCalibration traceLabelerDivergence discoverTags addReading indicatorsForReading getReading readingsPage readingEvidence latestReadings sourcesPage assignReading verifyReadingChain pushReadings exportIntent agentConnection onReadingProgress addResearch allResearch researchByNode researchHitRate vsInstitution onInboxPaste onDueNotify onInboxPruned`.split(/\s+/)
for (const name of expected) assert.ok(exposed.has(name), `Tauri bridge is missing app API method ${name}`)

const native = new Set(['readClipboard', 'openDataDir', 'openExternal'])
const subscriptions = new Set(['onThemeScaffolded', 'onThemeScaffoldProgress', 'onChanged', 'onReadingProgress', 'onInboxPaste', 'onDueNotify', 'onInboxPruned'])
const callPattern = (name) => new RegExp(`${name}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*call\\('([^']+)'`)
let commandMappings = 0
for (const name of expected) {
  if (native.has(name) || subscriptions.has(name)) continue
  const match = bridge.match(callPattern(name))
  assert.ok(match, `${name} must map to a domain command`)
  commandMappings++
}
assert.match(bridge, /readClipboard:\s*\(\)\s*=>\s*readText\(/, 'clipboard reads use the native Tauri plugin')
assert.match(bridge, /openDataDir:[\s\S]*?invoke\('application_data_dir'\)[\s\S]*?openPath\(path\)/, 'data directory opens through the native Tauri adapter')
assert.match(bridge, /openExternal:[\s\S]*?normalizeExternalUrl\(url\)[\s\S]*?openUrl\(safeUrl\)/, 'external URLs use the shared allowlist before native open')
assert.equal(normalizeExternalUrl('javascript:alert(1)'), null)
assert.equal(normalizeExternalUrl('file:///etc/passwd'), null)
assert.equal(normalizeExternalUrl('not-a-url'), null)
assert.equal(normalizeExternalUrl('https://example.com/path'), 'https://example.com/path')
assert.match(bridge, /invoke\('backend_invoke',\s*\{\s*command,\s*args\s*\}\)/, 'domain calls use named commands, not IPC events')
assert.match(html, /tauri-bootstrap\.js/)
assert.doesNotMatch(html, /src="\.\/app\.js"/)
assert.doesNotMatch(bridge, /ipcRenderer|electron|__electron/)
console.log(`Tauri bridge: ${expected.length} app methods preserved, ${commandMappings} domain commands mapped, and native desktop operations covered`)
