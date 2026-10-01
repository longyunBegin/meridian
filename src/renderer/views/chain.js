/**
 * 主题认知链 · 视图组件
 *
 * 链 = 主题的认知快照：反映"我对这个主题认知的变化"。
 * 无预设模板，段名由挂载自然生长；不创建 ledger node，不碰 lemma/confidence（公理1）。
 */
import { h, clear, toast } from '../lib/dom.js'
import { computeChainEdges, segmentNameIndex } from '../lib/chain-edges.js'
import { state, setView, selectNode, refresh } from '../app.js'

const m = window.meridian

/** 段状态 → 文案/语义色。标签只描述该段事实的确认状态，不描述段间关系。 */
export const SEG_STATUS = {
  confirmed: { label: '事实已确认', cls: 'st-confirmed' },
  pending: { label: '事实待验证', cls: 'st-pending' },
  stale: { label: '数据待更新', cls: 'st-stale' },
  forking: { label: '分叉待收敛', cls: 'st-forking' },
  closed: { label: '已关闭', cls: 'st-closed' },
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 在 .chain-layers 上画段间连线：只画 computeChainEdges 给出的真实关系
 *（由谁合并而来 / 影响谁），不推导、不补全。返回画出的边数。
 *
 * 走线统一为正交折线，所有边形状一致：
 *   源卡底边出（起点圆点）→ 下 12px 进层底留白 → 水平进入居中链轨
 *   → 沿链轨到目标卡底边留白 → 水平到目标卡中线 → 向上进目标卡（箭头）
 * SVG 在卡片下层，被卡片遮挡的线段天然不可见，不会穿过卡片；
 * 水平段只走层底留白，不穿过层标题。SVG 用像素坐标（viewBox = 容器像素尺寸）。
 */
function drawChainEdges(layersEl, segments) {
  const svg = layersEl.querySelector('.chain-edges')
  if (!svg) return 0
  while (svg.firstChild) svg.removeChild(svg.firstChild)
  const edges = computeChainEdges(segments)
  if (!edges.length) return 0
  const elOf = new Map()
  layersEl.querySelectorAll('[data-seg-id]').forEach((el) => {
    if (!elOf.has(el.dataset.segId)) elOf.set(el.dataset.segId, el)
  })
  const box = layersEl.getBoundingClientRect()
  if (!box.width || !box.height) return 0
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)

  const defs = document.createElementNS(SVG_NS, 'defs')
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', 'chainArrow')
  marker.setAttribute('viewBox', '0 0 10 10')
  marker.setAttribute('refX', '9')
  marker.setAttribute('refY', '5')
  marker.setAttribute('markerWidth', '4.5')
  marker.setAttribute('markerHeight', '4.5')
  marker.setAttribute('orient', 'auto')
  const arrow = document.createElementNS(SVG_NS, 'path')
  arrow.setAttribute('d', 'M 1 1 L 9 5 L 1 9 z')
  marker.appendChild(arrow)
  defs.appendChild(marker)
  svg.appendChild(defs)

  const rel = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }
  }
  const f = (n) => Math.round(n * 10) / 10
  const cx = box.width / 2
  let drawn = 0
  for (const e of edges) {
    const a = elOf.get(e.from)
    const b = elOf.get(e.to)
    if (!a || !b) continue
    const ra = rel(a)
    const rb = rel(b)
    const ax = ra.x + ra.w / 2
    const bx = rb.x + rb.w / 2
    const yA = ra.y + ra.h
    const yB = rb.y + rb.h
    const dot = document.createElementNS(SVG_NS, 'circle')
    dot.setAttribute('cx', f(ax))
    dot.setAttribute('cy', f(yA + 4))
    dot.setAttribute('r', '2.5')
    dot.setAttribute('class', 'chain-edge-dot')
    svg.appendChild(dot)
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d',
      `M ${f(ax)} ${f(yA + 7)} L ${f(ax)} ${f(yA + 12)} ` +
      `L ${f(cx)} ${f(yA + 12)} L ${f(cx)} ${f(yB + 12)} ` +
      `L ${f(bx)} ${f(yB + 12)} L ${f(bx)} ${f(yB + 5)}`)
    p.setAttribute('class', 'chain-edge')
    p.setAttribute('marker-end', 'url(#chainArrow)')
    svg.appendChild(p)
    drawn++
  }
  return drawn
}

/** 展示分层：只做页面分组，不蕴含因果或推演关系。层名/层数用户可改。 */
export const DEFAULT_LAYER_NAMES = ['第一层', '第二层', '第三层']
export const MAX_LAYERS = 12

export function layerNamesOf(theme) {
  const names = theme?.chain?.layerNames
  if (Array.isArray(names) && names.length) return names.map((n) => String(n))
  return [...DEFAULT_LAYER_NAMES]
}
export function layerNameOf(theme, i) {
  const names = layerNamesOf(theme)
  return names[Math.min(Math.max(i | 0, 0), names.length - 1)]
}
export function segStatusLabel(status) {
  return (SEG_STATUS[status] || SEG_STATUS.pending).label
}
export function segStatusCls(status) {
  return (SEG_STATUS[status] || SEG_STATUS.pending).cls
}

function fmtDate(at) {
  if (!at) return ''
  return String(at).slice(0, 10)
}

/** 因果路径节点卡：一行状态 + 段名 + 核心信息 + 依据/分支数。点击打开段详情抽屉。 */
export function renderSegmentCard(theme, segment, opts = {}) {
  const st = SEG_STATUS[segment.status] || SEG_STATUS.pending
  const subs = Array.isArray(segment.subsegments) ? segment.subsegments : []
  const openSubs = subs.filter((s) => s.status !== 'closed')
  const evCount = Array.isArray(segment.evidenceRefs) ? segment.evidenceRefs.length : 0

  const card = h('button', {
    type: 'button', class: 'cnode', 'data-seg-id': segment.id,
    'data-status': segment.status || 'pending',
    onclick: () => opts.onOpen?.(segment),
  },
    h('div', { class: 'cnode-top' },
      h('span', { class: `chain-pill ${st.cls}` }, st.label),
      h('span', { class: 'cnode-ev' }, evCount ? `依据 ${evCount}` : '暂无依据')),
    h('div', { class: 'cnode-name' }, segment.name || '未命名段'),
    h('div', { class: 'cnode-core' }, segment.coreInfo || '—'),
    h('div', { class: 'cnode-foot' },
      openSubs.length ? h('span', { class: 'cnode-fork' }, `${openSubs.length} 个分支`) : h('span', {}),
      h('span', { class: 'cnode-more' }, '详情 →')),
  )
  return card
}

/** 已关闭段：在链底部收成一条安静的 strip（墓碑区做管理，这里只留定位入口）。 */
function renderClosedStrip(theme, closedSegs, opts = {}) {
  if (!closedSegs.length) return null
  return h('div', { class: 'chain-closed' },
    h('span', { class: 'chain-closed-label' }, `已关闭 · ${closedSegs.length}`),
    ...closedSegs.map((s) => h('button', {
      type: 'button', class: 'chain-closed-chip', 'data-seg-id': s.id, title: s.name || '未命名段',
      onclick: () => opts.onOpen?.(s),
    }, s.name || '未命名段')),
    h('button', {
      type: 'button', class: 'chain-closed-link',
      onclick: () => setView('vault'),
    }, '墓碑区 →'),
  )
}

/** 层重命名：点击层名 → 行内输入 → 回车/失焦提交，Esc 取消。 */
function renameLayer(theme, index, layerEl) {
  const nameBtn = layerEl.querySelector('.chain-layer-name')
  if (!nameBtn || layerEl.querySelector('.chain-layer-rename')) return
  const oldName = layerNamesOf(theme)[index] || ''
  const input = h('input', { class: 'chain-layer-rename', value: oldName, maxlength: 12 })
  nameBtn.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const commit = async (save) => {
    if (done) return
    done = true
    const v = String(input.value || '').trim()
    if (save && v && v !== oldName) {
      const names = layerNamesOf(theme)
      names[index] = v
      await m.chainSetLayers(theme.id, names)
    }
    await refresh()
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') commit(true)
    else if (e.key === 'Escape') commit(false)
  })
  input.addEventListener('blur', () => commit(true))
}

/**
 * 主链视图：展示分层（层只是页面分组，不表示因果已成立）；已关闭段收到底部 strip。
 * 链感来自两处：居中纵贯各层的细线（纯结构，不表方向），以及段间真实关系
 *（由谁合并而来 / 影响谁）的连线——只画账本里存在的关系，不推导。
 * 连线统一样式：起点圆点在源卡底边，沿链轨走，箭头进目标卡底边。
 */
export function renderChainSection(theme, opts = {}) {
  const chain = theme.chain || { segments: [] }
  const segments = Array.isArray(chain.segments) ? chain.segments : []
  const live = segments.filter((s) => s.status !== 'closed')
  const closed = segments.filter((s) => s.status === 'closed')
  const pendingCount = live.filter((s) => (s.status || 'pending') === 'pending').length

  const wrap = h('section', { class: 'chain-section', 'aria-label': '认知链' },
    h('div', { class: 'chain-path-h' },
      h('div', {},
        h('div', { class: 'chain-kicker' }, '认知链'),
        h('div', { class: 'chain-counts' },
          `全链路 ${live.length}${pendingCount ? ` · 事实待验证 ${pendingCount}` : ''}`),
        h('div', { class: 'chain-hint' }, '层只是分组，点击层名可重命名'))),
  )

  if (!segments.length) {
    wrap.append(h('div', { class: 'chain-empty' },
      h('p', {}, '还没有认知维度。'),
      h('p', { class: 'chain-empty-sub' }, '在收件箱用提案草稿确认挂载后，段会在这里长出来。')))
    return wrap
  }

  const layerNames = layerNamesOf(theme)
  const layers = h('div', { class: 'chain-layers' })
  const stack = h('div', { class: 'chain-layer-stack' })
  stack.append(h('div', { class: 'chain-rail', 'aria-hidden': 'true' }))
  const edgeSvg = h('svg', { class: 'chain-edges', 'aria-hidden': 'true' })
  // SVG 在卡片下层：被卡片遮挡的线段天然不可见，不会画在卡片上面
  layers.append(edgeSvg, stack)
  const byLayer = layerNames.map(() => [])
  for (const s of live) {
    const li = Number.isInteger(s.layer) && s.layer >= 0 ? Math.min(s.layer, layerNames.length - 1) : 0
    byLayer[li].push(s)
  }

  layerNames.forEach((name, i) => {
    const nodes = byLayer[i]
    const layer = h('div', { class: 'chain-layer', 'data-layer': i })
    const labelRow = h('div', { class: 'chain-layer-label' })
    const nameBtn = h('button', {
      type: 'button', class: 'chain-layer-name', title: '点击重命名这一层',
      onclick: () => renameLayer(theme, i, layer),
    }, name)
    labelRow.append(nameBtn)
    if (nodes.length) labelRow.append(h('span', { class: 'chain-layer-count' }, String(nodes.length)))
    if (!nodes.length && layerNames.length > 1) {
      const del = h('button', {
        type: 'button', class: 'chain-layer-del', title: '删除这个空层',
        onclick: async (e) => {
          e.stopPropagation()
          const names = layerNamesOf(theme).filter((_, j) => j !== i)
          await m.chainSetLayers(theme.id, names)
          await refresh()
        },
      }, '×')
      labelRow.append(del)
    }
    layer.append(labelRow)
    if (nodes.length) {
      const row = h('div', { class: 'chain-layer-nodes' })
      nodes.forEach((seg) => row.append(renderSegmentCard(theme, seg, opts)))
      layer.append(row)
    } else {
      layer.append(h('div', { class: 'chain-layer-empty' }, '暂无内容'))
    }
    stack.append(layer)
  })

  if (layerNames.length < MAX_LAYERS) {
    const add = h('button', { type: 'button', class: 'chain-layer-add' }, '+ 加一层')
    add.onclick = async () => {
      const names = layerNamesOf(theme)
      await m.chainSetLayers(theme.id, [...names, `第${names.length + 1}层`])
      await refresh()
    }
    layers.append(add)
  }
  const footnote = h('div', { class: 'chain-footnote', hidden: true },
    '节点标签只表示该段事实的确认状态；连线表示的段间关系仍待检验，不表示因果已成立。')
  wrap.append(layers, footnote)

  // 挂载后按卡片实际位置画连线；尺寸变化时重画（只读布局，不写数据）
  const redraw = () => {
    if (!layers.isConnected) return
    footnote.hidden = drawChainEdges(layers, live) === 0
  }
  requestAnimationFrame(redraw)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!layers.isConnected) { ro.disconnect(); return }
      redraw()
    })
    ro.observe(layers)
  }

  const strip = renderClosedStrip(theme, closed, opts)
  if (strip) wrap.append(strip)

  return wrap
}

/** 证据引用行：读数 → 读数详情抽屉；lemma → 点击选中，右栏检查器只读查看详情；收件箱 → 条目（预留）。 */
function renderEvidenceRef(ref, opts) {
  if (ref.type === 'lemma') {
    const node = (state.nodes || []).find((n) => n.id === ref.id)
    return h('button', {
      type: 'button', class: 'chain-evidence', title: '在右栏查看命题详情',
      onclick: () => { closeSegmentDetail(); selectNode(ref.id) },
    },
      h('span', { class: 'chain-evidence-type' }, '命题'),
      h('span', { class: 'chain-evidence-id' }, node?.title || ref.title || ref.id.slice(0, 8)),
      node ? h('span', { class: 'chain-evidence-conf' }, `置信度 ${Math.round(node.confidence ?? 0)}%`) : null)
  }
  const label = ref.type === 'reading' ? '读数' : '收件箱条目'
  return h('button', {
    type: 'button', class: 'chain-evidence',
    onclick: () => opts.onEvidence?.(ref),
  }, h('span', { class: 'chain-evidence-type' }, label),
    h('span', { class: 'chain-evidence-id' }, ref.title || ref.id.slice(0, 8)))
}

/** 变化历史时间线 */
function renderChangeLog(changeLog) {
  const logs = Array.isArray(changeLog) ? changeLog : []
  if (!logs.length) return h('p', { class: 'chain-note' }, '暂无变化记录。')
  const items = [...logs].reverse().map((e) => h('div', { class: 'chain-log-item' },
    h('div', { class: 'chain-log-at' }, fmtDate(e.at)),
    h('div', { class: 'chain-log-body' },
      e.oldValue || e.newValue
        ? h('div', { class: 'chain-log-delta' },
          h('span', { class: 'chain-log-old' }, e.oldValue || '—'),
          h('span', { class: 'chain-log-arrow' }, '→'),
          h('span', { class: 'chain-log-new' }, e.newValue || '—'))
        : null,
      e.reason ? h('div', { class: 'chain-log-reason' }, e.reason) : null,
    )))
  return h('div', { class: 'chain-timeline' }, ...items)
}

/** 子段（分叉）展示：与段同构 */
function renderSubsegments(segment) {
  const subs = (segment.subsegments || []).filter((s) => s.status !== 'closed')
  const closed = (segment.subsegments || []).filter((s) => s.status === 'closed')
  if (!subs.length && !closed.length) return null
  const box = h('div', { class: 'chain-subsegs' },
    h('div', { class: 'chain-detail-h' }, `分支（${subs.length}）`))
  for (const s of subs) {
    const st = SEG_STATUS[s.status] || SEG_STATUS.pending
    box.append(h('div', { class: 'chain-subseg' },
      h('div', { class: 'chain-subseg-head' },
        h('span', { class: 'chain-subseg-name' }, s.name),
        h('span', { class: `chain-pill ${st.cls}` }, st.label)),
      s.coreInfo ? h('div', { class: 'chain-subseg-core' }, s.coreInfo) : null,
      s.kind === 'conditional' && s.convergeCondition
        ? h('div', { class: 'chain-converge' }, `收敛条件：${s.convergeCondition}`) : null,
    ))
  }
  if (closed.length) {
    box.append(h('div', { class: 'chain-detail-h' }, `已关闭分支（${closed.length}）· 留痕可复盘`))
    for (const s of closed) {
      box.append(h('div', { class: 'chain-subseg closed' },
        h('div', { class: 'chain-subseg-head' },
          h('span', { class: 'chain-subseg-name' }, s.name),
          h('span', { class: 'chain-pill st-closed' }, '已关闭')),
        s.closeReason ? h('div', { class: 'chain-subseg-core' }, `关闭原因：${s.closeReason}`) : null,
      ))
    }
  }
  return box
}

/**
 * 关联节点（对齐 demo 的 relation chips）：把 affects / mergedFrom / mergedInto
 * 的段名解析为段，可点击的 chip 跳转到该段详情；解析不到的显示为置灰文本。
 * 只表达账本里真实存在的关系，不引入固定因果角色。
 */
function renderRelations(theme, segment, opts) {
  const segments = theme.chain?.segments || []
  const byName = segmentNameIndex(segments)
  const byId = new Map(segments.map((s) => [s.id, s]))
  const items = []
  const push = (kind, label, names) => {
    for (const n of Array.isArray(names) ? names : []) {
      if (typeof n !== 'string') continue
      const name = n.trim()
      if (!name || items.some((it) => it.name === name)) continue
      const id = byName.get(name)
      items.push({ kind, label, name, seg: id ? byId.get(id) : null })
    }
  }
  push('affects', '影响', segment.affects)
  push('mergedFrom', '由其合并而来', segment.mergedFrom)
  push('mergedInto', '汇入', segment.mergedInto)
  const chips = items.map((it) => it.seg
    ? h('button', {
      type: 'button', class: 'chain-rel-chip',
      title: `${it.label}：${it.name}，点击查看`,
      onclick: () => openSegmentDetail(theme, it.seg, opts),
    }, it.name, ' ↗')
    : h('span', {
      class: 'chain-rel-chip is-missing',
      title: `${it.label}：${it.name}（已不在链中）`,
    }, it.name))
  return h('section', { class: 'chain-dsect' },
    h('div', { class: 'chain-detail-h chain-detail-h-row' }, '关联节点',
      h('span', { class: 'chain-hint-inline' }, '点击跳转')),
    items.length
      ? h('div', { class: 'chain-rel-chips' }, ...chips)
      : h('p', { class: 'chain-note' }, '暂无关联节点'))
}

/** 支撑线索（对齐 demo）：证据列表 + 收起/展开。 */
function renderEvidenceSection(segment, opts) {
  const refs = segment.evidenceRefs || []
  const list = h('div', { class: 'chain-evidence-list' },
    ...refs.map((r) => renderEvidenceRef(r, opts)))
  const toggle = h('button', { type: 'button', class: 'chain-sect-toggle' }, '收起 −')
  toggle.onclick = () => {
    list.hidden = !list.hidden
    toggle.textContent = list.hidden ? '展开 +' : '收起 −'
  }
  return h('section', { class: 'chain-dsect' },
    h('div', { class: 'chain-detail-h chain-detail-h-row' }, '支撑线索', refs.length ? toggle : null),
    refs.length ? list : h('p', { class: 'chain-note' }, '暂无。'))
}

/**
 * 段详情抽屉。右侧滑入，200-300ms transform/opacity 过渡。
 * 面板组织对齐 demo（kicker 行、标题、支撑线索、关联节点跳转），
 * 但不用 demo 的固定因果角色与演示评分；只读展示 + 回溯入口。
 */
export function openSegmentDetail(theme, segment, opts = {}) {
  closeSegmentDetail()
  const st = SEG_STATUS[segment.status] || SEG_STATUS.pending

  const backdrop = h('div', { class: 'chain-drawer-backdrop' })
  const drawer = h('aside', { class: 'chain-drawer', role: 'dialog', 'aria-label': `段详情：${segment.name}` })

  const close = () => {
    backdrop.classList.remove('show')
    drawer.classList.remove('show')
    setTimeout(() => { backdrop.remove(); drawer.remove() }, 280)
  }

  drawer.append(
    h('div', { class: 'chain-drawer-head' },
      h('div', { class: 'chain-drawer-title' }, '节点详情'),
      h('button', { type: 'button', class: 'btn btn-icon', title: '关闭', onclick: close }, '✕')),
    h('div', { class: 'chain-drawer-body' },
      // kicker：所在层 + 事实状态（对齐 demo 的 kicker 行；不用固定因果角色）
      h('div', { class: 'chain-drawer-kicker' },
        h('span', { class: 'chain-role-tag' }, layerNameOf(theme, segment.layer)),
        h('span', { class: `chain-pill ${st.cls}` }, st.label)),
      h('div', { class: 'chain-drawer-name' }, segment.name || '未命名段'),
      segment.metrics?.length ? h('div', { class: 'chain-metrics' },
        ...segment.metrics.map((mm) => h('span', { class: 'chain-metric' },
          h('b', {}, String(mm.value ?? '—')), h('i', {}, mm.label || '')))) : null,
      h('p', { class: 'chain-dcore' }, segment.coreInfo || '—'),
      h('div', { class: 'chain-role-row' },
        h('span', { class: 'chain-role-label' }, '所在层'),
        h('select', {
          class: 'chain-role-select',
          onchange: async (e) => {
            const li = parseInt(e.target.value, 10)
            const cur = Number.isInteger(segment.layer) && segment.layer >= 0 ? segment.layer : 0
            if (li === cur) return
            try {
              await m.chainUpdateSegment(theme.id, segment.id, { layer: li })
              await refresh()
              const freshTheme = (state.themes || []).find((t) => t.id === theme.id)
              const freshSeg = freshTheme?.chain?.segments?.find((s) => s.id === segment.id)
              if (freshTheme && freshSeg) openSegmentDetail(freshTheme, freshSeg, opts)
              toast(`已移到「${layerNameOf(theme, li)}」`, 'var(--text-2)')
            } catch (err) {
              toast('切换层级失败：' + (err.message || err), 'var(--red)')
            }
          },
        }, ...layerNamesOf(theme).map((name, li) =>
          h('option', {
            value: li,
            selected: (Number.isInteger(segment.layer) && segment.layer >= 0 ? segment.layer : 0) === li || undefined,
          }, name))),
      ),
      // 支撑线索（可收起）→ 挂载数据 → 关联节点（可跳转），对齐 demo 面板顺序
      renderEvidenceSection(segment, opts),
      // 挂载数据（lemma 只读：含置信度展示，不可改）
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '挂载数据'),
        (segment.evidenceRefs || []).some((r) => r.type === 'lemma')
          ? h('div', { class: 'chain-evidence-list' },
            ...segment.evidenceRefs.filter((r) => r.type === 'lemma').map((r) => renderEvidenceRef(r, opts)))
          : h('p', { class: 'chain-note' }, '暂无关联命题。命题与置信度只读，不在此修改。')),
      renderRelations(theme, segment, opts),
      // 子段 / 分叉
      renderSubsegments(segment),
      // 变化历史
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '变化历史'),
        renderChangeLog(segment.changeLog)),
      // 证伪 / 收敛 / 结算
      (segment.falsifier || segment.convergeCondition || segment.settleAt)
        ? h('section', { class: 'chain-dsect' },
          h('div', { class: 'chain-detail-h' }, '证伪 · 收敛 · 结算'),
          segment.falsifier ? h('p', {}, `证伪：${segment.falsifier}`) : null,
          segment.convergeCondition ? h('p', {}, `收敛条件：${segment.convergeCondition}`) : null,
          segment.settleAt ? h('p', {}, `结算日：${segment.settleAt}`) : null)
        : null,
    ))

  backdrop.onclick = close
  document.body.append(backdrop, drawer)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('show')
    drawer.classList.add('show')
  }))
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } }
  document.addEventListener('keydown', onKey)
}

export function closeSegmentDetail() {
  document.querySelectorAll('.chain-drawer, .chain-drawer-backdrop').forEach((el) => el.remove())
}

/** 证据详情：读数走 reading:evidence，来源 URL 外链原文。 */
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
  closeSegmentDetail()
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
    for (const s of existingSegments) {
      const on = segNames.includes(s.name)
      checkWrap.append(h('button', {
        type: 'button', class: `draft-chip${on ? ' on' : ''}`, 'aria-pressed': String(on),
        onclick: () => toggleSeg(s.name),
      }, h('span', { class: 'draft-chip-dot' }), h('span', {}, s.name)))
    }
    if (!existingSegments.length) checkWrap.append(h('span', { class: 'draft-empty-note' }, '该主题还没有段，可在下方新开。'))
  }
  refreshChecks()

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
    const cands = existingSegments.filter((s) => s.name.toLowerCase().startsWith(v.toLowerCase()) && s.name !== v).slice(0, 5)
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
    const sims = existingSegments
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
      const res = await m.chainMount(themeId, {
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
