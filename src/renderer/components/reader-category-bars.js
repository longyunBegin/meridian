/**
 * R7 分类聚合（docs/handoff-implementation-plan.md §10.3 R7）
 *
 * 分类维度的比较视图：每个分类有多少原子、挂了多少外部数据、平均强度。
 * 图里分类只是染色，聚合才能比较"重心在哪个分类"。
 */
import { h } from '../lib/dom.js'

export function renderCategoryBars(rows = [], { selectedId = null, onFocusCategory = null } = {}) {
  const section = h('section', { class: 'rdr-categories', 'aria-label': '分类' },
    h('div', { class: 'rdr-section-head' },
      h('strong', {}, '分类'),
      h('span', { class: 'rdr-section-hint' }, '哪一类内容最多、哪一类还没来源')))
  const usable = rows.filter((row) => row.atoms || row.evidence)
  if (!usable.length) {
    section.append(h('p', { class: 'rdr-section-empty' }, '还没有分类。可以在主题设置里加。'))
    return section
  }
  const maxAtoms = Math.max(...usable.map((row) => row.atoms), 1)
  const maxEvidence = Math.max(...usable.map((row) => row.evidence), 1)
  for (const row of usable) {
    section.append(h('div', { class: 'rdr-category-row' },
      h('span', { class: 'rdr-category-name' }, row.category),
      h('span', { class: 'rdr-category-bars' },
        h('span', { class: 'rdr-category-bar is-atoms', style: `width:${Math.round((row.atoms / maxAtoms) * 100)}%`, 'aria-hidden': 'true' }),
        h('span', { class: 'rdr-category-bar is-evidence', style: `width:${Math.round((row.evidence / maxEvidence) * 100)}%`, 'aria-hidden': 'true' })),
      h('span', { class: 'rdr-category-figures' },
        `${row.atoms} 原子 · ${row.evidence} 外部数据${row.averageStrength == null ? '' : ` · 平均强度 ${Math.round(row.averageStrength)}%`}`,
        row.atoms && !row.evidence ? h('span', { class: 'rdr-category-gap' }, '还没来源') : null)))
  }
  section.append(h('div', { class: 'rdr-category-legend' },
    h('span', {}, h('i', { class: 'rdr-category-swatch is-atoms', 'aria-hidden': 'true' }), '原子'),
    h('span', {}, h('i', { class: 'rdr-category-swatch is-evidence', 'aria-hidden': 'true' }), '外部数据')))
  return section
}
