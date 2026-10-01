/**
 * 认知链 · 追加式事件账本测试（P1）。
 *
 * 运行：node test/chain-events.test.mjs
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/chain-events-data')
process.env.MERIDIAN_USER_DATA_DIR = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const store = await import('../src/main/store.js')
const chain = await import('../src/main/chain-store.js')
const ev = await import('../src/main/chain-events.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

store.load()
const theme = store.addTheme('事件账本测试主题')

// — 用真实 mountToChain 造出带 hash 链的 changeLog —
chain.mountToChain(theme.id, {
  mountId: 'm1', segmentNames: ['段A'], coreInfo: '核心信息A',
  oldValue: '55%', newValue: '68%', reason: 'Q3 电话会',
  evidenceRefs: [{ type: 'lemma', id: 'L-ev1', title: '证据一' }],
})
chain.mountToChain(theme.id, {
  mountId: 'm2', segmentNames: ['段A'],
  oldValue: '68%', newValue: '72%', reason: 'Q4 电话会',
})
chain.mountToChain(theme.id, {
  mountId: 'm3', segmentNames: ['段B'], coreInfo: '核心信息B', reason: '首次记录',
})
// 手工补 affects 与第二条证据引用
{
  const t = store.load().themes.find((x) => x.id === theme.id)
  const segA = t.chain.segments.find((s) => s.name === '段A')
  segA.affects = ['段B']
  segA.evidenceRefs.push({ type: 'inbox', id: 'inbox-9', title: '补充证据' })
  store.persistLedger()
}

// — 造 branch / lemma 节点 —
store.addNode({ themeId: theme.id, kind: 'branch', title: '认知段一', type: 'hypothesis', confidence: 60 })
const deadLemma = store.addNode({
  themeId: theme.id, kind: 'lemma', title: '命题甲', type: 'observation', confidence: 70,
  status: 'dead',
  settlement: { date: '2026-09-01', resolved: true, correct: false },
})
deadLemma.deletedAt = '2026-09-01'
store.persistLedger()
store.addNode({ themeId: theme.id, kind: 'lemma', title: '命题乙', type: 'observation', confidence: 80 })

console.log('\n— 迁移映射 —')
const r1 = ev.migrateThemeToEvents(theme.id)
ok('段映射 2', r1.report.segments === 2, JSON.stringify(r1.report))
ok('changeLog 映射 3', r1.report.changeLogs === 3)
ok('affects 映射 1', r1.report.affects === 1)
ok('evidenceRefs 映射 2', r1.report.evidenceRefs === 2)
ok('branch 映射 1', r1.report.branches === 1)
ok('lemma 映射 2', r1.report.lemmas === 2)
ok('归档 1', r1.report.archived === 1)
ok('结算 1', r1.report.settlements === 1)

console.log('\n— 事件链完整性 —')
const events = ev.getEvents(theme.id)
ok('事件总数 13', events.length === 13, `实际 ${events.length}`)
ok('seq 连续 1..13', events.every((e, i) => e.seq === i + 1))
ok('首事件 prevHash 为 GENESIS', events[0].prevHash === 'GENESIS')
ok('prevHash 衔接', events.every((e, i) => i === 0 || e.prevHash === events[i - 1].hash))
const v1 = ev.verifyChain(theme.id)
ok('verifyChain 通过', v1.ok && v1.count === 13)

console.log('\n— 语义正确性 —')
const corrections = events.filter((e) => e.type === 'correction.appended')
ok('更正事件 2 条', corrections.length === 2)
ok('更正带 supersedes', corrections.every((e) => typeof e.supersedes === 'string'))
ok('原 changeLog hash 存证', corrections.every((e) => e.payload.provenance && e.payload.provenance.hash))
const affRel = events.find((e) => e.type === 'relation.declared' && e.payload.mapping)
ok('affects 暂译 derives 待复核', affRel && affRel.payload.rel === 'derives' && affRel.payload.reviewStatus === 'pending-review')
const claims = events.filter((e) => e.type === 'claim.created')
const lemmaClaim = claims.find((e) => e.payload.sourceRef === 'lemma:' + store.load().nodes.find((n) => n.title === '命题甲').id)
ok('confidence 原样携带', lemmaClaim && lemmaClaim.payload.confidence === 70)
ok('证伪结算保留', events.some((e) => e.type === 'settlement.recorded' && e.payload.correct === false))
ok('墓碑事件存在', events.some((e) => e.type === 'node.archived'))
ok('迁移 actor 标记', events.every((e) => e.actor === 'migration'))

console.log('\n— 幂等 —')
const r2 = ev.migrateThemeToEvents(theme.id)
ok('重跑零新建', r2.created === 0, `新建 ${r2.created}`)
ok('重跑全部跳过', r2.skipped === 13, `跳过 ${r2.skipped}`)
ok('重跑后链仍有效', ev.verifyChain(theme.id).ok)

console.log('\n— 篡改检测 —')
{
  const t = store.load().themes.find((x) => x.id === theme.id)
  t.eventChain.events[5].payload.reason = '被篡改'
  store.persistLedger()
  const v = ev.verifyChain(theme.id)
  ok('篡改被检出', !v.ok && v.index === 5, v.reason || '')
}

console.log('\n— 追加校验 —')
const theme2 = store.addTheme('追加校验主题')
let threw = false
try { ev.appendEvent(theme2.id, { type: 'nope.unknown', payload: {} }) } catch { threw = true }
ok('未知类型拒绝', threw)
threw = false
try { ev.appendEvent(theme2.id, { type: 'correction.appended', supersedes: 'evt:missing', payload: {} }) } catch { threw = true }
ok('supersedes 悬空拒绝', threw)
const e1 = ev.appendEvent(theme2.id, { id: 'evt:fixed', type: 'evidence.appended', payload: { text: 't' } })
const e2 = ev.appendEvent(theme2.id, { id: 'evt:fixed', type: 'evidence.appended', payload: { text: 't' } })
ok('显式 id 幂等', e2.replayed === true && ev.getEvents(theme2.id).length === 1 && e1.hash === e2.hash)

console.log('\n— dry-run 不写账本 —')
const theme3 = store.addTheme('dry-run 主题')
chain.mountToChain(theme3.id, { mountId: 'd1', segmentNames: ['段D'], reason: 'r' })
const dr = ev.migrateThemeToEvents(theme3.id, { persist: false })
ok('dry-run 构造出事件', dr.created > 0, `构造 ${dr.created}`)
ok('dry-run 未写账本', ev.getEvents(theme3.id).length === 0)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
