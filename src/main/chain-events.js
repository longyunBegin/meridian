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
import { load, uid, persistLedger } from './store.js'
import { digest } from './reading-store.js'
import { normalizeChain } from './chain-store.js'

export const CHAIN_EVENTS_VERSION = 1

export const EVENT_TYPES = [
  'evidence.appended', // 新证据挂载
  'claim.created', // 主张创建（用户 authored）
  'inference.created', // 推断创建（LLM 提议 + 用户确认）
  'relation.declared', // 语义关系声明：supports / derives / contradicts
  'correction.appended', // 更正事件，supersedes 指向上被取代事件
  'settlement.recorded', // 结算：正确 / 错误（错误即证伪）
  'node.archived', // 归档（墓碑），只读标记
  'topic.linked', // 主题关联
]

export const REL_TYPES = ['supports', 'derives', 'contradicts']

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const copy = (v) => JSON.parse(JSON.stringify(v ?? null))
const textId = (v) => typeof v === 'string' && v.length > 0

function getThemeOrThrow(themeId) {
  const theme = load().themes.find((t) => t.id === themeId && !t.deletedAt)
  if (!theme) throw new Error('主题不存在')
  return theme
}

/** 取主题事件链（归一化后返回可写引用；读操作请用 getEvents）。 */
function eventChain(theme) {
  if (!isObj(theme.eventChain)) theme.eventChain = {}
  const c = theme.eventChain
  if (!Array.isArray(c.events)) c.events = []
  c.version = CHAIN_EVENTS_VERSION
  return c
}

function normEvent(e) {
  if (!isObj(e)) return null
  if (!textId(e.id) || !textId(e.themeId) || !Number.isSafeInteger(e.seq) || e.seq < 1) return null
  if (!EVENT_TYPES.includes(e.type) || !textId(e.actor)) return null
  if (!(typeof e.hash === 'string' && /^[a-f0-9]{64}$/.test(e.hash))) return null
  return {
    id: e.id,
    themeId: e.themeId,
    seq: e.seq,
    at: String(e.at || ''),
    actor: e.actor,
    type: e.type,
    payload: isObj(e.payload) ? e.payload : {},
    supersedes: textId(e.supersedes) ? e.supersedes : null,
    prevHash: e.prevHash ?? null,
    hash: e.hash,
  }
}

/** 读某主题全部事件（深拷贝，防外部篡改内存）。 */
export function getEvents(themeId) {
  const theme = getThemeOrThrow(themeId)
  return eventChain(theme).events.map(normEvent).filter(Boolean).map(copy)
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
  if (events.some((e) => e.id === eventId)) throw new Error(`事件 id 已存在：${eventId}`)
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
export function appendEvent(themeId, fields = {}) {
  const theme = getThemeOrThrow(themeId)
  const chain = eventChain(theme)
  if (textId(fields.id)) {
    const existing = chain.events.find((e) => e.id === fields.id)
    if (existing) return { ...copy(normEvent(existing)), replayed: true }
  }
  const event = buildNextEvent(chain.events, themeId, fields)
  chain.events.push(event)
  persistLedger()
  return copy(event)
}

/**
 * 校验整条事件链：seq 连续、prevHash 衔接、hash 重算一致、类型合法。
 * 返回 { ok:true, count } 或 { ok:false, index, reason }。
 */
export function verifyChain(themeId) {
  const theme = getThemeOrThrow(themeId)
  const events = eventChain(theme).events
  for (let i = 0; i < events.length; i++) {
    const e = normEvent(events[i])
    if (!e) return { ok: false, index: i, reason: '事件格式非法' }
    if (e.seq !== i + 1) return { ok: false, index: i, reason: `seq 不连续：期望 ${i + 1}，实际 ${e.seq}` }
    const expectPrev = i === 0 ? 'GENESIS' : events[i - 1].hash
    if (e.prevHash !== expectPrev) return { ok: false, index: i, reason: 'prevHash 衔接断裂' }
    const { hash, ...body } = e
    if (digest(body) !== hash) return { ok: false, index: i, reason: 'hash 重算不一致（可能被篡改）' }
  }
  return { ok: true, count: events.length }
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
 * - chain segment → claim.created（evt:seg:<segId>）
 * - segment.changeLog：有 oldValue/newValue → correction.appended（supersedes 指向上同一段的上一个事件），
 *   否则 → evidence.appended；原 hash 存 payload.provenance
 * - segment.affects → relation.declared derives，标注 affects→derives（待复核）
 * - segment.mergedFrom → relation.declared derives
 * - segment.evidenceRefs → relation.declared supports（证据→主张）
 * - branch 节点 → claim.created（evt:node:<nodeId>）
 * - lemma 节点 → claim.created；dead → 追加 node.archived；settlement → settlement.recorded
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
  const workEvents = persist ? eventChain(theme).events : [...eventChain(theme).events]
  const report = { segments: 0, changeLogs: 0, affects: 0, mergedFrom: 0, evidenceRefs: 0, branches: 0, lemmas: 0, archived: 0, settlements: 0 }
  let created = 0
  let skipped = 0

  const put = (fields) => {
    if (persist && textId(fields.id) && workEvents.some((e) => e.id === fields.id)) {
      skipped++
      return workEvents.find((e) => e.id === fields.id)
    }
    if (!persist && textId(fields.id) && workEvents.some((e) => e.id === fields.id)) {
      skipped++
      return workEvents.find((e) => e.id === fields.id)
    }
    const event = buildNextEvent(workEvents, themeId, { actor: 'migration', ...fields })
    workEvents.push(event)
    created++
    return event
  }

  // 段名 → claim 事件 id（affects 按名引用时解析）
  const segNameToEventId = new Map()

  for (const seg of chain.segments) {
    const segEvent = put({
      id: `evt:seg:${seg.id}`,
      at: seg.createdAt || seg.updatedAt || null,
      type: 'claim.created',
      payload: {
        nodeKind: 'claim',
        title: seg.name,
        claimType: 'segment',
        confidence: null,
        status: seg.status || 'pending',
        sourceKind: 'segment',
        sourceRef: `segment:${seg.id}`,
        coreInfo: seg.coreInfo || '',
        layerNote: `旧分层 layer=${seg.layer}（投影不再使用分层）`,
        falsifier: seg.falsifier || '',
        convergeCondition: seg.convergeCondition || '',
        settleAt: seg.settleAt || '',
      },
    })
    segNameToEventId.set(seg.name, segEvent.id)
    report.segments++

    // 变化 log：按段内顺序，correction 串起 supersedes 链
    let prevInSeg = segEvent.id
    for (const logEntry of seg.changeLog || []) {
      const hasCorrection = String(logEntry.oldValue ?? '').trim() !== '' || String(logEntry.newValue ?? '').trim() !== ''
      if (hasCorrection) {
        put({
          id: `evt:log:${logEntry.id}`,
          at: logEntry.at || null,
          type: 'correction.appended',
          supersedes: prevInSeg,
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
      prevInSeg = `evt:log:${logEntry.id}`
      report.changeLogs++
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
    const evidenceRefs = Array.isArray(seg.evidenceRefs) ? seg.evidenceRefs : []
    evidenceRefs.forEach((ref, i) => {
      put({
        id: `evt:rel:ev:${seg.id}:${i}`,
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

  // branch / lemma 节点 → claim.created（parentId 丢弃，只记录备查）
  const sorted = [...nodes].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  for (const node of sorted) {
    const isBranch = node.kind === 'branch'
    put({
      id: `evt:node:${node.id}`,
      at: node.createdAt || node.updatedAt || null,
      type: 'claim.created',
      payload: {
        nodeKind: 'claim',
        title: node.title || '',
        claimType: node.type || '',
        confidence: node.confidence ?? null,
        status: node.status || 'live',
        sourceKind: isBranch ? 'branch' : 'lemma',
        sourceRef: `${node.kind}:${node.id}`,
        parentIdDiscarded: node.parentId || null,
        scaffold: isBranch ? copy(node.scaffold || null) : undefined,
        tags: copy(node.tags || []),
        tickers: copy(node.tickers || []),
      },
    })
    if (isBranch) report.branches++
    else report.lemmas++

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

  if (persist) persistLedger()
  return { created, skipped, report, events: workEvents.map((e) => copy(normEvent(e) || e)) }
}
