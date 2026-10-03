import { h } from '../lib/dom.js'
import { svgEl, svgText } from '../lib/theme-network-render.js'
import { claimEvidenceStats } from './reader-claim-map.js'

/**
 * 图谱缩略图（分簇版）：气泡 = 一组观点，固定分区布局，不用力导向。
 *
 * 为什么不用力导向（借鉴用户给的 demo 的关键一点）：力导向必然把没有结构的图排成一团糊，
 * 而这本主题的数据里观点之间几乎没有关系——所以"层次"只能来自**语义分组 + 固定位置**。
 *
 * 分簇依据（用户已确认按 (a)）：**按证据状况分簇**
 *   有争议（支持与反对都有）/ 没有来源 / 单一来源 / 多来源一致
 * 口径写在图例里，不冒充"业务分簇"。全部由真实数据推导（claimEvidenceStats），不造组。
 */

const GROUP_ORDER = ['contested', 'none', 'single', 'settled']

const GROUPS = {
  contested: { label: '有争议', hint: '同时收到支持与反对', color: 'var(--red)', rank: '先看这里' },
  none: { label: '没有来源', hint: '一个已表态来源都没有', color: 'var(--text-3)', rank: '空洞' },
  single: { label: '单一来源', hint: '只有 1 家来源', color: 'var(--orange)', rank: '脆弱' },
  settled: { label: '多来源一致', hint: '2 家以上来源，且没有反对', color: 'var(--green)', rank: '最扎实' },
}

const short = (node) => {
  const t = String(node?.title || node?.label || '未命名观点').trim()
  return t.length > 12 ? `${t.slice(0, 11)}…` : t
}

export function renderReaderClusterMap({ claims = [], evidenceForNode, onOpenClaim } = {}) {
  if (!claims.length) return h('div', { class: 'rdr-cluster-empty' }, '还没有可以画成图的观点。')

  const rows = claims.map((node) => ({ node, ...claimEvidenceStats(node, evidenceForNode) }))
  const byState = new Map(GROUP_ORDER.map((key) => [key, []]))
  for (const row of rows) (byState.get(row.state) || byState.get('none')).push(row)

  const groups = GROUP_ORDER
    .map((key) => ({ key, meta: GROUPS[key], rows: byState.get(key) || [] }))
    .filter((g) => g.rows.length > 0)

  /* 固定分区：按组数排成一行/网格，位置只由组数决定——同样的数据每次画在同一处。 */
  const width = 860
  const cols = Math.min(4, Math.max(1, groups.length))
  const rowsCount = Math.ceil(groups.length / cols)
  const cellW = width / cols
  const height = Math.max(240, rowsCount * 200)
  const maxCount = Math.max(...groups.map((g) => g.rows.length), 1)

  const svg = svgEl('svg', {
    class: 'rdr-cluster-canvas', viewBox: `0 0 ${width} ${height}`,
    role: 'group', 'aria-label': '观点分簇缩略图：气泡大小表示该组观点数量，颜色表示证据状况',
  })

  const listHost = h('div', { class: 'rdr-cluster-list' })

  groups.forEach((group, index) => {
    const cx = cellW * (index % cols) + cellW / 2
    const cy = 100 + Math.floor(index / cols) * 200
    const r = 30 + Math.sqrt(group.rows.length / maxCount) * 34

    const bubble = svgEl('g', {
      class: `rdr-cluster-bubble is-${group.key}`, tabindex: '0', role: 'button',
      transform: `translate(${cx} ${cy})`,
      'aria-label': `${group.meta.label}：${group.rows.length} 条观点（${group.meta.hint}）`,
    })
    bubble.append(svgEl('circle', {
      r, class: 'rdr-cluster-circle', stroke: group.meta.color,
      fill: group.key === 'none' ? 'transparent' : group.meta.color,
      'stroke-dasharray': group.key === 'none' ? '5 5' : '0',
    }))
    bubble.append(svgText(String(group.rows.length), { class: 'rdr-cluster-count', y: 5, 'text-anchor': 'middle' }))
    bubble.append(svgText(group.meta.label, { class: 'rdr-cluster-name', y: r + 18, 'text-anchor': 'middle' }))
    const tip = svgEl('title', {})
    tip.textContent = `${group.meta.label} · ${group.rows.length} 条观点\n${group.meta.hint}`
    bubble.append(tip)

    /* 点气泡 → 滚到下面这一组的清单（不做力导向展开，保持"固定分区"的可预期性）。 */
    const section = h('section', { class: `rdr-cluster-group is-${group.key}`, id: `rdr-cluster-${group.key}` },
      h('h3', { class: 'rdr-cluster-group-head' },
        h('span', { class: 'rdr-cluster-dot', style: `background:${group.meta.color}` }),
        h('span', { class: 'rdr-cluster-group-name' }, group.meta.label),
        h('span', { class: 'rdr-cluster-group-count' }, `${group.rows.length} 条`),
        h('span', { class: 'rdr-cluster-group-hint' }, group.meta.hint)),
      h('ul', { class: 'rdr-cluster-claims' }, ...group.rows.map((row) => h('li', {},
        onOpenClaim
          ? h('button', { type: 'button', class: 'rdr-cluster-claim', onclick: () => onOpenClaim(row.node.id) },
            short(row.node),
            h('span', { class: 'rdr-cluster-claim-meta' },
              row.stated ? `支持 ${row.support} · 反对 ${row.challenge}` : '还没有已表态的来源'))
          : h('span', { class: 'rdr-cluster-claim' }, short(row.node))))))
    listHost.append(section)

    const jump = () => section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    bubble.addEventListener('click', jump)
    bubble.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump() }
    })
    svg.append(bubble)
  })

  return h('div', { class: 'rdr-cluster-body' },
    svg,
    h('p', { class: 'rdr-cluster-caliber' },
      '分簇依据：按证据状况分组（有争议 / 没有来源 / 单一来源 / 多来源一致），不是业务分类；'
      + '气泡大小 = 该组观点数量，位置固定（不用力导向，同样的数据每次画在同一处）。'),
    listHost)
}
