/**
 * 拨弦一幕的时间轴：画面与声音共用同一份，保证音画同步。
 * 样片（pluck.html）直接用；成片（film-timeline.mjs）把它放到第五幕并放慢节奏。
 * 纯函数，只依赖 chain.mjs 产出的引擎结果。
 */

export const W = 1920
export const H = 1080
export const FPS = 60
export const DURATION = 6
const DEFAULT_T_IMPACT = 1.2  // 证据落到源头节点
const DEFAULT_HOP = 0.55      // 振动沿一条边走完所需秒数
export const PX_PER_POINT = 4.2 // 一个置信度点对应的振幅像素

export const LAYOUT = {
  optics:  { x: 230,  y: 500 },
  capex:   { x: 520,  y: 500 },
  apps:    { x: 810,  y: 500 },
  power:   { x: 810,  y: 780, side: 'right' },
  paying:  { x: 1100, y: 500 },
  renew:   { x: 1390, y: 500 },
  produce: { x: 1680, y: 500 },
}

// D 小调五声，越往下游越低；支线用高一些的音区分。
export const PITCH = {
  optics: 293.66, capex: 220.0, apps: 174.61, power: 261.63,
  paying: 146.83, renew: 110.0, produce: 98.0,
}

/** 与 store.js 的 clamp 一致：取整并夹在 0–100。 */
const engineClamp = (n) => Math.max(0, Math.min(100, Math.round(n)))

/**
 * opts 允许成片把这一幕放到任意时刻、换更慢的节奏；默认值就是 6 秒样片。
 */
export function buildTimeline(chain, opts = {}) {
  const T_IMPACT = opts.tImpact ?? DEFAULT_T_IMPACT
  const HOP = opts.hop ?? DEFAULT_HOP
  const byKey = new Map(chain.nodes.map((n) => [n.key, n]))
  const origin = byKey.get(chain.origin)
  if (!origin) throw new Error(`chain 中缺少源头节点 ${chain.origin}`)
  for (const n of chain.nodes) {
    if (!LAYOUT[n.key] || !PITCH[n.key]) throw new Error(`节点 ${n.key} 没有布局或音高`)
  }

  const depth = new Map([[origin.key, 0]])
  const queue = [origin.key]
  while (queue.length) {
    const k = queue.shift()
    for (const c of chain.nodes.filter((n) => n.parent === k)) {
      depth.set(c.key, depth.get(k) + 1)
      queue.push(c.key)
    }
  }

  const nodes = chain.nodes.map((n) => {
    const d = depth.get(n.key)
    const delta = n.after - n.before
    return {
      key: n.key,
      title: n.title,
      ...LAYOUT[n.key],
      before: n.before,
      after: n.after,
      delta,
      reachT: d === undefined || delta === 0 ? null : T_IMPACT + d * HOP,
    }
  })
  const nodeOf = new Map(nodes.map((n) => [n.key, n]))

  // 每条边：raw 是未取整的传导量（决定振幅），与引擎结果交叉校验。
  const edges = []
  for (const child of chain.nodes) {
    if (!child.parent) continue
    const parent = byKey.get(child.parent)
    const parentDelta = parent.after - parent.before
    const raw = parentDelta * parent.propagation
    const childDelta = child.after - child.before
    if (parentDelta !== 0) {
      const expected = engineClamp(child.before + raw) - child.before
      if (expected !== childDelta) {
        throw new Error(`引擎结果与传导公式不一致：${parent.key}→${child.key} 期望 ${expected}，引擎 ${childDelta}`)
      }
    } else if (childDelta !== 0) {
      throw new Error(`上游未变化但 ${child.key} 变化了 ${childDelta}`)
    }
    const pNode = nodeOf.get(parent.key)
    edges.push({
      from: parent.key,
      to: child.key,
      weight: parent.propagation,
      raw,
      t0: parentDelta === 0 ? null : pNode.reachT,
      cut: parentDelta !== 0 && childDelta === 0,
    })
  }

  const pluck = (n, amp) => ({ t: n.reachT, freq: PITCH[n.key], amp, pan: (n.x / W) * 2 - 1 })
  const audio = nodes
    .filter((n) => n.reachT !== null)
    .map((n) => pluck(n, Math.abs(n.delta) / Math.abs(origin.after - origin.before)))
  for (const e of edges.filter((x) => x.cut)) {
    const n = nodeOf.get(e.to)
    audio.push({ t: e.t0 + HOP * 0.35, freq: PITCH[n.key], amp: Math.abs(e.raw) / Math.abs(origin.after - origin.before), pan: (n.x / W) * 2 - 1, muted: true })
  }

  return {
    W, H, FPS, DURATION, T_IMPACT, HOP, PX_PER_POINT,
    theme: chain.theme,
    origin: origin.key,
    nodes,
    edges,
    evidence: { text: '新证据 · 1.6T 光模块出货超预期', showT: T_IMPACT - 0.9, dropT: T_IMPACT - 0.4 },
    subtitles: [
      { from: 1.0, to: 3.3, text: '拨一下上游，整条链都会响。' },
      { from: 3.5, to: 5.4, text: '越往下，越轻。直到它自己停下。' },
    ],
    fadeIn: 0.5,
    fadeOutFrom: 5.5,
    audio,
    impact: { t: T_IMPACT },
  }
}
