/**
 * 认知链 · 追加式事件账本（P1）
 *
 * 每个主题一条事件链，事件只追加不修改：
 * - 更正 = 新事件（correction.appended，带 supersedes 指向被取代事件），原事件保留，效力切换。
 * - hash = digest({ themeId, seq, at, actor, type, payload, supersedes, prevHash })，
 *   复用 reading-store 的 digest；首事件 prevHash 为 'GENESIS'（与段 changeLog 一致）。
 * - verifyChain()/verifyEvents() 已按用户决定删除（2026-10-03）（红区提案 §4 已批准）。
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
  'node.categorized', // 观点归类：追加式，保留历史分类（红区改动，用户已明确批准）
  'node.invalidated', // 失效只追加事件，历史节点保留
  'claim.created', // 主张创建（用户 authored）
  'inference.created', // 推断创建（LLM 提议 + 用户确认）
  'relation.declared', // 语义关系声明：supports / derives / contradicts
  'correction.appended', // 更正事件，supersedes 指向上被取代事件
  'settlement.recorded', // 结算：正确 / 错误（错误即证伪）
  'node.archived', // 归档（墓碑），只读标记
  'node.restored', // 恢复 = 追加新事件，不改写归档历史
  'node.parked', // 冷冻入库（外部弱信号 → 冷库），只改投影 status，不碰置信度
  'node.unparked', // 解冻 = 追加新事件，不改写冷冻历史
  'topic.linked', // 主题关联
  'confidence.updated', // 置信度更新（红区已批准，2026-10-02）：贝叶斯公式机械应用
  'engine.recommendation.proposed', // 引擎建议卡片；本身不代表事实已确认
  'signal.reviewed', // 信号判决：审阅者对 pendingReview 信号的接受/修正/驳回
]

export const NODE_TYPES = ['concept', 'object', 'event', 'viewpoint', 'evidence']
export const REL_TYPES = [
  'supports', 'derives', 'contradicts',
  'belongs-to', 'influences', 'depends-on', 'temporal', 'related',
  'supersedes', // Directed version relation; valid only alongside an appended correction event.
]

function legacyNodeType(node) {
  const legacyType = String(node?.type || '').trim()
  return NODE_TYPES.includes(legacyType) ? legacyType : 'viewpoint'
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const copy = (v) => JSON.parse(JSON.stringify(v ?? null))
const textId = (v) => typeof v === 'string' && v.length > 0
/**
 * 审阅 change 的合法形状：新的自由备注 {note}，或去领域化之前写入账本的
 * {direction,nature,themeTag} 三元组。旧账本要继续校验通过，新事件也不再被
 * 要求编造领域分类——所以这里两种都收，但都不再是必填。
 */
const validReviewChange = (change) => {
  if (!isObj(change)) return false
  if (typeof change.note === 'string') return true
  return ['improving', 'declining', 'stable'].includes(change.direction)
    && ['quantitative', 'pivot', 'epistemic', 'structural'].includes(change.nature)
    && textId(change.themeTag)
}
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
  const lastValid = [...events].reverse().find((e) => e && typeof e.hash === 'string')
  const prevHash = lastValid ? lastValid.hash : 'GENESIS'
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
            targetNodeId: segEvent.id,
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
          targetNodeId: `evt:node:${node.id}`,
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
