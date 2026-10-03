import {
  NODE_TYPE_META, RELATION_META, NODE_STATUS_LABEL, REVISION_RELATIONS, READER_STATE_META, readerStateKey,
  categoryColor, networkNodeType, networkNodeStatus, splitNetworkTitle, nodeTitleCharsPerLine,
} from './theme-network.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const ARGUMENT_TYPES = new Set(['supports', 'derives', 'contradicts'])
const REVISION_TYPES = new Set(REVISION_RELATIONS)
const MAX_VISIBLE_EDGES = 72

export function svgEl(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

export function svgText(value, attributes = {}) {
  const element = svgEl('text', attributes)
  element.textContent = String(value ?? '')
  return element
}

function pointOnCard(from, to, halfWidth, halfHeight) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (!dx && !dy) return { ...from }
  const t = Math.min(dx ? halfWidth / Math.abs(dx) : Infinity, dy ? halfHeight / Math.abs(dy) : Infinity)
  return { x: from.x + dx * t, y: from.y + dy * t }
}

function edgeGeometry(a, b, aSize, bSize, arrow) {
  const start = pointOnCard(a, b, aSize.w / 2 + 2, aSize.h / 2 + 2)
  const end = pointOnCard(b, a, bSize.w / 2 + (arrow ? 9 : 2), bSize.h / 2 + (arrow ? 9 : 2))
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy) || 1
  const bend = Math.min(24, length * 0.09)
  const cx = (start.x + end.x) / 2 - dy / length * bend
  const cy = (start.y + end.y) / 2 + dx / length * bend
  return {
    d: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    x: 0.25 * start.x + 0.5 * cx + 0.25 * end.x,
    y: 0.25 * start.y + 0.5 * cy + 0.25 * end.y,
  }
}

function appendTypeGlyph(group, type, centerX, centerY, scale = 1) {
  const meta = NODE_TYPE_META[type] || NODE_TYPE_META.viewpoint
  // 视觉编码：尺寸表示强度（scale 0.7~1.3）
  const s = Math.max(0.7, Math.min(1.3, scale))
  if (meta.shape === 'circle') {
    group.append(svgEl('circle', { cx: centerX, cy: centerY, r: 10 * s, fill: meta.color }))
  } else if (meta.shape === 'diamond') {
    group.append(svgEl('path', { d: `M ${centerX} ${centerY - 11 * s} L ${centerX + 11 * s} ${centerY} L ${centerX} ${centerY + 11 * s} L ${centerX - 11 * s} ${centerY} Z`, fill: meta.color }))
  } else if (meta.shape === 'hexagon') {
    group.append(svgEl('path', { d: `M ${centerX - 9 * s} ${centerY - 10 * s} L ${centerX + 4 * s} ${centerY - 10 * s} L ${centerX + 10 * s} ${centerY} L ${centerX + 4 * s} ${centerY + 10 * s} L ${centerX - 9 * s} ${centerY + 10 * s} L ${centerX - 12 * s} ${centerY} Z`, fill: meta.color }))
  } else if (meta.shape === 'document') {
    group.append(svgEl('path', { d: `M ${centerX - 9 * s} ${centerY - 10 * s} H ${centerX + 3 * s} L ${centerX + 10 * s} ${centerY - 3 * s} V ${centerY + 10 * s} H ${centerX - 9 * s} Z M ${centerX + 3 * s} ${centerY - 10 * s} V ${centerY - 3 * s} H ${centerX + 10 * s}`, fill: meta.color, 'fill-rule': 'evenodd' }))
  } else {
    group.append(svgEl('rect', { x: centerX - 10 * s, y: centerY - 10 * s, width: 20 * s, height: 20 * s, rx: 6 * s, fill: meta.color }))
  }
  /* 类型只用形状 + 颜色两重编码：汉字 icon 与类型文字标签已移除（见无障碍 label / 图例）。 */
}

/* 画布调色板：跟随系统浅色/深色（CSS 变量负责静态规则，这里负责 JS 直写的 fill）。 */
function canvasPalette() {
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  return dark
    ? { card: '#1c1c1e', pillBg: '#2c2c2e', ok: '#30d158', warn: '#ff5a54', muted: '#a7a7ad' }
    : { card: '#ffffff', pillBg: 'rgba(0,0,0,0.06)', ok: '#34c759', warn: '#ff3b30', muted: '#8e8e93' }
}
function nodeStatusColor(status) {
  /* Apple 式：中性底，颜色只出现在文字上。 */
  return canvasPalette().pillBg
}
function nodeStatusTextColor(status) {
  const p = canvasPalette()
  if (status === 'verified') return p.ok
  if (status === 'disputed') return p.warn
  return p.muted
}

/** Render only event-projection nodes: topic is never synthesized as a graph root. */
export function drawThemeNetwork(projection, opts = {}, canvas) {
  const stateNodes = Array.isArray(projection?.nodes) ? projection.nodes : []
  if (!stateNodes.length) return null
  const layout = opts.networkLayout
  if (!layout?.pos || !layout?.size) throw new Error('主题网络缺少稳定布局')
  const width = layout.width || 1120
  const height = layout.height || 360
  const selectedIds = new Set(stateNodes.map((node) => node.id))
  const currentById = new Map((Array.isArray(opts.currentNodes) ? opts.currentNodes : []).map((node) => [node.id, node]))
  const nodes = stateNodes.map((node) => {
    const current = currentById.get(node.id)
    if (!opts.compareCurrent || !current) return node
    const changes = {}
    if (current.title !== node.title) changes.currentTitle = current.title
    if (networkNodeStatus(current) !== networkNodeStatus(node)) changes.currentStatus = networkNodeStatus(current)
    if (Object.keys(changes).length) return { ...node, _comparison: changes }
    return node
  })
  const searchMatchIds = new Set(Array.isArray(opts.searchMatchIds) ? opts.searchMatchIds : [])
  const presentLimit = Math.min(MAX_VISIBLE_EDGES, Number(opts.maxComparisonNodes) || 8)
  let notYetAdded = 0
  if (opts.compareCurrent) {
    for (const current of Array.isArray(opts.currentNodes) ? opts.currentNodes : []) {
      if (selectedIds.has(current.id) || nodes.length >= stateNodes.length + presentLimit) continue
      nodes.push({ ...current, _notYetCreated: true })
      selectedIds.add(current.id)
      notYetAdded++
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  const historicalEdges = Array.isArray(projection?.edges) ? projection.edges : []
  const allHistoricalEdgeIds = new Set((Array.isArray(projection?.allEdges) ? projection.allEdges : historicalEdges)
    .map((edge) => edge.eventId || edge.id))
  const currentEdges = opts.compareCurrent && Array.isArray(opts.currentEdges) ? opts.currentEdges : []
  const futureEdges = currentEdges.filter((edge) => !allHistoricalEdgeIds.has(edge.eventId || edge.id)
    && nodeIds.has(edge.from) && nodeIds.has(edge.to))
  const edges = [...historicalEdges, ...futureEdges.map((edge) => ({ ...edge, _future: true }))]
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .slice(0, MAX_VISIBLE_EDGES)

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'cog-svg cog-network-svg',
    role: 'group',
    'aria-label': opts.historyContext?.selectedSeq != null
      ? `历史回放第 ${opts.historyContext.selectedSeq} 条的主题认知网络；节点位置固定；只读`
      : '主题认知网络；搜索可查找全部节点；节点位置固定',
    'data-node-count': nodes.length,
    'data-edge-count': edges.length,
    'data-comparison-ghosts': notYetAdded,
  })
  const defs = svgEl('defs')
  for (const rel of ['supports', 'derives', 'contradicts', 'supersedes']) {
    const meta = RELATION_META[rel]
    const marker = svgEl('marker', {
      id: `cog-network-arrow-${rel}`, viewBox: '0 0 10 10', refX: '8.5', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    })
    marker.append(svgEl('path', { d: 'M 1 1 L 9 5 L 1 9 z', fill: meta.color }))
    defs.append(marker)
  }
  const reviewMarker = svgEl('marker', {
    id: 'cog-network-arrow-review', viewBox: '0 0 10 10', refX: '8.5', refY: '5',
    markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
  })
  reviewMarker.append(svgEl('path', { d: 'M 1 1 L 9 5 L 1 9 z', fill: '#8e8e93' }))
  defs.append(reviewMarker)
  svg.append(defs)

  const edgeLayer = svgEl('g', { class: 'cog-network-edges', 'aria-label': '网络关系' })
  const labelLayer = svgEl('g', { class: 'cog-network-edge-labels', 'aria-hidden': 'true' })
  const nodeLayer = svgEl('g', { class: 'cog-network-nodes', 'aria-label': '网络节点' })
  svg.append(edgeLayer, labelLayer, nodeLayer)
  const edgeRecords = []
  for (const edge of edges) {
    const from = layout.pos.get(edge.from)
    const to = layout.pos.get(edge.to)
    const fromSize = layout.size.get(edge.from)
    const toSize = layout.size.get(edge.to)
    if (!from || !to || !fromSize || !toSize) continue
    /* 证据挂载：归位/入库留下的"已挂上但未声明立场"的连接。它不是论证关系，
       所以画成灰点线、无箭头，和图例里单列一行；确认或驳回后才会变成真关系。 */
    if (edge.derived && edge.rel === 'evidence-attached') {
      const future = Boolean(edge._future)
      const geometry = edgeGeometry(from, to, fromSize, toSize, false)
      const attachedLabel = (id) => projection.allNodes?.find((node) => node.id === id)?.title || id
      const path = svgEl('path', {
        d: geometry.d,
        class: `cog-edge cog-edge-evidence-attached is-evidence-attached${future ? ' is-future' : ''}`,
        'data-from': edge.from, 'data-to': edge.to, 'data-rel': edge.rel,
        'data-group': 'evidence',
        stroke: '#8a93a3',
        'stroke-width': 1.4,
        'stroke-opacity': future ? 0.2 : 0.6,
        'stroke-dasharray': '3 4',
        'marker-end': 'none',
        role: 'img',
        'aria-label': `证据挂载：${attachedLabel(edge.from)} 挂在 ${attachedLabel(edge.to)} 上，尚未声明立场`,
      })
      const attachedTitle = svgEl('title')
      attachedTitle.textContent = '证据挂载 · 未声明立场（它还不是支持或反驳）'
      path.append(attachedTitle)
      edgeLayer.append(path)
      edgeRecords.push({ path, label: null, edge })
      continue
    }
    const argument = ARGUMENT_TYPES.has(edge.rel)
    const revision = REVISION_TYPES.has(edge.rel) || edge.relationGroup === 'revision'
    const directional = argument || revision
    const rel = RELATION_META[edge.rel] || { label: edge.rel || '关系', color: '#8e8e93', group: 'association' }
    const pending = Boolean(edge.pendingReview)
    const rejected = edge.reviewDecision === 'rejected'
    const confirmed = edge.reviewDecision === 'confirmed'
    const future = Boolean(edge._future)
    const color = pending ? '#8e8e93' : rejected ? '#ff8d78' : rel.color
    const geometry = edgeGeometry(from, to, fromSize, toSize, directional)
    const path = svgEl('path', {
      d: geometry.d,
      class: `cog-edge cog-edge-${edge.rel || 'related'} ${argument ? 'is-argument' : revision ? 'is-revision' : 'is-association'}${pending ? ' is-review' : ''}${rejected ? ' is-rejected' : ''}${confirmed ? ' is-confirmed' : ''}${future ? ' is-future' : ''}`,
      'data-from': edge.from, 'data-to': edge.to, 'data-rel': edge.rel || 'related',
      'data-group': argument ? 'argument' : revision ? 'revision' : 'association',
      stroke: color,
      'stroke-width': argument ? (pending ? 2.5 : 2.8) : revision ? 2 : 1.1,
      'stroke-opacity': directional ? (future ? 0.38 : 0.9) : (future ? 0.15 : 0.43),
      'stroke-dasharray': pending || rejected || future ? (directional ? '6 4' : '3 5') : revision ? '7 3' : argument ? 'none' : '3 5',
      'marker-end': directional ? `url(#cog-network-arrow-${pending || rejected ? 'review' : edge.rel})` : 'none',
      role: 'img',
      'aria-label': `${rel.label}关系：${projection.allNodes?.find((node) => node.id === edge.from)?.title || edge.from} 指向 ${projection.allNodes?.find((node) => node.id === edge.to)?.title || edge.to}${pending ? '，待用户复核' : rejected ? '，已驳回但原声明保留' : ''}${future ? '，后续新增' : ''}`,
    })
    const title = svgEl('title')
    title.textContent = `${argument ? '有向论证' : revision ? '版本修订关系' : '弱主题关联'} · ${rel.label}${pending ? ' · 待复核' : confirmed ? ' · 已确认' : rejected ? ' · 已驳回' : ''}${future ? ' · 所选时点之后新增' : ''}`
    path.append(title)
    edgeLayer.append(path)
    if (directional) {
      const label = svgEl('g', {
        class: 'cog-edge-label', 'data-rel': edge.rel || '',
        'data-review-status': pending ? 'pending' : rejected ? 'rejected' : confirmed ? 'confirmed' : 'none',
        transform: `translate(${geometry.x.toFixed(1)} ${geometry.y.toFixed(1)})`,
      })
      const labelText = `${pending ? '待复核 · ' : rejected ? '已驳回 · ' : ''}${revision ? '修订 · ' : ''}${rel.label}`
      const boxWidth = Math.max(44, labelText.length * 11 + 16)
      label.append(svgEl('rect', { x: -boxWidth / 2, y: -10, width: boxWidth, height: 20, rx: 10, fill: '#171d27', stroke: color, 'stroke-opacity': 0.75 }))
      label.append(svgText(labelText, { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'cog-edge-label-text', fill: color }))
      labelLayer.append(label)
      edgeRecords.push({ path, label, edge })
    } else edgeRecords.push({ path, label: null, edge })
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  let activeId = null
  const setFocus = (id, notify = false) => {
    activeId = id || null
    const neighbors = new Set(activeId ? [activeId] : [])
    if (activeId) for (const { edge } of edgeRecords) {
      if (edge.from === activeId || edge.to === activeId) { neighbors.add(edge.from); neighbors.add(edge.to) }
    }
    for (const element of nodeLayer.querySelectorAll('.cog-node')) {
      const selected = element.getAttribute('data-node-id') === activeId
      element.classList.toggle('is-selected', selected)
      element.setAttribute('data-focus', activeId ? String(neighbors.has(element.getAttribute('data-node-id'))) : 'all')
    }
    for (const record of edgeRecords) {
      const related = !activeId || record.edge.from === activeId || record.edge.to === activeId
      record.path.setAttribute('data-focus', activeId ? String(related) : 'all')
      record.label?.classList.toggle('is-visible', Boolean(activeId && related))
    }
    const node = nodesById.get(activeId)
    /* 清空聚焦（activeId 为 null）也要通知调用方，否则右侧检视器会继续显示上一个节点。 */
    if (notify && (!node || !node._notYetCreated)) opts.onFocusNode?.(node || null)
  }

  /* LOD 分级（设计提案 02/03）：点阵 / 卡片 / 卡片+标题。默认完整渲染，调用方按缩放传级别。 */
  const lodLevel = opts.lodLevel || 'cards-labels'
  const showCards = lodLevel !== 'dots'
  const showLabels = lodLevel === 'cards-labels'
  for (const node of nodes) {
    const point = layout.pos.get(node.id)
    const dimensions = layout.size.get(node.id)
    if (!point || !dimensions) continue
    const type = networkNodeType(node)
    // 统一为原子节点视觉：不再按类型区分形状颜色
    const meta = NODE_TYPE_META.viewpoint
    const status = node._notYetCreated ? 'pending' : networkNodeStatus(node)
    const statusLabel = node._notYetCreated ? '后续新增' : NODE_STATUS_LABEL[status] || status
    /* 读者视角状态（已佐证/受挑战/有争议/未评估）：只有调用方给了 readerStates 时生效，
       其它画布（建设者）保持原来的统一原子配色，避免顺带改掉那边的观感。 */
    const readerMeta = opts.readerStates ? READER_STATE_META[opts.readerStates.get?.(node.id)] || null : null
    const pillLabel = readerMeta ? readerMeta.label : statusLabel
    const unavailable = Boolean(node.archived || node.invalidated || node._notYetCreated)
    const group = svgEl('g', {
      class: `cog-node${node.archived ? ' is-archived' : ''}${node.invalidated ? ' is-invalidated' : ''}${node._notYetCreated ? ' is-not-yet-created' : ''}${node._comparison ? ' has-current-comparison' : ''}${searchMatchIds.has(node.id) ? ' is-search-match' : ''}`,
      transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
      'data-node-id': node.id,
      'data-search-match': String(searchMatchIds.has(node.id)),
      'data-node-type': type,
      'data-kind': type,
      'data-status': status,
      'data-reader-state': readerMeta ? opts.readerStates.get(node.id) : null,
      'data-source-ref': node.sourceRef || '',
      'data-provenance': (node.provenanceEventIds || node.eventIds || []).join(','),
      tabindex: node._notYetCreated ? '-1' : '0',
      role: node._notYetCreated ? 'img' : 'button',
      'aria-label': node._notYetCreated
        ? `${meta.label}：${node.title || '未命名'}；此节点在所选历史时点之后新增，仅供比较`
        : `${meta.label}：${node.title || '未命名'}；状态：${pillLabel}${node.external ? '；外部引用，尚未解析' : ''}${node._comparison?.currentTitle ? `；当前名称：${node._comparison.currentTitle}` : ''}。按 Enter 或空格选择节点并查看详情。`,
    })
    /* 只给"不可用"节点写内联透明度：以前这里无条件写 '1'，内联样式盖掉了 CSS 的
       .cog-node[data-focus="false"]{opacity:.12}，导致邻域聚焦时节点根本没暗下去
       （只有连线生效）。可用节点留空，让 CSS 决定。 */
    group.style.opacity = unavailable ? (node._notYetCreated ? '0.36' : '0.68') : ''
    const stroke = node.invalidated ? '#ad756a' : node.archived ? '#8390a0' : (readerMeta?.color || meta.color)
    /* 设计提案 02/03：LOD 分级。点阵＝只有点（点径随强度）；卡片＝有卡片无文字；
       卡片+标题＝完整。默认（调用方没给 lodLevel）保持原来的完整渲染，建设者画布不受影响。 */
    const dotRadius = Math.max(3.5, 4 + (Math.max(0, Math.min(100, Number(node.confidence ?? node.strength ?? 50))) / 100) * 7)
    if (!showCards) {
      group.append(svgEl('circle', { cx: 0, cy: 0, r: dotRadius, fill: stroke, class: 'cog-node-dot' }))
    } else {
    group.append(svgEl('rect', {
      x: -dimensions.w / 2, y: -dimensions.h / 2, width: dimensions.w, height: dimensions.h, rx: 13,
      fill: canvasPalette().card, stroke, 'stroke-width': node._notYetCreated ? 1 : 1.6,
      'stroke-dasharray': unavailable ? '5 4' : 'none',
      class: 'cog-node-card',
    }))
    /* 左侧分类色条（设计提案 ④）：分类是主题自定义词表，颜色只表达"属于哪一类"。 */
    const catColor = typeof opts.categoryColorFor === 'function'
      ? opts.categoryColorFor(node.atomCategory)
      : categoryColor(opts.atomCategories, node.atomCategory)
    if (catColor) {
      group.append(svgEl('rect', {
        x: -dimensions.w / 2 + 5, y: -dimensions.h / 2 + 5, width: 3, height: Math.max(8, dimensions.h - 10),
        rx: 1.5, fill: catColor, class: 'cog-node-category',
      }))
    }
    /* 证据在读者画布上压成紧凑"数据点"：单行短标签、不挂状态徽标（14 张全标"未评估"
       只是噪声），身份由外形和它与观点的连线表达。只用 opts.compactEvidence 开启，
       建设者画布保持原样。 */
    const compact = Boolean(opts.compactEvidence) && type === 'evidence'
    const glyphX = compact ? -dimensions.w / 2 + 12 : -dimensions.w / 2 + 15
    const glyphY = compact ? 0 : -dimensions.h / 2 + 16
    // 视觉编码：glyph 尺寸表示节点强度（confidence 0-100 → 0.7-1.3）
    const strengthScale = 0.7 + (Math.max(0, Math.min(100, Number(node.confidence ?? node.strength ?? 50))) / 100) * 0.6
    appendTypeGlyph(group, type, glyphX, glyphY, compact ? 0.55 : strengthScale)
    /* 类型文字标签已移除：形状 + 颜色已足够区分，label 只保留在无障碍文本与图例中。 */
    const showPill = showLabels && opts.statusPill !== false
      && (node._notYetCreated || (!compact && Boolean(readerMeta)) || status !== 'pending')
    if (showPill) {
      const pillWidth = Math.max(44, Math.min(68, pillLabel.length * 10 + 13))
      const pillX = dimensions.w / 2 - pillWidth - 7
      const pillY = -dimensions.h / 2 + 7
      group.append(svgEl('rect', { x: pillX, y: pillY, width: pillWidth, height: 18, rx: 9, fill: readerMeta ? readerMeta.color : nodeStatusColor(status), class: 'cog-node-status-bg' }))
      group.append(svgText(pillLabel, { x: pillX + pillWidth / 2, y: pillY + 9.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'cog-node-status-pill', fill: readerMeta ? readerMeta.text : nodeStatusTextColor(status) }))
    }
    const titleLines = compact
      ? splitNetworkTitle(node.title || '数据', nodeTitleCharsPerLine(dimensions.w - 26, 10.5, 20), 1)
      : splitNetworkTitle(node.title || '未命名节点', nodeTitleCharsPerLine(dimensions.w, 11, 28), 2)
    if (showLabels) titleLines.forEach((line, index) => group.append(svgText(line, {
      x: -dimensions.w / 2 + (compact ? 21 : 12),
      y: compact ? 4 : titleLines.length === 1 ? 5 : -1 + index * 15,
      class: `cog-node-title${compact ? ' is-compact' : ''}`,
    })))
    if (showLabels && node._comparison?.currentTitle) {
      const comparisonText = `当前：${node._comparison.currentTitle}`
      group.append(svgText(splitNetworkTitle(comparisonText, nodeTitleCharsPerLine(dimensions.w, 11, 28), 1)[0], {
        x: -dimensions.w / 2 + 12, y: dimensions.h / 2 - 5, class: 'cog-node-comparison-label',
      }))
    } else if (showLabels && node._comparison?.currentStatus) {
      group.append(svgText(`当前状态：${NODE_STATUS_LABEL[node._comparison.currentStatus] || node._comparison.currentStatus}`, {
        x: -dimensions.w / 2 + 12, y: dimensions.h / 2 - 5, class: 'cog-node-comparison-label',
      }))
    }
    }
    /* 渐进披露：信号计数只画在当前选中的那个原子上（demo 的"N 条信号 · N 支持 / N 挑战"），
       而不是 21 张卡片全摊开数字。未表态单独列出——那正是"证据已挂上、还没表态"的量。 */
    const counts = opts.readerCounts?.get?.(node.id)
    if (counts && showCards && opts.focusNodeId === node.id && type !== 'evidence') {
      const parts = []
      if (counts.supports > 0) parts.push(`支持 ${counts.supports}`)
      if (counts.challenges > 0) parts.push(`挑战 ${counts.challenges}`)
      if (counts.unclassified > 0) parts.push(`未表态 ${counts.unclassified}`)
      if (parts.length) {
        group.append(svgText(parts.join(' · '), {
          x: 0, y: dimensions.h / 2 + 15, 'text-anchor': 'middle', class: 'cog-node-counts',
        }))
      }
    }
    const title = svgEl('title')
    title.textContent = `${meta.label} · ${node.title || '未命名节点'} · ${pillLabel}${node.originalTitle ? ` · 旧名：${node.originalTitle}` : ''}`
    group.append(title)
    if (!node._notYetCreated) {
      group.addEventListener('focus', () => setFocus(node.id, true))
      group.addEventListener('click', () => setFocus(node.id, true))
      group.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        if (event.repeat) return
        event.preventDefault()
        setFocus(node.id, true)
      })
    }
    nodeLayer.append(group)
  }

  canvas.append(svg)
  /* 不再用"先 opacity:0、等 requestAnimationFrame 再显示"的淡入：窗口被遮挡或
     在后台时 rAF 不推进，图会一直停在不可见状态（实测 opacity 卡在 0）。
     可见性不押在动画帧上。 */
  svg.addEventListener('cog-clear-focus', () => setFocus(null))
  /* 点空白处＝清空聚焦：所有节点与连线回到完全可见，右侧检视器也退回"未选中"。
     之前点空白没有任何反应，读者被"锁"在某次选择里出不来。 */
  svg.addEventListener('click', (event) => {
    if (event.target?.closest?.('.cog-node')) return
    setFocus(null, true)
  })
  /* 键盘等价操作：焦点在任一节点上按 Esc 也清空选择。
     否则只用键盘的读者选中节点后就退不出来（搜索框的 Esc 由它自己的处理器处理，不冲突）。 */
  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!activeId) return
    event.preventDefault()
    setFocus(null, true)
  })
  if (opts.focusNodeId && nodesById.has(opts.focusNodeId) && !nodesById.get(opts.focusNodeId)._notYetCreated) {
    setFocus(opts.focusNodeId)
  }
  return svg
}
