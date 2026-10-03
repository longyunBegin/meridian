import { h, icon, clear, toast } from '../lib/dom.js'
import { state, refresh, settleAndViewTheme } from '../app.js'
import { confColor, nodePath, inferInboxThemeId, inboxRouteValid, splitInboxPicked } from './shared.js'
import { trustMark, periodLabel } from './readings.js'
import { renderProposalDraft } from './chain.js'

const m = window.meridian

let inboxItems = []
let inboxTotal = 0
let inboxLimit = 50
let picked = new Set()
let inboxLoading = false
let renderSeq = 0
let selectedInboxId = null
const overrides = new Map()
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
const overrideKey = (itemId, themeId = state.themeId) => `${themeId}:${itemId}`

/** 条目自己的主题：抽取路由所用的主题（新数据直接记在条目上）。 */
function itemThemeId(item) {
  return inferInboxThemeId(item, cachedAllNodes, state.themeId)
}
function itemThemeNodes(item) {
  const tid = itemThemeId(item)
  return cachedAllNodes.filter((node) => node.themeId === tid)
}
/** 条目级 override 键：跟着条目自己的主题走，不跟当前主题 */
const ovKey = (item) => overrideKey(item.id, itemThemeId(item))

function hasValidInboxRoute(item, themeNodes) {
  return inboxRouteValid(item, themeNodes, overrides.get(ovKey(item)) || {})
}

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
  const [due, calib, inboxPage, conflicts, ignored] = await Promise.all([
    m.due(), m.calibration(), m.inboxList({ limit: pageSize, offset: 0 }), m.conflicts(), m.inboxIgnored(),
  ])
  if (seq !== renderSeq || state.view !== 'today') return
  const previousIndex = inboxItems.findIndex((item) => item.id === selectedInboxId)
  inboxItems = inboxPage.items
  inboxTotal = inboxPage.total
  const ids = new Set(inboxItems.map((item) => item.id))
  picked = new Set([...picked].filter((id) => ids.has(id)))
  for (const key of overrides.keys()) if (!ids.has(key.slice(key.indexOf(':') + 1))) overrides.delete(key)
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

    // ---- 顶部两个大数字：同色，靠字号和位置区分主次。
    // 颜色只留给真正的异常——"今日结算"用橙色会让用户误以为出问题了。
    h('div', { class: 'today-metrics' },
      h('div', { class: 'today-metric', onclick: () => scrollTo(mid, 'inbox-section') },
        h('span', { class: 'today-metric-num', style: { color: inboxTotal ? 'var(--text-1)' : 'var(--text-3)' } }, String(inboxTotal)),
        h('span', { class: 'today-metric-label' }, '待确认'),
      ),
      h('div', { class: 'today-metric', onclick: () => scrollTo(mid, 'due-section') },
        h('span', { class: 'today-metric-num', style: { color: due.length ? 'var(--text-1)' : 'var(--text-3)' } }, String(due.length)),
        h('span', { class: 'today-metric-label' }, '今日结算'),
      ),
    ),

    renderInboxWorkspace(mid, seq, allNodes),
    renderIgnoredProposals(ignored, allNodes),

    // ---- 到期未结算
    h('section', { class: 'card', id: 'due-section' },
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
        )) : h('div', { class: 'q' }, h('div', { class: 'q-body' },
          h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '没有到期的问题。给命题设一个结算日，它就会回来找你。'),
        )),
      ),
    ),

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
  // 收件箱统计：待处理 / 已抽取要点 / 已归位（粗筛层的三个关键数字）
  const statsRow = h('div', { class: 'inbox-stats-row' },
    h('span', { class: 'inbox-stat' }, '待处理 ', h('b', { class: 'inbox-stat-pending' }, '…')),
    h('span', { class: 'inbox-stat' }, '已抽取要点 ', h('b', { class: 'inbox-stat-lemmas' }, '…')),
    h('span', { class: 'inbox-stat' }, '已归位 ', h('b', { class: 'inbox-stat-resolved', style: { color: 'var(--green)' } }, '…')),
  )
  // 异步拉取统计
  m.inboxStats?.().then((s) => {
    if (!s) return
    statsRow.querySelector('.inbox-stat-pending').textContent = String(s.pending ?? '—')
    statsRow.querySelector('.inbox-stat-lemmas').textContent = String(s.lemmas ?? '—')
    statsRow.querySelector('.inbox-stat-resolved').textContent = String(s.resolved ?? '—')
  }).catch(() => {})
  const section = h('section', { class: 'card inbox-workspace', id: 'inbox-section' },
    h('div', { class: 'card-h inbox-workspace-head' },
      h('h2', {}, '待确认'),
      h('span', { class: 'spacer' }), h('em', {}, `${inboxTotal} 条待审阅`),
    ),
    statsRow,
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

  const list = h('div', { class: 'inbox-list', role: 'group', 'aria-label': '待确认信息列表' })
  const detail = h('section', { class: 'inbox-detail', id: 'inbox-detail', 'aria-labelledby': 'inbox-detail-title' })
  const count = h('span')
  // 复选框全开：分拣语义是"选中这批处理"，批量栏按选中成分自适应可用操作。
  // 未抽取条目可勾选 → 抽取所选 / 忽略所选；已抽取且挂点有效 → 批量入库。
  const isSelectable = (item) => !resolving.has(item.id)
  const overrideOf = (item, tid) => overrides.get(overrideKey(item.id, tid)) || {}
  const splitPicked = () => splitInboxPicked(items, picked, cachedAllNodes, state.themeId, overrideOf)
  const pickAll = h('button', {
    class: 'btn inbox-pick-all',
    onclick: () => {
      const available = items.filter(isSelectable)
      const allPicked = available.every((item) => picked.has(item.id))
      for (const item of available) allPicked ? picked.delete(item.id) : picked.add(item.id)
      updateBatch()
    },
  })
  const importPicked = h('button', {
    class: 'btn btn-primary inbox-import-picked',
    onclick: () => resolve(splitPicked().importable, 'accept'),
  }, '批量入库')
  // 批量抽取主题选择器：默认「自动」（要点最多的主题）；手动指定后，
  // 本次抽取的条目都记到该主题下，后续入库跟着条目自己的主题走。
  const liveThemes = state.themes.filter((t) => !t.deletedAt)
  const extractThemePick = h('select', {
    class: 'inbox-extract-theme', title: '抽取主题：默认自动（要点最多的主题），可手动指定',
  }, h('option', { value: '' }, '自动主题'),
    ...liveThemes.map((t) => h('option', { value: t.id, title: t.name }, t.name)))
  const extractPicked = h('button', {
    class: 'btn inbox-extract-picked',
    onclick: () => resolve(splitPicked().extractable, 'extract'),
  }, '抽取所选')
  const ignorePicked = h('button', {
    class: 'btn inbox-ignore-picked',
    onclick: () => resolve(items.filter((item) => picked.has(item.id)), 'reject'),
  }, '忽略所选')
  // 批量分配到主题：选主题后，所选项的 extractedThemeId 批量更新
  const assignThemePick = h('select', {
    class: 'inbox-assign-theme', title: '分配到主题：所选项将出现在该主题建设者的待归因队列',
  }, h('option', { value: '' }, '选择主题…'),
    ...liveThemes.map((t) => h('option', { value: t.id, title: t.name }, t.name)))
  const assignPicked = h('button', {
    class: 'btn inbox-assign-picked',
    onclick: async () => {
      const tid = assignThemePick.value
      if (!tid) { toast('请先选择要分配到的主题', 'var(--red)'); return }
      const targets = items.filter((item) => picked.has(item.id))
      if (!targets.length) return
      assignPicked.disabled = true
      let okCount = 0
      for (const item of targets) {
        try {
          const res = await m.inboxSetTheme(item.id, tid)
          if (res?.ok) { item.extractedThemeId = tid; okCount++ }
        } catch { /* 单条失败继续 */ }
      }
      const themeName = liveThemes.find((t) => t.id === tid)?.name || ''
      toast(okCount === targets.length
        ? `已分配 ${okCount} 条到「${themeName}」`
        : `已分配 ${okCount}/${targets.length} 条到「${themeName}」，${targets.length - okCount} 条失败`)
      picked.clear()
      updateBatch()
      rerender ? rerender() : onRouteChange()
    },
  }, '分配到主题')

  function updateBatch() {
    const available = items.filter(isSelectable)
    pickAll.textContent = available.length && available.every((item) => picked.has(item.id)) ? '取消全选' : '全选'
    pickAll.disabled = !available.length
    const { importable, extractable } = splitPicked()
    count.textContent = `已选 ${picked.size} 条`
    // 渐进式披露：没选中时底部栏只是状态条，不跟详情的「确认入库」抢主操作；
    // 选中后按成分出现对应批量入口，按钮带数字，一眼知道作用范围。
    importPicked.hidden = !importable.length
    importPicked.textContent = `批量入库（${importable.length}）`
    importPicked.disabled = !importable.length || importable.some((item) => resolving.has(item.id))
    extractPicked.hidden = !extractable.length
    extractPicked.textContent = `抽取所选（${extractable.length}）`
    extractPicked.disabled = !extractable.length || extractable.some((item) => resolving.has(item.id))
    extractThemePick.hidden = !extractable.length
    ignorePicked.hidden = !picked.size
    ignorePicked.textContent = `忽略所选（${picked.size}）`
    ignorePicked.disabled = !picked.size || [...picked].some((id) => resolving.has(id))
    // 批量分配：有选中项时显示
    assignThemePick.hidden = !picked.size
    assignPicked.hidden = !picked.size
    assignPicked.textContent = `分配到主题（${picked.size}）`
    assignPicked.disabled = !picked.size || [...picked].some((id) => resolving.has(id))
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
    if (action === 'accept' && chosen.some((item) => !itemThemeId(item) || !hasValidInboxRoute(item, itemThemeNodes(item)))) {
      toast('请先为所选信息选择其主题下的目标环节。', 'var(--red)')
      return
    }
    for (const item of chosen) resolving.add(item.id)
    updateBatch()
    select(selectedInboxId)
    try {
      if (action === 'accept') {
        // 按条目各自主题分组入库：今日收件箱是全局的，一批勾选可能横跨多个主题
        const groups = new Map()
        for (const item of chosen) {
          const tid = itemThemeId(item)
          if (!groups.has(tid)) groups.set(tid, [])
          groups.get(tid).push(item)
        }
        let total = 0
        for (const [tid, group] of groups) {
          const ovMap = Object.fromEntries(group.map((item) => [item.id, overrides.get(overrideKey(item.id, tid)) || {}]))
          const result = await m.inboxImport(tid, group, ovMap)
          total += result.results.length
          for (const item of group) { picked.delete(item.id); overrides.delete(overrideKey(item.id, tid)) }
        }
        toast(`${total} 条要点已归位`)
      } else if (action === 'extract') {
        const themeId = extractThemePick.value || undefined
        const res = await runExtract(chosen.map((item) => item.id), themeId)
        for (const item of chosen) { picked.delete(item.id); overrides.delete(ovKey(item)) }
        extractResultToast(res)
      } else {
        if (chosen.length === 1) {
          await m.inboxResolve(chosen[0].id, 'reject')
          toast(chosen[0].kind === 'route-proposal' ? '已忽略归位提议，可在下方展开查看。' : '已忽略这条信息')
        } else {
          const res = await m.inboxResolveMany(chosen.map((item) => item.id), 'reject')
          toast(`已忽略 ${res?.resolved?.length ?? chosen.length} 条`)
        }
        for (const item of chosen) { picked.delete(item.id); overrides.delete(ovKey(item)) }
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

  // 四态分组：抽取中（独立置顶，组头一条进度条）/ 已抽取 / 待抽取 / 未匹配
  const extractingItems = items.filter((item) => extracting.has(item.id))
  const extractedItems = items.filter((item) => item.extracted !== false && !extracting.has(item.id))
  const waitItems = items.filter((item) => item.extracted === false && item.matchScore > 0 && !extracting.has(item.id))
  const unmatchedItems = items.filter((item) => item.extracted === false && !(item.matchScore > 0) && !extracting.has(item.id))
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

  const appendItems = (group, opts = {}) => {
    if (!group.length) return
    if (opts.head) list.append(opts.head)
    for (const item of group) {
      list.append(renderInboxItem(item, () => select(item.id), (checked) => {
        checked ? picked.add(item.id) : picked.delete(item.id)
        updateBatch()
      }, (direction) => {
        const next = group[Math.max(0, Math.min(group.length - 1, group.indexOf(item) + direction))]
        select(next.id)
        const row = [...list.querySelectorAll('.inbox-item')].find((el) => el.dataset.id === next.id)
        row.querySelector('.inbox-body').focus({ preventScroll: true })
        row.scrollIntoView({ block: 'nearest' })
      }, isSelectable(item)))
    }
  }

  appendItems(extractingItems, { head: extractingGroupHead() })
  appendItems(extractedItems, { head: groupHead('已抽取', extractedItems.length, '核对信息，再归位到脉络') })
  appendItems(waitItems, { head: groupHead('待抽取', waitItems.length, null, [extractAll]) })
  appendItems(unmatchedItems, { head: groupHead('未匹配', unmatchedItems.length, null, [extractUnmatched, clearUnmatched]) })

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
      h('div', { class: 'inbox-import-bar' }, count, extractThemePick, extractPicked, importPicked, assignThemePick, assignPicked, ignorePicked),
    ),
    detail,
  ))
  updateBatch()
  select(selectedInboxId)
  return section
}

function renderInboxItem(item, onSelect, onPick, onNavigate, pickable = true) {
  const lemmas = item.lemmas || []
  const title = item.title || lemmas[0]?.title || '未命名信息'
  // 已分配到主题的条目默认折叠显示（视觉弱化，避免与待处理项混淆）
  const isAssigned = Boolean(item.extractedThemeId)
  return h('div', { class: `inbox-item${isAssigned ? ' is-assigned' : ''}`, dataset: { id: item.id } },
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
      h('span', { class: 'inbox-item-source' },
        h('span', {}, item.label?.kind || '未标注来源'), h('time', {}, item.createdAt?.slice(5) || ''),
      ),
      h('span', { class: 'inbox-title' }, title),
      h('span', { class: 'inbox-excerpt' }, item.text || lemmas[0]?.title || '暂无原文'),
      h('span', { class: 'inbox-meta' },
        item.extracted === false
          ? h('span', {}, item.matchScore > 0
            ? `命中 ${item.matchScore.toFixed(2)} · 未达阈值`
            : (item.skipped === 'low-quality' ? '低质来源 · 未抽取' : '标签库未匹配'))
          : h('span', {}, `${lemmas.length} 条要点`),
        item.extracted !== false && lemmas.some((lemma) => lemma.action === 'merge') ? h('span', { class: 'feed-dup' }, '可合并') : null,
        item.extracted !== false && lemmas.some((lemma) => lemma.conflicts?.length) ? h('span', { class: 'cf' }, '有冲突') : null,
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

function renderInboxDetail(panel, item, allNodes, onResolve, onRouteChange, rerender) {
  clear(panel)
  // 条目级主题：勾选、挂点下拉、归位图、入库都跟着条目自己的主题走，
  // 与渲染层当前主题无关——今日收件箱是全局的。
  const themeNodes = itemThemeNodes(item)
  const unextracted = item.extracted === false
  const lemmas = item.lemmas || []
  const editable = !unextracted && lemmas.some((lemma) => lemma.action !== 'merge')
  const label = item.label || {}
  const ov = overrides.get(ovKey(item)) || {}
  const busy = resolving.has(item.id)
  const theme = state.themes.find((t) => t.id === itemThemeId(item))
  const conf = ov.confidence ?? lemmas[0]?.confidence ?? 50
  const sourceUrl = item.provenance?.url
  // 主题切换器：换主题只改条目身上的 extractedThemeId；重渲染后归位图、
  // 目标环节下拉、挂点校验都跟着新主题走，旧主题的手动挂点按主题键隔离。
  const liveThemes = state.themes.filter((t) => !t.deletedAt)
  const themeSelect = h('select', {
    class: 'inbox-theme-select', id: 'inbox-theme', disabled: busy || !liveThemes.length,
    title: '切换条目主题',
    onchange: async (e) => {
      const tid = e.target.value
      if (!tid || tid === itemThemeId(item)) return
      e.target.disabled = true
      try {
        const res = await m.inboxSetTheme(item.id, tid)
        if (res?.ok) {
          item.extractedThemeId = tid
          toast(`已切换到「${state.themes.find((t) => t.id === tid)?.name}」`)
          rerender ? rerender() : onRouteChange()
          onRouteChange()
        } else {
          toast('切换主题失败：' + (res?.error || '请重试'), 'var(--red)')
          e.target.value = itemThemeId(item)
        }
      } catch (err) {
        toast('切换主题失败：' + (err.message || '请重试'), 'var(--red)')
        e.target.value = itemThemeId(item)
      } finally {
        e.target.disabled = busy
      }
    },
  }, ...liveThemes.map((t) => h('option', { value: t.id, title: t.name }, t.name)))
  themeSelect.value = itemThemeId(item) || ''
  const confirm = h('button', {
    class: 'btn btn-primary inbox-confirm', disabled: busy || !theme || !lemmas.length || !hasValidInboxRoute(item, themeNodes),
    onclick: () => onResolve([item], 'accept'),
  }, unextracted ? '抽取后入库' : editable ? '确认入库' : '合并来源')
  const confValue = h('output', { class: 'inbox-conf-val', for: 'inbox-confidence' }, String(Math.round(conf)))
  panel.append(
    h('header', { class: 'inbox-detail-head' },
      h('div', { class: 'inbox-detail-kicker' }, item.provenance?.platform || label.kind || '待审阅信息', ' · ', item.createdAt || ''),
      h('h3', { class: 'inbox-detail-title', id: 'inbox-detail-title', title: item.title || lemmas[0]?.title || '未命名信息' }, item.title || lemmas[0]?.title || '未命名信息'),
      h('div', { class: 'inbox-detail-meta' },
        h('span', {}, label.kind || '未标注来源'),
        typeof label.quality === 'number' ? h('span', {}, `来源质量 ${Math.round(label.quality * 100)}%`) : null,
        /^https?:\/\//i.test(sourceUrl || '') ? h('button', {
          class: 'btn inbox-source-link', onclick: () => m.openExternal(sourceUrl),
        }, icon('export', 12), '查看来源') : null,
      ),
    ),
    h('div', { class: 'inbox-detail-scroll' },
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
        h('p', { class: 'inbox-detail-note' }, '原文已留在本地。勾选后点「抽取所选」，或直接点分组旁的「抽取这 N 条」。'),
      ) : h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, `提取的要点 · ${lemmas.length}`),
        lemmas.length ? h('ol', { class: 'inbox-proposals' },
          ...lemmas.map((lemma) => h('li', {},
            h('span', {}, lemma.title),
            h('div', { class: 'inbox-proposal-meta' },
              h('span', {}, lemma.action === 'merge'
                ? `合并到「${allNodes.find((node) => node.id === lemma.mergeInto)?.title || '已有要点'}」`
                : '新增要点'),
              h('span', {}, lemma.action === 'merge' ? '保留原置信度与挂点' : `建议置信度 ${Math.round(lemma.confidence ?? 50)}`),
              lemma.conflicts?.length ? h('span', { class: 'cf' }, `${lemma.conflicts.length} 项冲突`) : null,
            ),
          )),
        ) : h('p', { class: 'inbox-detail-note' }, '未提取到可入库的要点。你可以忽略，或补充原文后重新捕获。'),
      ),
      // 确认归位：图已删，归位 = 挂到认知链。提案草稿搬进这里，一处确认。
      (editable || (theme && !unextracted)) ? h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '确认归位'),
        editable ? h('div', { class: 'draft-theme-row' },
          h('span', { class: 'draft-label' }, '主题'), themeSelect,
          theme ? null : h('span', { class: 'inbox-detail-note' }, '该条目没有可用主题，无法入库。')) : null,
        theme && !unextracted ? renderProposalDraft(item, [],
          {
            themeId: itemThemeId(item), bare: true,
            loadExisting: async () => {
              try {
                const proj = await m.chainProjection(itemThemeId(item))
                return (proj.nodes || [])
                  .filter((n) => n.kind === 'claim' || n.kind === 'inference')
                  .map((n) => ({ id: n.id, name: n.title }))
              } catch { return [] }
            },
            onDraft: () => rerender ? rerender() : onRouteChange(),
            onMounted: () => { rerender ? rerender() : onRouteChange(); refresh() },
          }) : null,
        editable ? h('div', { class: 'inbox-confidence' },
          h('label', { for: 'inbox-confidence' }, '置信度'),
          h('input', {
            id: 'inbox-confidence', class: 'prop-slider inbox-conf-slider', type: 'range',
            min: 0, max: 100, value: conf, disabled: busy,
            oninput: (e) => {
              const value = Number(e.target.value)
              overrides.set(ovKey(item), { ...overrides.get(ovKey(item)), confidence: value })
              confValue.value = String(value)
            },
          }), confValue,
        ) : null,
        editable && lemmas.length > 1 ? h('p', { class: 'inbox-detail-note' }, '调整后应用于本条信息中的新增要点；未调整时保留各自建议。') : null,
      ) : null,
    ),
    h('footer', { class: 'inbox-detail-actions' },
      h('span', { class: 'inbox-action-note' }, busy ? '正在处理…' : unextracted ? '未抽取 · 原文已留档' : `${lemmas.length} 条要点待核对`),
      h('button', { class: 'btn inbox-reject', disabled: busy, onclick: () => onResolve([item], 'reject') }, '忽略'),
      confirm,
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