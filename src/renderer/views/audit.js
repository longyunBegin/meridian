import { h, clear } from '../lib/dom.js'

const m = window.meridian

// 归位忽略是用户选择，独立展示，不计入过滤裁决的分母。
const GATE_LABELS = { extract: '抽取阶段', source: '来源质量闸', dedup: '去重闸', user: '用户拒绝', routeIgnored: '归位提议忽略', other: '其他裁决' }
const REASON_LABELS = { 'off-topic': '离题', 'duplicate': '重复', 'low-quality': '低质', 'rejected': '用户拒绝' }
const percent = (rate) => `${(rate * 100).toFixed(1)}%`

export async function renderAudit(mid) {
  clear(mid)
  const a = await m.falseKill(30)
  // 通道已移除：只显示来源 id
  const chName = (id) => id || '未知通道'
  const keys = ['source', 'dedup', 'user', 'routeIgnored']
  if (a.byGate.other.total) keys.push('other')
  const card = h('div', { class: 'audit' },
    h('div', { class: 'audit-tag' }, '误杀审计 · 30 天周期'),
    // L3 caption：这两个数字是过滤器的副产物，不是内容——不该占首屏最显眼处
    h('div', { class: 'audit-scope' }, `近 30 天 ${a.total} 条 · 全部 ${a.allTotal} 条`),
    h('div', { class: 'sub' }, `近 30 天筛掉了 ${a.total} 条，其中 ${a.missed} 条后来证明有用（误杀率 ${percent(a.rate)}）。`),
    ...keys.map((key) => {
      const group = a.byGate[key]
      return h('details', { class: 'audit-detail', dataset: { gate: key } },
        h('summary', { class: 'item audit-item', style: { display: 'list-item' } }, `${GATE_LABELS[key]} · ${group.total} 条 · ${key === 'routeIgnored' ? '后来入图' : '误杀'} ${group.missed} 条 · ${percent(group.rate)}`),
        group.total
          ? h('div', {}, ...group.items.map((entry) => recordDetail(entry, chName)))
          : h('div', { class: 'sub' }, '近 30 天没有记录。'),
      )
    }),
  )
  mid.append(h('div', { class: 'page', style: { padding: 0 } }, card))
}

function recordDetail({ verdict, proposal, node }, chName) {
  const route = !!proposal
  const record = proposal || verdict
  const reason = route ? '用户忽略归位建议' : REASON_LABELS[record.reason] || record.reason
  const at = route ? record.ignoredAt : record.at
  const summary = route ? record.title || record.text : record.summary
  const channel = route ? record.originChannel : record.channelId
  const channelLabel = typeof channel === 'object' && channel
    ? channel.kind || channel.label || channel.url || chName(channel.id)
    : chName(channel)
  const row = (label, value) => h('div', { class: 'audit-chain-row' },
    h('span', { class: 'audit-chain-k' }, label),
    h('span', {}, String(value ?? '—')),
  )
  const later = node
    ? `${node.title}（创建于 ${node.createdAt || '?'}）`
    : record.promotedTo ? `目标节点已不存在（${record.promotedTo}），保留回填记录` : '尚未回填'
  return h('details', {},
    h('summary', { class: 'item audit-item', style: { display: 'list-item' } },
      h('div', {},
        h('b', {}, node?.title || summary || '无摘要'),
        h('span', {}, `${reason} · ${at || '日期未知'} · ${record.promotedTo ? '已回填' : '尚未回填'}`),
      ),
    ),
    h('div', { class: 'audit-detail' },
      h('div', { class: 'audit-chain' },
        row('闸门', route ? GATE_LABELS.routeIgnored : GATE_LABELS[record.gate] || record.gate),
        row('原因', reason),
        route ? row('建议主题', record.matchedTheme?.name || record.matchedTheme?.title || record.matchedTheme?.id) : row('质量分', record.score),
        route ? row('匹配分', record.bestScore) : record.choice ? row('来源', record.choice) : null,
        route && record.matchedTags?.length ? row('匹配标签', record.matchedTags.map((t) => typeof t === 'string' ? t : t.name || t.text || t.id).join('、')) : null,
        channel ? row('通道', channelLabel) : null,
        summary ? h('div', { class: 'audit-chain-row' },
          h('span', { class: 'audit-chain-k' }, '摘要'),
          h('span', { class: 'audit-chain-summary' }, summary),
        ) : null,
        row(route ? '忽略于' : '筛掉', at),
        row('后来成为', later),
        record.promotedAt ? row('回填于', record.promotedAt) : null,
      ),
    ),
  )
}
