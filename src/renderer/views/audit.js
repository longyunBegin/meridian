import { h, mount, icon, clear } from '../lib/dom.js'
import { state } from '../app.js'

const m = window.meridian

/**
 * 误杀审计。每月一次，只有一个问题。
 * 这个界面一天只允许出现一次，且只能回答「是 / 否」——
 * 做成可浏览的列表，用户就会开始整理它，然后产品变回笔记软件。
 */
const GATE_LABELS = { extract: '抽取阶段', source: '来源质量闸', dedup: '去重闸', user: '用户拒绝' }
const REASON_LABELS = { 'off-topic': '离题', 'duplicate': '重复', 'low-quality': '低质', 'rejected': '用户拒绝' }

export async function renderAudit(mid) {
  clear(mid)
  const [a, channels] = await Promise.all([m.falseKill(30), m.channelList()])
  const chName = (id) => channels.find((c) => c.id === id)?.kind || id || '未知通道'
  const themeNodes = state.themeId ? await m.nodes(state.themeId) : []

  const reveal = h('div', { class: 'reveal', id: 'audit-reveal' })

  const card = h('div', { class: 'audit' },
    h('div', { class: 'audit-tag' }, '误杀审计 · 30 天周期'),
    a.total === 0
      ? h('div', {},
          h('div', { class: 'audit-q' }, '这 30 天没有被筛掉的内容。'),
          h('div', { class: 'sub' }, '过滤器没有工作过——要么来源都很干净，要么还没有开始捕获。'))
      : h('div', {},
          h('div', { class: 'audit-q' },
            a.missed > 0
              ? `这 30 天你筛掉了 ${a.total} 条，其中 ${a.missed} 条后来在别的源里变成了重要命题。`
              : `这 30 天你筛掉了 ${a.total} 条，没有一条后来变成重要命题。`),
          h('div', { class: 'sub' },
            a.missed > 0
              ? '每 30 天一次。它们当时被判为噪声，现在你已经知道它们不是——要不要看看是哪几条，把阈值调过来？'
              : '每 30 天一次。过滤器这一段的工作是干净的，但这只说明误杀率低，不说明筛得对。'),
          h('div', { class: 'acts' },
            a.missed > 0 ? h('button', {
              class: 'btn btn-primary', style: { height: '32px', padding: '0 16px' },
              onclick: () => { reveal.dataset.on = 'true' },
            }, `看看是哪 ${a.missed} 条`) : null,
            h('button', {
              class: 'btn', style: { height: '32px', padding: '0 16px' },
              onclick: (e) => { e.target.textContent = '已推迟到下个周期'; e.target.disabled = true },
            }, '这个周期不管'),
          ),
        ),
    reveal,
  )

  if (a.missed > 0) {
    mount(reveal,
      ...a.items.map(({ verdict, node }) => {
        const detail = h('div', { class: 'audit-detail' },
          h('div', { class: 'audit-chain' },
            h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '闸门'),
              h('span', {}, GATE_LABELS[verdict.gate] || verdict.gate)),
            h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '原因'),
              h('span', {}, REASON_LABELS[verdict.reason] || verdict.reason)),
            h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '质量分'),
              h('span', {}, String(verdict.score))),
            verdict.choice ? h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '来源'),
              h('span', {}, verdict.choice)) : null,
            verdict.channelId ? h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '通道'),
              h('span', {}, chName(verdict.channelId))) : null,
            verdict.summary ? h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '摘要'),
              h('span', { class: 'audit-chain-summary' }, verdict.summary)) : null,
            h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '筛掉'),
              h('span', {}, verdict.at)),
            h('div', { class: 'audit-chain-row' },
              h('span', { class: 'audit-chain-k' }, '后来成为'),
              h('span', {}, `${node.title}（创建于 ${node.createdAt || '?'}）`)),
          ),
        )
        const chev = icon('chevron', 14)
        chev.classList.add('audit-chevron')
        const item = h('div', { class: 'item audit-item', tabindex: '0' },
          h('span', { style: { color: 'var(--orange)', marginTop: '3px' } }, '●'),
          h('div', {},
            h('b', {}, node.title),
            h('span', {}, `当时判为${REASON_LABELS[verdict.reason] || verdict.reason} · ${verdict.choice || '未知来源'} Score ${verdict.score} · 筛于 ${verdict.at}`),
          ),
          chev,
        )
        const toggle = () => {
          const on = item.classList.toggle('expanded')
          if (on && !detail.isConnected) item.after(detail)
          else if (!on && detail.isConnected) detail.remove()
        }
        item.addEventListener('click', toggle)
        item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })
        return item
      }),
      advice(a),
    )
  }

  mid.append(h('div', { class: 'page', style: { padding: 0 } }, card))
}

function advice(a) {
  // 找出误杀最集中的质量分段
  const buckets = new Map()
  for (const { verdict } of a.items) {
    const lo = Math.floor(verdict.score * 10) / 10
    buckets.set(lo, (buckets.get(lo) || 0) + 1)
  }
  const worst = [...buckets.entries()].sort((x, y) => y[1] - x[1])[0]
  if (!worst) return null

  return h('div', { class: 'advice' },
    h('div', { class: 'l' }, '建议'),
    h('div', { class: 't' },
      `误杀集中在来源质量 ${worst[0].toFixed(1)} 附近。把这一档的自动拦截阈值下调，` +
      `让它们落入冷库而不是被丢弃——冷库里的内容仍然参与共同前提扫描，只是不进主图谱。`),
  )
}
