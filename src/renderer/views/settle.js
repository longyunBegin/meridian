import { h, icon, clear } from '../lib/dom.js'
import { state, settleAndPulse } from '../app.js'
import { confColor, nodePath } from './shared.js'

const m = window.meridian

export async function renderSettle(mid) {
  clear(mid)
  const [due, events, calib, filt] = await Promise.all([
    m.due(), m.events(), m.calibration(), m.filterCalibration(),
  ])
  const themeNodes = state.themeId ? (await m.nodes(state.themeId)) : []

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '结算'),
      h('p', {}, '判断只有在被对答案之后才是资产。'),
    ),

    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '到期未结算'), h('em', {}, String(due.length))),
      h('div', { class: 'sect-b' },
        due.length ? due.map((q) => h('div', { class: 'q' },
          h('span', { class: 'dot', style: { background: confColor(q.confidence), marginTop: '6px' } }),
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text' }, q.title),
            h('div', { class: 'q-meta' },
              h('span', {}, `当时置信度 ${Math.round(q.confidence)}`),
              h('span', {}, `· 到期 ${q.settlement.date}`),
              h('span', {}, `· ${nodePath(themeNodes, q.id) || '未归档'}`),
            ),
          ),
          h('div', { class: 'q-acts' },
            h('button', { class: 'btn btn-hit', onclick: async () => { await settleAndPulse(q.id, true); await renderSettle(mid) } }, '对了'),
            h('button', { class: 'btn btn-miss', onclick: async () => { await settleAndPulse(q.id, false); await renderSettle(mid) } }, '错了'),
            h('button', {
              class: 'btn', title: '推迟两周',
              onclick: async () => {
                const d = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)
                await m.updateNode(q.id, { settlement: { date: d, resolved: null, correct: null } })
                await renderSettle(mid)
              },
            }, '再等等'),
          ),
        )) : h('div', { class: 'q' }, h('div', { class: 'q-body' },
          h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '没有到期的问题。给命题设一个结算日，它就会回来找你。'),
        )),
      ),
    ),

    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '最近传导'), h('em', {}, '14 天')),
      h('div', { class: 'sect-b' },
        events.length ? events.slice(0, 8).map((e) => h('div', { class: 'event' },
          icon('lattice', 12),
          h('span', { class: 'src' }, e.title),
          h('span', { class: `amt ${e.delta >= 0 ? 'up' : 'down'}` }, `${e.delta >= 0 ? '+' : ''}${e.delta}`),
          h('span', { style: { fontSize: '11px', color: 'var(--text-3)' } }, `→ ${Math.round(e.confidence)} · ${e.t}`),
        )) : h('div', { class: 'event' }, h('span', { class: 'src', style: { color: 'var(--text-3)' } }, '还没有传导发生过。')),
      ),
    ),

    // ---- 命题校准曲线
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '命题校准曲线'),
        h('em', {}, calib.length ? `${calib.reduce((s, b) => s + b.total, 0)} 条已结算` : '尚无数据')),
      h('div', { class: 'sect-b' },
        calib.length
          ? h('div', { class: 'calib' }, ...calib.map((b) => h('div', {},
              h('em', {}, `${Math.round(b.accuracy * 100)}%`),
              h('i', { style: { height: `${b.accuracy * 100}%`, background: b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } }),
              h('span', {}, `${b.bucket}–${b.bucket + 9}`),
            )))
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '结算几条判断之后，这里会出现你的命中率曲线——这才是复利本身。'),
            )),
        calib.length ? h('div', { style: { marginTop: '12px', fontSize: '11.5px', color: 'var(--text-2)', lineHeight: '1.6' } },
          calib.filter((b) => b.total >= 2).length
            ? overconfidenceNote(calib)
            : '样本还太少。每桶至少 2 条才能看出倾向。') : null,
      ),
    ),

    // ---- 过滤器校准曲线
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '过滤器校准曲线'), h('em', {}, '误杀率')),
      h('div', { class: 'sect-b' },
        filt.some((b) => b.total)
          ? h('div', { class: 'calib' }, ...filt.map((b) => h('div', {},
              h('em', {}, b.total ? `${Math.round(b.accuracy * 100)}%` : '—'),
              h('i', {
                style: { height: `${Math.max(2, b.accuracy * 100)}%`, background: b.accuracy > 0.05 ? 'var(--orange)' : 'var(--accent)' },
              }),
              h('span', {}, `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`),
            )))
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '还没有被筛掉的内容。捕获几篇不同来源的文字后，这里会显示你在哪个质量分段误杀最多。'),
            )),
        filt.some((b) => b.total) ? h('div', { style: { marginTop: '12px', fontSize: '11.5px', color: 'var(--text-2)', lineHeight: '1.6' } },
          '横轴是来源质量分，纵轴是该分段被筛掉的内容后来变成重要命题的比例。') : null,
      ),
    ),
  ))
}

function overconfidenceNote(calib) {
  const solid = calib.filter((b) => b.total >= 2)
  if (solid.length < 2) return '各区间样本都还不足。'
  // 看的是最低的那一桶——高置信度低命中率才是过度自信
  const worst = solid.reduce((a, b) => (b.accuracy < a.accuracy ? b : a))
  const best = solid.reduce((a, b) => (b.accuracy > a.accuracy ? b : a))
  if (worst.bucket === best.bucket) return '各置信度区间的命中率目前没有明显差别。'
  const hi = worst.bucket > best.bucket
  return `你在 ${worst.bucket}–${worst.bucket + 9} 区间只有 ${Math.round(worst.accuracy * 100)}% 命中，` +
    `低于 ${best.bucket}–${best.bucket + 9} 区间的 ${Math.round(best.accuracy * 100)}%。` +
    (hi ? '越确信反而越不准——这是过度自信，是你该被重新定价的地方。' : '低区间的判断反而更可靠。')
}
