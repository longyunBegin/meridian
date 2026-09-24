import { h, icon, clear, toast } from '../lib/dom.js'
import { state, refresh, settleAndPulse } from '../app.js'
import { confColor, confColorContinuous, nodePath } from './shared.js'

const m = window.meridian

let inboxItems = []
let picked = new Set()
let inboxLoading = false
let renderSeq = 0
let selectedInboxIdx = null
const overrides = new Map()
let lastAutoImport = null

export async function renderToday(mid) {
  const seq = ++renderSeq
  clear(mid)

  // 恢复撤销入口（重启后仍可撤销）
  if (!lastAutoImport) {
    try {
      const last = await m.inboxLastAutoImport()
      if (seq !== renderSeq) return
      if (last) lastAutoImport = { id: last.id, count: last.count }
    } catch { /* 静默 */ }
  }

  const [due, calib, inbox, conflicts] = await Promise.all([
    m.due(), m.calibration(), m.inboxList(), m.conflicts(),
  ])
  if (seq !== renderSeq) return
  inboxItems = inbox
  if (picked.size === 0 && inbox.length) picked = new Set(inbox.map((_, i) => i))


  const themeNodes = state.themeId ? (await m.nodes(state.themeId)) : []
  if (seq !== renderSeq) return

  mid.append(h('div', { class: 'page today-page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '今日'),
      h('p', {}, '现在该做什么——不是你拥有什么。'),
    ),

    // ---- 自动归位提示
    lastAutoImport ? h('div', { class: 'auto-import-notice' },
      h('span', { class: 'auto-import-text' },
        `${lastAutoImport.count} 条新信息已归位`),
      h('span', { class: 'auto-import-sub', style: { color: 'var(--text-3)' } },
        '默认信任，例外修正'),
      h('span', { style: { flex: 1 } }),
      h('button', {
        class: 'btn', style: { height: '26px', fontSize: 'var(--t-body)' },
        onclick: async () => {
          if (lastAutoImport?.id) {
            await m.inboxUndoAutoImport(lastAutoImport.id)
            lastAutoImport = null
            await refresh()
            renderToday(mid)
          }
        },
      }, '撤销'),
    ) : null,

    // ---- 顶部两个大数字
    h('div', { class: 'today-metrics' },
      h('div', { class: 'today-metric', onclick: () => scrollTo(mid, 'inbox-section') },
        h('span', { class: 'today-metric-num', style: { color: inbox.length ? 'var(--accent)' : 'var(--text-3)' } }, String(inbox.length)),
        h('span', { class: 'today-metric-label' }, '待确认'),
      ),
      h('div', { class: 'today-metric', onclick: () => scrollTo(mid, 'due-section') },
        h('span', { class: 'today-metric-num', style: { color: due.length ? 'var(--orange)' : 'var(--text-3)' } }, String(due.length)),
        h('span', { class: 'today-metric-label' }, '今日结算'),
      ),
      h('div', { class: 'today-metric-spacer' }),
      // 校准曲线小图常驻
      h('div', { class: 'today-calib-mini' },
        calib.length ? h('div', { class: 'calib mini' },
          ...calib.map((b) => h('div', {},
            h('i', { style: { height: `${b.accuracy * 100}%`, background: b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } }),
          )),
        ) : h('div', { class: 'today-calib-empty' }, '—'),
        h('span', { class: 'today-calib-label' }, '校准曲线'),
      ),
    ),

    // ---- 收件箱：输入框 + 左栏列表 + 右栏常驻图
    h('section', { class: 'card', id: 'inbox-section' },
      h('div', { class: 'card-h' },
        h('h2', {}, '待确认'),
        h('span', { class: 'spacer' }),
        h('em', {}, `${inbox.length} 条`),
      ),
      h('div', { class: 'inbox-input-wrap' },
        h('textarea', {
          id: 'inbox-textarea',
          class: 'inbox-textarea',
          placeholder: '粘贴原文或 URL，或直接输入你的判断',
          rows: 2,
          onkeydown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const ta = e.target
              const val = ta.value.trim()
              if (!val) return
              ta.value = ''
              inboxPaste(val)
            }
          },
          ondragover: (e) => { e.preventDefault() },
          ondrop: (e) => {
            e.preventDefault()
            const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list')
            if (text?.trim()) {
              e.target.value = text.trim()
              e.target.focus()
            }
          },
        }),
      ),
      h('div', { class: 'sect-b' },
        inboxLoading ? h('div', { class: 'feeds-loading' }, h('span', { class: 'hud-dot' }), '正在打标…') : null,
        !inboxLoading && inbox.length === 0 ? h('div', { class: 'q' }, h('div', { class: 'q-body' },
          h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '收件箱空了。按 ⌘⇧V 粘贴内容，打标后这里等你看一眼。'),
        )) : null,
        !inboxLoading && inbox.length > 0 ? h('div', { class: 'inbox-split' },
          // 左栏：待确认列表
          h('div', { class: 'inbox-list' },
            ...inbox.map((item, i) => renderInboxItem(item, i, mid, themeNodes)),
            // 批量入库栏
            h('div', { class: 'inbox-import-bar' },
              h('span', { style: { fontSize: 'var(--t-body)', color: 'var(--text-3)' } }, `已选 ${picked.size} / ${inbox.length} 条`),
              h('span', { style: { flex: 1 } }),
              h('button', {
                class: 'btn', style: { height: '28px' },
                onclick: () => { picked = new Set(inbox.map((_, i) => i)); renderToday(mid) },
              }, '全选'),
              h('button', {
                class: 'btn', style: { height: '28px' },
                onclick: () => { picked.clear(); renderToday(mid) },
              }, '取消'),
              h('button', {
                class: 'btn btn-primary', style: { height: '28px' },
                onclick: async () => {
                  if (!state.themeId) { toast('先选择一个主题', 'var(--red)'); return }
                  const chosen = [...picked].sort((a, b) => a - b).map((i) => inbox[i])
                  const ovMap = {}
                  for (const item of chosen) {
                    const ov = overrides.get(item.id)
                    if (ov) ovMap[item.id] = ov
                  }
                  await m.inboxImport(state.themeId, chosen, ovMap)
                  picked.clear()
                  overrides.clear()
                  selectedInboxIdx = null
                  await refresh()
                  renderToday(mid)
                },
              }, icon('plus', 13), `全部入库`),
            ),
          ),
          // 右栏：常驻图
          h('div', { class: 'inbox-graph' },
            selectedInboxIdx != null && inbox[selectedInboxIdx]
              ? renderMiniGraph(themeNodes, inbox[selectedInboxIdx], mid)
              : h('div', { class: 'inbox-graph-empty' }, h('span', {}, '点一条待确认项'), h('span', {}, '图上点亮建议挂点')),
          ),
        ) : null,
      ),
    ),

    // ---- 到期未结算
    h('section', { class: 'card', id: 'due-section' },
      h('div', { class: 'card-h' },
        h('h2', {}, '到期未结算'),
        h('span', { class: 'spacer' }),
        h('em', {}, String(due.length)),
      ),
      h('div', { class: 'sect-b' },
        due.length ? due.map((q) => h('div', { class: 'q' },
          h('span', { class: 'dot', style: { background: confColor(q.confidence), marginTop: '6px' } }),
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text' }, q.title),
            h('div', { class: 'q-meta' },
              h('span', {}, `当时 ${Math.round(q.confidence)}`),
              h('span', {}, `· 到期 ${q.settlement.date}`),
              h('span', {}, `· ${nodePath(themeNodes, q.id) || '未归档'}`),
            ),
          ),
          h('div', { class: 'q-acts' },
            h('button', { class: 'btn btn-hit', onclick: async () => { await settleAndPulse(q.id, true); await renderToday(mid) } }, '对了'),
            h('button', { class: 'btn btn-miss', onclick: async () => { await settleAndPulse(q.id, false); await renderToday(mid) } }, '错了'),
            h('button', {
              class: 'btn', title: '推迟两周',
              onclick: async () => {
                const d = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)
                await m.updateNode(q.id, { settlement: { date: d, resolved: null, correct: null } })
                await renderToday(mid)
              },
            }, '再等等'),
          ),
        )) : h('div', { class: 'q' }, h('div', { class: 'q-body' },
          h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '没有到期的问题。给命题设一个结算日，它就会回来找你。'),
        )),
      ),
    ),

    // ---- 冲突（静默标记，不强制裁决）
    conflicts.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' },
        h('h2', {}, '冲突'),
        h('span', { class: 'spacer' }),
        h('em', {}, String(conflicts.length)),
      ),
      h('div', { class: 'sect-b' },
        ...conflicts.slice(0, 5).map((c) => {
          const a = themeNodes.find((n) => n.id === c.a)
          const b = themeNodes.find((n) => n.id === c.b)
          return h('div', { class: 'q' },
            h('span', { class: 'cf', style: { marginTop: '6px' } }, '冲突'),
            h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { fontSize: 'var(--t-body)' } },
                a?.title || c.a, ' ↔ ', b?.title || c.b),
              h('div', { class: 'q-meta' },
                h('span', { style: { color: 'var(--text-3)' } }, c.note || '方向相反'),
              ),
            ),
          )
        }),
        conflicts.length > 5 ? h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', padding: '4px 0' } }, `+${conflicts.length - 5} 条`) : null,
      ),
    ) : null,

    // ---- 校准曲线详情
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
      ),
    ),
  ))
}

function renderInboxItem(item, i, mid, themeNodes) {
  const on = picked.has(i)
  const selected = selectedInboxIdx === i
  const label = item.label || {}
  const color = confColorContinuous((label.quality || 0.5) * 100)
  const lemmas = item.lemmas || []
  const hasConflict = lemmas.some((l) => l.conflicts?.length)
  const hasDup = lemmas.some((l) => l.action === 'merge')
  const ov = overrides.get(item.id) || {}
  const conf = ov.confidence != null ? ov.confidence : (lemmas[0]?.confidence ?? 50)
  const parentId = ov.parentId || lemmas[0]?.parentId || null
  const parentLabel = parentId ? (themeNodes.find((n) => n.id === parentId)?.title || lemmas[0]?.parentLabel) : lemmas[0]?.parentLabel

  return h('div', { class: 'inbox-item', dataset: { on: String(on), sel: String(selected) } },
    // 勾选框
    h('button', {
      class: 'inbox-ck',
      onclick: () => { on ? picked.delete(i) : picked.add(i); renderToday(mid) },
    }, h('span', { class: 'ck', dataset: { on: String(on) } })),

    h('div', { class: 'inbox-body', onclick: () => { selectedInboxIdx = selected ? null : i; renderToday(mid) } },
      // 标题
      h('div', { class: 'inbox-title' }, item.title || lemmas[0]?.title || '(无标题)'),

      // 打标信息行
      h('div', { class: 'inbox-meta' },
        h('span', { class: 'feed-badge', style: { color, background: `${color}1a` } }, label.kind || '未标'),
        h('span', { class: 'inbox-quality' },
          h('span', { class: 'bar', style: { width: '40px' } },
            h('i', { style: { width: `${(label.quality || 0) * 100}%`, background: color } })),
          h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' } },
            label.quality?.toFixed(2) || '—'),
        ),
        hasDup ? h('span', { class: 'feed-dup' }, '重复') : h('span', { class: 'feed-new' }, '新'),
        hasConflict ? h('span', { class: 'cf' }, '冲突') : null,
        h('span', { class: 'feed-via' }, label.via === 'jev' ? 'Jev' : label.via === 'channel' ? '通道' : label.via === 'llm' ? 'LLM' : '查表'),
        parentLabel ? h('span', { class: 'inbox-parent', dataset: { ov: String(ov.parentId != null) } }, `→ ${parentLabel}`) : null,
      ),

      // 命题预览
      lemmas.length > 1 ? h('div', { class: 'inbox-lemmas' },
        ...lemmas.slice(0, 3).map((l) => h('div', { class: 'inbox-lemma' },
          h('span', { class: 'dot', style: { background: confColor(l.confidence), width: '4px', height: '4px' } }),
          h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-2)' } }, l.title),
        )),
        lemmas.length > 3 ? h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', padding: '2px 0 0 10px' } }, `+${lemmas.length - 3} 条`) : null,
      ) : null,

      // 内联裁决：置信度滑块
      selected ? h('div', { class: 'inbox-inline' },
        h('span', { class: 'inbox-inline-label' }, '置信度'),
        h('input', {
          class: 'prop-slider inbox-conf-slider', type: 'range', min: 0, max: 100, value: conf,
          oninput: (e) => {
            const v = Number(e.target.value)
            const o = overrides.get(item.id) || {}
            overrides.set(item.id, { ...o, confidence: v })
          },
        }),
        h('span', { class: 'inbox-conf-val', style: { color: confColorContinuous(conf) } }, String(Math.round(conf))),
      ) : null,
    ),

    // 右侧操作：接受 / 拒绝
    h('div', { class: 'inbox-actions' },
      h('button', {
        class: 'btn btn-primary', style: { height: '24px' },
        onclick: async () => {
          if (!state.themeId) { toast('先选择一个主题', 'var(--red)'); return }
          const o = overrides.get(item.id) || {}
          const ovMap = Object.keys(o).length ? { [item.id]: o } : {}
          await m.inboxImport(state.themeId, [item], ovMap)
          overrides.delete(item.id)
          picked.delete(i)
          selectedInboxIdx = null
          await refresh()
          renderToday(mid)
        },
      }, icon('plus', 12)),
      h('button', {
        class: 'btn', style: { height: '24px', color: 'var(--red)' },
        onclick: async () => { await m.inboxResolve(item.id, 'reject'); picked.delete(i); if (selectedInboxIdx === i) selectedInboxIdx = null; await refresh(); renderToday(mid) },
      }, icon('trash', 12)),
    ),
  )
}

// -------------------------------------------------- 收件箱右栏迷你图

const NS = 'http://www.w3.org/2000/svg'

function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'text') el.textContent = v
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) el.setAttribute(`data-${dk}`, String(dv))
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids.flat(4)) if (c != null && c !== false) el.append(c)
  return el
}

function miniLayout(nodes) {
  const kids = new Map()
  const roots = []
  for (const n of nodes) {
    if (!n.parentId) { roots.push(n); continue }
    if (!kids.has(n.parentId)) kids.set(n.parentId, [])
    kids.get(n.parentId).push(n)
  }
  const byTime = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')
  for (const list of kids.values()) list.sort(byTime)
  roots.sort(byTime)
  const pos = new Map()
  let leaf = 0
  const place = (node, depth) => {
    const cs = kids.get(node.id) || []
    if (!cs.length) { const y = leaf++; pos.set(node.id, { y, depth }); return y }
    let sum = 0
    for (const c of cs) sum += place(c, depth + 1)
    const y = sum / cs.length
    pos.set(node.id, { y, depth })
    return y
  }
  for (const r of roots) place(r, 0)
  return { pos, kids, roots }
}

function renderMiniGraph(themeNodes, item, mid) {
  if (!themeNodes.length) return h('div', { class: 'inbox-graph-empty' }, h('span', {}, '主题还没有环节'))

  const ov = overrides.get(item.id) || {}
  const suggestedParent = ov.parentId || item.lemmas?.[0]?.parentId || null

  const downstream = new Set()
  if (suggestedParent) {
    const stack = [suggestedParent]
    while (stack.length) {
      const pid = stack.pop()
      for (const c of themeNodes) {
        if (c.parentId === pid && !downstream.has(c.id)) {
          downstream.add(c.id)
          stack.push(c.id)
        }
      }
    }
  }
  const highlight = new Set([suggestedParent, ...downstream].filter(Boolean))

  const { pos, kids, roots } = miniLayout(themeNodes)
  const ROW = 28
  const COLW = 130
  const NODE_W = 100
  const NODE_H = 20

  let maxDepth = 0, maxRow = 0
  for (const [id, p] of pos) { maxDepth = Math.max(maxDepth, p.depth); maxRow = Math.max(maxRow, p.y) }
  const svgW = (maxDepth + 1) * COLW + 20
  const svgH = (maxRow + 1) * ROW + 20

  const X = (id) => (pos.get(id)?.depth ?? 0) * COLW + 10
  const Y = (id) => (pos.get(id)?.y ?? 0) * ROW + 10

  const svg = svgEl('svg', { class: 'mini-graph', width: '100%', height: '100%', viewBox: `0 0 ${svgW} ${svgH}` })

  // 边
  for (const n of themeNodes) {
    if (!n.parentId) continue
    const x1 = X(n.parentId) + NODE_W
    const y1 = Y(n.parentId) + NODE_H / 2
    const x2 = X(n.id)
    const y2 = Y(n.id) + NODE_H / 2
    const k = Math.max(12, (x2 - x1) / 2)
    const onEdge = highlight.has(n.parentId) && highlight.has(n.id)
    svg.append(svgEl('path', {
      d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`,
      fill: 'none',
      stroke: onEdge ? 'var(--accent)' : 'var(--hairline)',
      'stroke-width': onEdge ? '1.5' : '0.5',
      opacity: highlight.size && !onEdge ? '0.3' : '1',
    }))
  }

  // 节点
  for (const n of themeNodes) {
    const x = X(n.id), y = Y(n.id)
    const isParent = n.id === suggestedParent
    const isDown = downstream.has(n.id)
    const isOn = highlight.has(n.id)
    const g = svgEl('g', {
      class: 'mini-node',
      dataset: { id: n.id, parent: String(isParent), down: String(isDown) },
      opacity: highlight.size && !isOn ? '0.35' : '1',
      onclick: () => {
        const o = overrides.get(item.id) || {}
        overrides.set(item.id, { ...o, parentId: n.id })
        renderToday(mid)
      },
    })
    g.append(svgEl('rect', {
      x, y, width: NODE_W, height: NODE_H, rx: 5,
      fill: isParent ? 'var(--accent)' : isDown ? 'var(--surface-2)' : 'var(--surface-solid)',
      stroke: isParent ? 'none' : isOn ? 'var(--accent)' : 'var(--hairline)',
      'stroke-width': isParent ? '0' : isOn ? '1' : '0.5',
    }))
    const title = n.title.length > 12 ? n.title.slice(0, 11) + '…' : n.title
    g.append(svgEl('text', {
      x: x + 6, y: y + 13, text: title,
      fill: isParent ? '#fff' : 'var(--text-2)',
      'font-size': '10', 'font-weight': '500',
    }))
    if (isParent) {
      g.append(svgEl('rect', {
        x: x - 2, y: y - 2, width: NODE_W + 4, height: NODE_H + 4, rx: 7,
        fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '3 2',
      }))
    }
    svg.append(g)
  }

  const wrap = h('div', { class: 'mini-graph-wrap' }, svg)
  if (suggestedParent) {
    const parentName = themeNodes.find((n) => n.id === suggestedParent)?.title || '?'
    wrap.append(h('div', { class: 'mini-graph-hint' },
      h('span', {}, `挂点：${parentName.length > 16 ? parentName.slice(0, 15) + '…' : parentName}`),
      h('span', { style: { color: 'var(--text-3)' } }, ' · 点节点改挂点'),
    ))
  } else {
    wrap.append(h('div', { class: 'mini-graph-hint' }, h('span', { style: { color: 'var(--text-3)' } }, '点一个节点设为挂点')))
  }
  return wrap
}

function scrollTo(mid, id) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** ⌘⇧V 粘贴进收件箱 */
export async function inboxPaste(text) {
  const mid = document.getElementById('mid')
  if (!mid) return

  // 立即显示 loading，不等异步数据
  clear(mid)
  mid.append(h('div', { class: 'page today-page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '今日'),
      h('p', {}, '现在该做什么——不是你拥有什么。'),
    ),
    h('div', { class: 'feeds-loading', style: { padding: '40px' } },
      h('span', { class: 'hud-dot' }), '正在打标…'),
  ))

  try {
    const res = await m.inboxCapture(text)
    if (res?.autoImported) {
      lastAutoImport = { id: res.intakeEventId, count: res.count }
    } else {
      lastAutoImport = null
    }
  } catch { /* 静默失败 */ }

  // 捕获完成后重新渲染（renderSeq 会取消上面未完成的 renderToday 调用）
  renderToday(mid)
}