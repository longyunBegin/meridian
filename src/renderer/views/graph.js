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
import { state, refresh, selectNode } from '../app.js'
import { confColor, TYPE_LABEL, todayStr } from './shared.js'

const m = window.meridian

async function confirmDelete(id) {
  if (!confirm('删除这条及它的全部子树？')) return
  await m.removeNode(id)
  if (state.selectedId === id) state.selectedId = null
  await refresh()
}

async function toggleCold(id) {
  const node = state.nodes.find((n) => n.id === id)
  if (!node) return
  await m.updateNode(id, { status: node.status === 'cold' ? 'live' : 'cold' })
  await refresh()
}

async function addChildHere(parentId) {
  const node = m.getNode(parentId)
  if (!node) return
  const child = await m.addNode({
    themeId: state.themeId,
    parentId,
    kind: 'lemma',
    title: '未命名命题',
    confidence: 50,
  })
  state.selectedId = child.id
  await refresh()
}

const NS = 'http://www.w3.org/2000/svg'

/** 当前挂着的图的聚焦函数。选中态归 app.js 管，图只负责响应。 */
let focusFn = null

/** app.js 的 selectNode 调用它——选中状态只有一个来源，图不自己记。 */
export function refocusGraph(id) { focusFn?.(id) }

const ROW = 34 // 纵向行距
const PAD = 44 // 父子节点间的水平间隙
const MAXW = 270 // 节点最宽。再宽列距就撑不开，适应窗口时整图会缩得太小

/** SVG 元素助手。h() 建的是 HTML 节点，SVG 必须走 createElementNS。 */
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'text') el.textContent = v
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
    wrap.append(h('div', { class: 'graph-empty' },
      h('p', {}, '这个主题还没有环节。回车新建，或先去设置页从骨架起步。'),
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
    const weight = isLemma ? 400 : 550
    // 右侧固定占位：类型章 + 确信度计 + 数值（命题另有来源章）
    const chrome = isLemma ? 106 : 62
    const lead = isStage ? 34 : 12 // 环节层多一个编号章
    const need = PADL + lead + Math.ceil(textW(n.title, size, weight)) + chrome + TAIL
    const w = Math.min(MAXW, Math.max(isStage ? 150 : 118, need))
    box.set(n.id, {
      w,
      h: isStage ? 36 : isLemma ? 27 : 30,
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

  const pattern = s('pattern', {
    id: 'md-dots', width: '26', height: '26', patternUnits: 'userSpaceOnUse',
  }, s('circle', { cx: '1', cy: '1', r: '1', fill: 'var(--dot)' }))
  defs.append(pattern)
  svg.append(defs)

  const view = s('g', { class: 'graph-view' })
  svg.append(view)

  // viewBox 驱动缩放平移：比 transform 更稳——不依赖容器在首帧就有尺寸。
  // 截图工具窗口是 show:false，getBoundingClientRect 全零，transform 方案直接失效。
  // viewBox 在内容空间里定义"可见矩形"，wheel 和 drag 只改这四个数，不碰容器尺寸。
  let vb = [0, 0, 800, 600] // [x, y, w, h] — 内容空间坐标

  function applyViewBox() { svg.setAttribute('viewBox', vb.map((v, i) => `${i % 2 ? v.toFixed(1) : Math.round(v)}`).join(' ')) }

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
    const path = s('path', {
      class: 'edge',
      d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`,
      'stroke-width': (0.55 + (n.propagation ?? 0.5) * 1.7).toFixed(2),
      'marker-end': 'url(#md-arrow)',
      dataset: { from: n.parentId, to: n.id },
    })
    edges.append(path)
    edgeEls.set(`${n.parentId}>${n.id}`, path)
  }
  view.append(edges)

  // 诊断：画一个红框，如果截图里没有它，说明 SVG 本身不可见
  view.append(s('rect', { x: minX - 20, y: minY - 20, width: 40, height: 40, fill: 'red', opacity: '0.8' }))

  // ------------------------------------------------------------- 节点
  const nodeEls = new Map()
  const nodeLayer = s('g')

  /** 十格确信度计。和树形同一套语法，换视图不用重新学。 */
  const meter = (value, x, y) => {
    const v = Math.max(0, Math.min(100, Math.round(value)))
    const lit = Math.round(v / 10)
    const g = s('g')
    for (let i = 0; i < 10; i++) {
      g.append(s('rect', {
        x: x + i * 4, y, width: '2.5', height: '9', rx: '1',
        fill: i < lit ? confColor(v) : 'var(--hairline)',
      }))
    }
    return g
  }

  for (const n of nodes) {
    const b = box.get(n.id)
    const x = X(n.id), y = Y(n.id)
    const dead = n.status === 'dead'
    const cold = n.status === 'cold'
    const a = b.isLemma ? null : agg(n.id)

    const g = s('g', {
      class: 'node',
      dataset: { id: n.id, depth: pos.get(n.id)?.depth ?? 0 },
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

    // 悬停操作按钮——直接在图里删节点、加子项、切换冷库，不用切到右边
    const acts = s('g', { class: 'node-acts', transform: `translate(${x + b.w - 4},${y + 4})` })
    acts.append(s('title', { text: '操作' }))
    const actItems = [
      { path: 'M6 6l12 12M18 6L6 18', title: '删除', fn: () => confirmDelete(n.id) },
      ...(b.isLemma
        ? [{ path: 'M12 8v8M8 12h8', title: node.status === 'cold' ? '移出冷库' : '移入冷库', fn: () => toggleCold(n.id) }]
        : [{ path: 'M12 5v14M5 12h14', title: '加子命题', fn: () => addChildHere(n.id) }]),
    ]
    actItems.forEach((a, i) => {
      const btn = s('rect', {
        class: 'node-act', x: -18 * (actItems.length - i), y: 0, width: 18, height: 18, rx: '4',
      })
      btn.addEventListener('click', (e) => { e.stopPropagation(); a.fn() })
      acts.append(btn)
      acts.append(s('path', {
        d: a.path, transform: `translate(${-18 * (actItems.length - i) + 9}, 9) scale(0.75)`,
        class: 'node-act-p',
      }))
    })
    g.append(acts)

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
        fill: confColor(conf),
      }))
      right -= 6 + 40
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
    } else if (a.avg != null) {
      const avg = a.avg
      const numW = textW(String(avg), 11, 600) + 2
      right -= numW
      g.append(s('text', {
        class: 'node-num', x: right, y: y + b.h / 2, text: String(avg), fill: confColor(avg),
      }))
      right -= 6 + 40
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

    nodeLayer.append(g)
    nodeEls.set(n.id, g)
  }
  view.append(nodeLayer)

  // ------------------------------------------------------------- 因果聚焦
  const hint = h('div', { class: 'graph-hint' },
    h('span', { class: 'graph-hint-k' }, '滚轮缩放 · 拖拽平移 · 双击适应'),
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

    // 直接用视口尺寸——截图工具 show:false 时 wrapper 为零，但视口始终可靠
    const vw = document.documentElement?.clientWidth || window.innerWidth || 1280
    const vh = document.documentElement?.clientHeight || window.innerHeight || 820
    const pad = 50
    const scale = Math.min((vw - pad * 2) / cw, (vh - pad * 2) / ch, 1.2)
    const cwS = cw * scale, chS = ch * scale
    vb = [minX - (vw - cwS) / 2 / scale, minY - (vh - chS) / 2 / scale, vw / scale, vh / scale]
    applyViewBox()
    drawDots()
    // 给 SVG 显式像素尺寸——show:false 时 CSS 100% 拿不到容器尺寸
    svg.setAttribute('width', String(vw))
    svg.setAttribute('height', String(vh))
    // wrapper 也显式设尺寸，不让 flex 布局决定
    wrap.style.width = vw + 'px'
    wrap.style.height = vh + 'px'
  }

  /** 点阵底图铺在内容空间里，比容器大一圈，平移时永远有空间参照 */
  function drawDots() {
    const m = 800
    let grid = view.querySelector('.dots')
    if (!grid) {
      grid = s('rect', { class: 'dots', fill: 'url(#md-dots)' })
      view.insertBefore(grid, edges)
    }
    // 用 viewBox 当前可见区域外扩一圈
    const [vx, vy, vw, vh] = vb
    grid.setAttribute('x', String(vx - m))
    grid.setAttribute('y', String(vy - m))
    grid.setAttribute('width', String(vw + m * 2))
    grid.setAttribute('height', String(vh + m * 2))
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    // 把光标位置转到内容空间
    const r = svg.getBoundingClientRect()
    const cx = vb[0] + (e.clientX - r.left) / r.width * vb[2]
    const cy = vb[1] + (e.clientY - r.top) / r.height * vb[3]
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const nw = vb[2] * factor, nh = vb[3] * factor
    vb = [cx - (cx - vb[0]) * factor, cy - (cy - vb[1]) * factor, nw, nh]
    applyViewBox()
    drawDots()
  }, { passive: false })

  let drag = null
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return
    drag = { x: e.clientX, y: e.clientY, vb0: [...vb] }
    svg.setPointerCapture(e.pointerId)
    svg.classList.add('grabbing')
  })
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return
    const r = svg.getBoundingClientRect()
    const dx = (e.clientX - drag.x) / r.width * drag.vb0[2]
    const dy = (e.clientY - drag.y) / r.height * drag.vb0[3]
    vb = [drag.vb0[0] - dx, drag.vb0[1] - dy, drag.vb0[2], drag.vb0[3]]
    applyViewBox()
    drawDots()
  })
  const endDrag = () => { drag = null; svg.classList.remove('grabbing') }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', endDrag)
  svg.addEventListener('dblclick', (e) => { if (!e.target.closest('.node')) fitView() })

  // 首次布局后适应；窗口尺寸变化时也重新适应
  const ro = new ResizeObserver(() => fitView())
  ro.observe(wrap)
  // 用两个 rAF 确保浏览器至少完成一轮布局（show:false 的窗口尤其需要）
  requestAnimationFrame(() => requestAnimationFrame(fitView))
}
