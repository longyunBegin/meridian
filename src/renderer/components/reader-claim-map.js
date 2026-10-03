import { h } from '../lib/dom.js'
import { svgEl, svgText } from '../lib/theme-network-render.js'
import { layoutThemeNetwork } from '../lib/theme-network.js'
import { RELATION_LABEL } from '../lib/chain-ui-model.js'

/**
 * 第 ② 层「观点地图」：让读者一眼看到"这主题的骨架 + 哪里空着"。
 *
 * 具象规则（口径写在图例里，全部由真实数据推导）
 * - 圆的大小 = **已表态来源条数**（支持+反对；挂载但未表态的不计入——两个数不同，图例里说清）；
 * - 圆的颜色 = **证据状况**（没有来源 / 单一来源 / 有争议 / 多来源一致），
 *   **不按强度**：confidence 为 null 表示"中性、还没有强度记录"，不是"强度 0"（Number(null) === 0 这个坑要避开）；
 * - 虚线圆 = 一个来源都还没有（= 缺口）；
 * - 连线 = 观点之间的已声明关系（用 RELATION_LABEL 说人话）。
 * 位置复用 layoutThemeNetwork（与关系图同一套布局），不新造布局算法。
 */

export const CLAIM_STATES = {
  none: { label: '没有来源', desc: '还没有任何已表态来源', color: 'var(--text-3)', dashed: true },
  single: { label: '单一来源', desc: '只有 1 家来源', color: 'var(--orange)', dashed: false },
  contested: { label: '有争议', desc: '同时收到支持与反对', color: 'var(--red)', dashed: false },
  settled: { label: '多来源一致', desc: '2 家以上来源，且没有反对', color: 'var(--green)', dashed: false },
}

export function claimStateOf({ support = 0, challenge = 0, sources = 0 } = {}) {
  if (support + challenge === 0) return 'none'
  if (support > 0 && challenge > 0) return 'contested'
  if (sources <= 1) return 'single'
  return 'settled'
}

/** 观点 → 证据状况（供地图与单条下钻共用，避免两处口径分叉）。 */
export function claimEvidenceStats(node, evidenceForNode) {
  let rows = null
  try { rows = evidenceForNode?.(node?.id) || null } catch { rows = null }
  const list = [...(rows?.supports || []), ...(rows?.against || []), ...(rows?.both || [])]
  const support = (rows?.supports?.length || 0) + (rows?.both?.length || 0)
  const challenge = (rows?.against?.length || 0) + (rows?.both?.length || 0)
  const labels = new Set(list
    .map((row) => String(row?.source?.provenance?.sourceLabel || row?.source?.sourceLabel || '').trim())
    .filter(Boolean))
  const sources = labels.size
  return { support, challenge, sources, stated: list.length, state: claimStateOf({ support, challenge, sources }) }
}

const shortTitle = (node) => {
  const title = String(node?.title || node?.label || '未命名观点').trim()
  return title.length > 14 ? `${title.slice(0, 13)}…` : title
}

export function renderReaderClaimMap({ claims = [], edges = [], gaps = [], evidenceForNode, selectedId = null, onOpenClaim } = {}) {
  if (!claims.length) {
    return h('div', { class: 'rdr-map-empty' }, '还没有可以画成地图的观点——这个主题目前只有节点与来源。')
  }

  const stats = new Map(claims.map((node) => [node.id, claimEvidenceStats(node, evidenceForNode)]))
  const gapCount = gaps.length
  const emptyCount = [...stats.values()].filter((row) => row.state === 'none').length
  const width = 880
  const layout = layoutThemeNetwork(claims, edges, width)
  const height = Math.max(260, Math.min(440, layout?.height || 320))

  const radiusOf = (id) => {
    const s = stats.get(id)
    return 18 + Math.min(7, (s?.support || 0) + (s?.challenge || 0)) * 4
  }

  const svg = svgEl('svg', {
    class: 'rdr-map-canvas', viewBox: `0 0 ${width} ${height}`,
    role: 'group', 'aria-label': '观点地图：圆的大小表示已表态来源条数，颜色表示证据状况',
  })

  /* 观点之间的关系（只画两端都是观点的已声明关系；被驳回的边 reader-model 已过滤）。 */
  const claimIds = new Set(claims.map((node) => node.id))
  for (const edge of edges) {
    if (!claimIds.has(edge?.from) || !claimIds.has(edge?.to)) continue
    const a = layout.pos.get(edge.from)
    const b = layout.pos.get(edge.to)
    if (!a || !b) continue
    const line = svgEl('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: 'rdr-map-link', 'stroke-dasharray': edge.rel === 'contradicts' ? '4 4' : '0',
    })
    const lineTip = svgEl('title', {})
    lineTip.textContent = RELATION_LABEL?.[edge.rel] || edge.rel || '关系'
    line.append(lineTip)
    svg.append(line)
  }

  for (const node of claims) {
    const point = layout.pos.get(node.id)
    if (!point) continue
    const s = stats.get(node.id) || { support: 0, challenge: 0, sources: 0, state: 'none' }
    const meta = CLAIM_STATES[s.state] || CLAIM_STATES.none
    const r = radiusOf(node.id)
    const group = svgEl('g', {
      class: `rdr-map-bubble is-${s.state}${node.id === selectedId ? ' is-selected' : ''}`,
      tabindex: '0', role: 'button',
      'aria-label': `观点「${node.title || '未命名观点'}」：支持 ${s.support} · 反对 ${s.challenge} · 独立来源 ${s.sources} 家（${meta.label}）`,
      transform: `translate(${point.x} ${point.y})`,
    })
    group.append(svgEl('circle', {
      r, class: 'rdr-map-circle',
      stroke: meta.color,
      'stroke-dasharray': meta.dashed ? '5 5' : '0',
      fill: s.state === 'none' ? 'transparent' : meta.color,
    }))
    const label = svgText(shortTitle(node), { class: 'rdr-map-label', y: r + 15, 'text-anchor': 'middle' })
    group.append(label)
    const tip = svgEl('title', {})
    tip.textContent = `${node.title || '未命名观点'}\n支持 ${s.support} · 反对 ${s.challenge} · 独立来源 ${s.sources} 家\n${meta.label}：${meta.desc}`
    group.append(tip)
    if (typeof onOpenClaim === 'function') {
      group.addEventListener('click', () => onOpenClaim(node.id))
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenClaim(node.id) }
      })
    }
    svg.append(group)
  }

  const legend = h('ul', { class: 'rdr-map-legend' },
    ...Object.entries(CLAIM_STATES).map(([key, meta]) => h('li', { class: `rdr-map-legend-item is-${key}` },
      h('span', { class: 'rdr-map-legend-dot', style: `border-color:${meta.color};background:${key === 'none' ? 'transparent' : meta.color}` }),
      h('span', { class: 'rdr-map-legend-label' }, meta.label),
      h('span', { class: 'rdr-map-legend-desc' }, meta.desc))))

  return h('div', { class: 'rdr-map-body' },
    svg,
    h('p', { class: 'rdr-map-caliber' },
      '圆的大小 = 已表态来源条数（支持 + 反对；挂载但未表态的来源不计入）。'
      + '颜色 = 证据状况，不表示强度——强度记录为空表示"中性、还没有记录"，那不等于 0。'
      + ` 虚线圆 = 一个来源都还没有的观点（${emptyCount} 条）；`
      + (gapCount ? `全主题另有 ${gapCount} 处缺口在结论页列出（含"来源未复核"这类，不只是没来源）。` : '')),
    legend)
}
