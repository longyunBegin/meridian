/**
 * R3 双边清单（docs/handoff-implementation-plan.md §10.1 第 4 项）
 *
 * 支持一列 / 中间当前强度 / 挑战一列。图里"反驳"只是一条红线，极易被忽略；
 * 并排两列才能直接读"争议点到底在哪"。点任一条跳到该证据的详情。
 */
import { h } from '../lib/dom.js'

function evidenceLine(item, onFocusEvidence) {
  return h('li', { class: 'rdr-debate-item' },
    h('button', {
      type: 'button', class: 'rdr-debate-link', 'data-evidence-id': item.id,
      onclick: () => onFocusEvidence?.(item.id),
    },
      h('span', { class: 'rdr-debate-item-title' }, item.title),
      h('span', { class: 'rdr-debate-item-meta' },
        [item.sourceLabel, item.sourcePublishedAt, item.applicability ? `适用 ${item.applicability}` : null].filter(Boolean).join(' · ') || '出处未记录')))
}

export function renderDebateBoard(rows = [], { onFocusEvidence = null, onFocusAtom = null } = {}) {
  const section = h('section', { class: 'rdr-debate', 'aria-label': '双边清单' },
    h('div', { class: 'rdr-section-head' },
      h('strong', {}, '双边清单'),
      h('span', { class: 'rdr-section-hint' }, '支持 ⟷ 挑战并排 · 点任一条跳到该外部数据')))
  if (!rows.length) {
    section.append(h('p', { class: 'rdr-section-empty' }, '还没有已表态的支持或挑战关系。挂上外部数据并在审阅时表态后，这里会并排列出双方。'))
    return section
  }
  for (const row of rows) {
    section.append(h('div', { class: `rdr-debate-row${row.contested ? ' is-contested' : ''}` },
      h('div', { class: 'rdr-debate-col is-supports' },
        h('span', { class: 'rdr-debate-col-label' }, `支持 ${row.supports.length}`),
        row.supports.length ? h('ul', { class: 'rdr-debate-list' }, ...row.supports.map((item) => evidenceLine(item, onFocusEvidence)))
          : h('p', { class: 'rdr-debate-empty' }, '没有支持')),
      h('div', { class: 'rdr-debate-mid' },
        h('button', { type: 'button', class: 'rdr-debate-atom', onclick: () => onFocusAtom?.(row.id) }, row.title),
        h('span', { class: 'rdr-debate-strength' }, row.strength == null ? '还没有强度' : `强度 ${Math.round(row.strength)}%`),
        row.contested ? h('span', { class: 'rdr-debate-flag' }, '有争议') : null),
      h('div', { class: 'rdr-debate-col is-against' },
        h('span', { class: 'rdr-debate-col-label' }, `挑战 ${row.against.length}`),
        row.against.length ? h('ul', { class: 'rdr-debate-list' }, ...row.against.map((item) => evidenceLine(item, onFocusEvidence)))
          : h('p', { class: 'rdr-debate-empty' }, '没有挑战'))))
  }
  return section
}
