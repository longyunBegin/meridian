import { h, mount, icon, clear } from '../lib/dom.js'
import { state } from '../app.js'

const m = window.meridian

/**
 * 误杀审计。每月一次，只有一个问题。
 * 这个界面一天只允许出现一次，且只能回答「是 / 否」——
 * 做成可浏览的列表，用户就会开始整理它，然后产品变回笔记软件。
 */
export async function renderAudit(mid) {
  clear(mid)
  const a = await m.falseKill(30)
  const themeNodes = state.themeId ? await m.nodes(state.themeId) : []

  const reveal = h('div', { class: 'reveal', id: 'audit-reveal' })

  const card = h('div', { class: 'audit' },
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
      ...a.items.map(({ verdict, node }) => h('div', { class: 'item' },
        h('span', { style: { color: 'var(--orange)', marginTop: '3px' } }, '●'),
        h('div', {},
          h('b', {}, node.title),
          h('span', {}, `当时判为${verdict.reason === 'duplicate' ? '重复' : '低质'} · ${verdict.choice || '未知来源'} Score ${verdict.score} · 筛于 ${verdict.at}`),
        ),
      )),
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
