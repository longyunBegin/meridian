const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('meridian', {
  // ---- 读
  stats: () => ipcRenderer.invoke('db:stats'),
  nodes: (themeId) => ipcRenderer.invoke('db:nodes', themeId),
  getNode: (id) => ipcRenderer.invoke('db:getNode', id),
  themes: () => ipcRenderer.invoke('theme:all'),
  templates: () => ipcRenderer.invoke('theme:templates'),
  settings: () => ipcRenderer.invoke('settings:get'),
  labelTest: (text) => ipcRenderer.invoke('label:test', text),
  due: () => ipcRenderer.invoke('db:due'),
  calibration: () => ipcRenderer.invoke('db:calibration'),
  filterCalibration: () => ipcRenderer.invoke('db:filterCalibration'),
  falseKill: (days) => ipcRenderer.invoke('db:falseKill', days),
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
  repropagate: (id) => ipcRenderer.invoke('db:repropagate', id),
  settle: (id, correct) => ipcRenderer.invoke('db:settle', id, correct),
  addSource: (id, source) => ipcRenderer.invoke('db:addSource', id, source),
  resolveConflict: (id, verdict) => ipcRenderer.invoke('db:resolveConflict', id, verdict),
  spawn: (branchId) => ipcRenderer.invoke('db:spawn', branchId),
  addTheme: (name) => ipcRenderer.invoke('theme:add', name),
  addThemeFromTemplate: (templateId) => ipcRenderer.invoke('theme:fromTemplate', templateId),
  removeTheme: (id) => ipcRenderer.invoke('theme:remove', id),
  renameTheme: (id, name) => ipcRenderer.invoke('theme:rename', id, name),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // ---- io
  exportAll: () => ipcRenderer.invoke('io:export'),
  importAll: (json) => ipcRenderer.invoke('io:import', json),
  openDataDir: () => ipcRenderer.invoke('io:openDataDir'),

  // ---- 原文层
  rawStats: () => ipcRenderer.invoke('raw:stats'),
  rawGet: (id) => ipcRenderer.invoke('raw:get', id),
  rawPrune: () => ipcRenderer.invoke('raw:prune'),
  rawClear: () => ipcRenderer.invoke('raw:clear'),

  // ---- 订阅源
  feeds: () => ipcRenderer.invoke('feed:list'),
  feedAdd: (feed) => ipcRenderer.invoke('feed:add', feed),
  feedUpdate: (id, patch) => ipcRenderer.invoke('feed:update', id, patch),
  feedRemove: (id) => ipcRenderer.invoke('feed:remove', id),
  feedFetch: (id) => ipcRenderer.invoke('feed:fetch', id),
  feedFetchAndLabel: (id) => ipcRenderer.invoke('feed:fetchAndLabel', id),
  feedImport: (feedId, themeId, items) => ipcRenderer.invoke('feed:import', feedId, themeId, items),

  // ---- 捕获
  process: (text, themeId) => ipcRenderer.invoke('agent:process', text, themeId),
  socratic: (nodeId) => ipcRenderer.invoke('agent:socratic', nodeId),
  showCapture: () => ipcRenderer.send('app:showCapture'),
  captureReady: () => ipcRenderer.send('capture:ready'),
  captureResize: (height) => ipcRenderer.send('capture:resize', height),
  captureSave: (payload) => ipcRenderer.send('capture:save', payload),
  onCaptureFocus: (cb) => ipcRenderer.on('capture:focus', (_, v) => cb(v)),
  onCaptureReset: (cb) => ipcRenderer.on('capture:reset', () => cb()),
  onChanged: (cb) => ipcRenderer.on('db:changed', () => cb()),

  // ---- 收件箱
  inboxCapture: (text, channelMeta) => ipcRenderer.invoke('inbox:capture', text, channelMeta),
  inboxList: () => ipcRenderer.invoke('inbox:list'),
  inboxResolve: (id, action) => ipcRenderer.invoke('inbox:resolve', id, action),
  inboxImport: (themeId, items) => ipcRenderer.invoke('inbox:import', themeId, items),
  inboxClear: () => ipcRenderer.invoke('inbox:clear'),

  // ---- 骨架生成
  generateSkeleton: (description) => ipcRenderer.invoke('theme:generateSkeleton', description),
  instantiateSkeleton: (themeId, skeleton) => ipcRenderer.invoke('theme:instantiateSkeleton', themeId, skeleton),

  // ---- 收件箱热键：主进程读剪贴板后发给渲染进程
  onInboxPaste: (cb) => ipcRenderer.on('inbox:paste', (_, text) => cb(text)),
})
