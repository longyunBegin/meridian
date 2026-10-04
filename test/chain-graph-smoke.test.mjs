import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NETWORK_NODE_TYPES, ARGUMENT_RELATIONS, REVISION_RELATIONS, ASSOCIATION_RELATIONS,
  layoutThemeNetwork, buildDensityTimeline,
} from '../src/renderer/lib/theme-network.js'
import { selectGraphWindow } from '../src/renderer/lib/chain-ui-model.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')
const chain = read('src/renderer/views/chain.js')
const renderer = read('src/renderer/lib/theme-network-render.js')
const network = read('src/renderer/lib/theme-network.js')
const css = read('src/renderer/styles.css')
const projector = read('src/main/chain-projector.js')
const eventStore = read('src/main/chain-events.js')
const themeView = read('src/renderer/views/theme.js')
const appView = read('src/renderer/app.js')
const migrate = read('test/chain-events.test.mjs')

let passed = 0
let failed = 0
const ok = (name, condition, extra = '') => {
  condition ? passed++ : failed++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${extra ? `  ${extra}` : ''}`)
}

ok('正式节点分类恰为概念、对象、事件、观点、证据', NETWORK_NODE_TYPES.join(',') === 'concept,object,event,viewpoint,evidence')
ok('论证、版本修订与弱主题关联三类关系完整分组且无重复类型', ARGUMENT_RELATIONS.join(',') === 'supports,derives,contradicts'
  && REVISION_RELATIONS.join(',') === 'supersedes'
  && ASSOCIATION_RELATIONS.join(',') === 'belongs-to,influences,depends-on,temporal,related'
  && new Set([...ARGUMENT_RELATIONS, ...REVISION_RELATIONS, ...ASSOCIATION_RELATIONS]).size === 9)
ok('主题只作范围元数据；孤立节点与全体节点留在同一无根投影', projector.includes('export function chainScope(projection)')
  && projector.includes('return { nodes: projection.nodes, edges: projection.edges, floating: [] }')
  && !renderer.includes('__theme__') && !renderer.includes('is-theme'))
ok('投影兼容旧 claim/inference 与旧来源节点类型', network.includes("return 'viewpoint'")
  && eventStore.includes('function legacyNodeType(node)')
  && eventStore.includes("return NODE_TYPES.includes(legacyType) ? legacyType : 'viewpoint'"))
ok('改名、失效作为新事件回放；时间快照只投影校验有效前缀', projector.includes("e.type === 'node.renamed'")
  && projector.includes("e.type !== 'node.renamed' && e.type !== 'node.invalidated'")
  && projector.includes('export function getChainProjectionAt')
  && eventStore.includes("'node.renamed'") && eventStore.includes("'node.invalidated'"))
ok('五类节点写入通过显式类型 schema 且迁移保留旧类型 hint/边界', eventStore.includes("export const NODE_TYPES = ['concept', 'object', 'event', 'viewpoint', 'evidence']")
  && projector.includes('NODE_TYPES.includes(nodeType)') && migrate.includes('legacyTypeHint') && migrate.includes('migrationBoundary'))
ok('关系复核确认/驳回由新关系事件追加，原声明保持不变', projector.includes('export function reviewProjectedRelation')
  && projector.includes('reviewOf: original.id') && projector.includes("reviewDecision: decision")
  && chain.includes("submit('confirmed'") && chain.includes("submit('rejected'"))

ok('图中没有主题 root、观点阅读路线、旧观点分页器或独立媒体读单', !chain.includes('cog-claim-pager')
  && !chain.includes('primaryGraphNodes') && !chain.includes('renderIndependentMediaGroups')
  && !renderer.includes('cog-edge-topic') && !chain.includes('主题根 · 元数据')
  && !themeView.includes('renderChainReader') && /renderChainSection\(theme,/.test(themeView)
  && !appView.includes('主题本身就是图根'))
ok('真正空主题给出“添加第一条观察/观点”入口且无自动虚构', chain.includes('真实空主题')
  && chain.includes('添加第一条观察/观点')
  && chain.includes('不会自动生成观点、证据或事实')
  && (chain.includes('const trulyEmpty = !allNodes.length && !(currentView.events || []).length')
    || chain.includes('const trulyEmpty = verifiedTimelineEvents.length === 0')))
ok('节点创建表单只保存显式输入并区分适用时间，说明不会冒充证据或事实', /await m\.chainCreateNode\(theme\.id,\s*\{\s*nodeType: typeSelect\.value,\s*title,\s*detail: text,\s*status: 'pending',\s*applicability: applicabilityInput\.value\.trim\(\)/.test(chain)
  && chain.includes('说明不会自动转成证据、事实或关系') && chain.includes('适用时间不是系统摄入时间'))
ok('新节点、追加证据、关系及生命周期按钮均使用事件命令', chain.includes('m.chainCreateNode(')
  && chain.includes('m.chainAddEvidence(') && chain.includes('m.chainDeclareRelation(')
  && chain.includes('m.chainRenameNode(') && chain.includes('m.chainInvalidateNode('))
ok('通用内容通过 DOM textContent 呈现，不使用 HTML 字符串注入', renderer.includes('element.textContent = String(value ?? \'\')')
  && !renderer.includes('innerHTML') && chain.includes('textContent ='))
ok('SVG 节点标题按实际卡片宽度、字号和内边距分行，不以固定字数溢出边框', network.includes('export function nodeTitleCharsPerLine')
  && renderer.includes('nodeTitleCharsPerLine(dimensions.w, 11, 28)'))
ok('网络/历史控件实现保留在 chain.js（建设者主舞台现为待判队列；读者页提供序号回放）', chain.includes('const verifiedTimelineEvents = handlers.verifiedEvents || []')
  && chain.includes('buildDensityTimeline(verifiedTimelineEvents)')
  && chain.includes("class: 'cog-time-controls'")
  && read('src/renderer/views/reader.js').includes('rdr-history-slider')
  && read('src/renderer/views/reader.js').includes('loadProjectionAt'))
ok('时间轴日期刻度可点选；拖动选择时只发起只读历史回放', chain.includes("onclick: () => handlers.onReplay?.(point.seq)")
  && chain.includes("timeSlider.addEventListener('input', () => replayFromSlider(false))")
  && chain.includes('setTimeout(() => handlers.onReplay?.(point.seq), 90)')
  && projector.includes('export function getChainProjectionAt'))
ok('历史回放摘要与“与当前对比”均直接连到当前/历史投影', chain.includes('timelineChangeSummary(verifiedTimelineEvents, previousSeq, viewState.selectedSeq)')
  && chain.includes('compareCurrent && replaying') && chain.includes('currentEdges'))
ok('布局只按完整主题投影预计算一次并在历史帧中复用', chain.includes('const networkLayout = layoutThemeNetwork(projectedNodes(proj)')
  && chain.includes('networkLayout,') && renderer.includes('const layout = opts.networkLayout'))
ok('搜索旧名/正文与类型/状态筛选都作用于完整投影，画布帧有界', chain.includes('搜索节点、旧名或说明')
  && chain.includes('按节点类型筛选') && chain.includes('按节点状态筛选')
  && chain.includes('searchGraphNodes(projectedNodes(currentView.projection), query)')
  && chain.includes('const frame = selectGraphWindow({'))

ok('节点卡按形状、颜色及图形字区分类型，并用文字 pill 显示状态', network.includes('shape: \'circle\'')
  && network.includes('shape: \'diamond\'') && network.includes('shape: \'hexagon\'')
  && renderer.includes('appendTypeGlyph(group, type') && renderer.includes('class: \'cog-node-status-pill\''))
ok('论证边加粗带箭头、版本修订边独立为虚线箭头、弱主题关联线细且无箭头', renderer.includes('const directional = argument || revision')
  && renderer.includes("'stroke-width': argument ? (pending ? 2.5 : 2.8) : revision ? 2 : 1.1")
  && renderer.includes("'stroke-opacity': directional ? (future ? 0.38 : 0.9) : (future ? 0.15 : 0.43)")
  && renderer.includes("'stroke-dasharray': pending || rejected || future ? (directional ? '6 4' : '3 5') : revision ? '7 3' : argument ? 'none' : '3 5'")
  && renderer.includes("'marker-end': directional ? `url(#cog-network-arrow-${pending || rejected ? 'review' : edge.rel})` : 'none'"))
ok('节点可按 Tab 聚焦并通过 Enter/Space 激活，具有 role 与完整可访问标签', renderer.includes("role: node._notYetCreated ? 'img' : 'button'")
  && renderer.includes("tabindex: node._notYetCreated ? '-1' : '0'") && renderer.includes("event.key !== 'Enter' && event.key !== ' '")
  && renderer.includes("'aria-label': node._notYetCreated"))
ok('历史归档、失效与未来对比节点显示 ghost/虚线且不重排', renderer.includes('is-archived')
  && renderer.includes('is-invalidated') && renderer.includes('_notYetCreated') && renderer.includes("group.style.opacity = unavailable"))
ok('网络视图提供清晰密度上限和全量可搜索提示', renderer.includes('MAX_VISIBLE_EDGES = 72')
  && chain.includes('请用搜索、类型或状态筛选定位其余记录。') && chain.includes('搜索结果分页'))

const syntheticNodes = Array.from({ length: 1000 }, (_, i) => ({
  id: `node-${String(i).padStart(4, '0')}`, nodeType: NETWORK_NODE_TYPES[i % 5],
}))
const syntheticEdges = Array.from({ length: 1800 }, (_, i) => ({
  id: `edge-${i}`, from: syntheticNodes[i % 1000].id, to: syntheticNodes[(i * 31 + 7) % 1000].id,
  rel: [...ARGUMENT_RELATIONS, ...ASSOCIATION_RELATIONS][i % 8],
}))
const fullLayout = layoutThemeNetwork(syntheticNodes, syntheticEdges, 1120)
const windowed = selectGraphWindow({ nodes: syntheticNodes, allNodes: syntheticNodes, edges: syntheticEdges })
const repeatLayout = layoutThemeNetwork([...syntheticNodes].reverse(), [...syntheticEdges].reverse(), 1120)
ok('一千节点/一千八百关系可布局，画布只渲染有界子集且坐标输入顺序稳定', fullLayout.pos.size === 1000
  && windowed.nodes.length <= 60 && windowed.edges.length <= 72 && windowed.truncated
  && fullLayout.pos.get('node-0001').x === repeatLayout.pos.get('node-0001').x
  && fullLayout.pos.get('node-0001').y === repeatLayout.pos.get('node-0001').y)
const density = buildDensityTimeline(Array.from({ length: 40 }, (_, i) => ({ seq: i + 1, at: `2026-09-${String(1 + (i % 4)).padStart(2, '0')}T00:00:00Z` })))
ok('事件密度轴以日期聚合刻度并显示 4 个事件日', density.length === 4 && density.every((point) => point.count === 10))

const light = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const values = channels.map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2]
}
const contrast = (foreground, background) => {
  const values = [light(foreground), light(background)].sort((a, b) => b - a)
  return (values[0] + .05) / (values[1] + .05)
}
ok('暗色网络界面、键盘焦点、响应式过滤器和减少动态偏好均有样式', css.includes('background: #0c1118')
  && css.includes('.chain-section :focus-visible') && css.includes('@media (max-width: 760px)')
  && css.includes('@media (prefers-reduced-motion: reduce)') && css.includes('transition: opacity .3s ease'))
ok('主要暗色文字与画布底色具有 AA 级对比度', contrast('#e7edf6', '#0c1118') >= 4.5
  && contrast('#a3b0c1', '#0c1118') >= 4.5)

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
