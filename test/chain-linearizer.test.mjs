/**
 * 链线性化器测试（纯函数，无 DOM）。
 * 运行：node test/chain-linearizer.test.mjs
 */
import {
  buildDag, findMainPath, assignLevels, findSiblings,
  buildChain, extractStanceCandidates, collectClashes, linearize,
} from '../src/renderer/lib/chain-linearizer.js'

let pass = 0
let fail = 0
function ok(name, condition, extra = '') {
  condition ? pass++ : fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${extra ? `  ${extra}` : ''}`)
}

const N = (id, kind, seq, title) => ({ id, kind, title: title || id, createdSeq: seq })
const E = (id, rel, from, to, extra = {}) => ({ id, rel, from, to, ...extra })
const stepIds = (chain) => chain.steps.map((s) => s.nodes.map((n) => n.id))

/* ---- 1. 空投影 ---- */
{
  const r = linearize({ nodes: [], edges: [] })
  ok('空投影：无链', r.chains.length === 0)
  ok('空投影：无待接入', r.unplaced.length === 0)
  ok('空投影：无交锋', r.clashes.length === 0)
}

/* ---- 2. 线性链 A→B→C（derives） ---- */
const linear = {
  nodes: [N('A', 'claim', 1), N('B', 'claim', 2), N('C', 'claim', 3)],
  edges: [E('e1', 'derives', 'A', 'B'), E('e2', 'derives', 'B', 'C', { pendingReview: true })],
}
{
  const r = linearize(linear)
  ok('线性链：一条主链', r.chains.length === 1 && r.chains[0].kind === 'main')
  const ids = stepIds(r.chains[0])
  ok('线性链：顺序 A→B→C', JSON.stringify(ids) === JSON.stringify([['A'], ['B'], ['C']]), JSON.stringify(ids))
  ok('线性链：连接词为推导', r.chains[0].steps[0].connector === '推导' && r.chains[0].steps[1].connector === '推导')
  ok('线性链：末步无连接词', r.chains[0].steps[2].connector === null)
  ok('线性链：待复核边被标注', r.chains[0].steps[1].pendingReview === true)
  ok('线性链：无待接入', r.unplaced.length === 0)
}

/* ---- 3. 同级节点 b1→[b2|b3|b4]→b5 ---- */
const siblings = {
  nodes: [N('b1', 'claim', 1), N('b2', 'claim', 2), N('b3', 'claim', 3), N('b4', 'claim', 4), N('b5', 'claim', 5)],
  edges: [
    E('e1', 'supports', 'b1', 'b2'), E('e2', 'supports', 'b1', 'b3'), E('e3', 'supports', 'b1', 'b4'),
    E('e4', 'supports', 'b2', 'b5'), E('e5', 'supports', 'b3', 'b5'), E('e6', 'supports', 'b4', 'b5'),
  ],
}
{
  const dag = buildDag(siblings)
  const levels = assignLevels(dag)
  ok('同级：b2/b3/b4 同层', levels.get('b2') === 1 && levels.get('b3') === 1 && levels.get('b4') === 1)
  const sibs = findSiblings(dag, levels, dag.nodes.get('b2')).map((n) => n.id)
  ok('同级：b2 的同级是 b3,b4', JSON.stringify(sibs) === JSON.stringify(['b3', 'b4']), JSON.stringify(sibs))
  const r = linearize(siblings)
  const ids = stepIds(r.chains[0])
  ok('同级：三步', r.chains[0].steps.length === 3, JSON.stringify(ids))
  ok('同级：第二步三节点', JSON.stringify(ids[1]) === JSON.stringify(['b2', 'b3', 'b4']), JSON.stringify(ids))
  ok('同级：连接词为共同支撑', r.chains[0].steps[1].connector === '共同支撑')
  ok('同级：第一步连接词为支撑', r.chains[0].steps[0].connector === '支撑')
}

/* ---- 4. contradicts 不进主轴，形成候选链与交锋点 ---- */
{
  const proj = {
    nodes: [...linear.nodes, N('X', 'claim', 4, '对立观点')],
    edges: [...linear.edges, E('e9', 'contradicts', 'X', 'C')],
  }
  const r = linearize(proj)
  ok('对立：两条链', r.chains.length === 2, `${r.chains.length}`)
  ok('对立：第二条为候选', r.chains[1].kind === 'stance-candidate' && r.chains[1].stance === null)
  ok('对立：候选链含 X', r.chains[1].steps.some((s) => s.nodes.some((n) => n.id === 'X')))
  ok('对立：主链仍为 A→B→C', JSON.stringify(stepIds(r.chains[0])) === JSON.stringify([['A'], ['B'], ['C']]))
  ok('对立：交锋点 1 个', r.clashes.length === 1, `${r.clashes.length}`)
  ok('对立：交锋点连两条链', r.clashes[0].fromChainId !== r.clashes[0].toChainId)
}

/* ---- 5. 证据挂载到 step，不进主轴 ---- */
{
  const proj = {
    nodes: [...linear.nodes, N('ev1', 'evidence', 5, '证据一')],
    edges: [...linear.edges, E('e8', 'supports', 'ev1', 'B')],
  }
  const r = linearize(proj)
  ok('证据：主轴仍 3 步', r.chains[0].steps.length === 3)
  const evIds = r.chains[0].steps[1].evidence.map((n) => n.id)
  ok('证据：挂在 B 所在步', JSON.stringify(evIds) === JSON.stringify(['ev1']), JSON.stringify(evIds))
  ok('证据：不在待接入', r.unplaced.length === 0)
}

/* ---- 6. rejected 的边排除 ---- */
{
  const proj = {
    nodes: [N('A', 'claim', 1), N('B', 'claim', 2), N('C', 'claim', 3)],
    edges: [
      E('e1', 'derives', 'A', 'B', { reviewDecision: 'rejected' }),
      E('e2', 'derives', 'B', 'C'),
    ],
  }
  const r = linearize(proj)
  ok('驳回：主链为 B→C', JSON.stringify(stepIds(r.chains[0])) === JSON.stringify([['B'], ['C']]), JSON.stringify(stepIds(r.chains[0])))
  ok('驳回：A 待接入（无边）', r.unplaced.length === 1 && r.unplaced[0].node.id === 'A' && r.unplaced[0].reason === 'no-path')
}

/* ---- 7. 环不死循环 ---- */
{
  const proj = {
    nodes: [N('A', 'claim', 1), N('B', 'claim', 2), N('C', 'claim', 3)],
    edges: [E('e1', 'derives', 'A', 'B'), E('e2', 'derives', 'B', 'C'), E('e3', 'derives', 'C', 'A')],
  }
  const t0 = Date.now()
  const r = linearize(proj)
  ok('环：终止', Date.now() - t0 < 2000)
  ok('环：主链 3 步无重复', r.chains[0].steps.length === 3)
}

/* ---- 8. 归档节点排除 ---- */
{
  const proj = {
    nodes: [...linear.nodes, { ...N('D', 'claim', 4), archived: true }],
    edges: [...linear.edges, E('e7', 'supports', 'D', 'C')],
  }
  const r = linearize(proj)
  const allIds = r.chains.flatMap((c) => c.steps.flatMap((s) => s.nodes.map((n) => n.id)))
  ok('归档：D 不在链上', !allIds.includes('D'))
  ok('归档：D 不在待接入', !r.unplaced.some((u) => u.node.id === 'D'))
}

/* ---- 9. 主链标题可覆盖（主题无关） ---- */
{
  const r = linearize(linear, { mainTitle: '光互连 · 景气度建模' })
  ok('标题：调用方覆盖', r.chains[0].title === '光互连 · 景气度建模')
}

/* ---- 10. 平行分支进待接入 ---- */
{
  const proj = {
    nodes: [...linear.nodes, N('P', 'claim', 4, '侧支前提'), N('Q', 'claim', 5, '侧支')],
    edges: [...linear.edges, E('e6', 'supports', 'P', 'Q'), E('e7', 'supports', 'Q', 'B')],
  }
  const r = linearize(proj)
  const p = r.unplaced.find((x) => x.node.id === 'P')
  const q = r.unplaced.find((x) => x.node.id === 'Q')
  ok('分支：P、Q 待接入', !!p && !!q, r.unplaced.map((x) => x.node.id).join(','))
  ok('分支：原因为平行分支', p && p.reason === 'parallel-branch' && q && q.reason === 'parallel-branch')
  ok('分支：主链仍为 A→B→C', JSON.stringify(stepIds(r.chains[0])) === JSON.stringify([['A'], ['B'], ['C']]))
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
