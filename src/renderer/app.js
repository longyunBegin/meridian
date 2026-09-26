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
  /** 待铺骨架主题的描述。db:changed 会重画创建页，闭包留不住——重试要靠它。 */
  pendingScaffoldDesc: null,
  /** 分阶段进度：skeleton/tags/library → pending/active/done/fail。
   *  放 state 而不是闭包——进度事件来的时候创建页可能已经被重画过。 */
  scaffoldStages: null,
  /** 各阶段失败的原因（事件里带的 reason） */
  scaffoldStageReasons: {},
  /** 最近一次铺设的完整结果。部分失败/失败时渲染结果卡、可重试。 */
  scaffoldOutcome: null,
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
/** 标记一个主题开始铺骨架并启动轮询兜底。创建页、E3 补生成、重新生成三处共用——
 *  推送事件丢了也能靠轮询收回来，不会把按钮永远卡在「生成中」。 */
export function trackScaffold(themeId) {
  state.pendingScaffoldId = themeId
  pollScaffold(themeId)
}

/** 三个阶段的展示名 */
const STAGE_LABEL = { skeleton: '搭骨架', tags: '主题标签', library: '标签库' }
const STAGE_ORDER = ['skeleton', 'tags', 'library']
const STAGE_HINT = {
  skeleton: '模型正在搭产业链骨架…',
  tags: '正在提炼主题标签…',
  library: '正在建标签库…',
}
const STEP_SVG = {
  done: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  fail: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
}
function stepIconEl(st) {
  if (st === 'active') { const d = document.createElement('div'); d.className = 'sstep-spinner'; return d }
  if (st === 'done' || st === 'fail') { const s = document.createElement('span'); s.className = 'sstep-svg'; s.innerHTML = STEP_SVG[st]; return s }
  const d = document.createElement('div'); d.className = 'sstep-dot'; return d
}

/** 阶段失败的人话原因。事件里的 reason 和结果里的 reason 都认。 */
function stageWhy(stage, info) {
  const reason = info?.[stage === 'skeleton' ? 'skeletonReason' : stage === 'tags' ? 'themeTagsReason' : 'tagLibraryReason']
    || state.scaffoldStageReasons[stage]
  if (reason === 'no-key') return '未配置 API key'
  return { timeout: '模型响应超时', empty: '模型无返回', unparsable: '模型返回无法解析' }[reason]
    || (reason ? `调用失败（${reason}）` : '未知原因')
}

function stepSub(stage, st, info) {
  if (st === 'active') return STAGE_HINT[stage]
  if (st === 'fail') return stageWhy(stage, info)
  if (st === 'done' && stage === 'skeleton' && info?.skeletonFallback) return '通用模板（未配 key，配好后可重生成）'
  if (st === 'done' && stage === 'library' && info?.tagLibraryCount != null) return `${info.tagLibraryCount} 个标签`
  return ''
}

/** 阶段进度事件 → 更新 state + 直接刷当前视图的步骤行（不等整页重画）。 */
function updateScaffoldSteps(info) {
  if (!info || state.pendingScaffoldId !== info.themeId) return
  if (!state.scaffoldStages) state.scaffoldStages = { skeleton: 'pending', tags: 'pending', library: 'pending' }
  const st = { start: 'active', ok: 'done', fail: 'fail' }[info.state]
  if (!st || !STAGE_LABEL[info.stage]) return
  state.scaffoldStages[info.stage] = st
  if (info.state === 'fail' && info.reason) state.scaffoldStageReasons[info.stage] = info.reason
  paintScaffoldSteps()
}

/** 按 state.scaffoldStages 重绘步骤行。事件和重画都走这里。 */
function paintScaffoldSteps() {
  const stages = state.scaffoldStages
  if (!stages) return
  document.querySelectorAll('.scaffold-step[data-stage]').forEach((el) => {
    const stage = el.dataset.stage
    const st = stages[stage] || 'pending'
    el.dataset.state = st
    const ic = el.querySelector('.sstep-icon')
    if (ic) { ic.textContent = ''; ic.append(stepIconEl(st)) }
    const sub = el.querySelector('.sstep-sub')
    if (sub) sub.textContent = stepSub(stage, st, state.scaffoldOutcome)
  })
}

/** 用最终结果校准各步骤状态——进度事件丢了也以此为准。 */
function calibrateStages(info) {
  if (info?.skipped === 'complete') {
    state.scaffoldStages = { skeleton: 'done', tags: 'done', library: 'done' }
    return
  }
  const stages = state.scaffoldStages || { skeleton: 'pending', tags: 'pending', library: 'pending' }
  stages.skeleton = info.degraded ? 'fail' : 'done'
  stages.tags = info.themeTagsOk === false ? 'fail' : 'done'
  stages.library = info.tagLibraryOk === false ? 'fail' : 'done'
  state.scaffoldStages = stages
  for (const [stage, key] of [['skeleton', 'skeletonReason'], ['tags', 'themeTagsReason'], ['library', 'tagLibraryReason']]) {
    if (info[key]) state.scaffoldStageReasons[stage] = info[key]
  }
}
/** 轮询等骨架铺完。事件推送是主路径，这里是丢事件时的兜底——两条路都通到同一个 settle。 */
function pollScaffold(themeId) {
  clearInterval(scaffoldPoll)
  let ticks = 0
  scaffoldPoll = setInterval(async () => {
    if (state.pendingScaffoldId !== themeId) { clearInterval(scaffoldPoll); return }
    // 熔断：三阶段最长 90+60+60 秒。超过 5 分钟还没回来，主进程大概率已经没了——
    // 不能让用户永远卡在「生成中」，给一个可重试的失败态。
    if (++ticks > 260) {
      clearInterval(scaffoldPoll)
      if (state.pendingScaffoldId !== themeId) return
      state.pendingScaffoldId = null
      state.scaffoldFailed = true
      state.scaffoldOutcome = { themeId, degraded: true, reason: 'timeout', hasKey: true, themeTagsOk: false, themeTagsReason: 'timeout', tagLibraryOk: false, tagLibraryReason: 'timeout' }
      refresh()
      toast('骨架生成超时了，可以重新生成。', 'var(--red)')
      return
    }
    let inFlight = true
    try { inFlight = (await m.themeScaffoldStatus()).includes(themeId) } catch { return }
    if (inFlight) return
    clearInterval(scaffoldPoll)
    let result = null
    try { result = await m.themeScaffoldResult(themeId) } catch { return }
    if (result) settleScaffold(themeId, result)
  }, 1200)
}

/** 骨架铺完：全成功才切去那个主题；部分失败/失败就地给结果卡、可重试。
 *  用户中途切走了就不硬拽回来——只 toast 一声。 */
function settleScaffold(themeId, info) {
  if (state.pendingScaffoldId !== themeId) return
  state.pendingScaffoldId = null
  calibrateStages(info)
  const themeName = state.themes.find((t) => t.id === themeId)?.name || ''
  const partial = !info.degraded && (info.themeTagsOk === false || info.tagLibraryOk === false)
  if (!info.degraded && !partial) {
    state.scaffoldOutcome = null
    state.scaffoldStages = null
    state.scaffoldStageReasons = {}
    if (state.view === 'new-theme') {
      state.themeId = themeId
      state.view = 'lattice'
      refresh()
      toast(info.skeletonFallback ? '已用通用模板建好骨架，配 key 后可重生成' : '骨架已生成')
    } else {
      refresh()
      toast(`「${themeName}」骨架已生成`)
    }
    return
  }
  // 部分失败或彻底失败：留在原地给结果卡（用户还在新建页），在别处则 toast
  state.scaffoldOutcome = { themeId, ...info }
  state.scaffoldFailed = true
  refresh()
  if (state.view !== 'new-theme') {
    const bits = []
    if (info.degraded) bits.push(`骨架没生成：${scaffoldWhy(info)}`)
    if (info.themeTagsOk === false) bits.push(`主题标签没生成：${stageWhy('tags', info)}`)
    if (info.tagLibraryOk === false) bits.push(`标签库没生成：${stageWhy('library', info)}`)
    toast(`「${themeName}」${bits.join('；')}。`, 'var(--red)',
      { label: '去重试', onClick: async () => { setView('new-theme') } })
  }
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
    // 并发重复触发：主进程的 scaffolding 锁已经挡掉，这只是一次空转——
    // 不算成功：不能弹「骨架已生成」，更不能切页面。之前这里没过滤，
    // 用户连点两次「生成」，第二次会立刻收到 in-flight 并误报成功。
    if (info?.skipped === 'in-flight') return
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
  // 分阶段进度：创建页据此点亮步骤。事件丢了也不怕，settle 时按结果校准。
  m.onThemeScaffoldProgress?.((info) => updateScaffoldSteps(info))
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
      // 长名被省略号截断时，hover 用原生 tooltip 展示全名
      title: t.name,
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
/** 生成中的分步卡：三个阶段各一行，进度事件来了就地刷，不整页重画。 */
function renderScaffoldSteps() {
  const stages = state.scaffoldStages || { skeleton: 'pending', tags: 'pending', library: 'pending' }
  return h('div', { class: 'scaffold-steps' },
    STAGE_ORDER.map((stage) => {
      const st = stages[stage] || 'pending'
      return h('div', { class: 'scaffold-step', dataset: { stage, state: st } },
        h('span', { class: 'sstep-icon' }, stepIconEl(st)),
        h('div', { class: 'sstep-text' },
          h('div', { class: 'sstep-title' }, STAGE_LABEL[stage]),
          h('div', { class: 'sstep-sub' }, stepSub(stage, st, null)),
        ))
    }))
}

/** 部分失败 / 失败的结果卡：哪一步成了、哪一步没成、为什么，一目了然，可重试。 */
function renderOutcomeCard(outcome) {
  const failed = outcome.degraded
  const row = (stage, ok, sub) => h('div', { class: 'scaffold-step', dataset: { stage, state: ok ? 'done' : 'fail' } },
    h('span', { class: 'sstep-icon' }, stepIconEl(ok ? 'done' : 'fail')),
    h('div', { class: 'sstep-text' },
      h('div', { class: 'sstep-title' }, STAGE_LABEL[stage]),
      sub ? h('div', { class: 'sstep-sub' }, sub) : null))

  const card = h('div', { class: 'scaffold-steps scaffold-result' },
    h('div', { class: 'scaffold-result-title' }, failed ? '骨架没能生成' : '骨架已生成，但有一步没完成'),
    row('skeleton', !failed, failed ? stageWhy('skeleton', outcome) : (outcome.skeletonFallback ? '通用模板（未配 key）' : '')),
    row('tags', outcome.themeTagsOk !== false, outcome.themeTagsOk === false ? stageWhy('tags', outcome) : ''),
    row('library', outcome.tagLibraryOk !== false,
      outcome.tagLibraryOk === false ? stageWhy('library', outcome)
        : (outcome.tagLibraryCount != null ? `${outcome.tagLibraryCount} 个标签` : '')),
  )
  if (!outcome.hasKey) {
    card.append(h('div', { class: 'scaffold-hint' }, '未配置 API key——去设置里配好后，重新生成可走模型。'))
  }
  card.append(h('div', { class: 'scaffold-actions' },
    h('button', { class: 'btn', onclick: retryScaffold }, '重新生成'),
    failed ? null : h('button', {
      class: 'btn btn-primary',
      onclick: () => {
        state.themeId = outcome.themeId
        state.view = 'lattice'
        state.scaffoldOutcome = null
        state.scaffoldStages = null
        refresh()
      },
    }, '进入主题 →'),
  ))
  return card
}

/** 结果卡上的「重新生成」：幂等补齐——scaffoldTheme 会跳过已有的部分，只补没成的。 */
async function retryScaffold() {
  const outcome = state.scaffoldOutcome
  const desc = state.pendingScaffoldDesc
  if (!outcome?.themeId || !desc) return
  const themeId = outcome.themeId
  state.scaffoldOutcome = null
  state.scaffoldFailed = false
  state.scaffoldStages = { skeleton: 'pending', tags: 'pending', library: 'pending' }
  state.scaffoldStageReasons = {}
  trackScaffold(themeId)
  refresh()
  try {
    await m.scaffoldExisting(themeId, desc)
  } catch (e) {
    // 轮询兜底会收回来；真收不回来也有 5 分钟熔断
  }
}

export function renderThemeCreator(opts = {}) {
  const compact = opts.compact || false
  const startFailed = !!opts.failed || !!state.scaffoldFailed
  const wrap = h('div', { class: 'theme-creator' + (compact ? ' theme-creator--compact' : '') })
  const statusEl = h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', marginLeft: '6px' } })

  // 生成期间按钮锁住，只有失败才解锁。放在这里而不是各 onclick 里——
  // Enter 键和按钮是两个入口，且都只禁自己不禁对方；用户输完按回车、
  // 手指又点到按钮，就会建出两个同名主题、各跑一遍骨架。
  const inFlight = !!state.pendingScaffoldId
  let submitting = inFlight
  const submitBtn = h('button', {
    class: 'btn btn-primary', style: { height: '34px' },
    // 上一轮铺失败了就解锁让人填新的，否则等用户填描述
    disabled: inFlight || !startFailed,
    onclick: () => submitDesc(input.value.trim()),
  }, icon('plus', 13), inFlight ? '骨架生成中…' : '开始跟踪')

  const lock = (label) => { submitting = true; submitBtn.disabled = true; submitBtn.textContent = label; input.disabled = true }
  const unlock = (label) => { submitting = false; submitBtn.disabled = false; submitBtn.textContent = label; input.disabled = false }

  const submitDesc = async (desc) => {
    if (!desc || submitting) return
    lock('创建中…')
    statusEl.textContent = ''
    state.scaffoldOutcome = null
    try {
      const theme = await m.setupNewTheme(desc)
      state.pendingScaffoldDesc = desc
      state.scaffoldFailed = false
      // setupNew 返回时主进程已经同步起跑（start 事件甚至可能比这个 await 先到，
      // 那时 pendingScaffoldId 还没设、事件会被丢弃）——所以这里直接标 active，
      // 不靠事件点亮前两步。library 的 start 事件晚到，由事件驱动。
      state.scaffoldStages = { skeleton: 'active', tags: 'active', library: 'pending' }
      state.scaffoldStageReasons = {}
      if (theme.degraded) toast('已建主题。配 API key 后可生成针对这个主题的骨架和标签库。')
      // 轮询兜底：theme:scaffolded 是推送，窗口没起来或渲染层还没订阅时就丢了。
      // 丢了的后果是用户永远卡在这一页、按钮锁死——所以结果必须可查。
      trackScaffold(theme.id)
      // 整页重建而不是往 wrap 里 append：addTheme 不发 db:changed，侧栏要靠这次
      // refresh 才出现新主题；而且 db:changed 随时会重画，闭包里的 wrap 可能已脱离文档。
      // 重建后的创建器看到 inFlight，自己会锁住按钮输入框并挂上步骤卡。
      await refresh()
    } catch (e) {
      statusEl.textContent = '失败：' + (e.message || '未知错误')
      unlock('重新开始')
    }
  }

  const input = h('input', {
    class: 'txt skeleton-input', placeholder: '描述你要跟踪的', id: 'skeleton-desc',
    disabled: inFlight,
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
  // 用户切走又回来：进行中恢复步骤卡，已结束恢复结果卡——状态都在 state 里，不靠闭包
  if (inFlight) wrap.append(renderScaffoldSteps())
  else if (state.scaffoldOutcome) wrap.append(renderOutcomeCard(state.scaffoldOutcome))
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
    h('p', {}, '说一句话，模型搭骨架、提炼标签、建标签库。之后你在脉络页写下判断，账本负责记录证据。'),
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
