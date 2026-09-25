/**
 * 产业链图。
 *
 * 树形列表回答「这一层下面有什么」，图回答「这一层凭什么影响那一层」。
 * 后者是产品的核心机制（README：产业链是有方向的树，每条边带传导权重），
 * 在此之前完全没有界面承载。三条边必须编码的信息：
 *
 *   方向   —— 每条边带箭头。普通知识工具画无向层级，产业链是因果方向
 *   权重   —— 线宽 ∝ 父节点的 propagation。store.js 里 hop = delta × propagation，
 *             边的语义就存在父节点上
 *   影响半径 —— 选中一条命题，高亮它的全部上游与下游，其余压暗。
 *             这就是「上游 1 条证据变化，击穿了你 3 条下游判断」第一次可见
 *
 * 布局：从左到右的整齐树。列 = 产业链深度，上游自然落在左、下游落在右，
 * 与因果方向同向，不需要任何图例说明。
 *
 * 用 SVG 不用 Canvas：节点量级是几十到低几百；SVG 在 retina 上能画真正的
 * 0.5px 发丝线、能用 CSS 变量跟着深浅色模式走、命中测试免费。
 */
import { h, icon } from '../lib/dom.js'
import { state, refresh, selectNode, setShape, setView } from '../app.js'
import { confColor, confColorContinuous, TYPE_LABEL, todayStr } from './shared.js'

const m = window.meridian

const NS = 'http://www.w3.org/2000/svg'

/** 当前挂着的图的聚焦函数。选中态归 app.js 管，图只负责响应。 */
let focusFn = null
/** 当前挂着的脉冲函数。结算后 app.js 调它击穿下游。 */
let pulseFn = null

/** app.js 的 selectNode 调用它——选中状态只有一个来源，图不自己记。 */
export function refocusGraph(id) { focusFn?.(id) }
/** 结算后调它：图上脉冲从结算节点击穿全部下游。 */
export function pulseFrom(id) { pulseFn?.(id) }

const ROW = 42 // 纵向行距
const PAD = 44 // 父子节点间的水平间隙
const MAXW = 270 // 节点最宽。再宽列距就撑不开，适应窗口时整图会缩得太小

/** SVG 元素助手。h() 建的是 HTML 节点，SVG 必须走 createElementNS。 */
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'text') el.textContent = v
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) el.setAttribute(`data-${dk}`, String(dv))
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids.flat(4)) if (c != null && c !== false) el.append(c)
  return el
}

// ---------------------------------------------------------------- 文字测量

let mctx = null
function textW(str, size, weight) {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d')
  mctx.font = `${weight} ${size}px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif`
  return mctx.measureText(str).width
}

function ellipsize(str, size, weight, max) {
  if (textW(str, size, weight) <= max) return str
  let lo = 0, hi = str.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (textW(str.slice(0, mid) + '…', size, weight) <= max) lo = mid
    else hi = mid - 1
  }
  return lo ? str.slice(0, lo) + '…' : '…'
}

// ---------------------------------------------------------------- 布局

/**
 * 整齐树：后序遍历给叶子发纵向序号，内部节点取子节点的均值。
 * 叶子序号全局单调，每棵子树占一段连续区间——所以同层的节点不可能重叠
 * （内部节点的 y 落在自己那段里，和别的子树不相交）。
 *
 * 这里存的是「第几行」的原始序号，乘行距只发生在 Y() 一处。
 */
function layout(nodes) {
  const kids = new Map()
  const roots = []
  for (const n of nodes) {
    if (!n.parentId) { roots.push(n); continue }
    if (!kids.has(n.parentId)) kids.set(n.parentId, [])
    kids.get(n.parentId).push(n)
  }
  const byTime = (a, b) => a.createdAt.localeCompare(b.createdAt)
  for (const list of kids.values()) list.sort(byTime)
  roots.sort(byTime)

  const pos = new Map()
  let leaf = 0

  const place = (node, depth) => {
    const cs = kids.get(node.id) || []
    if (!cs.length) {
      const y = leaf++
      pos.set(node.id, { y, depth })
      return y
    }
    let sum = 0
    for (const c of cs) sum += place(c, depth + 1)
    const y = sum / cs.length
    pos.set(node.id, { y, depth })
    return y
  }
  for (const r of roots) place(r, 0)
  return { pos, kids, roots }
}

// ---------------------------------------------------------------- 聚合

function aggregate(kids, id) {
  let sum = 0, n = 0, due = 0
  const stack = [id]
  const seen = new Set()
  while (stack.length) {
    for (const c of kids.get(stack.pop()) || []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (c.kind === 'lemma') {
        if (c.status !== 'dead') { sum += c.confidence; n++ }
        if (c.settlement && c.settlement.resolved == null && c.settlement.date <= todayStr()) due++
      }
      stack.push(c.id)
    }
  }
  return { avg: n ? Math.round(sum / n) : null, count: n, due }
}

// ---------------------------------------------------------------- 渲染

export function renderGraph(wrap) {
  const nodes = state.nodes
  if (!nodes.length) {
    focusFn = null
    // R5 空状态三要素：图标 + 一句人话（陈述状态，不下指令）+ 一个主按钮
    wrap.append(h('div', { class: 'graph-empty' },
      h('div', { class: 'empty-ic' }, icon('lattice', 44)),
      h('p', { class: 'empty-title' }, '这个主题还没有环节'),
      h('p', { class: 'empty-sub' }, '生成骨架后，这里会画出产业链的传导关系'),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => { document.querySelector('.app')?.setAttribute('data-view', 'lattice'); setShape('tree') },
      }, '切到树形'),
    ))
    return
  }

  const { pos, kids, roots } = layout(nodes)
  const aggCache = new Map()
  const agg = (id) => {
    if (!aggCache.has(id)) aggCache.set(id, aggregate(kids, id))
    return aggCache.get(id)
  }

  // 先量标题定宽度，再由最宽节点决定列距——换主题不用回来调常量
  const PADL = 12 // 节点左内边距
  const TAIL = 10 // 标题与右侧信息区的间距
  const box = new Map()
  let colW = 150
  for (const n of nodes) {
    const isLemma = n.kind === 'lemma'
    const isStage = !isLemma && (pos.get(n.id)?.depth ?? 0) === 0
    const size = isStage ? 13 : 12.5
    const weight = isLemma ? 400 : 600
    // 右侧固定占位：类型章 + 确信度细条 + 数值（命题另有来源章）
    const chrome = isLemma ? 94 : 52
    const lead = isStage ? 34 : 12 // 环节层多一个编号章
    const need = PADL + lead + Math.ceil(textW(n.title, size, weight)) + chrome + TAIL
    const w = Math.min(MAXW, Math.max(isStage ? 150 : 118, need))
    box.set(n.id, {
      w,
      h: isStage ? 44 : isLemma ? 35 : 38,
      size, weight, isLemma, isStage, lead,
      titleMax: Math.max(24, w - PADL - lead - chrome - TAIL),
    })
    if (w + PAD > colW) colW = w + PAD
  }

  const X = (id) => (pos.get(id)?.depth ?? 0) * colW
  const Y = (id) => (pos.get(id)?.y ?? 0) * ROW

  // ------------------------------------------------------------- SVG 骨架
  const svg = s('svg', { class: 'graph', width: '100%', height: '100%' })
  const defs = s('defs')
  defs.append(s('marker', {
    id: 'md-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4',
    markerWidth: '7', markerHeight: '7', orient: 'auto', markerUnits: 'userSpaceOnUse',
  }, s('path', { d: 'M0,0 L8,4 L0,8 Z', fill: 'context-stroke' })))

  svg.append(defs)

  const view = s('g', { class: 'graph-view' })
  svg.append(view)

  // viewBox 驱动缩放平移：比 transform 更稳——不依赖容器在首帧就有尺寸。
  // 截图工具窗口是 show:false，getBoundingClientRect 全零，transform 方案直接失效。
  // viewBox 在内容空间里定义"可见矩形"，wheel 和 drag 只改这四个数，不碰容器尺寸。
  let vb = [0, 0, 800, 600] // [x, y, w, h] — 内容空间坐标

  function applyViewBox() {
    const safe = [vb[0], vb[1], Math.max(1, vb[2]), Math.max(1, vb[3])]
    svg.setAttribute('viewBox', safe.map((v, i) => `${i % 2 ? v.toFixed(1) : Math.round(v)}`).join(' '))
  }

  // ------------------------------------------------------------- 边
  const edgeEls = new Map()
  const edges = s('g')
  for (const n of nodes) {
    if (!n.parentId) continue
    const p = box.get(n.parentId), c = box.get(n.id)
    if (!p || !c) continue
    const x1 = X(n.parentId) + p.w
    const y1 = Y(n.parentId) + p.h / 2
    const x2 = X(n.id)
    const y2 = Y(n.id) + c.h / 2
    const k = Math.max(18, (x2 - x1) / 2)
    const pw = n.propagation ?? 0.5
    const er = Math.round(120 + (0 - 120) * pw)
    const eg = Math.round(140 + (113 - 140) * pw)
    const eb = Math.round(160 + (227 - 160) * pw)
    const ea = (0.15 + 0.43 * pw).toFixed(2)
    const path = s('path', {
      class: 'edge',
      d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`,
      stroke: `rgba(${er},${eg},${eb},${ea})`,
      'stroke-width': (0.5 + pw * 2.0).toFixed(2),
      'marker-end': 'url(#md-arrow)',
      dataset: { from: n.parentId, to: n.id },
    })
    edges.append(path)
    edgeEls.set(`${n.parentId}>${n.id}`, path)
  }
  view.append(edges)

  // ------------------------------------------------------------- 边拖权重
  // 传导权重在边上直接拖：垂直拖拽改权重，松开时存盘 + 重传导
  const edgeHits = s('g', { class: 'edge-hits' })
  const edgeMeta = new Map()
  for (const n of nodes) {
    if (!n.parentId) continue
    const p = box.get(n.parentId), c = box.get(n.id)
    if (!p || !c) continue
    const x1 = X(n.parentId) + p.w
    const y1 = Y(n.parentId) + p.h / 2
    const x2 = X(n.id)
    const y2 = Y(n.id) + c.h / 2
    const k = Math.max(18, (x2 - x1) / 2)
    const d = `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`
    const hit = s('path', {
      class: 'edge-hit', d, fill: 'none',
      'stroke-width': '16', stroke: 'transparent',
      dataset: { childId: n.id },
    })
    edgeHits.append(hit)
    edgeMeta.set(hit, { childId: n.id, parentId: n.parentId, edgeEl: edgeEls.get(`${n.parentId}>${n.id}`), x1, y1, x2, y2, k })
  }
  view.append(edgeHits)

  let weightDrag = null
  edgeHits.addEventListener('pointerdown', (e) => {
    const meta = edgeMeta.get(e.target)
    if (!meta) return
    e.stopPropagation()
    const child = nodes.find((n) => n.id === meta.childId)
    if (!child) return
    weightDrag = {
      meta, startY: e.clientY,
      startW: child.propagation ?? 0.5,
      tooltip: null,
    }
    svg.setPointerCapture(e.pointerId)
    weightDrag.tooltip = h('div', { class: 'weight-tip' }, `传导 ${Math.round(weightDrag.startW * 100)}%`)
    wrap.append(weightDrag.tooltip)
  })
  svg.addEventListener('pointermove', (e) => {
    if (!weightDrag) return
    const dy = weightDrag.startY - e.clientY
    const nw = Math.max(0, Math.min(1, weightDrag.startW + dy * 0.005))
    // 实时更新边的视觉
    const { edgeEl } = weightDrag.meta
    const er = Math.round(120 + (0 - 120) * nw)
    const eg = Math.round(140 + (113 - 140) * nw)
    const eb = Math.round(160 + (227 - 160) * nw)
    const ea = (0.15 + 0.43 * nw).toFixed(2)
    edgeEl.setAttribute('stroke', `rgba(${er},${eg},${eb},${ea})`)
    edgeEl.setAttribute('stroke-width', (0.5 + nw * 2.0).toFixed(2))
    weightDrag.tooltip.textContent = `传导 ${Math.round(nw * 100)}%`
    weightDrag.nw = nw
  })
  const endWeightDrag = async (e) => {
    if (!weightDrag) return
    const { meta, nw, tooltip } = weightDrag
    tooltip?.remove()
    weightDrag = null
    if (nw == null) return
    await m.updateNode(meta.childId, { propagation: nw })
    await m.repropagate(meta.childId)
    await refresh()
  }
  svg.addEventListener('pointerup', endWeightDrag)
  svg.addEventListener('pointercancel', endWeightDrag)


  // ------------------------------------------------------------- 节点
  const nodeEls = new Map()
  const nodeLayer = s('g')

  /** 确信度细条：28×3px，Apple 进度条风格 */
  const METER_W = 28
  const meter = (value, x, y) => {
    const v = Math.max(0, Math.min(100, Math.round(value)))
    const g = s('g')
    g.append(s('rect', { x, y: y + 3, width: METER_W, height: 3, rx: 1.5, fill: 'var(--hairline)' }))
    g.append(s('rect', { x, y: y + 3, width: METER_W * v / 100, height: 3, rx: 1.5, fill: confColorContinuous(v) }))
    return g
  }

  for (const n of nodes) {
    const b = box.get(n.id)
    const x = X(n.id), y = Y(n.id)
    const dead = n.status === 'dead'
    const cold = n.status === 'cold'
    const a = b.isLemma ? null : agg(n.id)

    // 密度编码：有判断/来源的节点更实，空 scaffold 的节点更淡
    // 所有权必须体现在图上看得见，不能只藏在 by 字段里
    const lemmaKids = nodes.filter((nn) => nn.parentId === n.id && nn.kind === 'lemma' && nn.status !== 'dead')
    const sourceCount = n.sources?.length || 0
    const judgmentCount = lemmaKids.length + (n.kind === 'lemma' ? 1 : 0)
    const density = judgmentCount >= 3 || sourceCount >= 4 ? 'high' : judgmentCount >= 1 || sourceCount >= 2 ? 'mid' : 'low'

    const g = s('g', {
      class: 'node',
      dataset: { id: n.id, depth: pos.get(n.id)?.depth ?? 0, kind: b.isStage ? 'stage' : b.isLemma ? 'lemma' : 'branch', density },
      opacity: dead ? '0.45' : '1',
      onclick: () => { selectNode(n.id); applyFocus(n.id) },
    })
    // 节点里放不下全文， hover 补上
    g.append(s('title', { text: n.title }))

    g.append(s('rect', {
      class: 'node-box', x, y, width: b.w, height: b.h, rx: b.isStage ? '10' : '8',
    }))
    if (state.selectedId === n.id) {
      g.append(s('rect', { class: 'node-ring', x: x - 2, y: y - 2, width: b.w + 4, height: b.h + 4, rx: b.isStage ? '12' : '10' }))
    }

    // 结算状态：左侧色条，一眼看出命中/证伪/待结算（Apple Notes 风格）
    if (b.isLemma && n.settlement) {
      let stlColor = null
      if (n.settlement.resolved) {
        stlColor = n.settlement.correct ? 'var(--green)' : 'var(--red)'
      } else if (n.settlement.date && n.settlement.date <= todayStr()) {
        stlColor = 'var(--orange)'
      }
      if (stlColor) {
        g.append(s('rect', { class: 'node-stl', x: x + 3, y: y + 5, width: 2.5, height: b.h - 10, rx: 1.25, fill: stlColor }))
      }
    }

    let cursor = x + PADL
    if (b.isStage) {
      g.append(s('rect', { class: 'node-chip', x: cursor, y: y + 9.5, width: '17', height: '17', rx: '5' }))
      g.append(s('text', {
        class: 'node-chip-t', x: cursor + 8.5, y: y + 18, text: String(roots.indexOf(n) + 1),
      }))
      cursor += 34
    }

    g.append(s('text', {
      class: `node-t${b.isLemma ? ' lm' : ''}`, x: cursor, y: y + b.h / 2,
      text: ellipsize(n.title, b.size, b.weight, b.titleMax),
    }))

    // 右侧：类型 / 来源 / 待结算 / 确信度计 / 数值
    let right = x + b.w - 12
    if (b.isLemma) {
      const conf = Math.round(n.confidence)
      const numW = textW(String(conf), 11, 600) + 2
      right -= numW
      g.append(s('text', {
        class: 'node-num', x: right, y: y + b.h / 2, text: String(conf),
        fill: confColorContinuous(conf),
      }))
      right -= 6 + METER_W
      g.append(meter(conf, right, y + (b.h - 9) / 2))
      right -= 6
      const badge = TYPE_LABEL[n.type]
      const bw = textW(badge, 10, 600) + 10
      right -= bw
      g.append(s('rect', { class: `node-badge b-${n.type}`, x: right, y: y + 6, width: bw, height: '15', rx: '4' }))
      g.append(s('text', { class: `node-badge-t b-${n.type}`, x: right + bw / 2, y: y + 13.5, text: badge }))
      if (n.sources?.length > 1) {
        const label = `${n.sources.length} 源`
        const sw = textW(label, 10, 600) + 10
        right -= 5 + sw
        g.append(s('rect', { class: 'node-src', x: right, y: y + 6, width: sw, height: '15', rx: '4' }))
        g.append(s('text', { class: 'node-src-t', x: right + sw / 2, y: y + 13.5, text: label }))
      }
      if (n.history?.some((h) => h.by === 'propagation')) {
        right -= 5 + 6
        g.append(s('circle', { class: 'node-prop-dot', cx: right + 3, cy: y + 13.5, r: 2.5 }))
      }
      if (cold) {
        right -= 5 + 22
        g.append(s('rect', { class: 'node-cold', x: right, y: y + 6, width: '22', height: '15', rx: '4' }))
        g.append(s('text', { class: 'node-cold-t', x: right + 11, y: y + 13.5, text: '冷' }))
      }
    } else if (a.avg != null) {
      const avg = a.avg
      const numW = textW(String(avg), 11, 600) + 2
      right -= numW
      g.append(s('text', {
        class: 'node-num', x: right, y: y + b.h / 2, text: String(avg), fill: confColorContinuous(avg),
      }))
      right -= 6 + METER_W
      g.append(meter(avg, right, y + (b.h - 9) / 2))
      if (a.due) {
        const label = String(a.due)
        right -= 6 + 18
        g.append(s('rect', { class: 'node-due', x: right, y: y + 6, width: '18', height: '15', rx: '4' }))
        g.append(s('text', { class: 'node-due-t', x: right + 9, y: y + 13.5, text: label }))
      }
      if (cold) {
        right -= 6 + 24
        g.append(s('rect', { class: 'node-cold', x: right, y: y + 6, width: '24', height: '15', rx: '4' }))
        g.append(s('text', { class: 'node-cold-t', x: right + 12, y: y + 13.5, text: '冷' }))
      }
    }

    // 底部信息条：标的 / 标签 / 传导权重 — 苹果式副标题，一眼建模
    const sy = y + b.h - 3.5
    let sx = x + 12
    if (b.isLemma) {
      if (n.tickers?.length) {
        const codes = n.tickers.slice(0, 2).map(t => t.code).join(' · ')
        const label = n.tickers.length > 2 ? `${codes} +${n.tickers.length - 2}` : codes
        g.append(s('text', { class: 'node-strip node-ticker', x: sx, y: sy, text: label }))
        sx += textW(label, 8.5, 500) + 8
      }
      if (n.tags?.length) {
        for (let i = 0; i < Math.min(3, n.tags.length); i++) {
          g.append(s('circle', { class: 'node-tag-dot', cx: sx + i * 5, cy: sy - 3, r: 1.5 }))
        }
      }
    } else {
      // 传导权重用人话：内部系数 ×0.60 是工程语言，用户要知道的是「传下去多少」
      const pw = Math.round((n.propagation ?? 0.5) * 100)
      const pwLabel = `传导 ${pw}%`
      g.append(s('text', { class: 'node-strip node-prop', x: sx, y: sy, text: pwLabel }))
      sx += textW(pwLabel, 8.5, 500) + 10
      const cc = (kids.get(n.id) || []).length
      if (cc) {
        g.append(s('text', { class: 'node-strip node-sub', x: sx, y: sy, text: `${cc} 个下游` }))
      }
      if (n.tickers?.length) {
        const codes = n.tickers.slice(0, 2).map(t => t.code).join(' · ')
        const label = n.tickers.length > 2 ? `${codes} +${n.tickers.length - 2}` : codes
        const tw = textW(label, 8.5, 500)
        g.append(s('text', { class: 'node-strip node-ticker', x: x + b.w - 12 - tw, y: sy, text: label }))
      }
    }

    nodeLayer.append(g)
    nodeEls.set(n.id, g)
  }
  view.append(nodeLayer)

  // ------------------------------------------------------------- 因果聚焦
  // 问号：缩放手感是很个人的事，第一次用大概率觉得快。
  // 悬浮/聚焦给一句指向设置项的话，点一下直接跳过去——不让用户自己去找。
  const helpTip = h('span', { class: 'graph-help-tip', role: 'tooltip' },
    '缩放太快或太慢？去 设置 → 界面 → 图的缩放 调。')
  const helpBtn = h('button', {
    class: 'graph-help', type: 'button', 'aria-label': '图的缩放设置',
    onclick: (e) => { e.stopPropagation(); setView('settings') },
  }, '?')
  const hint = h('div', { class: 'graph-hint' },
    h('span', { class: 'graph-hint-k' }, '点节点看因果 · 点空白看全图 · 滚轮缩放 · 拖拽平移 · 双击适应'),
    helpBtn, helpTip,
  )
  const radius = h('span', { class: 'graph-radius' })
  const overlay = h('div', { class: 'graph-overlay' }, radius, hint)
  wrap.append(svg, overlay)

  /**
   * 选中一条命题时，把它凭什么成立（上游）和它一倒会带倒谁（下游）点亮，
   * 其余压暗。这是图唯一不可被树形列表替代的信息。
   */
  function applyFocus(id) {
    if (!id) {
      for (const el of nodeEls.values()) el.dataset.focus = ''
      for (const el of edgeEls.values()) el.dataset.on = 'false'
      radius.textContent = ''
      return
    }
    const up = new Set()
    let cur = nodes.find((n) => n.id === id)
    while (cur?.parentId) { up.add(cur.parentId); cur = nodes.find((n) => n.id === cur.parentId) }

    const down = new Set()
    const stack = [id]
    while (stack.length) {
      for (const c of kids.get(stack.pop()) || []) {
        if (down.has(c.id)) continue
        down.add(c.id)
        stack.push(c.id)
      }
    }

    const on = new Set([id, ...up, ...down])
    for (const [nid, el] of nodeEls) el.dataset.focus = on.has(nid) ? 'true' : 'false'
    for (const [key, el] of edgeEls) {
      const [from, to] = key.split('>')
      el.dataset.on = on.has(from) && on.has(to) ? 'true' : 'false'
    }

    radius.textContent = down.size
      ? `影响半径 ${down.size} 条下游`
      : up.size ? '叶子命题 · 无下游' : ''
    radius.dataset.on = 'true'
  }
  focusFn = applyFocus
  applyFocus(state.selectedId)

  // ------------------------------------------------------------- 平移缩放
  // viewBox 方案：不改容器尺寸，不依赖 getBoundingClientRect，
  // 在内容空间里定义"可见矩形"，截图工具和隐藏窗口都能正常工作。
  function fitView() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      const b = box.get(n.id)
      minX = Math.min(minX, X(n.id)); minY = Math.min(minY, Y(n.id))
      maxX = Math.max(maxX, X(n.id) + b.w); maxY = Math.max(maxY, Y(n.id) + b.h)
    }
    const cw = maxX - minX, ch = maxY - minY
    if (!cw || !ch) return

    // 优先用容器尺寸，截图工具 show:false 时容器为零，回退到视口
    const pr = wrap.parentElement?.getBoundingClientRect() || {}
    const sized = pr.width > 0 && pr.height > 0
    const vw = sized ? pr.width : (document.documentElement?.clientWidth || window.innerWidth || 1280)
    const vh = sized ? pr.height : (document.documentElement?.clientHeight || window.innerHeight || 820)
    const pad = 50
    const scale = Math.max(0.01, Math.min((vw - pad * 2) / cw, (vh - pad * 2) / ch, 1.2))
    const cwS = cw * scale, chS = ch * scale
    vb = [minX - (vw - cwS) / 2 / scale, minY - (vh - chS) / 2 / scale, vw / scale, vh / scale]
    applyViewBox()

    // 容器有真实尺寸时，尺寸交给 CSS 的 inset:0 说话。
    // 曾经这里无条件写死像素，而 wrap 是 position:absolute; inset:0——
    // 一写 width/height 就覆盖了 inset，全屏后父容器长了它不跟着长，图就缩在一角。
    // 只有容器量不到尺寸（截图工具 show:false）才需要显式兜底。
    if (sized) {
      wrap.style.width = ''
      wrap.style.height = ''
      svg.removeAttribute('width')
      svg.removeAttribute('height')
    } else {
      svg.setAttribute('width', String(vw))
      svg.setAttribute('height', String(vh))
      wrap.style.width = vw + 'px'
      wrap.style.height = vh + 'px'
    }
  }


  /** 缩放灵敏度：设置里可调。触控板一次滚动会连发多个小 deltaY，
   *  固定 10% 一档体感过快；deltaMode 还要归一——按「行」滚的鼠标 deltaY 是上百。 */
  const zoomSpeed = () => {
    const v = Number(state.settings?.graphZoom)
    return Number.isFinite(v) && v > 0 ? Math.max(0.2, Math.min(3, v)) : 1
  }
  const zoomLimits = () => {
    const base = Math.max(vb[2], vb[3])
    return [base / 6, base * 6]
  }
  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    // 归一到「档」：像素模式按 4px 一档（触滑板一次小滚动约 1-10px），
    // 行模式本来就是一档，页模式按 3 档算。以前像素模式 unit=1，
    // 触滑板随手一拂就是 4-8 档，灵敏度调到 0.4 也照样跳。
    const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 3 : 4
    const steps = Math.max(-4, Math.min(4, e.deltaY / unit))
    const factor = Math.pow(1.08, -steps * zoomSpeed())
    const [minW, maxW] = zoomLimits()
    const nw = Math.max(minW, Math.min(maxW, vb[2] * factor))
    const real = nw / vb[2]
    if (real === 1) return
    // 把光标位置转到内容空间，缩放围绕光标做
    const r = svg.getBoundingClientRect()
    const cx = vb[0] + (e.clientX - r.left) / r.width * vb[2]
    const cy = vb[1] + (e.clientY - r.top) / r.height * vb[3]
    vb = [cx - (cx - vb[0]) * real, cy - (cy - vb[1]) * real, nw, vb[3] * real]
    applyViewBox()
  }, { passive: false })

  let drag = null
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return
    drag = { x: e.clientX, y: e.clientY, vb0: [...vb], moved: false }
    svg.setPointerCapture(e.pointerId)
    svg.classList.add('grabbing')
  })
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return
    // 移动超过 4px 算拖拽，不算点击——否则每次平移完都会顺手点亮全图
    if (!drag.moved && (Math.abs(e.clientX - drag.x) > 4 || Math.abs(e.clientY - drag.y) > 4)) drag.moved = true
    if (!drag.moved) return
    const r = svg.getBoundingClientRect()
    const dx = (e.clientX - drag.x) / r.width * drag.vb0[2]
    const dy = (e.clientY - drag.y) / r.height * drag.vb0[3]
    vb = [drag.vb0[0] - dx, drag.vb0[1] - dy, drag.vb0[2], drag.vb0[3]]
    applyViewBox()

  })
  const endDrag = () => {
    // 在空白上点一下（没拖）= 收起因果聚焦，点亮全图。
    // 聚焦是「点节点」才有信息量的状态，不该在用户想看全景时还压暗一半。
    // 只清聚焦，不清选中——检视面板里那条命题还在看，用户只是想顺便看一眼全图。
    if (drag && !drag.moved && state.selectedId) applyFocus(null)
    drag = null
    svg.classList.remove('grabbing')
  }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', endDrag)
  svg.addEventListener('dblclick', (e) => { if (!e.target.closest('.node')) fitView() })

  // 观察父容器而不是 wrap 自己——wrap 的尺寸由 CSS inset:0 决定，
  // 父容器变它才变；观察 wrap 自己则在全屏/分屏时收不到通知。
  const ro = new ResizeObserver(() => fitView())
  ro.observe(wrap.parentElement || wrap)
  // 用两个 rAF 确保浏览器至少完成一轮布局（show:false 的窗口尤其需要）
  requestAnimationFrame(() => requestAnimationFrame(fitView))

  // ------------------------------------------------------------- 结算脉冲
  /**
   * 结算后调：从结算节点出发，脉冲沿传导方向击穿全部下游。
   * 每层延迟 120ms，复利衰减的视觉化——「你这条 85% 黄了，顺着击穿 3 条下游」。
   */
  pulseFn = (id) => {
    const node = nodes.find((n) => n.id === id)
    if (!node) return
    // BFS 收集下游，按深度分层
    const layers = []
    const seen = new Set([id])
    let frontier = [id]
    while (frontier.length) {
      const next = []
      for (const fid of frontier) {
        for (const c of kids.get(fid) || []) {
          if (seen.has(c.id) || c.status === 'dead') continue
          seen.add(c.id)
          next.push(c.id)
        }
      }
      if (next.length) layers.push(next)
      frontier = next
    }
    // 起点脉冲
    const startB = box.get(id)
    if (startB) {
      const cx = X(id) + startB.w / 2, cy = Y(id) + startB.h / 2
      const ring = s('circle', { class: 'settle-pulse-ring', cx, cy, r: 6, fill: 'none', stroke: 'var(--orange)', 'stroke-width': 2 })
      view.append(ring)
      setTimeout(() => ring.remove(), 700)
    }
    // 逐层击穿
    layers.forEach((layer, depth) => {
      setTimeout(() => {
        for (const nid of layer) {
          const b = box.get(nid)
          if (!b) continue
          const cx = X(nid) + b.w / 2, cy = Y(nid) + b.h / 2
          const ring = s('circle', { class: 'settle-pulse-ring', cx, cy, r: 5, fill: 'none', stroke: 'var(--orange)', 'stroke-width': 1.5 })
          view.append(ring)
          setTimeout(() => ring.remove(), 600)
        }
      }, (depth + 1) * 120)
    })
  }
}
