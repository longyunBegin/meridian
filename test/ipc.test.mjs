/**
 * IPC 层测试：capture:save 这条链路曾经整个是断的。
 *
 * ipc.js 里用了 today() 却没有从 store.js import——抛 ReferenceError，
 * 而且是在求值 sources 对象字面量时抛的，addNode 根本没被调用，
 * 于是「按了回车、什么都没发生」。store.js 的引擎测试覆盖不到这条路径。
 *
 * 运行：node test/ipc.test.mjs
 */
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
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

store.load()
registerIpc({
  resizeCapture: () => {},
  showCapture: () => { throw new Error('showCapture 不该在这里被调用') },
  hideCapture: () => {},
  getMainWindow: () => undefined,
})

const theme = store.addTheme('IPC 测试主题')

const TEXT = '我们跟踪的 1.6T 光模块供应链显示，北美某云厂商 Q4 订单能见度已排到明年 Q2，产能被头部客户锁定。'
const payload = (extra = {}) => ({
  themeId: theme.id,
  labelKind: '一手数据',
  text: TEXT,
  lemmas: [{
    title: '1.6T 光模块订单能见度排到明年 Q2',
    type: 'observation',
    confidence: 82,
    action: 'new',
    parentId: null,
    ...extra,
  }],
})

console.log('\n— capture:save 主链路 —')
let threw = null
try { fire('capture:save', payload()) } catch (e) { threw = e }
ok('入库不抛异常', threw === null, threw ? `${threw.constructor.name}: ${threw.message}` : '')
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
fire('capture:save', payload({ title: '同一段原文的第二条命题' }))
ok('两条命题都在', store.allNodes().length === 2, `实际 ${store.allNodes().length}`)
ok('原文只存一份', store.rawStats().count === 1, `实际 ${store.rawStats().count}`)
ok('两条命题共用同一 rawId',
  store.allNodes()[0].sources[0].rawId === store.allNodes()[1].sources[0].rawId)

console.log('\n— 合并路径（action: merge）—')
const target = store.addNode({
  themeId: theme.id, parentId: null, kind: 'lemma', title: '既有命题', confidence: 60,
})
fire('capture:save', {
  themeId: theme.id, labelKind: '券商研报', text: TEXT,
  lemmas: [{ title: '重复 claim', type: 'observation', confidence: 70, action: 'merge', mergeInto: target.id }],
})
ok('合并只加来源不新建', store.allNodes().length === 3, `实际 ${store.allNodes().length}`)
ok('被合并的命题多了一个源', target.sources.length === 1, `实际 ${target.sources.length}`)
ok('新来源取了 payload 的类型', target.sources[0]?.kind === '券商研报')
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

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
