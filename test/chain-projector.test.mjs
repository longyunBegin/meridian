/**
 * 认知链 · 投影测试（P2）。
 *
 * 运行：node test/chain-projector.test.mjs
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/chain-projector-data')
process.env.MERIDIAN_USER_DATA_DIR = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const store = await import('../src/main/store.js')
const ev = await import('../src/main/chain-events.js')
const pj = await import('../src/main/chain-projector.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

store.load()
const theme = store.addTheme('投影测试主题')

// 主张 A ← 证据 E1 支持；主张 B ← E2 反驳；A 被更正两次；B 结算为错误；C 归档
const a = ev.appendEvent(theme.id, { id: 'e-a', type: 'claim.created', payload: { title: '主张A', coreInfo: '初版结论', status: 'pending', confidence: 60, sourceKind: 'segment', sourceRef: 'segment:sa' } })
const b = ev.appendEvent(theme.id, { id: 'e-b', type: 'claim.created', payload: { title: '主张B', status: 'pending', sourceKind: 'lemma', sourceRef: 'lemma:lb' } })
const c = ev.appendEvent(theme.id, { id: 'e-c', type: 'claim.created', payload: { title: '主张C', status: 'pending', sourceKind: 'lemma', sourceRef: 'lemma:lc' } })
const e1 = ev.appendEvent(theme.id, { id: 'e-e1', type: 'evidence.appended', payload: { text: '财报披露口径' } })
const e2 = ev.appendEvent(theme.id, { id: 'e-e2', type: 'evidence.appended', payload: { text: '相反的供应链消息' } })
ev.appendEvent(theme.id, { id: 'e-r1', type: 'relation.declared', payload: { rel: 'supports', from: { eventId: 'e-e1' }, to: { eventId: 'e-a' } } })
ev.appendEvent(theme.id, { id: 'e-r2', type: 'relation.declared', payload: { rel: 'contradicts', from: { eventId: 'e-e2' }, to: { eventId: 'e-b' } } })
// 外部证据引用 → 外部节点
ev.appendEvent(theme.id, { id: 'e-r3', type: 'relation.declared', payload: { rel: 'supports', from: { ref: { type: 'inbox', id: 'inbox-1', title: '收件箱线索' } }, to: { eventId: 'e-a' } } })
// 更正链：A v1 → v2 → v3
ev.appendEvent(theme.id, { id: 'e-a2', type: 'correction.appended', supersedes: 'e-a', payload: { oldValue: '初版结论', newValue: '修正结论', reason: '口径更新' } })
ev.appendEvent(theme.id, { id: 'e-a3', type: 'correction.appended', supersedes: 'e-a2', payload: { oldValue: '修正结论', newValue: '终版结论', reason: '再次核实' } })
ev.appendEvent(theme.id, { id: 'e-sb', type: 'settlement.recorded', payload: { correct: false, resolved: true, date: '2026-09-01', sourceKind: 'lemma', sourceRef: 'lemma:lb' } })
ev.appendEvent(theme.id, { id: 'e-ac', type: 'node.archived', payload: { sourceKind: 'lemma', sourceRef: 'lemma:lc' } })

console.log('\n— projectEvents —')
const proj = pj.projectEvents(ev.getEvents(theme.id))
const nodeA = proj.nodes.find((n) => n.id === 'e-a')
const nodeB = proj.nodes.find((n) => n.id === 'e-b')
const nodeC = proj.nodes.find((n) => n.id === 'e-c')
ok('节点数 6（3主张+2证据+1外部）', proj.nodes.length === 6, `实际 ${proj.nodes.length}`)
ok('边数 3', proj.edges.length === 3, `实际 ${proj.edges.length}`)
ok('更正不建新节点', !proj.nodes.some((n) => n.id === 'e-a2' || n.id === 'e-a3'))
ok('A 标记已更正', nodeA.superseded === true)
ok('A 当前值为终版', nodeA.currentText === '终版结论', nodeA.currentText)
ok('A 谱系 3 个事件', nodeA.eventIds.length === 3)
ok('B 标记已证伪', nodeB.correct === false)
ok('C 标记已归档', nodeC.archived === true)
ok('外部证据节点', proj.nodes.some((n) => n.external && n.title.includes('收件箱线索')))
ok('节点带来源事件 provenance', nodeA.provenanceEventIds.includes('e-a') && nodeA.sourceRef === 'segment:sa')
ok('关系边带来源事件 provenance', proj.edges.every((edge) => edge.provenanceEventIds.includes(edge.eventId)))
ok('支持关系汇总唯一证据数', nodeA.evidenceCount === 2, `实际 ${nodeA.evidenceCount}`)
const contradicts = proj.edges.find((e) => e.rel === 'contradicts')
ok('反驳边存在', !!contradicts && contradicts.from === 'e-e2' && contradicts.to === 'e-b')

console.log('\n— chainScope —')
const scope = pj.chainScope(proj)
ok('C（孤立非段主张）被收进 floating', !scope.nodes.some((n) => n.id === 'e-c') && scope.floating.some((n) => n.id === 'e-c'))
ok('A（段骨干）保留', scope.nodes.some((n) => n.id === 'e-a'))
ok('B（有边）保留', scope.nodes.some((n) => n.id === 'e-b'))

console.log('\n— getChainProjection 懒迁移 —')
const theme2 = store.addTheme('懒迁移主题')
{
  // 造旧结构：一段 + 一条 lemma，不跑迁移
  const t = store.load().themes.find((x) => x.id === theme2.id)
  t.chain = { segments: [{ id: 's1', name: '旧段', coreInfo: '旧结论', status: 'pending', layer: 0, changeLog: [], evidenceRefs: [], affects: [], mergedFrom: [] }] }
  store.addNode({ themeId: theme2.id, kind: 'lemma', title: '旧命题', type: 'observation', confidence: 55,
    sources: [{ kind: '一手数据', label: '旧来源标签', quality: 0.9, at: '2025-01-02', url: 'https://example.com/legacy-source' }] })
  store.persistLedger()
}
const archiveReadBeforeMigration = pj.getArchivedProjectionNodes(theme2.id)
ok('事件墓碑只读查询不触发旧数据迁移', archiveReadBeforeMigration.nodes.length === 0
  && !Object.hasOwn(store.allThemes().find((t) => t.id === theme2.id), 'eventChain'))
const gp = pj.getChainProjection(theme2.id)
ok('懒迁移包含旧来源证据与支持边', gp.eventCount === 4, `实际 ${gp.eventCount}`)
ok('旧段成为骨干节点', gp.nodes.some((n) => n.title === '旧段'))
const legacyClaim = gp.nodes.find((n) => n.title === '旧命题')
const legacyEvidence = gp.nodes.find((n) => n.kind === 'evidence' && n.title === '旧来源标签')
ok('旧命题和来源证据进入当前图并互相连通', !!legacyClaim && !!legacyEvidence
  && gp.edges.some((edge) => edge.rel === 'supports' && edge.from === legacyEvidence.id && edge.to === legacyClaim.id))
ok('旧来源元数据保留在证据事件', ev.getEvents(theme2.id).some((e) => e.type === 'evidence.appended'
  && e.payload.legacySource?.url === 'https://example.com/legacy-source'))
ok('二次调用不重复迁移', pj.getChainProjection(theme2.id).eventCount === 4)

const partialTheme = store.addTheme('部分升级来源主题')
const partialNode = store.addNode({ themeId: partialTheme.id, kind: 'lemma', title: '部分升级命题',
  sources: [{ kind: '独立媒体', label: '部分升级来源', quality: 0.65, url: 'https://example.com/partial-source' }] })
ev.appendEvent(partialTheme.id, {
  id: `evt:node:${partialNode.id}`, type: 'claim.created',
  payload: { title: partialNode.title, nodeKind: 'claim', sourceKind: 'lemma', sourceRef: `lemma:${partialNode.id}` },
})
const partialProjection = pj.getChainProjection(partialTheme.id)
ok('已有事件的部分升级会补入缺失的旧来源事件', partialProjection.eventCount === 3
  && partialProjection.edges.some((edge) => edge.rel === 'supports')
  && partialProjection.nodes.some((n) => n.kind === 'evidence' && n.title === '部分升级来源'))

console.log('\n— mountDraftToEvents —')
const theme3 = store.addTheme('挂载测试主题')
const mountRes = pj.mountDraftToEvents(theme3.id, {
  inboxId: 'inbox-9', inboxTitle: '测试条目',
  segmentNames: [], newSegmentName: '新主张',
  coreInfo: '核心判断', newValue: '新版判断', evidence: '依据文本',
  evidenceRefs: [{ type: 'lemma', id: 'lm-1', title: '关联命题' }],
})
ok('新主张挂载成功', mountRes.ok && mountRes.claims.includes('新主张'))
const mEvents = ev.getEvents(theme3.id)
ok('新主张产生 4 个事件（创建+证据+关系+更正）', mEvents.length === 4, `实际 ${mEvents.length}`)
const mProj = pj.projectEvents(mEvents)
const mNode = mProj.nodes.find((n) => n.title === '新主张')
ok('挂载后主张在投影中', !!mNode)
ok('挂载证据通过 supports 连入', mProj.edges.some((e) => e.rel === 'supports' && e.to === mNode.id))
ok('newValue 追为更正事件', mNode.superseded && mNode.currentText === '新版判断')
ok('更正链可校验', ev.verifyChain(theme3.id).ok)
// 再次挂载同名 → 命中已有主张，不建新主张
const mountRes2 = pj.mountDraftToEvents(theme3.id, {
  inboxId: 'inbox-10', segmentNames: ['新主张'], newSegmentName: '',
  evidence: '第二条依据',
})
const mEvents2 = ev.getEvents(theme3.id)
const mProj2 = pj.projectEvents(mEvents2)
ok('同名挂载不建新主张', mProj2.nodes.filter((n) => n.kind === 'claim' && n.title === '新主张').length === 1)
ok('同名挂载只追加证据+关系', mEvents2.length === mEvents.length + 2, `实际 ${mEvents2.length}`)
const replay = pj.mountDraftToEvents(theme3.id, {
  inboxId: 'inbox-10', segmentNames: ['新主张'], newSegmentName: '', evidence: '第二条依据',
})
ok('同一收件箱挂载重放不产生重复事件', replay.events === 0 && replay.replayed && ev.getEvents(theme3.id).length === mEvents2.length)

const unsupportedTheme = store.addTheme('无自我佐证测试')
pj.mountDraftToEvents(unsupportedTheme.id, {
  newSegmentName: '未附证据的判断', newValue: '判断文本不得冒充证据',
})
const unsupportedEvents = ev.getEvents(unsupportedTheme.id)
ok('新值不会被复制成支持自身的证据节点', unsupportedEvents.filter((e) => e.type === 'evidence.appended').length === 0
  && unsupportedEvents.filter((e) => e.type === 'relation.declared').length === 0
  && unsupportedEvents.length === 2)
const citedTheme = store.addTheme('显式引用测试')
pj.mountDraftToEvents(citedTheme.id, {
  newSegmentName: '有来源判断', evidenceRefs: [{ type: 'url', id: 'source-1', title: '来源一' }],
})
const citedEvents = ev.getEvents(citedTheme.id)
ok('明确来源引用可生成带来源的证据节点与支持边', citedEvents.some((e) => e.type === 'evidence.appended'
  && e.payload.evidenceRefs.some((r) => r.id === 'source-1'))
  && citedEvents.some((e) => e.type === 'relation.declared' && e.payload.rel === 'supports'))

console.log('\n— 投影归档 / 恢复 —')
const eventNode = pj.getChainProjection(theme3.id).nodes.find((n) => n.title === '新主张')
const archiveEvent = pj.archiveProjectedNode(theme3.id, eventNode.sourceRef, '证据已过时')
const archivedRead = pj.getArchivedProjectionNodes(theme3.id)
ok('归档追加事件含原因与证据数', archiveEvent.type === 'node.archived' && archiveEvent.payload.reason === '证据已过时' && archiveEvent.payload.evidenceCount === 2)
ok('归档查询返回详情和日期', archivedRead.nodes.some((n) => n.sourceRef === eventNode.sourceRef && n.archiveReason === '证据已过时' && n.archivedAt))
const restoreEvent = pj.restoreProjectedNode(theme3.id, eventNode.sourceRef, '重新核验后恢复')
const restoredNode = pj.projectEvents(ev.getEvents(theme3.id)).nodes.find((n) => n.sourceRef === eventNode.sourceRef)
ok('恢复只追加 node.restored 且保留归档史', restoreEvent.type === 'node.restored' && ev.getEvents(theme3.id).some((e) => e.id === archiveEvent.id))
ok('重放恢复后节点重新进入当前图', !restoredNode.archived && restoredNode.restoredAt && ev.verifyChain(theme3.id).ok)
let restoreTwiceRejected = false
try { pj.restoreProjectedNode(theme3.id, eventNode.sourceRef, '重复恢复') } catch { restoreTwiceRejected = true }
ok('重复恢复拒绝', restoreTwiceRejected)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
