import { h } from '../lib/dom.js'
import {
  NETWORK_NODE_TYPES, NODE_TYPE_META, NODE_STATUS_LABEL, REVISION_RELATIONS, networkNodeType, networkNodeStatus,
  buildEventTimeline, layoutThemeNetwork, timelineChangeSummary, truncateGraphemes,
} from '../lib/theme-network.js'
import { drawThemeNetwork } from '../lib/theme-network-render.js'
import { evidenceForNode } from '../lib/chain-workbench-model.js'
import { filterReaderNodes, synthesisSummary } from '../lib/reader-model.js'
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
  }, '打开来源') : null
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
    const layout = layoutThemeNetwork(currentNodes, currentEdges, 1120)
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
    const graphCanvas = h('div', { class: 'rdr-graph-canvas', 'aria-label': '主题认知网络画布' })
    const inspector = h('aside', { class: 'rdr-inspector', 'aria-label': '节点、证据与来源检视', 'aria-live': 'polite' })
    const focusLabel = h('span', { class: 'rdr-focus-label', role: 'status', 'aria-live': 'polite' }, '选择任一节点查看其论证、关联与来源')
    const nodeSearch = h('input', { class: 'txt rdr-search', type: 'search', placeholder: '搜索所有节点、说明或旧名', 'aria-label': '搜索完整主题中的所有节点' })
    const searchResults = h('div', { class: 'rdr-search-results', role: 'listbox', 'aria-label': '全量节点搜索结果', hidden: true })
    const searchStatus = h('p', { class: 'rdr-search-status', role: 'status', 'aria-live': 'polite' })
    const typeFilter = h('select', { class: 'txt rdr-filter', 'aria-label': '按节点类型筛选' },
      h('option', { value: 'all' }, '全部类型'),
      ...NETWORK_NODE_TYPES.map((type) => h('option', { value: type }, TYPE_LABEL[type])))
    const statusFilter = h('select', { class: 'txt rdr-filter', 'aria-label': '按节点状态筛选' },
      h('option', { value: 'all' }, '全部状态'),
      ...STATUS_FILTERS.map((status) => h('option', { value: status }, NODE_STATUS_LABEL[status])))
    const countStatus = h('span', { class: 'rdr-node-count', role: 'status', 'aria-live': 'polite' })
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
              : `事件完整性校验通过 · ${verifiedEvents.length} 条有效事件`),
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
          h('p', { class: 'rdr-inspector-kicker' }, `${TYPE_LABEL[type] || '节点'} · ${NODE_STATUS_LABEL[status] || status}`),
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
        }, h('span', { class: 'rdr-search-type' }, TYPE_LABEL[networkNodeType(node)] || '节点'),
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
      const type = typeFilter.value
      const status = statusFilter.value
      const frameNodes = state.replaying ? historyNodes : currentNodes
      const frameEdges = state.replaying ? historyEdges : currentEdges
      const matching = filterReaderNodes(frameNodes, type, status)
      const selected = state.selectedNodeId && frameNodes.some((node) => node.id === state.selectedNodeId)
        ? frameNodes.find((node) => node.id === state.selectedNodeId) : null
      if (selected && !matching.some((node) => node.id === selected.id) && nodeSearch.value.trim()
        && state.searchLocatedNodeId === selected.id) matching.push(selected)
      const focus = selected && matching.some((node) => node.id === selected.id) ? selected : null
      const matchIds = new Set(matching.map((node) => node.id))
      const candidateEdges = frameEdges.filter((edge) => matchIds.has(edge.from) && matchIds.has(edge.to))
      const frame = selectGraphWindow({ nodes: matching, allNodes: matching, edges: candidateEdges }, {
        focusNodeId: focus?.id || null, maxNodes: GRAPH_FRAME_NODE_LIMIT, maxEdges: GRAPH_FRAME_EDGE_LIMIT,
      })
      graphCanvas.replaceChildren()
      const shown = frame.nodes.length
      countStatus.textContent = `画布 ${shown} / ${matching.length} 个节点（当前主题共 ${currentNodes.length} 个）`
      if (matching.length > shown) graphCanvas.append(h('p', { class: 'rdr-frame-note', role: 'status' },
        `画布逐步展开，当前呈现 ${shown} 个局部节点；另有 ${matching.length - shown} 个匹配节点。可在上方全量搜索或缩小筛选，不会从主题中删除记录。`))
      if (!matching.length) graphCanvas.append(h('p', { class: 'rdr-frame-note', role: 'status' }, '没有节点符合筛选。调整类型或状态以查看完整网络。'))
      const drawProjection = { ...state.projection, nodes: frame.nodes, allNodes: historyNodes, edges: frame.edges, allEdges: historyEdges }
      const currentFrameNodes = filterReaderNodes(currentNodes, type, status)
      const currentFrameIds = new Set(currentFrameNodes.map((node) => node.id))
      const currentFrameEdges = currentEdges.filter((edge) => currentFrameIds.has(edge.from) && currentFrameIds.has(edge.to))
      if (frame.nodes.length) drawThemeNetwork(drawProjection, {
        networkLayout: layout,
        focusNodeId: state.selectedNodeId,
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
          renderGraph()
        },
      }, graphCanvas)
      if (state.searchLocatedNodeId && nodeSearch.value.trim()) {
        const point = layout.pos.get(state.searchLocatedNodeId)
        const shownIndex = frame.nodes.findIndex((node) => node.id === state.searchLocatedNodeId)
        const located = currentNodes.find((node) => node.id === state.searchLocatedNodeId)
        if (point && shownIndex >= 0 && located) {
          const horizontal = point.x < layout.width / 3 ? '左侧' : point.x > layout.width * 2 / 3 ? '右侧' : '中部'
          const vertical = point.y < layout.height / 3 ? '上方' : point.y > layout.height * 2 / 3 ? '下方' : '中部'
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
          ? `当前模型 · 仅展示通过校验的 ${verifiedEvents.length} 条事件；损坏尾部已隔离。`
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
          : h('span', { class: 'rdr-integrity-badge is-ok', role: 'status' }, `已校验 · ${verifiedEvents.length} 条事件`)))

    const controls = h('section', { class: 'rdr-map-panel', 'aria-label': '主题模型网络' },
      h('div', { class: 'rdr-map-toolbar' },
        h('div', {}, h('strong', { class: 'rdr-map-heading' }, '主题认知网络'),
          h('p', { class: 'rdr-map-sub' }, '无预设起点 · 实线箭头为论证 · 虚线箭头为版本修订 · 点线为弱关联')),
        countStatus),
      h('div', { class: 'rdr-search-tools' }, nodeSearch, typeFilter, statusFilter),
      searchResults, searchStatus,
      h('div', { class: 'rdr-focus-bar' }, focusLabel),
      graphCanvas,
      h('details', { class: 'rdr-legend' }, h('summary', {}, '关系与节点图例'),
        h('p', {}, '实线箭头：支持、推导、反驳；虚线箭头：版本修订；点线：归属、影响、依赖、时间关联、相关。待复核与驳回关系会保留其决定状态。'),
        h('p', {}, '节点按概念、对象、事件、观点、证据区分。网络位置为稳定布局，不代表重要度或因果强度。')),
      replayBox)
    const workspace = h('div', { class: 'rdr-workspace' }, controls, inspector)
    // 综合理解横幅：最强共识与最大分歧（对齐设计稿）
    let synthesisBanner = null
    try {
      const summary = synthesisSummary(currentNodes)
      if (summary && (summary.strongest || summary.mostDisputed)) {
        const parts = []
        parts.push(`当前 ${summary.nodeCount} 个原子节点中，`)
        if (summary.strongest) {
          parts.push(`最强共识是「${summary.strongest.title}」(强度 ${summary.strongest.strength}%)；`)
        }
        if (summary.mostDisputed) {
          parts.push(`最大分歧是「${summary.mostDisputed.title}」(支持 ${summary.mostDisputed.support} · 挑战 ${summary.mostDisputed.challenge})。`)
        }
        parts.push('拖动底部时间条可以看强度如何随外部数据累积变化。')
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
    article.replaceChildren(toolbar, ...(synthesisBanner ? [synthesisBanner] : []), workspace)
    renderSearch()
    renderInspector()
    renderGraph()
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
