import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const normalizeName = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const copy = (value) => JSON.parse(JSON.stringify(value))
const recordHash = ({ hash, ...body }) => digest(body)
const map = (entries = []) => new Map(entries)
const pageSize = (n) => Math.max(1, Math.min(200, Math.floor(Number(n) || 50)))
export const observationKey = (r) => `obs:${digest([r.indicatorId || r.chainKey, r.period.start, r.period.end, r.unit, r.basis])}`
const seriesKey = (r) => JSON.stringify([r.indicatorId || r.chainKey, r.unit, r.basis])
const indexKeys = ['refs', 'dedupe', 'chains', 'groups', 'latest', 'series', 'sources', 'sourceReadings', 'conflicts', 'daily', 'recentTraces']
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const textId = (v) => typeof v === 'string' && v.length > 0
const hashValue = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const natural = (v) => Number.isSafeInteger(v) && v >= 0
const strings = (v) => Array.isArray(v) && v.every(textId)
const trustShape = (v) => object(v) && Number.isFinite(v.score) && v.score >= 0 && v.score <= 1 && natural(v.crossCount) && v.crossCount > 0 && Array.isArray(v.flags) && v.flags.every((x) => typeof x === 'string')
const recoveryShape = (v) => v === null || (object(v) && natural(v.lineNo) && v.lineNo > 0 && validDate(v.at) && (v.blocked === true ? textId(v.error) : (v.blocked === undefined || v.blocked === false) && natural(v.truncatedBytes) && v.truncatedBytes > 0))
const checkpointShape = (v) => natural(v.size) && Number.isFinite(v.mtimeMs) && v.mtimeMs >= 0 && natural(v.lineNo) && (v.lineNo === 0 ? v.size === 0 && v.logHash === null : v.size > 0 && hashValue(v.logHash))

// checksum 只证明序列化内容没变；加载前还要验证消费方依赖的字段和索引引用。
// 这里只检查索引，不读取事实正文，正常启动不重放 JSONL。
function validIndex(body) {
  try {
    if (body.version !== 2 || !checkpointShape(body) || !natural(body.expectedSize) || !recoveryShape(body.recovery) || (body.expectedSize > body.size && !body.recovery?.blocked)) return false
    const indexes = {}
    for (const key of indexKeys) {
      const entries = body[key]
      if (!Array.isArray(entries) || entries.some((e) => !Array.isArray(e) || e.length !== 2 || !textId(e[0]))) return false
      indexes[key] = map(entries)
      if (indexes[key].size !== entries.length) return false
    }
    const { refs, sources, sourceReadings, groups, series } = indexes
    const chainHeads = map()
    for (const [id, r] of refs) {
      if (!object(r) || r.id !== id || !textId(r.chainKey) || !textId(r.sourceId) || !textId(r.dedupeKey) || !hashValue(r.hash) || !(r.prevHash === null || hashValue(r.prevHash)) || !validDate(r.at) || !(r.indicatorId === null || textId(r.indicatorId)) || typeof r.sourceUrl !== 'string' || !trustShape(r.trust) || !['current', 'superseded', 'conflicted', 'rejected'].includes(r.status) || r.projected !== true) return false
      if (!natural(r.offset) || !natural(r.length) || !r.length || r.length > 2 * 1024 * 1024 || r.offset + r.length > body.size || !natural(r.lineNo) || !r.lineNo || r.lineNo > body.lineNo || !sources.has(r.sourceId)) return false
      validateReading(r)
      if (!indexes.dedupe.has(r.dedupeKey)) return false
      if (!chainHeads.has(r.chainKey) || chainHeads.get(r.chainKey).lineNo < r.lineNo) chainHeads.set(r.chainKey, r)
    }
    if (chainHeads.size !== indexes.chains.size) return false
    for (const [key, r] of chainHeads) if (indexes.chains.get(key) !== r.hash) return false
    for (const [id, s] of sources) {
      if (!object(s) || s.id !== id || !natural(s.pushCount) || !s.pushCount || !strings(s.readingIds) || s.readingIds.length > 50 || !Number.isFinite(s.scoreSum) || !Number.isFinite(s.trust) || s.trust < 0 || s.trust > 1 || !Array.isArray(s.flags) || s.flags.some((x) => typeof x !== 'string') || !validDate(s.firstSeenAt) || !validDate(s.lastSeenAt)) return false
      const ids = sourceReadings.get(id)
      if (!strings(ids) || ids.length !== s.pushCount || JSON.stringify(s.readingIds) !== JSON.stringify(ids.slice(-50))) return false
    }
    const seen = new Set()
    for (const [sourceId, ids] of sourceReadings) {
      if (!sources.has(sourceId) || !strings(ids)) return false
      let lastLine = 0
      for (const id of ids) {
        const r = refs.get(id)
        if (!r || r.sourceId !== sourceId || seen.has(id) || r.lineNo <= lastLine) return false
        seen.add(id)
        lastLine = r.lineNo
      }
    }
    if (seen.size !== refs.size) return false
    const grouped = new Set()
    for (const [key, g] of groups) {
      if (!object(g) || g.id !== key || !strings(g.ids) || !g.ids.length || new Set(g.ids).size !== g.ids.length || !trustShape(g.trust) || !validDate(g.at) || !object(g.period) || !validDate(g.period.start) || !validDate(g.period.end) || typeof g.unit !== 'string' || !['reported', 'estimated'].includes(g.basis) || !['current', 'superseded', 'conflicted'].includes(g.status) || !(g.value === null || Number.isFinite(g.value)) || !natural(g.sourceCount) || g.readingCount !== g.ids.length || typeof g.pending !== 'boolean' || g.indexed !== true || !series.has(g.series)) return false
      for (const id of g.ids) {
        const r = refs.get(id)
        if (!r || grouped.has(id) || observationKey(r) !== key || seriesKey(r) !== g.series || r.indicatorId !== g.indicatorId || r.chainKey !== g.chainKey && !g.indicatorId) return false
        grouped.add(id)
      }
      if (g.currentReadingId !== null && !g.ids.includes(g.currentReadingId)) return false
    }
    if (grouped.size !== refs.size) return false
    let seriesGroups = 0
    for (const [key, keys] of series) {
      if (!strings(keys) || new Set(keys).size !== keys.length || keys.some((k) => groups.get(k)?.series !== key)) return false
      seriesGroups += keys.length
    }
    if (seriesGroups !== groups.size) return false
    for (const g of groups.values()) if (g.indicatorId && !indexes.latest.has(g.indicatorId)) return false
    for (const [id, key] of indexes.latest) if (groups.get(key)?.indicatorId !== id) return false
    for (const id of indexes.dedupe.values()) if (!textId(id) || !refs.has(id)) return false
    for (const hash of indexes.chains.values()) if (!hashValue(hash)) return false
    for (const [id, c] of indexes.conflicts) if (!object(c) || c.id !== id || c.type !== 'reading' || !['a', 'b', 'both', null].includes(c.resolved) || !refs.has(c.readingA) || !refs.has(c.readingB)) return false
    for (const [day, d] of indexes.daily) if (!object(d) || d.date !== day || !validDate(day) || !natural(d.accepted) || !natural(d.pending) || d.pending > d.accepted) return false
    for (const [id, t] of indexes.recentTraces) if (!object(t) || !refs.has(id) || t.id !== `reading:${id}` || !validDate(t.t) || t.stage !== 'reading' || t.target?.id !== id || t.target?.type !== 'reading' || !object(t.actor) || !object(t.decision) || t.sourceId !== refs.get(id).sourceId) return false
    return true
  } catch { return false }
}

/** 日期不用 Date.parse 的宽松溢出修正（例如 2 月 31 日）。 */
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return false
  const date = value.slice(0, 10)
  const time = Date.parse(value)
  return Number.isFinite(time) && date >= '1900-01-01' && date <= '2200-12-31' && new Date(Date.parse(date)).toISOString().slice(0, 10) === date
}

/** 同步与批量入口共用的字段验证；只返回允许落库的字段。 */
export function validateReading(input, { legacy = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('读数必须是对象')
  const invalidLegacy = legacy && (typeof input.value !== 'number' || !Number.isFinite(input.value))
  if (!invalidLegacy && (typeof input.value !== 'number' || !Number.isFinite(input.value))) throw new Error('value 必须是有限数字')
  const text = (v, max, name, fallback = '') => {
    if (v == null) return fallback
    if (typeof v !== 'string' || v.length > max) throw new Error(`${name} 文本过长或类型错误`)
    return v.trim()
  }
  const source = input.source || {}
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('source 必须是对象')
  const url = text(source.url, 4096, 'source.url')
  if (url) {
    let u
    try { u = new URL(url) } catch { throw new Error('source.url 无效') }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('source.url 只允许无凭据的 http/https')
  }
  const end = input.period?.end || (legacy ? source.end || input.asOf || input.at?.slice(0, 10) : input.asOf)
  const start = input.period?.start || (legacy ? source.start || end : end)
  if (!validDate(start) || !validDate(end) || Date.parse(start) > Date.parse(end)) throw new Error('period 日期或范围无效')
  const basis = input.basis || 'reported'
  if (!['reported', 'estimated'].includes(basis)) throw new Error('basis 无效')
  const tier = input.tier || 'agent'
  if (!['agent', 'structured', 'local-llm'].includes(tier)) throw new Error('tier 无效')
  if (input.at != null && !validDate(input.at)) throw new Error('at 日期无效')
  const normalizedSource = {}
  for (const k of ['kind', 'label', 'platform', 'accn', 'filed', 'form', 'start', 'end', 'frame']) normalizedSource[k] = text(source[k], 512, `source.${k}`)
  normalizedSource.url = url
  return {
    indicator: text(input.indicator, 512, 'indicator'), metric: text(input.metric, 512, 'metric'),
    value: invalidLegacy ? null : input.value, unit: text(input.unit, 64, 'unit'), basis, tier,
    ...(invalidLegacy ? { legacyInvalidValue: true, legacyValue: input.legacyValue ?? input.value ?? null } : {}),
    period: { start: start.slice(0, 10), end: end.slice(0, 10) },
    source: normalizedSource, raw: text(input.raw, 262144, 'raw'),
  }
}

/**
 * 索引是可丢弃的检查点，不是事实。事实和独立投影事件在同一 JSONL 事务行提交，
 * 因而崩溃不会留下「事实已写但状态未写」的半笔交易。正文缓存最多 256 条。
 * 正常启动只读索引及 stat；过时/损坏时逐块重放，不把全文件装进内存。
 */
export class ReadingStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true })
    this.file = join(directory, 'readings.jsonl')
    this.indexFile = join(directory, 'readings-index.json')
    this.cache = map()
    this.timer = null
    this.reset()
    let loaded = false
    try {
      const index = JSON.parse(readFileSync(this.indexFile, 'utf8'))
      const { checksum, ...body } = index
      const stat = this.stat()
      if ([1, 2].includes(body.version) && checksum === digest(body)) {
        if (recoveryShape(body.recovery)) this.recovery = body.recovery
        if (checkpointShape(body)) this.expectedSize = Math.max(body.size, this.recovery?.blocked && natural(body.expectedSize) ? body.expectedSize : 0)
        // v1 缺少完整来源索引；保留截尾检查点，但必须从日志重建。
        if (validIndex(body) && body.size === stat.size && body.mtimeMs === stat.mtimeMs) {
          for (const key of indexKeys) this[key] = map(body[key])
          this.size = body.size
          this.mtimeMs = body.mtimeMs
          this.lineNo = body.lineNo
          this.logHash = body.logHash
          this.corruption = this.recovery?.blocked ? this.recovery.error : null
          loaded = true
        }
      }
    } catch { /* 无索引或无效索引：从事实重建 */ }
    if (!loaded) this.rebuild()
    this.exitHandler = () => this.flush()
    process.on('exit', this.exitHandler)
  }

  reset() {
    for (const key of indexKeys) this[key] = map()
    this.size = 0
    this.mtimeMs = 0
    this.lineNo = 0
    this.logHash = null
    this.recovery = null
    this.corruption = null
    this.cache.clear()
  }

  stat() { return existsSync(this.file) ? statSync(this.file) : { size: 0, mtimeMs: 0 } }

  markBlocked(error, lineNo = this.lineNo + 1) {
    this.corruption = this.corruption || error
    this.recovery = { ...this.recovery, blocked: true, error: this.corruption, lineNo: this.recovery?.blocked ? this.recovery.lineNo : lineNo, at: new Date().toISOString() }
    this.cache.clear()
    this.flush()
  }

  ensureWritable() {
    if (this.corruption || this.recovery?.blocked) throw new Error(`账本损坏，禁止追加：${this.corruption || this.recovery.error}`)
    const stat = this.stat()
    if (stat.size !== this.size || stat.mtimeMs !== this.mtimeMs) {
      this.expectedSize = Math.max(this.expectedSize || 0, this.size)
      this.rebuild()
    }
    if (this.corruption || this.recovery?.blocked) throw new Error(`账本损坏，禁止追加：${this.corruption || this.recovery.error}`)
  }

  // 每行限 2MB，坏行不是半行：完整坏行必须报错，不静默跳过。
  scan(visitor) {
    if (!existsSync(this.file)) return { size: 0, tail: 0 }
    const fd = openSync(this.file, 'r')
    let pending = Buffer.alloc(0)
    let offset = 0
    let lineNo = 0
    try {
      const chunk = Buffer.alloc(65536)
      let n
      while ((n = readSync(fd, chunk, 0, chunk.length, null))) {
        pending = Buffer.concat([pending, chunk.subarray(0, n)])
        let end
        while ((end = pending.indexOf(10)) !== -1) {
          const bytes = pending.subarray(0, end + 1)
          lineNo++
          if (bytes.length > 2 * 1024 * 1024) throw new Error(`第 ${lineNo} 行过大`)
          visitor(JSON.parse(bytes.toString('utf8')), { offset, length: bytes.length, lineNo })
          offset += bytes.length
          pending = pending.subarray(end + 1)
        }
        if (pending.length > 2 * 1024 * 1024) throw new Error(`第 ${lineNo + 1} 行过大`)
      }
      return { size: offset, tail: pending.length }
    } finally { closeSync(fd) }
  }

  rebuild() {
    const recovery = this.recovery
    this.expectedSize = Math.max(this.expectedSize || 0, this.size)
    const before = this.stat()
    this.reset()
    this.recovery = recovery
    this.corruption = recovery?.blocked ? recovery.error : null
    let result
    try {
      result = this.scan((row, location) => {
        this.validateTransaction(row)
        this.apply(row, location)
      })
    } catch (error) {
      // 完整坏行不删、不跳过；保留可读前缀，并持久化禁止追加状态。
      this.markBlocked(error.message)
      return
    }
    const after = this.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.size !== result.size + result.tail) {
      this.markBlocked('重建期间账本发生变化')
      return
    }
    // 已确认的事务被截短，即使留下半行也是真实损坏，不能按崩溃尾部洗白。
    if (this.expectedSize > result.size) {
      this.markBlocked('文件比本地检查点短，检测到已提交事务截尾')
      return
    }
    if (result.tail) {
      if (this.corruption) { this.flush(); return }
      // 仅修复已确认前缀之后的中断追加，原始尾部另存，不丢弃。
      const fd = openSync(this.file, 'r')
      const tail = Buffer.alloc(result.tail)
      try { readSync(fd, tail, 0, tail.length, result.size) } finally { closeSync(fd) }
      appendFileSync(`${this.file}.partial`, tail)
      truncateSync(this.file, result.size)
      this.recovery = { truncatedBytes: result.tail, lineNo: this.lineNo + 1, at: new Date().toISOString() }
    }
    this.mtimeMs = result.tail ? this.stat().mtimeMs : after.mtimeMs
    this.flush()
  }

  validateTransaction(row) {
    if (row.version !== 1 || row.prevHash !== this.logHash || row.hash !== recordHash(row) || !validDate(row.at)) throw new Error(`第 ${this.lineNo + 1} 行事件链无效`)
    const f = row.fact
    if (f) {
      if (this.refs.has(f.id) || !f.chainKey || f.prevHash !== (this.chains.get(f.chainKey) || null) || f.hash !== recordHash(f)) throw new Error(`事实 ${f.id} 链无效`)
      validateReading(f, { legacy: f.legacyInvalidValue === true })
      if (f.legacyInvalidValue && (f.value !== null || f.status !== 'rejected')) throw new Error('旧无效读数不得成为当前值')
      if (!f.sourceId || !f.dedupeKey || !row.source || row.source.id !== f.sourceId) throw new Error('事实来源或去重字段缺失')
      if (f.supersedes) {
        const old = this.refs.get(f.supersedes)
        if (!old || old.sourceId !== f.sourceId || !f.accn || old.accn !== f.accn || observationKey(old) !== observationKey(f)) throw new Error('修正必须指向同来源同 accn 同观测的已有事实')
      }
    }
    const e = row.event
    if (!e || !['ingest', 'assign', 'resolve', 'conflict'].includes(e.kind) || !Array.isArray(e.patches) || !Array.isArray(e.conflicts)) throw new Error('投影事件无效')
    if ((e.kind === 'ingest') !== !!f) throw new Error('事件与事实不匹配')
    if (e.kind === 'assign' && (!this.refs.has(e.readingId) || !e.indicatorId)) throw new Error('归位事件无效')
    if (e.kind === 'resolve' && (!['a', 'b', 'both'].includes(e.verdict) || !this.conflicts.has(e.conflictId))) throw new Error('裁决事件无效')
    const ids = new Set()
    for (const p of e.patches) {
      if (!p || Object.keys(p).some((k) => !['id', 'indicatorId', 'status', 'trust'].includes(k))) throw new Error('事件不得改写事实字段')
      const prior = this.refs.get(p.id) || f
      const assigning = e.kind === 'assign' && (e.readingId === p.id || e.readingIds?.includes(p.id)) && e.indicatorId === p.indicatorId && !prior.indicatorId
        && observationKey(prior) === observationKey(this.refs.get(e.readingId))
      if (p.indicatorId !== prior.indicatorId && !assigning) throw new Error('只有同观测归位事件可改变指标投影')
      if ((!this.refs.has(p.id) && p.id !== f?.id) || ids.has(p.id) || !['current', 'superseded', 'conflicted', 'rejected'].includes(p.status) || !(p.indicatorId === null || typeof p.indicatorId === 'string') || !Number.isFinite(p.trust?.score) || p.trust.score < 0 || p.trust.score > 1 || !Number.isInteger(p.trust.crossCount) || p.trust.crossCount < 1 || !Array.isArray(p.trust.flags) || p.trust.flags.some((x) => typeof x !== 'string')) throw new Error('投影字段无效')
      ids.add(p.id)
    }
    if (f && !ids.has(f.id)) throw new Error('事实缺少初始投影')
    for (const c of e.conflicts) {
      if (!c.id || c.type !== 'reading' || !['a', 'b', 'both', null].includes(c.resolved) || ![c.readingA, c.readingB].every((id) => this.refs.has(id) || id === f?.id)) throw new Error('冲突事件无效')
    }
  }

  apply(row, location) {
    const touched = new Set()
    if (row.fact) {
      const f = row.fact
      const { source, ...small } = f
      this.refs.set(f.id, { ...small, sourceUrl: source?.url || '', ...location })
      this.dedupe.set(f.dedupeKey, f.id)
      this.chains.set(f.chainKey, f.hash)
      const sourceIds = this.sourceReadings.get(f.sourceId) || []
      sourceIds.push(f.id)
      this.sourceReadings.set(f.sourceId, sourceIds)
      const trace = { id: `reading:${f.id}`, t: f.at, stage: 'reading', target: { id: f.id, type: 'reading' }, actor: { by: f.effectiveTier }, decision: row.event.trace || {}, sourceId: f.sourceId }
      this.recentTraces.set(f.id, trace)
      if (this.recentTraces.size > 100) this.recentTraces.delete(this.recentTraces.keys().next().value)
      const old = this.sources.get(f.sourceId)
      this.sources.set(f.sourceId, { ...row.source, firstSeenAt: old?.firstSeenAt || f.at, lastSeenAt: f.at, pushCount: (old?.pushCount || 0) + 1, readingIds: [...(old?.readingIds || []), f.id].slice(-50), trust: old?.trust || 0, flags: old?.flags || [], scoreSum: old?.scoreSum || 0 })
      const day = f.at.slice(0, 10)
      const count = this.daily.get(day) || { date: day, accepted: 0, pending: 0 }
      count.accepted++
      if (!f.indicatorId) count.pending++
      this.daily.set(day, count)
      if (this.daily.size > 90) this.daily.delete([...this.daily.keys()].sort()[0])
    }
    for (const p of row.event.patches) {
      const r = this.refs.get(p.id)
      const oldKey = observationKey(r)
      touched.add(oldKey)
      const oldGroup = this.groups.get(oldKey)
      if (oldGroup) oldGroup.ids = oldGroup.ids.filter((id) => id !== p.id)
      const s = this.sources.get(r.sourceId)
      s.scoreSum += p.trust.score - (r.projected ? r.trust.score : 0)
      s.trust = s.scoreSum / s.pushCount
      if (p.trust.flags.includes('contradicted') && !s.flags.includes('once-contradicted')) s.flags.push('once-contradicted')
      Object.assign(r, p, { projected: true })
      // 归位后同时保留原待归位键和新指标键，重推不会再多出一份证据。
      this.dedupe.set(digest([r.indicatorId || r.chainKey, r.period, r.unit, r.basis, r.sourceId, r.sourceUrl, r.accn, r.value]), r.id)
      const key = observationKey(r)
      const group = this.groups.get(key) || { ids: [] }
      group.ids.push(r.id)
      this.groups.set(key, group)
      touched.add(key)
    }
    for (const key of touched) this.refreshGroup(key)
    for (const c of row.event.conflicts) this.conflicts.set(c.id, c)
    this.size = location.offset + location.length
    this.lineNo = location.lineNo
    this.logHash = row.hash
  }

  refreshGroup(key) {
    const g = this.groups.get(key)
    if (!g?.ids.length) {
      if (g?.series) {
        const keys = this.series.get(g.series) || []
        this.series.set(g.series, keys.filter((k) => k !== key))
      }
      this.groups.delete(key)
      const latestKey = g?.indicatorId || g?.chainKey
      if (latestKey && this.latest.get(latestKey) === key) this.refreshLatest(latestKey)
      return
    }
    const rs = g.ids.map((id) => this.refs.get(id))
    const r = rs[rs.length - 1]
    const active = rs.filter((x) => !['superseded', 'rejected'].includes(x.status))
    const conflicted = active.some((x) => x.status === 'conflicted') || new Set(active.map((x) => x.value)).size > 1
    const current = conflicted ? null : active.reduce((best, r) => !best || r.trust.score >= best.trust.score ? r : best, null)
    const flags = [...new Set((active.length ? active : rs).flatMap((x) => x.trust.flags))]
    Object.assign(g, {
      id: key, indicatorId: r.indicatorId, period: r.period, at: rs.reduce((a, x) => x.at > a ? x.at : a, ''),
      value: current?.value ?? null, unit: r.unit, basis: r.basis,
      // 冲突时 value 只能是 null，但调用方需要知道竞争的是哪几个数——不然界面只能干说"待裁决"
      values: conflicted ? [...new Set(active.map((x) => x.value))].sort((a, b) => a - b) : null,
      status: conflicted ? 'conflicted' : current ? 'current' : rs.every((r) => r.status === 'rejected') ? 'rejected' : 'superseded',
      currentReadingId: current?.id || null,
      trust: { score: conflicted ? 0 : current?.trust.score || 0, crossCount: current?.trust.crossCount || 1, flags },
      sourceCount: new Set(rs.map((x) => x.sourceId)).size, readingCount: rs.length,
      pending: !r.indicatorId, chainKey: r.chainKey, series: seriesKey(r),
    })
    const keys = this.series.get(g.series) || []
    if (!g.indexed) {
      let low = 0, high = keys.length
      while (low < high) {
        const mid = (low + high) >>> 1
        const p = this.groups.get(keys[mid]).period
        if (p.end < g.period.end || (p.end === g.period.end && p.start <= g.period.start)) low = mid + 1
        else high = mid
      }
      keys.splice(low, 0, key)
      g.indexed = true
      this.series.set(g.series, keys)
    }
    if (r.indicatorId) {
      const previous = this.groups.get(this.latest.get(r.indicatorId))
      if (!previous || g.period.end > previous.period.end || (g.period.end === previous.period.end && (g.period.start > previous.period.start || (g.period.start === previous.period.start && g.at >= previous.at)))) this.latest.set(r.indicatorId, key)
    } else {
      // 待归位的观测也必须进 latest。否则 latestReadings() 对它们完全失明，
      // 树内 inline 和总览层一个都看不到——而它们恰恰是最该被提醒去归位的。
      // 用 chainKey 做键，与指标 id 不会撞。
      const previous = this.groups.get(this.latest.get(r.chainKey))
      if (!previous || g.period.end > previous.period.end || (g.period.end === previous.period.end && g.at >= previous.at)) this.latest.set(r.chainKey, key)
    }
  }

  refreshLatest(key) {
    this.latest.delete(key)
    for (const [k, g] of this.groups) if ((g.indicatorId || g.chainKey) === key) {
      const old = this.groups.get(this.latest.get(key))
      if (!old || g.period.end > old.period.end || (g.period.end === old.period.end && g.period.start >= old.period.start)) this.latest.set(key, k)
    }
  }

  commit({ fact = null, source = null, event }) {
    // 正常追加仅 stat；磁盘有变化才重放，已发现的损坏不能自动解除。
    this.ensureWritable()
    const row = { version: 1, at: new Date().toISOString(), fact, source, event, prevHash: this.logHash }
    row.hash = recordHash(row)
    this.validateTransaction(row)
    const bytes = Buffer.from(JSON.stringify(row) + '\n')
    if (bytes.length > 2 * 1024 * 1024) throw new Error('单次投影事件超过 2MB')
    appendFileSync(this.file, bytes)
    this.apply(row, { offset: this.size, length: bytes.length, lineNo: this.lineNo + 1 })
    this.mtimeMs = this.stat().mtimeMs
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush() }, 1000)
      this.timer.unref?.()
    }
    return fact ? this.get(fact.id) : null
  }

  flush() {
    clearTimeout(this.timer)
    this.timer = null
    // 只能保存已确认的 mtime，绝不能给旧内存投影配上未经验证的新磁盘时间。
    const body = { version: 2, size: this.size, mtimeMs: this.mtimeMs, expectedSize: Math.max(this.expectedSize || 0, this.size), lineNo: this.lineNo, logHash: this.logHash, recovery: this.recovery }
    for (const key of indexKeys) body[key] = [...this[key]]
    writeFileSync(`${this.indexFile}.tmp`, JSON.stringify({ ...body, checksum: digest(body) }))
    renameSync(`${this.indexFile}.tmp`, this.indexFile)
  }

  close() { this.flush(); process.removeListener('exit', this.exitHandler) }

  exportJournal() {
    const rows = []
    const result = this.scan((row) => rows.push(row))
    if (result.tail) throw new Error('读数账本含半行，无法完整导出')
    return rows
  }

  replaceJournal(rows = []) {
    // importAll 是显式替换动作。旧账本只改名归档，事实字节不覆盖、不删除。
    this.validateJournal(rows)
    clearTimeout(this.timer)
    this.timer = null
    if (existsSync(this.file)) renameSync(this.file, `${this.file}.archive-${Date.now()}-${randomUUID()}`)
    this.reset()
    this.expectedSize = 0
    this.corruption = null
    this.importJournal(rows)
    this.mtimeMs = this.stat().mtimeMs
  }

  validateJournal(rows) {
    if (!Array.isArray(rows)) throw new Error('readingJournal 必须是数组')
    const verifier = Object.create(ReadingStore.prototype)
    verifier.cache = map()
    verifier.reset()
    // 先验证整个导入，绝不把坏事件部分落盘。
    for (const row of rows) {
      const length = Buffer.byteLength(JSON.stringify(row) + '\n')
      if (length > 2 * 1024 * 1024) throw new Error('导入事件超过 2MB')
      verifier.validateTransaction(row)
      verifier.apply(row, { offset: verifier.size, length, lineNo: verifier.lineNo + 1 })
    }
  }

  importJournal(rows) {
    this.validateJournal(rows)
    this.ensureWritable()
    const existing = this.exportJournal()
    try { this.validateJournal(existing) } catch (error) {
      this.markBlocked(error.message)
      throw new Error(`账本损坏，禁止追加：${error.message}`)
    }
    for (let i = 0; i < Math.min(existing.length, rows.length); i++) {
      if (existing[i].hash !== rows[i].hash) throw new Error('导入账本与本地历史分叉；为保护不可变事实，拒绝覆盖')
    }
    for (const row of rows.slice(existing.length)) {
      this.validateTransaction(row)
      const bytes = Buffer.from(JSON.stringify(row) + '\n')
      appendFileSync(this.file, bytes)
      this.apply(row, { offset: this.size, length: bytes.length, lineNo: this.lineNo + 1 })
    }
    this.mtimeMs = this.stat().mtimeMs
    this.flush()
  }

  get(id) {
    const ref = this.refs.get(id)
    if (!ref) return null
    let fact = this.cache.get(id)
    if (!fact) {
      const fd = openSync(this.file, 'r')
      const bytes = Buffer.alloc(ref.length)
      try {
        if (readSync(fd, bytes, 0, bytes.length, ref.offset) !== bytes.length) throw new Error('读数文件已截尾')
      } finally { closeSync(fd) }
      const row = JSON.parse(bytes.toString('utf8'))
      if (row.hash !== recordHash(row) || row.fact?.id !== id || row.fact.hash !== recordHash(row.fact)) throw new Error('读数校验失败')
      fact = row.fact
      this.cache.set(id, fact)
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value)
    }
    return copy({ ...fact, indicatorId: ref.indicatorId, nodeId: ref.indicatorId || fact.nodeId || null, status: ref.status, trust: ref.trust, observationId: observationKey(ref) })
  }

  makeFact(input) {
    const fact = { id: randomUUID(), at: new Date().toISOString(), ...input }
    fact.prevHash = this.chains.get(fact.chainKey) || null
    fact.hash = recordHash(fact)
    return fact
  }

  groupReadings(key) { return (this.groups.get(key)?.ids || []).map((id) => this.refs.get(id)) }
  all() { return [...this.refs.keys()].map((id) => this.get(id)) }

  page({ indicatorId, since, limit = 50, cursor, observationKey: key } = {}) {
    let items = [...this.groups.values()].filter((g) => (!indicatorId || g.indicatorId === indicatorId) && (!since || g.at >= since) && (!key || g.id === key))
    items.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    return this.paginate(items, { limit, cursor }, (g) => { const { ids, series, indexed, ...out } = g; return copy(out) })
  }

  paginate(items, { limit, cursor }, transform = copy) {
    const total = items.length
    let start = 0
    if (cursor) {
      const index = items.findIndex((x) => x.id === cursor)
      // 游标失效（数据被删/重放后 id 不在当前页序里）时退回第一页。
      // 曾经直接返回空页且 nextCursor 为 null——用户看到空白列表，往前往后都走不了。
      if (index >= 0) start = index + 1
    }
    const end = Math.min(total, start + pageSize(limit))
    const slice = items.slice(start, end)
    return { items: slice.map(transform), nextCursor: slice.length && end < total ? slice[slice.length - 1].id : null, total }
  }

  evidence({ observationId, indicatorId, sourceId, cursor, limit = 50 } = {}) {
    const render = (id) => {
      const fact = this.get(id)
      return { ...fact, source: { ...copy(this.sources.get(fact.sourceId)), ...fact.source } }
    }
    if (sourceId && !observationId && !indicatorId) {
      // 来源索引按事务行递增；倒序分页只读当前页，游标二分定位，不扫描事实。
      const ids = this.sourceReadings.get(sourceId) || []
      let end = ids.length
      if (cursor) {
        const ref = this.refs.get(cursor)
        if (!ref || ref.sourceId !== sourceId) return { items: [], nextCursor: null, total: ids.length }
        let low = 0, high = ids.length
        while (low < high) {
          const mid = (low + high) >>> 1
          if (this.refs.get(ids[mid]).lineNo < ref.lineNo) low = mid + 1
          else high = mid
        }
        if (ids[low] !== cursor) return { items: [], nextCursor: null, total: ids.length }
        end = low
      }
      const start = Math.max(0, end - pageSize(limit))
      return { items: ids.slice(start, end).reverse().map(render), nextCursor: start > 0 ? ids[start] : null, total: ids.length }
    }
    const ids = observationId ? this.groups.get(observationId)?.ids || [] : sourceId ? this.sourceReadings.get(sourceId) || [] : [...this.refs.keys()]
    const rs = ids.map((id) => this.refs.get(id)).filter((r) => (!indicatorId || r.indicatorId === indicatorId) && (!sourceId || r.sourceId === sourceId)).sort((a, b) => b.lineNo - a.lineNo)
    return this.paginate(rs, { cursor, limit }, (r) => render(r.id))
  }

  verify(key) {
    let count = 0
    let firstInvalid = 1
    // 独立重放实际字节，绝不拿内存正文作为验真依据。连投影事件也验证。
    const verifier = Object.create(ReadingStore.prototype)
    verifier.cache = map()
    verifier.reset()
    try {
      const before = this.stat()
      const result = this.scan((row, location) => {
        firstInvalid = location.lineNo
        verifier.validateTransaction(row)
        verifier.apply(row, location)
        if (row.fact && (row.fact.chainKey === key || row.fact.indicatorId === key || observationKey(row.fact) === key || this.refs.get(row.fact.id)?.indicatorId === key)) count++
      })
      const after = this.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('验链期间账本发生变化')
      if (this.corruption || this.recovery?.blocked) throw new Error(this.corruption || this.recovery.error)
      if (result.tail || result.size < this.size || result.size < (this.expectedSize || 0) || verifier.logHash !== this.logHash) throw new Error('文件尾部不完整或与本地检查点不一致')
      if (this.recovery) return { ok: false, count, firstInvalid: this.recovery.lineNo || this.lineNo + 1, error: '曾修复中断半行；完整前缀校验通过，尾部已另存 readings.jsonl.partial' }
      if (!count) return { ok: false, count: 0, error: '未找到序列' }
      return { ok: true, count, firstInvalid: null, assurance: '仅本地一致性校验；没有外部锚，不能抵抗整链重写' }
    } catch (error) {
      firstInvalid = this.recovery?.blocked ? this.recovery.lineNo : Math.max(firstInvalid, verifier.lineNo + 1)
      this.markBlocked(error.message, firstInvalid)
      return { ok: false, count, firstInvalid, error: error.message }
    }
  }
}
