import { h } from '../lib/dom.js'
import { RELATION_META } from '../lib/theme-network.js'
import { RELATION_LABEL } from '../lib/chain-ui-model.js'
import { buildAtomBoard, isAtom } from '../lib/reader-board.js'
import { renderReaderAtomDetail } from '../components/reader-atom-detail.js'
import { renderReaderBrief, renderReaderBoard, renderReaderFeed, renderReaderWatch } from '../components/reader-board.js'

const asArray = (value) => Array.isArray(value) ? value : []
const allNodesOf = (projection) => asArray(projection?.allNodes || projection?.nodes).filter(Boolean)
const allEdgesOf = (projection) => asArray(projection?.allEdges || projection?.edges).filter(Boolean)
const text = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
const finiteOrNull = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null)

/**
 * 读者页：主题 = 一组原子；外部数据对原子表态。
 * 一句话（检验到什么程度）→ 原子看板（按检验状态分组）→ 最近进来的外部数据 → 接下来看什么。
 * 点任一原子开右侧抽屉；节点 id 与建设者共用同一份投影。
 * 账本序号控件可只读回放到历史前缀（不写账本）。
 */
export function renderReaderView(theme, opts = {}) {
  const root = h('div', { class: 'meridian-theme rdr-root' })
  const article = h('article', { class: 'reader-main rdr-main', 'aria-label': `${theme?.name || '主题'} · 读者视图` },
    h('p', { class: 'rdr-loading' }, '正在读取主题网络…'))
  root.append(article)

  let liveProjection = {}
  let ledgerEvents = []
  let selectedSeq = null
  let rendering = false

  const renderEmpty = () => h('div', { class: 'rdr-empty' },
    h('p', { class: 'rdr-kicker' }, '主题范围 · 真实空投影'),
    h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题'),
    h('p', { class: 'rdr-empty-text' }, '这个主题还没有原子。'),
    h('p', { class: 'rdr-empty-sub' }, '在建设者里把主题拆成能被独立验证的原子；之后进来的外部数据会对它们佐证、反对或中立。'),
    h('button', { type: 'button', class: 'btn btn-primary rdr-builder-link', onclick: () => opts.onOpenBuilder?.('network') }, '进入建设者视图'))

  const maxSeq = () => ledgerEvents.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)

  const renderTimeline = (onReplay) => {
    const end = maxSeq()
    if (end < 1) return null
    const current = selectedSeq == null ? end : selectedSeq
    const slider = h('input', {
      class: 'rdr-history-slider', type: 'range', min: '1', max: String(end), step: '1',
      value: String(current), 'aria-label': '按账本序号回放读者视图',
    })
    const label = h('span', { class: 'rdr-history-label', 'aria-live': 'polite' },
      selectedSeq == null ? `当前 · 第 ${end} 条` : `历史 · 第 ${selectedSeq} 条`)
    const live = h('button', {
      type: 'button', class: 'btn btn-sm rdr-history-live', hidden: selectedSeq == null,
      onclick: () => onReplay(null),
    }, '回到当前')
    slider.addEventListener('input', () => {
      label.textContent = `历史 · 第 ${slider.value} 条`
      live.hidden = Number(slider.value) >= end
    })
    slider.addEventListener('change', () => onReplay(Number(slider.value)))
    return h('div', { class: 'rdr-history', role: 'group', 'aria-label': '账本序号回放' },
      h('span', { class: 'rdr-history-kicker' }, '账本回放'),
      slider, label, live)
  }

  const render = (currentProjection, rawEvents) => {
    const events = asArray(rawEvents)
    const currentNodes = allNodesOf(currentProjection)
    const currentEdges = allEdgesOf(currentProjection)
    const board = buildAtomBoard({ nodes: currentNodes, edges: currentEdges })
    if (!board.atoms.length) {
      /* 原生 replaceChildren(null) 会落成文本 "null"；空主题无事件时时间轴为 null。 */
      const emptyKids = [renderEmpty(), renderTimeline((seq) => { void showAt(seq) })].filter(Boolean)
      article.replaceChildren(...emptyKids)
      return
    }
    const atomById = new Map(board.atoms.map((atom) => [atom.id, atom]))
    const nodeById = new Map(currentNodes.filter(isAtom).map((node) => [String(node.id), node]))

    /* 原子之间的明确边（两端都是现存原子；已驳回的不算）。同一对、同一关系、同一方向只列一次，按账本顺序。 */
    const relationsOf = (id) => {
      const seen = new Set()
      return currentEdges
        .filter((edge) => edge.reviewDecision !== 'rejected' && edge.from !== edge.to && (edge.from === id || edge.to === id))
        .sort((a, b) => (finiteOrNull(a.seq) ?? Infinity) - (finiteOrNull(b.seq) ?? Infinity) || String(a.id).localeCompare(String(b.id)))
        .map((edge) => {
          const direction = edge.from === id ? 'out' : 'in'
          const otherId = String(direction === 'out' ? edge.to : edge.from)
          const other = atomById.get(otherId)
          const key = `${otherId}\u0000${edge.rel}\u0000${direction}`
          if (!other || seen.has(key)) return null
          seen.add(key)
          return { id: otherId, title: other.title, direction, label: RELATION_META[edge.rel]?.label || RELATION_LABEL[edge.rel] || text(edge.rel) || '关系' }
        })
        .filter(Boolean)
    }
    /* 修订历史：该原子修订链上的 correction.appended（只列改了文本的），按账本顺序。 */
    const correctionsOf = (node) => {
      const ids = new Set(asArray(node?.eventIds))
      return events
        .filter((event) => event?.type === 'correction.appended' && ids.has(event.id) && text(event.payload?.newValue))
        .sort((a, b) => (finiteOrNull(a.seq) ?? Infinity) - (finiteOrNull(b.seq) ?? Infinity))
        .map((event) => ({
          day: /^\d{4}-\d{2}-\d{2}/.test(text(event.at)) ? text(event.at).slice(0, 10) : null,
          oldValue: text(event.payload.oldValue) || null,
          newValue: text(event.payload.newValue),
          reason: text(event.payload.reason) || null,
        }))
    }
    const engineStrengthOf = (node) => {
      const value = finiteOrNull(node?.confidence)
      return value == null ? null : Math.round(Math.max(0, Math.min(100, value)))
    }

    /* 右侧抽屉：fixed 定位但挂在 article 内（fixture 用 currentRoot.querySelector('.rdr-detail') 找它）。 */
    let openKey = null
    let triggerEl = null
    let switchTimer = null
    let seenConnected = false
    const detailHost = h('div', { class: 'rdr-detail', role: 'dialog', 'aria-label': '原子详情', 'aria-hidden': 'true', tabindex: '-1' })
    const detailBackdrop = h('div', { class: 'rdr-drawer-backdrop', 'aria-hidden': 'true' })
    const closeDrawer = () => {
      if (openKey == null) return
      openKey = null
      detailHost.classList.remove('is-open', 'is-switching')
      detailBackdrop.classList.remove('is-open')
      detailHost.setAttribute('aria-hidden', 'true')
      document.body.style.overflow = ''
      if (triggerEl?.isConnected) triggerEl.focus()
      triggerEl = null
    }
    const showDrawer = (key, label, content, trigger) => {
      const wasOpen = openKey != null
      if (!wasOpen && trigger?.isConnected) triggerEl = trigger
      openKey = key
      detailHost.setAttribute('aria-label', label)
      if (wasOpen) {
        detailHost.classList.add('is-switching')
        clearTimeout(switchTimer)
        switchTimer = setTimeout(() => detailHost.classList.remove('is-switching'), 130)
      }
      detailHost.replaceChildren(content)
      detailHost.scrollTop = 0
      detailHost.classList.add('is-open')
      detailBackdrop.classList.add('is-open')
      detailHost.setAttribute('aria-hidden', 'false')
      document.body.style.overflow = 'hidden'
      ;(detailHost.querySelector('.rdr-detail-close') || detailHost).focus()
    }
    /* 抽屉键盘监听挂在 document 上：视图被换掉（root 脱离文档）后第一时间摘掉，不留泄漏。 */
    const onDrawerKey = (event) => {
      if (!root.isConnected) {
        if (seenConnected) {
          document.removeEventListener('keydown', onDrawerKey)
          if (openKey != null) document.body.style.overflow = ''
        }
        return
      }
      seenConnected = true
      if (event.key === 'Escape' && openKey != null) {
        event.preventDefault()
        closeDrawer()
      }
    }
    document.addEventListener('keydown', onDrawerKey)
    detailBackdrop.addEventListener('click', closeDrawer)

    const openAtom = (id, trigger = null) => {
      const atom = atomById.get(String(id))
      if (!atom) {
        showDrawer(`missing:${id}`, '原子详情', h('p', { class: 'rdr-note' }, `找不到该原子的数据（id: ${String(id)}）。`), trigger)
        return
      }
      const node = nodeById.get(atom.id)
      showDrawer(`atom:${atom.id}`, `原子详情 · ${atom.title}`, renderReaderAtomDetail({
        atom,
        relations: relationsOf(atom.id),
        corrections: correctionsOf(node),
        engineStrength: engineStrengthOf(node),
        onOpenAtom: openAtom,
        onClose: closeDrawer,
      }), trigger)
    }

    const searchInput = h('input', {
      class: 'txt rdr-search', type: 'search', placeholder: '搜索原子标题',
      'aria-label': '搜索读者页原子',
    })
    const searchStatus = h('span', { class: 'rdr-search-status', role: 'status', 'aria-live': 'polite' })
    const applySearch = () => {
      const query = searchInput.value.trim().toLowerCase()
      const rows = [...article.querySelectorAll('.rdr-atom-row[data-atom-id]')]
      let visible = 0
      for (const row of rows) {
        const title = row.querySelector('.rdr-atom-title')?.textContent || ''
        const match = !query || title.toLowerCase().includes(query)
        row.hidden = !match
        if (match) visible += 1
      }
      searchStatus.textContent = query ? (visible ? `${visible} 个匹配` : '无匹配原子') : ''
      if (query && visible === 1) {
        const only = rows.find((row) => !row.hidden)
        only?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
    searchInput.addEventListener('input', applySearch)

    article.replaceChildren(...[
      renderReaderBrief({ theme, board }),
      h('div', { class: 'rdr-tools', role: 'group', 'aria-label': '读者工具' },
        renderTimeline((seq) => { void showAt(seq) }),
        h('div', { class: 'rdr-search-wrap' }, searchInput, searchStatus)),
      renderReaderBoard({ board, onOpenAtom: openAtom }),
      renderReaderFeed({ board, onOpenAtom: openAtom }),
      renderReaderWatch({ board, onOpenAtom: openAtom }),
      detailBackdrop,
      detailHost,
    ].filter(Boolean))
    if (root.isConnected) seenConnected = true
  }

  const showAt = async (sequence) => {
    if (rendering) return
    rendering = true
    try {
      if (sequence == null) {
        selectedSeq = null
        render(liveProjection || {}, ledgerEvents)
        return
      }
      if (!Number.isSafeInteger(sequence) || !ledgerEvents.some((event) => event.seq === sequence)) {
        throw new Error(`第 ${sequence} 条事件不存在。`)
      }
      if (typeof opts.loadProjectionAt !== 'function') throw new Error('当前环境不支持按账本序号读取历史投影。')
      const historical = await opts.loadProjectionAt(sequence)
      if (!historical) throw new Error('历史投影读取失败，不能显示该时间点。')
      if (historical.integrity && historical.integrity.ok === false) throw new Error('历史投影校验失败，不能显示该时间点。')
      selectedSeq = sequence
      render(historical, ledgerEvents.filter((event) => (Number(event.seq) || 0) <= sequence))
    } catch (error) {
      article.replaceChildren(h('p', { class: 'rdr-note', role: 'alert' }, `读者视图加载失败：${error?.message || error}`))
    } finally {
      rendering = false
    }
  }

  const loadProjection = typeof opts.loadProjection === 'function' ? opts.loadProjection() : Promise.resolve({})
  const loadEvents = typeof opts.loadEvents === 'function' ? opts.loadEvents() : Promise.resolve([])
  Promise.all([loadProjection, loadEvents])
    .then(async ([projection, response]) => {
      liveProjection = projection || {}
      ledgerEvents = Array.isArray(response) ? response : response?.events || []
      const requestedSeq = Number.isSafeInteger(opts.initialSequence)
        && ledgerEvents.some((event) => event.seq === opts.initialSequence) ? opts.initialSequence : null
      if (Number.isSafeInteger(opts.initialSequence) && requestedSeq == null) {
        throw new Error(`第 ${opts.initialSequence} 条事件不存在。`)
      }
      if (requestedSeq != null) await showAt(requestedSeq)
      else render(liveProjection, ledgerEvents)
    })
    .catch((error) => article.replaceChildren(h('p', { class: 'rdr-note', role: 'alert' }, `读者视图加载失败：${error?.message || error}`)))
  return root
}
