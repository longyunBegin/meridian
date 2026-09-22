import { h, icon, clear } from '../lib/dom.js'
import { state, selectTheme, selectNode, setView } from '../app.js'
import { confColor, TYPE_LABEL, nodePath } from './shared.js'

const m = window.meridian

const META = {
  conflicts: {
    title: '待裁决冲突',
    note: '系统只标出矛盾，不替你裁决。每条冲突都是一次必须由你做出的判断。',
  },
  cold: {
    title: '冷库',
    note: '低质但可能为真的内容。不进主图谱，但仍参与共同前提扫描——弱信号经常来自弱来源。',
  },
  dead: {
    title: '墓碑区',
    note: '置信度跌破 20 或被证伪的命题。不删除——负资产的价值是避免重复犯错。',
  },
  filtered: {
    title: '已筛掉',
    note: '只留裁决记录，不留原文。若同一条 claim 后来从别的源进了图谱，记为一次误杀。',
  },
}

export async function renderVault(mid, kind) {
  clear(mid)
  const meta = META[kind] || META.cold

  if (kind === 'conflicts') return renderConflicts(mid, meta)
  if (kind === 'filtered') return renderFiltered(mid, meta)

  const nodes = (await m.nodes(state.themeId)).filter((n) =>
    kind === 'cold' ? n.status === 'cold' : n.status === 'dead')

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note),
    ),
    nodes.length
      ? h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, state.themes.find((t) => t.id === state.themeId)?.name || ''), h('em', {}, String(nodes.length))),
          h('div', { class: 'sect-b' },
            ...nodes.map((n) => h('div', { class: 'q' },
              h('span', { class: 'dot', style: { background: confColor(n.confidence), marginTop: '6px' } }),
              h('div', { class: 'q-body' },
                h('div', { class: 'q-text' }, n.title),
                h('div', { class: 'q-meta' },
                  h('span', {}, TYPE_LABEL[n.type]),
                  h('span', {}, `· 置信度 ${Math.round(n.confidence)}`),
                  h('span', {}, `· ${nodePath(state.nodes, n.id) || '未归档'}`),
                ),
              ),
              h('div', { class: 'q-acts' },
                h('button', {
                  class: 'btn',
                  onclick: async () => {
                    await m.updateNode(n.id, { status: kind === 'cold' ? 'live' : 'live', confidence: kind === 'dead' ? Math.max(25, n.confidence) : n.confidence })
                    await renderVault(mid, kind)
                  },
                }, kind === 'cold' ? '移回主图谱' : '复活'),
                h('button', { class: 'btn', onclick: () => { selectNode(n.id); setView('lattice') } }, '查看'),
              ),
            )),
          ),
        )
      : empty(meta),
  ))
}

async function renderConflicts(mid, meta) {
  const conflicts = await m.conflicts()
  const all = state.themeId ? await m.nodes(state.themeId) : []
  const byId = new Map(all.map((n) => [n.id, n]))

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note),
    ),
    conflicts.length
      ? h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, '待你裁决'), h('em', {}, String(conflicts.length))),
          h('div', { class: 'sect-b' },
            ...conflicts.map((c) => {
              const a = byId.get(c.a)
              const b = byId.get(c.b)
              if (!a || !b) return null
              return h('div', { class: 'conflict' },
                h('div', { class: 'note' }, `${c.note} · 发现于 ${c.at}`),
                h('div', { class: 'pair' },
                  side(a, 'A'),
                  h('span', { class: 'vs' }, 'vs'),
                  side(b, 'B'),
                ),
                h('div', { class: 'acts' },
                  h('button', { class: 'btn', onclick: async () => { await m.resolveConflict(c.id, 'a'); await renderVault(mid, 'conflicts') } }, 'A 成立'),
                  h('button', { class: 'btn', onclick: async () => { await m.resolveConflict(c.id, 'b'); await renderVault(mid, 'conflicts') } }, 'B 成立'),
                  h('button', { class: 'btn', onclick: async () => { await m.resolveConflict(c.id, 'both'); await renderVault(mid, 'conflicts') } }, '两者都对（我搞错了）'),
                ),
              )
            }).filter(Boolean),
          ),
        )
      : empty(meta),
  ))
}

function side(n, label) {
  return h('div', { class: 'side' },
    h('b', {}, `${label} · ${Math.round(n.confidence)}`),
    h('span', {}, n.title),
  )
}

async function renderFiltered(mid, meta) {
  const verdicts = (await m.verdicts()).slice().reverse()

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note),
    ),
    verdicts.length
      ? h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, '全部裁决记录'), h('em', {}, String(verdicts.length))),
          h('div', { class: 'sect-b' },
            ...verdicts.slice(0, 100).map((v) => h('div', { class: 'q' },
              h('span', { class: 'dot', style: { background: v.promotedTo ? 'var(--red)' : 'var(--text-3)', marginTop: '6px' } }),
              h('div', { class: 'q-body' },
                h('div', { class: 'q-text' }, v.summary),
                h('div', { class: 'q-meta' },
                  h('span', {}, v.reason === 'duplicate' ? '重复' : v.reason === 'low-quality' ? '低质' : v.reason),
                  h('span', {}, `· ${v.choice || '未知来源'} ${v.score}`),
                  h('span', {}, `· ${v.at}`),
                  v.promotedTo ? h('span', { style: { color: 'var(--red)' } }, '· 误杀') : null,
                ),
              ),
            )),
          ),
        )
      : empty(meta),
  ))
}

function empty(meta) {
  return h('section', { class: 'sect' },
    h('div', { class: 'sect-h' }, h('h2', {}, meta.title)),
    h('div', { class: 'sect-b' },
      h('div', { class: 'q' }, h('div', { class: 'q-body' },
        h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '现在是空的。'),
        h('div', { class: 'q-meta' }, meta.note),
      )),
    ),
  )
}
