/**
 * IPC 层测试：收件箱链路 + 原文层 + 其他 handler。
 *
 * 运行：node test/ipc.test.mjs
 */
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/ipc-data')
process.env.MERIDIAN_TEST_DATA = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const stub = await import('./electron-stub.mjs')
globalThis.__electron = stub

const store = await import('../src/main/store.js')
const { register: registerIpc } = await import('../src/main/ipc.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const fire = (ch, ...args) => stub.__handlers.get(ch)({}, ...args)
const fireAsync = async (ch, ...args) => stub.__handlers.get(ch)({}, ...args)

store.load()
registerIpc({ getMainWindow: () => undefined })

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

console.log('\n— 原文层的 IPC —')
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

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
