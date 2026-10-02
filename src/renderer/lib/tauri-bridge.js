import { invoke } from '@tauri-apps/api/core'
import { readText } from '@tauri-apps/plugin-clipboard-manager'
import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut'
import { openPath, openUrl } from '@tauri-apps/plugin-opener'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { normalizeExternalUrl } from '../../shared/external-url.js'

const listeners = new Map()
const call = (command, ...args) => {
  while (args.length && args.at(-1) === undefined) args.pop()
  return invoke('backend_invoke', { command, args })
}
const subscribe = (event, callback) => {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(callback)
  return () => listeners.get(event)?.delete(callback)
}
export function dispatchDesktopEvent(event, payload) {
  for (const callback of listeners.get(event) || []) {
    try { callback(payload) } catch (error) { console.error(`[event:${event}]`, error) }
  }
}

export function createMeridianBridge() {
  const api = {
    stats: () => call('db:stats'), nodes: (themeId) => call('db:nodes', themeId),
    allNodes: () => call('db:allNodes'), getNode: (id) => call('db:getNode', id),
    themes: () => call('theme:all'), settings: () => call('settings:get'),
    labelTest: (text) => call('label:test', text), llmTest: () => call('llm:test'), jevTest: () => call('jev:test'),
    jevLabelTest: (text) => call('jev:labelTest', text), due: () => call('db:due'), calibration: () => call('db:calibration'),
    filterCalibration: () => call('db:filterCalibration'), falseKill: (days) => call('db:falseKill', days),
    falseKillByChannel: (days) => call('db:falseKillByChannel', days), events: () => call('db:events'),
    conflicts: () => call('db:conflicts'), verdicts: () => call('db:verdicts'), premises: () => call('db:premises'),
    suggestParent: (text, themeId) => call('db:suggestParent', text, themeId),
    addTicker: (id, ticker) => call('db:addTicker', id, ticker), removeTicker: (id, code) => call('db:removeTicker', id, code),
    tickerLookup: (code, themeId) => call('db:tickerLookup', code, themeId), tickers: (themeId) => call('db:tickers', themeId),
    addNode: (input) => call('db:addNode', input), updateNode: (id, patch) => call('db:updateNode', id, patch),
    removeNode: (id) => call('db:removeNode', id), restoreNode: (id) => call('db:restoreNode', id),
    purgeDead: (scope, opts) => call('db:purgeDead', scope, opts), repropagate: (id) => call('db:repropagate', id),
    settle: (id, correct) => call('db:settle', id, correct), addSource: (id, source) => call('db:addSource', id, source),
    resolveConflict: (id, verdict) => call('db:resolveConflict', id, verdict), spawn: (branchId) => call('db:spawn', branchId),
    addTheme: (name) => call('theme:add', name), setupNewTheme: (description) => call('theme:setupNew', description),
    regenerateTheme: (themeId) => call('theme:regenerate', themeId),
    themeScaffoldStatus: () => call('theme:scaffoldStatus'), themeScaffoldResult: (themeId) => call('theme:scaffoldResult', themeId),
    onThemeScaffolded: (cb) => subscribe('theme:scaffolded', cb), onThemeScaffoldProgress: (cb) => subscribe('theme:scaffoldProgress', cb),
    scaffoldExisting: (themeId, description) => call('theme:scaffoldExisting', themeId, description),
    removeTheme: (id) => call('theme:remove', id), restoreTheme: (id) => call('theme:restore', id),
    deletedThemes: () => call('theme:deleted'), renameTheme: (id, name) => call('theme:rename', id, name),
    themeUpdate: (id, patch) => call('theme:update', id, patch),
    chainGet: (themeId) => call('chain:get', themeId),
    chainProjection: (themeId, options) => call('chain:getProjection', themeId, options),
    chainProjectionAt: (themeId, sequence) => call('chain:getProjectionAt', themeId, sequence),
    chainArchives: (themeId) => call('chain:getArchive', themeId),
    chainEvents: (themeId) => call('chain:getEvents', themeId),
    chainVerify: (themeId) => call('chain:verify', themeId),
    chainCreateNode: (themeId, input) => call('chain:createNode', themeId, input),
    chainRenameNode: (themeId, nodeId, title, reason) => call('chain:renameNode', themeId, nodeId, title, reason),
    chainCorrectNode: (themeId, nodeId, input) => call('chain:correctNode', themeId, nodeId, input),
    chainInvalidateNode: (themeId, nodeId, reason) => call('chain:invalidateNode', themeId, nodeId, reason),
    chainArchiveNode: (themeId, sourceRef, reason) => call('chain:archiveNode', themeId, sourceRef, reason),
    chainRestoreNode: (themeId, sourceRef, reason) => call('chain:restoreNode', themeId, sourceRef, reason),
    chainAddEvidence: (themeId, nodeId, input) => call('chain:addEvidence', themeId, nodeId, input),
    chainDeclareRelation: (themeId, fromNodeId, toNodeId, rel) => call('chain:declareRelation', themeId, fromNodeId, toNodeId, rel),
    chainReviewRelation: (themeId, eventId, decision, reason) => call('chain:reviewRelation', themeId, eventId, decision, reason),
    chainConfirmSignal: (themeId, signalEventId, decision, change, reason) => call('chain:confirmSignal', themeId, signalEventId, decision, change, reason),
    chainReviewEngineRecommendation: (themeId, eventId, decision, input) => call('chain:reviewEngineRecommendation', themeId, eventId, decision, input),
    engineRunPipeline: (inboxId) => call('engine:runPipeline', inboxId),
    chainMountEvent: (themeId, payload) => call('chain:mountEvent', themeId, payload),
    chainMount: (themeId, payload) => call('chain:mount', themeId, payload),
    chainUpdateSegment: (themeId, segmentId, patch, changeNote) => call('chain:updateSegment', themeId, segmentId, patch, changeNote),
    chainMergeSegments: (themeId, fromIds, intoId, reason) => call('chain:mergeSegments', themeId, fromIds, intoId, reason),
    chainCloseBranch: (themeId, segmentId, subId, reason) => call('chain:closeBranch', themeId, segmentId, subId, reason),
    chainReviveSegment: (themeId, segmentId, reason) => call('chain:reviveSegment', themeId, segmentId, reason),
    chainSetLayers: (themeId, names) => call('chain:setLayers', themeId, names),
    chainAddSubsegment: (themeId, segmentId, sub) => call('chain:addSubsegment', themeId, segmentId, sub),
    chainSetDraft: (inboxId, draft) => call('chain:setDraft', inboxId, draft),
    chainGenerateDraft: (inboxId) => call('chain:generateDraft', inboxId),
    chainReadingMap: (themeId) => call('chain:readingMap', themeId),
    chainSetReadingMap: (themeId, map) => call('chain:setReadingMap', themeId, map),
    saveSettings: (patch) => call('settings:set', patch),
    readClipboard: () => readText().catch(() => ''), commonUsGaap: () => call('db:commonUsGaap'),
    exportAll: () => call('io:export'), importAll: (json) => call('io:import', json),
    openDataDir: async () => {
      try { const path = await invoke('application_data_dir'); await openPath(path); return { ok: true, path } }
      catch (error) { return { ok: false, error: error?.message || String(error) } }
    },
    openExternal: async (url) => {
      try {
        const safeUrl = normalizeExternalUrl(url)
        if (!safeUrl) return false
        await openUrl(safeUrl)
        return true
      } catch { return false }
    },
    rawStats: () => call('raw:stats'), rawGet: (id) => call('raw:get', id), rawPrune: () => call('raw:prune'), rawClear: () => call('raw:clear'),
    process: (text, themeId) => call('agent:process', text, themeId), socratic: (nodeId) => call('agent:socratic', nodeId),
    onChanged: (cb) => subscribe('db:changed', cb),
    inboxCapture: (text, channelMeta, themeId) => call('inbox:capture', text, channelMeta, themeId),
    inboxList: (opts) => call('inbox:list', opts), inboxIgnored: () => call('inbox:ignored'),
    inboxResolve: (id, action) => call('inbox:resolve', id, action), inboxResolveMany: (ids, action) => call('inbox:resolveMany', ids, action),
    inboxImport: (themeId, items, overrides) => call('inbox:import', themeId, items, overrides), inboxClear: () => call('inbox:clear'),
    inboxUndoAutoImport: (id) => call('inbox:undoAutoImport', id), inboxLastAutoImport: () => call('inbox:lastAutoImport'),
    inboxExtract: (ids, themeId) => call('inbox:extract', ids, themeId), inboxExtractCancel: () => call('inbox:extract:cancel'), inboxSetTheme: (id, themeId) => call('inbox:setTheme', id, themeId),
    inboxClearUnextracted: (exceptIds) => call('inbox:clearUnextracted', exceptIds), inboxPrune: (days, opts) => call('inbox:prune', days, opts),
    intakeSeries: (days) => call('intake:series', days), llmUsage: () => call('llm:usage'),
    traceAll: () => call('trace:all'), traceByTarget: (id) => call('trace:byTarget', id),
    traceModelCalibration: () => call('trace:modelCalibration'), traceLabelerDivergence: () => call('trace:labelerDivergence'),
    discoverTags: (ticker) => call('edgar:discoverTags', ticker), addReading: (input) => call('reading:add', input),
    indicatorsForReading: (reading) => call('reading:indicatorsFor', reading), getReading: (id) => call('reading:get', id),
    readingsPage: (opts) => call('reading:page', opts), readingEvidence: (opts) => call('reading:evidence', opts),
    latestReadings: () => call('reading:latest'), sourcesPage: (opts) => call('source:page', opts),
    assignReading: (id, nodeId) => call('reading:assign', id, nodeId), verifyReadingChain: (key) => call('reading:verify', key),
    pushReadings: (envelope) => call('reading:push', envelope), exportIntent: () => call('agent:intent'),
    agentConnection: () => call('agent:connection'), onReadingProgress: (cb) => subscribe('reading:progress', cb),
    addResearch: (input) => call('research:add', input), allResearch: () => call('research:all'),
    researchByNode: (id) => call('research:byNode', id), researchHitRate: (notes, correct) => call('research:hitRate', notes, correct),
    vsInstitution: (days) => call('research:vsInstitution', days),
    onInboxPaste: (cb) => subscribe('inbox:paste', cb), onDueNotify: (cb) => subscribe('due:notify', cb),
    onInboxPruned: (cb) => subscribe('inbox:pruned', cb), onInboxExtractProgress: (cb) => subscribe('inbox:extract:progress', cb),
  }

  api.configureHotkey = async (shortcut) => {
    try { await unregisterAll() } catch {}
    try {
      const hotkey = shortcut || 'CommandOrControl+Shift+V'
      await register(hotkey, async (event) => {
        if (String(event?.state || '').toLowerCase().includes('release')) return
        try {
          const window = getCurrentWindow()
          await window.unminimize()
          await window.show()
          await window.setFocus()
        } catch {}
        const text = await readText().catch(() => '')
        dispatchDesktopEvent('inbox:paste', String(text || '').trim())
      })
      return { ok: true, shortcut: hotkey }
    } catch (error) {
      console.warn('[meridian] global shortcut unavailable:', error)
      return { ok: false, error: error?.message || String(error) }
    }
  }
  return api
}
