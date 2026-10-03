import {
  NODE_TYPE_META, RELATION_META, NODE_STATUS_LABEL, REVISION_RELATIONS, networkNodeType, networkNodeStatus, splitNetworkTitle, nodeTitleCharsPerLine,
} from './theme-network.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const ARGUMENT_TYPES = new Set(['supports', 'derives', 'contradicts'])
const REVISION_TYPES = new Set(REVISION_RELATIONS)
const MAX_VISIBLE_EDGES = 72

function svgEl(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

function svgText(value, attributes = {}) {
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

function appendTypeGlyph(group, type, centerX, centerY) {
  const meta = NODE_TYPE_META[type] || NODE_TYPE_META.viewpoint
  if (meta.shape === 'circle') {
    group.append(svgEl('circle', { cx: centerX, cy: centerY, r: 10, fill: meta.color }))
  } else if (meta.shape === 'diamond') {
    group.append(svgEl('path', { d: `M ${centerX} ${centerY - 11} L ${centerX + 11} ${centerY} L ${centerX} ${centerY + 11} L ${centerX - 11} ${centerY} Z`, fill: meta.color }))
  } else if (meta.shape === 'hexagon') {
    group.append(svgEl('path', { d: `M ${centerX - 9} ${centerY - 10} L ${centerX + 4} ${centerY - 10} L ${centerX + 10} ${centerY} L ${centerX + 4} ${centerY + 10} L ${centerX - 9} ${centerY + 10} L ${centerX - 12} ${centerY} Z`, fill: meta.color }))
  } else if (meta.shape === 'document') {
    group.append(svgEl('path', { d: `M ${centerX - 9} ${centerY - 10} H ${centerX + 3} L ${centerX + 10} ${centerY - 3} V ${centerY + 10} H ${centerX - 9} Z M ${centerX + 3} ${centerY - 10} V ${centerY - 3} H ${centerX + 10}`, fill: meta.color, 'fill-rule': 'evenodd' }))
  } else {
    group.append(svgEl('rect', { x: centerX - 10, y: centerY - 10, width: 20, height: 20, rx: 6, fill: meta.color }))
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
  svg.style.opacity = '0'
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
    if (notify && node && !node._notYetCreated) opts.onFocusNode?.(node)
  }

  for (const node of nodes) {
    const point = layout.pos.get(node.id)
    const dimensions = layout.size.get(node.id)
    if (!point || !dimensions) continue
    const type = networkNodeType(node)
    const meta = NODE_TYPE_META[type]
    const status = node._notYetCreated ? 'pending' : networkNodeStatus(node)
    const statusLabel = node._notYetCreated ? '后续新增' : NODE_STATUS_LABEL[status] || status
    const unavailable = Boolean(node.archived || node.invalidated || node._notYetCreated)
    const group = svgEl('g', {
      class: `cog-node${node.archived ? ' is-archived' : ''}${node.invalidated ? ' is-invalidated' : ''}${node._notYetCreated ? ' is-not-yet-created' : ''}${node._comparison ? ' has-current-comparison' : ''}${searchMatchIds.has(node.id) ? ' is-search-match' : ''}`,
      transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`,
      'data-node-id': node.id,
      'data-search-match': String(searchMatchIds.has(node.id)),
      'data-node-type': type,
      'data-kind': type,
      'data-status': status,
      'data-source-ref': node.sourceRef || '',
      'data-provenance': (node.provenanceEventIds || node.eventIds || []).join(','),
      tabindex: node._notYetCreated ? '-1' : '0',
      role: node._notYetCreated ? 'img' : 'button',
      'aria-label': node._notYetCreated
        ? `${meta.label}：${node.title || '未命名'}；此节点在所选历史时点之后新增，仅供比较`
        : `${meta.label}：${node.title || '未命名'}；状态：${statusLabel}${node.external ? '；外部引用，尚未解析' : ''}${node._comparison?.currentTitle ? `；当前名称：${node._comparison.currentTitle}` : ''}。按 Enter 或空格选择节点并查看详情。`,
    })
    group.style.opacity = unavailable ? (node._notYetCreated ? '0.36' : '0.68') : '1'
    const stroke = node.invalidated ? '#ad756a' : node.archived ? '#8390a0' : meta.color
    group.append(svgEl('rect', {
      x: -dimensions.w / 2, y: -dimensions.h / 2, width: dimensions.w, height: dimensions.h, rx: 13,
      fill: canvasPalette().card, stroke, 'stroke-width': node._notYetCreated ? 1 : 1.6,
      'stroke-dasharray': unavailable ? '5 4' : 'none',
      class: 'cog-node-card',
    }))
    const glyphX = -dimensions.w / 2 + 15
    const glyphY = -dimensions.h / 2 + 16
    appendTypeGlyph(group, type, glyphX, glyphY)
    /* 类型文字标签已移除：形状 + 颜色已足够区分，label 只保留在无障碍文本与图例中。 */
    const showPill = node._notYetCreated || status !== 'pending'
    if (showPill) {
      const pillWidth = Math.max(44, Math.min(68, statusLabel.length * 10 + 13))
      const pillX = dimensions.w / 2 - pillWidth - 7
      const pillY = -dimensions.h / 2 + 7
      group.append(svgEl('rect', { x: pillX, y: pillY, width: pillWidth, height: 18, rx: 9, fill: nodeStatusColor(status), class: 'cog-node-status-bg' }))
      group.append(svgText(statusLabel, { x: pillX + pillWidth / 2, y: pillY + 9.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'cog-node-status-pill', fill: nodeStatusTextColor(status) }))
    }
    const titleLines = splitNetworkTitle(node.title || '未命名节点', nodeTitleCharsPerLine(dimensions.w, 11, 28), 2)
    titleLines.forEach((line, index) => group.append(svgText(line, {
      x: -dimensions.w / 2 + 12,
      y: titleLines.length === 1 ? 5 : -1 + index * 15,
      class: 'cog-node-title',
    })))
    if (node._comparison?.currentTitle) {
      const comparisonText = `当前：${node._comparison.currentTitle}`
      group.append(svgText(splitNetworkTitle(comparisonText, nodeTitleCharsPerLine(dimensions.w, 11, 28), 1)[0], {
        x: -dimensions.w / 2 + 12, y: dimensions.h / 2 - 5, class: 'cog-node-comparison-label',
      }))
    } else if (node._comparison?.currentStatus) {
      group.append(svgText(`当前状态：${NODE_STATUS_LABEL[node._comparison.currentStatus] || node._comparison.currentStatus}`, {
        x: -dimensions.w / 2 + 12, y: dimensions.h / 2 - 5, class: 'cog-node-comparison-label',
      }))
    }
    const title = svgEl('title')
    title.textContent = `${meta.label} · ${node.title || '未命名节点'} · ${statusLabel}${node.originalTitle ? ` · 旧名：${node.originalTitle}` : ''}`
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
  requestAnimationFrame(() => { if (svg.isConnected) svg.style.opacity = '1' })
  svg.addEventListener('cog-clear-focus', () => setFocus(null))
  if (opts.focusNodeId && nodesById.has(opts.focusNodeId) && !nodesById.get(opts.focusNodeId)._notYetCreated) {
    setFocus(opts.focusNodeId)
  }
  return svg
}
