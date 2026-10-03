import { h } from '../lib/dom.js'
import { svgEl, svgText } from '../lib/theme-network-render.js'
import { claimEvidenceStats } from './reader-claim-map.js'
import { categoryColor } from '../lib/theme-network.js'
import { UNCATEGORIZED_LABEL } from '../lib/reader-model.js'
import { RELATION_LABEL } from '../lib/chain-ui-model.js'

/**
 * 观点图谱（簇 + 原子气泡）——借鉴用户给的第二个 demo：deepseek_html_20261003_6194d3.html
 *
 * 借鉴的三点（都能落到 Meridian 的真实数据上）
 * 1. **簇 = 固定圆心 + 半径**，簇内原子按**向日葵螺旋**（黄金角 2.39996）摆放：
 *    确定性布局，同样的数据每次画在同一处；不用力导向（力导向会把没有结构的图排成一团糊）。
 * 2. **气泡半径 ∝ √(已表态来源数)**；颜色 = 该簇的证据状况；虚线圆 = 一个来源都没有。
 * 3. **标题默认隐藏，悬浮/选中才显示**——这是 demo 治"信息太多"的关键手法。
 *
 * 分簇依据（用户已确认按 (a)）：按证据状况——有争议 / 没有来源 / 单一来源 / 多来源一致。
 * 簇间连线用**真实的观点之间关系**（relation.declared；已驳回的边在 reader 上游已过滤），没有关系就不画。
 * 不借鉴的：证据"权重"（账本里没有这个字段）；demo 里那些固定簇间线（数据里没有对应关系）。
 */

const GROUP_ORDER = ['contested', 'none', 'single', 'settled']
const GROUPS = {
  contested: { label: '有争议', hint: '同时收到支持与反对', color: 'var(--red)' },
  none: { label: '没有来源', hint: '一个已表态来源都没有', color: 'var(--text-3)' },
  single: { label: '单一来源', hint: '只有 1 家来源', color: 'var(--orange)' },
  settled: { label: '多来源一致', hint: '2 家以上来源，且没有反对', color: 'var(--green)' },
}

const short = (node, max = 10) => {
  const text = String(node?.title || node?.label || '未命名观点').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 强度：confidence/strength 为 null 表示"没有记录"，不是 0（Number(null) === 0 这个坑要避开）。 */
const strengthOf = (node) => {
  const raw = node?.confidence ?? node?.strength
  if (raw == null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export function renderReaderClusterMap({ claims = [], edges = [], themeCategories = [], evidenceForNode, selectedId = null, onOpenClaim } = {}) {
  if (!claims.length) return h('div', { class: 'rdr-cluster-empty' }, '还没有可以画成图谱的观点。')

  const rows = claims.map((node) => ({ node, ...claimEvidenceStats(node, evidenceForNode), strength: strengthOf(node) }))
  /* 簇 = **主题自定义分类**（建设者在「主题设置 → 分类管理」里定义、新建观点时选的那一档）——
     这是唯一"能被归类"的轴；没有分类的观点按模型的既定回落显示为「未分类」。
     证据状况（有争议/单一来源/…）是**派生状态**，不是分类，所以它只用来给气泡上色。 */
  const categoryOf = (node) => String(node?.atomCategory || '').trim() || UNCATEGORIZED_LABEL
  const order = [...(Array.isArray(themeCategories) ? themeCategories : [])]
  const groups = []
  for (const row of rows) {
    const name = categoryOf(row.node)
    let group = groups.find((g) => g.name === name)
    if (!group) { group = { name, rows: [], color: categoryColor(order, name) }; groups.push(group) }
    group.rows.push(row)
  }
  /* 顺序：主题词表的顺序优先，未分类放最后；簇内按证据数降序（有据的先看）。 */
  groups.sort((a, b) => {
    const ai = order.indexOf(a.name), bi = order.indexOf(b.name)
    if (a.name === UNCATEGORIZED_LABEL) return 1
    if (b.name === UNCATEGORIZED_LABEL) return -1
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
  for (const group of groups) group.rows.sort((a, b) => b.stated - a.stated || String(a.node.id).localeCompare(String(b.node.id)))

  /* 固定分区：按簇数排成一行/网格；圆半径随成员数增长（√ 尺度，避免大簇吞掉小簇）。 */
  const width = 880
  const cols = Math.min(3, groups.length)
  const rowCount = Math.ceil(groups.length / cols)
  const cellW = width / cols
  const cellH = 250
  const height = Math.max(250, rowCount * cellH)

  const place = new Map()
  groups.forEach((group, index) => {
    const cx = cellW * (index % cols) + cellW / 2
    const cy = Math.floor(index / cols) * cellH + cellH / 2
    group.cx = cx
    group.cy = cy
    group.r = Math.min(cellW, cellH) / 2 - 30 + Math.sqrt(group.rows.length) * 5
    group.rows.forEach((row, i) => {
      /* 向日葵螺旋：i=0 落在圆心，之后按黄金角铺开（与 demo 同一手法）。 */
      const angle = i * 2.39996 + cx * 0.01
      const spread = group.rows.length === 1 ? 0 : group.r * 0.5 * Math.sqrt((i + 0.5) / group.rows.length)
      place.set(row.node.id, {
        x: cx + Math.cos(angle) * spread,
        y: cy + Math.sin(angle) * spread * 0.85,
        r: 6 + Math.sqrt(Math.max(0, row.stated)) * 3,
        row,
        group,
      })
    })
  })

  const svg = svgEl('svg', {
    class: 'rdr-cluster-canvas', viewBox: `0 0 ${width} ${height}`,
    role: 'group', 'aria-label': '观点图谱：大圆是证据状况分组，圆内每个气泡是一条观点，气泡大小表示已表态来源数',
  })

  /* 簇间连线：用真实的观点之间关系（跨簇才画）。 */
  const claimIds = new Set(claims.map((node) => node.id))
  for (const edge of edges) {
    if (!claimIds.has(edge?.from) || !claimIds.has(edge?.to)) continue
    const a = place.get(edge.from)
    const b = place.get(edge.to)
    if (!a || !b || a.group.name === b.group.name) continue
    const line = svgEl('line', {
      class: 'rdr-cluster-link', x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      'stroke-dasharray': edge.rel === 'contradicts' ? '4 4' : '0',
    })
    const tip = svgEl('title', {})
    tip.textContent = RELATION_LABEL?.[edge.rel] || edge.rel || '关系'
    line.append(tip)
    svg.append(line)
  }

  /* 簇背景圆 + 簇标签 */
  for (const group of groups) {
    const bg = svgEl('g', { class: 'rdr-cluster-bg' })
    bg.append(svgEl('circle', {
      cx: group.cx, cy: group.cy, r: group.r, class: 'rdr-cluster-bg-circle',
      stroke: group.color, fill: group.color,
    }))
    bg.append(svgText(`${group.name} · ${group.rows.length}`, {
      class: 'rdr-cluster-bg-label', x: group.cx, y: group.cy - group.r + 16, 'text-anchor': 'middle',
    }))
    svg.append(bg)
  }

  /* 原子气泡：标题默认隐藏（CSS 控），悬浮或选中才显示。 */
  for (const row of rows) {
    const point = place.get(row.node.id)
    if (!point) continue
    const meta = GROUPS[row.state] || GROUPS.none
    const bubble = svgEl('g', {
      class: `rdr-cluster-bubble is-${row.state}${row.node.id === selectedId ? ' is-selected' : ''}`,
      tabindex: '0', role: 'button',
      transform: `translate(${point.x} ${point.y})`,
      'aria-label': `观点「${row.node.title || '未命名观点'}」：支持 ${row.support} · 反对 ${row.challenge} · 独立来源 ${row.sources} 家（${meta.label}）`,
    })
    bubble.append(svgEl('circle', { r: point.r, class: 'rdr-cluster-circle', fill: meta.color, stroke: meta.color }))
    bubble.append(svgText(short(row.node), { class: 'rdr-cluster-bubble-label', y: point.r + 12, 'text-anchor': 'middle' }))
    const tip = svgEl('title', {})
    tip.textContent = `${row.node.title || '未命名观点'}\n支持 ${row.support} · 反对 ${row.challenge} · 独立来源 ${row.sources} 家\n${meta.label}：${meta.hint}`
    bubble.append(tip)
    if (typeof onOpenClaim === 'function') {
      bubble.addEventListener('click', () => onOpenClaim(row.node.id))
      bubble.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenClaim(row.node.id) }
      })
    }
    svg.append(bubble)
  }

  /* 紧凑清单（demo 的 compact 区）：一簇一段，一行一条观点。 */
  const list = h('div', { class: 'rdr-cluster-wrap' },
    ...groups.map((group, gi) => h('section', { class: 'rdr-cluster-group', id: `rdr-cluster-${gi}` },
      h('div', { class: 'rdr-cluster-head' },
        h('span', { class: 'rdr-cluster-dot', style: `background:${group.color}` }),
        h('span', { class: 'rdr-cluster-head-title' }, group.name),
        h('span', { class: 'rdr-cluster-head-count' }, `${group.rows.length} 条`)),
      ...group.rows.map((row) => h('div', { class: `rdr-cluster-row${row.node.id === selectedId ? ' is-selected' : ''}` },
        h('button', {
          type: 'button', class: 'rdr-cluster-claim', dataset: { claimId: row.node.id },
          onclick: () => onOpenClaim?.(row.node.id),
        }, String(row.node.title || '未命名观点')),
        h('span', { class: `rdr-cluster-row-state is-${row.state}` }, (GROUPS[row.state] || GROUPS.none).label),
        h('span', { class: 'rdr-cluster-row-strength' }, row.strength ? `${row.strength}%` : '未记录'),
        h('span', { class: 'rdr-cluster-row-counts' },
          row.stated ? `支持 ${row.support} · 反对 ${row.challenge}` : '还没有已表态的来源'))))))

  return h('div', { class: 'rdr-cluster-body' },
    svg,
    h('p', { class: 'rdr-cluster-caliber' },
      '大圆 = 主题分类（在「主题设置 → 分类管理」里定义；没分类的观点归入「未分类」）· '
      + '圆内每个气泡 = 一条观点（大小 = 已表态来源数）· 气泡颜色 = 证据状况 · '
      + '悬浮或选中才显示标题 · 连线 = 观点之间的真实关系'),
    list)
}
