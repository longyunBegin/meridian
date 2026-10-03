import { h } from '../lib/dom.js'
import { networkNodeType } from '../lib/theme-network.js'
import { evidenceForNode } from '../lib/chain-workbench-model.js'
import { buildGapList, synthesisSummary } from '../lib/reader-model.js'
import { claimEvidenceStats } from '../components/reader-claim-map.js'
import { renderReaderClusterMap } from '../components/reader-cluster-map.js'
import { renderReaderClaimDetail } from '../components/reader-claim-detail.js'
import { renderReaderConclusion } from '../components/reader-conclusion.js'

const asArray = (value) => Array.isArray(value) ? value : []
const allNodesOf = (projection) => asArray(projection?.allNodes || projection?.nodes).filter(Boolean)
const allEdgesOf = (projection) => asArray(projection?.allEdges || projection?.edges).filter(Boolean)


/** Reader view uses the same current projection and node ids as the builder. */
export function renderReaderView(theme, opts = {}) {
  const root = h('div', { class: 'meridian-theme rdr-root' })
  const article = h('article', { class: 'reader-main rdr-main', 'aria-label': `${theme?.name || '主题'} · 读者视图` },
    h('p', { class: 'rdr-loading' }, '正在读取主题网络…'))
  root.append(article)

  const renderEmpty = (projection) => h('div', { class: 'rdr-empty' },
    h('p', { class: 'rdr-kicker' }, '主题范围 · 真实空投影'),
    h('h1', { class: 'rdr-title' }, theme?.name || '未命名主题'),
    h('p', { class: 'rdr-empty-text' }, '这个主题目前没有节点。主题只限定网络范围，不会自动成为根节点，也不会生成内容。'),
    h('p', { class: 'rdr-empty-sub' }, '建设者可从外部来源、观察或观点开始；每条关系与来源都保留为独立记录。'),
    h('button', { type: 'button', class: 'btn btn-primary', onclick: () => opts.onOpenBuilder?.('network') }, '进入建设者视图'))

  const render = (currentProjection, rawEvents) => {
    // 校验已删除：直接使用全部事件，不再截断到"已验证前缀"
    const verifiedEvents = Array.isArray(rawEvents) ? rawEvents : []
    const currentNodes = allNodesOf(currentProjection)
    const currentEdges = allEdgesOf(currentProjection)
    /* 分类来自 L2 主题自定义层（主题设置里的观点分类）：主题没配分类就没有这一档。
       （原来定义在画布筛选控件旁边，画布移除后挪到这里——分类面板仍然要用。） */
    const themeCategories = asArray(theme?.config?.atomCategories).map((name) => String(name || '').trim()).filter(Boolean)
    if (!currentNodes.length) {
      article.replaceChildren(renderEmpty(currentProjection))
      return
    }

    const state = {
      projection: currentProjection,
      events: verifiedEvents,
      selectedNodeId: null,
    }

    /* 第 ①③ 层「单条下钻」：就地展开在地图下方（读者不丢上下文）。
       口径与地图共用 claimEvidenceStats（不另写一份，避免两处说法分叉）。 */
    let detailClaimId = null
    const detailHost = h('div', { class: 'rdr-detail' })
    const closeClaimDetail = () => {
      detailClaimId = null
      detailHost.replaceChildren()
    }
    const openClaimDetail = (id) => {
      const node = claimNodes.find((row) => row.id === id) || null
      if (!node) return
      detailClaimId = id
      state.selectedNodeId = id
      detailHost.replaceChildren(renderReaderClaimDetail({
        node,
        stats: claimEvidenceStats(node, rowsOfClaim),
        rows: rowsOfClaim(id),
        /* 相关原子：这条观点的真实关系（relation.declared；已驳回的边在上游已过滤）。 */
        relations: currentEdges
          .filter((edge) => edge && (edge.from === id || edge.to === id))
          .map((edge) => {
            const otherId = edge.from === id ? edge.to : edge.from
            const other = claimNodes.find((row) => row.id === otherId) || null
            return other ? { id: otherId, title: other.title, rel: edge.rel } : null
          })
          .filter(Boolean),
        /* 每条证据的权重（=该条证据的强度）：记在 evidence.appended 的载荷里，
           这里按事件 id 建表，供信息卡的证据流逐条显示（人定的会标 manual）。 */
        weights: (() => {
          const map = new Map()
          for (const event of state.events || []) {
            if (event?.type !== 'evidence.appended') continue
            const value = Number(event.payload?.effectiveStrength)
            if (!Number.isFinite(value)) continue
            map.set(event.id, { value, manual: event.payload?.strengthSource === 'manual' })
          }
          return map
        })(),
        onOpenRelation: openClaimDetail,
        onClose: closeClaimDetail,
      }))
      detailHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }

    /* 第 ④ 层「结论页」：读者第一屏，常显（不属于九个 tab，切换 tab 不会把它藏掉）。
       内容全部由真实数据推导：synthesisSummary 给"最强/最分歧"，gaps 给缺口，证据条数与
       独立来源家数来自 evidenceForNode；口径直接写在页面上。 */
    const conclusionBox = h('section', { class: 'rdr-conclusion', 'aria-label': '结论' },
      renderReaderConclusion({
        summary: synthesisSummary(currentNodes, (id) => evidenceForNode(state, id)),
        claims: currentNodes.filter((node) => node && !node.archived
          && (node.nodeType === 'viewpoint' || node.kind === 'claim')),
        gaps: buildGapList({
          nodes: currentNodes,
          edges: allEdgesOf(currentProjection),
          inboxItems: [],
        }),
        evidenceForNode: (id) => evidenceForNode(state, id),
        onOpenClaim: openClaimDetail,
      }))
    const claimNodes = currentNodes.filter((node) => node && !node.archived
      && (node.nodeType === 'viewpoint' || node.kind === 'claim'))
    const rowsOfClaim = (id) => { try { return evidenceForNode(state, id) || {} } catch { return {} } }

    /* 第 ② 层「观点地图」：常显，紧跟结论页（三层下钻的第二层）。
       位置固定（按组数分区）、不用力导向；大小/颜色口径写在组件里。 */
    /* 图谱缩略图（分簇版，借鉴用户给的 demo）：固定分区、不用力导向。
       分簇依据 = 按证据状况（用户已确认），口径写在组件里。 */
    const mapBox = h('section', { class: 'rdr-map', 'aria-label': '观点分簇缩略图' },
      renderReaderClusterMap({
        claims: claimNodes,
        /* 簇 = 主题自定义分类（建设者可在「主题设置 → 分类管理」里定义）；没分类的归入「未分类」。 */
        themeCategories,
        /* 真实关系（已驳回的边在 currentEdges 上游已过滤）：用于画簇间连线，没有关系就不画。 */
        edges: currentEdges,
        evidenceForNode: rowsOfClaim,
        selectedId: state.selectedNodeId,
        onOpenClaim: openClaimDetail,
      }))
    /* 读者页结构对齐用户给的 demo：
       头部（主题名 + 四个统计数）→ 图谱缩略图（气泡=簇，含分簇清单）→ 当前最该看的 5 个 → 单条下钻（抽屉位）。
       原先的"还缺什么 / 详情 / 四个折叠区"与结论页的长段落一并去掉——demo 里没有这些。
       注意：这里曾误写成 `toolbar`（reader 的头部变量已删），于是取到 window.toolbar（BarProp），
       页面上渲染出 [object BarProp] —— 已修。 */
    const readerStats = (() => {
      const states = claimNodes.map((node) => claimEvidenceStats(node, rowsOfClaim).state)
      const categories = new Set(claimNodes.map((node) => String(node?.atomCategory || '').trim() || '未分类'))
      return {
        claims: claimNodes.length,
        clusters: categories.size,
        evidence: currentNodes.filter((node) => networkNodeType(node) === 'evidence').length,
        contested: states.filter((state) => state === 'contested').length,
      }
    })()
    const statBox = (num, label) => h('div', { class: 'rdr-stat' },
      h('div', { class: 'rdr-stat-num' }, String(num)),
      h('div', { class: 'rdr-stat-label' }, label))
    const headBox = h('header', { class: 'rdr-head' },
      h('p', { class: 'rdr-head-kicker' }, '主题 · 观点图谱'),
      h('h1', { class: 'rdr-head-title' }, theme?.name || '未命名主题'),
      h('div', { class: 'rdr-stats' },
        statBox(readerStats.claims, '观点'),
        statBox(readerStats.clusters, '分类'),
        statBox(readerStats.evidence, '证据'),
        statBox(readerStats.contested, '受关注')))
    /* demo 的顺序：气泡图 → 「当前最该看的 5 个」→ 分簇清单。
       清单由缩略图组件一并产出，这里把那个节点搬到 Top 5 之后（同一个节点搬家，不重建）。 */
    const clusterList = mapBox.querySelector('.rdr-cluster-wrap')
    article.replaceChildren(
      ...[headBox, mapBox, conclusionBox, clusterList, detailHost].filter(Boolean),
      /* 用户决定：理由清单、时间线、"还缺什么"、检视器卡片、"更多视图"都已删除；
         页面只保留 头部统计 → 观点图谱 → 当前最该看的 5 个 → 按分类观点清单 → 单条信息卡。 */
      )
  }

  const loadProjection = typeof opts.loadProjection === 'function' ? opts.loadProjection() : Promise.resolve({})
  const loadEvents = typeof opts.loadEvents === 'function' ? opts.loadEvents() : Promise.resolve([])
  Promise.all([loadProjection, loadEvents])
    .then(async ([projection, response]) => {
      const events = Array.isArray(response) ? response : response?.events || []
      // 校验已删除：直接使用全部事件
      const validEvents = events
      const requestedSeq = Number.isSafeInteger(opts.initialSequence)
        && validEvents.some((event) => event.seq === opts.initialSequence) ? opts.initialSequence : null
      if (Number.isSafeInteger(opts.initialSequence) && requestedSeq == null) {
        throw new Error(`第 ${opts.initialSequence} 条事件不存在。`)
      }
      let historicalProjection = null
      if (requestedSeq != null) {
        if (typeof opts.loadProjectionAt !== 'function') throw new Error('当前环境不支持按账本序号读取历史投影。')
        historicalProjection = await opts.loadProjectionAt(requestedSeq)
        if (!historicalProjection || historicalProjection.integrity?.ok === false) throw new Error('历史投影校验失败，不能显示该时间点。')
      }
      render(projection || {}, events, requestedSeq, historicalProjection)
      if (opts.autoPlay && requestedSeq != null) setTimeout(() => article.querySelector('.rdr-play-button')?.click(), 0)
    })
    .catch((error) => article.replaceChildren(h('p', { class: 'rdr-note', role: 'alert' }, `读者视图加载失败：${error?.message || error}`)))
  return root
}
