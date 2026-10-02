export const NETWORK_NODE_TYPES = ['concept', 'object', 'event', 'viewpoint', 'evidence']
export const ARGUMENT_RELATIONS = ['supports', 'derives', 'contradicts']
export const ASSOCIATION_RELATIONS = ['belongs-to', 'influences', 'depends-on', 'temporal', 'related']

export const NODE_TYPE_META = {
  concept: { label: '概念', icon: '概', shape: 'circle', color: '#55cfb1' },
  object: { label: '对象', icon: '物', shape: 'diamond', color: '#78aaff' },
  event: { label: '事件', icon: '时', shape: 'hexagon', color: '#ffc271' },
  viewpoint: { label: '观点', icon: '观', shape: 'rounded', color: '#c2a0ff' },
  evidence: { label: '证据', icon: '据', shape: 'document', color: '#d3deea' },
}

export const RELATION_META = {
  supports: { label: '支持', group: 'argument', color: '#61a8ff' },
  derives: { label: '推导', group: 'argument', color: '#c2a0ff' },
  contradicts: { label: '反驳', group: 'argument', color: '#ff9c79' },
  'belongs-to': { label: '归属', group: 'association', color: '#7d8da3' },
  influences: { label: '影响', group: 'association', color: '#7d8da3' },
  'depends-on': { label: '依赖', group: 'association', color: '#7d8da3' },
  temporal: { label: '时间关联', group: 'association', color: '#7d8da3' },
  related: { label: '相关', group: 'association', color: '#7d8da3' },
}

export function networkNodeType(node) {
  const type = node?.nodeType
  if (NETWORK_NODE_TYPES.includes(type)) return type
  if (node?.kind === 'evidence') return 'evidence'
  return 'viewpoint'
}

export function networkNodeStatus(node) {
  if (node?.archived) return 'archived'
  if (node?.invalidated) return 'invalidated'
  if (node?.correct === false || ['disputed', 'disproved'].includes(node?.status)) return 'disputed'
  if (node?.correct === true || ['verified', 'confirmed'].includes(node?.status)) return 'verified'
  if (['stale', 'forking', 'closed', 'superseded', 'resolved'].includes(node?.status)) return node.status
  return 'pending'
}

export const NODE_STATUS_LABEL = {
  pending: '待复核', verified: '已核验', disputed: '有争议', invalidated: '已失效', archived: '已归档',
  stale: '待更新', forking: '待收敛', closed: '已关闭', superseded: '已更正', resolved: '已结案',
}

export function truncateGraphemes(value, limit, suffix = '…') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const parts = typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
    : Array.from(text)
  return parts.length > limit ? `${parts.slice(0, Math.max(0, limit - 1)).join('')}${suffix}` : text
}

export function splitNetworkTitle(value, maxPerLine = 14, maxLines = 2) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim() || '未命名'
  const parts = typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
    : Array.from(text)
  const lines = []
  for (let i = 0; i < parts.length && lines.length < maxLines; i += maxPerLine) {
    lines.push(parts.slice(i, i + maxPerLine).join(''))
  }
  if (parts.length > maxPerLine * maxLines && lines.length) {
    lines[lines.length - 1] = truncateGraphemes(lines.at(-1), maxPerLine, '…')
  }
  return lines.length ? lines : ['未命名']
}

function dateKeyFor(event) {
  const raw = String(event?.at || '')
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (!match) return null
  const millis = Date.parse(`${match[1]}T00:00:00.000Z`)
  return Number.isFinite(millis) ? { date: match[1], day: Math.floor(millis / 86400000) } : null
}

/** One point per event-bearing day. Positions use elapsed calendar time, not event count. */
export function buildDensityTimeline(events = []) {
  const groups = new Map()
  const rows = Array.isArray(events) ? events : []
  for (const event of rows) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1) continue
    const parsed = dateKeyFor(event)
    const key = parsed?.date || '日期未记录'
    const prior = groups.get(key) || { date: key, day: parsed?.day ?? null, firstSeq: event.seq, seq: event.seq, count: 0 }
    prior.firstSeq = Math.min(prior.firstSeq, event.seq)
    prior.seq = Math.max(prior.seq, event.seq)
    prior.count++
    groups.set(key, prior)
  }
  const points = [...groups.values()].sort((a, b) => {
    if (a.day == null && b.day == null) return a.seq - b.seq
    if (a.day == null) return 1
    if (b.day == null) return -1
    return a.day - b.day || a.seq - b.seq
  })
  const validDays = points.filter((point) => point.day != null).map((point) => point.day)
  const minDay = validDays.length ? Math.min(...validDays) : 0
  const maxDay = validDays.length ? Math.max(...validDays) : minDay
  for (const [index, point] of points.entries()) {
    point.position = point.day == null || maxDay === minDay
      ? (points.length <= 1 ? 50 : index / (points.length - 1) * 100)
      : (point.day - minDay) / (maxDay - minDay) * 100
    point.density = Math.max(1, Math.min(5, Math.round(Math.sqrt(point.count))))
  }
  return points
}

export function timelinePointForDay(points = [], requestedDay = 0) {
  if (!points.length) return null
  const dated = points.filter((point) => point.day != null)
  if (!dated.length) return points.at(-1)
  let chosen = dated[0]
  for (const point of dated) {
    if (point.day > requestedDay) break
    chosen = point
  }
  return chosen
}

const EVENT_SUMMARY_KIND = {
  'node.created': '新增节点', 'claim.created': '新增观点', 'inference.created': '新增观点',
  'evidence.appended': '新增证据', 'relation.declared': '关系变化', 'correction.appended': '内容更正',
  'node.renamed': '改名', 'node.invalidated': '失效', 'node.archived': '归档',
  'node.restored': '恢复', 'settlement.recorded': '结算',
}

export function timelineChangeSummary(events = [], fromSeq = 0, toSeq = Number.MAX_SAFE_INTEGER) {
  const rows = (Array.isArray(events) ? events : []).filter((event) => Number.isSafeInteger(event?.seq)
    && event.seq > fromSeq && event.seq <= toSeq)
  if (!rows.length) return '该时点与上一刻度之间没有新增账本事件。'
  const counts = new Map()
  for (const event of rows) {
    const label = event.type === 'relation.declared' && event.payload?.reviewOf
      ? (event.payload.reviewDecision === 'confirmed' ? '确认' : '驳回')
      : EVENT_SUMMARY_KIND[event.type] || '其他事件'
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(' · ')
}

function hashId(value) {
  let hash = 2166136261
  for (const char of String(value)) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function nodeDimensions(node) {
  const type = networkNodeType(node)
  return { w: type === 'evidence' ? 144 : 156, h: 72 }
}

/**
 * Deterministic force-directed layout for a fixed, complete topic history.
 * Call once from the current verified projection, then reuse its positions for
 * every replay prefix so dates never trigger a different arrangement.
 */
export function layoutThemeNetwork(nodes = [], edges = [], width = 1120) {
  const rows = [...(Array.isArray(nodes) ? nodes : [])]
    .filter((node) => node && node.id != null)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const size = new Map(rows.map((node) => [node.id, nodeDimensions(node)]))
  const pos = new Map()
  if (!rows.length) return { pos, size, width, height: 360 }

  const count = rows.length
  const byId = new Map(rows.map((node) => [node.id, node]))
  const links = (Array.isArray(edges) ? edges : [])
    .filter((edge) => byId.has(edge?.from) && byId.has(edge?.to) && edge.from !== edge.to)
    .sort((a, b) => String(a.from).localeCompare(String(b.from))
      || String(a.to).localeCompare(String(b.to))
      || String(a.rel).localeCompare(String(b.rel))
      || (Number(a.seq) || 0) - (Number(b.seq) || 0)
      || String(a.id).localeCompare(String(b.id)))

  /* DFS 初始排序：从度数最高的节点出发深度优先遍历——链式论证在
     DFS 序列中保持连续；论证边邻居优先于弱关联邻居。相连节点在序列
     中相邻，再蛇形填网格，相邻即相近。 */
  const adjacency = new Map(rows.map((node) => [node.id, []]))
  const argSet = new Set()
  for (const edge of links) {
    adjacency.get(edge.from).push(edge.to)
    adjacency.get(edge.to).push(edge.from)
    if (edge.relationGroup === 'argument' || ARGUMENT_RELATIONS.includes(edge.rel)) {
      argSet.add(`${edge.from}→${edge.to}`)
      argSet.add(`${edge.to}→${edge.from}`)
    }
  }
  for (const [id, list] of adjacency) {
    list.sort((a, b) => (argSet.has(`${b}→${id}`) - argSet.has(`${a}→${id}`))
      || String(a).localeCompare(String(b)))
  }
  const degree = (id) => adjacency.get(id).length
  const startId = [...adjacency.keys()].sort((a, b) => degree(b) - degree(a) || String(a).localeCompare(String(b)))[0]
  const dfsOrder = []
  const seen = new Set()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    dfsOrder.push(id)
    const neighbors = adjacency.get(id).filter((next) => !seen.has(next))
    for (let k = neighbors.length - 1; k >= 0; k--) stack.push(neighbors[k])
  }
  for (const node of rows) {
    if (!seen.has(node.id)) { seen.add(node.id); dfsOrder.push(node.id) }
  }
  const marginX = 112
  const gapX = 188
  const gapY = 116
  const columns = Math.max(1, Math.floor((width - marginX * 2) / gapX) + 1)
  const rowCount = Math.ceil(count / columns)
  const height = Math.max(420, 96 + rowCount * gapY)
  /* 蛇形填网格：偶数行左→右、奇数行右→左，DFS 相邻节点永不跨行跳变。 */
  dfsOrder.forEach((id, i) => {
    const row = Math.floor(i / columns)
    const colInRow = i % columns
    const col = row % 2 === 0 ? colInRow : columns - 1 - colInRow
    pos.set(id, {
      x: Math.max(84, Math.min(width - 84, marginX + col * gapX)),
      y: Math.max(56, Math.min(height - 48, 62 + row * gapY)),
    })
  })
  const iterations = Math.max(24, Math.min(80, Math.round(5200 / Math.max(1, Math.sqrt(count)))))
  for (let iteration = 0; iteration < iterations; iteration++) {
    const cooling = 1 - iteration / iterations
    const fx = new Map(rows.map((node) => [node.id, 0]))
    const fy = new Map(rows.map((node) => [node.id, 0]))
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]
      const pa = pos.get(a.id)
      const sa = size.get(a.id)
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j]
        const pb = pos.get(b.id)
        const sb = size.get(b.id)
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          const angle = (hashId(`${a.id}:${b.id}`) % 6283) / 1000
          dx = Math.cos(angle) * 0.1; dy = Math.sin(angle) * 0.1; distance = 0.1
        }
        const minX = (sa.w + sb.w) / 2 + 22
        const minY = (sa.h + sb.h) / 2 + 22
        if (distance < 310) {
          const overlap = Math.max(0, Math.min(minX - Math.abs(dx), minY - Math.abs(dy)))
          const magnitude = (overlap > 0 ? overlap * 0.045 : 11 / distance) * cooling
          const nx = dx / distance * magnitude
          const ny = dy / distance * magnitude
          fx.set(a.id, fx.get(a.id) + nx); fy.set(a.id, fy.get(a.id) + ny)
          fx.set(b.id, fx.get(b.id) - nx); fy.set(b.id, fy.get(b.id) - ny)
        }
      }
    }
    for (const edge of links) {
      const a = pos.get(edge.from)
      const b = pos.get(edge.to)
      let dx = b.x - a.x
      let dy = b.y - a.y
      const distance = Math.hypot(dx, dy) || 1
      const isAssociation = edge.relationGroup === 'association' || ASSOCIATION_RELATIONS.includes(edge.rel)
      /* 论证边是阅读主干：目标更短、弹簧更强；关联边保持疏松。 */
      const target = isAssociation ? 235 : 168
      const strength = edge.pendingReview ? 0.2 : isAssociation ? 0.3 : 0.7
      const magnitude = Math.max(-28, Math.min(28, (distance - target) * 0.004 * strength)) * cooling
      dx = dx / distance * magnitude; dy = dy / distance * magnitude
      fx.set(edge.from, fx.get(edge.from) + dx); fy.set(edge.from, fy.get(edge.from) + dy)
      fx.set(edge.to, fx.get(edge.to) - dx); fy.set(edge.to, fy.get(edge.to) - dy)
    }
    for (const node of rows) {
      const point = pos.get(node.id)
      const pullX = (width / 2 - point.x) * 0.0008
      const pullY = (height / 2 - point.y) * 0.0008
      point.x = Math.max(84, Math.min(width - 84, point.x + Math.max(-12, Math.min(12, fx.get(node.id) + pullX))))
      point.y = Math.max(48, Math.min(height - 40, point.y + Math.max(-12, Math.min(12, fy.get(node.id) + pullY))))
    }
  }

  // Final deterministic collision pass; this affects the initial layout only, never replay.
  for (let pass = 0; pass < 24; pass++) {
    let moved = false
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]
      const pa = pos.get(a.id)
      const sa = size.get(a.id)
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j]
        const pb = pos.get(b.id)
        const sb = size.get(b.id)
        const minX = (sa.w + sb.w) / 2 + 10
        const minY = (sa.h + sb.h) / 2 + 10
        const dx = pa.x - pb.x
        const dy = pa.y - pb.y
        const overlapX = minX - Math.abs(dx)
        const overlapY = minY - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue
        moved = true
        if (overlapX < overlapY) {
          const shift = (dx >= 0 ? 1 : -1) * (overlapX / 2 + 1)
          pa.x += shift; pb.x -= shift
        } else {
          const shift = (dy >= 0 ? 1 : -1) * (overlapY / 2 + 1)
          pa.y += shift; pb.y -= shift
        }
      }
    }
    if (!moved) break
  }
  for (const node of rows) {
    const point = pos.get(node.id)
    const dim = size.get(node.id)
    point.x = Math.max(dim.w / 2 + 8, Math.min(width - dim.w / 2 - 8, point.x))
    point.y = Math.max(dim.h / 2 + 8, Math.min(height - dim.h / 2 - 8, point.y))
  }
  return { pos, size, width, height }
}
