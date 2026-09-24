import { h, icon, clear, $, toast } from './lib/dom.js'
import { renderToday, inboxPaste } from './views/today.js'
import { renderLattice } from './views/lattice.js'
import { renderAudit } from './views/audit.js'
import { renderVault, renderReadings, renderSources } from './views/vault.js'
import { renderSettings } from './views/settings.js'
import { renderInspectorLattice } from './views/inspector.js'
import { refocusGraph, pulseFrom } from './views/graph.js'

const m = window.meridian

export const state = {
  view: 'today',
  shape: 'graph', // tree | graph —— 默认图，归位比编辑频繁
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
  { id: 'today', label: '今日', icon: 'settle', key: '⌘1' },
  { id: 'lattice', label: '脉络', icon: 'lattice', key: '⌘2' },
  { id: 'vault', label: '库', icon: 'lattice', key: '⌘3' },
]

const VAULTS = [
  { id: 'cold', label: '冷库', icon: 'lattice' },
  { id: 'dead', label: '墓碑区', icon: 'trash' },
  { id: 'filtered', label: '误杀审计', icon: 'flag' },
  { id: 'review', label: '复盘', icon: 'settle' },
  { id: 'conflicts', label: '待裁决冲突', icon: 'flag' },
  { id: 'feeds', label: '数据源', icon: 'export' },
  { id: 'readings', label: '读数', icon: 'export' },
]

const THEME_COLORS = ['#0071e3', '#af52de', '#34c759', '#ff9500', '#ff2d55', '#00b8b8', '#ff3b30', '#5856d6']
function themeColor(id) {
  const idx = state.themes.findIndex((t) => t.id === id)
  return THEME_COLORS[idx % THEME_COLORS.length]
}

async function boot() {
  state.themes = await m.themes()
  state.templates = await m.templates()
  state.settings = await m.settings()
  state.view = 'today'
  if (state.themes.length) {
    state.themeId = state.themes[0].id
  }
  if (state.themeId) await loadNodes()
  render()
  m.onChanged(() => refresh())
  m.onInboxPaste((text) => {
    state.view = 'today'
    document.querySelector('.app').dataset.view = 'today'
    renderNav()
    inboxPaste(text)
  })
  m.onInboxFocus(() => {
    state.view = 'today'
    document.querySelector('.app').dataset.view = 'today'
    renderNav()
    renderMid()
    const ta = document.querySelector('#inbox-textarea')
    if (ta) ta.focus()
  })
  m.onDueNotify(() => {
    state.view = 'today'
    document.querySelector('.app').dataset.view = 'today'
    renderNav()
    renderMid()
    setTimeout(() => {
      const firstDue = document.querySelector('#due-section .q')
      if (firstDue) {
        firstDue.scrollIntoView({ behavior: 'smooth', block: 'center' })
        firstDue.classList.add('pulse')
        setTimeout(() => firstDue.classList.remove('pulse'), 2000)
      } else {
        const el = document.getElementById('due-section')
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 300)
  })
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

/**
 * 结算并脉冲：结算后切到脉络图视图，脉冲从结算节点击穿全部下游。
 * 「你这条 85% 黄了，顺着传导击穿 3 条下游」——本该是产品最壮观的时刻。
 */
export async function settleAndPulse(id, correct) {
  await m.settle(id, correct)
  state.view = 'lattice'
  state.shape = 'graph'
  state.selectedId = id
  await refresh()
  setTimeout(() => pulseFrom(id), 100)
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
  nav.append(h('button', {
    class: 'nav-item',
    title: 'Ctrl+Shift+V 粘贴到收件箱',
    onclick: () => {
      setView('today')
      const ta = document.querySelector('#inbox-textarea')
      if (ta) ta.focus()
    },
  }, icon('plus', 15), '捕获', h('span', { style: { marginLeft: 'auto', fontSize: '10px', color: 'var(--text-3)' } }, '⌘⇧V')))
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
    const itemBtn = h('button', {
      class: 'theme-item',
      'aria-selected': state.themeId === t.id ? 'true' : 'false',
      onclick: () => selectTheme(t.id),
    }, h('span', { class: 'sw', style: { background: themeColor(t.id) } }), h('span', {}, t.name), count ? h('em', { class: 'count' }, String(count)) : null)

    const menuBtn = h('button', {
      class: 'theme-menu-btn', title: '重命名 / 删除',
      onclick: () => {
        const input = h('input', {
          class: 'txt', value: t.name, style: { flex: '1', minWidth: '60px', fontSize: '12px', padding: '2px 6px' },
          onkeydown: async (e) => {
            if (e.key === 'Enter') {
              const name = input.value.trim()
              if (!name) { input.value = t.name; return }
              await m.renameTheme(t.id, name)
              await refresh()
            } else if (e.key === 'Escape') {
              row.replaceWith(itemWrap)
            }
          },
        })
        const row = h('div', { class: 'theme-edit-row' },
          input,
          h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: '11px' }, onclick: async () => {
            const name = input.value.trim()
            if (!name) return
            await m.renameTheme(t.id, name)
            await refresh()
          } }, '保存'),
          h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: '11px', color: 'var(--red)' }, onclick: async () => {
            await m.removeTheme(t.id)
            // 先更新 state.themes，再选下一个——否则 state.themes 还含已删主题
            await refresh()
            if (state.themeId === t.id) selectTheme(state.themes[0]?.id || null)
            const tEl = document.createElement('div')
            tEl.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--bg-2,#333);color:var(--text-2);padding:8px 16px;border-radius:6px;font-size:13px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.15);display:flex;align-items:center;gap:8px'
            tEl.append(document.createTextNode(`已删除主题「${t.name}」`))
            const undoBtn = document.createElement('button')
            undoBtn.textContent = '撤销'
            undoBtn.style.cssText = 'padding:2px 8px;font-size:11px;cursor:pointer'
            undoBtn.onclick = async () => {
              await m.restoreTheme(t.id)
              await refresh()
              tEl.remove()
              toast('已恢复', 'var(--text-2)')
            }
            tEl.append(undoBtn)
            document.body.append(tEl)
            setTimeout(() => tEl.remove(), 4000)
          } }, '删除'),
        )
        itemWrap.replaceWith(row)
        input.focus()
        input.select()
      },
    }, '⋯')

    const itemWrap = h('div', { class: 'theme-wrap' }, itemBtn, menuBtn)
    wrap.append(itemWrap)
  }

  const slot = $('#theme-add-slot')
  clear(slot)
  slot.append(h('button', { class: 'btn btn-icon', title: '新建主题', onclick: newThemePrompt }, icon('plus', 13)))
}

function renderSideFoot() {
  clear($('#sidefoot')).append(

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
    set('readings', st.readings)
    const cs = await m.conflicts()
    set('conflicts', cs.length)
  } catch { /* 计数失败不该影响主流程 */ }
}

/** 主题创建器：一句话描述 / 从模板 / 空白主题。侧边栏和零主题空态共用 */
export function renderThemeCreator(opts = {}) {
  const compact = opts.compact || false
  const onDone = opts.onDone || (async () => { state.view = 'today'; await refresh() })
  const wrap = h('div', { class: 'theme-creator' + (compact ? ' theme-creator--compact' : '') })

  // 一句话描述
  const descBox = h('div', { class: 'skeleton-gen' },
    h('input', {
      class: 'txt skeleton-input', placeholder: '描述你要跟踪的产业链，如「AI 产业链」',
      id: 'skeleton-desc',
      onkeydown: async (e) => {
        if (e.key === 'Enter') {
          const desc = e.target.value.trim()
          if (!desc) return
          e.target.disabled = true
          const theme = await m.setupNewTheme(desc)
          state.themeId = theme.id
          await onDone()
        }
      },
    }),
    h('button', {
      class: 'btn btn-primary', style: { height: '34px' },
      onclick: async () => {
        const input = document.getElementById('skeleton-desc')
        const desc = input?.value.trim()
        if (!desc) return
        input.disabled = true
        const theme = await m.setupNewTheme(desc)
        state.themeId = theme.id
        await onDone()
      },
    }, icon('plus', 13), '开始跟踪'),
  )

  // 模板列表 + 空白主题
  const actions = h('div', { class: 'empty-actions' },
    h('div', { style: { fontSize: '11px', color: 'var(--text-3)', margin: '4px 0 2px', width: '100%' } }, '从模板'),
    ...state.templates.map((t) => h('button', {
      class: 'btn', style: { height: '34px', justifyContent: 'space-between', padding: '0 12px' },
      onclick: async () => {
        const theme = await m.addThemeFromTemplate(t.id)
        state.themeId = theme.id
        await onDone()
      },
    }, h('b', { style: { fontWeight: '600', color: 'var(--text)' } }, t.name),
      h('span', { style: { fontSize: '11px', color: 'var(--text-3)' } }, `${t.count} 环节`)),
    ),
    h('button', {
      class: 'btn', style: { height: '34px', justifyContent: 'flex-start', padding: '0 12px', color: 'var(--text-3)' },
      onclick: async () => {
        const name = blankNameInput.value.trim()
        if (!name) { blankNameInput.focus(); return }
        const theme = await m.addTheme(name)
        state.themeId = theme.id
        state.view = 'lattice'
        await refresh()
      },
    }, h('span', {}, '或新建空白主题…')),
  )

  // 空白主题名称输入（明示：只有名称，之后可补生成骨架和标签库）
  const blankNameInput = h('input', {
    class: 'txt', placeholder: '空白主题名称（只有名称，之后可补生成骨架和标签库）',
    style: { width: '100%', margin: '4px 0' },
    onkeydown: async (e) => {
      if (e.key === 'Enter') {
        const name = e.target.value.trim()
        if (!name) return
        const theme = await m.addTheme(name)
        state.themeId = theme.id
        state.view = 'lattice'
        await refresh()
      }
    },
  })

  wrap.append(descBox, actions, blankNameInput)
  return wrap
}

function newThemePrompt() {
  const list = $('#themes')
  // 切换：再点 [+] 收起
  const existing = list.querySelector('.theme-creator')
  if (existing) { renderThemes(); return }
  list.append(renderThemeCreator({ compact: true, onDone: async () => { state.view = 'today'; await refresh() } }))
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
        toast('导入失败：不是有效的脉络数据', 'var(--red)')
      }
    },
  }).click()
}

function renderMid() {
  const mid = $('#mid')
  clear(mid)
  if (state.view === 'today') renderToday(mid)
  else if (state.view === 'lattice') {
    if (!state.themeId) { mid.append(emptyState()); return }
    renderLattice(mid)
  } else if (state.view === 'vault') {
    if (state.vaultKind === 'feeds') renderSources(mid)
    else if (state.vaultKind === 'readings') renderReadings(mid)
    else if (state.vaultKind === 'filtered') renderAudit(mid)
    else if (state.vaultKind === 'review') renderVault(mid, 'review')
    else renderVault(mid, state.vaultKind)
  }
  else if (state.view === 'settings') renderSettings(mid)
}

function emptyState() {
  return h('div', { class: 'empty' },
    h('h2', {}, '从一个主题开始'),
    h('p', {}, '说一句话，模型搭骨架，自动配通道——你直接进今日页看结果。'),
    renderThemeCreator(),
  )
}

function renderInspector() {
  const aside = $('#inspect')
  clear(aside)
  if (state.view === 'lattice' && state.themeId) renderInspectorLattice(aside)
  else aside.append(h('div', { class: 'insp-empty' }, h('span', {}, '')))
}

// ------------------------------------------------------------ 键盘

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  const map = { ',': 'settings', '1': 'today', '2': 'lattice', '3': 'vault' }
  if (map[e.key]) { e.preventDefault(); setView(map[e.key]) }
})

boot()
