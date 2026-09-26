/**
 * Meridian SQLite 持久化契约（schema v1）。
 *
 * 这是判断层 durability 的"单一真相"契约：内存 db 对象 ↔ SQLite 表。
 * 另一 agent（single-truth-service）会直接 import 本模块，请精确遵守以下约定：
 *
 *  - 表清单见 TABLES（共 14 张）。除 settings / llm_usage_daily 外，每张表都是
 *    `id TEXT PRIMARY KEY` + 全量对象 JSON 存于 `data TEXT NOT NULL`。
 *  - `data` 列是还原时的真相来源；其余标量列是查询/索引用的投影。
 *    rowsToDb() 以 data 为准，标量列非空时覆盖同名字段（camelCase），
 *    于是外部直接 SQL 改标量列也能被 load() 感知。
 *  - 嵌套字段（数组/对象）一律 JSON.stringify 存 TEXT，读回时 JSON.parse。
 *  - settings 表是 key-value：value 列存 JSON.stringify 后的值，保证类型往返；
 *    保留键 `__version` 存 meridian 数据版本号（migrate() 的权威仍是 version=4，
 *    load() 后 migrate(db) 会重新盖戳）。
 *  - llm_usage_daily 一表两用：date 非空的行是 db.llmUsage.daily（date 唯一），
 *    date 为空的行是 db.llmUsage.recent（按 key 排序还原，key = 'recent:' + 序号）。
 *  - premises / readings_index 是给 single-truth-service 预留的表：判断层内存 db
 *    没有对应的家。dbToRows() 只在输入对象自带 premises / readingsIndex 数组时写，
 *    rowsToDb() 不把这两张表还原进内存对象（store.js 从不读写它们）。
 *  - feeds / readings 不在表清单里：feeds 在 load() 时被 migrate() 排空，
 *    readings 在 load() 时被 migrateReadings() 迁入 readings.jsonl，
 *    persist() 永远看不到非空的它们（见 store.js readingSnapshot）。
 *
 * 红线：本模块只做"形状转换 + 建表"，不碰 ingestReadingCore、哈希链、
 * calibration()/trustFor()、SOURCE_QUALITY。
 */

export const SCHEMA_VERSION = 1

export const TABLES = [
  'nodes',
  'themes',
  'inbox_items',
  'intake_events',
  'traces',
  'trace_aggregates',
  'verdicts',
  'conflicts',
  'premises',
  'research_notes',
  'sources',
  'readings_index',
  'settings',
  'llm_usage_daily',
]

/**
 * 建表。db 是 `node:sqlite` 的 DatabaseSync 实例。
 * 幂等（CREATE TABLE IF NOT EXISTS），重复调用安全。
 */
export function initSchema(db) {
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    theme_id TEXT,
    kind TEXT,
    status TEXT,
    confidence REAL,
    tags TEXT,
    scaffold TEXT,
    sources TEXT,
    parent_id TEXT,
    stable_id TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT,
    tags TEXT,
    tag_library TEXT,
    created_at TEXT,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    text_hash TEXT UNIQUE,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS intake_events (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS trace_aggregates (
    id TEXT PRIMARY KEY,
    date TEXT,
    by_kind TEXT,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS verdicts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS premises (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS research_notes (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS readings_index (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS llm_usage_daily (
    key TEXT PRIMARY KEY,
    date TEXT UNIQUE,
    data TEXT NOT NULL
  )`)
}

const jstr = (v) => (v === undefined ? null : JSON.stringify(v))
const jparse = (s) => {
  if (s === null || s === undefined) return null
  try { return JSON.parse(s) } catch { return null }
}
const arr = (v) => (Array.isArray(v) ? v : [])
/** id + data 两列的通用行：全量对象进 data，id 兜底 null（缺 id 的行不该出现，防脏数据）。 */
const dataRow = (o) => ({ id: o?.id ?? null, data: JSON.stringify(o ?? null) })

/**
 * 内存 db 对象 → { 表名: [行对象...] }。
 * 接受 store.js readingSnapshot() 的结果（sources 已剥离 readingIds，readings 为 []）。
 */
export function dbToRows(db) {
  const d = db || {}
  const rows = {}
  rows.nodes = arr(d.nodes).map((n) => ({
    id: n?.id ?? null,
    theme_id: n?.themeId ?? null,
    kind: n?.kind ?? null,
    status: n?.status ?? null,
    confidence: n?.confidence ?? null,
    tags: jstr(n?.tags),
    scaffold: jstr(n?.scaffold),
    sources: jstr(n?.sources),
    parent_id: n?.parentId ?? null,
    stable_id: n?.stableId ?? null,
    created_at: n?.createdAt ?? null,
    updated_at: n?.updatedAt ?? null,
    deleted_at: n?.deletedAt ?? null,
    data: JSON.stringify(n ?? null),
  }))
  rows.themes = arr(d.themes).map((t) => ({
    id: t?.id ?? null,
    name: t?.name ?? null,
    tags: jstr(t?.tags),
    tag_library: jstr(t?.tagLibrary),
    created_at: t?.createdAt ?? null,
    data: JSON.stringify(t ?? null),
  }))
  rows.inbox_items = arr(d.inbox).map((i) => ({
    id: i?.id ?? null,
    text_hash: i?.text_hash ?? i?.textHash ?? null,
    data: JSON.stringify(i ?? null),
  }))
  rows.intake_events = arr(d.intakeEvents).map(dataRow)
  rows.traces = arr(d.traces).map(dataRow)
  rows.trace_aggregates = arr(d.traceAggregates?.label).map((day) => ({
    id: day?.date == null ? null : `label:${day.date}`,
    date: day?.date ?? null,
    by_kind: jstr(day?.byKind),
    data: JSON.stringify(day ?? null),
  }))
  rows.verdicts = arr(d.verdicts).map(dataRow)
  rows.conflicts = arr(d.conflicts).map(dataRow)
  // 预留表：只有调用方显式带了才写（判断层内存 db 本来就没有这两块）。
  rows.premises = arr(d.premises).map(dataRow)
  rows.research_notes = arr(d.researchNotes).map(dataRow)
  rows.sources = arr(d.sources).map(dataRow)
  rows.readings_index = arr(d.readingsIndex).map(dataRow)
  rows.settings = Object.entries(d.settings || {}).map(([key, value]) => ({
    key,
    value: JSON.stringify(value ?? null),
  }))
  rows.settings.push({ key: '__version', value: JSON.stringify(d.version ?? 4) })
  rows.llm_usage_daily = [
    ...arr(d.llmUsage?.daily).map((day) => ({
      key: day?.date == null ? null : `day:${day.date}`,
      date: day?.date ?? null,
      data: JSON.stringify(day ?? null),
    })),
    // recent 只留最近 50 条（见 recordLlmUsage），按内存顺序编号，还原时按 key 排序。
    ...arr(d.llmUsage?.recent).map((r, i) => ({
      key: `recent:${String(i).padStart(6, '0')}`,
      date: null,
      data: JSON.stringify(r ?? null),
    })),
  ]
  return rows
}

/** data 列优先、标量列非空覆盖：把一行还原成内存对象。
 *  scalars: { camel名: 列名 }——列值非空时直接覆盖；
 *  jsonCols: { camel名: 列名 }——列值是 JSON 文本，先 parse 再覆盖。
 *  于是外部直接 SQL 改标量列也能被 load() 感知，而 data 列保证全字段不丢。 */
function revive(row, scalars = {}, jsonCols = {}) {
  const base = jparse(row.data)
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [camel, col] of Object.entries(scalars)) {
    const v = row[col]
    if (v !== null && v !== undefined) out[camel] = v
  }
  for (const [camel, col] of Object.entries(jsonCols)) {
    const v = jparse(row[col])
    if (v !== null && v !== undefined) out[camel] = v
  }
  return out
}

/**
 * { 表名: [行对象...] } → 内存 db 对象（store.js 的 db 形状，可直接喂给 migrate()）。
 * premises / readings_index 两张表没有内存中的家，还原时忽略（见模块头注释）。
 */
export function rowsToDb(all) {
  const a = all || {}
  const dataRows = (t) => arr(a[t]).map((r) => jparse(r.data)).filter((o) => o && typeof o === 'object')

  const settings = {}
  let version = 4
  for (const r of arr(a.settings)) {
    if (r.key === '__version') {
      const v = jparse(r.value)
      version = Number.isFinite(Number(v)) ? Number(v) : 4
    } else {
      settings[r.key] = jparse(r.value)
    }
  }

  const usageRows = arr(a.llm_usage_daily)
  const daily = usageRows
    .filter((r) => r.date != null)
    .map((r) => jparse(r.data))
    .filter((o) => o && typeof o === 'object')
  const recent = usageRows
    .filter((r) => r.date == null)
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .map((r) => jparse(r.data))
    .filter((o) => o && typeof o === 'object')

  const label = arr(a.trace_aggregates)
    .filter((r) => typeof r.id === 'string' && r.id.startsWith('label:'))
    .map((r) => revive(r, { date: 'date' }, { byKind: 'by_kind' }))
    .filter((o) => o && typeof o === 'object')

  return {
    version,
    settings,
    themes: arr(a.themes).map((r) => revive(r,
      { name: 'name', createdAt: 'created_at' },
      { tags: 'tags', tagLibrary: 'tag_library' })),
    nodes: arr(a.nodes).map((r) => revive(r,
      {
        themeId: 'theme_id', kind: 'kind', status: 'status', confidence: 'confidence',
        parentId: 'parent_id', stableId: 'stable_id',
        createdAt: 'created_at', updatedAt: 'updated_at', deletedAt: 'deleted_at',
      },
      { tags: 'tags', scaffold: 'scaffold', sources: 'sources' })),
    verdicts: dataRows('verdicts'),
    conflicts: dataRows('conflicts'),
    feeds: [],
    inbox: dataRows('inbox_items'),
    traces: dataRows('traces'),
    intakeEvents: dataRows('intake_events'),
    readings: [],
    sources: dataRows('sources'),
    researchNotes: dataRows('research_notes'),
    llmUsage: { daily, recent },
    traceAggregates: { label },
  }
}
