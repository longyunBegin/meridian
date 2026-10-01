/**
 * 认知链 · 当前认知图（P2）
 *
 * 只读投影：事件账本 → 语义图谱。
 * 节点 = 主张 / 推断 / 证据；边 = supports / derives / contradicts（概念 02）。
 * 替换旧分层链视图；旧分层、旧连线、旧段抽屉代码已删除，不并存。
 *
 * 保留：renderProposalDraft（收件箱挂载，现走 chain:mountEvent 只追加事件）、
 * openEvidenceDetail（读数/收件箱依据详情）。
 *
 * 公理1：本视图只读投影，不创建/修改/删除 lemma，不改 confidence，不代审批。
 */
import { h, clear, toast } from '../lib/dom.js'
import { state, setView, selectNode } from '../app.js'

const m = window.meridian
const SVG_NS = 'http://www.w3.org/2000/svg'

/** 节点语义色（对齐概念图）。 */
const KIND = {
  claim: { label: '主张', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  inference: { label: '推断', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  evidence: { label: '证据', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0' },
}
/** 关系语义色（对齐概念图）。 */
const REL = {
  supports: { label: '支持', color: '#2563eb' },
  derives: { label: '推导', color: '#7c3aed' },
  contradicts: { label: '反驳', color: '#ea580c' },
}
/** 节点状态文案：只描述该节点事实的确认状态，不描述关系。 */
const NODE_STATUS = {
  confirmed: { label: '事实已确认' },
  pending: { label: '事实待验证' },
  stale: { label: '数据待更新' },
  forking: { label: '分叉待收敛' },
  closed: { label: '已关闭' },
}
const TYPE_LABEL = {
  'evidence.appended': '证据追加',
  'claim.created': '主张创建',
  'inference.created': '推断创建',
  'relation.declared': '关系声明',
  'correction.appended': '更正',
  'settlement.recorded': '结算',
  'node.archived': '归档',
  'topic.linked': '主题关联',
}
const ACTOR_LABEL = { user: '你', migration: '迁移', 'pipeline:capture': '收件箱捕获' }

const NODE_SIZE = {
  claim: { w: 150, h: 56 },
  inference: { w: 140, h: 52 },
  evidence: { w: 108, h: 42 },
}
const nodeSize = (n) => NODE_SIZE[n.kind] || NODE_SIZE.claim

/* ------------------------------------------------------------------ */
/* 认知链区块：主题页内的语义图谱                                       */
/* ------------------------------------------------------------------ */

/**
 * 主题页认知链区块。投影是异步的：先画壳，拿到投影后再画图。
 * opts: { onOpen(node), onEvidence(ref) }
 */
export function renderChainSection(theme, opts = {}) {
  const wrap = h('section', { class: 'chain-section', 'aria-label': '认知链' },
    h('div', { class: 'chain-path-h' },
      h('div', {},
        h('div', { class: 'chain-kicker' }, '认知链'),
        h('div', { class: 'chain-counts', 'data-cog-counts': '' }, '正在重放事件…'),
        h('div', { class: 'chain-hint' }, '当前认知图 · 只读投影，由事件账本按版本重放生成'))))
  const stage = h('div', { class: 'cog-stage' })
  wrap.append(stage)
  loadProjection(theme, stage, opts).catch((e) => {
    clear(stage).append(h('p', { class: 'chain-note' }, '投影加载失败：' + (e.message || e)))
  })
  return wrap
}

async function loadProjection(theme, stage, opts) {
  const proj = await m.chainProjection(theme.id)
  const countsEl = stage.parentElement.querySelector('[data-cog-counts]')
  const kinds = { claim: 0, inference: 0, evidence: 0 }
  for (const n of proj.nodes) if (kinds[n.kind] !== undefined) kinds[n.kind]++
  const parts = []
  if (kinds.claim) parts.push(`主张 ${kinds.claim}`)
  if (kinds.inference) parts.push(`推断 ${kinds.inference}`)
  if (kinds.evidence) parts.push(`证据 ${kinds.evidence}`)
  if (countsEl) countsEl.textContent = `事件 ${proj.eventCount} · ` + (parts.join(' · ') || '暂无节点')

  if (!proj.nodes.length) {
    stage.append(h('div', { class: 'chain-empty' },
      h('p', {}, '还没有认知事件。'),
      h('p', { class: 'chain-empty-sub' }, '在收件箱用提案草稿确认挂载后，主张会在这里长出来。')))
    return
  }
  drawGraph(stage, proj, theme, opts)
  if (proj.floatingCount > 0) renderFloating(stage, proj)
}

/** 未连入图谱的节点：收成一条可展开的安静列表，不进图。 */
function renderFloating(stage, proj) {
  const list = h('div', { class: 'cog-float-list', hidden: true })
  for (const n of (proj.floating || []).slice(0, 200)) {
    list.append(h('span', { class: 'cog-float-item' },
      h('i', { class: 'cog-dot', style: `background:${(KIND[n.kind] || KIND.claim).color}` }),
      `${(KIND[n.kind] || KIND.claim).label} · ${n.title}`))
  }
  if ((proj.floating || []).length > 200) {
    list.append(h('span', { class: 'cog-float-item' }, `……等共 ${proj.floating.length} 项`))
  }
  const btn = h('button', {
    type: 'button', class: 'cog-float-btn',
    onclick: () => { list.hidden = !list.hidden; btn.textContent = `${list.hidden ? '展开' : '收起'}未连入图谱（${proj.floatingCount}）` },
  }, `展开未连入图谱（${proj.floatingCount}）`)
  stage.append(h('div', { class: 'cog-float' }, btn, list))
}

/* ------------------------------------------------------------------ */
/* 力导向布局（同步跑完再画，确定性随机种子保证每次打开位置一致）       */
/* ------------------------------------------------------------------ */

function seededRand(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
function hashStr(str) {
  let hsh = 2166136261
  for (let i = 0; i < str.length; i++) { hsh ^= str.charCodeAt(i); hsh = Math.imul(hsh, 16777619) }
  return hsh >>> 0
}

function layoutGraph(nodes, edges, W, H) {
  const rand = seededRand(hashStr(nodes.map((n) => n.id).join('|')))
  const pos = new Map()
  const size = new Map(nodes.map((n) => [n.id, nodeSize(n)]))
  for (const n of nodes) {
    pos.set(n.id, { x: W * 0.15 + rand() * W * 0.7, y: H * 0.15 + rand() * H * 0.7 })
  }
  const REST = 230
  for (let t = 0; t < 200; t++) {
    const alpha = 1 - t / 200
    // 斥力
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id)
        const b = pos.get(nodes[j].id)
        let dx = a.x - b.x
        let dy = a.y - b.y
        const d2 = dx * dx + dy * dy
        if (d2 > 420 * 420 || d2 < 0.01) continue
        const d = Math.sqrt(d2)
        const f = Math.min(40000 / d2, 30) * alpha
        dx /= d; dy /= d
        a.x += dx * f * 1.6; a.y += dy * f * 0.85
        b.x -= dx * f * 1.6; b.y -= dy * f * 0.85
      }
    }
    // 弹簧
    for (const e of edges) {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 1
      const f = ((d - REST) / d) * 20 * alpha
      a.x += dx * f * 0.5; a.y += dy * f * 0.5
      b.x -= dx * f * 0.5; b.y -= dy * f * 0.5
    }
    // 向心 + 边界（留 25px 安全边距，供去重叠遍使用）
    for (const n of nodes) {
      const p = pos.get(n.id)
      const s = size.get(n.id)
      p.x += (W / 2 - p.x) * 0.01 * alpha
      p.y += (H / 2 - p.y) * 0.01 * alpha
      p.x = Math.max(s.w / 2 + 35, Math.min(W - s.w / 2 - 35, p.x))
      p.y = Math.max(s.h / 2 + 35, Math.min(H - s.h / 2 - 35, p.y))
    }
  }
  // 去重叠专用遍：沿穿透最小轴分开，迭代至收敛（不钳制，靠上面的安全边距）
  for (let k = 0; k < 200; k++) {
    let moved = false
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id)
        const b = pos.get(nodes[j].id)
        const sa = size.get(nodes[i].id)
        const sb = size.get(nodes[j].id)
        const minDx = (sa.w + sb.w) / 2 + 6
        const minDy = (sa.h + sb.h) / 2 + 6
        const dx = a.x - b.x
        const dy = a.y - b.y
        const ovx = minDx - Math.abs(dx)
        const ovy = minDy - Math.abs(dy)
        if (ovx <= 0 || ovy <= 0) continue
        moved = true
        if (ovx <= ovy) {
          const s = (dx >= 0 ? 1 : -1) * (ovx / 2 + 0.5)
          a.x += s; b.x -= s
        } else {
          const s = (dy >= 0 ? 1 : -1) * (ovy / 2 + 0.5)
          a.y += s; b.y -= s
        }
      }
    }
    if (!moved) break
  }
  // 最终钳制到真实边界
  for (const n of nodes) {
    const p = pos.get(n.id)
    const s = size.get(n.id)
    p.x = Math.max(s.w / 2 + 10, Math.min(W - s.w / 2 - 10, p.x))
    p.y = Math.max(s.h / 2 + 10, Math.min(H - s.h / 2 - 10, p.y))
  }
  return { pos, size }
}

/* ------------------------------------------------------------------ */
/* SVG 绘制                                                            */
/* ------------------------------------------------------------------ */

function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) node.appendChild(c)
  return node
}
function textEl(str, attrs = {}) {
  const t = el('text', attrs)
  t.textContent = str
  return t
}
/** 从矩形中心 p 向 q 方向，矩形边界上的出点。 */
function rectExit(p, q, hw, hh) {
  const dx = q.x - p.x
  const dy = q.y - p.y
  if (!dx && !dy) return { ...p }
  const tx = dx ? hw / Math.abs(dx) : Infinity
  const ty = dy ? hh / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)
  return { x: p.x + dx * t, y: p.y + dy * t }
}
function edgeD(a, b, sa, sb) {
  const s = rectExit(a, b, sa.w / 2 + 2, sa.h / 2 + 2)
  const e = rectExit(b, a, sb.w / 2 + 9, sb.h / 2 + 9)
  const mx = (s.x + e.x) / 2
  const my = (s.y + e.y) / 2
  const dx = e.x - s.x
  const dy = e.y - s.y
  const len = Math.hypot(dx, dy) || 1
  const bow = Math.min(30, len * 0.14)
  const cx = mx - (dy / len) * bow
  const cy = my + (dx / len) * bow
  return `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${e.x.toFixed(1)} ${e.y.toFixed(1)}`
}
function splitLines(title, maxLen = 13) {
  const t = String(title || '未命名').replace(/\s+/g, ' ').trim() || '未命名'
  if (t.length <= maxLen) return [t]
  return [t.slice(0, maxLen - 1), t.slice(maxLen - 1, maxLen * 2 - 2) + (t.length > maxLen * 2 - 1 ? '…' : '')]
}

function drawGraph(stage, proj, theme, opts) {
  const W = 1120
  const H = 620
  const { pos, size } = layoutGraph(proj.nodes, proj.edges, W, H)

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'cog-svg', role: 'img', 'aria-label': '当前认知图' })
  const defs = el('defs')
  for (const [rel, cfg] of Object.entries(REL)) {
    const marker = el('marker', {
      id: `cog-arrow-${rel}`, viewBox: '0 0 10 10', refX: '8.5', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    }, [el('path', { d: 'M 1 1 L 9 5 L 1 9 z', fill: cfg.color })])
    defs.appendChild(marker)
  }
  defs.appendChild(el('marker', {
    id: 'cog-arrow-review', viewBox: '0 0 10 10', refX: '8.5', refY: '5',
    markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
  }, [el('path', { d: 'M 1 1 L 9 5 L 1 9 z', fill: '#94a3b8' })]))
  svg.appendChild(defs)

  const edgeLayer = el('g', { class: 'cog-edges' })
  const nodeLayer = el('g', { class: 'cog-nodes' })
  svg.append(edgeLayer, nodeLayer)

  // 边
  const edgeRecs = []
  for (const e of proj.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const rel = REL[e.rel] || REL.supports
    const p = el('path', {
      d: edgeD(a, b, size.get(e.from), size.get(e.to)),
      class: `cog-edge cog-edge-${e.rel}${e.pendingReview ? ' is-review' : ''}`,
      stroke: e.pendingReview ? '#94a3b8' : rel.color,
      'marker-end': `url(#cog-arrow-${e.pendingReview ? 'review' : e.rel})`,
    })
    const title = el('title')
    title.textContent = `${rel.label}${e.pendingReview ? '（待复核）' : ''}${e.mapping ? ` · ${e.mapping}` : ''}`
    p.appendChild(title)
    edgeLayer.appendChild(p)
    edgeRecs.push({ el: p, from: e.from, to: e.to })
  }

  const redrawEdges = () => {
    for (const r of edgeRecs) {
      r.el.setAttribute('d', edgeD(pos.get(r.from), pos.get(r.to), size.get(r.from), size.get(r.to)))
    }
  }

  // 节点
  for (const n of proj.nodes) {
    const kind = KIND[n.kind] || KIND.claim
    const sz = size.get(n.id)
    const p = pos.get(n.id)
    const g = el('g', {
      class: 'cog-node', transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
      'data-kind': n.kind, 'data-status': n.status || 'pending',
    })
    const stroke = n.correct === false ? '#ea580c' : kind.border
    const rect = el('rect', {
      x: -sz.w / 2, y: -sz.h / 2, width: sz.w, height: sz.h, rx: 10,
      fill: n.archived ? '#f1f5f9' : kind.bg, stroke, 'stroke-width': n.correct === false ? 2.5 : 1.5,
      'stroke-dasharray': n.archived ? '5 4' : 'none',
    })
    g.appendChild(rect)
    g.appendChild(el('circle', { cx: -sz.w / 2 + 13, cy: -sz.h / 2 + 12, r: 4, fill: kind.color }))
    const lines = splitLines(n.title, n.kind === 'evidence' ? 10 : 13)
    lines.forEach((ln, i) => {
      g.appendChild(textEl(ln, {
        x: 5, y: lines.length === 1 ? 4 : -3 + i * 14,
        'text-anchor': 'middle', class: 'cog-node-title',
      }))
    })
    const sub = []
    if (n.correct === false) sub.push('已证伪')
    else if (n.archived) sub.push('已归档')
    if (n.superseded) sub.push('已更正')
    if (sub.length && n.kind !== 'evidence') {
      g.appendChild(textEl(sub.join(' · '), {
        x: 5, y: sz.h / 2 - 7, 'text-anchor': 'middle', class: 'cog-node-sub',
      }))
    }
    const tip = el('title')
    tip.textContent = `${kind.label} · ${n.title}`
    g.appendChild(tip)

    // 拖拽 / 点击
    let sx = 0
    let sy = 0
    let moved = false
    g.addEventListener('pointerdown', (ev) => {
      sx = ev.clientX; sy = ev.clientY; moved = false
      g.setPointerCapture(ev.pointerId)
      const pt = pos.get(n.id)
      const onMove = (me) => {
        if (Math.hypot(me.clientX - sx, me.clientY - sy) > 4) moved = true
        if (!moved) return
        const r = svg.getBoundingClientRect()
        const k = W / (r.width || W)
        pt.x = Math.max(sz.w / 2 + 10, Math.min(W - sz.w / 2 - 10, pt.x + (me.clientX - sx) * k))
        pt.y = Math.max(sz.h / 2 + 10, Math.min(H - sz.h / 2 - 10, pt.y + (me.clientY - sy) * k))
        sx = me.clientX; sy = me.clientY
        g.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`)
        redrawEdges()
      }
      const onUp = () => {
        g.removeEventListener('pointermove', onMove)
        g.removeEventListener('pointerup', onUp)
        if (!moved) opts.onOpen?.(n)
      }
      g.addEventListener('pointermove', onMove)
      g.addEventListener('pointerup', onUp)
    })
    nodeLayer.appendChild(g)
  }

  stage.append(svg)
  stage.append(renderLegend())
}

function renderLegend() {
  const item = (color, label, dashed) => h('span', { class: 'cog-legend-item' },
    h('svg', { class: 'cog-legend-line', viewBox: '0 0 34 8', 'aria-hidden': 'true' },
      (() => {
        const l = document.createElementNS(SVG_NS, 'line')
        l.setAttribute('x1', '1'); l.setAttribute('y1', '4')
        l.setAttribute('x2', '33'); l.setAttribute('y2', '4')
        l.setAttribute('stroke', color); l.setAttribute('stroke-width', '2')
        if (dashed) l.setAttribute('stroke-dasharray', '4 3')
        return l
      })()),
    h('span', {}, label))
  const dot = (color, label) => h('span', { class: 'cog-legend-item' },
    h('i', { class: 'cog-dot', style: `background:${color}` }), h('span', {}, label))
  return h('div', { class: 'cog-legend' },
    dot(KIND.claim.color, '主张'), dot(KIND.inference.color, '推断'), dot(KIND.evidence.color, '证据'),
    h('span', { class: 'cog-legend-sep' }),
    item(REL.supports.color, '支持'), item(REL.derives.color, '推导'), item(REL.contradicts.color, '反驳'),
    item('#94a3b8', '待复核', true))
}

/* ------------------------------------------------------------------ */
/* 节点详情抽屉：读投影，不读旧可变链字段                               */
/* ------------------------------------------------------------------ */

export async function openNodeDetail(theme, node, opts = {}) {
  closeNodeDetail()
  const kind = KIND[node.kind] || KIND.claim
  const st = NODE_STATUS[node.status] || NODE_STATUS.pending

  const backdrop = h('div', { class: 'chain-drawer-backdrop' })
  const drawer = h('aside', { class: 'chain-drawer', role: 'dialog', 'aria-label': `节点详情：${node.title}` })
  const body = h('div', { class: 'chain-drawer-body' }, h('p', { class: 'chain-note' }, '正在读取事件历史…'))
  const close = () => {
    backdrop.classList.remove('show')
    drawer.classList.remove('show')
    setTimeout(() => { backdrop.remove(); drawer.remove() }, 280)
  }
  drawer.append(
    h('div', { class: 'chain-drawer-head' },
      h('div', { class: 'chain-drawer-title' }, '节点详情'),
      h('button', { type: 'button', class: 'btn btn-icon', title: '关闭', onclick: close }, '✕')),
    body)
  backdrop.onclick = close
  document.body.append(backdrop, drawer)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('show')
    drawer.classList.add('show')
  }))
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } }
  document.addEventListener('keydown', onKey)

  // 事件历史 + 语义关系（都来自投影/事件，不读旧链字段）
  let events = []
  let proj = null
  try {
    const [evRes, p] = await Promise.all([m.chainEvents(theme.id), m.chainProjection(theme.id)])
    events = evRes?.events || []
    proj = p
  } catch (e) {
    clear(body).append(h('p', { class: 'chain-note' }, '事件读取失败：' + (e.message || e)))
    return
  }
  const byId = new Map(events.map((e) => [e.id, e]))
  const nodeById = new Map((proj?.nodes || []).map((n) => [n.id, n]))
  const lineage = (node.eventIds || [node.id]).map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => a.seq - b.seq)

  const badges = []
  if (node.correct === false) badges.push(h('span', { class: 'chain-pill st-forking' }, '已证伪'))
  if (node.archived) badges.push(h('span', { class: 'chain-pill st-closed' }, '已归档'))
  if (node.superseded) badges.push(h('span', { class: 'chain-pill st-stale' }, '已更正'))

  clear(body).append(
    h('div', { class: 'chain-drawer-kicker' },
      h('span', { class: 'chain-role-tag', style: `color:${kind.color};border-color:${kind.border}` }, kind.label),
      h('span', { class: 'chain-pill st-pending' }, st.label),
      ...badges),
    h('div', { class: 'chain-drawer-name' }, node.title),
    node.currentText && node.currentText !== node.title
      ? h('p', { class: 'chain-dcore' }, node.currentText) : null,
    node.confidence != null
      ? h('p', { class: 'chain-note' }, `置信度 ${Math.round(node.confidence)}%（只读，来自事件记录）`) : null,
    node.external ? h('p', { class: 'chain-note' }, '外部引用节点：关系端点指向账本外的对象。') : null,
    // 语义关系
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, '语义关系'),
      ...renderNodeRelations(proj, nodeById, node, theme, opts)),
    // 历史版本（v01/v02…，追加式账本的可追溯性）
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, `历史版本（${lineage.length}）`),
      ...lineage.map((e) => renderHistoryEvent(e))),
    // 证据引用（命题可点进右栏）
    h('section', { class: 'chain-dsect' },
      h('div', { class: 'chain-detail-h' }, '证据引用'),
      ...renderNodeEvidence(lineage, opts)),
  )
}

function renderNodeRelations(proj, nodeById, node, theme, opts) {
  const edges = (proj?.edges || []).filter((e) => e.from === node.id || e.to === node.id)
  if (!edges.length) return [h('p', { class: 'chain-note' }, '暂无语义关系。')]
  return edges.map((e) => {
    const otherId = e.from === node.id ? e.to : e.from
    const other = nodeById.get(otherId)
    const rel = REL[e.rel] || REL.supports
    const dir = e.from === node.id ? '→' : '←'
    return h('button', {
      type: 'button', class: 'chain-evidence',
      title: other && !other.external ? '查看该节点' : '',
      onclick: () => { if (other && !other.external) openNodeDetail(theme, other, opts) },
    },
      h('span', { class: 'chain-evidence-type', style: `color:${rel.color}` },
        `${e.pendingReview ? '待复核·' : ''}${rel.label} ${dir}`),
      h('span', { class: 'chain-evidence-id' }, other ? other.title : otherId.slice(0, 8)))
  })
}

function renderHistoryEvent(e) {
  const p = e.payload || {}
  const at = String(e.at || '').slice(0, 10)
  const actor = ACTOR_LABEL[e.actor] || e.actor || ''
  let summary = ''
  if (e.type === 'correction.appended') {
    summary = `${p.oldValue || '—'} → ${p.newValue || '—'}${p.reason ? `（${p.reason}）` : ''}`
  } else if (e.type === 'relation.declared') {
    summary = `${(REL[p.rel] || {}).label || p.rel}${p.reviewStatus === 'pending-review' ? '（待复核）' : ''}${p.mapping ? ` · ${p.mapping}` : ''}`
  } else if (e.type === 'settlement.recorded') {
    summary = p.correct === false ? '判定为错误' : p.correct === true ? '判定为正确' : '已结算'
  } else if (e.type === 'evidence.appended') {
    summary = String(p.text || p.reason || '').slice(0, 80)
  } else {
    summary = String(p.title || p.coreInfo || p.text || '').slice(0, 80)
  }
  return h('div', { class: 'chain-log-item' },
    h('div', { class: 'chain-log-at' }, `v${String(e.seq).padStart(2, '0')} · ${at}${actor ? ` · ${actor}` : ''}`),
    h('div', { class: 'chain-log-body' },
      h('div', { class: 'chain-log-delta' },
        h('span', { class: 'chain-log-new' }, TYPE_LABEL[e.type] || e.type)),
      summary ? h('div', { class: 'chain-log-reason' }, summary) : null))
}

/** 证据引用：命题走右栏（selectNode），读数/收件箱走 onEvidence。 */
function renderNodeEvidence(lineage, opts) {
  const seen = new Set()
  const refs = []
  for (const e of lineage) {
    const arr = e.payload?.evidenceRefs
    if (!Array.isArray(arr)) continue
    for (const r of arr) {
      const key = `${r.type}:${r.id}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(r)
    }
  }
  if (!refs.length) return [h('p', { class: 'chain-note' }, '暂无证据引用。')]
  return refs.map((ref) => {
    if (ref.type === 'lemma') {
      const node = (state.nodes || []).find((n) => n.id === ref.id)
      return h('button', {
        type: 'button', class: 'chain-evidence', title: '在右栏查看命题详情',
        onclick: () => { closeNodeDetail(); selectNode(ref.id) },
      },
        h('span', { class: 'chain-evidence-type' }, '命题'),
        h('span', { class: 'chain-evidence-id' }, node?.title || ref.title || String(ref.id || '').slice(0, 8)),
        node ? h('span', { class: 'chain-evidence-conf' }, `置信度 ${Math.round(node.confidence ?? 0)}%`) : null)
    }
    const label = ref.type === 'reading' ? '读数' : '收件箱条目'
    return h('button', {
      type: 'button', class: 'chain-evidence',
      onclick: () => opts.onEvidence?.(ref),
    }, h('span', { class: 'chain-evidence-type' }, label),
      h('span', { class: 'chain-evidence-id' }, ref.title || String(ref.id || '').slice(0, 8)))
  })
}

export function closeNodeDetail() {
  document.querySelectorAll('.chain-drawer, .chain-drawer-backdrop').forEach((el) => el.remove())
}
export async function openEvidenceDetail(ref) {
  try {
    if (ref.type === 'reading') {
      const res = await m.readingEvidence({ observationId: ref.id, limit: 1 }).catch(() => null)
      const item = res?.items?.[0]
      if (!item) { toast('读数不存在或已被清理', 'var(--red)'); return }
      // 切到读数页并高亮：读数页按 indicator 分组，直接打开证据浮层更直接
      openReadingModal(item)
      return
    }
    toast('收件箱条目跳转 coming soon', 'var(--text-2)')
  } catch (e) {
    toast('打开依据失败：' + (e.message || e), 'var(--red)')
  }
}

function openReadingModal(reading) {
  closeNodeDetail()
  const backdrop = h('div', { class: 'chain-drawer-backdrop' })
  const drawer = h('aside', { class: 'chain-drawer', role: 'dialog', 'aria-label': '读数详情' })
  const close = () => {
    backdrop.classList.remove('show'); drawer.classList.remove('show')
    setTimeout(() => { backdrop.remove(); drawer.remove() }, 280)
  }
  const src = reading.source || {}
  drawer.append(
    h('div', { class: 'chain-drawer-head' },
      h('div', { class: 'chain-drawer-title' }, reading.indicator || reading.metric || '读数'),
      h('button', { type: 'button', class: 'btn btn-icon', title: '关闭', onclick: close }, '✕')),
    h('div', { class: 'chain-drawer-body' },
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '数值'),
        h('p', { class: 'chain-dcore' }, `${reading.value ?? '—'} ${reading.unit || ''}`),
        h('p', { class: 'chain-note' }, `周期：${reading.period?.start || ''} ~ ${reading.period?.end || ''}`)),
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '来源'),
        h('p', {}, src.label || '—'),
        src.url ? h('button', {
          type: 'button', class: 'chain-linkbtn',
          onclick: async () => { try { await m.openExternal(src.url) } catch { toast('无法打开来源链接', 'var(--red)') } },
        }, '在系统浏览器打开原文 ↗') : null),
      h('section', { class: 'chain-dsect' },
        h('button', {
          type: 'button', class: 'btn',
          onclick: () => { close(); state.readingHighlight = reading.id; setView('readings') },
        }, '去读数页查看')),
    ))
  backdrop.onclick = close
  document.body.append(backdrop, drawer)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('show'); drawer.classList.add('show')
  }))
}

/* ------------------------------------------------------------------ */
/* 提案草稿：收件箱条目详情内展开。只起草、不拍板；用户点"确认挂载"生效。 */
/* ------------------------------------------------------------------ */

/** 简单相似度：新段名 vs 已有段名，提醒防重（不拦截）。 */
function segNameSimilarity(a, b) {
  const x = String(a || '').trim().toLowerCase()
  const y = String(b || '').trim().toLowerCase()
  if (!x || !y || x === y) return 0
  if (x.includes(y) || y.includes(x)) return 0.9
  // 字符级 Jaccard
  const set = (s) => new Set([...s])
  const sx = set(x), sy = set(y)
  let inter = 0
  for (const c of sx) if (sy.has(c)) inter++
  const union = new Set([...sx, ...sy]).size
  return union ? inter / union : 0
}

/**
 * 提案草稿区（认知链挂载）。
 * 只起草、不拍板；用户点"确认挂载"才写入主题链。
 * @param item 收件箱条目（含 chainDraft）
 * @param existingSegments 该主题已有段名列表 [{id, name}]
 * @param opts { themeId, bare, onDraft(), onMounted() }
 *   bare=true 时只返回内容体（无 section 包裹与大标题），由调用方嵌入「确认归位」。
 */
export function renderProposalDraft(item, existingSegments = [], opts = {}) {
  const draft = item.chainDraft
  let segs = Array.isArray(existingSegments) ? existingSegments : []
  const themeId = opts.themeId
  const box = opts.bare
    ? h('div', { class: 'chain-draft' })
    : h('section', { class: 'inbox-detail-section' },
      h('h4', { class: 'inbox-section-title' }, '提案草稿 · 认知链挂载'))

  const head = (sub) => h('div', { class: 'draft-head' },
    h('span', { class: 'draft-title' }, '认知链挂载'),
    sub ? h('span', { class: 'draft-sub' }, sub) : null)

  // 无草稿：生成按钮
  if (!draft || draft.status !== 'draft') {
    const genBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '用模型起草')
    const manualBtn = h('button', { type: 'button', class: 'btn' }, '手动起草')
    genBtn.onclick = async () => {
      genBtn.disabled = true
      try {
        const res = await m.chainGenerateDraft(item.id)
        if (res?.ok && res.draft) {
          item.chainDraft = res.draft
          toast('草稿已生成，请检查后确认挂载')
          opts.onDraft?.()
        } else {
          toast('生成失败：' + (res?.error || '未配置 API key，可手动起草'), 'var(--red)')
        }
      } catch (e) {
        toast('生成失败：' + (e.message || e), 'var(--red)')
      } finally { genBtn.disabled = false }
    }
    manualBtn.onclick = () => {
      item.chainDraft = {
        segmentNames: [], newSegmentName: '', coreInfo: '', oldValue: '', newValue: '',
        evidence: '', falsifier: '', status: 'draft', createdBy: 'user', createdAt: new Date().toISOString().slice(0, 10),
      }
      opts.onDraft?.()
    }
    box.append(
      head('草稿只给建议：挂到哪个段、参数怎么变，最终由你确认'),
      h('div', { class: 'draft-actions draft-actions-start' }, genBtn, manualBtn),
    )
    return box
  }

  // 有草稿：可编辑表单
  const segNames = Array.isArray(draft.segmentNames) ? [...draft.segmentNames] : []
  const warnBox = h('p', { class: 'draft-warn', hidden: true })

  // 已有段多选 chips
  const checkWrap = h('div', { class: 'draft-chips' })
  const toggleSeg = (name) => {
    const i = segNames.indexOf(name)
    if (i < 0) segNames.push(name)
    else segNames.splice(i, 1)
    refreshChecks()
  }
  const refreshChecks = () => {
    clear(checkWrap)
    for (const s of segs) {
      const on = segNames.includes(s.name)
      checkWrap.append(h('button', {
        type: 'button', class: `draft-chip${on ? ' on' : ''}`, 'aria-pressed': String(on),
        onclick: () => toggleSeg(s.name),
      }, h('span', { class: 'draft-chip-dot' }), h('span', {}, s.name)))
    }
    if (!segs.length) checkWrap.append(h('span', { class: 'draft-empty-note' }, '该主题还没有段，可在下方新开。'))
  }
  refreshChecks()
  // 已有主张改为从认知投影异步加载（不再读旧 chain.segments）
  if (typeof opts.loadExisting === 'function') {
    opts.loadExisting()
      .then((list) => { if (Array.isArray(list) && list.length) { segs = list; refreshChecks() } })
      .catch(() => {})
  }

  // 新开段名输入 + 自动补全 + 相似提醒
  const nameInput = h('input', {
    class: 'txt draft-input', placeholder: '新开一段，比如：供给侧', value: draft.newSegmentName || '',
    autocomplete: 'off',
  })
  const suggestBox = h('div', { class: 'draft-suggest', hidden: true })
  const checkSimilar = () => {
    const v = nameInput.value.trim()
    if (!v) { warnBox.hidden = true; suggestBox.hidden = true; return }
    // 自动补全：前缀匹配
    const cands = segs.filter((s) => s.name.toLowerCase().startsWith(v.toLowerCase()) && s.name !== v).slice(0, 5)
    clear(suggestBox)
    if (cands.length) {
      suggestBox.hidden = false
      for (const c of cands) {
        suggestBox.append(h('button', {
          type: 'button', class: 'draft-suggest-item',
          onclick: () => {
            nameInput.value = c.name
            if (!segNames.includes(c.name)) segNames.push(c.name)
            refreshChecks(); checkSimilar()
          },
        }, c.name))
      }
    } else suggestBox.hidden = true
    // 相似提醒：不拦截
    const sims = segs
      .map((s) => ({ name: s.name, sim: segNameSimilarity(v, s.name) }))
      .filter((x) => x.sim >= 0.6)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 2)
    if (sims.length) {
      warnBox.hidden = false
      clear(warnBox).append(`已有相似段「${sims.map((x) => x.name).join('」「')}」，确定要新开吗？`)
    } else warnBox.hidden = true
  }
  nameInput.addEventListener('input', checkSimilar)

  const coreInput = h('input', { class: 'txt draft-input', placeholder: '一句话说清这次认知变化', value: draft.coreInfo || '' })
  const oldInput = h('input', { class: 'txt draft-input', placeholder: '变更前', value: draft.oldValue || '' })
  const newInput = h('input', { class: 'txt draft-input', placeholder: '变更后', value: draft.newValue || '' })
  const evInput = h('input', { class: 'txt draft-input', placeholder: '一句话依据', value: draft.evidence || '' })
  const falInput = h('input', { class: 'txt draft-input', placeholder: '什么情况下这个判断会失效', value: draft.falsifier || '' })

  const mountBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '确认挂载')
  const dismissBtn = h('button', { type: 'button', class: 'btn' }, '放弃草稿')
  const saveDraft = async () => {
    const payload = {
      segmentNames: segNames, newSegmentName: nameInput.value.trim(),
      coreInfo: coreInput.value.trim(), oldValue: oldInput.value.trim(), newValue: newInput.value.trim(),
      evidence: evInput.value.trim(), falsifier: falInput.value.trim(),
      status: 'draft', createdBy: draft.createdBy || 'user', createdAt: draft.createdAt,
    }
    const res = await m.chainSetDraft(item.id, payload).catch(() => null)
    if (res?.ok) item.chainDraft = { ...payload }
    return !!res?.ok
  }

  mountBtn.onclick = async () => {
    const allSegs = [...segNames]
    if (nameInput.value.trim() && !allSegs.includes(nameInput.value.trim())) allSegs.push(nameInput.value.trim())
    if (!allSegs.length) { toast('请至少选择或新开一个段', 'var(--red)'); return }
    if (!newInput.value.trim() && !coreInput.value.trim()) { toast('请填写新值或核心信息', 'var(--red)'); return }
    mountBtn.disabled = true
    try {
      await saveDraft()
      if (!themeId) { toast('该条目没有可用主题，无法挂载', 'var(--red)'); mountBtn.disabled = false; return }
      // 条目的命题一并记为证据引用（只读展示置信度，不创建/修改 lemma）
      const lemmaRefs = (item.lemmas || [])
        .filter((l) => l.id)
        .map((l) => ({ type: 'lemma', id: l.id, title: l.title }))
      const res = await m.chainMountEvent(themeId, {
        inboxId: item.id,
        segmentNames: allSegs,
        coreInfo: coreInput.value.trim(),
        oldValue: oldInput.value.trim(),
        newValue: newInput.value.trim(),
        evidence: evInput.value.trim(),
        falsifier: falInput.value.trim(),
        evidenceRefs: [{ type: 'inbox', id: item.id, title: item.title }, ...lemmaRefs],
      })
      if (res?.ok) {
        item.chainDraft = { ...item.chainDraft, status: 'mounted', mountedAt: new Date().toISOString().slice(0, 10) }
        toast(`已挂载到「${allSegs.join('」「')}」`)
        opts.onMounted?.(res)
      } else {
        toast('挂载失败：' + (res?.error || '请重试'), 'var(--red)')
      }
    } catch (e) {
      toast('挂载失败：' + (e.message || e), 'var(--red)')
    } finally { mountBtn.disabled = false }
  }
  dismissBtn.onclick = async () => {
    await m.chainSetDraft(item.id, null).catch(() => null)
    item.chainDraft = null
    toast('草稿已放弃')
    opts.onDraft?.()
  }

  const field = (label, el) => h('div', { class: 'draft-group' },
    h('div', { class: 'draft-label' }, label), el)
  const srcLabel = { agent: '助手研究', llm: '模型起草', user: '手动' }[draft.createdBy] || '未知'
  box.append(
    head(`草稿来源：${srcLabel} · 只给建议，由你确认`),
    field('挂到已有段 · 可多选', checkWrap),
    field('新开一段', h('div', {}, nameInput, suggestBox)),
    warnBox,
    field('核心信息', coreInput),
    h('div', { class: 'draft-duo' }, field('旧值', oldInput), field('新值', newInput)),
    field('依据', evInput),
    field('证伪条件', falInput),
    h('div', { class: 'draft-actions' }, dismissBtn, mountBtn),
  )
  return box
}
