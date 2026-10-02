import { deriveReaderModel, estimateReadSeconds } from '../src/renderer/lib/reader-model.js'

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

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
