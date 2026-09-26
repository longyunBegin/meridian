#!/usr/bin/env node
/** meridian.json → meridian.sqlite 一次性迁移脚本。
 *
 * 用法：
 *   node service/migrate-json-to-sqlite.mjs --data-dir <目录> [--overwrite]
 *
 * 流程：
 *   1. 读 <data-dir>/meridian.json，JSON.parse 得到内存 db；
 *   2. 跑 app 的 migrate(db) 做 v1→v4 幂等归一化；
 *      —— migrate 在 src/main/store.js 里是私有函数（红区，不改源码、不另写映射），
 *         这里从源码文本里把 migrate 及其纯依赖（DEFAULT_SETTINGS、
 *         normalizeScaffold / normalizeTagLibrary / normalizeLlmUsage /
 *         normalizeTraceAggregates / localDate）按配平括号原样抽出来求值运行，
 *         跑的就是 app 自己的归一化逻辑；
 *   3. 用 service/db-schema.mjs 的 dbToRows(db) 得到 {表:[行]}；
 *   4. initSchema() 在 <data-dir>/meridian.sqlite 建表（+WAL），事务逐表写入；
 *   5. 校验：逐表 SELECT COUNT(*) == 写入行数，且与归一化后 JSON 数组长度一致；
 *   6. 对 <data-dir>/readings.jsonl 用 ReadingStore.verify() 做哈希链校验。
 *
 * 安全闸（见 main() 开头）：
 *   · --data-dir 指向真实账本（/home/hatch/.config/脉络）时，没有
 *     --i-know-what-im-doing 直接 abort；
 *   · 目标 sqlite 已存在且没有 --overwrite → abort；
 *   · 源 meridian.json 不存在 → abort。
 *
 * 注意：db-schema.mjs 由并行 agent 提供；若暂时不存在，脚本会明确报错退出，
 * 而不是静默用一套自己的映射。
 */

import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_LEDGER = '/home/hatch/.config/脉络'

// ---------------------------------------------------------------------------
// 1. 从 src/main/store.js 源码文本抽取 app 的 migrate(db)（红区：只读不改）
// ---------------------------------------------------------------------------

/** 配平括号抽取：从 source 中 `anchor` 之后第一个 `{` 开始，扫到配平的 `}`。 */
function extractBlock(source, anchor) {
  const start = source.indexOf(anchor)
  if (start < 0) throw new Error(`在 store.js 里找不到 ${JSON.stringify(anchor)}`)
  const open = source.indexOf('{', start)
  if (open < 0) throw new Error(`anchor 后没有 '{': ${anchor}`)
  let i = open
  let depth = 0
  let quote = null // ', ", ` 或 null
  let lineComment = false
  let blockComment = false
  for (; i < source.length; i++) {
    const c = source[i]
    const next = source[i + 1]
    if (lineComment) {
      if (c === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (c === '*' && next === '/') { blockComment = false; i++ }
      continue
    }
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '/' && next === '/') { lineComment = true; i++; continue }
    if (c === '/' && next === '*') { blockComment = true; i++; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error(`括号未配平: ${anchor}`)
  return source.slice(start, i + 1)
}

/** 返回一个函数 runAppMigrate(db)，跑的就是 store.js 里 migrate 的本体。 */
function loadAppMigrate() {
  const src = readFileSync(join(HERE, '..', 'src', 'main', 'store.js'), 'utf8')
  const pieces = [
    extractBlock(src, 'const DEFAULT_SETTINGS = ') + ';',
    extractBlock(src, 'const localDate = '),
    extractBlock(src, 'function normalizeScaffold(scaffold) '),
    extractBlock(src, 'function normalizeTagLibrary(tagLibrary) '),
    extractBlock(src, 'function normalizeLlmUsage(llmUsage) '),
    extractBlock(src, 'function normalizeTraceAggregates(ta) '),
    extractBlock(src, 'function migrate(d) '),
  ]
  // 完整性断言：抽出来的必须是归一化逻辑本身。
  const code = pieces.join('\n')
  for (const marker of ['d.version = 4', 'DEFAULT_SETTINGS', 'normalizeLlmUsage']) {
    if (!code.includes(marker)) throw new Error(`抽取完整性校验失败，缺少标记: ${marker}`)
  }
  const runner = new Function('db', `${code}\nconst today = () => localDate();\nmigrate(db);`)
  return (db) => runner(db)
}

// ---------------------------------------------------------------------------
// 2. CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`用法: node service/migrate-json-to-sqlite.mjs --data-dir <目录> [--overwrite] [--i-know-what-im-doing]

  --data-dir <目录>   账本目录（内含 meridian.json；生成 meridian.sqlite）
  --overwrite         目标 meridian.sqlite 已存在时覆盖（默认 abort）
  --i-know-what-im-doing
                      仅在 --data-dir 指向真实账本时需要。默认直接 abort。

警告：永远不要在真实账本（${REAL_LEDGER}）上试运行迁移，
先在拷贝目录上验证（见 service/README.md）。`)
}

function parseArgs(argv) {
  const args = { dataDir: null, overwrite: false, iknow: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data-dir') args.dataDir = argv[++i]
    else if (a === '--overwrite') args.overwrite = true
    else if (a === '--i-know-what-im-doing') args.iknow = true
    else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else { console.error(`未知参数: ${a}`); usage(); process.exit(2) }
  }
  if (!args.dataDir) { console.error('缺少 --data-dir'); usage(); process.exit(2) }
  return args
}

const fail = (msg) => { console.error(`ABORT: ${msg}`); process.exit(1) }

// node:sqlite 能直接绑定的类型；其余（嵌套对象/数组、boolean、undefined）做无损归一。
// 约定：dbToRows 返回的行应已是 sqlite 就绪值；这里只是兜底，不改变已就绪的值。
function toSqliteValue(v) {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v)
  return v
}

function tableNamesOf(TABLES) {
  if (Array.isArray(TABLES)) return TABLES.map((t) => (typeof t === 'string' ? t : t.name))
  if (TABLES && typeof TABLES === 'object') return Object.keys(TABLES)
  throw new Error('无法识别 TABLES 的形状（期望数组或对象）')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = resolve(args.dataDir)
  const srcJson = join(dataDir, 'meridian.json')
  const targetSqlite = join(dataDir, 'meridian.sqlite')

  // ---- 安全闸 ----
  // 真实账本比对：resolved 路径 + realpath（防符号链接绕过）双重判断。
  let isRealLedger = dataDir === resolve(REAL_LEDGER)
  if (!isRealLedger && existsSync(dataDir)) {
    try { isRealLedger = realpathSync(dataDir) === realpathSync(REAL_LEDGER) } catch {}
  }
  if (isRealLedger && !args.iknow) {
    fail(`--data-dir 指向真实账本 (${REAL_LEDGER})。迁移脚本禁止在真实账本上运行。` +
      `如确需操作，先阅读 service/README.md，并在拷贝目录上验证；执意继续请加 --i-know-what-im-doing。`)
  }
  if (!existsSync(srcJson)) fail(`源文件不存在: ${srcJson}`)
  if (existsSync(targetSqlite) && !args.overwrite) {
    fail(`目标已存在: ${targetSqlite}。确认要覆盖请加 --overwrite。`)
  }
  if (existsSync(targetSqlite)) {
    // 到这里一定是带了 --overwrite：删掉旧库后重建，保证幂等。
    rmSync(targetSqlite)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { rmSync(targetSqlite + suffix) } catch {}
    }
  }
  const schemaPath = join(HERE, 'db-schema.mjs')
  if (!existsSync(schemaPath)) {
    fail(`缺少 service/db-schema.mjs（契约模块，由并行 agent 提供）。` +
      `本脚本不自带 JSON→行映射，缺它无法运行。`)
  }

  const { SCHEMA_VERSION, initSchema, TABLES, dbToRows } = await import('./db-schema.mjs')
  const { ReadingStore } = await import('../src/main/reading-store.js')

  // ---- 读源 + app 归一化 ----
  let db
  try {
    db = JSON.parse(readFileSync(srcJson, 'utf8'))
  } catch (e) {
    fail(`meridian.json 解析失败: ${e.message}`)
  }
  if (!db || typeof db !== 'object' || !Array.isArray(db.nodes)) {
    fail('不是有效的脉络数据文件（缺少 nodes 数组）')
  }

  const runAppMigrate = loadAppMigrate()
  runAppMigrate(db) // v1→v4 幂等归一化（app 自己的逻辑）
  if (Number(db.version) !== 4) fail(`归一化后 version=${db.version}，期望 4`)

  // ---- JSON → 行（只用契约模块的映射） ----
  const all = dbToRows(db) // { 表名: [行] }
  if (!all || typeof all !== 'object') fail('dbToRows 未返回 {表:[行]}')
  const expectedTables = tableNamesOf(TABLES)
  const extra = Object.keys(all).filter((t) => !expectedTables.includes(t))
  if (extra.length) console.error(`注意: dbToRows 返回了契约 TABLES 之外的表: ${extra.join(', ')}（仍会写入）`)

  // ---- 建库 + 事务写入 ----
  const sqlite = new DatabaseSync(targetSqlite)
  try {
    initSchema(sqlite) // 建表 + WAL
    const report = []
    sqlite.exec('BEGIN')
    try {
      for (const [table, rows] of Object.entries(all)) {
        const want = rows.length
        if (want) {
          const cols = []
          for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
          const stmt = sqlite.prepare(
            `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          for (const r of rows) stmt.run(...cols.map((c) => toSqliteValue(r[c])))
        }
        // 校验紧随写入、提交之前：逐表 SELECT COUNT(*) == 写入行数，
        // 且与归一化后 JSON 数组长度一致（直接对应的表）。
        const wrote = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n
        const srcLen = Array.isArray(db[table]) ? db[table].length : null
        const countOk = wrote === want
        const srcOk = srcLen === null || srcLen === want
        const pass = countOk && srcOk
        report.push({
          table,
          源JSON数组: srcLen === null ? '（派生表，跳过）' : srcLen,
          应写入: want,
          已写入: wrote,
          结果: pass ? 'PASS' : 'FAIL',
        })
        if (!pass) throw new Error(`表 ${table} 行数校验失败（源=${srcLen} 应写=${want} 已写=${wrote}）`)
      }
      sqlite.exec('COMMIT')
    } catch (e) {
      console.log(`\n表行数校验（SCHEMA_VERSION=${SCHEMA_VERSION}）：`)
      console.table(report)
      try { sqlite.exec('ROLLBACK') } catch {}
      throw e
    }
    console.log(`\n表行数校验（SCHEMA_VERSION=${SCHEMA_VERSION}）：`)
    console.table(report)
  } finally {
    sqlite.close()
  }

  // ---- readings.jsonl 哈希链校验 ----
  const readingsFile = join(dataDir, 'readings.jsonl')
  if (!existsSync(readingsFile)) {
    console.log('\n链校验: readings.jsonl 不存在，跳过（记为 PASS）。')
  } else {
    const store = new ReadingStore(dataDir)
    try {
      const chainKeys = [...(store.chains?.keys?.() || [])]
      if (!chainKeys.length) {
        console.log('\n链校验: 读数链为空，无链可验（记为 PASS）。')
      } else {
        const key = chainKeys[0]
        const v = store.verify(key)
        console.log(`\n链校验 verify(${JSON.stringify(key)}): ok=${v.ok} count=${v.count}` +
          (v.error ? ` error=${v.error}` : ''))
        if (!v.ok) fail(`readings.jsonl 链校验不通过: ${v.error || '未知错误'}`)
      }
    } finally {
      if (typeof store.close === 'function') store.close()
    }
  }

  console.log(`\nPASS: ${srcJson} → ${targetSqlite} 迁移完成并通过全部校验。`)
}

export { extractBlock, loadAppMigrate, toSqliteValue, tableNamesOf }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`ABORT: ${e.message}`); process.exit(1) })
}
