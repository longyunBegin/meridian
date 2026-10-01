/**
 * 认知链 · 概念 01 + 02（P2 重做版）
 *
 * 左：追加式完整性账本（事件序列，只增不改；更正追加新事件，历史保留）。
 * 右：当前认知图（只读投影）——分层语义布局：研究主题在上、主张/推断居中、
 *     证据在下；边带关系名标注；主题根节点以虚线连接顶层主张/推断。
 * 替换旧分层链视图；旧分层、旧连线、旧段抽屉代码已删除，不并存。
 *
 * 保留：renderProposalDraft（收件箱挂载，现走 chain:mountEvent 只追加事件）、
 * openEvidenceDetail（读数/收件箱依据详情）。
 *
 * 公理1：本视图只读投影，不创建/修改/删除 lemma，不改 confidence，不代审批。
 */
import { h, clear, mount, toast } from '../lib/dom.js'
import { state, setView, selectNode } from '../app.js'
import { resolveEventReference } from '../lib/chain-reference.js'
import { LEDGER_PAGE_SIZE, FLOATING_PAGE_SIZE, GRAPH_FRAME_NODE_LIMIT, GRAPH_FRAME_EDGE_LIMIT, paginate, countFloating, floatingStatusKey, selectGraphWindow, consumeChainEventJump, affectedNodeIdForEvent, verifiedLedgerPrefix, eventsThroughSequence, compactEventSummary, searchGraphNodes, independentMediaEvidence } from '../lib/chain-ui-model.js'

const m = window.meridian
const SVG_NS = 'http://www.w3.org/2000/svg'
const ledgerPageByTheme = new Map()
let chainSectionCounter = 0
const CLAIM_PAGE_SIZE = 20
const SEARCH_RESULTS_PAGE_SIZE = 30

/** 节点语义色（对齐概念图）。 */
const KIND = {
  theme: { label: '研究主题', color: '#475569', bg: '#ffffff', border: '#cbd5e1' },
  claim: { label: '观点', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  inference: { label: '推断', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  evidence: { label: '证据', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0' },
}
/** 关系语义色（对齐概念图）。 */
const REL = {
  supports: { label: '支持', color: '#2563eb' },
  derives: { label: '推导', color: '#7c3aed' },
  contradicts: { label: '反驳', color: '#b54708' },
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
  'evidence.appended': '证据追加',
  'claim.created': '主张创建',
  'inference.created': '推断创建',
  'relation.declared': '关系声明',
  'correction.appended': '更正',
  'settlement.recorded': '结算',
  'node.archived': '归档',
  'node.restored': '恢复',
  'topic.linked': '主题关联',
}
const ACTOR_LABEL = { user: '你', migration: '迁移', 'pipeline:capture': '收件箱捕获' }

const NODE_SIZE = {
  theme: { w: 170, h: 56 },
  claim: { w: 150, h: 56 },
  inference: { w: 140, h: 52 },
  evidence: { w: 108, h: 42 },
}
const nodeSize = (n) => NODE_SIZE[n.kind] || NODE_SIZE.claim

/* ------------------------------------------------------------------ */
/* 认知链区块：主题页内的语义图谱                                       */
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
  const replayStatus = h('span', { class: 'cog-replay-status', role: 'status', 'aria-live': 'polite', 'data-replay-status': '', hidden: true })
  const concept = h('div', { class: 'cog-concept cog-reading-layout' })
  const ledgerBackdrop = h('div', { class: 'cog-ledger-backdrop', hidden: true, 'aria-hidden': 'true' })
  const ledgerPane = h('aside', {
    class: 'cog-ledger-pane cog-ledger-drawer', id: drawerId,
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': drawerTitleId, tabindex: '-1', hidden: true,
  }, h('p', { class: 'chain-note' }, '正在读取事件…'))
  const replayControlsSlot = h('div', { class: 'cog-ledger-replay-slot' })
  const graphPane = h('div', { class: 'cog-graph-pane', 'aria-label': '认知图谱阅读区' })
  const stage = h('div', { class: 'cog-stage' })
  graphPane.append(stage)
  const themeStats = h('section', { class: 'cog-theme-stats', role: 'group', 'aria-label': '主题动态统计' },
    ...[
      ['points', '观点与推断'],
      ['evidence', '证据条目'],
      ['events', '账本事件'],
      ['integrity', '账本完整性'],
    ].map(([key, label]) => h('div', { class: `cog-theme-stat${key === 'integrity' ? ' is-integrity' : ''}`, 'data-theme-stat': key },
      h('span', { class: 'cog-theme-stat-label' }, label),
      h('strong', { class: 'cog-theme-stat-value', 'data-theme-stat-value': key, 'aria-live': key === 'integrity' ? 'polite' : 'off' }, '—'))))
  const chainPanelId = `${drawerId}-chain-panel`
  const overviewPanelId = `${drawerId}-overview-panel`
  const chainTab = h('button', { type: 'button', class: 'cog-theme-tab', role: 'tab', id: `${drawerId}-chain-tab`, 'aria-controls': chainPanelId, 'aria-selected': 'true', tabindex: '0' }, 'Chain')
  const overviewTab = h('button', { type: 'button', class: 'cog-theme-tab', role: 'tab', id: `${drawerId}-overview-tab`, 'aria-controls': overviewPanelId, 'aria-selected': 'false', tabindex: '-1' }, 'Overview')
  const tabs = h('div', { class: 'cog-theme-tabs', role: 'tablist', 'aria-label': '主题视图' }, chainTab, overviewTab)
  const chainPanel = h('div', { class: 'cog-chain-panel', id: chainPanelId, role: 'tabpanel', 'aria-labelledby': chainTab.id, tabindex: '0' }, graphPane)
  const overviewContent = h('div', { class: 'cog-overview-content' })
  const overviewPanel = h('section', { class: 'cog-overview-panel', id: overviewPanelId, role: 'tabpanel', 'aria-labelledby': overviewTab.id, tabindex: '0', hidden: true },
    h('h2', { class: 'cog-overview-title' }, '主题概览'),
    h('p', { class: 'cog-overview-caption' }, '以下内容仅汇总此主题当前投影与已校验事件；账本校验状态不等于观点已证实。'),
    overviewContent)
  const activateTab = (tab, focus = false) => {
    const isChain = tab === chainTab
    chainTab.setAttribute('aria-selected', String(isChain))
    overviewTab.setAttribute('aria-selected', String(!isChain))
    chainTab.tabIndex = isChain ? 0 : -1
    overviewTab.tabIndex = isChain ? -1 : 0
    chainPanel.hidden = !isChain
    overviewPanel.hidden = isChain
    if (focus) tab.focus()
  }
  chainTab.addEventListener('click', () => activateTab(chainTab))
  overviewTab.addEventListener('click', () => activateTab(overviewTab))
  tabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' || event.key === 'ArrowLeft' ? chainTab
      : event.key === 'End' || event.key === 'ArrowRight' ? overviewTab : chainTab
    activateTab(next, true)
  })
  concept.append(ledgerBackdrop, ledgerPane, themeStats, tabs, chainPanel, overviewPanel)
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
  ledgerPane.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeLedger(); return }
    if (event.key !== 'Tab') return
    const focusable = [...ledgerPane.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary')]
      .filter((element) => !element.hidden && getComputedStyle(element).display !== 'none')
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
      h('div', { class: 'chain-kicker' }, '认知链'),
      h('div', { class: 'chain-counts', 'data-cog-counts': '' }, '正在重放事件…')),
    h('div', { class: 'cog-global-actions' }, integrityBadge, replayStatus, ledgerButton))
  const wrap = h('section', { class: 'chain-section', 'aria-label': '认知链' }, toolbar, concept)
  const viewOpts = {
    ...opts,
    closeLedger,
    openLedger,
    replayControlsSlot,
    ledgerTitleId: drawerTitleId,
    themeStats,
    overviewContent,
    chainPanel,
    overviewPanel,
    onChanged: () => {
      clear(ledgerPane)
      clear(stage)
      clear(overviewContent)
      loadConcept(theme, ledgerPane, stage, viewOpts).catch((e) => {
        clear(stage).append(h('p', { class: 'chain-note' }, '投影刷新失败：' + (e.message || e)))
      })
    },
  }
  loadConcept(theme, ledgerPane, stage, viewOpts).catch((e) => {
    clear(stage).append(h('p', { class: 'chain-note' }, '投影加载失败：' + (e.message || e)))
  })
  return wrap
}

function updateThemeStats(stats, projection, events) {
  if (!stats) return
  const nodes = projection?.allNodes || projection?.nodes || []
  const points = nodes.filter((node) => !node.external && ['claim', 'inference'].includes(node.kind)).length
  const evidence = nodes.filter((node) => !node.external && node.kind === 'evidence').length
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

function renderOverviewContent(container, projection, verifiedEvents, onOpenEvent) {
  if (!container) return
  clear(container)
  const counts = { claim: 0, inference: 0, evidence: 0 }
  for (const node of (projection?.allNodes || projection?.nodes || [])) {
    if (!node.external && counts[node.kind] !== undefined) counts[node.kind]++
  }
  container.append(
    h('div', { class: 'cog-overview-count-line' }, `观点 ${counts.claim} · 推断 ${counts.inference} · 证据 ${counts.evidence}`),
    h('h3', { class: 'cog-overview-title', style: { marginTop: '18px' } }, '最近记录'),
  )
  const recent = verifiedEvents.slice(-8).reverse()
  if (!recent.length) {
    container.append(h('p', { class: 'cog-overview-empty' }, '还没有账本事件。主题根节点是展示元数据；添加观点后，相关记录会出现在这里。'))
    return
  }
  const list = h('div', { class: 'cog-overview-events', 'aria-label': '最近的已校验账本事件' })
  for (const event of recent) {
    const button = h('button', {
      type: 'button', class: 'cog-overview-event',
      'aria-label': `在账本中查看第 ${event.seq} 条事件：${compactEventSummary(event)}`,
      onclick: () => onOpenEvent?.(event),
    }, h('span', { class: 'cog-overview-event-summary' }, compactEventSummary(event)),
    h('span', { class: 'cog-overview-event-time' }, fmtAt(event.at)))
    list.append(button)
  }
  container.append(list)
}

async function loadConcept(theme, ledgerPane, stage, opts) {
  const [proj, evRes] = await Promise.all([
    m.chainProjection(theme.id),
    m.chainEvents(theme.id).catch(() => null),
  ])
  const events = evRes?.events || []
  const verifiedEvents = verifiedLedgerPrefix(events, proj.integrity)
  const validPrefixSeq = verifiedEvents.length
  const viewState = { projection: { ...proj, allEvents: events }, selectedSeq: null, events: verifiedEvents }
  updateThemeStats(opts.themeStats, proj, events)
  let graphController = null
  let ledgerController = null
  let replayGeneration = 0
  const countsEl = stage.closest('.chain-section')?.querySelector('[data-cog-counts]')
  const kinds = { claim: 0, inference: 0, evidence: 0 }
  for (const n of proj.nodes) if (kinds[n.kind] !== undefined) kinds[n.kind]++
  const parts = []
  if (kinds.claim) parts.push(`观点 ${kinds.claim}`)
  if (kinds.inference) parts.push(`推断 ${kinds.inference}`)
  if (kinds.evidence) parts.push(`证据 ${kinds.evidence}`)
  if (countsEl) {
    countsEl.textContent = parts.join(' · ') || '暂无观点'
  }
  const replayStatusEl = stage.closest('.chain-section')?.querySelector('[data-replay-status]')
  const integrityBadge = stage.closest('.chain-section')?.querySelector('[data-ledger-status]')
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
  const updateReplayStatus = (state) => {
    if (!replayStatusEl) return
    const replaying = state?.selectedSeq != null
    const projection = state?.projection || proj
    const at = projection.selectedAt || state?.events?.at(-1)?.at || null
    replayStatusEl.hidden = !replaying
    replayStatusEl.classList.toggle('is-replay', replaying)
    replayStatusEl.textContent = replaying ? `历史回放 · v${state.selectedSeq} · ${at ? fmtAt(at) : '账本起点'} · 只读` : ''
  }

  const replayTo = async (sequence, focusEvent = null) => {
    const generation = ++replayGeneration
    try {
      const snapshot = await m.chainProjectionAt(theme.id, Number(sequence))
      if (generation !== replayGeneration) return null
      viewState.projection = { ...snapshot, allEvents: events }
      viewState.selectedSeq = snapshot.selectedSeq
      viewState.events = eventsThroughSequence(events, proj.integrity, snapshot.selectedSeq)
      graphController?.render(viewState, focusEvent ? firstAffectedNode(focusEvent, snapshot, events) : null)
      ledgerController?.syncReplay(viewState)
      return snapshot
    } catch (error) {
      if (generation !== replayGeneration) return null
      toast(`历史回放失败：${error?.message || error}`, 'var(--red)')
      return null
    }
  }
  const focusEvent = async (event) => {
    if (!Number.isSafeInteger(event?.seq) || !verifiedEvents.some((row) => row?.id === event.id)) {
      toast('该记录未通过账本校验，不能用于历史回放或图谱定位', 'var(--red)')
      return
    }
    if (viewState.selectedSeq != null && event.seq > viewState.selectedSeq) {
      const snapshot = await replayTo(event.seq, event)
      if (!snapshot) return
    }
    const targetId = firstAffectedNode(event, viewState.projection, events)
    if (targetId) graphController?.render(viewState, targetId)
    else toast('这条事件在当前版本没有可定位的图节点', 'var(--text-2)')
  }
  const openEvent = async (event) => {
    await focusEvent(event)
    opts.openLedger?.()
    ledgerController?.showEvent(event?.id)
  }
  const returnLive = () => {
    replayGeneration++
    viewState.projection = { ...proj, allEvents: events }
    viewState.selectedSeq = null
    viewState.events = verifiedEvents
    graphController?.render(viewState)
    ledgerController?.syncReplay(viewState)
  }
  const graphOpts = { ...opts, onJumpToEvent: openEvent }
  graphController = renderGraphTools(stage, theme, proj, graphOpts, {
    onReplay: replayTo,
    onLive: returnLive,
    onReplayStatus: updateReplayStatus,
    validPrefixSeq,
    replayControlsSlot: opts.replayControlsSlot,
  })
  ledgerController = renderLedgerPanel(ledgerPane, theme, events, proj.integrity, {
    onFocusEvent: focusEvent,
    onReplay: replayTo,
    onIntegrityChange: updateIntegrityBadge,
    onClose: opts.closeLedger,
    replayControls: opts.replayControlsSlot,
    titleId: opts.ledgerTitleId,
    onChanged: opts.onChanged,
    initialState: viewState,
    verifiedEvents,
  })
  graphController.render(viewState)
  renderOverviewContent(opts.overviewContent, proj, verifiedEvents, openEvent)
  const pendingLedgerJump = consumeChainEventJump(theme.id)
  if (pendingLedgerJump) {
    const request = pendingLedgerJump
    const target = verifiedEvents.find((event) => event?.id === request.eventId)
    if (target) queueMicrotask(() => openEvent(target))
    else toast('该引用事件不在已校验账本前缀中，未执行跳转', 'var(--text-2)')
  }

  if (!(proj.allNodes || proj.nodes || []).some((node) => !node.external && ['claim', 'inference'].includes(node.kind))) {
    stage.querySelector('.cog-graph-main')?.insertBefore(h('div', { class: 'chain-empty cog-theme-empty' },
      h('div', { class: 'empty-title' }, '从一个可检验的问题开始'),
      h('p', { class: 'chain-empty-sub' }, '主题本身就是图根，无需再创建主题节点。先写下你的观点或问题；证据和支持、反驳关系由你明确补充。观点不会自动变成证据。'),
      h('div', { class: 'cog-empty-steps' },
        h('span', {}, '1 添加观点'), h('span', { 'aria-hidden': 'true' }, '→'), h('span', {}, '2 补充证据'), h('span', { 'aria-hidden': 'true' }, '→'), h('span', {}, '3 选择关系')),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openEntryDialog(theme, proj, 'claim', opts) }, '添加第一个观点')),
      stage.querySelector('.cog-graph-canvas'))
    return
  }
}

const firstAffectedNode = affectedNodeIdForEvent

/* ------------------------------------------------------------------ */
/* 左：追加式完整性账本（概念 01）                                      */
/* ------------------------------------------------------------------ */

const EVENT_KIND_LABEL = {
  'evidence.appended': '新增证据',
  'claim.created': '新增主张',
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
      return `${a} —${rel.label || p.rel}→ ${b}${p.reviewStatus === 'pending-review' || p.rel === 'derives' ? '（待复核）' : ''}`
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
    'segment-affects': '旧主题关系（待复核）',
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
      '校验边界：哈希链可帮助发现未同步重算后续哈希的修改或意外损坏；本地可控攻击者仍可重写整链，本版本未提供签名或远端锚定。主题根节点与虚线是展示元数据，不是账本事件。'))
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
  const nodeSearch = h('input', { class: 'txt cog-node-search', type: 'search', placeholder: '搜索所有观点、证据或推断', 'aria-label': '搜索所有观点、证据或推断', 'aria-controls': searchResultsId })
  const searchButton = h('button', { type: 'button', class: 'btn', onclick: focusBySearch }, '定位节点')
  const clearSearch = h('button', { type: 'button', class: 'btn cog-search-clear', disabled: true, onclick: resetSearch }, '清除')
  const searchError = h('span', { class: 'cog-search-error', role: 'status', 'aria-live': 'polite' })
  const searchResults = h('div', { id: searchResultsId, class: 'cog-search-results', role: 'listbox', 'aria-label': '图谱搜索结果', hidden: true })
  const searchPageLabel = h('span', { class: 'cog-search-page-label', role: 'status', 'aria-live': 'polite' })
  const previousSearchPage = h('button', { type: 'button', class: 'btn cog-search-page-button', onclick: () => changeSearchPage(-1) }, '上组结果')
  const nextSearchPage = h('button', { type: 'button', class: 'btn cog-search-page-button', onclick: () => changeSearchPage(1) }, '下组结果')
  const searchPager = h('div', { class: 'cog-search-pager', role: 'group', 'aria-label': '搜索结果分页', hidden: true }, previousSearchPage, searchPageLabel, nextSearchPage)
  const sliderLabel = h('label', { class: 'cog-time-slider-label', for: sliderId }, '历史账本版本')
  const maxSeq = Math.max(0, handlers.validPrefixSeq || 0)
  const timeSlider = h('input', {
    id: sliderId, class: 'cog-time-slider', type: 'range', min: '0', max: String(maxSeq), step: '1',
    value: String(maxSeq), disabled: maxSeq === 0, 'aria-label': '账本事件序号历史回放',
  })
  const timePreview = h('span', { class: 'cog-time-preview', 'aria-live': 'polite' })
  const liveButton = h('button', { type: 'button', class: 'btn cog-live-button', hidden: true, onclick: () => handlers.onLive?.() }, '退出历史回放')
  const timeControls = h('div', { class: 'cog-time-controls' }, sliderLabel, timeSlider, timePreview, liveButton)
  handlers.replayControlsSlot?.append(timeControls)
  const pageLabel = h('span', { class: 'cog-claim-page-label', role: 'status', 'aria-live': 'polite' })
  const previousPage = h('button', { type: 'button', class: 'btn cog-claim-page-button', onclick: () => changeClaimPage(-1) }, '上一组观点')
  const nextPage = h('button', { type: 'button', class: 'btn cog-claim-page-button', onclick: () => changeClaimPage(1) }, '下一组观点')
  const claimPager = h('div', { class: 'cog-claim-pager', role: 'group', 'aria-label': '观点分页' }, previousPage, pageLabel, nextPage)
  let claimPage = 1
  const guidanceId = `${opts.ledgerTitleId || 'cog-ledger'}-evidence-guidance`
  const addClaim = h('button', { type: 'button', class: 'btn btn-primary', 'aria-describedby': guidanceId, onclick: () => openEntryDialog(theme, proj, 'claim', opts) }, '＋ 添加观点')
  const addEvidence = h('button', { type: 'button', class: 'btn', 'aria-describedby': guidanceId, onclick: () => openEntryDialog(theme, proj, 'evidence', opts) }, '补充证据')
  const evidenceGuidance = h('span', { id: guidanceId, class: 'cog-write-guidance', role: 'status', 'aria-live': 'polite' })
  const derivesToggle = h('button', { type: 'button', class: 'btn cog-derived-toggle', 'aria-pressed': 'false', hidden: true }, '显示其他推导关系')
  const help = h('details', { class: 'cog-graph-help' },
    h('summary', {}, '阅读方式与完整数据范围'),
    h('div', { class: 'cog-graph-help-body' },
      h('p', {}, '默认每页最多显示 20 个观点或推断，优先呈现主题下的观点骨架；证据与关系详情收起。选择一个观点后，下方只展开它直接关联的证据、来源事件和关系，主骨架仍保留。'),
      h('p', {}, '用“上一组观点 / 下一组观点”逐页阅读其余观点；搜索覆盖全部观点、推断、证据和外部引用。图下的完整节点与独立媒体清单保留逐条查看路径，不删节点、不合并来源。'),
      h('p', {}, '箭头和颜色含义见图谱常驻图例；关系是账本中的声明，不代表自动核实。历史回放仅重建通过校验的前缀并保持只读。'), derivesToggle))
  const graphToolbar = h('div', { class: 'cog-graph-toolbar' },
    h('div', { class: 'cog-graph-intro' },
      h('div', { class: 'cog-graph-title-line' }, h('span', { class: 'cog-ledger-num cog-graph-num' }, '02'), h('div', { class: 'cog-graph-title' }, '认知图谱')),
      h('p', { class: 'cog-graph-caption' }, '先看主题下的观点分布；证据与关系按需展开。')),
    h('div', { class: 'cog-graph-actions' }, addClaim, addEvidence, evidenceGuidance),
    renderLegend())
  const graphMain = h('div', { class: 'cog-graph-main' },
    h('div', { class: 'cog-focus-bar' }, focusLabel,
      h('div', { class: 'cog-focus-actions' }, nodeSearch, searchButton, clearSearch, focusDetails, clearFocus)),
    searchResults, searchPager, searchError, claimPager,
    help,
    graphCanvas)
  stage.append(graphToolbar, h('div', { class: 'cog-workspace-grid' }, graphMain, pointInspector))
  let currentView = { projection: proj, selectedSeq: null, events: [] }
  let currentFocus = null
  let showDerived = false
  let searchMatches = []
  let searchPage = 1
  let previousSearchQuery = ''
  function changeClaimPage(delta) {
    const total = (currentView.projection?.nodes || []).filter((node) => ['claim', 'inference'].includes(node.kind)).length
    const pageCount = Math.max(1, Math.ceil(total / CLAIM_PAGE_SIZE))
    claimPage = Math.max(1, Math.min(pageCount, claimPage + delta))
    render(currentView, null)
  }
  function changeSearchPage(delta, focusFirst = false) {
    const pageCount = Math.max(1, Math.ceil(searchMatches.length / SEARCH_RESULTS_PAGE_SIZE))
    searchPage = Math.max(1, Math.min(pageCount, searchPage + delta))
    renderSearchResults()
    if (focusFirst) searchResults.querySelector('.cog-search-result')?.focus()
  }
  derivesToggle.onclick = () => {
    showDerived = !showDerived
    derivesToggle.setAttribute('aria-pressed', String(showDerived))
    derivesToggle.textContent = `${showDerived ? '隐藏' : '显示'}其他推导关系`
    const svg = graphCanvas.querySelector('.cog-svg')
    if (svg) svg.dataset.showDerived = String(showDerived)
  }
  timeSlider.addEventListener('input', () => { timePreview.textContent = `待回放：v${timeSlider.value}` })
  timeSlider.addEventListener('change', () => handlers.onReplay?.(Number(timeSlider.value)))
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
    searchMatches = searchGraphNodes(currentView.projection?.allNodes || currentView.projection?.nodes || [], query)
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
    const match = searchMatches[0] || searchGraphNodes(currentView.projection?.allNodes || currentView.projection?.nodes || [], query)[0]
    if (!match) { searchError.textContent = '没有找到匹配节点。'; return }
    searchResults.hidden = true
    searchPager.hidden = true
    chooseSearchResult(match)
  }

  function renderFocusRegion(nodeId) {
    clear(focusRegion)
    if (!nodeId) { focusRegion.hidden = true; return }
    const projection = currentView.projection || {}
    const allNodes = projection.allNodes || projection.nodes || []
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
      const reviewState = edge.pendingReview ? ' · 待复核' : edge.reviewDecision === 'rejected' ? ' · 已驳回' : ''
      return h('div', { class: 'cog-focus-relation', 'data-rel': edge.rel || '' },
        h('span', { class: 'cog-focus-direction' }, `${from?.title || '来源未解析'} → ${to?.title || '来源未解析'}`),
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
      h('p', { class: 'cog-focus-region-summary' }, `${evidenceNodes.length} 条直接关联证据 · ${relatedEdges.length} 条直接关系 · 主题观点骨架仍保持可见。`),
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
    const allNodes = projection.allNodes || projection.nodes || []
    const node = nodeId ? allNodes.find((candidate) => candidate.id === nodeId) : null
    focusRegion.hidden = !node
    historyDisclosure.hidden = !node
    referencesDisclosure.hidden = !node
    if (!node) {
      const hasPoints = allNodes.some((candidate) => !candidate.external && ['claim', 'inference'].includes(candidate.kind))
      pointSummary.append(
        h('div', { class: 'cog-point-inspector-head' },
          h('div', {}, h('span', { class: 'cog-point-inspector-kicker' }, '节点检视'),
            h('h3', { class: 'cog-point-inspector-title' }, '选择一个观点或证据'))),
        h('div', { class: 'cog-point-inspector-empty' },
          h('p', {}, hasPoints ? '选择图中的节点，查看它的状态、来源、证据、关系与事件历史。' : '这个主题还没有观点。添加观点后，主题根会自动显示，无需重复创建。'),
          !hasPoints ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openEntryDialog(theme, projection, 'claim', opts) }, '添加第一个观点') : null))
      return
    }
    const kind = KIND[node.kind] || KIND.claim
    const statusLabel = node.archived ? '已归档'
      : node.correct === false ? '已证伪'
        : node.superseded ? '已更正'
          : node.correct === true || node.status === 'confirmed' ? '已确认'
            : node.status === 'stale' ? '待更新'
              : node.status === 'forking' ? '待收敛'
                : node.status === 'closed' ? '已关闭' : '待验证'
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
        confidence ? h('span', { class: 'cog-point-inspector-badge' }, `置信度 ${confidence}`) : null,
        node.kind === 'inference' ? h('span', { class: 'cog-point-inspector-badge' }, '需人工复核推导') : null),
      h('div', { class: 'cog-point-inspector-meta' },
        h('div', { class: 'cog-point-inspector-meta-row' }, h('span', {}, '来源'), h('strong', {}, source)),
        sourceDate ? h('div', { class: 'cog-point-inspector-meta-row' }, h('span', {}, '记录时间'), h('strong', {}, fmtAt(sourceDate))) : null,
        h('div', { class: 'cog-point-inspector-meta-row' }, h('span', {}, '节点历史'), h('strong', {}, `${history.length} 条相关事件`))),
      h('p', { class: 'cog-point-inspector-note' }, '状态与来源按已有记录展示；账本完整性校验不代表观点内容或来源已经证实。'),
      h('div', { class: 'cog-point-inspector-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => opts.onOpen?.(node, detailOptions) }, '完整详情与操作'),
        !node.archived && !node.external && currentView.selectedSeq == null && ['claim', 'inference'].includes(node.kind)
          ? h('button', { type: 'button', class: 'btn', onclick: () => openEntryDialog(theme, projection, 'evidence', opts) }, '补充证据') : null),
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
    const allNodes = projection.allNodes || projection.nodes || []
    const primaryNodes = (projection.nodes || allNodes).filter((node) => ['claim', 'inference'].includes(node.kind))
      .slice().sort((a, b) => (Number(a.createdSeq) || 0) - (Number(b.createdSeq) || 0) || String(a.id).localeCompare(String(b.id)))
    const allEdges = projection.allEdges || projection.edges || []
    const focusedNode = focusNodeId ? allNodes.find((node) => node.id === focusNodeId) : null
    let pageTarget = focusedNode && ['claim', 'inference'].includes(focusedNode.kind) ? focusedNode.id : null
    if (!pageTarget && focusedNode) {
      const parentEdge = allEdges.find((edge) => (edge.from === focusedNode.id && primaryNodes.some((node) => node.id === edge.to))
        || (edge.to === focusedNode.id && primaryNodes.some((node) => node.id === edge.from)))
      pageTarget = parentEdge ? (parentEdge.from === focusedNode.id ? parentEdge.to : parentEdge.from) : null
    }
    const targetIndex = pageTarget ? primaryNodes.findIndex((node) => node.id === pageTarget) : -1
    if (targetIndex >= 0) claimPage = Math.floor(targetIndex / CLAIM_PAGE_SIZE) + 1
    const pageCount = Math.max(1, Math.ceil(primaryNodes.length / CLAIM_PAGE_SIZE))
    claimPage = Math.max(1, Math.min(pageCount, claimPage))
    const pageStart = (claimPage - 1) * CLAIM_PAGE_SIZE
    const pageNodes = primaryNodes.slice(pageStart, pageStart + CLAIM_PAGE_SIZE)
    const pageIds = new Set(pageNodes.map((node) => node.id))
    const visualFocusId = pageTarget && pageIds.has(pageTarget) ? pageTarget : null
    const visibleEdges = visualFocusId
      ? allEdges.filter((edge) => (edge.from === visualFocusId || edge.to === visualFocusId) && pageIds.has(edge.from) && pageIds.has(edge.to))
      : []
    pageLabel.textContent = primaryNodes.length
      ? `观点 ${pageStart + 1}–${Math.min(pageStart + pageNodes.length, primaryNodes.length)} / ${primaryNodes.length} · 默认每页最多 ${CLAIM_PAGE_SIZE}`
      : '观点 0 / 0'
    previousPage.disabled = claimPage <= 1
    nextPage.disabled = claimPage >= pageCount
    const frame = selectGraphWindow({ ...projection, nodes: pageNodes, edges: visibleEdges }, {
      focusNodeId: visualFocusId,
      maxNodes: CLAIM_PAGE_SIZE,
      maxEdges: GRAPH_FRAME_EDGE_LIMIT,
    })
    clear(graphCanvas)
    if (frame.truncated) {
      graphCanvas.append(h('p', { class: 'cog-frame-note', role: 'status' },
        `本页仅显示 ${frame.nodes.length} 个观点骨架；使用分页、搜索或账本定位可查看完整节点范围。`))
    }
    const frameProjection = { ...projection, nodes: frame.nodes, edges: frame.edges }
    if (viewChanged && nodeSearch.value) renderSearchResults()
    const selectedEvents = viewState.events || []
    const graphOptions = {
      ...opts,
      historyContext: { events: selectedEvents, projection, selectedSeq: viewState.selectedSeq },
      focusNodeId: frame.focusNodeId,
      focusLabel,
      focusDetails,
      clearFocus,
      showDerived: Boolean(showDerived || focusNodeId),
      onFocusNode: (node) => {
        currentFocus = node?.id || null
        focusDetails.hidden = !currentFocus
        clearFocus.hidden = !currentFocus
        focusLabel.textContent = node ? `已选择：${node.title || '节点'} · 详情显示在右侧` : '选择一个观点以查看详情'
        renderPointInspector(currentFocus)
      },
    }
    drawGraph(stage, frameProjection, theme, graphOptions, graphCanvas)
    renderFloating(graphCanvas, projection, theme, graphOptions)
    renderIndependentMediaGroups(graphCanvas, projection, theme, graphOptions, (node) => render(viewState, node.id))
    focusDetails.hidden = !focusNodeId
    clearFocus.hidden = !focusNodeId
    focusLabel.textContent = focusNodeId
      ? `已选择：${focusedNode?.title || '节点'} · 详情显示在右侧`
      : '选择一个观点以查看详情'
    renderPointInspector(focusNodeId)
    const replaying = viewState.selectedSeq != null
    handlers.onReplayStatus?.(viewState)
    timeSlider.value = String(replaying ? viewState.selectedSeq : maxSeq)
    timePreview.textContent = ''
    liveButton.hidden = !replaying
    addClaim.disabled = replaying
    addClaim.title = replaying ? '历史回放为只读；返回当前投影后才能追加观点' : ''
    const choices = (projection.allNodes || projection.nodes || []).filter((node) => !node.archived && !node.external && ['claim', 'inference'].includes(node.kind))
    addEvidence.disabled = replaying
    addEvidence.title = replaying ? '历史回放为只读；返回当前投影后才能补充证据'
      : choices.length ? '' : '请先创建一个观点或问题，再补充证据'
    evidenceGuidance.textContent = replaying ? '历史回放只读：新增观点、补证与关系复核已禁用。'
      : choices.length ? '' : '还没有可连接的观点；点击“补充证据”会提示先创建观点。'
    const derivesCount = allEdges.filter((edge) => edge.rel === 'derives'
      && !edge.pendingReview && !edge.reviewDecision).length
    derivesToggle.hidden = !derivesCount || !focusNodeId
    derivesToggle.textContent = `${showDerived ? '隐藏' : '显示'}其他推导关系（${derivesCount}）`
    derivesToggle.setAttribute('aria-pressed', String(showDerived))
  }

  focusDetails.onclick = () => {
    const id = currentFocus || graphCanvas.querySelector('.cog-node.is-selected')?.getAttribute('data-node-id')
    const node = (currentView.projection.allNodes || currentView.projection.nodes || []).find((candidate) => candidate.id === id)
    if (node) opts.onOpen?.(node, { onChanged: opts.onChanged, historyContext: { events: currentView.events || [], projection: currentView.projection, selectedSeq: currentView.selectedSeq }, onJumpToEvent: opts.onJumpToEvent })
  }
  clearFocus.onclick = () => render(currentView, null)
  return { render, focus: (id) => render(currentView, id) }
}

function renderIndependentMediaGroups(canvas, projection, theme, opts, onFocusNode) {
  const items = independentMediaEvidence(projection.allNodes || projection.nodes || [], opts.historyContext?.events || [])
  if (!items.length) return
  const details = h('details', { class: 'cog-media-group' },
    h('summary', {}, `独立媒体 ×${items.length}`),
    h('p', { class: 'cog-media-note' }, '每条记录仍是独立来源；展开后可分别定位或查看详情，不会合并为同一事实。'))
  const list = h('div', { class: 'cog-media-list' })
  for (const { node, event } of items) {
    const payload = event?.payload || {}
    const title = String(payload.title || payload.text || node.title || '未命名证据').replace(/\s+/g, ' ').trim()
    const refs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : []
    const source = payload.sourceLabel || payload.legacySource?.label || refs.find((ref) => ref?.title)?.title
      || payload.sourceKind || payload.legacySource?.kind || '来源未记录'
    const date = payload.publishedAt || payload.date || event?.at || '日期未记录'
    const openDetail = h('button', {
      type: 'button', class: 'btn cog-media-open',
      'aria-label': `打开证据详情：${title}`,
      onclick: () => opts.onOpen?.(node, {
        onChanged: opts.onChanged, historyContext: opts.historyContext, onJumpToEvent: opts.onJumpToEvent,
      }),
    }, '查看详情')
    const locate = h('button', {
      type: 'button', class: 'btn cog-media-locate cog-event-focus',
      'aria-label': `在图中定位独立媒体证据：${title}`,
      onclick: () => onFocusNode?.(node),
    }, h('span', { 'aria-hidden': 'true' }, '⌖'), h('span', {}, '在图中定位'))
    list.append(h('article', { class: 'cog-media-item', 'data-media-node-id': node.id },
      h('div', { class: 'cog-media-item-title' }, `标题关键词 · ${title}`),
      h('div', { class: 'cog-media-item-meta' }, `来源 · ${source}　日期 · ${fmtAt(date)}`),
      h('div', { class: 'cog-media-item-actions' }, locate, openDetail)))
  }
  details.append(list)
  canvas.append(details)
}

function openEntryDialog(theme, proj, mode, opts) {
  const choices = (proj.nodes || []).filter((node) => !node.archived && !node.external && ['claim', 'inference'].includes(node.kind))
  if (mode === 'evidence' && !choices.length) { toast('请先创建一个观点或问题', 'var(--text-2)'); return }
  const previousFocus = document.activeElement
  closeNodeDetail()
  const isEvidence = mode === 'evidence'
  const heading = isEvidence ? '补充证据' : '添加观点或问题'
  const backdrop = h('div', { class: 'chain-drawer-backdrop show cog-entry-backdrop' })
  const dialog = h('section', { class: 'cog-entry-dialog show', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cog-entry-title', tabindex: '-1' })
  const titleInput = h('input', { class: 'txt', type: 'text', maxlength: '180', required: true, placeholder: '例如：本季度需求会继续增长', 'aria-label': '观点或问题标题' })
  const bodyInput = h('textarea', { class: 'txt cog-entry-textarea', rows: '3', placeholder: isEvidence ? '记录可核对的数字、观察或原文摘录' : '补充一句话说明；这段说明不是证据。', 'aria-label': isEvidence ? '证据摘要或原文摘录' : '观点说明' })
  const evidenceInput = h('textarea', { class: 'txt cog-entry-textarea', rows: '2', placeholder: '仅填写可作为依据的内容', 'aria-label': '证据摘要或原文摘录' })
  const sourceInput = h('input', { class: 'txt', type: 'text', placeholder: '来源名称（可选）', 'aria-label': '来源名称' })
  const urlInput = h('input', { class: 'txt', type: 'url', placeholder: 'https://…（可选）', 'aria-label': '来源链接' })
  const targetSelect = h('select', { class: 'txt', 'aria-label': '要连接到的观点或问题' },
    ...choices.map((node) => h('option', { value: node.id }, `${node.title}${node.kind === 'inference' ? ' · 推断' : ''}`)))
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
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const save = async (event) => {
    event.preventDefault()
    const text = bodyInput.value.trim()
    const title = titleInput.value.trim()
    if (!isEvidence && !title) { error.hidden = false; error.textContent = '请填写观点或问题。'; titleInput.focus(); return }
    if (isEvidence && !text) { error.hidden = false; error.textContent = '请填写证据摘要或原文摘录。'; bodyInput.focus(); return }
    const button = dialog.querySelector('[data-entry-save]')
    button.disabled = true
    error.hidden = true
    try {
      const result = isEvidence
        ? await m.chainAddEvidence(theme.id, targetSelect.value, { text, sourceLabel: sourceInput.value.trim(), url: urlInput.value.trim() })
        : await m.chainMountEvent(theme.id, { newSegmentName: title, coreInfo: text, evidence: evidenceInput.value.trim() })
      if (result?.ok === false) throw new Error(result.error || '保存未完成')
      const addedEvidence = isEvidence || Boolean(evidenceInput.value.trim())
      toast(isEvidence ? '已追加证据与支持关系' : `已添加观点${addedEvidence ? '与证据' : '；尚未添加的证据不会被自动补造'}`)
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
      ? h('label', { class: 'cog-entry-field' }, h('span', {}, '连接到观点或问题'), targetSelect)
      : h('label', { class: 'cog-entry-field' }, h('span', {}, '观点或问题'), titleInput),
    h('label', { class: 'cog-entry-field' }, h('span', {}, isEvidence ? '证据摘要或原文摘录' : '说明（可选）'), bodyInput),
    isEvidence ? h('div', { class: 'cog-entry-field' },
      h('label', { class: 'cog-entry-field' }, h('span', {}, '来源名称（可选）'), sourceInput),
      h('label', { class: 'cog-entry-field' }, h('span', {}, '来源链接（可选）'), urlInput))
      : h('div', {},
        h('p', { class: 'cog-entry-note' }, '观点说明不会自动转成证据或支持关系。'),
        h('details', { class: 'cog-entry-optional-evidence' },
          h('summary', {}, '同时补充证据（可选）'),
          h('label', { class: 'cog-entry-field' }, h('span', {}, '证据摘要或原文摘录'), evidenceInput))),
    error,
    h('div', { class: 'cog-entry-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, '取消'),
      h('button', { type: 'submit', class: 'btn btn-primary', 'data-entry-save': '' }, isEvidence ? '追加证据' : '创建观点')))
  dialog.append(h('header', { class: 'cog-entry-head' }, h('div', { id: 'cog-entry-title', class: 'cog-entry-title' }, heading),
    h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '关闭', onclick: close }, '×')), form)
  backdrop.addEventListener('click', close)
  document.body.append(backdrop, dialog)
  document.addEventListener('keydown', onKey)
  requestAnimationFrame(() => (isEvidence ? targetSelect : titleInput).focus())
}

/** Searchable, paged unplaced-node index. It never copies all floating nodes into the graph. */
function renderFloating(stage, proj, theme, opts = {}) {
  const nodes = Array.isArray(proj.floating) ? proj.floating : []
  if (!nodes.length) return
  const counts = countFloating(nodes)
  const byKind = Object.entries(counts.byKind).map(([kind, count]) => `${KIND[kind]?.label || kind} ${count}`).join(' · ')
  const byStatus = Object.entries(counts.byStatus).map(([status, count]) => `${NODE_STATUS[status]?.label || status} ${count}`).join(' · ')
  const query = h('input', { class: 'txt cog-float-search', type: 'search', placeholder: '搜索待归置节点', 'aria-label': '搜索待归置节点' })
  const kindFilter = h('select', { class: 'txt', 'aria-label': '按节点类型筛选' },
    h('option', { value: '' }, '全部类型'),
    ...Object.entries(KIND).filter(([kind]) => counts.byKind[kind]).map(([kind, config]) => h('option', { value: kind }, `${config.label} · ${counts.byKind[kind]}`)))
  const statusFilter = h('select', { class: 'txt', 'aria-label': '按节点状态筛选' },
    h('option', { value: '' }, '全部状态'),
    ...Object.entries(counts.byStatus).map(([status, count]) => h('option', { value: status }, `${NODE_STATUS[status]?.label || status} · ${count}`)))
  const list = h('div', { class: 'cog-float-list', hidden: true, 'aria-live': 'polite' })
  const resultLabel = h('span', { class: 'cog-float-result-count', role: 'status', 'aria-live': 'polite' })
  const pageLabel = h('span', { class: 'cog-page-label' })
  const pageState = { value: 1 }
  const prev = h('button', { type: 'button', class: 'btn cog-page-btn', onclick: () => { pageState.value--; renderRows() } }, '上一页')
  const next = h('button', { type: 'button', class: 'btn cog-page-btn', onclick: () => { pageState.value++; renderRows() } }, '下一页')
  const pagination = h('div', { class: 'cog-pagination' }, prev, pageLabel, next)
  const countsLine = h('p', { class: 'cog-float-counts' },
    `主题「${theme.name || '未命名主题'}」· 共 ${counts.total} 项`,
    h('br'), `类型：${byKind || '无'} · 状态：${byStatus || '无'}`)
  const container = h('details', { class: 'cog-float', 'aria-label': '完整待归置节点审阅区' },
    h('summary', {}, `待归置节点与审阅 · ${nodes.length} 项`),
    h('div', { class: 'cog-float-head' }, resultLabel),
    countsLine,
    h('div', { class: 'cog-float-filters' }, query, kindFilter, statusFilter),
    pagination, list, pagination)
  container.addEventListener('toggle', () => { list.hidden = !container.open })
  stage.append(container)

  function renderRows() {
    clear(list)
    const search = query.value.trim().toLocaleLowerCase()
    const filtered = nodes.filter((node) => (!search || `${node.title || ''} ${node.currentText || ''}`.toLocaleLowerCase().includes(search))
      && (!kindFilter.value || node.kind === kindFilter.value)
      && (!statusFilter.value || floatingStatusKey(node) === statusFilter.value))
    const page = paginate(filtered, pageState.value, FLOATING_PAGE_SIZE)
    pageState.value = page.page
    resultLabel.textContent = `${page.total} 项符合筛选`
    pageLabel.textContent = `${page.total ? page.start + 1 : 0}–${page.end} / ${page.total} · 第 ${page.page}/${page.pages} 页`
    prev.disabled = page.page <= 1
    next.disabled = page.page >= page.pages
    for (const node of page.items) {
      const kind = KIND[node.kind] || KIND.claim
      const statusKey = floatingStatusKey(node)
      const status = NODE_STATUS[statusKey] || { label: statusKey }
      const button = h('button', {
        type: 'button', class: 'btn cog-float-open',
        onclick: () => opts.onOpen?.(node, {
          onChanged: opts.onChanged,
          historyContext: opts.historyContext,
          onJumpToEvent: opts.onJumpToEvent,
        }),
      }, opts.historyContext?.selectedSeq != null ? '查看历史' : node.archived ? '查看与恢复' : '查看并挂接')
      list.append(h('article', { class: 'cog-float-row' },
        h('span', { class: 'cog-kind-tag' }, kind.label),
        h('span', { class: 'cog-float-title' }, node.title || '未命名节点'),
        h('span', { class: 'cog-float-status' }, `状态：${status.label}`),
        node.sourceRef ? h('span', { class: 'cog-float-source' }, `来源：${node.sourceRef}`) : h('span', { class: 'cog-float-source is-unresolved' }, '来源引用未记录'),
        button))
    }
  }
  for (const control of [query, kindFilter, statusFilter]) control.addEventListener('input', () => { pageState.value = 1; renderRows() })
  kindFilter.addEventListener('change', () => { pageState.value = 1; renderRows() })
  statusFilter.addEventListener('change', () => { pageState.value = 1; renderRows() })
  renderRows()
}

/* ------------------------------------------------------------------ */
/* 分层语义布局（概念 02）：研究主题在上、主张/推断居中、证据在下。      */
/* 确定性：同层内按 id 哈希排序 + 质心法降交叉，同数据每次位置一致。     */
/* ------------------------------------------------------------------ */

function seededRand(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
function hashStr(str) {
  let hsh = 2166136261
  for (let i = 0; i < str.length; i++) { hsh ^= str.charCodeAt(i); hsh = Math.imul(hsh, 16777619) }
  return hsh >>> 0
}

function layoutGraph(nodes, edges, W, themeNodeId = null) {
  const size = new Map(nodes.map((n) => [n.id, nodeSize(n)]))
  const pos = new Map()

  // 分层
  const layers = [[], [], []] // 0 主题 / 1 主张+推断 / 2 证据
  for (const n of nodes) {
    if (n.id === themeNodeId) layers[0].push(n)
    else if (n.kind === 'evidence') layers[2].push(n)
    else layers[1].push(n)
  }
  // 邻接（用于质心排序降交叉）
  const adj = new Map(nodes.map((n) => [n.id, new Set()]))
  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to)) { adj.get(e.from).add(e.to); adj.get(e.to).add(e.from) }
  }
  // 同层排序：先按质心（邻居在相邻层的平均序号），再按 id 哈希打破平局
  const sortLayer = (li, refLayers) => {
    const layer = layers[li]
    const idxOf = new Map()
    for (const rl of refLayers) layers[rl].forEach((x, i) => idxOf.set(x.id, i))
    const scored = layer.map((n) => {
      let sum = 0
      let cnt = 0
      for (const nb of adj.get(n.id)) {
        if (idxOf.has(nb)) { sum += idxOf.get(nb); cnt++ }
      }
      return { n, bary: cnt ? sum / cnt : -1, tie: hashStr(n.id) % 100000 }
    })
    scored.sort((x, y) => (x.bary - y.bary) || (x.tie - y.tie))
    layers[li] = scored.map((s) => s.n)
  }
  sortLayer(1, [2])
  sortLayer(2, [1])
  sortLayer(1, [2]) // 第二遍收敛

  // 落位：同层换行，行内居中
  const perRow = (w) => Math.max(1, Math.floor((W - 80) / w))
  const layerGap = 84
  const rowH = [0, 104, 88]
  let y = 64
  layers.forEach((layer, li) => {
    if (!layer.length) return
    const w = li === 2 ? 128 : 172
    const cap = perRow(w)
    for (let r = 0; r * cap < layer.length; r++) {
      const slice = layer.slice(r * cap, (r + 1) * cap)
      const span = (slice.length - 1) * w
      slice.forEach((n, i) => {
        pos.set(n.id, { x: W / 2 - span / 2 + i * w, y })
      })
      y += rowH[li]
    }
    y += layerGap
  })
  const H = Math.max(320, y - layerGap + 60)

  // 轻微去重叠兜底（同行内理论上已不重叠）
  const arr = nodes.map((n) => n.id)
  for (let k = 0; k < 40; k++) {
    let moved = false
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = pos.get(arr[i])
        const b = pos.get(arr[j])
        const sa = size.get(arr[i])
        const sb = size.get(arr[j])
        const minDx = (sa.w + sb.w) / 2 + 6
        const minDy = (sa.h + sb.h) / 2 + 6
        const dx = a.x - b.x
        const dy = a.y - b.y
        const ovx = minDx - Math.abs(dx)
        const ovy = minDy - Math.abs(dy)
        if (ovx <= 0 || ovy <= 0) continue
        moved = true
        if (ovx <= ovy) {
          const s = (dx >= 0 ? 1 : -1) * (ovx / 2 + 0.5)
          a.x += s; b.x -= s
        } else {
          const s = (dy >= 0 ? 1 : -1) * (ovy / 2 + 0.5)
          a.y += s; b.y -= s
        }
      }
    }
    if (!moved) break
  }
  for (const n of nodes) {
    const p = pos.get(n.id)
    const s = size.get(n.id)
    p.x = Math.max(s.w / 2 + 8, Math.min(W - s.w / 2 - 8, p.x))
    p.y = Math.max(s.h / 2 + 8, Math.min(H - s.h / 2 - 8, p.y))
  }
  return { pos, size, height: H }
}

/* ------------------------------------------------------------------ */
/* SVG 绘制                                                            */
/* ------------------------------------------------------------------ */

function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) node.appendChild(c)
  return node
}
function textEl(str, attrs = {}) {
  const t = el('text', attrs)
  t.textContent = str
  return t
}
/** 从矩形中心 p 向 q 方向，矩形边界上的出点。 */
function rectExit(p, q, hw, hh) {
  const dx = q.x - p.x
  const dy = q.y - p.y
  if (!dx && !dy) return { ...p }
  const tx = dx ? hw / Math.abs(dx) : Infinity
  const ty = dy ? hh / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)
  return { x: p.x + dx * t, y: p.y + dy * t }
}
function edgeD(a, b, sa, sb) {
  return edgeGeom(a, b, sa, sb).d
}
function splitLines(title, maxLen = 13) {
  const t = String(title || '未命名').replace(/\s+/g, ' ').trim() || '未命名'
  if (t.length <= maxLen) return [t]
  return [t.slice(0, maxLen - 1), t.slice(maxLen - 1, maxLen * 2 - 2) + (t.length > maxLen * 2 - 1 ? '…' : '')]
}

/** 二次贝塞尔走线几何：路径 + t=0.5 处的中点（放关系名标注）。 */
function edgeGeom(a, b, sa, sb) {
  const s = rectExit(a, b, sa.w / 2 + 2, sa.h / 2 + 2)
  const e = rectExit(b, a, sb.w / 2 + 9, sb.h / 2 + 9)
  const mx = (s.x + e.x) / 2
  const my = (s.y + e.y) / 2
  const dx = e.x - s.x
  const dy = e.y - s.y
  const len = Math.hypot(dx, dy) || 1
  const bow = Math.min(30, len * 0.14)
  const cx = mx - (dy / len) * bow
  const cy = my + (dx / len) * bow
  const px = 0.25 * s.x + 0.5 * cx + 0.25 * e.x
  const py = 0.25 * s.y + 0.5 * cy + 0.25 * e.y
  return {
    d: `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${e.x.toFixed(1)} ${e.y.toFixed(1)}`,
    px, py,
  }
}

const THEME_NODE_ID = '__cog_theme__'

function drawGraph(stage, proj, theme, opts, canvas = stage) {
  const W = 1120
  // 视图层合成主题根节点（概念 02 的"研究主题"占位），不进投影
  const themeNode = { id: THEME_NODE_ID, kind: 'theme', title: theme.name || '研究主题' }
  const nodes = [themeNode, ...proj.nodes]
  // 主题关联是展示元数据，不是账本边；仅在某个顶层节点获得焦点/悬停时画一条。
  const derivedTargets = new Set(proj.edges.filter((e) => e.rel === 'derives').map((e) => e.to))
  const topicTargets = new Map(proj.nodes
    .filter((n) => n.kind !== 'evidence' && !derivedTargets.has(n.id))
    .map((node) => [node.id, node]))
  const edges = [...proj.edges]

  const { pos, size, height: H } = layoutGraph(nodes, edges, W, THEME_NODE_ID)

  const replaySeq = opts.historyContext?.selectedSeq
  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'cog-svg', role: 'group',
    'aria-label': replaySeq != null ? `历史回放 v${replaySeq} 的认知图；只读` : '当前认知图；主题根节点为主题元数据，其余节点和关系来自事件记录',
    'data-show-derived': String(Boolean(opts.showDerived)),
  })
  const defs = el('defs')
  for (const [rel, cfg] of Object.entries(REL)) {
    const marker = el('marker', {
      id: `cog-arrow-${rel}`, viewBox: '0 0 10 10', refX: '8.5', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    }, [el('path', { d: 'M 1 1 L 9 5 L 1 9 z', fill: cfg.color })])
    defs.appendChild(marker)
  }
  defs.appendChild(el('marker', {
    id: 'cog-arrow-review', viewBox: '0 0 10 10', refX: '8.5', refY: '5',
    markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
  }, [el('path', { d: 'M 1 1 L 9 5 L 1 9 z', fill: '#94a3b8' })]))
  svg.appendChild(defs)

  const clusterLayer = el('g', { class: 'cog-clusters', 'aria-label': '观点关联簇背景' })
  const edgeLayer = el('g', { class: 'cog-edges' })
  const labelLayer = el('g', { class: 'cog-edge-labels' })
  const nodeLayer = el('g', { class: 'cog-nodes' })
  svg.append(clusterLayer, edgeLayer, labelLayer, nodeLayer)

  const primaryIds = new Set(proj.nodes.filter((node) => ['claim', 'inference'].includes(node.kind)).map((node) => node.id))
  const parentOf = new Map([...primaryIds].map((id) => [id, id]))
  const findRoot = (id) => {
    let root = id
    while (parentOf.get(root) !== root) root = parentOf.get(root)
    let current = id
    while (parentOf.get(current) !== current) {
      const next = parentOf.get(current)
      parentOf.set(current, root)
      current = next
    }
    return root
  }
  for (const edge of (proj.allEdges || proj.edges || [])) {
    if (!primaryIds.has(edge.from) || !primaryIds.has(edge.to)) continue
    const fromRoot = findRoot(edge.from)
    const toRoot = findRoot(edge.to)
    if (fromRoot !== toRoot) parentOf.set(toRoot, fromRoot)
  }
  const clusterMap = new Map()
  for (const id of primaryIds) {
    const root = findRoot(id)
    if (!clusterMap.has(root)) clusterMap.set(root, [])
    clusterMap.get(root).push(id)
  }
  const connectedClusters = [...clusterMap.values()].filter((ids) => ids.length > 1)
  const unlinked = [...clusterMap.values()].filter((ids) => ids.length === 1).flat()
  const clusters = connectedClusters.map((ids, index) => ({ ids, label: `关联簇 ${index + 1}` }))
  if (unlinked.length) clusters.push({ ids: unlinked, label: '尚无显式关系的观点' })
  clusters.forEach((cluster, index) => {
    const points = cluster.ids.map((id) => ({ point: pos.get(id), size: size.get(id) })).filter((item) => item.point && item.size)
    if (!points.length) return
    const left = Math.min(...points.map(({ point, size: box }) => point.x - box.w / 2)) - 14
    const right = Math.max(...points.map(({ point, size: box }) => point.x + box.w / 2)) + 14
    const top = Math.min(...points.map(({ point, size: box }) => point.y - box.h / 2)) - 18
    const bottom = Math.max(...points.map(({ point, size: box }) => point.y + box.h / 2)) + 12
    const group = el('g', { class: 'cog-cluster', 'data-cluster': cluster.label })
    const rect = el('rect', {
      x: left, y: top, width: right - left, height: bottom - top, rx: 18,
      class: `cog-cluster-bg${cluster.label.startsWith('关联簇') ? ' is-related' : ' is-unlinked'}`,
    })
    group.append(rect, textEl(cluster.label, { x: left + 10, y: top + 13, class: 'cog-cluster-label' }))
    clusterLayer.append(group)
  })

  const geomOf = (e) => edgeGeom(pos.get(e.from), pos.get(e.to), size.get(e.from), size.get(e.to))

  // 边
  const edgeRecs = []
  for (const e of edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const g = geomOf(e)
    const rel = REL[e.rel] || REL.supports
    const rejected = e.reviewDecision === 'rejected'
    const pending = e.pendingReview
    const confirmed = e.reviewDecision === 'confirmed'
    const relationStatus = pending ? '待复核' : confirmed ? '已确认' : rejected ? '已驳回' : ''
    const p = el('path', {
      d: g.d,
      class: `cog-edge cog-edge-${e.rel}${pending ? ' is-review' : ''}${rejected ? ' is-rejected' : ''}${confirmed ? ' is-confirmed' : ''}`,
      'data-from': e.from, 'data-to': e.to, 'data-rel': e.rel,
      stroke: pending ? '#64748b' : rejected ? '#b91c1c' : rel.color,
      'stroke-dasharray': pending || rejected ? '5 4' : 'none',
      'marker-end': `url(#cog-arrow-${pending || rejected ? 'review' : e.rel})`,
    })
    const title = el('title')
    const reviewMeta = e.reviewDecision
      ? ` · 决定者：${ACTOR_LABEL[e.reviewedBy] || e.reviewedBy || '未记录'} · 时间：${fmtAt(e.reviewedAt)}${e.reviewReason ? ` · 理由：${e.reviewReason}` : ''}`
      : ''
    title.textContent = `${rel.label}${relationStatus ? `（${relationStatus}）` : ''}${reviewMeta}${e.mapping ? ` · ${e.mapping}` : ''}`
    p.appendChild(title)
    edgeLayer.appendChild(p)
    // 关系名标注（概念 02 边上标 derives · 推导）
    const labelText = relationStatus ? `${relationStatus} · ${rel.label}` : `${e.rel} · ${rel.label}`
    const labelG = el('g', {
      class: 'cog-edge-label', 'data-rel': e.rel,
      'data-review-status': pending ? 'pending' : confirmed ? 'confirmed' : rejected ? 'rejected' : 'none',
      transform: `translate(${g.px.toFixed(1)} ${g.py.toFixed(1)})`,
    })
    const w = labelText.length * 12 + 14
    labelG.appendChild(el('rect', {
      x: -w / 2, y: -10, width: w, height: 20, rx: 10,
      fill: '#ffffff', stroke: pending ? '#64748b' : rejected ? '#b91c1c' : rel.color, 'stroke-opacity': 0.7,
    }))
    labelG.appendChild(textEl(labelText, {
      'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'cog-edge-label-text',
      fill: pending ? '#475569' : rejected ? '#991b1b' : rel.color,
    }))
    labelLayer.appendChild(labelG)
    edgeRecs.push({ el: p, edge: e, labelEl: labelG })
  }

  let activeTopicEdge = null
  const updateTopicEdge = (targetId) => {
    const target = topicTargets.get(targetId)
    if (!target) {
      activeTopicEdge?.remove()
      activeTopicEdge = null
      return
    }
    const geometry = edgeGeom(pos.get(THEME_NODE_ID), pos.get(target.id), size.get(THEME_NODE_ID), size.get(target.id))
    if (!activeTopicEdge) {
      activeTopicEdge = el('path', {
        class: 'cog-edge cog-edge-topic', 'data-from': THEME_NODE_ID, 'data-rel': 'topic',
        stroke: '#94a3b8', 'stroke-dasharray': '5 5', 'stroke-width': 1.2,
      })
      const title = el('title')
      title.textContent = '主题关联 · 研究主题到当前聚焦的顶层观点；展示元数据，不是账本事件'
      activeTopicEdge.appendChild(title)
      edgeLayer.appendChild(activeTopicEdge)
    }
    activeTopicEdge.setAttribute('data-to', target.id)
    activeTopicEdge.setAttribute('d', geometry.d)
  }

  const redrawEdges = () => {
    for (const r of edgeRecs) {
      const g = geomOf(r.edge)
      r.el.setAttribute('d', g.d)
      if (r.labelEl) r.labelEl.setAttribute('transform', `translate(${g.px.toFixed(1)} ${g.py.toFixed(1)})`)
    }
  }

  let focusedNodeId = null
  let hoveredNodeId = null
  const focusLabel = stage.querySelector('.cog-focus-label')
  const focusDetails = stage.querySelector('.cog-focus-detail')
  const clearFocus = stage.querySelector('.cog-focus-clear')
  const setFocus = (nodeId, notify = false) => {
    const nextFocus = nodeId || null
    const changed = focusedNodeId !== nextFocus
    focusedNodeId = nextFocus
    const connected = new Set(focusedNodeId ? [focusedNodeId] : [])
    if (focusedNodeId) {
      for (const record of edgeRecs) {
        if (record.edge.from === focusedNodeId || record.edge.to === focusedNodeId) {
          connected.add(record.edge.from); connected.add(record.edge.to)
        }
      }
    }
    for (const group of nodeLayer.querySelectorAll('.cog-node')) {
      const id = group.getAttribute('data-node-id')
      group.classList.toggle('is-selected', id === focusedNodeId)
      group.setAttribute('data-focus', focusedNodeId ? String(connected.has(id)) : 'all')
    }
    for (const record of edgeRecs) {
      const related = !focusedNodeId || record.edge.from === focusedNodeId || record.edge.to === focusedNodeId
      record.el.setAttribute('data-focus', focusedNodeId ? String(related) : 'all')
      record.labelEl?.classList.toggle('is-visible', Boolean(focusedNodeId && related))
    }
    updateTopicEdge(focusedNodeId || hoveredNodeId)
    const selected = proj.nodes.find((node) => node.id === focusedNodeId)
    if (focusLabel) focusLabel.textContent = selected
      ? `已选择：${selected.title} · 详情显示在右侧`
      : '选择一个观点以查看详情'
    if (focusDetails) focusDetails.hidden = !selected
    if (clearFocus) clearFocus.hidden = !selected
    if (notify && changed) opts.onFocusNode?.(selected || null)
  }
  svg.addEventListener('cog-clear-focus', () => setFocus(null))
  // 节点
  for (const n of nodes) {
    const kind = KIND[n.kind] || KIND.claim
    const sz = size.get(n.id)
    const p = pos.get(n.id)
    const isTheme = n.id === THEME_NODE_ID
    const g = el('g', {
      class: 'cog-node' + (isTheme ? ' is-theme' : ''), transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
      'data-kind': n.kind, 'data-status': n.status || 'pending',
      'data-node-id': n.id,
      'data-source-ref': n.sourceRef || `theme:${theme.id}`,
      'data-provenance': (n.provenanceEventIds || n.eventIds || []).join(','),
      tabindex: isTheme ? '-1' : '0', role: isTheme ? 'img' : 'button',
      'aria-label': isTheme ? `研究主题：${n.title}（主题元数据）`
        : `${kind.label}：${n.title}；${n.archived ? '已归档' : replaySeq != null ? `历史回放 v${replaySeq}` : '当前图节点'}${n.correct === false ? '；已证伪' : ''}${n.superseded ? '；已更正' : ''}。按回车或空格选中并在右侧查看详情。`,
    })
    const stroke = n.correct === false ? '#ea580c' : kind.border
    const rect = el('rect', {
      x: -sz.w / 2, y: -sz.h / 2, width: sz.w, height: sz.h, rx: 10,
      fill: n.archived ? '#f1f5f9' : kind.bg, stroke, 'stroke-width': n.correct === false ? 2.5 : 1.5,
      'stroke-dasharray': n.archived ? '5 4' : 'none',
    })
    g.appendChild(rect)
    if (!isTheme) {
      g.appendChild(el('circle', { cx: -sz.w / 2 + 13, cy: -sz.h / 2 + 12, r: 4, fill: kind.color }))
    }
    const lines = splitLines(n.title, n.kind === 'evidence' ? 10 : 13)
    lines.forEach((ln, i) => {
      g.appendChild(textEl(ln, {
        x: isTheme ? 0 : 5, y: lines.length === 1 ? 4 : -3 + i * 14,
        'text-anchor': 'middle', class: 'cog-node-title',
      }))
    })
    if (isTheme) {
      g.appendChild(textEl('主题根 · 元数据', { x: 0, y: sz.h / 2 - 8, 'text-anchor': 'middle', class: 'cog-node-sub' }))
    } else {
      const sub = []
      if (n.correct === false) sub.push('已证伪')
      else if (n.archived) sub.push('已归档')
      if (n.superseded) sub.push('已更正')
      if (sub.length && n.kind !== 'evidence') {
        g.appendChild(textEl(sub.join(' · '), {
          x: 5, y: sz.h / 2 - 7, 'text-anchor': 'middle', class: 'cog-node-sub',
        }))
      }
    }
    const tip = el('title')
    tip.textContent = isTheme ? `研究主题 · ${n.title}` : `${kind.label} · ${n.title}`
    g.appendChild(tip)

    // 单击、键盘焦点、Enter / Space 均选择节点并更新右侧检视器。
    if (!isTheme) {
      let sx = 0
      let sy = 0
      let moved = false
      let pointerActivation = false
      let suppressKeyboardClick = false
      let keyboardClickTimer = null
      g.addEventListener('focus', () => setFocus(n.id, true))
      g.addEventListener('mouseenter', () => {
        hoveredNodeId = n.id
        updateTopicEdge(focusedNodeId || hoveredNodeId)
      })
      g.addEventListener('mouseleave', () => {
        hoveredNodeId = null
        updateTopicEdge(focusedNodeId)
      })
      g.addEventListener('pointerdown', (ev) => {
        sx = ev.clientX; sy = ev.clientY; moved = false
        if (typeof g.setPointerCapture === 'function' && ev.pointerId != null) {
          try { g.setPointerCapture(ev.pointerId) } catch { /* synthetic pointer events may not have an active capture id */ }
        }
        const pt = pos.get(n.id)
        const onMove = (me) => {
          if (Math.hypot(me.clientX - sx, me.clientY - sy) > 4) moved = true
          if (!moved) return
          const r = svg.getBoundingClientRect()
          const k = W / (r.width || W)
          pt.x = Math.max(sz.w / 2 + 10, Math.min(W - sz.w / 2 - 10, pt.x + (me.clientX - sx) * k))
          pt.y = Math.max(sz.h / 2 + 10, Math.min(H - sz.h / 2 - 10, pt.y + (me.clientY - sy) * k))
          sx = me.clientX; sy = me.clientY
          g.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`)
          redrawEdges()
        }
        const onUp = () => {
          g.removeEventListener('pointermove', onMove)
          g.removeEventListener('pointerup', onUp)
          if (!moved) {
            g.focus({ preventScroll: true })
            setFocus(n.id, true)
          }
          pointerActivation = true
          setTimeout(() => { pointerActivation = false }, 0)
        }
        g.addEventListener('pointermove', onMove)
        g.addEventListener('pointerup', onUp)
      })
      g.addEventListener('click', (event) => {
        if (pointerActivation) { pointerActivation = false; return }
        if (event.detail === 0 && suppressKeyboardClick) { suppressKeyboardClick = false; return }
        setFocus(n.id, true)
      })
      g.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        if (ev.repeat) return
        ev.preventDefault()
        suppressKeyboardClick = true
        clearTimeout(keyboardClickTimer)
        keyboardClickTimer = setTimeout(() => { suppressKeyboardClick = false }, 750)
        setFocus(n.id, true)
      })
    }
    nodeLayer.appendChild(g)
  }

  canvas.append(svg)
  if (opts.focusNodeId) setFocus(opts.focusNodeId, false)
}
function renderLegend() {
  const rows = [
    ['supports', '支持', REL.supports.color, false, '关系来源 → 被支持对象'],
    ['derives', '推导', REL.derives.color, false, '前提 → 结论；待复核时改用灰色虚线'],
    ['contradicts', '反驳', REL.contradicts.color, false, '反驳来源 → 被反驳对象'],
    ['pending-review', '待复核', '#64748b', true, '保留原关系方向；灰色虚线表示尚未决定'],
    ['rejected', '已驳回', '#b91c1c', true, '红色虚线；箭头仍按 from → to'],
  ]
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
  const relationRows = rows.map(([key, label, color, dashed, description]) =>
    h('div', { class: 'cog-legend-row', 'data-legend-rel': key },
      sample(color, dashed),
      h('span', { class: 'cog-legend-copy' }, h('strong', {}, `${key} · ${label}`), h('span', {}, description))))
  return h('aside', { class: 'cog-graph-legend-corner', 'aria-label': '图谱关系图例' },
    h('strong', { class: 'cog-legend-title' }, '如何读图'),
    ...relationRows,
    h('p', { class: 'cog-legend-foot' }, '箭头均由账本关系 from 指向 to。主题 → 顶层观点的浅灰虚线无箭头，仅为主题元数据，不是事件。'))
}

/* ------------------------------------------------------------------ */
/* 节点详情抽屉：读投影，不读旧可变链字段                               */
/* ------------------------------------------------------------------ */

export async function openNodeDetail(theme, node, opts = {}) {
  const returnFocus = document.activeElement
  closeNodeDetail()
  const kind = KIND[node.kind] || KIND.claim
  const st = NODE_STATUS[node.status] || NODE_STATUS.pending
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
    !historical && !node.external && !node.archived && ['claim', 'inference'].includes(node.kind)
      ? renderEvidenceComposer(theme, node, opts) : null,
    !historical && !node.external && !node.archived ? renderRelationComposer(proj, node, theme, opts) : null,
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

function renderEvidenceComposer(theme, node, opts) {
  const text = h('textarea', { class: 'txt cog-entry-textarea', rows: '3', required: true, placeholder: '记录可核对的数字、观察或原文摘录', 'aria-label': '证据摘要或原文摘录' })
  const source = h('input', { class: 'txt', placeholder: '来源名称（可选）', 'aria-label': '来源名称' })
  const url = h('input', { class: 'txt', type: 'url', placeholder: 'https://…（可选）', 'aria-label': '来源链接' })
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const form = h('form', { class: 'cog-entry-form' },
    h('p', { class: 'cog-entry-note' }, '这会追加一条证据记录，并由你明确声明它支持此观点；来源真实性不会被自动验证。'),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '证据摘要或原文摘录'), text),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '来源名称（可选）'), source),
    h('label', { class: 'cog-entry-field' }, h('span', {}, '来源链接（可选）'), url),
    error,
    h('button', { type: 'submit', class: 'btn btn-primary' }, '追加证据'))
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!text.value.trim()) { error.hidden = false; error.textContent = '请填写证据摘要或原文摘录。'; text.focus(); return }
    const button = form.querySelector('button[type="submit"]')
    button.disabled = true
    try {
      const result = await m.chainAddEvidence(theme.id, node.id, { text: text.value.trim(), sourceLabel: source.value.trim(), url: url.value.trim() })
      if (result?.ok === false) throw new Error(result.error || '保存未完成')
      toast('已追加证据与支持关系')
      closeNodeDetail(); opts.onChanged?.()
    } catch (saveError) {
      error.hidden = false; error.textContent = saveError.message || String(saveError); button.disabled = false
    }
  })
  return h('section', { class: 'chain-dsect cog-action-section' },
    h('details', { class: 'cog-action-disclosure' }, h('summary', {}, '补充证据'), form))
}

function renderRelationComposer(proj, node, theme, opts) {
  const choices = (proj?.nodes || []).filter((candidate) => candidate.id !== node.id && !candidate.external && !candidate.archived)
  const disclosure = h('details', { class: 'cog-action-disclosure' }, h('summary', {}, '添加支持或反驳关系'))
  if (!choices.length) {
    disclosure.append(h('p', { class: 'cog-entry-note' }, '暂时没有其他未归档节点可连接。'))
    return h('section', { class: 'chain-dsect cog-action-section' }, disclosure)
  }
  const target = h('select', { class: 'txt', 'aria-label': '关系的另一个节点' },
    h('option', { value: '' }, '选择观点、问题或证据'),
    ...choices.map((candidate) => h('option', { value: candidate.id }, `${KIND[candidate.kind]?.label || '节点'} · ${candidate.title}`)))
  const relation = h('select', { class: 'txt', 'aria-label': '关系类型' },
    h('option', { value: 'supports' }, '支持'), h('option', { value: 'contradicts' }, '反驳'),
    h('optgroup', { label: '高级关系' }, h('option', { value: 'derives' }, '推导')))
  const preview = h('p', { class: 'cog-entry-note', 'aria-live': 'polite' }, '关系方向会在选择节点后显示。')
  const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
  const getDirection = () => {
    const other = choices.find((candidate) => candidate.id === target.value)
    if (!other) return null
    if (relation.value === 'supports' && node.kind === 'evidence' && ['claim', 'inference'].includes(other.kind)) return { from: node, to: other }
    if (relation.value === 'supports' && ['claim', 'inference'].includes(node.kind) && other.kind === 'evidence') return { from: other, to: node }
    return { from: node, to: other }
  }
  const updatePreview = () => {
    const direction = getDirection()
    preview.textContent = direction
      ? `${direction.from.title} —${REL[relation.value]?.label || '关系'}→ ${direction.to.title}。这是关系声明，不是已验证的因果结论。`
      : '选择另一个节点以查看关系方向。'
  }
  target.addEventListener('change', updatePreview)
  relation.addEventListener('change', updatePreview)
  const form = h('form', { class: 'cog-entry-form' },
    h('p', { class: 'cog-entry-note' }, '“推导”保留为高级关系；支持或反驳由你声明，不会被系统当作已验证因果。'),
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
  return edges.map((e) => {
    const otherId = e.from === node.id ? e.to : e.from
    const other = nodeById.get(otherId)
    const rel = REL[e.rel] || REL.supports
    const dir = e.from === node.id ? '→' : '←'
    const status = e.pendingReview ? '待人工复核' : e.reviewDecision === 'confirmed' ? '已由用户确认'
      : e.reviewDecision === 'rejected' ? '已由用户驳回' : '用户声明 · 未自动验证'
    const decisionEvent = e.reviewEventId ? eventsById.get(e.reviewEventId) : null
    const declarationEvent = eventsById.get(e.eventId)
    return h('div', { class: `chain-relation-item${e.pendingReview ? ' is-pending' : ''}${e.reviewDecision === 'rejected' ? ' is-rejected' : ''}` },
      h('button', {
        type: 'button', class: 'chain-evidence', title: other && !other.external ? '查看该节点' : '',
        onclick: () => { if (other && !other.external) openNodeDetail(theme, other, opts) },
      },
        h('span', { class: 'chain-evidence-type', style: `color:${rel.color}` }, `${status} · ${rel.label} ${dir}`),
        h('span', { class: 'chain-evidence-id' }, other ? other.title : '来源未解析')),
      e.reviewReason ? h('p', { class: 'chain-note' }, `决定理由：${e.reviewReason}`) : null,
      e.reviewedBy || e.reviewedAt ? h('p', { class: 'chain-note' }, `决定者：${ACTOR_LABEL[e.reviewedBy] || e.reviewedBy || '未记录'} · 时间：${fmtAt(e.reviewedAt)}`) : null,
      e.pendingReview && declarationEvent ? h('button', { type: 'button', class: 'btn cog-event-focus', onclick: () => opts.onJumpToEvent?.(declarationEvent) }, `前往账本复核 · 第 ${declarationEvent.seq} 条`) : null,
      decisionEvent ? h('button', { type: 'button', class: 'btn cog-event-focus', onclick: () => opts.onJumpToEvent?.(decisionEvent) }, `查看决定事件 · 第 ${decisionEvent.seq} 条`) : null)
  })
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
      : `${(REL[p.rel] || {}).label || p.rel}${p.reviewStatus === 'pending-review' || p.rel === 'derives' ? '（待复核）' : ''}${p.mapping ? ` · ${p.mapping}` : ''}`
  } else if (e.type === 'settlement.recorded') {
    summary = p.correct === false ? '判定为错误' : p.correct === true ? '判定为正确' : '已结算'
  } else if (e.type === 'node.archived') {
    summary = `归档：${p.reason || '未记录原因'}`
  } else if (e.type === 'node.restored') {
    summary = `恢复：${p.reason || '未记录原因'}`
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
  // 已有主张改为从认知投影异步加载（不再读旧 chain.segments）
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
