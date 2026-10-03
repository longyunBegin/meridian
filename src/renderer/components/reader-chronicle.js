/**
 * R4 编年史（docs/handoff-implementation-plan.md §10.1 第 5 项）
 *
 * 一行一条外部数据：日期 · 来源 · 归入哪个原子 · 支持/挑战 · 这次归因带来的强度变化。
 * 线性、可滚动、可搜索＝"跟随时间"本身；文案不出现事件序号/哈希这类账本术语。
 */
import { h } from '../lib/dom.js'

const STANCE_LABEL = { supports: '支持', contradicts: '挑战', unstated: '未表态' }

export function renderChronicle(rows = [], { onFocusEvidence = null, onOpenSource = null } = {}) {
  const section = h('section', { class: 'rdr-chronicle', 'aria-label': '编年史' },
    h('div', { class: 'rdr-section-head' },
      h('strong', {}, '编年史'),
      h('span', { class: 'rdr-section-hint' }, '按时间读外部数据：何时来了什么、归到哪、改变了多少')))
  if (!rows.length) {
    section.append(h('p', { class: 'rdr-section-empty' }, '还没有外部数据。捕获或导入来源后，这里按时间倒序列出每一条。'))
    return section
  }
  const list = h('ol', { class: 'rdr-chronicle-list' })
  for (const row of rows) {
    list.append(h('li', { class: `rdr-chronicle-item is-${row.stance}` },
      h('span', { class: 'rdr-chronicle-date' }, row.date),
      h('div', { class: 'rdr-chronicle-main' },
        h('button', { type: 'button', class: 'rdr-chronicle-text', onclick: () => onFocusEvidence?.(row.id) }, row.text),
        h('span', { class: 'rdr-chronicle-meta' },
          [row.sourceLabel || '来源未记录', row.atomTitles.length ? `归入 ${row.atomTitles.join(' / ')}` : '还没归入原子'].join(' · '))),
      h('span', { class: 'rdr-chronicle-stance' }, STANCE_LABEL[row.stance] || row.stance),
      h('span', { class: 'rdr-chronicle-delta' }, row.strengthChange || '强度未变'),
      row.url
        ? h('button', {
          type: 'button', class: 'rdr-chronicle-link',
          onclick: () => { if (typeof onOpenSource === 'function') onOpenSource(row.url); else globalThis.window?.meridian?.openExternal?.(row.url) },
        }, '来源 ↗')
        : null))
  }
  section.append(list)
  return section
}
