import { h, icon, clear, toast } from '../lib/dom.js'
import { state, refresh, settleAndViewTheme } from '../app.js'
import { confColor, nodePath, inferInboxThemeIds } from './shared.js'
import { trustMark, periodLabel } from './readings.js'
import { openThemeBuilder } from './theme.js'
import { checkSourceUrl, sourceHostOf, sourceUrlOf } from '../../shared/evidence-source.js'
import { SOURCE_VIA_LABEL, suggestWeight, weightFormula, weightText } from '../../shared/evidence-weight.js'

const m = window.meridian

let inboxItems = []
let inboxTotal = 0
let inboxLimit = 50
let picked = new Set()
let inboxLoading = false
let renderSeq = 0
let selectedInboxId = null
const resolving = new Set()
// 抽取进度：抽取中的条目独立成「抽取中」分组（置顶），组头一条进度条 + 取消按钮。
// 整页重画成本高（全量 inbox 过 IPC），进度事件只做定点 DOM 修补；
// 最终一致性靠 db:changed → refresh。extractDone/Total 让重渲染时组头进度不丢。
const extracting = new Set()
let extractActive = false
let extractDone = 0
let extractTotal = 0
let extractUnsub = null
let lastAutoImport = null
let cachedAllNodes = []
// 收件箱筛选状态：主题筛选（null=全部）+ 状态页签（all/pending/done）
let inboxThemeFilter = null
let inboxStatusFilter = 'all'
// 主题配色：主题无 color 字段时按索引取确定性配色（对齐设计稿蓝/紫/橙圆点）
const THEME_DOT_COLORS = ['#2f7cf6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#06b6d4']
function themeDotColor(themeId) {
  const themes = (state.themes || []).filter((t) => !t.deletedAt)
  const idx = Math.max(0, themes.findIndex((t) => t.id === themeId))
  return THEME_DOT_COLORS[idx % THEME_DOT_COLORS.length]
}

/** 相对时间（设计稿的「33 分钟前」）：列表行与详情头部共用；时间缺失或落在未来时返回空串。 */
function relativeTime(value) {
  if (!value) return ''
  const diff = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diff) || diff < 0) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
/** 条目明确属于的存活主题（记在条目上的 / 抽取挂点反推的），按记下的顺序，第一个是主主题。
 *  不拿「当前主题」兜底：交给主题只交用户在「属于主题」里看得见的那几个。 */
function memberThemeIds(item) {
  const live = new Set((state.themes || []).filter((t) => !t.deletedAt).map((t) => t.id))
  return inferInboxThemeIds(item, cachedAllNodes, null).filter((id) => live.has(id))
}
/** 条目的来源链接（只认真实的 http(s) 网址，口径见 shared/evidence-source.js）；没有返回 null。 */
const itemSourceUrl = (item) => sourceUrlOf(item?.provenance?.url)
/** 为什么这条现在交不出去；能交时返回空串（与后端 inbox:dispatch 的校验同口径）。 */
function dispatchBlocker(item) {
  if (item.kind === 'reading') return '读数挂到指标上，不交给主题'
  if (!String(item.text || '').trim()) return '这条没有原文，交不出去'
  if (!itemSourceUrl(item)) return '先补上来源链接（原文所在网页的网址），才能交给主题'
  if (!memberThemeIds(item).length) return '先选这条数据属于哪个主题'
  return ''
}
const themeName = (themeId) => (state.themes || []).find((t) => t.id === themeId)?.name || '未知主题'

export async function renderToday(mid) {
  if (state.view !== 'today') return
  const seq = ++renderSeq
  clear(mid)

  // 恢复撤销入口（重启后仍可撤销）
  if (!lastAutoImport) {
    try {
      const last = await m.inboxLastAutoImport()
      if (seq !== renderSeq) return
      if (last) lastAutoImport = { id: last.id, count: last.count }
    } catch { /* 静默 */ }
  }

  // 分页拉取：只要前 N 条。全量拉时每次渲染把全部 pending（含 text+lemmas）
  // 序列化过 IPC，而 refresh() 挂在 db:changed 上——改任何东西都会重跑。
  // 窗口随「加载更多」扩大，重渲染不会缩回第一页。
  const pageSize = Math.max(inboxLimit, inboxItems.length)
  const [due, calib, inboxPage, conflicts, ignored, judgeCounts] = await Promise.all([
    m.due(), m.calibration(), m.inboxList({ limit: pageSize, offset: 0 }), m.conflicts(), m.inboxIgnored(),
    // 待判数只是去建设者的入口，拿不到不该拖垮今日页
    Promise.resolve().then(() => m.themeJudgeCounts()).catch(() => null),
  ])
  if (seq !== renderSeq || state.view !== 'today') return
  const previousIndex = inboxItems.findIndex((item) => item.id === selectedInboxId)
  inboxItems = inboxPage.items
  inboxTotal = inboxPage.total
  const ids = new Set(inboxItems.map((item) => item.id))
  picked = new Set([...picked].filter((id) => ids.has(id)))
  if (!ids.has(selectedInboxId)) selectedInboxId = inboxItems[Math.max(0, Math.min(previousIndex, inboxItems.length - 1))]?.id || null

  const allNodes = await m.allNodes()
  if (seq !== renderSeq || state.view !== 'today') return
  cachedAllNodes = allNodes
  const themeNodes = allNodes.filter((node) => node.themeId === state.themeId)

  mid.append(h('div', { class: 'page today-page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '今日'),
      h('p', {}, '现在该做什么——不是你拥有什么。'),
    ),

    // ---- 自动归位提示
    lastAutoImport ? h('div', { class: 'auto-import-notice' },
      h('span', { class: 'auto-import-text' },
        `${lastAutoImport.count} 条新信息已归位`),
      h('span', { class: 'auto-import-sub', style: { color: 'var(--text-3)' } },
        '默认信任，例外修正'),
      h('span', { style: { flex: 1 } }),
      h('button', {
        class: 'btn', style: { height: '26px', fontSize: 'var(--t-body)' },
        onclick: async () => {
          if (lastAutoImport?.id) {
            await m.inboxUndoAutoImport(lastAutoImport.id)
            lastAutoImport = null
            await refresh()
            renderToday(mid)
          }
        },
      }, '撤销'),
    ) : null,

    /* 页面级状态：一行、次要色、等宽数字。同一批数字全页只出现一次——
       以前"待确认 4"在这里、在区块头、在统计卡、在页签里各出现一遍，读者要先做减法。 */
    h('p', { class: 'today-summary' },
      h('button', { type: 'button', class: 'today-summary-link', onclick: () => scrollTo(mid, 'inbox-section') },
        '待确认 ', h('b', {}, String(inboxTotal))),
      h('span', { class: 'today-summary-sep' }, '·'),
      h('button', { type: 'button', class: 'today-summary-link', onclick: () => scrollTo(mid, 'due-section') },
        '今日结算 ', h('b', {}, String(due.length))),
      /* 今日只分拣；交出去的数据在各主题建设者里判。这里给每个还有待判的主题一个入口。 */
      ...judgeEntries(judgeCounts).flatMap(({ themeId, total }) => [
        h('span', { class: 'today-summary-sep' }, '·'),
        h('button', {
          type: 'button', class: 'today-summary-link today-summary-judge', title: `去「${themeName(themeId)}」的建设者判`,
          onclick: () => openThemeBuilder(themeId),
        }, `${themeName(themeId)} 待判 `, h('b', {}, String(total))),
      ])),

    renderInboxWorkspace(mid, seq, allNodes),
    renderIgnoredProposals(ignored, allNodes),

    // ---- 到期未结算：没有到期项时只留一行提示，不再用空态撑起一整张卡
    due.length ? h('section', { class: 'card', id: 'due-section' },
      h('div', { class: 'card-h' },
        h('h2', {}, '到期未结算'),
        h('span', { class: 'spacer' }),
        h('em', {}, String(due.length)),
      ),
      h('div', { class: 'sect-b' },
        due.length ? due.map((q) => h('div', { class: 'q' },
          h('span', { class: 'dot', style: { background: confColor(q.confidence), marginTop: '6px' } }),
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text' }, q.title),
            h('div', { class: 'q-meta' },
              h('span', {}, `当时 ${Math.round(q.confidence)}`),
              h('span', {}, `· 到期 ${q.settlement.date}`),
              h('span', {}, `· ${nodePath(themeNodes, q.id) || '未归档'}`),
            ),
          ),
          h('div', { class: 'q-acts' },
            h('button', { class: 'btn btn-hit', onclick: async () => { await settleAndViewTheme(q.id, true); await renderToday(mid) } }, '对了'),
            h('button', { class: 'btn btn-miss', onclick: async () => { await settleAndViewTheme(q.id, false); await renderToday(mid) } }, '错了'),
            h('button', {
              class: 'btn', title: '推迟两周',
              onclick: async () => {
                const d = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)
                await m.updateNode(q.id, { settlement: { date: d, resolved: null, correct: null } })
                await renderToday(mid)
              },
            }, '再等等'),
          ),
        )) : null,
      ),
    ) : h('p', { class: 'today-empty-line' },
      h('b', {}, '到期未结算'), ' · 没有到期的问题。给命题设一个结算日，它就会回来找你。'),

    // ---- 冲突（静默标记，不强制裁决）
    conflicts.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' },
        h('h2', {}, '冲突'),
        h('span', { class: 'spacer' }),
        h('em', {}, String(conflicts.length)),
      ),
      h('div', { class: 'sect-b' },
        ...conflicts.slice(0, 5).map((c) => {
          const a = themeNodes.find((n) => n.id === c.a)
          const b = themeNodes.find((n) => n.id === c.b)
          return h('div', { class: 'q' },
            h('span', { class: 'cf', style: { marginTop: '6px' } }, '冲突'),
            h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { fontSize: 'var(--t-body)' } },
                a?.title || c.a, ' ↔ ', b?.title || c.b),
              h('div', { class: 'q-meta' },
                h('span', { style: { color: 'var(--text-3)' } }, c.note || '方向相反'),
              ),
            ),
          )
        }),
        conflicts.length > 5 ? h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', padding: '4px 0' } }, `+${conflicts.length - 5} 条`) : null,
      ),
    ) : null,

    // ---- 校准曲线详情
    h('section', { class: 'card' },
      h('div', { class: 'card-h' },
        h('h2', {}, '命题校准曲线'),
        // sparkline 归属到这一组——孤立在最右缘时它是个没有归属的装饰
        calib.length ? h('span', { class: 'calib-sig', title: '各信心档位的命中率' },
          ...calib.map((b) => h('i', { style: { height: `${b.accuracy * 100}%`, background: b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } })),
        ) : null,
        h('em', {}, calib.length ? `${calib.reduce((s, b) => s + b.total, 0)} 条已结算` : '尚无数据')),
      h('div', { class: 'sect-b' },
        calib.length
          ? h('div', { class: 'calib' }, ...calib.map((b) => h('div', {},
              h('em', {}, `${Math.round(b.accuracy * 100)}%`),
              h('i', { style: { height: `${b.accuracy * 100}%`, background: b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } }),
              h('span', {}, `${b.bucket}–${b.bucket + 9}`),
            )))
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '结算几条判断之后，这里会出现你的命中率曲线——这才是复利本身。'),
            )),
      ),
    ),
  ))
}

/** 有待判的存活主题，按主题列表顺序；counts 缺失 / 格式不对时为空。 */
function judgeEntries(response) {
  const counts = response?.ok ? response.counts : null
  if (!counts || typeof counts !== 'object') return []
  return (state.themes || [])
    .filter((theme) => !theme.deletedAt && Number(counts[theme.id]?.total) > 0)
    .map((theme) => ({ themeId: theme.id, total: Number(counts[theme.id].total) }))
}

/**
 * 逐条交给主题：先落账（inbox:dispatch，按条目幂等），成功后才接受条目（inbox:resolve，进同步 outbox）。
 * 一条失败不影响其余；失败的留在待确认里，重试不会重复计入。
 */
async function dispatchItems(chosen) {
  const outcome = { done: 0, proposals: 0, engineErrors: 0, themes: new Set(), failures: [] }
  for (const item of chosen) {
    try {
      const res = await m.inboxDispatch(item.id, memberThemeIds(item))
      if (!res?.ok) throw new Error(res?.error || '交给主题失败')
      await m.inboxResolve(item.id, 'accept')
      outcome.done += 1
      outcome.proposals += Number(res.stanceProposals) || 0
      if (res.engineError) outcome.engineErrors += 1
      for (const themeId of res.themeIds || []) outcome.themes.add(themeId)
      picked.delete(item.id)
    } catch (error) {
      outcome.failures.push(error?.message || String(error))
    }
  }
  return outcome
}

function dispatchResultToast({ done, proposals, engineErrors, themes, failures }) {
  if (!done) {
    toast(`交给主题失败：${failures[0] || '请重试'}`, 'var(--red)')
    return
  }
  const themeIds = [...themes]
  const where = themeIds.length === 1 ? `「${themeName(themeIds[0])}」` : ` ${themeIds.length} 个主题`
  const parts = [`${done} 条已交给${where}，进入建设者待判`]
  if (proposals) parts.push(`模型先给了 ${proposals} 条表态建议`)
  if (engineErrors) parts.push(`${engineErrors} 条模型没读成，按原文待判`)
  if (failures.length) parts.push(`${failures.length} 条失败：${failures[0]}`)
  toast(parts.join('；'), failures.length ? 'var(--orange)' : undefined,
    { label: '去判', onClick: () => openThemeBuilder(themeIds[0]) })
}

function renderIgnoredProposals(items, nodes) {
  if (!items.length) return null
  return h('details', { class: 'card ignored-proposals' },
    h('summary', {}, `已忽略的归位提议 · ${items.length} 条`),
    ...items.map((item) => {
      const promoted = nodes.find((node) => node.id === item.promotedTo)
      return h('details', { class: 'sect', dataset: { id: item.id }, style: { marginTop: '12px' } },
        h('summary', {}, item.title || '归位提议'),
        h('div', { class: 'q-meta' }, `建议主题：${item.matchedTheme?.name || '未指定'} · 忽略于 ${item.ignoredAt}`),
        h('div', { class: 'q-meta' }, `匹配标签：${(item.matchedTags || []).map((tag) => tag.name).join('、') || '无'}`),
        h('p', { class: 'inbox-original-text' }, item.text || '没有附带原文。'),
        ...(item.lemmas || []).map((lemma) => h('p', {}, lemma.title)),
        item.promotedTo ? h('div', { class: 'q-meta' }, `后来入图：${promoted?.title || '目标已不存在'} · ${item.promotedAt || ''}`) : null,
      )
    }),
  )
}

function renderInboxWorkspace(mid, seq, allNodes) {
  const items = inboxItems
  const liveThemes = state.themes.filter((t) => !t.deletedAt)

  /* 区块级摘要：只放"次要"的两个数（已抽取 / 已归位），主数（待确认）在页面级那一行。
     12px 次要色 + 等宽数字，不再是大号彩色数字。 */
  const statPending = h('b', {}, '…')
  const statLemmas = h('b', {}, '…')
  const statResolved = h('b', {}, '…')
  const statsRow = h('span', { class: 'inbox2-summary' },
    h('span', {}, '已抽取要点 ', statLemmas),
    h('span', { class: 'inbox2-summary-sep' }, '·'),
    h('span', {}, '已归位 ', statResolved))
  m.inboxStats?.().then((s) => {
    if (!s) return
    statPending.textContent = String(s.pending ?? '—')
    statLemmas.textContent = String(s.lemmas ?? '—')
    statResolved.textContent = String(s.resolved ?? '—')
  }).catch(() => {})

  // ---- 主题筛选 pills（对齐设计稿：全部主题黑底白字 + 各主题圆点）----
  const themeFilterRow = h('div', { class: 'inbox2-theme-filter' },
    h('span', { class: 'inbox2-filter-label' }, '主题筛选'),
    h('button', {
      type: 'button',
      class: `inbox2-theme-pill${inboxThemeFilter === null ? ' is-active' : ''}`,
      onclick: () => { inboxThemeFilter = null; renderToday(mid) },
    }, '全部主题'),
    ...liveThemes.map((t) => h('button', {
      type: 'button',
      class: `inbox2-theme-pill${inboxThemeFilter === t.id ? ' is-active' : ''}`,
      onclick: () => { inboxThemeFilter = inboxThemeFilter === t.id ? null : t.id; renderToday(mid) },
    }, h('i', { class: 'inbox2-dot', style: { background: themeDotColor(t.id) } }), t.name)),
  )

  // ---- 状态页签（对齐设计稿：圆角矩形，选中白底）----
  const countAll = items.length
  const countPending = items.filter((i) => i.extracted === false).length
  const countDone = items.filter((i) => i.extracted !== false).length
  const statusTabs = h('div', { class: 'inbox2-status-tabs' },
    ...[['all', '全部', countAll], ['pending', '待抽取', countPending], ['done', '已抽取', countDone]].map(([key, label, n]) =>
      h('button', {
        type: 'button',
        class: `inbox2-status-tab${inboxStatusFilter === key ? ' is-active' : ''}`,
        onclick: () => { inboxStatusFilter = key; renderToday(mid) },
      }, label, h('span', { class: 'inbox2-tab-count' }, String(n)))),
  )

  // 按筛选过滤列表（不改变 items 本体，只影响展示）
  const visibleItems = items.filter((item) => {
    if (inboxThemeFilter && !memberThemeIds(item).includes(inboxThemeFilter)) return false
    if (inboxStatusFilter === 'pending' && item.extracted !== false) return false
    if (inboxStatusFilter === 'done' && item.extracted === false) return false
    return true
  })

  const section = h('section', { class: 'card inbox-workspace inbox2', id: 'inbox-section' },
    h('div', { class: 'card-h inbox-workspace-head' },
      h('h2', {}, '待确认'),
      h('span', { class: 'spacer' }), statsRow,
    ),
    themeFilterRow,
    statusTabs,
    inboxLoading ? h('div', { class: 'inbox-capture-status', role: 'status' },
      h('span', { class: 'hud-dot' }), '正在解析新内容，你可以继续审阅其他信息。') : null,
  )
  if (!items.length) {
    section.append(h('div', { class: 'inbox-empty-state' },
      icon('lattice', 28), h('strong', {}, '待确认已清空'),
      h('p', {}, '复制原文或链接，点击侧栏「捕获」或按 ⌘⇧V。自己的判断可以直接在树里记录。'),
    ))
    return section
  }

  const list = h('div', { class: 'inbox-list enter-stagger', role: 'group', 'aria-label': '待确认信息列表' })
  const detail = h('section', { class: 'inbox-detail', id: 'inbox-detail', 'aria-labelledby': 'inbox-detail-title' })
  const count = h('span')
  /* 批量语义提示：哪些选中项已经绑过主题——用户问的就是"都绑定了为什么还要我选主题" */
  const assignNote = h('span', { class: 'inbox-batch-note', hidden: true })
  const linkNote = h('span', { class: 'inbox-batch-note is-warn', hidden: true })
  // 复选框全开：分拣语义是"选中这批处理"，批量栏按选中成分自适应可用操作。
  // 有主题、有原文的 → 交给主题；未抽取的 → 抽取所选（只为让系统猜主题）；任何选中项 → 忽略所选。
  const isSelectable = (item) => !resolving.has(item.id)
  const pickedItems = () => items.filter((item) => picked.has(item.id))
  const dispatchablePicked = () => pickedItems().filter((item) => !dispatchBlocker(item))
  const extractablePicked = () => pickedItems().filter((item) => item.extracted === false)
  const pickAll = h('button', {
    class: 'btn inbox-pick-all',
    onclick: () => {
      const available = items.filter(isSelectable)
      const allPicked = available.every((item) => picked.has(item.id))
      for (const item of available) allPicked ? picked.delete(item.id) : picked.add(item.id)
      updateBatch()
    },
  })
  const dispatchPicked = h('button', {
    class: 'btn btn-primary inbox-dispatch-picked',
    onclick: () => resolve(dispatchablePicked(), 'dispatch'),
  }, '交给主题')
  // 批量抽取主题选择器：默认「自动」（要点最多的主题）；手动指定后，
  // 本次抽取的条目都记到该主题下，后续入库跟着条目自己的主题走。
  // （liveThemes 已在函数顶部定义）
  const extractThemePick = h('select', {
    class: 'inbox-extract-theme', title: '抽取主题：默认自动（要点最多的主题），可手动指定',
  }, h('option', { value: '' }, '自动主题'),
    ...liveThemes.map((t) => h('option', { value: t.id, title: t.name }, t.name)))
  const extractPicked = h('button', {
    class: 'btn inbox-extract-picked',
    onclick: () => resolve(extractablePicked(), 'extract'),
  }, '抽取所选')
  const ignorePicked = h('button', {
    class: 'btn inbox-ignore-picked',
    onclick: () => resolve(items.filter((item) => picked.has(item.id)), 'reject'),
  }, '忽略所选')
  // 批量分配到主题：多主题模型下，所选项"加入"该主题（已含则跳过）
  const assignThemePick = h('select', {
    class: 'inbox-assign-theme', title: '分配到主题：所选项将加入该主题（多选）',
  }, h('option', { value: '' }, '选择主题…'),
    ...liveThemes.map((t) => h('option', { value: t.id, title: t.name }, t.name)))
  const assignPicked = h('button', {
    class: 'btn inbox-assign-picked',
    onclick: async () => {
      const tid = assignThemePick.value
      if (!tid) { toast('请先选择要分配到的主题', 'var(--red)'); return }
      // 多主题：只处理尚未包含该主题的条目（加入而非覆盖）
      const targets = items.filter((item) => picked.has(item.id) && !memberThemeIds(item).includes(tid))
      if (!targets.length) { toast('所选项都已包含该主题，不需要再分配'); return }
      assignPicked.disabled = true
      let okCount = 0
      for (const item of targets) {
        try {
          const nextTids = [...memberThemeIds(item), tid]
          const res = await m.inboxSetThemes(item.id, nextTids)
          if (res?.ok) {
            item.extractedThemeIds = res.themeIds
            item.extractedThemeId = res.themeIds[0] || null
            okCount++
          }
        } catch { /* 单条失败继续 */ }
      }
      toast(okCount === targets.length
        ? `已分配 ${okCount} 条到「${themeName(tid)}」`
        : `已分配 ${okCount}/${targets.length} 条到「${themeName(tid)}」，${targets.length - okCount} 条失败`)
      picked.clear()
      assignPicked.disabled = false
      await refresh()
    },
  }, '分配到主题')

  function updateBatch() {
    const available = items.filter(isSelectable)
    pickAll.textContent = available.length && available.every((item) => picked.has(item.id)) ? '取消全选' : '全选'
    pickAll.disabled = !available.length
    const dispatchable = dispatchablePicked()
    const extractable = extractablePicked()
    count.textContent = `已选 ${picked.size} 条`
    // 渐进式披露：没选中时底部栏只是状态条，不跟详情的「交给主题」抢主操作；
    // 选中后按成分出现对应批量入口，按钮带数字，一眼知道作用范围。
    dispatchPicked.hidden = !dispatchable.length
    dispatchPicked.textContent = `交给主题（${dispatchable.length}）`
    dispatchPicked.disabled = !dispatchable.length || dispatchable.some((item) => resolving.has(item.id))
    extractPicked.hidden = !extractable.length
    extractPicked.textContent = `抽取所选（${extractable.length}）`
    extractPicked.disabled = !extractable.length || extractable.some((item) => resolving.has(item.id))
    extractThemePick.hidden = !extractable.length
    ignorePicked.hidden = !picked.size
    ignorePicked.textContent = `忽略所选（${picked.size}）`
    ignorePicked.disabled = !picked.size || [...picked].some((id) => resolving.has(id))
    // 批量分配：只有"还没属于任何主题"的选中项才需要选主题；已属于的一律不再要求重选。
    const chosen = pickedItems().filter((item) => item.kind !== 'reading')
    const boundPicked = chosen.filter((item) => memberThemeIds(item).length)
    const unboundPicked = chosen.filter((item) => !memberThemeIds(item).length)
    const boundNames = [...new Set(boundPicked.flatMap((item) => memberThemeIds(item).map(themeName)))]
    const missingLink = chosen.filter((item) => !itemSourceUrl(item))
    linkNote.hidden = !missingLink.length
    linkNote.textContent = missingLink.length ? `${missingLink.length} 条缺来源链接，逐条点开补上后才能交给主题` : ''
    assignThemePick.hidden = !unboundPicked.length
    assignPicked.hidden = !unboundPicked.length
    assignPicked.textContent = `分配到主题（${unboundPicked.length}）`
    assignPicked.disabled = !unboundPicked.length || unboundPicked.some((item) => resolving.has(item.id))
    assignNote.hidden = !boundPicked.length
    assignNote.textContent = boundPicked.length
      ? (unboundPicked.length
        ? `其中 ${boundPicked.length} 条已归入「${boundNames.join('、')}」，只会给剩下 ${unboundPicked.length} 条分配。`
        : `所选中 ${boundPicked.length} 条已归入「${boundNames.join('、')}」，不需要再选主题。`)
      : ''
    // 抽取主题同理：选中的都绑好了就不需要再指定
    extractThemePick.hidden = !extractable.length || !extractable.some((item) => !memberThemeIds(item).length)
    for (const row of list.querySelectorAll('.inbox-item')) {
      const item = items.find((entry) => entry.id === row.dataset.id)
      if (!item) continue
      row.dataset.on = String(picked.has(item.id))
      row.querySelector('.inbox-ck').checked = picked.has(item.id)
      row.querySelector('.inbox-ck').disabled = !isSelectable(item)
    }
  }

  function select(id) {
    selectedInboxId = id
    for (const row of list.querySelectorAll('.inbox-item')) {
      const selected = row.dataset.id === id
      row.dataset.sel = String(selected)
      row.querySelector('.inbox-body').setAttribute('aria-pressed', String(selected))
    }
    renderInboxDetail(detail, items.find((item) => item.id === id), allNodes, resolve, updateBatch, () => select(id))
  }

  async function resolve(chosen, action) {
    if (!chosen.length || chosen.some((item) => resolving.has(item.id))) return
    if (action === 'dispatch') {
      const blocked = chosen.find((item) => dispatchBlocker(item))
      if (blocked) { toast(dispatchBlocker(blocked), 'var(--red)'); return }
    }
    for (const item of chosen) resolving.add(item.id)
    updateBatch()
    select(selectedInboxId)
    try {
      if (action === 'dispatch') {
        dispatchResultToast(await dispatchItems(chosen))
      } else if (action === 'extract') {
        const themeId = extractThemePick.value || undefined
        const res = await runExtract(chosen.map((item) => item.id), themeId)
        for (const item of chosen) picked.delete(item.id)
        extractResultToast(res)
      } else {
        if (chosen.length === 1) {
          await m.inboxResolve(chosen[0].id, 'reject')
          toast(chosen[0].kind === 'route-proposal' ? '已忽略归位提议，可在下方展开查看。' : '已忽略这条信息')
        } else {
          const res = await m.inboxResolveMany(chosen.map((item) => item.id), 'reject')
          toast(`已忽略 ${res?.resolved?.length ?? chosen.length} 条`)
        }
        for (const item of chosen) picked.delete(item.id)
      }
    } catch (e) {
      toast('处理失败：' + (e.message || '请重试'), 'var(--red)')
    } finally {
      for (const item of chosen) resolving.delete(item.id)
      await refresh()
    }
  }

  // ---- 抽取进度反馈：后端逐条 emit inbox:extract:progress，前端定点修补 ----
  function ensureExtractSubscription() {
    if (extractUnsub || typeof m.onInboxExtractProgress !== 'function') return
    extractUnsub = m.onInboxExtractProgress((p) => {
      if (!p || !extractActive) return
      if (p.phase === 'start') {
        extractDone = 0
        extractTotal = p.total
        paintExtractProgress(0, p.total)
        return
      }
      if (p.phase === 'done') return // 收尾走 IPC 返回 + db:changed 整页刷新
      extracting.delete(p.itemId)
      extractDone = p.done
      paintExtractProgress(p.done, p.total)
      // 被清空/忽略的条目后端会跳过（skipped）：不画失败徽标，行随整批结束重排
      if (!p.skipped) paintExtractRow(p.itemId, p.ok)
    })
  }
  /** 「抽取中」分组头：进度条 + 取消按钮（替代此前的悬浮 toast，一个真相源） */
  function extractingGroupHead() {
    return h('div', { class: 'inbox-group-head extracting-head' },
      h('span', { class: 'inbox-group-label' }, '抽取中'),
      h('span', { class: 'extract-progress-text' }, `正在抽取 ${extractDone}/${extractTotal}`),
      h('span', { class: 'extract-progress-track' }, h('span', {
        class: 'extract-progress-fill',
        style: { width: extractTotal ? `${Math.round((extractDone / extractTotal) * 100)}%` : '0%' },
      })),
      h('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true
          e.target.textContent = '取消中…'
          try { await m.inboxExtractCancel() } catch { /* 后端无该命令时静默 */ }
        },
      }, '取消'),
    )
  }
  function paintExtractProgress(done, total) {
    const head = document.querySelector('.extracting-head')
    if (!head) return
    const text = head.querySelector('.extract-progress-text')
    if (text) text.textContent = `正在抽取 ${done}/${total}`
    const fill = head.querySelector('.extract-progress-fill')
    if (fill) fill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%'
  }
  function paintExtractRow(itemId, ok) {
    const meta = document.querySelector(`.inbox-item[data-id="${itemId}"] .inbox-meta`)
    if (!meta) return
    meta.querySelector('.extracting')?.remove()
    meta.append(h('span', { class: ok ? 'extract-ok' : 'extract-fail' }, ok ? '已抽取 ✓' : '抽取失败'))
  }
  // 三个抽取入口共用：批量栏「抽取所选」、「抽取这 N 条」、未匹配组抽取
  async function runExtract(ids, themeId) {
    const targets = ids.filter((id) => !extracting.has(id))
    if (extractActive) return { ok: false, error: 'extract-in-progress' }
    if (!targets.length) return { ok: true, extracted: 0, total: 0 }
    extractActive = true
    extractDone = 0
    extractTotal = targets.length
    for (const id of targets) extracting.add(id)
    ensureExtractSubscription()
    // 立刻重排：「抽取中」分组出现、组头进度条就位（行内徽标由重渲染按 extracting 集合带出）
    await refresh()
    await renderToday(mid)
    try {
      return await m.inboxExtract(targets, themeId)
    } finally {
      extractActive = false
      extracting.clear()
      // db:changed 会触发整页刷新收尾：「抽取中」分组消失，条目各归其位
    }
  }
  function extractResultToast(res) {
    if (!res) return
    if (res.error === 'extract-in-progress') { toast('抽取已在进行中，稍等一下', 'var(--red)'); return }
    if (res.error) { toast('抽取失败：' + res.error, 'var(--red)'); return }
    toast(res.cancelled ? `已取消，已抽取 ${res.extracted} 条` : (res.extracted ? `已抽取 ${res.extracted} 条` : '没有可抽取的条目'))
  }

  // 四态分组（在筛选后的可见条目上分组）
  const extractingItems = visibleItems.filter((item) => extracting.has(item.id))
  const extractedItems = visibleItems.filter((item) => item.extracted !== false && !extracting.has(item.id))
  const waitItems = visibleItems.filter((item) => item.extracted === false && item.matchScore > 0 && !extracting.has(item.id))
  const unmatchedItems = visibleItems.filter((item) => item.extracted === false && !(item.matchScore > 0) && !extracting.has(item.id))
  const groupHead = (label, n, caption, actions = []) => h('div', { class: 'inbox-group-head' },
    h('span', { class: 'inbox-group-label' }, label),
    h('span', { class: 'inbox-group-count' }, String(n)),
    caption && !actions.length ? h('span', { class: 'inbox-group-caption' }, caption) : null,
    h('span', { style: { flex: 1 } }),
    ...actions,
  )
  const extractAll = h('button', {
    class: 'btn', disabled: inboxLoading,
    onclick: async () => {
      extractAll.disabled = true
      const res = await runExtract(waitItems.map((item) => item.id))
      extractAll.disabled = false
      extractResultToast(res)
      await refresh()
      await renderToday(mid)
    },
  }, `抽取这 ${waitItems.length} 条`)
  const clearUnmatched = h('button', {
    class: 'btn',
    onclick: async () => {
      // 抽取中的条目不受影响：后端按 exceptIds 排除
      const spared = [...extracting]
      const clearRes = await m.inboxClearUnextracted(spared)
      const removed = typeof clearRes === 'number' ? clearRes : (clearRes?.removed ?? 0)
      toast(spared.length ? `已清空 ${removed} 条未匹配（抽取中的 ${spared.length} 条不受影响）` : `已清空 ${removed} 条未匹配`)
      await refresh()
      await renderToday(mid)
    },
  }, '清空未匹配')
  // 未匹配组 previously 只有"清空"：内容留着但没有变有价值的路径。
  // 与待抽取组对称，给抽取入口（forceExtract 越过标签库闸门）。
  const extractUnmatched = h('button', {
    class: 'btn', disabled: inboxLoading,
    onclick: async () => {
      extractUnmatched.disabled = true
      const res = await runExtract(unmatchedItems.map((item) => item.id))
      extractUnmatched.disabled = false
      extractResultToast(res)
      await refresh()
      await renderToday(mid)
    },
  }, `抽取这 ${unmatchedItems.length} 条`)

  let staggerIdx = 0
  const appendItems = (group, opts = {}) => {
    if (!group.length) return
    if (opts.head) list.append(opts.head)
    for (const item of group) {
      const el = renderInboxItem(item, () => select(item.id), (checked) => {
        checked ? picked.add(item.id) : picked.delete(item.id)
        updateBatch()
      }, (direction) => {
        const next = group[Math.max(0, Math.min(group.length - 1, group.indexOf(item) + direction))]
        select(next.id)
        const row = [...list.querySelectorAll('.inbox-item')].find((el) => el.dataset.id === next.id)
        row.querySelector('.inbox-body').focus({ preventScroll: true })
        row.scrollIntoView({ block: 'nearest' })
      }, isSelectable(item))
      el.style.setProperty('--i', staggerIdx++)
      list.append(el)
    }
  }

  appendItems(extractingItems, { head: extractingGroupHead() })
  appendItems(extractedItems, { head: groupHead('已抽取', extractedItems.length, '选好主题，交给建设者去判') })
  appendItems(waitItems, { head: groupHead('待抽取', waitItems.length, null, [extractAll]) })
  appendItems(unmatchedItems, { head: groupHead('未匹配', unmatchedItems.length, null, [extractUnmatched, clearUnmatched]) })

  // 设计稿区分两种空：一条都没有（上面已处理）与"当前筛选下没有"。
  // 后者以前是白板，看起来像加载失败或数据没了。
  if (!visibleItems.length) {
    list.append(h('div', { class: 'inbox-empty-state', role: 'status' },
      h('strong', {}, '这里没有条目'),
      h('p', {}, '试试切换筛选或主题。'),
    ))
  }

  // 分页：只渲染前 inboxLimit 条。全量渲染时上千条 DOM 本身就是卡顿源。
  const remaining = Math.max(0, inboxTotal - inboxItems.length)
  const loadMore = remaining > 0 ? h('button', {
    class: 'btn inbox-load-more',
    onclick: async () => {
      // 不能动 e.target——renderToday 会清空重画，那时按钮已经不在 DOM 里
      const page = await m.inboxList({ limit: inboxLimit, offset: inboxItems.length })
      if (seq === renderSeq && state.view === 'today') {
        inboxItems = [...inboxItems, ...page.items]
        await renderToday(mid)
      }
    },
  }, `还有 ${remaining} 条待确认 · 加载更多`) : null

  section.append(h('div', { class: 'inbox-split' },
    h('div', { class: 'inbox-list-pane' },
      h('div', { class: 'inbox-list-toolbar' }, h('span', {}, '信息列表 · ↑↓ 切换'), pickAll),
      list,
      loadMore,
      h('div', { class: 'inbox-import-bar' }, count, linkNote, assignNote, extractThemePick, extractPicked, assignThemePick, assignPicked, dispatchPicked, ignorePicked),
    ),
    detail,
  ))
  updateBatch()
  /* 当前筛选下没有可见条目时不要继续显示被筛掉那条的详情——列表说"没有"、右边却摊着
     一条记录，用户会以为筛选没生效。 */
  if (visibleItems.length) select(selectedInboxId)
  else renderInboxDetail(detail, null, allNodes, resolve, updateBatch, () => select(selectedInboxId))
  return section
}

function renderInboxItem(item, onSelect, onPick, onNavigate, pickable = true) {
  const lemmas = item.lemmas || []
  const title = item.title || lemmas[0]?.title || '未命名信息'
  /* 选了主题只是分拣的一半（还没交出去），所以不弱化；主题 pills 与详情「属于主题」同一来源。
     勾选高亮由 updateBatch 写的 data-on 驱动（样式见 demo-components.css 末尾）。 */
  const liveThemes = (state.themes || []).filter((t) => !t.deletedAt)
  const itemThemes = memberThemeIds(item).map((tid) => liveThemes.find((t) => t.id === tid)).filter(Boolean)
  // 相对时间：设计稿显示"33 分钟前"；createdAt 是 ISO 字符串
  const relTime = relativeTime(item.createdAt)
  const extracted = item.extracted !== false
  const missingLink = item.kind !== 'reading' && !itemSourceUrl(item)
  return h('div', { class: 'inbox-item inbox2-item lift-hover enter-item sel-group', dataset: { id: item.id } },
    h('span', { class: 'sel-bar', 'aria-hidden': 'true' }),
    h('input', {
      type: 'checkbox', class: 'inbox-ck', 'aria-label': `选择 ${title}`,
      disabled: !pickable,
      onchange: (e) => onPick(e.target.checked),
    }),
    h('button', {
      class: 'inbox-body', 'aria-controls': 'inbox-detail', onclick: onSelect,
      onkeydown: (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
        e.preventDefault()
        onNavigate(e.key === 'ArrowDown' ? 1 : -1)
      },
    },
      // 第一行：来源（左）+ 时间（右）
      h('span', { class: 'inbox2-item-top' },
        h('span', { class: 'inbox2-item-source' }, item.label?.kind || item.provenance?.platform || '未标注来源'),
        h('time', { class: 'inbox2-item-time' }, relTime || item.createdAt?.slice(5, 16) || ''),
      ),
      // 标题（选中项蓝色由 CSS [data-sel="true"] 控制）
      h('span', { class: 'inbox2-item-title' }, title),
      // 主题标签 pills + 跨主题徽标
      itemThemes.length ? h('span', { class: 'inbox2-item-themes' },
        ...itemThemes.map((t) => h('span', { class: 'inbox2-theme-tag' },
          h('i', { class: 'inbox2-dot', style: { background: themeDotColor(t.id) } }), t.name)),
        itemThemes.length > 1 ? h('span', { class: 'inbox2-cross-badge' }, `跨 ${itemThemes.length} 个主题`) : null,
      ) : null,
      // 状态徽标：已抽取 N 条要点（绿）/ 未提取到要点（橙）
      h('span', { class: 'inbox2-item-status' },
        extracted
          ? h('span', { class: 'inbox2-badge is-ok' }, `✓ 已抽取 ${lemmas.length} 条要点`)
          : h('span', { class: 'inbox2-badge is-warn' }, '⚠ 未提取到要点'),
        missingLink ? h('span', { class: 'inbox2-badge is-nolink', title: '外部数据必须带真实的来源链接；补上后才能交给主题' }, '缺来源链接') : null,
        lemmas.some((lemma) => lemma.action === 'merge') ? h('span', { class: 'feed-dup' }, '可合并') : null,
        lemmas.some((lemma) => lemma.conflicts?.length) ? h('span', { class: 'cf' }, '有冲突') : null,
        resolving.has(item.id) ? h('span', {}, '处理中…') : null,
        extracting.has(item.id) ? h('span', { class: 'extracting' }, '抽取中…') : null,
      ),
    ),
  )
}

function unextractedNote(item) {
  if (item.skipped === 'low-quality') return '来源质量低于闸门，留档不抽取。'
  if (item.matchScore > 0) return `标签库命中 ${item.matchScore.toFixed(2)}，未达该标签阈值，留档不抽取。`
  return '标签库没有命中，留档不抽取。'
}

/**
 * 详情「来源」：外部数据必须指向真实的来源网页。有链接 → 显示域名、可打开、可改；没有 → 就地补上。
 * 链接由后端 inbox:setSourceUrl 按同一口径校验后写入；这里先做一次同口径的即时校验，省一次往返。
 * 下方给出进主题时的建议权重（来源类型 × 硬度），让分拣时就知道这条数据大概多重。
 */
function renderSourceSection(item, { busy, onSaved }) {
  if (item.kind === 'reading') return null
  const url = itemSourceUrl(item)
  const suggestion = suggestWeight({
    url: url || '', labelType: item.label?.kind || '', sourceLabel: item.provenance?.sourceLabel || '', text: item.text || '',
  })
  const weightNote = h('p', { class: 'inbox-detail-note inbox-weight-note' },
    `进主题时的建议权重 ${weightText(suggestion.weight)} = ${weightFormula(suggestion.weight)}（来源类型${SOURCE_VIA_LABEL[suggestion.sourceVia]}）。`,
    '模型拆出的单句按各自有没有具体数字算硬度；建设者判的时候可以改。')
  const input = h('input', {
    class: 'txt inbox-source-input', type: 'url', maxlength: '2048', value: url || '',
    placeholder: 'https://…（原文所在网页的网址）', 'aria-label': '来源链接', disabled: busy,
  })
  const error = h('p', { class: 'inbox-source-error', role: 'alert', hidden: true })
  const save = h('button', { type: 'button', class: 'btn btn-primary inbox-source-save', disabled: busy }, url ? '保存' : '补上链接')
  const editor = h('div', { class: 'inbox-source-editor', hidden: Boolean(url) }, input, save)
  const showError = (message) => {
    error.hidden = false
    error.textContent = message
  }
  const submit = async () => {
    const checked = checkSourceUrl(input.value)
    if (!checked.ok) { showError(`来源链接不可用：${checked.error}`); input.focus(); return }
    save.disabled = true
    try {
      const res = await m.inboxSetSourceUrl(item.id, checked.url)
      if (!res?.ok) throw new Error(res?.error || '保存失败')
      item.provenance = res.provenance
      toast(url ? '来源链接已更新' : '已补上来源链接')
      onSaved()
    } catch (err) {
      save.disabled = false
      showError(err?.message || String(err))
    }
  }
  save.addEventListener('click', submit)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit() }
  })
  const current = url
    ? h('div', { class: 'inbox-source-current' },
      h('span', { class: 'inbox-source-host', title: url }, sourceHostOf(url)),
      h('button', { type: 'button', class: 'btn inbox-source-link', onclick: () => m.openExternal(url) }, icon('export', 12), '打开原文'),
      h('button', {
        type: 'button', class: 'btn inbox-source-edit', disabled: busy,
        onclick: (event) => { editor.hidden = false; event.currentTarget.hidden = true; input.focus() },
      }, '改链接'))
    : h('p', { class: 'inbox-source-missing' }, item.provenance?.url
      ? `记下的链接不可用（${checkSourceUrl(item.provenance.url).error}）：外部数据必须指向真实的来源网页，补上后才能交给主题。`
      : '缺来源链接：外部数据必须指向真实的来源网页，补上后才能交给主题。')
  return h('section', { class: `inbox-detail-section inbox-source${url ? '' : ' is-missing'}` },
    h('h4', { class: 'inbox-section-title' }, '来源'),
    current, editor, error, weightNote)
}

function renderInboxDetail(panel, item, allNodes, onResolve, onRouteChange, rerender) {
  clear(panel)
  /* 没有选中项时给占位，而不是让详情列空白（也兜住"当前筛选把选中项滤掉了"这种情形）。 */
  if (!item) {
    panel.append(h('div', { class: 'inbox-empty-state', role: 'status' },
      h('strong', {}, '选择一条数据查看详情'),
      h('p', {}, '左侧列表按捕获时间排列，↑↓ 可以切换。'),
    ))
    return
  }
  // 今日只分拣：决定这条数据属于哪些主题（或忽略）。表态（佐证 / 反对 / 中立）在各主题建设者里判。
  const unextracted = item.extracted === false
  const lemmas = item.lemmas || []
  const label = item.label || {}
  const busy = resolving.has(item.id)
  const liveThemes = state.themes.filter((t) => !t.deletedAt)
  const members = memberThemeIds(item)
  const blocker = dispatchBlocker(item)
  const dispatch = item.kind === 'reading' ? null : h('button', {
    class: 'btn btn-primary inbox-dispatch', disabled: busy || Boolean(blocker),
    title: blocker || `第一个主题「${themeName(members[0])}」由模型先给表态建议，其余主题按原文待判`,
    onclick: () => onResolve([item], 'dispatch'),
  }, members.length > 1 ? `交给 ${members.length} 个主题` : '交给主题')
  // ---- 属于主题 pills：多选 toggle（点击加入/移除主题），顺序即交出去时的主次
  const currentTids = new Set(members)
  const belongPills = h('div', { class: 'inbox2-belong-pills' },
    h('span', { class: 'inbox2-belong-label' }, '属于主题'),
    ...liveThemes.map((t) => {
      const isMember = currentTids.has(t.id)
      return h('button', {
        type: 'button',
        class: `inbox2-belong-pill${isMember ? ' is-current' : ' is-add'}`,
        /* 柔和色调：同一语义色 14% 底 + 该色文字。实底白字会和主按钮抢强调。 */
        style: isMember ? { background: `color-mix(in srgb, ${themeDotColor(t.id)} 14%, transparent)`, color: themeDotColor(t.id) } : {},
        title: isMember ? `已属于「${t.name}」（点击移除）` : `加入「${t.name}」`,
        disabled: busy,
        onclick: async () => {
          if (busy) return
          // toggle：已在则移除，不在则加入
          const nextTids = memberThemeIds(item)
          const idx = nextTids.indexOf(t.id)
          if (idx >= 0) nextTids.splice(idx, 1)
          else nextTids.push(t.id)
          try {
            const res = await m.inboxSetThemes(item.id, nextTids)
            if (res?.ok) {
              item.extractedThemeIds = res.themeIds
              // 向后兼容：同步 extractedThemeId
              item.extractedThemeId = res.themeIds[0] || null
              toast(isMember ? `已从「${t.name}」移除` : `已加入「${t.name}」`)
              rerender ? rerender() : onRouteChange()
            } else toast('更新主题失败：' + (res?.error || '请重试'), 'var(--red)')
          } catch (err) { toast('更新主题失败：' + (err.message || '请重试'), 'var(--red)') }
        },
      }, isMember
        ? [h('i', { class: 'inbox2-dot is-white' }), t.name]
        : `+ ${t.name}`)
    }),
  )
  panel.append(
    h('header', { class: 'inbox-detail-head inbox2-head' },
      // 来源 · 时间（小字灰色，对齐设计稿）
      h('div', { class: 'inbox2-kicker' }, item.provenance?.platform || label.kind || '未标注来源', ' · ',
        relativeTime(item.createdAt) || item.createdAt || '时间未记录'),
      // 大标题
      h('h3', { class: 'inbox2-title', id: 'inbox-detail-title', title: item.title || lemmas[0]?.title || '未命名信息' }, item.title || lemmas[0]?.title || '未命名信息'),
      // 属于主题 pills 行（读数挂指标，不分主题）
      item.kind === 'reading' ? null : belongPills,
      // 提示文案（小字灰色）
      h('p', { class: 'inbox2-hint' }, item.kind === 'reading'
        ? '读数不交给主题：在下方选一个指标挂上去。'
        : '点主题标签选这条数据属于哪些主题。交出去后它进入这些主题建设者的「待判」：第一个主题由模型先给表态建议，其余主题按原文待判。'),
      h('div', { class: 'inbox-detail-meta' },
        typeof label.quality === 'number' ? h('span', {}, `来源质量 ${Math.round(label.quality * 100)}%`) : null,
      ),
    ),
    h('div', { class: 'inbox-detail-scroll' },
      renderSourceSection(item, {
        busy,
        onSaved: () => {
          document.querySelector(`.inbox-item[data-id="${CSS.escape(item.id)}"] .inbox2-badge.is-nolink`)?.remove()
          onRouteChange()
          rerender?.()
        },
      }),
      item.kind === 'route-proposal' ? h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '系统建议归位'),
        h('p', { class: 'inbox-detail-note' }, `主题：${item.matchedTheme?.name || '未指定'} · 标签：${(item.matchedTags || []).map((tag) => tag.name).join('、') || '无'}`),
      ) : null,
      // 待归位的读数：四个来源共用收件箱后，它们和捕获来的文本并排等裁决。
      // 要做的决定只有一个——这条数字挂到哪个指标上。
      item.kind === 'reading' ? h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '待归位的读数'),
        h('div', { class: 'inbox-reading-value' },
          h('b', {}, `${(item.reading?.value ?? '—').toLocaleString('en-US', { maximumFractionDigits: 8 })} ${item.reading?.unit || ''}`),
          trustMark(item.reading),
        ),
        h('p', { class: 'inbox-detail-note' },
          `${periodLabel(item.reading)} · ${item.reading?.basis === 'estimated' ? '估算' : '已披露'} · ${({ structured: '结构化', 'local-llm': '模型解读', agent: '外部提供' })[item.reading?.tier] || '来路未记录'}`),
        h('p', { class: 'inbox-detail-note' }, '这条读数没能自动匹配到指标节点。选一个指标挂上去，它就会进入该指标的历史序列。'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
          ...state.nodes
            .filter((n) => n.type === 'observation' && n.status !== 'dead')
            .map((n) => h('button', {
              class: 'btn',
              onclick: async (e) => {
                e.currentTarget.disabled = true
                try {
                  await m.assignReading(item.readingId, n.id)
                  toast(`已挂到「${n.title}」`)
                  await refresh()
                } catch { toast('归位失败，请重试', 'var(--red)'); e.currentTarget.disabled = false }
              },
            }, n.title)),
        ),
        state.nodes.some((n) => n.type === 'observation' && n.status !== 'dead') ? null
          : h('p', { class: 'inbox-detail-note' }, '这个主题下还没有指标节点。去脉络页把某条命题的类型改成「观测」，它就能接读数。'),
      ) : null,
      h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '原文'),
        h('p', { class: 'inbox-original-text' }, item.text || '这条信息没有附带原文。'),
      ),
      unextracted ? h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '未抽取'),
        h('p', { class: 'inbox-detail-note' }, unextractedNote(item)),
        h('p', { class: 'inbox-detail-note' }, '不抽取也能交给主题：选好主题直接交，建设者按原文判。抽取只是让系统先猜主题、列出要点。'),
      ) : h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, `要点 · ${lemmas.length}`),
        lemmas.length
          ? h('div', { class: 'prop-list' },
            ...lemmas.map((lemma) => h('div', { class: 'prop' }, h('div', { class: 'prop-text' }, lemma.title || '未命名要点'))))
          : h('p', { class: 'inbox-detail-note' }, '没有提取到要点；原文照样可以交给主题，或者忽略。'),
        lemmas.length ? h('p', { class: 'inbox-detail-note' }, '交出去后，要点跟着原文进主题，在建设者的判卡和读者页的数据详情里作为上下文出现；表态仍按原文在建设者里判。') : null,
      ),
    ),
    h('footer', { class: 'inbox-detail-actions' },
      h('span', { class: 'inbox-action-note' }, busy ? '正在处理…' : (blocker || `交给：${members.map(themeName).join('、')}`)),
      h('button', { class: 'btn inbox-reject', disabled: busy, onclick: () => onResolve([item], 'reject') }, '忽略'),
      dispatch,
    ),
  )
}


function scrollTo(mid, id) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** ⌘⇧V 粘贴进收件箱 */
export async function inboxPaste(text) {
  const mid = document.getElementById('mid')
  if (!mid) return
  if (inboxLoading) { toast('上一条内容仍在解析，请稍后再捕获。'); return }
  inboxLoading = true
  if (state.view === 'today') renderToday(mid)
  try {
    const res = await m.inboxCapture(text)
    lastAutoImport = res?.autoImported ? { id: res.intakeEventId, count: res.count } : null
  } catch (e) {
    toast('捕获失败：' + (e.message || '请重试'), 'var(--red)', { label: '重试', onClick: () => inboxPaste(text) })
  } finally {
    inboxLoading = false
    if (state.view === 'today') await renderToday(mid)
  }
}