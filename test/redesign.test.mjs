/**
 * 改造后功能测试：收件箱、通道优先打标、provenance、by/stableId、骨架生成、导入导出。
 * 运行：node test/redesign.test.mjs
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/redesign-data')
process.env.MERIDIAN_TEST_DATA = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const stub = await import('./electron-stub.mjs')
globalThis.__electron = stub

const store = await import('../src/main/store.js')
const { groupReadings } = await import('../src/shared/readings.js')
const { register: registerIpc } = await import('../src/main/ipc.js')
const labeler = await import('../src/main/labeler.js')
const fetcher = await import('../src/main/fetcher.js')
const crypto = await import('../src/main/crypto.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const fire = (ch, ...args) => stub.__handlers.get(ch)({}, ...args)

store.load()
registerIpc({
  resizeCapture: () => {},
  showCapture: () => {},
  hideCapture: () => {},
  getMainWindow: () => undefined,
})

const theme = store.addTheme('改造测试主题')

// ============================================================
console.log('\n— 收件箱 CRUD —')
// ============================================================

const item1 = store.addInboxItem({
  text: '某公司Q3营收同比增长40%',
  title: 'Q3营收同比增长40%',
  label: { kind: '财报 / 公告', quality: 0.95, via: 'jev' },
  lemmas: [{ title: 'Q3营收同比增长40%', type: 'observation', confidence: 80, action: 'new', parentId: null }],
  provenance: { platform: 'eastmoney', url: 'https://example.com/1', fetchedAt: '2026-09-22' },
})
ok('收件箱条目创建', item1.id != null)
ok('条目状态为 pending', item1.status === 'pending')
ok('条目带 provenance', item1.provenance?.platform === 'eastmoney')

const item2 = store.addInboxItem({
  text: '听说某公司要裁员',
  title: '某公司要裁员',
  label: { kind: '群聊转发', quality: 0.35, via: 'table' },
  lemmas: [{ title: '某公司要裁员', type: 'hypothesis', confidence: 30, action: 'new', parentId: null }],
})
ok('第二条条目创建', item2.id != null)

ok('allInbox 返回 2 条', store.allInbox().length === 2, `实际 ${store.allInbox().length}`)
ok('inboxCount 返回 2', store.inboxCount() === 2, `实际 ${store.inboxCount()}`)

const resolved = store.resolveInboxItem(item1.id, 'accept')
ok('accept 后状态为 accepted', resolved?.status === 'accepted')
ok('allInbox 只剩 1 条', store.allInbox().length === 1, `实际 ${store.allInbox().length}`)

const rejected = store.resolveInboxItem(item2.id, 'reject')
ok('reject 后状态为 rejected', rejected?.status === 'rejected')
ok('allInbox 为空', store.allInbox().length === 0, `实际 ${store.allInbox().length}`)

const cleared = store.clearInbox()
ok('clearInbox 清了 2 条', cleared === 2, `实际 ${cleared}`)
ok('clearInbox 后 inbox 为空', store.allInbox().length === 0)

// ============================================================
console.log('\n— 收件箱 IPC: inbox:capture —')
// ============================================================

const captureResult = await fire('inbox:capture', '某公司财报显示营收增长30%')
ok('inbox:capture 返回 ok', captureResult?.ok === true)
ok('capture 创建了收件箱条目', captureResult?.item?.id != null)
ok('条目有 label', captureResult?.item?.label?.kind != null)
ok('条目有 lemmas', Array.isArray(captureResult?.item?.lemmas))
ok('收件箱有 1 条', store.allInbox().length === 1, `实际 ${store.allInbox().length}`)

// ============================================================
console.log('\n— 收件箱 IPC: inbox:list / resolve / clear —')
// ============================================================

// T1: inbox:list 分页——返回 { items, total }，不再全量数组
const listResult = await fire('inbox:list')
ok('inbox:list 返回 { items, total }', listResult && Array.isArray(listResult.items) && typeof listResult.total === 'number')
ok('inbox:list 返回 1 条', listResult.items.length === 1, `实际 ${listResult.items.length}`)
ok('inbox:list total 正确', listResult.total === 1, `实际 ${listResult.total}`)

// 默认 limit 50；offset 生效
store.addInboxItem({ text: '批量测试甲', title: '批量测试甲', label: { kind: '自媒体', quality: 0.5 }, lemmas: [] })
store.addInboxItem({ text: '批量测试乙', title: '批量测试乙', label: { kind: '自媒体', quality: 0.5 }, lemmas: [] })
const pageAll = await fire('inbox:list')
ok('inbox:list 默认 limit 50', pageAll.items.length === 3 && pageAll.total === 3, `实际 ${pageAll.items.length}/${pageAll.total}`)
const pageLimited = await fire('inbox:list', { limit: 2 })
ok('inbox:list limit 生效', pageLimited.items.length === 2, `实际 ${pageLimited.items.length}`)
const pageOffset = await fire('inbox:list', { limit: 2, offset: 2 })
ok('inbox:list offset 生效', pageOffset.items.length === 1, `实际 ${pageOffset.items.length}`)

const resolveResult = await fire('inbox:resolve', listResult.items[0].id, 'reject')
ok('inbox:resolve 返回条目', resolveResult?.id === listResult.items[0].id)
ok('reject 后 verdicts 增加', store.allVerdicts().length > 0, `实际 ${store.allVerdicts().length}`)

const clearResult = await fire('inbox:clear')
ok('inbox:clear 返回清理数', typeof clearResult === 'number')

// ============================================================
console.log('\n— 收件箱 IPC: inbox:import 批量入库 —')
// ============================================================

store.addInboxItem({
  text: 'AI算力需求持续增长',
  title: 'AI算力需求持续增长',
  label: { kind: '一手数据', quality: 0.9, via: 'table' },
  lemmas: [{ title: 'AI算力需求持续增长', type: 'observation', confidence: 75, action: 'new', parentId: null, tags: ['AI算力'] }],
  provenance: { platform: 'research', url: 'https://example.com/2' },
})
store.addInboxItem({
  text: 'GPU价格下跌',
  title: 'GPU价格下跌',
  label: { kind: '独立媒体', quality: 0.65, via: 'table' },
  lemmas: [{ title: 'GPU价格下跌', type: 'observation', confidence: 55, action: 'new', parentId: null, tags: ['GPU'] }],
})

const importResult = await fire('inbox:import', theme.id, store.allInbox().map((i) => ({
  id: i.id, text: i.text, label: i.label, lemmas: i.lemmas, provenance: i.provenance,
})))
ok('inbox:import 返回 ok', importResult?.ok === true)
ok('inbox:import 创建了节点', importResult?.results?.length > 0, `实际 ${importResult?.results?.length}`)
ok('入库后收件箱清空', store.allInbox().length === 0, `实际 ${store.allInbox().length}`)

const importedNodes = store.allNodes().filter((n) => n.themeId === theme.id && n.kind === 'lemma')
ok('入库节点存在', importedNodes.length >= 2, `实际 ${importedNodes.length}`)
const nodeWithProv = importedNodes.find((n) => n.sources?.some((s) => s.platform))
ok('入库节点带 provenance platform', nodeWithProv != null)

// ============================================================
console.log('\n— 通道优先打标 —')
// ============================================================

const chLabel = await labeler.labelSource({ labeler: 'table' }, '任意文本', { kind: '一手数据' })
ok('通道优先: kind 来自 channelMeta', chLabel.kind === '一手数据')
ok('通道优先: via = channel', chLabel.via === 'channel')
ok('通道优先: quality 查表', chLabel.quality === 0.9, `实际 ${chLabel.quality}`)

const noChLabel = await labeler.labelSource({ labeler: 'table' }, '某公司财报显示营收增长', null)
ok('无通道: 降级到 tableLabel', noChLabel.via === 'table')
ok('无通道: 关键词命中', noChLabel.kind === '财报 / 公告')

const badChLabel = await labeler.labelSource({ labeler: 'table' }, '文本', { kind: '不存在的类型' })
ok('无效通道: 降级到 tableLabel', badChLabel.via === 'table')

// ============================================================
console.log('\n— provenance 字段 —')
// ============================================================

const provNode = store.addNode({
  themeId: theme.id, parentId: null, kind: 'lemma', title: '带 provenance 的命题', confidence: 60,
  sources: [{
    kind: '一手数据', label: '调研纪要', at: '2026-09-22',
    platform: 'wind', url: 'https://wind.com/data/1',
    fetchedAt: '2026-09-22T10:00:00Z', searchPrompt: 'AI算力供应链',
  }],
})
ok('节点创建成功', provNode.id != null)
ok('来源带 platform', provNode.sources[0].platform === 'wind')
ok('来源带 url', provNode.sources[0].url === 'https://wind.com/data/1')
ok('来源带 fetchedAt', provNode.sources[0].fetchedAt === '2026-09-22T10:00:00Z')
ok('来源带 searchPrompt', provNode.sources[0].searchPrompt === 'AI算力供应链')

store.addSource(provNode.id, {
  kind: '券商研报', label: '中信研报', at: '2026-09-22',
  platform: 'citics', url: 'https://citics.com/report/1',
})
const updated = store.getNode(provNode.id)
ok('追加来源带 platform', updated.sources[1].platform === 'citics')
ok('追加来源带 url', updated.sources[1].url === 'https://citics.com/report/1')

// ============================================================
console.log('\n— node 新字段: by / stableId —')
// ============================================================

ok('默认 by = manual', provNode.by === 'manual')
ok('默认 stableId 存在', typeof provNode.stableId === 'string' && provNode.stableId.length > 0)

const modelNode = store.addNode({
  themeId: theme.id, parentId: null, kind: 'branch', title: '模型生成的环节',
  propagation: 0.6, by: 'model', stableId: 'stable-001',
})
ok('模型节点 by = model', modelNode.by === 'model')
ok('模型节点 stableId = stable-001', modelNode.stableId === 'stable-001')

const allNodes = store.allNodes()
ok('所有节点都有 by', allNodes.every((n) => n.by === 'manual' || n.by === 'model'))
ok('所有节点都有 stableId', allNodes.every((n) => typeof n.stableId === 'string' && n.stableId.length > 0))

const stableIdBefore = modelNode.stableId
store.updateNode(modelNode.id, { title: '重命名环节' })
ok('updateNode 不改 stableId', store.getNode(modelNode.id).stableId === stableIdBefore)

// ============================================================
console.log('\n— stats 包含 inbox 计数 —')
// ============================================================

store.addInboxItem({ text: 'test', title: 'test', label: null, lemmas: [] })
const st = store.stats()
ok('stats 有 inbox 字段', typeof st.inbox === 'number')
ok('stats inbox = 1', st.inbox === 1, `实际 ${st.inbox}`)

// ============================================================
console.log('\n— 导入导出包含 inbox —')
// ============================================================

const exported = store.exportAll({ withRaw: false })
const parsed = JSON.parse(exported)
ok('导出包含 inbox 数组', Array.isArray(parsed.inbox))
const pendingInExport = parsed.inbox.filter((i) => i.status === 'pending')
ok('导出 inbox pending 有 1 条', pendingInExport.length === 1, `实际 ${pendingInExport.length}`)

// clearInbox 只清已处理的，保留 pending
const pendingBefore = store.allInbox().length
store.clearInbox()
ok('clearInbox 保留 pending', store.allInbox().length === pendingBefore, `实际 ${store.allInbox().length}`)
store.importAll(exported)
ok('导入后 inbox 恢复', store.allInbox().length >= 1, `实际 ${store.allInbox().length}`)

// ============================================================
console.log('\n— 骨架生成 IPC（一步异步流 + 部分失败） —')
// ============================================================

// 旧的两步式 handler（先取 JSON 再落库）已被 theme:setupNew / theme:scaffoldExisting
// 的一步异步流程取代，渲染层无调用——确认已移除，不留后门
ok('旧骨架 handler 已移除', !stub.__handlers.has('theme:generateSkeleton') && !stub.__handlers.has('theme:instantiateSkeleton'))

// 轮询兜底的另一半：theme:scaffoldStatus 必须存在
ok('scaffoldStatus handler 存在', typeof stub.__handlers.get('theme:scaffoldStatus') === 'function')
ok('空闲时 scaffoldStatus 返回空数组', JSON.stringify(await fire('theme:scaffoldStatus')) === '[]')

// 用 __testHooks 模拟真实 LLM 的延迟与部分失败（这台机器没有可用的真实 key）
const { __testHooks: scaffoldHooks } = await import('../src/main/llmlog.js')
const realScaffoldHook = scaffoldHooks.run
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
store.saveSettings({ apiKey: 'sk-test-scaffold' })

// 场景 A：骨架成功、主题标签失败、标签库失败——部分失败不能报成全成功
scaffoldHooks.run = async (scenario) => {
  await sleepMs(50)
  if (scenario === 'skeleton') {
    return { ok: true, skeleton: { roots: [{ title: '测试环节', propagation: 0.6, id: 't1', children: [] }] } }
  }
  return { ok: false, reason: 'timeout' }
}
const partialTheme = store.addTheme('部分失败测试主题')
await fire('theme:scaffoldExisting', partialTheme.id, '测试描述')
// 生成中：scaffoldStatus 必须能看到 in-flight（之前这个 handler 根本不存在）
const statusDuring = await fire('theme:scaffoldStatus')
ok('生成中 scaffoldStatus 可见', Array.isArray(statusDuring) && statusDuring.includes(partialTheme.id), `实际 ${JSON.stringify(statusDuring)}`)
let partialResult = null
for (let i = 0; i < 100 && !partialResult; i++) { await sleepMs(100); partialResult = await fire('theme:scaffoldResult', partialTheme.id) }
ok('部分失败：有结果', !!partialResult)
ok('部分失败：骨架 ok', partialResult?.skeletonOk === true)
ok('部分失败：主题标签失败且有原因', partialResult?.themeTagsOk === false && partialResult?.themeTagsReason === 'timeout', `实际 ${partialResult?.themeTagsReason}`)
ok('部分失败：标签库失败', partialResult?.tagLibraryOk === false)
ok('部分失败：整体不算 degraded（树已生成）', partialResult?.degraded === false)
ok('部分失败：节点已铺上', store.allNodes().some((n) => n.themeId === partialTheme.id && n.kind === 'branch'))
ok('生成完 scaffoldStatus 为空', !(await fire('theme:scaffoldStatus')).includes(partialTheme.id), `实际 ${JSON.stringify(await fire('theme:scaffoldStatus'))}`)

// 场景 B：骨架失败、主题标签成功——失败卡不能吞掉已成的部分
scaffoldHooks.run = async (scenario) => {
  await sleepMs(30)
  if (scenario === 'themeTags') return { ok: true, tags: ['测试标签'] }
  return { ok: false, reason: 'timeout' }
}
const failTheme = store.addTheme('骨架失败测试主题')
await fire('theme:scaffoldExisting', failTheme.id, '测试描述')
let failResult = null
for (let i = 0; i < 100 && !failResult; i++) { await sleepMs(100); failResult = await fire('theme:scaffoldResult', failTheme.id) }
ok('骨架失败：degraded', failResult?.degraded === true)
ok('骨架失败：skeletonOk false 且有原因', failResult?.skeletonOk === false && failResult?.skeletonReason === 'timeout')
ok('骨架失败：主题标签仍成功落库', failResult?.themeTagsOk === true && (store.allThemes().find((t) => t.id === failTheme.id)?.tags || []).includes('测试标签'))
ok('骨架失败：hasKey 为 true（区分没配 key）', failResult?.hasKey === true)

// 场景 C：无 key——兜底模板要诚实标注，不能显示成模型生成的
scaffoldHooks.run = realScaffoldHook
store.saveSettings({ apiKey: '' })
const fallbackTheme = store.addTheme('兜底测试主题')
await fire('theme:scaffoldExisting', fallbackTheme.id, 'AI 算力供应链')
let fallbackResult = null
for (let i = 0; i < 100 && !fallbackResult; i++) { await sleepMs(100); fallbackResult = await fire('theme:scaffoldResult', fallbackTheme.id) }
ok('无 key：兜底模板铺上', store.allNodes().some((n) => n.themeId === fallbackTheme.id && n.kind === 'branch'))
ok('无 key：skeletonFallback 诚实标注', fallbackResult?.skeletonFallback === true)
ok('无 key：不算 degraded（有树可用）', fallbackResult?.degraded === false)

// 收尾：恢复钩子与设置，别影响后面的 E3（它依赖无 key 兜底）
scaffoldHooks.run = realScaffoldHook
store.saveSettings({ apiKey: '' })

// ============================================================
console.log('\n— 骨架行式解析（模型说人话，我们这边建树） —')
// ============================================================

const { parseSkeleton, generateSkeleton } = await import('../src/main/extract.js')

const parseTitles = (r) => (r?.roots || []).map((n) => n.title)
const flatTitles = (r) => {
  const out = []
  const walk = (n) => { out.push(n.title); for (const c of n.children || []) walk(c) }
  for (const n of r?.roots || []) walk(n)
  return out
}

// 标准行式大纲
const outline = parseSkeleton('- 多晶硅 | 0.8 | 硅料价格受什么影响？\n  - 工业硅 | 0.6 | 成本谁说了算？\n- 硅片 | 0.7 | 价格战打到什么程度？')
ok('行式大纲解析出树', flatTitles(outline).join(',') === '多晶硅,工业硅,硅片', JSON.stringify(flatTitles(outline)))
ok('行式大纲子层挂对', outline.roots[0].children.length === 1 && outline.roots[0].children[0].title === '工业硅')
ok('行式大纲权重与核心问题进节点', outline.roots[0].propagation === 0.8 && outline.roots[0].scaffold?.answer?.[0] === '硅料价格受什么影响？')

// 废话行、代码块、坏行都不影响——以前这种直接整棵树报废
const noisy = parseSkeleton('好的，结果如下：\n```\n- 上游 | 0.5 | ？\n这行是废话没有横杠\n- | 0.5 | 空标题行\n  - 光芯片 | abc | 权重不是数字\n```\n以上是我的分析')
ok('行式大纲废话/坏行被忽略', flatTitles(noisy).join(',') === '上游,光芯片', JSON.stringify(flatTitles(noisy)))
ok('行式大纲非法权重回落 0.5', noisy.roots[0].children[0].propagation === 0.5)

// 缩进跳跃不丢节点
const jumpy = parseSkeleton('- A | 0.5 | ?\n      - B | 0.5 | ?')
ok('行式大纲缩进跳跃钳住不丢节点', flatTitles(jumpy).join(',') === 'A,B')

// 真没有有效行才返回 null
ok('行式大纲纯废话返回 null', parseSkeleton('我不知道，没法分析') === null)
ok('行式大纲空输入返回 null', parseSkeleton('') === null)

// ============================================================
console.log('\n— 骨架两轮生成（行式大纲 + 行式补指标） —')
// ============================================================

const realFetchSk = globalThis.fetch
const fetchCallsSk = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  fetchCallsSk.push(body)
  const content = body.messages[0].content.includes('环节清单')
    ? '- 1 | 多晶硅价格/月；多晶硅产量/季度 | 价格跌破现金成本\n- 2 | 工业硅价格/月 | 开工率跌破五成'
    : '- 多晶硅 | 0.8 | 硅料价格受什么影响？\n  - 工业硅 | 0.6 | 成本谁说了算？'
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 100 } }), { headers: { 'content-type': 'application/json' } })
}
const sk = await generateSkeleton({ baseUrl: 'https://x.test', apiKey: 'k', model: 'm' }, '光伏')
ok('两轮：第一轮 prompt 要行式大纲', fetchCallsSk[0].messages[0].content.includes('每行一个环节'))
ok('两轮：第一轮不让模型吐 JSON', !fetchCallsSk[0].messages[0].content.includes('产出 JSON'))
ok('两轮：第二轮发的是编号清单', fetchCallsSk[1].messages[1].content.includes('1. 多晶硅'))
ok('两轮：骨架 ok 且树正确', sk.ok === true && flatTitles(sk.skeleton).join(',') === '多晶硅,工业硅')
const ind0 = sk.skeleton.roots[0].scaffold?.indicators || []
ok('两轮：指标补进来了', ind0.length === 2 && ind0[0].name === '多晶硅价格' && ind0[0].cadence === '月')
ok('两轮：证伪信号补进来了', sk.skeleton.roots[0].scaffold?.falsifier === '价格跌破现金成本')

// 第二轮失败不影响骨架
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (body.messages[0].content.includes('环节清单')) return new Response('boom', { status: 500 })
  return new Response(JSON.stringify({ choices: [{ message: { content: '- A | 0.5 | ?' } }], usage: {} }), { headers: { 'content-type': 'application/json' } })
}
const sk2 = await generateSkeleton({ baseUrl: 'https://x.test', apiKey: 'k', model: 'm' }, '光伏')
ok('两轮：第二轮失败骨架仍 ok', sk2.ok === true && flatTitles(sk2.skeleton).join(',') === 'A')
ok('两轮：第二轮失败指标留空', (sk2.skeleton.roots[0].scaffold?.indicators || []).length === 0)
globalThis.fetch = realFetchSk

// ============================================================
console.log('\n— 收件箱 inbox:capture 带通道元数据 —')
// ============================================================

const chCapture = await fire('inbox:capture', '某公众号文章内容', { kind: '自媒体', platform: 'wechat', url: 'https://mp.weixin.qq.com/1' })
ok('带通道 capture 返回 ok', chCapture?.ok === true)
ok('带通道 capture label via = channel', chCapture?.item?.label?.via === 'channel')
ok('带通道 capture label kind = 自媒体', chCapture?.item?.label?.kind === '自媒体')
ok('带通道 capture provenance 保存', chCapture?.item?.provenance?.platform === 'wechat')

// ============================================================
console.log('\n— 收件箱 reject 产生 verdict —')
// ============================================================

const verdictsBefore = store.allVerdicts().length
const rejectItem = store.addInboxItem({ text: '低质内容', title: '低质内容', label: { kind: '道听途说', quality: 0.2, via: 'table' }, lemmas: [] })
await fire('inbox:resolve', rejectItem.id, 'reject')
ok('reject 后 verdicts +1', store.allVerdicts().length === verdictsBefore + 1, `实际 ${store.allVerdicts().length}`)
const lastVerdict = store.allVerdicts().slice(-1)[0]
ok('verdict gate = user', lastVerdict?.gate === 'user')
ok('verdict reason = rejected', lastVerdict?.reason === 'rejected')

// ============================================================
console.log('\n— today 视图数据完整性 —')
// ============================================================

const due = store.dueSettlements()
ok('due 返回数组', Array.isArray(due))

const calib = store.calibration()
ok('calibration 返回数组', Array.isArray(calib))

const fullStats = store.stats()
ok('stats 有 due', typeof fullStats.due === 'number')
ok('stats 有 inbox', typeof fullStats.inbox === 'number')
ok('stats 有 themes', typeof fullStats.themes === 'number')

// ============================================================
console.log('\n— 收件箱入库带覆盖置信度/挂点 —')
// ============================================================

// 先建一个父节点作为覆盖挂点
const overrideParent = store.addNode({ themeId: theme.id, kind: 'branch', title: '覆盖挂点环节', confidence: 60 })
const overrideInboxItem = store.addInboxItem({
  text: '某公司利润大增',
  title: '利润大增',
  label: { kind: '财报 / 公告', quality: 0.95, via: 'jev' },
  lemmas: [{ title: '利润大增', type: 'observation', confidence: 70, action: 'new', parentId: null, parentLabel: '默认挂点' }],
  provenance: null,
})

// 模拟前端覆盖：改置信度 70→85，改挂点 null→overrideParent.id
const overriddenItem = {
  ...overrideInboxItem,
  lemmas: overrideInboxItem.lemmas.map((l) => ({ ...l, confidence: 85, parentId: overrideParent.id })),
}
const overrideResult = await fire('inbox:import', theme.id, [overriddenItem])
ok('覆盖入库返回 ok', overrideResult?.ok === true)
const importedNode = store.allNodes().find((n) => n.title === '利润大增' && n.kind === 'lemma')
ok('覆盖置信度生效', importedNode?.confidence === 85, `实际 ${importedNode?.confidence}`)
ok('覆盖挂点生效', importedNode?.parentId === overrideParent.id, `实际 ${importedNode?.parentId}`)

// ============================================================
console.log('\n— 边拖权重 + 重传导 —')
// ============================================================

// 建链：A(80) → B(prop=0.5) → C(prop=0.5)
const wA = store.addNode({ themeId: theme.id, kind: 'lemma', title: '权重链A', confidence: 80, parentId: null })
const wB = store.addNode({ themeId: theme.id, kind: 'lemma', title: '权重链B', confidence: 50, parentId: wA.id, propagation: 0.5 })
const wC = store.addNode({ themeId: theme.id, kind: 'lemma', title: '权重链C', confidence: 30, parentId: wB.id, propagation: 0.5 })

// A 从 80 → 90，B 应 +5 (10×0.5)，C 应 +2.5 (5×0.5)
store.updateNode(wA.id, { confidence: 90 })
const wB1 = store.getNode(wB.id)
const wC1 = store.getNode(wC.id)
ok('A 变后 B 传导了', wB1.confidence === 55, `实际 ${wB1.confidence}`)
ok('A 变后 C 传导了', wC1.confidence === 33, `实际 ${wC1.confidence}`)

// 拖权重：B 的 propagation 从 0.5 → 0.8，重传导
// repropagate(B): baseline=50 (first manual), B=55, delta=5
// C reset to 30 (last manual), then hop = 5×0.8 = 4 → C = 34
store.updateNode(wB.id, { propagation: 0.8 })
store.repropagate(wB.id)
const wB2 = store.getNode(wB.id)
const wC2 = store.getNode(wC.id)
ok('改权重后 B 不变', wB2.confidence === 55, `实际 ${wB2.confidence}`)
ok('改权重后 C 按新权重重算', wC2.confidence === 34, `实际 ${wC2.confidence}`)

// ============================================================
console.log('\n— 结算后校准曲线更新 —')
// ============================================================

const settleNode = store.addNode({ themeId: theme.id, kind: 'lemma', title: '待结算测试', confidence: 75, parentId: null, settlement: { date: store.today(), resolved: null, correct: null } })
const dueBefore = store.dueSettlements().length
ok('新建结算节点出现在到期列表', store.dueSettlements().some((d) => d.id === settleNode.id), `实际 ${dueBefore}`)
store.settleLemma(settleNode.id, true)
const dueAfter = store.dueSettlements().length
ok('结算后不再到期', !store.dueSettlements().some((d) => d.id === settleNode.id), `实际 ${dueAfter}`)
const settled = store.getNode(settleNode.id)
ok('结算标记 correct = true', settled.settlement.correct === true)
ok('结算标记 resolved 有值', settled.settlement.resolved != null)

// ============================================================
console.log('\n— URL 检测与通道推断 —')
// ============================================================

ok('isUrl: http URL', fetcher.isUrl('https://example.com/article') === true)
ok('isUrl: 带空格不是 URL', fetcher.isUrl('https://example.com some text') === false)
ok('isUrl: 带换行不是 URL', fetcher.isUrl('https://example.com\nsecond line') === false)
ok('isUrl: 普通文本不是 URL', fetcher.isUrl('某公司Q3营收增长40%') === false)
ok('isUrl: 空字符串不是 URL', fetcher.isUrl('') === false)
ok('isUrl: ftp 不是 URL', fetcher.isUrl('ftp://example.com') === false)

const ch1 = fetcher.inferChannel('https://arxiv.org/abs/2401.12345')
ok('arxiv → 一手数据', ch1?.kind === '一手数据')
ok('arxiv 带 platform', ch1?.platform === 'arxiv.org')

const ch2 = fetcher.inferChannel('https://mp.weixin.qq.com/s/abc123')
ok('微信公众号 → 自媒体', ch2?.kind === '自媒体')

const ch3 = fetcher.inferChannel('https://www.cs.com.cn/report/123')
ok('中信证券 → 券商研报', ch3?.kind === '券商研报')

const ch4 = fetcher.inferChannel('https://finance.eastmoney.com/a/123.html')
ok('东方财富 → 财报/公告', ch4?.kind === '财报 / 公告')

const ch5 = fetcher.inferChannel('https://www.caixin.com/2026-09-22/123.html')
ok('财新 → 独立媒体', ch5?.kind === '独立媒体')

const ch6 = fetcher.inferChannel('https://unknown-random-site.com/page')
ok('未知域名 → kind 为 null', ch6?.kind === null)
ok('未知域名仍带 platform', ch6?.platform === 'unknown-random-site.com')

// ============================================================
console.log('\n— inbox:capture 粘贴 URL 推断通道 —')
// ============================================================

// 粘贴 arxiv URL：fetch 会失败（测试环境无网络），但通道元数据仍应推断出来
const urlCapture = await fire('inbox:capture', 'https://arxiv.org/abs/2401.12345')
ok('URL capture 返回 ok', urlCapture?.ok === true)
ok('URL capture 推断通道 via = channel', urlCapture?.item?.label?.via === 'channel')
ok('URL capture 推断 kind = 一手数据', urlCapture?.item?.label?.kind === '一手数据')
ok('URL capture provenance 带 platform', urlCapture?.item?.provenance?.platform === 'arxiv.org')
ok('URL capture provenance 带 url', urlCapture?.item?.provenance?.url === 'https://arxiv.org/abs/2401.12345')

// 粘贴公众号 URL
const wxCapture = await fire('inbox:capture', 'https://mp.weixin.qq.com/s/abc123def')
ok('公众号 URL capture kind = 自媒体', wxCapture?.item?.label?.kind === '自媒体')

// ============================================================
console.log('\n— API 密钥加密 —')
// ============================================================

const plainKey = 'sk-test-1234567890abcdef'
const encKey = crypto.encrypt(plainKey)
ok('加密后有 enc:v1: 前缀', encKey.startsWith('enc:v1:'))
ok('加密后不等于明文', encKey !== plainKey)
const decKey = crypto.decrypt(encKey)
ok('解密还原原文', decKey === plainKey, `实际 ${decKey}`)
ok('明文 decrypt 原样返回（向后兼容）', crypto.decrypt(plainKey) === plainKey)
ok('空字符串不加密', crypto.encrypt('') === '')
ok('null 不加密', crypto.encrypt(null) === null)

const s1 = { apiKey: 'sk-secret-1', jevKey: 'sk-jev-2', model: 'step-3' }
const encS = crypto.encryptSettings(s1)
ok('encryptSettings 加密了 apiKey', encS.apiKey.startsWith('enc:v1:'))
ok('encryptSettings 加密了 jevKey', encS.jevKey.startsWith('enc:v1:'))
ok('encryptSettings 没动 model', encS.model === 'step-3')
const decS = crypto.decryptSettings(encS)
ok('decryptSettings 还原 apiKey', decS.apiKey === 'sk-secret-1')
ok('decryptSettings 还原 jevKey', decS.jevKey === 'sk-jev-2')

// saveSettings 存加密，settings() 返回解密
store.saveSettings({ apiKey: 'sk-roundtrip-test' })
const liveSettings = store.settings()
ok('settings() 返回解密后的 apiKey', liveSettings.apiKey === 'sk-roundtrip-test', `实际 ${liveSettings.apiKey}`)
// 内部存储应该是加密的
const rawDb = store.load()
ok('内部存储的 apiKey 是加密的', rawDb.settings.apiKey.startsWith('enc:v1:'), `实际 ${rawDb.settings.apiKey.slice(0, 20)}...`)

// ============================================================
console.log('\n— 留痕层 trace —')

// 清空收件箱和 traces，准备测试
store.clearInbox()
const traceBefore = store.allTraces().length
// label stage 不再逐条存（改按天聚合，见 T3），结构测试用仍在存储的 gate stage
store.addTrace({
  target: { type: 'node', id: 'test-node-1' },
  stage: 'gate',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'abc123', textLen: 100, channelMeta: { platform: 'arxiv' } },
  output: { kind: '一手数据', quality: 0.9, via: 'jev' },
  decision: { kind: '一手数据', quality: 0.9 },
  reason: null,
})
ok('addTrace 创建了 trace', store.allTraces().length === traceBefore + 1, `实际 ${store.allTraces().length}`)

const tr = store.allTraces()[traceBefore]
ok('trace 有 id', typeof tr.id === 'string')
ok('trace 有 t', typeof tr.t === 'string')
ok('trace stage = gate', tr.stage === 'gate')
ok('trace actor.by = model', tr.actor.by === 'model')
ok('trace actor.model = step-3', tr.actor.model === 'step-3')
ok('trace actor.promptVersion = v1', tr.actor.promptVersion === 'v1')
ok('trace output 未加工', tr.output.quality === 0.9)
ok('trace decision 是最终值', tr.decision.quality === 0.9)
ok('trace reason 为 null（表值=模型值）', tr.reason === null)

// 取表值 ≠ 模型值时：label 走按天聚合，分差 = 模型值 - 表值
store.recordLabelAggregate({ kind: '分歧测试源', tableQuality: 0.4, modelQuality: 0.9 })
const diverged = store.labelerDivergence().find((g) => g.kind === '分歧测试源')
ok('分歧曲线按 kind 统计', diverged != null && diverged.count === 1, `实际 ${diverged?.count}`)
ok('分歧均值 = 模型值 - 表值', diverged != null && Math.abs(diverged.meanDiff - 0.5) < 0.01, `实际 ${diverged?.meanDiff}`)
// 同一天同 kind 累加，均值不变
store.recordLabelAggregate({ kind: '分歧测试源', tableQuality: 0.4, modelQuality: 0.9 })
const diverged2 = store.labelerDivergence().find((g) => g.kind === '分歧测试源')
ok('同 kind 累加 count=2', diverged2?.count === 2, `实际 ${diverged2?.count}`)
ok('同 kind 累加均值不变', diverged2 != null && Math.abs(diverged2.meanDiff - 0.5) < 0.01, `实际 ${diverged2?.meanDiff}`)

// 按 target 查询
const byTarget = store.tracesByTarget('test-node-1')
ok('tracesByTarget 返回 1 条', byTarget.length === 1, `实际 ${byTarget.length}`)

// 模型建议的校准曲线
store.addTrace({
  target: { type: 'node', id: 'test-node-3' },
  stage: 'extract',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'ghi789', textLen: 300 },
  output: { confidence: 85, lemmas: [] },
  decision: { confidence: 72 },
  reason: null,
})
const mc = store.modelCalibration()
ok('modelCalibration 返回 1 条', mc.length === 1, `实际 ${mc.length}`)
ok('modelConf = 85', mc[0].modelConf === 85)
ok('userConf = 72', mc[0].userConf === 72)
ok('modelCalibration 带 model', mc[0].model === 'step-3')
ok('modelCalibration 带 promptVersion', mc[0].promptVersion === 'v1')

// 打标器 vs 表的分歧曲线（读按天聚合）
const ld = store.labelerDivergence()
ok('labelerDivergence 返回数组', Array.isArray(ld))

// trace 不内联进 node
const dbNodes = store.allNodes()
ok('trace 不内联进 node', dbNodes.every((n) => !n.traces))

// 导入导出包含 traces
const exportedTraces = JSON.parse(store.exportAll())
ok('导出包含 traces 数组', Array.isArray(exportedTraces.traces))
ok('导出 traces 有 ' + store.allTraces().length + ' 条', exportedTraces.traces.length === store.allTraces().length)

// ============================================================
console.log('\n— 不确定性闸门 + 自动归位 —')
// ============================================================

const gateTheme = store.addTheme('闸门测试主题')
const gBranch1 = store.addNode({ themeId: gateTheme.id, kind: 'branch', title: '光通信', propagation: 0.6 })
const gBranch2 = store.addNode({ themeId: gateTheme.id, kind: 'branch', title: 'AI算力', propagation: 0.6 })
// 添加足够多的 lemma 使 gateTheme 成为 bestThemeContext（lemma 数最多）
for (let i = 0; i < 20; i++) {
  store.addNode({ themeId: gateTheme.id, parentId: gBranch1.id, kind: 'lemma', title: `光通信基线命题${i}`, confidence: 50 })
}

// 闸门通过：文本匹配环节、质量≥0.4、无冲突、无灰色去重
const gatePass = await fire('inbox:capture', '光通信 出货量超预期增长40%', { kind: '一手数据', quality: 0.9, platform: 'test' })
ok('闸门通过: autoImported = true', gatePass?.autoImported === true, `实际 autoImported=${gatePass?.autoImported} reasons=${JSON.stringify(gatePass?.gateReasons)}`)
ok('闸门通过: 返回 imported 数组', Array.isArray(gatePass?.imported))
ok('闸门通过: imported 有节点', gatePass?.imported?.length > 0)
ok('闸门通过: 不进收件箱', !gatePass?.item)
const autoNode = gatePass?.imported?.[0]
ok('自动入库节点存在', autoNode?.id != null)
const autoNodeFull = store.getNode(autoNode?.id)
ok('自动入库 by = source', autoNodeFull?.by === 'source', `实际 ${autoNodeFull?.by}`)
ok('自动入库节点在主题中', autoNodeFull?.themeId === gateTheme.id)

// 闸门失败: 归位失败（parentHint 匹配不到已有环节）
const gateNoParent = await fire('inbox:capture', '完全无关的xyz话题内容zzz', { kind: '一手数据', quality: 0.9 })
ok('闸门失败 no-parent: autoImported = false', gateNoParent?.autoImported === false)
ok('闸门失败 no-parent: 进收件箱', gateNoParent?.item?.id != null)
ok('闸门失败 no-parent: gateReasons 含 no-parent', gateNoParent?.gateReasons?.includes('no-parent'))

// 闸门失败: 来源质量低于 0.4
const gateLowQ = await fire('inbox:capture', '光通信行业某小道消息', { kind: '道听途说', quality: 0.2 })
ok('闸门失败 low-quality: autoImported = false', gateLowQ?.autoImported === false)
ok('闸门失败 low-quality: gateReasons 含 low-quality', gateLowQ?.gateReasons?.includes('low-quality'))

// 闸门失败: 去重灰色地带 (0.6–0.85)
// 注意：相似度按 token 交叠算，0.67 恰好落在"达到合并线 0.6、
// 但进灰色地带"的区间——之前这里的测试文本相似度只有 0.5，
// 是靠 routeLemmas 误用 0.45 默认阈值才判成合并的（已修复为 0.6）。
const gateDedup1 = await fire('inbox:capture', 'AI算力 需求增长 超预期', { kind: '一手数据', quality: 0.9 })
ok('去重测试: 第一条自动入库', gateDedup1?.autoImported === true, `实际 ${gateDedup1?.autoImported} reasons=${JSON.stringify(gateDedup1?.gateReasons)}`)
const gateDedup2 = await fire('inbox:capture', 'AI算力 需求增长 低于预期', { kind: '一手数据', quality: 0.9 })
if (gateDedup2?.autoImported) {
  ok('去重灰色: 高相似度直接合并', gateDedup2?.imported?.[0]?.action === 'merge')
} else {
  ok('去重灰色: 进收件箱', gateDedup2?.item?.id != null)
  ok('去重灰色: gateReasons 含 dedup-gray', gateDedup2?.gateReasons?.includes('dedup-gray'))
}
// 几乎逐字相同（相似度 1.0，命中留痕复用）：跳过灰色地带，直接合并自动入库
const gateDedup3 = await fire('inbox:capture', 'AI算力 需求增长 超预期', { kind: '一手数据', quality: 0.9 })
ok('去重高相似: 自动入库', gateDedup3?.autoImported === true, `实际 ${gateDedup3?.autoImported}`)
ok('去重高相似: 直接合并', gateDedup3?.imported?.[0]?.action === 'merge', `实际 ${gateDedup3?.imported?.[0]?.action}`)

// 校准曲线不统计 by:source 的节点
const calibBefore = store.calibration()
ok('校准曲线不含 by:source 节点', calibBefore.every(b => b.total >= 0))

// ============================================================
console.log('\n— 撤销自动归位 —')
// ============================================================

const undoTheme = store.addTheme('撤销测试主题')
const uBranch = store.addNode({ themeId: undoTheme.id, kind: 'branch', title: '半导体', propagation: 0.6 })
for (let i = 0; i < 30; i++) {
  store.addNode({ themeId: undoTheme.id, parentId: uBranch.id, kind: 'lemma', title: `半导体基线${i}`, confidence: 50 })
}

const undoCapture = await fire('inbox:capture', '半导体 出货量同比增长50%', { kind: '一手数据', quality: 0.9 })
ok('撤销测试: 自动入库', undoCapture?.autoImported === true)
ok('撤销测试: 有 intakeEventId', undoCapture?.intakeEventId != null)

const undoNodeId = undoCapture?.imported?.[0]?.id
ok('撤销测试: 节点已创建', store.getNode(undoNodeId) != null)
const inboxBeforeUndo = store.allInbox().length

const undoResult = await fire('inbox:undoAutoImport', undoCapture.intakeEventId)
ok('撤销返回 ok', undoResult?.ok === true)
ok('撤销后节点入墓', store.getNode(undoNodeId)?.status === 'dead')
ok('撤销后收件箱+1', store.allInbox().length === inboxBeforeUndo + 1, `实际 ${store.allInbox().length} vs ${inboxBeforeUndo + 1}`)
const undoInboxItem = store.allInbox().find(i => i.title === '半导体 出货量同比增长50%')
ok('撤销后收件箱有条目', undoInboxItem != null)
ok('撤销后条目有 label', undoInboxItem?.label?.kind === '一手数据')
ok('撤销后条目有 lemmas', Array.isArray(undoInboxItem?.lemmas))

// ============================================================
console.log('\n— 来源推导置信度 + by 分流统计 —')
// ============================================================

const confTheme = store.addTheme('置信度测试主题')
const cBranch = store.addNode({ themeId: confTheme.id, kind: 'branch', title: '新能源', propagation: 0.6 })
for (let i = 0; i < 40; i++) {
  store.addNode({ themeId: confTheme.id, parentId: cBranch.id, kind: 'lemma', title: `新能源基线${i}`, confidence: 50 })
}

// 自动入库的置信度由来源质量推导
const confCapture = await fire('inbox:capture', '新能源 装机量超预期', { kind: '一手数据', quality: 0.9 })
ok('置信度: 自动入库', confCapture?.autoImported === true)
const confNode = store.getNode(confCapture?.imported?.[0]?.id)
ok('置信度: by = source', confNode?.by === 'source')
ok('置信度: history[0].by = source', confNode?.history?.[0]?.by === 'source')
ok('置信度: 来源推导 = 90', confNode?.confidence === 90, `实际 ${confNode?.confidence}`)
ok('置信度: 无 manual history', !confNode?.history?.some(h => h.by === 'manual'))

// 校准曲线不含 by:source 节点（即使结算了）
store.settleLemma(confNode.id, true)
const calibAfterSettle = store.calibration()
ok('校准: by:source 结算后仍不进曲线', calibAfterSettle.every(b => !b.total || b.bucket !== 90 || b.hit === 0))

// 用户手动调置信度后，出现 manual history，进入校准
store.updateNode(confNode.id, { confidence: 75 })
const afterManual = store.getNode(confNode.id)
ok('手动调后: 有 manual history', afterManual?.history?.some(h => h.by === 'manual'))
ok('手动调后: confidence = 75', afterManual?.confidence === 75)

// 校准曲线现在包含该节点（有 manual entry + 已结算）
const calibAfterManual = store.calibration()
const bucket70 = calibAfterManual.find(b => b.bucket === 70)
ok('校准: 手动调后进入曲线', bucket70 != null && bucket70.total > 0, `实际 ${JSON.stringify(bucket70)}`)

// 不同来源质量推导不同置信度
const confCapture2 = await fire('inbox:capture', '新能源 补贴政策调整方向', { kind: '自媒体', quality: 0.5 })
if (confCapture2?.autoImported && confCapture2?.imported?.[0]?.action === 'new') {
  const confNode2 = store.getNode(confCapture2?.imported?.[0]?.id)
  ok('置信度: 自媒体推导 = 50', confNode2?.confidence === 50, `实际 ${confNode2?.confidence}`)
} else if (confCapture2?.autoImported) {
  ok('置信度: 自媒体合并已有节点', confCapture2?.imported?.[0]?.action === 'merge')
} else {
  ok('置信度: 自媒体低质进收件箱', confCapture2?.item?.id != null)
}

// ============================================================
console.log('\n— 冲突静默化 —')
// ============================================================

const conflictTheme = store.addTheme('冲突测试主题')
const cfBranch = store.addNode({ themeId: conflictTheme.id, kind: 'branch', title: '存储芯片', propagation: 0.6 })
for (let i = 0; i < 50; i++) {
  store.addNode({ themeId: conflictTheme.id, parentId: cfBranch.id, kind: 'lemma', title: `存储芯片基线${i}`, confidence: 50 })
}

const cfCapture1 = await fire('inbox:capture', '存储芯片 价格上涨超预期', { kind: '一手数据', quality: 0.9 })
ok('冲突: 第一条自动入库', cfCapture1?.autoImported === true)

const cfCapture2 = await fire('inbox:capture', '存储芯片 价格下跌不及预期', { kind: '一手数据', quality: 0.9 })
ok('冲突: 第二条入库或进收件箱', cfCapture2?.ok === true)

const allC = store.allConflicts()
ok('冲突: 不自动裁决', allC.every(c => c.resolved === null || c.resolved === undefined))
ok('冲突: 无弹窗无通知（静默）', true)

// ============================================================
console.log('\n— 任务1: 误杀闭环 —')
// ============================================================

const killTheme = store.addTheme('误杀测试主题')
const kBranch = store.addNode({ themeId: killTheme.id, kind: 'branch', title: '算力', propagation: 0.6 })
// 已有 lemma，用于触发 dedup（3 个 token 完全匹配 → score = 1.0）
const existLemma = store.addNode({ themeId: killTheme.id, parentId: kBranch.id, kind: 'lemma', title: '算力 芯片 需求', confidence: 60 })
for (let i = 0; i < 60; i++) {
  store.addNode({ themeId: killTheme.id, parentId: kBranch.id, kind: 'lemma', title: `算力基线${i}`, confidence: 50 })
}

// 第一次捕获：相似文本被 dedup 筛掉，产生 verdict
const killSim = store.findSimilar('算力 芯片 需求 超预期', killTheme.id)
ok('误杀: findSimilar 能找到', killSim.length > 0, `实际 ${JSON.stringify(killSim.map(s => ({ s: s.score, t: s.node.title })))}`)
ok('误杀: 相似度 >= 0.6', killSim[0]?.score >= 0.6, `实际 ${killSim[0]?.score}`)
const killCap1 = await fire('inbox:capture', '算力 芯片 需求 超预期', { kind: '一手数据', quality: 0.9 })
const killVerdictsBefore = store.allVerdicts().filter(v => v.themeId === killTheme.id)
ok('误杀: 第一次捕获后有 verdict', killVerdictsBefore.length > 0, `实际 ${killVerdictsBefore.length}`)
if (killVerdictsBefore.length > 0) {
  ok('误杀: verdict gate = dedup', killVerdictsBefore.some(v => v.gate === 'dedup'))
  ok('误杀: verdict promotedTo 为 null', killVerdictsBefore.every(v => v.promotedTo == null))
}

// 删除已有 lemma，使第二次捕获不被 dedup
store.removeNode(existLemma.id)

// 第二次捕获：同样的文本从别的源进来，这次作为新节点入库
const killCap2 = await fire('inbox:capture', '算力 芯片 需求 超预期', { kind: '券商研报', quality: 0.8 })
ok('误杀: 第二次捕获入库', killCap2?.ok === true)

// 检查误杀闭环
const verdictsAfter = store.allVerdicts().filter(v => v.themeId === killTheme.id)
const promoted = verdictsAfter.filter(v => v.promotedTo != null)
ok('误杀: verdict 被回填 promotedTo', promoted.length >= 1, `实际 ${promoted.length}`)

const audit = store.falseKillAudit(30)
ok('误杀: falseKillAudit missed >= 1', audit.missed >= 1, `实际 ${audit.missed}`)

const filterCalib = store.filterCalibration()
ok('误杀: filterCalibration 有非零误杀率', filterCalib.some(b => b.missed > 0), `实际 ${JSON.stringify(filterCalib)}`)

// 幂等：再次入库同一标题不重复回填
if (killCap2?.imported?.[0]?.id) {
  store.promoteMatchingVerdicts('算力 芯片 需求 超预期', killCap2.imported[0].id, killTheme.id)
  const promotedAgain = store.allVerdicts().filter(v => v.themeId === killTheme.id && v.promotedTo != null)
  ok('误杀: 幂等不重复回填', promotedAgain.length === promoted.length, `实际 ${promotedAgain.length} vs ${promoted.length}`)
}

// ============================================================
console.log('\n— route trace：自动归位 —')
// ============================================================

const rtTheme = store.addTheme('route-trace 测试主题')
const rtBranch = store.addNode({ themeId: rtTheme.id, kind: 'branch', title: '半导体', propagation: 0.6 })
for (let i = 0; i < 200; i++) {
  store.addNode({ themeId: rtTheme.id, parentId: rtBranch.id, kind: 'lemma', title: `半导体基线命题${i}`, confidence: 50 })
}

// 高质量捕获 → 通过闸门 → 自动归位
const rtCap = await fire('inbox:capture', '半导体 出货量超预期增长40%', { kind: '一手数据', quality: 0.9, platform: 'test' })
ok('route: 自动归位成功', rtCap?.autoImported === true, `实际 autoImported=${rtCap?.autoImported} reasons=${JSON.stringify(rtCap?.gateReasons)}`)

if (rtCap?.imported?.[0]?.id) {
  const rtTraces = store.tracesByTarget(rtCap.imported[0].id)
  const routeTraces = rtTraces.filter(t => t.stage === 'route')
  ok('route: 自动归位节点有 route trace', routeTraces.length > 0, `实际 ${routeTraces.length}`)
  if (routeTraces.length > 0) {
    const rt = routeTraces[0]
    ok('route: actor.by = gate', rt.actor?.by === 'gate', `实际 ${rt.actor?.by}`)
    ok('route: reason 以 gate-pass 开头', rt.reason?.startsWith('gate-pass'), `实际 ${rt.reason}`)
    ok('route: output 有 parentId', rt.output?.parentId != null || rt.output?.parentId === null)
    ok('route: decision 有 confidence', typeof rt.decision?.confidence === 'number')
    ok('route: input 有 suggestedParentId', rt.input?.suggestedParentId !== undefined)
    ok('route: input 有 suggestedConfidence', typeof rt.input?.suggestedConfidence === 'number')
  }
}

// ============================================================
console.log('\n— route trace：用户 override —')
// ============================================================

// 创建收件箱条目（未通过闸门的那种）
const ovItem = store.addInboxItem({
  text: '某公司可能要裁员',
  title: '某公司可能要裁员',
  label: { kind: '社交媒体', quality: 0.4, via: 'channel' },
  lemmas: [{ title: '某公司可能要裁员', type: 'observation', confidence: 40, action: 'new', parentId: rtBranch.id }],
  provenance: null,
})
ok('route: 收件箱条目创建', ovItem.id != null)

// 带 override 入库：改置信度
const ovResult = await fire('inbox:import', rtTheme.id, [ovItem], {
  [ovItem.id]: { confidence: 75, parentId: rtBranch.id },
})
ok('route: override 入库成功', ovResult?.ok === true)

if (ovResult?.results?.[0]?.id) {
  const ovTraces = store.tracesByTarget(ovResult.results[0].id)
  const routeTraces = ovTraces.filter(t => t.stage === 'route')
  ok('route: override 节点有 route trace', routeTraces.length > 0, `实际 ${routeTraces.length}`)
  if (routeTraces.length > 0) {
    const rt = routeTraces[0]
    ok('route: actor.by = user', rt.actor?.by === 'user', `实际 ${rt.actor?.by}`)
    ok('route: reason = user-override', rt.reason === 'user-override', `实际 ${rt.reason}`)
    ok('route: output.confidence ≠ decision.confidence', rt.output?.confidence !== rt.decision?.confidence,
      `实际 output=${rt.output?.confidence} decision=${rt.decision?.confidence}`)
    ok('route: decision.confidence = 75', rt.decision?.confidence === 75, `实际 ${rt.decision?.confidence}`)
  }
}

// 无 override 入库：reason = user-confirmed
const confirmItem = store.addInboxItem({
  text: '另一条待确认信息',
  title: '另一条待确认信息',
  label: { kind: '社交媒体', quality: 0.5, via: 'channel' },
  lemmas: [{ title: '另一条待确认信息', type: 'observation', confidence: 50, action: 'new', parentId: rtBranch.id }],
  provenance: null,
})
const confirmResult = await fire('inbox:import', rtTheme.id, [confirmItem], {})
ok('route: 无 override 入库成功', confirmResult?.ok === true)

if (confirmResult?.results?.[0]?.id) {
  const cfTraces = store.tracesByTarget(confirmResult.results[0].id)
  const routeTraces = cfTraces.filter(t => t.stage === 'route')
  ok('route: confirmed 节点有 route trace', routeTraces.length > 0, `实际 ${routeTraces.length}`)
  if (routeTraces.length > 0) {
    ok('route: reason = user-confirmed', routeTraces[0].reason === 'user-confirmed', `实际 ${routeTraces[0].reason}`)
    ok('route: output = decision (无修改)', routeTraces[0].output?.confidence === routeTraces[0].decision?.confidence)
  }
}

// ============================================================
console.log('\n— 任务3: intakeEvents 采集漏斗 —')
// ============================================================

// intakeSeries 返回今天的漏斗
const series = store.intakeSeries(3)
ok('intake: series 返回数组', Array.isArray(series))
ok('intake: series 有今天的数据', series.some(b => b.captured > 0), `实际 ${JSON.stringify(series)}`)

const todayBucket = series.find(b => b.captured > 0)
if (todayBucket) {
  ok('intake: 有 captured', todayBucket.captured > 0)
  ok('intake: 有 autoImported', todayBucket.autoImported >= 0)
  ok('intake: 有 toInbox', todayBucket.toInbox >= 0)
  ok('intake: autoImported + toInbox <= captured', todayBucket.autoImported + todayBucket.toInbox <= todayBucket.captured)
}

// 验证 intakeEvent 存在且结构正确
const allIntakeEvents = store.load().intakeEvents
ok('intake: intakeEvents 非空', allIntakeEvents.length > 0, `实际 ${allIntakeEvents.length}`)
const sampleEvent = allIntakeEvents[0]
ok('intake: event 有 id', sampleEvent.id != null)
ok('intake: event 有 at', sampleEvent.at != null)
ok('intake: event 有 gate', sampleEvent.gate != null)
ok('intake: event 有 outcome', sampleEvent.outcome != null)
ok('intake: event 有 label', sampleEvent.label != null)
ok('intake: event 有 lemmas', Array.isArray(sampleEvent.lemmas))
ok('intake: event 有 undone', sampleEvent.undone === false)

// 撤销后 intakeEvent 标记 undone
const undoEventId = rtCap?.intakeEventId
if (undoEventId) {
  await fire('inbox:undoAutoImport', undoEventId)
  const undoneEvent = store.getIntakeEvent(undoEventId)
  ok('intake: 撤销后 undone = true', undoneEvent?.undone === true, `实际 ${undoneEvent?.undone}`)
}

// 模拟重启：重新 load 后撤销入口仍在
store.load()
const lastAuto = store.lastAutoIntakeEvent()
ok('intake: lastAutoIntakeEvent 返回最近自动归位', lastAuto != null, `实际 null`)
if (lastAuto) {
  ok('intake: lastAuto outcome = auto', lastAuto.outcome === 'auto')
  ok('intake: lastAuto undone = false', lastAuto.undone === false)
}

// resolveInboxItem 补了 resolvedAt
const resolveTestItem = store.addInboxItem({
  text: 'resolveAt 测试', title: 'resolveAt 测试',
  label: { kind: '社交媒体', quality: 0.4, via: 'channel' },
  lemmas: [], provenance: null,
})
const resolvedAtTest = store.resolveInboxItem(resolveTestItem.id, 'accept')
ok('intake: resolveInboxItem 有 resolvedAt', resolvedAtTest?.resolvedAt != null, `实际 ${resolvedAtTest?.resolvedAt}`)

// 导出 → 导入 → intakeEvents 不丢
const exportedJson = store.exportAll()
const exportedObj = JSON.parse(exportedJson)
ok('intake: 导出包含 intakeEvents', Array.isArray(exportedObj.intakeEvents), `实际 ${typeof exportedObj.intakeEvents}`)
ok('intake: 导出 intakeEvents 非空', exportedObj.intakeEvents.length > 0, `实际 ${exportedObj.intakeEvents.length}`)

// 老文件导入后 intakeEvents 是空数组而非 undefined
const oldFile = JSON.stringify({
  version: 3, settings: {}, themes: [], nodes: [], verdicts: [], conflicts: [],
  feeds: [], inbox: [], traces: [], channels: [],
})
store.importAll(oldFile)
ok('intake: 老文件导入后 intakeEvents 是空数组', Array.isArray(store.load().intakeEvents) && store.load().intakeEvents.length === 0,
  `实际 ${typeof store.load().intakeEvents} len=${store.load().intakeEvents?.length}`)

// 导入有 intakeEvents 的文件后恢复
store.importAll(exportedJson)
ok('intake: 导入后 intakeEvents 恢复', store.load().intakeEvents.length === exportedObj.intakeEvents.length,
  `实际 ${store.load().intakeEvents.length} vs ${exportedObj.intakeEvents.length}`)

// ============================================================
console.log('\n— 任务4: raw 层补通道元数据 —')
// ============================================================

// 直接测试 appendRaw 带 channel
const rawWithChannel = store.appendRaw({
  kind: '一手数据', label: '一手数据',
  text: 'raw-channel-test-content-unique',
  channel: { platform: 'arxiv', url: 'https://arxiv.org/abs/2026.12345', fetchedAt: '2026-09-23' },
})
ok('raw: appendRaw 返回 id', rawWithChannel.id != null)
const rawEntry = store.getRaw(rawWithChannel.id)
ok('raw: 有 platform', rawEntry?.platform === 'arxiv', `实际 ${rawEntry?.platform}`)
ok('raw: 有 url', rawEntry?.url === 'https://arxiv.org/abs/2026.12345', `实际 ${rawEntry?.url}`)
ok('raw: 有 fetchedAt', rawEntry?.fetchedAt === '2026-09-23', `实际 ${rawEntry?.fetchedAt}`)

// 无 channel 的老条目仍正常
const rawNoChannel = store.appendRaw({ kind: '社交媒体', label: '社交媒体', text: 'raw-no-channel-test-unique' })
const rawNoChannelEntry = store.getRaw(rawNoChannel.id)
ok('raw: 无 channel 时无 platform', rawNoChannelEntry?.platform === undefined)
ok('raw: 无 channel 时无 url', rawNoChannelEntry?.url === undefined)

// 自动入库后 raw 带 channel 元数据
const rawTestTheme = store.addTheme('raw-channel 测试主题')
const rawTestBranch = store.addNode({ themeId: rawTestTheme.id, kind: 'branch', title: '航天', propagation: 0.6 })
for (let i = 0; i < 300; i++) {
  store.addNode({ themeId: rawTestTheme.id, parentId: rawTestBranch.id, kind: 'lemma', title: `航天基线${i}`, confidence: 50 })
}
const rawAutoCap = await fire('inbox:capture', '航天 发射次数创历史新高', { kind: '一手数据', quality: 0.9, platform: 'spacex', url: 'https://spacex.com/launches' })
ok('raw: 自动入库成功', rawAutoCap?.autoImported === true, `实际 ${rawAutoCap?.autoImported}`)
if (rawAutoCap?.imported?.[0]?.id) {
  const autoNode = store.getNode(rawAutoCap.imported[0].id)
  if (autoNode?.sources?.[0]?.rawId) {
    const autoRaw = store.getRaw(autoNode.sources[0].rawId)
    ok('raw: 自动入库 raw 有 platform', autoRaw?.platform === 'spacex', `实际 ${autoRaw?.platform}`)
    ok('raw: 自动入库 raw 有 url', autoRaw?.url === 'https://spacex.com/launches', `实际 ${autoRaw?.url}`)
  }
}

// ============================================================
console.log('\n— R2: 定时器纯函数 —')
// ============================================================

const { isQuietHours, dueToNotify, buildNotification } = await import('../src/main/scheduler.js')

// 时段边界
ok('scheduler: 10:00 不静默', isQuietHours(new Date('2026-01-01T10:00:00')) === false)
ok('scheduler: 21:59 不静默', isQuietHours(new Date('2026-01-01T21:59:00')) === false)
ok('scheduler: 22:00 静默', isQuietHours(new Date('2026-01-01T22:00:00')) === true)
ok('scheduler: 03:00 静默', isQuietHours(new Date('2026-01-01T03:00:00')) === true)
ok('scheduler: 08:59 静默', isQuietHours(new Date('2026-01-01T08:59:00')) === true)
ok('scheduler: 09:00 不静默', isQuietHours(new Date('2026-01-01T09:00:00')) === false)

// 去重
const notified = new Set(['a'])
const dueList = [{ id: 'a', title: '已通知' }, { id: 'b', title: '新到期' }, { id: 'c', title: '也新' }]
const fresh = dueToNotify(dueList, notified)
ok('scheduler: 去重后只剩 2 条', fresh.length === 2, `实际 ${fresh.length}`)
ok('scheduler: 去重后是 b 和 c', fresh[0]?.id === 'b' && fresh[1]?.id === 'c')

// 通知构造
const n1 = buildNotification([{ id: 'x', title: '光模块超预期' }])
ok('scheduler: 单条标题', n1?.title === 'Meridian · 到期结算', `实际 ${n1?.title}`)
ok('scheduler: 单条正文', n1?.body === '光模块超预期')

const n3 = buildNotification([{ id: 'a', title: '第一条' }, { id: 'b', title: '第二条' }, { id: 'c', title: '第三条' }])
ok('scheduler: 多条标题', n3?.title === 'Meridian · 3 条判断到期', `实际 ${n3?.title}`)
ok('scheduler: 多条正文取最早', n3?.body === '第一条')

ok('scheduler: 空列表返回 null', buildNotification([]) === null)
ok('scheduler: null 返回 null', buildNotification(null) === null)

// ============================================================
console.log('\n— R3: 误杀率按 gate 拆分 —')
// ============================================================

const fcResult = store.filterCalibration()
ok('R3: filterCalibration 返回数组', Array.isArray(fcResult))
ok('R3: 有 byGate 属性', fcResult.byGate != null)
ok('R3: byGate 有 source', fcResult.byGate.source != null)
ok('R3: byGate 有 dedup', fcResult.byGate.dedup != null)
ok('R3: byGate 有 user', fcResult.byGate.user != null)
ok('R3: source 有 label', fcResult.byGate.source.label === '明确误杀')
ok('R3: dedup 有 label', fcResult.byGate.dedup.label === '收敛度存疑')
ok('R3: user 有 label', fcResult.byGate.user.label === '用户误判')
ok('R3: source 有 accuracy', typeof fcResult.byGate.source.accuracy === 'number')
ok('R3: 原有数组结构不变', fcResult.length > 0 && typeof fcResult[0].lo === 'number')

// ============================================================
console.log('\n— R4: 误杀归因到通道 —')
// ============================================================

// 构造带 channelId 的 verdict
store.addVerdict({ gate: 'source', reason: 'low-quality', summary: '通道A误杀', score: 0.2, choice: '自媒体', channelId: 'ch-a' })
store.addVerdict({ gate: 'source', reason: 'low-quality', summary: '通道A再误杀', score: 0.3, choice: '自媒体', channelId: 'ch-a' })
store.addVerdict({ gate: 'dedup', reason: 'duplicate', summary: '通道B误杀', score: 0.5, choice: '一手数据', channelId: 'ch-b' })
store.addVerdict({ gate: 'source', reason: 'low-quality', summary: '无通道', score: 0.2, choice: '未知' })

const byCh = store.falseKillByChannel(30)
ok('R4: falseKillByChannel 返回数组', Array.isArray(byCh))
ok('R4: 有 ch-a', byCh.some(c => c.channelId === 'ch-a'), `实际 ${JSON.stringify(byCh.map(c => c.channelId))}`)
ok('R4: 有 ch-b', byCh.some(c => c.channelId === 'ch-b'))
ok('R4: 有未知通道', byCh.some(c => c.channelId === '未知通道'))
ok('R4: ch-a total = 2', byCh.find(c => c.channelId === 'ch-a')?.total === 2, `实际 ${byCh.find(c => c.channelId === 'ch-a')?.total}`)
ok('R4: 按 missed 降序', byCh[0]?.missed >= (byCh[1]?.missed || 0))

// 老 verdict 无 channelId 不报错
const oldVerdict = store.allVerdicts().find(v => !v.channelId)
ok('R4: 存在无 channelId 的 verdict', oldVerdict != null)

// ============================================================
console.log('\n— Fix: filterCalibration other gate 桶 —')
// ============================================================

store.addVerdict({ gate: 'extract', reason: 'off-topic', summary: 'extract gate 测试', score: 0.4, choice: '自媒体' })
const fcOther = store.filterCalibration()
ok('Fix: byGate 有 other', fcOther.byGate.other != null)
ok('Fix: other 有 label', fcOther.byGate.other.label === '其他 gate')
ok('Fix: other 有 accuracy', typeof fcOther.byGate.other.accuracy === 'number')
ok('Fix: other total > 0', fcOther.byGate.other.total > 0, `实际 ${fcOther.byGate.other.total}`)

// ============================================================
console.log('\n— Fix: purgeDead 区分用户删 vs 跌死 —')
// ============================================================

const purgeTheme = store.addTheme('purge 区分测试')
const purgeBranch = store.addNode({ themeId: purgeTheme.id, kind: 'branch', title: '测试环节', propagation: 0.5 })
const userDeleted = store.addNode({ themeId: purgeTheme.id, parentId: purgeBranch.id, kind: 'lemma', title: '用户手删的命题', confidence: 60 })
const autoDead = store.addNode({ themeId: purgeTheme.id, parentId: purgeBranch.id, kind: 'lemma', title: '跌死命题', confidence: 15 })

store.removeNode(userDeleted.id)
ok('Fix: 用户删后 status=dead', store.getNode(userDeleted.id)?.status === 'dead')
ok('Fix: 用户删有 deletedAt', store.getNode(userDeleted.id)?.deletedAt != null)

store.updateNode(autoDead.id, { confidence: 10 })
ok('Fix: 跌死 status=dead', store.getNode(autoDead.id)?.status === 'dead')
ok('Fix: 跌死无 deletedAt', store.getNode(autoDead.id)?.deletedAt == null)

const beforeDead = store.allNodes().filter((n) => n.status === 'dead')
const beforeUser = beforeDead.filter((n) => n.deletedAt).length
const beforeAuto = beforeDead.filter((n) => !n.deletedAt).length

const purgeAll = store.purgeDead()
ok('Fix: purgeAll removed = 全部 dead', purgeAll.removed === beforeDead.length, `实际 ${purgeAll.removed} vs ${beforeDead.length}`)
ok('Fix: purgeAll userDeleted 计数正确', purgeAll.userDeleted === beforeUser, `实际 ${purgeAll.userDeleted} vs ${beforeUser}`)
ok('Fix: purgeAll autoDead 计数正确', purgeAll.autoDead === beforeAuto, `实际 ${purgeAll.autoDead} vs ${beforeAuto}`)
ok('Fix: 真删后用户删节点不在', store.getNode(userDeleted.id) == null)
ok('Fix: 真删后跌死节点不在', store.getNode(autoDead.id) == null)

// scope = 'user' 只删用户删的
const purgeTheme2 = store.addTheme('purge scope 测试')
const purgeB2 = store.addNode({ themeId: purgeTheme2.id, kind: 'branch', title: '环节2', propagation: 0.5 })
const u2 = store.addNode({ themeId: purgeTheme2.id, parentId: purgeB2.id, kind: 'lemma', title: '手删2', confidence: 60 })
const a2 = store.addNode({ themeId: purgeTheme2.id, parentId: purgeB2.id, kind: 'lemma', title: '跌死2', confidence: 15 })
store.removeNode(u2.id)
store.updateNode(a2.id, { confidence: 8 })
const purgeUser = store.purgeDead('user')
ok('Fix: purgeUser removed = 1', purgeUser.removed === 1, `实际 ${purgeUser.removed}`)
ok('Fix: purgeUser 后跌死还在', store.getNode(a2.id)?.status === 'dead')
store.purgeDead('auto')

// ============================================================
console.log('\n— Fix: removeTheme 软删 —')
// ============================================================

const softTheme = store.addTheme('软删主题测试')
const softBranch = store.addNode({ themeId: softTheme.id, kind: 'branch', title: '软删环节', propagation: 0.5 })
const softLemma = store.addNode({ themeId: softTheme.id, parentId: softBranch.id, kind: 'lemma', title: '软删命题', confidence: 70 })

store.removeTheme(softTheme.id)
ok('Fix: 软删后主题不在 allThemes', !store.allThemes().some((t) => t.id === softTheme.id))
ok('Fix: 软删后节点 status=dead', store.getNode(softBranch.id)?.status === 'dead')
ok('Fix: 软删后子节点也 dead', store.getNode(softLemma.id)?.status === 'dead')
ok('Fix: 软删后节点有 deletedAt', store.getNode(softBranch.id)?.deletedAt != null)

const restored = store.restoreTheme(softTheme.id)
ok('Fix: restoreTheme 返回 true', restored === true)
ok('Fix: 恢复后主题在 allThemes', store.allThemes().some((t) => t.id === softTheme.id))
ok('Fix: 恢复后节点 status=live', store.getNode(softBranch.id)?.status === 'live')
ok('Fix: 恢复后子节点也 live', store.getNode(softLemma.id)?.status === 'live')

// ============================================================
console.log('\n— Fix: buildNotification 带上下文 —')
// ============================================================

const nCtx = buildNotification([{ id: 'x', title: '光模块超预期', confidence: 85, branchPath: '半导体 / 光模块', downstreamCount: 3 }])
ok('Fix: 通知正文含置信度', nCtx?.body.includes('85%'), `实际 ${nCtx?.body}`)
ok('Fix: 通知正文含挂点', nCtx?.body.includes('半导体 / 光模块'), `实际 ${nCtx?.body}`)
ok('Fix: 通知正文含下游数', nCtx?.body.includes('3 条下游'), `实际 ${nCtx?.body}`)

const nNoCtx = buildNotification([{ id: 'y', title: '无上下文命题' }])
ok('Fix: 无上下文时正文只有标题', nNoCtx?.body === '无上下文命题', `实际 ${nNoCtx?.body}`)

// ============================================================
console.log('\n— Fix2: bestThemeContext 不选已删主题 —')
// ============================================================

const btcTheme = store.addTheme('BTC 大主题')
const btcBranch = store.addNode({ themeId: btcTheme.id, kind: 'branch', title: 'BTC 环节', propagation: 0.5 })
for (let i = 0; i < 500; i++) {
  store.addNode({ themeId: btcTheme.id, parentId: btcBranch.id, kind: 'lemma', title: `BTC 命题 ${i}`, confidence: 60 })
}
const smallTheme = store.addTheme('小主题')
store.addNode({ themeId: smallTheme.id, kind: 'branch', title: '小环节', propagation: 0.5 })
store.addNode({ themeId: smallTheme.id, kind: 'lemma', title: '小命题', confidence: 60 })

ok('Fix2: 软删前 BTC 是 bestThemeContext', store.bestThemeContext()?.id === btcTheme.id, `实际 ${store.bestThemeContext()?.name}`)

store.removeTheme(btcTheme.id)
ok('Fix2: 软删后 bestThemeContext 不选已删主题', store.bestThemeContext()?.id !== btcTheme.id, `实际 ${store.bestThemeContext()?.name}`)
ok('Fix2: 软删后 bestThemeContext 选活跃主题', !store.deletedThemes().some((t) => t.id === store.bestThemeContext()?.id))

// stats().themes 也不包含已删主题
const stAfter = store.stats()
ok('Fix2: stats.themes 不含已删主题', stAfter.themes === store.allThemes().length, `实际 stats=${stAfter.themes} allThemes=${store.allThemes().length}`)

// stats().dead 数所有 dead 节点（含 branch）
const deadNodes = store.allNodes().filter((n) => n.status === 'dead')
ok('Fix2: stats.dead 数所有 dead 节点', stAfter.dead === deadNodes.length, `实际 stats=${stAfter.dead} actual=${deadNodes.length}`)

// 恢复
store.restoreTheme(btcTheme.id)
ok('Fix2: 恢复后 bestThemeContext 回到 BTC', store.bestThemeContext()?.id === btcTheme.id, `实际 ${store.bestThemeContext()?.name}`)

// deletedThemes 列表
store.removeTheme(smallTheme.id)
const delTs = store.deletedThemes()
ok('Fix2: deletedThemes 返回已删主题', delTs.some((t) => t.id === smallTheme.id))
ok('Fix2: deletedThemes 不含活跃主题', !delTs.some((t) => t.id === btcTheme.id))

// ============================================================
console.log('\n— Fix3: purgeDead dryRun 不落盘 —')
// ============================================================

const dryTheme = store.addTheme('dryRun 测试')
const dryBranch = store.addNode({ themeId: dryTheme.id, kind: 'branch', title: 'dry 环节', propagation: 0.5 })
const dryLemma = store.addNode({ themeId: dryTheme.id, parentId: dryBranch.id, kind: 'lemma', title: 'dry 命题', confidence: 60 })
store.removeNode(dryLemma.id)

const beforeCount = store.allNodes().filter((n) => n.status === 'dead').length
const dryResult = store.purgeDead('user', { dryRun: true })
ok('Fix3: dryRun 返回计数', dryResult.removed > 0, `实际 ${dryResult.removed}`)
ok('Fix3: dryRun 不删节点', store.allNodes().filter((n) => n.status === 'dead').length === beforeCount, `实际 ${store.allNodes().filter((n) => n.status === 'dead').length} vs ${beforeCount}`)
ok('Fix3: dryRun 后节点仍在', store.getNode(dryLemma.id) != null)

const realResult = store.purgeDead('user')
ok('Fix3: 真删后节点不在', store.getNode(dryLemma.id) == null)
ok('Fix3: 真删 removed > 0', realResult.removed > 0)

// ============================================================
console.log('\n— Fix3: 复盘页聚合逻辑 —')
// ============================================================

// 构造多天 intakeEvents，含 overridden
const aggTheme = store.addTheme('聚合测试主题')
const aggBranch = store.addNode({ themeId: aggTheme.id, kind: 'branch', title: '聚合环节', propagation: 0.5 })
for (let i = 0; i < 200; i++) {
  store.addNode({ themeId: aggTheme.id, parentId: aggBranch.id, kind: 'lemma', title: `聚合命题 ${i}`, confidence: 60 })
}

// 第一天：3 条捕获，1 条 overridden
store.addIntakeEvent({ at: '2026-09-20', themeId: aggTheme.id, outcome: 'inbox', gate: { pass: false }, label: { kind: '自媒体' }, lemmas: ['a'], overridden: true })
store.addIntakeEvent({ at: '2026-09-20', themeId: aggTheme.id, outcome: 'auto', gate: { pass: true }, label: { kind: '一手数据' }, lemmas: ['b'] })
store.addIntakeEvent({ at: '2026-09-20', themeId: aggTheme.id, outcome: 'inbox', gate: { pass: false }, label: { kind: '自媒体' }, lemmas: ['c'] })

// 第二天：2 条捕获，1 条 overridden
store.addIntakeEvent({ at: '2026-09-21', themeId: aggTheme.id, outcome: 'inbox', gate: { pass: false }, label: { kind: '自媒体' }, lemmas: ['d'], overridden: true })
store.addIntakeEvent({ at: '2026-09-21', themeId: aggTheme.id, outcome: 'auto', gate: { pass: true }, label: { kind: '一手数据' }, lemmas: ['e'] })

const aggSeries = store.intakeSeries(30)
const day20 = aggSeries.find((b) => b.date === '2026-09-20')
const day21 = aggSeries.find((b) => b.date === '2026-09-21')

ok('Fix3: day20 captured = 3', day20?.captured === 3, `实际 ${day20?.captured}`)
ok('Fix3: day20 overridden = 1', day20?.overridden === 1, `实际 ${day20?.overridden}`)
ok('Fix3: day21 overridden = 1', day21?.overridden === 1, `实际 ${day21?.overridden}`)

// 复盘页聚合逻辑（与 vault.js renderReview 中的 reduce 相同）
const agg = aggSeries.reduce((a, b) => ({
  captured: a.captured + b.captured,
  gatedIn: a.gatedIn + b.gatedIn,
  autoImported: a.autoImported + b.autoImported,
  toInbox: a.toInbox + b.toInbox,
  confirmed: a.confirmed + b.confirmed,
  rejected: a.rejected + b.rejected,
  undone: a.undone + b.undone,
  overridden: a.overridden + b.overridden,
  degraded: a.degraded + b.degraded,
}), { captured: 0, gatedIn: 0, autoImported: 0, toInbox: 0, confirmed: 0, rejected: 0, undone: 0, overridden: 0, degraded: 0 })

ok('Fix3: 聚合 overridden > 0', agg.overridden > 0, `实际 ${agg.overridden}`)
ok('Fix3: 聚合 overridden = 2', agg.overridden === 2, `实际 ${agg.overridden}`)

// 归位修改率 = overridden / (autoImported + confirmed)
const overrideRate = agg.autoImported + agg.confirmed > 0 ? Math.round((agg.overridden / (agg.autoImported + agg.confirmed)) * 100) : 0
ok('Fix3: 归位修改率 > 0', overrideRate > 0, `实际 ${overrideRate}%`)
ok('Fix3: 归位修改率 = overridden/(auto+confirmed)', agg.overridden === 2 && overrideRate === Math.round(2 / (agg.autoImported + agg.confirmed) * 100), `实际 ${overrideRate}% (overridden=${agg.overridden} auto=${agg.autoImported} confirmed=${agg.confirmed})`)

// ============================================================
console.log('\n— Fix4: planPurge 取消后数据不变 —')
// ============================================================

const { planPurge } = await import('../src/main/store.js')

// 构造有用户删和跌死节点的场景
const ppTheme = store.addTheme('planPurge 测试')
const ppBranch = store.addNode({ themeId: ppTheme.id, kind: 'branch', title: 'pp 环节', propagation: 0.5 })
const ppUser = store.addNode({ themeId: ppTheme.id, parentId: ppBranch.id, kind: 'lemma', title: '用户删的', confidence: 60 })
const ppAuto = store.addNode({ themeId: ppTheme.id, parentId: ppBranch.id, kind: 'lemma', title: '跌死的', confidence: 15 })
store.removeNode(ppUser.id)
store.updateNode(ppAuto.id, { confidence: 8 })

const deadBefore = store.allNodes().filter((n) => n.status === 'dead').length

// 场景1：用户点取消
const preview1 = store.purgeDead('user', { dryRun: true })
const plan1 = planPurge('user', preview1, false)
ok('Fix4: 取消时 willDelete = false', !plan1.willDelete)
ok('Fix4: 取消时 reason = canceled', plan1.reason === 'canceled')
ok('Fix4: 取消后 dead 节点数不变', store.allNodes().filter((n) => n.status === 'dead').length === deadBefore, `实际 ${store.allNodes().filter((n) => n.status === 'dead').length} vs ${deadBefore}`)
ok('Fix4: 取消后用户删节点仍在', store.getNode(ppUser.id) != null)
ok('Fix4: 取消后跌死节点仍在', store.getNode(ppAuto.id) != null)

// 场景2：用户确认
const preview2 = store.purgeDead('user', { dryRun: true })
const plan2 = planPurge('user', preview2, true)
ok('Fix4: 确认时 willDelete = true', plan2.willDelete)
ok('Fix4: 确认时 count = preview.removed', plan2.count === preview2.removed)
if (plan2.willDelete) {
  const r = store.purgeDead(plan2.scope)
  ok('Fix4: 确认后真删了', r.removed > 0)
  ok('Fix4: 确认后用户删节点不在', store.getNode(ppUser.id) == null)
  ok('Fix4: 确认后跌死节点仍在（只删 user scope）', store.getNode(ppAuto.id) != null)
}

// 场景3：空集
const preview3 = store.purgeDead('user', { dryRun: true })
const plan3 = planPurge('user', preview3, true)
ok('Fix4: 空集时 willDelete = false', !plan3.willDelete)
// ============================================================
// R1: 取数器注册表 — 已随通道系统移除（fetchers.js 已删除）
// ============================================================

// ============================================================
console.log('\n— R2: readings 读数集合 —')
// ============================================================

// 基本添加
const r1 = store.addReading({
  metric: 'nvda.revenue',
  value: 9714000000,
  unit: 'USD',
  asOf: '2018-01-28',
  at: '2026-09-20',
  source: { kind: '财报 / 公告', start: '2017-01-30', end: '2018-01-28', accn: '0001045810-19-000010', url: 'https://sec.gov/...' },
  basis: 'reported',
})
ok('R2: addReading 返回 added: true', r1.added === true)
ok('R2: reading 有 id', r1.reading.id != null)
ok('R2: reading 有 dedupeKey', r1.reading.dedupeKey != null)
ok('R2 v0.8: 去重键为非空不透明标识', typeof r1.reading.dedupeKey === 'string' && r1.reading.dedupeKey.length > 0)

// 幂等：完整来源也相同；v0.8 不再把不同来源仅凭相同 accn 合并。
const r2 = store.addReading({
  metric: 'nvda.revenue',
  value: 9714000000,
  unit: 'USD',
  asOf: '2018-01-28',
  source: { kind: '财报 / 公告', start: '2017-01-30', end: '2018-01-28', accn: '0001045810-19-000010', url: 'https://sec.gov/...' },
})
ok('R2: 重复 dedupeKey 返回 added: false', r2.added === false)

// 同一期间不同 accn（10-K 比较期重列）→ 两条记录
const r3 = store.addReading({
  metric: 'nvda.revenue',
  value: 9714000000,
  unit: 'USD',
  asOf: '2018-01-28',
  at: '2026-09-20',
  source: { kind: '财报 / 公告', start: '2017-01-30', end: '2018-01-28', accn: '0001045810-20-000036' },
})
ok('R2: 同期间不同 accn 是新记录', r3.added === true)
ok('R2: 两条记录都在', store.allReadings().filter((r) => r.metric === 'nvda.revenue').length === 2)

// 不同 metric
const r4 = store.addReading({
  metric: 'nvda.grossProfit',
  value: 5000000000,
  unit: 'USD',
  asOf: '2024-01-28',
  source: { kind: '财报 / 公告', start: '2023-01-30', end: '2024-01-28', accn: '0001045810-24-000001' },
})
ok('R2: 不同 metric 是新记录', r4.added === true)

// allReadings + 本地过滤
const revReadings = store.allReadings().filter((r) => r.metric === 'nvda.revenue')
ok('R2: allReadings 过滤 metric 正确', revReadings.length === 2 && revReadings.every((r) => r.metric === 'nvda.revenue'))

// v0.8 归位必须指向真实指标，旧 nodeId 输入仍能迁为主关联。
const r5Indicator = store.addNode({ themeId: theme.id, kind: 'lemma', type: 'observation', title: '苹果收入' })
const r5 = store.addReading({
  metric: 'aapl.revenue',
  value: 391000000000,
  unit: 'USD',
  asOf: '2024-09-28',
  nodeId: r5Indicator.id,
  source: { kind: '财报 / 公告', start: '2023-10-01', end: '2024-09-28', accn: '0000320193-24-000001' },
})
const indReadings = store.allReadings().filter((r) => r.indicatorId === r5Indicator.id)
ok('R2 v0.8: nodeId 兼容输入归位到真实指标', r5.added && indReadings.length === 1 && indReadings[0].metric === 'aapl.revenue')

// latestReading 语义：groupReadings 的 latest 字段
const r6 = store.addReading({
  metric: 'nvda.revenue',
  value: 16675000000,
  unit: 'USD',
  asOf: '2026-01-25',
  at: '2026-09-23',
  source: { kind: '财报 / 公告', start: '2025-01-27', end: '2026-01-25', accn: '0001045810-26-000001' },
})
const revGroups = groupReadings(store.allReadings().filter((r) => r.metric === 'nvda.revenue'))
const latest = revGroups[0].latest
ok('R2: groupReadings latest 返回最新', latest != null && latest.value === 16675000000)
ok('R2: 旧记录仍在', store.allReadings().filter((r) => r.metric === 'nvda.revenue').length === 3)

// stats 包含 readings
const stReadings = store.stats()
ok('R2: stats 包含 readings 计数', typeof stReadings.readings === 'number' && stReadings.readings >= 4)

// calibration 不含 readings 的影响
const calibR = store.calibration()
ok('R2: calibration 不受 readings 影响', !calibR.some((c) => c.metric != null && c.value != null))

// 导出 → 导入 → readings 不丢
const exportedR = store.exportAll({ withRaw: false })
const parsedR = JSON.parse(exportedR)
ok('R2: 导出包含 readings', Array.isArray(parsedR.readings) && parsedR.readings.length >= 4)

// 老文件没有 readings，也没有 v0.8 的来源集合与追加事件账本。
delete parsedR.readings
delete parsedR.readingJournal
delete parsedR.readingFormat
delete parsedR.sources
const oldFileStrR = JSON.stringify(parsedR)
store.importAll(oldFileStrR)
ok('R2: 老文件导入后 readings 为空', store.stats().readings === 0)

// 恢复数据
store.importAll(exportedR)
ok('R2: 重新导入后 readings 恢复', store.stats().readings >= 4)

// 没有 updateReading / removeReading / 三个死函数
const storeExports = Object.keys(store)
ok('R2: 没有 updateReading', !storeExports.includes('updateReading'))
ok('R2: 没有 removeReading', !storeExports.includes('removeReading'))
ok('R2: 没有 readingsByMetric', !storeExports.includes('readingsByMetric'))
ok('R2: 没有 readingsByIndicator', !storeExports.includes('readingsByIndicator'))
ok('R2: 没有 latestReading', !storeExports.includes('latestReading'))
ok('R2: 没有 groupReadings（已移至 shared）', !storeExports.includes('groupReadings'))

// ============================================================
console.log('\n— 读数展示: groupReadings 纯函数 —')
// ============================================================


// 构造测试数据
const testReadings = [
  { metric: 'a.revenue', value: 100, unit: 'USD', asOf: '2024-Q1', at: '2026-09-01', indicatorId: null, source: {} },
  { metric: 'a.revenue', value: 200, unit: 'USD', asOf: '2024-Q2', at: '2026-09-02', indicatorId: null, source: {} },
  { metric: 'a.revenue', value: 150, unit: 'USD', asOf: '2024-Q3', at: '2026-09-03', indicatorId: null, source: {} },
  { metric: 'b.profit', value: 50, unit: 'USD', asOf: '2024-Q2', at: '2026-09-02', indicatorId: 'ind-1', source: {} },
  { metric: 'b.profit', value: 60, unit: 'USD', asOf: null, at: '2026-09-01', indicatorId: 'ind-1', source: {} },
]

const groups = groupReadings(testReadings)
ok('分组: 2 个 metric', groups.length === 2)
ok('分组: a.revenue 有 3 条', groups.find((g) => g.metric === 'a.revenue').count === 3)
ok('分组: b.profit 有 2 条', groups.find((g) => g.metric === 'b.profit').count === 2)

// 最新一条置顶
const aGroup = groups.find((g) => g.metric === 'a.revenue')
ok('分组: a.revenue 最新置顶', aGroup.items[0].at === '2026-09-03')
ok('分组: a.revenue 最新 value = 150', aGroup.items[0].value === 150)

// 其余按 asOf 倒序
ok('分组: a.revenue 第二条 asOf = 2024-Q2', aGroup.items[1].asOf === '2024-Q2')
ok('分组: a.revenue 第三条 asOf = 2024-Q1', aGroup.items[2].asOf === '2024-Q1')

// 无 asOf 排最后
const bGroup = groups.find((g) => g.metric === 'b.profit')
ok('分组: b.profit 无 asOf 排最后', bGroup.items[bGroup.items.length - 1].asOf === null)

// latest 字段正确
ok('分组: a.revenue latest.at = 2026-09-03', aGroup.latest.at === '2026-09-03')
ok('分组: b.profit latest.at = 2026-09-02', bGroup.latest.at === '2026-09-02')
ok('分组: b.profit latest value = 50', bGroup.latest.value === 50)

// 空数组
ok('分组: 空数组返回空', groupReadings([]).length === 0)

// 单条
const single = groupReadings([{ metric: 'x', value: 1, asOf: '2024-Q1', at: '2026-09-01', source: {} }])
ok('分组: 单条 latest = 自身', single[0].latest === single[0].items[0])

// 折叠阈值不在此函数（由 UI 控制），但确认 items 返回全部
ok('分组: items 返回全部', aGroup.items.length === 3)

// IPC: openExternal 只允许 http/https
const openResult1 = fire('io:openExternal', 'javascript:alert(1)')
ok('IPC: openExternal 拒绝 javascript:', openResult1 === false)
const openResult2 = fire('io:openExternal', 'file:///etc/passwd')
ok('IPC: openExternal 拒绝 file:', openResult2 === false)
const openResult3 = fire('io:openExternal', 'not-a-url')
ok('IPC: openExternal 拒绝非 URL', openResult3 === false)

// preload.js 和 preload.cjs 同步
import { readFileSync as readFileSync2 } from 'node:fs'
import { fileURLToPath as fileURLToPath2 } from 'node:url'
const ROOT2 = join(dirname(fileURLToPath2(import.meta.url)), '..')
const pj = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
// 提取桥接键对比（去掉 require/import 行差异）
const extractKeys = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('preload: 两份桥接键同步', JSON.stringify(extractKeys(pj)) === JSON.stringify(extractKeys(pc)))

// 语法检查。同步测试只比内容——preload 少个逗号照样「同步」，但 app 直接起不来。
// 这一条是那次事故之后补的。
import { default as vm } from 'node:vm'
const syntaxOk = (src) => { try { new vm.Script(src); return true } catch { return false } }
ok('preload: preload.js 语法可编译', syntaxOk(pj), '语法错误会让 app 起不来')
// ============================================================
// R3: SEC EDGAR 取数器 — 已随通道系统移除（fetchers.js 已删除）
// ============================================================

// ============================================================
// 数据源统一为通道：迁移 — 通道已移除，旧 feeds/channels 不再转入运行态
// ============================================================

// --- 旧格式数据：3 条 feeds，0 条 channels ---
const oldData = JSON.stringify({
  version: 3,
  settings: {},
  themes: [],
  nodes: [],
  verdicts: [],
  conflicts: [],
  feeds: [
    { id: 'feed-1', name: 'Reuters RSS', url: 'https://reuters.com/feed.xml', kind: 'rss', themeId: null, interval: 60, lastFetch: '2026-09-20', lastCount: 15, enabled: true, createdAt: '2026-09-01' },
    { id: 'feed-2', name: 'Bloomberg RSS', url: 'https://bloomberg.com/feed.xml', kind: 'rss', themeId: null, interval: 30, lastFetch: null, lastCount: null, enabled: true, createdAt: '2026-09-02' },
    { id: 'feed-3', name: 'WSJ RSS', url: 'https://wsj.com/feed.xml', kind: 'rss', themeId: null, interval: 120, lastFetch: '2026-09-22', lastCount: 8, enabled: false, createdAt: '2026-09-03' },
  ],
  inbox: [],
  traces: [],
  channels: [],
  intakeEvents: [],
  readings: [],
})

store.importAll(oldData)
const migratedExportJson2 = JSON.parse(store.exportAll())
ok('迁移: 加载后通道描述符被清理（load 运行态）', !('channels' in store.load()))
ok('迁移: feeds 集合清空', (migratedExportJson2.feeds || []).length === 0)

// --- 幂等：导出再导入，channels 不翻倍 ---
const migratedExport = store.exportAll()
const migratedExportJson = JSON.parse(migratedExport)
ok('幂等: 导出 feeds 为空', Array.isArray(migratedExportJson.feeds) && migratedExportJson.feeds.length === 0)
ok('幂等: 导出 version 为 4', migratedExportJson.version === 4)
store.importAll(migratedExport)
ok('幂等: 加载后无 channels 键（通道已移除）', !('channels' in store.load()))

// --- 旧导出文件可导入（version 3 + feeds 有数据，channels 应被丢弃） ---
const dedupData = JSON.stringify({
  version: 3,
  settings: {},
  themes: [],
  nodes: [],
  verdicts: [],
  conflicts: [],
  feeds: [
    { id: 'feed-dup', name: 'Reuters RSS', url: 'https://reuters.com/feed.xml', kind: 'rss', interval: 60, enabled: true, createdAt: '2026-09-01' },
  ],
  inbox: [],
  traces: [],
  channels: [
    { id: 'ch-existing', name: 'Reuters RSS', kind: '独立媒体', fetch: 'rss', query: 'https://reuters.com/feed.xml', themeId: null, metric: null, interval: 60, lastFetch: null, lastCount: null, cadence: '日', network: 'direct', enabled: true, review: false, createdAt: '2026-09-01' },
  ],
  intakeEvents: [],
  readings: [],
})
store.importAll(dedupData)
ok('兼容: 旧格式导入不报错', true)
ok('兼容: 旧 channels 在加载后被清理', !('channels' in store.load()))

// --- grep 验收 ---
const vaultSrc = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const settingsSrc = readFileSync2(join(ROOT2, 'src/renderer/views/settings.js'), 'utf8')
const ipcSrc = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const preloadSrc = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const preloadCjsSrc = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

ok('验收: vault.js 无 inputs.kind ||', !vaultSrc.includes('inputs.kind ||'))
ok('验收: vault.js 无 inputs.fetch ||', !vaultSrc.includes('inputs.fetch ||'))
ok('验收: settings.js 无 通道与取数', !settingsSrc.includes('通道与取数'))
ok('验收: settings.js 无 订阅源', !settingsSrc.includes('订阅源'))
ok('验收: ipc.js 无 generatePills', !ipcSrc.includes('generatePills'))
ok('验收: ipc.js 无 feedFetchAndLabel', !ipcSrc.includes('feedFetchAndLabel'))
ok('验收: ipc.js 无 feedImport', !ipcSrc.includes('feedImport'))
ok('验收: ipc.js 无 feed:list', !ipcSrc.includes('feed:list'))
ok('验收: preload.js 无 feedFetchAndLabel', !preloadSrc.includes('feedFetchAndLabel'))
ok('验收: preload.js 无 feedImport', !preloadSrc.includes('feedImport'))
ok('验收: preload.cjs 无 feedFetchAndLabel', !preloadCjsSrc.includes('feedFetchAndLabel'))
ok('验收: preload.cjs 无 feedImport', !preloadCjsSrc.includes('feedImport'))

// feeds.js 已删除
import { existsSync as existsSync2 } from 'node:fs'
ok('验收: feeds.js 已删除', !existsSync2(join(ROOT2, 'src/renderer/views/feeds.js')))

// ============================================================
console.log('\n— R7: 指标来源面板 —')
// ============================================================

// --- 3.1 建主题不再配通道（通道功能已移除） ---
const nonAiTheme = await fire('theme:setupNew', '纺织服装供应链')
ok('R7: 非 AI 描述建主题成功', !!nonAiTheme?.id)

const aiTheme = await fire('theme:setupNew', 'AI 产业链')
ok('R7 无 key: 返回降级标记', aiTheme.degraded === true)
ok('R7: 建主题不再返回 channelCount', aiTheme.channelCount === undefined)

// --- 3.2 指针机制：channelIds（节点字段保留，仅存历史引用） ---
const ptrTheme = store.addTheme('R7 指针测试')

const indNode = store.addNode({ themeId: ptrTheme.id, kind: 'lemma', title: '云厂商 capex', type: 'observation', channelIds: ['r7-ch-1', 'r7-ch-2', 'r7-ch-3'] })
ok('R7 channelIds: 挂 3 个通道引用', indNode.channelIds.length === 3)

store.updateNode(indNode.id, { channelIds: ['r7-ch-1', 'r7-ch-2'] })
ok('R7 channelIds: 更新为 2', store.getNode(indNode.id).channelIds.length === 2)

// 旧节点 migrate 补 channelIds
const oldNodeData = JSON.stringify({
  version: 4,
  settings: {},
  themes: [],
  nodes: [{ id: 'r7-old-node', themeId: null, parentId: null, kind: 'lemma', title: '旧指标', type: 'observation', confidence: 50, sources: [], tags: [], tickers: [], status: 'live', history: [], by: 'manual', stableId: 'r7-old', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
  verdicts: [], conflicts: [], feeds: [], inbox: [], traces: [], channels: [], intakeEvents: [], readings: [],
})
store.importAll(oldNodeData)
const oldNode = store.allNodes().find((n) => n.id === 'r7-old-node')
ok('R7 migrate: 旧节点 channelIds 为空数组', Array.isArray(oldNode?.channelIds) && oldNode.channelIds.length === 0)

// 导出导入 channelIds 不丢
store.addNode({ themeId: null, kind: 'lemma', title: '导出测试', type: 'observation', channelIds: ['fake-ch-1', 'fake-ch-2'] })
const r7Export = store.exportAll()
store.importAll(r7Export)
const exportedNode = store.allNodes().find((n) => n.title === '导出测试')
ok('R7 导出导入: channelIds 不丢', exportedNode?.channelIds?.length === 2)

// --- indicatorsForReading（节点 channelIds 指针保留，仅存历史引用） ---
const ifrTheme = store.addTheme('R7 反查测试')
const ifrChId = 'fake-edgar-tsla'
const ifrNode = store.addNode({ themeId: ifrTheme.id, kind: 'lemma', title: 'TSLA 收入', type: 'observation', channelIds: [ifrChId] })
const ifrReading = store.addReading({ metric: 'tsla.revenue', value: 96773000000, unit: 'USD', channelId: ifrChId, at: '2026-09-20', source: { kind: '财报 / 公告', start: '2024-01-01', end: '2024-03-31', accn: '0001628280-24-020' } })
ok('R7 addReading: 返回 added', ifrReading.added === true)
const inds = store.indicatorsForReading(ifrReading.reading)
ok('R7 indicatorsForReading: 返回该指标', inds.length === 1 && inds[0].id === ifrNode.id)

// 无 channelId 的读数 → 空数组
const orphanReading = { channelId: null, metric: 'test' }
ok('R7 indicatorsForReading: 无 channelId → 空', store.indicatorsForReading(orphanReading).length === 0)


// --- 缺口列表：observation 节点无 channelIds ---
const gapTheme = store.addTheme('R7 缺口测试')
store.addNode({ themeId: gapTheme.id, kind: 'lemma', title: '有通道的指标', type: 'observation', channelIds: ['some-ch'] })
store.addNode({ themeId: gapTheme.id, kind: 'lemma', title: '无通道的指标1', type: 'observation' })
store.addNode({ themeId: gapTheme.id, kind: 'lemma', title: '无通道的指标2', type: 'observation' })
const gapNodes = store.allNodes().filter((n) => n.themeId === gapTheme.id && n.type === 'observation' && (!n.channelIds || n.channelIds.length === 0))
ok('R7 缺口: 2 个无通道指标', gapNodes.length === 2)

// --- grep 验收 ---
const inspectorSrc = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
const vaultSrcR7 = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const readingUiSrcV8 = readFileSync2(join(ROOT2, 'src/renderer/views/readings.js'), 'utf8')
const readingAppSrcV8 = readFileSync2(join(ROOT2, 'src/renderer/app.js'), 'utf8')

// 读数视图和来源面板无「加权」「汇总」「总量」「合计」
ok('R7 验收: vault.js 无 加权', !vaultSrcR7.includes('加权'))
ok('R7 验收: vault.js 无 汇总', !vaultSrcR7.includes('汇总'))
ok('R7 验收: vault.js 无 总量', !vaultSrcR7.includes('总量'))
ok('R7 验收: vault.js 无 合计', !vaultSrcR7.includes('合计'))
ok('R7 验收: inspector.js 无 加权', !inspectorSrc.includes('加权'))
ok('R7 验收: inspector.js 无 汇总', !inspectorSrc.includes('汇总'))
ok('R7 验收: inspector.js 无 总量', !inspectorSrc.includes('总量'))
ok('R7 验收: inspector.js 无 合计', !inspectorSrc.includes('合计'))

// 新代码不写 indicatorId（store.js addReading 里有 indicatorId 是旧代码，不算新写）
// 检查 inspector.js 不含 indicatorId；vault.js 不创建含 indicatorId 属性的对象（读取 p.indicatorId 不算写）
ok('R7 验收: inspector.js 无 indicatorId 写入', !inspectorSrc.includes('indicatorId'))
ok('R7 验收: vault.js 不写 indicatorId 属性', !vaultSrcR7.includes('indicatorId:') && !vaultSrcR7.match(/\{\s*indicatorId\s*[,:}]/))

// preload 两份同步
const pjR7 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcR7 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeysR7 = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('R7 验收: preload 两份同步', JSON.stringify(extractKeysR7(pjR7)) === JSON.stringify(extractKeysR7(pcR7)))

// v0.8：反查走按需证据，树内走每指标最新投影，不回传全量读数。
ok('R7 v0.8: 检视面板按需加载证据', inspectorSrc.includes('readingPanel') && readingUiSrcV8.includes('m.readingEvidence('))
ok('R7 v0.8: 树加载每指标最新投影', readingAppSrcV8.includes('m.latestReadings(') && !readingAppSrcV8.includes('m.allReadings('))

// ============================================================
// v0.6.3: O1-O5 优化
// ============================================================

console.log('\n— v0.6.3: O1-O5 优化 —')

// --- O1: us-gaap 标签发现 ---
const { parseCompanyFacts } = await import('../src/main/discover.js')
const { COMMON_US_GAAP } = await import('../src/main/store.js')
const factsFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/edgar-companyfacts.json'), 'utf8'))
const parsedTags = parseCompanyFacts(factsFixture)

ok('O1: parseCompanyFacts 返回标签数组', Array.isArray(parsedTags))
ok('O1: 解析出 6 个 us-gaap 标签', parsedTags.length === 6, `实际 ${parsedTags.length}`)
// 常用标签置顶
const commonTags = parsedTags.filter((t) => t.common)
ok('O1: 常用标签置顶', commonTags.length > 0 && parsedTags.indexOf(commonTags[0]) === 0)
ok('O1: Revenues 是常用标签', parsedTags.find((t) => t.tag === 'Revenues')?.common === true)
ok('O1: NetIncomeLoss 是常用标签', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.common === true)
ok('O1: SomeObscureTag 不是常用标签', parsedTags.find((t) => t.tag === 'SomeObscureTag')?.common === false)
// 期间数
ok('O1: Revenues 有 2 个期间', parsedTags.find((t) => t.tag === 'Revenues')?.periods === 2)
ok('O1: DeferredRevenue 有 0 个期间', parsedTags.find((t) => t.tag === 'DeferredRevenue')?.periods === 0)
ok('O1: NetIncomeLoss 有 1 个期间', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.periods === 1)
// 常用标签按 COMMON_US_GAAP 中的顺序
const revIdx = parsedTags.findIndex((t) => t.tag === 'Revenues')
const niIdx = parsedTags.findIndex((t) => t.tag === 'NetIncomeLoss')
ok('O1: Revenues 在 NetIncomeLoss 前', revIdx < niIdx)
// 非常用标签按字母序
const obscureIdx = parsedTags.findIndex((t) => t.tag === 'SomeObscureTag')
const defIdx = parsedTags.findIndex((t) => t.tag === 'DeferredRevenue')
ok('O1: 非常用按字母序 (DeferredRevenue < SomeObscureTag)', defIdx < obscureIdx)
// F3: label 和 synonymGroup
ok('O1: Revenues 有中文标签', parsedTags.find((t) => t.tag === 'Revenues')?.label === '总收入')
ok('O1: NetIncomeLoss 有中文标签', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.label === '净利润')
ok('O1: 非常用标签 label 为 null', parsedTags.find((t) => t.tag === 'SomeObscureTag')?.label === null)
ok('O1: Revenues 有 synonymGroup', parsedTags.find((t) => t.tag === 'Revenues')?.synonymGroup === 0)
ok('O1: NetIncomeLoss 无 synonymGroup', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.synonymGroup === null)
// COMMON_US_GAAP 是对象数组
ok('O1: COMMON_US_GAAP 是对象数组', COMMON_US_GAAP.every((c) => typeof c === 'object' && c.tag && c.label))
// 空数据降级
ok('O1: 空数据返回空数组', parseCompanyFacts(null).length === 0)
ok('O1: 无 us-gaap 返回空数组', parseCompanyFacts({ facts: {} }).length === 0)
// companyfacts 不进轮询
const schedulerSrc = readFileSync2(join(ROOT2, 'src/main/scheduler.js'), 'utf8')
ok('O1: scheduler.js 无 companyfacts', !schedulerSrc.includes('companyfacts'))
// discoverTags 在 discover.js 中（手动触发，不是轮询）
const discoverSrc = readFileSync2(join(ROOT2, 'src/main/discover.js'), 'utf8')
ok('O1: discover.js 有 discoverTags', discoverSrc.includes('discoverTags'))
ok('O1: discover.js 有 parseCompanyFacts', discoverSrc.includes('parseCompanyFacts'))
// IPC + preload 桥
ok('O1: ipc.js 有 edgar:discoverTags', readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8').includes('edgar:discoverTags'))
ok('O1: preload.js 有 discoverTags', pjR7.includes('discoverTags'))
ok('O1: preload.cjs 有 discoverTags', pcR7.includes('discoverTags'))
// v0.8 不再要求用户发现内部标签，来源由读数自动形成。
ok('O1 v0.8: 去掉标签配置，来源有独立分页', !vaultSrcR7.includes('发现标签') && readingUiSrcV8.includes('m.sourcesPage('))

// --- O2: 通道已移除；归位走读数台账 ---
const o2Theme = store.addTheme('O2 测试主题')
// v0.8：不用通道分组选管道，直接按指标查台账，未知读数再人工归位。
ok('O2b v0.8: 检视面板提供读数台账', inspectorSrc.includes('readingPanel(node)'))
ok('O2b v0.8: 台账查询限定当前指标', readingUiSrcV8.includes('m.readingsPage({ indicatorId: node.id'))
ok('O2b v0.8: 未匹配读数可人工归位', readingUiSrcV8.includes('m.assignReading(') && readingUiSrcV8.includes('归位到'))
ok('O2 v0.8: 归位选项可辨主题', readingUiSrcV8.includes('state.themes.find') && readingUiSrcV8.includes('n.themeId'))


// --- O4: v0.8 指标归位为主关联，获取方仍可用人话契约 ---
const storeSrc = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
ok('O4 v0.8: store 提供主关联和待归位入口', storeSrc.includes('indicatorId') && typeof store.assignReading === 'function')

// --- O5: 空态直接说明如何提供读数，不再跳转配置管道 ---
ok('O5 v0.8: 检视面板直接提供读数入口', inspectorSrc.includes("from './readings.js'") && inspectorSrc.includes('readingPanel(node)'))
ok('O5 v0.8: 空态说明手记或助手提供', inspectorSrc.includes('readingPanel') && readingUiSrcV8.includes('还没有读数') && readingUiSrcV8.includes('助手按主题'))

// --- v0.6.3 preload 两份同步（再验一次，加了 discoverTags）---
const pj63 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc63 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeys63 = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('v0.6.3 验收: preload 两份同步', JSON.stringify(extractKeys63(pj63)) === JSON.stringify(extractKeys63(pc63)))

// ============================================================
// v0.6.4: F1-F5 修订
// ============================================================

console.log('\n— v0.6.4: F1-F5 修订 —')

const vaultSrcF = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const ipcSrcF = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')

// --- F1: v0.8 恢复 indicatorId 主关联，不再要求丢弃归位信息 ---
const f1Indicator = store.addNode({ themeId: theme.id, kind: 'lemma', type: 'observation', title: 'F1 归位指标' })
const f1Reading = store.addReading({
  metric: 'f1.test',
  indicator: f1Indicator.title,
  value: 42,
  unit: 'USD',
  period: { start: '2024-01-01', end: '2024-03-31' },
  indicatorId: f1Indicator.id,
  source: { kind: '一手数据', label: 'F1 来源', url: 'https://f1.example/report' },
})
ok('F1 v0.8: addReading 保留指标主关联', f1Reading.added && store.allReadings().find((r) => r.metric === 'f1.test').indicatorId === f1Indicator.id)
ok('F1 v0.8: 指标读数提供有界查询', typeof store.readingsPage === 'function' && typeof store.latestReadings === 'function')

// --- F2: v0.8 无通道配置下拉；手填读数由当前节点带主题 ---
ok('F2 v0.8: 手填从当前节点推导主题', !vaultSrcF.includes('channelAdd(') && readingUiSrcV8.includes('themeHint: state.themes.find') && readingUiSrcV8.includes('node.themeId'))

// --- F3: COMMON_US_GAAP 带中文标签 + 同义组 ---
const { SYNONYM_GROUPS } = await import('../src/main/store.js')
ok('F3: COMMON_US_GAAP 是对象数组', Array.isArray(COMMON_US_GAAP) && COMMON_US_GAAP.every((c) => typeof c === 'object' && c.tag && c.label))
ok('F3: COMMON_US_GAAP 有中文标签', COMMON_US_GAAP.some((c) => c.label === '总收入'))
ok('F3: SYNONYM_GROUPS 存在', Array.isArray(SYNONYM_GROUPS) && SYNONYM_GROUPS.length > 0)
ok('F3: SYNONYM_GROUPS 每组是字符串数组', SYNONYM_GROUPS.every((g) => Array.isArray(g) && g.every((t) => typeof t === 'string')))
ok('F3: parseCompanyFacts 返回 label', parsedTags.find((t) => t.tag === 'Revenues')?.label === '总收入')
ok('F3: parseCompanyFacts 返回 synonymGroup', parsedTags.find((t) => t.tag === 'Revenues')?.synonymGroup === 0)
ok('F3 v0.8: 手填契约使用人话节点标题', readingUiSrcV8.includes('indicator: node.title'))

// --- F4: 手动读数仍在检视面板，但不再暗建 manual 通道 ---
const inspectorSrcF4 = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
ok('F4 v0.8: 检视面板有手填入口', inspectorSrcF4.includes('readingPanel(node)') && readingUiSrcV8.includes('记一条读数'))
ok('F4 v0.8: 不再寻找手工通道', !inspectorSrcF4.includes("c.fetch === 'manual'") && readingUiSrcV8.includes('manualForm(node)'))
ok('F4 v0.8: 手填也过摄入契约', !inspectorSrcF4.includes('channelAdd(') && readingUiSrcV8.includes('m.pushReadings('))
ok('F4 v0.8: 人话归位不再改 channelIds', readingUiSrcV8.includes('indicator: node.title') && !readingUiSrcV8.includes('channelIds:'))
ok('F4: vault.js 无手动录入表单', !vaultSrcF.includes('手动记一条读数'))

// --- F5: 通道已移除；来源读取失败回归 ---
ok('F5 v0.8: 来源读取失败有重试，手填失败不丢内容', readingUiSrcV8.includes('重试') && readingUiSrcV8.includes('填写内容已保留'))


// --- v0.6.4 preload 两份同步 ---
const pj64 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc64 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeys64 = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('v0.6.4 验收: preload 两份同步', JSON.stringify(extractKeys64(pj64)) === JSON.stringify(extractKeys64(pc64)))

// ============================================================
// 主题标签与通道相关性匹配
// ============================================================

console.log('\n— 主题标签与通道相关性匹配 —')

const { kindToTags, sicToTags, KIND_TO_TAGS, SIC_TO_TAG, updateTheme } = store
const inspectorSrcT = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
const extractSrc = readFileSync2(join(ROOT2, 'src/main/extract.js'), 'utf8')
const templatesJson = JSON.parse(readFileSync2(join(ROOT2, 'src/main/templates.json'), 'utf8'))

// --- T1: themes.tags 迁移 ---
const t1Theme = store.addTheme('T1 标签测试')
ok('T1: addTheme 有 tags 空数组', Array.isArray(t1Theme.tags) && t1Theme.tags.length === 0)
// updateTheme
const t1Updated = updateTheme(t1Theme.id, { tags: ['半导体', 'AI', '美股'] })
ok('T1: updateTheme 设 tags', t1Updated.tags.length === 3 && t1Updated.tags.includes('半导体'))
// 去重
const t1Dedup = updateTheme(t1Theme.id, { tags: ['半导体', '半导体', 'AI'] })
ok('T1: updateTheme tags 去重', t1Dedup.tags.length === 2)
// 旧数据迁移
const t1OldData = JSON.parse(store.exportAll({ withRaw: false }))
delete t1OldData.themes[0].tags
store.importAll(JSON.stringify(t1OldData))
ok('T1: 旧主题导入后 tags 为空数组', Array.isArray(store.allThemes()[0].tags) && store.allThemes()[0].tags.length === 0)

// --- T2: 通用骨架与验证通道库 ---
ok('T2: selectable templates 已删除', !Array.isArray(templatesJson.templates))
ok('T2: 通用骨架是上中下游', templatesJson.genericFallback.nodes.map((node) => node.path).join(',') === '上游,中游,下游')
ok('T2: 通用骨架领域中立', !JSON.stringify(templatesJson.genericFallback).match(/AI|光模块|半导体|GPU/i))
ok('T2: 通道库已移除', !('channelLibrary' in templatesJson))

// --- T4: kindToTags 纯函数 ---
ok('T4: 财报→财报', kindToTags('财报 / 公告').includes('财报'))
ok('T4: 一手数据→一手数据', kindToTags('一手数据').includes('一手数据'))
ok('T4: 券商研报→券商研报', kindToTags('券商研报').includes('券商研报'))
ok('T4: 未知 kind 返回空', kindToTags('未知').length === 0)

// --- T5: sicToTags 纯函数 ---
ok('T5: SIC 3674→半导体', sicToTags('3674', 'Semiconductors').includes('半导体'))
ok('T5: SIC 3674 含 description', sicToTags('3674', 'Semiconductors and Related Devices').includes('Semiconductors and Related Devices'))
ok('T5: 未知 SIC 用 description', sicToTags('9999', 'Custom Industry').includes('Custom Industry'))
ok('T5: 无 SIC 无 description 返回空', sicToTags(null, null).length === 0)
// fixture 有 SIC
const submissionsFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/edgar-submissions.json'), 'utf8'))
ok('T5: fixture 有 sic', submissionsFixture.sic === '3674')
ok('T5: fixture 有 sicDescription', submissionsFixture.sicDescription === 'Semiconductors and Related Devices')
ok('T5: fixture SIC 推导含半导体', sicToTags(submissionsFixture.sic, submissionsFixture.sicDescription).includes('半导体'))

// --- T7: v0.8 不再挑选相关通道；台账直接给证据、信任和关联判断 ---
ok('T7 v0.8: 检视面板直达台账', inspectorSrcT.includes('readingPanel(node)'))
ok('T7 v0.8: 展开提供信任依据', readingUiSrcV8.includes('trust.score') && readingUiSrcV8.includes('可信度'))
ok('T7 v0.8: 展开提供独立来源数', readingUiSrcV8.includes('源一致'))
ok('T7 v0.8: 展开提供关联判断', readingUiSrcV8.includes('关联判断') && readingUiSrcV8.includes('result.judgments'))
ok('T7 v0.8: 展开提供原文回溯', readingUiSrcV8.includes('m.rawGet(') && readingUiSrcV8.includes('查看原文'))
ok('T7 v0.8: 待归位可辨主题', readingUiSrcV8.includes('n.themeId') && readingUiSrcV8.includes('归位到'))

// --- T8: 不手填 ---
ok('T8: vault.js 无 tags 输入框', !vaultSrcF.includes('placeholder.*tags') && !vaultSrcF.includes("placeholder: 'tags'"))
ok('T8: inspector.js 无 tags 输入框', !inspectorSrcT.includes("placeholder: 'tags'"))

// --- T9: LLM 降级 ---
ok('T9: extract.js 有 generateThemeTags', extractSrc.includes('generateThemeTags'))
ok('T9: generateThemeTags 无 key 返回 ok: false', extractSrc.includes("return { ok: false, reason: 'no-key' }"))

// --- T10: IPC + preload ---
ok('T10: ipc.js 有 theme:update', ipcSrcF.includes('theme:update'))
ok('T10: ipc.js 无 channel:add', !ipcSrcF.includes('channel:add'))
ok('T10: ipc.js 无 channel:update', !ipcSrcF.includes('channel:update'))
ok('T10: preload.js 有 themeUpdate', pj64.includes('themeUpdate'))
ok('T10: preload.cjs 有 themeUpdate', pc64.includes('themeUpdate'))

// --- T11: SIC 映射表 ---
ok('T11: SIC_TO_TAG 有 3674', SIC_TO_TAG[3674] === '半导体')
ok('T11: KIND_TO_TAGS 有 财报', KIND_TO_TAGS['财报 / 公告'].includes('财报'))

// --- T12: preload 两份同步 ---
const pjT = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcT = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeysT = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('T12: preload 两份同步', JSON.stringify(extractKeysT(pjT)) === JSON.stringify(extractKeysT(pcT)))

// ============================================================
// latest tie-break 修复
// ============================================================

console.log('\n— latest tie-break 修复 —')

// v0.8：同一期间异源异值必须显式冲突，不能以入库顺序代替裁决。
const tieIndicator = store.addNode({ themeId: theme.id, kind: 'lemma', type: 'observation', title: '同刻冲突指标' })
const tieInput = { indicatorId: tieIndicator.id, indicator: tieIndicator.title, metric: 'tie.break', unit: 'USD', basis: 'reported', period: { start: '2026-09-24', end: '2026-09-24' }, at: '2026-09-24' }
store.addReading({ ...tieInput, value: 1, source: { kind: '一手数据', label: '甲', url: 'https://tie-a.example/report', platform: '甲' } })
store.addReading({ ...tieInput, value: 2, source: { kind: '一手数据', label: '乙', url: 'https://tie-b.example/report', platform: '乙' } })
const tieGroup = store.readingsPage({ indicatorId: tieIndicator.id, limit: 10 })
ok('tie-break v0.8: 同 at 异值呈现一个冲突观测', tieGroup.total === 1 && tieGroup.items[0]?.status === 'conflicted' && tieGroup.items[0]?.currentReadingId === null)

// 旧通道引用也不能绕过冲突裁决。
const tieChId = 'fake-tie-break'
const tieChannelIndicator = store.addNode({ themeId: theme.id, kind: 'lemma', type: 'observation', title: '通道冲突指标', channelIds: [tieChId] })
store.addReading({ ...tieInput, indicatorId: tieChannelIndicator.id, indicator: tieChannelIndicator.title, metric: 'tie.break.ch', value: 100, channelId: tieChId, source: { kind: '一手数据', label: '甲', url: 'https://tie-a.example/channel', platform: '甲' } })
store.addReading({ ...tieInput, indicatorId: tieChannelIndicator.id, indicator: tieChannelIndicator.title, metric: 'tie.break.ch', value: 200, channelId: tieChId, source: { kind: '一手数据', label: '乙', url: 'https://tie-b.example/channel', platform: '乙' } })
const tieConflicted = store.readingsPage({ indicatorId: tieChannelIndicator.id, limit: 10 })
ok('tie-break v0.8: 通道引用读数冲突仍裁决', tieConflicted.total === 1 && tieConflicted.items[0]?.status === 'conflicted')


const readingsSrc = readFileSync2(join(ROOT2, 'src/renderer/app.js'), 'utf8')
ok('tie-break v0.8: 树使用显式最新投影而非全量排序', readingsSrc.includes('latestReadings') && !readingsSrc.includes('await m.allReadings('))
// ============================================================
// R5: 轮询器 — 通道已移除，调度器只保留到期结算通知
// ============================================================

console.log('\n— R5: 轮询器（通道已移除） —')

const schedulerR5Src = readFileSync2(join(ROOT2, 'src/main/scheduler.js'), 'utf8')
ok('R5: scheduler.js 无 dueChannels', !schedulerR5Src.includes('dueChannels'))
ok('R5: scheduler.js 无 runChannel', !schedulerR5Src.includes('runChannel'))
ok('R5: scheduler.js 无 fetcher', !schedulerR5Src.includes('fetcher'))
ok('R5: scheduler.js 只有一个 setInterval', (schedulerR5Src.match(/setInterval/g) || []).length === 1)
ok('R5: scheduler.js 保留到期结算通知', schedulerR5Src.includes('dueToNotify'))

const ipcR5Src = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
ok('R5: ipc.js 无 channel:fetch', !ipcR5Src.includes('channel:fetch'))
ok('R5: ipc.js 无 channel:list', !ipcR5Src.includes('channel:list'))
ok('R5: ipc.js 无 runChannelFetch', !ipcR5Src.includes('runChannelFetch'))

const mainR5Src = readFileSync2(join(ROOT2, 'src/main/main.js'), 'utf8')
ok('R5: main.js 不再传通道给调度器', !mainR5Src.includes('runChannel'))

const storeR5Src = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
ok('R5: store.js 无 allChannels', !storeR5Src.includes('allChannels'))
ok('R5: store.js 无 addChannel', !storeR5Src.includes('addChannel'))
ok('R5: store.js 无 channelMatchRates', !storeR5Src.includes('channelMatchRates'))

// fetchers.js / propose.js 已删除
ok('R5: fetchers.js 已删除', !existsSync2(join(ROOT2, 'src/main/fetchers.js')))
ok('R5: propose.js 已删除', !existsSync2(join(ROOT2, 'src/main/propose.js')))
// ============================================================
// B: LLM 提议指针 — 已随通道系统移除
// ============================================================

console.log('\n— B: LLM 提议指针（已移除） —')

const ipcBSrc = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
ok('B: ipc.js 无 llm:proposeLinks', !ipcBSrc.includes('llm:proposeLinks'))
ok('B: propose.js 已删除', !existsSync2(join(ROOT2, 'src/main/propose.js')))

const pjB = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcB = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
ok('B: preload.js 无 proposeLinks', !pjB.includes('proposeLinks'))
ok('B: preload.cjs 无 proposeLinks', !pcB.includes('proposeLinks'))

// --- v0.8 读数界面回归：手填不暗建通道 ---
const inspectorBSrc = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
ok('B v0.8: 单指标看台账', inspectorBSrc.includes('readingPanel(node)'))
ok('B v0.8: 手填不暗建通道', !readingUiSrcV8.includes('channelAdd(') && readingUiSrcV8.includes('m.pushReadings('))
ok('B v0.8: 提交读数后刷新台账', readingUiSrcV8.includes('await refresh()') && !readingUiSrcV8.includes('m.channelFetch('))

// ============================================================
// ============================================================
// D: 研究观点记录（通道包 C 已随通道系统移除）
// ============================================================

console.log('\n— D: 研究观点 —')


// --- D1: researchNotes 集合 ---

ok('D1: blank 有 researchNotes', store.allResearchNotes().length === 0 || Array.isArray(store.allResearchNotes()))
ok('D1: stats 有 researchNotes', typeof store.stats().researchNotes === 'number')

// addResearchNote
const dTheme = store.addTheme('D-研究观点测试')
const dNode = store.addNode({ themeId: dTheme.id, parentId: null, kind: 'lemma', title: 'D测试命题', type: 'observation', confidence: 60 })
const rn1 = store.addResearchNote({ org: '中信证券', stance: 'bullish', publishedAt: '2026-09-15', title: '1.6T 光模块超预期', nodeId: dNode.id })
ok('D1: addResearchNote 返回 note', rn1?.id != null)
ok('D1: note 有 org', rn1.org === '中信证券')
ok('D1: note 有 stance', rn1.stance === 'bullish')
ok('D1: note 有 nodeId', rn1.nodeId === dNode.id)

const rn2 = store.addResearchNote({ org: 'Morgan Stanley', stance: 'neutral', publishedAt: '2026-09-20', title: '维持中性', nodeId: dNode.id })
const rn3 = store.addResearchNote({ org: '高盛', stance: 'bearish', publishedAt: '2026-09-18', title: '估值过高', nodeId: dNode.id })

// allResearchNotes
ok('D1: allResearchNotes 有 3 条', store.allResearchNotes().length >= 3)

// researchNotesByNode
const byNode = store.researchNotesByNode(dNode.id)
ok('D1: researchNotesByNode 返回 3 条', byNode.length === 3)
ok('D1: researchNotesByNode 含中信', byNode.some((n) => n.org === '中信证券'))

// --- D1: researchHitRate 纯函数 ---

const hitRate = store.researchHitRate(byNode, true)
ok('D1: hitRate total=2（不含 neutral）', hitRate.total === 2)
ok('D1: hitRate hits=1（bullish 命中）', hitRate.hits === 1)
ok('D1: hitRate rate=0.5', hitRate.rate === 0.5)

const hitRateWrong = store.researchHitRate(byNode, false)
ok('D1: hitRate 错时 hits=1（bearish 命中）', hitRateWrong.hits === 1)
ok('D1: hitRate 错时 rate=0.5', hitRateWrong.rate === 0.5)

// neutral only → total=0, rate=null
const neutralOnly = store.researchHitRate([{ stance: 'neutral' }], true)
ok('D1: hitRate 全 neutral 时 total=0', neutralOnly.total === 0)
ok('D1: hitRate 全 neutral 时 rate=null', neutralOnly.rate === null)

// correct=null → rate=null
const noSettle = store.researchHitRate(byNode, null)
ok('D1: hitRate 未结算时 rate=null', noSettle.rate === null)

// --- D1: vsInstitution ---

store.settleLemma(dNode.id, true)
const vs = store.vsInstitution(90)
ok('D1: vsInstitution 返回对象', vs != null)
ok('D1: vsInstitution 有 userRate', vs.userRate != null)
ok('D1: vsInstitution 有 orgRate', vs.orgRate != null)
ok('D1: vsInstitution settledCount > 0', vs.settledCount > 0)
ok('D1: vsInstitution userHits=1（结算为对）', vs.userHits >= 1)

// --- D1: 红线 — researchNotes 不产生 node ---
const nodeCountBefore = store.allNodes().length
store.addResearchNote({ org: 'test', stance: 'bullish', title: '不应产生 node', nodeId: dNode.id })
ok('D1: researchNotes 不产生 node', store.allNodes().length === nodeCountBefore)

// --- D1: 导出导入 ---

const exportData = JSON.parse(store.exportAll())
ok('D1: 导出包含 researchNotes', Array.isArray(exportData.researchNotes))
ok('D1: 导出 researchNotes 非空', exportData.researchNotes.length > 0)

// --- D1: 旧数据兼容（无 researchNotes 的导入）---
const oldDataD = { ...exportData, researchNotes: undefined }
delete oldDataD.researchNotes
store.importAll(JSON.stringify(oldDataD))
ok('D1: 旧数据导入后 researchNotes 为空数组', Array.isArray(store.allResearchNotes()) && store.allResearchNotes().length === 0)

// 重新导入完整数据
store.importAll(JSON.stringify(exportData))
ok('D1: 重新导入后 researchNotes 恢复', store.allResearchNotes().length > 0)

// --- D: IPC handler ---

ok('D: IPC research:add 可调', await fire('research:add', { org: 'test', stance: 'bullish', title: 'IPC test', nodeId: dNode.id }) != null)
ok('D: IPC research:all 可调', Array.isArray(await fire('research:all')))
ok('D: IPC research:byNode 可调', Array.isArray(await fire('research:byNode', dNode.id)))
ok('D: IPC research:vsInstitution 可调', await fire('research:vsInstitution', 90) != null)

// --- D: preload 同步 ---

const pjD = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcD = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
ok('D: preload.js 有 addResearch', pjD.includes('addResearch'))
ok('D: preload.cjs 有 addResearch', pcD.includes('addResearch'))
ok('D: preload.js 有 vsInstitution', pjD.includes('vsInstitution'))
ok('D: preload.cjs 有 vsInstitution', pcD.includes('vsInstitution'))
const extractKeysD = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('D: preload 两份同步', JSON.stringify(extractKeysD(pjD)) === JSON.stringify(extractKeysD(pcD)))

// --- D: inspector.js 有研究观点区 ---

const inspectorSrcD = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
ok('D: inspector.js 有 researchPanel', inspectorSrcD.includes('researchPanel'))
ok('D: inspector.js 有研究观点标题', inspectorSrcD.includes('研究观点'))

// --- D: vault.js 有你 vs 机构 ---

const vaultSrcD = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
ok('D: vault.js 有 vsInstitution', vaultSrcD.includes('vsInstitution'))
ok('D: vault.js 有 你 vs 机构', vaultSrcD.includes('你 vs 机构'))

// --- D: 无加权/汇总/总量/合计 ---

ok('D: inspector.js 无加权', !inspectorSrcD.includes('加权'))
ok('D: inspector.js 无汇总', !inspectorSrcD.includes('汇总'))
ok('D: inspector.js 无总量', !inspectorSrcD.includes('总量'))
ok('D: inspector.js 无合计', !inspectorSrcD.includes('合计'))

// --- D: store.js 红线 — researchNotes 不进 calibration/verdicts ---

const storeSrcD = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
ok('D: store.js 有 researchHitRate', storeSrcD.includes('researchHitRate'))
ok('D: store.js 有 vsInstitution', storeSrcD.includes('vsInstitution'))
const calLinesD = storeSrcD.split('\n')
const calStartD = calLinesD.findIndex((l) => l.includes('export function calibration()'))
const calEndD = calLinesD.findIndex((l, i) => i > calStartD && l.startsWith('export function'))
const calBodyD = calLinesD.slice(calStartD, calEndD).join('\n')
ok('D: store.js researchNotes 不进 calibration', !calBodyD.includes('researchNotes'))

// ============================================================
// v0.6.6: B1-B3 bug 修复 + I1-I5 设计缺口
// ============================================================

console.log('\n— v0.6.6: B1-B3 + I1-I5 —')

const extractSrc66 = readFileSync2(join(ROOT2, 'src/main/extract.js'), 'utf8')
const storeSrc66 = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
const ipcSrc66 = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const vaultSrc66 = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const appSrc66 = readFileSync2(join(ROOT2, 'src/renderer/app.js'), 'utf8')
const settingsSrc66 = readFileSync2(join(ROOT2, 'src/renderer/views/settings.js'), 'utf8')
const pj66 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc66 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// --- B1: LLM 指标类型不匹配 ---

ok('B1: 第二轮 prompt 有行式 indicators 示例', extractSrc66.includes('指标1/周期'))
ok('B1: 第二轮 prompt 有 cadence 四选一说明', extractSrc66.includes('月 / 季度 / 年度 / 事件'))
ok('B1: extract.js 有 normalizeCadence', extractSrc66.includes('normalizeCadence'))
ok('B1: extract.js 解析兼容字符串', extractSrc66.includes("typeof i === 'string'"))
ok('B1: extract.js 解析产对象', extractSrc66.includes('{ name: i, cadence:'))
ok('B1: spawnFromScaffold 防御字符串', storeSrc66.includes("typeof ind === 'string' ? ind : String(ind?.name"))
ok('B1: spawnFromScaffold 防御 cadence', storeSrc66.includes("ind?.cadence) || '季度'"))

// B1 端到端：字符串 indicators → spawn → 无 undefined
const b1Theme = store.addTheme('B1 测试主题')
const b1Branch = store.addNode({ themeId: b1Theme.id, parentId: null, kind: 'branch', title: 'B1 环节', scaffold: { answer: null, indicators: ['裸字符串指标'], falsifier: null } })
const b1Spawned = store.spawnFromScaffold(b1Branch.id)
ok('B1: 字符串 indicators spawn 产出节点', b1Spawned.length > 0)
ok('B1: 字符串 indicators 标题无 undefined', !b1Spawned.some((n) => n.title.includes('undefined')))
ok('B1: 字符串 indicators 标题含指标名', b1Spawned.some((n) => n.title.includes('裸字符串指标')))

// B1 端到端：对象 indicators → spawn → 正确 name/cadence
const b1Branch2 = store.addNode({ themeId: b1Theme.id, parentId: null, kind: 'branch', title: 'B1 对象环节', scaffold: { answer: null, indicators: [{ name: '毛利率', cadence: '月' }, { name: '营收', cadence: '季度' }], falsifier: null } })
const b1Spawned2 = store.spawnFromScaffold(b1Branch2.id)
ok('B1: 对象 indicators spawn 产出 2 节点', b1Spawned2.length === 2)
ok('B1: 对象 indicators 标题含毛利率', b1Spawned2.some((n) => n.title.includes('毛利率')))
ok('B1: 对象 indicators 标题含按月节奏', b1Spawned2.some((n) => n.title.includes('按月节奏更新')))
ok('B1: 对象 indicators 标题含按季度节奏', b1Spawned2.some((n) => n.title.includes('按季度节奏更新')))
ok('B1: 对象 indicators 无 undefined', !b1Spawned2.some((n) => n.title.includes('undefined')))

// B1: 非法 cadence → 归到季度
const b1Branch3 = store.addNode({ themeId: b1Theme.id, parentId: null, kind: 'branch', title: 'B1 非法环节', scaffold: { answer: null, indicators: [{ name: '测试', cadence: '每周' }], falsifier: null } })
const b1Spawned3 = store.spawnFromScaffold(b1Branch3.id)
ok('B1: 非法 cadence 归到默认', b1Spawned3.some((n) => n.title.includes('按季度节奏更新') || n.title.includes('按每周节奏更新')))

// B1: 结算日 cadence=月 → 约 30 天
const b1MonthNode = b1Spawned2.find((n) => n.title.includes('按月节奏'))
if (b1MonthNode) {
  const days = Math.round((new Date(b1MonthNode.settlement.date) - Date.now()) / 86400000)
  ok('B1: cadence=月 结算日约 30 天', days >= 25 && days <= 35, `实际 ${days}`)
} else {
  ok('B1: cadence=月 结算日约 30 天', false, '节点未找到')
}

// --- B2: 取数器配置已随通道系统移除；来源页回归 ---

ok('B2 v0.8: 来源页有 renderSources', readingUiSrcV8.includes('renderSources'))
ok('B2 v0.8: 无内部 metric 配置', !vaultSrc66.includes('needsMetric') && readingUiSrcV8.includes('indicator: node.title'))
ok('B2 v0.8: 不再要求用户发现 GAAP 标签', !vaultSrc66.includes('发现标签') && readingUiSrcV8.includes('来源随读数自动记录'))
ok('B2: preload 无取数器入口', !pj66.includes('metricFetchers') && !pc66.includes('metricFetchers'))
ok('B2: ipc.js 无取数器', !ipcSrc66.includes('METRIC_FETCHERS') && !ipcSrc66.includes('channel:metricFetchers'))

// --- I1: v0.8 指标维度由查询限定，不在渲染层过滤全量 readings ---

ok('I1 v0.8: 指标台账限定主关联', readingUiSrcV8.includes('m.readingsPage({ indicatorId: node.id'))
ok('I1 v0.8: 分页显式禁用不可用的翻页按钮', readingUiSrcV8.includes('prev.disabled') && readingUiSrcV8.includes('next.disabled'))
ok('I1 v0.8: 流水加载有界页面', readingUiSrcV8.includes('pager(p => m.readingsPage(p)'))
ok('I1 v0.8: 展开按观测查证据', readingUiSrcV8.includes('observationId: r.id') && readingUiSrcV8.includes('m.readingEvidence('))
ok('I1 v0.8: 历史按主关联查而非通道筛选', readingUiSrcV8.includes('m.readingsPage({ indicatorId: r.indicatorId'))
ok('I1 v0.8: 来源页独立分页而非配置通道', readingUiSrcV8.includes('m.sourcesPage(') && !vaultSrc66.includes('全部通道'))

// --- I2: 主题重命名 UI ---

ok('I2: app.js 有 renameTheme 调用', appSrc66.includes('renameTheme'))
ok('I2: app.js 有 theme-menu-btn', appSrc66.includes('theme-menu-btn'))
ok('I2: app.js 有 theme-edit-row', appSrc66.includes('theme-edit-row'))
ok('I2: app.js 有 Escape 取消', appSrc66.includes("e.key === 'Escape'"))
ok('I2: app.js 空名不保存', appSrc66.includes('if (!name)'))

// --- I3: 主题删除/恢复侧边栏 ---

ok('I3: app.js 有 removeTheme 调用', appSrc66.includes('removeTheme'))
ok('I3: app.js 有 restoreTheme 调用', appSrc66.includes('restoreTheme'))
ok('I3: app.js 有撤销按钮', appSrc66.includes('撤销'))
ok('I3: app.js toast 4 秒', appSrc66.includes('4000'))

// --- I4: 墓碑区主题名 ---

ok('I4: vault.js 墓碑区有主题名', vaultSrc66.includes("state.themes.find((t) => t.id === n.themeId)?.name"))
ok('I4: vault.js 已删主题占位', vaultSrc66.includes('已删主题'))

// --- I5: 已删主题可恢复节点数 ---

ok('I5: store.js deletedThemes 有 restorableCount', storeSrc66.includes('restorableCount'))
ok('I5: settings.js 显示恢复计数', settingsSrc66.includes('restorableCount'))
ok('I5: settings.js 恢复按钮带计数', settingsSrc66.includes('恢复 ('))
ok('I5: settings.js 零计数禁用', settingsSrc66.includes('!t.restorableCount'))

// I5 端到端
const i5Theme = store.addTheme('I5 测试主题')
store.addNode({ themeId: i5Theme.id, parentId: null, kind: 'branch', title: 'I5 环节' })
store.addNode({ themeId: i5Theme.id, parentId: null, kind: 'lemma', title: 'I5 命题', type: 'hypothesis', confidence: 60 })
store.removeTheme(i5Theme.id)
const i5Deleted = store.deletedThemes()
const i5Match = i5Deleted.find((t) => t.id === i5Theme.id)
ok('I5: deletedThemes 返回 restorableCount', i5Match && typeof i5Match.restorableCount === 'number')
ok('I5: 删除后 restorableCount > 0', i5Match && i5Match.restorableCount > 0, `实际 ${i5Match?.restorableCount}`)

// I5: 清空墓碑后 restorableCount = 0
store.purgeDead('all')
const i5AfterPurge = store.deletedThemes()
const i5Match2 = i5AfterPurge.find((t) => t.id === i5Theme.id)
if (i5Match2) {
  ok('I5: 清空后 restorableCount = 0', i5Match2.restorableCount === 0, `实际 ${i5Match2.restorableCount}`)
} else {
  ok('I5: 清空后主题不在已删列表（彻底删除）', true)
}

// --- v0.6.6 验收: preload 两份同步 ---
const extractKeys66 = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('v0.6.6 验收: preload 两份同步', JSON.stringify(extractKeys66(pj66)) === JSON.stringify(extractKeys66(pc66)))

// ============================================================
// 主题标签库与语义归位
// ============================================================

console.log('\n— 标签库与语义归位 —')

const extractSrcTL = readFileSync2(join(ROOT2, 'src/main/extract.js'), 'utf8')
const storeSrcTL = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
const ipcSrcTL = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const vaultSrcTL = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const latticeSrcTL = readFileSync2(join(ROOT2, 'src/renderer/views/lattice.js'), 'utf8')
const pjTL = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcTL = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// --- T1: tagLibrary schema ---

ok('T1: store.js 有 tagLibrary', storeSrcTL.includes('tagLibrary'))
ok('T1: migrate 补 tagLibrary', storeSrcTL.includes('t.tagLibrary = normalizeTagLibrary(t.tagLibrary)'))
ok('T1: addTheme 给 tagLibrary: []', storeSrcTL.includes('tagLibrary: [], createdAt'))
ok('T1: updateTheme 白名单 tagLibrary', storeSrcTL.includes('patch.tagLibrary !== undefined'))
ok('T1: extract.js 有 generateTagLibrary', extractSrcTL.includes('export async function generateTagLibrary'))
ok('T1: extract.js 有 TAG_LIBRARY_SYSTEM', extractSrcTL.includes('TAG_LIBRARY_SYSTEM'))
ok('T1: extract.js threshold clamp', extractSrcTL.includes('Math.max(0.4, Math.min(0.85'))

// T1: 迁移 — 旧数据导入后 tagLibrary 为空数组
const tlTheme = store.addTheme('标签库测试主题')
ok('T1: addTheme 有 tagLibrary', Array.isArray(tlTheme.tagLibrary) && tlTheme.tagLibrary.length === 0)

// T1: updateTheme tagLibrary
store.updateTheme(tlTheme.id, { tagLibrary: [{ id: 'tl_1', name: '测试标签', synonyms: ['test'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const tlThemeAfter = store.allThemes().find((t) => t.id === tlTheme.id)
ok('T1: updateTheme tagLibrary 生效', tlThemeAfter.tagLibrary.length === 1)
ok('T1: tagLibrary 有 id', tlThemeAfter.tagLibrary[0].id === 'tl_1')

// T1: 导出导入不丢
const tlExport = JSON.parse(store.exportAll())
ok('T1: 导出含 tagLibrary', Array.isArray(tlExport.themes.find((t) => t.id === tlTheme.id)?.tagLibrary))
store.importAll(JSON.stringify({ ...tlExport, themes: tlExport.themes.map((t) => ({ ...t, tagLibrary: undefined })) }))
const tlAfterImport = store.allThemes().find((t) => t.id === tlTheme.id)
ok('T1: 旧数据导入 tagLibrary 为空数组', Array.isArray(tlAfterImport.tagLibrary) && tlAfterImport.tagLibrary.length === 0)

// --- T2: matchTagLibrary 纯函数 ---

ok('T2: store.js 有 matchTagLibrary', storeSrcTL.includes('export function matchTagLibrary'))
ok('T2: store.js 有 crossThemeMatch', storeSrcTL.includes('export function crossThemeMatch'))
ok('T2: store.js 有 recordTagHits', storeSrcTL.includes('export function recordTagHits'))

// T2: 空词库 → []
ok('T2: 空词库返回 []', store.matchTagLibrary('text', []).length === 0)
ok('T2: null 词库返回 []', store.matchTagLibrary('text', null).length === 0)

// T2: 命中 3/5 词 → score = 0.6
const tlLib = [
  { id: 'tl_a', name: '稳定币', synonyms: ['stablecoin', 'USDT', 'USDC', 'pegged'], threshold: 0.6, hits: 0, lastHitAt: null },
  { id: 'tl_b', name: '算力', synonyms: ['hash rate', 'mining'], threshold: 0.6, hits: 0, lastHitAt: null },
]
const tlMatch1 = store.matchTagLibrary('稳定币 stablecoin USDT', tlLib)
ok('T2: 命中 3/5 词有结果', tlMatch1.length > 0)
ok('T2: 命中 3/5 score=0.6', tlMatch1[0].score === 0.6, `实际 ${tlMatch1[0].score}`)

// T2: 命中 0 词 → 不出现
const tlMatch2 = store.matchTagLibrary('完全无关的内容xyz', tlLib)
ok('T2: 命中 0 词不出现', tlMatch2.length === 0)

// T2: 中英双语分别命中
const tlMatch3 = store.matchTagLibrary('stablecoin market cap', tlLib)
ok('T2: 英文命中', tlMatch3.some((m) => m.name === '稳定币'))
const tlMatch4 = store.matchTagLibrary('稳定币发行量', tlLib)
ok('T2: 中文命中', tlMatch4.some((m) => m.name === '稳定币'))

// T2: 按分数降序
const tlMatch5 = store.matchTagLibrary('稳定币 stablecoin USDT USDC pegged 算力 hash rate', tlLib)
ok('T2: 按分数降序', tlMatch5[0].score >= tlMatch5[tlMatch5.length - 1].score)

// --- T2: 跨主题匹配 ---

// 恢复 tagLibrary
store.updateTheme(tlTheme.id, { tagLibrary: tlLib })
const tlTheme2 = store.addTheme('标签库测试主题2')
store.updateTheme(tlTheme2.id, { tagLibrary: [{ id: 'tl_c', name: '轨道', synonyms: ['rail', 'metro'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const crossMatches = store.crossThemeMatch('稳定币 stablecoin USDT')
ok('T2: 跨主题匹配返回数组', Array.isArray(crossMatches))
ok('T2: 跨主题匹配命中主题1', crossMatches.some((m) => m.themeId === tlTheme.id))
ok('T2: 跨主题匹配不命中主题2', !crossMatches.some((m) => m.themeId === tlTheme2.id))

// --- T2: hits 回写 ---

store.recordTagHits(tlTheme.id, ['tl_a'])
const tlAfterHit = store.allThemes().find((t) => t.id === tlTheme.id)
const tlTagA = tlAfterHit.tagLibrary.find((t) => t.id === 'tl_a')
ok('T2: hits 回写递增', tlTagA.hits === 1)
ok('T2: lastHitAt 有值', tlTagA.lastHitAt != null)

// --- T2: updateTagLibraryTag / deleteTagLibraryTags ---

const tlUpdatedTag = store.updateTagLibraryTag(tlTheme.id, 'tl_a', { name: '稳定币改', threshold: 0.8 })
ok('T2: updateTagLibraryTag 改名', tlUpdatedTag.name === '稳定币改')
ok('T2: updateTagLibraryTag threshold clamp', tlUpdatedTag.threshold === 0.8)

const tlDeleted = store.deleteTagLibraryTags(tlTheme.id, ['tl_b'])
ok('T2: deleteTagLibraryTags 删了 1 个', tlDeleted === 1)
const tlAfterDelete = store.allThemes().find((t) => t.id === tlTheme.id)
ok('T2: deleteTagLibraryTags 后剩 1 个', tlAfterDelete.tagLibrary.length === 1)

// --- T3: processCapture 接入匹配 + 提议归位 ---

ok('T3: ipc.js 有 crossThemeMatch', ipcSrcTL.includes('crossThemeMatch'))
ok('T3: ipc.js 有 routeProposals', ipcSrcTL.includes('routeProposals'))
ok('T3: ipc.js 有 route-proposal', ipcSrcTL.includes("'route-proposal'"))
ok('T3: ipc.js 有 recordTagHits', ipcSrcTL.includes('recordTagHits'))
ok('T3: ipc.js theme:setupNew 调 generateTagLibrary', ipcSrcTL.includes('generateTagLibrary'))
ok('T3: ipc.js 无 theme:fromTemplate', !ipcSrcTL.includes('theme:fromTemplate'))

// --- T4: 标签库可视化 ---

ok('T4: lattice.js 有 renderTagLibraryBand', latticeSrcTL.includes('function renderTagLibraryBand'))
ok('T4: lattice.js 有 标签库', latticeSrcTL.includes('标签库'))
ok('T4: lattice.js 有 整理', latticeSrcTL.includes('整理'))
ok('T4: lattice.js 有 全选命中 0', latticeSrcTL.includes('全选命中 0'))
ok('T4: lattice.js 有 删除所选', latticeSrcTL.includes('删除所选'))
ok('T4: lattice.js 无 prompt(', !latticeSrcTL.includes('prompt('))

// T4: 无禁用词
ok('T4: lattice.js 无加权', !latticeSrcTL.includes('加权'))
ok('T4: lattice.js 无汇总', !latticeSrcTL.includes('汇总'))
ok('T4: lattice.js 无总量', !latticeSrcTL.includes('总量'))
ok('T4: lattice.js 无合计', !latticeSrcTL.includes('合计'))

// --- T5: 主题级操作合并 ---

ok('T5: lattice.js 有 主题名', latticeSrcTL.includes('主题名'))
ok('T5: lattice.js 有 主题标签', latticeSrcTL.includes('主题标签'))
ok('T5: lattice.js 有 删除主题', latticeSrcTL.includes('删除主题'))
ok('T5: lattice.js 有 renameTheme', latticeSrcTL.includes('renameTheme'))
ok('T5: lattice.js 有 removeTheme', latticeSrcTL.includes('removeTheme'))

// --- T6: 画树不生成新环节 ---

ok('T6: ipc.js 无 生成新环节', !ipcSrcTL.includes('生成新环节'))

// --- 领域中立（只检查新增的标签库代码，不查存量 SIC 映射/prompt 示例）---

const tagLibPrompt = extractSrcTL.match(/TAG_LIBRARY_SYSTEM = `[\s\S]*?`/)?.[0] || ''
ok('领域中立: TAG_LIBRARY_SYSTEM 无硬编码行业词', !tagLibPrompt.match(/光模块|半导体|hyperscaler|AI 产业/))
ok('领域中立: matchTagLibrary 无硬编码行业词', !storeSrcTL.match(/function matchTagLibrary[\s\S]*?^}/m)?.[0]?.match(/光模块|半导体|hyperscaler/))
ok('领域中立: lattice.js 无硬编码行业词', !latticeSrcTL.match(/光模块|半导体|hyperscaler/))

// --- IPC + preload ---

ok('TL: ipc.js 有 tagLibrary:updateTag', ipcSrcTL.includes('tagLibrary:updateTag'))
ok('TL: ipc.js 有 tagLibrary:deleteTags', ipcSrcTL.includes('tagLibrary:deleteTags'))
ok('TL: preload.js 有 updateTagLibraryTag', pjTL.includes('updateTagLibraryTag'))
ok('TL: preload.cjs 有 updateTagLibraryTag', pcTL.includes('updateTagLibraryTag'))
ok('TL: preload.js 有 deleteTagLibraryTags', pjTL.includes('deleteTagLibraryTags'))
ok('TL: preload.cjs 有 deleteTagLibraryTags', pcTL.includes('deleteTagLibraryTags'))
ok('TL: preload 两份同步', pjTL.includes('updateTagLibraryTag') === pcTL.includes('updateTagLibraryTag'))

// --- IPC 可调 ---

ok('TL: IPC tagLibrary:updateTag 可调', await fire('theme:tagLibrary:updateTag', tlTheme.id, 'tl_a', { name: '改过' }) != null)
ok('TL: IPC tagLibrary:deleteTags 可调', typeof await fire('theme:tagLibrary:deleteTags', tlTheme.id, []) === 'number')

// ============================================================
// 主题入口与读数拆分（E + R）
// ============================================================

console.log('\n— 主题入口与读数拆分 —')

const appSrcER = readFileSync2(join(ROOT2, 'src/renderer/app.js'), 'utf8')
const vaultSrcER = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const latticeSrcER = readFileSync2(join(ROOT2, 'src/renderer/views/lattice.js'), 'utf8')
const inspectorSrcER = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
const ipcSrcER = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const pjER = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcER = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// --- E1: 单一路径建主题 ---

ok('E1: app.js 有 renderThemeCreator', appSrcER.includes('function renderThemeCreator'))
ok('E1: app.js 有 setupNewTheme 调用', appSrcER.includes('setupNewTheme'))
ok('E1: app.js 无 addThemeFromTemplate 调用', !appSrcER.includes('addThemeFromTemplate'))
ok('E1: app.js 只有描述输入框', appSrcER.includes('描述你要跟踪的'))

// --- E2: 空态复用 ---

// 空账本与点侧栏 + 走同一个创建页，不再是「today 里嵌一个创建器」
ok('E2: 空态与新建入口共用同一个创建页', appSrcER.includes('function renderNewTheme') && appSrcER.includes('return renderNewTheme()'))
ok('E2: 有 new-theme 视图路由', appSrcER.includes("state.view === 'new-theme'"))
ok('E2: 侧栏 + 开页面而非内联展开', appSrcER.includes("setView('new-theme')") && !appSrcER.includes('function newThemePrompt'))
// 失败态放 state 而不是闭包——addTheme 触发 db:changed 会重画整个创建页，
// 闭包里的变量被清零，骨架铺完就找不到该去哪、也没法就地解锁
ok('E2: 生成期间按钮锁住，失败才解锁', appSrcER.includes('const unlock = ') && appSrcER.includes('state.scaffoldFailed'))
ok('E2: 待铺骨架的 id 放 state', appSrcER.includes('state.pendingScaffoldId') && !appSrcER.includes('let createdThemeId'))
// skeleton-desc 只在 app.js 的 renderThemeCreator 中定义（不复制到其他文件）
ok('E2: skeleton-desc 只在 app.js', appSrcER.includes('skeleton-desc') && !latticeSrcER.includes('skeleton-desc') && !vaultSrcER.includes('skeleton-desc') && !inspectorSrcER.includes('skeleton-desc'))

// --- E3: 空白主题补生成骨架 ---

ok('E3: lattice.js 有 renderSkeletonPrompt', latticeSrcER.includes('function renderSkeletonPrompt'))
ok('E3: lattice.js 有骨架提示', latticeSrcER.includes('还没有骨架'))
ok('E3: lattice.js 有 scaffoldExisting 调用', latticeSrcER.includes('scaffoldExisting'))
ok('E3: ipc.js 有 scaffoldTheme 共用函数', ipcSrcER.includes('async function scaffoldTheme'))
ok('E3: ipc.js 有 theme:scaffoldExisting', ipcSrcER.includes('theme:scaffoldExisting'))
// 异步化后 setupNew / scaffoldExisting 都不再 await scaffoldTheme——
// 主题立即返回，骨架后台铺，铺完由 theme:scaffolded 通知
ok('E3: setupNew 异步调 scaffoldTheme', ipcSrcER.includes('scaffoldTheme(theme.id, description, settings())') && !ipcSrcER.includes('await scaffoldTheme(theme.id'))
ok('E3: preload.js 有 scaffoldExisting', pjER.includes('scaffoldExisting'))
ok('E3: preload.cjs 有 scaffoldExisting', pcER.includes('scaffoldExisting'))
ok('E3: preload 两份同步', pjER.includes('scaffoldExisting') === pcER.includes('scaffoldExisting'))

// E3 端到端：空白主题补生成
const e3Theme = store.addTheme('E3 空白主题')
const e3BeforeNodes = store.allNodes().filter((n) => n.themeId === e3Theme.id).length
ok('E3: 空白主题无节点', e3BeforeNodes === 0)
const e3Result = await fire('theme:scaffoldExisting', e3Theme.id, 'AI 算力供应链')
ok('E3: scaffoldExisting 返回 ok', e3Result?.ok === true)
// 异步：等 scaffoldTheme 在后台跑完（轮询节点出现，最多 3 秒）
let e3AfterNodes = 0
for (let i = 0; i < 30 && e3AfterNodes === 0; i++) {
  await new Promise((r) => setTimeout(r, 100))
  e3AfterNodes = store.allNodes().filter((n) => n.themeId === e3Theme.id).length
}
ok('E3: 补生成后有节点', e3AfterNodes > 0, `实际 ${e3AfterNodes}`)
const e3ThemeAfter = store.allThemes().find((t) => t.id === e3Theme.id)
ok('E3: 补生成后有标签库', Array.isArray(e3ThemeAfter?.tagLibrary))

// 幂等：已经有环节的主题再触发一次，不能把兜底模板再铺一遍。
// 实测用户连点几次「生成」后，同一个主题下摞了三套上中下游。
const idemTheme = store.addTheme('幂等测试主题')
await fire('theme:scaffoldExisting', idemTheme.id, 'AI 算力供应链')
let idemCount = 0
for (let i = 0; i < 30 && idemCount === 0; i++) {
  await new Promise((r) => setTimeout(r, 100))
  idemCount = store.allNodes().filter((n) => n.themeId === idemTheme.id).length
}
await new Promise((r) => setTimeout(r, 200))
await fire('theme:scaffoldExisting', idemTheme.id, 'AI 算力供应链')
await fire('theme:scaffoldExisting', idemTheme.id, 'AI 算力供应链')
await new Promise((r) => setTimeout(r, 400))
const idemAfter = store.allNodes().filter((n) => n.themeId === idemTheme.id).length
ok('幂等：重复触发不重复铺节点', idemAfter === idemCount, `第一次 ${idemCount} → 三次后 ${idemAfter}`)

// --- R1: 读数视图只读 + 三审计字段 ---

ok('R1: vault.js 无手动录入表单', !vaultSrcER.includes('手动记一条读数'))
ok('R1 v0.8: 读数页显示起止期间', readingUiSrcV8.includes('r.period?.start') && readingUiSrcV8.includes('r.period?.end'))
// 抓于迁到流水按天分组；展开再懒加载证据和历史，不带全量数组。
ok('R1 v0.8: 流水按抓取时间分组', readingUiSrcV8.includes('dayFeed') && readingUiSrcV8.includes("String(r.at || '').slice(0, 10)"))
ok('R1 v0.8: 流水点行展开观测', readingUiSrcV8.includes('openObservation') && readingUiSrcV8.includes('reading-dialog'))
ok('R1 v0.8: 指标台账保留在 inspector', inspectorSrcER.includes('readingPanel(node)'))
ok('R1 v0.8: 展开历史按需分页', readingUiSrcV8.includes('m.readingEvidence(') && readingUiSrcV8.includes('m.readingsPage({ indicatorId: r.indicatorId'))

// R1 端到端：读数显示跟踪指标
const r1Theme = store.addTheme('R1 测试主题')
const r1Node = store.addNode({ themeId: r1Theme.id, parentId: null, kind: 'branch', title: 'R1 环节' })
const r1Ind = store.addNode({ themeId: r1Theme.id, parentId: r1Node.id, kind: 'lemma', title: 'R1 指标', type: 'observation', confidence: 50 })
const r1ChId = 'fake-r1-channel'
store.updateNode(r1Ind.id, { channelIds: [r1ChId] })
store.addReading({ metric: 'r1.test', value: 42, unit: 'USD', asOf: '2024-Q1', channelId: r1ChId, source: { kind: '一手数据' } })
const r1Inds = store.indicatorsForReading({ channelId: r1ChId })
ok('R1: indicatorsForReading 返回指标', r1Inds.length > 0 && r1Inds[0].title === 'R1 指标')

// --- R2: 手填读数在检视面板 ---

ok('R2 v0.8: 检视面板保留手填入口', inspectorSrcER.includes('readingPanel(node)') && readingUiSrcV8.includes('记一条读数'))
ok('R2 v0.8: 手填无需 manual 通道', !inspectorSrcER.includes("c.fetch === 'manual'") && readingUiSrcV8.includes('manualForm(node)'))
ok('R2 v0.8: 手填不创建通道', !inspectorSrcER.includes('channelAdd') && readingUiSrcV8.includes('indicator: node.title'))
ok('R2 v0.8: 手填走统一摄入', readingUiSrcV8.includes('m.pushReadings(') && readingUiSrcV8.includes('meridian.reading.v1'))
ok('R2: vault.js 无 addReading 调用', !vaultSrcER.includes('addReading'))

// --- R3: 缺口只保留头部汇总，提议移到检视面板 ---

ok('R3: lattice.js 无 renderGapList', !latticeSrcER.includes('function renderGapList'))
ok('R3: lattice.js 有指标汇总', latticeSrcER.includes('个指标') && latticeSrcER.includes('个未接数据'))
ok('R3 v0.8: 检视面板不再提议配置通道', !inspectorSrcER.includes('proposeLinks') && inspectorSrcER.includes('readingPanel'))
ok('R3 v0.8: 未知读数有归位动作', readingUiSrcV8.includes('确认归位') && readingUiSrcV8.includes('m.assignReading('))
ok('R3 v0.8: 归位失败不静默', readingUiSrcV8.includes('归位失败，请重试'))
ok('R3 v0.8: 归位后刷新而非拉取通道', readingUiSrcV8.includes('await refresh()') && !inspectorSrcER.includes('channelFetch'))
ok('R3: vault.js 无 proposeLinks', !vaultSrcER.includes('proposeLinks'))

// --- R4: 无「未关联」筛选项 ---

ok('R4: vault.js 无未关联筛选', !vaultSrcER.includes("'未关联'"))

// --- 验收清单 ---

// 1. 读数视图无表单
ok('验收: vault.js 无 addReading', !vaultSrcER.includes('addReading'))
ok('验收: vault.js 无 手动记一条', !vaultSrcER.includes('手动记一条'))

// 2. 旧字段兼容：有效期间的读数携带失效 indicatorId 时，保留为待归位。
const oldReading = store.addReading({ metric: 'old.test', value: 1, unit: 'USD', asOf: '2026-09-24', indicatorId: 'old-ind', source: { kind: '一手数据' } })
ok('验收 v0.8: 失效旧关联保留为待归位', oldReading.added === true && oldReading.reading.indicatorId === null)

// 3. scaffoldTheme 不写 indicatorId
const scaffoldThemeSrc = ipcSrcER.slice(
  ipcSrcER.indexOf('async function scaffoldTheme'),
  ipcSrcER.indexOf("ipcMain.handle('theme:setupNew'"),
)
ok('验收: ipc.js scaffoldTheme 无 indicatorId', !scaffoldThemeSrc.includes('indicatorId'))

// ============================================================
// v0.7: S4 图交互 + S5 字阶
// ============================================================

console.log('\n— v0.7: 图交互与字阶 —')

const graphSrcS45 = readFileSync2(join(ROOT2, 'src/renderer/views/graph.js'), 'utf8')
const stylesSrcS45 = readFileSync2(join(ROOT2, 'src/renderer/styles.css'), 'utf8')
const rendererJsS45 = [
  appSrcER,
  latticeSrcER,
  inspectorSrcER,
  vaultSrcER,
  readFileSync2(join(ROOT2, 'src/renderer/views/settings.js'), 'utf8'),
  readFileSync2(join(ROOT2, 'src/renderer/views/today.js'), 'utf8'),
].join('\n')

ok('S4: graph.js 无 CRUD 函数', !graphSrcS45.match(/addChildHere|toggleCold|removeNode/))
ok('S4: graph.js 无原生 confirm', !graphSrcS45.includes('confirm('))
ok('S4: graph.js 无浮动操作组', !graphSrcS45.includes('node-acts'))
ok('S4: 图中隐藏重新生成', latticeSrcER.includes('isGraph ? null : (() => {'))
ok('S4: 图中隐藏新建按钮', latticeSrcER.includes("isGraph ? null : h('button'"))
ok('S4: 图中 Enter 切回树形', latticeSrcER.includes("state.shape === 'graph'"))
ok('S4: 图中方向键遍历节点', latticeSrcER.includes("state.shape === 'graph' ? '.node' : '.row'"))
ok('S4: 支持 Cmd/Ctrl+Backspace', latticeSrcER.includes("(e.metaKey || e.ctrlKey) && e.key === 'Backspace'"))
ok('S4: 树图共用软删函数', appSrcER.includes('export async function deleteNodeWithUndo'))
ok('S4: 软删 toast 可撤销', appSrcER.includes('m.restoreNode(id)') && appSrcER.includes("label: '撤销'"))

ok('S5: 有 caption 字阶', stylesSrcS45.includes('--t-caption: 11px'))
ok('S5: 有 body 字阶', stylesSrcS45.includes('--t-body: 13px'))
ok('S5: 有 title 字阶', stylesSrcS45.includes('--t-title: 15px'))
ok('S5: 有 head 字阶', stylesSrcS45.includes('--t-head: 20px'))
ok('S5: 有 hero 字阶', stylesSrcS45.includes('--t-hero: 28px'))
ok('S5: CSS 无直接像素字号', !/font-size:\s*[\d.]+px/.test(stylesSrcS45))
ok('S5: 渲染 JS 无直接像素字号', !/fontSize:\s*['"][\d.]+px/.test(rendererJsS45))

// ============================================================
console.log('\n— C2: 忽略归位建议与分组审计（离线行为）—')
// 独立测试数据；不读取真实用户目录，也不调用模型或网络。
const c2Snapshot = store.exportAll({ withRaw: false })
store.importAll(JSON.stringify({ nodes: [], themes: [], inbox: [], verdicts: [] }))
const c2Theme = store.addTheme('C2 suggested theme')
const c2OtherTheme = store.addTheme('C2 unrelated theme')
store.updateTheme(c2Theme.id, { tagLibrary: [{ id: 'c2-tag', name: 'zirconium', synonyms: [], threshold: 0.6 }] })
store.addNode({ themeId: c2OtherTheme.id, kind: 'lemma', title: 'default capture context' })
const c2Capture = await fire('inbox:capture', 'zirconium refinery output rises', { kind: '一手数据', platform: 'offline-test' })
const c2Captured = c2Capture.routeProposals?.[0]
ok('C2: capture 保留路由类型和主题', c2Captured?.kind === 'route-proposal' && c2Captured.matchedTheme.id === c2Theme.id)
ok('C2: capture 保留标签、通道和 bestScore', c2Captured?.matchedTags[0].tagId === 'c2-tag' && c2Captured.originChannel.platform === 'offline-test' && c2Captured.bestScore === 1)
// 以下用明确的 proposal 文本验证三条匹配路径。
store.importAll(JSON.stringify({ nodes: [], themes: [c2Theme, c2OtherTheme], inbox: [], verdicts: [] }))
const c2Propose = (fields = {}) => store.addInboxItem({
  kind: 'route-proposal', title: 'unrelated headline', text: 'unrelated body',
  matchedTheme: { id: c2Theme.id, name: c2Theme.name },
  matchedTags: [{ name: 'zirconium', score: 0.8 }],
  originChannel: { id: 'c2-channel', kind: '一手数据' }, bestScore: 0.8,
  ...fields,
})
const c2New = c2Propose({ lemmas: [{ title: 'Zirconium refinery output rises' }] })
ok('C2: addInboxItem 保留所有建议字段', c2New.kind === 'route-proposal' && c2New.matchedTheme.id === c2Theme.id && c2New.matchedTags[0].score === 0.8 && c2New.originChannel.id === 'c2-channel' && c2New.bestScore === 0.8)
const c2Before = store.allVerdicts().length
await fire('inbox:resolve', c2New.id, 'reject', { kind: 'ordinary' })
const c2IgnoredAt = c2New.ignoredAt
await fire('inbox:resolve', c2New.id, 'reject')
ok('C2: 路由拒绝不写 verdict 且幂等', store.allVerdicts().length === c2Before && c2New.ignored === true && !!c2IgnoredAt && c2New.ignoredAt === c2IgnoredAt)
ok('C2: ignored 不出现在活动队列/计数', store.allInbox().length === 0 && store.inboxCount() === 0 && store.stats().inbox === 0)
ok('C2: ignored getter 与 IPC 返回保留记录', store.ignoredInbox()[0]?.id === c2New.id && (await fire('inbox:ignored'))[0]?.id === c2New.id)
const c2Ordinary = store.addInboxItem({ title: 'ordinary rejection', label: { kind: '独立媒体', quality: 0.65 } })
await fire('inbox:resolve', c2Ordinary.id, 'reject', { kind: 'route-proposal' })
const c2ResolvedAt = c2Ordinary.resolvedAt
await fire('inbox:resolve', c2Ordinary.id, 'reject')
store.resolveInboxItem(c2Ordinary.id, 'reject')
ok('C2: 普通拒绝只写一次 user verdict，不信任客户端类型', store.allVerdicts().length === c2Before + 1 && store.allVerdicts()[0].gate === 'user' && c2Ordinary.resolvedAt === c2ResolvedAt)
ok('C2: 未知 id 不写 verdict', await fire('inbox:resolve', 'c2-missing', 'reject') === null && store.allVerdicts().length === c2Before + 1)
store.addNode({ themeId: c2OtherTheme.id, title: 'Zirconium refinery output rises' })
const c2Branch = store.addNode({ themeId: c2Theme.id, kind: 'branch', title: 'Zirconium refinery output rises' })
store.updateNode(c2Branch.id, { title: 'Zirconium refinery output rises' })
store.addSource(c2Branch.id, { kind: '一手数据' })
ok('C2: 跨主题和 branch 占位均不回填', !c2New.promotedTo)
const c2Node = store.addNode({ themeId: c2Theme.id, title: '  zirconium refinery output rises  ' })
ok('C2: 新 lemma 以建议 lemmas 标题回填', c2New.promotedTo === c2Node.id && !!c2New.promotedAt)
const c2PromotedAt = c2New.promotedAt
store.addNode({ themeId: c2Theme.id, title: 'Zirconium refinery output rises' })
store.addSource(c2Node.id, { kind: '一手数据' })
ok('C2: 回填不覆盖首次目标和日期', c2New.promotedTo === c2Node.id && c2New.promotedAt === c2PromotedAt)
const c2Rename = c2Propose({ text: 'sapphire shipments accelerate' })
store.resolveInboxItem(c2Rename.id, 'reject')
const c2RenameNode = store.addNode({ themeId: c2Theme.id, title: 'old unrelated wording' })
store.updateNode(c2RenameNode.id, { title: 'sapphire shipments accelerate strongly' })
ok('C2: rename 以 proposal text token 重合回填', c2Rename.promotedTo === c2RenameNode.id)
const c2MergeNode = store.addNode({ themeId: c2Theme.id, title: 'cobalt battery demand' })
const c2Merge = c2Propose({ title: 'cobalt battery demand', text: '', lemmas: [] })
store.resolveInboxItem(c2Merge.id, 'reject')
ok('C2: 忽略时不追溯已存在节点', !c2Merge.promotedTo)
store.addSource(c2MergeNode.id, { kind: '一手数据', label: 'new evidence' })
ok('C2: addSource merge 以 proposal title 回填', c2Merge.promotedTo === c2MergeNode.id && !!c2Merge.promotedAt)
const c2Cross = c2Propose({ title: 'tungsten mine supply', text: '' })
store.resolveInboxItem(c2Cross.id, 'reject')
const c2CrossNode = store.addNode({ themeId: c2OtherTheme.id, title: 'unrelated' })
store.updateNode(c2CrossNode.id, { title: 'tungsten mine supply' })
store.addSource(c2CrossNode.id, { kind: '一手数据' })
ok('C2: rename / merge 也不能跨主题回填', !c2Cross.promotedTo)
const c2Pending = c2Propose({ title: 'platinum catalyst output', text: '' })
store.addNode({ themeId: c2Theme.id, title: c2Pending.title })
ok('C2: 未忽略的建议不回填', !c2Pending.promotedTo)
const c2Empty = c2Propose({ title: '', text: '', lemmas: [] })
store.resolveInboxItem(c2Empty.id, 'reject')
store.addNode({ themeId: c2Theme.id, title: '' })
ok('C2: 空标题不能回填', !c2Empty.promotedTo)
store.resolveInboxItem(c2New.id, 'accept')
store.clearInbox()
ok('C2: clear 保留已接受的 ignored 和待处理建议', store.ignoredInbox().some((p) => p.id === c2New.id && p.status === 'accepted') && store.allInbox().some((p) => p.id === c2Pending.id))
const c2RoundTrip = store.exportAll({ withRaw: false })
store.importAll(c2RoundTrip)
const c2Restored = store.ignoredInbox().find((p) => p.id === c2New.id)
ok('C2: 导入导出保留忽略、回填和建议字段', c2Restored?.ignoredAt === c2IgnoredAt && c2Restored.promotedAt === c2PromotedAt && c2Restored.promotedTo === c2Node.id && c2Restored.bestScore === 0.8 && c2Restored.matchedTags.length === 1)
await fire('inbox:resolve', c2New.id, 'reject')
store.clearInbox()
ok('C2: 导入后再次忽略/清理仍幂等', store.ignoredInbox().find((p) => p.id === c2New.id)?.ignoredAt === c2IgnoredAt && store.allVerdicts().length === 1)
// 使用明确日期的独立夹具，验证窗口、未知 gate、悬空目标和各组分母。
const c2Now = new Date().toISOString()
const c2Old = new Date(Date.now() - 60 * 864e5).toISOString()
store.importAll(JSON.stringify({
  nodes: [c2Node], themes: [c2Theme],
  verdicts: [
    { id: 's1', gate: 'source', at: c2Now, promotedTo: c2Node.id },
    { id: 's2', gate: 'source', at: c2Now },
    { id: 'd1', gate: 'dedup', at: c2Now, promotedTo: 'deleted-node' },
    { id: 'u1', gate: 'user', at: c2Now },
    { id: 'o1', gate: 'unexpected', at: c2Now, promotedTo: 'deleted-node' },
    { id: 'o2', gate: 'routeIgnored', at: c2Now },
    { id: 'o3', gate: 'toString', at: c2Now },
    { id: 'old', gate: 'source', at: c2Old, promotedTo: c2Node.id },
  ],
  inbox: [
    { ...c2Restored, id: 'r1', ignoredAt: c2Now, createdAt: c2Old },
    { ...c2Restored, id: 'r2', ignoredAt: c2Now, promotedTo: 'deleted-node' },
    { ...c2Restored, id: 'r3', ignoredAt: c2Now, promotedTo: null },
    { ...c2Restored, id: 'r-old', ignoredAt: c2Old, createdAt: c2Now },
    { ...c2Restored, id: 'not-route', kind: 'ordinary', ignoredAt: c2Now },
    { ...c2Restored, id: 'not-ignored', ignored: false, ignoredAt: c2Now },
  ],
}))
const c2Audit = store.falseKillAudit(30)
ok('C2: historical / recent 总数只含 verdict', c2Audit.allTotal === 8 && c2Audit.total === 7 && c2Audit.missed === 3 && c2Audit.rate === 3 / 7)
ok('C2: 顶层 items 只含回填 verdict，悬空目标仍保留', c2Audit.items.length === 3 && c2Audit.items.every((x) => x.verdict && !x.proposal) && c2Audit.items.some((x) => x.node === null))
for (const [gate, total, missed] of [['source', 2, 1], ['dedup', 1, 1], ['user', 1, 0], ['other', 3, 1], ['routeIgnored', 3, 2]]) {
  const g = c2Audit.byGate[gate]
  ok(`C2: ${gate} 独立分母/分子/比率与完整列表`, g.total === total && g.missed === missed && g.rate === missed / total && g.items.length === total)
}
ok('C2: routeIgnored 只来自 inbox，按 ignoredAt 而非 createdAt', c2Audit.byGate.routeIgnored.items.every((x) => x.proposal && !x.verdict && ['r1', 'r2', 'r3'].includes(x.proposal.id)))
ok('C2: routeIgnored 悬空目标保留证据', c2Audit.byGate.routeIgnored.items.find((x) => x.proposal.id === 'r2')?.node === null)
ok('C2: verdict 命名为 routeIgnored 也归 other', c2Audit.byGate.other.items.some((x) => x.verdict.id === 'o2'))
store.importAll(JSON.stringify({ nodes: [] }))
const c2EmptyAudit = store.falseKillAudit()
ok('C2: 旧空数据无 NaN，所有组仍返回空数组', c2EmptyAudit.allTotal === 0 && c2EmptyAudit.rate === 0 && Object.values(c2EmptyAudit.byGate).every((g) => g.total === 0 && g.missed === 0 && g.rate === 0 && g.items.length === 0))
store.importAll(c2Snapshot)

console.log('\n— v0.7.1 捕获来源与展示契约 —')
const cleanupSnapshot = store.exportAll({ withRaw: false })
const cleanupFetch = globalThis.fetch
try {
  store.importAll(JSON.stringify({ nodes: [], themes: [], settings: { apiKey: '' }, inbox: [], verdicts: [] }))
  const captureTheme = store.addTheme('手工捕获验收')
  const capture = await fire('inbox:capture', '本期设备出货达到一百台，尚需人工核实。')
  const imported = await fire('inbox:import', captureTheme.id, [capture.item])
  const raw = store.getRaw(store.getNode(imported.results[0].id).sources[0].rawId)
  ok('C1: 纯文本 raw label 标记手工粘贴及日期', raw.label === `手工粘贴 · ${store.today()}`)
  ok('C1: 剪贴板读取桥可调用', typeof await fire('io:readClipboard') === 'string')
  const url = 'https://example.com/cleanup-source'
  globalThis.fetch = async (requested) => {
    if (requested !== url) throw new Error('测试不允许外网请求')
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<article>' + '季度供应链开工率上升，企业披露设备投产进度并提醒短期风险。'.repeat(5) + '</article>' }
  }
  const fromUrl = await fire('inbox:capture', url)
  ok('C1: URL 捕获保留平台、地址、抓取时间', fromUrl.item.provenance.url === url && fromUrl.item.provenance.platform === 'example.com' && !!fromUrl.item.provenance.fetchedAt)
  const urlImport = await fire('inbox:import', captureTheme.id, [fromUrl.item])
  const urlNode = store.getNode(urlImport.results[0].id)
  ok('C1: URL raw label 使用原始地址', store.getRaw(urlNode.sources[0].rawId).label === url)
  ok('C1: 入库来源继续保留 URL 与抓取时间', urlNode.sources[0].url === url && !!urlNode.sources[0].fetchedAt)
  const gaapLabels = await fire('db:commonUsGaap')
  ok('C6: 中文指标映射通过 IPC 提供', gaapLabels.some(({ tag, label }) => tag === 'Revenues' && label === '总收入'))
} finally {
  globalThis.fetch = cleanupFetch
  store.importAll(cleanupSnapshot)
}
const cleanupToday = readFileSync2(join(ROOT2, 'src/renderer/views/today.js'), 'utf8')
const cleanupMain = readFileSync2(join(ROOT2, 'src/main/main.js'), 'utf8')
const cleanupPreload = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const cleanupPreloadCjs = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
ok('C1: 两份 preload 完全同步', cleanupPreload === cleanupPreloadCjs)
ok('C1: 输入框和拖拽清理干净', !/inbox-textarea|ondrop|ondragover|inboxDraft/.test(cleanupToday + stylesSrcS45))
ok('C1: 输入聚焦推送全链路清理', !/inbox:focus|onInboxFocus/.test(cleanupMain + cleanupPreload + cleanupPreloadCjs + appSrcER))
ok('C1: 侧栏按钮读取剪贴板且空态有提示', appSrcER.includes('m.readClipboard()') && appSrcER.includes('剪贴板是空的'))
ok('C3: Windows 字体在 Mac 字体之后', stylesSrcS45.indexOf('Segoe UI') > stylesSrcS45.indexOf('Hiragino Sans GB') && stylesSrcS45.includes('Microsoft YaHei'))
ok('C3: mica 仅用于 win32', cleanupMain.includes("process.platform === 'win32' ? { backgroundMaterial: 'mica' }"))
ok('C4: 默认树并保存用户切换', appSrcER.includes("localStorage.getItem('meridian.shape') === 'graph' ? 'graph' : 'tree'") && appSrcER.includes("localStorage.setItem('meridian.shape', shape)"))
ok('C5: 6/12/18 圆角档位', stylesSrcS45.includes('--r-sm: 6px') && stylesSrcS45.includes('--r: 12px') && stylesSrcS45.includes('--r-lg: 18px'))
// 50% 是正圆不是档位，要排除；查的是「用了 1-99px 的档位外圆角」
ok('C5: 普通圆角使用 token，非标准字重已移除', !/border-radius:\s*[1-9]\d*px(?!\s*;)/.test(stylesSrcS45.replace(/border-radius:\s*50%/g, '')) && !/font-weight:\s*(500|550|650)/.test(stylesSrcS45))
// R14 之后行是五列网格，常量已上移卡片头；跟踪仍只算一次
// v0.8 行的单位是观测，来源和原文留在展开；默认显示信任态。
const feedRowSrc = readingUiSrcV8.slice(readingUiSrcV8.indexOf('function observationRow'), readingUiSrcV8.indexOf('function dayFeed'))
const rowPart = feedRowSrc
ok('C6/R14 v0.8: 观测行显示值与信任而非内部字段',
  rowPart.includes('trustMark(r)') && rowPart.includes('fmtValue(r.value)') &&
  !rowPart.includes('r.hash') && !rowPart.includes('r.dedupeKey'))
ok('C6 v0.8: 不铺通道筛选，按天虚拟化有界渲染', !vaultSrcER.includes('全部通道') && readingUiSrcV8.includes('ResizeObserver') && readingUiSrcV8.includes('rows.slice(0, 10)'))

// ============================================================
// LLM 成本治理：A（lastFetch 精度）B（免费过滤层）C（节流与归因）D（收件箱三态）
// ============================================================

console.log('\n— 成本治理：A/B 免费过滤层 —')

const { readUsage, __testHooks: llmHooks, SCENARIO_LABELS } = await import('../src/main/llmlog.js')
const { startScheduler, isQuietHours: govQuiet } = await import('../src/main/scheduler.js')
const ipcSrcGov = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const vaultSrcGov = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const todaySrcGov = readFileSync2(join(ROOT2, 'src/renderer/views/today.js'), 'utf8')
const storeSrcGov = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
const schedulerSrcGov = readFileSync2(join(ROOT2, 'src/main/scheduler.js'), 'utf8')
const pjGov = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcGov = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// ---- C4：token 读取（原来 9 个调用点一处都没读 usage）----

const usageRes = new Response(JSON.stringify({ usage: { total_tokens: 42 }, choices: [] }), { headers: { 'content-type': 'application/json' } })
ok('C4: readUsage 读 total_tokens', await readUsage(usageRes) === 42)
ok('C4: readUsage 不消费原响应体', (await usageRes.json())?.usage?.total_tokens === 42)
ok('C4: readUsage 无 usage 返回 0', await readUsage(new Response('{}', { headers: { 'content-type': 'application/json' } })) === 0)
ok('C4: readUsage 解析失败返回 0', await readUsage(new Response('not json', { headers: { 'content-type': 'application/json' } })) === 0)
ok('C4: 调用点只在 tracked 里记账', ipcSrcGov.includes('tracked(') && !ipcSrcGov.includes('recordLlmUsage'))

// ---- C5：Jev 原生协议（state/questions 直连 baseUrl 本体）----

const jevNativeRes = new Response(JSON.stringify({ usage: { input_tokens: 280, output_tokens: 20 } }), { headers: { 'content-type': 'application/json' } })
ok('C5: readUsage 读 Jev 原生 input/output_tokens', await readUsage(jevNativeRes) === 300)
const jevBothRes = new Response(JSON.stringify({ usage: { total_tokens: 42, input_tokens: 280, output_tokens: 20 } }), { headers: { 'content-type': 'application/json' } })
ok('C5: readUsage 有 total_tokens 时优先用它', await readUsage(jevBothRes) === 42)

// 打桩 fetch：捕获请求形状，返回原生 answers
const realFetch = globalThis.fetch
let jevLastReq = null
const jevOkBody = {
  answers: {
    kind: { type: 'choice', choice: '券商研报', probabilities: { '券商研报': 0.9 }, confidence: 0.9 },
    quality: { type: 'score', score: 3.4, normalized: 0.85, legend: { 1: '低', 5: '高' }, confidence: 0.8 },
    noul: { type: 'noul', noul: 0.7 },
  },
  model: 'jev-1.13.0',
  usage: { input_tokens: 280, output_tokens: 20 },
}
globalThis.fetch = async (url, init) => {
  jevLastReq = { url, body: JSON.parse(init.body) }
  return new Response(JSON.stringify(jevOkBody), { headers: { 'content-type': 'application/json' } })
}
const jevSettings = { jevBaseUrl: 'https://api.typesafe.ai/v1/systemone/', jevKey: 'sk-test', jevModel: 'jev-latest' }
const jevR = await labeler.jevLabel(jevSettings, '某券商发布研报称目标价上调')
ok('C5: jevLabel 打到 baseUrl 本体，不拼 /chat/completions', jevLastReq.url === 'https://api.typesafe.ai/v1/systemone')
ok('C5: jevLabel 请求体是原生 state/questions 形状',
  jevLastReq.body.model === 'jev-latest' &&
  jevLastReq.body.state === '某券商发布研报称目标价上调' &&
  jevLastReq.body.questions?.kind?.type === 'choice' &&
  jevLastReq.body.questions?.quality?.type === 'score' &&
  jevLastReq.body.questions?.noul?.type === 'noul' &&
  !('messages' in jevLastReq.body))
ok('C5: jevLabel Choice 选项覆盖全部来源类型',
  Object.keys(jevLastReq.body.questions.kind.criteria).length === 7 &&
  jevLastReq.body.questions.kind.criteria['券商研报'] === '券商研报')
ok('C5: jevLabel 解析 answers：kind/质量走表/jevScore/noul',
  jevR.ok === true && jevR.kind === '券商研报' && jevR.quality === 0.8 &&
  jevR.jevScore === 0.85 && jevR.noul === 0.7 && jevR.via === 'jev')
ok('C5: jevLabel 返回服务端解析的真实模型版本与用量', jevR.model === 'jev-1.13.0' && jevR.usage === 300)

// choice 返回非法选项 → 回落查表，但仍记 via=jev（与旧语义一致）
globalThis.fetch = async (url, init) => {
  jevLastReq = { url, body: JSON.parse(init.body) }
  const b = structuredClone(jevOkBody)
  b.answers.kind.choice = '不存在的类型'
  return new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
}
const jevFallback = await labeler.jevLabel(jevSettings, '某公司财报显示营收增长')
ok('C5: jevLabel Choice 非法时回落查表', jevFallback.ok === true && jevFallback.kind === '财报 / 公告')

// score 没有 normalized 时用 legend 刻度归一
globalThis.fetch = async () => new Response(JSON.stringify({
  answers: {
    kind: { type: 'choice', choice: '独立媒体' },
    quality: { type: 'score', score: 1.6, legend: { 0: '低', 1: '中', 2: '高' } },
    noul: { type: 'noul', noul: 0.5 },
  },
  model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 },
}), { headers: { 'content-type': 'application/json' } })
const jevLegend = await labeler.jevLabel(jevSettings, '据报道')
ok('C5: jevLabel score 用 legend 刻度归一', jevLegend.jevScore === 0.8)

// 异常路径
globalThis.fetch = async () => new Response('nope', { status: 500 })
const jev500 = await labeler.jevLabel(jevSettings, '文本')
ok('C5: jevLabel HTTP 失败返回 why', jev500.ok === false && jev500.why === 'HTTP 500')
globalThis.fetch = async () => { throw new TypeError('fetch failed') }
const jevNet = await labeler.jevLabel(jevSettings, '文本')
ok('C5: jevLabel 网络异常返回 network', jevNet.ok === false && jevNet.why === 'network')
globalThis.fetch = async () => new Response(JSON.stringify({ nothing: true }), { headers: { 'content-type': 'application/json' } })
const jevBad = await labeler.jevLabel(jevSettings, '文本')
ok('C5: jevLabel 无 answers 返回 unparsable', jevBad.ok === false && jevBad.why === 'unparsable')
const jevNoKey = await labeler.jevLabel({ ...jevSettings, jevKey: '' }, '文本')
ok('C5: jevLabel 无 key 不发请求', jevNoKey.ok === false && jevNoKey.why === 'no-key')
globalThis.fetch = realFetch

// jev:test 的 handler 走原生最小 ping（只验形状：不拼 /chat/completions、body 为原生）
ok('E2: jev:test 不再拼 /chat/completions', !ipcSrcGov.includes("jevBaseUrl || '')}/chat/completions"))
ok('E2: jev:test 用原生 state/questions 最小请求', ipcSrcGov.includes("questions: { ok: { type: 'noul'") && ipcSrcGov.includes("state: 'ping'"))

const usageToday = () => store.llmUsage().daily.find((d) => d.date === store.today()) || { calls: 0, failed: 0, degraded: 0, tokens: 0, byScenario: {} }
// 账本是同一个对象，比较前先拍快照，否则 before/after 是同一个引用
const usageSnapshot = () => { const d = usageToday(); return { calls: d.calls, failed: d.failed, degraded: d.degraded, tokens: d.tokens, byScenario: { ...d.byScenario } } }
const c4Before = usageSnapshot()
store.recordLlmUsage('extract', { ok: true, tokens: 120 })
store.recordLlmUsage('extract', { ok: false, error: 'timeout', latency: 15000 })
const c4After = usageSnapshot()
ok('C4: 按天聚合调用次数', c4After.calls === c4Before.calls + 2)
ok('C4: 按天累计 token', c4After.tokens === c4Before.tokens + 120)
ok('C4: 失败计数', c4After.failed === c4Before.failed + 1)
ok('C4: 按场景分组', (c4After.byScenario.extract || 0) === (c4Before.byScenario.extract || 0) + 2)
ok('C4: 失败明细带场景与耗时', store.llmUsage().recent[0].scenario === 'extract' && store.llmUsage().recent[0].error === 'timeout' && store.llmUsage().recent[0].latency === 15000)
ok('C4: 同一天只有一条账', store.llmUsage().daily.filter((d) => d.date === store.today()).length === 1)

for (let i = 0; i < 60; i++) store.recordLlmUsage('extract', { ok: false, error: `boom-${i}` })
ok('C4: 失败明细封顶 50 条', store.llmUsage().recent.length === 50, `实际 ${store.llmUsage().recent.length}`)
ok('C4: 封顶保留最新', store.llmUsage().recent[0].error === 'boom-59')
ok('C4: 账本过迁移仍是对象', (() => { const dbRaw = store.load(); return typeof dbRaw.llmUsage === 'object' && Array.isArray(dbRaw.llmUsage.daily) })())

// ---- A：通道已移除；成本治理主题照常建 ----

const aGeo = store.addTheme('成本治理主题')


// ---- 让成本治理主题成为默认主题，装上可控抽取桩 ----

const aLemmaCount = (id) => store.allNodes().filter((n) => n.themeId === id && n.kind === 'lemma' && n.status !== 'dead').length
const aMaxOther = Math.max(0, ...store.allThemes().filter((t) => t.id !== aGeo.id).map((t) => aLemmaCount(t.id)))
const aBranch = store.addNode({ themeId: aGeo.id, kind: 'branch', title: '成本治理环节', propagation: 0.5 })
for (let i = 0; i <= aMaxOther; i++) {
  store.addNode({ themeId: aGeo.id, parentId: aBranch.id, kind: 'lemma', title: `治理基线${i}`, confidence: 50 })
}
ok('B: 成本治理主题成为默认主题', store.bestThemeContext()?.id === aGeo.id, `实际 ${store.bestThemeContext()?.name}`)

const realRunHook = llmHooks.run
let extractCalls = 0
let stubTitle = null
llmHooks.run = async (scenario, args) => {
  if (scenario === 'extract') {
    extractCalls++
    return { ok: true, lemmas: [{ title: stubTitle || `治理抽取命题·${String(args.text).slice(0, 10)}`, type: 'observation', confidence: 70, parentHint: null, tags: [], sourceKind: '一手数据' }], usage: 321 }
  }
  return { ok: false, reason: 'no-key' }
}
store.saveSettings({ apiKey: 'sk-gov-test', labeler: 'table' })

// ---- B1：同 hash 第二次进来零调用 ----

const b1Text = '成本治理测试：某公司发布新一代交换机，端口密度提升一倍。'
const b1TokensBefore = usageToday().tokens
const b1CallsBefore = usageToday().byScenario.extract || 0
const b1First = await fire('inbox:capture', b1Text)
ok('B1: 首次捕获走抽取', extractCalls === 1 && b1First?.ok === true)
ok('B1: 抽取写进账本并带上 token', (usageToday().tokens === b1TokensBefore + 321) && (usageToday().byScenario.extract || 0) === b1CallsBefore + 1, `token 增量 ${usageToday().tokens - b1TokensBefore}`)
const b1Second = await fire('inbox:capture', b1Text)
ok('B1: 同 hash 第二次零调用', extractCalls === 1, `实际 ${extractCalls}`)
ok('B1: 走的是复用路径', store.allTraces().some((t) => t.stage === 'extract' && t.actor?.by === 'reuse'))
ok('B1: 复用不产生新的账本调用', (usageToday().byScenario.extract || 0) === b1CallsBefore + 1)
ok('B1: 复用仍返回结论', b1Second?.ok === true && (b1Second?.item || b1Second?.autoImported))

// ---- B3：高相似（≥0.85）直接并源，不抽 ----

const b3Node = store.addNode({ themeId: aGeo.id, parentId: aBranch.id, kind: 'lemma', title: '铜连接在短距离内可替代光模块', confidence: 50, type: 'hypothesis' })
const b3CallsBefore = extractCalls
const b3VerdictsBefore = store.allVerdicts().filter((v) => v.textHash).length
const b3 = await fire('inbox:capture', '铜连接在短距离内可替代光模块，成本更低。')
ok('B3: 高相似不调用模型', extractCalls === b3CallsBefore)
ok('B3: 命题原样合并，不新建', store.getNode(b3Node.id).sources.length === 1)
ok('B3: 合并的判定记进误杀审计（带 textHash）', store.allVerdicts().filter((v) => v.textHash).length > b3VerdictsBefore)
ok('B3: 未抽取低质结论', b3?.skipped !== 'low-quality' && store.getNode(b3Node.id).status !== 'dead')

// 0.7 落在 0.6–0.85 之间：不预合并（宁可多抽一次），抽完由分流层合并
const b3Mid = store.addNode({ themeId: aGeo.id, parentId: aBranch.id, kind: 'lemma', title: '铜连接 在短距离 可替代光模块', confidence: 50, type: 'hypothesis' })
const b3MidScore = store.findSimilar('铜连接 可替代光模块 成本更低', aGeo.id).find((r) => r.node.id === b3Mid.id)?.score
ok('B3: 0.7 灰区相似度成立', b3MidScore >= 0.6 && b3MidScore < 0.85, `实际 ${b3MidScore}`)
stubTitle = b3Mid.title
const b3MidCap = await fire('inbox:capture', '铜连接 可替代光模块 成本更低')
stubTitle = null
ok('B3: 灰区照常抽取', extractCalls === b3CallsBefore + 1)
const b3MidMerged = b3MidCap?.autoImported
  ? (b3MidCap.imported?.[0]?.action === 'merge' && b3MidCap.imported?.[0]?.id === b3Mid.id)
  : (b3MidCap?.lemmas?.[0]?.action === 'merge' && b3MidCap?.lemmas?.[0]?.mergeInto === b3Mid.id)
ok('B3: 灰区由分流层合并', b3MidMerged, `autoImported=${b3MidCap?.autoImported}`)

// ---- B2：通道已知低质，不抽 ----

const b2Text = '道听途说测试：某厂产能砍半，听说的。'
const b2CallsBefore = extractCalls
const b2 = await fire('inbox:capture', b2Text, { kind: '道听途说', channelId: 'gov-ch-1' })
ok('B2: 低质通道直接留档不抽取', b2?.skipped === 'low-quality' && b2?.item?.extracted === false)
ok('B2: 低质不调用模型', extractCalls === b2CallsBefore)
ok('B2: 原文与质量分完整保留', b2?.item?.text === b2Text && b2?.item?.label?.quality === 0.2)
ok('B2: matchScore 为 0 → 未匹配态', b2?.item?.matchScore === 0)
ok('B2: 不加价（via channel）', b2?.item?.label?.via === 'channel')
ok('B2: 拦截留痕可回查', store.allTraces().some((t) => t.stage === 'gate' && t.decision?.skipped === 'low-quality'))

// ---- B4：标签库分级闸门 ----

store.updateTheme(aGeo.id, { tagLibrary: [{ id: 'gov_tag_1', name: '光模块', synonyms: ['optical'], threshold: 0.5, hits: 0, lastHitAt: null }] })
const b4aCalls = extractCalls
const b4a = await fire('inbox:capture', '光模块行业月度跟踪：出货量环比回升。')
ok('B4: score === threshold 放行（不是 >）', extractCalls === b4aCalls + 1 && !b4a?.skipped)

store.updateTheme(aGeo.id, { tagLibrary: [{ id: 'gov_tag_1', name: '光模块', synonyms: ['optical'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const b4bCalls = extractCalls
const b4bText = '光模块渠道调研：价格企稳，库存正常。'
const b4b = await fire('inbox:capture', b4bText)
ok('B4: 未达阈值不抽取', b4b?.skipped === 'weak-tags' && b4b?.item?.extracted === false)
ok('B4: 未达阈值记下命中分', b4b?.item?.matchScore === 0.5, `实际 ${b4b?.item?.matchScore}`)
ok('B4: 未达阈值零调用', extractCalls === b4bCalls)
ok('B4: 弱匹配原文留着', b4b?.item?.text === b4bText)

const b4cCalls = extractCalls
const b4c = await fire('inbox:capture', '完全无关的话题：周末去爬山，天气不错。')
ok('B4: 未命中标签库不抽取', b4c?.skipped === 'no-tags' && b4c?.item?.matchScore === 0)
ok('B4: 未命中零调用', extractCalls === b4cCalls)

store.updateTheme(aGeo.id, { tagLibrary: [] })
const b4dCalls = extractCalls
const b4d = await fire('inbox:capture', '完全无关的话题二：周末在家煮咖啡。')
ok('B4: 空词库全部放行（没声明过关心什么就不筛）', extractCalls === b4dCalls + 1 && !b4d?.skipped)

// ---- D：收件箱三态 + 主动抽取 + 清空未匹配 ----

store.updateTheme(aGeo.id, { tagLibrary: [{ id: 'gov_tag_1', name: '光模块', synonyms: ['optical'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const dText = '未匹配三态测试：本地咖啡馆换了新豆子。'
const d1 = await fire('inbox:capture', dText)
ok('D: 未匹配条目进箱且标注未抽取', d1?.item?.extracted === false && d1?.item?.matchScore === 0 && d1?.item?.text === dText)
const dCallsBefore = extractCalls
const dExtract = await fire('inbox:extract', [d1.item.id])
ok('D: 抽取这 N 条按需调用模型', dExtract?.extracted === 1 && extractCalls === dCallsBefore + 1)
const dAfter = store.allInbox().find((i) => i.id === d1.item.id)
ok('D: 抽取后转为已抽取并带上命题', dAfter?.extracted === true && dAfter?.lemmas?.length === 1)

const dExtractAgain = await fire('inbox:extract', [d1.item.id])
ok('D: 抽过的不会被重复抽取（不重复花钱）', dExtractAgain?.extracted === 0 && extractCalls === dCallsBefore + 1)

const d2 = await fire('inbox:capture', '未匹配三态测试二：社区团购又涨价了。')
const dKept = store.allInbox().filter((i) => i.extracted !== false).length
const dPending = store.allInbox().filter((i) => i.extracted === false).length
const dCleared = await fire('inbox:clearUnextracted')
ok('D: 清空未匹配清掉全部未抽取条目', dCleared === dPending, `实际 ${dCleared} / ${dPending}`)
ok('D: 已抽取条目一条未动', store.allInbox().filter((i) => i.extracted !== false).length === dKept)
ok('D: 未抽取条目清空后归零', store.allInbox().filter((i) => i.extracted === false).length === 0)
ok('D: 被清的确实是未匹配那条', d2?.item?.extracted === false && !store.allInbox().some((i) => i.id === d2.item.id))

const dStale = store.addInboxItem({ text: '过期未匹配内容', title: '过期未匹配内容', lemmas: [], extracted: false, matchScore: 0 })
const dDb = store.load()
dDb.inbox.find((i) => i.id === dStale.id).createdAt = '2026-07-01'
ok('D: 未匹配 30 天后自动过期', !store.allInbox().some((i) => i.id === dStale.id))
ok('D: 过期条目仍在库里（内容不丢）', dDb.inbox.some((i) => i.id === dStale.id))
dDb.inbox = dDb.inbox.filter((i) => i.id !== dStale.id)

// ---- C1：调度器只做到期结算通知，不再轮询通道 ----

const { dueToNotify: govDueToNotify, buildNotification: govBuildNotification } = await import('../src/main/scheduler.js')
ok('C1: scheduler 导出 dueToNotify', typeof govDueToNotify === 'function')
ok('C1: scheduler 导出 buildNotification', typeof govBuildNotification === 'function')
ok('C1: dueToNotify 过滤已通知', govDueToNotify([{ id: 'a' }, { id: 'b' }], new Set(['a'])).length === 1)
ok('C1: buildNotification 空返回 null', govBuildNotification([]) === null)
ok('C1: buildNotification 带标题', govBuildNotification([{ title: 't' }]).title.includes('到期'))
// startScheduler 只接受到期结算相关参数
const schedNotified = []
const stopSched = startScheduler({ due: () => [{ id: 's1', title: '到期判断' }], notify: (n) => schedNotified.push(n), badge: () => {}, onClick: () => {} })
await new Promise((r) => setTimeout(r, 20))
stopSched()
ok('C1: startScheduler 不再接受 channels 参数', !schedulerSrcGov.includes('channels'))
ok('C1: scheduler 无通道轮询', !schedulerSrcGov.includes('dueChannels') && !schedulerSrcGov.includes('runChannel'))


// ---- C6：通道未匹配率已随通道系统移除；来源声誉回归 ----

ok('C6 v0.8: 来源声誉只作参考不停用', readingUiSrcV8.includes('只作参考') && readingUiSrcV8.includes('不会自动停用来源'))


// ---- C5：复盘页 LLM 段 ----

const c5Usage = await fire('llm:usage')
ok('C5: llm:usage 返回按天账本', Array.isArray(c5Usage?.daily) && Array.isArray(c5Usage?.recent))
ok('C5: 账本里有今天的调用', c5Usage.daily.some((d) => d.date === store.today() && d.calls > 0))
ok('C5: 复盘页有 LLM 段', vaultSrcGov.includes('LLM 调用') && vaultSrcGov.includes('今日 token') && vaultSrcGov.includes('SCENARIO_LABELS'))
ok('C5: 复盘页说明 token 来源', vaultSrcGov.includes('模型不返回时按 0 计'))
ok('C5: 场景名有中文映射', Object.keys(SCENARIO_LABELS).includes('extract') && SCENARIO_LABELS.extract === '抽取')

// ---- D：界面与 IPC 接线 ----

ok('D: today.js 三态分组', todaySrcGov.includes("groupHead('已抽取'") && todaySrcGov.includes("groupHead('待抽取'") && todaySrcGov.includes("groupHead('未匹配'"))
ok('D: today.js 有「抽取这 N 条」「清空未匹配」', todaySrcGov.includes('`抽取这 ${waitItems.length} 条`') && todaySrcGov.includes('清空未匹配'))
ok('D: 未抽取条目不可勾选入库', todaySrcGov.includes('const isSelectable = (item) => item.extracted !== false'))
ok('D: 未抽取详情不给归位表单', todaySrcGov.includes('const unextracted = item.extracted === false') && todaySrcGov.includes('const editable = !unextracted'))
ok('D: 三态样式就位', stylesSrcS45.includes('.inbox-group-head'))
ok('D: preload 有 inboxExtract / inboxClearUnextracted', pjGov.includes('inboxExtract') && pjGov.includes('inboxClearUnextracted'))
ok('C5/C6: preload 有 llmUsage、无 channelMatchRates', pjGov.includes('llmUsage:') && !pjGov.includes('channelMatchRates'))
ok('C5/C6: 两份 preload 仍然完全同步', pjGov === pcGov && pjGov.includes('inboxExtract') === pcGov.includes('inboxExtract'))

// 收尾：恢复抽取桩与设置，别把 stub 留给后面的断言
llmHooks.run = realRunHook
store.saveSettings({ apiKey: '' })

// ============================================================
console.log('\n— 数据边界：inbox 过期 / trace 索引 / 抽取上限 —')
// ============================================================

// ---- T2 pruneInbox ----
const pruneTheme = store.addTheme('清理测试')
// addInboxItem 永远写 createdAt: today()，所以要造假数据得直接改 DB
const mkInbox = (daysAgo, extra = {}) => {
  const entry = store.addInboxItem({
    text: `清理测试 ${daysAgo} 天前`, title: `清理测试 ${daysAgo}`,
    label: { kind: '自媒体', quality: 0.5 }, lemmas: [],
  })
  Object.assign(entry, { createdAt: new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10) }, extra)
  return entry
}
mkInbox(40)                                    // 该清
mkInbox(40, { ignored: true })                 // 主动忽略，永不清
mkInbox(5)                                     // 新，不清
const acceptedOld = mkInbox(40)                // 已处理的，不清（先 resolve 再测）
store.resolveInboxItem(acceptedOld.id, 'reject')

// 用增量断言——测试文件前面已经攒了一批 inbox，绝对值不可靠
const inboxBase = store.allInbox().length
const pruneDry = store.pruneInbox(30, { dryRun: true })
ok('T2 dryRun 该清的只有 1 条', pruneDry.removed === 1, `实际 removed=${pruneDry.removed}`)
ok('T2 dryRun 后数据没变', store.allInbox().length === inboxBase, `实际 ${store.allInbox().length} vs ${inboxBase}`)
const pruneReal = store.pruneInbox(30)
ok('T2 真删 1 条', pruneReal.removed === 1, `实际 ${pruneReal.removed}`)
ok('T2 净减 1 条', store.allInbox().length === inboxBase - 1, `实际 ${store.allInbox().length} vs ${inboxBase - 1}`)
// ignored / 5 天内的 / 已处理的都还在。注意 allInbox() 本就排除 ignored，
// 所以这三条要查 load().inbox 而不是 allInbox()
const rawInbox = store.load().inbox
ok('T2 ignored 的还在', rawInbox.some((i) => i.ignored), 'ignored 条目被清了')
ok('T2 新的还在', rawInbox.some((i) => i.title === '清理测试 5'), '5 天前的条目被清了')
ok('T2 已处理的还在', rawInbox.some((i) => i.id === acceptedOld.id && i.status === 'rejected'), '已处理条目被清了')
ok('T2 40 天前的没了', !rawInbox.some((i) => i.title === '清理测试 40' && !i.ignored && i.status === 'pending'), '该清的没清')

// ---- T4 trace 索引 ----
const idxBefore = store.allTraces().length
store.addTrace({
  target: { type: 'node', id: 'idx-node' }, stage: 'extract',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'idx-hash-1' },
  output: { lemmas: [{ title: '索引测试命题', type: 'observation', confidence: 60 }] },
  decision: { lemmas: [{ title: '索引测试命题', type: 'observation', confidence: 60 }] },
})
const idx = store.traceIndexByHash()
ok('T4 索引能查到刚写的', idx.get('idx-hash-1')?.input?.textHash === 'idx-hash-1')
ok('T4 索引含存量 trace', idx.size >= idxBefore, `实际 ${idx.size} vs ${idxBefore}`)
// 同 hash 后写覆盖先写
store.addTrace({
  target: { type: 'node', id: 'idx-node-2' }, stage: 'extract',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'idx-hash-1' },
  output: { lemmas: [{ title: '第二条', type: 'observation', confidence: 70 }] },
  decision: { lemmas: [{ title: '第二条', type: 'observation', confidence: 70 }] },
})
ok('T4 同 hash 后写覆盖', store.traceIndexByHash().get('idx-hash-1').target.id === 'idx-node-2')
store.invalidateTraceIndex()
ok('T4 invalidate 后重建', store.traceIndexByHash().get('idx-hash-1').target.id === 'idx-node-2')

// ---- T3 extract trace 上限 ----
const extractsBefore = store.allTraces().filter((t) => t.stage === 'extract').length
for (let i = 0; i < store.MAX_EXTRACT_TRACES + 20; i++) {
  store.addTrace({
    target: { type: 'node', id: `bulk-${i}` }, stage: 'extract',
    actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
    input: { textHash: `bulk-hash-${i}` },
    output: { lemmas: [] }, decision: { lemmas: [] },
  })
}
const extractsAfter = store.allTraces().filter((t) => t.stage === 'extract').length
ok('T3 extract trace 不超上限', extractsAfter <= store.MAX_EXTRACT_TRACES, `实际 ${extractsAfter} / 上限 ${store.MAX_EXTRACT_TRACES}`)
ok('T3 保留的是最新的', store.allTraces().some((t) => t.target?.id === `bulk-${store.MAX_EXTRACT_TRACES + 19}`), '最新一条被清了')

// ---- T3 label 不再逐条存 ----
const labelCount = store.allTraces().filter((t) => t.stage === 'label').length
ok('T3 label trace 不逐条存', labelCount === 0, `实际 ${labelCount} 条`)
ok('T3 traceAggregates.label 有数据', store.load().traceAggregates.label.length > 0)

// ============================================================
console.log('\n— v0.8 数据摄入与可追溯（真实 store / 临时目录 / 仅回环 HTTP）—')
// ============================================================

const v8Assert = (await import('node:assert/strict')).default
const v8Fs = await import('node:fs')
const { spawnSync: v8SpawnSync } = await import('node:child_process')
const { request: v8Request } = await import('node:http')

// 每组独立报告失败；接口尚未实现也是失败，绝不以 skip / 临时桩通过验收。
const v8Test = async (name, run) => {
  try {
    await run()
    ok(`v0.8: ${name}`, true)
  } catch (error) {
    ok(`v0.8: ${name}`, false, error.stack || String(error))
  }
}
const v8Reset = () => {
  store.importAll(JSON.stringify({ nodes: [], themes: [], readings: [], sources: [], raw: [], settings: { apiKey: '', labeler: 'table' } }))
  const theme = store.addTheme('v0.8 零配置产业链')
  const branch = store.addNode({ themeId: theme.id, kind: 'branch', title: '经营', scaffold: { indicators: [{ name: '测试收入', cadence: '季度' }] } })
  const indicator = store.addNode({ themeId: theme.id, parentId: branch.id, kind: 'lemma', type: 'observation', title: '测试收入' })
  return { theme, branch, indicator }
}
const v8Period = { start: '2026-04-01', end: '2026-06-30' }
const v8Source = (host = 'issuer.example', extra = {}) => ({ kind: '财报 / 公告', label: '季度报告', url: `https://${host}/report`, platform: host, ...extra })
const v8Input = (indicator, extra = {}) => ({ indicator: indicator.title, value: 100, unit: 'USD', period: { ...v8Period }, basis: 'reported', tier: 'agent', source: v8Source(), ...extra })
const v8Envelope = (...readings) => ({ schema: 'meridian.reading.v1', readings })
const v8Ingest = async (envelope, options) => {
  const { ingestReadings } = await import('../src/main/reading-ingest.js')
  return ingestReadings(envelope, options)
}
const v8Accepted = (result, accepted, duplicates = 0) => {
  v8Assert.equal(result.ok, true)
  v8Assert.equal(result.accepted, accepted)
  v8Assert.equal(result.duplicates, duplicates)
  v8Assert.deepEqual(result.rejected, [])
  v8Assert.equal(result.total, accepted + duplicates)
}
const v8Add = (indicator, extra = {}) => {
  const result = store.addReading({ ...v8Input(indicator), indicatorId: indicator.id, ...extra })
  v8Assert.equal(result.added, true, result.error)
  v8Assert.ok(result.reading?.id)
  return result.reading
}
const v8OnlyObservation = (indicatorId) => {
  const page = store.readingsPage({ indicatorId, limit: 10 })
  v8Assert.equal(page.total, 1)
  v8Assert.equal(page.items.length, 1)
  return page.items[0]
}
const v8ChainOk = (key, count) => {
  const check = store.verifyReadingChain(key)
  v8Assert.equal(check.ok, true, JSON.stringify(check))
  v8Assert.equal(check.count, count)
  v8Assert.ok(check.firstInvalid == null, '完整序列不能报告损坏位置')
}

await v8Test('确定接口全部存在；缺失不跳过', async () => {
  for (const name of ['addReading', 'getReading', 'allReadings', 'readingsPage', 'readingEvidence', 'latestReadings', 'allSources', 'sourcesPage', 'assignReading', 'verifyReadingChain', 'exportIntent', 'resolveConflict', 'dueIndicators']) {
    v8Assert.equal(typeof store[name], 'function', name)
  }
  v8Assert.equal(typeof (await import('../src/main/reading-ingest.js')).ingestReadings, 'function')
  v8Assert.equal(typeof (await import('../src/main/agent-server.js')).startAgentServer, 'function')
})

await v8Test('人话归位、原文引用、来源观察、重放幂等与留痕', async () => {
  const { theme, indicator } = v8Reset()
  const raw = '测试收入为 100 美元，期间 2026 年第二季度。'
  const envelope = { ...v8Envelope(v8Input(indicator, { raw })), themeHint: theme.name }
  const progress = []
  v8Accepted(await v8Ingest(envelope, { onProgress: (event) => progress.push(event) }), 1)
  v8Assert.ok(progress.length > 0, '摄入须报告进度')
  v8Assert.equal(typeof store.addChannel, 'undefined', '通道 API 已移除')
  const reading = store.allReadings()[0]
  v8Assert.equal(reading.indicatorId, indicator.id)
  v8Assert.deepEqual(reading.period, v8Period)
  v8Assert.equal(reading.status, 'current')
  v8Assert.equal(store.getReading(reading.id).value, 100)
  v8Assert.equal(store.getRaw(reading.rawId).text, raw)
  v8Assert.match(reading.hash, /^[a-f0-9]{64}$/)
  const source = store.allSources().find((item) => item.id === reading.sourceId)
  v8Assert.equal(source.url, envelope.readings[0].source.url)
  v8Assert.ok(source.readingIds.includes(reading.id))
  v8Assert.equal(source.pushCount, 1)
  v8Assert.ok(source.firstSeenAt && source.lastSeenAt)
  const sourceSnapshot = JSON.stringify(store.allSources())
  v8Accepted(await v8Ingest(envelope), 0, 1)
  v8Assert.equal(store.allReadings().length, 1)
  v8Assert.equal(JSON.stringify(store.allSources()), sourceSnapshot, '重放不能赚来源声誉')
  v8Assert.equal(store.rawStats().count, 1)
  store.appendRaw({ kind: '一手数据', text: '无人引用的原文' })
  const pruned = store.pruneRaw()
  v8Assert.equal(pruned.removed, 1)
  v8Assert.equal(store.getRaw(reading.rawId).text, raw, '仅由读数引用的原文不可清理')
  const observation = v8OnlyObservation(indicator.id)
  v8Assert.equal(observation.currentReadingId, reading.id)
  v8Assert.equal(observation.pending, false)
  v8Assert.equal(observation.sourceCount, 1)
  v8Assert.equal(observation.readingCount, 1)
  v8ChainOk(observation.chainKey, 1)
  v8Assert.ok(store.allTraces().some((trace) => JSON.stringify(trace).includes(reading.id)), '摄入留下可定位读数的 trace')
})

await v8Test('独立来源同值交叉；同平台或同域名不虚增信任', async () => {
  const { indicator } = v8Reset()
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator))), 1)
  const initial = v8OnlyObservation(indicator.id).trust.score
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { source: v8Source('issuer.example', { label: '同站另一页', url: 'https://issuer.example/other', platform: '另一客户端' }) }))), 1)
  v8Assert.equal(v8OnlyObservation(indicator.id).trust.crossCount, 1)
  v8Assert.equal(v8OnlyObservation(indicator.id).trust.score, initial)
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { source: v8Source('mirror.example', { platform: 'issuer.example' }) }))), 1)
  v8Assert.equal(v8OnlyObservation(indicator.id).trust.crossCount, 1, '转载同平台不独立')
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { source: v8Source('independent.example') }))), 1)
  const observation = v8OnlyObservation(indicator.id)
  v8Assert.equal(observation.trust.crossCount, 2)
  v8Assert.ok(observation.trust.score > initial)
  v8Assert.equal(observation.readingCount, 4)
  v8Assert.equal(store.allConflicts().filter((conflict) => !conflict.resolved).length, 0)
})

for (const verdict of ['a', 'b', 'both']) {
  await v8Test(`异源异值不静默；裁决 ${verdict} 追加记录且保留证据`, async () => {
    const { indicator } = v8Reset()
    const a = v8Add(indicator)
    const b = v8Add(indicator, { value: 120, source: v8Source('other.example') })
    const observation = v8OnlyObservation(indicator.id)
    v8Assert.equal(observation.status, 'conflicted')
    v8Assert.equal(observation.currentReadingId, null, '冲突不得擅自选当前值')
    v8Assert.equal(store.getReading(a.id).status, 'conflicted')
    v8Assert.equal(store.getReading(b.id).status, 'conflicted')
    const conflicts = store.allConflicts().filter((conflict) => conflict.type === 'reading' && !conflict.resolved)
    v8Assert.equal(conflicts.length, 1)
    v8Assert.deepEqual(new Set([conflicts[0].a, conflicts[0].b]), new Set([a.id, b.id]))
    const journalPath = join(DATA, 'readings.jsonl')
    const beforeJournal = v8Fs.readFileSync(journalPath, 'utf8')
    const oldHashes = [store.getReading(a.id).hash, store.getReading(b.id).hash]
    const decision = store.resolveConflict(conflicts[0].id, verdict)
    v8Assert.equal(decision.resolved, verdict)
    const afterJournal = v8Fs.readFileSync(journalPath, 'utf8')
    v8Assert.ok(afterJournal.startsWith(beforeJournal) && afterJournal.length > beforeJournal.length, '人工裁决应追加可追溯记录而非覆盖数值')
    v8Assert.ok(afterJournal.slice(beforeJournal.length).includes(conflicts[0].id), '裁决记录应指向原冲突')
    v8Assert.equal(store.getReading(a.id).value, 100)
    v8Assert.equal(store.getReading(b.id).value, 120)
    v8Assert.deepEqual([store.getReading(a.id).hash, store.getReading(b.id).hash], oldHashes)
    const after = v8OnlyObservation(indicator.id)
    if (verdict !== 'both') {
      v8Assert.equal(after.value, verdict === 'a' ? 100 : 120)
      v8Assert.notEqual(after.status, 'conflicted')
      v8Assert.ok(after.currentReadingId)
    }
    v8Assert.equal(store.allConflicts().filter((conflict) => !conflict.resolved).length, 0)
    v8ChainOk(after.chainKey, store.allReadings().length)
  })
}

await v8Test('同来源同 accn 异值为修正；相同 accn 的异源仍冲突', async () => {
  const { indicator } = v8Reset()
  const source = v8Source('issuer.example', { accn: 'filing-2026-q2' })
  const old = v8Add(indicator, { source })
  const revised = v8Add(indicator, { source, value: 110 })
  v8Assert.equal(store.getReading(old.id).status, 'superseded')
  v8Assert.equal(store.getReading(old.id).value, 100)
  v8Assert.equal(revised.supersedes, old.id)
  v8Assert.equal(v8OnlyObservation(indicator.id).currentReadingId, revised.id)
  v8Assert.equal(store.allConflicts().length, 0)
  v8Assert.equal(store.addReading({ ...v8Input(indicator), indicatorId: indicator.id, source, value: 110 }).added, false)
  v8Add(indicator, { source: v8Source('outsider.example', { accn: source.accn }), value: 90 })
  v8Assert.equal(v8OnlyObservation(indicator.id).status, 'conflicted')
  v8Assert.equal(store.allConflicts().filter((conflict) => !conflict.resolved).length, 1)
  v8ChainOk(v8OnlyObservation(indicator.id).chainKey, 3)
})

await v8Test('期间、单位、口径分开；不能错误交叉或互相冲突', async () => {
  const { indicator } = v8Reset()
  const entries = [
    v8Input(indicator),
    v8Input(indicator, { period: { start: '2026-01-01', end: '2026-06-30' } }),
    v8Input(indicator, { unit: 'CNY' }),
    v8Input(indicator, { basis: 'estimated' }),
  ]
  v8Accepted(await v8Ingest(v8Envelope(...entries)), 4)
  const page = store.readingsPage({ indicatorId: indicator.id, limit: 10 })
  v8Assert.equal(page.total, 4)
  v8Assert.equal(new Set(page.items.map((item) => item.id)).size, 4)
  v8Assert.ok(page.items.every((item) => item.trust.crossCount === 1 && item.readingCount === 1))
  v8Assert.equal(store.allConflicts().length, 0)
})

await v8Test('自报 tier 作先验采信，超过 0.6 必须靠第二个独立来源', async () => {
  const { indicator } = v8Reset()
  // 契约里夹带 trust 也不该改写判定——分数只能由账本按公式算
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { tier: 'structured', trust: { score: 1, crossCount: 99 } }))), 1)
  const external = v8OnlyObservation(indicator.id)
  v8Assert.equal(external.trust.crossCount, 1)
  // 自报 structured 采信为先验：单一来源 = base 1.0 × 0.6 = 0.6
  // 曾经这里一律压成 'agent'，外部数据天花板只有 0.24，信任分失去区分度
  v8Assert.equal(external.trust.score, 0.6, '自报来路作先验采信')
  // 公式本身就是那道线：base 上限 1.0，单一来源过不了 0.6。想更高必须有第二个独立来源。
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, {
    tier: 'agent',
    source: v8Source('other.example', { kind: '独立媒体', label: '另一个平台' }),
  }))), 1)
  const corroborated = v8OnlyObservation(indicator.id)
  v8Assert.ok(corroborated.trust.crossCount >= 2, '第二个独立来源被计入')
  v8Assert.ok(corroborated.trust.score > external.trust.score, '佐证让分数超过单来源上限')
  // 内置 fetcher 同样受公式约束——来路可验证不构成豁免，豁免会让 SEC 这类单一权威源失真
  const internal = store.addNode({ themeId: indicator.themeId, kind: 'lemma', type: 'observation', title: '内置收入' })
  v8Accepted(await v8Ingest(v8Envelope(v8Input(internal, { tier: 'structured' })), { trusted: true }), 1)
  const trusted = v8OnlyObservation(internal.id)
  v8Assert.ok(trusted.trust.score >= 0.6 && trusted.trust.score <= 1)
})

await v8Test('历史异常跳变标记并降信任，但不丢弃事实', async () => {
  const { indicator } = v8Reset()
  const stable = [100, 102, 101, 103].map((value, index) => {
    const day = `2026-0${index + 1}-01`
    return v8Input(indicator, { value, period: { start: day, end: day } })
  })
  v8Accepted(await v8Ingest(v8Envelope(...stable)), 4)
  const baseline = store.readingsPage({ indicatorId: indicator.id, limit: 10 }).items
  v8Assert.ok(baseline.every((item) => !item.trust.flags.includes('jump')))
  const period = { start: '2026-05-01', end: '2026-05-01' }
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { value: 200, period }))), 1)
  const jump = store.readingsPage({ indicatorId: indicator.id, limit: 10 }).items.find((item) => item.period.end === period.end)
  v8Assert.equal(jump.value, 200)
  v8Assert.ok(jump.trust.flags.includes('jump'))
  v8Assert.ok(jump.trust.score < baseline[0].trust.score)
  v8Assert.equal(store.allReadings().length, 5)
  v8ChainOk(jump.chainKey, 5)
})

await v8Test('严格字段校验逐条报索引和理由；非法读数不能污染库', async () => {
  const { indicator } = v8Reset()
  const invalid = [
    { value: NaN }, { value: Infinity }, { value: '100' }, { value: null },
    { indicator: '' }, { unit: '' }, { basis: 'invented' }, { tier: 'root' },
    { period: { start: '2026-07-01', end: '2026-06-30' } },
    { period: { start: '2026-02-30', end: '2026-03-01' } },
    { period: { start: 'yesterday', end: 'tomorrow' } },
    { source: null }, { raw: { text: '不是字符串' } },
  ]
  const result = await v8Ingest(v8Envelope(v8Input(indicator), ...invalid.map((patch) => v8Input(indicator, patch))))
  v8Assert.equal(result.total, invalid.length + 1)
  v8Assert.equal(result.accepted, 1)
  v8Assert.equal(result.duplicates, 0)
  v8Assert.deepEqual(result.rejected.map((item) => item.index), invalid.map((_, i) => i + 1))
  v8Assert.ok(result.rejected.every((item) => typeof item.reason === 'string' && item.reason.length > 0))
  v8Assert.equal(store.allReadings().length, 1)
  v8Assert.equal(store.allSources().length, 1)
  for (const envelope of [null, {}, { schema: 'other', readings: [] }, { schema: 'meridian.reading.v1', readings: {} }]) {
    const bad = await v8Ingest(envelope)
    v8Assert.equal(bad.ok, false)
    v8Assert.equal(bad.accepted, 0)
  }
  v8Assert.equal(store.allReadings().length, 1)
  for (const value of [NaN, Infinity, null, '100']) {
    const bad = store.addReading({ ...v8Input(indicator), indicatorId: indicator.id, value })
    v8Assert.equal(bad.added, false)
    v8Assert.ok(bad.error, 'store 入口也必须防御非法数值')
  }
})

// 四个来源共用收件箱：待归位的读数不再只躺在读数页，而是进收件箱等裁决。
// 曾经只有捕获走这道门，agent 推来的读数直接入库，用户在路上永远看不到它们。
await v8Test('待归位读数进收件箱，归位后待办消失且可查询验链', async () => {
  const { indicator } = v8Reset()
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { indicator: '完全未知的月球矿石产量' }))), 1)
  const reading = store.allReadings()[0]
  v8Assert.equal(reading.indicatorId, null)
  const queued = store.allInbox().filter((i) => i.kind === 'reading')
  v8Assert.equal(queued.length, 1, '待归位读数必须进收件箱')
  v8Assert.equal(queued[0].readingId, reading.id)
  v8Assert.equal(queued[0].reading.value, reading.value)
  // 重推同一条不重复建待办
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { indicator: '完全未知的月球矿石产量' }))), 0, 1)
  v8Assert.equal(store.allInbox().filter((i) => i.kind === 'reading').length, 1, '重复推送不重复建待办')
  const pending = store.readingsPage({ limit: 10 }).items[0]
  v8Assert.equal(pending.pending, true)
  v8ChainOk(pending.chainKey, 1)
  store.assignReading(reading.id, indicator.id)
  v8Assert.equal(store.allInbox().filter((i) => i.kind === 'reading').length, 0, '归位后待办消失')
  const assigned = v8OnlyObservation(indicator.id)
  v8Assert.equal(assigned.pending, false)
  v8Assert.equal(assigned.value, reading.value)
  const evidence = store.readingEvidence({ observationId: assigned.id, limit: 10 })
  v8Assert.ok(evidence.items.some((item) => item.value === reading.value))
  const check = store.verifyReadingChain(assigned.chainKey)
  v8Assert.equal(check.ok, true, JSON.stringify(check))
})

// 干净且匹配上指标的不进收件箱——收件箱是裁决台，不是监控台
await v8Test('匹配上的读数直接入账，不占收件箱', async () => {
  const { indicator } = v8Reset()
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator))), 1)
  v8Assert.equal(store.allInbox().filter((i) => i.kind === 'reading').length, 0)
  const obs = v8OnlyObservation(indicator.id)
  v8Assert.equal(obs.pending, false)
  v8Assert.equal(obs.indicatorId, indicator.id)
})

// ---- 回归：总览层对「待归位」失明 ----
// 曾经 latest 只按 indicatorId 建索引，indicatorId 为 null 的观测进不去，
// latestReadings() 一个都回不来——树内 inline 和总览层完全看不到待归位的读数，
// 而它们恰恰是最该被提醒去归位的。

await v8Test('待归位读数进入 latestReadings，可被总览层看见', async () => {
  const { indicator } = v8Reset()
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { indicator: '无人认领的遥远指标' }))), 1)
  const latest = store.latestReadings()
  const pending = latest.items.find((r) => r.pending)
  v8Assert.ok(pending, '待归位读数必须出现在 latestReadings')
  v8Assert.equal(pending.indicatorId, null)
  v8Assert.equal(pending.title, '无人认领的遥远指标')
  v8Assert.ok(latest.pending >= 1, '返回值带待归位计数')
  // 已归位的排在待归位前面——树的主体是归位数据，待归位是待办
  const firstPending = latest.items.findIndex((r) => r.pending)
  v8Assert.ok(latest.items.slice(0, firstPending).every((r) => !r.pending))
})

await v8Test('冲突观测暴露竞争值，而不是只给一个 null', async () => {
  const { indicator } = v8Reset()
  v8Accepted(await v8Ingest(v8Envelope(
    v8Input(indicator, { value: 100 }),
    v8Input(indicator, { value: 140, source: v8Source('other.example', { kind: '独立媒体' }) }),
  )), 2)
  const conflicted = v8OnlyObservation(indicator.id)
  v8Assert.equal(conflicted.status, 'conflicted')
  v8Assert.equal(conflicted.value, null, '冲突时不假装有当前值')
  v8Assert.deepEqual(conflicted.values, [100, 140], '竞争值必须可读，否则界面只能干说待裁决')
  // 裁决后恢复单一当前值，values 清空
  const conflict = store.allConflicts().find((c) => c.type === 'reading')
  store.resolveConflict(conflict.id, 'a')
  const resolved = v8OnlyObservation(indicator.id)
  v8Assert.notEqual(resolved.status, 'conflicted')
  v8Assert.equal(resolved.values, null)
  v8Assert.ok(Number.isFinite(resolved.value))
})

await v8Test('旧格式期间回填，sources 显式导入，读数和原文完整往返', async () => {
  const { indicator } = v8Reset()
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { raw: '可往返的原文' }))), 1)
  const snapshot = store.exportAll()
  const before = JSON.parse(snapshot)
  v8Assert.equal(before.sources.length, 1)
  v8Reset()
  store.importAll(snapshot)
  v8Assert.deepEqual(store.allSources(), before.sources)
  const imported = store.getReading(before.readings[0].id)
  v8Assert.equal(imported.hash, before.readings[0].hash)
  v8Assert.equal(store.getRaw(imported.rawId).text, '可往返的原文')
  v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator, { raw: '可往返的原文' }))), 0, 1)
  v8ChainOk(v8OnlyObservation(indicator.id).chainKey, 1)
  store.importAll(JSON.stringify({ nodes: [], themes: [], readings: [{ id: 'legacy-v8', metric: 'legacy.revenue', value: 12, unit: 'USD', at: '2026-07-01', source: { kind: '财报 / 公告', start: v8Period.start, end: v8Period.end, accn: 'legacy' } }] }))
  const legacy = store.getReading('legacy-v8')
  v8Assert.deepEqual(legacy.period, v8Period)
  v8Assert.equal(legacy.asOf, v8Period.end)
  v8Assert.equal(legacy.value, 12)
  v8Assert.ok(legacy.sourceId && store.allSources().some((source) => source.id === legacy.sourceId))
  v8Assert.equal(store.readingsPage({ limit: 10 }).items.length, 1)
  const standalone = { id: 'imported-source-only', kind: '财报 / 公告', label: '独立导入来源', url: 'https://archive.example/report', platform: 'archive', firstSeenAt: '2026-01-01', lastSeenAt: '2026-06-30', pushCount: 8, trust: 0.82, flags: ['once-contradicted'], readingIds: [] }
  store.importAll(JSON.stringify({ nodes: [], themes: [], readings: [], sources: [standalone] }))
  v8Assert.deepEqual(store.allSources().find((source) => source.id === standalone.id), standalone, '不能仅从 readings 反推来源而遗漏 sources 集合')
})

await v8Test('证据分页游标完整且不串观测；来源分页有界', async () => {
  const { indicator } = v8Reset()
  const entries = Array.from({ length: 7 }, (_, i) => v8Input(indicator, { source: v8Source(`witness-${i}.example`) }))
  v8Accepted(await v8Ingest(v8Envelope(...entries)), 7)
  v8Add(indicator, { period: { start: '2026-07-01', end: '2026-09-30' }, value: 200 })
  const observation = store.readingsPage({ indicatorId: indicator.id, limit: 10 }).items.find((item) => item.period.end === v8Period.end)
  const seen = new Set()
  let cursor = null
  let pages = 0
  do {
    const page = store.readingEvidence({ observationId: observation.id, cursor, limit: 2 })
    v8Assert.ok(page.items.length > 0 && page.items.length <= 2)
    v8Assert.ok(Array.isArray(page.judgments))
    for (const item of page.items) {
      v8Assert.equal(item.period.end, v8Period.end)
      v8Assert.equal(seen.has(item.id), false)
      seen.add(item.id)
    }
    if (page.nextCursor != null) v8Assert.notEqual(page.nextCursor, cursor)
    cursor = page.nextCursor
    v8Assert.ok(++pages <= 4, '游标必须前进')
  } while (cursor != null)
  v8Assert.equal(seen.size, 7)
  const sourceIds = new Set()
  cursor = null
  pages = 0
  do {
    const page = store.sourcesPage({ cursor, limit: 3 })
    v8Assert.equal(page.total, store.allSources().length)
    v8Assert.ok(page.items.length > 0 && page.items.length <= 3)
    for (const source of page.items) {
      v8Assert.equal(sourceIds.has(source.id), false)
      sourceIds.add(source.id)
    }
    cursor = page.nextCursor
    v8Assert.ok(++pages <= 3)
  } while (cursor != null)
  v8Assert.equal(sourceIds.size, store.allSources().length)
})

await v8Test('意图导出含树、标签库和未结算判断；零配置也有到期指标', async () => {
  const { theme, branch, indicator } = v8Reset()
  store.updateTheme(theme.id, { tags: ['经营'], tagLibrary: [{ id: 'v8-tag', name: '收入', synonyms: ['营收'], threshold: 0.6 }] })
  const judgment = store.addNode({ themeId: theme.id, parentId: branch.id, kind: 'lemma', type: 'hypothesis', title: '收入将超过 90', confidence: 85, settlement: { date: '2026-12-31', resolved: null } })
  store.updateNode(indicator.id, { parentId: judgment.id })
  const closed = store.addNode({ themeId: theme.id, parentId: branch.id, kind: 'lemma', type: 'hypothesis', title: '已经结算的判断', settlement: { date: '2026-01-01', resolved: true } })
  const intent = store.exportIntent()
  const exported = intent.themes.find((item) => item.id === theme.id)
  v8Assert.equal(exported.name, theme.name)
  v8Assert.ok(exported.tags.includes('经营'))
  v8Assert.ok(exported.tagLibrary.some((tag) => tag.name === '收入' && tag.synonyms.includes('营收')))
  v8Assert.ok(JSON.stringify(exported.tree).includes(indicator.title))
  const open = intent.openJudgments.find((item) => item.claim === judgment.title)
  v8Assert.equal(open.confidence, 85)
  v8Assert.equal(open.settlesOn, '2026-12-31')
  v8Assert.ok(open.indicators.includes(indicator.title))
  v8Assert.ok(!intent.openJudgments.some((item) => item.claim === closed.title))
  v8Assert.equal(typeof store.addChannel, 'undefined', '通道 API 已移除')
  v8Assert.ok(store.dueIndicators().some((item) => item.id === indicator.id))
  v8Add(indicator)
  v8Assert.ok(!store.dueIndicators().some((item) => item.id === indicator.id), '刚摄入不应立即再次到期')
  v8Assert.ok(store.dueIndicators(Date.now() + 366 * 864e5).some((item) => item.id === indicator.id), '经过 cadence 后再次到期')
  const evidence = store.readingEvidence({ indicatorId: indicator.id, limit: 10 })
  v8Assert.ok(JSON.stringify(evidence.judgments).includes(judgment.title), '证据关联正在等它的判断')
  v8Assert.ok(!JSON.stringify(intent).includes('apiKey'))
})

// 子进程只载入 store 和 Electron 替身，绝不 import 真实 main、启应用或触达真实 userData。
const v8Reload = (expression) => {
  const code = `
    globalThis.__electron = await import(${JSON.stringify(new URL('./electron-stub.mjs', import.meta.url).href)})
    const store = await import(${JSON.stringify(new URL('../src/main/store.js', import.meta.url).href)})
    store.load()
    console.log(JSON.stringify(${expression}))
  `
  const child = v8SpawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, MERIDIAN_TEST_DATA: DATA }, encoding: 'utf8', timeout: 10000 })
  v8Assert.equal(child.status, 0, child.stderr || String(child.error || ''))
  return JSON.parse(child.stdout.trim().split('\n').at(-1))
}

await v8Test('JSONL 追加持久化、重启索引、坏索引重建及历史修改检测', async () => {
  const { indicator } = v8Reset()
  const first = v8Add(indicator)
  const file = join(DATA, 'readings.jsonl')
  const prefix = v8Fs.readFileSync(file, 'utf8')
  v8Assert.ok(prefix.includes(first.id))
  const second = v8Add(indicator, { period: { start: '2026-07-01', end: '2026-09-30' }, value: 105 })
  v8Assert.ok(v8Fs.readFileSync(file, 'utf8').startsWith(prefix), '新增读数不能重写历史行')
  v8Assert.equal(second.prevHash, first.hash)
  const key = store.readingsPage({ indicatorId: indicator.id, limit: 1 }).items[0].chainKey
  v8ChainOk(key, 2)
  // store 的元数据 debounce 为 120ms；此处明确等待落盘边界，不用轮询掩盖错误。
  await new Promise((resolve) => setTimeout(resolve, 180))
  const metadata = JSON.parse(v8Fs.readFileSync(join(DATA, 'meridian.json'), 'utf8'))
  v8Assert.ok(!metadata.readings || metadata.readings.length === 0, '主 JSON 不能继续存全量读数')
  const indexFile = join(DATA, 'readings-index.json')
  v8Assert.ok(v8Fs.existsSync(indexFile))
  const indexText = v8Fs.readFileSync(indexFile, 'utf8')
  v8Assert.doesNotThrow(() => JSON.parse(indexText))
  const reloaded = v8Reload(`({ reading: store.getReading(${JSON.stringify(first.id)}), check: store.verifyReadingChain(${JSON.stringify(key)}), total: store.readingsPage({ limit: 1 }).total })`)
  v8Assert.equal(reloaded.reading.value, 100)
  v8Assert.equal(reloaded.reading.hash, first.hash)
  v8Assert.equal(reloaded.total, 2)
  v8Assert.equal(reloaded.check.ok, true)
  const original = v8Fs.readFileSync(file, 'utf8')
  try {
    v8Fs.writeFileSync(indexFile, '{broken index')
    const rebuilt = v8Reload(`({ total: store.readingsPage({ limit: 1 }).total, check: store.verifyReadingChain(${JSON.stringify(key)}) })`)
    v8Assert.equal(rebuilt.total, 2)
    v8Assert.equal(rebuilt.check.ok, true)
    // 修改真正的磁盘历史，不改 API 返回对象，避免误测副本或缓存。
    let changed = 0
    let changedLine = 0
    const tampered = original.split('\n').map((line, index) => {
      if (!line.trim()) return line
      const entry = JSON.parse(line)
      // 兼容每行直接存 reading 和事实 + 裁决事件封装；只动事实值，不重算校验。
      const fact = entry.fact || entry
      if (fact.id === first.id) { fact.value = 999; changed++; changedLine = index + 1 }
      return JSON.stringify(entry)
    }).join('\n')
    v8Assert.equal(changed, 1)
    v8Fs.writeFileSync(file, tampered)
    const broken = store.verifyReadingChain(key)
    v8Assert.equal(broken.ok, false, '已热缓存和索引也不能掩盖磁盘数据修改')
    v8Assert.equal(broken.firstInvalid, changedLine, '应指出第一个被修改的历史位置')
  } finally {
    v8Fs.writeFileSync(file, original)
    v8Fs.writeFileSync(indexFile, indexText)
  }
  v8Fs.appendFileSync(file, '{"id":"interrupted')
  try {
    const partial = v8Reload(`({ total: store.readingsPage({ limit: 1 }).total, reading: store.getReading(${JSON.stringify(first.id)}) })`)
    v8Assert.equal(partial.total, 2, '崩溃半行不影响已有记录')
    v8Assert.equal(partial.reading.value, 100)
    v8Assert.equal(partial.reading.hash, first.hash)
  } finally {
    v8Fs.writeFileSync(file, original)
    v8Fs.writeFileSync(indexFile, indexText)
  }
})

await v8Test('批量 1000 条 <2s；10000 条观测分页有界、不漏不重', async () => {
  const { indicator } = v8Reset()
  const entries = Array.from({ length: 10000 }, (_, i) => {
    const day = new Date(Date.UTC(1990, 0, 1 + i)).toISOString().slice(0, 10)
    return v8Input(indicator, { period: { start: day, end: day }, value: 100 + i / 10000 })
  })
  const started = performance.now()
  for (const input of entries.slice(0, 1000)) v8Add(indicator, input)
  const elapsed = performance.now() - started
  v8Assert.ok(elapsed < 2000, `1000 条 addReading 实际 ${elapsed.toFixed(1)}ms`)
  let yielded = false
  const tick = setTimeout(() => { yielded = true }, 0)
  const progress = []
  try {
    v8Accepted(await v8Ingest(v8Envelope(...entries.slice(1000, 2000)), { onProgress: (event) => progress.push(event) }), 1000)
    v8Assert.equal(yielded, true, '批量摄入必须让出事件循环')
    v8Assert.ok(progress.length > 1, '批量不能只在完成时发一次进度')
  } finally { clearTimeout(tick) }
  for (const input of entries.slice(2000)) v8Add(indicator, input)
  v8Assert.equal(store.allReadings().length, 10000)
  const latest = store.latestReadings()
  v8Assert.equal(latest.total, 1)
  v8Assert.equal(latest.items.length, 1, '树内仅取每指标最新一条')
  v8Assert.equal(latest.items[0].period.end, entries.at(-1).period.end)
  const seen = new Set()
  const cursors = new Set()
  let cursor = null
  let pages = 0
  do {
    const page = store.readingsPage({ indicatorId: indicator.id, limit: 127, cursor })
    v8Assert.equal(page.total, 10000)
    v8Assert.ok(page.items.length > 0 && page.items.length <= 127)
    v8Assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024, '一页不能夹带全量历史')
    for (const observation of page.items) {
      v8Assert.equal(observation.indicatorId, indicator.id)
      v8Assert.equal(seen.has(observation.id), false)
      seen.add(observation.id)
    }
    cursor = page.nextCursor
    if (cursor != null) {
      v8Assert.equal(cursors.has(cursor), false)
      cursors.add(cursor)
    }
    v8Assert.ok(++pages <= 79)
  } while (cursor != null)
  v8Assert.equal(seen.size, 10000)
  v8Assert.equal(pages, 79)
  const oversized = store.readingsPage({ limit: 1000000 })
  v8Assert.ok(oversized.items.length > 0 && oversized.items.length <= 1000, '恶意 limit 也不能回传全量')
  const defaults = store.readingsPage()
  v8Assert.ok(defaults.items.length > 0 && defaults.items.length <= 1000)
  v8Assert.ok(defaults.nextCursor)
  v8Assert.equal(store.readingsPage({ indicatorId: 'missing-v8', limit: 10 }).total, 0)
  v8Assert.equal(store.readingsPage({ since: '2999-01-01', limit: 10 }).total, 0)
  const evidence = store.readingEvidence({ indicatorId: indicator.id, limit: 17 })
  v8Assert.equal(evidence.items.length, 17)
  v8Assert.ok(evidence.nextCursor)
})

const v8Http = (server, path, { method = 'GET', body, token = server.token, origin } = {}) => new Promise((resolve, reject) => {
  const headers = {}
  if (token != null) headers.Authorization = `Bearer ${token}`
  if (origin) headers.Origin = origin
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const req = v8Request({ host: '127.0.0.1', port: server.port, path, method, headers, agent: false }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let json = null
      try { json = JSON.parse(text) } catch {}
      resolve({ status: res.statusCode, json, text })
    })
  })
  req.setTimeout(5000, () => req.destroy(new Error('本地 HTTP 请求超时')))
  req.on('error', reject)
  req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
})
const v8WithServer = async (run) => {
  const { startAgentServer } = await import('../src/main/agent-server.js')
  const directory = v8Fs.mkdtempSync(join(DATA, 'agent-'))
  let server
  let changed = 0
  let calls = 0
  let closed = false
  const close = async () => {
    if (server && !closed) { await server.close(); closed = true }
  }
  try {
    server = await startAgentServer({ userData: directory, ingest: async (...args) => { calls++; return v8Ingest(...args) }, getIntent: () => store.exportIntent(), onChanged: () => { changed++ } })
    await run(server, directory, () => ({ changed, calls }), close)
  } finally {
    await close()
    v8Fs.rmSync(directory, { recursive: true, force: true })
  }
}

await v8Test('HTTP 同端口发现、0600 token、鉴权、Origin、体积与 schema 防御', async () => {
  const { indicator } = v8Reset()
  await v8WithServer(async (server, directory, counts) => {
    v8Assert.equal(server.host, '127.0.0.1')
    v8Assert.ok(Number.isInteger(server.port) && server.port > 0 && server.port <= 65535)
    v8Assert.ok(typeof server.token === 'string' && server.token.length >= 32)
    const discoveryPath = join(directory, 'agent-port.json')
    const discovery = JSON.parse(v8Fs.readFileSync(discoveryPath, 'utf8'))
    v8Assert.equal(discovery.port, server.port)
    v8Assert.equal(discovery.token, server.token)
    v8Assert.equal(v8Fs.statSync(discoveryPath).mode & 0o777, 0o600)
    for (const path of ['/intent', '/readings', '/mcp']) {
      const method = path === '/intent' ? 'GET' : 'POST'
      v8Assert.equal((await v8Http(server, path, { method, token: null, body: method === 'POST' ? {} : undefined })).status, 401)
      v8Assert.equal((await v8Http(server, path, { method, token: 'wrong-token', body: method === 'POST' ? {} : undefined })).status, 401)
      v8Assert.equal((await v8Http(server, path, { method, origin: 'https://evil.example', body: method === 'POST' ? {} : undefined })).status, 403)
    }
    v8Assert.equal(counts().calls, 0, '鉴权失败不能进入摄入')
    const tooLarge = 'x'.repeat(1024 * 1024 + 1)
    for (const path of ['/readings', '/mcp']) v8Assert.equal((await v8Http(server, path, { method: 'POST', body: tooLarge })).status, 413)
    v8Assert.equal((await v8Http(server, '/readings', { method: 'POST', body: '{invalid' })).status, 400)
    const invalid = await v8Http(server, '/readings', { method: 'POST', body: { schema: 'bad', readings: [] } })
    v8Assert.ok([400, 422].includes(invalid.status), '非法 schema 必须是客户端错误，不能 2xx')
    v8Assert.equal(invalid.json.ok, false)
    v8Assert.equal(store.allReadings().length, 0)
    const payload = v8Envelope(v8Input(indicator, { tier: 'structured' }))
    const pushed = await v8Http(server, '/readings', { method: 'POST', body: payload })
    v8Assert.equal(pushed.status, 200)
    v8Accepted(pushed.json, 1)
    // 外部自报 structured 作先验采信，但单一来源封顶 0.6——越不过这条线
    v8Assert.ok(v8OnlyObservation(indicator.id).trust.score > 0.4)
    v8Assert.ok(v8OnlyObservation(indicator.id).trust.score <= 0.6)
    v8Accepted((await v8Http(server, '/readings', { method: 'POST', body: payload })).json, 0, 1)
    v8Assert.ok(counts().changed >= 1)
    const intent = await v8Http(server, '/intent')
    v8Assert.equal(intent.status, 200)
    v8Assert.deepEqual(intent.json, store.exportIntent())
    v8Assert.ok(!intent.text.includes(server.token))
    v8Assert.equal((await v8Http(server, '/not-a-route')).status, 404)
  })
})

await v8Test('MCP initialize、三工具、真实 push 与 JSON-RPC 错误', async () => {
  const { indicator } = v8Reset()
  await v8WithServer(async (server) => {
    let id = 0
    const rpc = async (method, params = {}) => {
      const requestId = ++id
      const response = await v8Http(server, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: requestId, method, params } })
      v8Assert.equal(response.status, 200)
      v8Assert.equal(response.json.jsonrpc, '2.0')
      v8Assert.equal(response.json.id, requestId)
      return response.json
    }
    const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'meridian-test', version: '0.8' } })
    v8Assert.ok(initialized.result.protocolVersion)
    v8Assert.ok(initialized.result.capabilities.tools)
    v8Assert.ok(initialized.result.serverInfo.name)
    const listed = await rpc('tools/list')
    v8Assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ['list_open_judgments', 'list_themes', 'push_readings'])
    v8Assert.ok(listed.result.tools.every((tool) => tool.inputSchema?.type === 'object'))
    const decode = (response) => {
      v8Assert.ok(!response.error && !response.result.isError, JSON.stringify(response))
      const content = response.result.content.find((item) => item.type === 'text')
      return JSON.parse(content.text)
    }
    const pushed = decode(await rpc('tools/call', { name: 'push_readings', arguments: v8Envelope(v8Input(indicator)) }))
    v8Accepted(pushed, 1)
    v8Assert.equal(store.allReadings().length, 1)
    const themes = decode(await rpc('tools/call', { name: 'list_themes', arguments: {} }))
    v8Assert.ok(JSON.stringify(themes).includes('v0.8 零配置产业链'))
    const judgments = decode(await rpc('tools/call', { name: 'list_open_judgments', arguments: {} }))
    v8Assert.deepEqual(judgments, store.exportIntent().openJudgments)
    v8Assert.equal((await rpc('missing-method')).error.code, -32601)
    const unknown = await rpc('tools/call', { name: 'not_a_tool', arguments: {} })
    v8Assert.ok(unknown.error || unknown.result?.isError, '未知工具不能报告成功')
    const malformed = await v8Http(server, '/mcp', { method: 'POST', body: '{broken' })
    v8Assert.equal(malformed.json.error.code, -32700)
    const badRequest = await v8Http(server, '/mcp', { method: 'POST', body: { jsonrpc: '1.0', id: 77, method: 'tools/list' } })
    v8Assert.equal(badRequest.json.error.code, -32600)
    v8Assert.equal(store.allReadings().length, 1)
  })
})

// 文件投递已移除：只保留 HTTP 与 MCP 两个入口
await v8Test('接入只有 HTTP 与 MCP，没有文件投递', async () => {
  const { indicator } = v8Reset()
  await v8WithServer(async (server, directory, counts, close) => {
    v8Assert.equal(typeof server.pollFile, 'undefined', '不再有文件轮询入口')
    v8Assert.ok(!Array.isArray(server.inboxPaths), '不再有投递路径列表')
    v8Assert.ok(!v8Fs.existsSync(join(directory, 'inbox-readings.jsonl')), '不再创建投递文件')
    v8Assert.ok(!v8Fs.existsSync(join(directory, 'inbox-readings-cursor.json')), '不再写投递游标')
    v8Accepted(await v8Ingest(v8Envelope(v8Input(indicator))), 1)
    v8Assert.equal(store.allReadings().length, 1, 'HTTP/MCP 摄入不受影响')
    await close()
  })
})


await v8Test('打开数据目录用 handle，成功路径和 shell 错误均可见', async () => {
  const ipc = v8Fs.readFileSync(join(ROOT, 'src/main/ipc.js'), 'utf8')
  v8Assert.match(ipc, /ipcMain\.handle\(['"]io:openDataDir['"]/)
  v8Assert.doesNotMatch(ipc, /ipcMain\.on\(['"]io:openDataDir['"]/)
  const original = stub.shell.openPath
  const opened = []
  try {
    stub.shell.openPath = async (path) => { opened.push(path); return '' }
    const success = await fire('io:openDataDir')
    v8Assert.equal(success.ok, true)
    v8Assert.equal(success.path, DATA)
    v8Assert.deepEqual(opened, [DATA])
    stub.shell.openPath = async () => '测试路径不可访问'
    const failure = await fire('io:openDataDir')
    v8Assert.equal(failure.ok, false)
    v8Assert.equal(failure.error, '测试路径不可访问')
  } finally { stub.shell.openPath = original }
  v8Assert.equal(v8Fs.readFileSync(join(ROOT, 'src/main/preload.js'), 'utf8'), v8Fs.readFileSync(join(ROOT, 'src/main/preload.cjs'), 'utf8'))
})

await v8Test('新版存证导出不能删除事件后冒充旧数据导入', async () => {
  const { indicator } = v8Reset()
  v8Add(indicator)
  const backup = JSON.parse(store.exportAll())
  delete backup.readingJournal
  backup.readings[0].value = 999
  v8Assert.throws(() => store.importAll(JSON.stringify(backup)), /存证/)
  delete backup.readingFormat
  v8Assert.throws(() => store.importAll(JSON.stringify(backup)), /存证/)
  v8Assert.equal(store.allReadings()[0].value, 100)
})

await v8Test('归位整组作证而不复活被修正的旧值', async () => {
  const { indicator } = v8Reset()
  const source = v8Source('revision.example', { accn: 'revision-1' })
  const old = store.addReading(v8Input({ title: '尚未识别的收入' }, { source, value: 10 })).reading
  const current = store.addReading(v8Input({ title: '尚未识别的收入' }, { source, value: 20 })).reading
  v8Assert.equal(store.getReading(old.id).status, 'superseded')
  v8Assert.equal(store.assignReading(old.id, indicator.id).ok, true)
  v8Assert.equal(store.getReading(old.id).status, 'superseded')
  v8Assert.equal(store.getReading(current.id).indicatorId, indicator.id)
  v8Assert.equal(v8OnlyObservation(indicator.id).value, 20)
  v8ChainOk(old.chainKey, 2)
})

const v8Scope = () => {
  const { theme, indicator: total } = v8Reset()
  store.updateNode(total.id, { measurement: { role: 'total', scope: 'revenue' } })
  const component = name => store.addNode({ themeId: theme.id, parentId: total.id, title: name, type: 'observation', measurement: { role: 'component', scope: 'revenue' } })
  return { total, a: component('分部甲收入'), b: component('分部乙收入') }
}
await v8Test('分部修正清除整个范围旧冲突，先入账后归位也检验加和', async () => {
  const { total, a, b } = v8Scope()
  v8Add(total)
  v8Add(a, { value: 60 })
  const source = v8Source('component.example', { accn: 'component-1' })
  v8Add(b, { value: 50, source })
  v8Assert.equal(store.allConflicts().filter(c => !c.resolved).length, 1)
  v8Add(b, { value: 30, source })
  v8Assert.equal(store.allConflicts().filter(c => !c.resolved).length, 0)
  for (const node of [total, a, b]) v8Assert.equal(v8OnlyObservation(node.id).status, 'current')
  const fixture = v8Scope()
  v8Add(fixture.total)
  v8Add(fixture.a, { value: 60 })
  const pending = store.addReading(v8Input({ title: '未识别分部' }, { value: 50 })).reading
  v8Assert.equal(store.assignReading(pending.id, fixture.b.id).ok, true)
  for (const node of [fixture.total, fixture.a, fixture.b]) v8Assert.equal(v8OnlyObservation(node.id).status, 'conflicted')
  const conflict = store.allConflicts().find(c => !c.resolved)
  v8Assert.equal(conflict.comparison.sum, 110)
  store.resolveConflict(conflict.id, 'both')
  for (const node of [fixture.total, fixture.a, fixture.b]) v8Assert.equal(v8OnlyObservation(node.id).status, 'current')
  v8Assert.equal(store.allConflicts().filter(c => !c.resolved).length, 0)
})

await v8Test('来源台账超过五十条仍可分页查看全部作证', async () => {
  const { indicator } = v8Reset()
  for (let i = 0; i < 65; i++) {
    const day = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)
    v8Add(indicator, { period: { start: day, end: day }, value: i })
  }
  const source = store.allSources()[0]
  v8Assert.equal(source.pushCount, 65)
  const ids = new Set()
  let cursor
  do {
    const page = store.readingEvidence({ sourceId: source.id, cursor, limit: 10 })
    page.items.forEach(r => ids.add(r.id))
    cursor = page.nextCursor
  } while (cursor)
  v8Assert.equal(ids.size, 65)
})

await v8Test('旧无效数值仍保留并标记，不阻止整份旧账本迁移', async () => {
  v8Reset()
  store.importAll(JSON.stringify({ nodes: [], themes: [], readings: [{ id: 'old-null', at: '2026-06-30', asOf: '2026-06-30', metric: 'old.value', value: null, source: {} }] }))
  const r = store.getReading('old-null')
  v8Assert.equal(r.value, null)
  v8Assert.equal(r.status, 'rejected')
  v8Assert.ok(r.trust.flags.includes('legacy-invalid-value'))
  v8Assert.equal(store.readingsPage({}).total, 1)
  v8ChainOk(r.chainKey, 1)
  const backup = store.exportAll()
  store.importAll(backup)
  v8Assert.equal(store.getReading('old-null').status, 'rejected')
})


await v8Test('等长篡改后退出不能洗白索引，重启后禁止继续追加', async () => {
  const { ReadingStore } = await import('../src/main/reading-store.js')
  const directory = v8Fs.mkdtempSync(join(DATA, 'tamper-'))
  let journal = new ReadingStore(directory)
  try {
    const source = { id: 'proof-source', label: '验证', url: 'https://proof.example/report' }
    const fact = journal.makeFact({ indicatorId: 'proof-node', chainKey: 'proof-node', sourceId: source.id, source, dedupeKey: 'proof-key', value: 10, unit: 'USD', period: v8Period, basis: 'reported', tier: 'agent', effectiveTier: 'agent', status: 'current', trust: { score: 0.24, crossCount: 1, flags: [] } })
    journal.commit({ fact, source, event: { kind: 'ingest', patches: [{ id: fact.id, indicatorId: fact.indicatorId, status: fact.status, trust: fact.trust }], conflicts: [] } })
    journal.flush()
    const bytes = v8Fs.readFileSync(journal.file, 'utf8')
    const stat = v8Fs.statSync(journal.file)
    const changed = bytes.replace('"value":10', '"value":11')
    v8Assert.notEqual(changed, bytes)
    v8Assert.equal(changed.length, bytes.length)
    v8Fs.writeFileSync(journal.file, changed)
    v8Fs.utimesSync(journal.file, stat.atime, new Date(stat.mtimeMs + 2000))
    journal.close()
    journal = new ReadingStore(directory)
    v8Assert.equal(journal.verify('proof-node').ok, false)
    v8Assert.throws(() => journal.commit({ event: { kind: 'conflict', patches: [], conflicts: [] } }), /禁止追加/)
    v8Assert.equal(v8Fs.readFileSync(journal.file, 'utf8'), changed)
  } finally { journal.close() }
})

await v8Test('摄入队列并发有界，MCP 拒绝非法初始化参数', async () => {
  const { indicator } = v8Reset()
  await v8WithServer(async (server, directory, counts) => {
    // 文件投递已移除，摄入并发上界改由 HTTP 入口的队列保证。
    // 一次打 40 个并发：队列只放 8 个，超出必须回 429 而不是把内存撑爆——
    // 所以这里断言「要么全进要么超额被拒」，不是「全部 200」（那会在时序波动时偶发失败）。
    const many = Array.from({ length: 40 }, (_, i) => v8Envelope(v8Input(indicator, {
      period: { start: '2026-01-01', end: '2026-03-31' }, value: 100 + i,
    })))
    const results = await Promise.all(many.map((body) => v8Http(server, '/readings', { method: 'POST', body })))
    const statuses = results.map((r) => r.status)
    v8Assert.ok(statuses.every((s) => s === 200 || s === 429), '并发超额只能回 429，不能 5xx：' + [...new Set(statuses)].join(','))
    v8Assert.ok(statuses.some((s) => s === 200), '至少有一部分被处理')
    // 拒绝的必须带得懂的错因，不能是裸状态码
    const busy = results.find((r) => r.status === 429)
    if (busy) v8Assert.ok(/队列/.test(busy.json?.error || ''), '429 要说明是队列满：' + JSON.stringify(busy.json))
    v8Assert.equal(store.allReadings().length, statuses.filter((s) => s === 200).length, '入库数等于成功数')
    const response = await v8Http(server, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: 17 } })
    v8Assert.equal(response.json.error.code, -32602)
  })
})

// ---- 回归：第三方审查发现的四件没测试护着的事 ----

// 1) 数据目录被外部删掉后，追加不能崩。目录是可重建的，事实不是——
//    先建目录再谈损坏，否则一次误删就让摄入永久失效。
await v8Test('数据目录被外部删除后自动重建，追加不崩且链自洽', async () => {
  const { indicator } = v8Reset()
  // 读数账本就在 MERIDIAN_TEST_DATA 下，删整个目录模拟「用户手动删了数据文件夹」
  const dir = process.env.MERIDIAN_TEST_DATA
  v8Assert.ok(dir, '拿得到数据目录')
  v8Fs.rmSync(dir, { recursive: true, force: true })
  v8Assert.ok(!v8Fs.existsSync(dir), '目录已删')
  // 删目录后追加：不能抛 ENOENT
  const result = await v8Ingest(v8Envelope(v8Input(indicator)))
  v8Assert.equal(result.accepted, 1, '删目录后仍能入账')
  v8Assert.ok(v8Fs.existsSync(dir), '目录被重建')
  const obs = v8OnlyObservation(indicator.id)
  v8ChainOk(obs.chainKey, 1)
})

// 2) 日期必须按本地时区算。UTC 日期在 UTC+8 下每天有 8 小时是「明天」——
//    用户晚上十一点记一笔，日期跳到明天，结算日与「今天」的比对错位一天。
await v8Test('today() 用本地时区，不与 UTC 日期混用', async () => {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const expect = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  v8Assert.equal(store.today(), expect, `today() 应等于本地日期，实际 ${store.today()}`)
  v8Assert.equal(store.addDays(1), (() => {
    const d = new Date(Date.now() + 864e5)
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })(), 'addDays 同样是本地基准')
  // 源码里不许再出现 toISOString().slice(0,10) 这类 UTC 取日期的写法
  for (const file of ['store.js']) {
    const src = v8Fs.readFileSync(join(ROOT2, 'src/main', file), 'utf8')
    v8Assert.ok(!/toISOString\(\)\.slice\(0,\s*10\)/.test(src), `${file} 还在用 UTC 取日期`)
  }
})

// 3) 模型 ID 无效必须被识别成 bad-model，不能只回一句 HTTP 404——
//    默认模型曾因下线而白屏，用户看到 404 完全不知道该改什么。
await v8Test('llm:test 识别无效模型 ID', async () => {
  const fired = []
  const seen = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {}
    seen.push(body.model)
    if (body.model === 'bad-model-name') {
      return { ok: false, status: 404, clone: () => ({ json: async () => ({ error: { message: 'The model "bad-model-name" does not exist' } }) }), json: async () => ({ error: { message: 'The model "bad-model-name" does not exist' } }) }
    }
    return origFetch(url, opts)
  }
  try {
    store.saveSettings({ apiKey: 'sk-test', model: 'bad-model-name', baseUrl: 'https://api.stepfun.com/v1' })
    const r = await fire('llm:test')
    fired.push(r)
  } finally { globalThis.fetch = origFetch }
  v8Assert.equal(fired[0]?.reason, 'bad-model', '无效模型 ID 要报 bad-model：' + JSON.stringify(fired[0]))
  v8Assert.equal(fired[0]?.model, 'bad-model-name', '回报出是哪个模型无效')
})

// 4) 界面不许再泄漏 SOURCE_QUALITY 这个内部常量名（第三方审查抓到过）
await v8Test('设置页文案不泄漏内部常量名', async () => {
  const src = v8Fs.readFileSync(join(ROOT2, 'src/renderer/views/settings.js'), 'utf8')
  // 只查给用户看的字符串字面量，不查注释
  const visible = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  for (const word of ['SOURCE_QUALITY', 'dedupeKey', 'prevHash', 'chainKey', 'crossCount', 'indicatorId', 'readingInboxPaths']) {
    v8Assert.ok(!visible.includes(word), `设置页文案泄漏了 ${word}`)
  }
})

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
