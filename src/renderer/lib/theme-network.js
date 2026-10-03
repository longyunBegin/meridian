export const NETWORK_NODE_TYPES = ['concept', 'object', 'event', 'viewpoint', 'evidence']
export const ARGUMENT_RELATIONS = ['supports', 'derives', 'contradicts']
export const REVISION_RELATIONS = ['supersedes']
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
  supersedes: { label: '修订版本', group: 'revision', color: '#d89b49' },
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

/**
 * 分类色（设计提案 ④）：分类是主题自定义的词表，颜色只表达"属于哪一类"，
 * 不绑领域类型——所以按词表顺序取色，词表变了颜色跟着走。
 */
export const CATEGORY_COLORS = ['#0a84ff', '#30b0c7', '#af52de', '#ff9500', '#34c759', '#ff375f', '#5e5ce6', '#8e8e93']

export function categoryColor(categories = [], category = '') {
  const name = String(category || '').trim()
  if (!name) return null
  const index = (Array.isArray(categories) ? categories : []).map((item) => String(item || '').trim()).indexOf(name)
  return CATEGORY_COLORS[(index >= 0 ? index : CATEGORY_COLORS.length - 1) % CATEGORY_COLORS.length]
}

/**
 * 图谱 LOD（设计提案 02）：缩放 <0.75 只画点（不画字）；0.75–1.15 画卡片不画字；
 * >1.15 才出标题。文字是 SVG/canvas 里最贵的东西。≥600 节点强制点阵。
 */
export function graphLodLevel(scale, heavy = false) {
  if (heavy) return 'dots'
  const value = Number(scale)
  if (!Number.isFinite(value) || value < 0.75) return 'dots'
  return value <= 1.15 ? 'cards' : 'cards-labels'
}

export const GRAPH_LOD_LABEL = { dots: '点阵', cards: '卡片', 'cards-labels': '卡片+标题' }

/**
 * 读者视角的状态：由账本里的证据与关系推导，而不是节点自身的复核状态。
 * 陌生主题第一眼要看的是"哪里被佐证、哪里被挑战、哪里还没动过"——
 * 而节点自身的 status 往往全是"待复核"，那个维度对读者没有信息量。
 */
export const READER_STATE_META = {
  supported: { label: '已佐证', color: '#34c759', text: '#08240f' },
  challenged: { label: '受挑战', color: '#ff3b30', text: '#ffffff' },
  contested: { label: '有争议', color: '#ff9500', text: '#1d1d1f' },
  evidenced: { label: '有证据·未表态', color: '#0a84ff', text: '#ffffff' },
  unevaluated: { label: '未评估', color: '#8e8e93', text: '#ffffff' },
  archived: { label: '已归档', color: '#8390a0', text: '#ffffff' },
  invalidated: { label: '已失效', color: '#ad756a', text: '#ffffff' },
}

/** 一个原子的读者状态。summary 用 evidenceForNode() 的口径（supports/against/both/unclassified）。 */
export function readerStateKey(node, summary = null) {
  if (node?.archived) return 'archived'
  if (node?.invalidated) return 'invalidated'
  if (!summary) return 'unevaluated'
  const supports = (summary.supports?.length || 0) + (summary.both?.length || 0)
  const against = (summary.against?.length || 0) + (summary.both?.length || 0)
  if (supports && against) return 'contested'
  if (supports) return 'supported'
  if (against) return 'challenged'
  /* 挂了数据但还没声明立场：这是账本里最常见的真实状态，必须和"完全没数据"区分开。 */
  if ((summary.unclassified?.length || 0) > 0 || (summary.total || 0) > 0) return 'evidenced'
  return 'unevaluated'
}

/**
 * 证据挂载边：归位/入库写的是 evidence.appended + targetNodeIds，那是"证据已挂上、
 * 但用户还没声明立场"的连接。它没有对应的 relation.declared 事件，所以过去在图上
 * 完全看不见——21 个节点会显示成 21 个孤立的点。
 *
 * 这里把它单独派生出来给画布用：灰点线、无箭头，绝不冒充支持/反驳。
 * 同一对节点已经有声明关系时跳过，避免两条线叠在一起。
 */
export function evidenceAttachmentEdges(nodes = [], declaredEdges = []) {
  const rows = Array.isArray(nodes) ? nodes : []
  const byId = new Map(rows.map((node) => [node?.id, node]).filter(([id]) => id != null))
  const declared = new Set()
  for (const edge of Array.isArray(declaredEdges) ? declaredEdges : []) {
    if (!edge?.from || !edge?.to) continue
    declared.add(`${edge.from}->${edge.to}`)
    declared.add(`${edge.to}->${edge.from}`)
  }
  const derived = []
  for (const node of rows) {
    if (networkNodeType(node) !== 'evidence') continue
    for (const targetId of node.targetNodeIds || []) {
      if (!byId.has(targetId) || targetId === node.id) continue
      if (declared.has(`${node.id}->${targetId}`)) continue
      derived.push({
        id: `attached:${node.id}:${targetId}`,
        eventId: `attached:${node.id}:${targetId}`,
        from: node.id,
        to: targetId,
        rel: 'evidence-attached',
        relationGroup: 'evidence',
        seq: Number(node.createdSeq) || 0,
        derived: true,
      })
    }
  }
  return derived
}

export function truncateGraphemes(value, limit, suffix = '…') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const parts = typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
    : Array.from(text)
  return parts.length > limit ? `${parts.slice(0, Math.max(0, limit - 1)).join('')}${suffix}` : text
}

function titleGraphemes(value) {
  return typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].map((part) => part.segment)
    : Array.from(value)
}

function titleWidthUnits(grapheme) {
  if (/^\s+$/u.test(grapheme)) return 0.32
  if (/[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(grapheme)
    || /[\u3000-\u303f\uff00-\uffef]/u.test(grapheme)) return 1
  if (/^[ilI.,'`:;!|]$/u.test(grapheme)) return 0.34
  if (/^[MW@#%&]$/u.test(grapheme)) return 0.82
  if (/^[A-Z0-9]$/u.test(grapheme)) return 0.64
  return 0.56
}

function titleLineWidth(value) {
  return titleGraphemes(value).reduce((total, part) => total + titleWidthUnits(part), 0)
}

export function splitNetworkTitle(value, maxPerLine = 14, maxLines = 2) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim() || '未命名'
  const limit = Math.max(1, Number(maxPerLine) || 1)
  const lineLimit = Math.max(1, Math.floor(Number(maxLines) || 1))
  const parts = titleGraphemes(text)
  const lines = []
  let line = ''
  let used = 0
  let truncated = false
  for (const part of parts) {
    const width = titleWidthUnits(part)
    if (used + width > limit && line.trim()) {
      lines.push(line.trimEnd())
      line = ''
      used = 0
      if (lines.length >= lineLimit) { truncated = true; break }
      if (/^\s+$/u.test(part)) continue
    }
    if (!line && /^\s+$/u.test(part)) continue
    line += part
    used += width
  }
  if (line.trim()) {
    if (lines.length < lineLimit) lines.push(line.trimEnd())
    else truncated = true
  }
  if (!lines.length) return ['未命名']
  if (truncated) {
    let parts = titleGraphemes(lines.at(-1))
    while (parts.length && titleLineWidth(parts.join('')) + titleWidthUnits('…') > limit) parts.pop()
    lines[lines.length - 1] = `${parts.join('').trimEnd()}…`
  }
  return lines
}

export function nodeTitleCharsPerLine(cardWidth, fontSize = 11, horizontalPadding = 24) {
  const width = Number(cardWidth)
  const size = Number(fontSize)
  const padding = Number(horizontalPadding)
  if (!Number.isFinite(width) || !Number.isFinite(size) || size <= 0) return 1
  return Math.max(1, Math.floor((width - (Number.isFinite(padding) ? Math.max(0, padding) : 0)) / size))
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

/** One replay stop for every ledger event; sequence, not wall-clock order, is authoritative. */
export function buildEventTimeline(events = []) {
  const rows = (Array.isArray(events) ? events : [])
    .filter((event) => event && Number.isSafeInteger(event.seq) && event.seq > 0)
    .sort((a, b) => a.seq - b.seq)
  return rows.map((event, index) => {
    const parsed = dateKeyFor(event)
    return {
      seq: event.seq,
      eventId: event.id || null,
      eventType: event.type || null,
      date: parsed?.date || '日期未记录',
      day: parsed?.day ?? null,
      count: event.seq,
      position: index,
    }
  })
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

/** 尺寸即强度：confidence 0-100 映射到 0.84–1.16 的缩放；布局间距与碰撞检测同步跟随。 */
function nodeDimensions(node) {
  const type = networkNodeType(node)
  /* 证据是"数据点"：卡片明显小于观点原子，一眼就能看出谁是论点、谁是数据。 */
  const base = type === 'evidence' ? { w: 128, h: 38 } : { w: 156, h: 72 }
  /* 没有强度（null/undefined）＝中性尺寸：注意 Number(null) 是 0，别把它当成"强度 0"。 */
  const raw = node?.confidence ?? node?.strength
  const strength = raw == null ? 50 : Math.max(0, Math.min(100, Number(raw) || 0))
  const scale = 0.84 + (strength / 100) * 0.32
  return { w: Math.round(base.w * scale), h: Math.round(base.h * scale) }
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
    if (edge.relationGroup === 'argument' || ARGUMENT_RELATIONS.includes(edge.rel)
      || edge.relationGroup === 'revision' || REVISION_RELATIONS.includes(edge.rel)) {
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
  /* 边距与间距跟着画布宽度走：面板窄（读者视图常只有 ~500px）时若还用 112px 边距 + 188px 列距，
     只能塞下两列、整张图被拉成一长条；自适应后能塞三列，卡片也保持原始可读尺寸。
     宽度 ≥1120 时这些值等于原来的常量，宽画布行为不变。 */
  /* 规模降级（设计提案 03）：≥600 节点放弃力导向松弛与干涉消除，纯网格密排——
     如实降级，而不是卡死或假装画完了。调用方拿 heavy 去把画布切成点阵并标注。 */
  const heavy = count > 600
  const marginX = heavy ? 16 : Math.round(Math.min(112, Math.max(56, width * 0.1)))
  const gapY = heavy ? 16 : Math.round(Math.min(116, Math.max(104, width * 0.104)))
  const gapX = heavy ? 26 : Math.round(Math.min(188, Math.max(148, (width - marginX * 2) / 3.6)))
  const columns = heavy
    ? Math.max(1, Math.min(count, Math.floor(width / gapX)))
    : Math.max(1, Math.floor((width - marginX * 2) / gapX) + 1)
  const rowCount = Math.ceil(count / columns)
  /* 行高按该行最高卡片取步进：证据数据点只有 38px 高，若还按统一的 104px 走，
     纯证据行会白留一大截高度（21 节点时能差出 ~140px 的空白）。 */
  const rowTop = [62]
  for (let row = 0; row < rowCount; row++) {
    if (heavy) { rowTop[row + 1] = rowTop[row] + gapY; continue }
    let tallest = 0
    for (let col = 0; col < columns; col++) {
      const node = dfsOrder[row * columns + col]
      if (!node) continue
      tallest = Math.max(tallest, size.get(node)?.h || 0)
    }
    rowTop[row + 1] = rowTop[row] + Math.max(64, Math.round(tallest + 32), Math.round(gapY * 0.6))
  }
  let height = Math.max(420, Math.round(rowTop[rowCount] + 40))
  /* 蛇形填网格：偶数行左→右、奇数行右→左，DFS 相邻节点永不跨行跳变。 */
  dfsOrder.forEach((id, i) => {
    const row = Math.floor(i / columns)
    const colInRow = i % columns
    const col = row % 2 === 0 ? colInRow : columns - 1 - colInRow
    pos.set(id, {
      x: Math.max(84, Math.min(width - 84, marginX + col * gapX)),
      y: Math.max(56, Math.min(height - 48, rowTop[row])),
    })
  })
  const iterations = heavy ? 0 : Math.max(24, Math.min(80, Math.round(5200 / Math.max(1, Math.sqrt(count)))))
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
      /* 论证边与修订链是阅读主干；弱主题关联保持疏松；证据挂载用中等距离
         （数据点卡片比观点卡小得多，不需要拉那么远，图也能矮一截）。 */
      const isAttachment = edge.relationGroup === 'evidence'
      const isAssociation = edge.relationGroup === 'association' || ASSOCIATION_RELATIONS.includes(edge.rel)
      const isRevision = edge.relationGroup === 'revision' || REVISION_RELATIONS.includes(edge.rel)
      const target = isAttachment ? 150 : isAssociation ? 235 : isRevision ? 190 : 168
      const strength = edge.pendingReview ? 0.2 : isAttachment ? 0.45 : isAssociation ? 0.3 : isRevision ? 0.48 : 0.7
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
  for (let pass = 0; pass < (heavy ? 0 : 24); pass++) {
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
  /* 高度收敛到实际内容：力导会把手底下的节点往上拉，按网格行数算的高度会剩一截空白
     （实测 86px，纯粹是多余滚动）。位置不变，只是不再留空。 */
  let contentBottom = 0
  for (const node of rows) {
    const point = pos.get(node.id)
    const dim = size.get(node.id)
    contentBottom = Math.max(contentBottom, point.y + (dim?.h || 0) / 2)
  }
  height = Math.max(420, Math.round(contentBottom + 32))
  return { pos, size, width, height, heavy }
}
