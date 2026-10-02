import { h } from '../lib/dom.js'
import { networkNodeType, truncateGraphemes } from '../lib/theme-network.js'
import { deriveReaderModel, DIRECTION_META, NATURE_META, estimateReadSeconds } from '../lib/reader-model.js'

const PROP_STATUS_LABEL = { pending: '待确认', verified: '已确认', disputed: '有争议' }
const confidenceBar = (confidence, { showLabel = true } = {}) => {
  const value = confidence == null || !Number.isFinite(Number(confidence)) ? null : Math.max(0, Math.min(100, Math.round(Number(confidence))))
  if (value == null) return h('span', { class: 'conf-bar is-empty' }, showLabel ? h('span', { class: 'conf-bar-label' }, '未评估') : null)
  const level = value >= 70 ? 'high' : value >= 40 ? 'mid' : 'low'
  return h('span', { class: `conf-bar is-${level}`, role: 'img', 'aria-label': `置信度 ${value}%` },
    h('span', { class: 'conf-bar-track' }, h('span', { class: 'conf-bar-fill', style: `width:${value}%` })),
    showLabel ? h('span', { class: 'conf-bar-label' }, `${value}%`) : null)
}
const short = (value, limit = 90) => truncateGraphemes(String(value || ''), limit)
const titleOf = (node) => String(node?.title || node?.currentText || '未命名')
const liveNodes = (projection) => (projection?.allNodes || projection?.nodes || []).filter((node) => node && !node.archived)
const liveEdges = (projection) => (projection?.allEdges || projection?.edges || []).filter((edge) => edge && edge.reviewDecision !== 'rejected')

/* ------------------------------------------------------------------ */
/* 渲染：与 demo 对齐的三段式阅读结构。 */

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
    const activate = () => go('builder', item.node.id)
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

/* 关键数字：命题 / 证据 / 支持 / 反驳 / 待确认 */
function renderKeyNumbers(model) {
  if (!model.keyNumbers?.length) return null
  return h('section', { class: 'rdr-numbers', 'aria-label': '关键数字' },
    ...model.keyNumbers.map((item) =>
      h('div', { class: 'rdr-number' },
        h('div', { class: 'rdr-number-value' }, String(item.value)),
        h('div', { class: 'rdr-number-label' }, item.label))))
}

/* 核心判断：关键命题 + 置信度 + 状态 */
function renderKeyJudgments(model, go) {
  if (!model.keyJudgments?.length) return null
  return h('section', { class: 'rdr-judgments', 'aria-label': '核心判断' },
    h('h2', { class: 'rdr-section-title' }, '核心判断'),
    h('ul', { class: 'rdr-judgment-list' },
      ...model.keyJudgments.map((j) =>
        h('li', {},
          h('button', {
            type: 'button', class: 'rdr-judgment', onclick: () => go('propositions', j.id),
          },
            h('span', { class: 'rdr-judgment-main' },
              h('span', { class: 'rdr-judgment-title' }, j.title),
              h('span', { class: 'rdr-judgment-meta' },
                h('span', { class: `cog-wb-meta-pill is-${j.status}` }, PROP_STATUS_LABEL[j.status] || '待核验'),
                j.supports ? h('span', {}, `${j.supports} 支持`) : null,
                j.contradicts ? h('span', { class: 'is-against' }, `${j.contradicts} 反驳`) : null)),
            confidenceBar(j.confidence))))))
}

/* 最新变化：主题是活的——外部信息 + 时间驱动变化。这里让人一眼看到"变了什么"。 */
function renderRecentChanges(model) {
  if (!model.recent?.length) return null
  return h('section', { class: 'rdr-changes', 'aria-label': '最新变化' },
    h('h2', { class: 'rdr-section-title' }, '最新变化'),
    h('ul', { class: 'rdr-change-list' },
      ...model.recent.slice(0, 5).map((text) =>
        h('li', { class: 'rdr-change' },
          h('span', { class: 'rdr-change-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'rdr-change-text' }, short(text, 90))))))
}

export function renderReaderView(theme, opts = {}) {
  /* 最外层：demo 样式作用域 */
  const root = h('div', { class: 'meridian-theme' })
  const article = h('article', { class: 'reader-main', 'aria-label': `${theme?.name || '主题'} · 阅读视图` },
    h('p', { class: 'rdr-loading' }, '正在从当前投影生成阅读视图…'))
  root.append(article)
  const go = (kind, nodeId) => opts.onOpenBuilder?.(kind, nodeId)

  /* 三层 → 颜色/图标：颜色由 direction，图标由 nature */
  const dirColor = (d) => (DIRECTION_META[d] || DIRECTION_META.undetermined).color
  const dirIcon = (d) => (DIRECTION_META[d] || DIRECTION_META.undetermined).icon
  const dirLabel = (d) => (DIRECTION_META[d] || DIRECTION_META.undetermined).label
  const natIcon = (n) => (NATURE_META[n] || NATURE_META.quantitative).icon

  /* 节点卡片：1:1 对齐 demo renderNodeCard */
  const renderNodeCard = (node) => {
    const evo = Array.isArray(node.evolution) && node.evolution.length ? node.evolution : [{
      date: '', direction: node.direction || 'stable',
      nature: node.nature || 'quantitative', themeTag: node.themeTag || '',
    }]
    return h('div', {
      class: 'node-card', role: 'button', tabindex: '0', 'aria-label': `查看${node.title}的演化详情`,
      'data-node': node.id,
      onclick: () => go('builder', node.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('builder', node.id) } },
    },
      h('div', { class: 'node-top' },
        h('span', { class: 'node-dot', style: `background:${dirColor(node.direction)}` }),
        h('span', { class: 'node-name' }, node.title),
        /* trend 标签：themeTag（direction 颜色）+ nature 图标小字 */
        h('span', { class: 'node-trend', style: `color:${dirColor(node.direction)}` },
          `${natIcon(node.nature)} ${node.themeTag || dirLabel(node.direction)}`)),
      h('div', { class: 'node-state' }, node.state),
      node.confidence == null ? null : h('div', { class: 'node-confidence' }, confidenceBar(node.confidence)),
      h('div', {},
        h('div', { class: 'mini-evo' },
          h('div', { class: 'mini-evo-track' },
            ...evo.flatMap((e, i) => {
              const isLast = i === evo.length - 1
              const cls = ['mini-point', isLast ? 'latest' : ''].filter(Boolean).join(' ')
              const point = h('span', {
                class: cls,
                style: `color:${dirColor(e.direction)}`,
                title: `${e.date} · ${e.themeTag || ''}`,
              }, natIcon(e.nature))
              return i < evo.length - 1 ? [point, h('span', { class: 'spacer' })] : [point]
            }))),
        h('div', { class: 'mini-evo-meta' },
          h('span', {}, (evo[0].date || '').slice(5)),
          h('span', {}, `${evo.length} 次变化`),
          h('span', {}, (evo[evo.length - 1].date || '').slice(5)))))
  }

  const render = (projection, events) => {
    const model = deriveReaderModel(projection, events)
    article.innerHTML = ''
    if (model.empty) { article.append(renderEmpty(theme, go)); return }

    const inner = h('div', { class: 'reader-inner' })

    /* Hero */
    const { improving, declining, stable, undetermined } = model.directionCounts
    inner.append(
      h('div', { class: 'hero' },
        h('div', { class: 'hero-kicker' }, `主题 · ${theme?.name || ''}`),
        h('h1', { class: 'hero-title' }, theme?.name || '未命名主题'),
        h('p', { class: 'hero-line' },
          model.oneLiner ? model.oneLiner.conclusion : '论证链还在生长中，暂不足以提炼一句话结论。'),
        h('div', { class: 'trend-overview' },
          h('div', { class: 'trend-group' },
            h('span', { class: 'icon', style: 'background:rgba(48,209,88,.12);color:var(--green)' }, '↑'),
            h('span', { class: 'label' }, '好转', h('b', {}, String(improving)))),
          h('div', { class: 'trend-group' },
            h('span', { class: 'icon', style: 'background:rgba(255,59,48,.1);color:var(--red)' }, '↓'),
            h('span', { class: 'label' }, '恶化', h('b', {}, String(declining)))),
          h('div', { class: 'trend-group' },
            h('span', { class: 'icon', style: 'background:rgba(29,29,31,.06);color:var(--text-3)' }, '→'),
            h('span', { class: 'label' }, '稳定', h('b', {}, String(stable)))),
          h('div', { class: 'trend-group' },
            h('span', { class: 'icon', style: 'background:rgba(29,29,31,.04);color:var(--text-3)' }, '·'),
            h('span', { class: 'label' }, '待观察', h('b', {}, String(undetermined)))))))

    /* 阅读时间 */
    inner.append(
      h('div', { class: 'read-time' },
        h('span', {}, '◷'),
        h('span', {}, '阅读时间约 ', h('b', {}, `${estimateReadSeconds(model)} 秒`), ' · 共 3 个模块'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, '向下滑动继续')))

    /* 卡片 1：当前状态 */
    const allNodes = [
      ...model.nodesByDirection.improving,
      ...model.nodesByDirection.declining,
      ...model.nodesByDirection.stable,
      ...model.nodesByDirection.undetermined,
    ]
    const card1 = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-num' }, '1'),
        h('span', { class: 'card-title' }, '当前状态'),
        h('span', { class: 'card-time' }, '25 秒')),
      h('div', {}, ...allNodes.map(renderNodeCard)))
    inner.append(card1)

    /* 卡片 2：最近拐点 */
    const turnList = h('div', { class: 'turning-list' })
    if (!model.turningPoints.length) {
      turnList.append(h('div', { class: 'turning' },
        h('div', { class: 'turning-text' }, '最近 30 天没有显著的方向变化。')))
    } else {
      for (const tp of model.turningPoints) {
        turnList.append(
          h('div', { class: 'turning' },
            h('div', { class: 'turning-date' },
              h('span', {}, tp.date || ''),
              /* type 标签：themeTag + nature 图标，direction 颜色 */
              h('span', { class: 'turning-type', style: `color:${dirColor(tp.direction)}` },
                `${natIcon(tp.nature)} ${tp.themeTag || ''}`)),
            h('div', { class: 'turning-text' }, tp.text),
            h('div', { class: 'turning-nodes' },
              ...(tp.nodeTitles || []).map(t =>
                h('span', { class: 'turning-pill' },
                  h('span', { class: 'nd', style: `background:${dirColor(tp.direction)}` }), t)))))
      }
    }
    inner.append(
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('span', { class: 'card-num' }, '2'),
          h('span', { class: 'card-title' }, '最近拐点'),
          h('span', { class: 'card-time' }, '15 秒')),
        turnList))

    /* 卡片 3：深入某一个方向 */
    inner.append(
      h('div', { class: 'next-card' },
        h('div', { class: 'card-head' },
          h('span', { class: 'card-num' }, '3'),
          h('span', { class: 'card-title' }, '深入某一个方向'),
          h('span', { class: 'card-time' }, '5 秒')),
        h('div', { class: 'next-body' },
          '点击任意节点，查看它', h('b', {}, '随时间演化的完整过程'),
          '——不是简单的上下，而是包括量变、质变、认识更新、结构变化等多种形态。'),
        h('div', { class: 'node-quick-list' },
          ...allNodes.map((node) => {
            const evoLen = Array.isArray(node.evolution) ? node.evolution.length : 0
            const lastDate = evoLen ? (node.evolution[evoLen - 1].date || '') : ''
            return h('div', {
              class: 'node-quick',
              'data-goto-node': node.id,
              onclick: () => go('builder', node.id),
            },
              h('div', { class: 'node-quick-top' },
                h('span', { class: 'node-dot', style: `background:${dirColor(node.direction)}` }),
                h('span', { class: 'node-quick-name' }, node.title),
                h('span', { class: 'node-trend', style: `color:${dirColor(node.direction)}` },
                  `${natIcon(node.nature)} ${node.themeTag || dirLabel(node.direction)}`),
                h('span', { class: 'node-quick-arrow' }, '→')),
              h('div', { class: 'node-quick-state' }, node.state),
              h('div', { class: 'node-quick-meta' },
                h('span', {}, `${evoLen} 次状态变化`),
                h('span', {}, '·'),
                h('span', {}, lastDate ? `最近 ${lastDate}` : '暂无变化记录')))
          })),
        h('div', { class: 'next-chips' },
          h('span', { class: 'chip', 'data-goto': 'builder', onclick: () => go('builder') }, '进入建设者视图'))))

    /* 尾部 */
    inner.append(
      h('div', { class: 'tail' },
        h('div', { class: 'tail-mark' }, '✓'),
        '已读完当前核心', h('br', {}),
        '数据的增删改只发生在建设者模式。'))

    article.append(inner)
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
  return root
}

function renderEmpty(theme, go) {
  return h('div', { class: 'rdr-empty' },
    h('p', { class: 'rdr-kicker' }, `主题 · ${theme?.name || ''}`),
    h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题'),
    h('p', { class: 'rdr-empty-text' }, '这个主题还在建设中，还没有任何记录。'),
    h('p', { class: 'rdr-empty-sub' }, '主题是一步一步建起来的：先记下第一条观察或证据，网络会随之生长。'),
    h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('builder') }, '去建设者视图开始记录'))
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
        h('button', { type: 'button', class: 'rdr-driver', onclick: () => go('builder', d.id) },
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
        h('button', { type: 'button', class: 'rdr-evo', onclick: () => go('builder', v.id) },
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
        h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('builder', b.fromId) }, short(b.from, 36)),
        h('span', { class: 'rdr-muted' }, ' 依赖 '),
        h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('builder', b.toId) }, short(b.to, 36))))),
      viewBtn('network', model.boundaries[0].fromId)))
  }

  if (model.disputes.length) {
    cards.push(h('section', { class: 'rdr-card is-dispute' },
      h('p', { class: 'rdr-card-kicker' }, '争议焦点'),
      h('ul', { class: 'rdr-list' }, ...model.disputes.slice(0, 5).map((d) => h('li', {},
        h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('builder', d.fromId) }, short(d.from, 36)),
        d.to ? h('span', { class: 'rdr-muted' }, ' 反驳 ') : null,
        d.to ? h('button', { type: 'button', class: 'rdr-inline-link', onclick: () => go('builder', d.toId) }, short(d.to, 36)) : null,
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
