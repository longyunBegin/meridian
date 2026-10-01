/**
 * 认知链图谱 · 几何/布局冒烟测试。
 * 从 src/renderer/views/chain.js 源码中提取纯函数真实执行，
 * 验证布局与走线不崩、节点不严重重叠。
 * 运行：node test/chain-graph-smoke.test.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src/renderer/views/chain.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

// 提取顶层 function 声明（这些函数不依赖 DOM）
const fns = {}
const grab = (name) => {
  if (name === 'nodeSize') {
    const line = src.split('\n').find((l) => l.startsWith('const nodeSize ='))
    if (!line) { console.log(' FAIL  提取失败：nodeSize'); fail++; return '' }
    return line
  }
  const m = src.match(new RegExp(`function ${name}\\(.*?\\n\\}`, 's'))
  if (!m) { console.log(' FAIL  提取失败：' + name); fail++; return '' }
  return m[0]
}
for (const name of ['seededRand', 'hashStr', 'nodeSize', 'layoutGraph', 'rectExit', 'edgeD', 'splitLines']) {
  fns[name] = grab(name)
}
const NODE_SIZE_SRC = src.match(/const NODE_SIZE = \{[\s\S]*?\n\}/)?.[0] || ''
const sandbox = `
${NODE_SIZE_SRC}
${fns.nodeSize || ''}
${fns.seededRand || ''}
${fns.hashStr || ''}
${fns.rectExit || ''}
${fns.splitLines || ''}
${fns.edgeD || ''}
${fns.layoutGraph || ''}
`
const api = new Function(`${sandbox}; return { layoutGraph, rectExit, edgeD, splitLines, nodeSize }`)()
const { layoutGraph, rectExit, edgeD, splitLines, nodeSize } = api

console.log('\n— splitLines —')
ok('短标题一行', JSON.stringify(splitLines('市场规模')) === '["市场规模"]')
ok('长标题两行', splitLines('这是一个很长的主张标题文本内容').length === 2)
ok('空标题兜底', splitLines('')[0] === '未命名')
ok('证据节点更短', splitLines('这是一个很长的主张标题文本内容', 10).length === 2)

console.log('\n— nodeSize / rectExit / edgeD —')
ok('主张节点 150x56', nodeSize({ kind: 'claim' }).w === 150)
ok('证据节点更小', nodeSize({ kind: 'evidence' }).w < nodeSize({ kind: 'claim' }).w)
const a = { x: 100, y: 100 }
const b = { x: 400, y: 300 }
const s = rectExit(a, b, 75, 28)
ok('出点在矩形边界上', Math.abs(Math.abs(s.x - 100) - 75) < 1 || Math.abs(Math.abs(s.y - 100) - 28) < 1)
const d = edgeD(a, b, { w: 150, h: 56 }, { w: 150, h: 56 })
ok('边路径是二次贝塞尔', /^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/.test(d), d)
ok('零距离不崩', typeof edgeD(a, { ...a }, { w: 150, h: 56 }, { w: 150, h: 56 }) === 'string')

console.log('\n— layoutGraph（模拟真实规模：14 主张 + 16 证据） —')
const nodes = []
for (let i = 0; i < 14; i++) nodes.push({ id: 'seg' + i, kind: 'claim' })
for (let i = 0; i < 16; i++) nodes.push({ id: 'ev' + i, kind: 'evidence' })
const edges = []
for (let i = 0; i < 14; i++) edges.push({ from: 'ev' + (i % 16), to: 'seg' + i })
edges.push({ from: 'seg0', to: 'seg1' })
const t0 = Date.now()
const { pos, size } = layoutGraph(nodes, edges, 1120, 620)
const dt = Date.now() - t0
ok('30 节点布局 < 2s', dt < 2000, `${dt}ms`)
let bad = 0
for (const n of nodes) {
  const p = pos.get(n.id)
  const sz = size.get(n.id)
  if (!p || Number.isNaN(p.x) || Number.isNaN(p.y)) bad++
  if (p.x < sz.w / 2 || p.x > 1120 - sz.w / 2 || p.y < sz.h / 2 || p.y > 620 - sz.h / 2) bad++
}
ok('所有节点位置有效且在边界内', bad === 0, `坏点 ${bad}`)
const r2 = layoutGraph(nodes, edges, 1120, 620)
ok('布局确定性', r2.pos.get('seg0').x === pos.get('seg0').x)
let badEdge = 0
for (const e of edges) {
  const dd = edgeD(pos.get(e.from), pos.get(e.to), size.get(e.from), size.get(e.to))
  if (!/^M [\d.-]+ [\d.-]+ Q/.test(dd)) badEdge++
}
ok('全部边路径合法', badEdge === 0)
// 重叠检查（按各自尺寸）
let overlap = 0
const pts = nodes.map((n) => ({ ...pos.get(n.id), sz: size.get(n.id) }))
for (let i = 0; i < pts.length; i++) {
  for (let j = i + 1; j < pts.length; j++) {
    const dx = Math.abs(pts[i].x - pts[j].x)
    const dy = Math.abs(pts[i].y - pts[j].y)
    if (dx < (pts[i].sz.w + pts[j].sz.w) / 2 && dy < (pts[i].sz.h + pts[j].sz.h) / 2) overlap++
  }
}
ok('节点重叠对数可接受', overlap <= 6, `${overlap} 对`)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
