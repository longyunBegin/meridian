import { invoke } from '@tauri-apps/api/core'
import { readText } from '@tauri-apps/plugin-clipboard-manager'
import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut'
import { openPath, openUrl } from '@tauri-apps/plugin-opener'
import { getCurrentWindow } from '@tauri-apps/api/window'

const listeners = new Map()
const call = (channel, ...args) => {
  while (args.length && args.at(-1) === undefined) args.pop()
  return invoke('backend_invoke', { channel, args })
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
    updateTagLibraryTag: (themeId, tagId, patch) => call('theme:tagLibrary:updateTag', themeId, tagId, patch),
    deleteTagLibraryTags: (themeId, tagIds) => call('theme:tagLibrary:deleteTags', themeId, tagIds),
    saveSettings: (patch) => call('settings:set', patch),
    readClipboard: () => readText().catch(() => ''), commonUsGaap: () => call('db:commonUsGaap'),
    exportAll: () => call('io:export'), importAll: (json) => call('io:import', json),
    openDataDir: async () => {
      try { const path = await invoke('legacy_data_dir'); await openPath(path); return { ok: true, path } }
      catch (error) { return { ok: false, error: error?.message || String(error) } }
    },
    openExternal: async (url) => {
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) return false
        await openUrl(parsed.toString())
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
    inboxExtract: (ids, themeId) => call('inbox:extract', ids, themeId), inboxSetTheme: (id, themeId) => call('inbox:setTheme', id, themeId),
    inboxClearUnextracted: () => call('inbox:clearUnextracted'), inboxPrune: (days, opts) => call('inbox:prune', days, opts),
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
    onInboxPruned: (cb) => subscribe('inbox:pruned', cb),
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
