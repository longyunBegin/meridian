import { h } from '../lib/dom.js'

/**
 * 第 ④ 层「结论页」：让读者 30 秒建立对这个主题的模型。
 *
 * 设计原则（用户要求：具象化我们处理的数据，让读者能直观建模）
 * - 这里的每一句话都从真实数据推导，**不生成新内容**；推导不出来就如实写"没有"。
 * - 口径写在页面上。尤其"观点覆盖率"不是"结论为真的概率"，只是"我们手上有没有材料的比例"——
 *   不把"暂未发现"包装成"确定没有"。
 * - 数字都能追到证据：支持/反对条数、独立来源家数（按 sourceLabel 去重，同一家媒体多次只算 1 家）。
 */

const titleOf = (node) => String(node?.title || node?.label || '未命名观点').trim()

const sourceLabels = (rows) => [...(rows?.supports || []), ...(rows?.against || []), ...(rows?.both || [])]
  .map((row) => String(row?.source?.provenance?.sourceLabel || row?.source?.sourceLabel || '').trim())
  .filter(Boolean)

export function renderReaderConclusion({ summary = null, claims = [], gaps = [], evidenceForNode, onOpenClaim } = {}) {
  const nodeCount = summary?.nodeCount || 0
  const strongest = summary?.strongest || null
  const disputed = summary?.mostDisputed || null

  const rowsFor = (node) => {
    try { return (typeof evidenceForNode === 'function' ? evidenceForNode(node?.id) : null) || null } catch { return null }
  }
  const countsFor = (node) => {
    const rows = rowsFor(node)
    const support = (rows?.supports?.length || 0) + (rows?.both?.length || 0)
    const challenge = (rows?.against?.length || 0) + (rows?.both?.length || 0)
    return { support, challenge, sources: new Set(sourceLabels(rows)).size }
  }

  /* 覆盖率：至少有 1 条已表态来源的观点 ÷ 全部观点。口径写在下面。 */
  const withEvidence = claims.filter((node) => {
    const { support, challenge } = countsFor(node)
    return support + challenge > 0
  }).length
  const coverage = nodeCount ? Math.round((withEvidence / nodeCount) * 100) : 0

  /* 结论句：只把已有的事实用人话说一遍。 */
  let verdict
  if (!nodeCount) {
    verdict = '这个主题还没有可以被支持或反驳的观点——目前只有节点与来源。'
  } else {
    /* 强度为 0 或没有强度记录时，不许叫"最站得住"——那只是"账本里还没有把它推起来的记录"。 */
    const strengthReady = strongest && Number(strongest.strength) > 0
    const anyStrength = claims.some((node) => Number(node?.confidence ?? node?.strength ?? 0) > 0)
    const head = strengthReady
      ? `这个主题有 ${nodeCount} 条观点。目前最站得住的是「${strongest.title}」（强度 ${strongest.strength}%）`
      : `这个主题有 ${nodeCount} 条观点。${anyStrength ? '还没有哪一条明显更站得住' : '账本里还没有任何观点的强度被推起来（都是 0）'}`
    let tail = '；还没有观点同时收到支持与反对的证据'
    if (disputed && disputed.support > 0 && disputed.challenge > 0) {
      tail = Math.abs(disputed.support - disputed.challenge) <= 1
        ? `；分歧最大的是「${disputed.title}」（支持 ${disputed.support} · 反对 ${disputed.challenge}）`
        : `；两边都有证据的是「${disputed.title}」（支持 ${disputed.support} · 反对 ${disputed.challenge}）`
    }
    verdict = `${head}${tail}。`
  }

  /* 最值得先看的两条：优先"最站得住 / 分歧最大"；这两个判据都不成立时（例如强度还没被来源推起来），
     退而给"来源最多的两条"——同样是从真实数据推出来的，不编。 */
  const picks = []
  if (strongest && nodeCount && Number(strongest.strength) > 0) picks.push({ tag: '最站得住', id: strongest.id, title: strongest.title, strength: strongest.strength })
  if (disputed && disputed.id !== strongest?.id) picks.push({ tag: '分歧最大', id: disputed.id, title: disputed.title })
  if (picks.length < 2) {
    const ranked = claims.map((node) => ({ node, ...countsFor(node) }))
      .filter((row) => row.support + row.challenge > 0)
      .sort((a, b) => (b.support + b.challenge) - (a.support + a.challenge))
    for (const row of ranked) {
      if (picks.length >= 2) break
      if (picks.some((pick) => pick.id === row.node.id)) continue
      picks.push({ tag: '来源最多', id: row.node.id, title: titleOf(row.node) })
    }
  }

  const pickRow = (pick) => {
    const { support, challenge, sources } = countsFor({ id: pick.id })
    const bits = []
    if (support || challenge) bits.push(`支持 ${support} · 反对 ${challenge}`)
    if (sources) bits.push(`独立来源 ${sources} 家`)
    return h('li', { class: 'rdr-conclusion-pick' },
      h('span', { class: 'rdr-conclusion-tag' }, pick.tag),
      h('span', { class: 'rdr-conclusion-pick-title' }, pick.title),
      Number(pick.strength) > 0 ? h('span', { class: 'rdr-conclusion-strength' }, `强度 ${pick.strength}%`) : null,
      h('span', { class: 'rdr-conclusion-counts' }, bits.join(' · ') || '还没有已表态的来源'),
      onOpenClaim ? h('button', {
        type: 'button', class: 'btn btn-sm rdr-conclusion-open',
        onclick: () => onOpenClaim(pick.id),
      }, '看它的理由') : null)
  }

  const topGaps = gaps.slice(0, 3)

  return h('div', { class: 'rdr-conclusion-body' },
    h('p', { class: 'rdr-conclusion-verdict' }, verdict),
    h('div', { class: 'rdr-conclusion-coverage' },
      h('div', { class: 'rdr-conclusion-bar', role: 'img', 'aria-label': `观点覆盖率 ${coverage}%` },
        h('span', { class: 'rdr-conclusion-bar-fill', style: `width:${coverage}%` })),
      h('div', { class: 'rdr-conclusion-coverage-text' },
        h('strong', {}, `观点覆盖率 ${withEvidence} / ${nodeCount}`),
        h('span', {}, `（${coverage}%）至少有 1 条已表态来源的观点 ÷ 全部观点。它不是"结论为真的概率"。`))),
    picks.length ? h('div', { class: 'rdr-conclusion-block' },
      h('h3', { class: 'rdr-conclusion-head' }, '最值得先看的两条'),
      h('ul', { class: 'rdr-conclusion-picks' }, ...picks.map(pickRow))) : null,
    h('div', { class: 'rdr-conclusion-block' },
      h('h3', { class: 'rdr-conclusion-head' }, '现在最缺的'),
      topGaps.length
        ? h('ul', { class: 'rdr-conclusion-gaps' }, ...topGaps.map((gap) => h('li', {},
          h('span', { class: 'rdr-conclusion-gap-title' }, gap.title || '（未命名）'),
          h('span', { class: 'rdr-conclusion-gap-detail' }, gap.detail || ''))))
        : h('p', { class: 'rdr-conclusion-gap-detail' }, '按当前口径没有发现缺口——不等于已经足够，只说明"已记录的证据都挂到了某条观点上"。')))
}
