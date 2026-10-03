/**
 * 去领域化 · L2 词表 fixture。
 *
 * 守住两条最容易悄悄退化的验收：
 *  1. 手动新增原子时，「类型」下拉不是写死的领域词，而是 theme.config.atomCategories
 *     （空词表只给「未分类」并指向主题设置）。
 *  2. 主题设置里的「分类管理」增删都按契约发出 theme:update（带完整词表，而非只发增量）。
 *
 * 注意：relationLabels 目前只做存档（渲染层选择器仍用固定措辞，因为没有统一词表源时
 * 会出现"选器说导致、图例说支持"的不一致），所以这里断言的是现状而非接入效果。
 *
 * 只渲染 UI，不跑流水线、不写账本；命令桩只够把主题页与建设者挂起来。
 */
import '../styles.css'
import '../demo-theme.css'
import '../demo-components.css'

window.__MERIDIAN_TEST_SKIP_BOOT__ = true

const report = document.querySelector('#fixture-report')
const results = []
const check = (name, condition, detail = '') => {
  results.push({ name, pass: Boolean(condition), detail })
}
const waitFor = async (predicate, label, timeout = 5000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  check(`等待：${label}`, false, '超时')
  return false
}

const makeTheme = (id, name, config) => ({ id, name, tags: [], config })
/* 有词表：分类与关系词表都由主题定义；空词表：两条都应回落到默认。 */
const vocabTheme = makeTheme('synthetic-vocab-theme', '隔离词表主题', {
  atomCategories: ['技术路线', '关键问题'],
  relationLabels: ['导致', '依赖'],
})
const plainTheme = makeTheme('synthetic-plain-theme', '隔离空词表主题', { atomCategories: [], relationLabels: [] })
const emptyProjection = {
  nodes: [], allNodes: [], edges: [], allEdges: [], eventCount: 0,
  integrity: { ok: true, count: 0, lastValidSeq: 0, verified: true },
}

const stub = {
  async themes() { return [vocabTheme, plainTheme] },
  async nodes() { return [] },
  async allNodes() { return [] },
  async latestReadings() { return { items: [] } },
  async chainProjection() { return emptyProjection },
  async chainEvents() { return { events: [] } },
  async inboxList() { return [] },
  async settings() { return {} },
  async chainVerify() { return { ok: true, lastValidSeq: 0, count: 0 } },
  /* 词表保存：把 patch 落到主题对象上，模拟真实后端持久化，
     这样"保存 → 重新渲染 → 再删"的往返才测得到（否则删的是渲染时那份旧词表）。 */
  async themeUpdate(id, patch) {
    const theme = [vocabTheme, plainTheme].find((candidate) => candidate.id === id)
    if (theme && patch?.config) theme.config = patch.config
    return { ok: true }
  },
}
/* 未显式列出的命令一律返回 { ok: true }：这个 fixture 不验证写入路径。 */
window.meridian = new Proxy(stub, {
  get: (target, key) => (key in target ? target[key] : async () => ({ ok: true })),
})

try {
  const { state } = await import('../app.js')
  const { renderTheme } = await import('../views/theme.js')
  const host = document.querySelector('#fixture-root')

  /** 把主题挂成建设者视图，返回挂载点（供后续在同一个挂载里继续操作）。 */
  const mountBuilder = async (theme) => {
    state.themes = [vocabTheme, plainTheme]
    state.themeId = theme.id
    localStorage.setItem(`meridian:theme-view:${theme.id}`, 'builder')
    host.replaceChildren()
    const mount = document.createElement('section')
    renderTheme(mount)
    host.append(mount)
    mount.querySelector('.theme-view-tab:nth-child(2)').click()
    await waitFor(() => mount.querySelector('.builder-queue-add'), `建设者挂载（${theme.name}）`)
    return mount
  }

  /** 打开「＋ 手动新增一个原子」，读表单里的控件。 */
  const openAtomForm = async (theme) => {
    const mount = await mountBuilder(theme)
    mount.querySelector('.builder-queue-add').click()
    await waitFor(() => mount.querySelector('.atom-form-card'), `新增原子表单（${theme.name}）`)
    const card = mount.querySelector('.atom-form-card')
    return {
      pills: [...(card?.querySelectorAll('.atom-form-pill') || [])].map((el) => el.textContent.trim()),
      selected: card?.querySelector('.atom-form-pill.is-selected')?.textContent.trim() || null,
      typeHint: [...(card?.querySelectorAll('.atom-form-labelrow') || [])]
        .find((row) => row.textContent.includes('类型'))?.textContent.replace(/\s+/g, ' ').trim() || null,
      relOptions: [...(card?.querySelectorAll('.atom-form-rel option') || [])].map((el) => el.textContent.trim()),
      colors: card?.querySelectorAll('.atom-form-dot').length || 0,
    }
  }

  const populated = await openAtomForm(vocabTheme)
  check('有词表时分类下拉来自 theme.config.atomCategories',
    JSON.stringify(populated.pills) === JSON.stringify(['技术路线', '关键问题']), JSON.stringify(populated.pills))
  check('默认选中第一个分类', populated.selected === '技术路线', String(populated.selected))
  check('有词表时不再提示去主题设置添加分类', populated.typeHint === '类型', String(populated.typeHint))
  check('关系下拉目前用固定措辞（relationLabels 只存档，未接入选择器）',
    JSON.stringify(populated.relOptions) === JSON.stringify(['支持', '反驳', '推导', '相关']), JSON.stringify(populated.relOptions))

  const empty = await openAtomForm(plainTheme)
  check('空词表只给「未分类」并指向主题设置',
    JSON.stringify(empty.pills) === JSON.stringify(['未分类'])
    && String(empty.typeHint || '').includes('可在主题设置中添加分类'),
    JSON.stringify({ pills: empty.pills, hint: empty.typeHint }))
  check('空词表时关系下拉同样是固定措辞',
    JSON.stringify(empty.relOptions) === JSON.stringify(['支持', '反驳', '推导', '相关']), JSON.stringify(empty.relOptions))
  check('颜色选择器两种词表下都在（7 色）', populated.colors === 7 && empty.colors === 7,
    `${populated.colors}/${empty.colors}`)

  // ---- 分类管理：增删都要按契约发出 theme:update（整表覆写，不是增量） ----
  const updateCalls = []
  const persistUpdate = stub.themeUpdate
  stub.themeUpdate = async (id, patch) => {
    updateCalls.push({ id, patch })
    return persistUpdate(id, patch)
  }
  const openThemeSettings = async (theme) => {
    const mount = await mountBuilder(theme)
    const opsToggle = [...mount.querySelectorAll('.sect-h')].find((el) => el.textContent.includes('主题设置'))
    opsToggle.click()
    await waitFor(() => mount.querySelector('input[placeholder="添加一个分类"]'), '主题设置展开')
    return { mount, ops: mount.querySelector('[id^="theme-ops-"]') }
  }

  const first = await openThemeSettings(vocabTheme)
  first.ops.querySelector('input[placeholder="添加一个分类"]').value = '监管变化'
  ;[...first.ops.querySelectorAll('button')].find((button) => button.textContent.trim() === '添加').click()
  await waitFor(() => updateCalls.length >= 1, '添加分类发出 theme:update')
  const added = updateCalls.at(-1)
  check('分类管理「添加」发出 theme:update，且带整张词表（分类 + 关系词表）',
    added?.id === vocabTheme.id
    && JSON.stringify(added.patch?.config) === JSON.stringify({
      atomCategories: ['技术路线', '关键问题', '监管变化'], relationLabels: ['导致', '依赖'],
    }), JSON.stringify(added?.patch))

  /* 重新挂载：真实应用保存后会 refresh，设置页拿到的是新词表；这里模拟同一往返。 */
  const second = await openThemeSettings(vocabTheme)
  const rendered = [...second.ops.querySelectorAll('input[placeholder][value], input')]
    .map((el) => el.value).filter((value) => value && value !== '添加一个关系标签')
  second.ops.querySelector('button[aria-label^="删除"]').click()
  await waitFor(() => updateCalls.length >= 2, '删除分类发出 theme:update')
  const removed = updateCalls.at(-1)
  check('保存后的词表在下次渲染可见（含新增项）', rendered.includes('监管变化'), JSON.stringify(rendered))
  check('分类管理「删除」发出 theme:update，删掉首项且保留其余顺序',
    removed?.id === vocabTheme.id
    && JSON.stringify(removed.patch?.config?.atomCategories) === JSON.stringify(['关键问题', '监管变化'])
    && JSON.stringify(removed.patch?.config?.relationLabels) === JSON.stringify(['导致', '依赖']),
    JSON.stringify(removed?.patch))

  document.body.dataset.fixture = results.every((row) => row.pass) ? 'pass' : 'fail'
  report.textContent = `RESULT (${results.filter((row) => row.pass).length}/${results.length})\n`
    + results.map((row) => `${row.pass ? 'PASS' : 'FAIL'}: ${row.name}${row.detail ? ` — ${row.detail}` : ''}`).join('\n')
} catch (error) {
  check('fixture 执行无未捕获异常', false, error?.stack || String(error))
  document.body.dataset.fixture = 'fail'
  report.textContent = `RESULT (${results.filter((row) => row.pass).length}/${results.length})\n`
    + results.map((row) => `${row.pass ? 'PASS' : 'FAIL'}: ${row.name}${row.detail ? ` — ${row.detail}` : ''}`).join('\n')
}
