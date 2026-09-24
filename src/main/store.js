import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { encrypt, decrypt, encryptSettings, decryptSettings } from './crypto.js'
const { app } = globalThis.__electron

const DATA_FILE = () => join(app.getPath('userData'), 'meridian.json')

/** 来源质量基准表。打标器只负责选类型，质量分一律由这张表裁决。 */
export const SOURCE_QUALITY = [
  ['财报 / 公告', 0.95],
  ['一手数据', 0.9],
  ['券商研报', 0.8],
  ['独立媒体', 0.65],
  ['自媒体', 0.5],
  ['群聊转发', 0.35],
  ['道听途说', 0.2],
]
const QUALITY = new Map(SOURCE_QUALITY)

/** us-gaap 常用标签置顶——探活实测过的高频标签，带中文标签方便辨识 */
export const COMMON_US_GAAP = [
  { tag: 'Revenues', label: '总收入' },
  { tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', label: '总收入（合同）' },
  { tag: 'GrossProfit', label: '毛利' },
  { tag: 'OperatingIncomeLoss', label: '营业利润' },
  { tag: 'NetIncomeLoss', label: '净利润' },
  { tag: 'EarningsPerShareBasic', label: '基本EPS' },
  { tag: 'CostOfRevenue', label: '营业成本' },
  { tag: 'CostOfGoodsAndServicesSold', label: '营业成本（商品）' },
  { tag: 'ResearchAndDevelopmentExpense', label: '研发费用' },
  { tag: 'InventoryNet', label: '存货' },
  { tag: 'PaymentsToAcquirePropertyPlantAndEquipment', label: '资本支出' },
  { tag: 'NetCashProvidedByUsedInOperatingActivities', label: '经营现金流' },
  { tag: 'LongTermDebt', label: '长期借款' },
  { tag: 'Assets', label: '总资产' },
  { tag: 'Liabilities', label: '总负债' },
  { tag: 'StockholdersEquity', label: '股东权益' },
]

/** 同义标签组：不同公司用不同 us-gaap 标签表达同一概念 */
export const SYNONYM_GROUPS = [
  ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
  ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
]

/** 来源类型 → 标签推导映射 */
export const KIND_TO_TAGS = {
  '财报 / 公告': ['财报'],
  '一手数据': ['一手数据'],
  '券商研报': ['券商研报'],
  '独立媒体': ['独立媒体'],
  '自媒体': ['自媒体'],
  '群聊转发': ['群聊转发'],
  '道听途说': ['道听途说'],
}

/** SEC SIC 代码 → 中文行业标签（覆盖常见行业，查不到的用 sicDescription 原文） */
export const SIC_TO_TAG = {
  3674: '半导体',
  3570: '计算机',
  3812: '通信设备',
  7372: '软件',
  7380: '服务',
  6021: '银行',
  6022: '银行',
  6199: '金融',
  6331: '保险',
  1311: '石油',
  2834: '医药',
  3841: '医疗器械',
  4813: '电信',
  5900: '零售',
  2000: '食品',
  2800: '化工',
  3300: '金属',
  3400: '制造',
  3600: '电子',
  3700: '汽车',
  4600: '运输',
  5000: '批发',
  7000: '酒店',
  8000: '服务',
}

/** 来源类型 → 标签（纯函数） */
export function kindToTags(kind) {
  return KIND_TO_TAGS[kind] || []
}

/** SIC 代码 → 行业标签（纯函数，查不到用 sicDescription 原文） */
export function sicToTags(sic, sicDescription) {
  const tags = []
  const sicNum = Number(sic)
  if (SIC_TO_TAG[sicNum]) tags.push(SIC_TO_TAG[sicNum])
  if (sicDescription && !tags.includes(sicDescription)) tags.push(sicDescription)
  return tags
}

/**
 * 按标签交集给通道排序。交集多的在前，交集 0 的排最后。
 * 返回 [{ channel, score, shared }]，score = 交集数量。
 */
export function rankChannelsByTags(channels, themeTags) {
  if (!themeTags?.length) return channels.map((c) => ({ channel: c, score: 0, shared: [] }))
  const want = new Set(themeTags)
  return channels
    .map((c) => {
      const shared = (c.tags || []).filter((t) => want.has(t))
      return { channel: c, score: shared.length, shared }
    })
    .sort((a, b) => b.score - a.score)
}

/** 更新频率 → 结算日偏移（天） */
const CADENCE_DAYS = { 周: 7, 月: 30, 季度: 95, 半年: 180, 年度: 365, 事件: 60 }

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.stepfun.com/v1',
  apiKey: '',
  model: 'step-3',
  hotkey: 'CommandOrControl+Shift+V',
  labeler: 'table', // table | jev | llm —— 可替换的打标器
  jevBaseUrl: 'https://openrouter.ai/api/v1',
  jevModel: 'typesafe/jev-1.13',
  jevKey: '',
}

const blank = () => ({
  version: 4,
  settings: { ...DEFAULT_SETTINGS },
  themes: [],
  nodes: [],
  verdicts: [], // 被筛掉的裁决记录：留判断，不留原文
  conflicts: [], // 待裁决的命题冲突
  feeds: [], // 订阅源：RSS / 公众号 / X 列表
  inbox: [], // 收件箱：待确认的摄入项，全局不按主题分
  traces: [], // 留痕：每一次模型介入的完整记录，独立集合不内联进 node
  channels: [], // 通道描述符：按内容类型选取数器
  intakeEvents: [], // 采集漏斗：每次捕获一条记录
  readings: [], // 读数：结构化财务数字，只追加不覆盖
  researchNotes: [], // 研究观点：外部机构对命题的判断，不产生 node、不进校准
})

let db = null
let saveTimer = null

export function load() {
  if (db) return db
  const file = DATA_FILE()
  if (existsSync(file)) {
    try { db = JSON.parse(readFileSync(file, 'utf8')) } catch { db = blank() }
  } else db = blank()
  migrate(db)
  return db
}

/** v1 → v2：source 单值升级为 sources 数组；补 verdicts / conflicts
 *  v2 → v3：来源可挂 rawId 指向原文层（见文件末尾），判断层本身不变
 *  v3 → v4：feeds 合并进 channels。RSS 只是 fetch 类型的一种，不该有平行系统。 */
function migrate(d) {
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) }
  d.verdicts = d.verdicts || []
  d.conflicts = d.conflicts || []
  d.feeds = d.feeds || []
  d.inbox = d.inbox || []
  d.traces = d.traces || []
  d.channels = d.channels || []
  d.intakeEvents = d.intakeEvents || []
  d.readings = d.readings || []
  d.researchNotes = d.researchNotes || []
  for (const t of d.themes || []) t.tags = Array.isArray(t.tags) ? t.tags : []
  for (const c of d.channels || []) {
    c.tags = Array.isArray(c.tags) ? c.tags : []
    c.failCount = c.failCount ?? 0
  }
  for (const n of d.nodes || []) {
    n.sources = Array.isArray(n.sources) ? n.sources : (n.source ? [n.source] : [])
    n.tags = Array.isArray(n.tags) ? n.tags : []
    n.tickers = Array.isArray(n.tickers) ? n.tickers : []
    n.status = n.status || 'live'
    n.scaffold = n.scaffold || null
    n.by = n.by || 'manual'
    n.stableId = n.stableId || n.id
    n.channelIds = Array.isArray(n.channelIds) ? n.channelIds : []
    delete n.source
  }
  // feeds → channels 迁移。feeds.kind 硬编码 'rss' 不在 SOURCE_QUALITY 表里，
  // 统一映射成 '独立媒体'（0.65）——对来源不明的 RSS 这是诚实的中性值。
  if (Array.isArray(d.feeds) && d.feeds.length) {
    for (const f of d.feeds) {
      if (d.channels.some((c) => c.fetch === 'rss' && c.query === f.url)) continue
      d.channels.push({
        id: f.id,
        name: f.name || f.url,
        kind: '独立媒体',
        fetch: 'rss',
        query: f.url,
        themeId: f.themeId || null,
        metric: null,
        interval: Math.max(15, Number(f.interval) || 60),
        lastFetch: f.lastFetch || null,
        lastCount: f.lastCount ?? null,
        cadence: '日',
        network: 'direct',
        enabled: f.enabled !== false,
        review: false,
        createdAt: f.createdAt || today(),
      })
    }
    d.feeds = []
  }
  d.version = 4
}

function persist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const file = DATA_FILE()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(db, null, 2))
  }, 120)
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
export const today = () => new Date().toISOString().slice(0, 10)
export const addDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)))
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0))
const round1 = (n) => Math.round(n * 10) / 10

// ------------------------------------------------------------------ nodes

export function allNodes() { return load().nodes }
export function getNode(id) { return load().nodes.find((n) => n.id === id) || null }
export function childrenOf(id) { return load().nodes.filter((n) => n.parentId === id) }
export function rootNodes(themeId) { return load().nodes.filter((n) => n.themeId === themeId && !n.parentId) }

export function descendants(id) {
  const out = []
  const walk = (pid) => { for (const c of childrenOf(pid)) { out.push(c); walk(c.id) } }
  walk(id)
  return out
}

export function addNode(input) {
  const t = today()
  const sources = normalizeSources(input.sources || (input.source ? [input.source] : []))
  const node = {
    id: uid(),
    themeId: input.themeId,
    parentId: input.parentId || null,
    kind: input.kind === 'branch' ? 'branch' : 'lemma',
    title: String(input.title || '').trim(),
    type: input.type || 'hypothesis',
    confidence: clamp(input.confidence ?? 50),
    propagation: input.propagation ?? 0.5,
    sources,
    tags: [...new Set(input.tags || [])],
    tickers: normalizeTickers(input.tickers || []),
    status: input.status || 'live', // live | cold | dead
    settlement: input.settlement || null,
    scaffold: input.scaffold || null,
    history: [{ t, confidence: clamp(input.confidence ?? 50), by: input.by || 'manual' }],
    by: input.by || 'manual',
    stableId: input.stableId || uid(),
    channelIds: [...new Set(input.channelIds || [])],
    createdAt: t,
    updatedAt: t,
    ...(input.intakeId ? { intakeId: input.intakeId } : {}),
  }
  db.nodes.push(node)
  persist()
  return node
}

function normalizeSources(list) {
  const seen = new Set()
  const out = []
  for (const s of list) {
    if (!s?.kind) continue
    const key = `${s.kind}|${s.label || ''}`
    if (seen.has(key)) continue // 同源同出处只计一次
    seen.add(key)
    out.push({
      kind: s.kind,
      label: s.label || s.kind,
      quality: QUALITY.has(s.kind) ? QUALITY.get(s.kind) : (s.quality ?? 0.5),
      at: s.at || today(),
      ...(s.rawId ? { rawId: s.rawId } : {}),
      ...(s.platform ? { platform: s.platform } : {}),
      ...(s.url ? { url: s.url } : {}),
      ...(s.fetchedAt ? { fetchedAt: s.fetchedAt } : {}),
      ...(s.searchPrompt ? { searchPrompt: s.searchPrompt } : {}),
    })
  }
  return out
}

export function updateNode(id, patch, { propagate = true } = {}) {
  const node = getNode(id)
  if (!node) return null

  if (patch.confidence !== undefined && patch.confidence !== node.confidence) {
    const before = node.confidence
    node.confidence = clamp(patch.confidence)
    node.history.push({ t: today(), confidence: node.confidence, by: 'manual' })
    if (propagate) propagateFrom(node, before, node.confidence)
    // 置信度跌破 20 自动进入墓碑区，但不删除——负资产的价值是避免重复犯错
    if (node.kind === 'lemma' && node.status === 'live' && node.confidence < 20) node.status = 'dead'
    if (node.kind === 'lemma' && node.status === 'dead' && node.confidence >= 20) node.status = 'live'
  }

  for (const key of ['title', 'type', 'parentId', 'settlement', 'themeId', 'status']) {
    if (patch[key] !== undefined) node[key] = patch[key]
  }
  if (patch.propagation !== undefined) node.propagation = clamp01(patch.propagation)
  if (patch.sources !== undefined) node.sources = normalizeSources(patch.sources)
  if (patch.tags !== undefined) node.tags = [...new Set(patch.tags)]
  if (patch.tickers !== undefined) node.tickers = normalizeTickers(patch.tickers)
  if (patch.channelIds !== undefined) node.channelIds = [...new Set(patch.channelIds)]
  node.updatedAt = today()
  persist()
  return node
}

export function removeNode(id) {
  const t = today()
  const doomed = [id, ...descendants(id).map((n) => n.id)]
  for (const nid of doomed) {
    const node = getNode(nid)
    if (!node) continue
    node.deletedFrom = node.parentId || null
    node.deletedAt = t
    node.status = 'dead'
  }
  persist()
}

/** 恢复整棵子树：把 deletedAt 的节点复活，还原 parentId */
export function restoreNode(id) {
  const node = getNode(id)
  if (!node || node.status !== 'dead') return false
  const restored = [id, ...descendants(id).map((n) => n.id)]
  for (const nid of restored) {
    const n = getNode(nid)
    if (!n || n.status !== 'dead' || !n.deletedAt) continue
    n.status = 'live'
    n.parentId = n.deletedFrom
    delete n.deletedAt
    delete n.deletedFrom
  }
  persist()
  return true
}

/**
 * 真删：清空墓碑区节点（不可恢复）。
 * scope: 'user' = 只删用户软删的（有 deletedAt），'auto' = 只删跌死的（无 deletedAt），'all' = 全部
 * { dryRun: true } 只返回计数不落盘，用于确认前预览。
 * 返回 { removed, userDeleted, autoDead } 方便 UI 拆开显示计数。
 */
export function purgeDead(scope = 'all', { dryRun = false } = {}) {
  const db = load()
  const deadNodes = db.nodes.filter((n) => n.status === 'dead')
  const userDeleted = deadNodes.filter((n) => n.deletedAt)
  const autoDead = deadNodes.filter((n) => !n.deletedAt)
  let toRemove
  if (scope === 'user') toRemove = userDeleted
  else if (scope === 'auto') toRemove = autoDead
  else toRemove = deadNodes
  if (dryRun) return { removed: toRemove.length, userDeleted: userDeleted.length, autoDead: autoDead.length }
  const deadIds = new Set(toRemove.map((n) => n.id))
  db.nodes = db.nodes.filter((n) => !deadIds.has(n.id))
  db.conflicts = db.conflicts.filter((c) => !deadIds.has(c.a) && !deadIds.has(c.b))
  persist()
  return { removed: deadIds.size, userDeleted: userDeleted.length, autoDead: autoDead.length }
}

/**
 * 纯函数：根据 dryRun 预览和用户确认，决定是否执行真删。
 * 把确认逻辑从 UI 回调里抽出来，让测试能断言「取消后数据不变」。
 */
export function planPurge(scope, dryRunResult, confirmed) {
  if (dryRunResult.removed === 0) return { willDelete: false, scope, reason: 'empty' }
  if (!confirmed) return { willDelete: false, scope, reason: 'canceled' }
  return { willDelete: true, scope, count: dryRunResult.removed }
}

/** 追加一个来源；若该 claim 已有独立来源，则只累加不新建。返回新增与否。 */
export function addSource(id, source) {
  const node = getNode(id)
  if (!node) return { added: false, count: 0 }
  const before = node.sources.length
  node.sources = normalizeSources([...node.sources, source])
  const added = node.sources.length > before
  node.updatedAt = today()
  persist()
  return { added, count: node.sources.length }
}

/**
 * 传导：置信度变化沿产业链方向向下游衰减。
 * 每一跳乘以该节点的 propagation 权重，深度衰减由复利自然产生。
 */
function propagateFrom(origin, before, after) {
  const delta = after - before
  if (Math.abs(delta) < 1) return []

  const queue = [{ id: origin.id, delta }]
  const seen = new Set([origin.id])
  const touched = []

  while (queue.length) {
    const { id, delta: d } = queue.shift()
    const node = getNode(id)
    if (!node) continue
    for (const child of childrenOf(id)) {
      if (seen.has(child.id) || child.status === 'dead') continue
      seen.add(child.id)
      const hop = d * clamp01(node.propagation)
      const next = clamp(child.confidence + hop)
      const real = next - child.confidence
      if (Math.abs(real) < 0.5) continue
      child.confidence = next
      child.history.push({ t: today(), confidence: round1(next), by: 'propagation', from: origin.id })
      touched.push({ id: child.id, delta: round1(real) })
      queue.push({ id: child.id, delta: real })
    }
  }
  return touched
}

/** 手动重算某个节点的整棵子树（用于调节权重后刷新） */
export function repropagate(id) {
  const node = getNode(id)
  if (!node) return []
  const first = node.history.find((h) => h.by === 'manual') || node.history[0]
  const baseline = first ? first.confidence : node.confidence
  for (const d of descendants(id)) {
    const f = d.history.find((h) => h.by === 'manual')
    d.confidence = clamp(f ? f.confidence : d.confidence)
  }
  return propagateFrom(node, baseline, node.confidence) || []
}

// ------------------------------------------------------------------ themes

export function allThemes() { return load().themes.filter((t) => !t.deletedAt) }
export function deletedThemes() {
  const db = load()
  return db.themes.filter((t) => t.deletedAt).map((t) => ({
    ...t,
    restorableCount: db.nodes.filter((n) => n.themeId === t.id && n.status === 'dead' && n.deletedAt).length,
  }))
}

export function bestThemeContext() {
  const db = load()
  const live = db.themes.filter((t) => !t.deletedAt)
  if (!live.length) return null
  const counts = {}
  for (const n of db.nodes) {
    if (n.kind === 'lemma' && n.status !== 'dead') counts[n.themeId] = (counts[n.themeId] || 0) + 1
  }
  let best = live[0]
  let max = -1
  for (const t of live) {
    const c = counts[t.id] || 0
    if (c > max) { max = c; best = t }
  }
  return best
}
export function addTheme(name) {
  const theme = { id: uid(), name: String(name || '').trim(), tags: [], createdAt: today() }
  db.themes.push(theme)
  persist()
  return theme
}
/** 更新主题字段（目前支持 name / tags） */
export function updateTheme(id, patch) {
  const theme = db.themes.find((t) => t.id === id)
  if (!theme) return null
  if (patch.name !== undefined) theme.name = String(patch.name).trim()
  if (patch.tags !== undefined) theme.tags = [...new Set(patch.tags.filter((t) => typeof t === 'string'))]
  persist()
  return theme
}
/** 软删主题：标记 deletedAt，所有根节点走 removeNode（递归软删子树） */
export function removeTheme(id) {
  const theme = db.themes.find((t) => t.id === id)
  if (!theme) return
  theme.deletedAt = today()
  for (const root of rootNodes(id)) removeNode(root.id)
  persist()
}

/** 恢复主题：清除 deletedAt，恢复所有该主题下被软删的节点 */
export function restoreTheme(id) {
  const theme = db.themes.find((t) => t.id === id)
  if (!theme || !theme.deletedAt) return false
  delete theme.deletedAt
  for (const n of db.nodes.filter((n) => n.themeId === id && n.status === 'dead' && n.deletedAt)) {
    restoreNode(n.id)
  }
  persist()
  return true
}
export function renameTheme(id, name) {
  const theme = db.themes.find((t) => t.id === id)
  if (theme) theme.name = String(name || '').trim()
  persist()
}

// ------------------------------------------------------------------ verdicts

/**
 * 裁决记录：被筛掉的内容只留判断，不留原文。
 * promotedTo 在「同一条 claim 后来从别的源进了图谱」时回填——那就是一次误杀。
 */
export function addVerdict(v) {
  const verdict = {
    id: uid(),
    at: today(),
    gate: v.gate || 'extract', // extract | source | dedup | user
    reason: v.reason || 'off-topic',
    summary: String(v.summary || '').slice(0, 120),
    score: clamp01(v.score ?? 0),
    choice: v.choice || null,
    promotedTo: null,
    ...(v.nodeId ? { nodeId: v.nodeId } : {}),
    ...(v.themeId ? { themeId: v.themeId } : {}),
    ...(v.channelId ? { channelId: v.channelId } : {}),
  }
  db.verdicts.push(verdict)
  persist()
  return verdict
}

export function allVerdicts() { return load().verdicts }

/** 同一条 claim 后来从别的源进了图谱 → 回填 promotedTo，记为一次误杀 */
export function markPromoted(verdictId, nodeId) {
  const v = db.verdicts.find((x) => x.id === verdictId)
  if (v) { v.promotedTo = nodeId; persist() }
  return v
}

/** 回查既有 verdicts，匹配到被筛掉的同一 claim 则回填 promotedTo（误杀闭环） */
export function promoteMatchingVerdicts(nodeTitle, nodeId, themeId) {
  const norm = (s) => String(s || '').trim().toLowerCase()
  const nodeTokens = new Set(tokenize(nodeTitle))
  for (const v of db.verdicts) {
    if (v.promotedTo != null) continue // 幂等：已回填的跳过
    if (v.themeId && v.themeId !== themeId) continue // 只回填同主题
    // 优先级 1：标题规范化后精确相等
    if (norm(v.summary) === norm(nodeTitle)) {
      markPromoted(v.id, nodeId)
      continue
    }
    // 优先级 2：token 重合度 ≥ 0.6
    const ownTokens = tokenize(v.summary)
    if (!ownTokens.length || !nodeTokens.size) continue
    let hit = 0
    for (const t of nodeTokens) if (ownTokens.includes(t)) hit += t.length >= 2 ? 2 : 1
    const denom = ownTokens.reduce((s, t) => s + (t.length >= 2 ? 2 : 1), 0)
    const score = denom ? hit / denom : 0
    if (score >= 0.6) markPromoted(v.id, nodeId)
  }
}

// ------------------------------------------------------------------ conflicts

export function addConflict(a, b, note) {
  if (a === b) return null
  const exists = db.conflicts.find((c) => !c.resolved && ((c.a === a && c.b === b) || (c.a === b && c.b === a)))
  if (exists) return exists
  const c = { id: uid(), a, b, note: note || '两条命题互相矛盾', at: today(), resolved: null }
  db.conflicts.push(c)
  persist()
  return c
}

export function allConflicts() { return load().conflicts }

export function resolveConflict(id, verdict) {
  const c = db.conflicts.find((x) => x.id === id)
  if (!c) return null
  c.resolved = verdict // 'a' | 'b' | 'both'
  c.resolvedAt = today()
  persist()
  return c
}

export function conflictsOf(nodeId) {
  return db.conflicts.filter((c) => !c.resolved && (c.a === nodeId || c.b === nodeId))
}

// ------------------------------------------------------------------ queries

/** 到期未结算的命题（附带上下文：下游数 + 挂点路径，供通知使用） */
export function dueSettlements() {
  const t = today()
  return db.nodes
    .filter((n) => n.kind === 'lemma' && n.status !== 'dead' && n.settlement?.date && n.settlement.resolved == null && n.settlement.date <= t)
    .sort((a, b) => a.settlement.date.localeCompare(b.settlement.date))
    .map((n) => ({
      ...n,
      downstreamCount: descendants(n.id).length,
      branchPath: branchPathOf(n) || null,
    }))
}

/** 最近发生过的传导事件（含相对上一条记录的变化量） */
export function propagationEvents(sinceDays = 14) {
  const cutoff = Date.now() - sinceDays * 864e5
  const events = []
  for (const n of db.nodes) {
    n.history.forEach((entry, i) => {
      if (entry.by !== 'propagation') return
      const ts = Date.parse(entry.t)
      if (!Number.isFinite(ts) || ts < cutoff) return
      const prev = n.history[i - 1]?.confidence ?? entry.confidence
      events.push({
        id: n.id, title: n.title, previous: prev, confidence: entry.confidence,
        delta: round1(entry.confidence - prev), from: entry.from, t: entry.t, ts,
      })
    })
  }
  return events.sort((a, b) => b.ts - a.ts)
}

/** 命题校准曲线：分置信度桶统计命中率。只统计 by:'manual' 的置信度设定。 */
export function calibration() {
  const buckets = new Map()
  for (const n of db.nodes) {
    if (n.kind !== 'lemma') continue
    const s = n.settlement
    if (!s || s.resolved == null || s.correct == null) continue
    const first = n.history.find((h) => h.by === 'manual')
    if (!first) continue
    const bucket = Math.min(10, Math.floor(first.confidence / 10)) * 10
    const b = buckets.get(bucket) || { bucket, total: 0, hit: 0 }
    b.total += 1
    if (s.correct) b.hit += 1
    buckets.set(bucket, b)
  }
  return [...buckets.values()].map((b) => ({ ...b, accuracy: b.hit / b.total })).sort((a, b) => a.bucket - b.bucket)
}

/**
 * 过滤器校准曲线：按 Jev 质量分分桶，统计误杀率。
 * 误杀 = 该 verdict 的 promotedTo 非空（同一条 claim 后来从别的源进了图谱）。
 */
export function filterCalibration() {
  const edges = [0, 0.3, 0.5, 0.7]
  const buckets = edges.map((lo) => ({
    lo,
    hi: lo === 0.7 ? 1 : edges[edges.indexOf(lo) + 1],
    total: 0,
    killed: 0,
    missed: 0,
  }))
  for (const v of db.verdicts) {
    const b = buckets.find((x) => v.score >= x.lo && v.score < x.hi) || buckets[buckets.length - 1]
    b.total += 1
    if (v.promotedTo) b.missed += 1
  }
  const result = buckets.map((b) => ({
    lo: b.lo,
    hi: b.hi,
    total: b.total,
    missed: b.missed,
    accuracy: b.total ? b.missed / b.total : 0,
  }))

  // 按 gate 拆分误杀率（附加，不破坏原有数组结构）
  const gateStats = { source: { total: 0, missed: 0 }, dedup: { total: 0, missed: 0 }, user: { total: 0, missed: 0 }, other: { total: 0, missed: 0 } }
  for (const v of db.verdicts) {
    const g = gateStats[v.gate] ? v.gate : 'other'
    gateStats[g].total++
    if (v.promotedTo) gateStats[g].missed++
  }
  result.byGate = {
    source: { ...gateStats.source, accuracy: gateStats.source.total ? gateStats.source.missed / gateStats.source.total : 0, label: '明确误杀' },
    dedup: { ...gateStats.dedup, accuracy: gateStats.dedup.total ? gateStats.dedup.missed / gateStats.dedup.total : 0, label: '收敛度存疑' },
    user: { ...gateStats.user, accuracy: gateStats.user.total ? gateStats.user.missed / gateStats.user.total : 0, label: '用户误判' },
    other: { ...gateStats.other, accuracy: gateStats.other.total ? gateStats.other.missed / gateStats.other.total : 0, label: '其他 gate' },
  }

  return result
}

/** 误杀审计：本月被筛掉的总数，以及其中后来变成了重要命题的 */
export function falseKillAudit(days = 30) {
  const cutoff = Date.now() - days * 864e5
  const recent = db.verdicts.filter((v) => Date.parse(v.at) >= cutoff)
  const killed = recent.filter((v) => v.promotedTo)
  return {
    window: days,
    total: recent.length,
    missed: killed.length,
    rate: recent.length ? killed.length / recent.length : 0,
    items: killed.map((v) => ({
      verdict: v,
      node: getNode(v.promotedTo),
    })).filter((x) => x.node),
  }
}

/** 按通道聚合误杀，返回误杀最多的通道 top N */
export function falseKillByChannel(days = 30, topN = 10) {
  const cutoff = Date.now() - days * 864e5
  const recent = db.verdicts.filter((v) => Date.parse(v.at) >= cutoff)
  const byChannel = {}
  for (const v of recent) {
    const ch = v.channelId || '未知通道'
    if (!byChannel[ch]) byChannel[ch] = { channelId: ch, total: 0, missed: 0 }
    byChannel[ch].total++
    if (v.promotedTo) byChannel[ch].missed++
  }
  return Object.values(byChannel)
    .map((c) => ({ ...c, rate: c.total ? c.missed / c.total : 0 }))
    .sort((a, b) => b.missed - a.missed || b.total - a.total)
    .slice(0, topN)
}

/**
 * 本地归位建议：按标题 token 重合度打分。
 * 没有 key 时也能用；有打标器时 extract 会给更好的 parentHint。
 */
const STOP = new Set(['的', '了', '是', '在', '和', '与', '有', '对', '从', '到', '为', '将', '被', '一个', '这个', '那个', '不会', '可能'])

export function suggestParent(text, themeId) {
  const tokens = tokenize(text)
  if (!tokens.length) return []
  return db.nodes
    .filter((n) => n.themeId === themeId && n.kind === 'branch')
    .map((n) => {
      const own = tokenize(n.title)
      let hit = 0
      for (const t of tokens) if (own.includes(t)) hit += t.length >= 2 ? 2 : 1
      return { node: n, score: hit }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

export function tokenize(text) {
  const cjk = String(text).match(/[一-龥]{2,}/g) || []
  const latin = String(text).toLowerCase().match(/[a-z][a-z0-9+.#-]{2,}/g) || []
  return [...cjk.flatMap((s) => s.split(/(?=[上中下游内])/)), ...latin]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !STOP.has(s))
}

/** 找同一条 claim 的既有命题：token 重合度超过阈值即视为同一判断 */
export function findSimilar(text, themeId, threshold = 0.45) {
  const tokens = new Set(tokenize(text))
  if (!tokens.size) return []
  return db.nodes
    .filter((n) => n.kind === 'lemma' && n.themeId === themeId && n.status !== 'dead')
    .map((n) => {
      const own = tokenize(n.title)
      if (!own.length) return null
      let hit = 0
      for (const t of tokens) if (own.includes(t)) hit += t.length >= 2 ? 2 : 1
      const denom = own.reduce((s, t) => s + (t.length >= 2 ? 2 : 1), 0)
      const score = denom ? hit / denom : 0
      return score >= threshold ? { node: n, score: round1(score) } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
}

/** 找潜在冲突：同一父节点下类型相反的命题 */
export function findConflicts(nodeId) {
  const node = getNode(nodeId)
  if (!node || node.kind !== 'lemma') return []
  const siblings = childrenOf(node.parentId).filter((n) => n.kind === 'lemma' && n.id !== node.id && n.status !== 'dead')
  const neg = /(不会|未能|低于|下跌|下降|推迟|不及|放缓|停滞|失败|压制)/
  const pos = /(超|上调|增长|上升|突破|提前|加速|放量|创新高)/
  const mine = node.title
  const out = []
  for (const s of siblings) {
    const sameSubject = tokenize(mine).some((t) => tokenize(s.title).includes(t))
    if (!sameSubject) continue
    const flip = (neg.test(mine) && pos.test(s.title)) || (pos.test(mine) && neg.test(s.title))
    if (flip) out.push({ node: s, reason: '方向相反' })
  }
  return out
}

/**
 * 从环节骨架生成待回答命题。
 * 结算日由指标更新频率推导——这是 scaffold 和结算层之间的桥。
 */
export function spawnFromScaffold(branchId) {
  const branch = getNode(branchId)
  if (!branch?.scaffold) return []
  const created = []

  for (const q of branch.scaffold.answer || []) {
    created.push(addNode({
      themeId: branch.themeId,
      parentId: branchId,
      kind: 'lemma',
      title: q,
      type: 'hypothesis',
      confidence: 50,
      tags: branch.tags,
    }))
  }
  for (const ind of branch.scaffold.indicators || []) {
    const name = typeof ind === 'string' ? ind : String(ind?.name || '').trim()
    if (!name) continue
    const cadence = (typeof ind === 'object' && ind?.cadence) || '季度'
    const days = CADENCE_DAYS[cadence] ?? 60
    created.push(addNode({
      themeId: branch.themeId,
      parentId: branchId,
      kind: 'lemma',
      title: `${name}：按${cadence}节奏更新，本期读数待填`,
      type: 'observation',
      confidence: 50,
      settlement: { date: addDays(days), resolved: null, correct: null },
      tags: branch.tags,
    }))
  }
  return created
}

/**
 * 共同前提：同一批 tag 出现在 ≥2 个主题里，就是跨主题共享的底层假设。
 * 改变它，两边同时受影响。
 */
export function sharedPremises() {
  const byTag = new Map()
  for (const n of db.nodes) {
    if (n.status === 'dead') continue
    for (const tag of n.tags || []) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(n)
    }
  }
  const themes = new Map(db.themes.map((t) => [t.id, t]))
  const out = []
  for (const [tag, nodes] of byTag) {
    const byTheme = new Map()
    for (const n of nodes) {
      if (!byTheme.has(n.themeId)) byTheme.set(n.themeId, [])
      byTheme.get(n.themeId).push(n)
    }
    if (byTheme.size < 2) continue
    out.push({
      tag,
      themes: [...byTheme.entries()].map(([themeId, list]) => ({
        themeId,
        name: themes.get(themeId)?.name || '未知主题',
        branches: [...new Set(list.map((n) => branchPathOf(n)))].filter(Boolean).slice(0, 3),
        count: list.length,
      })),
      affected: nodes.length,
    })
  }
  return out.sort((a, b) => b.affected - a.affected)
}

/** 取节点所属的最深一级环节名——共同前提要靠它才看得出具体是哪一层 */
function branchPathOf(node) {
  const out = []
  let cur = node
  while (cur) {
    if (cur.kind === 'branch') out.unshift(cur.title)
    cur = cur.parentId ? getNode(cur.parentId) : null
  }
  return out.join(' / ')
}

export function settleLemma(id, correct) {
  const node = getNode(id)
  if (!node) return null
  node.settlement = { ...(node.settlement || {}), resolved: today(), correct: !!correct }
  node.updatedAt = today()
  persist()
  return node
}

// ------------------------------------------------------------------ tickers

/**
 * 命题 ↔ 标的映射。只做可见性，不做信号——合规红线。
 * 标的挂在命题上，可反查「这条产业链位置影响哪些票」。
 * 不输出买卖建议、评分、目标价。
 */
function normalizeTicker(t) {
  if (!t?.code) return null
  return {
    code: String(t.code).trim().toUpperCase().slice(0, 20),
    name: String(t.name || t.code).trim().slice(0, 40),
    relation: ['受益', '受损', '中性'].includes(t.relation) ? t.relation : '受益',
  }
}

function normalizeTickers(list) {
  const seen = new Set()
  const out = []
  for (const t of list) {
    const n = normalizeTicker(t)
    if (!n || seen.has(n.code)) continue
    seen.add(n.code)
    out.push(n)
  }
  return out
}

export function addTicker(nodeId, ticker) {
  const node = getNode(nodeId)
  if (!node) return null
  const t = normalizeTicker(ticker)
  if (!t) return null
  if (!node.tickers.some((x) => x.code === t.code)) {
    node.tickers.push(t)
    node.updatedAt = today()
    persist()
  }
  return node
}

export function removeTicker(nodeId, code) {
  const node = getNode(nodeId)
  if (!node) return null
  node.tickers = node.tickers.filter((t) => t.code !== code)
  node.updatedAt = today()
  persist()
  return node
}

/** 反查：某标的关联的所有命题（可选限定主题） */
export function nodesByTicker(code, themeId) {
  const c = String(code).trim().toUpperCase()
  return db.nodes.filter((n) =>
    n.kind === 'lemma' && n.status !== 'dead' &&
    n.tickers?.some((t) => t.code === c) &&
    (!themeId || n.themeId === themeId),
  )
}

/** 某主题下出现过的全部标的（去重，按出现次数排序） */
export function allTickers(themeId) {
  const counts = new Map()
  for (const n of db.nodes) {
    if (n.kind !== 'lemma' || n.status === 'dead') continue
    if (themeId && n.themeId !== themeId) continue
    for (const t of n.tickers || []) {
      const key = t.code
      const entry = counts.get(key) || { ...t, count: 0 }
      entry.count++
      counts.set(key, entry)
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

// ------------------------------------------------------------------ stats

export function stats() {
  const nodes = db.nodes
  const lemmas = nodes.filter((n) => n.kind === 'lemma')
  return {
    themes: db.themes.filter((t) => !t.deletedAt).length,
    branches: nodes.length - lemmas.length,
    lemmas: lemmas.length,
    live: lemmas.filter((n) => n.status === 'live').length,
    cold: lemmas.filter((n) => n.status === 'cold').length,
    dead: nodes.filter((n) => n.status === 'dead').length,
    due: dueSettlements().length,
    events: propagationEvents(14).length,
    verdicts: db.verdicts.length,
    conflicts: db.conflicts.filter((c) => !c.resolved).length,
    premises: sharedPremises().length,
    feeds: db.channels.filter((c) => c.enabled).length,
    inbox: db.inbox.filter((i) => i.status === 'pending').length,
    readings: db.readings.length,
    researchNotes: db.researchNotes.length,
  }
}

export function settings() { return decryptSettings(load().settings) }
export function saveSettings(patch) {
  const enc = { ...patch }
  if (patch.apiKey !== undefined) enc.apiKey = encrypt(patch.apiKey)
  if (patch.jevKey !== undefined) enc.jevKey = encrypt(patch.jevKey)
  db.settings = { ...db.settings, ...enc }
  persist()
  return decryptSettings(db.settings)
}

// ------------------------------------------------------------------ 原文层

/**
 * 原文层：判断层记"我得出了什么结论"，这里记"我当时读的是什么"。
 *
 * 两者生命周期不同，所以拆成两个文件：判断是要复利的资产，
 * 原文只是一次性依据——清掉原文不该动到任何一条命题。
 *
 * 只存"进了判断"的那部分。被筛掉的内容仍然只留裁决记录（见 addVerdict），
 * 那是 ROADMAP 划的边界：存原文会把产品做成垃圾抽屉。
 *
 * 用 JSONL 而不是 JSON：追加是 O(1)，进程崩了最坏丢半行（读的时候跳过），
 * 不必为了加一条而重写整个文件。
 */
const RAW_FILE = () => join(app.getPath('userData'), 'raw.jsonl')

let rawCache = null
let rawBySha = null

/** 懒加载——没人看原文就不读文件，启动不为它花钱。 */
function loadRaw() {
  if (rawCache) return rawCache
  rawCache = new Map()
  rawBySha = new Map()
  const file = RAW_FILE()
  if (!existsSync(file)) return rawCache
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e?.id && e.text) { rawCache.set(e.id, e); rawBySha.set(e.sha256, e.id) }
    } catch { /* 追加中断留下的半行，直接丢 */ }
  }
  return rawCache
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * 落一段原文，返回 rawId。同内容只存一份——sha256 命中就复用旧 id。
 * 这同时是 v0.4「N 个独立源」的免费数据源：不同 hash 天然就是独立来源。
 */
export function appendRaw({ kind, label, text, channel }) {
  const body = String(text || '').trim()
  if (!body) return { id: null, added: false }
  const cache = loadRaw()
  const h = sha(body)
  const hit = rawBySha.get(h)
  if (hit) return { id: hit, added: false }

  const entry = {
    id: uid(),
    at: today(),
    sha256: h,
    kind: kind || '独立媒体',
    label: label || kind || '未注明',
    chars: body.length,
    text: body,
    ...(channel?.platform ? { platform: channel.platform } : {}),
    ...(channel?.url ? { url: channel.url } : {}),
    ...(channel?.fetchedAt ? { fetchedAt: channel.fetchedAt } : {}),
    ...(channel?.channelId ? { channelId: channel.channelId } : {}),
  }
  cache.set(entry.id, entry)
  rawBySha.set(h, entry.id)
  const file = RAW_FILE()
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(entry) + '\n')
  return { id: entry.id, added: true }
}

export function getRaw(id) { return loadRaw().get(id) || null }

/** 被命题引用着的 rawId。清理时绝不动这些。 */
function referencedRawIds() {
  const used = new Set()
  for (const n of db.nodes) for (const s of n.sources || []) if (s.rawId) used.add(s.rawId)
  return used
}

function rewriteRaw(entries) {
  const file = RAW_FILE()
  mkdirSync(dirname(file), { recursive: true })
  if (!entries.length) { rmSync(file, { force: true }); return }
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

/** 清掉没有任何命题引用的原文。判断层一行不动，这个操作绝对安全。 */
export function pruneRaw() {
  const used = referencedRawIds()
  const cache = loadRaw()
  const doomed = [...cache.values()].filter((e) => !used.has(e.id))
  for (const e of doomed) { cache.delete(e.id); rawBySha.delete(e.sha256) }
  rewriteRaw([...cache.values()])
  return { removed: doomed.length, kept: cache.size }
}

/** 清空全部原文，并把节点上的 rawId 摘掉。判断、置信度、校准曲线全部保留。 */
export function clearRaw() {
  const cache = loadRaw()
  const removed = cache.size
  cache.clear()
  rawBySha.clear()
  rewriteRaw([])
  let unlinked = 0
  for (const n of db.nodes) {
    for (const s of n.sources || []) if (s.rawId) { delete s.rawId; unlinked++ }
  }
  if (unlinked) persist()
  return { removed, unlinked }
}

export function rawStats() {
  let chars = 0
  for (const e of loadRaw().values()) chars += Buffer.byteLength(e.text || '', 'utf8')
  return { count: loadRaw().size, bytes: chars }
}

/**
 * 导出带上原文层——它常常抓不回来，是资产的一部分。
 * withRaw: false 时**整个 raw 键都不出现**，而不是给空数组：
 * 空数组会被导入端理解成"用空覆盖"，把磁盘上的原文清掉。
 */
export function exportAll({ withRaw = true } = {}) {
  const out = { ...db, version: 4 }
  if (withRaw) out.raw = [...loadRaw().values()]
  return JSON.stringify(out, null, 2)
}

export function importAll(json) {
  const parsed = JSON.parse(json)
  if (!parsed || !Array.isArray(parsed.nodes)) throw new Error('不是有效的脉络数据文件')
  db = { version: 4, settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }, themes: parsed.themes || [], nodes: parsed.nodes, verdicts: parsed.verdicts || [], conflicts: parsed.conflicts || [], feeds: parsed.feeds || [], inbox: parsed.inbox || [], traces: parsed.traces || [], channels: parsed.channels || [], intakeEvents: parsed.intakeEvents || [], readings: parsed.readings || [], researchNotes: parsed.researchNotes || [] }
  migrate(db)
  // 带了原文就整体替换；没带（只导出判断的文件）则不动磁盘上已有的原文
  if (Array.isArray(parsed.raw)) {
    const keep = parsed.raw.filter((e) => e?.id && e.text)
    rewriteRaw(keep)
    rawCache = null
    rawBySha = null
  }
  persist()
  return true
}
// ------------------------------------------------------------------ 收件箱

/**
 * 收件箱：全局待确认区，不按主题分。
 * 摄入入口（⌘⇧V 粘贴、LLM 检索、订阅源）→ 统一打标/去重/冲突检测 → 等用户裁决。
 * 摩擦按批摊薄：十条从 10 次热键 + 10 次 round-trip + 10 次审阅
 * 变成 1 次粘贴 + 1 次 round-trip + 1 次批量勾选。
 */
export function allInbox() {
  return load().inbox.filter((i) => i.status === 'pending')
}

export function addInboxItem(item) {
  const entry = {
    id: uid(),
    text: item.text || '',
    title: item.title || '',
    label: item.label || null,
    lemmas: item.lemmas || [],
    rejected: item.rejected || [],
    noulCompared: item.noulCompared || 0,
    noulMaxScore: item.noulMaxScore || 0,
    provenance: item.provenance || null,
    status: 'pending',
    createdAt: today(),
  }
  load().inbox.push(entry)
  persist()
  return entry
}

export function resolveInboxItem(id, action) {
  const item = load().inbox.find((i) => i.id === id)
  if (!item) return null
  item.status = action === 'accept' ? 'accepted' : 'rejected'
  item.resolvedAt = today()
  persist()
  return item
}

export function clearInbox() {
  const db = load()
  const before = db.inbox.length
  db.inbox = db.inbox.filter((i) => i.status === 'pending')
  persist()
  return before - db.inbox.length
}

export function inboxCount() {
  return load().inbox.filter((i) => i.status === 'pending').length
}
// ============================================================
// 采集漏斗 intakeEvents
// ============================================================

export function addIntakeEvent(event) {
  const db = load()
  const record = {
    id: uid(),
    at: today(),
    ...event,
    undone: false,
  }
  db.intakeEvents.push(record)
  persist()
  return record
}

export function getIntakeEvent(id) {
  return load().intakeEvents.find((e) => e.id === id) || null
}

export function markIntakeUndone(id) {
  const db = load()
  const event = db.intakeEvents.find((e) => e.id === id)
  if (!event) return null
  event.undone = true
  persist()
  return event
}

export function markIntakeResolved(inboxItemId, overridden) {
  const db = load()
  const event = db.intakeEvents.find((e) => e.inboxItemId === inboxItemId)
  if (!event) return null
  event.resolved = true
  if (overridden) event.overridden = true
  persist()
  return event
}

/** 最近一条未撤销的自动归位事件，用于渲染层恢复撤销入口 */
export function lastAutoIntakeEvent() {
  const db = load()
  for (let i = db.intakeEvents.length - 1; i >= 0; i--) {
    if (db.intakeEvents[i].outcome === 'auto' && !db.intakeEvents[i].undone) {
      return db.intakeEvents[i]
    }
  }
  return null
}

/** 按天返回采集漏斗 */
export function intakeSeries(sinceDays = 30) {
  const db = load()
  const cutoff = new Date(Date.now() - sinceDays * 864e5).toISOString().slice(0, 10)
  const byDate = {}
  for (const e of db.intakeEvents) {
    if (e.at < cutoff) continue
    if (!byDate[e.at]) {
      byDate[e.at] = {
        date: e.at, captured: 0, gatedIn: 0, autoImported: 0, toInbox: 0,
        confirmed: 0, rejected: 0, undone: 0, overridden: 0, degraded: 0,
      }
    }
    const b = byDate[e.at]
    b.captured++
    if (e.gate?.pass) b.gatedIn++
    if (e.outcome === 'auto') b.autoImported++
    if (e.outcome === 'inbox') b.toInbox++
    if (e.undone) b.undone++
    if (e.degraded) b.degraded++
    if (e.overridden) b.overridden++
    if (e.outcome === 'inbox' && e.inboxItemId) {
      const item = db.inbox.find((i) => i.id === e.inboxItemId)
      if (item?.status === 'accepted') b.confirmed++
      if (item?.status === 'rejected') b.rejected++
    }
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
}
// ============================================================
// 留痕层 trace
// ============================================================

export function addTrace(trace) {
  const db = load()
  const record = {
    id: uid(),
    t: today(),
    ...trace,
  }
  db.traces.push(record)
  persist()
  return record
}

export function allTraces() {
  return load().traces
}

export function tracesByTarget(targetId) {
  return load().traces.filter((t) => t.target?.id === targetId)
}

/** 模型建议的校准曲线：模型建议的置信度 vs 用户最终的置信度 */
export function modelCalibration() {
  const db = load()
  const pairs = []
  for (const tr of db.traces) {
    if (tr.stage === 'extract' && tr.actor?.by === 'model'
        && tr.output?.confidence != null && tr.decision?.confidence != null) {
      pairs.push({
        nodeId: tr.target?.id,
        modelConf: tr.output.confidence,
        userConf: tr.decision.confidence,
        model: tr.actor?.model,
        promptVersion: tr.actor?.promptVersion,
        t: tr.t,
      })
    }
  }
  return pairs
}

/** 打标器 vs 表的分歧曲线：Jev 的 Score 和表值的差，按来源类型分开统计 */
export function labelerDivergence() {
  const db = load()
  const byKind = {}
  for (const tr of db.traces) {
    if (tr.stage === 'label' && tr.output?.quality != null && tr.decision?.quality != null) {
      const kind = tr.decision?.kind || '未知'
      if (!byKind[kind]) byKind[kind] = { kind, count: 0, diffs: [] }
      byKind[kind].count++
      byKind[kind].diffs.push(tr.output.quality - tr.decision.quality)
    }
  }
  return Object.values(byKind).map((g) => ({
    ...g,
    meanDiff: g.diffs.reduce((a, b) => a + b, 0) / g.diffs.length,
  }))
}
// ============================================================
// 通道描述符
// ============================================================

export function allChannels() {
  return load().channels
}

export function addChannel(ch) {
  const db = load()
  const channel = {
    id: uid(),
    name: ch.name || '未命名通道',
    kind: ch.kind || '自媒体',
    quality: ch.quality ?? SOURCE_QUALITY.find(([k]) => k === (ch.kind || '自媒体'))?.[1] ?? 0.5,
    fetch: ch.fetch || 'manual',
    query: ch.query || '',
    cadence: ch.cadence || '日',
    network: ch.network || 'direct',
    themeId: ch.themeId || null,
    metric: ch.metric || null,
    interval: Math.max(15, Number(ch.interval) || 60),
    lastFetch: ch.lastFetch || null,
    lastCount: ch.lastCount ?? null,
    lastOk: ch.lastOk ?? null,
    lastError: ch.lastError || null,
    tags: [...new Set((ch.tags || []).filter((t) => typeof t === 'string'))],
    failCount: ch.failCount ?? 0,
    review: ch.review === true,
    enabled: ch.enabled !== false,
    createdAt: today(),
  }
  db.channels.push(channel)
  persist()
  return channel
}

export function updateChannel(id, patch) {
  const db = load()
  const ch = db.channels.find((c) => c.id === id)
  if (!ch) return null
  Object.assign(ch, patch)
  persist()
  return ch
}

export function removeChannel(id) {
  const db = load()
  db.channels = db.channels.filter((c) => c.id !== id)
  // 清理节点上的悬空引用——不靠 UI 的 filter(Boolean) 兜底
  for (const n of db.nodes) {
    if (Array.isArray(n.channelIds) && n.channelIds.includes(id)) {
      n.channelIds = n.channelIds.filter((x) => x !== id)
    }
  }
  persist()
}
// ------------------------------------------------------------------ 读数层

/**
 * 读数：结构化财务数字（收入、库存、capex 等），只追加不覆盖。
 *
 * 去重键 = (metric, start, end, accn)。
 * 不能用 (metric, start, end)——10-K 会把上一年作比较期重列，
 * 同一期间会被两个 filing 重复申报。实例：
 *   2017-01-30 ~ 2018-01-28
 *      filed=2019-02-21  form=10-K  accn=0001045810-19-000010  val=9,714,000,000
 *      filed=2020-02-20  form=10-K  accn=0001045810-20-000036  val=9,714,000,000
 * 用 (metric, start, end) 会随机丢掉两条中的一条。
 *
 * frame 字段覆盖率只有 18/28，不能当键。
 */
export function addReading(input) {
  const db = load()
  const dedupeKey = input.dedupeKey
    || `${input.metric}|${input.source?.start || ''}|${input.source?.end || ''}|${input.source?.accn || ''}`
  if (db.readings.some((r) => r.dedupeKey === dedupeKey)) {
    return { added: false, dedupeKey }
  }
  const reading = {
    id: uid(),
    at: input.at || today(),
    asOf: input.asOf || null,

    nodeId: input.nodeId || null,
    metric: input.metric,
    value: input.value,
    unit: input.unit || null,
    source: input.source || {},
    basis: input.basis || 'reported',
    channelId: input.channelId || null,
    dedupeKey,
  }
  db.readings.push(reading)
  persist()
  return { added: true, reading }
}

export function allReadings() {
  return load().readings
}
/** 反查：某个读数属于哪些指标节点 */
export function indicatorsForReading(reading) {
  const db = load()
  const ch = db.channels.find((c) => c.id === reading.channelId)
  if (!ch) return []
  return db.nodes.filter((n) => (n.channelIds || []).includes(ch.id))
}

/** 取某通道产出的最新一条读数 */
export function latestReadingByChannel(channelId) {
  const db = load()
  const readings = db.readings.filter((r) => r.channelId === channelId)
  if (!readings.length) return null
  return readings.reduce((latest, r) =>
    (r.at || '') >= (latest.at || '') ? r : latest, readings[0])
}
// ------------------------------------------------------------------ 研究观点

/**
 * 研究观点：外部机构对某条命题的判断。
 * 不产生 node、不进 calibration()、不进 verdicts——是外部基准，不是你的判断。
 */
export function addResearchNote(input) {
  const db = load()
  const note = {
    id: uid(),
    at: input.at || today(),
    org: input.org || '',
    publishedAt: input.publishedAt || null,
    stance: input.stance || 'neutral',
    title: input.title || '',
    summary: input.summary || null,
    url: input.url || null,
    nodeId: input.nodeId || null,
    metric: input.metric || null,
    basis: input.basis || 'reported',
  }
  db.researchNotes.push(note)
  persist()
  return note
}

export function allResearchNotes() {
  return load().researchNotes
}

export function researchNotesByNode(nodeId) {
  return load().researchNotes.filter((n) => n.nodeId === nodeId)
}

/**
 * 计算机构观点命中率。纯函数。
 * 命题结算为「对」→ bullish 命中，bearish 未中，neutral 不计入
 * 结算为「错」→ bearish 命中，bullish 未中，neutral 不计入
 * @param {Array} notes 该命题挂的研究观点
 * @param {boolean|null} correct 结算结果
 * @returns {{ hits, total, rate }} total 不含 neutral
 */
export function researchHitRate(notes, correct) {
  const directional = (notes || []).filter((n) => n.stance === 'bullish' || n.stance === 'bearish')
  if (!directional.length || correct == null) return { hits: 0, total: 0, rate: null }
  const hits = directional.filter((n) =>
    correct ? n.stance === 'bullish' : n.stance === 'bearish').length
  return { hits, total: directional.length, rate: hits / directional.length }
}

/**
 * 你 vs 机构：近 N 天已结算命题的命中率对比。
 * @param {number} days 回看天数
 * @returns {{ userHits, userTotal, userRate, orgHits, orgTotal, orgRate, settledCount }}
 */
export function vsInstitution(days = 90) {
  const db = load()
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const settled = db.nodes.filter((n) =>
    n.kind === 'lemma' &&
    n.settlement?.resolved &&
    n.settlement?.correct != null &&
    (n.settlement.resolved || '') >= cutoff)

  let userHits = 0
  let orgHits = 0
  let orgTotal = 0

  for (const n of settled) {
    if (n.settlement.correct) userHits++
    const notes = db.researchNotes.filter((rn) => rn.nodeId === n.id)
    const directional = notes.filter((rn) => rn.stance === 'bullish' || rn.stance === 'bearish')
    for (const rn of directional) {
      orgTotal++
      if (n.settlement.correct ? rn.stance === 'bullish' : rn.stance === 'bearish') orgHits++
    }
  }

  return {
    userHits,
    userTotal: settled.length,
    userRate: settled.length ? userHits / settled.length : null,
    orgHits,
    orgTotal,
    orgRate: orgTotal ? orgHits / orgTotal : null,
    settledCount: settled.length,
  }
}
