/**
 * R6 邻接矩阵（docs/handoff-implementation-plan.md §10.1 第 7 项）
 *
 * 行＝原子、列＝外部数据（可切原子 × 原子）。边一密，node-link 就成毛线球；
 * 矩阵里找"块状结构"远快于看图。单元格点击＝定位到那条证据/那个原子。
 */
import { h } from '../lib/dom.js'

const CELL_LABEL = {
  supports: '支持', contradicts: '挑战', derives: '推导', related: '相关', attached: '挂上·未表态',
}

export function renderAdjacencyMatrix(matrix, {
  mode = 'atom-evidence', degraded = false, selectedId = null,
  onModeChange = null, onFocus = null,
} = {}) {
  const section = h('section', { class: 'rdr-matrix', 'aria-label': '邻接矩阵' },
    h('div', { class: 'rdr-section-head' },
      h('strong', {}, '邻接矩阵'),
      h('span', { class: 'rdr-section-hint' }, '行＝原子 · 列＝外部数据 · 点击单元格定位；行列已按共同归属重排，块状即"一起支撑"'),
      h('div', { class: 'rdr-matrix-modes' },
        h('button', {
          type: 'button', class: `btn btn-sm rdr-matrix-mode${mode === 'atom-evidence' ? ' is-active' : ''}`,
          'aria-pressed': String(mode === 'atom-evidence'), onclick: () => onModeChange?.('atom-evidence'),
        }, '原子 × 外部数据'),
        h('button', {
          type: 'button', class: `btn btn-sm rdr-matrix-mode${mode === 'atom-atom' ? ' is-active' : ''}`,
          'aria-pressed': String(mode === 'atom-atom'), onclick: () => onModeChange?.('atom-atom'),
        }, '原子 × 原子'))))
  if (degraded) {
    section.append(h('p', { class: 'rdr-matrix-degraded' }, `节点数 ≥300：图谱已按文档规则自动降级为矩阵视图（力导向在千级节点上不再是可读结构）。`))
  }
  if (!matrix.rows.length || !matrix.columns.length) {
    section.append(h('p', { class: 'rdr-section-empty' }, '还没有可成矩阵的原子与外部数据。'))
    return section
  }
  const table = h('table', { class: 'rdr-matrix-table' })
  const head = h('tr', {}, h('th', { class: 'rdr-matrix-corner', scope: 'col' }, '原子 \\ 数据'))
  for (const column of matrix.columns) {
    head.append(h('th', { class: 'rdr-matrix-col', scope: 'col', title: column.title }, column.title.slice(0, 4)))
  }
  table.append(h('thead', {}, head))
  const body = h('tbody')
  matrix.rows.forEach((row, rowIndex) => {
    const tr = h('tr', { class: `rdr-matrix-row${selectedId === row.id ? ' is-selected' : ''}` },
      h('th', { class: 'rdr-matrix-rowhead', scope: 'row' },
        h('button', { type: 'button', class: 'rdr-matrix-atom', onclick: () => onFocus?.(row.id) }, row.title)))
    matrix.columns.forEach((column, columnIndex) => {
      const state = matrix.cells[rowIndex]?.[columnIndex] || null
      tr.append(h('td', { class: `rdr-matrix-cell${state ? ` is-${state}` : ' is-empty'}` },
        state
          ? h('button', {
            type: 'button', class: 'rdr-matrix-dot',
            title: `${row.title} ← ${column.title}：${CELL_LABEL[state] || state}`,
            'aria-label': `${row.title} 与 ${column.title}：${CELL_LABEL[state] || state}`,
            onclick: () => onFocus?.(column.id),
          })
          : null))
    })
    body.append(tr)
  })
  table.append(body)
  section.append(table)
  section.append(h('div', { class: 'rdr-matrix-legend' },
    ...['supports', 'contradicts', 'derives', 'attached'].map((state) => h('span', { class: 'rdr-matrix-legend-item' },
      h('i', { class: `rdr-matrix-swatch is-${state}`, 'aria-hidden': 'true' }), CELL_LABEL[state]))))
  return section
}
