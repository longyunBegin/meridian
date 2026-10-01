/**
 * 认知链图谱 · 几何/布局冒烟测试（概念 02 分层语义布局）。
 * 从 src/renderer/views/chain.js 源码中提取纯函数真实执行，
 * 验证分层布局与走线不崩、节点不严重重叠。
 * 运行：node test/chain-graph-smoke.test.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src/renderer/views/chain.js'), 'utf8')
const vaultSrc = readFileSync(join(ROOT, 'src/renderer/views/vault.js'), 'utf8')
const cssSrc = readFileSync(join(ROOT, 'src/renderer/styles.css'), 'utf8')
const uiModelSrc = readFileSync(join(ROOT, 'src/renderer/lib/chain-ui-model.js'), 'utf8')
const projectorSrc = readFileSync(join(ROOT, 'src/main/chain-projector.js'), 'utf8')
const eventsSrc = readFileSync(join(ROOT, 'src/main/chain-events.js'), 'utf8')
const chainStoreSrc = readFileSync(join(ROOT, 'src/main/chain-store.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const linear = channels.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}
const contrastRatio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const composite = (fg, bg, alpha) => {
  const f = [1, 3, 5].map((i) => parseInt(fg.slice(i, i + 2), 16))
  const b = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16))
  return '#' + f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')
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
for (const name of ['seededRand', 'hashStr', 'nodeSize', 'layoutGraph', 'rectExit', 'edgeGeom', 'edgeD', 'splitLines']) {
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
${fns.edgeGeom || ''}
${fns.edgeD || ''}
${fns.layoutGraph || ''}
`
const api = new Function(`${sandbox}; return { layoutGraph, rectExit, edgeD, edgeGeom, splitLines, nodeSize }`)()
const { layoutGraph, rectExit, edgeD, edgeGeom, splitLines, nodeSize } = api

console.log('\n— splitLines —')
ok('短标题一行', JSON.stringify(splitLines('市场规模')) === '["市场规模"]')
ok('长标题两行', splitLines('这是一个很长的主张标题文本内容').length === 2)
ok('空标题兜底', splitLines('')[0] === '未命名')
ok('证据节点更短', splitLines('这是一个很长的主张标题文本内容', 10).length === 2)

console.log('\n— nodeSize / rectExit / edgeD / edgeGeom —')
ok('主张节点 150x56', nodeSize({ kind: 'claim' }).w === 150)
ok('证据节点更小', nodeSize({ kind: 'evidence' }).w < nodeSize({ kind: 'claim' }).w)
ok('主题节点尺寸', nodeSize({ kind: 'theme' }).w === 170)
const a = { x: 100, y: 100 }
const b = { x: 400, y: 300 }
const s = rectExit(a, b, 75, 28)
ok('出点在矩形边界上', Math.abs(Math.abs(s.x - 100) - 75) < 1 || Math.abs(Math.abs(s.y - 100) - 28) < 1)
const d = edgeD(a, b, { w: 150, h: 56 }, { w: 150, h: 56 })
ok('边路径是二次贝塞尔', /^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/.test(d), d)
ok('零距离不崩', typeof edgeD(a, { ...a }, { w: 150, h: 56 }, { w: 150, h: 56 }) === 'string')
const g = edgeGeom(a, b, { w: 150, h: 56 }, { w: 150, h: 56 })
ok('edgeGeom 给出标注中点', typeof g.px === 'number' && typeof g.py === 'number' && !Number.isNaN(g.px))
ok('edgeD 与 edgeGeom 路径一致', edgeD(a, b, { w: 150, h: 56 }, { w: 150, h: 56 }) === g.d)

console.log('\n— layoutGraph 分层语义布局（14 主张 + 16 证据 + 主题根） —')
const nodes = [{ id: '__theme__', kind: 'theme' }]
for (let i = 0; i < 14; i++) nodes.push({ id: 'seg' + i, kind: 'claim' })
for (let i = 0; i < 16; i++) nodes.push({ id: 'ev' + i, kind: 'evidence' })
const edges = []
for (let i = 0; i < 14; i++) edges.push({ from: 'ev' + (i % 16), to: 'seg' + i })
edges.push({ from: 'seg0', to: 'seg1' })
const t0 = Date.now()
const { pos, size, height } = layoutGraph(nodes, edges, 1120, '__theme__')
const dt = Date.now() - t0
ok('31 节点布局 < 2s', dt < 2000, `${dt}ms`)
ok('返回动态高度', typeof height === 'number' && height >= 320, `H=${height}`)
let bad = 0
for (const n of nodes) {
  const p = pos.get(n.id)
  const sz = size.get(n.id)
  if (!p || Number.isNaN(p.x) || Number.isNaN(p.y)) bad++
  if (p.x < sz.w / 2 || p.x > 1120 - sz.w / 2 || p.y < sz.h / 2 || p.y > height - sz.h / 2) bad++
}
ok('所有节点位置有效且在边界内', bad === 0, `坏点 ${bad}`)
const themeY = pos.get('__theme__').y
const claimYs = nodes.filter((n) => n.kind === 'claim').map((n) => pos.get(n.id).y)
const evYs = nodes.filter((n) => n.kind === 'evidence').map((n) => pos.get(n.id).y)
ok('主题根节点在最上', claimYs.every((y) => y > themeY) && evYs.every((y) => y > themeY), `themeY=${themeY}`)
ok('主张层在证据层之上', Math.max(...claimYs) < Math.min(...evYs),
  `claim max=${Math.max(...claimYs)} ev min=${Math.min(...evYs)}`)
const r2 = layoutGraph(nodes, edges, 1120, '__theme__')
ok('布局确定性', r2.pos.get('seg0').x === pos.get('seg0').x && r2.pos.get('seg0').y === pos.get('seg0').y)
let badEdge = 0
for (const e of edges) {
  const dd = edgeD(pos.get(e.from), pos.get(e.to), size.get(e.from), size.get(e.to))
  if (!/^M [\d.-]+ [\d.-]+ Q/.test(dd)) badEdge++
}
ok('全部边路径合法', badEdge === 0)

console.log('\n— UI 完整性、provenance 与可访问性 —')
ok('校验状态和手动复核入口', src.includes('m.chainVerify(theme.id)') && src.includes('role: integrity?.ok ? \'status\' : \'alert\''))
ok('明确不提供绝对不可篡改保证', src.includes('本地可控攻击者仍可重写整链') && src.includes('未提供签名或远端锚定'))
ok('图节点可键盘打开且声明来源', src.includes("ev.key !== 'Enter'") && src.includes('data-provenance') && src.includes('provenanceEventIds'))
ok('节点详情不渲染空字段 null 占位', src.includes('mount(clear(body),'))
const entryDialogBlock = src.slice(src.indexOf('function openEntryDialog('), src.indexOf('\nfunction ', src.indexOf('function openEntryDialog(') + 1))
ok('建模对话框关闭后可返回原焦点', entryDialogBlock.indexOf('const previousFocus = document.activeElement') >= 0
  && entryDialogBlock.indexOf('const previousFocus = document.activeElement') < entryDialogBlock.indexOf('closeNodeDetail()'))
ok('恢复是新事件而非旧记录删除', src.includes('node.restored') && src.includes('追加恢复事件'))
ok('墓碑区有归档原因、证据数和日期', vaultSrc.includes('归档原因：') && vaultSrc.includes('证据 ${node.evidenceCount') && vaultSrc.includes('归档于 ${date}'))
ok('墓碑区具备筛选、技术详情与恢复入口', vaultSrc.includes("type: 'search'") && vaultSrc.includes('技术详情 · 原始引用与事件 ID') && vaultSrc.includes('m.chainRestoreNode'))
ok('墓碑当前归档源为事件投影；旧段仅作标明且无直接复活写入的兼容预览', vaultSrc.includes('m.chainArchives(theme.id)')
  && vaultSrc.includes('旧格式 · 待事件化') && vaultSrc.includes('eventBackedSourceRefs.has(`segment:${segment.id}`)')
  && !vaultSrc.includes('m.chainReviveSegment'))
ok('账本按序窗口分页；无前 200 条静默截断', src.includes('paginate(ordered, page, LEDGER_PAGE_SIZE)')
  && uiModelSrc.includes('LEDGER_PAGE_SIZE = 40') && !src.includes('.slice(0, 200)'))
ok('待归置节点全量搜索过滤并提供分页挂接入口', src.includes('cog-float-search') && src.includes('paginate(filtered, pageState.value, FLOATING_PAGE_SIZE)')
  && src.includes("'查看并挂接'"))
ok('待归置索引按归档/结算语义计数筛选，归档项入口明示恢复', src.includes('floatingStatusKey(node)')
  && src.includes("node.archived ? '查看与恢复' : '查看并挂接'"))
ok('历史回放标识序号/只读且损坏账本约束在校验前缀', src.includes('chainProjectionAt')
  && src.includes('validPrefixSeq') && src.includes('历史回放 · v${viewState.selectedSeq}') && src.includes('只读'))
ok('待复核关系具备理由输入及追加式确认/驳回入口', src.includes('m.chainReviewRelation')
  && src.includes("submit('confirmed'") && src.includes("submit('rejected'") && src.includes('决定理由'))
ok('待复核/已决定推导边默认不被普通推导折叠隐藏', src.includes("'data-review-status': pending ? 'pending'")
  && cssSrc.includes('.cog-edge-derives:not(.is-review):not(.is-confirmed):not(.is-rejected)'))
ok('损坏尾部的复核状态不会泄漏进当前账本卡片或节点历史', src.includes('verifiedLedgerPrefix(events, proj.integrity)')
  && src.includes('handlers.verifiedEvents || verifiedLedgerPrefix(events, integrity)')
  && src.includes('events = verifiedLedgerPrefix(evRes?.events || [], p.integrity)'))
ok('损坏账本仅按有效前缀标记当前事件数', src.includes('有效事件 ${validPrefixSeq} / 原始记录 ${events.length}'))
ok('墓碑恢复只对完整性通过的事件归档开放', vaultSrc.includes('!result?.integrity ? []')
  && vaultSrc.includes('disabled: integrity?.ok !== true'))
ok('历史滑杆 replay 采用最后请求胜出并可由返回 live 作废', src.includes('let replayGeneration = 0')
  && src.includes('if (generation !== replayGeneration) return null') && src.includes('replayGeneration++'))
ok('历史 ledger 来源/对象名称解析只读取所选序号前的有效事件', src.includes('eventsThroughSequence(events, integrity, viewState?.selectedSeq)')
  && src.includes('eventSourceLabel(e, visibleEvents)') && src.includes('eventObjectLabel(e, visibleEvents, byId)'))
ok('sourceRef 身份不以毫秒时间戳生成，新旧链身份分别使用 UUID/稳定哈希', !projectorSrc.includes('Date.now(')
  && !eventsSrc.includes('Date.now(') && !chainStoreSrc.includes('Date.now(') && !chainStoreSrc.includes('uid(')
  && chainStoreSrc.includes('randomUUID()') && chainStoreSrc.includes('legacy-segment-') && chainStoreSrc.includes('legacy-log-'))
ok('节点一生保留折叠更正谱系且事件可跳回 ledger append sequence', src.includes('renderLineageThread')
  && src.includes('节点一生 · 来源与相关事件') && src.includes('跳回账本 · 第 ${e.seq} 条'))
ok('校验、键盘焦点和墓碑布局有可见样式', cssSrc.includes('.cog-integrity.is-error') && cssSrc.includes('.cog-node:focus-visible rect') && cssSrc.includes('.event-archive-section'))
ok('链区辅助文字使用可读对比度 token', cssSrc.includes('.chain-section, .chain-drawer { --text-3:var(--text-2); }') && src.includes("color: '#b54708'"))
ok('新增链区文字和状态颜色满足 WCAG AA 对比度', contrastRatio(composite('#1d1f21', '#ffffff', 0.62), '#ffffff') >= 4.5
  && contrastRatio(composite('#f5f5f7', '#2a2a2c', 0.66), '#2a2a2c') >= 4.5
  && contrastRatio('#166534', '#ecfdf5') >= 4.5 && contrastRatio('#b54708', '#ffffff') >= 4.5)
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
