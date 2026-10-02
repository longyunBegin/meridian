/**
 * 认知链 · 追加式事件账本（P1）
 *
 * 每个主题一条事件链，事件只追加不修改：
 * - 更正 = 新事件（correction.appended，带 supersedes 指向被取代事件），原事件保留，效力切换。
 * - hash = digest({ themeId, seq, at, actor, type, payload, supersedes, prevHash })，
 *   复用 reading-store 的 digest；首事件 prevHash 为 'GENESIS'（与段 changeLog 一致）。
 * - verifyChain() 补上此前刻意未写的校验函数（红区提案 §4 已批准）。
 *
 * 许可边界：
 * - 只做"搬运"不做"改判"：迁移函数只翻译已有状态，不创建新判断；confidence 原样携带。
 * - 同步暂缓（提案决策点 5）：本模块不进 outbox，单机 local-only。
 * - 不改动既有模块：只读 theme / theme.chain / nodes，只写 theme.eventChain。
 *
 * 持久化：通过 store.js 导出的 persistLedger() 落盘（与 updateTheme 同一通道）。
 */
import { load, uid, persistLedgerNow } from './store.js'
import { digest } from './reading-store.js'
import { normalizeChain } from './chain-store.js'

export const CHAIN_EVENTS_VERSION = 1

export const EVENT_TYPES = [
  'evidence.appended', // 新证据挂载
  'node.created', // 通用网络节点：五种稳定类型
  'node.renamed', // 改名只追加事件，保留旧名
  'node.invalidated', // 失效只追加事件，历史节点保留
  'claim.created', // 主张创建（用户 authored）
  'inference.created', // 推断创建（LLM 提议 + 用户确认）
  'relation.declared', // 语义关系声明：supports / derives / contradicts
  'correction.appended', // 更正事件，supersedes 指向上被取代事件
  'settlement.recorded', // 结算：正确 / 错误（错误即证伪）
  'node.archived', // 归档（墓碑），只读标记
  'node.restored', // 恢复 = 追加新事件，不改写归档历史
  'topic.linked', // 主题关联
  'confidence.updated', // 置信度更新（红区已批准，2026-10-02）：贝叶斯公式机械应用
]

export const NODE_TYPES = ['concept', 'object', 'event', 'viewpoint', 'evidence']
export const REL_TYPES = [
  'supports', 'derives', 'contradicts',
  'belongs-to', 'influences', 'depends-on', 'temporal', 'related',
]

function legacyNodeType(node) {
  const legacyType = String(node?.type || '').trim()
  return NODE_TYPES.includes(legacyType) ? legacyType : 'viewpoint'
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const copy = (v) => JSON.parse(JSON.stringify(v ?? null))
const textId = (v) => typeof v === 'string' && v.length > 0
const displayTitle = (value, limit = 28) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  const parts = typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
    : Array.from(text)
  return parts.length > limit ? parts.slice(0, limit - 1).join('') + '…' : text
}

function legacySourceIdentity(node, source) {
  const fingerprint = digest({
    nodeId: node.id,
    kind: source.kind || '', label: source.label || '', quality: source.quality ?? null,
    at: source.at || null, rawId: source.rawId || null, platform: source.platform || null,
    url: source.url || null, fetchedAt: source.fetchedAt || null, searchPrompt: source.searchPrompt || null,
  })
  return {
    eventId: `evt:legacy-source:${fingerprint}`,
    sourceRef: `legacy-source:${node.kind}:${node.id}:${fingerprint.slice(0, 24)}`,
  }
}

function getThemeOrThrow(themeId) {
  const theme = load().themes.find((t) => t.id === themeId && !t.deletedAt)
  if (!theme) throw new Error('主题不存在')
  return theme
}

/** 取主题事件链（归一化后返回可写引用；读操作请用 getEvents）。 */
function rawEvents(theme) {
  const c = theme.eventChain
  if (c == null) return []
  if (!isObj(c) || !Array.isArray(c.events)) throw new Error('事件账本格式非法；为保护原数据，已停止读写')
  if (c.version !== CHAIN_EVENTS_VERSION) throw new Error(`不支持的事件账本版本：${c.version ?? '未声明'}`)
  return c.events
}

function writableEventChain(theme) {
  if (theme.eventChain == null) theme.eventChain = { version: CHAIN_EVENTS_VERSION, events: [] }
  const events = rawEvents(theme)
  return { ...theme.eventChain, events }
}

function normEvent(e) {
  if (!isObj(e)) return null
  if (!textId(e.id) || !textId(e.themeId) || !Number.isSafeInteger(e.seq) || e.seq < 1) return null
  if (!EVENT_TYPES.includes(e.type) || !textId(e.actor)) return null
  if (!textId(e.at) || !isObj(e.payload)) return null
  if (!(typeof e.hash === 'string' && /^[a-f0-9]{64}$/.test(e.hash))) return null
  if (!['id', 'themeId', 'seq', 'at', 'actor', 'type', 'payload', 'supersedes', 'prevHash', 'hash'].every((k) => Object.hasOwn(e, k))) return null
  if (Object.keys(e).some((k) => !['id', 'themeId', 'seq', 'at', 'actor', 'type', 'payload', 'supersedes', 'prevHash', 'hash'].includes(k))) return null
  return {
    id: e.id,
    themeId: e.themeId,
    seq: e.seq,
    at: String(e.at || ''),
    actor: e.actor,
    type: e.type,
    payload: e.payload,
    supersedes: textId(e.supersedes) ? e.supersedes : null,
    prevHash: e.prevHash ?? null,
    hash: e.hash,
  }
}

/** 读某主题全部事件（深拷贝，防外部篡改内存）。 */
export function getEvents(themeId) {
  const theme = getThemeOrThrow(themeId)
  // Keep malformed rows visible to verification/recovery; never silently drop history.
  return rawEvents(theme).map((e) => copy(e))
}

/** Existing event ledgers may predate migration of per-node source citations. */
export function hasUnmigratedNodeSources(themeId) {
  const theme = getThemeOrThrow(themeId)
  const ids = new Set(rawEvents(theme).map((e) => e?.id).filter(textId))
  return load().nodes.some((node) => node.themeId === themeId
    && (Array.isArray(node.sources) ? node.sources : []).some((source) =>
      isObj(source) && textId(source.kind) && !ids.has(legacySourceIdentity(node, source).eventId)))
}

/** 按 id 取单个事件。 */
export function getEvent(themeId, eventId) {
  const found = getEvents(themeId).find((e) => e.id === eventId)
  return found ? copy(found) : null
}

function eventBody({ id, themeId, seq, at, actor, type, payload, supersedes, prevHash }) {
  return { id, themeId, seq, at, actor, type, payload: copy(payload), supersedes: supersedes ?? null, prevHash }
}

/** 在给定事件数组尾部构造下一个事件（不落盘，供 appendEvent 与迁移 dry-run 共用）。 */
function buildNextEvent(events, themeId, { id = null, at = null, actor = 'user', type, payload = {}, supersedes = null }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`未知事件类型：${type}`)
  if (!textId(actor)) throw new Error('actor 不能为空')
  if (!isObj(payload)) throw new Error('payload 必须为对象')
  const eventId = textId(id) ? id : uid()
  if (events.some((e) => e?.id === eventId)) throw new Error(`事件 id 已存在：${eventId}`)
  if (supersedes != null && !events.some((e) => e.id === supersedes)) {
    throw new Error(`supersedes 指向不存在的事件：${supersedes}`)
  }
  const seq = events.length + 1
  const prevHash = events.length ? events[events.length - 1].hash : 'GENESIS'
  const body = eventBody({
    id: eventId, themeId, seq,
    at: at || new Date().toISOString(),
    actor, type, payload, supersedes, prevHash,
  })
  return { ...body, hash: digest(body) }
}

/**
 * 追加事件：算 seq/prevHash/hash 后落盘。
 * 显式 id 已存在 → 幂等返回已有事件（replayed: true），不重复追加。
 */
function verifyEvents(events, themeId) {
  const ids = new Map()
  const corrected = new Set()
  const correctionRoot = new Map()
  const correctionHead = new Map()
  const archiveState = new Map()
  const titleBySourceRef = new Map()
  const nodeIdBySourceRef = new Map()
  const invalidatedSourceRefs = new Set()
  const reviewedRelations = new Set()
  for (let i = 0; i < events.length; i++) {
    const e = normEvent(events[i])
    if (!e) return { ok: false, index: i, lastValidSeq: i, reason: '事件格式非法' }
    if (e.themeId !== themeId) return { ok: false, index: i, lastValidSeq: i, reason: '事件属于其他主题' }
    if (ids.has(e.id)) return { ok: false, index: i, lastValidSeq: i, reason: `事件 id 重复：${e.id}` }
    if (e.seq !== i + 1) return { ok: false, index: i, lastValidSeq: i, reason: `seq 不连续：期望 ${i + 1}，实际 ${e.seq}` }
    const expectPrev = i === 0 ? 'GENESIS' : events[i - 1]?.hash
    if (e.prevHash !== expectPrev) return { ok: false, index: i, lastValidSeq: i, reason: 'prevHash 衔接断裂' }
    const { hash, ...body } = e
    if (digest(body) !== hash) return { ok: false, index: i, lastValidSeq: i, reason: 'hash 重算不一致（可能被篡改）' }
    if (e.supersedes != null && e.type !== 'correction.appended') return { ok: false, index: i, lastValidSeq: i, reason: '非更正事件包含 supersedes' }

    const p = e.payload
    if ((e.type === 'claim.created' || e.type === 'inference.created') && !textId(p.title)) return { ok: false, index: i, lastValidSeq: i, reason: '主张/推断缺少标题' }
    if (e.type === 'node.created') {
      if (!textId(p.title) || !NODE_TYPES.includes(p.nodeType) || !textId(p.sourceRef)) {
        return { ok: false, index: i, lastValidSeq: i, reason: '节点创建缺少有效类型、标题或 sourceRef' }
      }
      if (p.detail != null && typeof p.detail !== 'string') {
        return { ok: false, index: i, lastValidSeq: i, reason: '节点说明必须为文本' }
      }
      titleBySourceRef.set(p.sourceRef, p.title)
      nodeIdBySourceRef.set(p.sourceRef, e.id)
    }
    if (e.type === 'claim.created' || e.type === 'inference.created' || e.type === 'evidence.appended') {
      const sourceRef = p.sourceRef || `event:${e.id}`
      const title = e.type === 'evidence.appended'
        ? (p.title || displayTitle(p.text || p.reason || '证据')) : (p.title || p.coreInfo || '未命名')
      if (!titleBySourceRef.has(sourceRef)) {
        titleBySourceRef.set(sourceRef, title)
        nodeIdBySourceRef.set(sourceRef, e.id)
      }
    }
    if (e.type === 'node.renamed') {
      const previous = titleBySourceRef.get(p.sourceRef)
      if (!textId(p.nodeId) || p.nodeId !== nodeIdBySourceRef.get(p.sourceRef)
        || !textId(p.sourceRef) || !textId(p.previousTitle) || !textId(p.newTitle) || !previous
        || p.previousTitle !== previous || p.newTitle === previous || typeof p.reason !== 'string'
        || invalidatedSourceRefs.has(p.sourceRef)) {
        return { ok: false, index: i, lastValidSeq: i, reason: '改名事件目标、旧名或新名非法' }
      }
      titleBySourceRef.set(p.sourceRef, p.newTitle)
    }
    if (e.type === 'node.invalidated') {
      if (!textId(p.nodeId) || p.nodeId !== nodeIdBySourceRef.get(p.sourceRef)
        || !textId(p.sourceRef) || !titleBySourceRef.has(p.sourceRef) || invalidatedSourceRefs.has(p.sourceRef)
        || typeof p.reason !== 'string' || !p.reason.trim()) {
        return { ok: false, index: i, lastValidSeq: i, reason: '失效事件目标不存在或已失效' }
      }
      invalidatedSourceRefs.add(p.sourceRef)
    }
    if (e.type === 'correction.appended') {
      const target = ids.get(e.supersedes)
      const genericViewpoint = target?.type === 'node.created' && target.payload?.nodeType === 'viewpoint'
      if (!textId(e.supersedes) || !target || (!genericViewpoint && !['claim.created', 'inference.created', 'correction.appended'].includes(target.type))) {
        return { ok: false, index: i, lastValidSeq: i, reason: '更正目标不存在或不是主张版本' }
      }
      if (corrected.has(e.supersedes)) return { ok: false, index: i, lastValidSeq: i, reason: '更正形成分叉版本' }
      const root = target.type === 'correction.appended' ? correctionRoot.get(target.id) : target.id
      if (!root || (correctionHead.get(root) || root) !== target.id) return { ok: false, index: i, lastValidSeq: i, reason: '更正未沿当前版本顺序追加' }
      corrected.add(e.supersedes)
      correctionRoot.set(e.id, root)
      correctionHead.set(root, e.id)
    }
    if (e.type === 'relation.declared') {
      if (!REL_TYPES.includes(p.rel) || !isObj(p.from) || !isObj(p.to)) return { ok: false, index: i, lastValidSeq: i, reason: '关系类型或端点非法' }
      if (p.reviewStatus != null && !['pending-review', 'confirmed', 'rejected'].includes(p.reviewStatus)) return { ok: false, index: i, lastValidSeq: i, reason: '关系复核状态非法' }
      for (const endpoint of [p.from, p.to]) {
        if (endpoint.eventId && !ids.has(endpoint.eventId)) return { ok: false, index: i, lastValidSeq: i, reason: '关系引用了尚不存在的事件' }
        if (!endpoint.eventId && !endpoint.ref && !textId(endpoint.name)) return { ok: false, index: i, lastValidSeq: i, reason: '关系端点缺少来源' }
      }
      if (p.reviewOf != null) {
        const original = ids.get(p.reviewOf)
        const op = original?.payload || {}
        if (!textId(p.reviewOf) || original?.type !== 'relation.declared' || op.reviewOf
          || (op.reviewStatus !== 'pending-review' && op.rel !== 'derives') || reviewedRelations.has(p.reviewOf)) {
          return { ok: false, index: i, lastValidSeq: i, reason: '关系复核目标不存在、不是待复核关系或已作出决定' }
        }
        if (!['confirmed', 'rejected'].includes(p.reviewDecision) || !textId(p.decisionReason)
          || p.rel !== op.rel || JSON.stringify(p.from) !== JSON.stringify(op.from) || JSON.stringify(p.to) !== JSON.stringify(op.to)) {
          return { ok: false, index: i, lastValidSeq: i, reason: '关系复核决定或理由非法，或与原关系不一致' }
        }
        reviewedRelations.add(p.reviewOf)
      } else if (p.reviewDecision != null || p.decisionReason != null) {
        return { ok: false, index: i, lastValidSeq: i, reason: '关系复核决定缺少 reviewOf' }
      }
    }
    if (e.type === 'node.archived' || e.type === 'node.restored' || e.type === 'settlement.recorded') {
      if (!textId(p.sourceRef)) return { ok: false, index: i, lastValidSeq: i, reason: `${e.type} 缺少 sourceRef` }
    }
    if (e.type === 'node.archived') archiveState.set(p.sourceRef, true)
    if (e.type === 'node.restored') {
      if (!archiveState.get(p.sourceRef)) return { ok: false, index: i, lastValidSeq: i, reason: '恢复事件没有先前归档事件' }
      archiveState.set(p.sourceRef, false)
    }
    ids.set(e.id, e)
  }
  return { ok: true, count: events.length, lastValidSeq: events.length }
}

function sameIntent(existing, fields) {
  const expected = {
    actor: fields.actor || 'user',
    type: fields.type,
    payload: copy(fields.payload || {}),
    supersedes: fields.supersedes ?? null,
  }
  const actual = {
    actor: existing.actor,
    type: existing.type,
    payload: existing.payload,
    supersedes: existing.supersedes ?? null,
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
}

/** 先验证旧链，再将一批事件作为单次账本快照提交；显式 id 可安全重放。 */
export function appendEvents(themeId, drafts = []) {
  if (!Array.isArray(drafts)) throw new Error('事件批次必须为数组')
  const theme = getThemeOrThrow(themeId)
  const originalChain = theme.eventChain == null ? null : copy(theme.eventChain)
  const existingEvents = rawEvents(theme)
  const before = verifyEvents(existingEvents, themeId)
  if (!before.ok) throw new Error(`事件账本校验失败（第 ${before.index + 1} 条）：${before.reason}`)

  const work = existingEvents.map((e) => copy(e))
  const results = []
  let created = 0
  for (const fields of drafts) {
    if (!isObj(fields)) throw new Error('事件草稿必须为对象')
    if (textId(fields.id)) {
      const existing = work.find((e) => e.id === fields.id)
      if (existing) {
        const normalized = normEvent(existing)
        if (!normalized || !sameIntent(normalized, fields)) throw new Error(`事件 id 已被不同内容占用：${fields.id}`)
        results.push({ ...copy(normalized), replayed: true })
        continue
      }
    }
    const event = buildNextEvent(work, themeId, fields)
    work.push(event)
    results.push(copy(event))
    created++
  }
  const verified = verifyEvents(work, themeId)
  if (!verified.ok) throw new Error(`事件批次校验失败（第 ${verified.index + 1} 条）：${verified.reason}`)
  if (!created) return results

  theme.eventChain = { ...(originalChain || {}), version: CHAIN_EVENTS_VERSION, events: work }
  try {
    persistLedgerNow()
  } catch (error) {
    theme.eventChain = originalChain
    throw error
  }
  return results
}

export function appendEvent(themeId, fields = {}) {
  return appendEvents(themeId, [fields])[0]
}

/**
 * 校验整条事件链：seq 连续、prevHash 衔接、hash 重算一致、类型合法。
 * 返回 { ok:true, count } 或 { ok:false, index, reason }。
 */
export function verifyChain(themeId) {
  const theme = getThemeOrThrow(themeId)
  return verifyEvents(rawEvents(theme), themeId)
}

// ---------------------------------------------------------------------------
// 迁移：把现有账本翻译成事件（直接迁移，无回滚；只搬运不改判）
// ---------------------------------------------------------------------------

/**
 * migrateThemeToEvents(themeId, { persist })
 * - persist=true（默认）：真实写入 theme.eventChain 并落盘。
 * - persist=false：dry-run，只构造事件、跑校验，不写账本。
 * 返回 { created, skipped, events, report }。
 *
 * 映射（提案 §6 + 用户决策）：
 * - chain segment → node.created/viewpoint（evt:seg:<segId>）
 * - segment.changeLog：有 oldValue/newValue → correction.appended（supersedes 指向上同一段的上一个事件），
 *   否则 → evidence.appended；原 hash 存 payload.provenance
 * - segment.affects → relation.declared derives，标注 affects→derives（待复核）
 * - segment.mergedFrom → relation.declared derives
 * - segment.evidenceRefs → relation.declared supports（证据→主张）
 * - branch / lemma 节点 → node.created/五种标准类型；无法精确映射时保留为 viewpoint，旧 sources → evidence.appended + supports；
 *   dead → 追加 node.archived；settlement → settlement.recorded
 * - parentId 旧树层级：丢弃（payload 记录 parentIdDiscarded 备查，不建关系）
 * - confidence 原样携带，永不改动
 */
export function migrateThemeToEvents(themeId, { persist = true } = {}) {
  const theme = getThemeOrThrow(themeId)
  const db = load()
  const chain = normalizeChain(theme.chain)
  const nodes = (db.nodes || []).filter((n) => n.themeId === themeId)
  // 注意：不过滤 deletedAt——已删除/已归档节点正是要搬运的历史（→ claim.created + node.archived）

  // 工作区：persist=false 时在内存副本上构造，不碰真实账本
  const originalChain = theme.eventChain == null ? null : copy(theme.eventChain)
  const existingEvents = rawEvents(theme)
  const existingCheck = verifyEvents(existingEvents, themeId)
  if (!existingCheck.ok) throw new Error(`事件账本校验失败（第 ${existingCheck.index + 1} 条）：${existingCheck.reason}`)
  const workEvents = existingEvents.map((e) => copy(e))
  const workById = new Map(workEvents.map((event) => [event?.id, event]))
  const report = { segments: 0, changeLogs: 0, affects: 0, mergedFrom: 0, evidenceRefs: 0, nodeSources: 0, branches: 0, lemmas: 0, archived: 0, settlements: 0, ambiguousLegacyTypes: 0 }
  let created = 0
  let skipped = 0

  const put = (fields) => {
    if (textId(fields.id) && workById.has(fields.id)) {
      skipped++
      return workById.get(fields.id)
    }
    const event = buildNextEvent(workEvents, themeId, { actor: 'migration', ...fields })
    workEvents.push(event)
    workById.set(event.id, event)
    created++
    return event
  }

  // 段名 → claim 事件 id（affects 按名引用时解析）
  const segNameToEventId = new Map()

  for (const seg of chain.segments) {
    const segEvent = put({
      id: `evt:seg:${seg.id}`,
      at: seg.createdAt || seg.updatedAt || null,
      type: 'node.created',
      payload: {
        nodeType: 'viewpoint',
        title: seg.name || '未命名旧观点',
        detail: seg.coreInfo || '',
        confidence: null,
        status: seg.status || 'pending',
        sourceKind: 'segment',
        sourceRef: `segment:${seg.id}`,
        legacyTypeHint: 'segment',
        migrationBoundary: '迁移仅能保留当前快照与可读取的 changeLog；无法恢复原始来源未记录的逐步历史。',
        layerNote: `旧分层 layer=${seg.layer}（投影不再使用分层）`,
        falsifier: seg.falsifier || '',
        convergeCondition: seg.convergeCondition || '',
        settleAt: seg.settleAt || '',
      },
    })
    segNameToEventId.set(seg.name, segEvent.id)
    report.segments++

    // 变化 log：按段内顺序，correction 串起 supersedes 链
    let prevClaimVersion = segEvent.id
    for (const logEntry of seg.changeLog || []) {
      const hasCorrection = String(logEntry.oldValue ?? '').trim() !== '' || String(logEntry.newValue ?? '').trim() !== ''
      if (hasCorrection) {
        put({
          id: `evt:log:${logEntry.id}`,
          at: logEntry.at || null,
          type: 'correction.appended',
          supersedes: prevClaimVersion,
          payload: {
            oldValue: String(logEntry.oldValue ?? ''),
            newValue: String(logEntry.newValue ?? ''),
            reason: logEntry.reason || '',
            evidenceRefs: copy(logEntry.evidenceRefs || []),
            sourceKind: 'segment-changeLog',
            sourceRef: `segment:${seg.id}#log:${logEntry.id}`,
            provenance: { prevHash: logEntry.prevHash ?? null, hash: logEntry.hash ?? null },
          },
        })
      } else {
        put({
          id: `evt:log:${logEntry.id}`,
          at: logEntry.at || null,
          type: 'evidence.appended',
          payload: {
            text: logEntry.reason || logEntry.newValue || '',
            reason: logEntry.reason || '',
            evidenceRefs: copy(logEntry.evidenceRefs || []),
            sourceKind: 'segment-changeLog',
            sourceRef: `segment:${seg.id}#log:${logEntry.id}`,
            provenance: { prevHash: logEntry.prevHash ?? null, hash: logEntry.hash ?? null },
          },
        })
      }
      if (hasCorrection) prevClaimVersion = `evt:log:${logEntry.id}`
      report.changeLogs++
    }

    if (seg.status === 'closed') {
      put({
        id: `evt:arch:segment:${seg.id}`,
        at: seg.closedAt || seg.updatedAt || null,
        type: 'node.archived',
        payload: {
          reason: seg.closeReason || seg.reason || '旧认知段已关闭',
          archivedAt: seg.closedAt || seg.updatedAt || null,
          evidenceCount: Array.isArray(seg.evidenceRefs) ? seg.evidenceRefs.length : 0,
          sourceKind: 'segment',
          sourceRef: `segment:${seg.id}`,
        },
      })
      report.archived++
    }

    // affects → derives（待复核标注）
    const affects = Array.isArray(seg.affects) ? seg.affects : []
    affects.forEach((name, i) => {
      const targetId = segNameToEventId.get(name) || null
      put({
        id: `evt:rel:aff:${seg.id}:${i}`,
        at: seg.updatedAt || null,
        type: 'relation.declared',
        payload: {
          rel: 'derives',
          from: { eventId: segEvent.id, name: seg.name },
          to: targetId ? { eventId: targetId, name } : { name },
          mapping: 'affects→derives（待复核）',
          reviewStatus: 'pending-review',
          sourceKind: 'segment-affects',
          sourceRef: `segment:${seg.id}`,
        },
      })
      report.affects++
    })

    // mergedFrom → derives
    const mergedFrom = Array.isArray(seg.mergedFrom) ? seg.mergedFrom : []
    mergedFrom.forEach((name, i) => {
      const targetId = segNameToEventId.get(name) || null
      put({
        id: `evt:rel:mfrom:${seg.id}:${i}`,
        at: seg.updatedAt || null,
        type: 'relation.declared',
        payload: {
          rel: 'derives',
          from: targetId ? { eventId: targetId, name } : { name },
          to: { eventId: segEvent.id, name: seg.name },
          mapping: 'mergedFrom→derives',
          sourceKind: 'segment-mergedFrom',
          sourceRef: `segment:${seg.id}`,
        },
      })
      report.mergedFrom++
    })

    // evidenceRefs → supports（证据→主张）
    const seenEvidenceRefs = new Set()
    const evidenceRefs = []
    for (const [legacyIndex, ref] of (Array.isArray(seg.evidenceRefs) ? seg.evidenceRefs : []).entries()) {
      if (!isObj(ref) || !ref.type || !ref.id) continue
      const key = JSON.stringify([String(ref.type).trim(), String(ref.id).trim()])
      if (seenEvidenceRefs.has(key)) continue
      seenEvidenceRefs.add(key)
      evidenceRefs.push({ ref, legacyIndex })
    }
    evidenceRefs.forEach(({ ref, legacyIndex }) => {
      put({
        id: `evt:rel:ev:${seg.id}:${legacyIndex}`,
        at: seg.updatedAt || null,
        type: 'relation.declared',
        payload: {
          rel: 'supports',
          from: { ref: copy(ref) },
          to: { eventId: segEvent.id, name: seg.name },
          sourceKind: 'segment-evidenceRef',
          sourceRef: `segment:${seg.id}`,
        },
      })
      report.evidenceRefs++
    })
  }

  // branch / lemma 节点 → canonical node.created（parentId 保留作迁移元数据，不绘制隐含层级边）
  const sorted = [...nodes].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  for (const node of sorted) {
    const isBranch = node.kind === 'branch'
    const mappedType = legacyNodeType(node)
    if (!NODE_TYPES.includes(String(node.type || '').trim())) report.ambiguousLegacyTypes++
    put({
      id: `evt:node:${node.id}`,
      at: node.createdAt || node.updatedAt || null,
      type: 'node.created',
      payload: {
        nodeType: mappedType,
        title: node.title || '未命名旧节点',
        detail: String(node.description || node.coreInfo || ''),
        confidence: node.confidence ?? null,
        status: node.status || 'live',
        sourceKind: isBranch ? 'branch' : 'lemma',
        sourceRef: `${node.kind}:${node.id}`,
        legacyKind: node.kind,
        legacyTypeHint: node.type || null,
        parentIdDiscarded: node.parentId || null,
        migrationBoundary: '旧数据只有当前快照；无法从迁移记录反推未保存的中间状态或原始内容真伪。',
        scaffold: isBranch ? copy(node.scaffold || null) : undefined,
        tags: copy(node.tags || []),
        tickers: copy(node.tickers || []),
      },
    })
    if (isBranch) report.branches++
    else report.lemmas++

    // Old per-node sources are facts about evidence, not claims. Preserve each source
    // as its own event and explicitly connect it to the migrated claim.
    const sourceRows = Array.isArray(node.sources) ? node.sources : []
    const seenSources = new Set()
    for (const source of sourceRows) {
      if (!isObj(source) || !textId(source.kind)) continue
      const identity = legacySourceIdentity(node, source)
      if (seenSources.has(identity.eventId)) continue
      seenSources.add(identity.eventId)
      report.nodeSources++
      const title = String(source.label || source.kind || '历史来源')
      const evidence = put({
        id: identity.eventId,
        at: source.at || node.createdAt || node.updatedAt || null,
        type: 'evidence.appended',
        payload: {
          text: title,
          reason: '旧节点来源迁移',
          legacySource: copy(source),
          sourceKind: 'legacy-node-source',
          sourceRef: identity.sourceRef,
        },
      })
      put({
        id: `${identity.eventId}:supports`,
        at: source.at || node.createdAt || node.updatedAt || null,
        type: 'relation.declared',
        payload: {
          rel: 'supports',
          from: { eventId: evidence.id },
          to: { eventId: `evt:node:${node.id}` },
          sourceKind: 'legacy-node-source',
          sourceRef: identity.sourceRef,
        },
      })
    }

    if (node.settlement && isObj(node.settlement)) {
      put({
        id: `evt:settle:${node.id}`,
        at: node.settlement.date || node.updatedAt || null,
        type: 'settlement.recorded',
        payload: {
          date: node.settlement.date || null,
          resolved: node.settlement.resolved ?? null,
          correct: node.settlement.correct ?? null,
          sourceKind: node.kind,
          sourceRef: `${node.kind}:${node.id}`,
        },
      })
      report.settlements++
    }
    if (node.status === 'dead') {
      put({
        id: `evt:arch:${node.id}`,
        at: node.deletedAt || node.updatedAt || null,
        type: 'node.archived',
        payload: {
          deletedAt: node.deletedAt || null,
          status: 'dead',
          sourceKind: node.kind,
          sourceRef: `${node.kind}:${node.id}`,
        },
      })
      report.archived++
    }
  }

  const finalCheck = verifyEvents(workEvents, themeId)
  if (!finalCheck.ok) throw new Error(`迁移结果校验失败（第 ${finalCheck.index + 1} 条）：${finalCheck.reason}`)
  if (persist && created > 0) {
    theme.eventChain = { ...(originalChain || {}), version: CHAIN_EVENTS_VERSION, events: workEvents }
    try {
      persistLedgerNow()
    } catch (error) {
      theme.eventChain = originalChain
      throw error
    }
  }
  return { created, skipped, report, events: workEvents.map((e) => copy(normEvent(e) || e)) }
}
