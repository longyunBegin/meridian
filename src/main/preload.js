const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('meridian', {
  // ---- 读
  stats: () => ipcRenderer.invoke('db:stats'),
  nodes: (themeId) => ipcRenderer.invoke('db:nodes', themeId),
  allNodes: () => ipcRenderer.invoke('db:allNodes'),
  getNode: (id) => ipcRenderer.invoke('db:getNode', id),
  themes: () => ipcRenderer.invoke('theme:all'),
  settings: () => ipcRenderer.invoke('settings:get'),
  labelTest: (text) => ipcRenderer.invoke('label:test', text),
  llmTest: () => ipcRenderer.invoke('llm:test'),
  jevTest: () => ipcRenderer.invoke('jev:test'),
  jevLabelTest: (text) => ipcRenderer.invoke('jev:labelTest', text),
  due: () => ipcRenderer.invoke('db:due'),
  calibration: () => ipcRenderer.invoke('db:calibration'),
  filterCalibration: () => ipcRenderer.invoke('db:filterCalibration'),
  falseKill: (days) => ipcRenderer.invoke('db:falseKill', days),
  falseKillByChannel: (days) => ipcRenderer.invoke('db:falseKillByChannel', days),
  events: () => ipcRenderer.invoke('db:events'),
  conflicts: () => ipcRenderer.invoke('db:conflicts'),
  verdicts: () => ipcRenderer.invoke('db:verdicts'),
  premises: () => ipcRenderer.invoke('db:premises'),
  suggestParent: (text, themeId) => ipcRenderer.invoke('db:suggestParent', text, themeId),
  addTicker: (id, ticker) => ipcRenderer.invoke('db:addTicker', id, ticker),
  removeTicker: (id, code) => ipcRenderer.invoke('db:removeTicker', id, code),
  tickerLookup: (code, themeId) => ipcRenderer.invoke('db:tickerLookup', code, themeId),
  tickers: (themeId) => ipcRenderer.invoke('db:tickers', themeId),

  // ---- 写
  addNode: (input) => ipcRenderer.invoke('db:addNode', input),
  updateNode: (id, patch) => ipcRenderer.invoke('db:updateNode', id, patch),
  removeNode: (id) => ipcRenderer.invoke('db:removeNode', id),
  restoreNode: (id) => ipcRenderer.invoke('db:restoreNode', id),
  purgeDead: (scope, opts) => ipcRenderer.invoke('db:purgeDead', scope, opts),
  repropagate: (id) => ipcRenderer.invoke('db:repropagate', id),
  settle: (id, correct) => ipcRenderer.invoke('db:settle', id, correct),
  addSource: (id, source) => ipcRenderer.invoke('db:addSource', id, source),
  resolveConflict: (id, verdict) => ipcRenderer.invoke('db:resolveConflict', id, verdict),
  spawn: (branchId) => ipcRenderer.invoke('db:spawn', branchId),
  addTheme: (name) => ipcRenderer.invoke('theme:add', name),
  setupNewTheme: (description) => ipcRenderer.invoke('theme:setupNew', description),
  regenerateTheme: (themeId) => ipcRenderer.invoke('theme:regenerate', themeId),
  themeScaffoldStatus: () => ipcRenderer.invoke('theme:scaffoldStatus'),
  themeScaffoldResult: (themeId) => ipcRenderer.invoke('theme:scaffoldResult', themeId),
  onThemeScaffolded: (cb) => ipcRenderer.on('theme:scaffolded', (_, info) => cb(info)),
  onThemeScaffoldProgress: (cb) => ipcRenderer.on('theme:scaffoldProgress', (_, info) => cb(info)),
  scaffoldExisting: (themeId, description) => ipcRenderer.invoke('theme:scaffoldExisting', themeId, description),
  removeTheme: (id) => ipcRenderer.invoke('theme:remove', id),
  restoreTheme: (id) => ipcRenderer.invoke('theme:restore', id),
  deletedThemes: () => ipcRenderer.invoke('theme:deleted'),
  renameTheme: (id, name) => ipcRenderer.invoke('theme:rename', id, name),
  themeUpdate: (id, patch) => ipcRenderer.invoke('theme:update', id, patch),
  updateTagLibraryTag: (themeId, tagId, patch) => ipcRenderer.invoke('theme:tagLibrary:updateTag', themeId, tagId, patch),
  deleteTagLibraryTags: (themeId, tagIds) => ipcRenderer.invoke('theme:tagLibrary:deleteTags', themeId, tagIds),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // ---- io
  readClipboard: () => ipcRenderer.invoke('io:readClipboard'),
  commonUsGaap: () => ipcRenderer.invoke('db:commonUsGaap'),
  exportAll: () => ipcRenderer.invoke('io:export'),
  importAll: (json) => ipcRenderer.invoke('io:import', json),
  openDataDir: () => ipcRenderer.invoke('io:openDataDir'),
  openExternal: (url) => ipcRenderer.invoke('io:openExternal', url),

  // ---- 原文层
  rawStats: () => ipcRenderer.invoke('raw:stats'),
  rawGet: (id) => ipcRenderer.invoke('raw:get', id),
  rawPrune: () => ipcRenderer.invoke('raw:prune'),
  rawClear: () => ipcRenderer.invoke('raw:clear'),


  // ---- 捕获（已删除 HUD，保留 process/socratic）
  process: (text, themeId) => ipcRenderer.invoke('agent:process', text, themeId),
  socratic: (nodeId) => ipcRenderer.invoke('agent:socratic', nodeId),
  onChanged: (cb) => ipcRenderer.on('db:changed', () => cb()),

  // ---- 收件箱
  inboxCapture: (text, channelMeta) => ipcRenderer.invoke('inbox:capture', text, channelMeta),
  inboxList: (opts) => ipcRenderer.invoke('inbox:list', opts),
  inboxIgnored: () => ipcRenderer.invoke('inbox:ignored'),
  inboxResolve: (id, action) => ipcRenderer.invoke('inbox:resolve', id, action),
  inboxImport: (themeId, items, overrides) => ipcRenderer.invoke('inbox:import', themeId, items, overrides),
  inboxClear: () => ipcRenderer.invoke('inbox:clear'),
  inboxUndoAutoImport: (intakeEventId) => ipcRenderer.invoke('inbox:undoAutoImport', intakeEventId),
  inboxLastAutoImport: () => ipcRenderer.invoke('inbox:lastAutoImport'),
  inboxExtract: (ids) => ipcRenderer.invoke('inbox:extract', ids),
  inboxClearUnextracted: () => ipcRenderer.invoke('inbox:clearUnextracted'),
  inboxPrune: (days, opts) => ipcRenderer.invoke('inbox:prune', days, opts),
  intakeSeries: (sinceDays) => ipcRenderer.invoke('intake:series', sinceDays),

  // ---- LLM 账本
  llmUsage: () => ipcRenderer.invoke('llm:usage'),

  // ---- 留痕层 trace
  traceAll: () => ipcRenderer.invoke('trace:all'),
  traceByTarget: (targetId) => ipcRenderer.invoke('trace:byTarget', targetId),
  traceModelCalibration: () => ipcRenderer.invoke('trace:modelCalibration'),
  traceLabelerDivergence: () => ipcRenderer.invoke('trace:labelerDivergence'),

  // ---- EDGAR 标签发现
  discoverTags: (ticker) => ipcRenderer.invoke('edgar:discoverTags', ticker),

  // ---- 读数层
  addReading: (input) => ipcRenderer.invoke('reading:add', input),
  indicatorsForReading: (reading) => ipcRenderer.invoke('reading:indicatorsFor', reading),
  getReading: (id) => ipcRenderer.invoke('reading:get', id),
  readingsPage: (opts) => ipcRenderer.invoke('reading:page', opts),
  readingEvidence: (opts) => ipcRenderer.invoke('reading:evidence', opts),
  latestReadings: () => ipcRenderer.invoke('reading:latest'),
  sourcesPage: (opts) => ipcRenderer.invoke('source:page', opts),
  assignReading: (id, nodeId) => ipcRenderer.invoke('reading:assign', id, nodeId),
  verifyReadingChain: (key) => ipcRenderer.invoke('reading:verify', key),
  pushReadings: (envelope) => ipcRenderer.invoke('reading:push', envelope),
  exportIntent: () => ipcRenderer.invoke('agent:intent'),
  agentConnection: () => ipcRenderer.invoke('agent:connection'),
  onReadingProgress: (cb) => {
    const listener = (_, progress) => cb(progress)
    ipcRenderer.on('reading:progress', listener)
    return () => ipcRenderer.removeListener('reading:progress', listener)
  },

  // ---- 研究观点
  addResearch: (input) => ipcRenderer.invoke('research:add', input),
  allResearch: () => ipcRenderer.invoke('research:all'),
  researchByNode: (nodeId) => ipcRenderer.invoke('research:byNode', nodeId),
  researchHitRate: (notes, correct) => ipcRenderer.invoke('research:hitRate', notes, correct),
  vsInstitution: (days) => ipcRenderer.invoke('research:vsInstitution', days),

  // ---- 收件箱热键：主进程读剪贴板后发给渲染进程
  onInboxPaste: (cb) => ipcRenderer.on('inbox:paste', (_, text) => cb(text)),
  onDueNotify: (cb) => ipcRenderer.on('due:notify', () => cb()),
  onInboxPruned: (cb) => ipcRenderer.on('inbox:pruned', (_, info) => cb(info)),
})
