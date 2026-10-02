import { h } from '../lib/dom.js'
import { linearize } from '../lib/chain-linearizer.js'
import { networkNodeType, truncateGraphemes } from '../lib/theme-network.js'
import { compactEventSummary } from '../lib/chain-ui-model.js'

/* ------------------------------------------------------------------ */
/* 主题读者视图：当前投影派生的阅读文章。                                */
/*                                                                    */
/* 非模板原则：卡片按数据成熟度涌现，每种卡片有最低数据门槛；            */
/* 不达标就不渲染，绝不硬凑。成熟度信号只用于降级逻辑，不展示为分数。    */
/* ------------------------------------------------------------------ */

const ARG_RELS = new Set(['supports', 'derives'])

const REL_LABEL = {
  supports: '支持', derives: '推导', contradicts: '反驳',
  'belongs-to': '归属', influences: '影响', 'depends-on': '依赖',
  temporal: '时间关联', related: '相关',
}

const titleOf = (node) => String(node?.title || node?.currentText || '未命名').trim() || '未命名'
const short = (value, limit = 90) => truncateGraphemes(String(value || ''), limit)

function liveEdges(projection) {
  const edges = projection?.allEdges || projection?.edges || []
  return (Array.isArray(edges) ? edges : []).filter((e) => e && e.reviewDecision !== 'rejected')
}

function liveNodes(projection) {
  const nodes = projection?.allNodes || projection?.nodes || []
  return (Array.isArray(nodes) ? nodes : []).filter((n) => n && !n.archived)
}

/**
 * 从当前投影派生读者模型。纯函数：projection/events → model。
 * 阈值（产品约定）：
 * - 一句话：主链长度 ≥ 2（至少一次推导），否则不生成
 * - 关键驱动：被论证边引用的概念/对象 ≥ 2 个
 * - 关键演变：有改名/更正记录的节点 ≥ 1 个
 * - 边界条件：depends-on 边 ≥ 1 条
 * - 争议焦点：contradicts 边或 disputed 节点 ≥ 1
 * - 下一步：待复核关系或近期变化 ≥ 1
 */
export function deriveReaderModel(projection = {}, events = []) {
  const nodes = liveNodes(projection)
  const edges = liveEdges(projection)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const model = {
    empty: nodes.length === 0,
    nodeCount: nodes.length,
    eventCount: Array.isArray(events) ? events.length : 0,
    oneLiner: null, drivers: [], evolutions: [], boundaries: [],
    disputes: [], pending: [], recent: [],
    status: '尚未开始',
  }
  if (model.empty) return model

  // 一句话：主链结论（链式阅读 = 主链结论先行）
  let mainChain = null
  try {
    const result = linearize(projection)
    mainChain = (result.chains || []).find((c) => c.kind === 'main') || null
  } catch { mainChain = null }
  if (mainChain && mainChain.steps.length >= 2) {
    const lastStep = mainChain.steps[mainChain.steps.length - 1]
    const conclusion = lastStep.nodes[0]
    const evidenceCount = new Set(mainChain.steps.flatMap((s) => (s.evidence || []).map((e) => e.id))).size
    model.oneLiner = {
      conclusion: titleOf(conclusion),
      conclusionId: conclusion?.id || null,
      steps: mainChain.steps.length,
      evidence: evidenceCount,
      hasPending: mainChain.steps.some((s) => s.pendingReview),
    }
  }

  // 关键驱动：被论证边引用的概念/对象（supports/derives 边从驱动指向观点，驱动在 from 端）
  const refCount = new Map()
  for (const edge of edges) {
    if (!ARG_RELS.has(edge.rel)) continue
    const source = byId.get(edge.from)
    if (!source) continue
    const type = networkNodeType(source)
    if (type !== 'concept' && type !== 'object') continue
    refCount.set(source.id, (refCount.get(source.id) || 0) + 1)
  }
  model.drivers = [...refCount.entries()]
    .map(([id, count]) => ({ id, title: titleOf(byId.get(id)), refs: count }))
    .sort((a, b) => b.refs - a.refs || a.title.localeCompare(b.title, 'zh'))
    .slice(0, 5)
  if (model.drivers.length < 2) model.drivers = []

  // 关键演变：改名/更正过的节点
  model.evolutions = nodes
    .filter((n) => (n.originalTitle && n.originalTitle !== n.title)
      || (Array.isArray(n.nameHistory) && n.nameHistory.length))
    .map((n) => ({
      id: n.id,
      from: n.originalTitle || n.nameHistory?.[0]?.previousTitle || '',
      to: titleOf(n),
      versions: (n.nameHistory?.length || 0) + 1,
    }))

  // 边界条件：depends-on 边
  model.boundaries = edges
    .filter((e) => e.rel === 'depends-on' && byId.has(e.from) && byId.has(e.to))
    .map((e) => ({ id: e.id, from: titleOf(byId.get(e.from)), fromId: e.from, to: titleOf(byId.get(e.to)), toId: e.to }))

  // 争议焦点：contradicts 边 + disputed 节点
  const disputeEdges = edges
    .filter((e) => e.rel === 'contradicts' && byId.has(e.from) && byId.has(e.to))
    .map((e) => ({
      id: e.id, from: titleOf(byId.get(e.from)), fromId: e.from,
      to: titleOf(byId.get(e.to)), toId: e.to,
      pending: Boolean(e.pendingReview),
    }))
  const disputedNodes = nodes
    .filter((n) => /disputed/i.test(String(n.status || '')))
    .map((n) => ({ id: `node:${n.id}`, from: titleOf(n), fromId: n.id, to: '', toId: null, pending: false, nodeDisputed: true }))
  model.disputes = [...disputeEdges, ...disputedNodes]

  // 下一步：待复核关系
  model.pending = edges
    .filter((e) => e.pendingReview && e.reviewDecision == null && byId.has(e.from) && byId.has(e.to))
    .map((e) => ({
      id: e.id, rel: REL_LABEL[e.rel] || e.rel,
      from: titleOf(byId.get(e.from)), fromId: e.from,
      to: titleOf(byId.get(e.to)), toId: e.to,
    }))

  // 近期变化：最近 5 条事件
  const rows = Array.isArray(events) ? events : []
  model.recent = rows.slice(-5).reverse().map((e) => compactEventSummary(e))

  if (model.disputes.length) model.status = '存在争议'
  else if (model.pending.length) model.status = '存在待复核关系'
  else if (model.oneLiner) model.status = '相对稳定'
  else model.status = '建设中'
  return model
}

const estimateReadSeconds = (model) => {
  if (model.empty) return 0
  const cards = [model.drivers, model.evolutions, model.boundaries, model.disputes, model.pending.length || model.recent.length ? [1] : []]
    .filter((list) => list.length).length
  return 25 + (model.oneLiner ? 20 : 0) + cards * 40
}

/** 证据：通过 supports 边指向目标节点的 evidence 节点。 */
function evidenceFor(projection, nodeIds) {
  const ids = new Set(nodeIds)
  const nodes = liveNodes(projection)
  const edges = liveEdges(projection)
  const evidenceIds = new Set()
  for (const edge of edges) {
    if (edge.rel !== 'supports' || !ids.has(edge.to)) continue
    const source = nodes.find((n) => n.id === edge.from)
    if (source && networkNodeType(source) === 'evidence') evidenceIds.add(source.id)
  }
  return nodes.filter((n) => evidenceIds.has(n.id))
}

const evidenceList = (items) => h('ul', { class: 'rdr-evidence' },
  ...items.slice(0, 6).map((n) => h('li', {},
    h('span', { class: 'rdr-evidence-dot', 'aria-hidden': 'true' }),
    h('span', {}, short(n.title || n.currentText, 80)))))

/**
 * 读者视图。opts: { onOpenBuilder(kind, nodeId) }
 * kind: 'network' | 'propositions' | 'attribution'
 */
/* ------------------------------------------------------------------ */
/* 主题骨架：读者一眼建模用。只取关键观点（按重要性排序，≤8 个），      */
/* 固定行布局保证渲染完整；状态色 + 支持/反驳数突出重要信息。            */
/* ------------------------------------------------------------------ */

const SKELETON_MAX = 8

function skeletonKeyNodes(projection) {
  const nodes = liveNodes(projection).filter((n) => networkNodeType(n) === 'viewpoint' && !n.archived && !n.invalidated)
  if (!nodes.length) return []
  const edges = liveEdges(projection)
  const scored = nodes.map((node) => {
    let supports = 0
    let contradicts = 0
    for (const e of edges) {
      if (e.to !== node.id && e.target !== node.id) continue
      if (e.rel === 'contradicts') contradicts++
      else if (e.rel === 'supports' || e.rel === 'derives') supports++
    }
    const disputed = contradicts > 0
    return { node, supports, contradicts, disputed, score: contradicts * 3 + supports + (disputed ? 5 : 0) }
  })
  scored.sort((a, b) => b.score - a.score || b.supports - a.supports)
  return scored.slice(0, SKELETON_MAX)
}

function renderSkeletonMap(projection, go) {
  const items = skeletonKeyNodes(projection)
  if (items.length < 2) return null
  const rowH = 84
  const padTop = 16
  const W = 680
  const H = padTop * 2 + items.length * rowH - 12
  const spineX = 20
  const svg = h('svg', {
    class: 'rdr-skeleton-svg', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `主题骨架：${items.length} 个关键观点`,
  })
  const ns = 'http://www.w3.org/2000/svg'
  const el = (tag, attrs) => {
    const n = document.createElementNS(ns, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    return n
  }
  /* 主干 */
  const topY = padTop + 32
  const botY = padTop + (items.length - 1) * rowH + 32
  svg.append(el('line', { x1: spineX, y1: topY, x2: spineX, y2: botY, class: 'rdr-skel-spine' }))
  items.forEach((item, i) => {
    const cy = padTop + i * rowH + 32
    const cardX = 44
    const cardW = W - cardX - 8
    const cardY = cy - 32
    const status = item.disputed ? 'disputed' : (item.supports > 0 ? 'verified' : 'draft')
    const g = el('g', { class: 'rdr-skel-node', tabindex: '0', role: 'button', 'aria-label': titleOf(item.node) })
    g.append(el('rect', { x: cardX, y: cardY, width: cardW, height: 64, rx: 12, class: 'rdr-skel-card' }))
    g.append(el('rect', { x: cardX, y: cardY, width: 4, height: 64, rx: 2, class: `rdr-skel-bar is-${status}` }))
    const dot = el('circle', { cx: spineX, cy, r: 7, class: `rdr-skel-dot is-${status}` })
    svg.append(el('line', { x1: spineX, y1: cy, x2: cardX, y2: cy, class: 'rdr-skel-link' }))
    svg.append(dot)
    const title = el('text', { x: cardX + 18, y: cy - 6, class: 'rdr-skel-title' })
    title.textContent = truncateGraphemes(titleOf(item.node), 30)
    g.append(title)
    const meta = el('text', { x: cardX + 18, y: cy + 16, class: 'rdr-skel-meta' })
    const bits = []
    if (item.disputed) bits.push(`有争议 · ${item.contradicts} 条反驳`)
    if (item.supports) bits.push(`${item.supports} 条支持`)
    if (!bits.length) bits.push('待补充论证')
    meta.textContent = bits.join(' · ')
    g.append(meta)
    const activate = () => go('network', item.node.id)
    g.addEventListener('click', activate)
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
    })
    svg.append(g)
  })
  const wrap = h('div', { class: 'rdr-skeleton' })
  const svgHost = h('span', { class: 'rdr-skeleton-host' })
  svgHost.append(svg)
  wrap.append(svgHost, h('p', { class: 'rdr-skel-hint' }, '关键观点骨架 · 点击节点深入建设者'))
  return wrap
}

export function renderReaderView(theme, opts = {}) {
  const article = h('article', { class: 'rdr', 'aria-label': `${theme?.name || '主题'} · 阅读视图` },
    h('p', { class: 'rdr-loading' }, '正在从当前投影生成阅读视图…'))
  const go = (kind, nodeId) => opts.onOpenBuilder?.(kind, nodeId)

  const render = (projection, events) => {
    const model = deriveReaderModel(projection, events)
    article.innerHTML = ''
    if (model.empty) { article.append(renderEmpty(theme, go)); return }

    const seconds = estimateReadSeconds(model)
    const readLabel = seconds < 60 ? `约 ${seconds} 秒读完` : `约 ${Math.round(seconds / 60)} 分钟读完`

    // Hero：一句话 = 当前核心判断（无置信度数字）
    const hero = h('header', { class: 'rdr-hero' },
      h('p', { class: 'rdr-kicker' }, `主题 · ${theme?.name || ''}`),
      h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题'),
      model.oneLiner
        ? h('p', { class: 'rdr-oneliner' }, model.oneLiner.conclusion)
        : h('p', { class: 'rdr-oneliner is-hint' }, '论证链还在生长中，暂不足以提炼一句话结论。'),
      h('div', { class: 'rdr-meta' },
        h('span', { class: 'rdr-status' }, model.status),
        h('span', { class: 'rdr-dot-sep', 'aria-hidden': 'true' }, '·'),
        h('span', {}, readLabel),
        model.oneLiner ? h('span', { class: 'rdr-dot-sep', 'aria-hidden': 'true' }, '·') : null,
        model.oneLiner ? h('span', {}, `${model.oneLiner.steps} 步论证 · ${model.oneLiner.evidence} 条证据`) : null,
        model.oneLiner?.hasPending ? h('span', { class: 'rdr-pending-flag' }, '含待复核环节') : null))

    // 速读 / 完整：完整模式在卡片下展开证据
    let fullMode = false
    const cardsHost = h('div', { class: 'rdr-cards' })
    const modeSwitch = h('div', { class: 'rdr-modeswitch', role: 'group', 'aria-label': '阅读模式' },
      h('button', {
        type: 'button', class: 'rdr-mode is-active', 'aria-pressed': 'true',
        onclick: (e) => setMode(false, e.currentTarget),
      }, '速读'),
      h('button', {
        type: 'button', class: 'rdr-mode', 'aria-pressed': 'false',
        onclick: (e) => setMode(true, e.currentTarget),
      }, '完整'))
    const setMode = (full, button) => {
      fullMode = full
      modeSwitch.querySelectorAll('.rdr-mode').forEach((b) => {
        const active = b === button
        b.classList.toggle('is-active', active)
        b.setAttribute('aria-pressed', String(active))
      })
      paintCards()
    }
    const paintCards = () => {
      cardsHost.innerHTML = ''
      for (const card of buildCards(model, projection, go, fullMode)) cardsHost.append(card)
      if (!cardsHost.children.length) {
        cardsHost.append(h('p', { class: 'rdr-note' }, '已有一些记录，但还不足以形成结构化卡片。去建设者视图继续添砖加瓦吧。'))
      }
    }
    paintCards()

    // 主题骨架：一眼建模（关键观点 + 状态 + 支持/反驳数）
    const skeleton = renderSkeletonMap(projection, go)

    // 尾声：读完的终点感 + 深入建设者
    const tail = h('footer', { class: 'rdr-tail' },
      h('p', { class: 'rdr-tail-title' }, '已读完当前核心'),
      h('p', { class: 'rdr-tail-sub' }, '以上均来自当前投影；判断的增删改只发生在建设者模式。'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('network') }, '深入 →'))

    article.append(hero, skeleton, modeSwitch, cardsHost, tail)
  }

  // 异步加载投影（与建设者视图同一数据源）
  const loadEvents = typeof opts.loadEvents === 'function'
    ? opts.loadEvents().catch(() => [])
    : Promise.resolve([])
  Promise.all([opts.loadProjection(), loadEvents])
    .then(([projection, events]) => render(projection || {}, events || []))
    .catch((e) => {
      article.innerHTML = ''
      article.append(h('p', { class: 'rdr-note' }, '阅读视图加载失败：' + (e?.message || e)))
    })
  return article
}

function renderEmpty(theme, go) {
  return h('div', { class: 'rdr-empty' },
    h('p', { class: 'rdr-kicker' }, `主题 · ${theme?.name || ''}`),
    h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题'),
    h('p', { class: 'rdr-empty-text' }, '这个主题还在建设中，还没有任何记录。'),
    h('p', { class: 'rdr-empty-sub' }, '主题是一步一步建起来的：先记下第一条观察或证据，网络会随之生长。'),
    h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('network') }, '去建设者视图开始记录'))
}

/** 按成熟度涌现卡片：有数据才渲染。返回元素数组。 */
function buildCards(model, projection, go, fullMode) {
  const cards = []
  const viewBtn = (kind, nodeId, label = '在建设者视图中查看') =>
    h('button', { type: 'button', class: 'rdr-card-link', onclick: () => go(kind, nodeId) }, label + ' →')

  if (model.drivers.length) {
    const max = Math.max(...model.drivers.map((d) => d.refs), 1)
    cards.push(h('section', { class: 'rdr-card' },
      h('p', { class: 'rdr-card-kicker' }, '关键驱动'),
      h('ul', { class: 'rdr-drivers' }, ...model.drivers.map((d) => h('li', {},
        h('button', { type: 'button', class: 'rdr-driver', onclick: () => go('network', d.id) },
          h('span', { class: 'rdr-driver-name' }, d.title),
          h('span', { class: 'rdr-driver-bar', 'aria-hidden': 'true' },
            h('span', { style: `width:${Math.round((d.refs / max) * 100)}%` })),
          h('span', { class: 'rdr-driver-refs' }, `被 ${d.refs} 条论证引用`))))),
      fullMode ? evidenceList(evidenceFor(projection, model.drivers.map((d) => d.id))) : null,
      viewBtn('network', model.drivers[0].id)))
  }

  if (model.evolutions.length) {
    cards.push(h('section', { class: 'rdr-card' },
      h('p', { class: 'rdr-card-kicker' }, '关键演变'),
      h('ul', { class: 'rdr-timeline' }, ...model.evolutions.slice(0, 4).map((v) => h('li', {},
        h('button', { type: 'button', class: 'rdr-evo', onclick: () => go('network', v.id) },
          v.from ? h('span', { class: 'rdr-evo-from' }, short(v.from, 40)) : null,
          v.from ? h('span', { class: 'rdr-evo-arrow', 'aria-hidden': 'true' }, '→') : null,
          h('span', { class: 'rdr-evo-to' }, short(v.to, 40)),
          v.versions > 1 ? h('span', { class: 'rdr-evo-ver' }, `第 ${v.versions} 版`) : null)))),
      viewBtn('network', model.evolutions[0].id)))
  }

  if (model.boundaries.length) {
    cards.push(h('section', { class: 'rdr-card' },
      h('p', { class: 'rdr-card-kicker' }, '边界条件'),
      h('ul', { class: 'rdr-list' }, ...model.boundaries.slice(0, 5).map((b) => h('li', {},
        h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('network', b.fromId) }, short(b.from, 36)),
        h('span', { class: 'rdr-muted' }, ' 依赖 '),
        h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('network', b.toId) }, short(b.to, 36))))),
      viewBtn('network', model.boundaries[0].fromId)))
  }

  if (model.disputes.length) {
    cards.push(h('section', { class: 'rdr-card is-dispute' },
      h('p', { class: 'rdr-card-kicker' }, '争议焦点'),
      h('ul', { class: 'rdr-list' }, ...model.disputes.slice(0, 5).map((d) => h('li', {},
        h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('network', d.fromId) }, short(d.from, 36)),
        d.to ? h('span', { class: 'rdr-muted' }, ' 反驳 ') : null,
        d.to ? h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('network', d.toId) }, short(d.to, 36)) : null,
        d.pending ? h('span', { class: 'rdr-flag' }, '待复核') : null,
        d.nodeDisputed ? h('span', { class: 'rdr-flag' }, '有争议') : null))),
      fullMode ? evidenceList(evidenceFor(projection, model.disputes.map((d) => d.fromId).filter(Boolean))) : null,
      viewBtn('attribution')))
  }

  if (model.pending.length || model.recent.length) {
    cards.push(h('section', { class: 'rdr-card is-action' },
      h('p', { class: 'rdr-card-kicker' }, '下一步'),
      model.pending.length ? h('p', { class: 'rdr-action-line' },
        h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('attribution') },
          `${model.pending.length} 条关系待你复核`), '，确认或驳回后网络才会更新。') : null,
      model.recent.length ? h('div', {},
        h('p', { class: 'rdr-recent-title' }, '最近动态'),
        h('ul', { class: 'rdr-recent' }, ...model.recent.slice(0, 3).map((t) => h('li', {}, short(t, 70))))) : null,
      viewBtn('attribution')))
  }
  return cards
}
