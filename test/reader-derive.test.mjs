import {
  deriveReaderModel, estimateReadSeconds, filterReaderNodes, buildSynthesisAxis, buildArgumentOutline,
  strengthSparkline, buildGapList, buildDebateBoard, buildChronicle, parseApplicabilityEnd, UNCATEGORIZED_LABEL,
} from '../src/renderer/lib/reader-model.js'

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? `  ${detail}` : ''}`)
}
const vp = (id, title, extra = {}) => ({ id, nodeType: 'viewpoint', title, archived: false, external: false, createdSeq: 1, eventIds: [], ...extra })
const ev = (id, type, payload, at = '2026-10-01T12:00:00.000Z') => ({ id, type, payload, at, seq: 2 })
const edge = (id, from, to, rel, extra = {}) => ({ id, from, to, rel, reviewDecision: null, pendingReview: false, ...extra })
const now = Date.parse('2026-10-02T12:00:00.000Z')

{
  const nodes = [
    vp('pending', '待复核观点'),
    vp('verified', '已确认观点', { status: 'verified' }),
    vp('disputed', '有反驳观点', { status: 'disputed' }),
    vp('archived', '归档观点', { archived: true }),
    { id: 'evidence', nodeType: 'evidence', title: '一手数据' },
  ]
  const originalIds = nodes.map((node) => node.id).join()
  check('Reader 图过滤在纯模型中按五类类型和生命周期状态工作', filterReaderNodes(nodes, 'viewpoint', 'disputed').map((node) => node.id).join() === 'disputed'
    && filterReaderNodes(nodes, 'evidence', 'all').map((node) => node.id).join() === 'evidence'
    && filterReaderNodes(nodes, 'all', 'archived').map((node) => node.id).join() === 'archived')
  check('Reader 过滤只改变可见帧，不改写完整主题节点列表', nodes.map((node) => node.id).join() === originalIds
    && filterReaderNodes(nodes, 'all', 'all').length === nodes.length)
  /* 分类筛选来自 L2 主题自定义层：按用户自己的词筛，没有分类的原子归入"未分类"。 */
  const categorized = [
    { id: 'tech', nodeType: 'viewpoint', title: '技术路线', atomCategory: '技术路线' },
    { id: 'biz', nodeType: 'viewpoint', title: '商业模式', atomCategory: '商业模式' },
    { id: 'old', nodeType: 'viewpoint', title: '早先建的原子' },
  ]
  check('Reader 分类筛选按主题自定义词表工作，未分类单独一档',
    filterReaderNodes(categorized, 'all', 'all', '技术路线').map((node) => node.id).join() === 'tech'
    && filterReaderNodes(categorized, 'all', 'all', UNCATEGORIZED_LABEL).map((node) => node.id).join() === 'old'
    && filterReaderNodes(categorized, 'all', 'all').length === 3)
}

{
  const model = deriveReaderModel({ nodes: [], edges: [] }, [], { now })
  check('空投影保持真实空状态', model.empty && model.status === '尚未开始' && model.directionCounts.improving === 0)
  check('空状态无阅读时长', estimateReadSeconds(model) === 0)
}
{
  const model = deriveReaderModel({ nodes: [vp('v1', '单一观点', { confidence: 63 })], edges: [] }, [], { now })
  const node = model.nodesByDirection.undetermined[0]
  check('普通投影中的置信度按 0–100 百分比读取，不二次乘 100', node?.confidence === 63)
  check('无趋势证据的稀疏主题保持待观察，不合成稳定结论', model.status === '方向待观察'
    && !model.oneLiner && model.directionCounts.undetermined === 1)
  check('读时长来自实时节点数而非 demo 固定文本', estimateReadSeconds(model) === 30)
}
{
  const nodes = [vp('v1', '关键判断 A', { confidence: 75 }), vp('v2', '关键判断 B', { confidence: 42 }), vp('v3', '稳定判断 C')]
  const events = [ev('confidence-1', 'confidence.updated', {
    nodeId: 'v1', oldConfidence: 60, newConfidence: 75, strength: 0.5, change: { nature: 'quantitative', themeTag: '订单能见度' },
  })]
  const model = deriveReaderModel({ nodes, edges: [] }, events, { now })
  const improving = model.nodesByDirection.improving[0]
  check('置信度变化按百分点参与方向提炼', improving?.id === 'v1' && improving.confidence === 75)
  check('事件序列进入对应观点的演化卡片', improving?.evolution[0]?.eventId === 'confidence-1'
    && improving.evolution[0]?.direction === 'improving' && improving.evolution[0]?.text.includes('60% → 75%'))
  check('明显置信度变化成为最近拐点', model.turningPoints[0]?.nodeIds.includes('v1')
    && model.turningPoints[0]?.text.includes('15 个百分点'))
  check('拐点数量变化会增加动态阅读时长', estimateReadSeconds(model) > 30)
}
{
  const nodes = [vp('v1', '观点 A'), vp('v2', '反向观点 B')]
  const edges = [edge('e1', 'v2', 'v1', 'contradicts')]
  const model = deriveReaderModel({ nodes, edges }, [], { now })
  check('反驳关系保留为关系，不自动推断节点趋势', model.nodesByDirection.undetermined.some((node) => node.id === 'v1'))
  check('没有人工综合解释时不生成主题整体方向结论', model.oneLiner == null)
  const rejected = deriveReaderModel({ nodes, edges: [edge('rejected', 'v2', 'v1', 'contradicts', { reviewDecision: 'rejected' })] }, [], { now })
  check('已驳回关系不推导节点方向', rejected.nodesByDirection.undetermined.some((node) => node.id === 'v1'))
}
{
  const nodes = [vp('v1', '观点 A'), vp('v2', '观点 B'), vp('v3', '观点 C')]
  const edges = [
    edge('s1', 'e1', 'v1', 'supports'), edge('s2', 'e2', 'v1', 'supports'),
    edge('s3', 'e3', 'v2', 'supports'), edge('c1', 'e4', 'v3', 'contradicts'),
  ]
  const model = deriveReaderModel({ nodes, edges }, [], { now })
  check('支持边占多数也不宣称主题整体向好', model.oneLiner == null && model.directionCounts.improving === 0)
}
{
  const events = [ev('old-confidence', 'confidence.updated', { nodeId: 'v1', oldConfidence: 30, newConfidence: 80 }, '2026-08-01T12:00:00.000Z')]
  const model = deriveReaderModel({ nodes: [vp('v1', '旧变化观点', { confidence: 80 })], edges: [] }, events, { now })
  check('30 天外变化保留在历史序列但不伪装成最近拐点', model.turningPoints.length === 0
    && model.nodesByDirection.undetermined[0]?.evolution[0]?.eventId === 'old-confidence')
}

{
  /* 合成轴（设计提案 01）：强度线 × 外部数据点 × 确认/修订台阶，同一条真实日期轴。 */
  const axisEvents = [
    { id: 'a1', type: 'evidence.appended', at: '2026-09-20T00:00:00.000Z', payload: { text: '第一条外部数据' } },
    { id: 'a2', type: 'relation.declared', at: '2026-09-21T00:00:00.000Z', payload: { rel: 'supports', from: { eventId: 'a1' }, to: { eventId: 'v1' } } },
    { id: 'a3', type: 'evidence.appended', at: '2026-09-22T00:00:00.000Z', payload: { text: '第二条外部数据' } },
    { id: 'a4', type: 'relation.declared', at: '2026-09-22T00:00:00.000Z', payload: { rel: 'contradicts', from: { eventId: 'a3' }, to: { eventId: 'v1' } } },
    { id: 'a5', type: 'confidence.updated', at: '2026-09-23T00:00:00.000Z', payload: { nodeId: 'v1', newConfidence: 67 } },
    { id: 'a6', type: 'signal.reviewed', at: '2026-09-24T00:00:00.000Z', payload: { decision: 'accepted' } },
    { id: 'a7', type: 'relation.declared', at: '2026-09-25T00:00:00.000Z', payload: { rel: 'supersedes', from: { eventId: 'a3' }, to: { eventId: 'v1' } } },
  ]
  const axisNode = { id: 'v1', confidence: 67, confidenceHistory: [{ at: '2026-09-23T00:00:00.000Z', oldConfidence: 62, newConfidence: 67, reason: '支持证据' }] }
  const axis = buildSynthesisAxis({ events: axisEvents, node: axisNode })
  check('合成轴把外部数据点按支持/挑战/未表态分色，并落在同一条日期轴上',
    axis.counts.evidence === 2 && axis.counts.supports === 1 && axis.counts.contradicts === 1 && axis.counts.unstated === 0
    && axis.evidence[0].t === 0 && axis.evidence[1].t > 0)
  check('合成轴强度线来自该原子的 confidence 历史，台阶含确认与修订',
    axis.series.length === 1 && axis.series[0].value === 67
    && axis.steps.map((step) => step.label).join() === '确认归因,版本修订'
    && axis.counts.steps === 2)
  const flat = buildSynthesisAxis({ events: axisEvents.slice(0, 3), node: { id: 'v1', confidence: null, confidenceHistory: [] } })
  check('没有强度记录时不编造曲线（只用轨道显示外部数据累积）',
    flat.series.length === 0 && flat.evidence.length === 2 && flat.start === Date.parse('2026-09-20T00:00:00.000Z'))
  const empty = buildSynthesisAxis({})
  check('空账本合成轴保持真实空状态', empty.evidence.length === 0 && empty.series.length === 0 && empty.start === null && empty.end === null)
}

{
  /* R1 论证大纲 / R2 sparkline 的纯模型（图以外的有序结构：读得完、比得了量）。 */
  const evidenceNode = (id, title, extra = {}) => ({
    id, nodeType: 'evidence', kind: 'evidence', title, currentText: title, status: 'pending', archived: false,
    evidenceRefs: [{ type: 'url', id: 'https://example.test/a', title: '来源' }],
    sourceLabel: '来源', sourcePublishedAt: '2026-09-20', applicability: '2026Q3', ...extra,
  })
  const atom = { id: 'v1', nodeType: 'viewpoint', title: '结论原子', confidence: 71, archived: false, atomCategory: '技术路线' }
  const byId = {
    v1: atom,
    e1: evidenceNode('e1', '支持数据'),
    e2: evidenceNode('e2', '挑战数据'),
    e3: evidenceNode('e3', '未表态数据', { evidenceRefs: [], sourceLabel: null, sourcePublishedAt: null, applicability: null }),
  }
  const evidenceFor = (id) => (id === 'v1'
    ? { supports: [{ source: byId.e1 }], against: [{ source: byId.e2 }], unclassified: [{ source: byId.e3 }], both: [] }
    : null)
  const outline = buildArgumentOutline([atom, byId.e1, byId.e2, byId.e3], evidenceFor)
  check('R1 大纲按支持/挑战/未表态分组，并带上出处（URL 只在 http(s) 时给）',
    outline.length === 1 && outline[0].counts.supports === 1 && outline[0].counts.against === 1 && outline[0].counts.unclassified === 1
    && outline[0].supports[0].url === 'https://example.test/a' && outline[0].supports[0].sourceLabel === '来源'
    && outline[0].supports[0].applicability === '2026Q3' && outline[0].unclassified[0].url === null)
  check('R1 大纲不算证据节点自身，缺强度时是 null 而不是 0%',
    buildArgumentOutline([atom, byId.e1, byId.e2, byId.e3], evidenceFor).length === 1
    && buildArgumentOutline([{ id: 'v2', nodeType: 'viewpoint', title: '无强度原子', confidence: null }], () => null)[0].strength === null
    && buildArgumentOutline([{ id: 'v3', nodeType: 'viewpoint', title: '归档原子', archived: true }], () => null).length === 0)
  const spark = strengthSparkline({ confidenceHistory: [{ newConfidence: 62 }, { newConfidence: 71 }] })
  /* R5 缺口清单：四类缺口都来自既有事实，且过期判定只认能解析的适用时间。 */
  check('R5 适用时间只认可解析的写法（季度/月/日/年）',
    parseApplicabilityEnd('2026Q3') === Date.UTC(2026, 9, 0, 23, 59, 59)
    && parseApplicabilityEnd('2026-08') === Date.UTC(2026, 8, 0, 23, 59, 59)
    && parseApplicabilityEnd('2026-08-15') === Date.UTC(2026, 7, 15, 23, 59, 59)
    && parseApplicabilityEnd('2026') === Date.UTC(2026, 11, 31, 23, 59, 59)
    && parseApplicabilityEnd('随便写的') === null && parseApplicabilityEnd('') === null)
  const gapNodes = [
    { id: 'v1', nodeType: 'viewpoint', title: '有证据原子', evidenceNodeIds: ['e1'], evidenceCount: 1 },
    { id: 'v2', nodeType: 'viewpoint', title: '无证据原子', evidenceCount: 0 },
    { id: 'e1', nodeType: 'evidence', title: '过期数据', applicability: '2020Q1', targetNodeIds: ['v1'], pendingReview: false },
    { id: 'e2', nodeType: 'evidence', title: '待复核数据', applicability: '2099', targetNodeIds: ['v1'], pendingReview: true },
  ]
  const gaps = buildGapList({
    nodes: gapNodes,
    inboxItems: [
      { id: 'i1', status: 'pending', title: '未归位条目' },
      { id: 'i2', status: 'pending', title: '已归位条目', extractedThemeId: 't1' },
      { id: 'i3', status: 'pending', title: '读者自己记的待办', kind: 'todo' },
      { id: 'i4', status: 'rejected', title: '已裁决条目' },
    ],
    now: Date.parse('2026-10-03T00:00:00.000Z'),
  })
  check('R5 缺口清单覆盖缺外部数据 / 待复核 / 已过期 / 未归位，且不误报',
    gaps.filter((gap) => gap.kind === 'no-evidence').length === 1
    && gaps.filter((gap) => gap.kind === 'pending-review').length === 1
    && gaps.filter((gap) => gap.kind === 'expired-evidence').map((gap) => gap.title).join() === '过期数据'
    && gaps.filter((gap) => gap.kind === 'unassigned-inbox').length === 1
    && gaps.every((gap) => gap.todo && gap.detail))
  check('R5 每条缺口都给出可执行的待办文案',
    gaps.find((gap) => gap.kind === 'no-evidence').todo === '为「无证据原子」补一条外部数据'
    && gaps.find((gap) => gap.kind === 'expired-evidence').todo.includes('更新'))

  /* R3 双边清单 / R4 编年史：并排读争议、按时间读来源 */
  const debateNodes = [
    { id: 'd1', nodeType: 'viewpoint', title: '两边都有的原子', confidence: 71, archived: false },
    { id: 'd2', nodeType: 'viewpoint', title: '只有支持的原子', confidence: null, archived: false },
    { id: 'd3', nodeType: 'viewpoint', title: '没有表态的原子', confidence: null, archived: false },
    { id: 'd1e1', nodeType: 'evidence', title: '支持数据', sourceLabel: '来源甲' },
    { id: 'd1e2', nodeType: 'evidence', title: '挑战数据', sourceLabel: null },
    { id: 'd2e1', nodeType: 'evidence', title: '支持数据二', sourceLabel: '来源乙' },
  ]
  const summaryFor = (id) => ({
    d1: { supports: [{ source: debateNodes[3] }], against: [{ source: debateNodes[4] }] },
    d2: { supports: [{ source: debateNodes[5] }], against: [] },
    d3: { supports: [], against: [] },
  }[id] || null)
  const board = buildDebateBoard(debateNodes, summaryFor)
  check('R3 双边清单只列有表态的原子，争议行优先，并带当前强度',
    board.map((row) => row.id).join() === 'd1,d2'
    && board[0].contested === true && board[0].supports.length === 1 && board[0].against.length === 1
    && board[0].strength === 71 && board[1].strength === null
    && board[0].supports[0].sourceLabel === '来源甲')
  const chronicleEvents = [
    { id: 'ce1', type: 'evidence.appended', at: '2026-09-20T00:00:00.000Z', payload: { text: '第一条外部数据' } },
    { id: 'cr1', type: 'relation.declared', at: '2026-09-20T01:00:00.000Z', payload: { rel: 'supports', from: { eventId: 'ce1' }, to: { eventId: 'd1' } } },
    { id: 'cc1', type: 'confidence.updated', at: '2026-09-20T01:00:01.000Z', payload: { evidenceEventId: 'ce1', oldConfidence: 62, newConfidence: 67 } },
    { id: 'ce2', type: 'evidence.appended', at: '2026-09-25T00:00:00.000Z', payload: { text: '第二条外部数据' } },
  ]
  const chronicleNodes = [{ id: 'd1', nodeType: 'viewpoint', title: '结论原子' }, { id: 'ce1', nodeType: 'evidence', title: '第一条外部数据', targetNodeIds: ['d1'], sourceLabel: 'Yole' }]
  const chronicle = buildChronicle({ events: chronicleEvents, nodes: chronicleNodes })
  check('R4 编年史按时间倒序列出每条外部数据，并带来源、归入原子、立场与强度变化',
    chronicle.length === 2 && chronicle[0].date === '2026-09-25' && chronicle[1].date === '2026-09-20'
    && chronicle[1].sourceLabel === 'Yole' && chronicle[1].atomTitles.join() === '结论原子'
    && chronicle[1].stance === 'supports' && chronicle[1].strengthChange === '62% → 67%'
    && chronicle[0].strengthChange === null && chronicle[0].stance === 'unstated')

  check('R2 sparkline 由 confidence 历史算折线点，单点或空历史不画线',
    spark.enough && spark.min === 62 && spark.max === 71 && spark.points.split(' ').length === 2
    && strengthSparkline({ confidenceHistory: [{ newConfidence: 62 }] }).enough === false
    && strengthSparkline({}).enough === false && strengthSparkline({ confidenceHistory: [] }).points === '')
}

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
