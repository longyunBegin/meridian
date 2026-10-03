import { h, toast } from '../lib/dom.js'
import {
  NETWORK_NODE_TYPES, NODE_TYPE_META, NODE_STATUS_LABEL, REVISION_RELATIONS, READER_STATE_META, readerStateKey,
  graphLodLevel, GRAPH_LOD_LABEL, evidenceAttachmentEdges, categoryColor,
  networkNodeType, networkNodeStatus,
  buildEventTimeline, layoutThemeNetwork, timelineChangeSummary, truncateGraphemes,
} from '../lib/theme-network.js'
import { drawThemeNetwork } from '../lib/theme-network-render.js'
import { evidenceForNode } from '../lib/chain-workbench-model.js'
import {
  filterReaderNodes, nodeCategory, buildSynthesisAxis, buildArgumentOutline, strengthSparkline,
  buildGapList, buildDebateBoard, buildChronicle, buildAdjacencyMatrix, matrixReplacesGraph,
  graphNeighborhood, shortestNodePath, buildCategoryAggregation,
  synthesisSummary, UNCATEGORIZED_LABEL,
} from '../lib/reader-model.js'
import { renderSynthesisAxis } from '../components/reader-synthesis-axis.js'
import { renderArgumentOutline } from '../components/reader-argument-outline.js'
import { renderSmallMultiples } from '../components/reader-small-multiples.js'
import { renderGapList } from '../components/reader-gaps.js'
import { renderDebateBoard } from '../components/reader-debate-board.js'
import { renderChronicle } from '../components/reader-chronicle.js'
import { renderAdjacencyMatrix } from '../components/reader-matrix.js'
import { renderCategoryBars } from '../components/reader-category-bars.js'
import {
  GRAPH_FRAME_EDGE_LIMIT, GRAPH_FRAME_NODE_LIMIT, searchGraphNodes, selectGraphWindow,
  verifiedLedgerPrefix,
} from '../lib/chain-ui-model.js'

const TYPE_LABEL = Object.fromEntries(NETWORK_NODE_TYPES.map((type) => [type, NODE_TYPE_META[type].label]))
const STATUS_FILTERS = ['pending', 'verified', 'disputed', 'invalidated', 'archived']
const SEARCH_PAGE_SIZE = 20
const asArray = (value) => Array.isArray(value) ? value : []
const titleOf = (node) => String(node?.title || node?.currentText || '未命名节点')
const allNodesOf = (projection) => asArray(projection?.allNodes || projection?.nodes).filter(Boolean)
const allEdgesOf = (projection) => asArray(projection?.allEdges || projection?.edges).filter(Boolean)
const dateText = (value) => {
  const text = String(value || '').trim()
  return text ? text.replace('T', ' ').slice(0, 19) : '未记录'
}
const cleanText = (value, limit = 1000) => truncateGraphemes(String(value || '').replace(/\s+/g, ' ').trim(), limit)
const safeUrl = (value) => {
  try {
    const url = new URL(String(value || ''))
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}
const eventTime = (event) => event?.at || event?.timestamp || null
const sourceDateOf = (payload) => payload?.publishedAt || payload?.sourcePublishedAt || payload?.sourceDate || payload?.publicationDate || payload?.date || null
const applicabilityOf = (payload) => {
  const direct = payload?.applicability || payload?.applies || payload?.appliesTo || payload?.timeWindow
    || payload?.statement?.timeWindow || payload?.recommendation?.timeWindow
  if (direct) return String(direct)
  const from = payload?.effectiveFrom || payload?.validFrom || payload?.appliesFrom
  const to = payload?.effectiveTo || payload?.validTo || payload?.appliesToDate
  if (from || to) return `${from || '起点未记录'} — ${to || '当前/终点未记录'}`
  return '未记录'
}
const scoreRowsOf = (payload) => {
  const recommendation = payload?.recommendation || {}
  const attribution = payload?.attribution || {}
  const scores = payload?.scores || payload?.modelScores || {}
  const rows = [
    ['匹配分数', recommendation.matchScore ?? payload?.matchScore ?? scores.matchScore ?? scores.match, '候选匹配'],
    ['归因强度', recommendation.strength ?? attribution.strength ?? payload?.strength ?? scores.attributionStrength ?? scores.attribution, '关系建议'],
    ['有效强度估算', recommendation.effectiveStrength ?? payload?.effectiveStrength ?? scores.effectiveStrength, '规则估算'],
    ['模型置信度', recommendation.confidence ?? payload?.modelConfidence ?? scores.confidence, '模型输出'],
  ]
  return rows.filter(([, value]) => Number.isFinite(Number(value)) && value !== '' && value != null)
    .map(([label, value, scope]) => {
      const numeric = Number(value)
      return { label, value: Math.max(0, Math.min(1, numeric > 1 && numeric <= 100 ? numeric / 100 : numeric)), scope }
    })
}

function sourceEventFor(node, eventsById, events) {
  const latestCorrection = [...asArray(node?.eventIds)].reverse()
    .map((id) => eventsById.get(id)).find((event) => event?.type === 'correction.appended')
  if (latestCorrection) return latestCorrection
  const ids = [...new Set([...(node?.provenanceEventIds || []), ...(node?.eventIds || []), node?.id].filter(Boolean))]
  for (const id of ids) if (eventsById.has(id)) return eventsById.get(id)
  const ref = node?.sourceRef
  if (ref) {
    const found = events.find((event) => event?.payload?.sourceRef === ref || event?.payload?.sourceRef?.id === ref)
    if (found) return found
  }
  return null
}

function renderSourceRecord(node, event, { onLocateEvent, stanceLabel } = {}) {
  const payload = event?.payload || {}
  const reviewLabel = node?.reviewDecision === 'rejected' ? '已驳回 · 原记录保留'
    : node?.reviewDecision === 'corrected' ? '已复核 · 建议已修订'
      : node?.reviewDecision === 'accepted' || node?.reviewDecision === 'confirmed' ? '已复核 · 已接受'
        : node?.pendingReview ? '待人工复核' : ''
  const source = payload.sourceLabel || payload.legacySource?.label || payload.sourceKind || node?.sourceKind || '来源未记录'
  const url = safeUrl(payload.sourceUrl || payload.url || payload.evidenceRefs?.find?.((ref) => ref?.type === 'url')?.id)
  const scores = scoreRowsOf(payload)
  const sourceDate = sourceDateOf(payload)
  const applicability = applicabilityOf(payload)
  const m = globalThis.window?.meridian || {}
  const sourceLink = url ? h('button', {
    type: 'button', class: 'btn btn-sm rdr-source-open', onclick: () => m.openExternal?.(url),
  }, '查看来源') : null
  return h('article', { class: 'rdr-evidence-card', 'data-evidence-id': node?.id || '' },
    h('div', { class: 'rdr-evidence-top' },
      h('span', { class: 'rdr-evidence-kind' }, '证据'),
      stanceLabel ? h('span', { class: 'rdr-evidence-stance' }, stanceLabel) : null,
      reviewLabel ? h('span', { class: `rdr-evidence-review${node?.reviewDecision === 'rejected' ? ' is-rejected' : ''}` }, reviewLabel) : null,
      h('strong', { class: 'rdr-evidence-title' }, titleOf(node)),
      sourceLink),
    h('p', { class: 'rdr-evidence-text' }, cleanText(payload.text || payload.quote || node?.currentText || node?.detail || '来源内容未记录。')),
    h('dl', { class: 'rdr-provenance-grid' },
      h('div', {}, h('dt', {}, '来源'), h('dd', {}, String(source))),
      h('div', {}, h('dt', {}, '来源发布时间'), h('dd', {}, dateText(sourceDate))),
      h('div', {}, h('dt', {}, '适用时间'), h('dd', {}, applicability)),
      h('div', {}, h('dt', {}, '系统摄入时间'), h('dd', {}, dateText(payload.ingestedAt || eventTime(event)))),
      h('div', {}, h('dt', {}, '来源抓取时间'), h('dd', {}, dateText(payload.sourceFetchedAt))),
      h('div', {}, h('dt', {}, '事件追加时间'), h('dd', {}, dateText(eventTime(event))))),
    scores.length ? h('div', { class: 'rdr-score-block' },
      h('strong', {}, '来源中的模型/规则评分'),
      h('div', { class: 'rdr-score-list' }, ...scores.map((row) => h('span', { class: 'rdr-score-chip' },
        `${row.label} ${Math.round(row.value * 100)}% · ${row.scope}`))),
      h('p', {}, '评分对应不同任务或规则，不能互相替代，也不等于证据真实性。')) : null,
    event && onLocateEvent ? h('button', {
      type: 'button', class: 'rdr-event-link', onclick: () => onLocateEvent(event),
    }, `查看来源事件 · 第 ${event.seq || '—'} 条`) : null)
}

function renderRelation(edge, node, nodesById, onSelect) {
  const from = nodesById.get(edge.from)
  const to = nodesById.get(edge.to)
  const isArgument = ['supports', 'derives', 'contradicts'].includes(edge.rel)
  const isRevision = REVISION_RELATIONS.includes(edge.rel) || edge.relationGroup === 'revision'
  const relLabels = {
    supports: '支持', derives: '推导', contradicts: '反驳', 'belongs-to': '归属',
    influences: '影响', 'depends-on': '依赖', temporal: '时间关联', related: '相关', supersedes: '修订版本',
  }
  const state = edge.reviewDecision === 'rejected' ? ' · 已驳回（保留原声明）'
    : edge.pendingReview ? ' · 待人工复核'
      : edge.reviewDecision === 'confirmed' ? ' · 已确认' : ''
  const endpoint = (item, direction) => item ? h('button', {
    type: 'button', class: 'rdr-relation-node', 'data-node-id': item.id,
    onclick: () => onSelect(item.id),
  }, `${direction === 'from' ? '来源' : '目标'}：${titleOf(item)}`) : h('span', {}, '节点未解析')
  return h('article', { class: `rdr-relation-row ${isArgument ? 'is-argument' : isRevision ? 'is-revision' : 'is-association'}${edge.pendingReview ? ' is-pending' : ''}${edge.reviewDecision === 'rejected' ? ' is-rejected' : ''}`, 'data-rel': edge.rel || '' },
    endpoint(from, 'from'),
    h('span', { class: 'rdr-relation-label' }, `${relLabels[edge.rel] || edge.rel || '关系'}${isArgument ? ' · 有方向论证' : isRevision ? ' · 有方向版本关系' : ' · 弱主题关联'}${state}`),
    endpoint(to, 'to'),
    edge.decisionReason ? h('p', { class: 'rdr-relation-reason' }, `复核理由：${edge.decisionReason}`) : null)
}

/** Reader view uses the same current projection and node ids as the builder. */
export function renderReaderView(theme, opts = {}) {
  const root = h('div', { class: 'meridian-theme rdr-root' })
  const article = h('article', { class: 'reader-main rdr-main', 'aria-label': `${theme?.name || '主题'} · 读者视图` },
    h('p', { class: 'rdr-loading' }, '正在读取已校验的主题网络…'))
  root.append(article)

  const renderEmpty = (projection) => h('div', { class: 'rdr-empty' },
    h('p', { class: 'rdr-kicker' }, '主题范围 · 真实空投影'),
    h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题'),
    h('p', { class: 'rdr-empty-text' }, projection?.integrity?.ok === false
      ? '账本校验异常，当前没有可安全展示的有效节点。损坏尾部不会用于构建主题视图。'
      : '这个主题目前没有节点。主题只限定网络范围，不会自动成为根节点，也不会生成内容。'),
    h('p', { class: 'rdr-empty-sub' }, '建设者可从外部来源、观察或观点开始；每条关系与来源都保留为独立记录。'),
    h('button', { type: 'button', class: 'btn btn-primary', onclick: () => opts.onOpenBuilder?.('network') }, '进入建设者视图'))

  let refreshGeneration = 0
  /* 全览开关（面板装不下一屏时用）：挂在 reader 视图闭包上，跨多次 render 保持。 */
  let overviewMode = false
  /* 图谱缩放与 LOD（设计提案 02）：缩放 <0.75 点阵 / ≤1.15 卡片 / >1.15 卡片+标题。 */
  let zoom = 1
  let lodAuto = true
  /* R1 论证大纲的折叠状态：只存内存（§10.3 验收要求），不写任何数据。 */
  const outlineExpanded = new Set()
  /* R7：图是局部工具——默认 'local'（选中原子才画 1–2 跳邻域），'full' 是显式入口。 */
  let graphScope = 'local'
  /* 吸顶分段导航当前锚点（只存内存）。 */
  let activeSection = 'reader-axis'
  const render = (currentProjection, rawEvents, selectedSeq = null, replayProjection = null) => {
    const generation = ++refreshGeneration
    const integrity = currentProjection?.integrity || {}
    const verifiedEvents = verifiedLedgerPrefix(rawEvents, integrity)
    const currentNodes = allNodesOf(currentProjection)
    const currentEdges = allEdgesOf(currentProjection)
    if (!currentNodes.length) {
      article.replaceChildren(renderEmpty(currentProjection))
      return
    }

    const timeline = buildEventTimeline(verifiedEvents)
    /* 布局按容器实测宽度算：写死 1120 会在这块 ~500px 的面板里被 CSS 缩到 0.64 倍
       （卡片标题实际只有 8px），还得横向滚动。归位/入库只写 evidence.appended +
       targetNodeIds（未声明立场），布局必须把证据挂载也算进去，否则证据会散落在画布各处。 */
    let layout = null
    const ensureLayout = () => {
      const measured = Math.round(graphCanvas?.clientWidth || 0)
      const width = Math.max(480, Math.min(1680, measured > 40 ? measured - 8 : 1120))
      if (layout && layout.width === width) return layout
      const attachmentEdges = evidenceAttachmentEdges(currentNodes, currentEdges)
      layout = layoutThemeNetwork(currentNodes, [...currentEdges, ...attachmentEdges], width)
      return layout
    }
    const state = {
      projection: selectedSeq == null ? currentProjection : (replayProjection || currentProjection),
      events: selectedSeq == null ? verifiedEvents : verifiedEvents.filter((event) => event.seq <= selectedSeq),
      selectedSeq,
      selectedNodeId: null,
      compareCurrent: false,
      liveSelectedNodeId: null,
      searchMatches: [],
      searchPage: 1,
      searchLocatedNodeId: null,
      replaying: selectedSeq != null,
      loadingReplay: false,
    }
    let historyNodes = allNodesOf(state.projection)
    let historyEdges = allEdgesOf(state.projection)
    let nodesById = new Map(historyNodes.map((node) => [node.id, node]))
    let eventById = new Map(state.events.map((event) => [event.id, event]))
    const refreshHistoryIndexes = () => {
      historyNodes = allNodesOf(state.projection)
      historyEdges = allEdgesOf(state.projection)
      nodesById = new Map(historyNodes.map((node) => [node.id, node]))
      eventById = new Map(state.events.map((event) => [event.id, event]))
    }
    const graphCanvas = h('div', { class: 'rdr-graph-canvas', 'aria-label': '原子节点图谱画布' })
    const inspector = h('aside', { class: 'rdr-inspector', 'aria-label': '节点、证据与来源检视', 'aria-live': 'polite' })
    const focusLabel = h('span', { class: 'rdr-focus-label', role: 'status', 'aria-live': 'polite' }, '选择任一节点查看其论证、关联与来源')
    const nodeSearch = h('input', { class: 'txt rdr-search', type: 'search', placeholder: '搜索所有节点、说明或旧名', 'aria-label': '搜索完整主题中的所有节点' })
    const searchResults = h('div', { class: 'rdr-search-results', role: 'listbox', 'aria-label': '全量节点搜索结果', hidden: true })
    const searchStatus = h('p', { class: 'rdr-search-status', role: 'status', 'aria-live': 'polite' })
    // 类型筛选已移除：主题下只有原子节点，无类型区分
    const typeFilter = h('select', { class: 'txt rdr-filter', 'aria-label': '按节点类型筛选', hidden: true },
      h('option', { value: 'all' }, '全部类型'))
    const statusFilter = h('select', { class: 'txt rdr-filter', 'aria-label': '按节点状态筛选' },
      h('option', { value: 'all' }, '全部状态'),
      ...STATUS_FILTERS.map((status) => h('option', { value: status }, NODE_STATUS_LABEL[status])))
    /* 分类筛选来自 L2 主题自定义层（主题设置里的原子分类）：主题没配分类就不出现，
       配了之后"未分类"单独一档，保证早先建的原子仍然找得到。 */
    const themeCategories = asArray(theme?.config?.atomCategories).map((name) => String(name || '').trim()).filter(Boolean)
    const categoryFilter = h('select', { class: 'txt rdr-filter', 'aria-label': '按原子分类筛选', hidden: themeCategories.length === 0 },
      h('option', { value: 'all' }, '全部分类'),
      ...themeCategories.map((name) => h('option', { value: name }, name)),
      h('option', { value: UNCATEGORIZED_LABEL }, UNCATEGORIZED_LABEL))
    const countStatus = h('span', { class: 'rdr-node-count', role: 'status', 'aria-live': 'polite' })
    /* R7 路径查询：图真正擅长的"两原子之间怎么走"。 */
    const pathFrom = h('select', { class: 'txt rdr-path-select', 'aria-label': '路径起点' })
    const pathTo = h('select', { class: 'txt rdr-path-select', 'aria-label': '路径终点' })
    const pathFind = h('button', { type: 'button', class: 'btn btn-sm rdr-path-find' }, '找路径')
    const pathStatus = h('p', { class: 'rdr-path-status', role: 'status', 'aria-live': 'polite' }, '选两个原子，看它们之间隔着几条关系。')
    const timeSlider = h('input', {
      class: 'rdr-time-slider', type: 'range', min: '0', max: String(Math.max(0, timeline.length - 1)), step: '1',
      value: String(Math.max(0, timeline.length - 1)),
      disabled: timeline.length < 2 || typeof opts.loadProjectionAt !== 'function',
      'aria-label': '回放已校验的主题事件时间线',
    })
    const hasDatedTimeline = timeline.some((point) => point.day != null)
    const timeStatus = h('p', { class: 'rdr-time-status', role: 'status', 'aria-live': 'polite' },
      timeline.length
        ? (hasDatedTimeline
          ? '时间轴只使用已校验事件；缺失日期留作“日期未记录”，不会推断真实时间。'
          : '没有可用时间元数据；仅按已校验账本序号回放，不推断日期。')
        : '暂无可回放的已校验事件。')
    const playButton = h('button', { type: 'button', class: 'btn btn-sm rdr-play-button', 'aria-pressed': 'false', disabled: timeSlider.disabled }, '播放')
    const liveButton = h('button', { type: 'button', class: 'btn btn-sm rdr-live-button', hidden: true }, '返回当前模型')
    const compareButton = h('button', { type: 'button', class: 'btn btn-sm rdr-compare-button', hidden: true, 'aria-pressed': 'false' }, '与当前对比')
    const historyCaption = h('span', { class: 'rdr-history-caption', role: 'status', 'aria-live': 'polite' })
    const replayBox = h('section', { class: 'rdr-history', 'aria-label': '主题时间回放' },
      h('div', { class: 'rdr-history-head' },
        h('div', {}, h('strong', {}, '时间回放'), h('p', {}, '同一组节点位置按事件前缀重放；不生成或改写事件。')),
        h('div', { class: 'rdr-history-actions' }, playButton, compareButton, liveButton)),
      timeSlider, historyCaption, timeStatus)

    let searchPage = 1
    let previousQuery = ''
    let replayTimer = null
    let playbackTimer = null
    let playbackIndex = -1
    let playbackGeneration = 0
    let replayPlaying = false
    let replayRequest = 0
    const currentFocusNode = () => historyNodes.find((node) => node.id === state.selectedNodeId) || null

    const renderInspector = () => {
      inspector.replaceChildren()
      const node = currentFocusNode()
      if (!node) {
        inspector.append(
          h('div', { class: 'rdr-inspector-empty' },
            h('span', { class: 'rdr-inspector-kicker' }, '主题整体模型'),
            h('h2', {}, theme?.name || '主题'),
            h('p', {}, '主题没有中心 root。图中节点并列呈现；实线/箭头表达有方向的支持、推导或反驳，弱关联单独呈现。'),
            h('p', {}, '综合解释尚未作为独立的人工结论写入主题。这里不按支持关系数量判断整体方向；选择节点后可追溯其证据、适用时间和未决项。'),
            h('div', { class: 'rdr-read-integrity', role: integrity.ok === false ? 'alert' : 'status' }, integrity.ok === false
              ? `完整性异常 · 仅展示校验有效前缀 ${integrity.lastValidSeq || 0} 条事件`
              : `链完整 · ${verifiedEvents.length} 条记录`),
            state.selectedSeq != null ? h('p', { class: 'rdr-historical-note' }, `当前为历史回放 · 第 ${state.selectedSeq} 条之后的事件不参与此时点模型。`) : null,
            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => opts.onOpenBuilder?.('network') }, '进入建设者视图')))
        return
      }
      const type = networkNodeType(node)
      const status = networkNodeStatus(node)
      const incidentEdges = historyEdges.filter((edge) => edge.from === node.id || edge.to === node.id)
      const evidenceSummary = evidenceForNode(state, node.id)
      const evidenceNodes = [...new Map([
        ...evidenceSummary.supports, ...evidenceSummary.against, ...evidenceSummary.both, ...evidenceSummary.unclassified,
      ].map((row) => [row.source.id, row.source])).values()]
      const pending = incidentEdges.filter((edge) => edge.pendingReview && edge.reviewDecision == null)
      const evidenceBuckets = [
        { key: 'support', label: '支持', nodes: evidenceSummary.supports.map((row) => row.source) },
        { key: 'against', label: '提出反驳', nodes: evidenceSummary.against.map((row) => row.source) },
        { key: 'both', label: '支持与反驳并存', nodes: evidenceSummary.both.map((row) => row.source) },
        { key: 'unclassified', label: '已关联，方向未标注', nodes: evidenceSummary.unclassified.map((row) => row.source) },
        { key: 'rejected', label: '已驳回 · 保留在账本', nodes: evidenceSummary.rejected.map((row) => row.source) },
      ]
      const event = sourceEventFor(node, eventById, state.events)
      const detail = node.currentText || node.detail || node.coreInfo || ''
      const strength = Math.round(Number(node.confidence ?? node.strength ?? 0))
      const supportCount = evidenceSummary.supports.length + evidenceSummary.both.length
      const challengeCount = evidenceSummary.against.length + evidenceSummary.both.length
      // 外部数据按时间倒序
      const sortedEvidence = [...evidenceNodes].sort((a, b) => {
        const ta = sourceEventFor(a, eventById, state.events)?.at || a.at || 0
        const tb = sourceEventFor(b, eventById, state.events)?.at || b.at || 0
        return new Date(tb) - new Date(ta)
      })
      inspector.append(
        h('div', { class: 'rdr-inspector-head' },
          h('p', { class: 'rdr-inspector-kicker' }, `原子 · ${NODE_STATUS_LABEL[status] || status}`),
          h('h2', { class: 'rdr-inspector-title' }, titleOf(node)),
          detail ? h('p', { class: 'rdr-inspector-summary' }, cleanText(detail)) : h('p', { class: 'rdr-inspector-summary is-empty' }, '没有记录节点说明。'),
          // 当前强度条（对齐设计稿）
          h('div', { class: 'rdr-strength-block' },
            h('div', { class: 'rdr-strength-label-row' },
              h('span', {}, '当前强度'),
              h('strong', {}, `${strength}%`)),
            h('div', { class: 'rdr-strength-bar', role: 'progressbar', 'aria-valuenow': strength, 'aria-valuemin': 0, 'aria-valuemax': 100 },
              h('div', { class: 'rdr-strength-fill', style: `width:${strength}%` })),
            h('div', { class: 'rdr-strength-counts' },
              h('span', { class: 'rdr-count-pill is-support' }, `支持 ${supportCount}`),
              h('span', { class: 'rdr-count-pill is-challenge' }, `挑战 ${challengeCount}`)))),
        h('div', { class: 'rdr-inspector-scroll' },
          h('section', { class: 'rdr-inspector-section rdr-reader-questions' },
            h('h3', {}, '读者三问 · 仅呈现账本中明确记录的关系'),
            ...[
              { label: '哪些关系支持该观点？', rows: incidentEdges.filter((edge) => edge.rel === 'supports') },
              { label: '哪些关系提出反驳或挑战？', rows: incidentEdges.filter((edge) => edge.rel === 'contradicts') },
              { label: '哪些关系待复核？', rows: incidentEdges.filter((edge) => edge.pendingReview && edge.reviewDecision == null) },
              { label: '推导、修订与弱关联', rows: incidentEdges.filter((edge) => !['supports', 'contradicts'].includes(edge.rel)) },
            ].map((group) => h('div', { class: `rdr-relation-group${group.rows.some((edge) => edge.pendingReview && edge.reviewDecision == null) ? ' is-pending' : ''}` },
              h('strong', {}, `${group.label} · ${group.rows.length}`),
              group.rows.length ? h('div', { class: 'rdr-relations' }, ...group.rows.map((edge) => renderRelation(edge, node, nodesById, (id) => {
                if (!nodesById.has(id)) return
                state.selectedNodeId = id
                renderInspector()
                renderGraph()
              }))) : h('p', { class: 'rdr-muted' }, '账本未记录此类关系；这不表示已经排除反例。'))),
            h('p', { class: 'rdr-relation-note' }, '支持、推导与反驳是有方向论证；归属、影响、依赖、时间关联与相关是弱主题关联。关系数量不构成可信度评级。')),
          h('section', { class: 'rdr-inspector-section' },
            h('h3', {}, `未决项 · ${pending.length + (status === 'disputed' ? 1 : 0)}`),
            status === 'disputed' ? h('p', { class: 'rdr-open-item' }, '节点当前标记为有争议。') : null,
            ...pending.map((edge) => h('p', { class: 'rdr-open-item' }, `关系「${edge.rel || '未知'}」仍待人工复核。`)),
            !pending.length && status !== 'disputed' ? h('p', { class: 'rdr-muted' }, '当前没有显式记录的未决项；这不表示所有问题都已解决。') : null),
          h('section', { class: 'rdr-inspector-section' },
            h('h3', {}, `外部数据 · ${evidenceSummary.total} 条（按时间倒序）`),
            h('p', { class: 'rdr-evidence-count-note' }, '按唯一证据节点计数；佐证/反驳徽标表示该证据与当前节点的关系方向。'),
            sortedEvidence.length ? h('div', { class: 'rdr-evidence-list-flat' }, ...sortedEvidence.map((evidence) => {
              const sourceEvent = sourceEventFor(evidence, eventById, state.events)
              // 判断徽标
              const isSupport = evidenceSummary.supports.some((r) => r.source.id === evidence.id) || evidenceSummary.both.some((r) => r.source.id === evidence.id)
              const isChallenge = evidenceSummary.against.some((r) => r.source.id === evidence.id) || evidenceSummary.both.some((r) => r.source.id === evidence.id)
              const badge = isSupport && isChallenge ? h('span', { class: 'rdr-evidence-badge is-both' }, '佐证/反驳')
                : isSupport ? h('span', { class: 'rdr-evidence-badge is-support' }, '佐证')
                : isChallenge ? h('span', { class: 'rdr-evidence-badge is-challenge' }, '反驳')
                : h('span', { class: 'rdr-evidence-badge is-neutral' }, '已关联')
              return h('div', { class: 'rdr-evidence-item' }, badge, renderSourceRecord(evidence, sourceEvent, {
                onLocateEvent: (source) => opts.onOpenBuilder?.('network', evidence.id, source.id),
              }))
            })) : h('p', { class: 'rdr-muted' }, '没有找到直接关联的证据节点。观点说明本身不是证据。')),
          event ? h('section', { class: 'rdr-inspector-section' },
            h('h3', {}, '节点自身的来源记录'),
            renderSourceRecord(node, event, { onLocateEvent: (source) => opts.onOpenBuilder?.('network', node.id, source.id) })) : null,
          h('section', { class: 'rdr-inspector-section rdr-node-identity' },
            h('span', {}, `节点 ID · ${node.id}`),
            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => opts.onOpenBuilder?.('network', node.id) }, '在建设者视图定位同一节点'))))
    }

    const renderSearch = () => {
      const query = nodeSearch.value.trim()
      const matches = searchGraphNodes(currentNodes, query)
      state.searchMatches = matches
      if (query !== previousQuery) { searchPage = 1; previousQuery = query }
      searchResults.replaceChildren()
      if (!query) {
        searchResults.hidden = true
        searchStatus.textContent = `全量检索范围：${currentNodes.length} 个节点。画布可渐进展开，搜索始终覆盖完整投影。`
        return
      }
      searchResults.hidden = false
      if (!matches.length) { searchStatus.textContent = '没有找到匹配节点。'; return }
      const pages = Math.max(1, Math.ceil(matches.length / SEARCH_PAGE_SIZE))
      searchPage = Math.min(searchPage, pages)
      const start = (searchPage - 1) * SEARCH_PAGE_SIZE
      for (const node of matches.slice(start, start + SEARCH_PAGE_SIZE)) {
        const present = historyNodes.some((item) => item.id === node.id)
        const result = h('button', {
          type: 'button', role: 'option', class: 'rdr-search-result', 'data-node-id': node.id,
          onclick: () => {
            if (!present) {
              searchStatus.textContent = '该节点在此历史时点尚未建立；退出回放后可定位当前节点。'
              return
            }
            state.selectedNodeId = node.id
            state.searchLocatedNodeId = node.id
            renderInspector()
            renderGraph()
            focusSearchResult(node.id)
          },
        }, h('span', { class: 'rdr-search-type' }, '原子'),
        h('span', {}, titleOf(node)),
        !present ? h('span', { class: 'rdr-search-future' }, '此时点之后新增') : null)
        result.addEventListener('keydown', (event) => {
          const buttons = [...searchResults.querySelectorAll('.rdr-search-result')]
          const index = buttons.indexOf(result)
          if (event.key === 'Escape') { event.preventDefault(); nodeSearch.value = ''; renderSearch(); nodeSearch.focus() }
          else if (event.key === 'ArrowDown') { event.preventDefault(); buttons[index + 1]?.focus() }
          else if (event.key === 'ArrowUp') { event.preventDefault(); index ? buttons[index - 1]?.focus() : nodeSearch.focus() }
        })
        searchResults.append(result)
      }
      const pager = h('div', { class: 'rdr-search-pager' },
        h('button', { type: 'button', class: 'btn btn-sm', disabled: searchPage <= 1, onclick: () => { searchPage--; renderSearch() } }, '上一组'),
        h('span', {}, `结果 ${start + 1}–${Math.min(start + SEARCH_PAGE_SIZE, matches.length)} / ${matches.length}`),
        h('button', { type: 'button', class: 'btn btn-sm', disabled: searchPage >= pages, onclick: () => { searchPage++; renderSearch() } }, '下一组'))
      searchResults.append(pager)
      searchStatus.textContent = `${matches.length} 个匹配节点；方向键浏览，回车定位。`
    }

    const focusSearchResult = (nodeId) => {
      requestAnimationFrame(() => graphCanvas.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`)?.focus())
    }

    const renderGraph = () => {
      /* R6 的规模规则（§10.0 结论第 3 条）：≥300 节点不再画全图，如实说明已换成矩阵。
         工具栏与面板保留，计数与提示仍可读。 */
      if (matrixReplacesGraph(currentNodes.length)) {
        graphCanvas.classList.remove('is-overview')
        graphCanvas.replaceChildren(h('p', { class: 'rdr-frame-note', role: 'status' },
          `这个主题有 ${currentNodes.length} 个节点（≥300）：图谱已自动降级为矩阵视图——力导向在千级节点上不再是可读结构，矩阵里找块状结构更快。矩阵在上方「邻接矩阵」区。`))
        countStatus.textContent = `已降级为矩阵 · ${currentNodes.length} 个节点`
        lodBadge.textContent = 'LOD 点阵 · ≥300 已降级为矩阵'
        lodBadge.classList.add('is-degraded')
        return
      }
      /* render() 会重建画布，所以每次重画都把全览状态贴回去。 */
      graphCanvas.classList.toggle('is-overview', overviewMode)
      const type = typeFilter.value
      const status = statusFilter.value
      const category = categoryFilter.value
      const frameNodes = state.replaying ? historyNodes : currentNodes
      const declaredFrameEdges = state.replaying ? historyEdges : currentEdges
      /* 声明关系 + 证据挂载一起参与筛选/裁剪，画布上才看得见"谁挂着谁"。 */
      const frameEdges = [...declaredFrameEdges, ...evidenceAttachmentEdges(frameNodes, declaredFrameEdges)]
      const matching = filterReaderNodes(frameNodes, type, status, category)
      const selected = state.selectedNodeId && frameNodes.some((node) => node.id === state.selectedNodeId)
        ? frameNodes.find((node) => node.id === state.selectedNodeId) : null
      if (selected && !matching.some((node) => node.id === selected.id) && nodeSearch.value.trim()
        && state.searchLocatedNodeId === selected.id) matching.push(selected)
      const focus = selected && matching.some((node) => node.id === selected.id) ? selected : null
      /* R7：局部模式下把画布收窄到选中原子的 1–2 跳邻域；未选中且非全图时给引导，不画全图。 */
      const neighborhood = graphScope === 'local' && focus
        ? graphNeighborhood({ nodes: frameNodes, edges: frameEdges, focusId: focus.id, hops: 2 }) : null
      const scopedMatching = neighborhood ? matching.filter((node) => neighborhood.nodeIds.includes(node.id)) : matching
      if (graphScope === 'local' && !focus) {
        graphCanvas.replaceChildren(h('div', { class: 'rdr-graph-guide' },
          h('p', {}, '图是局部工具：选一个原子，只看它的 1–2 跳邻域。要"找路径 / 看全局"时再用下面的路径查询或「全图」。'),
          h('button', { type: 'button', class: 'btn btn-sm rdr-graph-full-link', onclick: () => setGraphScope('full') }, '仍要看全图')))
        countStatus.textContent = `未选择原子 · 当前主题共 ${currentNodes.length} 个节点`
        return
      }
      const matchIds = new Set(scopedMatching.map((node) => node.id))
      const candidateEdges = frameEdges.filter((edge) => matchIds.has(edge.from) && matchIds.has(edge.to))
      const frame = selectGraphWindow({ nodes: scopedMatching, allNodes: scopedMatching, edges: candidateEdges }, {
        focusNodeId: focus?.id || null, maxNodes: GRAPH_FRAME_NODE_LIMIT, maxEdges: GRAPH_FRAME_EDGE_LIMIT,
      })
      graphCanvas.replaceChildren()
      const shown = frame.nodes.length
      countStatus.textContent = neighborhood
        ? `局部邻域 ${shown} / ${matching.length} 个节点（当前主题共 ${currentNodes.length} 个）`
        : `画布 ${shown} / ${scopedMatching.length} 个节点（当前主题共 ${currentNodes.length} 个）`
      if (scopedMatching.length > shown) graphCanvas.append(h('p', { class: 'rdr-frame-note', role: 'status' },
        `画布逐步展开，当前呈现 ${shown} 个局部节点；另有 ${scopedMatching.length - shown} 个匹配节点。可在上方全量搜索或缩小筛选，不会从主题中删除记录。`))
      if (!scopedMatching.length) graphCanvas.append(h('p', { class: 'rdr-frame-note', role: 'status' }, '没有节点符合筛选。调整类型或状态以查看完整网络。'))
      const drawProjection = {
        ...state.projection, nodes: frame.nodes, allNodes: historyNodes, edges: frame.edges,
        allEdges: [...historyEdges, ...evidenceAttachmentEdges(historyNodes, historyEdges)],
      }
      /* 每个原子的读者状态（已佐证/受挑战/有争议/有证据未表态/未评估）：颜色由它决定；
         信号计数只在被选中的那个原子上画到画布上（渐进披露，不让 21 张卡片都摊开数字）。 */
      const readerStates = new Map()
      const readerCounts = new Map()
      for (const node of frame.nodes) {
        const summary = evidenceForNode(state, node.id)
        readerStates.set(node.id, readerStateKey(node, summary))
        readerCounts.set(node.id, {
          supports: (summary?.supports?.length || 0) + (summary?.both?.length || 0),
          challenges: (summary?.against?.length || 0) + (summary?.both?.length || 0),
          unclassified: summary?.unclassified?.length || 0,
        })
      }
      const currentFrameNodes = filterReaderNodes(currentNodes, type, status, category)
      const currentFrameIds = new Set(currentFrameNodes.map((node) => node.id))
      const currentFrameEdges = currentEdges.filter((edge) => currentFrameIds.has(edge.from) && currentFrameIds.has(edge.to))
      /* LOD 级别按"实际渲染比例"算：显示全图时取 fit 比例，否则取 缩放 × 容器宽 / 布局宽。
         这样窗口变窄、点了显示全图、拖了缩放，画多少文字都跟着走（提案 02）。 */
      const activeLayout = ensureLayout()
      const canvasWidth = graphCanvas.clientWidth || 0
      const canvasHeight = graphCanvas.clientHeight || 0
      const effectiveScale = canvasWidth > 0
        ? (overviewMode
          ? Math.min(canvasWidth / activeLayout.width, (canvasHeight || activeLayout.height) / activeLayout.height)
          : (canvasWidth * zoom) / activeLayout.width)
        : zoom
      const lodLevel = (lodAuto && !activeLayout.heavy) ? graphLodLevel(effectiveScale) : 'cards-labels'
      const drawnLevel = activeLayout.heavy ? 'dots' : lodLevel
      lodBadge.textContent = activeLayout.heavy
        ? `LOD ${GRAPH_LOD_LABEL[drawnLevel]} · ≥600 已降级为网格布局`
        : `LOD ${GRAPH_LOD_LABEL[drawnLevel]}`
      lodBadge.classList.toggle('is-degraded', Boolean(activeLayout.heavy))
      if (frame.nodes.length) drawThemeNetwork(drawProjection, {
        networkLayout: activeLayout,
        focusNodeId: state.selectedNodeId,
        readerStates,
        readerCounts,
        /* 证据压成紧凑数据点，让观点原子成为视觉主体（建设者画布不受影响）。 */
        compactEvidence: true,
        lodLevel,
        /* 读者画布用分类色条 + 状态描边表达含义；状态文字徽标只在"卡片+标题"档出现
           （文字是最贵的东西，低 LOD 一律不出字）。 */
        statusPill: lodLevel === 'cards-labels',
        atomCategories: themeCategories,
        searchMatchIds: nodeSearch.value.trim() ? state.searchMatches.map((node) => node.id) : [],
        historyContext: { events: state.events, projection: state.projection, selectedSeq: state.selectedSeq },
        compareCurrent: Boolean(state.compareCurrent && state.replaying),
        currentNodes: currentFrameNodes,
        currentEdges: currentFrameEdges,
        maxComparisonNodes: 8,
        onFocusNode: (node) => {
          state.selectedNodeId = node?.id || null
          focusLabel.textContent = node ? `已选择：${titleOf(node)} · 来源与关系显示在右侧` : '选择任一节点查看其论证、关联与来源'
          renderInspector()
          renderAxis()
          renderGraph()
        },
      }, graphCanvas)
      /* 缩放＝把 SVG 按比例放大/缩小（布局与 viewBox 不变，容器负责滚动）；
         显示全图时交给 CSS 的 fit 规则，不写内联宽度。 */
      const drawnSvg = graphCanvas.querySelector('.cog-network-svg')
      if (drawnSvg) drawnSvg.style.width = overviewMode ? '' : `${Math.round(zoom * 100)}%`
      if (state.searchLocatedNodeId && nodeSearch.value.trim()) {
        const currentLayout = ensureLayout()
        const point = currentLayout.pos.get(state.searchLocatedNodeId)
        const shownIndex = frame.nodes.findIndex((node) => node.id === state.searchLocatedNodeId)
        const located = currentNodes.find((node) => node.id === state.searchLocatedNodeId)
        if (point && shownIndex >= 0 && located) {
          const horizontal = point.x < currentLayout.width / 3 ? '左侧' : point.x > currentLayout.width * 2 / 3 ? '右侧' : '中部'
          const vertical = point.y < currentLayout.height / 3 ? '上方' : point.y > currentLayout.height * 2 / 3 ? '下方' : '中部'
          searchStatus.textContent = `已定位并高亮「${titleOf(located)}」：画布${vertical}${horizontal} · 当前窗口 ${shownIndex + 1}/${frame.nodes.length}。`
        }
      }
      focusLabel.textContent = focus ? `已选择：${titleOf(focus)} · 来源与关系显示在右侧`
        : selected ? `已选择：${titleOf(selected)} · 当前筛选未显示该节点，右侧仍保留其来源与关系`
          : '选择任一节点查看其论证、关联与来源'
    }

    const timelinePointAt = (position) => {
      if (!timeline.length) return null
      let chosen = timeline[0]
      for (const point of timeline) { if (point.position > position) break; chosen = point }
      return chosen
    }
    const updateHistoryStatus = () => {
      const point = timeline.find((item) => item.seq === state.selectedSeq) || timeline.filter((item) => item.seq <= state.selectedSeq).at(-1)
      if (!state.replaying || !point) {
        historyCaption.textContent = ''
        timeStatus.textContent = integrity.ok === false
          ? `当前模型 · 仅展示链完整前缀的 ${verifiedEvents.length} 条记录；损坏尾部已隔离。`
          : `当前模型 · ${verifiedEvents.length} 条已校验事件。`
      } else {
        const index = timeline.findIndex((item) => item.seq === point.seq)
        const priorSeq = index > 0 ? timeline[index - 1].seq : 0
        const summary = timelineChangeSummary(verifiedEvents, priorSeq, point.seq)
        const compare = state.compareCurrent ? ` · 与当前比较：${timelineChangeSummary(verifiedEvents, point.seq, verifiedEvents.at(-1)?.seq || 0)}` : ''
        historyCaption.textContent = `${point.date} · 第 ${state.selectedSeq} 条 · ${point.count} 条事件`
        const missingTime = point.date === '日期未记录' ? ' · 日期元数据缺失，仅按已校验序号回放' : ''
        timeStatus.textContent = `${summary}${compare}${missingTime} · 只读回放`
      }
      liveButton.hidden = !state.replaying
      compareButton.hidden = !state.replaying
      compareButton.setAttribute('aria-pressed', String(state.compareCurrent))
      compareButton.textContent = state.compareCurrent ? '隐藏当前对比' : '与当前对比'
    }

    const commitReplay = async (point) => {
      if (!point || typeof opts.loadProjectionAt !== 'function') return
      const request = ++replayRequest
      state.loadingReplay = true
      const selectedBeforeReplay = state.selectedNodeId
      timeStatus.textContent = `正在读取 ${point.date} 的只读投影…`
      try {
        const historical = await opts.loadProjectionAt(point.seq)
        if (request !== replayRequest || generation !== refreshGeneration) return
        state.projection = historical || {}
        state.events = verifiedEvents.filter((event) => event.seq <= point.seq)
        state.selectedSeq = point.seq
        state.replaying = true
        if (state.liveSelectedNodeId == null) state.liveSelectedNodeId = selectedBeforeReplay
        refreshHistoryIndexes()
        const selectedNode = state.selectedNodeId
        if (selectedNode && !allNodesOf(state.projection).some((node) => node.id === selectedNode)) state.selectedNodeId = null
        renderInspector()
        renderGraph()
        timeSlider.value = String(point.position)
        updateHistoryStatus()
      } catch (error) {
        if (request === replayRequest) timeStatus.textContent = `历史回放失败：${error?.message || error}`
      } finally { if (request === replayRequest) state.loadingReplay = false }
    }
    const stopPlayback = () => {
      replayPlaying = false
      playbackGeneration++
      clearTimeout(playbackTimer)
      playbackTimer = null
      playButton.textContent = '播放'
      playButton.setAttribute('aria-pressed', 'false')
    }
    const runPlayback = async (generation) => {
      if (!replayPlaying || generation !== playbackGeneration) return
      playbackIndex++
      if (playbackIndex >= timeline.length) { stopPlayback(); return }
      const point = timeline[playbackIndex]
      timeSlider.value = String(point.position)
      await commitReplay(point)
      if (!replayPlaying || generation !== playbackGeneration) return
      if (playbackIndex >= timeline.length - 1) { stopPlayback(); return }
      playbackTimer = setTimeout(() => runPlayback(generation), 900)
    }
    playButton.addEventListener('click', () => {
      if (replayPlaying) { stopPlayback(); return }
      if (timeline.length < 2 || typeof opts.loadProjectionAt !== 'function') return
      const currentIndex = timeline.findIndex((point) => point.seq === state.selectedSeq)
      playbackIndex = currentIndex >= 0 && currentIndex < timeline.length - 1 ? currentIndex : -1
      replayPlaying = true
      playbackGeneration++
      const generation = playbackGeneration
      playButton.textContent = '暂停'
      playButton.setAttribute('aria-pressed', 'true')
      runPlayback(generation)
    })
    const returnLive = () => {
      stopPlayback()
      replayRequest++
      state.projection = currentProjection
      state.events = verifiedEvents
      state.selectedSeq = null
      state.replaying = false
      state.compareCurrent = false
      refreshHistoryIndexes()
      state.selectedNodeId = state.liveSelectedNodeId || state.selectedNodeId
      state.liveSelectedNodeId = null
      renderInspector()
      renderGraph()
      updateHistoryStatus()
      timeSlider.value = String(Math.max(0, timeline.length - 1))
    }
    timeSlider.addEventListener('input', () => {
      stopPlayback()
      const point = timelinePointAt(Number(timeSlider.value))
      if (!point) return
      historyCaption.textContent = `${point.date} · 第 ${point.seq} 条`
      clearTimeout(replayTimer)
      replayTimer = setTimeout(() => commitReplay(point), 120)
    })
    timeSlider.addEventListener('change', () => {
      stopPlayback()
      const point = timelinePointAt(Number(timeSlider.value))
      clearTimeout(replayTimer)
      commitReplay(point)
    })
    liveButton.addEventListener('click', returnLive)
    compareButton.addEventListener('click', () => {
      state.compareCurrent = !state.compareCurrent
      renderGraph()
      updateHistoryStatus()
    })
    nodeSearch.addEventListener('input', () => {
      state.searchLocatedNodeId = null
      renderSearch()
      renderGraph()
    })
    nodeSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const node = state.searchMatches[0]
        if (node) {
          const present = historyNodes.some((candidate) => candidate.id === node.id)
          if (present) { state.selectedNodeId = node.id; state.searchLocatedNodeId = node.id; renderInspector(); renderGraph(); focusSearchResult(node.id) }
          else searchStatus.textContent = '该节点在此历史时点尚未建立；退出回放后可定位当前节点。'
        }
      } else if (event.key === 'ArrowDown') {
        event.preventDefault(); searchResults.querySelector('.rdr-search-result')?.focus()
      } else if (event.key === 'Escape') {
        event.preventDefault(); nodeSearch.value = ''; renderSearch(); nodeSearch.focus()
      }
    })
    const onFilterChange = () => {
      state.searchLocatedNodeId = null
      if (nodeSearch.value.trim()) searchStatus.textContent = '筛选已更改；搜索仍覆盖完整主题，选择可见结果即可定位。'
      renderGraph()
    }
    typeFilter.addEventListener('change', onFilterChange)
    statusFilter.addEventListener('change', onFilterChange)
    categoryFilter.addEventListener('change', onFilterChange)

    const toolbar = h('div', { class: 'rdr-reader-head' },
      h('div', { class: 'rdr-reader-title-row' },
        h('div', {}, h('p', { class: 'rdr-kicker' }, '主题模型 · 读者视图'), h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题')),
        h('span', { class: 'rdr-scope-badge' }, `${currentNodes.length} 个节点`),
        h('button', { type: 'button', class: 'btn btn-sm rdr-builder-link', onclick: () => opts.onOpenBuilder?.('network') }, '建设者视图')),
      h('div', { class: 'rdr-synthesis' },
        h('span', { class: 'rdr-synthesis-mark', 'aria-hidden': 'true' }, '◎'),
        h('div', {}, h('strong', {}, '如何阅读这张图'),
          h('p', {}, '主题只界定范围，不是中心节点。节点、论证关系与弱关联共同构成当前模型；支持关系数量不等于主题整体向好。选择节点，可回到证据、适用时间、来源摄入记录和未决项。')),
        integrity.ok === false ? h('span', { class: 'rdr-integrity-badge is-error', role: 'alert' }, `校验异常 · 有效前缀 ${integrity.lastValidSeq || 0}`)
          : h('span', { class: 'rdr-integrity-badge is-ok', role: 'status' }, `链完整 · ${verifiedEvents.length} 条记录`)))

    /* 全览：默认关（保持卡片原始可读尺寸），开了就把整张图缩进面板一屏——
       不需要滚动也能看全 21 个节点，代价是字变小。开关状态跟随这次挂载，不写任何数据。 */
    const overviewButton = h('button', {
      type: 'button', class: 'btn btn-sm rdr-overview-toggle', 'aria-pressed': String(overviewMode),
      onclick: () => {
        overviewMode = !overviewMode
        overviewButton.setAttribute('aria-pressed', String(overviewMode))
        overviewButton.textContent = overviewMode ? '显示全图 · 开' : '显示全图'
        graphCanvas.classList.toggle('is-overview', overviewMode)
        renderGraph()
      },
    }, overviewMode ? '显示全图 · 开' : '显示全图')
    /* 缩放与 LOD（设计提案 02）：缩放决定画多少文字；LOD 自动＝按缩放分级，手动＝始终出标题。 */
    const zoomBadge = h('span', { class: 'rdr-zoom-badge' }, `${zoom.toFixed(2)}×`)
    const zoomSlider = h('input', {
      type: 'range', class: 'rdr-zoom-slider', min: '0.4', max: '2', step: '0.05',
      value: String(zoom), 'aria-label': '图谱缩放',
    })
    zoomSlider.addEventListener('input', () => {
      zoom = Number(zoomSlider.value) || 1
      zoomBadge.textContent = `${zoom.toFixed(2)}×`
      renderGraph()
    })
    const lodBadge = h('span', { class: 'rdr-lod-badge', role: 'status' })
    /* R7：局部邻域 / 全图 显式切换；未选中原子时画布给引导而不是全图。 */
    const setGraphScope = (scope) => {
      graphScope = scope === 'full' ? 'full' : 'local'
      graphScopeLocal.setAttribute('aria-pressed', String(graphScope === 'local'))
      graphScopeFull.setAttribute('aria-pressed', String(graphScope === 'full'))
      renderGraph()
    }
    const graphScopeLocal = h('button', {
      type: 'button', class: 'btn btn-sm rdr-graph-scope is-local', 'aria-pressed': String(graphScope === 'local'),
      onclick: () => setGraphScope('local'),
    }, '局部邻域')
    const graphScopeFull = h('button', {
      type: 'button', class: 'btn btn-sm rdr-graph-scope is-full', 'aria-pressed': String(graphScope === 'full'),
      onclick: () => setGraphScope('full'),
    }, '全图')
    const lodAutoButton = h('button', {
      type: 'button', class: 'btn btn-sm rdr-lod-auto', 'aria-pressed': String(lodAuto),
      onclick: () => {
        lodAuto = !lodAuto
        lodAutoButton.setAttribute('aria-pressed', String(lodAuto))
        lodAutoButton.textContent = lodAuto ? 'LOD 自动' : 'LOD 手动'
        renderGraph()
      },
    }, lodAuto ? 'LOD 自动' : 'LOD 手动')

    /* 合成轴（设计提案 01）：强度线 × 外部数据点 × 确认/修订台阶，同一条日期轴。
       它取代原来的序号滑条成为主控制；序号回放降级进 <details>（保留能力，不再抢焦点）。 */
    const axisCaption = h('p', { class: 'rdr-axis-caption', role: 'status', 'aria-live': 'polite' })
    const axisHost = h('div', { class: 'rdr-axis-host' })
    const renderAxis = () => {
      const selected = state.selectedNodeId && currentNodes.some((node) => node.id === state.selectedNodeId)
        ? currentNodes.find((node) => node.id === state.selectedNodeId) : null
      const model = buildSynthesisAxis({ events: state.events, node: selected })
      axisHost.replaceChildren(renderSynthesisAxis(model, {
        nodeTitle: selected ? titleOf(selected) : '',
        onHover: (text) => { axisCaption.textContent = text },
      }))
      const span = model.start != null && model.end != null
        ? `${new Date(model.start).toISOString().slice(0, 10)} → ${new Date(model.end).toISOString().slice(0, 10)}`
        : '尚无事件'
      const parts = [
        `${model.counts.evidence} 条外部数据（支持 ${model.counts.supports} · 挑战 ${model.counts.contradicts} · 未表态 ${model.counts.unstated}）`,
        `${model.counts.steps} 次确认/修订`,
        span,
      ]
      if (selected) {
        const last = model.series[model.series.length - 1]
        parts.push(`${titleOf(selected)}：${last ? `强度 ${last.value}%` : '还没有强度记录'}`)
      }
      axisCaption.textContent = parts.join(' · ')
    }
    /* 读者页是一屏到底的长文档：给一条吸顶的分段导航，既是全局感也是一跳直达。
       锚点用区块容器的 id；点击后高亮当前项（不整页重绘）。 */
    const sectionNavHost = h('nav', { class: 'rdr-section-nav', 'aria-label': '读者页导航' })
    const renderSectionNav = () => {
      const items = [
        ['reader-axis', '合成轴'],
        ['reader-outline', '论证大纲'],
        ['reader-debate', '双边清单'],
        ['reader-multiples', '原子一览'],
        ['reader-categories', '分类'],
        ['reader-matrix', '矩阵'],
        ['reader-chronicle', '编年史'],
        ['reader-gaps', '缺口'],
        ['reader-map', '图谱'],
      ].filter(([id]) => document.getElementById(id) || hostsReady.has(id))
      sectionNavHost.replaceChildren(...items.map(([id, label]) => h('button', {
        type: 'button',
        class: `rdr-section-nav-item${activeSection === id ? ' is-active' : ''}`,
        onclick: () => {
          activeSection = id
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          renderSectionNav()
        },
      }, label)))
    }
    const hostsReady = new Set(['reader-outline', 'reader-debate', 'reader-multiples', 'reader-categories', 'reader-matrix', 'reader-chronicle', 'reader-gaps'])

    const axisBox = h('section', { id: 'reader-axis', class: 'rdr-axis-card', 'aria-label': '合成轴：强度、时间与外部数据' },
      h('div', { class: 'rdr-axis-head' },
        h('strong', { class: 'rdr-axis-title' }, '强度 · 时间 · 外部数据（合成轴）'),
        axisCaption),
      axisHost)
    /* 序号回放降级为内部细节：能力保留，主控制让给合成轴。 */
    const replayDetails = h('details', { class: 'rdr-replay-details' },
      h('summary', {}, '按事件序号回放 · 内部细节'), replayBox)

    /* R1 论证大纲 + R2 小倍数网格（§10.2 首屏配方第 2/3 屏）：
       图没有唯一阅读顺序、也比不了量；要"读完 / 比较"就用有序结构，图退到点开某个原子之后。 */
    const outlineHost = h('div', { id: 'reader-outline', class: 'rdr-outline-host' })
    const multiplesHost = h('div', { id: 'reader-multiples', class: 'rdr-multiples-host' })
    /* R5 缺口清单 + P1-5 回流：待办只写收件箱，不动账本；撤销＝把刚建的待办移出收件箱。 */
    const gapsHost = h('div', { id: 'reader-gaps', class: 'rdr-gaps-host' })
    /* R3 双边清单 / R4 编年史：同样是"图以外的有序结构"，读得完、跟得上时间。 */
    const debateHost = h('div', { id: 'reader-debate', class: 'rdr-debate-host' })
    const chronicleHost = h('div', { id: 'reader-chronicle', class: 'rdr-chronicle-host' })
    /* R6 邻接矩阵：行＝原子、列＝外部数据（可切原子×原子）；≥300 节点时图自动换成它。 */
    const matrixHost = h('div', { id: 'reader-matrix', class: 'rdr-matrix-host' })
    const categoryHost = h('div', { id: 'reader-categories', class: 'rdr-category-host' })
    let matrixMode = 'atom-evidence'
    const todoKeys = new Set()
    let inboxCache = null
    const loadInboxItems = async () => {
      if (inboxCache) return inboxCache
      try { inboxCache = (await opts.loadInbox?.()) || [] } catch { inboxCache = [] }
      return inboxCache
    }
    const createTodo = async (text, key, color) => {
      const mm = globalThis.window?.meridian || {}
      const id = `gap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      if (typeof mm.inboxUpsertItem !== 'function') { toast('当前环境不支持写入收件箱', 'var(--red)'); return }
      const res = await mm.inboxUpsertItem({
        id, text, title: text.slice(0, 40), kind: 'todo', extracted: false,
        provenance: { platform: 'reader-gap', sourceLabel: '读者标记的缺口' },
        createdAt: new Date().toISOString(),
      })
      if (res?.ok === false) { toast(`加入收件箱失败：${res.error || '未知错误'}`, 'var(--red)'); return }
      if (key) todoKeys.add(key)
      inboxCache = null
      renderStructure()
      toast(`已加入今日收件箱 · 待办：${text}`, color || 'var(--text-2)', {
        label: '撤销',
        onClick: async () => {
          try { await mm.inboxResolve?.(id, 'reject') } catch { /* 撤销失败不阻塞阅读 */ }
          if (key) todoKeys.delete(key)
          inboxCache = null
          renderStructure()
        },
      })
    }
    const renderGaps = () => {
      const gaps = buildGapList({
        nodes: currentNodes,
        edges: allEdgesOf(currentProjection),
        inboxItems: inboxCache || [],
      })
      gapsHost.replaceChildren(renderGapList(gaps, {
        todoKeys,
        selectedId: state.selectedNodeId,
        onCreateTodo: (gap) => createTodo(gap.todo, gap.key),
        onFocusAtom: focusAtom,
        onOpenBuilder: (gap) => opts.onOpenBuilder?.(gap.nodeId ? 'network' : 'network', gap.nodeId || undefined),
        onMarkGap: (selectedAtomId) => {
          const node = selectedAtomId ? currentNodes.find((item) => item.id === selectedAtomId) : null
          createTodo(node ? `为「${titleOf(node)}」补一条外部数据` : '复核这个主题里说不通的关系', null)
        },
      }))
    }
    const focusAtom = (id) => {
      const next = id && currentNodes.some((node) => node.id === id) ? id : null
      state.selectedNodeId = next
      if (next) outlineExpanded.add(next)
      focusLabel.textContent = next
        ? `已选择：${titleOf(currentNodes.find((node) => node.id === next) || {})} · 来源与关系显示在右侧`
        : '选择任一节点查看其论证、关联与来源'
      renderInspector()
      renderAxis()
      renderGraph()
      renderStructure()
    }
    /* R7 路径查询：两原子之间隔着什么。真正的图问题，保留下来。 */
    const PATH_REL_LABEL = { supports: '支持', contradicts: '挑战', derives: '推导', supersedes: '修订', related: '相关', 'evidence-attached': '挂载' }
    const renderPathOptions = () => {
      const atoms = currentNodes.filter((node) => networkNodeType(node) !== 'evidence')
      for (const select of [pathFrom, pathTo]) {
        const previous = select.value
        select.replaceChildren(...atoms.map((node) => h('option', { value: node.id }, titleOf(node))))
        if (atoms.some((node) => node.id === previous)) select.value = previous
      }
      if (atoms.length > 1 && (!pathTo.value || pathFrom.value === pathTo.value)) pathTo.value = atoms[1].id
      pathFind.disabled = atoms.length < 2
    }
    pathFind.addEventListener('click', () => {
      const result = shortestNodePath({ edges: allEdgesOf(currentProjection), from: pathFrom.value, to: pathTo.value })
      if (!result.found) {
        pathStatus.textContent = `没找到路径：${result.reason}。`
        return
      }
      const chain = result.nodeIds.map((id, index) => {
        const name = titleOf(currentNodes.find((node) => node.id === id) || {})
        if (index === 0) return name
        const rel = result.edges[index - 1]?.rel
        return `—${PATH_REL_LABEL[rel] || rel || '关联'}→ ${name}`
      })
      pathStatus.textContent = `路径（${result.edges.length} 跳）：${chain.join(' ')}`
      /* 路径超过 2 跳就把图切到全图，否则局部邻域里看不到整条路。 */
      if (result.edges.length > 2) setGraphScope('full')
      else {
        state.selectedNodeId = result.nodeIds[0]
        renderInspector()
        renderGraph()
      }
    })

    const renderStructure = () => {
      renderPathOptions()
      const rows = buildArgumentOutline(currentNodes, (id) => evidenceForNode(state, id))
      const nodeById = new Map(currentNodes.map((node) => [node.id, node]))
      outlineHost.replaceChildren(renderArgumentOutline(rows, {
        expandedIds: outlineExpanded,
        onToggle: (id, open) => { open ? outlineExpanded.add(id) : outlineExpanded.delete(id) },
        onFocusAtom: focusAtom,
      }))
      debateHost.replaceChildren(renderDebateBoard(buildDebateBoard(currentNodes, (id) => evidenceForNode(state, id)), {
        onFocusEvidence: focusAtom,
        onFocusAtom: focusAtom,
      }))
      categoryHost.replaceChildren(renderCategoryBars(
        buildCategoryAggregation({ nodes: currentNodes, categories: themeCategories }),
        { selectedId: state.selectedNodeId },
      ))
      matrixHost.replaceChildren(renderAdjacencyMatrix(
        buildAdjacencyMatrix({ nodes: currentNodes, edges: allEdgesOf(currentProjection), mode: matrixMode }),
        {
          mode: matrixMode,
          degraded: matrixReplacesGraph(currentNodes.length),
          selectedId: state.selectedNodeId,
          onFocus: focusAtom,
          onModeChange: (next) => { matrixMode = next; renderStructure() },
        },
      ))
      chronicleHost.replaceChildren(renderChronicle(buildChronicle({ events: state.events, nodes: allNodesOf(state.projection) }), {
        onFocusEvidence: focusAtom,
        onOpenSource: (url) => globalThis.window?.meridian?.openExternal?.(url),
      }))
      renderGaps()
      multiplesHost.replaceChildren(renderSmallMultiples(rows, {
        selectedId: state.selectedNodeId,
        colorFor: (category) => categoryColor(themeCategories, category),
        sparkFor: (id) => strengthSparkline(nodeById.get(id)),
        onFocusAtom: focusAtom,
      }))
    }

    const controls = h('section', { id: 'reader-map', class: 'rdr-map-panel', 'aria-label': '主题模型网络' },
      h('div', { class: 'rdr-map-toolbar' },
        h('div', {}, h('strong', { class: 'rdr-map-heading' }, '原子节点图谱'),
          h('p', { class: 'rdr-map-sub' }, '节点大小反映强度 · 颜色反映状态 · 实线箭头为论证 · 虚线箭头为版本修订 · 点线为弱关联 · 灰色细点线为证据挂载')),
        countStatus),
      h('div', { class: 'rdr-search-tools' }, nodeSearch, typeFilter, statusFilter, categoryFilter),
      h('div', { class: 'rdr-path-row' }, h('span', { class: 'rdr-path-label' }, '路径查询'), pathFrom, h('span', {}, '→'), pathTo, pathFind),
      pathStatus,
      searchResults, searchStatus,
      h('div', { class: 'rdr-focus-bar' }, focusLabel),
      graphCanvas,
      h('div', { class: 'rdr-graph-foot' },
        h('span', { class: 'rdr-graph-scope-group', role: 'group', 'aria-label': '图谱范围' }, graphScopeLocal, graphScopeFull),
        lodAutoButton, zoomSlider, zoomBadge, overviewButton, lodBadge),
      h('details', { class: 'rdr-legend' }, h('summary', {}, '关系与节点图例'),
        h('p', {}, '实线箭头：支持、推导、反驳；虚线箭头：版本修订；点线：归属、影响、依赖、时间关联、相关；灰色细点线：证据挂载——外部数据已挂到这个原子上，但你还没有声明它是支持还是反驳。待复核与驳回关系会保留其决定状态。'),
        h('p', {}, '主题下的节点均为原子节点（主题拆分的第一性原理单元）。网络位置为稳定布局，不代表重要度或因果强度。'),
        h('p', {}, h('strong', {}, '视觉编码：'), '节点卡片大小反映强度（越大越强）；边框与状态徽标颜色反映状态——',
          h('span', { style: `color:${READER_STATE_META.supported.color}` }, '已佐证'),
          ' / ',
          h('span', { style: `color:${READER_STATE_META.challenged.color}` }, '受挑战'),
          ' / ',
          h('span', { style: `color:${READER_STATE_META.contested.color}` }, '有争议'),
          ' / ',
          h('span', { style: `color:${READER_STATE_META.evidenced.color}` }, '有证据·未表态'),
          ' / ',
          h('span', { style: `color:${READER_STATE_META.unevaluated.color}` }, '未评估'),
          '。点击空白处可清空选择，回到整张图谱。')),
      replayDetails)
    const workspace = h('div', { class: 'rdr-workspace' }, controls, inspector)
    // 综合理解横幅：最强共识与最大分歧（对齐设计稿）
    let synthesisBanner = null
    try {
      /* 必须传真实的证据口径：不传时 synthesisSummary 会退化成"把 evidenceCount 对半分"
         的估算，于是横幅说"支持 2 · 挑战 2"，而图谱上同一个原子标的是"有证据·未表态"。 */
      const summary = synthesisSummary(currentNodes, (_view, nodeId) => evidenceForNode(state, nodeId))
      const hasStrength = currentNodes.some((node) => Number.isFinite(Number(node.confidence ?? node.strength)))
      if (summary) {
        const parts = []
        if (hasStrength) {
          parts.push(`当前 ${summary.nodeCount} 个原子节点中，`)
          if (summary.strongest) {
            parts.push(`最强共识是「${summary.strongest.title}」(强度 ${summary.strongest.strength}%)；`)
          }
          if (summary.mostDisputed) {
            parts.push(`最大分歧是「${summary.mostDisputed.title}」(支持 ${summary.mostDisputed.support} · 挑战 ${summary.mostDisputed.challenge})。`)
          }
          parts.push('拖动底部时间条可以看强度如何随外部数据累积变化。')
        } else {
          /* 没有强度数据时不要硬报"最强共识 0%"：那只是把 Default 当结论。 */
          parts.push(`当前 ${summary.nodeCount} 个原子节点都还没有强度：外部数据已经挂上来，但还没有一条被表态为支持或反驳。`)
          parts.push('点开图上一个原子看它的来源，或到建设者视图确认归因——强度会在确认之后开始累积。')
        }
        synthesisBanner = h('div', { class: 'rdr-synthesis-banner', role: 'status' },
          h('span', { class: 'rdr-synthesis-banner-mark', 'aria-hidden': 'true' }, '✳'),
          h('div', {},
            h('strong', {}, '当前综合理解 · 从原子节点自动投影'),
            h('p', {}, parts.join('')),
            h('div', { class: 'rdr-synthesis-pills' },
              h('span', { class: 'rdr-pill' }, `时间窗口 ${new Date().getFullYear()}`),
              h('span', { class: 'rdr-pill' }, `${summary.nodeCount} 原子节点`),
              h('span', { class: 'rdr-pill' }, `${verifiedEvents.length} 条外部数据`))))
      }
    } catch { /* 横幅计算失败不阻塞主视图 */ }
    article.replaceChildren(toolbar, ...(synthesisBanner ? [synthesisBanner] : []), sectionNavHost, axisBox, outlineHost, debateHost, multiplesHost, categoryHost, matrixHost, chronicleHost, gapsHost, workspace)
    renderSearch()
    renderInspector()
    renderGraph()
    renderAxis()
    renderStructure()
    renderSectionNav()
    loadInboxItems().then(() => renderGaps())
    updateHistoryStatus()
  }

  const loadProjection = typeof opts.loadProjection === 'function' ? opts.loadProjection() : Promise.resolve({})
  const loadEvents = typeof opts.loadEvents === 'function' ? opts.loadEvents() : Promise.resolve([])
  Promise.all([loadProjection, loadEvents])
    .then(async ([projection, response]) => {
      const events = Array.isArray(response) ? response : response?.events || []
      const integrity = projection?.integrity || {}
      const validEvents = verifiedLedgerPrefix(events, integrity)
      const requestedSeq = Number.isSafeInteger(opts.initialSequence)
        && validEvents.some((event) => event.seq === opts.initialSequence) ? opts.initialSequence : null
      if (Number.isSafeInteger(opts.initialSequence) && requestedSeq == null) {
        throw new Error(`第 ${opts.initialSequence} 条事件不在已校验的有效前缀中。`)
      }
      let historicalProjection = null
      if (requestedSeq != null) {
        if (typeof opts.loadProjectionAt !== 'function') throw new Error('当前环境不支持按账本序号读取历史投影。')
        historicalProjection = await opts.loadProjectionAt(requestedSeq)
        if (!historicalProjection || historicalProjection.integrity?.ok === false) throw new Error('历史投影校验失败，不能显示该时间点。')
      }
      render(projection || {}, events, requestedSeq, historicalProjection)
      if (opts.autoPlay && requestedSeq != null) setTimeout(() => article.querySelector('.rdr-play-button')?.click(), 0)
    })
    .catch((error) => article.replaceChildren(h('p', { class: 'rdr-note', role: 'alert' }, `读者视图加载失败：${error?.message || error}`)))
  return root
}
