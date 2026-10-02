import { deriveReaderModel } from '../src/renderer/views/reader.js'
import { requestBuilderPane, requestBuilderNodeFocus, consumeBuilderJump } from '../src/renderer/lib/chain-ui-model.js'
import { layoutThemeNetwork } from '../src/renderer/lib/theme-network.js'

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? `  ${detail}` : ''}`)
}

const vp = (id, title, extra = {}) => ({ id, nodeType: 'viewpoint', title, archived: false, external: false, createdSeq: 1, eventIds: [], ...extra })
const ev = (id, title) => ({ id, nodeType: 'evidence', title, archived: false, external: false, createdSeq: 1, eventIds: [] })
const edge = (id, from, to, rel, extra = {}) => ({ id, from, to, rel, reviewDecision: null, pendingReview: false, ...extra })

// 1. 空主题：empty，不渲染任何卡片
{
  const model = deriveReaderModel({ nodes: [], edges: [] }, [])
  check('空投影 → empty，不派生任何卡片', model.empty && !model.oneLiner
    && !model.drivers.length && !model.disputes.length && model.status === '尚未开始')
}

// 2. 稀疏主题：1 个孤立观点 → 建设中，无一句话
{
  const model = deriveReaderModel({ nodes: [vp('v1', '光互连是方向')], edges: [] }, [])
  check('孤立单观点 → 无一句话（主链长度 < 2 不生成）', !model.empty && !model.oneLiner && model.status === '建设中')
}

// 3. 一句话阈值：2 个观点 + derives 边 → 主链长度 2，一句话出现
{
  const nodes = [vp('v1', '电互连带宽逼近极限'), vp('v2', '光互连是下一代路径')]
  const edges = [edge('e1', 'v1', 'v2', 'derives', { pendingReview: true })]
  const model = deriveReaderModel({ nodes, edges }, [])
  check('主链长度 ≥ 2 → 一句话为链尾结论', model.oneLiner?.conclusion === '光互连是下一代路径'
    && model.oneLiner.steps === 2, JSON.stringify(model.oneLiner))
  check('derives 边默认待复核 → 下一步卡片有内容', model.pending.length === 1 && model.status === '存在待复核关系')
}

// 4. 驱动阈值：被引用的概念 ≥ 2 个才出卡片
{
  const nodes = [vp('v1', '判断'), { id: 'c1', nodeType: 'concept', title: '带宽密度', archived: false, external: false, createdSeq: 1, eventIds: [] }]
  const edges = [edge('e1', 'c1', 'v1', 'supports')]
  const sparse = deriveReaderModel({ nodes, edges }, [])
  check('只有 1 个被引用概念 → 驱动卡不渲染', sparse.drivers.length === 0)
  nodes.push({ id: 'c2', nodeType: 'concept', title: '良率', archived: false, external: false, createdSeq: 1, eventIds: [] })
  edges.push(edge('e2', 'c2', 'v1', 'supports'))
  const rich = deriveReaderModel({ nodes, edges }, [])
  check('2 个被引用概念 → 驱动卡出现', rich.drivers.length === 2)
}

// 5. 争议：contradicts 边 → 争议卡 + 状态
{
  const nodes = [vp('v1', 'A 判断'), vp('v2', 'B 判断')]
  const edges = [edge('e1', 'v2', 'v1', 'contradicts')]
  const model = deriveReaderModel({ nodes, edges }, [])
  check('contradicts 边 → 争议焦点出现，状态为存在争议', model.disputes.length === 1 && model.status === '存在争议')
}

// 6. 边界：depends-on 边 → 边界条件卡
{
  const nodes = [vp('v1', '放量判断'), { id: 'o1', nodeType: 'object', title: 'PhotonLink', archived: false, external: false, createdSeq: 1, eventIds: [] }]
  const edges = [edge('e1', 'v1', 'o1', 'depends-on')]
  const model = deriveReaderModel({ nodes, edges }, [])
  check('depends-on 边 → 边界条件卡出现', model.boundaries.length === 1 && model.boundaries[0].from === '放量判断')
}

// 7. 演变：改名节点 → 关键演变卡
{
  const nodes = [vp('v1', '新名', { originalTitle: '旧名' })]
  const model = deriveReaderModel({ nodes, edges: [] }, [])
  check('有旧名的节点 → 关键演变卡出现', model.evolutions.length === 1 && model.evolutions[0].from === '旧名')
}

// 8. 驳回的边不计入任何卡片
{
  const nodes = [vp('v1', 'A'), vp('v2', 'B')]
  const edges = [edge('e1', 'v2', 'v1', 'contradicts', { reviewDecision: 'rejected' })]
  const model = deriveReaderModel({ nodes, edges }, [])
  check('已驳回的 contradicts 边不计入争议', model.disputes.length === 0)
}

// 9. 读者 → 建设者跳转请求往返
{
  requestBuilderPane('t1', 'attribution')
  requestBuilderNodeFocus('t1', 'v9')
  const jump = consumeBuilderJump('t1')
  check('跳转请求携带子页签与聚焦节点', jump?.pane === 'attribution' && jump?.nodeId === 'v9')
  check('消费后不再重复触发', consumeBuilderJump('t1') === null)
  requestBuilderPane('t1', 'nope')
  check('非法子页签被拒绝', consumeBuilderJump('t1') === null)
}

// 10. BFS 布局：相连节点初始靠近，平均边长显著缩短（结构化主题图）
{
  const nodes = []
  const edges = []
  // 主链：12 个观点依次推导
  for (let i = 0; i < 12; i++) nodes.push({ id: `v${i}`, nodeType: 'viewpoint', title: `观点${i}` })
  for (let i = 0; i < 11; i++) edges.push({ id: `d${i}`, from: `v${i}`, to: `v${i + 1}`, rel: 'derives', pendingReview: false })
  // 每个观点挂 1 条证据
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: `e${i}`, nodeType: 'evidence', title: `证据${i}` })
    edges.push({ id: `s${i}`, from: `e${i}`, to: `v${i}`, rel: 'supports', pendingReview: false })
  }
  // 2 个概念被多个观点引用 + 1 条反驳
  nodes.push({ id: 'c1', nodeType: 'concept', title: '概念甲' }, { id: 'c2', nodeType: 'concept', title: '概念乙' })
  edges.push({ id: 'r1', from: 'c1', to: 'v3', rel: 'supports', pendingReview: false })
  edges.push({ id: 'r2', from: 'c1', to: 'v7', rel: 'supports', pendingReview: false })
  edges.push({ id: 'r3', from: 'c2', to: 'v5', rel: 'supports', pendingReview: false })
  edges.push({ id: 'x1', from: 'v9', to: 'v2', rel: 'contradicts', pendingReview: false })
  const layout = layoutThemeNetwork(nodes, edges, 1120)
  let total = 0
  let count = 0
  for (const e of edges) {
    const a = layout.pos.get(e.from)
    const b = layout.pos.get(e.to)
    if (!a || !b) continue
    total += Math.hypot(a.x - b.x, a.y - b.y)
    count++
  }
  const avg = total / Math.max(1, count)
  check('27 节点结构化主题平均边长 < 250px', avg < 250, `平均 ${Math.round(avg)}px`)
}

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
