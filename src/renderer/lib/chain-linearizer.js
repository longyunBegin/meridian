/**
 * 链线性化器（纯函数，无 DOM 依赖）
 *
 * 输入：chain-projector 产出的只读投影 { nodes, edges }
 *   - node: { id, kind: 'claim'|'inference'|'evidence'|..., title, createdSeq, archived, external }
 *   - edge: { id, rel: 'supports'|'derives'|'contradicts', from, to, pendingReview, reviewDecision }
 * 输出：{ chains: Chain[], unplaced: Unplaced[], clashes: Clash[] }
 *
 * Chain = { id, kind: 'main'|'stance-candidate', stance: null,
 *           title, steps: Step[] }
 * Step  = { nodes: Node[]（同级）, evidence: Node[]（收起挂载）,
 *           connector: string|null（本步 → 下一步的连接词）,
 *           pendingReview: boolean }
 * Unplaced = { node, reason: 'parallel-branch'|'no-path' }
 * Clash = { edgeId, fromChainId, fromStepIndex, toChainId, toStepIndex, pendingReview }
 *
 * 约定（与 projector 一致）：边 from → to 表示 from 支撑/推导 to。
 * 主轴只取 claim/inference；evidence 收起挂在所属 step 下，不进主轴；
 * contradicts 不进主轴，用于交锋点与对立候选链。
 * 不读事件、不写账本；公理1 安全。
 */

const REL_WEIGHT = { derives: 2, supports: 1 }
const CONNECTOR_WORD = { derives: '推导', supports: '支撑' }

const isBackbone = (n) => !!n && (n.kind === 'claim' || n.kind === 'inference')
const isEvidence = (n) => !!n && n.kind === 'evidence'
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

function cmpArr(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const bySeq = (a, b) => (num(a.createdSeq) - num(b.createdSeq)) || byId(String(a.id), String(b.id))

/** 只用 supports/derives 建 DAG；rejected 的边排除，待复核保留（标注）。 */
export function buildDag(projection) {
  const nodes = new Map()
  for (const n of (projection && projection.nodes) || []) {
    if (!n || !n.id || n.archived || n.external) continue
    nodes.set(n.id, n)
  }
  const out = new Map()
  const incon = new Map()
  for (const id of nodes.keys()) { out.set(id, []); incon.set(id, []) }
  for (const e of (projection && projection.edges) || []) {
    if (!e || !e.from || !e.to || e.from === e.to) continue
    if (e.reviewDecision === 'rejected') continue
    if (e.rel !== 'supports' && e.rel !== 'derives') continue
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue
    out.get(e.from).push({ to: e.to, rel: e.rel, edge: e })
    incon.get(e.to).push({ from: e.from, rel: e.rel, edge: e })
  }
  return { nodes, out, incon }
}

const backboneOutCount = (dag, id) =>
  dag.out.get(id).filter((x) => isBackbone(dag.nodes.get(x.to))).length
const backboneInCount = (dag, id) =>
  dag.incon.get(id).filter((x) => isBackbone(dag.nodes.get(x.from))).length

/**
 * 主链 = 最重路径。终点取"最像结论"的节点（主干出边最少；
 * 平局看主干入边多、创建时间晚），再沿最强入边回溯。
 * derives 优先于 supports；环用 seen 截断，保证终止。
 */
export function findMainPath(dag) {
  const backbone = [...dag.nodes.values()].filter(isBackbone)
  if (!backbone.length) return []
  const endKey = (x) => [backboneOutCount(dag, x.id), -backboneInCount(dag, x.id), -num(x.createdSeq), String(x.id)]
  let end = backbone[0]
  for (const n of backbone) {
    if (cmpArr(endKey(n), endKey(end)) < 0) end = n
  }
  const path = [end]
  const seen = new Set([end.id])
  let cur = end
  for (;;) {
    const cands = dag.incon.get(cur.id)
      .filter((x) => isBackbone(dag.nodes.get(x.from)) && !seen.has(x.from))
      .sort((a, b) =>
        ((REL_WEIGHT[b.rel] || 0) - (REL_WEIGHT[a.rel] || 0)) ||
        (num(dag.nodes.get(a.from).createdSeq) - num(dag.nodes.get(b.from).createdSeq)) ||
        byId(a.from, b.from))
    if (!cands.length) break
    cur = dag.nodes.get(cands[0].from)
    seen.add(cur.id)
    path.unshift(cur)
  }
  return path
}

/** 最长路径分层：level(n) = 0（无主干入边）或 1 + max(level(前提))。环截断。 */
export function assignLevels(dag) {
  const level = new Map()
  const visit = (id, stack) => {
    if (level.has(id)) return level.get(id)
    if (stack.has(id)) return 0
    stack.add(id)
    let lv = 0
    for (const x of dag.incon.get(id)) {
      if (!isBackbone(dag.nodes.get(x.from))) continue
      lv = Math.max(lv, visit(x.from, stack) + 1)
    }
    stack.delete(id)
    level.set(id, lv)
    return lv
  }
  for (const n of dag.nodes.values()) if (isBackbone(n)) visit(n.id, new Set())
  return level
}

function reaches(dag, fromId, toId) {
  if (fromId === toId) return true
  const seen = new Set([fromId])
  const q = [fromId]
  while (q.length) {
    const cur = q.pop()
    for (const x of dag.out.get(cur) || []) {
      if (!isBackbone(dag.nodes.get(x.to))) continue
      if (x.to === toId) return true
      if (!seen.has(x.to)) { seen.add(x.to); q.push(x.to) }
    }
  }
  return false
}

/**
 * 同级节点：与 pathNode 同 level、互不可达、共享至少一个主干直接后继。
 * 即"同一级、用不同论据支撑同一点"的节点（如 b2|b3|b4 → b5）。
 */
export function findSiblings(dag, levels, pathNode) {
  const succ = new Set(
    dag.out.get(pathNode.id)
      .filter((x) => isBackbone(dag.nodes.get(x.to)))
      .map((x) => x.to))
  if (!succ.size) return []
  const lv = levels.get(pathNode.id)
  const out = []
  for (const n of dag.nodes.values()) {
    if (!isBackbone(n) || n.id === pathNode.id) continue
    if (levels.get(n.id) !== lv) continue
    const sharesSucc = dag.out.get(n.id)
      .some((x) => isBackbone(dag.nodes.get(x.to)) && succ.has(x.to))
    if (!sharesSucc) continue
    if (reaches(dag, n.id, pathNode.id) || reaches(dag, pathNode.id, n.id)) continue
    out.push(n)
  }
  out.sort(bySeq)
  return out
}

function evidenceFor(dag, stepNodeIds) {
  const ids = new Set(stepNodeIds)
  const ev = []
  for (const n of dag.nodes.values()) {
    if (!isEvidence(n)) continue
    if (dag.out.get(n.id).some((x) => ids.has(x.to))) ev.push(n)
  }
  ev.sort(bySeq)
  return ev
}

function stepConnector(dag, stepNodes, nextStepNodes) {
  if (!nextStepNodes || !nextStepNodes.length) return null
  if (stepNodes.length > 1) return { word: '共同支撑', pendingReview: false }
  const fromId = stepNodes[0].id
  const targets = new Set(nextStepNodes.map((n) => n.id))
  let best = null
  for (const x of dag.out.get(fromId)) {
    if (!targets.has(x.to)) continue
    if (!best || (REL_WEIGHT[x.rel] || 0) > (REL_WEIGHT[best.rel] || 0)) best = x
  }
  if (!best) return { word: '相关', pendingReview: false }
  return { word: CONNECTOR_WORD[best.rel] || '相关', pendingReview: Boolean(best.edge.pendingReview) }
}

export function buildChain(dag, path, levels, meta, taken = new Set()) {
  const steps = []
  for (const p of path) {
    const sibs = findSiblings(dag, levels, p).filter((s) => !taken.has(s.id))
    const nodes = [p, ...sibs]
    nodes.forEach((n) => taken.add(n.id))
    steps.push({
      nodes,
      evidence: evidenceFor(dag, nodes.map((n) => n.id)),
      connector: null,
      pendingReview: false,
    })
  }
  for (let i = 0; i < steps.length - 1; i++) {
    const c = stepConnector(dag, steps[i].nodes, steps[i + 1].nodes)
    steps[i].connector = c ? c.word : null
    steps[i].pendingReview = Boolean(c && c.pendingReview)
  }
  return { id: meta.id, kind: meta.kind, stance: meta.stance || null, title: meta.title, steps }
}

/**
 * 对立候选链：与主结论有 contradicts 关系的节点，各自沿最强入边
 * 回溯一条论证线。只做"提议"，stance 置 null、kind 标 candidate，
 * 命名与多空归属待用户确认。
 */
export function extractStanceCandidates(dag, levels, mainPath, projection, taken = new Set()) {
  if (!mainPath.length) return []
  const conclusion = mainPath[mainPath.length - 1]
  const mainIds = new Set(mainPath.map((n) => n.id))
  const rivals = new Map()
  for (const e of (projection && projection.edges) || []) {
    if (!e || e.rel !== 'contradicts' || e.reviewDecision === 'rejected') continue
    const a = dag.nodes.get(e.from)
    const b = dag.nodes.get(e.to)
    if (!isBackbone(a) || !isBackbone(b)) continue
    if (e.from === conclusion.id && !mainIds.has(e.to)) rivals.set(e.to, e)
    else if (e.to === conclusion.id && !mainIds.has(e.from)) rivals.set(e.from, e)
  }
  const chains = []
  let k = 0
  for (const rid of rivals.keys()) {
    if (taken.has(rid)) continue
    const start = dag.nodes.get(rid)
    const line = [start]
    const seen = new Set([rid, ...mainIds])
    let cur = start
    for (;;) {
      const cands = dag.incon.get(cur.id)
        .filter((x) => isBackbone(dag.nodes.get(x.from)) && !seen.has(x.from))
        .sort((a, b) =>
          ((REL_WEIGHT[b.rel] || 0) - (REL_WEIGHT[a.rel] || 0)) ||
          (num(dag.nodes.get(a.from).createdSeq) - num(dag.nodes.get(b.from).createdSeq)) ||
          byId(a.from, b.from))
      if (!cands.length) break
      cur = dag.nodes.get(cands[0].from)
      seen.add(cur.id)
      line.unshift(cur)
    }
    chains.push(buildChain(dag, line, levels, {
      id: `stance-${++k}`,
      kind: 'stance-candidate',
      stance: null,
      title: `与「${conclusion.title || '主结论'}」对立的论证线（待确认）`,
    }, taken))
  }
  return chains
}

/** 交锋点：两端都在链上的 contradicts 边。 */
export function collectClashes(projection, chains) {
  const loc = new Map()
  for (const c of chains) {
    c.steps.forEach((s, i) => s.nodes.forEach((n) => {
      if (!loc.has(n.id)) loc.set(n.id, { chainId: c.id, stepIndex: i })
    }))
  }
  const clashes = []
  for (const e of (projection && projection.edges) || []) {
    if (!e || e.rel !== 'contradicts' || e.reviewDecision === 'rejected') continue
    const a = loc.get(e.from)
    const b = loc.get(e.to)
    if (!a || !b) continue
    clashes.push({
      edgeId: e.id,
      fromChainId: a.chainId, fromStepIndex: a.stepIndex,
      toChainId: b.chainId, toStepIndex: b.stepIndex,
      pendingReview: Boolean(e.pendingReview),
    })
  }
  return clashes
}

/** 主入口。opts.mainTitle 可覆盖主链标题（主题无关：标题来自调用方）。 */
export function linearize(projection, opts = {}) {
  const dag = buildDag(projection)
  const path = findMainPath(dag)
  const levels = assignLevels(dag)
  const taken = new Set()
  const chains = []
  if (path.length) {
    chains.push(buildChain(dag, path, levels, {
      id: 'main', kind: 'main', title: opts.mainTitle || '主链',
    }, taken))
  }
  for (const c of extractStanceCandidates(dag, levels, path, projection, taken)) chains.push(c)
  const placed = new Set(taken)
  const unplaced = []
  for (const n of dag.nodes.values()) {
    if (!isBackbone(n) || placed.has(n.id)) continue
    const linked = dag.out.get(n.id).some((x) => isBackbone(dag.nodes.get(x.to))) ||
      dag.incon.get(n.id).some((x) => isBackbone(dag.nodes.get(x.from)))
    unplaced.push({ node: n, reason: linked ? 'parallel-branch' : 'no-path' })
  }
  unplaced.sort((a, b) => bySeq(a.node, b.node))
  return { chains, unplaced, clashes: collectClashes(projection, chains) }
}
