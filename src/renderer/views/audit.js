import { h, clear } from '../lib/dom.js'

const m = window.meridian

// 归位忽略是用户选择，独立展示，不计入过滤裁决的分母。
const GATE_LABELS = { extract: '抽取阶段', source: '来源质量闸', dedup: '去重闸', user: '用户拒绝', routeIgnored: '归位提议忽略', other: '其他裁决' }
const REASON_LABELS = { 'off-topic': '离题', 'duplicate': '重复', 'low-quality': '低质', 'rejected': '用户拒绝' }
const percent = (rate) => `${(rate * 100).toFixed(1)}%`

/**
 * 误杀审计（展示层重构 2026-10-01）。
 *
 * 口径诚实化：verdict 上没有独立的"已复核"标记，只有 promotedTo 回填。
 * promotedTo != null = 已确认误杀；其余一律记为"待复核"——可能是筛得对，
 * 也可能还没复核。绝不把"暂未发现"包装成"确定没有"。
 * 只改展示，不碰账本 schema 与 main-process 逻辑。
 */
export async function renderAudit(mid) {
  clear(mid)
  const a = await m.falseKill(30)
  // 通道已移除：只显示来源 id
  const chName = (id) => id || '未知来源'
  const pending = a.total - a.missed

  // 值得担心的闸门排前面：已确认误杀数降序，其次筛掉总数降序
  const gateKeys = ['source', 'dedup', 'user']
  if (a.byGate.other.total) gateKeys.push('other')
  gateKeys.sort((x, y) => (a.byGate[y].missed - a.byGate[x].missed) || (a.byGate[y].total - a.byGate[x].total))

  const stat = (label, num, sub, warn) =>
    h('div', { class: 'fk-stat' },
      h('div', { class: 'fk-num' + (warn ? ' is-warn' : '') }, num),
      h('div', { class: 'fk-stat-label' }, label),
      h('div', { class: 'fk-stat-sub' }, sub))

  mid.append(h('div', { class: 'page', style: { padding: 0 } },
    h('div', { class: 'audit' },
      h('div', { class: 'audit-tag' }, '误杀审计 · 30 天周期'),
      // 首屏三数：直接回答"最近 30 天哪些过滤规则值得担心？"
      h('div', { class: 'fk-hero' },
        stat('筛掉总数', String(a.total), '近 30 天过滤裁决'),
        stat('已确认误杀', String(a.missed), `误杀率 ${percent(a.rate)}`, a.missed > 0),
        stat('待复核', String(pending), '尚未回填入图')),
      h('p', { class: 'fk-caliber' },
        '口径：误杀率 = 已确认误杀 ÷ 筛掉总数。"待复核"指尚未回填入图——可能是筛得对，也可能还没复核；只有"后来证明有用"并回填入图的，才计入误杀。'),
      a.total === 0
        ? h('p', { class: 'fk-verdict' }, '近 30 天没有筛掉记录。')
        : a.missed === 0
          ? h('p', { class: 'fk-verdict' }, '近 30 天没有已确认的误杀，各过滤规则暂无值得担心项。')
          : h('p', { class: 'fk-verdict' }, `有 ${a.missed} 条已确认误杀，涉事闸门已排在前面。`),
      h('div', { class: 'fk-gates' },
        ...gateKeys.map((key) => gateRow(key, a.byGate[key], chName, false)),
        a.byGate.routeIgnored.total ? gateRow('routeIgnored', a.byGate.routeIgnored, chName, true) : null,
      ),
      h('p', { class: 'fk-foot' }, `历史累计 ${a.allTotal} 条裁决。归位忽略是用户选择，独立展示，不计入筛掉分母。`),
      /* 建设者复核里被你驳回的决定：也在"误杀审计"这一栏——
         它要回答的正是"这条被判掉，是不是判错了"。驳回后又被重新声明＝误杀。 */
      a.chainReview?.total ? h('section', { class: 'fk-chain-review' },
        h('h3', {}, `建设者里你驳回了 ${a.chainReview.total} 条复核决定`),
        a.chainReview.reversed
          ? h('p', { class: 'fk-caliber' }, `其中 ${a.chainReview.reversed} 条后来被重新声明——按本页口径计入误杀。`)
          : h('p', { class: 'fk-caliber' }, '目前没有"驳回后又被重新声明"的，说明这些判断还没有被推翻。'),
        h('ul', { class: 'fk-chain-review-list' },
          ...a.chainReview.items.slice(0, 20).map((row) => h('li', {},
            h('span', { class: 'fk-chain-review-kind' }, row.kind),
            h('span', { class: 'fk-chain-review-title' }, row.title),
            h('span', { class: 'fk-chain-review-theme' }, row.themeName || ''),
            row.reversed ? h('b', { class: 'fk-chain-review-flag' }, '已重新确认') : null,
            h('time', {}, String(row.at || '').slice(0, 10)))))) : null,
    ),
  ))
}

/** 闸门行：可展开的轻量列表行。橙色只给"需处理"（有已确认误杀）。 */
function gateRow(key, group, chName, isRoute) {
  const pending = group.total - group.missed
  const warn = group.missed > 0
  const nums = isRoute
    ? `${group.total} 条 · 后来入图 ${group.missed} 条`
    : `筛掉 ${group.total} · 已确认误杀 ${group.missed} · 待复核 ${pending}`
  return h('details', { class: 'fk-gate', dataset: { gate: key } },
    h('summary', { class: 'fk-gate-head' },
      warn ? h('span', { class: 'fk-dot', title: '有已确认误杀，需关注' }) : null,
      h('span', { class: 'fk-gate-name' }, GATE_LABELS[key] || key),
      h('span', { class: 'fk-gate-nums' }, nums),
      h('span', { class: 'fk-chev' }, '›')),
    group.total
      ? h('div', { class: 'fk-recs' }, ...group.items.map((entry) => recordRow(entry, chName, isRoute)))
      : h('div', { class: 'fk-empty' }, '近 30 天没有记录。'),
  )
}

/** 单条裁决：标题行 + 展开后的定义列表。单层容器，无嵌套灰块。 */
function recordRow({ verdict, proposal, node }, chName, isRoute) {
  const record = proposal || verdict
  const reason = isRoute ? '用户忽略归位建议' : REASON_LABELS[record.reason] || record.reason
  const at = isRoute ? record.ignoredAt : record.at
  const summary = isRoute ? record.title || record.text : record.summary
  const channel = isRoute ? record.originChannel : record.channelId
  const channelLabel = typeof channel === 'object' && channel
    ? channel.kind || channel.label || channel.url || chName(channel.id)
    : chName(channel)
  const filled = !!record.promotedTo
  const later = node
    ? `${node.title}（创建于 ${node.createdAt || '?'}）`
    : record.promotedTo ? `目标节点已不存在（${record.promotedTo}），保留回填记录` : '尚未回填'

  const row = (label, value) => value == null ? null : h('div', { class: 'fk-kv' },
    h('span', { class: 'fk-k' }, label),
    h('span', { class: 'fk-v' }, String(value)),
  )
  return h('details', { class: 'fk-rec' },
    h('summary', { class: 'fk-rec-head' },
      filled ? h('span', { class: 'fk-dot', title: '已确认误杀' }) : null,
      h('span', { class: 'fk-rec-title' }, node?.title || summary || '无摘要'),
      h('span', { class: 'fk-rec-meta' }, `${reason} · ${at || '日期未知'} · ${filled ? '已回填' : '尚未回填'}`),
    ),
    h('div', { class: 'fk-rec-body' },
      row('闸门', isRoute ? GATE_LABELS.routeIgnored : GATE_LABELS[record.gate] || record.gate),
      row('原因', reason),
      isRoute
        ? row('建议主题', record.matchedTheme?.name || record.matchedTheme?.title || record.matchedTheme?.id)
        : row('质量分', record.score),
      isRoute ? row('匹配分', record.bestScore) : record.choice ? row('来源', record.choice) : null,
      isRoute && record.matchedTags?.length
        ? row('匹配标签', record.matchedTags.map((t) => typeof t === 'string' ? t : t.name || t.text || t.id).join('、'))
        : null,
      channel ? row('通道', channelLabel) : null,
      summary ? row('摘要', summary) : null,
      row(isRoute ? '忽略于' : '筛掉于', at),
      row('后来成为', later),
      record.promotedAt ? row('回填于', record.promotedAt) : null,
    ),
  )
}
