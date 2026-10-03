import '../styles.css'

window.__MERIDIAN_TEST_SKIP_BOOT__ = true

const themes = [
  { id: 'synthetic-theme-a', name: '合成主题 A', tags: [] },
  { id: 'synthetic-theme-b', name: '合成主题 B', tags: [] },
  /* 没有任何条目归属的主题：用来验"当前筛选下为空"的空态。 */
  { id: 'synthetic-theme-c', name: '合成主题 C', tags: [] },
]
const nodes = [
  { id: 'synthetic-viewpoint-a', themeId: themes[0].id, title: '合成观点 A', type: 'hypothesis', kind: 'claim', confidence: 72, status: 'live' },
  { id: 'synthetic-viewpoint-b', themeId: themes[1].id, title: '合成观点 B', type: 'hypothesis', kind: 'claim', confidence: 64, status: 'live' },
  { id: 'synthetic-indicator', themeId: themes[0].id, title: '合成观测指标', type: 'observation', kind: 'claim', confidence: 60, status: 'live' },
  { id: 'synthetic-cold-node', themeId: themes[0].id, title: '合成冷库条目', type: 'hypothesis', kind: 'claim', confidence: 30, status: 'cold' },
  { id: 'synthetic-dead-node', themeId: themes[0].id, title: '合成墓碑条目', type: 'hypothesis', kind: 'claim', confidence: 10, status: 'dead', settlement: { correct: false } },
]
const fixture = {
  items: [],
  due: [],
  conflicts: [],
  calls: [],
  sourcePages: 0,
  readingPages: 0,
  captureText: '',
  autoImportId: null,
  failCaptureOnce: false,
}
const reading = {
  id: 'synthetic-reading-1', indicatorId: 'synthetic-indicator', title: '合成指标读数',
  value: 42, unit: '单位', status: 'current', basis: 'reported', tier: 'structured',
  at: '2026-09-30T10:00:00.000Z', asOf: '2026-09-30', period: { start: '2026-09-01', end: '2026-09-30' },
  source: { label: '合成来源', platform: 'synthetic-fixture', url: 'https://example.test/reading' },
  trust: { score: 0.8, crossCount: 2, flags: [] }, chainKey: 'synthetic-reading-chain', rawId: 'synthetic-raw-1',
}
const inboxItem = (id, extra = {}) => ({
  id, title: `合成收件箱 ${id}`, text: `仅供自动化使用的合成原文（${id}）。`,
  createdAt: '2026-09-30T10:00:00.000Z', extracted: false, matchScore: 0.72,
  label: { kind: '合成来源', quality: 0.8 },
  provenance: { platform: 'synthetic-fixture', sourceLabel: '合成来源', url: 'https://www.reuters.com/fixture/inbox' },
  ...extra,
})

window.meridian = {
  async themes() { return themes },
  async settings() { return {} },
  onChanged() {},
  async stats() { return { cold: 1, dead: 1, verdicts: 0, readings: 1 } },
  async nodes(themeId) { return nodes.filter((node) => node.themeId === themeId) },
  async allNodes() { return nodes },
  async latestReadings() { return { items: [reading] } },
  async due() { return fixture.due },
  async calibration() { return [{ bucket: 70, total: 2, accuracy: 0.75 }] },
  async conflicts() { return fixture.conflicts },
  async inboxIgnored() { return [] },
  async inboxLastAutoImport() { return null },
  async inboxList({ limit = 50, offset = 0 } = {}) {
    fixture.calls.push(['inboxList', { limit, offset }])
    return { items: fixture.items.slice(offset, offset + limit), total: fixture.items.length }
  },
  async inboxExtract(ids, themeId) {
    fixture.calls.push(['inboxExtract', [...ids], themeId || null])
    for (const id of ids) {
      const item = fixture.items.find((row) => row.id === id)
      if (!item) continue
      item.extracted = true
      item.extractedThemeId = themeId || themes[0].id
      item.lemmas = [{ title: '合成新命题', action: 'new', parentId: null, confidence: 74 }]
    }
    return { ok: true, extracted: ids.length, total: ids.length }
  },
  async inboxDispatch(id, themeIds) {
    fixture.calls.push(['inboxDispatch', id, [...themeIds]])
    return { ok: true, inboxId: id, themeIds: [...themeIds], stanceProposals: 1, proposalEventIds: ['synthetic-proposal'], evidenceId: null, others: [] }
  },
  async inboxSetThemes(id, themeIds) {
    fixture.calls.push(['inboxSetThemes', id, [...themeIds]])
    const item = fixture.items.find((row) => row.id === id)
    if (item) {
      item.extractedThemeIds = [...themeIds]
      item.extractedThemeId = themeIds[0]
    }
    return { ok: true, themeIds: [...themeIds] }
  },
  async inboxSetSourceUrl(id, url) {
    fixture.calls.push(['inboxSetSourceUrl', id, url])
    const item = fixture.items.find((row) => row.id === id)
    if (!item) return { ok: false, error: '收件箱条目不存在' }
    item.provenance = { ...(item.provenance || {}), url }
    return { ok: true, inboxId: id, url, provenance: { ...item.provenance } }
  },
  async themeJudgeCounts() {
    return { ok: true, counts: { [themes[0].id]: { proposal: 1, pending: 0, unmapped: 1, total: 2 }, [themes[1].id]: { proposal: 0, pending: 0, unmapped: 0, total: 0 } } }
  },
  async inboxResolve(id, decision) {
    fixture.calls.push(['inboxResolve', id, decision])
    fixture.items = fixture.items.filter((row) => row.id !== id)
    return { ok: true }
  },
  async inboxResolveMany(ids, decision) {
    fixture.calls.push(['inboxResolveMany', [...ids], decision])
    fixture.items = fixture.items.filter((row) => !ids.includes(row.id))
    return { ok: true, resolved: ids }
  },
  async inboxSetTheme(id, themeId) {
    fixture.calls.push(['inboxSetTheme', id, themeId])
    const item = fixture.items.find((row) => row.id === id)
    if (item) item.extractedThemeId = themeId
    return { ok: true }
  },
  async inboxClearUnextracted(exceptIds = []) {
    fixture.calls.push(['inboxClearUnextracted', [...exceptIds]])
    const before = fixture.items.length
    fixture.items = fixture.items.filter((row) => row.extracted !== false || exceptIds.includes(row.id))
    return { removed: before - fixture.items.length }
  },
  async inboxCapture(text) {
    fixture.calls.push(['inboxCapture', text])
    fixture.captureText = text
    if (fixture.failCaptureOnce) {
      fixture.failCaptureOnce = false
      throw new Error('合成一次性捕获失败')
    }
    fixture.autoImportId = 'synthetic-auto-import-1'
    return { ok: true, autoImported: true, intakeEventId: fixture.autoImportId, count: 1 }
  },
  async inboxUndoAutoImport(id) {
    fixture.calls.push(['inboxUndoAutoImport', id])
    fixture.autoImportId = null
    return { ok: true }
  },
  async readClipboard() { return '合成剪贴板捕获内容' },
  async openExternal(url) { fixture.calls.push(['openExternal', url]); return { ok: true } },
  async updateNode(id, patch) {
    fixture.calls.push(['updateNode', id, patch])
    fixture.due = fixture.due.filter((row) => row.id !== id)
    return { ok: true }
  },
  async settle(id, correct) { fixture.calls.push(['settle', id, correct]); return { ok: true } },
  async assignReading(readingId, nodeId) { fixture.calls.push(['assignReading', readingId, nodeId]); return { ok: true } },
  async sourcesPage({ limit = 50, cursor } = {}) {
    fixture.sourcePages++
    return { items: cursor ? [] : [{ id: 'synthetic-source-1', label: '合成来源记录', kind: 'synthetic', platform: 'fixture', trust: 0.8, pushCount: 1, url: 'https://example.test/source' }].slice(0, limit), nextCursor: null, total: 1 }
  },
  async readingsPage() { fixture.readingPages++; return { items: [reading], nextCursor: null, total: 1 } },
  async readingEvidence() { return { items: [reading], total: 1, judgments: [] } },
  async rawGet(id) { return { id, text: '合成原文内容，不对应真实来源。' } },
  async verifyReadingChain() { return { ok: true, count: 1 } },
  async agentConnection() { fixture.calls.push(['agentConnection']); return { port: 0, error: 'synthetic fixture: offline', path: '/synthetic/connection.json' } },
  async falseKill() {
    return { total: 0, missed: 0, rate: 0, allTotal: 0, byGate: {
      source: { total: 0, missed: 0, items: [] }, dedup: { total: 0, missed: 0, items: [] },
      user: { total: 0, missed: 0, items: [] }, other: { total: 0, missed: 0, items: [] },
      routeIgnored: { total: 0, missed: 0, items: [] },
    } }
  },
  async intakeSeries() { return [] },
  async filterCalibration() { return [] },
  async verdicts() { return [] },
  async falseKillByChannel() { return [] },
  async vsInstitution() { return [] },
  async llmUsage() { return [] },
  async chainArchives() { return { integrity: { ok: true, count: 0, lastValidSeq: 0 }, nodes: [], edges: [] } },
  async chainEvents() { return { events: [], integrity: { ok: true, count: 0, lastValidSeq: 0 } } },
  async chainProjection() { return { nodes: [], allNodes: [], edges: [], allEdges: [], eventCount: 0, integrity: { ok: true, count: 0, lastValidSeq: 0 } } },
  async getReading() { return null },
  async resolveConflict() { return { ok: true } },
  async restoreNode() { return { ok: true } },
  async chainRestoreNode() { return { ok: true } },
}

const { state, setView } = await import('../app.js')
const report = document.querySelector('#fixture-report')
const results = []
const check = (name, condition, detail = '') => {
  results.push({ name, pass: Boolean(condition), detail })
  report.textContent = results.map((row) => `${row.pass ? 'PASS' : 'FAIL'}: ${row.name}${row.detail ? ` — ${row.detail}` : ''}`).join('\n')
}
const waitFor = async (predicate, label, timeout = 6000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  check(`等待：${label}`, false, '超时')
  return false
}
const clickNav = async (label) => {
  const button = [...document.querySelectorAll('#nav button, #vaults button')].find((el) => el.textContent.includes(label))
  if (!button) throw new Error(`找不到导航入口：${label}`)
  button.click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  return button
}

state.themes = themes
state.themeId = themes[0].id
state.nodes = nodes.filter((node) => node.themeId === themes[0].id)
state.selectedId = null
state.loadedTheme = themes[0].id
state.view = 'today'
setView('today')
await waitFor(() => document.querySelector('.inbox-empty-state'), '今日空收件箱')
check('今日空状态可辨认，待确认数清零', document.querySelector('.inbox-empty-state')?.textContent.includes('待确认已清空')
  && document.querySelector('.today-summary')?.textContent.includes('0'))
check('今日结算、校准曲线和空态说明同时可见', document.querySelector('.today-page')?.textContent.includes('到期未结算')
  && document.querySelector('.today-page')?.textContent.includes('命题校准曲线'))
{
  const judgeLinks = [...document.querySelectorAll('.today-summary .today-summary-judge')]
  check('今日摘要只给还有待判的主题一个去建设者的入口', judgeLinks.length === 1
    && judgeLinks[0].textContent.includes(`${themes[0].name} 待判`) && judgeLinks[0].textContent.includes('2'),
  judgeLinks.map((el) => el.textContent).join('|'))
}

await clickNav('数据源')
await waitFor(() => document.querySelector('.sources-page .source-record'), '数据源记录')
check('数据源列表展示合成来源且连接说明可懒加载', document.querySelector('.sources-page')?.textContent.includes('合成来源记录'))
const connection = document.querySelector('.sources-page .reading-connection')
connection.querySelector('summary').click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'agentConnection'), '数据源连接 API')
await waitFor(() => document.querySelector('.sources-page .reading-connection')?.textContent.includes('HTTP'), '数据源连接信息')
const connectionText = document.querySelector('.reading-connection')?.textContent || ''
check('数据源连接信息读取失败时说明 HTTP/MCP 均不可用，不触发外网请求', connectionText.includes('HTTP')
  && connectionText.includes('MCP') && connectionText.includes('服务未启动'), connectionText)

await clickNav('读数')
await waitFor(() => document.querySelector('.readings-page .feed-row'), '读数列表')
const readingRow = document.querySelector('.readings-page .feed-row')
check('读数按时间呈现合成观测并标明可信来源', readingRow?.textContent.includes('合成指标读数')
  && readingRow?.textContent.includes('42'))
readingRow.click()
await waitFor(() => document.querySelector('.reading-dialog'), '读数详情对话框')
await waitFor(() => document.querySelector('.reading-dialog .reading-raw'), '读数作证行')
document.querySelector('.reading-dialog .reading-raw')?.click()
await waitFor(() => document.querySelector('.reading-dialog .raw-text'), '读数原文')
document.querySelector('.reading-dialog .reading-verify')?.click()
await waitFor(() => document.querySelector('.reading-dialog .reading-verify')?.parentElement?.textContent.includes('序列完整'), '读数存证验证结果')
check('读数详情可查看本地原文并验证序列完整性', document.querySelector('.reading-dialog .raw-text')?.textContent.includes('合成原文')
  && document.querySelector('.reading-dialog .reading-verify')?.parentElement?.textContent.includes('序列完整，1 条记录'))
document.querySelector('.reading-dialog [aria-label="关闭读数详情"]')?.click()
await waitFor(() => !document.querySelector('.reading-dialog'), '读数详情关闭')

await clickNav('审计')
const auditButtons = [...document.querySelectorAll('#vaults .audit-sub')]
check('审计主入口展开全部五个数据保护子页面', auditButtons.length === 5
  && ['冷库', '墓碑区', '误杀审计', '复盘', '待裁决冲突'].every((label) => auditButtons.some((el) => el.textContent.includes(label))))
for (const label of ['冷库', '墓碑区', '误杀审计', '复盘', '待裁决冲突']) {
  await clickNav(label)
  await waitFor(() => document.querySelector('#mid .page, #mid .audit'), `${label} 页面`)
  check(`审计路由可达：${label}`, document.querySelector('#mid')?.textContent.includes(label)
    || document.querySelector('#mid')?.textContent.includes('合成'))
}

fixture.items = [
  inboxItem('extract-synthetic-1'),
  inboxItem('unmatched-synthetic-1', { matchScore: 0 }),
  inboxItem('route-synthetic-1', {
    extracted: true, extractedThemeId: themes[0].id,
    lemmas: [{ title: '已抽取合成命题', action: 'new', parentId: null, confidence: 70 }],
  }),
  inboxItem('reading-synthetic-1', {
    kind: 'reading', readingId: 'pending-reading-synthetic-1', extracted: false,
    reading: { value: 9, unit: '件', period: { end: '2026-09-30' }, basis: 'reported', tier: 'structured', trust: { score: 0.7, crossCount: 1, flags: [] } },
  }),
]
await clickNav('今日')
await waitFor(() => document.querySelector('.inbox-item[data-id="extract-synthetic-1"]'), '待抽取信息')
check('收件箱区分待抽取、未匹配与已抽取分组', [...document.querySelectorAll('.inbox-group-label')].map((el) => el.textContent).join('|').includes('待抽取')
  && [...document.querySelectorAll('.inbox-group-label')].some((el) => el.textContent === '未匹配')
  && [...document.querySelectorAll('.inbox-group-label')].some((el) => el.textContent === '已抽取'))

/* 设计稿区分"一条都没有"与"当前筛选下没有"：后者左列给「这里没有条目」、右列给「选择一条数据查看详情」，
   而不是留一块白板 + 继续展示被筛掉那条的详情。 */
const themeChip = (text) => [...document.querySelectorAll('#inbox-section .inbox2-theme-pill')]
  .find((el) => el.textContent.includes(text))
themeChip('合成主题 C').click()
await waitFor(() => document.querySelector('#inbox-section .inbox-list .inbox-empty-state'), '筛选后为空态')
{
  const listEmpty = document.querySelector('#inbox-section .inbox-list .inbox-empty-state')?.textContent.replace(/\s+/g, ' ').trim() || ''
  const detailEmpty = document.querySelector('#inbox-section .inbox-detail .inbox-empty-state')?.textContent.replace(/\s+/g, ' ').trim() || ''
  check('筛选后为空：列表给「这里没有条目」并提示切换筛选', listEmpty.includes('这里没有条目') && listEmpty.includes('试试切换筛选或主题'), listEmpty)
  check('筛选后为空：详情不再展示被筛掉的条目，改为未选中占位', detailEmpty.includes('选择一条数据查看详情'), detailEmpty)
}
themeChip('全部主题').click()
await waitFor(() => document.querySelector('#inbox-section .inbox2-item'), '切回全部主题')

const readingInboxRow = document.querySelector('.inbox-item[data-id="reading-synthetic-1"] .inbox-body')
readingInboxRow.click()
await waitFor(() => document.querySelector('.inbox-detail .inbox-reading-value'), '待归位读数详情')
const assignButton = [...document.querySelectorAll('.inbox-detail-section button')].find((button) => button.textContent.includes('合成观测指标'))
assignButton?.click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'assignReading'), '读数归位')
check('待归位读数详情展示可信度并可显式挂到观测指标', fixture.calls.some((call) => call[0] === 'assignReading'
  && call[1] === 'pending-reading-synthetic-1' && call[2] === 'synthetic-indicator'))

const extractCheckbox = document.querySelector('.inbox-item[data-id="extract-synthetic-1"] .inbox-ck')
extractCheckbox.checked = true
extractCheckbox.dispatchEvent(new Event('change', { bubbles: true }))
document.querySelector('.inbox-extract-picked').click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'inboxExtract'), '批量抽取')
await waitFor(() => document.querySelector('.inbox-item[data-id="extract-synthetic-1"] .inbox2-item-title')?.textContent.includes('合成收件箱'), '抽取后重绘')
check('批量抽取只提交明确勾选项并把投影更新到已抽取分组', fixture.calls.some((call) => call[0] === 'inboxExtract'
  && call[1].length === 1 && call[1][0] === 'extract-synthetic-1')
  && [...document.querySelectorAll('.inbox-group-label')].some((el) => el.textContent === '已抽取'))
const dispatchCheckbox = document.querySelector('.inbox-item[data-id="extract-synthetic-1"] .inbox-ck')
dispatchCheckbox.checked = true
dispatchCheckbox.dispatchEvent(new Event('change', { bubbles: true }))
{
  const checkedRow = document.querySelector('.inbox-item[data-id="extract-synthetic-1"]')
  const otherRow = [...document.querySelectorAll('#inbox-section .inbox-item')].find((row) => row !== checkedRow && row.dataset.on !== 'true' && row.dataset.sel !== 'true')
  const style = getComputedStyle(checkedRow)
  check('勾选的行高亮：不透明、底色与未勾选行不同、带左侧强调条', checkedRow.dataset.on === 'true' && style.opacity === '1'
    && Boolean(otherRow) && style.backgroundColor !== getComputedStyle(otherRow).backgroundColor && style.boxShadow.includes('inset'),
  JSON.stringify({ on: checkedRow.dataset.on, opacity: style.opacity, bg: style.backgroundColor, other: otherRow && getComputedStyle(otherRow).backgroundColor, shadow: style.boxShadow }))
}
check('勾选有主题有原文的条目：批量栏给「交给主题（1）」，不再有批量入库',
  document.querySelector('.inbox-dispatch-picked')?.textContent === '交给主题（1）' && !document.querySelector('.inbox-import-picked'))
document.querySelector('.inbox-dispatch-picked').click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'inboxResolve' && call[1] === 'extract-synthetic-1'), '交给主题后接受条目')
{
  const dispatchAt = fixture.calls.findIndex((call) => call[0] === 'inboxDispatch' && call[1] === 'extract-synthetic-1')
  const acceptAt = fixture.calls.findIndex((call) => call[0] === 'inboxResolve' && call[1] === 'extract-synthetic-1')
  check('批量交给主题：按条目自己的主题落账，落账成功后才接受', dispatchAt >= 0 && acceptAt > dispatchAt
    && JSON.stringify(fixture.calls[dispatchAt][2]) === JSON.stringify([themes[0].id]) && fixture.calls[acceptAt][2] === 'accept')
}

const routeRow = document.querySelector('.inbox-item[data-id="route-synthetic-1"] .inbox-body')
routeRow.click()
await waitFor(() => document.querySelector('.inbox-detail .inbox2-belong-pill'), '已抽取条目主题选择')
check('详情不再给逐条要点的主题 / 原子 / 立场映射，要点只读', !document.querySelector('.inbox-detail .prop-select, .inbox-detail .stance-btn')
  && document.querySelector('.inbox-detail .prop-text')?.textContent === '已抽取合成命题')
const targetThemePill = [...document.querySelectorAll('.inbox-detail .inbox2-belong-pill')]
  .find((pill) => pill.textContent.includes(themes[1].name))
targetThemePill.click()
await waitFor(() => document.querySelector('.inbox-detail .inbox-dispatch')?.textContent === '交给 2 个主题', '加入第二个主题')
check('点主题标签把条目加入第二个主题（原主题保持为主主题）', fixture.calls.some((call) => call[0] === 'inboxSetThemes'
  && call[1] === 'route-synthetic-1' && JSON.stringify(call[2]) === JSON.stringify([themes[0].id, themes[1].id])))
{
  const kicker = document.querySelector('#inbox-section .inbox2-kicker')?.textContent.trim() || ''
  check('详情眉标的时间是相对时间，而不是原始 ISO 时间戳',
    /(刚刚|\d+ (分钟|小时|天)前|时间未记录)$/.test(kicker), kicker)
}
const sourceLink = document.querySelector('.inbox-detail .inbox-source-link')
sourceLink?.click()
check('查看来源链接调用受控外部打开桥接，不在 fixture 导航外网', fixture.calls.some((call) => call[0] === 'openExternal'
  && call[1] === 'https://www.reuters.com/fixture/inbox'))
document.querySelector('.inbox-detail .inbox-dispatch').click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'inboxResolve' && call[1] === 'route-synthetic-1'), '单条交给主题')
check('单条交给主题：按「属于主题」的顺序交出（第一个是主主题）', fixture.calls.some((call) => call[0] === 'inboxDispatch'
  && call[1] === 'route-synthetic-1' && JSON.stringify(call[2]) === JSON.stringify([themes[0].id, themes[1].id])))

const unmatchedRow = document.querySelector('.inbox-item[data-id="unmatched-synthetic-1"] .inbox-body')
unmatchedRow.click()
document.querySelector('.inbox-detail .inbox-reject').click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'inboxResolve'), '忽略收件箱条目')
check('单条忽略写入显式 reject 决定', fixture.calls.some((call) => call[0] === 'inboxResolve'
  && call[1] === 'unmatched-synthetic-1' && call[2] === 'reject'))

fixture.items = [inboxItem('nolink-synthetic-1', {
  extracted: true, extractedThemeId: themes[0].id, lemmas: [{ title: '没有链接的要点' }],
  provenance: { platform: 'synthetic-fixture', sourceLabel: '合成来源' },
})]
await import('../app.js').then(({ refresh }) => refresh())
await waitFor(() => document.querySelector('.inbox-item[data-id="nolink-synthetic-1"]'), '缺链接条目')
check('缺来源链接的条目：列表行标「缺来源链接」', document.querySelector('.inbox-item[data-id="nolink-synthetic-1"] .inbox2-badge.is-nolink')?.textContent === '缺来源链接')
document.querySelector('.inbox-item[data-id="nolink-synthetic-1"] .inbox-body').click()
await waitFor(() => document.querySelector('.inbox-detail .inbox-source.is-missing'), '缺链接详情')
check('缺来源链接：详情给补链接输入框，交给主题按钮禁用并说明原因', Boolean(document.querySelector('.inbox-detail .inbox-source-input'))
  && document.querySelector('.inbox-detail .inbox-dispatch')?.disabled === true
  && document.querySelector('.inbox-detail .inbox-action-note')?.textContent.includes('来源链接'))
{
  const sourceInput = document.querySelector('.inbox-detail .inbox-source-input')
  sourceInput.value = 'https://example.test/fake'
  document.querySelector('.inbox-detail .inbox-source-save').click()
  await waitFor(() => !document.querySelector('.inbox-detail .inbox-source-error')?.hidden, '示例域名报错')
  check('补链接：示例域名在界面上直接拒绝，不调后端', !fixture.calls.some((call) => call[0] === 'inboxSetSourceUrl')
    && document.querySelector('.inbox-detail .inbox-source-error')?.textContent.includes('示例'))
  document.querySelector('.inbox-detail .inbox-source-input').value = 'https://www.reuters.com/fixture/nolink'
  document.querySelector('.inbox-detail .inbox-source-save').click()
  await waitFor(() => document.querySelector('.inbox-detail .inbox-source-host'), '补链接后显示域名')
  check('补链接：合格的链接写入后显示域名，交给主题可用，列表行不再标缺链接',
    fixture.calls.some((call) => call[0] === 'inboxSetSourceUrl' && call[1] === 'nolink-synthetic-1' && call[2] === 'https://www.reuters.com/fixture/nolink')
    && document.querySelector('.inbox-detail .inbox-source-host')?.textContent === 'reuters.com'
    && document.querySelector('.inbox-detail .inbox-dispatch')?.disabled === false
    && !document.querySelector('.inbox-item[data-id="nolink-synthetic-1"] .inbox2-badge.is-nolink'))
  check('详情给出进主题时的建议权重（来源类型 × 硬度）', /建议权重 0\.65 = 独立媒体 0\.65 × 硬数据 1\.0（来源类型按链接域名）/.test(document.querySelector('.inbox-detail .inbox-weight-note')?.textContent || ''),
    document.querySelector('.inbox-detail .inbox-weight-note')?.textContent)
}

fixture.items = Array.from({ length: 51 }, (_, index) => inboxItem(`page-synthetic-${index + 1}`, { matchScore: 0 }))
await import('../app.js').then(({ refresh }) => refresh())
await waitFor(() => document.querySelectorAll('.inbox-item').length === 50, '收件箱首 50 条分页')
const loadMore = document.querySelector('.inbox-load-more')
loadMore?.click()
await waitFor(() => document.querySelectorAll('.inbox-item').length === 51, '加载剩余收件箱条目')
check('收件箱分页先显示 50 条，加载更多读取下一页而不丢失前页', document.querySelectorAll('.inbox-item').length === 51
  && fixture.calls.some((call) => call[0] === 'inboxList' && call[1]?.offset === 50))

fixture.items = [inboxItem('unmatched-clear-synthetic-1', { matchScore: 0 })]
await import('../app.js').then(({ refresh }) => refresh())
await waitFor(() => document.querySelector('.inbox-item[data-id="unmatched-clear-synthetic-1"]'), '未匹配条目')
const clearButton = [...document.querySelectorAll('#mid button')].find((button) => button.textContent === '清空未匹配')
clearButton?.click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'inboxClearUnextracted'), '清空未匹配')
check('清空未匹配只调用对应清理命令并保留正在抽取排除列表', fixture.calls.some((call) => call[0] === 'inboxClearUnextracted'
  && Array.isArray(call[1])))

fixture.due = [{ id: 'synthetic-due-node', title: '合成到期判断', confidence: 61, settlement: { date: '2026-09-30', resolved: null, correct: null } }]
await import('../app.js').then(({ refresh }) => refresh())
await waitFor(() => document.querySelector('#due-section button')?.textContent === '对了', '到期结算操作')
const postpone = [...document.querySelectorAll('#due-section button')].find((button) => button.textContent === '再等等')
postpone?.click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'updateNode'), '推迟结算日期')
const updateCall = fixture.calls.findLast((call) => call[0] === 'updateNode')
const actualPostponeDate = updateCall?.[2]?.settlement?.date
const expectedPostponeDate = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)
check('到期判断可推迟两周且只更新结算日期、不写结算结论', updateCall?.[1] === 'synthetic-due-node'
  && updateCall?.[2]?.settlement?.resolved === null && actualPostponeDate === expectedPostponeDate)

fixture.conflicts = Array.from({ length: 7 }, (_, index) => ({ a: 'synthetic-viewpoint-a', b: 'synthetic-viewpoint-b', note: `合成冲突 ${index + 1}` }))
await import('../app.js').then(({ refresh }) => refresh())
await waitFor(() => document.querySelector('.today-page')?.textContent.includes('合成冲突 1'), '冲突卡片')
check('今日冲突卡只展示前五项并清楚提示剩余数量', document.querySelector('.today-page')?.textContent.includes('+2 条')
  && document.querySelectorAll('.today-page .cf').length >= 5)

fixture.failCaptureOnce = true
fixture.autoImportId = null
const captureButton = [...document.querySelectorAll('#nav button')].find((button) => button.textContent.includes('捕获'))
captureButton?.click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'inboxCapture'), '剪贴板捕获')
await waitFor(() => document.querySelector('.toast')?.textContent.includes('合成一次性捕获失败'), '捕获失败反馈')
const retry = [...document.querySelectorAll('.toast button')].find((button) => button.textContent.includes('重试'))
retry?.click()
await waitFor(() => fixture.calls.filter((call) => call[0] === 'inboxCapture').length === 2, '捕获重试')
await waitFor(() => document.querySelector('.auto-import-notice'), '自动归位撤销提示')
check('剪贴板捕获失败可重试，自动归位成功后提供撤销入口', fixture.captureText === '合成剪贴板捕获内容'
  && fixture.calls.filter((call) => call[0] === 'inboxCapture').length === 2
  && Boolean(document.querySelector('.auto-import-notice button')))
document.querySelector('.auto-import-notice button')?.click()
await waitFor(() => fixture.calls.some((call) => call[0] === 'inboxUndoAutoImport'), '撤销自动归位')
check('自动归位撤销通过明确的 intake event ID 请求', fixture.calls.some((call) => call[0] === 'inboxUndoAutoImport'
  && call[1] === 'synthetic-auto-import-1'))

report.textContent = results.map((row) => `${row.pass ? 'PASS' : 'FAIL'}: ${row.name}${row.detail ? ` — ${row.detail}` : ''}`).join('\n')
document.body.dataset.fixture = results.every((row) => row.pass) ? 'pass' : 'fail'
window.__PRODUCT_SURFACE_RESULTS__ = results
if (results.some((row) => !row.pass)) throw new Error('Synthetic product-surface fixture has failing assertions.')
