/**
 * 认知链 · 概念 01 + 02（P2 重做版）
 *
 * 左：追加式完整性账本（事件序列，只增不改；更正追加新事件，历史保留）。
 * 右：主题范围内的事件投影网络——没有中心主题节点或预设阅读方向。
 * 替换旧分层链视图；旧分层、旧连线、旧段抽屉代码已删除，不并存。
 *
 * 保留：renderProposalDraft（收件箱挂载，现走 chain:mountEvent 只追加事件）、
 * openEvidenceDetail（读数/收件箱依据详情）。
 *
 * 公理1：本视图只读投影，不创建/修改/删除 lemma，不改 confidence，不代审批。
 */
import { h, clear, mount, toast } from '../lib/dom.js'
import { renderEnginePipeline } from '../components/engine-review.js'
import { renderEvidenceComposer } from '../components/evidence-relation-editor.js'
import { renderBuilderHistoryTimeline } from '../components/builder-history-timeline.js'
import { buildWorkbenchEntries, filterWorkbenchEntries } from '../components/builder-workbench.js'
import { state, setView, selectNode } from '../app.js'
import { resolveEventReference } from '../lib/chain-reference.js'
import { DIRECTION_META, NATURE_META } from '../lib/reader-model.js'
import { LEDGER_PAGE_SIZE, GRAPH_FRAME_NODE_LIMIT, GRAPH_FRAME_EDGE_LIMIT, paginate, selectGraphWindow, consumeChainEventJump, consumeBuilderJump, affectedNodeIdForEvent, verifiedLedgerPrefix, eventsThroughSequence, compactEventSummary, searchGraphNodes } from '../lib/chain-ui-model.js'
import { evidenceForNode } from '../lib/chain-workbench-model.js'
import {
  NETWORK_NODE_TYPES, NODE_TYPE_META, RELATION_META, NODE_STATUS_LABEL, networkNodeType,
  networkNodeStatus, splitNetworkTitle, buildDensityTimeline, timelineChangeSummary,
  layoutThemeNetwork,
} from '../lib/theme-network.js'
import { drawThemeNetwork } from '../lib/theme-network-render.js'

const m = window.meridian
const SVG_NS = 'http://www.w3.org/2000/svg'
const ledgerPageByTheme = new Map()
let chainSectionCounter = 0
const SEARCH_RESULTS_PAGE_SIZE = 30
const builderStateByTheme = new Map()
const builderInboxStateByTheme = new Map()
/** Fresh builder entry always starts at the workbench; explicit reader node-jumps are applied after mount. */
export function normalizeBuilderState(saved = {}) {
  const mode = saved && typeof saved === 'object' ? saved.mode : null
  if (mode === 'inbox') return { mode: 'inbox', nodeId: null }
  /* Legacy `stream`, secondary `history`, and stale `node` subviews never displace the primary entry. */
  return { mode: 'inbox', nodeId: null }
}
/** 节点语义色（对齐概念图）。 */
const KIND = {
  theme: { label: '主题范围', color: '#64748b', bg: '#111827', border: '#475569' },
  concept: { label: '概念', color: '#55cfb1', bg: '#14231f', border: '#3ba88e' },
  object: { label: '对象', color: '#78aaff', bg: '#172238', border: '#5886c5' },
  event: { label: '事件', color: '#ffc271', bg: '#2a2116', border: '#c08c47' },
  viewpoint: { label: '观点', color: '#c2a0ff', bg: '#211b2d', border: '#9676c8' },
  claim: { label: '观点', color: '#c2a0ff', bg: '#211b2d', border: '#9676c8' },
  inference: { label: '观点', color: '#c2a0ff', bg: '#211b2d', border: '#9676c8' },
  evidence: { label: '证据', color: '#d3deea', bg: '#1c242d', border: '#9aaab9' },
}
/** Argument edges are strong; topic associations are deliberately restrained. */
const REL = {
  supports: { label: '支持', color: '#61a8ff', group: 'argument' },
  derives: { label: '推导', color: '#c2a0ff', group: 'argument' },
  contradicts: { label: '反驳', color: '#ff9c79', group: 'argument' },
  'belongs-to': { label: '归属', color: '#7d8da3', group: 'association' },
  influences: { label: '影响', color: '#7d8da3', group: 'association' },
  'depends-on': { label: '依赖', color: '#7d8da3', group: 'association' },
  temporal: { label: '时间关联', color: '#7d8da3', group: 'association' },
  related: { label: '相关', color: '#7d8da3', group: 'association' },
}
/** 节点状态文案：只描述该节点事实的确认状态，不描述关系。 */
const NODE_STATUS = {
  confirmed: { label: '事实已确认' },
  pending: { label: '事实待验证' },
  stale: { label: '数据待更新' },
  forking: { label: '分叉待收敛' },
  closed: { label: '已关闭' },
  archived: { label: '已归档' },
  disproved: { label: '已证伪' },
  superseded: { label: '已更正' },
  resolved: { label: '已结案' },
}
const TYPE_LABEL = {
  'node.created': '节点创建',
  'node.renamed': '节点改名',
  'node.invalidated': '节点失效',
  'evidence.appended': '证据追加',
  'claim.created': '命题创建',
  'inference.created': '推断创建',
  'relation.declared': '关系声明',
  'correction.appended': '更正',
  'settlement.recorded': '结算',
  'node.archived': '归档',
  'node.restored': '恢复',
  'topic.linked': '主题关联',
}
const ACTOR_LABEL = { user: '你', migration: '迁移', 'pipeline:capture': '收件箱捕获' }

function projectedNodes(projection) {
  const allNodes = Array.isArray(projection?.allNodes) ? projection.allNodes : []
  if (allNodes.length) return allNodes
  return Array.isArray(projection?.nodes) ? projection.nodes : []
}

/* ------------------------------------------------------------------ */
/* 主题认知网络：无根语义关系图及其追加式事件账本。 */
/* ------------------------------------------------------------------ */

/**
 * 主题页认知链区块：左 = 追加式完整性账本，右 = 当前认知图（概念 01 + 02）。
 * 投影与事件都是异步的：先画壳，拿到数据后再画。
 * opts: { onOpen(node), onEvidence(ref) }
 */
export function renderChainSection(theme, opts = {}) {
  const drawerId = `cog-ledger-drawer-${++chainSectionCounter}`
  const drawerTitleId = `${drawerId}-title`
  const integrityBadge = h('span', { class: 'cog-integrity-badge is-pending', role: 'status', 'aria-live': 'polite', 'data-ledger-status': '' }, '账本校验中…')
  const addNodeBtn = h('button', { type: 'button', class: 'btn', disabled: true }, '＋ 添加节点')
  const addEvidenceBtn = h('button', { type: 'button', class: 'btn', disabled: true }, '＋ 补充证据')
  const concept = h('div', { class: 'cog-concept cog-reading-layout' })
  const ledgerBackdrop = h('div', { class: 'cog-ledger-backdrop', hidden: true, 'aria-hidden': 'true' })
  const ledgerPane = h('aside', {
    class: 'cog-ledger-pane cog-ledger-drawer', id: drawerId,
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': drawerTitleId, tabindex: '-1', hidden: true,
  }, h('p', { class: 'chain-note' }, '正在读取事件…'))
  /* 建设者：1:1 对齐 demo — .meridian-theme > .builder > .sidebar + .builder-main */
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': '建设者导航' })
  const mainStage = h('main', { class: 'builder-main', 'aria-label': '建设者主舞台' })
  const historyFooter = h('div', { class: 'builder-history-host' })
  const builderLayout = h('div', { class: 'meridian-theme' },
    h('div', { class: 'builder' }, sidebar, mainStage))
  concept.append(ledgerBackdrop, ledgerPane, builderLayout)
  let ledgerButton = null
  const openLedger = () => {
    ledgerBackdrop.hidden = false
    ledgerPane.hidden = false
    ledgerButton?.setAttribute('aria-expanded', 'true')
    ledgerPane.querySelector('.cog-ledger-close')?.focus()
  }
  const closeLedger = () => {
    ledgerBackdrop.hidden = true
    ledgerPane.hidden = true
    ledgerButton?.setAttribute('aria-expanded', 'false')
    ledgerButton?.focus()
  }
  ledgerBackdrop.addEventListener('click', closeLedger)
  const hiddenByClosedDisclosure = (element) => {
    let parent = element.parentElement
    while (parent) {
      if (parent.tagName === 'DETAILS' && !parent.open
        && !(element.tagName === 'SUMMARY' && element.parentElement === parent)) return true
      parent = parent.parentElement
    }
    return false
  }
  ledgerPane.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeLedger(); return }
    if (event.key !== 'Tab') return
    const focusable = [...ledgerPane.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary')]
      .filter((element) => !element.hidden && getComputedStyle(element).display !== 'none' && !hiddenByClosedDisclosure(element))
    if (!focusable.length) { event.preventDefault(); ledgerPane.focus(); return }
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus() }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus() }
  })
  ledgerButton = h('button', {
    type: 'button', class: 'btn cog-ledger-open', 'aria-controls': drawerId, 'aria-expanded': 'false',
    onclick: openLedger,
  }, h('span', { 'aria-hidden': 'true' }, '▤'), h('span', {}, '账本'))
  const toolbar = h('header', { class: 'chain-path-h cog-global-toolbar' },
    h('div', { class: 'cog-global-brand' },
      h('div', { class: 'chain-kicker' }, '主题建设'),
      h('div', { class: 'chain-counts', 'data-cog-counts': '' }, '正在读取事件…')),
    h('div', { class: 'cog-global-actions' }, addNodeBtn, addEvidenceBtn, integrityBadge, ledgerButton))
  const wrap = h('section', { class: 'chain-section', 'aria-label': '主题建设' }, toolbar, concept, historyFooter)
  const viewOpts = {
    ...opts,
    closeLedger,
    openLedger,
    ledgerTitleId: drawerTitleId,
    sidebar,
    mainStage,
    historyFooter,
    onViewAtSequence: opts.onViewAtSequence,
    onReturnLive: opts.onReturnLive,
    addNodeBtn,
    addEvidenceBtn,
    integrityBadge,
    ledgerButton,
    onChanged: () => {
      clear(ledgerPane)
      clear(sidebar)
      clear(mainStage)
      // 路由预载只适用于首次挂载；追加事件后刷新必须读取新的校验账本与投影。
      loadConcept(theme, ledgerPane, { ...viewOpts, initialProjection: null, initialEvents: null }).catch((e) => {
        clear(mainStage).append(h('p', { class: 'chain-note' }, '投影刷新失败：' + (e.message || e)))
      })
    },
  }
  loadConcept(theme, ledgerPane, viewOpts).catch((e) => {
    clear(mainStage).append(h('p', { class: 'chain-note' }, '投影加载失败：' + (e.message || e)))
  })
  return wrap
}

function updateThemeStats(stats, projection, events) {
  if (!stats) return
  const nodes = projectedNodes(projection)
  const points = nodes.filter((node) => !node.external && networkNodeType(node) !== 'evidence').length
  const evidence = nodes.filter((node) => !node.external && networkNodeType(node) === 'evidence').length
  const eventCount = Number.isSafeInteger(projection?.eventCount) ? projection.eventCount : events.length
  const integrity = projection?.integrity?.ok === true ? '校验通过'
    : projection?.integrity?.ok === false ? '校验异常' : '待校验'
  const values = { points, evidence, events: eventCount, integrity }
  for (const [key, value] of Object.entries(values)) {
    const card = stats.querySelector(`[data-theme-stat="${key}"]`)
    const output = card?.querySelector(`[data-theme-stat-value="${key}"]`)
    if (output) output.textContent = String(value)
    if (card && key === 'integrity') card.dataset.state = projection?.integrity?.ok === false ? 'error' : projection?.integrity?.ok === true ? 'ok' : 'pending'
  }
}

/* ------------------------------------------------------------------ */
/* 建设者工作台                                                          */
/* 左：命题列表（有什么） · 中：网络 + 命题详情 · 右：待处理（怎么办）     */
/* 数据进入 → 选中目标命题 → 选支持 / 反驳 → 只追加事件（公理1）。         */
/* ------------------------------------------------------------------ */

function fmtDate(value) {
  const s = String(value || '')
  if (!s) return '未设置'
  const date = new Date(s)
  return Number.isNaN(date.getTime()) ? s.slice(0, 10) : date.toLocaleDateString('zh-CN')
}

function fmtDateTime(value) {
  const s = String(value || '')
  if (!s) return ''
  const date = new Date(s)
  if (Number.isNaN(date.getTime())) return s.slice(0, 16)
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function loadConcept(theme, ledgerPane, opts) {
  const [proj, evRes] = opts.initialProjection
    ? [opts.initialProjection, { events: opts.initialEvents || [] }]
    : await Promise.all([
      m.chainProjection(theme.id),
      m.chainEvents(theme.id).catch(() => null),
    ])
  const events = evRes?.events || []
  const verifiedEvents = verifiedLedgerPrefix(events, proj.integrity)
  const validPrefixSeq = verifiedEvents.length
  if (opts.historyFooter) {
    clear(opts.historyFooter).append(renderBuilderHistoryTimeline(verifiedEvents, {
      onViewAtSequence: opts.onViewAtSequence,
      onReturnLive: opts.onReturnLive,
    }))
  }
  const viewState = { projection: { ...proj, allEvents: events }, selectedSeq: null, events: verifiedEvents }
  const writeBlocked = proj.integrity?.ok === false
  if (opts.addNodeBtn) {
    opts.addNodeBtn.disabled = writeBlocked
    opts.addNodeBtn.title = writeBlocked ? '事件账本校验异常，不能追加节点' : ''
    opts.addNodeBtn.onclick = () => openEntryDialog(theme, viewState.projection, 'node', opts)
  }
  if (opts.addEvidenceBtn) {
    const canAttachEvidence = projectedNodes(viewState.projection).some((node) => !node.archived && !node.invalidated
      && !node.external && networkNodeType(node) !== 'evidence')
    opts.addEvidenceBtn.disabled = writeBlocked || !canAttachEvidence
    opts.addEvidenceBtn.title = writeBlocked ? '事件账本校验异常，不能追加证据'
      : canAttachEvidence ? '' : '请先添加一个非证据节点，再补充证据'
    opts.addEvidenceBtn.onclick = () => openEntryDialog(theme, viewState.projection, 'evidence', opts)
  }
  updateThemeStats(opts.themeStats, proj, events)
  let ledgerController = null
  const sectionEl = ledgerPane.closest('.chain-section')
  const countsEl = sectionEl?.querySelector('[data-cog-counts]')
  const kinds = Object.fromEntries(NETWORK_NODE_TYPES.map((type) => [type, 0]))
  const scopedNodes = Array.isArray(proj.nodes) ? proj.nodes : projectedNodes(proj)
  for (const node of scopedNodes) if (!node.external) kinds[networkNodeType(node)]++
  const parts = []
  for (const type of NETWORK_NODE_TYPES) if (kinds[type]) parts.push(`${NODE_TYPE_META[type].label} ${kinds[type]}`)
  if (countsEl) {
    countsEl.textContent = parts.length
      ? `${parts.join(' · ')} · ${events.length} 事件${scopedNodes.some((node) => node.external) ? ' · 含外部引用' : ''}`
      : '暂无节点'
  }
  const integrityBadge = sectionEl?.querySelector('[data-ledger-status]')
  const updateIntegrityBadge = (current = proj.integrity, validCount = validPrefixSeq, rawCount = events.length) => {
    if (!integrityBadge) return
    const valid = current?.ok === true
    integrityBadge.classList.toggle('is-ok', valid)
    integrityBadge.classList.toggle('is-error', !valid)
    integrityBadge.setAttribute('role', valid ? 'status' : 'alert')
    integrityBadge.textContent = valid
      ? `✓ ${validCount} 事件 · 校验通过`
      : `⚠ ${validCount} / ${rawCount} 事件 · 校验异常`
    integrityBadge.title = valid ? '追加式账本完整性校验通过' : integrityText(current || { ok: false })
  }
  updateIntegrityBadge()
  ledgerController = renderLedgerPanel(ledgerPane, theme, events, proj.integrity, {
    onIntegrityChange: updateIntegrityBadge,
    onClose: opts.closeLedger,
    titleId: opts.ledgerTitleId,
    onChanged: opts.onChanged,
    initialState: viewState,
    verifiedEvents,
  })
  /* Historical signals stay in this same review queue; no separate history page. */
  const buildSignals = () => {
    const signals = []
    const reviewedBySignal = new Map()
    for (const reviewEvent of verifiedEvents || []) {
      const reviewPayload = reviewEvent.payload || {}
      if (reviewEvent.type === 'signal.reviewed' && reviewPayload.signalEventId) {
        reviewedBySignal.set(reviewPayload.signalEventId, reviewPayload)
      } else if (reviewEvent.type === 'relation.declared' && reviewPayload.reviewOf) {
        reviewedBySignal.set(reviewPayload.reviewOf, { decision: reviewPayload.reviewDecision, reason: reviewPayload.decisionReason })
      }
    }
    const nodes = projectedNodes(viewState.projection)
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    for (const event of (verifiedEvents || []).slice().reverse()) {
      const type = event?.type
      const payload = event?.payload || {}
      if (payload.reviewOf) continue
      const isPending = payload.pendingReview || event?.pendingReview
        || (type === 'relation.declared'
          && (payload.reviewStatus != null ? payload.reviewStatus === 'pending-review' : payload.rel === 'derives'))
      if (!isPending) continue
      if (!['evidence.appended', 'relation.declared'].includes(type)) continue
      const nodeId = payload.nodeId || payload.targetId || payload.claimId
        || (typeof payload.to === 'string' ? payload.to : payload.to?.eventId)
      const node = nodeId ? nodeById.get(nodeId) : null
      const rel = payload.rel || payload.relation || 'supports'
      /* Review changes remain suggestions until an immutable decision event stores them. */
      const decisionPayload = reviewedBySignal.get(event.id)
      const change = decisionPayload?.change || payload.change || {}
      const direction = change.direction || (rel === 'contradicts' ? 'declining' : 'improving')
      const nature = change.nature || (type === 'relation.declared' ? 'structural' : rel === 'contradicts' ? 'epistemic' : 'quantitative')
      const themeTag = change.themeTag || payload.themeTag || '数据更新'
      signals.push({
        id: event.id,
        event, type, payload,
        nodeId, node,
        suggestedNode: node?.title || '未归属',
        suggestedDir: rel === 'contradicts' ? '反驳' : rel === 'derives' ? '推导' : '支持',
        dirKey: rel,
        /* 三层 */
        direction, nature, themeTag,
        text: payload.title || String(payload.text || '').slice(0, 60) || (type === 'relation.declared' ? `待审核的${rel}关系` : '新数据'),
        source: payload.sourceLabel || payload.url || '',
        confidence: payload.confidence ?? change.confidence ?? null,
        at: event?.at || event?.timestamp,
        reviewDecision: reviewedBySignal.get(event.id)?.decision || null,
      })
    }
    return signals
  }

  /* ============ Builder：工作台是主入口；历史信号只作次级入口 ============ */
  const savedBuilderState = normalizeBuilderState(builderStateByTheme.get(theme.id))
  let builderMode = savedBuilderState.mode // inbox | node | history; legacy `stream` migrates to inbox
  let selectedNodeId = savedBuilderState.nodeId
  /* 判决状态：signalId -> 'accepted' | 'rejected' | 'edited' */
  const verdictState = new Map()
  /* 编辑器草稿：signalId -> { nodeId, direction, nature, themeTag } */
  const editorDraft = new Map()

  const dirColor = (d) => (DIRECTION_META[d] || DIRECTION_META.stable).color
  const dirIcon = (d) => (DIRECTION_META[d] || DIRECTION_META.stable).icon
  const natIcon = (n) => (NATURE_META[n] || NATURE_META.quantitative).icon
  /* 三层 → demo data-type（决定圆点颜色）：improving=confirm(绿), declining=contradict(红), stable=new(蓝) */
  const sigDataType = (direction) => direction === 'improving' ? 'confirm'
    : direction === 'declining' ? 'contradict' : 'new'

  const renderSidebar = () => {
    clear(opts.sidebar)
    /* Count pending source intake and actionable legacy ledger signals together. */
    let inboxCount = buildSignals().filter((signal) => !signal.reviewDecision && !verdictState.get(signal.id)).length
    try {
      const inbox = m.inboxList ? m.inboxList() : null
      if (Array.isArray(inbox)) inboxCount += inbox.length
      else if (inbox && typeof inbox.then === 'function') { /* 异步，稍后刷新 */ }
    } catch { /* 忽略 */ }
    opts.sidebar.append(
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark' }, 'M'),
        h('div', { class: 'brand-name' }, 'Meridian')),
      h('nav', { class: 'side-nav', id: 'side-nav', 'aria-label': '建设者工作流' },
        h('p', { class: 'side-nav-label' }, '工作台'),
        h('button', {
          type: 'button',
          class: 'side-nav-item active',
          'data-mode': 'inbox',
          'aria-current': 'page',
          onclick: () => { builderMode = 'inbox'; selectedNodeId = null; renderMain(); renderSidebar(); },
        },
          h('span', { class: 'icon', 'aria-hidden': 'true' }, '◷'),
          h('span', {}, '待处理工作台'),
          h('span', { class: 'n' }, String(inboxCount)))),
      h('div', { class: 'side-foot' },
        h('b', {}, '数据源'), ' · 事件账本',
        h('br', {}),
        h('b', {}, '事件'), ` · ${verifiedEvents.length} 条`)
    )
    /* 异步刷新收件箱计数 */
    try {
      if (m.inboxList) {
        const r = m.inboxList()
        if (r && typeof r.then === 'function') {
          r.then((list) => {
            const n = (Array.isArray(list) ? list.length : 0)
              + buildSignals().filter((signal) => !signal.reviewDecision && !verdictState.get(signal.id)).length
            const el = opts.sidebar.querySelector('[data-mode="inbox"] .n')
            if (el) el.textContent = String(n)
          }).catch(() => {})
        }
      }
    } catch { /* 忽略 */ }
  }

  const renderMain = () => {
    builderStateByTheme.set(theme.id, { mode: builderMode, nodeId: selectedNodeId })
    clear(opts.mainStage)
    if (builderMode === 'node' && selectedNodeId) {
      opts.mainStage.append(renderNodeView(selectedNodeId))
    } else opts.mainStage.append(renderInboxView())
  }

  /* 判决：调用后端 chain:confirmSignal */
  const doVerdict = async (sig, decision, change = null) => {
    try {
      const response = await m.chainConfirmSignal(theme.id, sig.id, decision, change, '')
      if (response?.ok === false) throw new Error(response.error || '判决事件未能追加')
      verdictState.set(sig.id, decision === 'accepted' ? 'accepted' : decision === 'rejected' ? 'rejected' : 'edited')
      toast(decision === 'accepted' ? '已接受 · 决定事件已追加'
        : decision === 'rejected' ? '已驳回 · 原事件保留，决定事件已追加' : '建议已修订 · 决定事件已追加')
    } catch (e) {
      toast('判决失败：' + (e?.message || e), 'var(--red)')
      return
    }
    builderInboxStateByTheme.set(theme.id, { mode: 'processed', entryId: `signal:${sig.id}` })
    if (typeof opts.onChanged === 'function') opts.onChanged()
    else { renderMain(); renderSidebar() }
  }
  const acceptSignal = (sig) => doVerdict(sig, 'accepted', {
    direction: sig.direction, nature: sig.nature, themeTag: sig.themeTag,
  })
  const rejectSignal = (sig) => doVerdict(sig, 'rejected', null)
  const confirmEdit = (sig) => {
    const draft = editorDraft.get(sig.id) || {
      direction: sig.direction, nature: sig.nature, themeTag: sig.themeTag,
    }
    if (!['improving', 'declining', 'stable'].includes(draft.direction)) {
      toast('请选择方向', 'var(--red)'); return
    }
    if (!['quantitative', 'pivot', 'epistemic', 'structural'].includes(draft.nature)) {
      toast('请选择变化性质', 'var(--red)'); return
    }
    if (!String(draft.themeTag || '').trim()) {
      toast('请填写主题标签', 'var(--red)'); return
    }
    doVerdict(sig, 'corrected', {
      direction: draft.direction, nature: draft.nature, themeTag: String(draft.themeTag).trim(),
    })
  }

  /* 信号类型标签：对齐 demo TYPE_LABEL */
  const signalTypeLabel = (sig) => {
    const t = sig.type || sig.payload?.type || 'new'
    if (t === 'evidence.appended') return '新增'
    if (t === 'relation.declared') {
      const rel = sig.payload?.rel || 'supports'
      return rel === 'contradicts' ? '证伪' : '证实'
    }
    const map = { new: '新增', confirm: '证实', contradict: '证伪', duplicate: '重复', update: '更新' }
    return map[t] || '新增'
  }

  /* 信号卡片：1:1 对齐 demo renderSignal */
  const renderSignal = (sig, i, savedDecision = null) => {
    const statusMap = { pending: '待判决', accepted: '已接受', rejected: '已驳回', edited: '已修订' }
    const decision = verdictState.get(sig.id) || savedDecision || null
    const status = decision === 'rejected' ? 'rejected'
      : decision === 'corrected' || decision === 'edited' ? 'edited'
        : decision ? 'accepted' : 'pending'
    const isResolved = Boolean(decision)
    const draft = editorDraft.get(sig.id) || {
      direction: sig.direction, nature: sig.nature, themeTag: sig.themeTag,
    }
    /* 影响 pill：节点名 + themeTag（direction 颜色）+ nature 图标 */
    const impactPill = h('button', {
      type: 'button', class: 'impact-pill', 'data-node': sig.nodeId || '',
      onclick: (e) => {
        e.stopPropagation()
        if (sig.nodeId) { selectedNodeId = sig.nodeId; builderMode = 'node'; renderMain(); renderSidebar(); }
      },
    },
      h('span', { class: 'nd', style: `background:${dirColor(sig.direction)}` }),
      sig.suggestedNode || '未归属',
      h('span', { class: 'ef', style: `color:${dirColor(sig.direction)}` },
        `${natIcon(sig.nature)} ${sig.themeTag || ''}`))

    /* Only the three fields persisted by the append-only review event are editable here. */
    const editor = h('div', { class: 'verdict-editor', 'data-editor': sig.id },
      h('p', { class: 'legacy-signal-edit-note' }, '只修订方向、性质与标签；目标节点沿用原事件关系。所有决定均以追加事件记录。'),
      h('div', { class: 'editor-row' },
        h('span', { class: 'label' }, '方向'),
        h('div', { class: 'dir-toggle' },
          ...['improving', 'declining', 'stable'].map((d) =>
            h('button', {
              type: 'button', disabled: isResolved,
              class: draft.direction === d ? 'active' : '',
              'data-dir': sig.id, 'data-dir-val': d,
              onclick: (e) => {
                e.stopPropagation()
                const dd = editorDraft.get(sig.id) || { ...draft }
                dd.direction = d
                editorDraft.set(sig.id, dd)
                renderMain()
                const ed = opts.mainStage.querySelector(`[data-editor="${sig.id}"]`)
                if (ed) ed.classList.add('open')
              },
            }, `${dirIcon(d)} ${DIRECTION_META[d].label}`)))),
      h('div', { class: 'editor-row' },
        h('span', { class: 'label' }, '性质'),
        h('div', { class: 'dir-toggle' },
          ...['quantitative', 'pivot', 'epistemic', 'structural'].map((n) =>
            h('button', {
              type: 'button', disabled: isResolved,
              class: draft.nature === n ? 'active' : '',
              'data-nature': sig.id, 'data-nature-val': n,
              onclick: (e) => {
                e.stopPropagation()
                const dd = editorDraft.get(sig.id) || { ...draft }
                dd.nature = n
                editorDraft.set(sig.id, dd)
                renderMain()
                const ed = opts.mainStage.querySelector(`[data-editor="${sig.id}"]`)
                if (ed) ed.classList.add('open')
              },
            }, `${natIcon(n)} ${NATURE_META[n].label}`)))),
      h('div', { class: 'editor-row' },
        h('span', { class: 'label' }, '标签'),
        h('input', {
          type: 'text', disabled: isResolved,
          value: draft.themeTag || '',
          placeholder: '主题标签，如：产能瓶颈',
          style: 'flex:1;font:inherit;padding:4px 8px;border-radius:6px;border:1px solid var(--line-2);background:var(--surface);color:var(--text)',
          oninput: (e) => {
            const dd = editorDraft.get(sig.id) || { ...draft }
            dd.themeTag = e.target.value
            editorDraft.set(sig.id, dd)
          },
        })),
      h('div', { class: 'editor-row' },
        h('span', { class: 'label' }, ''),
        h('button', {
          type: 'button', class: 'verdict-btn accept', disabled: isResolved,
          onclick: () => confirmEdit(sig),
        }, '✓ 确认修正')))

    const card = h('div', {
      class: 'signal',
      'data-type': sigDataType(sig.direction),
      'data-signal': sig.id,
      style: `animation-delay:${Math.min(i * 0.04, 0.4)}s`,
    },
      h('span', { class: 'signal-dot' }),
      h('div', { class: 'signal-card' },
        h('div', { class: 'signal-top' },
          /* 类型标签：显示 themeTag（三层） */
          h('span', { class: 'signal-type' }, sig.themeTag || '数据更新'),
          sig.source ? h('span', { class: 'signal-source' }, sig.source) : null,
          h('span', { class: 'spacer' }),
          h('span', { class: 'signal-time' }, fmtDate(sig.at))),
        h('div', { class: 'signal-title' }, sig.text),
        sig.payload?.text && sig.payload.text !== sig.text
          ? h('div', { class: 'signal-excerpt' }, String(sig.payload.text).slice(0, 200))
          : null,
        h('div', { class: 'signal-extract' },
          h('div', { class: 'label' }, '系统提取'),
          h('div', { class: 'text' },
            `${dirIcon(sig.direction)}${DIRECTION_META[sig.direction]?.label || ''} · ${natIcon(sig.nature)}${NATURE_META[sig.nature]?.label || ''} · ${sig.themeTag || ''}`,
            sig.confidence != null ? ` · 置信度 ${Math.round(sig.confidence * 100)}%` : '')),
        h('div', { class: 'signal-impacts' },
          h('span', { class: 'lead' }, '影响'),
          impactPill),
        h('div', { class: 'verdict' },
          h('span', { class: 'lead' }, '判决'),
          h('button', {
            type: 'button', disabled: isResolved,
            class: `verdict-btn accept${status === 'accepted' ? ' active' : ''}`,
            'data-v': sig.id, 'data-act': 'accept',
            onclick: (e) => { e.stopPropagation(); acceptSignal(sig) },
          }, '✓ 接受'),
          h('button', {
            type: 'button', disabled: isResolved,
            class: `${status === 'edited' ? 'active' : ''}`,
            'data-v': sig.id, 'data-act': 'edit',
            onclick: (e) => {
              e.stopPropagation()
              verdictState.set(sig.id, verdictState.get(sig.id) || 'pending')
              renderMain()
              const ed = opts.mainStage.querySelector(`[data-editor="${sig.id}"]`)
              if (ed) ed.classList.add('open')
              toast('展开修正选项')
            },
          }, '✎ 修正'),
          h('button', {
            type: 'button', disabled: isResolved,
            class: `verdict-btn reject${status === 'rejected' ? ' active' : ''}`,
            'data-v': sig.id, 'data-act': 'reject',
            onclick: (e) => { e.stopPropagation(); rejectSignal(sig) },
          }, '✕ 驳回'),
          h('span', { class: `verdict-status ${status}` },
            h('span', { class: 'dot' }),
            statusMap[status])),
        editor)
    )
    return card
  }

  /* 节点视图：1:1 对齐 demo renderNodeView */
  const renderNodeView = (nodeId) => {
    const nodes = projectedNodes(viewState.projection)
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return h('p', { class: 'chain-note' }, '节点不存在')
    const title = node.title || node.id
    const evolutions = buildNodeEvolution(nodeId)
    const latestEvo = evolutions[evolutions.length - 1]
    const overallDir = latestEvo?.direction || 'undetermined'
    const evidenceSummary = evidenceForNode(viewState, nodeId)
    const evidenceGroups = [
      { label: '支持', rows: evidenceSummary.supports },
      { label: '反驳', rows: evidenceSummary.against },
      { label: '双向关系', rows: evidenceSummary.both },
      { label: '方向未标注', rows: evidenceSummary.unclassified },
      { label: '已驳回 · 原记录保留', rows: evidenceSummary.rejected },
    ]
    const evidenceSection = h('section', { class: 'builder-node-evidence', 'aria-label': '可导航证据与来源' },
      h('div', { class: 'evolution-title' }, h('span', {}, '证据与来源'), h('span', { class: 'n' }, `${evidenceSummary.total} 条可导航证据`)),
      evidenceSummary.total ? h('div', { class: 'builder-node-evidence-groups' },
        ...evidenceGroups.filter((group) => group.rows.length).map((group) => h('div', { class: 'builder-node-evidence-group' },
          h('strong', {}, `${group.label} · ${group.rows.length}`),
          h('ul', {}, ...group.rows.map((row) => h('li', {},
            h('button', { type: 'button', class: 'builder-node-evidence-link', onclick: () => {
              openNodeDetail(theme, row.source, opts).catch((error) => toast(`无法打开证据：${error?.message || error}`, 'var(--red)'))
            } }, row.source.title || row.source.currentText || row.source.id),
            row.source.sourceLabel ? h('span', {}, row.source.sourceLabel) : null,
            row.relations.some((relation) => relation.pendingReview && relation.reviewDecision == null)
              ? h('span', { class: 'cog-flag' }, '待复核') : null))))))
        : h('p', { class: 'chain-note' }, '当前投影没有明确关联的证据节点；观点说明本身不是证据。'))
    return h('div', { style: 'display:contents' },
      h('div', { class: 'back-bar' },
        h('button', {
          type: 'button', class: 'back-btn', id: 'back-btn',
          onclick: () => { builderMode = 'inbox'; selectedNodeId = null; renderMain(); renderSidebar(); },
        }, h('span', { class: 'ar' }, '←'), ' 返回建设者工作台')),
      h('div', { class: 'node-view-head' },
        h('div', { class: 'node-title-row' },
          h('span', { class: 'node-title-dot', style: `background:${dirColor(overallDir)}` }),
          h('h1', { class: 'node-title' }, title),
          h('span', { class: 'node-trend', style: `margin-left:auto;color:${dirColor(overallDir)}` },
            latestEvo?.directionExplicit
              ? `${dirIcon(overallDir)} ${DIRECTION_META[overallDir].label} · ${latestEvo.themeTag || ''}`
              : `· ${latestEvo?.themeTag || '方向未评估'}`)),
        h('div', { class: 'node-current' }, node.currentText || node.title || ''),
        h('div', { class: 'node-stats' },
          h('span', { class: 'item' }, h('b', {}, String(evolutions.length)), ' 条相关事件'),
          h('span', { class: 'item' }, h('b', {}, String(evidenceSummary.total)), ' 条可导航证据'),
          h('span', { class: 'item' }, `${verifiedEvents.length} 条数据`),
          h('span', { class: 'item' }, '最近更新 ', h('b', {}, evolutions.length ? fmtDate(evolutions[evolutions.length - 1].at) : '—')))),
      h('div', { class: 'scroll' },
        h('div', { class: 'scroll-inner' },
          evidenceSection,
          h('div', { class: 'evolution-title' },
            h('span', {}, '证据与关系事件'),
            h('span', { class: 'n' }, `按时间排列 · ${evolutions.length} 条记录`)),
          h('div', { class: 'evolution' },
            ...evolutions.map((evo, i) => {
              const isLatest = i === evolutions.length - 1
              return h('div', {
                class: `evo-point${isLatest ? ' latest' : ''}`,
                style: `animation-delay:${i * 0.06}s`,
              },
                h('span', { class: 'evo-dot' }, h('span', {}, natIcon(evo.nature))),
                h('div', { class: 'evo-head' },
                  h('span', { class: 'evo-date' }, fmtDate(evo.at)),
                  h('span', { class: 'evo-tag', style: `color:${dirColor(evo.direction)}` }, evo.themeTag || ''),
                  isLatest ? h('span', { class: 'evo-current-flag' }, '当前') : null),
                h('div', { class: 'evo-state' }, evo.text),
                evo.source ? h('div', { class: 'evo-reason' },
                  h('div', { class: 'left' },
                    h('span', { class: 'lead' }, '因为'), evo.source)) : null)
            })))))
  }

  /* 从事件构建节点演化时间线 */
  const buildNodeEvolution = (nodeId) => {
    const evolutions = []
    for (const event of (verifiedEvents || [])) {
      const payload = event?.payload || {}
      const eid = payload.nodeId || payload.claimId || payload.targetId
      if (eid !== nodeId) continue
      const type = event?.type
      if (!['confidence.updated', 'evidence.appended', 'relation.declared'].includes(type)) continue
      const change = payload.change || {}
      evolutions.push({
        at: event?.at || event?.timestamp,
        direction: change.direction || (type === 'confidence.updated'
          ? ((payload.newConfidence ?? payload.after ?? 0) > (payload.oldConfidence ?? payload.before ?? 0) ? 'improving'
            : (payload.newConfidence ?? payload.after ?? 0) < (payload.oldConfidence ?? payload.before ?? 0) ? 'declining' : 'stable')
          : 'undetermined'),
        directionExplicit: ['improving', 'declining', 'stable'].includes(change.direction)
          || (type === 'confidence.updated' && Number.isFinite(Number(payload.newConfidence ?? payload.after))
            && Number.isFinite(Number(payload.oldConfidence ?? payload.before))),
        nature: change.nature || (type === 'relation.declared' ? 'structural'
          : type === 'evidence.appended' ? 'quantitative' : 'quantitative'),
        themeTag: change.themeTag || payload.themeTag || (type === 'confidence.updated' ? '置信度变化'
          : type === 'evidence.appended' ? '证据追加' : '关系事件'),
        text: payload.title || payload.text?.slice(0, 80) || type,
        source: payload.sourceLabel || payload.url || '',
      })
    }
    return evolutions.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))
  }

  /* External intake → extraction → mapping → explicit review. Nothing enters
     the theme projection until a recommendation is explicitly accepted. */
  const renderInboxView = () => {
    const savedQueue = builderInboxStateByTheme.get(theme.id) || {}
    let queueMode = savedQueue.mode === 'processed' ? 'processed' : 'pending'
    let selectedEntryId = savedQueue.entryId || null
    const wrap = h('div', { class: 'builder-intake' })
    const auditControls = h('div', { class: 'builder-audit-actions' },
      ...[opts.integrityBadge, opts.ledgerButton].filter(Boolean))
    const head = h('div', { class: 'inbox-head' },
      h('div', { class: 'builder-intake-heading' },
        h('p', { class: 'builder-intake-eyebrow' }, '建设者工作台'),
        h('div', { class: 'inbox-title' }, theme.name || '当前主题')),
      h('div', { class: 'inbox-sub' }, '外部来源先进入待审核；模型只提取原子陈述并提出映射建议。每项必须由你确认或驳回，才会追加主题事件。'),
      auditControls)
    const flow = h('div', { class: 'builder-flow-steps', 'aria-label': '建设者处理阶段' },
      ...['① 来源已摄入', '② 抽取原子陈述', '③ 映射到主题', '④ 变更前后预览', '⑤ 确认或驳回', '⑥ 事件追加与投影更新']
        .map((step, index) => h('span', { class: `builder-flow-step${index === 0 ? ' is-ready' : ''}` }, step)))
    const pendingTab = h('button', { type: 'button', class: 'builder-queue-tab', 'aria-pressed': 'true' }, '待处理')
    const processedTab = h('button', { type: 'button', class: 'builder-queue-tab', 'aria-pressed': 'false' }, '已处理')
    const addNode = h('button', { type: 'button', class: 'btn btn-sm builder-queue-add' }, '＋ 手工观点')
    const addManualOpinion = () => {
      if (opts.addNodeBtn?.disabled) { toast('当前账本暂不可追加节点', 'var(--text-2)'); return }
      opts.addNodeBtn?.click()
    }
    addNode.addEventListener('click', addManualOpinion)
    const openSourceCapture = () => {
      const overlay = h('div', { class: 'cog-modal-overlay' })
      const dialog = h('div', { class: 'cog-modal builder-source-capture', role: 'dialog', 'aria-modal': 'true', 'aria-label': '接入外部来源' })
      const titleInput = h('input', { class: 'txt', maxlength: '180', placeholder: '来源标题（选填）', 'aria-label': '来源标题' })
      const sourceInput = h('input', { class: 'txt', maxlength: '180', placeholder: '来源名称（选填）', 'aria-label': '来源名称' })
      const urlInput = h('input', { class: 'txt', type: 'url', placeholder: 'https://…（选填，仅作出处记录）', 'aria-label': '来源链接' })
      const bodyInput = h('textarea', { class: 'txt cog-modal-textarea', rows: '7', placeholder: '粘贴来源原文或可审核摘录（必填）', 'aria-label': '来源原文或摘录' })
      const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
      const close = () => overlay.remove()
      const save = h('button', { type: 'button', class: 'btn btn-primary' }, '保存到待处理')
      save.addEventListener('click', async () => {
        const text = bodyInput.value.trim()
        if (!text) { error.hidden = false; error.textContent = '请粘贴来源原文或摘录；不会只凭标题或 URL 生成建议。'; bodyInput.focus(); return }
        let sourceUrl = ''
        if (urlInput.value.trim()) {
          try {
            const parsed = new URL(urlInput.value.trim())
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http(s) 来源链接。')
            sourceUrl = parsed.href
          } catch (failure) { error.hidden = false; error.textContent = failure.message || '请输入有效的 http(s) 来源链接。'; urlInput.focus(); return }
        }
        save.disabled = true
        error.hidden = true
        const id = `manual-source-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
        const title = titleInput.value.trim() || text.replace(/\s+/g, ' ').slice(0, 90)
        const sourceLabel = sourceInput.value.trim() || (sourceUrl ? new URL(sourceUrl).host : '用户接入来源')
        try {
          if (typeof m.inboxUpsertItem !== 'function') throw new Error('当前客户端尚未提供只入待审队列的来源接口。')
          const result = await m.inboxUpsertItem({
            id, title, text, kind: 'external-source', extracted: false,
            extractedThemeId: theme.id, createdAt: new Date().toISOString(),
            provenance: { platform: '用户接入', sourceLabel, ...(sourceUrl ? { url: sourceUrl } : {}) },
          })
          if (result?.ok === false) throw new Error(result.error || '来源保存失败')
          queueMode = 'pending'
          selectedEntryId = `source:${id}`
          persistQueueState()
          toast('来源已放入待处理队列；主题投影未更改')
          close()
          await loadInbox()
        } catch (failure) {
          error.hidden = false
          error.textContent = failure?.message || String(failure)
          save.disabled = false
        }
      })
      dialog.append(
        h('div', { class: 'cog-modal-head' }, h('h3', { class: 'cog-modal-title' }, '接入外部来源'),
          h('button', { type: 'button', class: 'cog-modal-close', 'aria-label': '关闭', onclick: close }, '×')),
        h('p', { class: 'cog-modal-target' }, '原文/摘录只会进入待审核收件箱。此入口不会自动抓取 URL、创建观点或写入主题事实。'),
        titleInput, sourceInput, urlInput, bodyInput, error,
        h('div', { class: 'cog-modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, '取消'), save))
      overlay.append(dialog)
      overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close() })
      document.body.append(overlay)
      bodyInput.focus()
    }
    const addSource = h('button', { type: 'button', class: 'btn btn-sm builder-queue-source', onclick: openSourceCapture }, '＋ 接入外部来源')
    const queueList = h('div', { class: 'builder-queue-list', role: 'listbox', 'aria-label': '待处理来源、建议与旧账本信号', tabindex: '0' },
      h('p', { class: 'chain-note' }, '正在加载…'))
    const queue = h('aside', { class: 'builder-intake-queue', 'aria-label': '来源与建议队列' },
      h('div', { class: 'builder-queue-head' },
        h('div', { class: 'builder-queue-tabs', role: 'group', 'aria-label': '队列状态' }, pendingTab, processedTab),
        addSource, addNode),
      queueList)
    const detail = h('section', { class: 'builder-intake-review', 'aria-label': '来源与建议审核详情' },
      h('p', { class: 'chain-note' }, '选择一条来源或建议，查看其证据、映射目标与变更预览。'))
    const body = h('div', { class: 'builder-intake-body' }, queue, detail)
    wrap.append(head, flow, body)
    let currentItems = []
    const persistQueueState = () => builderInboxStateByTheme.set(theme.id, { mode: queueMode, entryId: selectedEntryId })
    const resolvedReviews = () => {
      const reviews = new Map()
      for (const event of verifiedEvents) {
        const payload = event.payload || {}
        if (event.type === 'signal.reviewed' && payload.signalEventId) reviews.set(payload.signalEventId, payload)
        else if (event.type === 'relation.declared' && payload.reviewOf) {
          reviews.set(payload.reviewOf, { decision: payload.reviewDecision, reason: payload.decisionReason, reviewEventId: event.id })
        }
      }
      return reviews
    }
    const buildEntries = (items) => buildWorkbenchEntries(items, buildSignals(), resolvedReviews(), verdictState)
    const entryTitle = (entry) => {
      if (entry.kind === 'legacy-signal') return entry.signal.text || `待复核事件 ${entry.signal.id}`
      const item = entry.item
      const sourceTitle = item.title || item.label?.title || item.provenance?.sourceLabel || item.provenance?.url || `来源 ${item.id}`
      if (entry.kind !== 'proposal') return sourceTitle
      const recommendation = entry.result.recommendation || {}
      if (entry.result.kind === 'new-proposition' || recommendation.kind === 'new-proposition') {
        return recommendation.title || entry.result.suggestedTitle || sourceTitle
      }
      const target = recommendation.propositionTitle || entry.result.proposition?.title || sourceTitle
      return recommendation.rel === 'supersedes' ? `修订 · ${target}` : `${recommendation.rel || '建议'} · ${target}`
    }
    const renderQueue = () => {
      const entries = buildEntries(currentItems)
      const visible = filterWorkbenchEntries(entries, queueMode)
      pendingTab.setAttribute('aria-pressed', String(queueMode === 'pending'))
      processedTab.setAttribute('aria-pressed', String(queueMode === 'processed'))
      pendingTab.classList.toggle('is-active', queueMode === 'pending')
      processedTab.classList.toggle('is-active', queueMode === 'processed')
      pendingTab.textContent = `待处理 · ${entries.filter((entry) => !entry.decision).length}`
      processedTab.textContent = `已处理 · ${entries.filter((entry) => Boolean(entry.decision)).length}`
      clear(queueList)
      if (!visible.length) {
        queueList.append(h('p', { class: 'builder-queue-empty' }, queueMode === 'processed'
          ? '这里会保留已确认或已驳回的建议。' : entries.length ? '当前没有待处理来源、建议或旧信号。' : '收件箱中暂无来源；可以接入一条来源，或手工录入观点。'))
        if (queueMode === 'pending' && !entries.length) queueList.append(h('div', { class: 'builder-empty-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: openSourceCapture }, '接入外部来源'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: addManualOpinion }, '手工录入观点')))
        selectedEntryId = null
        persistQueueState()
        renderSelected(null)
        return
      }
      let selected = visible.find((entry) => entry.id === selectedEntryId) || visible[0]
      selectedEntryId = selected.id
      persistQueueState()
      for (const entry of visible) {
        const item = entry.item || {}
        const label = entry.kind === 'legacy-signal' ? '历史事件 · 待复核'
          : entry.kind === 'proposal'
          ? entry.result.recommendation?.rel === 'supersedes' ? '修订建议'
            : entry.result.kind === 'new-proposition' ? '新节点' : '论证建议'
          : item.enginePipeline?.status === 'done' ? '模型建议' : '外部来源'
        const status = entry.decision === 'rejected' ? '已驳回' : entry.decision ? '已确认' : '待审核'
        const source = entry.kind === 'legacy-signal' ? entry.signal.source || '主题事件账本'
          : item.provenance?.sourceLabel || item.provenance?.platform || item.source || '来源未标注'
        const button = h('button', {
          type: 'button', class: `builder-queue-item${entry.id === selected.id ? ' is-selected' : ''}`,
          role: 'option', 'aria-selected': String(entry.id === selected.id), 'data-entry-id': entry.id,
          onclick: () => { selectedEntryId = entry.id; persistQueueState(); renderQueue() },
        },
        h('span', { class: 'builder-queue-item-top' }, h('span', { class: 'builder-queue-kind' }, label),
          h('span', { class: `builder-queue-status${entry.decision ? ' is-done' : ''}` }, status)),
        h('strong', { class: 'builder-queue-item-title' }, entryTitle(entry)),
        h('span', { class: 'builder-queue-item-source' }, source))
        queueList.append(button)
      }
      renderSelected(selected)
    }
    const setQueueMode = (mode) => {
      queueMode = mode
      selectedEntryId = null
      persistQueueState()
      renderQueue()
    }
    pendingTab.addEventListener('click', () => setQueueMode('pending'))
    processedTab.addEventListener('click', () => setQueueMode('processed'))
    const loadInbox = async () => {
      let items = []
      try {
        if (m.inboxList) {
          const r = await m.inboxList()
          items = Array.isArray(r) ? r : (r?.items || [])
        }
      } catch { /* 忽略 */ }
      currentItems = items
      const titleEl = head.querySelector('.inbox-title')
      if (titleEl && items.length) titleEl.append(h('span', { class: 'live' }))
      renderQueue()
    }
    const renderSelected = (entry) => {
      clear(detail)
      if (!entry) {
        detail.append(h('div', { class: 'builder-review-empty' },
          h('span', { class: 'builder-review-empty-mark', 'aria-hidden': 'true' }, '◌'),
          h('h2', {}, queueMode === 'processed' ? '尚无已处理建议' : '选择待处理项目'),
          h('p', {}, '确认前保持主题投影不变；每一项决定都保留为可回放事件。')))
        return
      }
      if (entry.kind === 'legacy-signal') {
        const signalIndex = buildSignals().findIndex((signal) => signal.id === entry.signal.id)
        const resolved = Boolean(entry.decision)
        const decisionLabel = entry.decision === 'rejected' ? '已驳回'
          : entry.decision === 'corrected' ? '已修订' : entry.decision ? '已确认' : '未决'
        detail.append(h('article', { class: 'builder-intake-card builder-legacy-signal' },
          h('header', { class: 'builder-intake-card-head' },
            h('div', {}, h('p', { class: 'builder-intake-kicker' }, resolved ? '历史账本信号 · 已处理' : '历史账本信号 · 仍待人工复核'),
              h('h2', {}, entry.signal.text || `待复核事件 ${entry.signal.id}`)),
            h('span', { class: 'builder-intake-state' }, decisionLabel)),
          h('p', { class: 'builder-legacy-note' }, resolved
            ? '原始信号与既有决定均保持不变；以下展示追加的审核决定，原事件可在审计账本查看。'
            : '原事件保持不变；确认、修订或驳回会追加 signal.reviewed 决定事件。'),
          h('dl', { class: 'builder-source-meta' },
            h('div', {}, h('dt', {}, '建议归属'), h('dd', {}, entry.signal.suggestedNode || '未归属')),
            h('div', {}, h('dt', {}, '来源'), h('dd', {}, entry.signal.source || '未记录')),
            h('div', {}, h('dt', {}, '事件 ID'), h('dd', {}, entry.signal.id))),
          renderSignal(entry.signal, signalIndex, entry.decision),
          h('button', { type: 'button', class: 'btn btn-sm builder-legacy-audit', onclick: () => {
            opts.openLedger?.()
            ledgerController?.showEvent(entry.signal.id)
          } }, '在审计账本查看原始事件')))
        return
      }
      detail.append(renderIntakeItem(entry.item, entry))
    }
    const renderIntakeItem = (item, entry) => {
      const provenance = item.provenance || {}
      const mapped = (item.extractedThemeId || item.themeId) === theme.id
      const pipelineReady = item.enginePipeline?.status === 'done'
      const decisionCount = (item.enginePipeline?.results || []).filter((result) => result.reviewDecision).length
      const title = item.title || item.label?.title || provenance.sourceLabel || provenance.url || `来源 ${item.id}`
      const card = h('article', { class: 'builder-intake-card', 'data-inbox-id': item.id || '' },
        h('header', { class: 'builder-intake-card-head' },
          h('div', {}, h('p', { class: 'builder-intake-kicker' }, `来源已摄入 · ${provenance.platform || item.label?.kind || '未标注来源'}`),
            h('h2', {}, entry?.kind === 'proposal' ? entryTitle(entry) : title)),
          h('span', { class: `builder-intake-state${pipelineReady ? ' is-ready' : ''}` }, entry?.decision === 'rejected' ? '建议已驳回'
            : entry?.decision ? '建议已确认' : pipelineReady ? `建议已生成 · ${decisionCount}/${item.enginePipeline.results?.length || 0} 已决定` : '来源待运行模型')),
        h('dl', { class: 'builder-source-meta' },
          h('div', {}, h('dt', {}, '来源时间'), h('dd', {}, provenance.publishedAt || provenance.sourceDate || '未记录')),
          h('div', {}, h('dt', {}, '系统摄入'), h('dd', {}, item.createdAt || item.capturedAt || '未记录')),
          provenance.fetchedAt ? h('div', {}, h('dt', {}, '抓取时间'), h('dd', {}, provenance.fetchedAt)) : null,
          provenance.url ? h('div', {}, h('dt', {}, '来源链接'), h('dd', {}, provenance.url)) : null),
        h('details', { class: 'builder-source-body' },
          h('summary', {}, '查看已摄入原文'),
          h('p', {}, String(item.text || '收件箱条目未保存原文。'))))
      if (item.lemmas?.length) {
        const extraction = h('section', { class: 'builder-extraction-preview' },
          h('strong', {}, `抽取候选 · ${item.lemmas.length} 条（尚非事实）`),
          h('ul', {}, ...item.lemmas.map((lemma) => h('li', {},
            h('span', { class: 'builder-candidate-type' }, lemma.type || '陈述'),
            h('span', {}, lemma.title || lemma.value || '未命名陈述'),
            lemma.timeWindow ? h('span', { class: 'builder-candidate-time' }, `适用时间 · ${lemma.timeWindow}`) : h('span', { class: 'builder-candidate-time is-unknown' }, '适用时间未注明')))))
        card.append(extraction)
      }
      const actions = h('div', { class: 'builder-intake-actions' })
      if (!mapped) {
        const mapButton = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, `映射到「${theme.name || '当前主题'}」`)
        mapButton.addEventListener('click', async () => {
          mapButton.disabled = true
          try {
            const result = await m.inboxSetTheme?.(item.id, theme.id)
            if (result?.ok === false) throw new Error(result.error || '映射未完成')
            toast('已更新收件箱条目的主题映射；尚未写入主题事实')
            await loadInbox()
          } catch (error) { toast(`映射失败：${error?.message || error}`, 'var(--red)'); mapButton.disabled = false }
        })
        actions.append(mapButton)
      } else {
        actions.append(h('span', { class: 'builder-mapped-label' }, `已映射到当前主题 · ${theme.name || ''}`))
        const engineHost = h('div', { class: 'builder-engine-host' })
        const reviewItem = entry?.kind === 'proposal'
          ? { ...item, enginePipeline: { ...item.enginePipeline, results: [entry.result] } }
          : item
        engineHost.append(renderEnginePipeline(reviewItem, {
          themeId: theme.id,
          projection: viewState.projection,
          onDone: (change) => {
            if (change?.kind === 'decision') {
              queueMode = 'processed'
              selectedEntryId = `proposal:${change.result?.proposalEventId}`
            }
            persistQueueState()
            opts.onChanged?.()
          },
        }))
        card.append(actions, engineHost)
        return card
      }
      card.append(actions)
      return card
    }
    loadInbox()
    return wrap
  }


  /* 渲染入口 */
  renderSidebar()
  renderMain()
  /* 处理从读者视图跳转过来的节点聚焦请求 */
  const jump = consumeBuilderJump(theme.id)
  if (jump?.nodeId) {
    selectedNodeId = jump.nodeId
    builderMode = 'node'
    renderMain()
    renderSidebar()
  }

  const eventJump = consumeChainEventJump(theme.id)
  if (eventJump?.eventId) {
    if (verifiedEvents.some((event) => event?.id === eventJump.eventId)) {
      opts.openLedger?.()
      ledgerController?.showEvent(eventJump.eventId)
    } else {
      toast('来源事件不在账本校验有效前缀中，无法定位。', 'var(--red)')
    }
  }

}

const firstAffectedNode = affectedNodeIdForEvent

/* ------------------------------------------------------------------ */
/* 左：追加式完整性账本（概念 01）                                      */
/* ------------------------------------------------------------------ */

const EVENT_KIND_LABEL = {
  'evidence.appended': '新增证据',
  'claim.created': '新增命题',
  'inference.created': '新增推断',
  'relation.declared': '关系声明',
  'correction.appended': '追加更正事件',
  'settlement.recorded': '结算记录',
  'node.archived': '归档',
  'node.restored': '追加恢复',
  'topic.linked': '主题关联',
}
const fmtAt = (at) => {
  const s = String(at || '')
  if (!s) return '时间未记录'
  const date = new Date(s)
  return Number.isNaN(date.getTime()) ? s.slice(0, 32)
    : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
/** 事件内容摘要（一行）。 */
function eventSummary(e, titleOf) {
  const p = e.payload || {}
  switch (e.type) {
    case 'correction.appended': {
      const t = titleOf?.(p.claimEventId || p.targetEventId || e.supersedes) || ''
      return `更正${t ? `「${t}」` : ''}：${p.oldValue || '—'} → ${p.newValue || '—'}${p.reason ? `（${p.reason}）` : ''}`
    }
    case 'relation.declared': {
      const rel = REL[p.rel] || {}
      const endpointLabel = (ep) => ep?.eventId ? (titleOf?.(ep.eventId) || '来源未解析')
        : ep?.ref?.title ? `引用名称（未解析）：${ep.ref.title}`
          : ep?.name ? `引用名称（未解析）：${ep.name}` : '来源未解析'
      const a = endpointLabel(p.from)
      const b = endpointLabel(p.to)
      if (p.reviewOf) {
        const decision = p.reviewDecision === 'confirmed' ? '确认' : '驳回'
        return `人工复核${decision}：${a} —${rel.label || p.rel}→ ${b}${p.decisionReason ? `（${p.decisionReason}）` : ''}`
      }
      return `${a} —${rel.label || p.rel}→ ${b}${p.reviewStatus === 'pending-review' || p.rel === 'derives' ? '（待确认）' : ''}`
    }
    case 'settlement.recorded':
      return p.correct === false ? '判定为错误' : p.correct === true ? '判定为正确' : '已结算'
    case 'evidence.appended':
      return String(p.text || p.reason || p.title || '').slice(0, 60) || '证据追加'
    case 'node.archived':
      return `归档「${p.title || titleOf?.(p.targetEventId) || '未命名节点'}」${p.reason ? ` · ${p.reason}` : ''}`
    case 'node.restored':
      return `恢复「${p.title || titleOf?.(p.restoredArchiveEventId) || '未命名节点'}」${p.reason ? ` · ${p.reason}` : ''}`
    default:
      return String(p.title || p.coreInfo || p.text || '').slice(0, 60)
  }
}

/** 追加式完整性账本面板：事件序列只增不改，更正追加新事件。 */
function integrityText(integrity) {
  if (integrity?.ok) return `校验通过 · ${integrity.count} 条事件`
  const seq = Number.isInteger(integrity?.index) ? `第 ${integrity.index + 1} 条` : '账本'
  return `校验失败 · ${seq} · ${integrity?.reason || '格式不可读'} · 仅投影已验证前缀 ${integrity?.lastValidSeq || 0} 条`
}

function eventObjectLabel(e, events, byId) {
  const p = e.payload || {}
  const titleOf = (id) => {
    const target = byId.get(id)
    const tp = target?.payload || {}
    return String(tp.title || tp.coreInfo || tp.text || tp.legacySource?.label || '').trim()
  }
  if (e.type === 'relation.declared') {
    const original = p.reviewOf ? byId.get(p.reviewOf) : e
    const relationPayload = original?.payload || p
    const endpoint = (ep) => ep?.eventId ? (titleOf(ep.eventId) || '来源未解析')
      : ep?.ref?.title ? `引用名称（未解析）：${ep.ref.title}`
        : ep?.name ? `引用名称（未解析）：${ep.name}` : '来源未解析'
    return `${endpoint(relationPayload.from)} ↔ ${endpoint(relationPayload.to)}`
  }
  if (e.type === 'correction.appended') return titleOf(e.supersedes) || '观点或问题'
  if (['node.archived', 'node.restored', 'settlement.recorded'].includes(e.type)) {
    const result = resolveEventReference(events, p.sourceRef)
    return result.status === 'resolved' ? (result.subjectTitle || '未命名对象') : '来源未解析'
  }
  const direct = p.title || p.coreInfo || p.text || p.legacySource?.label
  if (direct) return String(direct).replace(/\s+/g, ' ').trim().slice(0, 90)
  if (p.sourceRef) {
    const result = resolveEventReference(events, p.sourceRef)
    return result.status === 'resolved' ? (result.subjectTitle || '未命名对象') : '来源未解析'
  }
  return '未命名对象'
}

function eventSourceLabel(e, events) {
  const p = e.payload || {}
  if (p.legacySource) return `历史来源元数据 · 未核验（${String(p.legacySource.label || p.legacySource.kind || '历史来源')}）`
  if (p.sourceLabel) return `来源声明 · 未核验（${String(p.sourceLabel)}）`
  if (p.sourceKind === 'relation-review') return '人工复核决定'
  const evidenceRef = Array.isArray(p.evidenceRefs) ? p.evidenceRefs.find((ref) => ref?.title || ref?.url) : null
  if (evidenceRef) return `引用记录 · 未核实（${String(evidenceRef.title || evidenceRef.url)}）`
  const kindLabels = {
    'legacy-node-source': '旧节点来源迁移',
    'segment-changeLog': '主题更新记录',
    'segment-evidenceRef': '主题中已保存的引用',
    'segment-affects': '旧主题关系（待确认）',
    'segment-mergedFrom': '旧主题合并记录',
    segment: '主题观点',
    mount: '收件箱挂载',
    'manual-evidence': '手动添加的证据',
    'user-declared-relation': '手动声明的关系',
  }
  if (kindLabels[p.sourceKind]) return `记录类别：${kindLabels[p.sourceKind]} · 来源真实性未核验`
  if (p.sourceRef) {
    const result = resolveEventReference(events, p.sourceRef)
    if (result.status === 'resolved') return `引用已解析到「${result.subjectTitle || '未命名对象'}」· 来源真实性未核验`
    return '来源未解析'
  }
  return '未记录来源'
}

function copyLedgerReference(value, label) {
  if (!value) return
  if (!navigator.clipboard?.writeText) { toast('当前环境不支持复制到剪贴板', 'var(--red)'); return }
  navigator.clipboard.writeText(String(value))
    .then(() => toast(`已复制${label}`))
    .catch(() => toast('复制失败，请检查系统剪贴板权限', 'var(--red)'))
}

function renderLedgerPanel(pane, theme, events, integrity, handlers = {}) {
  clear(pane)
  const integrityBox = h('div', {
    class: `cog-integrity ${integrity?.ok ? 'is-ok' : 'is-error'}`,
    role: integrity?.ok ? 'status' : 'alert', 'aria-live': 'polite',
  }, integrityText(integrity))
  const verifyButton = h('button', {
    type: 'button', class: 'btn cog-verify-btn',
      onclick: async () => {
        verifyButton.disabled = true
        integrityBox.textContent = '正在重新校验…'
        try {
          const result = await m.chainVerify(theme.id)
          const checked = result?.integrity
          integrityBox.setAttribute('class', `cog-integrity ${checked?.ok ? 'is-ok' : 'is-error'}`)
          integrityBox.setAttribute('role', checked?.ok ? 'status' : 'alert')
          integrityBox.textContent = integrityText(checked)
          handlers.onIntegrityChange?.(checked,
            Number.isSafeInteger(checked?.lastValidSeq) ? checked.lastValidSeq
              : Number.isSafeInteger(checked?.count) ? checked.count : events.length,
            events.length)
        } catch (error) {
          integrityBox.setAttribute('class', 'cog-integrity is-error')
          integrityBox.setAttribute('role', 'alert')
          integrityBox.textContent = `校验失败 · ${error?.message || error}`
          handlers.onIntegrityChange?.({ ok: false, reason: error?.message || String(error) }, 0, events.length)
        } finally { verifyButton.disabled = false }
    },
  }, '重新校验')
  const pageLabel = h('span', { class: 'cog-page-label', 'aria-live': 'polite' })
  const ordered = events.map((record, index) => ({ record, index })).sort((a, b) => {
    const ax = Number.isSafeInteger(a.record?.seq) ? a.record.seq : Number.MAX_SAFE_INTEGER
    const bx = Number.isSafeInteger(b.record?.seq) ? b.record.seq : Number.MAX_SAFE_INTEGER
    return ax - bx || a.index - b.index
  })
  const pageCount = Math.max(1, Math.ceil(ordered.length / LEDGER_PAGE_SIZE))
  let page = Math.min(pageCount, Math.max(1, ledgerPageByTheme.get(theme.id) || pageCount))
  const list = h('div', { class: 'cog-ledger-list', 'aria-live': 'polite' })
  const prev = h('button', { type: 'button', class: 'btn cog-page-btn', onclick: () => setPage(page - 1) }, '更早')
  const next = h('button', { type: 'button', class: 'btn cog-page-btn', onclick: () => setPage(page + 1) }, '较新')
  const pagination = h('div', { class: 'cog-pagination', 'aria-label': '账本分页' }, prev, pageLabel, next)
  pane.append(
    h('div', { class: 'cog-ledger-head' },
      h('span', { class: 'cog-ledger-num' }, '01'),
      h('span', { class: 'cog-ledger-title', id: handlers.titleId || '' }, '账本 · 追加式审计记录'),
      h('span', { class: 'cog-ledger-badge' }, '只追加'),
      h('button', { type: 'button', class: 'btn cog-ledger-close', 'aria-label': '关闭账本抽屉', onclick: handlers.onClose }, '关闭')),
    h('p', { class: 'cog-ledger-sub' }, '完整时间顺序保留；窗口分页避免一次性渲染大账本。更正、归档、恢复与复核均追加新事件，不覆盖旧记录。'),
    h('div', { class: 'cog-integrity-row' }, integrityBox, verifyButton),
    handlers.replayControls || null,
    h('p', { class: 'cog-ledger-colhead' }, '按 append sequence 升序 · 每页最多 40 条'),
  )
  if (!events.length) {
    pane.append(h('div', { class: 'cog-ledger-empty' }, '还没有账本事件。创建观点或补充证据后，操作会按顺序记录在这里。'))
    return { syncReplay: () => {}, showEvent: () => {} }
  }

  const verifiedEvents = handlers.verifiedEvents || verifiedLedgerPrefix(events, integrity)
  const reviewedBy = new Map(verifiedEvents.filter((event) => event?.payload?.reviewOf)
    .map((event) => [event.payload.reviewOf, event]))

  let currentViewState = handlers.initialState
  function setPage(nextPage) {
    page = Math.max(1, Math.min(pageCount, Math.floor(nextPage)))
    ledgerPageByTheme.set(theme.id, page)
    renderPage(currentViewState)
  }

  function renderPage(viewState = currentViewState) {
    currentViewState = viewState
    const visibleEvents = eventsThroughSequence(events, integrity, viewState?.selectedSeq)
    const byId = new Map(visibleEvents.filter((x) => x && typeof x === 'object').map((x) => [x.id, x]))
    const titleOf = (eventId) => {
      const e = byId.get(eventId)
      return e ? String(e.payload?.title || e.payload?.coreInfo || e.payload?.text || e.payload?.legacySource?.label || '').slice(0, 80) : ''
    }
    clear(list)
    const pageRows = paginate(ordered, page, LEDGER_PAGE_SIZE)
    page = pageRows.page
    const first = pageRows.total ? pageRows.start + 1 : 0
    pageLabel.textContent = `${first}–${pageRows.end} / ${pageRows.total} 条 · 第 ${pageRows.page} / ${pageRows.pages} 页`
    prev.disabled = page <= 1
    next.disabled = page >= pageRows.pages
    for (const item of pageRows.items) {
      const raw = item.record
      const e = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : { id: `invalid-${item.index}`, seq: null, type: 'invalid', at: '', actor: '', payload: { raw: String(raw) }, hash: '', prevHash: '' }
      const isInvalid = !e.id || !e.type || !Number.isSafeInteger(e.seq) || !e.hash
      const isCorrection = e.type === 'correction.appended'
      const isReviewEvent = e.type === 'relation.declared' && !!e.payload?.reviewOf
      const needsHumanReview = e.payload?.reviewStatus === 'pending-review' || e.payload?.rel === 'derives'
      const isPendingReview = e.type === 'relation.declared' && needsHumanReview && !isReviewEvent
      const isFirst = e.seq === 1
      const kindLabel = isInvalid ? '无法解析的事件记录' : isReviewEvent ? '关系复核决定'
        : (isFirst ? '初始记录' : (EVENT_KIND_LABEL[e.type] || '未识别事件'))
      const superseded = isCorrection && e.supersedes ? byId.get(e.supersedes) : null
      const verification = integrity?.ok ? '已校验'
        : Number.isInteger(integrity?.index) && item.index < integrity.index ? '前缀已校验'
          : Number.isInteger(integrity?.index) && item.index === integrity.index ? '校验失败' : '未校验'
      const verificationClass = verification === '校验失败' ? 'is-error' : verification === '未校验' ? 'is-pending' : 'is-ok'
      const actor = ACTOR_LABEL[e.actor] || e.actor || '未记录'
      const sourceLabel = eventSourceLabel(e, visibleEvents)
      const objectLabel = eventObjectLabel(e, visibleEvents, byId)
      const eventId = typeof e.id === 'string' ? e.id : ''
      const sourceRef = typeof e.payload?.sourceRef === 'string' ? e.payload.sourceRef : ''
      const afterReplay = viewState?.selectedSeq != null && Number.isSafeInteger(e.seq) && e.seq > viewState.selectedSeq
      const rawReviewDecision = isPendingReview ? reviewedBy.get(e.id) : null
      const reviewDecision = rawReviewDecision && (viewState?.selectedSeq == null || rawReviewDecision.seq <= viewState.selectedSeq)
        ? rawReviewDecision : null
      const reviewText = reviewDecision
        ? `已${reviewDecision.payload.reviewDecision === 'confirmed' ? '确认' : '驳回'} · ${ACTOR_LABEL[reviewDecision.actor] || reviewDecision.actor || '未记录'} · ${fmtAt(reviewDecision.at) || '时间未记录'} · ${reviewDecision.payload.decisionReason || '未填写理由'}`
        : isPendingReview ? '待人工复核；在明确决定前，不作为已确认关系展示。' : ''
      const focusButton = h('button', {
        type: 'button', class: 'btn cog-event-focus',
        disabled: isInvalid || verification === '校验失败' || verification === '未校验',
        'aria-label': `⌖ 在图中定位第 ${Number.isSafeInteger(e.seq) ? e.seq : item.index + 1} 条事件`,
        onclick: () => handlers.onFocusEvent?.(e),
      }, h('span', { 'aria-hidden': 'true' }, '⌖'), h('span', {}, '在图中定位'))
      const disclosure = h('details', { class: 'cog-ev-disclosure' },
        h('summary', { class: 'cog-ev-summary', title: compactEventSummary(e) },
          h('span', { class: `cog-ev-dot${isCorrection || isReviewEvent ? ' orange' : ''}`, 'aria-hidden': 'true' }),
          h('span', { class: 'cog-ev-summary-text' }, isInvalid
            ? `记录 ${item.index + 1} · 无法解析的事件记录` : compactEventSummary(e))),
        h('div', { class: 'cog-ev-expanded' },
          h('div', { class: 'cog-ev-meta' },
            h('span', { class: 'cog-ev-at' }, fmtAt(e.at) || '时间未记录'),
            h('span', { class: 'cog-ev-kind' }, isFirst ? '初始记录' : kindLabel),
            afterReplay ? h('span', { class: 'cog-ev-future-tag' }, '未纳入当前回放') : null),
          h('div', { class: 'cog-ev-readable' },
          h('div', { class: 'cog-ev-readable-row' }, h('span', { class: 'cog-ev-readable-label' }, '对象'), h('span', { class: 'cog-ev-readable-value' }, objectLabel)),
          h('div', { class: 'cog-ev-readable-row' }, h('span', { class: 'cog-ev-readable-label' }, '变化'), h('span', { class: 'cog-ev-readable-value' }, eventSummary(e, titleOf) || '未记录摘要')),
          h('div', { class: 'cog-ev-readable-row' }, h('span', { class: 'cog-ev-readable-label' }, '操作者'), h('span', { class: 'cog-ev-readable-value' }, actor)),
          h('div', { class: 'cog-ev-readable-row' }, h('span', { class: 'cog-ev-readable-label' }, '来源'), h('span', { class: `cog-ev-readable-value${sourceLabel === '来源未解析' ? ' is-unresolved' : ''}` }, sourceLabel)),
          reviewText ? h('div', { class: 'cog-review-status', role: 'status' }, reviewText) : null),
          isPendingReview && !reviewDecision && viewState?.selectedSeq == null && integrity?.ok
            ? renderReviewControls(theme, e, handlers.onChanged) : null,
          h('details', { class: 'cog-ev-technical' },
          h('summary', {}, '技术详情 · 原始 ID、引用与哈希'),
          h('div', { class: 'cog-ev-hashes' },
            h('div', { class: 'cog-ev-hashrow' },
              h('span', { class: 'cog-ev-hk' }, '事件 ID'), h('span', { class: 'cog-ev-hv' }, eventId || '不可用'),
              eventId ? h('button', { type: 'button', class: 'cog-copy-btn', onclick: () => copyLedgerReference(eventId, '事件 ID') }, '复制') : null),
            h('div', { class: 'cog-ev-hashrow' },
              h('span', { class: 'cog-ev-hk' }, '来源引用'), h('span', { class: 'cog-ev-hv' }, sourceRef || '未记录'),
              sourceRef ? h('button', { type: 'button', class: 'cog-copy-btn', onclick: () => copyLedgerReference(sourceRef, '来源引用') }, '复制') : null),
            h('div', { class: 'cog-ev-hashrow' },
              h('span', { class: 'cog-ev-hk' }, '事件类型'), h('span', { class: 'cog-ev-hv' }, String(e.type || '未记录'))),
            h('div', { class: 'cog-ev-hashrow' },
              h('span', { class: 'cog-ev-hk' }, '前序哈希'), h('span', { class: 'cog-ev-hv' }, isFirst ? 'GENESIS · 起始' : String(e.prevHash || '不可用'))),
            h('div', { class: 'cog-ev-hashrow' },
              h('span', { class: 'cog-ev-hk' }, '本条哈希'), h('span', { class: 'cog-ev-hv' }, e.hash ? `sha256 · ${e.hash}` : '不可用')),
            isCorrection ? h('div', { class: 'cog-ev-hashrow' },
              h('span', { class: 'cog-ev-hk' }, '取代声明'), h('span', { class: 'cog-ev-hv' }, superseded ? `第 ${superseded.seq} 条事件` : '目标未解析')) : null,
            isReviewEvent ? h('div', { class: 'cog-ev-hashrow' },
              h('span', { class: 'cog-ev-hk' }, '复核对象'), h('span', { class: 'cog-ev-hv' }, byId.has(e.payload.reviewOf) ? `第 ${byId.get(e.payload.reviewOf).seq} 条事件` : '目标未解析')) : null,
            isInvalid ? h('pre', { class: 'cog-ev-invalid-raw' }, JSON.stringify(raw, null, 2) || String(raw)) : null,
          ))))
      const card = h('article', {
        class: `cog-ev${isCorrection ? ' is-correction' : ''}${isInvalid ? ' is-invalid' : ''}${afterReplay ? ' is-future' : ''}`,
        'data-event-id': eventId, tabindex: '-1',
      },
        h('div', { class: 'cog-ev-row' },
          disclosure,
          h('span', { class: `cog-ev-validation ${verificationClass}`, role: verification === '校验失败' ? 'alert' : 'status' }, verification),
          focusButton))
      list.append(card)
    }
  }

  pane.append(pagination, list, pagination,
    h('div', { class: 'cog-ledger-foot' },
      h('strong', {}, '更正 ≠ 覆盖'),
      ' — 被取代的版本仍保留；新事件追加并声明取代关系，当前效力切换，历史不改写。',
      h('br'),
      '校验边界：哈希链可帮助发现未同步重算后续哈希的修改或意外损坏；本地可控攻击者仍可重写整链，本版本未提供签名或远端锚定。完整性校验不代表事件内容为真。'))
  renderPage(handlers.initialState)

  return {
    syncReplay(viewState) {
      currentViewState = viewState
      renderPage(viewState)
    },
    showEvent(id) {
      const index = ordered.findIndex((item) => item.record?.id === id)
      if (index < 0) return
      setPage(Math.floor(index / LEDGER_PAGE_SIZE) + 1)
      requestAnimationFrame(() => {
        const target = list.querySelector(`[data-event-id="${CSS.escape(String(id))}"]`)
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        target?.focus({ preventScroll: true })
      })
    },
  }
}

function renderReviewControls(theme, event, onChanged) {
  const reason = h('textarea', {
    class: 'txt cog-review-reason', rows: '2', required: true,
    placeholder: '写明你确认/驳回这条关系的理由', 'aria-label': '关系复核理由',
  })
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const submit = async (decision, button) => {
    if (!reason.value.trim()) { error.hidden = false; error.textContent = '请先填写复核理由。'; reason.focus(); return }
    error.hidden = true
    button.disabled = true
    try {
      const result = await m.chainReviewRelation(theme.id, event.id, decision, reason.value.trim())
      if (result?.ok === false) throw new Error(result.error || '决定未写入')
      toast(decision === 'confirmed' ? '已追加确认决定' : '已追加驳回决定')
      onChanged?.()
    } catch (failure) {
      error.hidden = false
      error.textContent = failure?.message || String(failure)
      button.disabled = false
    }
  }
  const confirm = h('button', { type: 'button', class: 'btn btn-primary', onclick: (event) => submit('confirmed', event.currentTarget) }, '确认关系')
  const reject = h('button', { type: 'button', class: 'btn', onclick: (event) => submit('rejected', event.currentTarget) }, '驳回关系')
  return h('details', { class: 'cog-review-controls' },
    h('summary', {}, '人工复核 · 选择确认或驳回'),
    h('p', { class: 'cog-entry-note' }, '推断关系未获确认前不会显示为已证实；每项决定都会作为新事件追加，原声明保留。'),
    reason, error, h('div', { class: 'cog-review-actions' }, confirm, reject))
}

function renderGraphTools(stage, theme, proj, opts, handlers = {}) {
  const graphCanvas = h('div', { class: 'cog-graph-canvas' })
  const pointSummary = h('div', { class: 'cog-point-inspector-summary' })
  const focusRegion = h('section', { class: 'cog-local-focus', 'aria-label': '所选节点的证据与关系', hidden: true })
  const historyBody = h('div', { class: 'cog-inspector-disclosure-body' })
  const historyDisclosure = h('details', { class: 'cog-inspector-disclosure', hidden: true },
    h('summary', { 'data-inspector-history-label': '' }, '节点历史与事件时间线'), historyBody)
  const referencesBody = h('div', { class: 'cog-inspector-disclosure-body' })
  const referencesDisclosure = h('details', { class: 'cog-inspector-disclosure', hidden: true },
    h('summary', {}, '来源引用'), referencesBody)
  const pointInspector = h('aside', { class: 'cog-point-inspector', 'aria-label': '所选观点详情', 'aria-live': 'polite' },
    pointSummary, focusRegion, historyDisclosure, referencesDisclosure)
  const focusLabel = h('span', { class: 'cog-focus-label', 'aria-live': 'polite' }, '选择一个观点以展开其证据和关系')
  const focusDetails = h('button', { type: 'button', class: 'btn cog-focus-detail', hidden: true }, '查看详情')
  const clearFocus = h('button', { type: 'button', class: 'btn cog-focus-clear', hidden: true }, '清除聚焦')
  const searchResultsId = `${opts.ledgerTitleId || 'cog-ledger'}-search-results`
  const sliderId = `${opts.ledgerTitleId || 'cog-ledger'}-slider`
  const nodeSearch = h('input', { class: 'txt cog-node-search', type: 'search', placeholder: '搜索节点、旧名或说明', 'aria-label': '搜索所有节点、旧名或说明', 'aria-controls': searchResultsId })
  const searchButton = h('button', { type: 'button', class: 'btn', onclick: focusBySearch }, '定位节点')
  const clearSearch = h('button', { type: 'button', class: 'btn cog-search-clear', disabled: true, onclick: resetSearch }, '清除')
  const searchError = h('span', { class: 'cog-search-error', role: 'status', 'aria-live': 'polite' })
  const searchResults = h('div', { id: searchResultsId, class: 'cog-search-results', role: 'listbox', 'aria-label': '图谱搜索结果', hidden: true })
  const searchPageLabel = h('span', { class: 'cog-search-page-label', role: 'status', 'aria-live': 'polite' })
  const previousSearchPage = h('button', { type: 'button', class: 'btn cog-search-page-button', onclick: () => changeSearchPage(-1) }, '上组结果')
  const nextSearchPage = h('button', { type: 'button', class: 'btn cog-search-page-button', onclick: () => changeSearchPage(1) }, '下组结果')
  const searchPager = h('div', { class: 'cog-search-pager', role: 'group', 'aria-label': '搜索结果分页', hidden: true }, previousSearchPage, searchPageLabel, nextSearchPage)
  const verifiedTimelineEvents = handlers.verifiedEvents || []
  const timelinePoints = buildDensityTimeline(verifiedTimelineEvents)
  const sliderLabel = h('label', { class: 'cog-time-slider-label', for: sliderId }, '主题历史时间轴')
  const maxSeq = Math.max(0, handlers.validPrefixSeq || 0)
  const timeSlider = h('input', {
    id: sliderId, class: 'cog-time-slider', type: 'range', min: '0', max: '100', step: '1',
    value: '100', disabled: timelinePoints.length < 2, 'aria-label': '按日期回放已校验的主题网络事件',
  })
  const timePreview = h('span', { class: 'cog-time-preview', 'aria-live': 'polite' })
  const liveButton = h('button', { type: 'button', class: 'btn cog-live-button', hidden: true, onclick: () => handlers.onLive?.() }, '退出历史回放')
  const timeSummary = h('span', { class: 'cog-time-summary', role: 'status', 'aria-live': 'polite' },
    timelinePoints.length ? '选择日期刻度查看该时点以来的变化。' : '暂无已校验事件可回放。')
  const compareButton = h('button', { type: 'button', class: 'btn cog-time-compare', hidden: true, 'aria-pressed': 'false' }, '与当前对比')
  const tickRail = h('div', { class: 'cog-time-ticks', role: 'group', 'aria-label': '按事件日期与密度选择历史状态' })
  for (const point of timelinePoints) {
    const tick = h('button', {
      type: 'button', class: `cog-time-tick density-${point.density}`,
      style: { left: `${point.position}%` },
      'data-seq': String(point.seq),
      title: `${point.date} · ${point.count} 条已校验事件`,
      'aria-label': `${point.date}，${point.count} 条已校验事件，回放到第 ${point.seq} 条`,
      onclick: () => handlers.onReplay?.(point.seq),
    })
    tickRail.append(tick)
  }
  const timeControls = h('section', { class: 'cog-time-controls', 'aria-label': '主题历史时间轴' },
    h('div', { class: 'cog-time-head' }, sliderLabel, compareButton, liveButton),
    timeSlider, tickRail, timePreview, timeSummary)
  let replayTimer = null
  const pointAtPosition = (position) => {
    if (!timelinePoints.length) return null
    let selected = timelinePoints[0]
    for (const point of timelinePoints) {
      if (point.position > position) break
      selected = point
    }
    return selected
  }
  const replayFromSlider = (commit = false) => {
    const point = pointAtPosition(Number(timeSlider.value))
    if (!point) return
    timePreview.textContent = `${point.date} · ${point.count} 条事件 · v${point.seq}`
    clearTimeout(replayTimer)
    if (commit) handlers.onReplay?.(point.seq)
    else replayTimer = setTimeout(() => handlers.onReplay?.(point.seq), 90)
  }
  timeSlider.addEventListener('input', () => replayFromSlider(false))
  timeSlider.addEventListener('change', () => replayFromSlider(true))
  const typeFilter = h('select', { class: 'txt cog-node-filter', 'aria-label': '按节点类型筛选' },
    h('option', { value: 'all' }, '全部类型'),
    ...NETWORK_NODE_TYPES.map((type) => h('option', { value: type }, NODE_TYPE_META[type].label)))
  const statusFilter = h('select', { class: 'txt cog-node-filter', 'aria-label': '按节点状态筛选' },
    h('option', { value: 'all' }, '全部状态'),
    ...['pending', 'verified', 'disputed', 'invalidated', 'archived'].map((status) => h('option', { value: status }, NODE_STATUS_LABEL[status])))
  const filterBar = h('div', { class: 'cog-network-filters', role: 'group', 'aria-label': '网络筛选' }, typeFilter, statusFilter)
  const guidanceId = `${opts.ledgerTitleId || 'cog-ledger'}-evidence-guidance`
  const addNode = h('button', { type: 'button', class: 'btn btn-primary', 'aria-describedby': guidanceId, onclick: () => openEntryDialog(theme, proj, 'node', opts) }, '＋ 添加节点')
  const addEvidence = h('button', { type: 'button', class: 'btn', 'aria-describedby': guidanceId, onclick: () => openEntryDialog(theme, proj, 'evidence', opts) }, '补充证据')
  const evidenceGuidance = h('span', { id: guidanceId, class: 'cog-write-guidance', role: 'status', 'aria-live': 'polite' })
  const help = h('details', { class: 'cog-graph-help' },
    h('summary', {}, '网络范围、关系与校验说明'),
    h('div', { class: 'cog-graph-help-body' },
      h('p', {}, '主题只限定网络范围，不是节点或起点；节点仅为概念、对象、事件、观点、证据。搜索与类型/状态筛选帮助在较大主题中定位记录。'),
      h('p', {}, '支持、推导、反驳是有方向的论证关系；归属、影响、依赖、时间关联、相关是弱关联，不表示论证。待确认关系须由用户明确确认或驳回。'),
      h('p', {}, '底部时间轴从完整性校验通过的事件前缀重放同一张网络；它只读，节点位置固定。完整性校验只说明事件链一致，不代表记录内容为真。')))
  const graphLegend = renderLegend()
  const graphToolbar = h('div', { class: 'cog-graph-toolbar' },
    h('div', { class: 'cog-graph-intro' },
      h('div', { class: 'cog-graph-title-line' }, h('span', { class: 'cog-ledger-num cog-graph-num' }, '网络'), h('div', { class: 'cog-graph-title' }, '主题认知网络')),
      h('p', { class: 'cog-graph-caption' }, '关系随主题和时间演变；不预设阅读路线、中心节点或结论。')),
    h('div', { class: 'cog-graph-actions' }, addNode, addEvidence, evidenceGuidance))
  /* 搜索与筛选收进折叠：默认只呈现网络本体，复杂度是用户要来的。 */
  const searchTools = h('details', { class: 'cog-graph-tools' },
    h('summary', {}, '搜索与筛选'),
    h('div', { class: 'cog-graph-tools-body' },
      h('div', { class: 'cog-search-row' }, nodeSearch, searchButton, clearSearch),
      filterBar))
  const graphMain = h('div', { class: 'cog-graph-main' },
    h('div', { class: 'cog-focus-bar' }, focusLabel,
      h('div', { class: 'cog-focus-actions' }, focusDetails, clearFocus)),
    searchTools, searchResults, searchPager, searchError,
    graphCanvas,
    h('details', { class: 'cog-graph-legend-wrap' }, h('summary', {}, '图例'), graphLegend),
    help,
    h('details', { class: 'cog-graph-time-wrap' }, h('summary', {}, '时间轴'), timeControls))
  stage.append(graphToolbar, h('div', { class: 'cog-workspace-grid' }, graphMain, pointInspector))
  let currentView = { projection: proj, selectedSeq: null, events: [] }
  let currentFocus = null
  let compareCurrent = false
  const networkLayout = layoutThemeNetwork(projectedNodes(proj), proj.allEdges || proj.edges || [], 1120)
  let searchMatches = []
  let searchPage = 1
  let previousSearchQuery = ''
  for (const filter of [typeFilter, statusFilter]) filter.addEventListener('change', () => render(currentView, currentFocus))
  compareButton.onclick = () => {
    compareCurrent = !compareCurrent
    compareButton.setAttribute('aria-pressed', String(compareCurrent))
    compareButton.textContent = compareCurrent ? '隐藏当前对比' : '与当前对比'
    render(currentView, currentFocus)
  }
  function changeSearchPage(delta, focusFirst = false) {
    const pageCount = Math.max(1, Math.ceil(searchMatches.length / SEARCH_RESULTS_PAGE_SIZE))
    searchPage = Math.max(1, Math.min(pageCount, searchPage + delta))
    renderSearchResults()
    if (focusFirst) searchResults.querySelector('.cog-search-result')?.focus()
  }
  const chooseSearchResult = (node) => {
    if (!node) return
    searchError.textContent = ''
    searchResults.hidden = true
    searchPager.hidden = true
    render(currentView, node.id)
  }
  const renderSearchResults = () => {
    const query = nodeSearch.value.trim()
    if (query !== previousSearchQuery) {
      searchPage = 1
      previousSearchQuery = query
    }
    clear(searchResults)
    searchMatches = searchGraphNodes(projectedNodes(currentView.projection), query)
    clearSearch.disabled = !query
    if (!query) { searchResults.hidden = true; searchPager.hidden = true; searchError.textContent = ''; return }
    searchResults.hidden = false
    if (!searchMatches.length) { searchPager.hidden = true; searchError.textContent = '没有找到匹配节点。'; return }
    const pageCount = Math.max(1, Math.ceil(searchMatches.length / SEARCH_RESULTS_PAGE_SIZE))
    searchPage = Math.min(searchPage, pageCount)
    const pageStart = (searchPage - 1) * SEARCH_RESULTS_PAGE_SIZE
    const visible = searchMatches.slice(pageStart, pageStart + SEARCH_RESULTS_PAGE_SIZE)
    previousSearchPage.disabled = searchPage <= 1
    nextSearchPage.disabled = searchPage >= pageCount
    searchPageLabel.textContent = `结果 ${pageStart + 1}–${pageStart + visible.length} / ${searchMatches.length}`
    searchPager.hidden = searchMatches.length <= SEARCH_RESULTS_PAGE_SIZE
    searchError.textContent = `${searchMatches.length} 个匹配节点；方向键移入当前组结果，回车定位。`
    for (const [index, node] of visible.entries()) {
      const result = h('button', {
        type: 'button', class: 'cog-search-result', role: 'option', 'aria-selected': 'false',
        onclick: () => chooseSearchResult(node),
      }, h('span', { class: 'cog-search-result-kind' }, KIND[node.kind]?.label || '节点'),
      h('span', { class: 'cog-search-result-title' }, node.title || '未命名节点'))
      result.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); resetSearch() }
        else if (event.key === 'ArrowDown') {
          event.preventDefault()
          if (index === visible.length - 1 && searchPage < pageCount) changeSearchPage(1, true)
          else searchResults.querySelectorAll('.cog-search-result')[Math.min(index + 1, visible.length - 1)]?.focus()
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          if (index === 0) nodeSearch.focus()
          else searchResults.querySelectorAll('.cog-search-result')[index - 1]?.focus()
        }
      })
      searchResults.append(result)
    }
  }
  nodeSearch.addEventListener('input', renderSearchResults)
  nodeSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); focusBySearch() }
    else if (event.key === 'ArrowDown' && searchMatches.length) { event.preventDefault(); searchResults.querySelector('.cog-search-result')?.focus() }
    else if (event.key === 'ArrowUp' && searchMatches.length) {
      event.preventDefault()
      const results = searchResults.querySelectorAll('.cog-search-result')
      results.item(results.length - 1)?.focus()
    }
    else if (event.key === 'Escape') { event.preventDefault(); resetSearch() }
  })

  function resetSearch() {
    nodeSearch.value = ''
    searchMatches = []
    searchPage = 1
    previousSearchQuery = ''
    clear(searchResults)
    searchResults.hidden = true
    searchPager.hidden = true
    searchError.textContent = ''
    clearSearch.disabled = true
    render(currentView, null)
    nodeSearch.focus()
  }

  function focusBySearch() {
    const query = nodeSearch.value.trim()
    if (!query) { searchError.textContent = '请输入节点名称。'; nodeSearch.focus(); return }
    const match = searchMatches[0] || searchGraphNodes(projectedNodes(currentView.projection), query)[0]
    if (!match) { searchError.textContent = '没有找到匹配节点。'; return }
    searchResults.hidden = true
    searchPager.hidden = true
    chooseSearchResult(match)
  }

  function renderFocusRegion(nodeId) {
    clear(focusRegion)
    if (!nodeId) { focusRegion.hidden = true; return }
    const projection = currentView.projection || {}
    const allNodes = projectedNodes(projection)
    const byId = new Map(allNodes.map((node) => [node.id, node]))
    const focused = byId.get(nodeId)
    if (!focused) { focusRegion.hidden = true; return }
    focusRegion.hidden = false
    const edges = projection.allEdges || projection.edges || []
    const relatedEdges = edges.filter((edge) => edge.from === nodeId || edge.to === nodeId)
    const eventById = new Map((currentView.events || []).map((event) => [event.id, event]))
    const historyContext = { events: currentView.events || [], projection, selectedSeq: currentView.selectedSeq }
    const openOptions = { onChanged: opts.onChanged, historyContext, onJumpToEvent: opts.onJumpToEvent }
    const nodeEvent = (node) => [...(node.provenanceEventIds || []), ...(node.eventIds || []), node.id]
      .map((id) => eventById.get(id)).find(Boolean)
    const eventButton = (event, label) => event && typeof opts.onJumpToEvent === 'function'
      ? h('button', { type: 'button', class: 'btn cog-focus-event', onclick: () => opts.onJumpToEvent(event) }, `${label} · 第 ${event.seq} 条`)
      : h('span', { class: 'cog-focus-event-missing' }, '来源事件未解析')
    const evidenceIds = new Set()
    for (const edge of relatedEdges) {
      const otherId = edge.from === nodeId ? edge.to : edge.from
      if (byId.get(otherId)?.kind === 'evidence') evidenceIds.add(otherId)
    }
    if (focused.kind === 'evidence') evidenceIds.add(focused.id)
    const evidenceNodes = [...evidenceIds].map((id) => byId.get(id)).filter(Boolean)
    const relationRows = relatedEdges.map((edge) => {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      const sourceEvent = eventById.get(edge.eventId) || eventById.get(edge.provenanceEventIds?.[0])
      const relationName = REL[edge.rel]?.label || edge.rel
      const reviewState = edge.pendingReview ? ' · 待确认' : edge.reviewDecision === 'rejected' ? ' · 已驳回' : ''
      const relationText = REL[edge.rel]?.group === 'argument'
        ? `${from?.title || '来源未解析'} → ${to?.title || '来源未解析'}`
        : `${from?.title || '来源未解析'} · ${relationName} · ${to?.title || '来源未解析'}（弱关联）`
      return h('div', { class: 'cog-focus-relation', 'data-rel': edge.rel || '' },
        h('span', { class: 'cog-focus-direction' }, relationText),
        h('span', { class: `cog-focus-rel-name rel-${edge.rel || 'unknown'}` }, `${edge.rel || '关系'} · ${relationName}${reviewState}`),
        eventButton(sourceEvent, '关系来源事件'))
    })
    const evidenceRows = evidenceNodes.map((node) => {
      const event = nodeEvent(node)
      const payload = event?.payload || {}
      const source = payload.sourceLabel || payload.legacySource?.label || payload.sourceKind || node.sourceKind || '来源未记录'
      const date = payload.publishedAt || payload.date || event?.at
      return h('article', { class: 'cog-focus-evidence', 'data-node-id': node.id },
        h('div', { class: 'cog-focus-evidence-title' }, node.title || '未命名证据'),
        h('div', { class: 'cog-focus-evidence-meta' }, `来源 · ${source} · 日期 · ${date ? fmtAt(date) : '未记录'}`),
        h('div', { class: 'cog-focus-evidence-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => opts.onOpen?.(node, openOptions) }, '查看证据详情'),
          eventButton(event, '来源事件')))
    })
    const focusedEvent = nodeEvent(focused)
    focusRegion.append(
      h('div', { class: 'cog-focus-region-head' },
        h('div', {},
          h('span', { class: 'cog-focus-region-kicker' }, `${KIND[focused.kind]?.label || '节点'} · 局部展开`),
          h('h3', { class: 'cog-focus-region-title' }, focused.title || '未命名节点')),
        h('button', { type: 'button', class: 'btn', onclick: () => opts.onOpen?.(focused, openOptions) }, '查看节点详情')),
      h('p', { class: 'cog-focus-region-summary' }, `${evidenceNodes.length} 条直接关联证据 · ${relatedEdges.length} 条直接关系。`),
      evidenceNodes.length
        ? h('section', { class: 'cog-focus-evidence-list', 'aria-label': '所选节点关联证据' }, h('h4', {}, '证据与来源事件'), ...evidenceRows)
        : h('p', { class: 'cog-focus-empty' }, '没有直接关联的证据节点；可通过全局搜索或账本查找其他来源。'),
      relationRows.length
        ? h('section', { class: 'cog-focus-relations', 'aria-label': '所选节点关系' }, h('h4', {}, '关系与方向'), ...relationRows)
        : h('p', { class: 'cog-focus-empty' }, '当前没有直接关系声明。'),
      focused.kind === 'evidence' ? eventButton(focusedEvent, '所选证据的来源事件') : null)
  }

  function renderPointInspector(nodeId) {
    clear(pointSummary)
    clear(historyBody)
    clear(referencesBody)
    const projection = currentView.projection || {}
    const allNodes = projectedNodes(projection)
    const node = nodeId ? allNodes.find((candidate) => candidate.id === nodeId) : null
    focusRegion.hidden = !node
    historyDisclosure.hidden = !node
    referencesDisclosure.hidden = !node
    if (!node) {
      const hasLocalNodes = allNodes.some((candidate) => !candidate.external)
      const trulyEmpty = !allNodes.length && !(currentView.events || []).length && projection.integrity?.ok === true
      pointSummary.append(
        h('div', { class: 'cog-point-inspector-head' },
          h('div', {}, h('span', { class: 'cog-point-inspector-kicker' }, '节点检视'),
            h('h3', { class: 'cog-point-inspector-title' }, '选择一个网络节点'))),
        h('div', { class: 'cog-point-inspector-empty' },
          h('p', {}, hasLocalNodes ? '选择图中的节点，查看类型、状态、来源、关系与事件历史。'
            : trulyEmpty ? '这是一个真实空主题。主题仅限定网络范围；不会自动生成观点、证据或事实。'
              : '当前有效前缀中没有本地节点；可先检查账本与外部引用记录。'),
          trulyEmpty ? h('button', { type: 'button', class: 'btn btn-primary', disabled: projection.integrity?.ok !== true,
            onclick: () => openEntryDialog(theme, projection, 'node', opts, 'viewpoint') }, '添加第一条观察/观点') : null))
      return
    }
    const nodeType = networkNodeType(node)
    const kind = KIND[nodeType] || KIND.viewpoint
    const statusKey = networkNodeStatus(node)
    const statusLabel = NODE_STATUS_LABEL[statusKey] || NODE_STATUS[node.status]?.label || statusKey
    const events = currentView.events || []
    const eventById = new Map(events.map((event) => [event.id, event]))
    const firstEvent = [...(node.provenanceEventIds || []), ...(node.eventIds || []), node.id]
      .map((id) => eventById.get(id)).find(Boolean)
    const payload = firstEvent?.payload || {}
    const resolvedSource = resolveEventReference(events, node.sourceRef)
    const source = payload.sourceLabel || payload.legacySource?.label || payload.sourceKind || node.sourceKind
      || (resolvedSource.status === 'resolved' ? resolvedSource.subjectTitle : '') || '来源未记录'
    const sourceDate = payload.publishedAt || payload.date || firstEvent?.at
    const history = collectNodeHistory(node, events)
    const historyContext = { events, projection, selectedSeq: currentView.selectedSeq }
    const detailOptions = { onChanged: opts.onChanged, historyContext, onJumpToEvent: opts.onJumpToEvent }
    const confidence = node.confidence == null || !Number.isFinite(Number(node.confidence))
      ? null : `${Math.round(Number(node.confidence))}%`
    pointSummary.append(
      h('div', { class: 'cog-point-inspector-head' },
        h('div', {}, h('span', { class: 'cog-point-inspector-kicker' }, `${kind.label} · 节点详情`),
          h('h3', { class: 'cog-point-inspector-title' }, node.title || '未命名节点'))),
      node.currentText && node.currentText !== node.title
        ? h('p', { class: 'cog-point-inspector-body' }, node.currentText) : null,
      h('div', { class: 'cog-point-inspector-badges' },
        h('span', { class: 'cog-point-inspector-badge' }, statusLabel),
        h('span', { class: 'cog-point-inspector-badge' }, `类型：${NODE_TYPE_META[nodeType].label}`),
        confidence ? h('span', { class: 'cog-point-inspector-badge' }, `置信度 ${confidence}`) : null,
        null),
      node.originalTitle && node.originalTitle !== node.title
        ? h('p', { class: 'cog-point-inspector-note' }, `旧名：${node.originalTitle}`) : null,
      node.nameHistory?.length ? h('div', { class: 'cog-point-inspector-note' },
        `名称历史：${node.nameHistory.map((entry) => `${entry.previousTitle} → ${entry.title}`).join('；')}`) : null,
      h('div', { class: 'cog-point-inspector-meta' },
        h('div', { class: 'cog-point-inspector-meta-row' }, h('span', {}, '来源'), h('strong', {}, source)),
        sourceDate ? h('div', { class: 'cog-point-inspector-meta-row' }, h('span', {}, '记录时间'), h('strong', {}, fmtAt(sourceDate))) : null,
        h('div', { class: 'cog-point-inspector-meta-row' }, h('span', {}, '节点历史'), h('strong', {}, `${history.length} 条相关事件`))),
      h('p', { class: 'cog-point-inspector-note' }, '状态与来源按已有记录展示；账本完整性只说明事件链一致，不代表内容或来源已经证实。'),
      h('div', { class: 'cog-point-inspector-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => opts.onOpen?.(node, detailOptions) }, '完整详情与操作'),
        !node.archived && !node.invalidated && !node.external && currentView.selectedSeq == null && nodeType !== 'evidence'
          ? h('button', { type: 'button', class: 'btn', onclick: () => openEntryDialog(theme, projection, 'evidence', opts) }, '补充证据') : null),
      !node.archived && !node.invalidated && !node.external && currentView.selectedSeq == null && projection.integrity?.ok
        ? renderNodeLifecycleControls(theme, node, opts) : null,
      firstEvent && typeof opts.onJumpToEvent === 'function'
        ? h('button', { type: 'button', class: 'btn cog-focus-event', onclick: () => opts.onJumpToEvent(firstEvent) }, `跳回来源事件 · 第 ${firstEvent.seq} 条`)
        : null)
    renderFocusRegion(node.id)
    historyDisclosure.querySelector('[data-inspector-history-label]').textContent = `节点历史与事件时间线 · ${history.length} 条`
    historyBody.append(renderNodeHistoryTimeline(history, detailOptions))
    referencesBody.append(...renderNodeEvidence(history, detailOptions))
  }

  function render(viewState, focusNodeId = null) {
    const viewChanged = viewState !== currentView
    currentView = viewState
    currentFocus = focusNodeId
    const projection = viewState.projection
    const allNodes = projectedNodes(projection)
    const allEdges = projection.allEdges || projection.edges || []
    const focusedNode = focusNodeId ? allNodes.find((node) => node.id === focusNodeId) : null
    const typeValue = typeFilter.value
    const statusValue = statusFilter.value
    const matchesFilters = (node) => (typeValue === 'all' || networkNodeType(node) === typeValue)
      && (statusValue === 'all' || networkNodeStatus(node) === statusValue)
    const filteredNodes = allNodes.filter(matchesFilters)
    if (focusedNode && !filteredNodes.some((node) => node.id === focusedNode.id)) filteredNodes.push(focusedNode)
    const filteredIds = new Set(filteredNodes.map((node) => node.id))
    const filteredEdges = allEdges.filter((edge) => filteredIds.has(edge.from) && filteredIds.has(edge.to))
    const currentAllNodes = projectedNodes(proj)
    const currentNodes = currentAllNodes.filter(matchesFilters)
    const currentIds = new Set(currentNodes.map((node) => node.id))
    const currentEdges = (proj.allEdges || proj.edges || []).filter((edge) => currentIds.has(edge.from) && currentIds.has(edge.to))
    const replaying = viewState.selectedSeq != null
    const frame = selectGraphWindow({
      ...projection,
      nodes: filteredNodes,
      allNodes: [...filteredNodes, ...currentNodes.filter((node) => !filteredIds.has(node.id))],
      edges: filteredEdges,
    }, {
      focusNodeId,
      maxNodes: compareCurrent && replaying ? Math.max(1, GRAPH_FRAME_NODE_LIMIT - 8) : GRAPH_FRAME_NODE_LIMIT,
      maxEdges: GRAPH_FRAME_EDGE_LIMIT,
    })
    clear(graphCanvas)
    if (frame.truncated) {
      graphCanvas.append(h('p', { class: 'cog-frame-note', role: 'status' },
        `当前视图呈现 ${frame.nodes.length} 个网络节点；${filteredNodes.length} 项符合筛选。请用搜索、类型或状态筛选定位其余记录。`))
    }
    if (!filteredNodes.length && allNodes.length) graphCanvas.append(h('p', { class: 'cog-frame-note', role: 'status' },
      '没有节点符合当前筛选。可调整类型/状态，或清除筛选。'))
    if (!allNodes.length) {
      const trulyEmpty = verifiedTimelineEvents.length === 0 && projection.integrity?.ok === true
      graphCanvas.append(projection.integrity?.ok === false
        ? h('section', { class: 'cog-network-empty is-integrity-error', role: 'alert' },
          h('h3', {}, '当前有效记录为空，账本校验异常'),
          h('p', {}, '历史回放与写入仅依据校验有效前缀；请先查看账本异常详情。这里不会将损坏尾部当作事实。'))
        : trulyEmpty ? h('section', { class: 'cog-network-empty', 'aria-label': '空主题引导' },
          h('span', { class: 'cog-network-empty-kicker' }, '真实空主题'),
          h('h3', {}, '从一条观察或观点开始'),
          h('p', {}, '主题只限定这张网络的范围，不是中心节点。不会自动生成观点、证据或事实。'),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openEntryDialog(theme, projection, 'node', opts, 'viewpoint') }, '添加第一条观察/观点'))
          : h('p', { class: 'cog-frame-note', role: 'status' }, '已有账本事件，但当前有效投影没有节点；请检查该主题的账本与历史事件。'))
    }
    const frameProjection = { ...projection, nodes: frame.nodes, edges: frame.edges, allNodes, allEdges }
    if (viewChanged && nodeSearch.value) renderSearchResults()
    const selectedEvents = viewState.events || []
    const graphOptions = {
      ...opts,
      historyContext: { events: selectedEvents, projection, selectedSeq: viewState.selectedSeq },
      focusNodeId: frame.focusNodeId,
      currentProjection: proj,
      currentNodes,
      currentEdges,
      networkLayout,
      compareCurrent: Boolean(compareCurrent && replaying),
      focusLabel,
      focusDetails,
      clearFocus,
      onFocusNode: (node) => {
        currentFocus = node?.id || null
        focusDetails.hidden = !currentFocus
        clearFocus.hidden = !currentFocus
        focusLabel.textContent = node ? `已选择：${node.title || '节点'} · 详情显示在右侧` : '选择一个节点'
        renderPointInspector(currentFocus)
        handlers.onNodeSelect?.(node)
      },
    }
    if (frame.nodes.length) drawThemeNetwork(frameProjection, { ...graphOptions, maxComparisonNodes: 8 }, graphCanvas)
    focusDetails.hidden = !focusNodeId
    clearFocus.hidden = !focusNodeId
    focusLabel.textContent = focusNodeId
      ? `已选择：${focusedNode?.title || '节点'} · 详情显示在右侧`
      : '选择一个节点'
    renderPointInspector(focusNodeId)
    handlers.onReplayStatus?.(viewState)
    let timelineIndex = -1
    if (replaying) {
      for (let i = 0; i < timelinePoints.length; i++) if (timelinePoints[i].seq <= viewState.selectedSeq) timelineIndex = i
      const selectedEvent = verifiedTimelineEvents.find((event) => event.seq === viewState.selectedSeq)
      const selectedDate = String(selectedEvent?.at || '').slice(0, 10)
      const datePointIndex = timelinePoints.findIndex((point) => point.date === selectedDate)
      if (datePointIndex >= 0) timelineIndex = datePointIndex
    }
    const currentPoint = timelinePoints[Math.max(0, timelineIndex)] || timelinePoints.at(-1)
    timeSlider.value = String(replaying ? currentPoint?.position ?? 0 : 100)
    timePreview.textContent = replaying && currentPoint ? `${currentPoint.date} · 第 ${viewState.selectedSeq} 条` : ''
    liveButton.hidden = !replaying
    compareButton.hidden = !replaying
    compareButton.setAttribute('aria-pressed', String(compareCurrent))
    compareButton.textContent = compareCurrent ? '隐藏当前对比' : '与当前对比'
    if (replaying && currentPoint) {
      const previousSeq = timelineIndex > 0 ? timelinePoints[timelineIndex - 1].seq : 0
      const segmentSummary = timelineChangeSummary(verifiedTimelineEvents, previousSeq, viewState.selectedSeq)
      const laterSummary = compareCurrent ? ` · 与当前相比：${timelineChangeSummary(verifiedTimelineEvents, viewState.selectedSeq, maxSeq)}` : ''
      timeSummary.textContent = `${currentPoint.date} · ${segmentSummary}${laterSummary}`
    } else {
      timeSummary.textContent = maxSeq ? `当前状态 · ${maxSeq} 条已校验事件。拖动时间轴或选择日期刻度回放。` : '暂无已校验事件可回放。'
    }
    for (const tick of tickRail.querySelectorAll('.cog-time-tick')) {
      const point = timelinePoints.find((item) => item.seq === Number(tick.getAttribute('data-seq')))
      if (point) tick.setAttribute('aria-current', String(point.seq === currentPoint?.seq && replaying))
    }
    addNode.disabled = replaying || projection.integrity?.ok === false
    addNode.title = replaying ? '历史回放只读；返回当前状态后才能添加节点'
      : projection.integrity?.ok === false ? '事件账本校验异常，不能追加记录' : ''
    const choices = projectedNodes(projection).filter((node) => !node.archived && !node.invalidated
      && !node.external && networkNodeType(node) !== 'evidence')
    addEvidence.disabled = replaying || projection.integrity?.ok === false
    addEvidence.title = replaying ? '历史回放为只读；返回当前投影后才能补充证据'
      : projection.integrity?.ok === false ? '事件账本校验异常，不能追加记录'
        : choices.length ? '' : '请先添加一个非证据节点，再补充证据'
    evidenceGuidance.textContent = replaying || projection.integrity?.ok === false ? '历史回放或账本校验异常时，写入和复核已禁用。'
      : choices.length ? '' : '当前没有可关联的非证据节点；补充证据不会自动创建观点或事实。'
  }

  focusDetails.onclick = () => {
    const id = currentFocus || graphCanvas.querySelector('.cog-node.is-selected')?.getAttribute('data-node-id')
    const node = projectedNodes(currentView.projection).find((candidate) => candidate.id === id)
    if (node) opts.onOpen?.(node, { onChanged: opts.onChanged, historyContext: { events: currentView.events || [], projection: currentView.projection, selectedSeq: currentView.selectedSeq }, onJumpToEvent: opts.onJumpToEvent })
  }
  clearFocus.onclick = () => render(currentView, null)
  return { render, focus: (id) => render(currentView, id) }
}

function openEntryDialog(theme, proj, mode, opts, defaultNodeType = 'viewpoint') {
  const choices = projectedNodes(proj).filter((node) => !node.archived && !node.invalidated && !node.external
    && networkNodeType(node) !== 'evidence')
  const isEvidence = mode === 'evidence'
  if (isEvidence && !choices.length) { toast('请先添加概念、对象、事件或观点节点，再追加证据', 'var(--text-2)'); return }
  const previousFocus = document.activeElement
  closeNodeDetail()
  const typeChoices = NETWORK_NODE_TYPES.filter((type) => type !== 'evidence')
  const heading = isEvidence ? '补充证据' : '添加网络节点'
  const backdrop = h('div', { class: 'chain-drawer-backdrop show cog-entry-backdrop' })
  const dialog = h('section', { class: 'cog-entry-dialog show', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cog-entry-title', tabindex: '-1' })
  const typeSelect = h('select', { class: 'txt', 'aria-label': '节点类型' },
    ...typeChoices.map((type) => h('option', { value: type, selected: type === defaultNodeType }, NODE_TYPE_META[type].label)))
  const titleInput = h('input', { class: 'txt', type: 'text', maxlength: '180', required: true, placeholder: '写下观察、概念或明确观点', 'aria-label': '节点名称' })
  const bodyInput = h('textarea', { class: 'txt cog-entry-textarea', rows: '3', placeholder: isEvidence ? '记录可核对的数字、观察或原文摘录' : '说明（可选）；说明不会自动成为证据。', 'aria-label': isEvidence ? '证据摘要或原文摘录' : '节点说明' })
  const sourceInput = h('input', { class: 'txt', type: 'text', placeholder: '来源名称（可选）', 'aria-label': '来源名称' })
  const urlInput = h('input', { class: 'txt', type: 'url', placeholder: 'https://…（可选）', 'aria-label': '来源链接' })
  const publishedInput = h('input', { class: 'txt', type: 'text', maxlength: '100', placeholder: '来源发布时间或日期（可选）', 'aria-label': '来源发布时间' })
  const applicabilityInput = h('input', { class: 'txt', type: 'text', maxlength: '160', placeholder: '如 2026Q2、截至某日（可选）', 'aria-label': '适用时间' })
  const targetSelect = h('select', { class: 'txt', 'aria-label': '要关联到的非证据节点' },
    ...choices.map((node) => h('option', { value: node.id }, `${NODE_TYPE_META[networkNodeType(node)].label} · ${node.title}`)))
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const close = () => {
    document.removeEventListener('keydown', onKey)
    backdrop.remove(); dialog.remove()
    if (previousFocus?.isConnected) previousFocus.focus()
  }
  const onKey = (event) => {
    if (event.key === 'Escape') { close(); return }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary')]
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return }
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus() }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus() }
  }
  const save = async (event) => {
    event.preventDefault()
    const text = bodyInput.value.trim()
    const title = titleInput.value.trim()
    if (isEvidence && !text) { error.hidden = false; error.textContent = '请填写证据摘要或原文摘录。'; bodyInput.focus(); return }
    if (!isEvidence && !title) { error.hidden = false; error.textContent = '请填写节点名称。'; titleInput.focus(); return }
    const button = dialog.querySelector('[data-entry-save]')
    button.disabled = true
    error.hidden = true
    try {
      const result = isEvidence
        ? await m.chainAddEvidence(theme.id, targetSelect.value, {
          text, sourceLabel: sourceInput.value.trim(), url: urlInput.value.trim(),
          sourcePublishedAt: publishedInput.value.trim(), applicability: applicabilityInput.value.trim(),
        })
        : await m.chainCreateNode(theme.id, {
          nodeType: typeSelect.value, title, detail: text, status: 'pending', applicability: applicabilityInput.value.trim(),
        })
      if (result?.ok === false) throw new Error(result.error || '保存未完成')
      toast(isEvidence ? '已追加证据与明确声明的支持关系' : `已追加${NODE_TYPE_META[typeSelect.value].label}节点`)
      close()
      opts.onChanged?.()
    } catch (saveError) {
      error.hidden = false
      error.textContent = saveError.message || String(saveError)
      button.disabled = false
    }
  }
  const form = h('form', { class: 'cog-entry-form', onsubmit: save },
    isEvidence
      ? h('label', { class: 'cog-entry-field' }, h('span', {}, '关联到'), targetSelect)
      : h('label', { class: 'cog-entry-field' }, h('span', {}, '节点类型'), typeSelect),
    !isEvidence ? h('label', { class: 'cog-entry-field' }, h('span', {}, '名称'), titleInput) : null,
    h('label', { class: 'cog-entry-field' }, h('span', {}, isEvidence ? '证据摘要或原文摘录' : '说明（可选）'), bodyInput),
    isEvidence ? h('div', { class: 'cog-entry-field' },
      h('label', { class: 'cog-entry-field' }, h('span', {}, '来源名称（可选）'), sourceInput),
      h('label', { class: 'cog-entry-field' }, h('span', {}, '来源链接（可选）'), urlInput),
      h('label', { class: 'cog-entry-field' }, h('span', {}, '来源发布时间（可选）'), publishedInput),
      h('label', { class: 'cog-entry-field' }, h('span', {}, '适用时间（可选）'), applicabilityInput))
      : h('div', {},
        h('label', { class: 'cog-entry-field' }, h('span', {}, '适用时间（可选）'), applicabilityInput),
        h('p', { class: 'cog-entry-note' }, '只记录你明确输入的节点；说明不会自动转成证据、事实或关系。适用时间不是系统摄入时间。')),
    error,
    h('div', { class: 'cog-entry-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, '取消'),
      h('button', { type: 'submit', class: 'btn btn-primary', 'data-entry-save': '' }, isEvidence ? '追加证据' : '创建节点')))
  dialog.append(h('header', { class: 'cog-entry-head' }, h('div', { id: 'cog-entry-title', class: 'cog-entry-title' }, heading),
    h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '关闭', onclick: close }, '×')), form)
  backdrop.addEventListener('click', close)
  document.body.append(backdrop, dialog)
  document.addEventListener('keydown', onKey)
  requestAnimationFrame(() => (isEvidence ? targetSelect : titleInput).focus())
}

function renderLegend() {
  const sample = (color, dashed, arrow = true) => {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'cog-legend-line')
    svg.setAttribute('viewBox', '0 0 38 12')
    svg.setAttribute('aria-hidden', 'true')
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', '1'); line.setAttribute('y1', '6'); line.setAttribute('x2', arrow ? '31' : '37'); line.setAttribute('y2', '6')
    line.setAttribute('stroke', color); line.setAttribute('stroke-width', '2')
    if (dashed) line.setAttribute('stroke-dasharray', '4 3')
    svg.append(line)
    if (arrow) {
      const head = document.createElementNS(SVG_NS, 'path')
      head.setAttribute('d', 'M 27 2 L 34 6 L 27 10')
      head.setAttribute('fill', 'none'); head.setAttribute('stroke', color); head.setAttribute('stroke-width', '2')
      svg.append(head)
    }
    return svg
  }
  const argumentRows = ['supports', 'derives', 'contradicts'].map((key) =>
    h('div', { class: 'cog-legend-row', 'data-legend-rel': key },
      sample(REL[key].color, false, true),
      h('span', { class: 'cog-legend-copy' }, h('strong', {}, REL[key].label), h('span', {}, '有方向的论证关系'))))
  const associationRows = ['belongs-to', 'influences', 'depends-on', 'temporal', 'related'].map((key) =>
    h('div', { class: 'cog-legend-row is-association', 'data-legend-rel': key },
      sample(REL[key].color, false, false),
      h('span', { class: 'cog-legend-copy' }, h('strong', {}, REL[key].label), h('span', {}, '主题关联；不表示支持或因果'))))
  const nodeRows = NETWORK_NODE_TYPES.map((type) => {
    const meta = NODE_TYPE_META[type]
    return h('span', { class: 'cog-legend-node-type' },
      h('span', { class: 'cog-type-key-shape', 'data-shape': meta.shape, style: { '--node-type-color': meta.color }, 'aria-hidden': 'true' }),
      h('span', {}, meta.label))
  })
  /* 图例状态只保留用户能理解的 5 个；旧链遗留状态不进图例。 */
  const LEGEND_STATUSES = ['pending', 'verified', 'disputed', 'invalidated', 'archived']
  const statusRows = LEGEND_STATUSES.map((status) =>
    h('span', { class: `cog-legend-status is-${status}` }, NODE_STATUS_LABEL[status]))
  return h('aside', { class: 'cog-graph-legend-corner', 'aria-label': '网络类型、关系和状态图例' },
    h('strong', { class: 'cog-legend-title' }, '类型、关系与状态'),
    h('section', { class: 'cog-legend-section', 'aria-label': '节点类型' }, h('span', { class: 'cog-legend-section-title' }, '节点类型 · 形状与颜色区分'), ...nodeRows),
    h('section', { class: 'cog-legend-section', 'aria-label': '论证关系' }, h('span', { class: 'cog-legend-section-title' }, '论证 · 有方向箭头'), ...argumentRows),
    h('section', { class: 'cog-legend-section', 'aria-label': '主题关联' }, h('span', { class: 'cog-legend-section-title' }, '主题关联 · 细线无箭头'), ...associationRows),
    h('section', { class: 'cog-legend-section', 'aria-label': '节点状态' }, h('span', { class: 'cog-legend-section-title' }, '节点状态 · 文字 pill'), ...statusRows),
    h('p', { class: 'cog-legend-foot' }, '只呈现事件中明确记录的节点与关系；主题不作为中心节点。待确认/驳回关系会保留声明方向并显示其状态。'))
}

/* ------------------------------------------------------------------ */
/* 节点详情抽屉：读投影，不读旧可变链字段                               */
/* ------------------------------------------------------------------ */

export async function openNodeDetail(theme, node, opts = {}) {
  const returnFocus = document.activeElement
  closeNodeDetail()
  const type = networkNodeType(node)
  const kind = KIND[type] || KIND.viewpoint
  const statusKey = networkNodeStatus(node)
  const st = { label: NODE_STATUS_LABEL[statusKey] || NODE_STATUS[node.status]?.label || statusKey }
  const historyContext = opts.historyContext || null
  const historical = historyContext?.selectedSeq != null

  const backdrop = h('div', { class: 'chain-drawer-backdrop' })
  const drawer = h('aside', { class: 'chain-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `节点详情：${node.title}`, tabindex: '-1' })
  const body = h('div', { class: 'chain-drawer-body' }, h('p', { class: 'chain-note' }, '正在读取事件历史…'))
  const close = () => {
    document.removeEventListener('keydown', onKey)
    backdrop.classList.remove('show')
    drawer.classList.remove('show')
    setTimeout(() => {
      backdrop.remove(); drawer.remove()
      if (returnFocus?.isConnected) returnFocus.focus()
    }, 280)
  }
  drawer.append(
    h('div', { class: 'chain-drawer-head' },
      h('div', { class: 'chain-drawer-title' }, '节点详情'),
      h('button', { type: 'button', class: 'btn btn-icon', title: '关闭', onclick: close }, '✕')),
    body)
  backdrop.onclick = close
  document.body.append(backdrop, drawer)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('show')
    drawer.classList.add('show')
    drawer.querySelector('button')?.focus()
  }))
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return }
    if (e.key !== 'Tab') return
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary')]
    if (!focusable.length) { e.preventDefault(); drawer.focus(); return }
    if (e.shiftKey && document.activeElement === focusable[0]) { e.preventDefault(); focusable.at(-1).focus() }
    else if (!e.shiftKey && document.activeElement === focusable.at(-1)) { e.preventDefault(); focusable[0].focus() }
  }
  document.addEventListener('keydown', onKey)

  let events = []
  let proj = null
  try {
    if (historyContext?.projection) {
      events = historyContext.events || []
      const snapshot = historyContext.projection
      proj = { ...snapshot, nodes: snapshot.allNodes || snapshot.nodes || [] }
    } else {
      const [evRes, p] = await Promise.all([m.chainEvents(theme.id), m.chainProjection(theme.id)])
      events = verifiedLedgerPrefix(evRes?.events || [], p.integrity)
      proj = { ...p, nodes: p.allNodes || p.nodes || [] }
    }
  } catch (e) {
    clear(body).append(h('p', { class: 'chain-note' }, '事件读取失败：' + (e.message || e)))
    return
  }
  const byId = new Map(events.filter((e) => e && typeof e === 'object').map((e) => [e.id, e]))
  const nodeById = new Map((proj?.nodes || []).map((n) => [n.id, n]))
  const readableSource = resolveEventReference(events, node.sourceRef)
  const lineage = (node.eventIds || [node.id]).map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => a.seq - b.seq)
  const versionEvents = lineage.filter((event) => ['claim.created', 'inference.created', 'correction.appended'].includes(event.type))
  const relatedEvents = collectNodeHistory(node, events)

  const badges = []
  if (node.correct === false) badges.push(h('span', { class: 'chain-pill st-forking' }, '已证伪'))
  if (node.archived) badges.push(h('span', { class: 'chain-pill st-closed' }, '已归档'))
  if (node.invalidated) badges.push(h('span', { class: 'chain-pill st-closed' }, '已失效'))
  if (node.superseded) badges.push(h('span', { class: 'chain-pill st-stale' }, '已更正'))
  const archiveReason = h('input', { class: 'txt', type: 'text', placeholder: '填写归档原因（必填）', 'aria-label': '归档原因' })
  const archiveButton = h('button', {
    type: 'button', class: node.archived ? 'btn btn-primary' : 'btn', disabled: !node.sourceRef,
    onclick: async (ev) => {
      const button = ev.currentTarget
      if (!node.archived && !archiveReason.value.trim()) { toast('请填写归档原因', 'var(--red)'); archiveReason.focus(); return }
      button.disabled = true
      try {
        const result = node.archived
          ? await m.chainRestoreNode(theme.id, node.sourceRef, archiveReason.value.trim() || '从归档区恢复')
          : await m.chainArchiveNode(theme.id, node.sourceRef, archiveReason.value.trim())
        if (result?.ok === false) throw new Error(result.error || '操作未完成')
        toast(node.archived ? '已追加恢复事件' : '已追加归档事件')
        close()
        opts.onChanged?.()
      } catch (error) { toast((node.archived ? '恢复' : '归档') + '失败：' + (error.message || error), 'var(--red)') }
      finally { button.disabled = false }
    },
  }, node.archived ? '追加恢复事件' : '追加归档事件')

  mount(clear(body),
    h('div', { class: 'chain-drawer-kicker' },
      h('span', { class: 'chain-role-tag', style: `color:${kind.color};border-color:${kind.border}` }, kind.label),
      h('span', { class: 'chain-pill st-pending' }, st.label),
      ...badges),
    h('div', { class: 'chain-drawer-name' }, node.title),
    node.originalTitle && node.originalTitle !== node.title ? h('p', { class: 'chain-note' }, `旧名：${node.originalTitle}`) : null,
    node.nameHistory?.length ? h('p', { class: 'chain-note' }, `名称历史：${node.nameHistory.map((entry) => `${entry.previousTitle} → ${entry.title}`).join('；')}`) : null,
    node.currentText && node.currentText !== node.title ? h('p', { class: 'chain-dcore' }, node.currentText) : null,
    node.confidence != null ? h('p', { class: 'chain-note' }, `置信度 ${Math.round(node.confidence)}%（只读，来自事件记录）`) : null,
    node.external ? h('p', { class: 'chain-note' }, '外部引用节点：关系端点指向账本外的对象。') : null,
    proj?.integrity?.ok === false ? h('p', { class: 'cog-integrity is-error', role: 'alert' }, `事件账本校验失败：${proj.integrity.reason}。当前仅显示已验证前缀。`) : null,
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, '来源'),
      h('p', { class: `chain-note${readableSource.status === 'unresolved' ? ' is-unresolved' : ''}` },
        readableSource.status === 'resolved' ? `${readableSource.subjectTitle || '已解析来源'} · 引用来源真实性未自动核验`
          : readableSource.status === 'unresolved' ? '来源未解析 · 引用尚未核实' : '未记录来源'),
      h('p', { class: 'chain-note' }, '来源引用表示一条可追溯声明，不等于来源真实性已核验。'),
      h('details', { class: 'chain-technical' },
        h('summary', {}, '技术详情 · 原始引用与事件 ID'),
        h('p', { class: 'chain-note' }, `来源引用：${node.sourceRef || '未记录'}`),
        node.sourceRef ? h('button', { type: 'button', class: 'cog-copy-btn', onclick: () => copyLedgerReference(node.sourceRef, '来源引用') }, '复制来源引用') : null,
        h('p', { class: 'chain-note' }, `关联事件：${(node.provenanceEventIds || node.eventIds || []).join(' · ') || '无'}`))),
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, '语义关系'),
      ...renderNodeRelations(proj, nodeById, node, theme, opts)),
    !historical && !node.external && !node.archived && !node.invalidated && type !== 'evidence'
      ? renderEvidenceComposer(theme, node, opts) : null,
    !historical && !node.external && !node.archived && !node.invalidated ? renderRelationComposer(proj, node, theme, opts) : null,
    !historical && !node.external && !node.archived && !node.invalidated && proj?.integrity?.ok
      ? renderNodeLifecycleControls(theme, node, opts) : null,
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, `历史版本（${versionEvents.length}）`),
      renderLineageThread(versionEvents, opts)),
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, `节点一生 · 来源与相关事件（${relatedEvents.length}）`),
      renderNodeHistoryTimeline(relatedEvents, opts)),
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, '证据引用 · 未自动核实来源真实性'),
      ...renderNodeEvidence(relatedEvents, opts)),
    !historical && !node.external ? h('section', { class: 'chain-dsect chain-archive-actions' },
      h('div', { class: 'chain-detail-h' }, node.archived ? '归档状态' : '节点操作'),
      node.archived && node.archiveReason ? h('p', { class: 'chain-note' }, `归档原因：${node.archiveReason}`) : null,
      node.archived ? null : archiveReason,
      archiveButton) : null,
  )
}

function collectNodeHistory(node, events) {
  const ids = new Set([node.id, ...(node.eventIds || []), ...(node.provenanceEventIds || [])].filter(Boolean))
  const sourceRefs = new Set([node.sourceRef].filter(Boolean))
  const related = new Set()
  const refMatchesNode = (ref) => ref?.type && ref?.id && sourceRefs.has(`${ref.type}:${ref.id}`)
  let changed = true
  while (changed) {
    changed = false
    for (const event of events) {
      const p = event?.payload || {}
      let touches = ids.has(event.id) || (event.supersedes && ids.has(event.supersedes))
        || (p.sourceRef && sourceRefs.has(p.sourceRef)) || (p.reviewOf && ids.has(p.reviewOf))
      if (event.type === 'relation.declared') {
        const original = p.reviewOf ? events.find((row) => row.id === p.reviewOf) : event
        const rp = original?.payload || p
        const endpoints = [rp.from, rp.to]
        touches ||= endpoints.some((endpoint) => (endpoint?.eventId && ids.has(endpoint.eventId))
          || refMatchesNode(endpoint?.ref))
        if (touches) {
          for (const endpoint of endpoints) if (endpoint?.eventId && !ids.has(endpoint.eventId)) { ids.add(endpoint.eventId); changed = true }
          if (original?.id && !ids.has(original.id)) { ids.add(original.id); changed = true }
        }
      }
      if (touches && !related.has(event.id)) { related.add(event.id); changed = true }
      if (touches && event.id && !ids.has(event.id)) { ids.add(event.id); changed = true }
      if (p.sourceRef && touches && !sourceRefs.has(p.sourceRef)) { sourceRefs.add(p.sourceRef); changed = true }
    }
  }
  return events.filter((event) => related.has(event.id)).sort((a, b) => (a.seq || 0) - (b.seq || 0))
}

function renderLineageThread(events, opts) {
  if (!events.length) return h('p', { class: 'chain-note' }, '暂无创建或更正版本。')
  const labels = events.map((event) => `v${String(event.seq).padStart(2, '0')}`)
  return h('details', { class: 'chain-lineage-thread' },
    h('summary', {}, `展开更正谱系 · ${labels.join(' → ')}`),
    h('p', { class: 'chain-note' }, '每个版本和差异均保留在账本中；这里仅将同一节点的 lineage 聚合展示。'),
    ...events.map((event) => renderHistoryEvent(event, opts)))
}

function renderNodeHistoryTimeline(events, opts) {
  if (!events.length) return h('p', { class: 'chain-note' }, '暂无可追溯来源或相关事件。')
  const pageSize = 30
  let page = 1
  const list = h('div', { class: 'chain-node-timeline' })
  const label = h('span', { class: 'cog-page-label', 'aria-live': 'polite' })
  const prev = h('button', { type: 'button', class: 'btn cog-page-btn', onclick: () => draw(page - 1) }, '更早')
  const next = h('button', { type: 'button', class: 'btn cog-page-btn', onclick: () => draw(page + 1) }, '较新')
  function draw(value) {
    const range = paginate(events, value, pageSize)
    page = range.page
    label.textContent = `${range.total ? range.start + 1 : 0}–${range.end} / ${range.total} 条`
    prev.disabled = page <= 1
    next.disabled = page >= range.pages
    clear(list)
    for (const event of range.items) list.append(renderHistoryEvent(event, opts))
  }
  draw(1)
  return h('div', { class: 'chain-node-timeline-wrap' }, h('div', { class: 'cog-pagination' }, prev, label, next), list)
}

function renderNodeLifecycleControls(theme, node, opts) {
  const disclosure = h('details', { class: 'cog-action-disclosure cog-node-lifecycle' },
    h('summary', {}, '改名或标记失效（追加事件）'))
  const renameTitle = h('input', { class: 'txt', type: 'text', maxlength: '180', required: true, value: node.title || '', 'aria-label': '新节点名称' })
  const renameReason = h('input', { class: 'txt', type: 'text', maxlength: '500', placeholder: '改名原因（可选）', 'aria-label': '改名原因' })
  const renameError = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const renameForm = h('form', { class: 'cog-entry-form' },
    h('label', { class: 'cog-entry-field' }, h('span', {}, '新名称'), renameTitle),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '原因（可选）'), renameReason),
    renameError,
    h('button', { type: 'submit', class: 'btn' }, '追加改名事件'))
  renameForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submit = renameForm.querySelector('button[type="submit"]')
    submit.disabled = true
    renameError.hidden = true
    try {
      const result = await m.chainRenameNode(theme.id, node.id, renameTitle.value.trim(), renameReason.value.trim())
      if (result?.ok === false) throw new Error(result.error || '改名未完成')
      toast('已追加改名事件；旧名保留在历史中')
      closeNodeDetail()
      opts.onChanged?.()
    } catch (error) {
      renameError.hidden = false
      renameError.textContent = error.message || String(error)
      submit.disabled = false
    }
  })
  let correctionDisclosure = null
  if (node.nodeType === 'viewpoint') {
    correctionDisclosure = h('details', { class: 'cog-action-disclosure cog-node-correction' },
      h('summary', {}, '修订观点说明（追加更正）'))
    const revisedText = h('textarea', {
      class: 'txt cog-entry-textarea', rows: '4', required: true, maxlength: '10000',
      'aria-label': '修订后的观点说明',
    })
    revisedText.value = String(node.currentText || node.detail || '')
    const applicability = h('input', {
      class: 'txt', type: 'text', maxlength: '160', value: node.applicability || '',
      placeholder: '适用时间（可选）', 'aria-label': '修订后的适用时间',
    })
    const reason = h('textarea', {
      class: 'txt cog-entry-textarea', rows: '2', required: true, maxlength: '1000',
      placeholder: '说明为何需要修订', 'aria-label': '观点修订原因',
    })
    const correctionAfter = h('p', {}, '')
    const correctionPreview = h('section', { class: 'engine-before-after', 'aria-label': '观点修订变更前后预览' },
      h('div', { class: 'engine-preview-column is-before' }, h('strong', {}, '当前版本'), h('p', {}, String(node.currentText || node.detail || node.title || '未记录'))),
      h('div', { class: 'engine-preview-arrow', 'aria-hidden': 'true' }, '→'),
      h('div', { class: 'engine-preview-column is-after' }, h('strong', {}, '确认后'), correctionAfter),
      h('p', { class: 'engine-preview-note' }, '预览不会写入；提交后以更正事件追加新版本，旧版本仍可回放。'))
    const updateCorrectionPreview = () => {
      correctionAfter.textContent = `${revisedText.value.trim() || '（待填写修订内容）'}${applicability.value.trim() ? ` · 适用时间：${applicability.value.trim()}` : ' · 适用时间未注明'}`
    }
    revisedText.addEventListener('input', updateCorrectionPreview)
    applicability.addEventListener('input', updateCorrectionPreview)
    updateCorrectionPreview()
    const correctionError = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const correctionForm = h('form', { class: 'cog-entry-form' },
      h('p', { class: 'cog-entry-note' }, '修订会沿当前版本追加 correction.appended；旧文本与适用时间历史仍可回放。'),
      h('label', { class: 'cog-entry-field' }, h('span', {}, '修订后的观点说明'), revisedText),
      h('label', { class: 'cog-entry-field' }, h('span', {}, '适用时间（可选）'), applicability),
      h('label', { class: 'cog-entry-field' }, h('span', {}, '修订原因（必填）'), reason),
      correctionPreview,
      correctionError,
      h('button', { type: 'submit', class: 'btn btn-primary' }, '预览并追加修订'))
    correctionForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!revisedText.value.trim() || !reason.value.trim()) {
        correctionError.hidden = false; correctionError.textContent = '请填写修订后的说明和修订原因。'; return
      }
      const submit = correctionForm.querySelector('button[type="submit"]')
      submit.disabled = true; correctionError.hidden = true
      try {
        const result = await m.chainCorrectNode(theme.id, node.id, {
          newValue: revisedText.value.trim(), reason: reason.value.trim(),
          applicability: applicability.value.trim(), requestId,
        })
        if (result?.ok === false) throw new Error(result.error || '修订未完成')
        toast(result?.event?.replayed ? '该修订已写入；重试已安全复用原事件' : '已追加更正事件；旧版本保留在历史中')
        closeNodeDetail()
        opts.onChanged?.()
      } catch (error) {
        correctionError.hidden = false; correctionError.textContent = error.message || String(error); submit.disabled = false
      }
    })
    correctionDisclosure.append(correctionForm)
  }
  const invalidationReason = h('textarea', { class: 'txt cog-entry-textarea', rows: '2', required: true, maxlength: '1000', placeholder: '说明为何该节点不再有效', 'aria-label': '失效原因' })
  const invalidateError = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const invalidateForm = h('form', { class: 'cog-entry-form' },
    h('label', { class: 'cog-entry-field' }, h('span', {}, '失效原因（必填）'), invalidationReason),
    invalidateError,
    h('button', { type: 'submit', class: 'btn cog-invalidate-button' }, '追加失效事件'))
  invalidateForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!invalidationReason.value.trim()) { invalidateError.hidden = false; invalidateError.textContent = '请填写失效原因。'; invalidationReason.focus(); return }
    const submit = invalidateForm.querySelector('button[type="submit"]')
    submit.disabled = true
    invalidateError.hidden = true
    try {
      const result = await m.chainInvalidateNode(theme.id, node.id, invalidationReason.value.trim())
      if (result?.ok === false) throw new Error(result.error || '失效标记未完成')
      toast('已追加失效事件；历史节点仍保留')
      closeNodeDetail()
      opts.onChanged?.()
    } catch (error) {
      invalidateError.hidden = false
      invalidateError.textContent = error.message || String(error)
      submit.disabled = false
    }
  })
  disclosure.append(...[correctionDisclosure, renameForm, invalidateForm].filter(Boolean))
  return h('section', { class: 'chain-dsect cog-action-section' }, disclosure)
}

function renderRelationComposer(proj, node, theme, opts) {
  const choices = (proj?.nodes || []).filter((candidate) => candidate.id !== node.id && !candidate.external
    && !candidate.archived && !candidate.invalidated)
  const disclosure = h('details', { class: 'cog-action-disclosure' }, h('summary', {}, '添加论证或主题关联'))
  if (!choices.length) {
    disclosure.append(h('p', { class: 'cog-entry-note' }, '暂时没有其他有效节点可连接。'))
    return h('section', { class: 'chain-dsect cog-action-section' }, disclosure)
  }
  const target = h('select', { class: 'txt', 'aria-label': '关系的另一个节点' },
    h('option', { value: '' }, '选择另一个网络节点'),
    ...choices.map((candidate) => h('option', { value: candidate.id }, `${NODE_TYPE_META[networkNodeType(candidate)].label} · ${candidate.title}`)))
  const relation = h('select', { class: 'txt', 'aria-label': '关系类型' },
    h('optgroup', { label: '论证关系 · 有方向' },
      ...['supports', 'derives', 'contradicts'].map((rel) => h('option', { value: rel }, REL[rel].label))),
    h('optgroup', { label: '主题关联 · 弱关系' },
      ...['belongs-to', 'influences', 'depends-on', 'temporal', 'related'].map((rel) => h('option', { value: rel }, REL[rel].label))))
  const preview = h('p', { class: 'cog-entry-note', 'aria-live': 'polite' }, '关系方向会在选择节点后显示。')
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const getDirection = () => {
    const other = choices.find((candidate) => candidate.id === target.value)
    if (!other) return null
    if (relation.value === 'supports' && networkNodeType(node) === 'evidence' && networkNodeType(other) !== 'evidence') return { from: node, to: other }
    if (relation.value === 'supports' && networkNodeType(node) !== 'evidence' && networkNodeType(other) === 'evidence') return { from: other, to: node }
    return { from: node, to: other }
  }
  const updatePreview = () => {
    const direction = getDirection()
    if (!direction) { preview.textContent = '选择另一个节点以查看关系说明。'; return }
    preview.textContent = REL[relation.value]?.group === 'argument'
      ? `${direction.from.title} —${REL[relation.value].label}→ ${direction.to.title}。这是用户声明的论证关系，不代表内容为真。`
      : `${direction.from.title} —${REL[relation.value]?.label || '关系'}— ${direction.to.title}。弱主题关联在网络中使用无箭头细线。`
  }
  target.addEventListener('change', updatePreview)
  relation.addEventListener('change', updatePreview)
  const form = h('form', { class: 'cog-entry-form' },
    h('p', { class: 'cog-entry-note' }, '支持、推导和反驳是有方向的论证关系；归属、影响、依赖、时间关联和相关使用弱线展示。声明不等于内容为真。'),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '关系类型'), relation),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '另一个节点'), target),
    preview, error,
    h('button', { type: 'submit', class: 'btn btn-primary' }, '追加关系'))
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const direction = getDirection()
    if (!direction) { error.hidden = false; error.textContent = '请先选择另一个节点。'; target.focus(); return }
    const button = form.querySelector('button[type="submit"]')
    button.disabled = true
    try {
      const result = await m.chainDeclareRelation(theme.id, direction.from.id, direction.to.id, relation.value)
      if (result?.ok === false) throw new Error(result.error || '保存未完成')
      toast('已追加关系声明')
      closeNodeDetail(); opts.onChanged?.()
    } catch (saveError) {
      error.hidden = false; error.textContent = saveError.message || String(saveError); button.disabled = false
    }
  })
  disclosure.append(form)
  return h('section', { class: 'chain-dsect cog-action-section' }, disclosure)
}

function renderNodeRelations(proj, nodeById, node, theme, opts) {
  const edges = (proj?.edges || []).filter((e) => e.from === node.id || e.to === node.id)
  if (!edges.length) return [h('p', { class: 'chain-note' }, '暂无语义关系。')]
  const eventsById = new Map((opts.historyContext?.events || []).map((event) => [event.id, event]))
  const renderEdge = (e) => {
    const otherId = e.from === node.id ? e.to : e.from
    const other = nodeById.get(otherId)
    const rel = REL[e.rel] || REL.supports
    const argument = rel.group === 'argument'
    const dir = argument ? (e.from === node.id ? '→' : '←') : '·'
    const status = e.pendingReview ? '待人工复核' : e.reviewDecision === 'confirmed' ? '已由用户确认'
      : e.reviewDecision === 'rejected' ? '已由用户驳回' : '用户声明 · 未自动验证'
    const decisionEvent = e.reviewEventId ? eventsById.get(e.reviewEventId) : null
    const declarationEvent = eventsById.get(e.eventId)
    return h('div', { class: `chain-relation-item${e.pendingReview ? ' is-pending' : ''}${e.reviewDecision === 'rejected' ? ' is-rejected' : ''}` },
      h('button', {
        type: 'button', class: 'chain-evidence', title: other && !other.external ? '查看该节点' : '',
        onclick: () => { if (other && !other.external) openNodeDetail(theme, other, opts) },
      },
        h('span', { class: 'chain-evidence-type', style: `color:${rel.color}` }, `${status} · ${rel.label} ${dir}${argument ? '' : ' 弱关联'}`),
        h('span', { class: 'chain-evidence-id' }, other ? other.title : '来源未解析')),
      e.reviewReason ? h('p', { class: 'chain-note' }, `决定理由：${e.reviewReason}`) : null,
      e.reviewedBy || e.reviewedAt ? h('p', { class: 'chain-note' }, `决定者：${ACTOR_LABEL[e.reviewedBy] || e.reviewedBy || '未记录'} · 时间：${fmtAt(e.reviewedAt)}`) : null,
      e.pendingReview && declarationEvent ? h('button', { type: 'button', class: 'btn cog-event-focus', onclick: () => opts.onJumpToEvent?.(declarationEvent) }, `前往账本复核 · 第 ${declarationEvent.seq} 条`) : null,
      decisionEvent ? h('button', { type: 'button', class: 'btn cog-event-focus', onclick: () => opts.onJumpToEvent?.(decisionEvent) }, `查看决定事件 · 第 ${decisionEvent.seq} 条`) : null)
  }
  /* 论证关系（强语义：支持/推导/反驳）与主题关联（弱语义）分组展示。 */
  const argumentEdges = edges.filter((e) => (REL[e.rel] || REL.supports).group === 'argument')
  const associationEdges = edges.filter((e) => (REL[e.rel] || REL.supports).group !== 'argument')
  const sections = []
  if (argumentEdges.length) {
    sections.push(h('p', { class: 'chain-relations-group-label' }, `论证关系（${argumentEdges.length}）`),
      ...argumentEdges.map(renderEdge))
  }
  if (associationEdges.length) {
    sections.push(h('p', { class: 'chain-relations-group-label' }, `主题关联（${associationEdges.length}）`),
      ...associationEdges.map(renderEdge))
  }
  return sections
}

function renderHistoryEvent(e, opts = {}) {
  const p = e.payload || {}
  const at = String(e.at || '').slice(0, 10)
  const actor = ACTOR_LABEL[e.actor] || e.actor || ''
  let summary = ''
  if (e.type === 'correction.appended') {
    summary = `${p.oldValue || '—'} → ${p.newValue || '—'}${p.reason ? `（${p.reason}）` : ''}`
  } else if (e.type === 'relation.declared') {
    summary = p.reviewOf
      ? `人工复核${p.reviewDecision === 'confirmed' ? '确认' : '驳回'} · ${p.decisionReason || '未记录理由'}`
      : `${(REL[p.rel] || {}).label || p.rel}${p.reviewStatus === 'pending-review' || p.rel === 'derives' ? '（待确认）' : ''}${p.mapping ? ` · ${p.mapping}` : ''}`
  } else if (e.type === 'settlement.recorded') {
    summary = p.correct === false ? '判定为错误' : p.correct === true ? '判定为正确' : '已结算'
  } else if (e.type === 'node.archived') {
    summary = `归档：${p.reason || '未记录原因'}`
  } else if (e.type === 'node.restored') {
    summary = `恢复：${p.reason || '未记录原因'}`
  } else if (e.type === 'node.renamed') {
    summary = `${p.previousTitle || '旧名未记录'} → ${p.newTitle || '新名未记录'}${p.reason ? `（${p.reason}）` : ''}`
  } else if (e.type === 'node.invalidated') {
    summary = `失效：${p.title || '节点'}${p.reason ? `（${p.reason}）` : ''}`
  } else if (e.type === 'node.created') {
    summary = `${NODE_TYPE_META[p.nodeType]?.label || '节点'}：${p.title || '未命名节点'}${p.detail ? ` · ${p.detail}` : ''}`
  } else if (e.type === 'evidence.appended') {
    summary = String(p.text || p.reason || '').slice(0, 80)
  } else {
    summary = String(p.title || p.coreInfo || p.text || '').slice(0, 80)
  }
  const typeLabel = e.type === 'relation.declared' && p.reviewOf ? '关系复核决定' : (TYPE_LABEL[e.type] || e.type)
  const jump = typeof opts.onJumpToEvent === 'function'
    ? h('button', { type: 'button', class: 'btn cog-event-focus', onclick: () => opts.onJumpToEvent(e) }, `跳回账本 · 第 ${e.seq} 条`)
    : null
  return h('div', { class: 'chain-log-item' },
    h('div', { class: 'chain-log-at' }, `v${String(e.seq).padStart(2, '0')} · ${at}${actor ? ` · ${actor}` : ''}`),
    h('div', { class: 'chain-log-body' },
      h('div', { class: 'chain-log-delta' },
        h('span', { class: 'chain-log-new' }, typeLabel)),
      summary ? h('div', { class: 'chain-log-reason' }, summary) : null,
      jump))
}

/** 证据引用：命题走右栏（selectNode），读数/收件箱走 onEvidence。 */
function renderNodeEvidence(lineage, opts) {
  const seen = new Set()
  const refs = []
  for (const e of lineage) {
    const arr = e.payload?.evidenceRefs
    if (!Array.isArray(arr)) continue
    for (const r of arr) {
      const key = `${r.type}:${r.id}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(r)
    }
  }
  if (!refs.length) return [h('p', { class: 'chain-note' }, '暂无证据引用。')]
  return refs.map((ref) => {
    if (ref.type === 'lemma') {
      const node = (state.nodes || []).find((n) => n.id === ref.id)
      return h('div', { class: 'chain-evidence-wrap' },
        h('button', {
          type: 'button', class: 'chain-evidence', title: node ? '在右栏查看命题详情' : '该历史命题当前未解析',
          disabled: !node,
          onclick: () => { closeNodeDetail(); selectNode(ref.id) },
        },
          h('span', { class: 'chain-evidence-type' }, '旧命题'),
          h('span', { class: `chain-evidence-id${node ? '' : ' is-unresolved'}` }, node?.title || ref.title || '来源未解析'),
          h('span', { class: 'chain-evidence-conf' }, node ? '对象已解析 · 来源真实性未核验' : '引用未解析 · 仅保存原始引用名')),
        !node ? h('details', { class: 'chain-technical' }, h('summary', {}, '技术详情 · 原始命题 ID'),
          h('p', { class: 'chain-note' }, String(ref.id || '未记录')),
          ref.id ? h('button', { type: 'button', class: 'cog-copy-btn', onclick: () => copyLedgerReference(ref.id, '命题 ID') }, '复制命题 ID') : null) : null)
    }
    const label = ref.type === 'reading' ? '读数' : '收件箱条目'
    return h('div', { class: 'chain-evidence-wrap' },
      h('button', {
        type: 'button', class: 'chain-evidence',
        onclick: () => opts.onEvidence?.(ref),
      }, h('span', { class: 'chain-evidence-type' }, label),
        h('span', { class: `chain-evidence-id${ref.title ? '' : ' is-unresolved'}` }, ref.title || ref.id || '来源未解析')),
      h('p', { class: 'chain-note is-unresolved' }, '引用尚未在账本外部解析；名称与 ID 均不代表来源已核实。'),
      h('details', { class: 'chain-technical' }, h('summary', {}, '技术详情 · 原始引用 ID'),
        h('p', { class: 'chain-note' }, String(ref.id || '未记录')),
        ref.id ? h('button', { type: 'button', class: 'cog-copy-btn', onclick: () => copyLedgerReference(ref.id, '引用 ID') }, '复制引用 ID') : null))
  })
}

export function closeNodeDetail() {
  document.querySelectorAll('.chain-drawer, .chain-drawer-backdrop').forEach((el) => el.remove())
}
export async function openEvidenceDetail(ref) {
  try {
    if (ref.type === 'reading') {
      const res = await m.readingEvidence({ observationId: ref.id, limit: 1 }).catch(() => null)
      const item = res?.items?.[0]
      if (!item) { toast('读数不存在或已被清理', 'var(--red)'); return }
      // 切到读数页并高亮：读数页按 indicator 分组，直接打开证据浮层更直接
      openReadingModal(item)
      return
    }
    toast('收件箱条目跳转 coming soon', 'var(--text-2)')
  } catch (e) {
    toast('打开依据失败：' + (e.message || e), 'var(--red)')
  }
}

function openReadingModal(reading) {
  closeNodeDetail()
  const backdrop = h('div', { class: 'chain-drawer-backdrop' })
  const drawer = h('aside', { class: 'chain-drawer', role: 'dialog', 'aria-label': '读数详情' })
  const close = () => {
    backdrop.classList.remove('show'); drawer.classList.remove('show')
    setTimeout(() => { backdrop.remove(); drawer.remove() }, 280)
  }
  const src = reading.source || {}
  drawer.append(
    h('div', { class: 'chain-drawer-head' },
      h('div', { class: 'chain-drawer-title' }, reading.indicator || reading.metric || '读数'),
      h('button', { type: 'button', class: 'btn btn-icon', title: '关闭', onclick: close }, '✕')),
    h('div', { class: 'chain-drawer-body' },
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '数值'),
        h('p', { class: 'chain-dcore' }, `${reading.value ?? '—'} ${reading.unit || ''}`),
        h('p', { class: 'chain-note' }, `周期：${reading.period?.start || ''} ~ ${reading.period?.end || ''}`)),
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '来源'),
        h('p', {}, src.label || '—'),
        src.url ? h('button', {
          type: 'button', class: 'chain-linkbtn',
          onclick: async () => { try { await m.openExternal(src.url) } catch { toast('无法打开来源链接', 'var(--red)') } },
        }, '在系统浏览器打开原文 ↗') : null),
      h('section', { class: 'chain-dsect' },
        h('button', {
          type: 'button', class: 'btn',
          onclick: () => { close(); state.readingHighlight = reading.id; setView('readings') },
        }, '去读数页查看')),
    ))
  backdrop.onclick = close
  document.body.append(backdrop, drawer)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('show'); drawer.classList.add('show')
  }))
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 快速归因：收件箱里配好（命题 + 支持/反驳），一键在主题里自动连好。    */
/* URL 从条目来源自动带，不用手工填。                                    */
/* ------------------------------------------------------------------ */

function renderQuickAttribute(item, { themeId, loadExisting, onDone } = {}) {
  const wrap = h('div', { class: 'quick-attr' },
    h('div', { class: 'draft-head' },
      h('span', { class: 'draft-title' }, '快速归因'),
      h('span', { class: 'draft-sub' }, '选命题、选支持/反驳，确认后自动在主题里连好')))
  if (!themeId) {
    wrap.append(h('p', { class: 'chain-note' }, '该条目没有可用主题，无法快速归因。'))
    return wrap
  }
  const propSelect = h('select', { class: 'txt', 'aria-label': '目标命题' },
    h('option', { value: '' }, '正在加载命题…'))
  let stance = 'supports'
  const stanceSeg = h('div', { class: 'cog-seg', role: 'group', 'aria-label': '支持或反驳' })
  const stanceBtns = {}
  for (const [value, label] of [['supports', '支持'], ['contradicts', '反驳']]) {
    const btn = h('button', { type: 'button', class: 'cog-seg-btn', 'aria-pressed': String(value === stance) }, label)
    btn.classList.toggle('is-active', value === stance)
    btn.addEventListener('click', () => {
      stance = value
      for (const [v, b] of Object.entries(stanceBtns)) {
        b.classList.toggle('is-active', v === stance)
        b.setAttribute('aria-pressed', String(v === stance))
      }
    })
    stanceBtns[value] = btn
    stanceSeg.append(btn)
  }
  const textInput = h('textarea', {
    class: 'txt cog-modal-textarea', rows: '3', 'aria-label': '证据内容',
    placeholder: '证据摘要或原文摘录（必填）',
  }, (item.text || '').slice(0, 500))
  const urlInput = h('input', {
    class: 'txt', type: 'url', 'aria-label': '来源链接',
    placeholder: '来源链接（自动填入，可改）',
    value: item.provenance?.url || '',
  })
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const confirmBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '确认并连接')
  /* 命题列表异步加载 */
  Promise.resolve(loadExisting?.()).then((list) => {
    const rows = Array.isArray(list) ? list : []
    propSelect.innerHTML = ''
    if (!rows.length) {
      propSelect.append(h('option', { value: '' }, '该主题暂无命题'))
      confirmBtn.disabled = true
      return
    }
    propSelect.append(h('option', { value: '' }, '选择目标命题…'))
    for (const p of rows) propSelect.append(h('option', { value: p.id }, p.name || '未命名命题'))
  }).catch(() => {
    propSelect.innerHTML = ''
    propSelect.append(h('option', { value: '' }, '命题加载失败'))
    confirmBtn.disabled = true
  })
  confirmBtn.addEventListener('click', async () => {
    const propId = propSelect.value
    const text = textInput.value.trim()
    if (!propId) { error.hidden = false; error.textContent = '请选择目标命题。'; propSelect.focus(); return }
    if (!text) { error.hidden = false; error.textContent = '请填写证据内容。'; textInput.focus(); return }
    error.hidden = true
    confirmBtn.disabled = true
    try {
      const input = { text, rel: stance }
      const url = urlInput.value.trim()
      if (url) input.url = url
      /* 复用建设者的归因后端：只追加 evidence.appended + relation.declared */
      const res = await m.chainAddEvidence(themeId, propId, input)
      if (res?.ok === false) throw new Error(res.error || '写入失败')
      /* 标记条目已归因 */
      await m.inboxResolve?.(item.id, 'accept').catch(() => null)
      toast(stance === 'supports' ? '已连接到命题（支持）' : '已连接到命题（反驳）')
      onDone?.(res)
    } catch (e) {
      error.hidden = false
      error.textContent = e?.message || String(e)
      confirmBtn.disabled = false
    }
  })
  wrap.append(
    h('div', { class: 'quick-attr-row' },
      h('span', { class: 'draft-label' }, '命题'), propSelect),
    h('div', { class: 'quick-attr-row' },
      h('span', { class: 'draft-label' }, '立场'), stanceSeg),
    textInput, urlInput, error,
    h('div', { class: 'draft-actions' }, confirmBtn))
  return wrap
}

/* ------------------------------------------------------------------ */
/* 认知发动机 UI：四步流水线（抽取→分类→匹配→归因），人确认后闭环。       */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* 内联归因：点支持/反驳后，表单在原地展开，填完回车即确认。不弹框。      */
/* ------------------------------------------------------------------ */

function openInlineAttribution(theme, node, presetRel, container, { onChanged } = {}) {
  if (!node || !container) return
  /* 如果已有展开的表单，先收起 */
  container.querySelector('.inline-attr-form')?.remove()
  let rel = presetRel === 'contradicts' ? 'contradicts' : 'supports'
  const form = h('div', { class: 'inline-attr-form' })
  const seg = h('div', { class: 'cog-seg', role: 'group', 'aria-label': '支持或反驳' })
  const btns = {}
  for (const [value, label] of [['supports', '支持'], ['contradicts', '反驳']]) {
    const btn = h('button', { type: 'button', class: 'cog-seg-btn', 'aria-pressed': String(value === rel) }, label)
    btn.classList.toggle('is-active', value === rel)
    btn.addEventListener('click', () => {
      rel = value
      for (const [v, b] of Object.entries(btns)) {
        b.classList.toggle('is-active', v === rel)
        b.setAttribute('aria-pressed', String(v === rel))
      }
    })
    btns[value] = btn
    seg.append(btn)
  }
  const textInput = h('textarea', { class: 'txt', rows: '3', placeholder: '证据摘要或原文摘录', 'aria-label': '证据内容' })
  const urlInput = h('input', { class: 'txt', type: 'url', placeholder: '来源链接（选填）', 'aria-label': '来源链接' })
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const actions = h('div', { class: 'inline-attr-actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => form.remove() }, '取消'),
    h('button', { type: 'button', class: 'btn btn-primary' }, '确认'))
  const confirmBtn = actions.querySelector('.btn-primary')
  confirmBtn.addEventListener('click', async () => {
    const text = textInput.value.trim()
    if (!text) { error.hidden = false; error.textContent = '请填写证据内容。'; textInput.focus(); return }
    error.hidden = true
    confirmBtn.disabled = true
    try {
      const input = { text, rel }
      const url = urlInput.value.trim()
      if (url) input.url = url
      const res = await m.chainAddEvidence(theme.id, node.id, input)
      if (res?.ok === false) throw new Error(res.error || '写入失败')
      toast(rel === 'supports' ? '已支持' : '已反驳')
      form.remove()
      onChanged?.()
    } catch (e) {
      error.hidden = false
      error.textContent = e.message || String(e)
      confirmBtn.disabled = false
    }
  })
  /* 回车确认（Shift+回车换行） */
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmBtn.click() }
  })
  form.append(seg, textInput, urlInput, error, actions)
  /* 插到操作按钮后面 */
  const actionsBar = container.querySelector('.cog-wb-detail-actions')
  if (actionsBar) actionsBar.after(form)
  else container.append(form)
  textInput.focus()
}

/* 提案草稿：收件箱条目详情内展开。只起草、不拍板；用户点"确认挂载"生效。 */
/* ------------------------------------------------------------------ */

/** 简单相似度：新段名 vs 已有段名，提醒防重（不拦截）。 */
function segNameSimilarity(a, b) {
  const x = String(a || '').trim().toLowerCase()
  const y = String(b || '').trim().toLowerCase()
  if (!x || !y || x === y) return 0
  if (x.includes(y) || y.includes(x)) return 0.9
  // 字符级 Jaccard
  const set = (s) => new Set([...s])
  const sx = set(x), sy = set(y)
  let inter = 0
  for (const c of sx) if (sy.has(c)) inter++
  const union = new Set([...sx, ...sy]).size
  return union ? inter / union : 0
}

/**
 * 提案草稿区（认知链挂载）。
 * 只起草、不拍板；用户点"确认挂载"才写入主题链。
 * @param item 收件箱条目（含 chainDraft）
 * @param existingSegments 该主题已有段名列表 [{id, name}]
 * @param opts { themeId, bare, onDraft(), onMounted() }
 *   bare=true 时只返回内容体（无 section 包裹与大标题），由调用方嵌入「确认归位」。
 */
export function renderProposalDraft(item, existingSegments = [], opts = {}) {
  const draft = item.chainDraft
  let segs = Array.isArray(existingSegments) ? existingSegments : []
  const themeId = opts.themeId
  const box = opts.bare
    ? h('div', { class: 'chain-draft' })
    : h('section', { class: 'inbox-detail-section' },
      h('h4', { class: 'inbox-section-title' }, '提案草稿 · 认知链挂载'))

  /* 快速归因：选命题 + 支持/反驳，一键在主题里连好（URL 自动带）。 */
  box.append(renderQuickAttribute(item, { themeId, loadExisting: opts.loadExisting, onDone: opts.onMounted }))

  /* 认知发动机：四步流水线（抽取→分类→匹配→归因） */
  box.append(renderEnginePipeline(item, { themeId, onDone: opts.onMounted }))

  const head = (sub) => h('div', { class: 'draft-head' },
    h('span', { class: 'draft-title' }, '认知链挂载'),
    sub ? h('span', { class: 'draft-sub' }, sub) : null)

  // 无草稿：生成按钮
  if (!draft || draft.status !== 'draft') {
    const genBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '用模型起草')
    const manualBtn = h('button', { type: 'button', class: 'btn' }, '手动起草')
    genBtn.onclick = async () => {
      genBtn.disabled = true
      try {
        const res = await m.chainGenerateDraft(item.id)
        if (res?.ok && res.draft) {
          item.chainDraft = res.draft
          toast('草稿已生成，请检查后确认挂载')
          opts.onDraft?.()
        } else {
          toast('生成失败：' + (res?.error || '未配置 API key，可手动起草'), 'var(--red)')
        }
      } catch (e) {
        toast('生成失败：' + (e.message || e), 'var(--red)')
      } finally { genBtn.disabled = false }
    }
    manualBtn.onclick = () => {
      item.chainDraft = {
        segmentNames: [], newSegmentName: '', coreInfo: '', oldValue: '', newValue: '',
        evidence: '', falsifier: '', status: 'draft', createdBy: 'user', createdAt: new Date().toISOString().slice(0, 10),
      }
      opts.onDraft?.()
    }
    box.append(
      head('草稿只给建议：挂到哪个段、参数怎么变，最终由你确认'),
      h('div', { class: 'draft-actions draft-actions-start' }, genBtn, manualBtn),
    )
    return box
  }

  // 有草稿：可编辑表单
  const segNames = Array.isArray(draft.segmentNames) ? [...draft.segmentNames] : []
  const warnBox = h('p', { class: 'draft-warn', hidden: true })

  // 已有段多选 chips
  const checkWrap = h('div', { class: 'draft-chips' })
  const toggleSeg = (name) => {
    const i = segNames.indexOf(name)
    if (i < 0) segNames.push(name)
    else segNames.splice(i, 1)
    refreshChecks()
  }
  const refreshChecks = () => {
    clear(checkWrap)
    for (const s of segs) {
      const on = segNames.includes(s.name)
      checkWrap.append(h('button', {
        type: 'button', class: `draft-chip${on ? ' on' : ''}`, 'aria-pressed': String(on),
        onclick: () => toggleSeg(s.name),
      }, h('span', { class: 'draft-chip-dot' }), h('span', {}, s.name)))
    }
    if (!segs.length) checkWrap.append(h('span', { class: 'draft-empty-note' }, '该主题还没有段，可在下方新开。'))
  }
  refreshChecks()
  // 已有命题改为从认知投影异步加载（不再读旧 chain.segments）
  if (typeof opts.loadExisting === 'function') {
    opts.loadExisting()
      .then((list) => { if (Array.isArray(list) && list.length) { segs = list; refreshChecks() } })
      .catch(() => {})
  }

  // 新开段名输入 + 自动补全 + 相似提醒
  const nameInput = h('input', {
    class: 'txt draft-input', placeholder: '新开一段，比如：供给侧', value: draft.newSegmentName || '',
    autocomplete: 'off',
  })
  const suggestBox = h('div', { class: 'draft-suggest', hidden: true })
  const checkSimilar = () => {
    const v = nameInput.value.trim()
    if (!v) { warnBox.hidden = true; suggestBox.hidden = true; return }
    // 自动补全：前缀匹配
    const cands = segs.filter((s) => s.name.toLowerCase().startsWith(v.toLowerCase()) && s.name !== v).slice(0, 5)
    clear(suggestBox)
    if (cands.length) {
      suggestBox.hidden = false
      for (const c of cands) {
        suggestBox.append(h('button', {
          type: 'button', class: 'draft-suggest-item',
          onclick: () => {
            nameInput.value = c.name
            if (!segNames.includes(c.name)) segNames.push(c.name)
            refreshChecks(); checkSimilar()
          },
        }, c.name))
      }
    } else suggestBox.hidden = true
    // 相似提醒：不拦截
    const sims = segs
      .map((s) => ({ name: s.name, sim: segNameSimilarity(v, s.name) }))
      .filter((x) => x.sim >= 0.6)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 2)
    if (sims.length) {
      warnBox.hidden = false
      clear(warnBox).append(`已有相似段「${sims.map((x) => x.name).join('」「')}」，确定要新开吗？`)
    } else warnBox.hidden = true
  }
  nameInput.addEventListener('input', checkSimilar)

  const coreInput = h('input', { class: 'txt draft-input', placeholder: '一句话说清这次认知变化', value: draft.coreInfo || '' })
  const oldInput = h('input', { class: 'txt draft-input', placeholder: '变更前', value: draft.oldValue || '' })
  const newInput = h('input', { class: 'txt draft-input', placeholder: '变更后', value: draft.newValue || '' })
  const evInput = h('input', { class: 'txt draft-input', placeholder: '一句话依据', value: draft.evidence || '' })
  const falInput = h('input', { class: 'txt draft-input', placeholder: '什么情况下这个判断会失效', value: draft.falsifier || '' })

  const mountBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '确认挂载')
  const dismissBtn = h('button', { type: 'button', class: 'btn' }, '放弃草稿')
  const saveDraft = async () => {
    const payload = {
      segmentNames: segNames, newSegmentName: nameInput.value.trim(),
      coreInfo: coreInput.value.trim(), oldValue: oldInput.value.trim(), newValue: newInput.value.trim(),
      evidence: evInput.value.trim(), falsifier: falInput.value.trim(),
      status: 'draft', createdBy: draft.createdBy || 'user', createdAt: draft.createdAt,
    }
    const res = await m.chainSetDraft(item.id, payload).catch(() => null)
    if (res?.ok) item.chainDraft = { ...payload }
    return !!res?.ok
  }

  mountBtn.onclick = async () => {
    const allSegs = [...segNames]
    if (nameInput.value.trim() && !allSegs.includes(nameInput.value.trim())) allSegs.push(nameInput.value.trim())
    if (!allSegs.length) { toast('请至少选择或新开一个段', 'var(--red)'); return }
    if (!newInput.value.trim() && !coreInput.value.trim()) { toast('请填写新值或核心信息', 'var(--red)'); return }
    mountBtn.disabled = true
    try {
      await saveDraft()
      if (!themeId) { toast('该条目没有可用主题，无法挂载', 'var(--red)'); mountBtn.disabled = false; return }
      // 条目的命题一并记为证据引用（只读展示置信度，不创建/修改 lemma）
      const lemmaRefs = (item.lemmas || [])
        .filter((l) => l.id)
        .map((l) => ({ type: 'lemma', id: l.id, title: l.title }))
      const res = await m.chainMountEvent(themeId, {
        inboxId: item.id,
        segmentNames: allSegs,
        coreInfo: coreInput.value.trim(),
        oldValue: oldInput.value.trim(),
        newValue: newInput.value.trim(),
        evidence: evInput.value.trim(),
        falsifier: falInput.value.trim(),
        evidenceRefs: [{ type: 'inbox', id: item.id, title: item.title }, ...lemmaRefs],
      })
      if (res?.ok) {
        item.chainDraft = { ...item.chainDraft, status: 'mounted', mountedAt: new Date().toISOString().slice(0, 10) }
        toast(`已挂载到「${allSegs.join('」「')}」`)
        opts.onMounted?.(res)
      } else {
        toast('挂载失败：' + (res?.error || '请重试'), 'var(--red)')
      }
    } catch (e) {
      toast('挂载失败：' + (e.message || e), 'var(--red)')
    } finally { mountBtn.disabled = false }
  }
  dismissBtn.onclick = async () => {
    await m.chainSetDraft(item.id, null).catch(() => null)
    item.chainDraft = null
    toast('草稿已放弃')
    opts.onDraft?.()
  }

  const field = (label, el) => h('div', { class: 'draft-group' },
    h('div', { class: 'draft-label' }, label), el)
  const srcLabel = { agent: '助手研究', llm: '模型起草', user: '手动' }[draft.createdBy] || '未知'
  box.append(
    head(`草稿来源：${srcLabel} · 只给建议，由你确认`),
    field('挂到已有段 · 可多选', checkWrap),
    field('新开一段', h('div', {}, nameInput, suggestBox)),
    warnBox,
    field('核心信息', coreInput),
    h('div', { class: 'draft-duo' }, field('旧值', oldInput), field('新值', newInput)),
    field('依据', evInput),
    field('证伪条件', falInput),
    h('div', { class: 'draft-actions' }, dismissBtn, mountBtn),
  )
  return box
}
