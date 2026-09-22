import { h, icon, clear, $ } from './lib/dom.js'
import { renderLattice } from './views/lattice.js'
import { renderSettle } from './views/settle.js'
import { renderAudit } from './views/audit.js'
import { renderPremise } from './views/premise.js'
import { renderVault } from './views/vault.js'
import { renderSettings } from './views/settings.js'
import { renderInspectorLattice } from './views/inspector.js'
import { refocusGraph } from './views/graph.js'

const m = window.meridian

export const state = {
  view: 'lattice',
  shape: 'tree', // tree | graph —— 脉络视图的两种形态，共用主题/选中/检视
  vaultKind: 'cold',
  themeId: null,
  selectedId: null,
  open: new Set(),
  query: '',
  nodes: [],
  themes: [],
  templates: [],
  settings: {},
  loadedTheme: null,
}

const NAV = [
  { id: 'lattice', label: '脉络', icon: 'lattice', key: '⌘1' },
  { id: 'settle', label: '结算', icon: 'settle', key: '⌘2' },
  { id: 'audit', label: '误杀审计', icon: 'flag', key: '⌘3' },
  { id: 'premise', label: '共同前提', icon: 'lattice', key: '⌘4' },
]

const VAULTS = [
  { id: 'conflicts', label: '待裁决冲突', icon: 'flag' },
  { id: 'cold', label: '冷库', icon: 'lattice' },
  { id: 'dead', label: '墓碑区', icon: 'trash' },
  { id: 'filtered', label: '已筛掉', icon: 'export' },
]

async function boot() {
  state.themes = await m.themes()
  state.templates = await m.templates()
  state.settings = await m.settings()
  if (state.themes.length) {
    state.themeId = state.themes[0].id
    state.view = 'lattice'
  } else {
    state.view = 'settings'
  }
  if (state.themeId) await loadNodes()
  render()
  m.onChanged(() => refresh())
  applyUrlParams()
}

/**
 * 开发工具（tools/shoot.mjs）用 query 参数驱动到指定视图和选中节点，
 * 以便自动截图做视觉验证。正常启动时这些参数不存在，是无副作用的。
 */
function applyUrlParams() {
  const p = new URLSearchParams(location.search)
  const view = p.get('view')
  if (!view) return
  const vault = p.get('vault')
  const shape = p.get('shape')
  if (shape === 'tree' || shape === 'graph') state.shape = shape
  setView(view, vault)

  // 复现「新建主题后侧栏不显示」：走与输入框回车相同的路径
  const newtheme = p.get('newtheme')
  if (newtheme) {
    m.addTheme(newtheme).then(async (theme) => {
      state.themeId = theme.id
      state.view = 'lattice'
      await refresh()
    })
    return
  }

  const select = p.get('select')
  if (select) {
    // 选中前先展开它的全部祖先，否则树里看不到
    let cur = state.nodes.find((n) => n.id === select)
    while (cur?.parentId) {
      state.open.add(cur.parentId)
      cur = state.nodes.find((n) => n.id === cur.parentId)
    }
    selectNode(select)
  }
}

async function loadNodes() {
  if (!state.themeId) { state.nodes = []; return }
  state.nodes = await m.nodes(state.themeId)
  state.loadedTheme = state.themeId
}

export async function refresh() {
  state.themes = await m.themes()
  await loadNodes()
  render()
}

export function selectTheme(id) {
  state.themeId = id
  state.selectedId = null
  state.open.clear()
  state.query = ''
  state.view = 'lattice'
  refresh()
}

/** 树形 ↔ 图。只换形态，主题和选中项都留着。 */
export function setShape(shape) {
  if (state.shape === shape) return
  state.shape = shape
  render()
}

export function selectNode(id) {
  state.selectedId = id
  renderInspector()
  // 图的因果聚焦跟着选中态走——选中只有一个来源，就是这里
  if (state.shape === 'graph') refocusGraph(id)
  for (const el of document.querySelectorAll('.row')) {
    el.setAttribute('aria-selected', el.dataset.id === id ? 'true' : 'false')
  }
}

export function setView(v, vaultKind) {
  state.view = v
  if (vaultKind) state.vaultKind = vaultKind
  if (v === 'lattice' && state.loadedTheme !== state.themeId) return refresh()
  render()
}

// ------------------------------------------------------------ 渲染

function render() {
  document.querySelector('.app').dataset.view = state.view
  paintVaultCounts()
  renderNav()
  renderThemes()
  renderSideFoot()
  renderVaults()
  renderMid()
  renderInspector()
}

function renderNav() {
  const nav = $('#nav')
  clear(nav)
  for (const v of NAV) {
    nav.append(h('button', {
      class: 'nav-item',
      'aria-selected': state.view === v.id ? 'true' : 'false',
      onclick: () => setView(v.id),
    }, icon(v.icon, 15), v.label))
  }
}

function lemmaCount(themeId) {
  if (state.themeId === themeId && state.nodes.length) {
    return state.nodes.filter((n) => n.kind === 'lemma' && n.status !== 'dead').length
  }
  return ''
}

function renderThemes() {
  const wrap = $('#themes')
  clear(wrap)
  if (!state.themes.length) {
    wrap.append(h('div', { style: { padding: '6px 8px', fontSize: '11px', color: 'var(--text-3)' } }, '还没有主题'))
  }
  for (const t of state.themes) {
    const count = lemmaCount(t.id)
    wrap.append(h('button', {
      class: 'theme-item',
      'aria-selected': state.themeId === t.id ? 'true' : 'false',
      onclick: () => selectTheme(t.id),
    }, h('span', {}, t.name), count ? h('em', { class: 'count' }, String(count)) : null))
  }

  const slot = $('#theme-add-slot')
  clear(slot)
  slot.append(h('button', { class: 'btn btn-icon', title: '新建主题', onclick: newThemePrompt }, icon('plus', 13)))
}

function renderSideFoot() {
  clear($('#sidefoot')).append(
    h('button', { class: 'nav-item', onclick: exportJson }, icon('export', 15), '导出 JSON'),
    h('button', { class: 'nav-item', onclick: importJson }, icon('export', 15), '导入 JSON'),
    // 设置此前只能靠 ⌘, 进，侧边栏没有任何入口——等于没有。
    // 按苹果系应用的习惯沉在底部，不和主导航抢注意力。
    h('div', { class: 'side-sep' }),
    h('button', {
      class: 'nav-item',
      'aria-selected': state.view === 'settings' ? 'true' : 'false',
      onclick: () => setView('settings'),
    }, icon('gear', 15), '设置'),
  )
}

function renderVaults() {
  const wrap = $('#vaults')
  clear(wrap)
  for (const v of VAULTS) {
    const on = state.view === 'vault' && state.vaultKind === v.id
    wrap.append(h('button', {
      class: 'vault-item',
      'aria-selected': on ? 'true' : 'false',
      onclick: () => setView('vault', v.id),
    }, icon(v.icon, 14), h('span', {}, v.label), h('em', { class: 'count', id: `vc-${v.id}` }, '')))
  }
}

/** 侧栏各库的计数，进入对应视图时才拉，避免启动时打满请求 */
async function paintVaultCounts() {
  const set = (id, n) => { const el = document.getElementById(`vc-${id}`); if (el) el.textContent = n ? String(n) : '' }
  try {
    const st = await m.stats()
    set('cold', st.cold)
    set('dead', st.dead)
    set('filtered', st.verdicts)
    const cs = await m.conflicts()
    set('conflicts', cs.length)
  } catch { /* 计数失败不该影响主流程 */ }
}

function newThemePrompt() {
  const wrap = $('#themes')
  let done = false
  const dismiss = () => { if (done) return; done = true; input.remove(); renderThemes() }
  const input = h('input', {
    class: 'txt', placeholder: '主题名称，回车创建', style: { height: '28px', margin: '4px 6px' },
    onkeydown: async (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        done = true
        const theme = await m.addTheme(input.value.trim())
        input.remove()
        state.themeId = theme.id
        state.view = 'lattice'
        await refresh()
      } else if (e.key === 'Escape') dismiss()
    },
    onblur: dismiss,
  })
  wrap.append(input)
  input.focus()
}

async function exportJson() {
  const json = await m.exportAll()
  const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: 'meridian.json' })
  document.body.append(a)
  a.click()
  a.remove()
}

function importJson() {
  h('input', {
    type: 'file', accept: '.json',
    onchange: async (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        await m.importAll(await file.text())
        state.themeId = (await m.themes())[0]?.id || null
        await refresh()
      } catch {
        alert('导入失败：不是有效的脉络数据')
      }
    },
  }).click()
}

function renderMid() {
  const mid = $('#mid')
  clear(mid)
  if (state.view === 'lattice') {
    if (!state.themeId) { mid.append(emptyState()); return }
    renderLattice(mid)
  } else if (state.view === 'settle') renderSettle(mid)
  else if (state.view === 'audit') renderAudit(mid)
  else if (state.view === 'premise') renderPremise(mid)
  else if (state.view === 'vault') renderVault(mid, state.vaultKind)
  else if (state.view === 'settings') renderSettings(mid)
}

function emptyState() {
  return h('div', { class: 'empty' },
    h('h2', {}, '从一个主题开始'),
    h('p', {}, '主题是一条你持续跟踪的脉络。骨架只给结构，判断由你自己下。'),
    h('div', { class: 'empty-actions' },
      ...state.templates.map((t) => h('button', {
        class: 'btn', style: { height: '34px', justifyContent: 'space-between', padding: '0 12px' },
        onclick: async () => {
          const theme = await m.addThemeFromTemplate(t.id)
          state.themeId = theme.id
          state.view = 'lattice'
          await refresh()
        },
      }, h('b', { style: { fontWeight: '600', color: 'var(--text)' } }, t.name),
        h('span', { style: { fontSize: '11px', color: 'var(--text-3)' } }, `${t.count} 环节`)),
      ),
      h('button', {
        class: 'btn', style: { height: '34px', justifyContent: 'flex-start', padding: '0 12px', color: 'var(--text-3)' },
        onclick: newThemePrompt,
      }, h('span', {}, '或新建空白主题…')),
    ),
  )
}

function renderInspector() {
  const aside = $('#inspect')
  clear(aside)
  if (state.view === 'lattice' && state.themeId) renderInspectorLattice(aside)
  else aside.append(h('div', { class: 'insp-empty' }, h('span', {}, '非脉络视图')))
}

// ------------------------------------------------------------ 键盘

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  const map = { ',': 'settings', '1': 'lattice', '2': 'settle', '3': 'audit', '4': 'premise' }
  if (map[e.key]) { e.preventDefault(); setView(map[e.key]) }
})

boot()
