/**
 * 账本视图 · 追加式审计记录
 *
 * 1:1 迁移自 deepseek_html_20261002_2a745f.html 的视觉与交互，
 * 数据来自真实事件账本（chain-events），只读不写。
 *
 * 用法：await renderLedger(container, theme)
 */
import { h, clear } from '../lib/dom.js'

const m = window.meridian
const PAGE_SIZE = 40

/* 事件类型 → 显示标签 / 样式类 / 过滤键 */
const KIND_META = {
  'evidence.appended':   { label: '新增证据', cls: 'k-evidence',   filter: 'evidence' },
  'claim.created':       { label: '新增主张', cls: 'k-claim',      filter: 'claim' },
  'inference.created':   { label: '新增推断', cls: 'k-claim',      filter: 'claim' },
  'relation.declared':   { label: '关系声明', cls: 'k-relation',   filter: 'relation' },
  'correction.appended': { label: '更正',     cls: 'k-correction', filter: 'correction' },
  'settlement.recorded': { label: '结算',     cls: 'k-settlement', filter: 'settlement' },
  'signal.reviewed':     { label: '判决',     cls: 'k-system',     filter: null },
  'confidence.updated':  { label: '置信度',   cls: 'k-system',     filter: null },
}
const SYSTEM_META = { label: '系统', cls: 'k-system', filter: null }
const kindMeta = (type) => KIND_META[type] || SYSTEM_META

const FILTERS = [
  { key: 'all',        label: '全部' },
  { key: 'evidence',   label: '证据' },
  { key: 'claim',      label: '主张' },
  { key: 'relation',   label: '关系' },
  { key: 'correction', label: '更正' },
  { key: 'settlement', label: '结算' },
]

const esc = (s) => String(s ?? '')

/** 事件摘要：title > text > reason > 类型标签，截断 80 字符 */
function eventSummary(e) {
  const p = (e && e.payload && typeof e.payload === 'object') ? e.payload : {}
  const raw = p.title || p.text || p.reason || p.coreInfo || ''
  const text = String(raw).trim()
  if (text) return text.length > 80 ? text.slice(0, 80) + '…' : text
  return kindMeta(e?.type).label
}

function fmtTime(at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return String(at || '—').slice(0, 16)
  const p2 = (n) => String(n).padStart(2, '0')
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function fmtDate(at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '—'
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

export async function renderLedger(container, theme) {
  clear(container)
  const root = h('div', { class: 'meridian-ledger', 'aria-label': '账本 · 追加式审计记录' })
  container.append(root)

  const state = {
    events: [],       // 全部事件（seq 降序：最新在前）
    filter: 'all',
    keyword: '',
    page: 1,
    integrity: null,
    expanded: new Set(), // 已展开的事件 id
  }

  /* ---------- 骨架 ---------- */
  const totalCountEl = h('b', { id: 'ledger-total-count' }, '…')
  const rangeEl = h('span', { class: 'status-meta', id: 'ledger-range-text' }, '—')
  const statusCheckEl = h('div', { class: 'status-check' },
    h('span', { class: 'ic' }, '…'),
    h('span', { class: 'lbl' }, '加载中'))
  const statusBar = h('div', { class: 'status-bar' },
    statusCheckEl,
    h('span', { class: 'status-sep' }, '|'),
    rangeEl,
    h('span', { class: 'status-spacer' }),
    h('span', {
      class: 'status-action', id: 'ledger-recheck', role: 'button', tabindex: '0',
      onclick: () => recheck(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); recheck() } },
    }, '重新校验'))

  const searchInput = h('input', {
    type: 'text', id: 'ledger-search-input', placeholder: '搜索事件内容…',
    autocomplete: 'off',
  })
  const filtersEl = h('div', { class: 'filters', id: 'ledger-filters' })
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search' }, h('span', { class: 'icon' }, '⌕'), searchInput),
    filtersEl)

  const pageNumEl = h('b', { id: 'ledger-page-num' }, '1')
  const pageTotalEl = h('b', { id: 'ledger-page-total' }, '1')
  const pageRangeEl = h('span', { id: 'ledger-page-range' }, '—')
  const prevBtn = h('button', { class: 'pager-btn', id: 'ledger-prev-btn', onclick: () => setPage(state.page + 1) }, '← 更早')
  const nextBtn = h('button', { class: 'pager-btn', id: 'ledger-next-btn', onclick: () => setPage(state.page - 1) }, '较新 →')
  const pager = h('div', { class: 'pager' },
    h('div', { class: 'pager-info' }, '第 ', pageNumEl, ' / ', pageTotalEl, ' 页 · ', pageRangeEl),
    h('div', { class: 'pager-nav' }, prevBtn, nextBtn))

  const listEl = h('div', { class: 'ledger', id: 'ledger-list' })
  const footNoteEl = h('span', {}, '追加序列连续 · 无缺口')
  const foot = h('div', { class: 'foot' },
    h('div', { class: 'foot-item' }, h('span', { class: 'dot' }), footNoteEl),
    h('span', { class: 'foot-spacer' }),
    h('div', { class: 'foot-item' }, '排序 append_sequence ↓'),
    h('div', { class: 'foot-item' }, `每页 ${PAGE_SIZE} 条`))

  const toastEl = h('div', { class: 'toast', id: 'ledger-toast' })

  root.append(
    h('div', { class: 'titlebar' },
      h('div', { class: 'title-num' }, '01'),
      h('div', { class: 'title-text' }, '账本 · 追加式审计记录',
        h('span', { class: 'title-badge' }, '只追加')),
      h('div', { class: 'title-actions' })),
    statusBar,
    toolbar,
    pager,
    listEl,
    foot,
    toastEl,
  )

  const showToast = (msg) => {
    toastEl.textContent = msg
    toastEl.classList.add('show')
    clearTimeout(showToast._t)
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800)
  }

  /* ---------- 数据 ---------- */
  const getFiltered = () => {
    let list = state.events
    if (state.filter !== 'all') {
      list = list.filter((e) => kindMeta(e?.type).filter === state.filter)
    }
    const kw = state.keyword.trim().toLowerCase()
    if (kw) {
      list = list.filter((e) => {
        const label = kindMeta(e?.type).label || ''
        return eventSummary(e).toLowerCase().includes(kw) || label.includes(kw)
      })
    }
    return list
  }

  const renderIntegrity = () => {
    const g = state.integrity
    clear(statusCheckEl)
    if (!g) {
      statusCheckEl.append(h('span', { class: 'ic' }, '…'), h('span', { class: 'lbl' }, '未校验'))
      return
    }
    if (g.ok) {
      statusCheckEl.append(
        h('span', { class: 'ic' }, '✓'),
        h('span', { class: 'lbl' }, '校验通过 ·'),
        totalCountEl,
        h('span', { class: 'lbl' }, '条事件'))
      footNoteEl.textContent = '追加序列连续 · 无缺口'
    } else {
      const reason = g.reason || '未知原因'
      const idx = Number.isInteger(g.index) ? `（第 ${g.index + 1} 条）` : ''
      statusCheckEl.append(
        h('span', { class: 'ic', style: { background: 'rgba(255,59,48,.14)', color: 'var(--red)' } }, '✕'),
        h('span', { class: 'lbl', style: { color: 'var(--red)' } }, `校验失败：${reason}${idx}`))
      footNoteEl.textContent = `校验失败：${reason}${idx}`
    }
  }

  const renderStats = () => {
    totalCountEl.textContent = String(state.events.length)
    if (state.events.length) {
      const oldest = state.events[state.events.length - 1]
      const newest = state.events[0]
      rangeEl.textContent = `${fmtDate(oldest?.at)} — ${fmtDate(newest?.at)}`
    } else {
      rangeEl.textContent = '—'
    }
  }

  const renderFilters = () => {
    const counts = { all: state.events.length }
    for (const f of FILTERS) if (f.key !== 'all') counts[f.key] = 0
    for (const e of state.events) {
      const fk = kindMeta(e?.type).filter
      if (fk && counts[fk] !== undefined) counts[fk]++
    }
    clear(filtersEl)
    for (const f of FILTERS) {
      filtersEl.append(h('button', {
        type: 'button',
        class: 'filter' + (state.filter === f.key ? ' active' : ''),
        dataset: { filter: f.key },
        onclick: () => {
          if (state.filter === f.key) return
          state.filter = f.key
          state.page = 1
          render()
        },
      }, f.label + ' ', h('span', { class: 'cnt' }, String(counts[f.key] || 0))))
    }
  }

  const renderPager = () => {
    const list = getFiltered()
    const total = list.length
    const pageTotal = Math.max(1, Math.ceil(total / PAGE_SIZE))
    if (state.page > pageTotal) state.page = pageTotal
    if (state.page < 1) state.page = 1
    const start = (state.page - 1) * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, total)
    pageNumEl.textContent = String(state.page)
    pageTotalEl.textContent = String(pageTotal)
    pageRangeEl.textContent = total ? `${start + 1}–${end} / ${total}` : '0 / 0'
    /* 最新在前：第 1 页最新；"更早"往页码大方向，"较新"往页码小方向 */
    prevBtn.disabled = state.page >= pageTotal
    nextBtn.disabled = state.page <= 1
  }

  const eventDetail = (e) => {
    const rows = [
      ['id', e.id],
      ['seq', e.seq],
      ['type', e.type],
      ['at', e.at],
      ['actor', e.actor],
      ['prevHash', e.prevHash],
      ['hash', e.hash],
    ]
    if (e.supersedes != null) rows.push(['supersedes', e.supersedes])
    const wrap = h('div', {
      class: 'ledger-row-detail',
      style: {
        gridColumn: '1 / -1', background: 'var(--surface-2)',
        borderRadius: '8px', padding: '10px 12px', margin: '2px 0 6px',
        fontSize: '11px', lineHeight: '1.6', overflowX: 'auto',
      },
    })
    const table = h('div', {})
    for (const [k, v] of rows) {
      table.append(h('div', { style: { display: 'flex', gap: '8px' } },
        h('span', { style: { color: 'var(--text-3)', minWidth: '72px', fontFamily: 'ui-monospace,monospace' } }, k),
        h('span', { style: { fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all' } }, esc(v ?? '—'))))
    }
    table.append(h('div', { style: { color: 'var(--text-3)', marginTop: '6px' } }, 'payload'))
    table.append(h('pre', {
      style: {
        margin: '4px 0 0', padding: '8px', background: 'var(--surface)',
        borderRadius: '6px', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        fontFamily: 'ui-monospace,SFMono-Regular,monospace', maxHeight: '220px', overflowY: 'auto',
      },
    }, JSON.stringify(e.payload ?? {}, null, 2)))
    wrap.append(table)
    return wrap
  }

  const renderList = () => {
    const list = getFiltered()
    const start = (state.page - 1) * PAGE_SIZE
    const pageItems = list.slice(start, start + PAGE_SIZE)
    clear(listEl)
    if (!pageItems.length) {
      listEl.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, '◇'),
        h('div', { class: 'empty-text' },
          state.keyword ? `没有匹配「${state.keyword}」的事件` : '没有符合当前过滤条件的事件')))
      return
    }
    for (const e of pageItems) {
      const meta = kindMeta(e?.type)
      const expanded = state.expanded.has(e?.id)
      const row = h('div', {
        class: 'row', dataset: { seq: String(e?.seq ?? '') },
        onclick: () => {
          if (!e?.id) return
          if (state.expanded.has(e.id)) state.expanded.delete(e.id)
          else state.expanded.add(e.id)
          renderList()
        },
      },
        h('div', { class: 'seq' }, e?.seq ?? '—'),
        h('div', { class: 'time' }, fmtTime(e?.at)),
        h('div', { class: `kind ${meta.cls}` },
          h('span', { class: 'kdot' }),
          h('span', {}, meta.label)),
        h('div', { class: 'text' }, eventSummary(e)),
        h('div', { class: 'row-action' },
          h('button', {
            type: 'button', title: expanded ? '收起详情' : '展开详情',
            onclick: (ev) => {
              ev.stopPropagation()
              if (!e?.id) return
              if (state.expanded.has(e.id)) state.expanded.delete(e.id)
              else state.expanded.add(e.id)
              renderList()
            },
          }, expanded ? '▴' : '▾')),
        expanded ? eventDetail(e) : null)
      listEl.append(row)
    }
  }

  function render() {
    renderStats()
    renderFilters()
    renderPager()
    renderList()
    renderIntegrity()
  }

  function setPage(p) {
    const pageTotal = Math.max(1, Math.ceil(getFiltered().length / PAGE_SIZE))
    const next = Math.max(1, Math.min(pageTotal, p))
    if (next === state.page) return
    state.page = next
    listEl.scrollTop = 0
    render()
  }

  async function recheck() {
    showToast('正在重新校验…')
    try {
      const res = await m.chainVerify(theme.id)
      state.integrity = res?.integrity || null
      renderIntegrity()
      showToast(state.integrity?.ok ? `校验通过 · ${state.events.length} 条事件` : '校验失败')
    } catch (err) {
      state.integrity = { ok: false, reason: err?.message || String(err) }
      renderIntegrity()
      showToast('校验失败')
    }
  }

  /* ---------- 事件绑定 ---------- */
  let searchTimer = null
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.keyword = searchInput.value
      state.page = 1
      render()
    }, 300)
  })

  const onKey = (e) => {
    if (!root.isConnected) {
      document.removeEventListener('keydown', onKey)
      return
    }
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault()
      searchInput.focus()
    }
    if (e.key === 'Escape' && document.activeElement === searchInput) searchInput.blur()
  }
  document.addEventListener('keydown', onKey)

  /* ---------- 加载 ---------- */
  listEl.append(h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, '◌'),
    h('div', { class: 'empty-text' }, '正在加载账本事件…')))
  try {
    const [evRes, verRes] = await Promise.all([
      m.chainEvents(theme.id),
      m.chainVerify(theme.id).catch(() => null),
    ])
    const events = Array.isArray(evRes?.events) ? evRes.events : []
    /* 最新在前 */
    state.events = events.slice().sort((a, b) => (b?.seq ?? 0) - (a?.seq ?? 0))
    state.integrity = verRes?.integrity || null
  } catch (err) {
    state.events = []
    state.integrity = { ok: false, reason: err?.message || String(err) }
    showToast(`加载失败：${err?.message || err}`)
  }
  render()
  return { refresh: render }
}
