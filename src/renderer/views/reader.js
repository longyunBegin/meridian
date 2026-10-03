import { h, toast } from '../lib/dom.js'
import {
  NETWORK_NODE_TYPES, NODE_TYPE_META, NODE_STATUS_LABEL, REVISION_RELATIONS, READER_STATE_META, readerStateKey,
  categoryColor,
  networkNodeType, networkNodeStatus,
  truncateGraphemes,
} from '../lib/theme-network.js'
import { evidenceForNode } from '../lib/chain-workbench-model.js'
import {
  filterReaderNodes, nodeCategory, buildSynthesisAxis, buildArgumentOutline, strengthSparkline,
  buildGapList, buildDebateBoard, buildChronicle, buildAdjacencyMatrix, matrixReplacesGraph,
  buildCategoryAggregation,
  synthesisSummary, UNCATEGORIZED_LABEL,
} from '../lib/reader-model.js'
import { claimEvidenceStats } from '../components/reader-claim-map.js'
import { renderReaderClusterMap } from '../components/reader-cluster-map.js'
import { renderReaderClaimDetail } from '../components/reader-claim-detail.js'
import { renderReaderConclusion } from '../components/reader-conclusion.js'
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
  /* 图谱缩放与 LOD（设计提案 02）：缩放 <0.75 点阵 / ≤1.15 卡片 / >1.15 卡片+标题。 */
  let zoom = 1
  /* R1 论证大纲的折叠状态：只存内存（§10.3 验收要求），不写任何数据。 */
  const outlineExpanded = new Set()
  /* 吸顶分段导航当前锚点（只存内存）。 */
  const render = (currentProjection, rawEvents) => {
    const generation = ++refreshGeneration
    const integrity = currentProjection?.integrity || {}
    const verifiedEvents = verifiedLedgerPrefix(rawEvents, integrity)
    const currentNodes = allNodesOf(currentProjection)
    const currentEdges = allEdgesOf(currentProjection)
    /* 分类来自 L2 主题自定义层（主题设置里的观点分类）：主题没配分类就没有这一档。
       （原来定义在画布筛选控件旁边，画布移除后挪到这里——分类面板仍然要用。） */
    const themeCategories = asArray(theme?.config?.atomCategories).map((name) => String(name || '').trim()).filter(Boolean)
    if (!currentNodes.length) {
      article.replaceChildren(renderEmpty(currentProjection))
      return
    }

    const state = {
      projection: currentProjection,
      events: verifiedEvents,
      selectedNodeId: null,
      liveSelectedNodeId: null,
      searchMatches: [],
      searchPage: 1,
      searchLocatedNodeId: null,
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
    const inspector = h('aside', { class: 'rdr-inspector', 'aria-label': '节点、证据与来源检视', 'aria-live': 'polite' })
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
              : `记录完整 · ${verifiedEvents.length} 条`),
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
          h('p', { class: 'rdr-inspector-kicker' }, `观点 · ${NODE_STATUS_LABEL[status] || status}`),
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
                          }))) : h('p', { class: 'rdr-muted' }, '账本未记录此类关系；这不表示已经排除反例。'))),
            h('p', { class: 'rdr-relation-note' }, '支持、推导与反驳是有方向论证；归属、影响、依赖、时间关联与相关是弱主题关联。关系数量不构成可信度评级。')),
          h('section', { class: 'rdr-inspector-section' },
            h('h3', {}, `未决项 · ${pending.length + (status === 'disputed' ? 1 : 0)}`),
            status === 'disputed' ? h('p', { class: 'rdr-open-item' }, '节点当前标记为有争议。') : null,
            ...pending.map((edge) => h('p', { class: 'rdr-open-item' }, `关系「${edge.rel || '未知'}」仍待人工复核。`)),
            !pending.length && status !== 'disputed' ? h('p', { class: 'rdr-muted' }, '当前没有显式记录的未决项；这不表示所有问题都已解决。') : null),
          h('section', { class: 'rdr-inspector-section' },
            h('h3', {}, `来源 · ${evidenceSummary.total} 条（按时间倒序）`),
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
        `${model.counts.evidence} 条来源（支持 ${model.counts.supports} · 反对 ${model.counts.contradicts} · 没表态 ${model.counts.unstated}）`,
        `${model.counts.steps} 次确认/修订`,
        span,
      ]
      if (selected) {
        const last = model.series[model.series.length - 1]
        parts.push(`${titleOf(selected)}：${last ? `强度 ${last.value}%` : '还没有强度记录'}`)
      }
      axisCaption.textContent = parts.join(' · ')
    }

    const axisBox = h('section', { id: 'reader-axis', class: 'rdr-axis-card', 'aria-label': '整体情况：强度、时间与来源' },
      h('div', { class: 'rdr-axis-head' },
        h('strong', { class: 'rdr-axis-title' }, '整体情况'),
        axisCaption),
      axisHost)
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
          createTodo(node ? `为「${titleOf(node)}」补一条来源` : '复核这个主题里说不通的关系', null)
        },
      }))
    }
    const focusAtom = (id) => {
      const next = id && currentNodes.some((node) => node.id === id) ? id : null
      state.selectedNodeId = next
      if (next) outlineExpanded.add(next)
      renderInspector()
      renderStructure()
      renderGaps()
    }
    /* R7 路径查询：两原子之间隔着什么。真正的图问题，保留下来。 */
    const renderStructure = () => {
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

    /* 检视器保留：它是理由清单/正反两方/时间线/矩阵等下钻的详情面板（原本挂在关系图面板里）。 */
    const workspace = h('div', { class: 'rdr-workspace' }, inspector)
    axisBox.append(h('p', { class: 'rdr-axis-caveat' }, '来源多，不等于大家都认同——它只说明有多少条被挂上来。'))
    /* 第 ①③ 层「单条下钻」：就地展开在地图下方（读者不丢上下文）。
       口径与地图共用 claimEvidenceStats（不另写一份，避免两处说法分叉）。 */
    let detailClaimId = null
    const detailHost = h('div', { class: 'rdr-detail' })
    const closeClaimDetail = () => {
      detailClaimId = null
      detailHost.replaceChildren()
    }
    const openClaimDetail = (id) => {
      const node = claimNodes.find((row) => row.id === id) || null
      if (!node) return
      detailClaimId = id
      state.selectedNodeId = id
      /* 缺口面板的「标记缺口」把 selectedId 固化在渲染时——选中变化后必须重渲染，
         否则按钮记的是旧值（null），点了不会为该观点建待办。 */
      renderGaps()
      detailHost.replaceChildren(renderReaderClaimDetail({
        node,
        stats: claimEvidenceStats(node, rowsOfClaim),
        rows: rowsOfClaim(id),
        /* 相关原子：这条观点的真实关系（relation.declared；已驳回的边在上游已过滤）。 */
        relations: currentEdges
          .filter((edge) => edge && (edge.from === id || edge.to === id))
          .map((edge) => {
            const otherId = edge.from === id ? edge.to : edge.from
            const other = claimNodes.find((row) => row.id === otherId) || null
            return other ? { id: otherId, title: other.title, rel: edge.rel } : null
          })
          .filter(Boolean),
        onOpenRelation: openClaimDetail,
        onClose: closeClaimDetail,
      }))
      detailHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }

    /* 第 ④ 层「结论页」：读者第一屏，常显（不属于九个 tab，切换 tab 不会把它藏掉）。
       内容全部由真实数据推导：synthesisSummary 给"最强/最分歧"，gaps 给缺口，证据条数与
       独立来源家数来自 evidenceForNode；口径直接写在页面上。 */
    const conclusionBox = h('section', { class: 'rdr-conclusion', 'aria-label': '结论' },
      renderReaderConclusion({
        summary: synthesisSummary(currentNodes, (id) => evidenceForNode(state, id)),
        claims: currentNodes.filter((node) => node && !node.archived
          && (node.nodeType === 'viewpoint' || node.kind === 'claim')),
        /* 注意：renderGaps 里那份 gaps 是函数内部变量，作用域到不了这里——
           这里按同样入参现算一次（buildGapList 是纯函数，不写数据）。 */
        gaps: buildGapList({
          nodes: currentNodes,
          edges: allEdgesOf(currentProjection),
          inboxItems: inboxCache || [],
        }),
        evidenceForNode: (id) => evidenceForNode(state, id),
        onOpenClaim: openClaimDetail,
      }))
    const claimNodes = currentNodes.filter((node) => node && !node.archived
      && (node.nodeType === 'viewpoint' || node.kind === 'claim'))
    const mapGaps = buildGapList({ nodes: currentNodes, edges: currentEdges, inboxItems: inboxCache || [] })
    const rowsOfClaim = (id) => { try { return evidenceForNode(state, id) || {} } catch { return {} } }

    /* 第 ② 层「观点地图」：常显，紧跟结论页（三层下钻的第二层）。
       位置固定（按组数分区）、不用力导向；大小/颜色口径写在组件里。 */
    /* 图谱缩略图（分簇版，借鉴用户给的 demo）：固定分区、不用力导向。
       分簇依据 = 按证据状况（用户已确认），口径写在组件里。 */
    const mapBox = h('section', { class: 'rdr-map', 'aria-label': '观点分簇缩略图' },
      renderReaderClusterMap({
        claims: claimNodes,
        /* 簇 = 主题自定义分类（建设者可在「主题设置 → 分类管理」里定义）；没分类的归入「未分类」。 */
        themeCategories,
        /* 真实关系（已驳回的边在 currentEdges 上游已过滤）：用于画簇间连线，没有关系就不画。 */
        edges: currentEdges,
        evidenceForNode: rowsOfClaim,
        selectedId: state.selectedNodeId,
        onOpenClaim: openClaimDetail,
      }))
    /* 九个 tab 换成"三层常显 + 次级视图折叠"：
       常显 = 结论页(④) → 观点地图(②) → 单条下钻(①③) → 还缺什么；
       其余（关系全貌 / 时间线 / 全部理由 / 对照与分类 / 整体情况）收进折叠区——
       能力一个不丢，但读者不再需要先选一种"格式"才能开始看。 */
    const moreView = (title, ...nodes) => h('details', { class: 'rdr-more' },
      h('summary', { class: 'rdr-more-summary' }, title), ...nodes)
    const block = (title, host) => h('section', { class: 'rdr-block' },
      h('h2', { class: 'rdr-block-head' }, title), host)

    /* 读者页结构对齐用户给的 demo：
       头部（主题名 + 四个统计数）→ 图谱缩略图（气泡=簇，含分簇清单）→ 当前最该看的 5 个 → 单条下钻（抽屉位）。
       原先的"还缺什么 / 详情 / 四个折叠区"与结论页的长段落一并去掉——demo 里没有这些。
       注意：这里曾误写成 `toolbar`（reader 的头部变量已删），于是取到 window.toolbar（BarProp），
       页面上渲染出 [object BarProp] —— 已修。 */
    const readerStats = (() => {
      const states = claimNodes.map((node) => claimEvidenceStats(node, rowsOfClaim).state)
      const categories = new Set(claimNodes.map((node) => String(node?.atomCategory || '').trim() || '未分类'))
      return {
        claims: claimNodes.length,
        clusters: categories.size,
        evidence: currentNodes.filter((node) => networkNodeType(node) === 'evidence').length,
        contested: states.filter((state) => state === 'contested').length,
      }
    })()
    const statBox = (num, label) => h('div', { class: 'rdr-stat' },
      h('div', { class: 'rdr-stat-num' }, String(num)),
      h('div', { class: 'rdr-stat-label' }, label))
    const headBox = h('header', { class: 'rdr-head' },
      h('p', { class: 'rdr-head-kicker' }, '主题 · 观点图谱'),
      h('h1', { class: 'rdr-head-title' }, theme?.name || '未命名主题'),
      h('div', { class: 'rdr-stats' },
        statBox(readerStats.claims, '观点'),
        statBox(readerStats.clusters, '分类'),
        statBox(readerStats.evidence, '证据'),
        statBox(readerStats.contested, '受关注')))
    /* demo 的顺序：气泡图 → 「当前最该看的 5 个」→ 分簇清单。
       清单由缩略图组件一并产出，这里把那个节点搬到 Top 5 之后（同一个节点搬家，不重建）。 */
    const clusterList = mapBox.querySelector('.rdr-cluster-wrap')
    article.replaceChildren(
      ...[headBox, mapBox, conclusionBox, clusterList, detailHost].filter(Boolean),
      /* 其余面板（合成轴 / 理由清单 / 小倍数 / 正反两方 / 时间线 / 对照表 / 分类 / 缺口 / 检视器）
         保留能力，但收进**一行折叠**——可见区域保持 demo 式的精简，页面不再被它们占满。 */
      /* 还缺什么：三个构造器里数据最实的一个（11 条、三类），也最回答"哪里不确定"——提到可见区。 */
      /* 「更多视图」只留两个看得懂的：
         · 时间线：这主题是怎么长出来的（事件时间戳齐全）
         · 理由清单：每个观点凭什么（来源按立场分组）
         移除：整体情况（强度历史为空，画出来是空图）、分类聚合（主题没配分类，只有"未分类"一行）、
         正反两方（与理由清单同源同轴）、小倍数（每卡都显示"还没有强度"、分类色点也没数据）、
         对照表（用户反馈"完全看不懂"，且与理由清单同一份数据）。 */
      moreView('更多视图', outlineHost, chronicleHost))
    /* 面板在折叠区里也必须先渲染（fixture 与无障碍都按 DOM 断言/读取）。 */
    renderInspector()
    renderStructure()
    loadInboxItems().then(() => renderGaps())
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
