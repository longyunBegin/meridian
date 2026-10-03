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
    /* 没有强度记录（null = 中性，不是 0）时，不许叫"最站得住"——那只是"账本里还没有这条记录"。 */
    const strengthReady = strongest && Number(strongest.strength) > 0
    const anyStrength = claims.some((node) => Number(node?.confidence ?? node?.strength ?? 0) > 0)
    const head = strengthReady
      ? `这个主题有 ${nodeCount} 条观点。目前最站得住的是「${strongest.title}」（强度 ${strongest.strength}%）`
      : `这个主题有 ${nodeCount} 条观点。${anyStrength ? '还没有哪一条明显更站得住' : '账本里还没有任何观点的强度记录（中性，不等于 0）'}`
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
  /* 最值得先看的 5 条：排序口径写在页面上，每张卡都写「为什么排这里」。
     顺序 = 读者最该先知道的：① 两边都有人（争议）② 一个来源都没有（空洞）
     ③ 只有一家来源（脆弱）④ 独立来源最多（最有据）。全部从真实数据推；强度为空就不显示。 */
  /* 七彩：按排名给每张卡一个色相，作为左侧色条与徽标色（视觉上区分名次）。 */
  const RAINBOW = [
    'hsl(357 76% 60%)', 'hsl(28 92% 58%)', 'hsl(45 92% 52%)',
    'hsl(142 62% 45%)', 'hsl(199 85% 52%)', 'hsl(262 68% 62%)', 'hsl(322 70% 58%)',
  ]
  const scored = claims.map((node) => {
    const s = countsFor(node)
    const stated = s.support + s.challenge
    const both = s.support > 0 && s.challenge > 0
    const gap = stated === 0
    const single = !gap && s.sources <= 1
    /* 三因子（用户指定）：变化幅度 · 证据密度 · 临界状态——都只从真实数据取。 */
    const history = Array.isArray(node?.confidenceHistory) ? node.confidenceHistory : []
    const last = history.length ? history[history.length - 1] : null
    const swing = last && Number.isFinite(Number(last.newConfidence)) && Number.isFinite(Number(last.oldConfidence))
      ? Math.abs(Number(last.newConfidence) - Number(last.oldConfidence))
      : 0
    const density = stated * 6 + s.sources * 8
    const critical = both ? 60 - Math.abs(s.support - s.challenge) * 12 : gap ? 50 : single ? 30 : 10
    const score = critical + density + swing * 1.5
    const reason = [
      both
        ? (s.support === s.challenge
          ? `反对与支持一样多（${s.support} : ${s.challenge}）`
          : `两边都有证据（支持 ${s.support} · 反对 ${s.challenge}）`)
        : gap ? '一个来源都还没有'
          : single ? `只有 1 家来源（${s.support ? '支持' : '反对'} ${stated} 条）`
            : `${s.sources} 家独立来源、没有反对`,
      s.stated ? `证据密度：已表态 ${s.stated} 条 · 独立来源 ${s.sources} 家` : null,
      swing ? `最近变化 ±${Math.round(swing)}` : null,
    ].filter(Boolean).join(' · ')
    const rawStrength = Number(node.confidence ?? node.strength)
    return {
      node, support: s.support, challenge: s.challenge, sources: s.sources, score, reason,
      strength: Number.isFinite(rawStrength) && rawStrength > 0 ? Math.round(rawStrength) : null,
      tag: both ? '有争议' : gap ? '没有来源' : single ? '单一来源' : '最有据',
    }
  }).sort((a, b) => b.score - a.score || String(a.node?.id).localeCompare(String(b.node?.id)))
  const picks = scored.slice(0, 5)

  const pickRow = (pick, index) => {
    const accent = RAINBOW[index % RAINBOW.length]
    const bits = []
    if (pick.support || pick.challenge) bits.push(`支持 ${pick.support} · 反对 ${pick.challenge}`)
    if (pick.sources) bits.push(`独立来源 ${pick.sources} 家`)
    return h('li', { class: 'rdr-conclusion-pick', style: { '--rdr-pick-accent': accent } },
      h('span', { class: 'rdr-conclusion-tag' }, pick.tag),
      h('span', { class: 'rdr-conclusion-pick-title' }, pick.node?.title || '未命名观点'),
      pick.strength ? h('span', { class: 'rdr-conclusion-strength' }, `强度 ${pick.strength}%`) : null,
      h('span', { class: 'rdr-conclusion-counts' }, bits.join(' · ') || '还没有已表态的来源'),
      pick.reason ? h('span', { class: 'rdr-conclusion-reason' }, pick.reason) : null,
      onOpenClaim ? h('button', {
        type: 'button', class: 'btn btn-sm rdr-conclusion-open',
        onclick: () => onOpenClaim(pick.node?.id),
      }, '看它的理由') : null)
  }

  const topGaps = gaps.slice(0, 3)

  return h('div', { class: 'rdr-conclusion-body' },
    h('div', { class: 'rdr-conclusion-block' },
      h('h2', { class: 'rdr-conclusion-head' }, '当前最该看的 5 个'),
      h('p', { class: 'rdr-conclusion-caliber' }, '按变化幅度 · 证据密度 · 临界状态综合排序（变化幅度需要强度历史，没有历史时不计入）。'),
      h('ul', { class: 'rdr-conclusion-picks' }, ...picks.map((pick, index) => pickRow(pick, index)))))
}
