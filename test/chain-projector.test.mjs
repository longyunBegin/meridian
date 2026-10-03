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
ok('支持与反驳关系汇总唯一可导航证据数', nodeA.evidenceCount === 3, `实际 ${nodeA.evidenceCount}`)
const contradicts = proj.edges.find((e) => e.rel === 'contradicts')
ok('反驳边存在', !!contradicts && contradicts.from === 'e-e2' && contradicts.to === 'e-b')

console.log('\n— evidence.appended 显式目标与历史回放 —')
const evidenceTheme = store.addTheme('证据目标隔离主题')
ev.appendEvent(evidenceTheme.id, { id: 'target-a', type: 'node.created', payload: { nodeType: 'viewpoint', title: '目标观点 A', sourceRef: 'manual:target-a' } })
ev.appendEvent(evidenceTheme.id, { id: 'target-b', type: 'node.created', payload: { nodeType: 'viewpoint', title: '目标观点 B', sourceRef: 'manual:target-b' } })
for (let index = 0; index < 14; index++) {
  const targetNodeId = index % 2 === 0 ? 'target-a' : 'target-b'
  ev.appendEvent(evidenceTheme.id, {
    id: `targeted-evidence-${index + 1}`, type: 'evidence.appended',
    payload: { text: `目标证据 ${index + 1}`, ...(index % 3 === 0 ? { claimId: targetNodeId } : { targetNodeId }) },
  })
}
ev.appendEvent(evidenceTheme.id, { id: 'orphan-evidence', type: 'evidence.appended', payload: { text: '未指定目标的孤立证据' } })
const evidenceProjection = pj.getChainProjection(evidenceTheme.id)
const targetA = evidenceProjection.allNodes.find((node) => node.id === 'target-a')
const targetB = evidenceProjection.allNodes.find((node) => node.id === 'target-b')
const expectedEvidenceA = Array.from({ length: 7 }, (_, index) => `targeted-evidence-${index * 2 + 1}`)
const expectedEvidenceB = Array.from({ length: 7 }, (_, index) => `targeted-evidence-${index * 2 + 2}`)
ok('14 条证据事件仅按显式目标进入对应观点清单', targetA.evidenceCount === 7 && targetB.evidenceCount === 7
  && targetA.evidenceEventIds.length === 7 && targetB.evidenceEventIds.length === 7)
ok('A/B 目标互不串挂', expectedEvidenceA.every((id) => targetA.evidenceEventIds.includes(id))
  && expectedEvidenceB.every((id) => targetB.evidenceEventIds.includes(id))
  && !targetA.evidenceEventIds.some((id) => expectedEvidenceB.includes(id)))
ok('无目标证据不因事件总数或标题而猜挂', evidenceProjection.allNodes.find((node) => node.id === 'orphan-evidence').targetNodeIds.length === 0
  && targetA.evidenceCount + targetB.evidenceCount === 14)
const evidencePrefix = pj.getChainProjectionAt(evidenceTheme.id, 9)
const prefixA = evidencePrefix.allNodes.find((node) => node.id === 'target-a')
const prefixB = evidencePrefix.allNodes.find((node) => node.id === 'target-b')
ok('有效前缀历史证据数随时间截断且目标保持一致', evidencePrefix.integrity.replayed === true
  && prefixA.evidenceCount === 4 && prefixB.evidenceCount === 3
  && prefixA.evidenceEventIds.every((id) => expectedEvidenceA.includes(id))
  && prefixB.evidenceEventIds.every((id) => expectedEvidenceB.includes(id)))

console.log('\n— chainScope —')
const scope = pj.chainScope(proj)
ok('C（孤立主题节点）仍属于同一张无根网络，不被移入第二张浮动图', scope.nodes.some((n) => n.id === 'e-c') && scope.floating.length === 0)
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
ok('legacy evidence 目标事件 ID 与旧关系边汇总到同一清单', legacyClaim.evidenceCount === 1
  && legacyClaim.evidenceEventIds.includes(legacyEvidence.id)
  && ev.getEvents(theme2.id).some((event) => event.id === legacyEvidence.id && event.payload.targetNodeId === legacyClaim.id))
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
/* 佐证 / 反驳：同一入口，两种方向 */
const confBefore = pj.getChainProjection(manualTheme.id).nodes.find((n) => n.id === manualClaimEvent.id)?.confidence
const refutingEvidence = pj.appendEvidenceToProjectedNode(manualTheme.id, manualClaimEvent.id, {
  text: '第三方复核发现数据口径不一致', rel: 'contradicts', reason: '口径差异导致结论不可比',
})
ok('反驳证据追加 relation.declared 且 rel=contradicts', refutingEvidence.length === 2
  && refutingEvidence[1].type === 'relation.declared' && refutingEvidence[1].payload.rel === 'contradicts'
  && refutingEvidence[1].payload.reason === '口径差异导致结论不可比')
ok('用户亲笔的反驳不需要复核（pendingReview 为假）', refutingEvidence[1].payload.reviewOf == null)
const defaultRelEvidence = pj.appendEvidenceToProjectedNode(manualTheme.id, manualClaimEvent.id, {
  text: '另一份佐证材料', rel: 'nonsense',
})
ok('非法 rel 回退为 supports', defaultRelEvidence[1].payload.rel === 'supports')
const projAfterRefute = pj.getChainProjection(manualTheme.id)
const contradictsEdge = (projAfterRefute.allEdges || projAfterRefute.edges || [])
  .find((e) => e.rel === 'contradicts' && e.from === refutingEvidence[0].id && e.to === manualClaimEvent.id)
const confAfter = projAfterRefute.nodes.find((n) => n.id === manualClaimEvent.id)?.confidence
ok('反驳边进入投影且目标节点 confidence 未被触碰（公理1）', !!contradictsEdge && confAfter === confBefore)
let duplicateRelationRejected = false
try { pj.declareProjectedRelation(manualTheme.id, addedEvidence[0].id, manualClaimEvent.id, 'contradicts') } catch { duplicateRelationRejected = true }
ok('重复关系不会静默膨胀图谱', duplicateRelationRejected)

console.log('\n— 认知建议审阅闭环：隔离合成账本 —')
const engineTheme = store.addTheme('隔离引擎审阅闭环')
const engineTarget = ev.appendEvent(engineTheme.id, { id: 'engine-target-support', type: 'claim.created', payload: {
  title: '合成营收观点', coreInfo: '初始说明', status: 'pending', confidence: 60, sourceRef: 'synthetic:engine-target',
} })
const makeEngineProposal = (key, targetId, rel, { quoteVerified = true, kind = 'evidence' } = {}) => ev.appendEvent(engineTheme.id, {
  id: `engine-proposal-${key}`, actor: 'engine', type: 'engine.recommendation.proposed', payload: {
    pendingReview: true, recommendationId: `synthetic:${key}`, inboxId: `synthetic-inbox:${key}`,
    statement: { subject: '合成公司', attribute: '营收', value: key, timeWindow: '2026Q2', type: 'hard',
      sourceText: `合成来源摘录：${key}。`, sourceQuoteVerified: quoteVerified },
    recommendation: { kind, title: kind === 'new-proposition' ? `合成新观点 ${key}` : '合成营收观点',
      propositionId: kind === 'evidence' ? targetId : null, rel, strength: 0.62, matchScore: 0.84, effectiveStrength: 0.51,
      change: { direction: 'improving', nature: 'quantitative', themeTag: '营收' } },
    metaMultiplier: 0.85, sourceLabel: '隔离合成来源', sourceUrl: 'https://example.test/synthetic',
    sourcePublishedAt: '2026-09-18', sourceFetchedAt: '2026-09-21T09:55:00.000Z', ingestedAt: '2026-09-21T10:00:00.000Z',
  },
})
const rejectionProposal = makeEngineProposal('reject', engineTarget.id, 'supports')
const beforeRejectCount = ev.getEvents(engineTheme.id).length
const rejectedReview = pj.reviewEngineRecommendation(engineTheme.id, rejectionProposal.id, 'rejected', {})
const afterRejectEvents = ev.getEvents(engineTheme.id)
ok('驳回只追加 signal.reviewed，不生成证据/关系/置信度事实', rejectedReview.ok
  && afterRejectEvents.length === beforeRejectCount + 1
  && afterRejectEvents.at(-1).type === 'signal.reviewed'
  && !afterRejectEvents.some((event) => event.type === 'evidence.appended' || event.type === 'confidence.updated'))
const repeatedReject = pj.reviewEngineRecommendation(engineTheme.id, rejectionProposal.id, 'rejected', {})
ok('重复驳回幂等，不重复追加决定事件', repeatedReject.replayed && ev.getEvents(engineTheme.id).length === beforeRejectCount + 1)
let conflictingDecisionRejected = false
try { pj.reviewEngineRecommendation(engineTheme.id, rejectionProposal.id, 'accepted', { change: { direction: 'improving', nature: 'quantitative', themeTag: '营收' } }) }
catch { conflictingDecisionRejected = true }
ok('已驳回建议不能被重放改成接受', conflictingDecisionRejected)

const supportProposal = makeEngineProposal('support', engineTarget.id, 'supports')
const beforeConfirmSeq = ev.getEvents(engineTheme.id).length
const supportReview = pj.reviewEngineRecommendation(engineTheme.id, supportProposal.id, 'accepted', {
  change: { direction: 'improving', nature: 'quantitative', themeTag: '营收' },
})
const afterSupportEvents = ev.getEvents(engineTheme.id)
const supportEvidence = afterSupportEvents.find((event) => event.type === 'evidence.appended' && event.payload.recommendationId === 'synthetic:support')
const supportConfidence = afterSupportEvents.find((event) => event.type === 'confidence.updated' && event.payload.evidenceEventId === supportEvidence?.id)
const expectedStrength = 0.62 * 0.85 /* hard fact + URL is capped at 1; relation × meta */
ok('用户确认后按追加事件批次记录证据、supports 关系、实际强度和决定', supportReview.ok
  && afterSupportEvents.some((event) => event.type === 'relation.declared' && event.payload.from?.eventId === supportEvidence?.id)
  && supportConfidence?.payload.strength === expectedStrength && afterSupportEvents.at(-1).type === 'signal.reviewed')
const currentEngineProjection = pj.getChainProjection(engineTheme.id)
const currentTarget = currentEngineProjection.nodes.find((node) => node.id === engineTarget.id)
ok('confidence.updated 投影更新 0–100 当前置信度并记录来源历史', supportConfidence?.payload.oldConfidence === 60
  && supportConfidence?.payload.newConfidence === currentTarget?.confidence
  && currentTarget?.confidenceHistory?.at(-1)?.eventId === supportConfidence.id)
const replayBeforeConfirm = pj.getChainProjectionAt(engineTheme.id, beforeConfirmSeq)
ok('回放到确认前仍只有建议、无确认边或置信度变化', replayBeforeConfirm.allNodes.find((node) => node.id === engineTarget.id)?.confidence === 60
  && !replayBeforeConfirm.allEdges.some((edge) => edge.from === supportEvidence?.id))
const beforeDuplicateAccept = ev.getEvents(engineTheme.id).length
const duplicateAccept = pj.reviewEngineRecommendation(engineTheme.id, supportProposal.id, 'accepted', {
  change: { direction: 'improving', nature: 'quantitative', themeTag: '营收' },
})
ok('确认命令重试返回既有决定，不重复证据、关系或 confidence.updated', duplicateAccept.replayed
  && ev.getEvents(engineTheme.id).length === beforeDuplicateAccept)

const relationTypes = ['contradicts', 'derives', 'supersedes', 'related']
const relationResults = []
for (const rel of relationTypes) {
  const target = ev.appendEvent(engineTheme.id, { id: `engine-target-${rel}`, type: 'claim.created', payload: {
    title: `合成 ${rel} 观点`, coreInfo: '当前合成结论', confidence: 50, sourceRef: `synthetic:target:${rel}`,
  } })
  const proposal = makeEngineProposal(rel, target.id, rel)
  const review = pj.reviewEngineRecommendation(engineTheme.id, proposal.id, 'accepted', {
    change: { direction: rel === 'contradicts' ? 'declining' : 'stable', nature: 'structural', themeTag: rel },
  })
  relationResults.push({ rel, target, proposal, review })
}
const engineRows = ev.getEvents(engineTheme.id)
const engineProjection = pj.getChainProjection(engineTheme.id)
ok('五种归因关系均经用户确认：支持/反驳/衍生/取代/相关分别映射到账本语义',
  relationResults.every(({ rel, target, proposal, review }) => review.ok
    && engineRows.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === proposal.id)
    && (rel === 'supersedes'
      ? engineRows.some((event) => event.type === 'correction.appended' && event.payload.sourceKind === 'engine-reviewed'
        && event.supersedes === target.id)
      : engineProjection.allEdges.some((edge) => edge.rel === rel && edge.to === target.id))
    && (rel !== 'derives' || engineProjection.allEdges.find((edge) => edge.rel === 'derives' && edge.to === target.id)?.pendingReview === false)))
const supersedesResult = relationResults.find((result) => result.rel === 'supersedes')
const supersedesCorrection = engineRows.find((event) => event.type === 'correction.appended' && event.supersedes === supersedesResult?.target.id)
const supersedesNode = engineProjection.allNodes.find((node) => node.id === supersedesResult?.target.id)
ok('修订版本边不混入弱关联；原文、适用时间、发布/抓取/摄入与分作用评分随 correction 保留',
  engineProjection.allEdges.some((edge) => edge.rel === 'supersedes' && edge.to === supersedesResult?.target.id && edge.relationGroup === 'revision')
  && supersedesCorrection?.payload.text === '合成来源摘录：supersedes。'
  && supersedesCorrection?.payload.applicability === '2026Q2'
  && supersedesCorrection?.payload.sourcePublishedAt === '2026-09-18'
  && supersedesCorrection?.payload.sourceFetchedAt === '2026-09-21T09:55:00.000Z'
  && supersedesCorrection?.payload.ingestedAt === '2026-09-21T10:00:00.000Z'
  && supersedesCorrection?.payload.scores?.matchScore === 0.84
  && supersedesCorrection?.payload.scores?.attributionStrength === 0.62
  && supersedesCorrection?.payload.scores?.effectiveStrength === 0.51
  && supersedesNode?.currentText === '合成来源摘录：supersedes。' && supersedesNode?.applicability === '2026Q2')

const unverified = makeEngineProposal('unverified', engineTarget.id, 'supports', { quoteVerified: false })
let unverifiedRefused = false
try { pj.reviewEngineRecommendation(engineTheme.id, unverified.id, 'accepted', { change: { direction: 'stable', nature: 'quantitative', themeTag: '营收' } }) }
catch { unverifiedRefused = true }
ok('未经来源核验的模型摘录不能作为证据确认', unverifiedRefused
  && !ev.getEvents(engineTheme.id).some((event) => event.type === 'evidence.appended' && event.payload.recommendationId === 'synthetic:unverified'))

const relationalProposal = makeEngineProposal('relational', null, 'related', { kind: 'new-proposition' })
const beforeRelationalAccept = ev.getEvents(engineTheme.id).length
const relationalReview = pj.reviewEngineRecommendation(engineTheme.id, relationalProposal.id, 'accepted', {
  title: '用户确认的合成关系命题', change: { direction: 'stable', nature: 'structural', themeTag: '供需关系' },
})
const afterRelationalProjection = pj.getChainProjection(engineTheme.id)
ok('relational 流程由用户确认后追加观点、可核验来源和支持边，不自动预写事实', relationalReview.ok
  && ev.getEvents(engineTheme.id).length > beforeRelationalAccept
  && afterRelationalProjection.nodes.some((node) => node.title === '用户确认的合成关系命题')
  && afterRelationalProjection.allEdges.some((edge) => edge.rel === 'supports' && edge.to === relationalReview.events?.[0]?.id))
ok('引擎建议闭环完成后全事件链可验证', ev.verifyChain(engineTheme.id).ok)

console.log('\n— 去领域化：审阅 change 收敛为自由备注 —')
const noteProposal = makeEngineProposal('note-only', engineTarget.id, 'supports')
const noteReview = pj.reviewEngineRecommendation(engineTheme.id, noteProposal.id, 'accepted', {
  change: { note: '这句是自由备注，不是枚举。' },
})
const noteEvents = ev.getEvents(engineTheme.id)
const noteEvidence = noteEvents.find((event) => event.type === 'evidence.appended' && event.payload.recommendationId === 'synthetic:note-only')
const noteDecision = noteEvents.filter((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === noteProposal.id).at(-1)
const noteConfidence = noteEvents.find((event) => event.type === 'confidence.updated' && event.payload.evidenceEventId === noteEvidence?.id)
ok('确认建议后账本事件的 change 只有 note 字段', noteReview.ok
  && JSON.stringify(noteEvidence?.payload.change) === JSON.stringify({ note: '这句是自由备注，不是枚举。' })
  && JSON.stringify(noteDecision?.payload.change) === JSON.stringify({ note: '这句是自由备注，不是枚举。' })
  && ev.verifyChain(engineTheme.id).ok)
ok('强度只由 strength 决定，不读 change 标签', noteConfidence?.payload.strength === expectedStrength)

const emptyNoteProposal = makeEngineProposal('empty-note', engineTarget.id, 'supports')
let emptyNoteAccepted = false
try { emptyNoteAccepted = pj.reviewEngineRecommendation(engineTheme.id, emptyNoteProposal.id, 'accepted', {})?.ok === true } catch { emptyNoteAccepted = false }
const emptyNoteEvidence = ev.getEvents(engineTheme.id).find((event) => event.type === 'evidence.appended' && event.payload.recommendationId === 'synthetic:empty-note')
ok('input.change 已是可选：不再要求 direction/nature/themeTag', emptyNoteAccepted
  && Boolean(emptyNoteEvidence) && Object.keys(emptyNoteEvidence.payload.change || {}).every((key) => key === 'note'))

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

console.log('\n— 五类主题网络与完整节点生命周期 —')
const networkTheme = store.addTheme('合成网络全流程')
const emptyNetwork = pj.getChainProjection(networkTheme.id)
ok('新主题起始投影真实为空且不自动生成主题根或观点', emptyNetwork.integrity.ok
  && emptyNetwork.nodes.length === 0 && emptyNetwork.eventCount === 0)
let invalidNodeTypeRejected = false
try { pj.createProjectedNode(networkTheme.id, { nodeType: 'topic', title: '不得作为图节点的主题' }) } catch { invalidNodeTypeRejected = true }
ok('节点类型严格限制为五类，不接纳主题 root', invalidNodeTypeRejected && ev.getEvents(networkTheme.id).length === 0)
const concept = pj.createProjectedNode(networkTheme.id, { nodeType: 'concept', title: '合成概念' })
const objectNode = pj.createProjectedNode(networkTheme.id, { nodeType: 'object', title: '合成对象' })
const eventNodeNew = pj.createProjectedNode(networkTheme.id, { nodeType: 'event', title: '合成事件' })
const viewpoint = pj.createProjectedNode(networkTheme.id, {
  nodeType: 'viewpoint', title: '合成观点', detail: '用户输入的说明，不是证据', applicability: '2026Q1',
})
const evidence = pj.createProjectedNode(networkTheme.id, { nodeType: 'evidence', title: '合成证据', detail: '仅用于模型类型覆盖测试' })
const createdProjection = pj.getChainProjection(networkTheme.id)
ok('真实追加事件生成且只生成五类用户节点，不补造额外事实', createdProjection.nodes.length === 5
  && createdProjection.nodes.map((node) => node.nodeType).sort().join(',') === 'concept,event,evidence,object,viewpoint'
  && createdProjection.nodes.every((node) => node.kind !== 'theme'))
ok('用户明确输入的观点适用时间进入事件投影', createdProjection.allNodes.find((node) => node.id === viewpoint.id)?.applicability === '2026Q1')
const relationEvents = [
  pj.declareProjectedRelation(networkTheme.id, concept.id, objectNode.id, 'belongs-to'),
  pj.declareProjectedRelation(networkTheme.id, eventNodeNew.id, concept.id, 'influences'),
  pj.declareProjectedRelation(networkTheme.id, viewpoint.id, objectNode.id, 'depends-on'),
  pj.declareProjectedRelation(networkTheme.id, eventNodeNew.id, viewpoint.id, 'temporal'),
  pj.declareProjectedRelation(networkTheme.id, concept.id, eventNodeNew.id, 'related'),
  pj.declareProjectedRelation(networkTheme.id, evidence.id, viewpoint.id, 'supports'),
  pj.declareProjectedRelation(networkTheme.id, concept.id, viewpoint.id, 'derives'),
  pj.declareProjectedRelation(networkTheme.id, objectNode.id, eventNodeNew.id, 'derives'),
  pj.declareProjectedRelation(networkTheme.id, objectNode.id, viewpoint.id, 'contradicts'),
]
ok('五种弱主题关联与三种有向论证关系均可追加并投影', relationEvents.length === 9
  && relationEvents.map((event) => event.payload.rel).join(',') === 'belongs-to,influences,depends-on,temporal,related,supports,derives,derives,contradicts'
  && pj.getChainProjection(networkTheme.id).allEdges.length === 9)
const accepted = pj.reviewProjectedRelation(networkTheme.id, relationEvents[6].id, 'confirmed', '已确认合成前提链')
const rejected = pj.reviewProjectedRelation(networkTheme.id, relationEvents[7].id, 'rejected', '证据不足，驳回该推导')
const reviewedProjection = pj.getChainProjection(networkTheme.id)
ok('待复核论证确认与驳回都追加决定事件并关闭原关系待办', accepted.payload.reviewOf === relationEvents[6].id
  && rejected.payload.reviewOf === relationEvents[7].id
  && reviewedProjection.allEdges.find((edge) => edge.eventId === relationEvents[6].id)?.reviewDecision === 'confirmed'
  && reviewedProjection.allEdges.find((edge) => edge.eventId === relationEvents[7].id)?.reviewDecision === 'rejected'
  && !reviewedProjection.allEdges.find((edge) => edge.eventId === relationEvents[6].id)?.pendingReview
  && !reviewedProjection.allEdges.find((edge) => edge.eventId === relationEvents[7].id)?.pendingReview)
const extraEvidence = pj.appendEvidenceToProjectedNode(networkTheme.id, viewpoint.id, {
  text: '合成证据内容 <img src=x onerror=alert(1)>', sourceLabel: '合成来源', url: 'https://example.invalid/data',
  sourcePublishedAt: '2026-09-18', applicability: '2026Q2',
})
ok('补充证据只保存用户输入，并以明确 supports 关系连到所选节点', extraEvidence.length === 2
  && extraEvidence[0].type === 'evidence.appended' && extraEvidence[0].payload.text.includes('<img')
  && extraEvidence[1].type === 'relation.declared' && extraEvidence[1].payload.rel === 'supports'
  && extraEvidence[1].payload.from.eventId === extraEvidence[0].id && extraEvidence[1].payload.to.eventId === viewpoint.id)
ok('手工证据分别保留来源发布时间与适用时间，不伪造抓取时间', extraEvidence[0].payload.sourcePublishedAt === '2026-09-18'
  && extraEvidence[0].payload.applicability === '2026Q2' && !Object.hasOwn(extraEvidence[0].payload, 'sourceFetchedAt'))
const beforeCorrectionSeq = ev.getEvents(networkTheme.id).length
const manualCorrectionInput = {
  newValue: '用户确认修订后的合成观点', reason: '合成来源的适用范围变化', applicability: '2026Q2', requestId: 'fixture-revision-1',
}
const manualCorrection = pj.correctProjectedNode(networkTheme.id, viewpoint.id, manualCorrectionInput)
const afterCorrectionCount = ev.getEvents(networkTheme.id).length
const repeatedManualCorrection = pj.correctProjectedNode(networkTheme.id, viewpoint.id, manualCorrectionInput)
const correctedProjection = pj.getChainProjection(networkTheme.id)
const correctedViewpoint = correctedProjection.allNodes.find((node) => node.id === viewpoint.id)
const priorViewpoint = pj.getChainProjectionAt(networkTheme.id, beforeCorrectionSeq).allNodes.find((node) => node.id === viewpoint.id)
ok('观点修订只追加 correction 事件，保留旧文本并更新适用时间', manualCorrection.type === 'correction.appended'
  && manualCorrection.supersedes === viewpoint.id && correctedViewpoint.currentText === manualCorrectionInput.newValue
  && correctedViewpoint.applicability === '2026Q2' && priorViewpoint.currentText === '用户输入的说明，不是证据'
  && priorViewpoint.applicability === '2026Q1')
ok('相同 requestId 重试返回原更正事件且不追加重复记录', repeatedManualCorrection.replayed === true
  && ev.getEvents(networkTheme.id).length === afterCorrectionCount
  && ev.verifyChain(networkTheme.id).ok)
const beforeRenameSeq = ev.getEvents(networkTheme.id).length
const renamed = pj.renameProjectedNode(networkTheme.id, concept.id, '合成概念新名', '测试追加式改名')
const beforeInvalidateSeq = ev.getEvents(networkTheme.id).length
const invalidation = pj.invalidateProjectedNode(networkTheme.id, eventNodeNew.id, '合成样本不再适用')
const currentNetwork = pj.getChainProjection(networkTheme.id)
const renamedNode = currentNetwork.allNodes.find((node) => node.id === concept.id)
const invalidatedNode = currentNetwork.allNodes.find((node) => node.id === eventNodeNew.id)
ok('改名和失效分别追加事件；旧名历史和失效节点仍留在投影', renamed.type === 'node.renamed'
  && renamed.payload.previousTitle === '合成概念' && invalidation.type === 'node.invalidated'
  && renamedNode.title === '合成概念新名' && renamedNode.nameHistory?.[0]?.previousTitle === '合成概念'
  && invalidatedNode.invalidated && invalidatedNode.invalidationReason === '合成样本不再适用')
const historyBeforeRename = pj.getChainProjectionAt(networkTheme.id, beforeRenameSeq)
const historyBeforeInvalidate = pj.getChainProjectionAt(networkTheme.id, beforeInvalidateSeq)
ok('改名/失效前后历史投影按时点准确保留名称与状态', historyBeforeRename.allNodes.find((node) => node.id === concept.id)?.title === '合成概念'
  && !historyBeforeRename.allNodes.find((node) => node.id === eventNodeNew.id)?.invalidated
  && historyBeforeInvalidate.allNodes.find((node) => node.id === concept.id)?.title === '合成概念新名'
  && !historyBeforeInvalidate.allNodes.find((node) => node.id === eventNodeNew.id)?.invalidated
  && currentNetwork.allNodes.find((node) => node.id === eventNodeNew.id)?.invalidated)
const beforeReadOnlyReplay = JSON.stringify(ev.getEvents(networkTheme.id))
pj.getChainProjectionAt(networkTheme.id, 2)
ok('滑动历史只读回放不会写入或修改事件链', JSON.stringify(ev.getEvents(networkTheme.id)) === beforeReadOnlyReplay)
let invalidationWithoutReasonRejected = false
try { pj.invalidateProjectedNode(networkTheme.id, objectNode.id, '   ') } catch { invalidationWithoutReasonRejected = true }
ok('失效标记要求明确原因', invalidationWithoutReasonRejected && ev.verifyChain(networkTheme.id).ok)
ok('生命周期结束后全账本哈希链仍有效且原声明/决定都保留', ev.verifyChain(networkTheme.id).ok
  && ev.getEvents(networkTheme.id).some((event) => event.id === relationEvents[7].id)
  && ev.getEvents(networkTheme.id).some((event) => event.id === rejected.id))

const sharedRefTheme = store.addTheme('合成重复来源引用')
const sharedRefFirst = ev.appendEvent(sharedRefTheme.id, {
  type: 'node.created', payload: { nodeType: 'concept', title: '第一个旧节点', sourceRef: 'legacy:shared-ref' },
})
const sharedRefSecond = ev.appendEvent(sharedRefTheme.id, {
  type: 'node.created', payload: { nodeType: 'object', title: '第二个旧节点', sourceRef: 'legacy:shared-ref' },
})
pj.renameProjectedNode(sharedRefTheme.id, sharedRefSecond.id, '第二个旧节点新名', '共享来源引用回归')
pj.invalidateProjectedNode(sharedRefTheme.id, sharedRefSecond.id, '共享来源引用失效回归')
const sharedRefNodes = pj.getChainProjection(sharedRefTheme.id).allNodes
ok('共享 legacy sourceRef 下改名/失效仍只作用于 payload 指定的 nodeId', sharedRefNodes.find((node) => node.id === sharedRefFirst.id)?.title === '第一个旧节点'
  && !sharedRefNodes.find((node) => node.id === sharedRefFirst.id)?.invalidated
  && sharedRefNodes.find((node) => node.id === sharedRefSecond.id)?.title === '第二个旧节点新名'
  && sharedRefNodes.find((node) => node.id === sharedRefSecond.id)?.invalidated
  && ev.verifyChain(sharedRefTheme.id).ok)

console.log('\n— 旧 signal 决定投影与有效前缀 —')
const signalTheme = store.addTheme('旧信号审核与回放')
const signalTarget = pj.createProjectedNode(signalTheme.id, {
  nodeType: 'viewpoint', title: '旧信号目标观点', detail: '原始观点内容',
})
const pendingEvidenceSignal = ev.appendEvent(signalTheme.id, {
  id: 'legacy-pending-evidence', type: 'evidence.appended',
  payload: { text: '旧待审证据', targetNodeId: signalTarget.id, pendingReview: true, sourceLabel: '旧来源' },
})
const pendingRelationSignal = ev.appendEvent(signalTheme.id, {
  id: 'legacy-pending-relation', type: 'relation.declared',
  payload: { rel: 'contradicts', from: { eventId: pendingEvidenceSignal.id }, to: { eventId: signalTarget.id }, reviewStatus: 'pending-review' },
})
const beforeSignalReviews = ev.getEvents(signalTheme.id).length
const beforeSignalProjection = pj.getChainProjectionAt(signalTheme.id, beforeSignalReviews)
const originalEvidencePayload = JSON.stringify(ev.getEvents(signalTheme.id).find((event) => event.id === pendingEvidenceSignal.id).payload)
const relationReview = ev.appendEvent(signalTheme.id, {
  id: 'legacy-relation-decision', type: 'signal.reviewed', actor: 'user',
  payload: { signalEventId: pendingRelationSignal.id, decision: 'corrected', reason: '方向标签复核', change: { direction: 'declining', nature: 'epistemic', themeTag: '反例' } },
})
const evidenceReview = ev.appendEvent(signalTheme.id, {
  id: 'legacy-evidence-decision', type: 'signal.reviewed', actor: 'user',
  payload: { signalEventId: pendingEvidenceSignal.id, decision: 'rejected', reason: '来源需复核' },
})
const afterSignalProjection = pj.getChainProjection(signalTheme.id)
const reviewedRelationEdge = afterSignalProjection.allEdges.find((edge) => edge.eventId === pendingRelationSignal.id)
const reviewedEvidenceNode = afterSignalProjection.allNodes.find((node) => node.id === pendingEvidenceSignal.id)
const beforeSignalReviewAgain = pj.getChainProjectionAt(signalTheme.id, beforeSignalReviews)
ok('旧 evidence/relation 信号接受追加决定而不改写源事件', relationReview.payload.signalEventId === pendingRelationSignal.id
  && evidenceReview.payload.signalEventId === pendingEvidenceSignal.id
  && JSON.stringify(ev.getEvents(signalTheme.id).find((event) => event.id === pendingEvidenceSignal.id).payload) === originalEvidencePayload)
ok('signal.reviewed 将 relation 待审状态关闭并保留三层修订及审核 provenance', !reviewedRelationEdge?.pendingReview
  && reviewedRelationEdge?.reviewDecision === 'corrected'
  && reviewedRelationEdge?.reviewChange?.themeTag === '反例'
  && reviewedRelationEdge?.provenanceEventIds.includes(relationReview.id))
ok('被驳回 evidence 保留目标关联、决定与来源可追溯字段', !reviewedEvidenceNode?.pendingReview
  && reviewedEvidenceNode?.reviewDecision === 'rejected'
  && reviewedEvidenceNode?.reviewEventId === evidenceReview.id
  && afterSignalProjection.allNodes.find((node) => node.id === signalTarget.id)?.evidenceCount === 1)
ok('有效前缀回放可回到未判决旧信号，不提前泄露未来决定', beforeSignalProjection.allEdges.find((edge) => edge.eventId === pendingRelationSignal.id)?.pendingReview
  && beforeSignalProjection.allNodes.find((node) => node.id === pendingEvidenceSignal.id)?.pendingReview
  && !beforeSignalProjection.allEdges.find((edge) => edge.eventId === pendingRelationSignal.id)?.reviewDecision
  && !beforeSignalReviewAgain.allNodes.find((node) => node.id === pendingEvidenceSignal.id)?.reviewEventId)
ok('旧信号复核后哈希链完整', ev.verifyChain(signalTheme.id).ok)

/* —— P0-1 / P0-2 / P0-3：出处随事件走、脏 ref 不进门、投影带 refs —— */
const provenanceTheme = store.addTheme('出处保真测试')
pj.mountDraftToEvents(provenanceTheme.id, {
  inboxId: 'inbox-prov-1', inboxTitle: '带来源的收件箱条目', newSegmentName: '有出处的判断',
  evidence: '原文摘录',
  evidenceRefs: [
    { type: 'url', id: 'https://example.com/report?a=1', title: '示例来源' },
    { type: 'url', id: 'javascript:alert(1)', title: '脏 ref' },
  ],
  sourceUrl: 'https://example.com/report?a=1',
  sourceLabel: '示例来源',
  sourcePublishedAt: '2026-09-20',
  sourceFetchedAt: '2026-09-28T02:00:00.000Z',
  ingestedAt: '2026-09-29T03:00:00.000Z',
})
const provenanceEvents = ev.getEvents(provenanceTheme.id)
const mountedEvidence = provenanceEvents.find((e) => e.type === 'evidence.appended')
ok('P0-1 挂载事件自带 URL 与来源元数据（不依赖收件箱条目存活）',
  mountedEvidence?.payload?.sourceUrl === 'https://example.com/report?a=1'
  && mountedEvidence.payload.sourceLabel === '示例来源'
  && mountedEvidence.payload.sourcePublishedAt === '2026-09-20'
  && mountedEvidence.payload.sourceFetchedAt === '2026-09-28T02:00:00.000Z'
  && mountedEvidence.payload.ingestedAt === '2026-09-29T03:00:00.000Z'
  && mountedEvidence.payload.evidenceRefs.some((ref) => ref.type === 'url' && ref.id === 'https://example.com/report?a=1'))
ok('P0-2 脏协议 ref 写不进账本（javascript: 被挡在写入侧）',
  !JSON.stringify(provenanceEvents).includes('javascript:')
  && ev.verifyChain(provenanceTheme.id).ok)
const provenanceProjection = pj.getChainProjection(provenanceTheme.id)
const projectionEvidence = provenanceProjection.allNodes.find((node) => node.nodeType === 'evidence')
ok('P0-3 投影证据节点带 evidenceRefs 与来源（快照/回放不丢出处）',
  projectionEvidence?.evidenceRefs?.some((ref) => ref.type === 'url' && ref.id === 'https://example.com/report?a=1')
  && projectionEvidence.sourceUrl === 'https://example.com/report?a=1'
  && projectionEvidence.sourceLabel === '示例来源')
const protocolTheme = store.addTheme('手工补证协议测试')
const protocolTarget = pj.createProjectedNode(protocolTheme.id, { nodeType: 'viewpoint', title: '手工补证目标' })
const dirtyManual = pj.appendEvidenceToProjectedNode(protocolTheme.id, protocolTarget.id, {
  text: '脏链接证据', url: 'javascript:alert(1)', sourceLabel: '脏来源',
})
const dirtyEvents = ev.getEvents(protocolTheme.id).filter((e) => e.type === 'evidence.appended')
const cleanManual = pj.appendEvidenceToProjectedNode(protocolTheme.id, protocolTarget.id, {
  text: '合法链接证据', url: 'https://example.org/paper', sourceLabel: '合法来源',
})
const cleanEvents = ev.getEvents(protocolTheme.id).filter((e) => e.type === 'evidence.appended')
ok('P0-2 手工补证同样过 http(s) 判定：脏的不产生 url ref，合法的正常入库',
  dirtyManual?.ok !== false && cleanManual?.ok !== false
  && dirtyEvents.length === 1 && dirtyEvents[0].payload.evidenceRefs.length === 0
  && cleanEvents.length === 2
  && cleanEvents[1].payload.evidenceRefs.some((ref) => ref.id === 'https://example.org/paper')
  && ev.verifyChain(protocolTheme.id).ok)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
