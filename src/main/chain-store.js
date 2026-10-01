/**
 * 主题认知链 · 数据层
 *
 * 链 = 主题的认知快照：反映"我对这个主题认知的变化"。
 * - 存 theme.chain JSON 字段；初始空对象，段名由挂载自然生长（无预设模板）。
 * - 变化 log 每条带 hash/prevHash（复用 reading-store 的 digest），防篡改，不写校验函数（红区）。
 * - 不创建 ledger node，不碰 lemma/confidence（公理1）。
 * - 所有变更按 id 幂等：sync outbox 重放安全。
 *
 * 持久化：通过 store.js 导出的 persistLedger() 落盘（与 updateTheme 同一通道）。
 */
import { load, uid, today, persistLedger } from './store.js'
import { digest } from './reading-store.js'

export const CHAIN_VERSION = 1
export const SEG_STATUSES = ['confirmed', 'pending', 'stale', 'forking', 'closed']
/**
 * 展示分层：层只是页面的视觉分组，不蕴含因果或推演关系。
 * 层名与层数由用户自定（默认三层）；段用 layer 下标归属某层。
 */
export const DEFAULT_LAYER_NAMES = ['第一层', '第二层', '第三层']
export const MAX_LAYERS = 12
export function sanitizeLayerNames(names) {
  if (!Array.isArray(names) || !names.length) return [...DEFAULT_LAYER_NAMES]
  const clean = names.map((n) => String(n ?? '').trim()).filter(Boolean).slice(0, MAX_LAYERS)
  return clean.length ? clean : [...DEFAULT_LAYER_NAMES]
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function normLogEntry(e) {
  if (!isObj(e)) return null
  return {
    id: String(e.id || uid()),
    at: String(e.at || today()),
    oldValue: String(e.oldValue ?? ''),
    newValue: String(e.newValue ?? ''),
    reason: String(e.reason || ''),
    evidenceRefs: Array.isArray(e.evidenceRefs) ? e.evidenceRefs.filter(isObj) : [],
    prevHash: e.prevHash ?? null,
    hash: e.hash ?? null,
  }
}

function normSubsegment(s) {
  if (!isObj(s)) return null
  return {
    id: String(s.id || uid()),
    name: String(s.name || '未命名分支'),
    coreInfo: String(s.coreInfo || ''),
    status: SEG_STATUSES.includes(s.status) ? s.status : 'pending',
    kind: s.kind === 'structural' ? 'structural' : 'conditional',
    convergeCondition: String(s.convergeCondition || ''),
    changeLog: (Array.isArray(s.changeLog) ? s.changeLog : []).map(normLogEntry).filter(Boolean),
    evidenceRefs: Array.isArray(s.evidenceRefs) ? s.evidenceRefs.filter(isObj) : [],
    closeReason: String(s.closeReason || ''),
    closedAt: s.closedAt || null,
    createdAt: s.createdAt || today(),
    updatedAt: s.updatedAt || today(),
  }
}

function normSegment(s) {
  if (!isObj(s)) return null
  const strArr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []
  return {
    id: String(s.id || uid()),
    name: String(s.name || '未命名段'),
    coreInfo: String(s.coreInfo || ''),
    status: SEG_STATUSES.includes(s.status) ? s.status : 'pending',
    layer: Number.isInteger(s.layer) && s.layer >= 0 ? s.layer : 0,
    metrics: (Array.isArray(s.metrics) ? s.metrics : []).filter(isObj).map((m) => ({
      label: String(m.label || ''), value: m.value ?? '',
    })),
    source: isObj(s.source) ? {
      label: String(s.source.label || ''),
      url: String(s.source.url || ''),
      at: String(s.source.at || ''),
      firstHand: !!s.source.firstHand,
    } : null,
    affects: strArr(s.affects),
    mergedInto: strArr(s.mergedInto),
    mergedFrom: strArr(s.mergedFrom),
    falsifier: String(s.falsifier || ''),
    convergeCondition: String(s.convergeCondition || ''),
    settleAt: String(s.settleAt || ''),
    subsegments: (Array.isArray(s.subsegments) ? s.subsegments : []).map(normSubsegment).filter(Boolean),
    changeLog: (Array.isArray(s.changeLog) ? s.changeLog : []).map(normLogEntry).filter(Boolean),
    evidenceRefs: Array.isArray(s.evidenceRefs) ? s.evidenceRefs.filter(isObj) : [],
    createdAt: s.createdAt || today(),
    updatedAt: s.updatedAt || today(),
    closedAt: s.closedAt || null,
  }
}

/** 归一化：老账本/空值进来也能安全读。 */
export function normalizeChain(chain) {
  const c = isObj(chain) ? chain : {}
  const layerNames = sanitizeLayerNames(c.layerNames)
  return {
    version: CHAIN_VERSION,
    layerNames,
    segments: (Array.isArray(c.segments) ? c.segments : []).map(normSegment).filter(Boolean)
      .map((s) => ({ ...s, layer: Math.min(s.layer, layerNames.length - 1) })),
    readingMap: isObj(c.readingMap) ? c.readingMap : {},
  }
}

function getThemeOrThrow(themeId) {
  const theme = load().themes.find((t) => t.id === themeId && !t.deletedAt)
  if (!theme) throw new Error('主题不存在')
  return theme
}

function themeChain(theme) {
  if (!isObj(theme.chain)) theme.chain = {}
  const norm = normalizeChain(theme.chain)
  theme.chain = norm
  return norm
}

/** 读链（归一化后返回）。 */
export function getChain(themeId) {
  const theme = getThemeOrThrow(themeId)
  return themeChain(theme)
}

export function findSegment(chain, idOrName) {
  const segs = chain.segments || []
  return segs.find((s) => s.id === idOrName) || segs.find((s) => s.name === idOrName) || null
}

/** 变化 log 追加：算 prevHash/hash。entry.id 已存在则幂等跳过。 */
function appendLog(segment, { oldValue = '', newValue = '', reason = '', evidenceRefs = [], id = null, at = null }) {
  const logs = segment.changeLog
  const entryId = id || uid()
  if (logs.some((e) => e.id === entryId)) return logs.find((e) => e.id === entryId)
  const prevHash = logs.length ? logs[logs.length - 1].hash : 'GENESIS'
  const body = {
    id: entryId, at: at || today(),
    oldValue: String(oldValue ?? ''), newValue: String(newValue ?? ''),
    reason: String(reason || ''),
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    prevHash,
  }
  const entry = { ...body, hash: digest(body) }
  logs.push(entry)
  segment.updatedAt = today()
  return entry
}

/**
 * 确认挂载：把一次认知变化挂到一个或多个段。
 * - 段名已存在 → 追加变化 log；不存在 → 新建段（状态 pending）。
 * - mountId 幂等：同一 mountId 重放不重复追加。
 * 返回 { segments: [变更的段], created: [新建的段名] }。
 */
export function mountToChain(themeId, {
  mountId = null, segmentNames = [], coreInfo = '', oldValue = '', newValue = '',
  evidence = '', falsifier = '', evidenceRefs = [], source = null, layer = null,
} = {}) {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  const mid = mountId || uid()
  const changed = []
  const created = []
  const names = [...new Set((segmentNames || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!names.length) throw new Error('至少指定一个段')

  for (const name of names) {
    let seg = chain.segments.find((s) => s.name === name)
    if (!seg) {
      seg = normSegment({
        name, coreInfo, status: 'pending',
        layer: Math.min(Number.isInteger(layer) && layer >= 0 ? layer : 0, chain.layerNames.length - 1),
        falsifier, source,
        evidenceRefs, createdAt: today(), updatedAt: today(),
      })
      chain.segments.push(seg)
      created.push(name)
    }
    // 同一 mountId 在该段已有 log → 跳过（幂等）
    if (seg.changeLog.some((e) => e.id === mid)) { changed.push(seg); continue }
    if (coreInfo && !seg.coreInfo) seg.coreInfo = coreInfo
    if (falsifier && !seg.falsifier) seg.falsifier = falsifier
    if (source && !seg.source) seg.source = normSegment({ source }).source
    for (const ref of evidenceRefs) {
      if (!seg.evidenceRefs.some((r) => r.type === ref.type && r.id === ref.id)) seg.evidenceRefs.push(ref)
    }
    appendLog(seg, { id: mid, oldValue, newValue, reason: evidence, evidenceRefs })
    changed.push(seg)
  }
  persistLedger()
  return { segments: changed, created }
}

/** 更新段字段（改名保留 id）+ 可选记一条变化。 */
export function updateChainSegment(themeId, segmentId, patch = {}, changeNote = null) {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  const seg = chain.segments.find((s) => s.id === segmentId)
  if (!seg) throw new Error('段不存在')
  const p = isObj(patch) ? patch : {}
  if (p.name !== undefined && String(p.name).trim()) seg.name = String(p.name).trim()
  if (p.coreInfo !== undefined) seg.coreInfo = String(p.coreInfo)
  if (p.status !== undefined && SEG_STATUSES.includes(p.status)) {
    if (p.status === 'closed' && seg.status !== 'closed') seg.closedAt = today()
    seg.status = p.status
  }
  if (p.role !== undefined) { /* 历史字段：因果 role 已废弃，忽略 */ }
  if (Number.isInteger(p.layer) && p.layer >= 0) seg.layer = Math.min(p.layer, chain.layerNames.length - 1)
  if (p.falsifier !== undefined) seg.falsifier = String(p.falsifier)
  if (p.convergeCondition !== undefined) seg.convergeCondition = String(p.convergeCondition)
  if (p.settleAt !== undefined) seg.settleAt = String(p.settleAt)
  if (Array.isArray(p.affects)) seg.affects = p.affects.filter((x) => typeof x === 'string')
  if (Array.isArray(p.metrics)) seg.metrics = p.metrics.filter(isObj)
  if (isObj(p.source)) seg.source = normSegment({ source: p.source }).source
  if (changeNote) {
    appendLog(seg, {
      oldValue: changeNote.oldValue, newValue: changeNote.newValue,
      reason: changeNote.reason, evidenceRefs: changeNote.evidenceRefs,
    })
  }
  seg.updatedAt = today()
  persistLedger()
  return seg
}

/**
 * 设置展示分层（改名/增减层）：整体覆写，幂等。
 * - 空数组/全空 → 回到默认三层；最多 MAX_LAYERS 层。
 * - 层数减少时，超出范围的段自动收敛到最后一层。
 */
export function setChainLayers(themeId, names) {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  chain.layerNames = sanitizeLayerNames(names)
  const max = chain.layerNames.length - 1
  for (const seg of chain.segments) seg.layer = Math.min(seg.layer, max)
  persistLedger()
  return { layerNames: chain.layerNames }
}

/** 合并段：fromIds 并入 intoId。from 段标 mergedInto 并关闭，证据与历史迁入目标。幂等。 */
export function mergeChainSegments(themeId, fromIds = [], intoId, reason = '') {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  const into = chain.segments.find((s) => s.id === intoId)
  if (!into) throw new Error('目标段不存在')
  const merged = []
  for (const fid of fromIds) {
    if (fid === intoId) continue
    const from = chain.segments.find((s) => s.id === fid)
    if (!from || from.status === 'closed' || from.mergedInto.includes(into.name)) continue
    // 证据与变化历史迁入（按 id 去重）
    for (const ref of from.evidenceRefs) {
      if (!into.evidenceRefs.some((r) => r.type === ref.type && r.id === ref.id)) into.evidenceRefs.push(ref)
    }
    for (const e of from.changeLog) {
      if (!into.changeLog.some((x) => x.id === e.id)) into.changeLog.push({ ...e })
    }
    if (!into.mergedFrom.includes(from.name)) into.mergedFrom.push(from.name)
    from.mergedInto = [...new Set([...from.mergedInto, into.name])]
    from.status = 'closed'
    from.closedAt = today()
    from.updatedAt = today()
    merged.push(from.name)
  }
  if (merged.length) {
    appendLog(into, { reason: `合并段：${merged.join('、')} 并入。${reason}`.trim() })
    into.updatedAt = today()
  }
  persistLedger()
  return { into, merged }
}

/** 新增分支（条件分叉 / 结构分叉）。 */
export function addChainSubsegment(themeId, segmentId, sub = {}) {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  const seg = chain.segments.find((s) => s.id === segmentId)
  if (!seg) throw new Error('段不存在')
  const s = normSubsegment(sub)
  if (seg.subsegments.some((x) => x.id === s.id)) return seg.subsegments.find((x) => x.id === s.id)
  seg.subsegments.push(s)
  // 只有条件分叉才自动进入"待收敛"；结构分叉长期并存，不强行 forking
  if (seg.status !== 'forking' && s.kind === 'conditional') seg.status = 'forking'
  seg.updatedAt = today()
  persistLedger()
  return s
}

/** 关闭分支：条件分叉收敛后关闭，留痕（关闭留痕可复盘）。幂等。 */
export function closeChainBranch(themeId, segmentId, subId, reason = '') {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  const seg = chain.segments.find((s) => s.id === segmentId)
  if (!seg) throw new Error('段不存在')
  const sub = seg.subsegments.find((x) => x.id === subId)
  if (!sub) throw new Error('分支不存在')
  if (sub.status === 'closed') return sub
  sub.status = 'closed'
  sub.closeReason = String(reason || '')
  sub.closedAt = today()
  appendLog(seg, { reason: `关闭分支「${sub.name}」：${reason}`.trim() })
  const openCount = seg.subsegments.filter((x) => x.status !== 'closed').length
  if (openCount < 2 && seg.status === 'forking') seg.status = 'confirmed'
  seg.updatedAt = today()
  persistLedger()
  return sub
}

/**
 * 整段复活：已关闭的段回到「待确认」，其下所有已关闭分支一并复活。
 * 复活不恢复关闭前的状态（不追踪），统一落到 pending，由用户重新核验后确认。
 * 记一条变化日志，可审计、可同步。幂等：已是开放状态时无操作。
 */
export function reviveChainSegment(themeId, segmentId, reason = '') {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  const seg = chain.segments.find((s) => s.id === segmentId)
  if (!seg) throw new Error('段不存在')
  const reopened = []
  if (seg.status === 'closed') {
    seg.status = 'pending'
    reopened.push(`段「${seg.name || '未命名段'}」`)
  }
  for (const sub of seg.subsegments || []) {
    if (sub.status === 'closed') {
      sub.status = 'pending'
      reopened.push(`分支「${sub.name || '未命名分支'}」`)
    }
  }
  if (!reopened.length) return { seg, reopened: [] }
  appendLog(seg, {
    reason: `墓碑区整段复活：${reopened.join('、')}回到待确认${reason ? `。${reason}` : ''}，请重新核验后再确认。`,
  })
  seg.updatedAt = today()
  persistLedger()
  return { seg, reopened }
}

/** 读数自动映射表：metric/indicator → 段名。用户批一次，只读不写。 */
export function getReadingMap(themeId) {
  return getChain(themeId).readingMap || {}
}
export function setReadingMap(themeId, map = {}) {
  const theme = getThemeOrThrow(themeId)
  const chain = themeChain(theme)
  chain.readingMap = isObj(map) ? { ...map } : {}
  persistLedger()
  return chain.readingMap
}

/* ------------------------------------------------------------------ */
/* 提案草稿：存在收件箱条目的 chainDraft 字段上（随条目同步）。 */
/* ------------------------------------------------------------------ */

export function getInboxItem(inboxId) {
  return load().inbox.find((i) => i.id === inboxId) || null
}

/** 存/清提案草稿。draft 为 null 时清除。 */
export function setInboxChainDraft(inboxId, draft) {
  const db = load()
  const item = db.inbox.find((i) => i.id === inboxId)
  if (!item) throw new Error('收件箱条目不存在')
  if (draft == null) delete item.chainDraft
  else item.chainDraft = { ...(draft && typeof draft === 'object' ? draft : {}) }
  persistLedger()
  return item.chainDraft || null
}
