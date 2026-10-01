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
ev.appendEvent(theme.id, { id: 'e-r4', type: 'relation.declared', payload: { rel: 'contradicts', from: { ref: { type: 'lemma', id: 'unresolved-claim' } }, to: { eventId: 'e-a' } } })
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
ok('节点数 7（3主张+2证据+2外部）', proj.nodes.length === 7, `实际 ${proj.nodes.length}`)
ok('边数 4', proj.edges.length === 4, `实际 ${proj.edges.length}`)
ok('更正不建新节点', !proj.nodes.some((n) => n.id === 'e-a2' || n.id === 'e-a3'))
ok('A 标记已更正', nodeA.superseded === true)
ok('A 当前值为终版', nodeA.currentText === '终版结论', nodeA.currentText)
ok('A 谱系 3 个事件', nodeA.eventIds.length === 3)
ok('B 标记已证伪', nodeB.correct === false)
ok('C 标记已归档', nodeC.archived === true)
ok('外部证据节点', proj.nodes.some((n) => n.external && n.title.includes('收件箱线索')))
ok('缺少可读名称的外部引用显示来源未解析', proj.nodes.some((n) => n.external && n.sourceRef.includes('unresolved-claim') && n.title === '来源未解析'))
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

console.log('\n— evidence ref 去重与回放稳定性 —')
const duplicateRefTheme = store.addTheme('重复证据引用测试')
const duplicateRefs = [
  { type: 'lemma', id: 'same-ref', title: '首个标题' },
  { type: 'lemma', id: 'same-ref', title: '后续标题不得覆盖' },
  { type: 'url', id: 'https://example.test/evidence', title: 'URL 来源' },
]
const duplicateMount = pj.mountDraftToEvents(duplicateRefTheme.id, {
  inboxId: 'duplicate-ref-inbox', inboxTitle: '重复引用条目', newSegmentName: '引用去重主张',
  evidence: '保留的依据摘要', evidenceRefs: duplicateRefs,
})
const duplicateEvents = ev.getEvents(duplicateRefTheme.id)
const duplicateEvidence = duplicateEvents.filter((event) => event.type === 'evidence.appended')
const normalizedRefs = duplicateEvidence[0]?.payload.evidenceRefs || []
ok('同一挂载中的重复 ref 按规范化 type/id 去重且保留首次顺序/标题', duplicateMount.ok
  && normalizedRefs.length === 3
  && normalizedRefs[1]?.id === 'same-ref' && normalizedRefs[1]?.title === '首个标题'
  && normalizedRefs[2]?.type === 'url')
const eventCountAfterFirstDuplicateMount = duplicateEvents.length
const duplicateReplay = pj.mountDraftToEvents(duplicateRefTheme.id, {
  inboxId: 'duplicate-ref-inbox', inboxTitle: '重复引用条目', newSegmentName: '引用去重主张',
  evidence: '保留的依据摘要', evidenceRefs: duplicateRefs,
})
ok('重复挂载重放不会再追加同一证据事件或支持关系', duplicateReplay.events === 0
  && ev.getEvents(duplicateRefTheme.id).length === eventCountAfterFirstDuplicateMount)
pj.mountDraftToEvents(duplicateRefTheme.id, {
  inboxId: 'second-inbox-same-evidence', segmentNames: ['引用去重主张'], evidence: '保留的依据摘要',
  evidenceRefs: duplicateRefs,
})
const crossInboxEvents = ev.getEvents(duplicateRefTheme.id)
const repeatedReferenceCount = crossInboxEvents.filter((event) => event.type === 'evidence.appended')
  .flatMap((event) => event.payload.evidenceRefs || []).filter((ref) => ref.type === 'lemma' && ref.id === 'same-ref').length
ok('不同 inbox 重用同一 evidence ref 时不重复写入该引用', repeatedReferenceCount === 1
  && crossInboxEvents.filter((event) => event.type === 'evidence.appended').length === 2)

const repeatedTextTheme = store.addTheme('重复正文独立挂接测试')
pj.mountDraftToEvents(repeatedTextTheme.id, { newSegmentName: '原文相同的主张', evidence: '相同正文' })
pj.mountDraftToEvents(repeatedTextTheme.id, { segmentNames: ['原文相同的主张'], evidence: '相同正文' })
ok('相同正文的独立挂接仍各自追加证据事件，不按文本误去重', ev.getEvents(repeatedTextTheme.id)
  .filter((event) => event.type === 'evidence.appended').length === 2)

const reviewTheme = store.addTheme('推导关系复核测试')
const reviewFrom = ev.appendEvent(reviewTheme.id, { id: 'review-from', type: 'claim.created', payload: { title: '推断 A', nodeKind: 'inference' } })
const reviewTo = ev.appendEvent(reviewTheme.id, { id: 'review-to', type: 'claim.created', payload: { title: '主张 B', nodeKind: 'claim' } })
const derivedEdge = pj.declareProjectedRelation(reviewTheme.id, reviewFrom.id, reviewTo.id, 'derives')
const beforeDecision = pj.projectEvents(ev.getEvents(reviewTheme.id)).edges.find((edge) => edge.eventId === derivedEdge.id)
ok('derives 声明默认待用户复核', derivedEdge.payload.reviewStatus === 'pending-review' && beforeDecision?.pendingReview === true)
const reviewedCount = ev.getEvents(reviewTheme.id).length
const reviewDecision = pj.reviewProjectedRelation(reviewTheme.id, derivedEdge.id, 'confirmed', '已检查前提与来源')
const afterDecisionEvents = ev.getEvents(reviewTheme.id)
const afterDecisionEdge = pj.projectEvents(afterDecisionEvents).edges.find((edge) => edge.eventId === derivedEdge.id)
ok('人工确认以新关系事件追加且原关系 payload 未变', reviewDecision.id !== derivedEdge.id
  && reviewDecision.payload.reviewOf === derivedEdge.id
  && ev.getEvents(reviewTheme.id).find((event) => event.id === derivedEdge.id).payload.reviewStatus === 'pending-review'
  && afterDecisionEvents.length === reviewedCount + 1)
ok('复核后投影保留决定者、时间、理由并只解除待复核状态', afterDecisionEdge?.pendingReview === false
  && afterDecisionEdge?.reviewDecision === 'confirmed' && afterDecisionEdge?.reviewReason === '已检查前提与来源'
  && afterDecisionEdge?.reviewedBy === 'user' && !!afterDecisionEdge?.reviewedAt)
let repeatedReviewRejected = false
try { pj.reviewProjectedRelation(reviewTheme.id, derivedEdge.id, 'rejected', '改主意') } catch { repeatedReviewRejected = true }
ok('已决定的关系不可原地反转或重复复核', repeatedReviewRejected && ev.verifyChain(reviewTheme.id).ok)

const replayTheme = store.addTheme('历史只读回放测试')
ev.appendEvent(replayTheme.id, { id: 'replay-a', type: 'claim.created', payload: { title: '版本 A', sourceRef: 'fixture:a' } })
ev.appendEvent(replayTheme.id, { id: 'replay-b', type: 'claim.created', payload: { title: '版本 B', sourceRef: 'fixture:b' } })
const eventsBeforeReplay = JSON.stringify(ev.getEvents(replayTheme.id))
const replayAtOne = pj.getChainProjectionAt(replayTheme.id, 1)
ok('v1 回放仅含 v1 节点且标记只读序号', replayAtOne.selectedSeq === 1
  && replayAtOne.allNodes.some((node) => node.id === 'replay-a')
  && !replayAtOne.allNodes.some((node) => node.id === 'replay-b')
  && replayAtOne.integrity.replayed === true)
pj.getChainProjectionAt(replayTheme.id, 99)
ok('只读历史回放不写入或修改生产 ledger', JSON.stringify(ev.getEvents(replayTheme.id)) === eventsBeforeReplay)
const damagedReplayTheme = store.addTheme('损坏前缀回放测试')
ev.appendEvent(damagedReplayTheme.id, { id: 'safe-prefix', type: 'claim.created', payload: { title: '最后有效前缀' } })
ev.appendEvent(damagedReplayTheme.id, { id: 'bad-future', type: 'claim.created', payload: { title: '损坏后的未来' } })
const damagedRow = store.load().themes.find((item) => item.id === damagedReplayTheme.id)
damagedRow.eventChain.events[1].payload.title = '被篡改的未来状态'
store.persistLedger()
const damagedReplay = pj.getChainProjectionAt(damagedReplayTheme.id, 999)
ok('账本损坏时回放自动截断到最后校验有效前缀', damagedReplay.selectedSeq === 1
  && damagedReplay.validPrefixSeq === 1
  && damagedReplay.allNodes.some((node) => node.id === 'safe-prefix')
  && !damagedReplay.allNodes.some((node) => node.id === 'bad-future'))

console.log('\n— 明确添加证据与语义关系 —')
const manualTheme = store.addTheme('手动建模主题')
const manualClaimEvent = ev.appendEvent(manualTheme.id, {
  id: 'evt:manual-claim', type: 'claim.created',
  payload: { title: '待验证观点', coreInfo: '观点说明不是证据', sourceRef: 'manual:claim' },
})
const addedEvidence = pj.appendEvidenceToProjectedNode(manualTheme.id, manualClaimEvent.id, {
  text: '年报中披露的实际数值', sourceLabel: '公司年报', url: 'https://example.com/report',
})
const manualRows = ev.getEvents(manualTheme.id)
ok('补充证据追加证据与支持关系两条事件', addedEvidence.length === 2
  && addedEvidence[0].type === 'evidence.appended' && addedEvidence[1].type === 'relation.declared')
ok('观点说明不会被复制成证据', addedEvidence[0].payload.text === '年报中披露的实际数值'
  && addedEvidence[0].payload.text !== '观点说明不是证据')
ok('来源名称作为可读元数据保存在证据事件中', addedEvidence[0].payload.sourceLabel === '公司年报')
ok('手动证据保留来源 URL 并明确连到目标观点', addedEvidence[0].payload.evidenceRefs[0]?.id === 'https://example.com/report'
  && addedEvidence[1].payload.from.eventId === addedEvidence[0].id
  && addedEvidence[1].payload.to.eventId === manualClaimEvent.id)
const contradiction = pj.declareProjectedRelation(manualTheme.id, addedEvidence[0].id, manualClaimEvent.id, 'contradicts')
ok('反驳关系显式追加且完整性继续通过', contradiction.type === 'relation.declared'
  && contradiction.payload.rel === 'contradicts' && ev.verifyChain(manualTheme.id).ok)
let duplicateRelationRejected = false
try { pj.declareProjectedRelation(manualTheme.id, addedEvidence[0].id, manualClaimEvent.id, 'contradicts') } catch { duplicateRelationRejected = true }
ok('重复关系不会静默膨胀图谱', duplicateRelationRejected)

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
