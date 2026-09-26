import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { encrypt, decrypt, encryptSettings, decryptSettings } from './crypto.js'
import { __testHooks as llmHooks } from './llmlog.js'
import { ReadingStore, digest, normalizeName, observationKey, validateReading } from './reading-store.js'
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
  model: 'step-3.5-flash',
  hotkey: 'CommandOrControl+Shift+V',
  labeler: 'table', // table | jev —— 可替换的打标器
  jevBaseUrl: 'https://openrouter.ai/api/v1',
  jevModel: 'typesafe/jev-1.13',
  jevKey: '',
  // 产业链图的滚轮缩放灵敏度。触控板一次滚动连发多个小 deltaY，
  // 固定一档 10% 体感过快；给用户自己调。
  graphZoom: 1,
  // 数据源接入：绑哪、哪个端口、要不要凭据。曾经全写死——127.0.0.1 + 随机端口 +
  // 每次重启换 token，agent 在别的机器上连不到，在本机也没法配固定地址。
  agentHost: '127.0.0.1',
  agentPort: 0,          // 0 = 每次随机
  agentToken: true,      // 关闭仅允许本机绑定
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
  readings: [], // 仅接收旧文件迁移；正文独立存于 readings.jsonl
  sources: [], // 从读数观测出来的来源，不是配置项
  researchNotes: [], // 研究观点：外部机构对命题的判断，不产生 node、不进校准
  llmUsage: { daily: [], recent: [] }, // LLM 账本：按天聚合 + 最近失败明细
  traceAggregates: { label: [] }, // 留痕聚合：label 按天计数，extract/route 仍逐条（见文件末尾）
})

let db = null
let saveTimer = null
let readingStore = null

function readingsStore() {
  if (!readingStore) readingStore = new ReadingStore(app.getPath('userData'))
  return readingStore
}

function readingSnapshot() {
  const { readings, ...rest } = db
  // 迁移尚未全部成功时保留旧数组，避免一次 I/O 失败被 debounce 写盘吞掉未迁移项。
  return { ...rest, readings: readings || [], sources: allSources().map(({ readingIds, ...source }) => source) }
}

function migrateReadings(readings) {
  for (const r of readings) {
    if (readingsStore().refs.has(r.id)) continue
    if (r.hash || r.prevHash) throw new Error('带存证的读数缺少原始追加记录，已停止迁移')
    const source = { ...db.sources.find((s) => s.id === r.sourceId), ...r.source }
    const result = ingestReadingCore({ ...r, source }, { migration: true })
    if (result.error) throw new Error(`旧读数 ${r.id || ''} 迁移失败：${result.error}`)
  }
  db.readings = []
}

function normalizeScaffold(scaffold) {
  if (!scaffold || typeof scaffold !== 'object') return null
  const answer = Array.isArray(scaffold.answer)
    ? scaffold.answer.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : scaffold.answer ? [String(scaffold.answer).trim()].filter(Boolean) : []
  const indicators = Array.isArray(scaffold.indicators)
    ? scaffold.indicators
      .map((i) => typeof i === 'string'
        ? { name: i.trim(), cadence: '季度' }
        : { name: String(i?.name || '').trim(), cadence: String(i?.cadence || '季度') })
      .filter((i) => i.name)
    : []
  return {
    answer,
    indicators,
    falsifier: scaffold.falsifier ? String(scaffold.falsifier).trim() : null,
  }
}

function normalizeTagLibrary(tagLibrary) {
  return Array.isArray(tagLibrary) ? tagLibrary : []
}

/** LLM 账本：schema 只加不改，老数据没有就补空账本 */
function normalizeLlmUsage(llmUsage) {
  const u = llmUsage && typeof llmUsage === 'object' ? llmUsage : {}
  return {
    daily: Array.isArray(u.daily) ? u.daily : [],
    recent: Array.isArray(u.recent) ? u.recent : [],
  }
}

/**
 * 留痕聚合。label stage 的 trace 只被 labelerDivergence 消费（按 kind 的条数和分差均值），
 * 逐条存 input/output 全是浪费——3175 条里 1556 条 label 占了 2MB。
 * 改成按天一条计数。extract / route 仍逐条：前者是 findReuse 的复用来源，后者是归位判定链路。
 */
function normalizeTraceAggregates(ta) {
  const a = ta && typeof ta === 'object' ? ta : {}
  return { label: Array.isArray(a.label) ? a.label : [] }
}

/** 记一条 label 聚合。同一天同 kind 累加，分差存累计值（求均值时再除）。 */
export function recordLabelAggregate({ kind, tableQuality, modelQuality }) {
  const db = load()
  const t = today()
  let day = db.traceAggregates.label.find((d) => d.date === t)
  if (!day) {
    day = { date: t, byKind: {} }
    db.traceAggregates.label.push(day)
    // 只留最近 90 天——再老的聚合对「换打标器会不会漂移」没有意义
    if (db.traceAggregates.label.length > 90) db.traceAggregates.label.shift()
  }
  const k = kind || '未知'
  if (!day.byKind[k]) day.byKind[k] = { count: 0, diffSum: 0 }
  day.byKind[k].count += 1
  day.byKind[k].diffSum += (Number(modelQuality) || 0) - (Number(tableQuality) || 0)
  persist()
  return day
}

/** 收件箱条目超过这个天数还没人看过 → 清掉。ROADMAP 的边界：
 *  「用户从未看过、且 30 天未升级为命题的自动拦截——连裁决记录一起清掉。
 *   本地优先产品的数据文件是用户自己的负担。」 */
export const INBOX_TTL_DAYS = 30

/** 上一次启动时的清理结果，供 main.js 告知用户（静默删数据是这个产品最不能做的事） */
let lastPruneInfo = null
export const lastInboxPrune = () => lastPruneInfo

/**
 * 清掉过期没人看的待确认条目。返回 { removed, kept }。
 *
 * 保留（按重要性）：
 *   · status !== 'pending'  已处理的，是记录
 *   · ignored               你主动标记过的——「系统认为相关、人认为不相关」是误杀审计的原料
 *   · 30 天内的 pending      还没来得及看
 *
 * 清掉的只有「30 天以上、没人看过、没被主动忽略」的 pending。
 */
export function pruneInbox(days = INBOX_TTL_DAYS, { dryRun = false } = {}) {
  const d = load()
  const cutoff = Date.now() - days * 864e5
  const keep = (i) => {
    if (i.status !== 'pending') return true
    if (i.ignored) return true
    // 只读 createdAt——addInboxItem 永远写它，从没写过 at（那个分支是死的）
    const ts = Date.parse(i.createdAt || '')
    return Number.isFinite(ts) && ts >= cutoff
  }
  const removed = d.inbox.filter((i) => !keep(i)).length
  if (dryRun) return { removed, kept: d.inbox.length - removed }
  const before = d.inbox.length
  d.inbox = d.inbox.filter(keep)
  persist()
  return { removed: before - d.inbox.length, kept: d.inbox.length }
}

export function load() {
  if (db) return db
  const file = DATA_FILE()
  if (existsSync(file)) {
    try { db = JSON.parse(readFileSync(file, 'utf8')) } catch { db = blank() }
  } else db = blank()
  migrate(db)
  readingsStore()
  migrateReadings(db.readings)
  // 收件箱是队列不是档案——启动时清一次过期积压。放在 load 里而不是起定时器：
  // 天然一天一次，且没有「app 开着但没触发」的窗口。
  lastPruneInfo = pruneInbox()
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
  d.sources = Array.isArray(d.sources) ? d.sources : []
  d.researchNotes = d.researchNotes || []
  d.llmUsage = normalizeLlmUsage(d.llmUsage)
  d.traceAggregates = normalizeTraceAggregates(d.traceAggregates)
  for (const t of d.themes || []) {
    t.tags = Array.isArray(t.tags) ? t.tags : []
    t.tagLibrary = normalizeTagLibrary(t.tagLibrary)
  }
  for (const c of d.channels || []) {
    c.tags = Array.isArray(c.tags) ? c.tags : []
    c.failCount = c.failCount ?? 0
  }
  for (const n of d.nodes || []) {
    n.sources = Array.isArray(n.sources) ? n.sources : (n.source ? [n.source] : [])
    n.tags = Array.isArray(n.tags) ? n.tags : []
    n.tickers = Array.isArray(n.tickers) ? n.tickers : []
    n.status = n.status || 'live'
    n.scaffold = normalizeScaffold(n.scaffold)
    n.by = n.by || 'manual'
    n.stableId = n.stableId || n.id
    n.channelIds = Array.isArray(n.channelIds) ? n.channelIds : []
    n.indicatorIds = Array.isArray(n.indicatorIds) ? n.indicatorIds : []
    n.cadence = n.cadence ?? null
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
    writeFileSync(file, JSON.stringify(readingSnapshot(), null, 2))
  }, 120)
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
/** 本地日期。曾经用 toISOString()——那是 UTC，在 UTC+8 下每天有 8 小时算「明天」，
 *  用户晚上十一点记一笔，日期就跳到了明天，结算日和「今天」的比对都会错位一天。
 *  日期是给人看的，按用户所在的时区算。 */
const localDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export const today = () => localDate()
export const addDays = (n) => localDate(new Date(Date.now() + n * 864e5))

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
    scaffold: normalizeScaffold(input.scaffold),
    history: [{ t, confidence: clamp(input.confidence ?? 50), by: input.by || 'manual' }],
    by: input.by || 'manual',
    stableId: input.stableId || uid(),
    channelIds: [...new Set(input.channelIds || [])],
    indicatorIds: [...new Set(input.indicatorIds || [])],
    cadence: input.cadence ?? null,
    ...(input.measurement ? { measurement: { ...input.measurement } } : {}),
    createdAt: t,
    updatedAt: t,
    ...(input.intakeId ? { intakeId: input.intakeId } : {}),
  }
  db.nodes.push(node)
  promoteMatchingIgnoredRoutes(node)
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
  if (patch.indicatorIds !== undefined) node.indicatorIds = [...new Set(patch.indicatorIds)]
  if (patch.cadence !== undefined) node.cadence = patch.cadence
  if (patch.measurement !== undefined) node.measurement = patch.measurement ? { ...patch.measurement } : null
  node.updatedAt = today()
  if (patch.title !== undefined) promoteMatchingIgnoredRoutes(node)
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
  if (added) promoteMatchingIgnoredRoutes(node)
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
  const theme = { id: uid(), name: String(name || '').trim(), tags: [], tagLibrary: [], createdAt: today() }
  db.themes.push(theme)
  persist()
  return theme
}
/** 更新主题字段（支持 name / tags / tagLibrary） */
export function updateTheme(id, patch) {
  const theme = db.themes.find((t) => t.id === id)
  if (!theme) return null
  if (patch.name !== undefined) theme.name = String(patch.name).trim()
  if (patch.tags !== undefined) theme.tags = [...new Set((Array.isArray(patch.tags) ? patch.tags : []).filter((t) => typeof t === 'string'))]
  if (patch.tagLibrary !== undefined) theme.tagLibrary = normalizeTagLibrary(patch.tagLibrary)
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

// ------------------------------------------------------------------ 标签库


/** 标签库匹配纯函数：子串覆盖比例打分 */
export function matchTagLibrary(text, tagLibrary) {
  if (!tagLibrary?.length) return []
  const haystack = String(text || '').toLowerCase()
  return tagLibrary
    .map((tag) => {
      const terms = [tag.name, ...(tag.synonyms || [])]
      let hit = 0
      let total = 0
      for (const t of terms) {
        total++
        if (haystack.includes(String(t).toLowerCase())) hit++
      }
      const score = total ? hit / total : 0
      return { tagId: tag.id, name: tag.name, score: round1(score), terms: hit, total }
    })
    .filter((r) => r.score > 0 && r.terms >= 1)
    .sort((a, b) => b.score - a.score)
}

/** 跨主题匹配：返回所有主题的匹配结果 */
export function crossThemeMatch(text) {
  const db = load()
  const results = []
  for (const t of db.themes.filter((t) => !t.deletedAt)) {
    for (const m of matchTagLibrary(text, t.tagLibrary || [])) {
      results.push({ themeId: t.id, themeName: t.name, ...m })
    }
  }
  return results.sort((a, b) => b.score - a.score)
}

/** 命中回写：hits++ / lastHitAt = today() */
export function recordTagHits(themeId, tagIds) {
  const theme = db.themes.find((t) => t.id === themeId)
  if (!theme) return
  const now = today()
  for (const tag of theme.tagLibrary || []) {
    if (tagIds.includes(tag.id)) {
      tag.hits = (tag.hits || 0) + 1
      tag.lastHitAt = now
    }
  }
  persist()
}

/** 更新标签库中单个标签 */
export function updateTagLibraryTag(themeId, tagId, patch) {
  const theme = db.themes.find((t) => t.id === themeId)
  if (!theme) return null
  const tag = (theme.tagLibrary || []).find((t) => t.id === tagId)
  if (!tag) return null
  if (patch.name !== undefined) tag.name = String(patch.name).trim().slice(0, 30)
  if (patch.synonyms !== undefined) tag.synonyms = patch.synonyms.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 10)
  if (patch.threshold !== undefined) tag.threshold = Math.max(0.4, Math.min(0.85, Number(patch.threshold) || 0.6))
  persist()
  return tag
}

/** 批量删除标签库中的标签 */
export function deleteTagLibraryTags(themeId, tagIds) {
  const theme = db.themes.find((t) => t.id === themeId)
  if (!theme) return 0
  const before = theme.tagLibrary.length
  theme.tagLibrary = theme.tagLibrary.filter((t) => !tagIds.includes(t.id))
  persist()
  return before - theme.tagLibrary.length
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
    ...(v.textHash ? { textHash: v.textHash } : {}),
  }
  db.verdicts.push(verdict)
  persist()
  return verdict
}

export function allVerdicts() { return load().verdicts }

// ------------------------------------------------------------------ LLM 账本

const LLM_RECENT_LIMIT = 50

/**
 * 记一次 LLM 调用。按天聚合、失败明细只留最近 50 条。
 * 每条调用存一行会把 meridian.json 撑爆——那个文件每次 persist() 全量重写。
 */
export function recordLlmUsage(scenario, info = {}) {
  const u = load().llmUsage
  const date = today()
  let day = u.daily.find((d) => d.date === date)
  if (!day) {
    day = { date, calls: 0, failed: 0, degraded: 0, tokens: 0, byScenario: {}, byChannel: {} }
    u.daily.push(day)
  }
  day.calls++
  if (!info.ok) day.failed++
  if (info.degraded) day.degraded++
  day.tokens += Math.max(0, Math.round(Number(info.tokens) || 0))
  day.byScenario[scenario] = (day.byScenario[scenario] || 0) + 1
  if (info.channelId) day.byChannel[info.channelId] = (day.byChannel[info.channelId] || 0) + 1
  if (!info.ok) {
    u.recent.unshift({
      at: new Date().toISOString(),
      scenario,
      error: info.error || 'failed',
      latency: Math.round(Number(info.latency) || 0),
      themeId: info.themeId || null,
      channelId: info.channelId || null,
    })
    if (u.recent.length > LLM_RECENT_LIMIT) u.recent.length = LLM_RECENT_LIMIT
  }
  persist()
  return day
}

export function llmUsage() {
  return load().llmUsage
}

// llmlog.tracked 的落库接口：模块级注入，避免 llmlog → store 的循环依赖
llmHooks.track = (scenario, info) => recordLlmUsage(scenario, info)

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

/** 用户忽略的归位建议单独回查，不改变自动过滤 verdict 的语义。由节点写入方持久化。 */
function promoteMatchingIgnoredRoutes(node) {
  if (node.kind !== 'lemma' || node.status === 'dead' || !node.themeId || !String(node.title || '').trim() || ['未命名命题', '新命题'].includes(node.title)) return
  const norm = (s) => String(s || '').trim().toLowerCase()
  const nodeTokens = new Set(tokenize(node.title))
  const matches = (text) => {
    if (!norm(text)) return false
    if (norm(text) === norm(node.title)) return true
    const tokens = tokenize(text)
    if (!tokens.length || !nodeTokens.size) return false
    let hit = 0
    for (const t of nodeTokens) if (tokens.includes(t)) hit += t.length >= 2 ? 2 : 1
    const denom = tokens.reduce((sum, t) => sum + (t.length >= 2 ? 2 : 1), 0)
    return denom > 0 && hit / denom >= 0.6
  }
  for (const proposal of ignoredInbox()) {
    if (proposal.promotedTo != null || proposal.matchedTheme?.id !== node.themeId) continue
    const texts = [...(proposal.lemmas || []).map((l) => l.title), proposal.text, proposal.title]
    if (!texts.some(matches)) continue
    proposal.promotedTo = node.id
    proposal.promotedAt = today()
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

export function allConflicts() {
  load()
  const conflicts = new Map(db.conflicts.map((c) => [c.id, c]))
  for (const [id, c] of readingsStore().conflicts) conflicts.set(id, { ...c })
  return [...conflicts.values()]
}

export function resolveConflict(id, verdict) {
  const c = allConflicts().find((x) => x.id === id)
  if (!c || !['a', 'b', 'both'].includes(verdict)) return null
  if (c.type === 'reading') return resolveReadingConflict(c, verdict)
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
  const verdicts = allVerdicts()
  const recent = verdicts.filter((v) => Date.parse(v.at) >= cutoff)
  const killed = recent.filter((v) => v.promotedTo)
  const group = (records, key) => {
    const missed = records.filter((r) => r.promotedTo).length
    return {
      total: records.length, missed, rate: records.length ? missed / records.length : 0,
      items: records.map((r) => ({ [key]: r, node: getNode(r.promotedTo) })),
    }
  }
  const gates = ['source', 'dedup', 'user']
  const byGate = Object.fromEntries(gates.map((gate) => [gate, group(recent.filter((v) => v.gate === gate), 'verdict')]))
  byGate.other = group(recent.filter((v) => !gates.includes(v.gate)), 'verdict')
  byGate.routeIgnored = group(ignoredInbox().filter((p) => Date.parse(p.ignoredAt) >= cutoff), 'proposal')
  return {
    window: days,
    allTotal: verdicts.length,
    total: recent.length,
    missed: killed.length,
    rate: recent.length ? killed.length / recent.length : 0,
    items: killed.map((v) => ({ verdict: v, node: getNode(v.promotedTo) })),
    byGate,
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
    conflicts: allConflicts().filter((c) => !c.resolved).length,
    premises: sharedPremises().length,
    feeds: db.channels.filter((c) => c.enabled).length,
    inbox: inboxCount(),
    readings: readingsStore().refs.size,
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
  for (const r of readingsStore().refs.values()) if (r.rawId) used.add(r.rawId)
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
  load()
  const out = { ...db, version: 4, readingFormat: 'meridian.reading.v1', sources: allSources(), readings: allReadings(), readingJournal: readingsStore().exportJournal() }
  if (withRaw) out.raw = [...loadRaw().values()]
  return JSON.stringify(out, null, 2)
}

export function importAll(json) {
  const parsed = JSON.parse(json)
  if (!parsed || !Array.isArray(parsed.nodes)) throw new Error('不是有效的脉络数据文件')
  if ((parsed.readingFormat || (parsed.readings || []).some((r) => r.hash || r.prevHash)) && !Array.isArray(parsed.readingJournal)) {
    throw new Error('带存证的读数必须附完整追加记录，不能按旧数据重新签名')
  }
  // 新导出保留事实和裁决事件；显式导入替换当前视图，原账本只改名归档。
  if (parsed.readingJournal) readingsStore().validateJournal(parsed.readingJournal)
  else for (const r of parsed.readings || []) validateReading({ ...r, source: r.source || (parsed.sources || []).find((s) => s.id === r.sourceId) || {} }, { legacy: true })
  readingsStore().replaceJournal(parsed.readingJournal || [])
  db = { version: 4, settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }, themes: parsed.themes || [], nodes: parsed.nodes, verdicts: parsed.verdicts || [], conflicts: parsed.conflicts || [], feeds: parsed.feeds || [], inbox: parsed.inbox || [], traces: parsed.traces || [], channels: parsed.channels || [], intakeEvents: parsed.intakeEvents || [], sources: parsed.sources || [], readings: parsed.readings || [], researchNotes: parsed.researchNotes || [], llmUsage: normalizeLlmUsage(parsed.llmUsage), traceAggregates: normalizeTraceAggregates(parsed.traceAggregates) }
  migrate(db)
  if (!parsed.readingJournal) migrateReadings(db.readings)
  else db.readings = []
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
/** 未匹配（没花过钱）的内容超过 30 天自动过期 */
const UNMATCHED_TTL_DAYS = 30

function isExpiredUnmatched(i) {
  if (i.extracted !== false || i.matchScore > 0) return false
  const age = (Date.now() - Date.parse(i.createdAt || today())) / 864e5
  return age > UNMATCHED_TTL_DAYS
}

export function allInbox() {
  return load().inbox.filter((i) => i.status === 'pending' && !i.ignored && !isExpiredUnmatched(i))
}

export function ignoredInbox() {
  return load().inbox.filter((i) => i.kind === 'route-proposal' && i.ignored)
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
    // 三态由此推导，不存状态字符串：抽了 / 待抽取（弱匹配）/ 未匹配
    extracted: item.extracted !== false,
    matchScore: Number(item.matchScore) || 0,
    ...(item.skipped ? { skipped: item.skipped } : {}),
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.matchedTheme ? { matchedTheme: item.matchedTheme } : {}),
    ...(item.matchedTags ? { matchedTags: item.matchedTags } : {}),
    ...(item.originChannel !== undefined ? { originChannel: item.originChannel } : {}),
    ...(item.bestScore != null ? { bestScore: item.bestScore } : {}),
    // 读数型待办：四个来源共用收件箱后，待归位的读数也走这道门
    ...(item.readingId ? { readingId: item.readingId } : {}),
    ...(item.observationId ? { observationId: item.observationId } : {}),
    ...(item.reading ? { reading: item.reading } : {}),
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
  if (action !== 'accept' && action !== 'reject') return item
  if (action === 'reject' && item.kind === 'route-proposal') {
    if (item.ignored) return item
    item.ignored = true
    item.ignoredAt = item.ignoredAt || today()
  } else {
    if (item.status !== 'pending') return item
    item.status = action === 'accept' ? 'accepted' : 'rejected'
    item.resolvedAt = today()
    if (action === 'reject') {
      addVerdict({
        gate: 'user', reason: 'rejected', summary: item.title,
        score: item.label?.quality || 0, choice: item.label?.kind || '未知',
      })
    }
  }
  persist()
  return item
}

/**
 * 清收件箱。onlyUnextracted: true 时只清「没花过钱」的未抽取条目——
 * 已抽取的仍在等人裁决，批量清掉会丢内容。
 */
export function clearInbox({ onlyUnextracted = false } = {}) {
  const db = load()
  const before = db.inbox.length
  if (onlyUnextracted) {
    db.inbox = db.inbox.filter((i) => i.extracted !== false || i.ignored)
  } else {
    db.inbox = db.inbox.filter((i) => i.status === 'pending' || i.ignored)
  }
  persist()
  return before - db.inbox.length
}

/** 用户主动点「抽取这 N 条」后，把抽取结果写回条目 */
export function setInboxExtraction(id, { extracted, matchScore, lemmas }) {
  const item = load().inbox.find((i) => i.id === id)
  if (!item) return null
  item.extracted = extracted !== false
  if (matchScore != null) item.matchScore = Number(matchScore) || 0
  if (Array.isArray(lemmas)) item.lemmas = lemmas
  persist()
  return item
}

/** 通道未匹配率：近 N 天该通道进收件箱的条目里，多少条没被抽取（低质 / 未命中标签库 / 未达阈值） */
export function channelMatchRates(days = 30) {
  const since = Date.parse(today()) - days * 864e5
  const byChannel = new Map()
  for (const i of load().inbox) {
    const channelId = i.provenance?.channelId
    if (!channelId) continue
    if (Date.parse(i.createdAt || today()) < since) continue
    if (!byChannel.has(channelId)) byChannel.set(channelId, { channelId, total: 0, unmatched: 0 })
    const row = byChannel.get(channelId)
    row.total++
    if (i.extracted === false) row.unmatched++
  }
  return [...byChannel.values()].map((r) => ({ ...r, rate: r.total ? r.unmatched / r.total : 0 }))
}

export function inboxCount() {
  return allInbox().length
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
  const cutoff = localDate(new Date(Date.now() - sinceDays * 864e5))
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

/** extract trace 的上限。依据：一天 300 次捕获 × 7 天 = 2100，够覆盖一周的复用窗口，
 *  再老的内容被 findReuse 命中到的概率极低，而无限长会让索引和文件一起涨。 */
export const MAX_EXTRACT_TRACES = 2000

/** textHash → 最新 trace 的内存索引。findReuse 用它把 O(n) 扫降成 O(1)。
 *  内存态不进 DB——重启重建，成本 O(n) 一次。 */
let traceIndex = null

export function traceIndexByHash() {
  if (traceIndex) return traceIndex
  traceIndex = new Map()
  for (const t of load().traces) {
    const h = t.input?.textHash
    if (h) traceIndex.set(h, t)   // 后写的覆盖先写的，天然「最新优先」
  }
  return traceIndex
}

export function invalidateTraceIndex() { traceIndex = null }

export function addTrace(trace) {
  const db = load()
  const record = {
    id: uid(),
    t: today(),
    ...trace,
  }
  db.traces.push(record)
  // extract trace 只留最近的——老的复用价值趋零，但会让文件和索引一起涨
  if (record.stage === 'extract') {
    const extracts = db.traces.filter((t) => t.stage === 'extract')
    if (extracts.length > MAX_EXTRACT_TRACES) {
      const drop = new Set(extracts.slice(0, extracts.length - MAX_EXTRACT_TRACES).map((t) => t.id))
      db.traces = db.traces.filter((t) => !drop.has(t.id))
    }
  }
  // 写入同步索引，否则要等下次启动才能复用
  const h = record.input?.textHash
  if (h) {
    if (!traceIndex) traceIndexByHash()
    traceIndex.set(h, record)
  }
  persist()
  return record
}

export function allTraces() {
  // 读数留痕来自独立账本，只展示最近 100 条，不逐条写回 meridian.json。
  const traces = load().traces
  return [...traces, ...JSON.parse(JSON.stringify([...readingsStore().recentTraces.values()]))]
}

export function tracesByTarget(targetId) {
  return allTraces().filter((t) => t.target?.id === targetId)
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
/** 打标器 vs 表的分歧曲线：Jev 的 Score 和表值的差，按来源类型分开统计。
 *  读的是按天聚合（traceAggregates.label），不再逐条扫 traces——
 *  聚合前后的 count 和 meanDiff 必须一致，否则这条曲线的基准就漂了。 */
export function labelerDivergence() {
  const db = load()
  const byKind = {}
  for (const day of db.traceAggregates.label) {
    for (const [kind, g] of Object.entries(day.byKind || {})) {
      if (!byKind[kind]) byKind[kind] = { kind, count: 0, diffSum: 0 }
      byKind[kind].count += g.count
      byKind[kind].diffSum += g.diffSum
    }
  }
  return Object.values(byKind).map((g) => ({
    kind: g.kind,
    count: g.count,
    meanDiff: g.count ? g.diffSum / g.count : 0,
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

/** 同步兼容入口：与批量摄入共享归一、去重、冲突、留痕、落库核心。
 * 去重包含完整期间/单位/口径/来源出处/accn/值；忽略调用方自报的 dedupeKey。
 * 事实只追加，状态/信任/归位/裁决进入独立事件；不自动裁定命题。 */
export function addReading(input) {
  return ingestReadingCore(input)
}

/** 人话优先；精确、规范化、标签库各级都只接受唯一匹配。 */
export function matchReadingIndicator(input, { trusted = false, channelId = null, migration = false } = {}) {
  const d = load()
  const nodes = d.nodes.filter((n) => n.type === 'observation' && n.status !== 'dead')
  const hint = normalizeName(input.themeHint)
  const scoped = hint ? nodes.filter((n) => d.themes.some((t) => t.id === n.themeId && (t.id === input.themeHint || normalizeName(t.name) === hint))) : nodes
  if (input.indicator) {
    const exact = scoped.filter((n) => n.title === input.indicator)
    if (exact.length) return exact.length === 1 ? exact[0].id : null
    const name = normalizeName(input.indicator)
    const normalized = scoped.filter((n) => normalizeName(n.title) === name)
    if (normalized.length) return normalized.length === 1 ? normalized[0].id : null
    const matches = scoped.filter((n) => {
      const theme = d.themes.find((t) => t.id === n.themeId)
      return (theme?.tagLibrary || []).some((tag) => [tag.name, ...(tag.synonyms || [])].some((s) => normalizeName(s) === name) && ((n.tags || []).includes(tag.name) || (n.tags || []).includes(tag.id) || normalizeName(n.title) === normalizeName(tag.name)))
    })
    if (matches.length) return matches.length === 1 ? matches[0].id : null
    if (!trusted) return null
  }
  // 此同步接口也被 IPC 使用，channelId/tier 本身绝不是可信证明。
  // 兼容内部关联，但 structured 权重只由不来自 envelope 的 trusted 参数授权。
  if (trusted || migration || input.nodeId || input.indicatorId) {
    const direct = nodes.find((n) => n.id === (input.indicatorId || input.nodeId))
    if (direct) return direct.id
  }
  const channel = channelId || input.channelId
  const matches = nodes.filter((n) => (channel && (n.channelIds || []).includes(channel)) || (trusted && input.metric && n.metric === input.metric))
  return matches.length === 1 ? matches[0].id : null
}

function sourceIdentity(source, trusted, channelId) {
  let host = ''
  try { host = new URL(source.url).hostname.toLowerCase().replace(/^www\./, '') } catch { /* 旧离线来源 */ }
  const identity = host || normalizeName(source.platform || source.label) || 'unknown'
  const independentKey = identity !== 'unknown' ? `origin:${identity}` : 'unknown'
  return { id: `src:${digest(identity)}`, identity, independentKey }
}

function independentSources(readings) {
  const parent = readings.map((_, i) => i)
  const owners = new Map()
  const root = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  readings.forEach((r, i) => {
    const source = r.source || readingsStore().get(r.id)?.source || {}
    const keys = []
    try { keys.push(`host:${new URL(source.url).hostname.toLowerCase().replace(/^www\./, '')}`) } catch {}
    const platform = normalizeName(source.platform)
    if (platform) keys.push(`platform:${platform}`)
    if (r.rawId) keys.push(`raw:${r.rawId}`)
    if (!keys.length) keys.push('unknown')
    for (const key of keys) {
      if (owners.has(key)) parent[root(i)] = root(owners.get(key))
      else owners.set(key, i)
    }
  })
  return Math.max(1, new Set(parent.map((_, i) => root(i))).size)
}

function trustFor(r, crossCount, flags) {
  const base = r.effectiveTier === 'structured' ? 1 : r.effectiveTier === 'local-llm' ? 0.7 : 0.4
  const penalty = (flags.includes('jump') ? 0.1 : 0) + (flags.includes('sum-violation') ? 0.3 : 0) + (flags.includes('contradicted') ? 0.5 : 0)
  // 公式本身就是那道线：base 上限 1.0，所以单一来源最多 0.6——想更高必须有第二个独立来源。
  // 不需要额外的佐证上限，加了也是死代码（base > 1 才可能触发）。
  let score = Math.max(0, Math.min(1, base * (0.6 + 0.4 * Math.min(1, (crossCount - 1) * 0.25)) - penalty))
  if (flags.includes('review-required')) score = Math.min(score, 0.24)
  if (flags.includes('legacy-invalid-value')) score = 0
  return { score, crossCount, flags: [...new Set(flags)] }
}

/** 只在同期间、同单位、同口径的证据组内比较。状态变化只进入事件。 */
function projectReadings(rs, extraFlags = new Map()) {
  const active = rs.filter((r) => !['superseded', 'rejected'].includes(r.status))
  const byValue = new Map()
  for (const r of active) {
    if (!byValue.has(r.value)) byValue.set(r.value, [])
    byValue.get(r.value).push(r)
  }
  const counts = new Map([...byValue].map(([value, rows]) => [value, independentSources(rows)]))
  const conflict = byValue.size > 1
  const patches = rs.map((r) => {
    const flags = [...(r.trust?.flags || []).filter((f) => f !== 'conflict'), ...(extraFlags.get(r.id) || [])]
    const live = active.includes(r)
    if (conflict && live) flags.push('conflict')
    const crossCount = counts.get(r.value) || 1
    return { id: r.id, indicatorId: r.indicatorId, status: live ? (conflict || flags.includes('sum-violation') ? 'conflicted' : 'current') : r.status, trust: trustFor(r, crossCount, flags) }
  })
  const conflicts = []
  if (conflict) {
    const a = active[0]
    for (const b of active.slice(1)) if (a.value !== b.value) {
      const id = `rc:${digest([observationKey(a), ...[a.id, b.id].sort()])}`
      const prior = readingsStore().conflicts.get(id)
      conflicts.push({ id, type: 'reading', observationId: observationKey(a), readingA: a.id, readingB: b.id, a: a.id, b: b.id, note: '同期间读数不一致，等待人工裁决', at: today(), resolved: prior?.resolved || null, ...(prior?.resolvedAt ? { resolvedAt: prior.resolvedAt } : {}) })
    }
  }
  return { patches, conflicts }
}

function consistencyFlags(fact) {
  const s = readingsStore()
  const flags = []
  const series = s.series.get(JSON.stringify([fact.indicatorId || fact.chainKey, fact.unit, fact.basis])) || []
  let low = 0, high = series.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (s.groups.get(series[mid]).period.end < fact.period.end) low = mid + 1
    else high = mid
  }
  const earlier = series.slice(Math.max(0, low - 5), low).map((key) => s.groups.get(key)).filter((g) => g.value != null && g.status === 'current')
  if (earlier.length >= 4) {
    const duration = (p) => Date.parse(p.end) - Date.parse(p.start)
    const comparable = earlier.every((g) => Math.abs(duration(g.period) - duration(fact.period)) <= 7 * 864e5)
    const changes = earlier.slice(1).map((g, i) => earlier[i].value ? Math.abs((g.value - earlier[i].value) / earlier[i].value) : Infinity)
    const last = earlier[earlier.length - 1]
    if (comparable && changes.every((x) => x <= 0.1) && last.value && Math.abs((fact.value - last.value) / last.value) > 0.4) flags.push('jump')
  }
  return flags
}

/** 显式范围元数据才检查加和；父子位置本身不证明可加（收入和毛利也可为父子）。 */
function projectSumScope(fact, projection, incoming = []) {
  if (!fact.indicatorId) return projection
  const node = getNode(fact.indicatorId)
  const parent = node?.measurement?.role === 'total' ? node : getNode(node?.parentId)
  if (parent?.type !== 'observation' || parent.measurement?.role !== 'total' || !parent.measurement.scope) return projection
  const children = childrenOf(parent.id).filter((n) => n.type === 'observation' && n.measurement?.role === 'component' && n.measurement.scope === parent.measurement.scope)
  if (!children.length || (node.id !== parent.id && !children.some((n) => n.id === node.id))) return projection
  const s = readingsStore()
  const patches = new Map(projection.patches.map((p) => [p.id, p]))
  const conflicts = new Map(projection.conflicts.map((c) => [c.id, c]))
  const rows = []
  const scopeKeys = new Set()
  for (const member of [parent, ...children]) {
    const key = observationKey({ ...fact, indicatorId: member.id })
    scopeKeys.add(key)
    const entries = new Map(s.groupReadings(key).map((r) => [r.id, r]))
    for (const r of incoming) if (observationKey(r) === key) entries.set(r.id, r)
    const clean = [...entries.values()].map((r) => {
      const row = { ...r, ...patches.get(r.id) }
      return { ...row, trust: { ...row.trust, flags: row.trust.flags.filter((f) => f !== 'sum-violation') } }
    })
    const p = projectReadings(clean)
    for (const patch of p.patches) patches.set(patch.id, patch)
    for (const conflict of p.conflicts) conflicts.set(conflict.id, conflict)
    const live = clean.filter((r) => !['superseded', 'rejected'].includes(r.status))
    rows.push(new Set(live.map((r) => r.value)).size === 1 ? live : [])
  }
  const representatives = rows.map((group) => group.at(-1))
  const [total, ...components] = representatives
  const sum = components.reduce((n, r) => n + (r?.value || 0), 0)
  const invalid = total && components.every(Boolean) && representatives.every((r) => r.value >= 0)
    && sum > total.value + Math.max(1, Math.abs(total.value)) * 1e-9
  let activeId = null
  if (invalid) {
    const ids = rows.flat().map((r) => r.id)
    activeId = `rc:${digest(['sum', ...representatives.map((r) => r.id)])}`
    for (const id of ids) {
      const patch = patches.get(id)
      const r = incoming.find((r) => r.id === id) || s.refs.get(id)
      patches.set(id, { ...patch, status: 'conflicted', trust: trustFor(r, patch.trust.crossCount, [...patch.trust.flags, 'sum-violation']) })
    }
    conflicts.set(activeId, {
      id: activeId, type: 'reading', readingA: total.id, readingB: components[0].id, a: total.id, b: components[0].id,
      readingIds: ids, totalIds: rows[0].map((r) => r.id), componentIds: rows.slice(1).flat().map((r) => r.id),
      note: `同范围总计 ${total.value}，分部之和 ${sum}，两者不一致`, at: today(), resolved: null, reason: 'sum-violation',
      comparison: { total: total.value, sum, unit: total.unit },
    })
  }
  for (const c of s.conflicts.values()) {
    if (c.reason !== 'sum-violation' || c.resolved || c.id === activeId) continue
    const a = s.refs.get(c.readingA || c.a)
    if (a && scopeKeys.has(observationKey(a))) conflicts.set(c.id, { ...c, resolved: 'both', resolvedAt: today(), obsolete: 'recomputed' })
  }
  return { patches: [...patches.values()], conflicts: [...conflicts.values()] }
}

/** trusted 是本地调用上下文，绝不从 input 读取；外部适配器只使用默认 false。 */
export function ingestReadingCore(input, { trusted = false, channelId = null, migration = false } = {}) {
  load()
  try {
    const period = input?.period || { start: input?.source?.start || input?.asOf || input?.source?.end, end: input?.source?.end || input?.asOf }
    const normalized = validateReading({ ...input, ...(migration ? {} : { period }) }, { legacy: migration })
    if (migration) normalized.source = { ...input.source, ...normalized.source }
    const s = readingsStore()
    const indicatorId = matchReadingIndicator({ ...normalized, themeHint: input.themeHint, indicatorId: input.indicatorId, nodeId: input.nodeId, channelId: input.channelId }, { trusted, channelId, migration })
    const chainKey = indicatorId || `pending:${digest([normalizeName(normalized.indicator || normalized.metric || 'unknown'), normalizeName(input.themeHint)])}`
    const identity = sourceIdentity(normalized.source, trusted, channelId || input.channelId)
    const sourceId = migration && input.sourceId ? input.sourceId : identity.id
    const source = { ...normalized.source, id: sourceId, identity: identity.identity, at: input.at || new Date().toISOString(), independentKey: identity.independentKey }
    const dedupeKey = digest([chainKey, normalized.period, normalized.unit, normalized.basis, sourceId, normalized.source.url, normalized.source.accn, normalized.value])
    if (s.dedupe.has(dedupeKey) && !migration) return { added: false, dedupeKey }
    const old = s.groupReadings(observationKey({ ...normalized, indicatorId, chainKey }))
    const superseded = old.filter((r) => !['superseded', 'rejected'].includes(r.status) && r.sourceId === sourceId && identity.identity !== 'unknown' && normalized.source.accn && r.accn === normalized.source.accn && r.value !== normalized.value)
    const rawId = normalized.raw ? appendRaw({ kind: source.kind, label: source.label, text: normalized.raw, channel: { url: source.url, platform: source.platform } }).id : migration ? input.rawId || input.source?.rawId || null : null
    const flags = []
    if ((QUALITY.get(source.kind) || 0) < 0.6 || !source.url) flags.push('review-required')
    if (normalized.legacyInvalidValue) flags.push('legacy-invalid-value')
    const { raw, ...fields } = normalized
    // 自报的 tier 作为先验采信。曾经这里一律压成 'agent'，等于宣布外部数据永远不可信——
    // 结果是 agent 喂进来的结构化数据天花板只有 0.4，信任分失去区分度。
    // 真正的约束在 trustFor 的佐证上限：没有第二个独立来源，谁都到不了 0.6 以上。
    const effectiveTier = normalized.tier
    const fact = s.makeFact({
      ...fields, ...(migration && input.id ? { id: input.id } : {}),
      at: migration && input.at ? input.at : new Date().toISOString(),
      indicatorId, nodeId: indicatorId || (typeof input.nodeId === 'string' ? input.nodeId : null), channelId: channelId || input.channelId || null,
      chainKey, sourceId, independentKey: identity.independentKey, accn: source.accn,
      effectiveTier,
      asOf: normalized.period.end, rawId, dedupeKey,
      supersedes: superseded[superseded.length - 1]?.id || null,
      status: normalized.legacyInvalidValue ? 'rejected' : 'current', trust: trustFor({ effectiveTier }, 1, flags),
    })
    const rs = [...old.map((r) => superseded.includes(r) ? { ...r, status: 'superseded' } : r), fact]
    const projection = projectSumScope(fact, projectReadings(rs, new Map([[fact.id, consistencyFlags(fact)]])), rs)
    const reading = s.commit({ fact, source, event: { kind: 'ingest', ...projection, trace: { matched: !!indicatorId, channelId: fact.channelId, quality: QUALITY.get(source.kind) || 0, effectiveTier: fact.effectiveTier } } })
    persist()
    // 闸门：需要人做决定的才进收件箱。干净且匹配上指标的直接入账，不打扰——
    // 收件箱是裁决台，不是监控台，否则 agent 一次推一千条能把它埋了。
    // 冲突另走冲突队列（今日页已有），这里只收「没地方放」的待归位读数。
    if (!migration && !indicatorId) queuePendingReading(reading)
    return { added: true, reading, dedupeKey }
  } catch (error) { return { added: false, error: error.message } }
}

/**
 * 待归位的读数进收件箱——三个来源（手贴 / agent 推送 / HTTP+ MCP）
 * 从此共用一个门。曾经只有捕获走这道门，agent 推来的读数直接入库，
 * 用户在路上永远看不到它们，也就永远等不到归位。
 */
function queuePendingReading(reading) {
  const existing = db.inbox.find((i) => i.kind === 'reading' && i.readingId === reading.id)
  if (existing) return existing
  const item = addInboxItem({
    kind: 'reading',
    readingId: reading.id,
    observationId: reading.observationId || null,
    title: reading.indicator || reading.metric || '未命名读数',
    text: reading.indicator || reading.metric || '',
    label: { kind: reading.source?.kind || '来源未分类', quality: 0, via: 'reading' },
    lemmas: [], extracted: true, matchScore: 0,
    provenance: { platform: reading.source?.platform || null, url: reading.source?.url || null, rawId: reading.rawId || null },
  })
  item.reading = { value: reading.value, unit: reading.unit, period: reading.period, basis: reading.basis, tier: reading.tier, status: reading.status, trust: reading.trust }
  persist()
  return item
}

export function allReadings() { load(); return readingsStore().all() }
export function getReading(id) { load(); return readingsStore().get(id) }
export function readingsPage(options = {}) {
  load()
  const page = readingsStore().page(options)
  page.items = page.items.map((r) => ({ ...r, title: getNode(r.indicatorId)?.title || readingsStore().refs.get(readingsStore().groups.get(r.id)?.ids[0])?.indicator || '待归位' }))
  return page
}

function judgmentsFor(indicatorIds) {
  const ids = new Set(indicatorIds.filter(Boolean))
  const channels = new Set(db.nodes.filter((n) => ids.has(n.id)).flatMap((n) => n.channelIds || []))
  return db.nodes.filter((n) => n.kind === 'lemma' && n.type !== 'observation' && n.status !== 'dead' && ((n.indicatorIds || []).some((id) => ids.has(id)) || (n.channelIds || []).some((id) => channels.has(id)) || db.nodes.some((i) => ids.has(i.id) && i.parentId === n.id)))
}

export function readingEvidence(options = {}) {
  load()
  const result = readingsStore().evidence(options)
  const group = readingsStore().groups.get(options.observationId)
  const ids = options.indicatorId ? [options.indicatorId] : group ? [group.indicatorId] : result.items.map((r) => r.indicatorId)
  return { ...result, judgments: judgmentsFor(ids).map((n) => ({ id: n.id, title: n.title, claim: n.title, confidence: n.confidence, settlesOn: n.settlement?.date || null, resolved: n.settlement?.resolved ?? null })) }
}

export function latestReadings() {
  load()
  const s = readingsStore()
  const items = [...s.latest.entries()].map(([key, groupKey]) => {
    const g = s.groups.get(groupKey)
    const reading = s.get(g.currentReadingId || g.ids[g.ids.length - 1])
    return {
      ...reading, indicatorId: g.indicatorId, nodeId: g.indicatorId, pending: g.pending,
      title: getNode(g.indicatorId)?.title || reading.indicator || reading.metric || '待归位',
      value: g.value, values: g.values || null, trust: { ...g.trust, flags: [...g.trust.flags] },
      status: g.status, currentReadingId: g.currentReadingId, observationId: groupKey,
    }
  })
  // 待归位的排后面——已归位的才是树的主体，待归位是待办
  items.sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || (b.period?.end || '').localeCompare(a.period?.end || ''))
  return { items, total: items.length, pending: items.filter((r) => r.pending).length }
}

export function allSources(options) {
  load()
  const sources = new Map((db.sources || []).map((s) => [s.id, s]))
  for (const [id, source] of readingsStore().sources) {
    const { scoreSum, ...publicSource } = source
    sources.set(id, { ...publicSource, readingIdsTruncated: source.pushCount > (source.readingIds?.length || 0) })
  }
  const items = [...sources.values()].map((s) => JSON.parse(JSON.stringify(s)))
  return options ? readingsStore().paginate(items, options).items : items
}
export function sourcesPage(options = {}) { return readingsStore().paginate(allSources(), options) }
export function verifyReadingChain(key) { load(); return readingsStore().verify(key) }

export function assignReading(id, indicatorId) {
  load()
  const s = readingsStore()
  const r = s.refs.get(id)
  if (!r || !db.nodes.some((n) => n.id === indicatorId && n.type === 'observation' && n.status !== 'dead')) return { ok: false, error: '读数或指标不存在' }
  if (r.indicatorId === indicatorId) return { ok: true }
  if (r.indicatorId) return { ok: false, error: '只有待归位读数可重新匹配' }
  const queued = db.inbox.find((i) => i.kind === 'reading' && i.readingId === id)
  if (queued) { db.inbox = db.inbox.filter((i) => i !== queued); persist() }
  try {
    const moved = s.groupReadings(observationKey(r)).map((row) => ({ ...row, indicatorId }))
    const target = s.groupReadings(observationKey(moved[0]))
    const combined = [...target, ...moved]
    const projection = projectSumScope(moved[0], projectReadings(combined), combined)
    const ids = new Set(moved.map((row) => row.id))
    // 同一待归位观测的所有作证一起移动，保留修正和驳回状态。
    const retired = [...s.conflicts.values()].filter((c) => !c.resolved && (ids.has(c.readingA) || ids.has(c.readingB))).map((c) => ({ ...c, resolved: 'both', resolvedAt: today(), obsolete: 'assigned' }))
    s.commit({ event: { kind: 'assign', readingId: id, readingIds: [...ids], indicatorId, patches: projection.patches, conflicts: [...retired, ...projection.conflicts] } })
    persist()
    return { ok: true }
  } catch (error) { return { ok: false, error: error.message } }
}

function resolveReadingConflict(c, verdict) {
  const s = readingsStore()
  const a = s.refs.get(c.readingA || c.a), b = s.refs.get(c.readingB || c.b)
  if (!a || !b) return { ok: false, error: '冲突证据不存在' }
  // 兼容旧导入的 readingA/readingB 或 a/b 冲突：先追加到事件账本。
  if (!s.conflicts.has(c.id)) s.commit({ event: { kind: 'conflict', patches: [], conflicts: [{ ...c, readingA: a.id, readingB: b.id, resolved: c.resolved || null }] } })
  const ids = new Set([...s.groupReadings(observationKey(a)), ...s.groupReadings(observationKey(b))].map((r) => r.id))
  for (const id of c.readingIds || []) if (s.refs.has(id)) ids.add(id)
  const losers = new Set(c.reason === 'sum-violation'
    ? verdict === 'a' ? c.componentIds || [b.id] : verdict === 'b' ? c.totalIds || [a.id] : []
    : verdict === 'a' ? [b.id] : verdict === 'b' ? [a.id] : [])
  const groups = new Map()
  for (const id of ids) {
    const r = s.refs.get(id)
    const flags = r.trust.flags.filter((f) => f !== 'sum-violation')
    if (losers.has(id)) flags.push('contradicted')
    const row = { ...r, status: losers.has(id) ? 'rejected' : r.status === 'conflicted' ? 'current' : r.status, trust: { ...r.trust, flags } }
    const key = observationKey(row)
    groups.set(key, [...(groups.get(key) || []), row])
  }
  const projections = [...groups.values()].map((rs) => projectReadings(rs))
  const patches = projections.flatMap((p) => p.patches)
  const remainingConflicts = projections.flatMap((p) => p.conflicts).filter((other) => other.id !== c.id)
  const resolved = { ...c, readingA: a.id, readingB: b.id, resolved: verdict, resolvedAt: today() }
  const aliases = [...s.conflicts.values()].filter((other) => other.id !== c.id && ((other.readingA === a.id && other.readingB === b.id) || (other.readingA === b.id && other.readingB === a.id))).map((other) => ({ ...other, resolved: verdict === 'both' ? verdict : (other.readingA === a.id ? verdict : verdict === 'a' ? 'b' : 'a'), resolvedAt: today() }))
  const retired = [...s.conflicts.values()].filter((other) => other.id !== c.id && !other.resolved && (losers.has(other.readingA) || losers.has(other.readingB)))
    .map((other) => ({ ...other, resolved: 'both', resolvedAt: today(), obsolete: 'superseded-by-decision' }))
  s.commit({ event: { kind: 'resolve', conflictId: c.id, verdict, patches, conflicts: [...remainingConflicts, ...retired, resolved, ...aliases] } })
  persist()
  return resolved
}

/** 反查：indicatorId 为主，channelIds 只作为旧数据兼容。 */
export function indicatorsForReading(reading) {
  const d = load()
  return d.nodes.filter((n) => n.id === reading.indicatorId || n.id === reading.nodeId || (reading.channelId && (n.channelIds || []).includes(reading.channelId)))
}

export function latestReadingByChannel(channelId) {
  load()
  const s = readingsStore()
  const rs = [...s.refs.values()].filter((r) => r.channelId === channelId).sort((a, b) => b.period.end.localeCompare(a.period.end) || b.period.start.localeCompare(a.period.start) || b.lineNo - a.lineNo)
  if (!rs.length) return null
  const r = s.get(rs[0].id), g = s.groups.get(observationKey(rs[0]))
  return { ...r, value: g.value, status: g.status, trust: { ...g.trust, flags: [...g.trust.flags] } }
}

export function exportIntent() {
  const d = load()
  const tree = (themeId, parentId = null, visited = new Set()) => d.nodes.filter((n) => n.themeId === themeId && (n.parentId || null) === parentId && n.status !== 'dead' && !visited.has(n.id)).map((n) => ({ id: n.id, title: n.title, type: n.type, cadence: n.cadence || null, indicatorIds: n.indicatorIds || [], children: tree(themeId, n.id, new Set([...visited, n.id])) }))
  return {
    themes: d.themes.filter((t) => !t.deletedAt).map((t) => ({ id: t.id, name: t.name, tags: t.tags || [], tree: tree(t.id), tagLibrary: t.tagLibrary || [] })),
    openJudgments: d.nodes.filter((n) => n.kind === 'lemma' && n.type !== 'observation' && n.status !== 'dead' && n.settlement?.resolved == null).map((n) => ({ id: n.id, claim: n.title, confidence: n.confidence, settlesOn: n.settlement?.date || null, indicators: d.nodes.filter((i) => i.type === 'observation' && i.status !== 'dead' && ((n.indicatorIds || []).includes(i.id) || i.parentId === n.id || (n.channelIds || []).some((id) => (i.channelIds || []).includes(id)))).map((i) => i.title) })),
  }
}

export function dueIndicators(now = Date.now()) {
  const d = load()
  const time = typeof now === 'number' ? now : new Date(now).getTime()
  if (!Number.isFinite(time)) return []
  return d.nodes.filter((n) => n.type === 'observation' && n.status !== 'dead').map((n) => {
    let parent = d.nodes.find((p) => p.id === n.parentId)
    let inherited = null
    const visited = new Set([n.id])
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id)
      inherited = parent.scaffold?.indicators?.find((i) => normalizeName(i.name) === normalizeName(n.title))?.cadence
      if (inherited) break
      parent = d.nodes.find((p) => p.id === parent.parentId)
    }
    const cadence = n.cadence || inherited || '季度'
    const days = ({ 日: 1, 每日: 1, 周: 7, 每周: 7, 月: 30, 每月: 30, 季: 95, 年: 365, ...CADENCE_DAYS })[cadence] || 95
    const key = readingsStore().latest.get(n.id)
    const last = readingsStore().groups.get(key)
    const nextDue = new Date(last ? Date.parse(last.at) + days * 864e5 : 0).toISOString()
    return { ...n, channelIds: n.channelIds || [], cadence, lastReadingAt: last?.at || null, nextDue }
  }).filter((n) => Date.parse(n.nextDue) <= time)
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
  const cutoff = localDate(new Date(Date.now() - days * 86400000))
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
