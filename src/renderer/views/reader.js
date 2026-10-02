import { h } from '../lib/dom.js'
import { linearize } from '../lib/chain-linearizer.js'
import { networkNodeType, truncateGraphemes } from '../lib/theme-network.js'
import { compactEventSummary } from '../lib/chain-ui-model.js'
import { PROP_STATUS_LABEL, confidenceBar } from './chain.js'

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

/* 三层模型映射表（从九种枚举改成三层模型）
   维度一 direction：状态量（好转/恶化/稳定）→ 决定颜色
   维度二 nature：变化性质（量变/质变/认识/结构）→ 决定图标
   维度三 themeTag：主题标签（开放字符串） */
export const DIRECTION_META = {
  improving: { label: '好转', color: 'var(--green)', icon: '↑' },
  declining: { label: '恶化', color: 'var(--red)', icon: '↓' },
  stable: { label: '稳定', color: 'var(--text-3)', icon: '→' },
}
export const NATURE_META = {
  quantitative: { label: '量变', icon: '·' },
  pivot: { label: '质变', icon: '⇄' },
  epistemic: { label: '认识', icon: '◉' },
  structural: { label: '结构', icon: '⑂' },
}

/* 从事件类型推导变化性质 */
function natureFromEvent(event) {
  const type = event?.type || ''
  if (type === 'confidence.updated') return 'quantitative'
  if (type === 'evidence.appended') {
    const rel = event?.payload?.rel || ''
    return rel === 'contradicts' ? 'epistemic' : 'quantitative'
  }
  if (type === 'relation.declared') return 'structural'
  if (type === 'claim.created') return 'epistemic'
  return 'quantitative'
}

/* 从事件内容推导主题标签（开放，系统建议） */
function themeTagFromEvent(event) {
  const payload = event?.payload || {}
  if (payload.themeTag) return payload.themeTag
  const type = event?.type || ''
  if (type === 'confidence.updated') return '置信度变化'
  if (type === 'evidence.appended') {
    const rel = payload.rel || ''
    return rel === 'contradicts' ? '假设挑战' : '证据支持'
  }
  if (type === 'relation.declared') return '关系建立'
  if (type === 'claim.created') return '新命题'
  return '数据更新'
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
    /* 三问模型：方向 + 状态 + 拐点 */
    directionCounts: { improving: 0, declining: 0, stable: 0 },
    nodesByDirection: { improving: [], declining: [], stable: [] },
    turningPoints: [],
  }
  if (model.empty) return model

  /* ---- 方向推导：基于最近30天置信度变化 ---- */
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  const confChanges = new Map() // nodeId -> { net: number, latest: event }
  for (const event of (Array.isArray(events) ? events : [])) {
    if (event?.type !== 'confidence.updated') continue
    const payload = event?.payload || {}
    const nodeId = payload.nodeId || payload.claimId
    if (!nodeId || !byId.has(nodeId)) continue
    const at = new Date(event?.at || event?.timestamp || 0).getTime()
    if (at < thirtyDaysAgo) continue
    const before = payload.before ?? payload.oldConfidence ?? 0
    const after = payload.after ?? payload.newConfidence ?? 0
    const delta = after - before
    if (!confChanges.has(nodeId)) confChanges.set(nodeId, { net: 0, latest: null, latestAt: 0 })
    const entry = confChanges.get(nodeId)
    entry.net += delta
    if (at > entry.latestAt) { entry.latest = event; entry.latestAt = at }
  }

  /* ---- 节点方向与状态 ---- */
  const viewpoints = nodes.filter((n) => networkNodeType(n) === 'viewpoint')
  /* 证据统计 */
  const evStats = new Map()
  for (const v of viewpoints) evStats.set(v.id, { supports: 0, contradicts: 0, latestEv: null, latestAt: 0 })
  for (const edge of edges) {
    const stat = evStats.get(edge.to)
    if (!stat) continue
    if (edge.rel === 'supports' || edge.rel === 'derives') stat.supports++
    else if (edge.rel === 'contradicts') stat.contradicts++
  }
  /* 最新证据 */
  for (const event of (Array.isArray(events) ? events : [])) {
    if (event?.type !== 'evidence.appended') continue
    const payload = event?.payload || {}
    const nodeId = payload.nodeId || payload.targetId
    const stat = evStats.get(nodeId)
    if (!stat) continue
    const at = new Date(event?.at || event?.timestamp || 0).getTime()
    if (at > stat.latestAt) {
      stat.latestEv = event
      stat.latestAt = at
    }
  }

  for (const node of viewpoints) {
    const change = confChanges.get(node.id)
    const stat = evStats.get(node.id) || { supports: 0, contradicts: 0 }
    /* 方向：净变化 >5% 上升，<-5% 承压，否则稳定 */
    let direction = 'stable'
    if (change) {
      if (change.net > 0.05) direction = 'improving'
      else if (change.net < -0.05) direction = 'declining'
    }
    /* 有反驳无支持 → 恶化 */
    if (direction === 'stable' && stat.contradicts > 0 && stat.supports === 0) direction = 'declining'

    /* 一句话状态：标题 + 置信度 + 证据对比 */
    const conf = Math.round((node.confidence ?? 0.5) * 100)
    let state = titleOf(node)
    if (stat.supports > 0 || stat.contradicts > 0) {
      state += `：${stat.supports} 条支持，${stat.contradicts} 条反驳，置信度 ${conf}%`
    } else {
      state += `：置信度 ${conf}%，暂无证据`
    }

    /* 最近关键变化 */
    let latest = null, latestSrc = null
    if (stat.latestEv) {
      const p = stat.latestEv.payload || {}
      latest = p.title || p.text?.slice(0, 30) || '新证据'
      latestSrc = p.sourceLabel || p.url || '来源'
    } else if (change?.latest) {
      const p = change.latest.payload || {}
      latest = `置信度 ${Math.round((p.before ?? 0) * 100)}% → ${Math.round((p.after ?? 0) * 100)}%`
      latestSrc = '自动更新'
    }

    /* 三层模型：从最新事件推导 nature 和 themeTag */
    const latestEvent = stat.latestEv || change?.latest || null
    const nature = latestEvent ? natureFromEvent(latestEvent) : 'quantitative'
    const themeTag = latestEvent ? themeTagFromEvent(latestEvent) : '暂无标签'
    model.nodesByDirection[direction].push({
      id: node.id,
      title: titleOf(node),
      direction,
      nature,
      themeTag,
      state,
      latest,
      latestSrc,
      confidence: conf,
    })
    model.directionCounts[direction]++
  }

  /* 排序：上升在前，承压其次，稳定最后；组内按置信度 */
  for (const dir of ['improving', 'declining', 'stable']) {
    model.nodesByDirection[dir].sort((a, b) => b.confidence - a.confidence)
  }

  /* ---- 拐点：最近30天显著改变方向的事件 ---- */
  const turningCandidates = []
  for (const [nodeId, change] of confChanges) {
    /* 单次变化幅度 >10% 视为拐点（三层模型） */
    if (Math.abs(change.net) < 0.1) continue
    const node = byId.get(nodeId)
    if (!node) continue
    const dir = change.net > 0 ? 'improving' : 'declining'
    const latestEv = change.latest
    turningCandidates.push({
      date: new Date(change.latestAt).toISOString().slice(0, 10),
      timestamp: change.latestAt,
      direction: dir,
      nature: latestEv ? natureFromEvent(latestEv) : 'quantitative',
      themeTag: latestEv ? themeTagFromEvent(latestEv) : '置信度变化',
      text: `${titleOf(node)}：置信度变化 ${Math.round(change.net * 100)}%`,
      nodeIds: [nodeId],
      nodeTitles: [titleOf(node)],
    })
  }
  /* 按时间倒序，最多取 5 个 */
  turningCandidates.sort((a, b) => b.timestamp - a.timestamp)
  model.turningPoints = turningCandidates.slice(0, 5)

  /* 一句话（保留原有逻辑，用于顶部） */
  let mainChain = null
  try {
    const result = linearize(projection)
    mainChain = (result.chains || []).find((c) => c.kind === 'main') || null
  } catch { mainChain = null }
  if (mainChain && mainChain.steps.length >= 2) {
    const lastStep = mainChain.steps[mainChain.steps.length - 1]
    const conclusion = lastStep.nodes[0]
    model.oneLiner = { conclusion: titleOf(conclusion) }
  }

  return model
}

/* ------------------------------------------------------------------ */
/* 渲染：三问结构 */const estimateReadSeconds = (model) => {
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
  const article = h('article', { class: 'rdr', 'aria-label': `${theme?.name || '主题'} · 阅读视图` },
    h('p', { class: 'rdr-loading' }, '正在从当前投影生成阅读视图…'))
  const go = (kind, nodeId) => opts.onOpenBuilder?.(kind, nodeId)

  const DIR_META = {
    up: { icon: '↑', label: '上升', cls: 'is-up' },
    down: { icon: '↓', label: '承压', cls: 'is-down' },
    flat: { icon: '→', label: '稳定', cls: 'is-flat' },
  }

  const render = (projection, events) => {
    const model = deriveReaderModel(projection, events)
    article.innerHTML = ''
    if (model.empty) { article.append(renderEmpty(theme, go)); return }

    /* 顶部：一句话 + 方向计数 */
    const { up, down, flat } = model.directionCounts
    const hero = h('header', { class: 'rdr-hero' },
      h('p', { class: 'rdr-kicker' }, `主题 · ${theme?.name || ''}`),
      h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题'),
      model.oneLiner
        ? h('p', { class: 'rdr-oneliner' }, model.oneLiner.conclusion)
        : h('p', { class: 'rdr-oneliner is-hint' }, '论证链还在生长中，暂不足以提炼一句话结论。'),
      h('div', { class: 'rdr-dir-counts' },
        h('span', { class: 'rdr-dir-count is-up' }, '↑ 上升 ', h('b', {}, String(up))),
        h('span', { class: 'rdr-dir-count is-down' }, '↓ 承压 ', h('b', {}, String(down))),
        h('span', { class: 'rdr-dir-count is-flat' }, '→ 稳定 ', h('b', {}, String(flat)))))

    /* 第一问：现在是什么状态 — 节点按方向排序 */
    const stateSection = h('section', { class: 'rdr-section' },
      h('h2', { class: 'rdr-section-title' }, '现在是什么状态'))
    for (const dir of ['improving', 'declining', 'stable']) {
      const nodes = model.nodesByDirection[dir]
      if (!nodes.length) continue
      const meta = DIR_META[dir]
      const group = h('div', { class: 'rdr-dir-group' },
        h('h3', { class: `rdr-dir-label ${meta.cls}` }, `${meta.icon} ${meta.label} · ${nodes.length}`))
      for (const node of nodes) {
        /* 三层模型：themeTag 大字（direction 颜色）+ nature 小字 */
        const natMeta = NATURE_META[node.nature] || NATURE_META.quantitative
        const dirMeta = DIRECTION_META[node.direction] || DIRECTION_META.stable
        group.append(
          h('button', {
            type: 'button', class: 'rdr-node-card',
            onclick: () => go('network', node.id),
          },
            h('div', { class: 'rdr-node-top' },
              h('span', { class: `rdr-dir-tag ${meta.cls}` }, `${meta.icon} ${meta.label}`),
              h('span', { class: 'rdr-node-title' }, node.title)),
            h('div', { class: 'rdr-node-tags' },
              h('span', { class: 'rdr-theme-tag', style: `color:${dirMeta.color}` }, node.themeTag || ''),
              h('span', { class: 'rdr-nature-tag' }, `${natMeta.icon} ${natMeta.label}`)),
            h('p', { class: 'rdr-node-state' }, node.state),
            node.latest
              ? h('p', { class: 'rdr-node-latest' },
                  h('span', { class: 'rdr-latest-label' }, '最近：'),
                  node.latest,
                  node.latestSrc ? h('span', { class: 'rdr-latest-src' }, ` · ${node.latestSrc}`) : null)
              : null))
      }
      stateSection.append(group)
    }

    /* 第二问：最近有没有拐点 */
    const turnSection = h('section', { class: 'rdr-section' },
      h('h2', { class: 'rdr-section-title' }, '最近有没有拐点'))
    if (!model.turningPoints.length) {
      turnSection.append(h('p', { class: 'rdr-note' }, '最近 30 天没有显著的方向变化。'))
    } else {
      const list = h('div', { class: 'rdr-turn-list' })
      for (const tp of model.turningPoints) {
        /* 三层模型：颜色由 direction，图标由 nature，显示 themeTag */
        const dirMeta = DIRECTION_META[tp.direction] || DIRECTION_META.stable
        const natMeta = NATURE_META[tp.nature] || NATURE_META.quantitative
        list.append(
          h('button', {
            type: 'button', class: 'rdr-turn-card',
            onclick: () => { if (tp.nodeIds[0]) go('network', tp.nodeIds[0]) },
          },
            h('div', { class: 'rdr-turn-top' },
              h('span', { class: 'rdr-turn-date' }, tp.date),
              h('span', { class: 'rdr-turn-tag', style: `color:${dirMeta.color}` }, tp.themeTag || ''),
              h('span', { class: 'rdr-turn-nature' }, `${natMeta.icon} ${natMeta.label}`)),
            h('p', { class: 'rdr-turn-text' }, tp.text),
            tp.nodeTitles?.length
              ? h('p', { class: 'rdr-turn-nodes' }, '影响：' + tp.nodeTitles.join('、'))
              : null))
      }
      turnSection.append(list)
    }

    /* 尾声：去建设者深入 */
    const tail = h('footer', { class: 'rdr-tail' },
      h('p', { class: 'rdr-tail-sub' }, '想看每一条数据的完整演化？去建设者视图。'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('network') }, '进入建设者 →'))

    article.append(hero, stateSection, turnSection, tail)
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
