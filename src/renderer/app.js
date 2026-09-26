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
  shape: localStorage.getItem('meridian.shape') === 'graph' ? 'graph' : 'tree',
  auditKind: 'cold',
  /** 正在铺骨架的主题 id。放 state 而不是闭包——addTheme 会触发 db:changed →
   *  refresh() 重画整个创建页，闭包里的变量被清零，骨架铺完就找不到该去哪个主题了。 */
  pendingScaffoldId: null,
  /** 骨架铺失败了。创建页据此把按钮解锁成「重新生成」——放在 state 里，
   *  因为 db:changed 会重画页面，闭包记不住这件事。 */
  scaffoldFailed: false,
  themeId: null,
  selectedId: null,
  open: new Set(),
  query: '',
  nodes: [],
  latestByNode: new Map(),
  pendingReadings: [],
  readingsError: false,
  themes: [],
  settings: {},
  loadedTheme: null,
}

// 「脉络」没有顶栏入口：点左侧主题就进那个主题的脉络，再放一个顶栏按钮是同一目的两个入口，
// 而且会同时亮两个选中态（顶栏的脉络 + 侧栏的主题），用户看不出自己到底在看哪。
const NAV = [
  { id: 'today', label: '今日', icon: 'settle', key: '⌘1' },
  { id: 'sources', label: '数据源', icon: 'export', key: '⌘2' },
  { id: 'readings', label: '读数', icon: 'export', key: '⌘3', count: 'readings' },
]

/** 审计五视图。台账性质，不是工作面——收在侧栏一组里，默认收起。 */
const AUDITS = [
  { id: 'cold', label: '冷库', icon: 'lattice' },
  { id: 'dead', label: '墓碑区', icon: 'trash' },
  { id: 'filtered', label: '误杀审计', icon: 'flag' },
  { id: 'review', label: '复盘', icon: 'settle' },
  { id: 'conflicts', label: '待裁决冲突', icon: 'flag' },
]

const THEME_COLORS = ['#0071e3', '#af52de', '#34c759', '#ff9500', '#ff2d55', '#00b8b8', '#ff3b30', '#5856d6']
function themeColor(id) {
  const idx = state.themes.findIndex((t) => t.id === id)
  return THEME_COLORS[idx % THEME_COLORS.length]
}

let scaffoldPoll = null
/** 轮询等骨架铺完。事件推送是主路径，这里是丢事件时的兜底——两条路都通到同一个 settle。 */
function pollScaffold(themeId) {
  clearInterval(scaffoldPoll)
  scaffoldPoll = setInterval(async () => {
    if (state.pendingScaffoldId !== themeId) { clearInterval(scaffoldPoll); return }
    let inFlight = true
    try { inFlight = (await m.themeScaffoldStatus()).includes(themeId) } catch { return }
    if (inFlight) return
    clearInterval(scaffoldPoll)
    let result = null
    try { result = await m.themeScaffoldResult(themeId) } catch { return }
    if (result) settleScaffold(themeId, result)
  }, 1200)
}

/** 骨架铺完：成功切去那个主题，失败就地解锁让人重试。 */
function settleScaffold(themeId, info) {
  if (state.pendingScaffoldId !== themeId) return
  if (info.degraded) {
    state.pendingScaffoldId = null
    state.scaffoldFailed = true
    refresh()
    toast(`骨架没生成：${scaffoldWhy(info)}。`, 'var(--red)')
    return
  }
  state.themeId = themeId
  state.pendingScaffoldId = null
  state.view = 'lattice'
  refresh()
  toast('骨架已生成')
  if (info.tagLibraryOk === false) toast(`标签库没生成：${tagLibraryWhy(info)}。归位会受影响。`, 'var(--red)')
}

/** 骨架失败的人话原因。「树没生成」和「key 没配」是两件事，用户该知道是哪件。 */
const scaffoldWhy = (info) => (!info.hasKey ? '未配置 API key'
  : { timeout: '模型响应超时', empty: '模型无返回', unparsable: '模型返回的结构无法解析' }[info.reason]
    || `调用失败（${info.reason}）`)
const tagLibraryWhy = (info) => ({ timeout: '模型响应超时', empty: '模型无返回', unparsable: '模型返回的结构无法解析' }[info.tagLibraryReason]
  || `调用失败（${info.tagLibraryReason}）`)

async function boot() {
  state.themes = await m.themes()
  state.settings = await m.settings()
  // 空账本直接落在创建页——和点侧栏 + 进来的是同一个页面、同一套交互。
  // 曾经空账本进 today，today 里再嵌一个创建器，等于同一个目的两套界面。
  state.view = state.themes.length ? 'today' : 'new-theme'
  if (state.themes.length) {
    state.themeId = state.themes[0].id
  }
  if (state.themeId) await loadNodes()
  render()
  m.onChanged(() => refresh())
  let intakeStatus = null
  let intakeTimer = null
  m.onReadingProgress?.((progress) => {
    if (!progress.total || progress.total < 2) return
    clearTimeout(intakeTimer)
    if (!intakeStatus?.isConnected) {
      intakeStatus = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' })
      document.body.append(intakeStatus)
    }
    const done = progress.processed >= progress.total
    intakeStatus.textContent = done
      ? `读数检验完成：${progress.accepted || 0} 条入账，${progress.duplicates || 0} 条已记录，${progress.rejected?.length || 0} 条未接收`
      : `正在检验读数 ${progress.processed || 0} / ${progress.total}`
    if (done) intakeTimer = setTimeout(() => intakeStatus?.remove(), 4000)
  })

  m.onThemeScaffolded(async (info) => {
    // 建主题页还在等这条通知：成了就切过去，败了就地解锁重试。
    // 必须在 refresh() 之前做——refresh 会重画页面，把创建页替换掉。
    if (state.pendingScaffoldId && info?.themeId === state.pendingScaffoldId) {
      clearInterval(scaffoldPoll)
      settleScaffold(info.themeId, info)
      return
    }
    await refresh()
    if (info?.skipped === 'complete') return
    if (info?.degraded) {
      // 分清楚是没配 key 还是配了但调用失败——后者值得用户立刻看见并重试
      toast(`骨架没生成：${scaffoldWhy(info)}。可在脉络页点「重新生成」重试。`, 'var(--red)')
    }
    else if (info?.themeId) toast('骨架已生成')
    // 标签库是归位的依据，缺了读数匹配不上指标。它的失败以前是静默的——
    // 骨架成功就报「已生成」，用户只看到标签库是 0，根本不知道去哪补。
    if (info && !info.degraded && info.tagLibraryOk === false) {
      toast(`标签库没生成：${tagLibraryWhy(info)}。归位会受影响，可再点一次「重新生成」只补标签库。`, 'var(--red)')
    }
  })
  m.onInboxPaste(captureText)
  m.onInboxPruned((info) => {
    if (info?.removed > 0) toast(`已清理 ${info.removed} 条超过 30 天未处理的待确认`)
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
  const kind = p.get('audit')
  const shape = p.get('shape')
  if (shape === 'tree' || shape === 'graph') state.shape = shape
  setView(view, kind)

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

let nodesRequest = 0
async function loadNodes() {
  const request = ++nodesRequest
  const themeId = state.themeId
  if (!themeId) { state.nodes = []; state.latestByNode = new Map(); state.pendingReadings = []; return }
  const [nodes, latest] = await Promise.all([
    m.nodes(themeId),
    m.latestReadings().catch(() => null),
  ])
  if (request !== nodesRequest || state.themeId !== themeId) return
  state.nodes = nodes
  state.readingsError = !latest
  const byNode = new Map()
  // 待归位的读数单独放——它们没有指标节点可挂，但必须让人看见，否则永远等不到归位
  const pending = []
  // 仅保留服务端已判定的最新快照，不按时间猜当前值。
  const put = (map, key, reading) => {
    if (!key) return
    const previous = map.get(key)
    map.set(key, previous ? { ...reading, status: 'conflicted' } : reading)
  }
  for (const reading of latest?.items || []) {
    if (reading.pending || !reading.indicatorId) { pending.push(reading); continue }
    put(byNode, reading.indicatorId, reading)
  }
  state.latestByNode = byNode
  state.pendingReadings = pending
  state.loadedTheme = themeId
}

export async function refresh() {
  state.themes = await m.themes()
  await loadNodes()
  render()
}

export async function deleteNodeWithUndo(id) {
  const node = state.nodes.find((item) => item.id === id)
  if (!node) return
  await m.removeNode(id)
  if (state.selectedId === id) state.selectedId = null
  await refresh()
  toast(`已删除「${node.title}」及其子树`, 'var(--text-2)', {
    label: '撤销',
    onClick: async () => {
      await m.restoreNode(id)
      state.selectedId = id
      await refresh()
    },
  })
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
  localStorage.setItem('meridian.shape', shape)
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

export function setView(v, auditKind) {
  state.view = v
  if (auditKind) state.auditKind = auditKind
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
  renderAudits()
  renderMid()
  renderInspector()
}

async function captureText(text) {
  setView('today')
  if (text?.trim()) await inboxPaste(text.trim())
  else toast('剪贴板是空的')
}

function renderNav() {
  const nav = $('#nav')
  clear(nav)
  nav.append(h('button', {
    class: 'nav-item',
    title: '捕获剪贴板内容（⌘⇧V / Ctrl+Shift+V）',
    onclick: async () => {
      try { await captureText(await m.readClipboard()) }
      catch (e) { toast('读取剪贴板失败：' + e.message, 'var(--red)') }
    },
  }, icon('plus', 15), '捕获', h('span', { style: { marginLeft: 'auto', fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '⌘⇧V')))
  for (const v of NAV) {
    nav.append(h('button', {
      class: 'nav-item',
      'aria-selected': state.view === v.id ? 'true' : 'false',
      onclick: () => setView(v.id),
    }, icon(v.icon, 15), v.label,
      // 读数是唯一需要一眼看到存量的顶级视图——侧栏计数在这里会离内容太远
      v.count ? h('em', { class: 'count', id: `vc-${v.count}` }, '') : null))
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
    wrap.append(h('div', { style: { padding: '6px 8px', fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '还没有主题'))
  }
  for (const t of state.themes) {
    const count = lemmaCount(t.id)
    const itemBtn = h('button', {
      class: 'theme-item',
      // 只有正停留在该主题的脉络页时才亮。曾经只看 themeId，
      // 于是切到读数/数据源后主题还高亮着——一个已经不在看的页面里的选中态。
      'aria-selected': state.view === 'lattice' && state.themeId === t.id ? 'true' : 'false',
      onclick: () => selectTheme(t.id),
    }, h('span', { class: 'sw', style: { background: themeColor(t.id) } }), h('span', {}, t.name), count ? h('em', { class: 'count' }, String(count)) : null)

    const menuBtn = h('button', {
      class: 'theme-menu-btn', title: '重命名 / 删除',
      onclick: () => {
        const input = h('input', {
          class: 'txt', value: t.name, style: { flex: '1', minWidth: '60px', fontSize: 'var(--t-body)', padding: '2px 6px' },
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
          h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: async () => {
            const name = input.value.trim()
            if (!name) return
            await m.renameTheme(t.id, name)
            await refresh()
          } }, '保存'),
          h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)', color: 'var(--red)' }, onclick: async () => {
            await m.removeTheme(t.id)
            // 先更新 state.themes，再选下一个——否则 state.themes 还含已删主题
            await refresh()
            if (state.themeId === t.id) selectTheme(state.themes[0]?.id || null)
            const tEl = document.createElement('div')
            tEl.className = 'toast'
            tEl.append(document.createTextNode(`已删除主题「${t.name}」`))
            const undoBtn = document.createElement('button')
            undoBtn.textContent = '撤销'
            undoBtn.className = 'toast-btn'
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
  // 开一个独立页面，不在侧栏里内联展开——侧栏那点宽度放不下描述输入，
  // 而且「有主题时点 + 」和「没主题时看到的页面」必须是同一个东西，否则同一个
  // 目的有两套交互。没主题时 boot 也落在 new-theme 上，两边完全一致。
  slot.append(h('button', { class: 'btn btn-icon', title: '新建主题', onclick: () => setView('new-theme') }, icon('plus', 13)))
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

/** 侧栏「审计」组：五个台账视图收在一处，默认收起。
 *  它们是出事才看的东西，平铺在侧栏会和主题列表抢注意力。 */
let auditOpen = false

function renderAudits() {
  const wrap = $('#vaults')
  clear(wrap)
  wrap.append(h('button', {
    class: 'vault-item audit-head',
    'aria-expanded': auditOpen ? 'true' : 'false',
    onclick: () => { auditOpen = !auditOpen; renderAudits() },
  }, icon('flag', 14), h('span', {}, '审计'),
    h('span', { class: 'audit-chev' }, '›')))

  if (!auditOpen) return
  for (const a of AUDITS) {
    const on = state.view === 'audit' && state.auditKind === a.id
    wrap.append(h('button', {
      class: 'vault-item audit-sub',
      'aria-selected': on ? 'true' : 'false',
      onclick: () => setView('audit', a.id),
    }, icon(a.icon, 13), h('span', {}, a.label), h('em', { class: 'count', id: `vc-${a.id}` }, '')))
  }
}

/** 侧栏各审计视图的计数，进入对应视图时才拉，避免启动时打满请求 */
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

/** 主题创建器：用户只描述要跟踪什么，其余由系统完成。 */
export function renderThemeCreator(opts = {}) {
  const compact = opts.compact || false
  const startFailed = !!opts.failed
  const wrap = h('div', { class: 'theme-creator' + (compact ? ' theme-creator--compact' : '') })
  const statusEl = h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', marginLeft: '6px' } })

  // 生成期间按钮锁住，只有失败才解锁。放在这里而不是各 onclick 里——
  // Enter 键和按钮是两个入口，且都只禁自己不禁对方；用户输完按回车、
  // 手指又点到按钮，就会建出两个同名主题、各跑一遍骨架。
  let submitting = false
  const submitBtn = h('button', {
    class: 'btn btn-primary', style: { height: '34px' },
    // 上一轮铺失败了就解锁让人重试，否则等用户填描述
    disabled: !startFailed,
    onclick: () => submitDesc(input.value.trim()),
  }, icon('plus', 13), startFailed ? '重新生成' : '开始跟踪')

  const lock = (label) => { submitting = true; submitBtn.disabled = true; submitBtn.textContent = label; input.disabled = true }
  const unlock = (label) => { submitting = false; submitBtn.disabled = false; submitBtn.textContent = label; input.disabled = false }

  const submitDesc = async (desc) => {
    if (!desc || submitting) return
    lock('创建中…')
    statusEl.textContent = ''
    try {
      const theme = await m.setupNewTheme(desc)
      state.pendingScaffoldId = theme.id
      input.value = ''
      // 主题已经建好，骨架在后台铺。留在本页显示进度，不切走——
      // 失败了要能就地重试，不用自己导航回来。成功后再切过去。
      lock('骨架生成中…')
      statusEl.textContent = '骨架生成中，可以先去别处看。'
      if (theme.degraded) toast('已建主题。配 API key 后可生成针对这个主题的骨架和标签库。')
      // 轮询兜底：theme:scaffolded 是推送，窗口没起来或渲染层还没订阅时就丢了。
      // 丢了的后果是用户永远卡在这一页、按钮锁死——所以结果必须可查。
      pollScaffold(theme.id)
    } catch (e) {
      statusEl.textContent = '失败：' + (e.message || '未知错误')
      unlock('重新开始')
    }
  }

  const input = h('input', {
    class: 'txt skeleton-input', placeholder: '描述你要跟踪的', id: 'skeleton-desc',
    value: startFailed ? '' : '',
    oninput: () => { if (!submitting) submitBtn.disabled = !input.value.trim() },
    onkeydown: async (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      await submitDesc(e.target.value.trim())
    },
  })

  wrap.append(h('div', { class: 'skeleton-gen' },
    input,
    submitBtn,
    statusEl,
  ))
  return wrap
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
  else if (state.view === 'new-theme') mid.append(renderNewTheme())
  else if (state.view === 'lattice') {
    if (!state.themeId) { mid.append(emptyState()); return }
    renderLattice(mid)
  } else if (state.view === 'sources') {
    renderSources(mid)
  } else if (state.view === 'readings') {
    renderReadings(mid)
  } else if (state.view === 'audit') {
    if (state.auditKind === 'filtered') renderAudit(mid)
    else if (state.auditKind === 'review') renderVault(mid, 'review')
    else renderVault(mid, state.auditKind)
  }
  else if (state.view === 'settings') renderSettings(mid)
}

/** 没有任何主题时，今日页主区就是创建页——和点侧栏 + 进来的是同一个组件。 */
function emptyState() {
  return renderNewTheme()
}

/**
 * 新建主题页。侧栏 + 与空账本都落在这里，交互完全一致。
 * 生成期间按钮锁住，只有失败才解锁——否则连点会建出多个同名主题、
 * 各跑一遍骨架（实测出现过两个「光互连」，各 34 个环节）。
 */
function renderNewTheme() {
  const page = h('div', { class: 'page' })
  const creator = renderThemeCreator({ failed: state.scaffoldFailed })
  state.scaffoldFailed = false
  page.append(h('div', { class: 'page-head' },
    h('h1', {}, '新建主题'),
    h('p', {}, '说一句话，模型搭骨架、配通道、建标签库。之后你在脉络页写下判断，账本负责记录证据。'),
  ), creator)
  return page
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
  const map = { ',': 'settings', '1': 'today', '2': 'sources', '3': 'readings' }
  if (map[e.key]) { e.preventDefault(); setView(map[e.key]) }
})

boot()
