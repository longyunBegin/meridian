import { h } from '../lib/dom.js'
import { ATOM_STATES, STANCE_LABEL } from '../lib/reader-board.js'
import { settleText, tallyText, dateText } from './reader-board.js'
import { WEIGHT_TIER_LABEL, weightFormula, weightText, weightTier } from '../../shared/evidence-weight.js'

/**
 * 原子抽屉：这个原子从哪来（出处）、出处之外的数据怎么说（逐条可核对）、
 * 改过什么（修订历史）、什么时候见分晓、和哪些原子有明确的边。
 */

const STATE_BY_KEY = new Map(ATOM_STATES.map((state) => [state.key, state]))
const squash = (value) => String(value || '').replace(/\s+/g, '')

/** 权重标记：分值 + 高 / 中 / 低；悬停看「来源类型分 × 硬度系数」与它是判定时确认的还是进主题时的建议。 */
export function weightChip(weight, weightSource) {
  if (!weight) return null
  const tier = weightTier(weight)
  const origin = weightSource === 'judged' ? '判定时确认' : '进主题时的建议，尚未判定'
  return h('span', {
    class: `rdr-ev-weight is-${tier}${weightSource === 'judged' ? '' : ' is-suggested'}`,
    title: `权重 = ${weightFormula(weight)}（${origin}）；只有佐证 / 反对会按它推动原子强度`,
  }, `权重 ${weightText(weight)} · ${WEIGHT_TIER_LABEL[tier]}`)
}

function evidenceRow(row, { showStance, external = true }) {
  /* 旧数据迁移的出处只记了来源类型，正文就是类型本身（"财报 / 公告"）——与来源名重复时不再显示一遍。 */
  const body = row.quote || row.title
  const echoesSource = Boolean(row.sourceName) && squash(body) === squash(row.sourceName)
  const points = Array.isArray(row.points) ? row.points : []
  return h('li', { class: `rdr-ev-row is-${row.stance}` },
    h('div', { class: 'rdr-ev-top' },
      showStance ? h('span', { class: `rdr-chip is-${row.stance}` }, STANCE_LABEL[row.stance] || row.stance) : null,
      h('span', { class: 'rdr-ev-source' }, row.sourceName || '来源未标注'),
      h('span', { class: 'rdr-ev-when' }, dateText(row.date)),
      weightChip(row.weight, row.weightSource),
      row.url ? h('a', { class: 'rdr-ev-link', href: row.url, target: '_blank', rel: 'noreferrer noopener' }, '原文 ↗')
        : external ? h('span', { class: 'rdr-ev-nolink', title: '外部数据必须指向真实的来源网址；这条旧数据没有记下' }, '缺来源链接') : null),
    echoesSource ? null : h('p', { class: 'rdr-ev-quote' }, body),
    points.length
      ? h('details', { class: 'rdr-ev-points' },
        h('summary', {}, `要点 · ${points.length}`),
        h('ul', {}, ...points.map((point) => h('li', {}, point))))
      : null)
}

/** 按权重汇总佐证 / 反对：只算账本里记了权重的；旧数据没记的单独说明，不拿现算的补。 */
function weightedSummary(rows) {
  const sums = { support: 0, against: 0 }
  let weighted = 0
  let missing = 0
  for (const row of rows) {
    if (row.stance !== 'support' && row.stance !== 'against') continue
    if (!row.weight) { missing += 1; continue }
    sums[row.stance] += row.weight.value
    weighted += 1
  }
  if (!weighted) return null
  return h('p', { class: 'rdr-atomd-weighted', title: '每条数据的权重 = 来源类型分 × 硬度系数；这里是同一表态的权重相加' },
    `按权重：佐证 ${sums.support.toFixed(2)} · 反对 ${sums.against.toFixed(2)}`,
    missing ? `（另有 ${missing} 条旧数据没记权重，未计入）` : '')
}

const block = (title, ...children) => h('div', { class: 'rdr-atomd-block' }, h('h4', { class: 'rdr-detail-subhead' }, title), ...children)

/**
 * relations：[{ id, title, label, direction: 'out' | 'in' }]；corrections：[{ day, oldValue, newValue, reason }]。
 * engineStrength：引擎记下的强度（0-100）或 null；只作参考展示，读者页不据此排序或分组。
 */
export function renderReaderAtomDetail({ atom, relations = [], corrections = [], engineStrength = null, onOpenAtom, onClose } = {}) {
  const state = STATE_BY_KEY.get(atom.state) || STATE_BY_KEY.get('none')
  const summary = atom.independentCount
    ? `出处之外有 ${atom.independentCount} 条独立数据：${tallyText(atom.tallies)}。`
    : atom.origin.length ? '只有出处，还没有出处之外的数据检验它。' : '还没有任何外部数据。'

  return h('div', { class: 'rdr-detail-body' },
    h('div', { class: 'rdr-detail-head' },
      h('h3', { class: 'rdr-detail-title' }, atom.title),
      h('span', { class: 'rdr-atom-type' }, atom.typeLabel),
      h('span', { class: `rdr-chip is-state-${atom.state}` }, state.label),
      onClose ? h('button', { type: 'button', class: 'btn btn-sm rdr-detail-close', onclick: onClose }, '收起') : null),
    atom.currentText ? h('p', { class: 'rdr-atomd-current' }, h('span', { class: 'rdr-atomd-label' }, '当前表述'), atom.currentText) : null,
    h('p', { class: 'rdr-atomd-summary' }, summary),
    weightedSummary(atom.independent),

    block(`出处 · ${atom.origin.length}`, atom.origin.length
      ? h('ul', { class: 'rdr-ev-list' }, ...atom.origin.map((row) => evidenceRow(row, { showStance: false, external: false })))
      : h('p', { class: 'rdr-detail-caliber' }, '没有记录出处：这个原子不是从某条外部数据里抽出来的。')),

    block(`独立外部数据 · ${atom.independentCount}`, atom.independentCount
      ? h('ul', { class: 'rdr-ev-list' }, ...atom.independent.map((row) => evidenceRow(row, { showStance: true })))
      : h('p', { class: 'rdr-detail-caliber' }, '还没有出处之外的数据。新数据进来、在建设者里确认它对这个原子的表态后，会出现在这里。')),

    atom.pending.length
      ? block(`待确认 · ${atom.pending.length}`,
        h('ul', { class: 'rdr-ev-list' }, ...atom.pending.map((row) => evidenceRow(row, { showStance: true }))),
        h('p', { class: 'rdr-detail-caliber' }, '这些数据还没在建设者里确认表态，暂不计入佐证 / 反对 / 中立。'))
      : null,

    atom.related.length
      ? block(`修订 / 推导依据 · ${atom.related.length}`,
        h('ul', { class: 'rdr-ev-list' }, ...atom.related.map((row) => evidenceRow(row, { showStance: true }))),
        h('p', { class: 'rdr-detail-caliber' }, '这些数据用来修订或推出这个原子，不算佐证或反对。'))
      : null,

    corrections.length
      ? block(`修订历史 · ${corrections.length}`, h('ol', { class: 'rdr-atomd-revisions' }, ...corrections.map((item) => h('li', {},
        h('span', { class: 'rdr-ev-when' }, item.day ? `${item.day} 记录` : '日期未记录'),
        item.oldValue ? h('span', { class: 'rdr-atomd-old' }, item.oldValue) : null,
        h('span', { class: 'rdr-atomd-new' }, item.newValue),
        item.reason ? h('span', { class: 'rdr-atomd-reason' }, `理由：${item.reason}`) : null))))
      : null,

    atom.settle || atom.falsifier
      ? block('见分晓',
        atom.settle ? h('p', { class: `rdr-atomd-settle is-${atom.settle.tone}` }, settleText(atom.settle)) : null,
        atom.falsifier ? h('p', { class: 'rdr-atomd-falsifier' }, `推翻条件：${atom.falsifier}`) : null)
      : null,

    relations.length
      ? block(`关系 · ${relations.length}`, h('ul', { class: 'rdr-atomd-relations' }, ...relations.map((rel) => h('li', {},
        h('span', { class: 'rdr-atomd-rel' }, rel.direction === 'out' ? `${rel.label} →` : `← ${rel.label}`),
        onOpenAtom
          ? h('button', { type: 'button', class: 'rdr-atomd-rel-target', onclick: (event) => onOpenAtom(rel.id, event.currentTarget) }, rel.title)
          : h('span', {}, rel.title)))))
      : null,

    engineStrength != null
      ? h('p', { class: 'rdr-detail-caliber' }, `引擎强度 ${engineStrength}%：引擎按来源类型与归因力度算出的分，仅供参考；读者页不按它排序或分组。`)
      : null)
}
