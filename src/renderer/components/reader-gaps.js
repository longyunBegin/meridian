/**
 * R5 缺口清单 + P1-5 读者回流（docs/handoff-implementation-plan.md §3.5 / §10.3）
 *
 * 缺口＝"知道哪里还不知道"：无证据的原子 / 待复核的归因 / 过期的证据 / 未归位的收件箱条目。
 * 每条都能一键进收件箱（待办）或去建设者；回流动作只是"写一条待办"，不改写账本。
 */
import { h } from '../lib/dom.js'

const KIND_LABEL = {
  'no-evidence': '还没有来源',
  'pending-review': '等你确认',
  'expired-evidence': '来源过期了',
  'unassigned-inbox': '没归到任何观点',
}

export function renderGapList(gaps = [], {
  todoKeys = null, selectedId = null,
  onCreateTodo = null, onFocusAtom = null, onOpenBuilder = null, onMarkGap = null,
} = {}) {
  const section = h('section', { class: 'rdr-gaps', 'aria-label': '还缺什么' },
    h('div', { class: 'rdr-section-head' },
      h('strong', {}, '还缺什么'),
      h('span', { class: 'rdr-section-hint' }, '模型一半的价值在"知道哪里还不知道" · 每条都能一键进收件箱或建设者')))
  if (!gaps.length) {
    section.append(h('p', { class: 'rdr-section-empty' }, '当前没有发现结构性缺口：每个原子都有外部数据，也没有待复核或过期的证据。'))
  } else {
    const list = h('ul', { class: 'rdr-gap-list' })
    for (const gap of gaps) {
      const done = typeof todoKeys?.has === 'function' && todoKeys.has(gap.key)
      list.append(h('li', { class: `rdr-gap-item is-${gap.kind}` },
        h('span', { class: 'rdr-gap-kind' }, KIND_LABEL[gap.kind] || gap.kind),
        h('div', { class: 'rdr-gap-main' },
          h('strong', { class: 'rdr-gap-title' }, gap.title),
          h('span', { class: 'rdr-gap-detail' }, gap.detail)),
        h('div', { class: 'rdr-gap-actions' },
          done
            ? h('span', { class: 'rdr-gap-done' }, '已在收件箱')
            : h('button', { type: 'button', class: 'btn btn-sm rdr-gap-todo', onclick: () => onCreateTodo?.(gap) }, '加入待办'),
          gap.nodeId
            ? h('button', { type: 'button', class: 'btn btn-sm rdr-gap-locate', onclick: () => onFocusAtom?.(gap.nodeId) }, '在图谱中定位')
            : null,
          h('button', { type: 'button', class: 'btn btn-sm rdr-gap-builder', onclick: () => onOpenBuilder?.(gap) }, '去建设者'))))
    }
    section.append(list)
  }
  /* 读者回流入口（原型底部的「标记缺口」）：对选中的原子记一条待办，没选中就记一条主题级待办。 */
  section.append(h('div', { class: 'rdr-gap-foot' },
    h('button', { type: 'button', class: 'btn btn-sm rdr-gap-mark', onclick: () => onMarkGap?.(selectedId) }, '标记缺口'),
    h('span', { class: 'rdr-gap-foot-hint' }, selectedId ? '为选中的原子记一条待办' : '先在图谱里选一个原子，可只对那个原子记待办')))
  return section
}
