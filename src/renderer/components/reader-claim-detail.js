import { h } from '../lib/dom.js'
import { svgEl } from '../lib/theme-network-render.js'
import { strengthSparkline } from '../lib/reader-model.js'
import { CLAIM_STATES } from './reader-claim-map.js'
import { RELATION_LABEL } from '../lib/chain-ui-model.js'

/**
 * 第 ①③ 层「单条下钻」：就地展开在地图下方（读者不丢上下文）。
 *
 * ① 天平：支持/反对的条数与独立来源家数（按来源名去重，口径写在界面上）。
 * ③ 证据收据：逐笔可核对——方向、来源、时间、复核状态、原文链接。
 *    诚实边界：**边上没有 weight 字段**（实测 `(无 weight)`），所以这里不给"权重"这一列，
 *    并明说"账本里没有记录权重"，而不是拿别的数冒充权重。
 * 强度曲线：复用 strengthSparkline（reader-model）。没有强度记录（confidence=null，中性）
 *    时如实说"画不出曲线（不是强度为 0）"，不画一条假的平线。
 */

const relLabel = (rel) => (rel === 'contradicts' ? '反对' : rel === 'supports' ? '支持' : rel || '关系')

const reviewLabel = (edge) => {
  if (!edge) return '未记录'
  if (edge.reviewDecision === 'rejected') return '已驳回（不计入天平）'
  if (edge.reviewDecision) return '已确认'
  if (edge.pendingReview) return '待人工复核'
  return '已记录'
}

const whenOf = (row) => {
  const raw = row?.source?.sourcePublishedAt || row?.source?.provenance?.publishedAt
    || row?.source?.provenance?.fetchedAt || row?.source?.createdAt || null
  if (!raw) return '时间未记录'
  try { return String(raw).slice(0, 10) } catch { return '时间未记录' }
}

const urlOf = (row) => {
  const raw = String(row?.source?.sourceUrl || row?.source?.provenance?.url || '').trim()
  try { return /^https?:$/.test(new URL(raw).protocol) ? raw : '' } catch { return '' }
}

export function renderReaderClaimDetail({ node, stats = {}, rows = {}, relations = [], weights = null, onOpenRelation, onClose } = {}) {
  const support = stats.support || 0
  const challenge = stats.challenge || 0
  const both = rows?.both?.length || 0
  const stated = support + challenge
  const total = Math.max(1, stated)
  const meta = CLAIM_STATES[stats.state] || CLAIM_STATES.none

  const receipt = [...(rows?.supports || []), ...(rows?.against || []), ...(rows?.both || []), ...(rows?.unclassified || [])]
  /* 每行证据的权重：从该证据节点的事件 id 去权重表里取（没有就是没有，不补别的数）。 */
  const weightOf = (row) => {
    if (!weights || typeof weights.get !== 'function') return null
    for (const id of (row?.source?.eventIds || [])) {
      const hit = weights.get(id)
      if (hit) return hit
    }
    return null
  }
  const hasWeight = receipt.some((row) => weightOf(row) != null)
  /* 强度：当前值、上期值与环比——全部来自账本；没有记录就如实留白。 */
  const rawStrength = node?.confidence ?? node?.strength
  const strength = rawStrength == null || !Number.isFinite(Number(rawStrength)) || Number(rawStrength) <= 0
    ? null : Math.round(Number(rawStrength))
  const history = Array.isArray(node?.confidenceHistory) ? node.confidenceHistory : []
  const previousValue = history.length >= 2 ? Number(history[history.length - 2]?.newConfidence) : null
  const delta = strength != null && Number.isFinite(previousValue) ? strength - Math.round(previousValue) : null
  const deltaText = delta == null ? null : delta === 0 ? '与上期持平' : delta > 0 ? `相比上期上升 ${delta} 个百分点` : `相比上期下降 ${Math.abs(delta)} 个百分点`
  /* 当前理解：只用账本里已有的量拼，不编方向。 */
  const understanding = strength == null
    ? `这条观点有 ${stated} 条已表态来源（支持 ${support} · 反对 ${challenge}${unclassified ? ` · 未表态 ${unclassified}` : ''}），但账本里还没有它的强度记录。`
    : `综合 ${stated} 条已表态来源，当前强度 ${strength}%，整体呈现「${meta.label}」态势。`
  const unclassified = rows?.unclassified?.length || 0
  const rejected = rows?.rejected?.length || 0

  /* 强度曲线：复用 reader-model 的 strengthSparkline，画不出来就直说。 */
  const spark = (() => { try { return strengthSparkline(node, { width: 220, height: 40 }) } catch { return null } })()
  const sparkFigure = spark?.enough
    ? h('div', { class: 'rdr-detail-spark' },
      (() => {
        const svg = svgEl('svg', { viewBox: '0 0 220 40', class: 'rdr-detail-spark-canvas', role: 'img', 'aria-label': `强度变化：最低 ${spark.min}，最高 ${spark.max}` })
        svg.append(svgEl('polyline', { points: spark.points, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2' }))
        return svg
      })(),
      h('span', { class: 'rdr-detail-spark-text' }, `强度 ${spark.min}–${spark.max}（${spark.values.length} 次记录）`))
    : h('p', { class: 'rdr-detail-spark-text' }, history.length === 1
      ? '只有一次强度记录，画不出趋势——再有一次变化就会出现。'
      : '账本里还没有这条观点的强度记录，画不出曲线——没有记录不等于强度为 0。')

  const receiptRow = (row) => {
    const isAgainst = (rows?.against || []).includes(row)
    const isUnstated = (rows?.unclassified || []).includes(row)
    const isBoth = (rows?.both || []).includes(row)
    const url = urlOf(row)
    return h('li', { class: `rdr-detail-receipt-row${isAgainst ? ' is-against' : ''}` },
      h('span', { class: 'rdr-detail-receipt-dir' }, isBoth ? '± 两边' : isAgainst ? '− 反对' : isUnstated ? '· 未表态' : '+ 支持'),
      h('span', { class: 'rdr-detail-receipt-source' }, row?.source?.title || '（未命名来源）'),
      (() => { const w = weightOf(row); return w ? h('span', { class: 'rdr-detail-receipt-weight' },
        `权重 ${w.value.toFixed(2)}${w.manual ? ' · 人工' : ''}`) : null })(),
      h('span', { class: 'rdr-detail-receipt-label' }, row?.source?.provenance?.sourceLabel || row?.source?.sourceLabel || '来源未标注'),
      h('span', { class: 'rdr-detail-receipt-when' }, whenOf(row)),
      h('span', { class: 'rdr-detail-receipt-review' }, relLabel(row?.edge?.rel) + ' · ' + reviewLabel(row?.edge)),
      hasWeight ? h('span', { class: 'rdr-detail-receipt-weight' }, `权重 ${Number(row?.edge?.weight).toFixed(2)}`) : null,
      url ? h('a', { class: 'rdr-detail-receipt-link', href: url, target: '_blank', rel: 'noreferrer noopener' }, '原文 ↗') : null)
  }

  return h('div', { class: 'rdr-detail-body' },
    h('div', { class: 'rdr-detail-head' },
      h('h3', { class: 'rdr-detail-title' }, node?.title || '未命名观点'),
      h('span', { class: `rdr-detail-state is-${stats.state || 'none'}` }, meta.label),
      onClose ? h('button', { type: 'button', class: 'btn btn-sm rdr-detail-close', onclick: onClose }, '收起') : null),

    /* ① 天平 */
    h('div', { class: 'rdr-detail-scale' },
      h('div', { class: 'rdr-detail-scale-row' },
        h('span', { class: 'rdr-detail-scale-label' }, '支持'),
        h('span', { class: 'rdr-detail-scale-bar' }, h('span', { class: 'rdr-detail-scale-fill is-support', style: `width:${Math.round((support / total) * 100)}%` })),
        h('span', { class: 'rdr-detail-scale-count' }, String(support))),
      h('div', { class: 'rdr-detail-scale-row' },
        h('span', { class: 'rdr-detail-scale-label' }, '反对'),
        h('span', { class: 'rdr-detail-scale-bar' }, h('span', { class: 'rdr-detail-scale-fill is-against', style: `width:${Math.round((challenge / total) * 100)}%` })),
        h('span', { class: 'rdr-detail-scale-count' }, String(challenge))),
      h('div', { class: 'rdr-detail-scale-row' },
        h('span', { class: 'rdr-detail-scale-label' }, '未表态'),
        h('span', { class: 'rdr-detail-scale-bar' }, h('span', { class: 'rdr-detail-scale-fill is-unstated', style: `width:${Math.round((unclassified / Math.max(1, stated + unclassified)) * 100)}%` })),
        h('span', { class: 'rdr-detail-scale-count' }, String(unclassified))),
      h('p', { class: 'rdr-detail-caliber' },
        `独立来源 ${stats.sources || 0} 家（按来源名去重：同一家媒体发多条只算 1 家）。`
        + (both ? ` 其中 ${both} 条同时给了支持和反对。` : '')
        + (unclassified ? ` 另有 ${unclassified} 条挂载但未表态，不计入天平。` : '')
        + (rejected ? ` 有 ${rejected} 条表态已被驳回，不计入。` : ''))),

    /* 相关原子：这条观点在账本里真实连着的其它观点（可为空）。 */
    relations.length ? h('div', { class: 'rdr-detail-relations' },
      h('h4', { class: 'rdr-detail-subhead' }, `相关原子 · ${relations.length}`),
      h('ul', { class: 'rdr-detail-rel-list' }, ...relations.map((rel) => h('li', {},
        h('span', { class: `rdr-detail-rel-label is-${rel.rel}` }, RELATION_LABEL?.[rel.rel] || rel.rel || '关系'),
        onOpenRelation
          ? h('button', { type: 'button', class: 'rdr-detail-rel-target', onclick: () => onOpenRelation(rel.id) }, String(rel.title || '未命名观点'))
          : h('span', {}, String(rel.title || '未命名观点')))))) : null,

    /* ②′ 强度：大号数字 + 环比 + 刻度（用户给的 demo 里就是这样呈现的） */
    h('div', { class: 'rdr-detail-strength' },
      h('div', { class: 'rdr-detail-strength-head' },
        h('span', { class: 'rdr-detail-strength-num' }, strength == null ? '—' : `${strength}%`),
        h('span', { class: 'rdr-detail-strength-delta' }, deltaText || (strength == null ? '账本里还没有强度记录' : '只有一次记录，还比不出环比')),
        h('span', { class: 'rdr-detail-strength-base' }, `基于 ${stated} 条已表态证据`)),
      h('div', { class: 'rdr-detail-strength-bar' },
        h('span', { class: 'rdr-detail-strength-fill', style: `width:${strength == null ? 0 : strength}%` })),
      h('div', { class: 'rdr-detail-strength-scale' }, h('span', {}, '强度区间 0 — 100'))),

    /* ②″ 当前理解：一句话，只用账本里已有的量 */
    h('div', { class: 'rdr-detail-understanding' },
      h('h4', { class: 'rdr-detail-subhead' }, '当前理解'),
      h('p', {}, understanding)),

    /* ③ 证据收据（完整证据流：支持 / 反对 / 两边 / 未表态） */
    h('div', { class: 'rdr-detail-receipt' },
      h('h4', { class: 'rdr-detail-subhead' }, `证据流 · ${receipt.length} 笔`),
      receipt.length
        ? h('ul', { class: 'rdr-detail-receipt-list' }, ...receipt.map(receiptRow))
        : h('p', { class: 'rdr-detail-caliber' }, '这条观点还没有任何已表态的来源。'),
      hasWeight
        ? h('p', { class: 'rdr-detail-caliber' }, '权重 = 该条证据落账时的强度；标「人工」的是确认建议时由你指定的，其余来自引擎。')
        : h('p', { class: 'rdr-detail-caliber' }, '账本里没有记录每条来源的权重，所以这里不给权重——宁可少一列，也不拿别的数冒充。')),

    h('div', { class: 'rdr-detail-spark-block' },
      h('h4', { class: 'rdr-detail-subhead' }, '强度变化'),
      sparkFigure))
}
