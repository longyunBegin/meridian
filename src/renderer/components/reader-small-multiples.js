/**
 * R2 小倍数网格（docs/handoff-implementation-plan.md §10.1 第 3 项）
 *
 * 每个原子一张卡：名称 + 分类色点 + sparkline（confidence 历史）+ 当前强度条 +
 * 支持/挑战/未表态计数。点卡片＝聚焦该原子并联动检视器与合成轴。
 *
 * 为什么不是图：图上做不了并排比较（谁涨谁跌、谁强谁弱），网格可以。
 */
import { h } from '../lib/dom.js'
import { READER_STATE_META } from '../lib/theme-network.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

function sparklineSvg(spark, state) {
  const width = 72
  const height = 22
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('class', 'rdr-multiple-spark')
  svg.setAttribute('aria-hidden', 'true')
  if (spark?.enough) {
    const line = document.createElementNS(SVG_NS, 'polyline')
    line.setAttribute('points', spark.points)
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', state.color)
    line.setAttribute('stroke-width', '1.6')
    svg.append(line)
  } else {
    /* 少于两个点＝没有趋势可画，用一条虚线明说"数据不足"，不假装平稳。 */
    const flat = document.createElementNS(SVG_NS, 'line')
    flat.setAttribute('x1', '0'); flat.setAttribute('x2', String(width))
    flat.setAttribute('y1', String(height / 2)); flat.setAttribute('y2', String(height / 2))
    flat.setAttribute('stroke', 'var(--line, #ddd)')
    flat.setAttribute('stroke-width', '1.4')
    flat.setAttribute('stroke-dasharray', '3 3')
    svg.append(flat)
  }
  return svg
}

export function renderSmallMultiples(rows = [], { onFocusAtom = null, colorFor = null, sparkFor = null, selectedId = null } = {}) {
  const section = h('section', { class: 'rdr-multiples', 'aria-label': '原子小倍数网格' },
    h('div', { class: 'rdr-section-head' },
      h('strong', {}, '原子一览'),
      h('span', { class: 'rdr-section-hint' }, '每行一个原子 · 强度趋势不可比较时如实留白 · 点卡片聚焦到图谱')))
  if (!rows.length) {
    section.append(h('p', { class: 'rdr-section-empty' }, '还没有原子。'))
    return section
  }
  const grid = h('div', { class: 'rdr-multiples-grid' })
  for (const row of rows) {
    const state = READER_STATE_META[row.state] || READER_STATE_META.unevaluated
    const catColor = typeof colorFor === 'function' ? colorFor(row.category) : null
    const strength = row.strength == null ? null : Math.round(row.strength)
    const card = h('button', {
      type: 'button',
      class: `rdr-multiple-card${selectedId && selectedId === row.id ? ' is-selected' : ''}`,
      'data-atom-id': row.id,
      onclick: () => onFocusAtom?.(row.id),
    },
      h('span', { class: 'rdr-multiple-top' },
        catColor ? h('span', { class: 'rdr-multiple-cat', style: `background:${catColor}`, title: `分类：${row.category}`, 'aria-hidden': 'true' }) : null,
        h('strong', { class: 'rdr-multiple-title' }, row.title),
        h('span', { class: 'rdr-multiple-state', style: `color:${state.textColor}` }, state.label)),
      h('span', { class: 'rdr-multiple-meter' },
        h('span', { class: 'rdr-multiple-bar', 'aria-hidden': 'true' },
          h('span', { class: 'rdr-multiple-bar-fill', style: `width:${strength == null ? 0 : strength}%;background:${state.color}` })),
        h('span', { class: 'rdr-multiple-value' }, strength == null ? '还没有强度' : `${strength}%`)),
      sparklineSvg(typeof sparkFor === 'function' ? sparkFor(row.id) : null, state),
      h('span', { class: 'rdr-multiple-counts' },
        `${row.counts.supports} 支持 · ${row.counts.against} 挑战 · ${row.counts.unclassified} 未表态`))
    grid.append(card)
  }
  section.append(grid)
  return section
}
