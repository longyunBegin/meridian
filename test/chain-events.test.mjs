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
  segA.evidenceRefs.push({ type: 'lemma', id: 'L-ev1', title: '重复引用不得覆盖首个名称' })
  segA.evidenceRefs.push({ type: 'inbox', id: 'inbox-9', title: '补充证据' })
  store.persistLedger()
}

// — 造 branch / lemma 节点 —
store.addNode({ themeId: theme.id, kind: 'branch', title: '认知段一', type: 'hypothesis', confidence: 60 })
const deadLemma = store.addNode({
  themeId: theme.id, kind: 'lemma', title: '命题甲', type: 'observation', confidence: 70,
  status: 'dead',
  settlement: { date: '2026-09-01', resolved: true, correct: false },
  sources: [{ kind: '一手数据', label: '旧命题来源', quality: 0.9, at: '2026-08-31', url: 'https://example.com/lemma-source' }],
})
deadLemma.deletedAt = '2026-09-01'
store.persistLedger()
store.addNode({ themeId: theme.id, kind: 'lemma', title: '命题乙', type: 'observation', confidence: 80 })

console.log('\n— 迁移映射 —')
const r1 = ev.migrateThemeToEvents(theme.id)
ok('段映射 2', r1.report.segments === 2, JSON.stringify(r1.report))
const newlyCreatedSegments = chain.getChain(theme.id).segments
ok('新建旧链段以各自 UUID 作为稳定身份', newlyCreatedSegments.length === 2
  && newlyCreatedSegments[0].id !== newlyCreatedSegments[1].id
  && newlyCreatedSegments.every((segment) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment.id)))
ok('changeLog 映射 3', r1.report.changeLogs === 3)
ok('affects 映射 1', r1.report.affects === 1)
ok('evidenceRefs 映射 2', r1.report.evidenceRefs === 2)
ok('branch 映射 1', r1.report.branches === 1)
ok('lemma 映射 2', r1.report.lemmas === 2)
ok('旧节点来源映射 1', r1.report.nodeSources === 1)
ok('归档 1', r1.report.archived === 1)
ok('结算 1', r1.report.settlements === 1)

console.log('\n— 事件链完整性 —')
const events = ev.getEvents(theme.id)
ok('事件总数 15', events.length === 15, `实际 ${events.length}`)
ok('seq 连续 1..15', events.every((e, i) => e.seq === i + 1))
ok('首事件 prevHash 为 GENESIS', events[0].prevHash === 'GENESIS')
ok('prevHash 衔接', events.every((e, i) => i === 0 || e.prevHash === events[i - 1].hash))
const v1 = ev.verifyChain(theme.id)
ok('verifyChain 通过', v1.ok && v1.count === 15)

console.log('\n— 语义正确性 —')
const corrections = events.filter((e) => e.type === 'correction.appended')
ok('更正事件 2 条', corrections.length === 2)
ok('更正带 supersedes', corrections.every((e) => typeof e.supersedes === 'string'))
ok('原 changeLog hash 存证', corrections.every((e) => e.payload.provenance && e.payload.provenance.hash))
const affRel = events.find((e) => e.type === 'relation.declared' && e.payload.mapping)
ok('affects 暂译 derives 待复核', affRel && affRel.payload.rel === 'derives' && affRel.payload.reviewStatus === 'pending-review')
const migratedEvidenceEdges = events.filter((event) => event.type === 'relation.declared' && event.payload.sourceKind === 'segment-evidenceRef')
ok('旧段重复 evidence ref 按 type/id 去重且保留首次来源顺序', migratedEvidenceEdges.length === 2
  && migratedEvidenceEdges[0].payload.from.ref.id === 'L-ev1'
  && migratedEvidenceEdges[1].payload.from.ref.id === 'inbox-9'
  && migratedEvidenceEdges[0].id.endsWith(':0') && migratedEvidenceEdges[1].id.endsWith(':2'))
const claims = events.filter((e) => e.type === 'node.created' || e.type === 'claim.created')
const lemmaClaim = claims.find((e) => e.payload.sourceRef === 'lemma:' + store.load().nodes.find((n) => n.title === '命题甲').id)
ok('confidence 原样携带', lemmaClaim && lemmaClaim.payload.confidence === 70)
const migratedSource = events.find((e) => e.type === 'evidence.appended' && e.payload.sourceKind === 'legacy-node-source')
ok('旧节点来源保留完整元数据并连到原命题', migratedSource?.payload.legacySource?.url === 'https://example.com/lemma-source'
  && events.some((e) => e.type === 'relation.declared' && e.payload.rel === 'supports'
    && e.payload.from.eventId === migratedSource.id && e.payload.to.eventId === lemmaClaim.id))
const ambiguousLegacyNode = events.find((event) => event.type === 'node.created' && event.payload.legacyTypeHint === 'observation')
ok('无法一一映射的旧类型保留 hint、诚实迁入观点并标注历史边界', ambiguousLegacyNode?.payload.nodeType === 'viewpoint'
  && ambiguousLegacyNode.payload.migrationBoundary.includes('无法从迁移记录反推'))
ok('迁移不删除或改写旧主题链与原节点记录', store.load().themes.find((row) => row.id === theme.id)?.chain?.segments?.length === 2
  && store.load().nodes.some((node) => node.id === deadLemma.id && node.deletedAt === '2026-09-01'))
ok('证伪结算保留', events.some((e) => e.type === 'settlement.recorded' && e.payload.correct === false))
ok('墓碑事件存在', events.some((e) => e.type === 'node.archived'))
ok('迁移 actor 标记', events.every((e) => e.actor === 'migration'))

console.log('\n— 幂等 —')
const r2 = ev.migrateThemeToEvents(theme.id)
ok('重跑零新建', r2.created === 0, `新建 ${r2.created}`)
ok('重跑全部跳过', r2.skipped === 15, `跳过 ${r2.skipped}`)
ok('重跑后链仍有效', ev.verifyChain(theme.id).ok)

console.log('\n— 篡改检测 —')
{
  const t = store.load().themes.find((x) => x.id === theme.id)
  t.eventChain.events[5].payload.reason = '被篡改'
  store.persistLedger()
  const v = ev.verifyChain(theme.id)
  ok('篡改被检出', !v.ok && v.index === 5, v.reason || '')
  ok('损坏记录仍可读用于恢复', ev.getEvents(theme.id)[5].payload.reason === '被篡改')
  let appendBlocked = false
  try { ev.appendEvent(theme.id, { type: 'evidence.appended', payload: { text: '不得接在损坏后缀上' } }) } catch { appendBlocked = true }
  ok('损坏账本拒绝继续追加', appendBlocked)
}

console.log('\n— 非法记录恢复边界 —')
{
  const damagedTheme = store.addTheme('含非法行的账本')
  ev.appendEvent(damagedTheme.id, { id: 'valid-prefix', type: 'evidence.appended', payload: { text: '有效前缀' } })
  const row = store.load().themes.find((x) => x.id === damagedTheme.id)
  row.eventChain.events.push(null)
  store.persistLedgerNow()
  const readBack = ev.getEvents(damagedTheme.id)
  const integrity = ev.verifyChain(damagedTheme.id)
  ok('非法尾行不被静默过滤', readBack.length === 2 && readBack[1] === null)
  ok('校验报告给出最后有效前缀', !integrity.ok && integrity.index === 1 && integrity.lastValidSeq === 1)
  let blocked = false
  try { ev.appendEvent(damagedTheme.id, { type: 'evidence.appended', payload: { text: 'blocked' } }) } catch { blocked = true }
  ok('非法尾行存在时拒绝追加', blocked)
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

const schemaTheme = store.addTheme('新网络事件 schema 测试')
for (const [label, payload] of [
  ['未知节点类型', { nodeType: 'theme', title: '不得入图', sourceRef: 'schema:1' }],
  ['缺失 sourceRef', { nodeType: 'concept', title: '缺 sourceRef' }],
  ['缺失标题', { nodeType: 'concept', sourceRef: 'schema:2' }],
]) {
  let rejected = false
  try { ev.appendEvent(schemaTheme.id, { type: 'node.created', payload }) } catch { rejected = true }
  ok(`节点创建 payload 校验拒绝${label}`, rejected && ev.getEvents(schemaTheme.id).length === 0)
}
const schemaNode = ev.appendEvent(schemaTheme.id, {
  id: 'schema-node', type: 'node.created', payload: { nodeType: 'concept', title: '校验节点', sourceRef: 'schema:node' },
})
let badRenameRejected = false
try {
  ev.appendEvent(schemaTheme.id, { type: 'node.renamed', payload: {
    nodeId: 'wrong-node', sourceRef: 'schema:node', previousTitle: '校验节点', newTitle: '被拒绝', reason: '',
  } })
} catch { badRenameRejected = true }
let badInvalidationRejected = false
try {
  ev.appendEvent(schemaTheme.id, { type: 'node.invalidated', payload: {
    nodeId: schemaNode.id, sourceRef: 'schema:node', title: '校验节点', reason: ' ',
  } })
} catch { badInvalidationRejected = true }
ok('改名必须绑定到 sourceRef 所指的节点 ID', badRenameRejected && ev.getEvents(schemaTheme.id).length === 1)
ok('失效必须携带非空原因且失败不会污染有效前缀', badInvalidationRejected && ev.verifyChain(schemaTheme.id).ok
  && ev.getEvents(schemaTheme.id).length === 1)

console.log('\n— dry-run 不写账本 —')
const theme3 = store.addTheme('dry-run 主题')
chain.mountToChain(theme3.id, { mountId: 'd1', segmentNames: ['段D'], reason: 'r' })
const dr = ev.migrateThemeToEvents(theme3.id, { persist: false })
ok('dry-run 构造出事件', dr.created > 0, `构造 ${dr.created}`)
ok('dry-run 未写账本', ev.getEvents(theme3.id).length === 0)

console.log('\n— 缺失旧 ID 的确定性迁移身份 —')
const missingIdTheme = store.addTheme('旧记录缺失 ID 主题')
{
  const row = store.load().themes.find((item) => item.id === missingIdTheme.id)
  row.chain = { segments: [{ name: '缺失 ID 的旧段', coreInfo: '旧结论', status: 'pending', layer: 0,
    changeLog: [{ oldValue: '旧值', newValue: '新值', reason: '旧更正', at: '2025-01-01' }] }] }
  store.persistLedger()
}
const missingRawChain = store.load().themes.find((item) => item.id === missingIdTheme.id).chain
const normalizedMissing1 = chain.normalizeChain(missingRawChain).segments[0]
const normalizedMissing2 = chain.normalizeChain(missingRawChain).segments[0]
ok('缺 ID 的旧段与 changeLog 在重复归一化时使用同一稳定哈希身份', normalizedMissing1.id === normalizedMissing2.id
  && normalizedMissing1.changeLog[0].id === normalizedMissing2.changeLog[0].id
  && normalizedMissing1.id.startsWith('legacy-segment-') && normalizedMissing1.changeLog[0].id.startsWith('legacy-log-'))
const missingFirstMigration = ev.migrateThemeToEvents(missingIdTheme.id)
const missingFirstEvents = ev.getEvents(missingIdTheme.id)
const missingSecondMigration = ev.migrateThemeToEvents(missingIdTheme.id)
const missingSecondEvents = ev.getEvents(missingIdTheme.id)
ok('缺 ID 旧段迁移保留同一 sourceRef 与事件 ID，重跑不重复创建', missingFirstMigration.created === 2
  && missingSecondMigration.created === 0 && missingFirstEvents.length === 2 && missingSecondEvents.length === 2
  && missingFirstEvents[0].id === `evt:seg:${normalizedMissing1.id}`
  && missingFirstEvents[0].payload.sourceRef === `segment:${normalizedMissing1.id}`
  && missingFirstEvents[1].id === `evt:log:${normalizedMissing1.changeLog[0].id}`
  && missingFirstEvents[1].payload.sourceRef === `segment:${normalizedMissing1.id}#log:${normalizedMissing1.changeLog[0].id}`)

console.log('\n— 旧节点类型映射到五类标准节点 —')
const canonicalLegacyTheme = store.addTheme('旧节点标准类型迁移主题')
const canonicalLegacyNodes = [
  ['concept', '旧概念'], ['object', '旧对象'], ['event', '旧事件'],
  ['viewpoint', '旧观点'], ['evidence', '旧证据'],
].map(([type, title]) => store.addNode({ themeId: canonicalLegacyTheme.id, kind: 'lemma', type, title }))
const canonicalMigration = ev.migrateThemeToEvents(canonicalLegacyTheme.id)
const canonicalEvents = ev.getEvents(canonicalLegacyTheme.id)
const canonicalProjection = canonicalEvents.filter((event) => event.type === 'node.created').map((event) => event.payload.nodeType).sort()
ok('五种已有标准节点类型在迁移中逐一保留且不压成观点', canonicalMigration.created === 5
  && canonicalProjection.join(',') === 'concept,event,evidence,object,viewpoint')
ok('标准类型旧节点记录仍保留在原数据存储中', canonicalLegacyNodes.every((node) => store.load().nodes.some((saved) => saved.id === node.id)))
const canonicalRerun = ev.migrateThemeToEvents(canonicalLegacyTheme.id)
ok('标准节点迁移可重复执行且无重复追加', canonicalRerun.created === 0
  && canonicalRerun.skipped === 5 && ev.verifyChain(canonicalLegacyTheme.id).ok)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
