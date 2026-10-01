/**
 * 认知链连线 · 纯函数。
 *
 * 只表达账本里真实存在的关系，不推导、不补全：
 * - mergedFrom：段由谁合并而来（合并时记录的源段名）
 * - affects：段声明影响谁（段名数组）
 *
 * 关系存的是段名，这里按名解析为段 id；解析不到（已关闭/改名/删除）就不画线。
 * 无 DOM 依赖，可在 node 测试里直接 import。
 */

/** 段名 → 段 id（重名取第一个；空名跳过）。 */
export function segmentNameIndex(segments) {
  const byName = new Map()
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || typeof s.name !== 'string') continue
    const n = s.name.trim()
    if (n && !byName.has(n)) byName.set(n, s.id)
  }
  return byName
}

const strArr = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string')

/**
 * @param {Array} segments 参与画线的段（通常是未关闭段）
 * @returns {Array<{from:string,to:string,kind:'merged'|'affects'}>} 去重后的有向边
 */
export function computeChainEdges(segments) {
  const list = Array.isArray(segments) ? segments : []
  const byName = segmentNameIndex(list)
  const edges = []
  const seen = new Set()
  const add = (from, to, kind) => {
    if (!from || !to || from === to) return
    const key = `${from}\u2192${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, kind })
  }
  for (const s of list) {
    if (!s || !s.id) continue
    for (const name of strArr(s.mergedFrom)) add(byName.get(name.trim()), s.id, 'merged')
    for (const name of strArr(s.affects)) add(s.id, byName.get(name.trim()), 'affects')
  }
  return edges
}
