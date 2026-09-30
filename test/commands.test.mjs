/**
 * 领域命令测试：收件箱链路 + 原文层 + 其他服务。
 *
 * 运行：node test/commands.test.mjs
 */
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/ipc-data')
process.env.MERIDIAN_USER_DATA_DIR = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const { registry, invoke } = await import('./runtime-harness.mjs').then(({ createCommandTestHarness }) => createCommandTestHarness(DATA))

const store = await import('../src/main/store.js')
const { registerDomainCommands } = await import('../src/main/domain-commands.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const fire = invoke
const fireAsync = invoke

store.load()
registerDomainCommands({ registry })

const theme = store.addTheme('IPC 测试主题')

const TEXT = '我们跟踪的 1.6T 光模块供应链显示，北美某云厂商 Q4 订单能见度已排到明年 Q2，产能被头部客户锁定。'

console.log('\n— inbox:capture 主链路 —')
const cap = await fireAsync('inbox:capture', TEXT)
ok('inbox:capture 返回 ok', cap?.ok === true)
ok('创建了收件箱条目', store.allInbox().length === 1, `实际 ${store.allInbox().length}`)
const item = store.allInbox()[0]
ok('条目有标题', typeof item?.title === 'string' && item.title.length > 0)
ok('条目状态 pending', item?.status === 'pending')

console.log('\n— inbox:import 入库 —')
const importResult = await fireAsync('inbox:import', theme.id, [{
  label: { kind: '一手数据' },
  text: TEXT,
  lemmas: [{
    title: '1.6T 光模块订单能见度排到明年 Q2',
    type: 'observation',
    confidence: 82,
    parentId: null,
  }],
}])
ok('inbox:import 返回 ok', importResult?.ok === true)
ok('命题真的入库了', store.allNodes().length === 1, `实际 ${store.allNodes().length}`)

const node = store.allNodes()[0]
ok('标题正确', node?.title === '1.6T 光模块订单能见度排到明年 Q2')
ok('类型正确', node?.type === 'observation')
ok('置信度正确', node?.confidence === 82)
ok('来源打上了', node?.sources?.[0]?.kind === '一手数据')
ok('来源质量由表裁决', node?.sources?.[0]?.quality === 0.9, `实际 ${node?.sources?.[0]?.quality}`)
ok('来源带了日期', typeof node?.sources?.[0]?.at === 'string' && node.sources[0].at.length === 10)

console.log('\n— 原文层 —')
ok('来源挂了 rawId', typeof node?.sources?.[0]?.rawId === 'string')
const raw = store.getRaw(node.sources[0].rawId)
ok('原文落库了', raw?.text === TEXT)
ok('原文记了来源类型', raw?.kind === '一手数据')
ok('原文记了字数', raw?.chars === TEXT.length)
ok('raw.jsonl 文件存在', existsSync(join(DATA, 'raw.jsonl')))

console.log('\n— 同一段原文抓两次 —')
await fireAsync('inbox:import', theme.id, [{
  label: { kind: '一手数据' },
  text: TEXT,
  lemmas: [{
    title: '同一段原文的第二条命题',
    type: 'observation',
    confidence: 75,
    parentId: null,
  }],
}])
ok('两条命题都在', store.allNodes().length === 2, `实际 ${store.allNodes().length}`)
ok('原文只存一份', store.rawStats().count === 1, `实际 ${store.rawStats().count}`)
ok('两条命题共用同一 rawId',
  store.allNodes()[0].sources[0].rawId === store.allNodes()[1].sources[0].rawId)

console.log('\n— 合并路径（addSource）—')
const target = store.addNode({
  themeId: theme.id, parentId: null, kind: 'lemma', title: '既有命题', confidence: 60,
})
store.addSource(target.id, {
  kind: '券商研报', label: '中信', at: store.today(), quality: 0.8,
  rawId: store.appendRaw({ kind: '券商研报', label: '中信', text: TEXT }).id,
})
ok('合并只加来源不新建', store.allNodes().length === 3, `实际 ${store.allNodes().length}`)
ok('被合并的命题多了一个源', target.sources.length === 1, `实际 ${target.sources.length}`)
ok('新来源取了类型', target.sources[0]?.kind === '券商研报')
ok('新来源也挂了 rawId', typeof target.sources[0]?.rawId === 'string')

console.log('\n— 原文相关命令 —')
ok('raw:stats 报得出条数', fire('raw:stats').count === 1)
ok('raw:get 读得到', fire('raw:get', node.sources[0].rawId)?.text === TEXT)
ok('raw:get 不存在的 id 返回 null', fire('raw:get', 'nope') === null)
ok('raw:prune 不动被引用的', fire('raw:prune').kept === 1)
ok('raw:prune 后原文还在', store.getRaw(node.sources[0].rawId) !== null)
const cleared = fire('raw:clear')
ok('raw:clear 报得出清了几条', cleared.removed === 1)
ok('clear 后原文没了', store.rawStats().count === 0)
ok('clear 摘掉了引用', store.allNodes().every((n) => n.sources.every((s) => !s.rawId)))
ok('clear 不动命题', store.allNodes().length === 3)

console.log('\n— 其他 handler 仍可调 —')
ok('settings:get 带来源质量表', Array.isArray(fire('settings:get').sourceQuality))
ok('settings:set 写得进', fire('settings:set', { model: 'test-model' }).model === 'test-model')
ok('db:stats 算得动', fire('db:stats').themes === 1)
ok('theme:all 列得出', fire('theme:all').length === 1)

console.log('\n— 回归：被免费层拦下的原文再抓一次不崩 —')
// 带标签库的主题：文本命中 B4 no-tags 拦截，留下 kind 'skipped' 的 gate 留痕。
// 曾经 captureGate 把 'skipped' 也当复用返回，processCapture 读到
// gate.seen.lemmas === undefined，在 ex.lemmas.length 抛 TypeError。
const skipTheme = store.addTheme('拦截回归主题')
store.updateTheme(skipTheme.id, { tagLibrary: [{ id: 't1', name: '量子计算', threshold: 0.6 }] })
await fireAsync('inbox:import', skipTheme.id, [1, 2, 3, 4].map((i) => ({
  label: { kind: '一手数据' },
  text: `回归主题第 ${i} 条原文`,
  lemmas: [{ title: `回归主题第 ${i} 条命题`, type: 'observation', confidence: 70, parentId: null }],
})))
const SKIP_TEXT = '回归拦截文本：某厂 Q3 光模块出货环比增长 20%。'
const rs1 = await fireAsync('inbox:capture', SKIP_TEXT)
ok('第一次被 no-tags 拦下', rs1?.ok === true && rs1?.skipped === 'no-tags', `实际 ${rs1?.skipped}`)
let reThrew = null
let rs2 = null
try { rs2 = await fireAsync('inbox:capture', SKIP_TEXT) } catch (e) { reThrew = e }
ok('第二次同文本捕获不抛异常', reThrew === null, reThrew ? reThrew.message : '')
ok('第二次同样被拦下', rs2?.ok === true && rs2?.skipped === 'no-tags', `实际 ${rs2?.skipped}`)
const dirtyReuse = store.load().traces.filter((t) => t.stage === 'extract'
  && t.actor?.by === 'reuse' && !(t.decision && t.decision.lemmas))
ok('没有写下空 decision 的假复用留痕', dirtyReuse.length === 0, `实际 ${dirtyReuse.length}`)

console.log('\n— 回归：抽取分流合并阈值 0.6 —')
// 既有命题「北美云厂商Q4光模块订单大增」vs 新文本首句
// 「北美云厂商Q4光模块订单小幅上扬」相似度恰为 0.5，落在旧阈值 0.45
// 与设计值 0.6 之间。曾经 routeLemmas 用 findSimilar 默认阈值 0.45
// 把它判成 merge——新命题就丢了，只变成已有节点的一个来源，
// 而注释里写的一直是"抽完再合并的 0.6"。
const mergeTheme = store.addTheme('合并阈值回归主题')
store.addNode({ themeId: mergeTheme.id, kind: 'lemma', title: '北美云厂商Q4光模块订单大增', type: 'observation', confidence: 70 })
const weakCap = await fireAsync('agent:process', '北美云厂商Q4光模块订单小幅上扬。', mergeTheme.id)
const weakAction = weakCap?.lemmas?.[0]?.action
ok('弱相似(0.5)命题不判合并', weakAction === 'new', `实际 ${weakAction}`)
const strongCap = await fireAsync('agent:process', '北美云厂商Q4光模块订单大增。', mergeTheme.id)
const strongAction = strongCap?.lemmas?.[0]?.action
ok('强相似(1.0)命题仍判合并', strongAction === 'merge', `实际 ${strongAction}`)

console.log('\n— 收件箱条目级主题（跨主题勾选/入库） —')
const themeA = store.addTheme('收件箱主题A')
const themeB = store.addTheme('收件箱主题B')
const nA = store.addNode({ themeId: themeA.id, kind: 'lemma', title: 'A 主题既有命题', type: 'observation', confidence: 60 })
const nB = store.addNode({ themeId: themeB.id, kind: 'lemma', title: 'B 主题既有命题', type: 'observation', confidence: 60 })
const itA = store.addInboxItem({
  text: 'A 主题文本', title: 'A 条目', extracted: true, extractedThemeId: themeA.id,
  lemmas: [{ title: 'A 新命题', type: 'observation', confidence: 70, parentId: nA.id }],
})
ok('addInboxItem 透传 extractedThemeId', itA.extractedThemeId === themeA.id, `实际 ${itA.extractedThemeId}`)
store.setInboxExtraction(itA.id, { extracted: true, matchScore: 0.9, lemmas: itA.lemmas, themeId: themeA.id })
ok('setInboxExtraction 记录抽取所用主题',
  store.allInbox().find((i) => i.id === itA.id)?.extractedThemeId === themeA.id)
// 跨主题分组入库：各进各的主题，不串
const itB = store.addInboxItem({
  text: 'B 主题文本', title: 'B 条目', extracted: true, extractedThemeId: themeB.id,
  lemmas: [{ title: 'B 新命题', type: 'observation', confidence: 70, parentId: nB.id }],
})
const rA = await fireAsync('inbox:import', themeA.id, [itA])
const rB = await fireAsync('inbox:import', themeB.id, [itB])
ok('A 条目入库 ok', rA?.ok === true)
ok('B 条目入库 ok', rB?.ok === true)
const nodeNewA = store.allNodes().find((n) => n.title === 'A 新命题')
const nodeNewB = store.allNodes().find((n) => n.title === 'B 新命题')
ok('A 命题落在 A 主题', nodeNewA?.themeId === themeA.id, `实际 ${nodeNewB?.themeId}`)
ok('B 命题落在 B 主题', nodeNewB?.themeId === themeB.id, `实际 ${nodeNewB?.themeId}`)
ok('A 命题挂点仍是 A 的节点', nodeNewA?.parentId === nA.id)
ok('B 命题挂点仍是 B 的节点', nodeNewB?.parentId === nB.id)

console.log('\n— inbox:setTheme 换主题 —')
const itC = store.addInboxItem({
  text: 'C 主题文本', title: 'C 条目', extracted: true, extractedThemeId: themeA.id,
  lemmas: [{ title: 'C 新命题', type: 'observation', confidence: 70, parentId: nA.id }],
})
const st1 = await fireAsync('inbox:setTheme', itC.id, themeB.id)
ok('换主题返回 ok', st1?.ok === true, `实际 ${JSON.stringify(st1)}`)
ok('条目 extractedThemeId 已更新',
  store.load().inbox.find((i) => i.id === itC.id)?.extractedThemeId === themeB.id)
const stBad = await fireAsync('inbox:setTheme', itC.id, '不存在的主题')
ok('换到不存在的主题返回 ok:false', stBad?.ok === false)
ok('换到不存在的主题不改条目',
  store.load().inbox.find((i) => i.id === itC.id)?.extractedThemeId === themeB.id)
const stNoItem = await fireAsync('inbox:setTheme', '不存在的条目', themeA.id)
ok('条目不存在返回 ok:false', stNoItem?.ok === false)

console.log('\n— inbox:statuses 只读状态 —')
const sts = await fireAsync('inbox:statuses', [itA.id, itC.id, '不存在的条目'])
ok('返回 ok', sts?.ok === true)
ok('已入库条目状态 accepted', sts?.statuses?.[itA.id] === 'accepted', `实际 ${sts?.statuses?.[itA.id]}`)
ok('待处理条目状态 pending', sts?.statuses?.[itC.id] === 'pending', `实际 ${sts?.statuses?.[itC.id]}`)
ok('不存在的条目状态 null', sts?.statuses?.['不存在的条目'] === null)

console.log('\n— inbox:resolveMany 批量忽略 —')
const rj1 = store.addInboxItem({ text: '忽略条目1', title: '忽略1', extracted: false })
const rj2 = store.addInboxItem({ text: '忽略条目2', title: '忽略2', extracted: false })
const rm = await fireAsync('inbox:resolveMany', [rj1.id, rj2.id], 'reject')
ok('批量忽略返回 ok', rm?.ok === true)
ok('两条都 resolved', rm?.resolved?.length === 2, `实际 ${rm?.resolved?.length}`)
const rj1After = store.load().inbox.find((i) => i.id === rj1.id)
const rj2After = store.load().inbox.find((i) => i.id === rj2.id)
ok('忽略后状态 rejected', rj1After?.status === 'rejected' && rj2After?.status === 'rejected')
ok('忽略后不在 pending 里',
  !store.allInbox().filter((i) => i.status === 'pending').some((i) => i.id === rj1.id || i.id === rj2.id))
const rmEmpty = await fireAsync('inbox:resolveMany', [], 'reject')
ok('空数组不崩', rmEmpty?.ok === true && rmEmpty?.resolved?.length === 0)

console.log('\n— inbox:extract 进度事件 + 有限并发 + 取消 —')
// harness 默认吞掉 emit，这里换一个只收抽取进度事件的收集器
const { configurePlatformServices } = await import('../src/main/runtime-services.js')
const { __testHooks: extractHooks } = await import('../src/main/llmlog.js')
const extractEvents = []
configurePlatformServices({ emitEvent: (name, payload) => { if (name === 'inbox:extract:progress') extractEvents.push(payload) } })
const prevApiKey = store.settings().apiKey
store.saveSettings({ apiKey: '<redacted>' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realExtractHook = extractHooks.run
extractHooks.run = async (scenario) => {
  await sleep(30)
  if (scenario === 'extract') return { ok: true, lemmas: [{ title: '抽取出的命题', type: 'observation', confidence: 70 }] }
  return { ok: false, reason: 'timeout' }
}
const ex1 = store.addInboxItem({ text: '抽取条目一，讲某供应链的订单情况。', title: '抽取1', extracted: false })
const ex2 = store.addInboxItem({ text: '抽取条目二，讲某公司的产能扩张。', title: '抽取2', extracted: false })
const ex3 = store.addInboxItem({ text: '抽取条目三，讲某产品的价格走势。', title: '抽取3', extracted: false })
extractEvents.length = 0
const exRes = await fireAsync('inbox:extract', [ex1.id, ex2.id, ex3.id])
ok('抽取返回 ok', exRes?.ok === true)
ok('三条都抽取成功', exRes?.extracted === 3 && exRes?.total === 3, `实际 extracted=${exRes?.extracted} total=${exRes?.total}`)
const phases = extractEvents.map((e) => e.phase)
ok('进度事件有 start/item/done', phases[0] === 'start' && phases.at(-1) === 'done' && phases.filter((p) => p === 'item').length === 3,
  `实际 ${JSON.stringify(phases)}`)
const dones = extractEvents.filter((e) => e.phase === 'item').map((e) => e.done).sort((a, b) => a - b)
ok('逐条进度 done 递增 1..3', JSON.stringify(dones) === '[1,2,3]', `实际 ${JSON.stringify(dones)}`)
ok('三条都标为已抽取', [ex1.id, ex2.id, ex3.id].every((id) => store.load().inbox.find((i) => i.id === id)?.extracted === true))
// 已抽取过的不再重复抽取
const noOpRes = await fireAsync('inbox:extract', [ex1.id])
ok('已抽取过的不再重复抽取', noOpRes?.ok === true && noOpRes?.extracted === 0 && noOpRes?.total === 0,
  `实际 ${JSON.stringify({ extracted: noOpRes?.extracted, total: noOpRes?.total })}`)

// 并发重入：第一批还没跑完时再调，直接拒绝；取消后在飞的跑完、没起跑的不再起
extractHooks.run = async (scenario) => {
  await sleep(300)
  if (scenario === 'extract') return { ok: true, lemmas: [{ title: '慢抽取命题', type: 'observation', confidence: 70 }] }
  return { ok: false, reason: 'timeout' }
}
const slowIds = []
for (let i = 4; i <= 8; i++) slowIds.push(store.addInboxItem({ text: `慢速抽取条目${i}`, title: `抽取${i}`, extracted: false }).id)
const slowPromise = fireAsync('inbox:extract', slowIds)
await sleep(50) // 让第一批先占住 extractRun
const reenter = await fireAsync('inbox:extract', [slowIds[0]])
ok('并发重入被拒绝', reenter?.ok === false && reenter?.error === 'extract-in-progress', `实际 ${JSON.stringify(reenter)}`)
const cancelRes = await fireAsync('inbox:extract:cancel')
ok('取消命令返回 ok', cancelRes?.ok === true && cancelRes?.cancelled === true)
const slowRes = await slowPromise
ok('取消后整批标记 cancelled', slowRes?.cancelled === true, `实际 cancelled=${slowRes?.cancelled}`)
ok('取消后在飞的 3 条落盘、没起跑的不再抽取', slowRes?.extracted === 3 && slowRes?.total === 5,
  `实际 extracted=${slowRes?.extracted} total=${slowRes?.total}`)

// 单条失败不掀翻整批
extractHooks.run = async (scenario, args) => {
  await sleep(10)
  if (scenario !== 'extract') return { ok: false, reason: 'timeout' }
  if (args?.text?.includes('坏条目')) throw new Error('LLM 炸了')
  return { ok: true, lemmas: [{ title: '好条目命题', type: 'observation', confidence: 70 }] }
}
const exGood = store.addInboxItem({ text: '好条目内容', title: '抽取好', extracted: false })
const exBad = store.addInboxItem({ text: '坏条目内容', title: '抽取坏', extracted: false })
extractEvents.length = 0
const partRes = await fireAsync('inbox:extract', [exGood.id, exBad.id])
ok('部分失败整批仍 ok', partRes?.ok === true && partRes?.extracted === 1, `实际 extracted=${partRes?.extracted}`)
const failEvt = extractEvents.find((e) => e.phase === 'item' && e.itemId === exBad.id)
ok('失败条目进度事件 ok=false', failEvt?.ok === false)
ok('好条目已抽取', store.load().inbox.find((i) => i.id === exGood.id)?.extracted === true)
ok('坏条目未抽取', store.load().inbox.find((i) => i.id === exBad.id)?.extracted !== true)

console.log('\n— inbox:clearUnextracted 排除抽取中条目 —')
const cu1 = store.addInboxItem({ text: '清空测试条目一', title: '清空1', extracted: false })
const cu2 = store.addInboxItem({ text: '清空测试条目二', title: '清空2', extracted: false })
const cu3 = store.addInboxItem({ text: '清空测试条目三', title: '清空3', extracted: false })
const clearRes = await fireAsync('inbox:clearUnextracted', [cu1.id])
const inboxIds = new Set(store.load().inbox.map((i) => i.id))
ok('exceptIds 中的条目被保留', inboxIds.has(cu1.id))
ok('其余未抽取被清空', !inboxIds.has(cu2.id) && !inboxIds.has(cu3.id))
ok('返回清空数量', clearRes.removed >= 2, `实际 ${clearRes.removed}`)
ok('返回的 deletedIds 精确对应被删条目',
  clearRes.deletedIds.includes(cu2.id) && clearRes.deletedIds.includes(cu3.id) && !clearRes.deletedIds.includes(cu1.id))

console.log('\n— inbox:extract 跳过中途被忽略的条目 —')
let gateOpen = false
const extractTexts = []
extractHooks.run = async (scenario, args) => {
  if (scenario !== 'extract') return { ok: false, reason: 'timeout' }
  extractTexts.push(args?.text)
  while (!gateOpen) await sleep(10)
  return { ok: true, lemmas: [{ title: '门控命题', type: 'observation', confidence: 70 }] }
}
const gIds = []
for (let i = 1; i <= 4; i++) gIds.push(store.addInboxItem({ text: `门控抽取条目${i}内容`, title: `门控${i}`, extracted: false }).id)
extractEvents.length = 0
extractTexts.length = 0
const gatePromise = fireAsync('inbox:extract', gIds)
await sleep(150) // 3 个 worker 各取走一条并卡在 hook 里，第四条还在队列里
store.resolveInboxItem(gIds[3], 'reject') // 抽取中忽略第四条
gateOpen = true
const gateRes = await gatePromise
ok('被忽略的条目不计入抽取', gateRes?.extracted === 3 && gateRes?.total === 4,
  `实际 extracted=${gateRes?.extracted} total=${gateRes?.total}`)
ok('被忽略的条目没跑 LLM', !extractTexts.some((t) => t && t.includes('门控抽取条目4')), `实际跑了 ${extractTexts.length} 次`)
const skipEvt = extractEvents.find((e) => e.phase === 'item' && e.itemId === gIds[3])
ok('跳过事件带 skipped 标记', skipEvt?.skipped === true)
ok('被忽略条目保持未抽取', store.load().inbox.find((i) => i.id === gIds[3])?.extracted !== true)
gateOpen = false

extractHooks.run = realExtractHook
store.saveSettings({ apiKey: prevApiKey })

console.log('\n— db:updateNode 发出 db:changed —')
const dbEvents = []
configurePlatformServices({ emitEvent: (name, payload) => dbEvents.push({ name, payload }) })
const renameTarget = store.allNodes()[0]
const updRes = await fireAsync('db:updateNode', renameTarget.id, { title: 'IPC 改名测试' })
ok('db:updateNode 成功返回节点', !!updRes && updRes.id === renameTarget.id)
ok('成功更新后发出 db:changed', dbEvents.some((e) => e.name === 'db:changed'))
dbEvents.length = 0
const updMissing = await fireAsync('db:updateNode', 'no-such-node', { title: 'x' })
ok('不存在的节点返回 null', updMissing === null)
ok('空更新不发 db:changed', !dbEvents.some((e) => e.name === 'db:changed'))

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
