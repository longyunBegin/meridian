import { h } from '../lib/dom.js'
import { ATOM_STATES, STANCE_LABEL } from '../lib/reader-board.js'

/**
 * 读者页（数据由 buildAtomBoard 给出，这里只负责呈现）：
 * ① 主题 + 一句话结论 + 检验状态条 ② 原子看板（按检验状态分组）③ 最近进来的外部数据 ④ 接下来看什么。
 * 点任一原子，开右侧原子抽屉。
 */

/* 每组先显示的条数：被检验过的组多给一些，没被检验的组只露个头。 */
const GROUP_PREVIEW = { tested: 8, quiet: 5 }
const STATE_BY_KEY = new Map(ATOM_STATES.map((state) => [state.key, state]))

/** 类型 pill：观察偏「事实」色，观点 / 假设偏强调色；其余中性。 */
function typeChipClass(typeLabel) {
  if (typeLabel === '观察') return 'is-fact'
  if (typeLabel === '观点' || typeLabel === '假设') return 'is-view'
  return 'is-type'
}

function formatBalance(value, mode) {
  const n = Number(value) || 0
  return mode === 'weight' ? n.toFixed(2) : String(Math.round(n))
}

/**
 * 天秤：左绿佐证 / 右红反对；支点按权重（或条数）占比定位。
 * 没有独立佐证/反对时不画假天秤。
 */
function balanceScale(atom) {
  const balance = atom.balance
  if (!balance) return null
  const total = balance.support + balance.against
  if (!(total > 0)) return null
  const pct = Math.max(0, Math.min(100, balance.ratio * 100))
  const unit = balance.mode === 'weight' ? '按权重' : '按条数'
  const label = `${unit}：佐证 ${formatBalance(balance.support, balance.mode)}，反对 ${formatBalance(balance.against, balance.mode)}`
  return h('div', {
    class: `rdr-scale${balance.againstLeads ? ' is-against-leads' : ''}`,
    role: 'img',
    'aria-label': label,
    title: balance.mode === 'weight' && balance.missing
      ? `${label}（另有 ${balance.missing} 条旧数据没记权重，未计入）`
      : label,
  },
  h('div', { class: 'rdr-scale-track' },
    h('span', { class: 'rdr-scale-support', style: { width: `${pct}%` } }),
    h('span', { class: 'rdr-scale-against', style: { width: `${100 - pct}%` } }),
    h('span', { class: 'rdr-scale-fulcrum', style: { left: `${pct}%` }, 'aria-hidden': 'true' })),
  h('div', { class: 'rdr-scale-foot' },
    h('span', { class: 'rdr-scale-support-n' }, '佐证 ', h('b', {}, formatBalance(balance.support, balance.mode))),
    balance.againstLeads
      ? h('span', { class: 'rdr-scale-flip' }, '反对占优')
      : h('span', { class: 'rdr-scale-mid', 'aria-hidden': 'true' }, ''),
    h('span', { class: 'rdr-scale-against-n' }, '反对 ', h('b', {}, formatBalance(balance.against, balance.mode)))))
}

export function settleText(settle) {
  if (!settle) return ''
  if (settle.settled) return `${settle.day} 已结算 · ${settle.correct ? '成立' : '不成立'}`
  if (settle.tone === 'overdue') return `${settle.day} 已过 ${-settle.daysLeft} 天，未结算`
  if (settle.daysLeft === 0) return `${settle.day} 今天见分晓`
  return `${settle.day} 见分晓（还有 ${settle.daysLeft} 天）`
}

export function tallyText(tallies) {
  const parts = []
  if (tallies.support) parts.push(`佐证 ${tallies.support}`)
  if (tallies.against) parts.push(`反对 ${tallies.against}`)
  if (tallies.both) parts.push(`两边 ${tallies.both}`)
  if (tallies.neutral) parts.push(`中立 ${tallies.neutral}`)
  return parts.join(' · ')
}

export const dateText = (date) => (date ? `${date.day} ${date.kind}` : '日期未记录')

/* ① 主题 + 一句话 + 状态条 */
export function renderReaderBrief({ theme, board }) {
  const { byState, totals } = board
  const segments = ATOM_STATES.filter((state) => byState[state.key])
  const facts = []
  const fact = (label, value) => facts.push(h('li', { class: 'rdr-brief-fact' },
    h('span', { class: 'rdr-brief-fact-value' }, value), h('span', { class: 'rdr-brief-fact-label' }, label)))
  const { stances } = totals
  fact(stances.both ? '独立表态：佐证 / 反对 / 中立 / 两边' : '独立表态：佐证 / 反对 / 中立',
    [stances.support, stances.against, stances.neutral, ...(stances.both ? [stances.both] : [])].join(' / '))
  fact('条出处（不计入表态）', String(totals.originSources))
  if (totals.pendingSources) fact('条待确认（不计入表态）', String(totals.pendingSources))
  fact('最近一条独立数据', totals.latestIndependentDay || '还没有')

  return h('header', { class: 'rdr-brief' },
    h('p', { class: 'rdr-brief-kicker' }, '主题'),
    h('h1', { class: 'rdr-brief-question' }, theme?.name || '未命名主题'),
    h('p', { class: 'rdr-brief-verdict' }, board.verdict),
    h('div', { class: 'rdr-statusbar', role: 'img', 'aria-label': segments.map((state) => `${state.label} ${byState[state.key]}`).join('，') },
      ...segments.map((state) => h('span', {
        class: `rdr-statusbar-seg is-${state.key}`, style: { flexGrow: String(byState[state.key]) },
        title: `${state.label} ${byState[state.key]}`,
      }))),
    h('ul', { class: 'rdr-legend' }, ...ATOM_STATES.map((state) => h('li', { class: `rdr-legend-item is-${state.key}${byState[state.key] ? '' : ' is-zero'}` },
      h('span', { class: 'rdr-legend-dot' }), state.label, h('b', {}, String(byState[state.key]))))),
    h('ul', { class: 'rdr-brief-facts' }, ...facts))
}

function atomRow(atom, onOpenAtom) {
  const state = STATE_BY_KEY.get(atom.state) || STATE_BY_KEY.get('none')
  const scale = balanceScale(atom)
  let quietNote = null
  if (!scale) {
    if (atom.independentCount) quietNote = tallyText(atom.tallies) || '有独立数据，但还没有佐证 / 反对'
    else if (atom.origin.length) quietNote = `出处：${atom.origin[0].sourceName || '来源未标注'} · 尚未被独立数据检验`
    else quietNote = '还没有外部数据'
  }
  const meta = atom.latestDay ? `最近 ${atom.latestDay}` : (atom.origin[0]?.sourceName ? `出处 ${atom.origin[0].sourceName}` : '')
  const button = h('button', {
    type: 'button',
    class: `rdr-atom-row${scale ? '' : ' is-quiet-atom'}`,
    dataset: { atomId: atom.id },
    onclick: () => onOpenAtom?.(atom.id, button),
  },
  h('div', { class: 'rdr-atom-head' },
    h('span', { class: 'rdr-atom-title' }, `「${atom.title}」`),
    h('span', { class: 'rdr-atom-tags' },
      h('span', { class: `rdr-chip ${typeChipClass(atom.typeLabel)}` }, atom.typeLabel),
      h('span', { class: `rdr-chip is-state-${atom.state}` }, state.label),
      atom.balance?.againstLeads && scale
        ? h('span', { class: 'rdr-chip is-flip' }, '反对占优')
        : null)),
  scale || h('p', { class: 'rdr-atom-quiet' }, quietNote),
  meta ? h('span', { class: 'rdr-atom-meta' }, meta) : null)
  return h('li', {}, button)
}

/* ② 原子看板 */
export function renderReaderBoard({ board, onOpenAtom }) {
  const groupEl = (group) => {
    const limit = group.tested ? GROUP_PREVIEW.tested : GROUP_PREVIEW.quiet
    const list = h('ul', { class: 'rdr-atom-list' })
    const toggle = group.items.length > limit ? h('button', { type: 'button', class: 'rdr-group-more' }) : null
    let expanded = false
    const paint = () => {
      list.replaceChildren(...(expanded ? group.items : group.items.slice(0, limit)).map((atom) => atomRow(atom, onOpenAtom)))
      if (toggle) {
        toggle.textContent = expanded ? '收起' : `展开全部 ${group.items.length} 个`
        toggle.setAttribute('aria-expanded', String(expanded))
      }
    }
    toggle?.addEventListener('click', () => { expanded = !expanded; paint() })
    paint()
    return h('div', { class: `rdr-group is-${group.key}${group.tested ? '' : ' is-quiet'}`, 'aria-label': `${group.label} ${group.items.length} 个` },
      h('h3', { class: 'rdr-group-head' },
        h('span', { class: 'rdr-group-dot' }),
        h('span', { class: 'rdr-group-label' }, `${group.label} · ${group.items.length}`),
        h('span', { class: 'rdr-group-hint' }, group.hint)),
      list,
      toggle)
  }
  return h('section', { class: 'rdr-board u-stagger', 'aria-label': '原子看板' },
    h('h2', { class: 'rdr-h2' }, '原子看板 · 外部数据怎么说'),
    h('p', { class: 'rdr-caption' }, '按检验状态分组；组内先按独立数据条数、再按最近日期排。天秤按佐证 / 反对权重（无权重时按条数）摆位，出处不算佐证。'),
    ...board.groups.map(groupEl))
}

/* ③ 最近进来的外部数据 */
export function renderReaderFeed({ board, onOpenAtom }) {
  const { feed } = board
  return h('section', { class: 'rdr-feed', 'aria-label': '最近进来的外部数据' },
    h('h2', { class: 'rdr-h2' }, '最近进来的外部数据'),
    feed.total
      ? h('p', { class: 'rdr-caption' }, `按进入账本的先后，最新在前${feed.total > feed.items.length ? `（共 ${feed.total} 条，显示最近 ${feed.items.length} 条）` : ''}。出处也列出来，单独标注。`)
      : null,
    feed.total
      ? h('ol', { class: 'rdr-feed-list' }, ...feed.items.map((row) => h('li', { class: 'rdr-feed-item' },
        h('span', { class: 'rdr-feed-when' }, dateText(row.date)),
        h('span', { class: `rdr-chip is-${row.stance}` }, STANCE_LABEL[row.stance] || row.stance),
        h('span', { class: 'rdr-feed-source' }, row.sourceName || row.title),
        h('span', { class: 'rdr-feed-arrow', 'aria-hidden': 'true' }, '→'),
        h('button', { type: 'button', class: 'rdr-feed-atom', onclick: (event) => onOpenAtom?.(row.atomId, event.currentTarget) }, row.atomTitle))))
      : h('p', { class: 'rdr-note' }, '还没有任何外部数据进来。'))
}

/* ④ 接下来看什么 */
export function renderReaderWatch({ board, onOpenAtom }) {
  if (!board.watch.length) return null
  return h('section', { class: 'rdr-watch', 'aria-label': '接下来看什么' },
    h('h2', { class: 'rdr-h2' }, '接下来看什么'),
    h('ol', { class: 'rdr-watch-list' }, ...board.watch.map((item) => h('li', { class: `rdr-watch-item is-${item.settle.tone}` },
      h('span', { class: 'rdr-watch-when' }, settleText(item.settle)),
      h('button', { type: 'button', class: 'rdr-watch-title', onclick: (event) => onOpenAtom?.(item.id, event.currentTarget) }, item.title),
      h('span', { class: `rdr-watch-falsifier${item.falsifier ? '' : ' is-empty'}` }, item.falsifier ? `推翻条件：${item.falsifier}` : '没有写推翻条件')))))
}
