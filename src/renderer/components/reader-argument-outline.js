/**
 * R1 论证大纲（docs/handoff-implementation-plan.md §10.1 第 2 项）
 *
 * 结论 → 要点（支持 / 挑战 / 未表态分组）→ 每条外部数据（来源名 + 时间 + 查看来源）。
 * 为什么不是图：图没有唯一阅读顺序，读不完；大纲有，而且折叠＝按需展开。
 * 文案里不出现"事件 / seq / 哈希"这类账本术语。
 */
import { h } from '../lib/dom.js'
import { READER_STATE_META } from '../lib/theme-network.js'

const GROUP_LABEL = { supports: '支持', against: '挑战', unclassified: '未表态' }

function strengthText(row) {
  return row.strength == null ? '还没有强度' : `强度 ${Math.round(row.strength)}%`
}

function evidenceMeta(item) {
  const parts = [item.sourceLabel, item.sourcePublishedAt, item.applicability ? `适用 ${item.applicability}` : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : '没记来源'
}

export function renderArgumentOutline(rows = [], { expandedIds = null, onToggle = null, onFocusAtom = null, onOpenSource = null } = {}) {
  const section = h('section', { class: 'rdr-outline', 'aria-label': '理由清单' },
    h('div', { class: 'rdr-section-head' },
      h('strong', {}, '理由清单'),
      h('span', { class: 'rdr-section-hint' }, '每条观点下挂着它的理由和来源 · 点标题展开')))
  if (!rows.length) {
    section.append(h('p', { class: 'rdr-section-empty' }, '这个主题还没有可以成篇的原子。先在图谱上建一个观点，再把外部数据挂上去。'))
    return section
  }
  for (const row of rows) {
    const state = READER_STATE_META[row.state] || READER_STATE_META.unevaluated
    const details = h('details', { class: 'rdr-outline-atom', ...(expandedIds?.has(row.id) ? { open: true } : {}) })
    details.append(h('summary', { class: 'rdr-outline-summary' },
      h('span', { class: 'rdr-outline-dot', style: `background:${state.color}`, 'aria-hidden': 'true' }),
      h('strong', { class: 'rdr-outline-title' }, row.title),
      h('span', { class: 'rdr-outline-meta' }, `${state.label} · ${strengthText(row)}`),
      h('span', { class: 'rdr-outline-counts' },
        `支持 ${row.counts.supports} · 挑战 ${row.counts.against} · 未表态 ${row.counts.unclassified}`)))
    const body = h('div', { class: 'rdr-outline-body' })
    for (const key of ['supports', 'against', 'unclassified']) {
      const list = row[key] || []
      body.append(h('div', { class: `rdr-outline-group is-${key}` },
        h('span', { class: 'rdr-outline-group-label' }, `${GROUP_LABEL[key]} ${list.length}`),
        list.length
          ? h('ul', { class: 'rdr-outline-list' }, ...list.map((item) => h('li', { class: 'rdr-outline-item' },
            h('div', { class: 'rdr-outline-item-head' },
              h('span', { class: 'rdr-outline-item-title' }, item.title),
              h('span', { class: 'rdr-outline-item-meta' }, evidenceMeta(item))),
            item.text ? h('p', { class: 'rdr-outline-item-text' }, item.text) : null,
            item.url
              ? h('button', {
                type: 'button', class: 'rdr-outline-link',
                onclick: () => { if (typeof onOpenSource === 'function') onOpenSource(item.url); else globalThis.window?.meridian?.openExternal?.(item.url) },
              }, '查看来源 ↗')
              : null)))
          : h('p', { class: 'rdr-outline-empty' }, `没有${GROUP_LABEL[key]}的外部数据`)))
    }
    details.append(body)
    /* 折叠状态只存内存（进 Set 再重画），不写任何数据。 */
    details.addEventListener('toggle', () => onToggle?.(row.id, details.open))
    section.append(details)
  }
  return section
}
