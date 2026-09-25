import { h, icon, clear, toast } from '../lib/dom.js'
import { state, refresh, settleAndPulse } from '../app.js'
import { confColor, nodePath } from './shared.js'

const m = window.meridian

let inboxItems = []
let picked = new Set()
let inboxLoading = false
let renderSeq = 0
let selectedInboxId = null
const overrides = new Map()
const resolving = new Set()
let lastAutoImport = null
const overrideKey = (itemId, themeId = state.themeId) => `${themeId}:${itemId}`

function hasValidInboxRoute(item, themeNodes) {
  const ov = overrides.get(overrideKey(item.id)) || {}
  return (item.lemmas || []).every((lemma) => {
    if (lemma.action === 'merge') return true
    const parentId = ov.parentId ?? lemma.parentId
    return !parentId || themeNodes.some((node) => node.id === parentId && node.status !== 'dead')
  })
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

  const [due, calib, inbox, conflicts, ignored] = await Promise.all([
    m.due(), m.calibration(), m.inboxList(), m.conflicts(), m.inboxIgnored(),
  ])
  if (seq !== renderSeq || state.view !== 'today') return
  const previousIndex = inboxItems.findIndex((item) => item.id === selectedInboxId)
  inboxItems = inbox
  const ids = new Set(inbox.map((item) => item.id))
  picked = new Set([...picked].filter((id) => ids.has(id)))
  for (const key of overrides.keys()) if (!ids.has(key.slice(key.indexOf(':') + 1))) overrides.delete(key)
  if (!ids.has(selectedInboxId)) selectedInboxId = inbox[Math.max(0, Math.min(previousIndex, inbox.length - 1))]?.id || null

  const allNodes = await m.allNodes()
  if (seq !== renderSeq || state.view !== 'today') return
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

    // ---- 顶部两个大数字
    h('div', { class: 'today-metrics' },
      h('div', { class: 'today-metric', onclick: () => scrollTo(mid, 'inbox-section') },
        h('span', { class: 'today-metric-num', style: { color: inbox.length ? 'var(--accent)' : 'var(--text-3)' } }, String(inbox.length)),
        h('span', { class: 'today-metric-label' }, '待确认'),
      ),
      h('div', { class: 'today-metric', onclick: () => scrollTo(mid, 'due-section') },
        h('span', { class: 'today-metric-num', style: { color: due.length ? 'var(--orange)' : 'var(--text-3)' } }, String(due.length)),
        h('span', { class: 'today-metric-label' }, '今日结算'),
      ),
      h('div', { class: 'today-metric-spacer' }),
      // 校准曲线小图常驻
      h('div', { class: 'today-calib-mini' },
        calib.length ? h('div', { class: 'calib mini' },
          ...calib.map((b) => h('div', {},
            h('i', { style: { height: `${b.accuracy * 100}%`, background: b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } }),
          )),
        ) : h('div', { class: 'today-calib-empty' }, '—'),
        h('span', { class: 'today-calib-label' }, '校准曲线'),
      ),
    ),

    renderInboxWorkspace(themeNodes, allNodes),
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
            h('button', { class: 'btn btn-hit', onclick: async () => { await settleAndPulse(q.id, true); await renderToday(mid) } }, '对了'),
            h('button', { class: 'btn btn-miss', onclick: async () => { await settleAndPulse(q.id, false); await renderToday(mid) } }, '错了'),
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
      h('div', { class: 'card-h' }, h('h2', {}, '命题校准曲线'),
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

function renderInboxWorkspace(themeNodes, allNodes) {
  const items = inboxItems
  const section = h('section', { class: 'card inbox-workspace', id: 'inbox-section' },
    h('div', { class: 'card-h inbox-workspace-head' },
      h('h2', {}, '待确认'), h('p', {}, '已抽取的核对归位，未抽取的留档待命'),
      h('span', { class: 'spacer' }), h('em', {}, `${items.length} 条待审阅`),
    ),
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
  const isSelectable = (item) => item.extracted !== false && item.lemmas?.length && !resolving.has(item.id) && hasValidInboxRoute(item, themeNodes)
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
    onclick: () => resolve(items.filter((item) => picked.has(item.id)), 'accept'),
  }, '入库所选')

  function updateBatch() {
    for (const item of items) if (!hasValidInboxRoute(item, themeNodes)) picked.delete(item.id)
    const available = items.filter(isSelectable)
    pickAll.textContent = available.length && available.every((item) => picked.has(item.id)) ? '取消全选' : '全选'
    pickAll.disabled = !available.length
    count.textContent = `已选 ${picked.size} 条`
    importPicked.disabled = !state.themeId || !picked.size || items.some((item) => picked.has(item.id) && resolving.has(item.id))
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
    renderInboxDetail(detail, items.find((item) => item.id === id), themeNodes, allNodes, resolve, updateBatch)
  }

  async function resolve(chosen, action) {
    if (!chosen.length || chosen.some((item) => resolving.has(item.id))) return
    const themeId = state.themeId
    if (action === 'accept' && !themeId) { toast('先选择一个主题', 'var(--red)'); return }
    if (action === 'accept' && chosen.some((item) => !hasValidInboxRoute(item, themeNodes))) {
      toast('请先为所选信息选择当前主题下的目标环节。', 'var(--red)')
      return
    }
    for (const item of chosen) resolving.add(item.id)
    updateBatch()
    select(selectedInboxId)
    try {
      if (action === 'accept') {
        const ovMap = Object.fromEntries(chosen.map((item) => [item.id, overrides.get(overrideKey(item.id, themeId)) || {}]))
        const result = await m.inboxImport(themeId, chosen, ovMap)
        toast(`${result.results.length} 条命题已入库`)
      } else {
        await m.inboxResolve(chosen[0].id, 'reject')
        toast(chosen[0].kind === 'route-proposal' ? '已忽略归位提议，可在下方展开查看。' : '已忽略这条信息')
      }
      for (const item of chosen) { picked.delete(item.id); overrides.delete(overrideKey(item.id, themeId)) }
    } catch (e) {
      toast('处理失败：' + (e.message || '请重试'), 'var(--red)')
    } finally {
      for (const item of chosen) resolving.delete(item.id)
      await refresh()
    }
  }

  // 三态分组：已抽取（现有行为）/ 待抽取（弱匹配）/ 未匹配（标签库不认，但内容留着）
  const extractedItems = items.filter((item) => item.extracted !== false)
  const waitItems = items.filter((item) => item.extracted === false && item.matchScore > 0)
  const unmatchedItems = items.filter((item) => item.extracted === false && !(item.matchScore > 0))
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
      extractAll.textContent = '抽取中…'
      const res = await m.inboxExtract(waitItems.map((item) => item.id))
      if (!res?.error) toast(res.extracted ? `已抽取 ${res.extracted} 条` : '没有可抽取的条目')
      await refresh()
      await renderToday(mid)
    },
  }, `抽取这 ${waitItems.length} 条`)
  const clearUnmatched = h('button', {
    class: 'btn',
    onclick: async () => {
      const removed = await m.inboxClearUnextracted()
      toast(`已清空 ${removed} 条未匹配`)
      await refresh()
      await renderToday(mid)
    },
  }, '清空未匹配')

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
      }))
    }
  }

  appendItems(extractedItems, { head: groupHead('已抽取', extractedItems.length, '核对信息，再归位到脉络') })
  appendItems(waitItems, { head: groupHead('待抽取', waitItems.length, null, [extractAll]) })
  appendItems(unmatchedItems, { head: groupHead('未匹配', unmatchedItems.length, null, [clearUnmatched]) })
  section.append(h('div', { class: 'inbox-split' },
    h('div', { class: 'inbox-list-pane' },
      h('div', { class: 'inbox-list-toolbar' }, h('span', {}, '信息列表 · ↑↓ 切换'), pickAll),
      list,
      h('div', { class: 'inbox-import-bar' }, count, importPicked),
    ),
    detail,
  ))
  updateBatch()
  select(selectedInboxId)
  return section
}

function renderInboxItem(item, onSelect, onPick, onNavigate) {
  const lemmas = item.lemmas || []
  const title = item.title || lemmas[0]?.title || '未命名信息'
  return h('div', { class: 'inbox-item', dataset: { id: item.id } },
    h('input', {
      type: 'checkbox', class: 'inbox-ck', 'aria-label': `选择 ${title}`,
      disabled: item.extracted === false || !lemmas.length || resolving.has(item.id),
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
          : h('span', {}, `${lemmas.length} 条命题`),
        item.extracted !== false && lemmas.some((lemma) => lemma.action === 'merge') ? h('span', { class: 'feed-dup' }, '可合并') : null,
        item.extracted !== false && lemmas.some((lemma) => lemma.conflicts?.length) ? h('span', { class: 'cf' }, '有冲突') : null,
        resolving.has(item.id) ? h('span', {}, '处理中…') : null,
      ),
    ),
  )
}

function unextractedNote(item) {
  if (item.skipped === 'low-quality') return '来源质量低于闸门，留档不抽取。'
  if (item.matchScore > 0) return `标签库命中 ${item.matchScore.toFixed(2)}，未达该标签阈值，留档不抽取。`
  return '标签库没有命中，留档不抽取。'
}

function renderInboxDetail(panel, item, themeNodes, allNodes, onResolve, onRouteChange) {
  clear(panel)
  const unextracted = item.extracted === false
  const lemmas = item.lemmas || []
  const editable = !unextracted && lemmas.some((lemma) => lemma.action !== 'merge')
  const label = item.label || {}
  const ov = overrides.get(overrideKey(item.id)) || {}
  const busy = resolving.has(item.id)
  const theme = state.themes.find((t) => t.id === state.themeId)
  const conf = ov.confidence ?? lemmas[0]?.confidence ?? 50
  const sourceUrl = item.provenance?.url
  const confirm = h('button', {
    class: 'btn btn-primary inbox-confirm', disabled: busy || !theme || !lemmas.length || !hasValidInboxRoute(item, themeNodes),
    onclick: () => onResolve([item], 'accept'),
  }, unextracted ? '抽取后入库' : editable ? '确认入库' : '合并来源')
  const routeNote = h('p', { class: 'inbox-detail-note inbox-route-warning', hidden: hasValidInboxRoute(item, themeNodes) },
    '建议挂点不属于当前主题，请重新选择目标环节。')
  const confValue = h('output', { class: 'inbox-conf-val', for: 'inbox-confidence' }, String(Math.round(conf)))
  const parentSelect = h('select', {
    class: 'inbox-parent-select', id: 'inbox-parent', disabled: busy || !theme,
    onchange: () => {
      overrides.set(overrideKey(item.id), { ...overrides.get(overrideKey(item.id)), parentId: parentSelect.value })
      clear(graph)
      graph.append(renderMiniGraph(themeNodes, item, changeParent))
      confirm.disabled = busy || !theme
      routeNote.hidden = true
      onRouteChange()
    },
  }, h('option', { value: '__unavailable__', disabled: true }, '请选择当前主题的环节'),
  h('option', { value: '' }, '主题根级'),
  ...themeNodes.filter((node) => node.status !== 'dead').map((node) =>
    h('option', { value: node.id }, nodePath(themeNodes, node.id) || node.title)))
  parentSelect.value = hasValidInboxRoute(item, themeNodes) ? (ov.parentId ?? lemmas.find((lemma) => lemma.action !== 'merge')?.parentId ?? '') : '__unavailable__'
  const changeParent = (id) => {
    if (busy) return
    parentSelect.value = id
    parentSelect.dispatchEvent(new Event('change'))
  }
  const graph = h('div', { class: 'inbox-graph' }, renderMiniGraph(themeNodes, item, changeParent))
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
      h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '原文'),
        h('p', { class: 'inbox-original-text' }, item.text || '这条信息没有附带原文。'),
      ),
      unextracted ? h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '未抽取'),
        h('p', { class: 'inbox-detail-note' }, unextractedNote(item)),
        h('p', { class: 'inbox-detail-note' }, '原文已留在本地。需要时在列表的「待抽取」分组点「抽取这 N 条」。'),
      ) : h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, `提取的命题 · ${lemmas.length}`),
        lemmas.length ? h('ol', { class: 'inbox-proposals' },
          ...lemmas.map((lemma) => h('li', {},
            h('span', {}, lemma.title),
            h('div', { class: 'inbox-proposal-meta' },
              h('span', {}, lemma.action === 'merge'
                ? `合并到「${allNodes.find((node) => node.id === lemma.mergeInto)?.title || '已有命题'}」`
                : '新增命题'),
              h('span', {}, lemma.action === 'merge' ? '保留原置信度与挂点' : `建议置信度 ${Math.round(lemma.confidence ?? 50)}`),
              lemma.conflicts?.length ? h('span', { class: 'cf' }, `${lemma.conflicts.length} 项冲突`) : null,
            ),
          )),
        ) : h('p', { class: 'inbox-detail-note' }, '未提取到可入库的命题。你可以忽略，或补充原文后重新捕获。'),
      ),
      editable ? h('section', { class: 'inbox-detail-section' },
        h('h4', { class: 'inbox-section-title' }, '确认归位'),
        h('p', { class: 'inbox-route-theme' }, theme ? `主题 · ${theme.name}` : '先在侧栏选择一个主题，再确认入库。'),
        routeNote,
        h('div', { class: 'inbox-routing' }, h('label', { for: 'inbox-parent' }, '目标环节'), parentSelect),
        h('div', { class: 'inbox-confidence' },
          h('label', { for: 'inbox-confidence' }, '置信度'),
          h('input', {
            id: 'inbox-confidence', class: 'prop-slider inbox-conf-slider', type: 'range',
            min: 0, max: 100, value: conf, disabled: busy,
            oninput: (e) => {
              const value = Number(e.target.value)
              overrides.set(overrideKey(item.id), { ...overrides.get(overrideKey(item.id)), confidence: value })
              confValue.value = String(value)
            },
          }), confValue,
        ),
        lemmas.length > 1 ? h('p', { class: 'inbox-detail-note' }, '调整后应用于本条信息中的新增命题；未调整时保留各自建议。') : null,
        h('details', { class: 'inbox-map' }, h('summary', {}, '查看归位图'), graph),
      ) : null,
    ),
    h('footer', { class: 'inbox-detail-actions' },
      h('span', { class: 'inbox-action-note' }, busy ? '正在处理…' : unextracted ? '未抽取 · 原文已留档' : `${lemmas.length} 条命题待核对`),
      h('button', { class: 'btn inbox-reject', disabled: busy, onclick: () => onResolve([item], 'reject') }, '忽略'),
      confirm,
    ),
  )
}

// -------------------------------------------------- 收件箱右栏迷你图

const NS = 'http://www.w3.org/2000/svg'

function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'text') el.textContent = v
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) el.setAttribute(`data-${dk}`, String(dv))
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids.flat(4)) if (c != null && c !== false) el.append(c)
  return el
}

function miniLayout(nodes) {
  const kids = new Map()
  const roots = []
  for (const n of nodes) {
    if (!n.parentId) { roots.push(n); continue }
    if (!kids.has(n.parentId)) kids.set(n.parentId, [])
    kids.get(n.parentId).push(n)
  }
  const byTime = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')
  for (const list of kids.values()) list.sort(byTime)
  roots.sort(byTime)
  const pos = new Map()
  let leaf = 0
  const place = (node, depth) => {
    const cs = kids.get(node.id) || []
    if (!cs.length) { const y = leaf++; pos.set(node.id, { y, depth }); return y }
    let sum = 0
    for (const c of cs) sum += place(c, depth + 1)
    const y = sum / cs.length
    pos.set(node.id, { y, depth })
    return y
  }
  for (const r of roots) place(r, 0)
  return { pos, kids, roots }
}

function renderMiniGraph(themeNodes, item, onParentChange) {
  themeNodes = themeNodes.filter((node) => node.status !== 'dead')
  if (!themeNodes.length) return h('div', { class: 'inbox-graph-empty' }, h('span', {}, '主题还没有环节'))

  const ov = overrides.get(overrideKey(item.id)) || {}
  const suggestedParent = ov.parentId ?? item.lemmas?.find((lemma) => lemma.action !== 'merge')?.parentId ?? null

  const downstream = new Set()
  if (suggestedParent) {
    const stack = [suggestedParent]
    while (stack.length) {
      const pid = stack.pop()
      for (const c of themeNodes) {
        if (c.parentId === pid && !downstream.has(c.id)) {
          downstream.add(c.id)
          stack.push(c.id)
        }
      }
    }
  }
  const highlight = new Set([suggestedParent, ...downstream].filter(Boolean))

  const { pos, kids, roots } = miniLayout(themeNodes)
  const ROW = 28
  const COLW = 130
  const NODE_W = 100
  const NODE_H = 20

  let maxDepth = 0, maxRow = 0
  for (const [id, p] of pos) { maxDepth = Math.max(maxDepth, p.depth); maxRow = Math.max(maxRow, p.y) }
  const svgW = (maxDepth + 1) * COLW + 20
  const svgH = (maxRow + 1) * ROW + 20

  const X = (id) => (pos.get(id)?.depth ?? 0) * COLW + 10
  const Y = (id) => (pos.get(id)?.y ?? 0) * ROW + 10

  const svg = svgEl('svg', { class: 'mini-graph', width: '100%', height: svgH, style: `min-width: ${svgW}px`, viewBox: `0 0 ${svgW} ${svgH}` })

  // 边
  for (const n of themeNodes) {
    if (!n.parentId) continue
    const x1 = X(n.parentId) + NODE_W
    const y1 = Y(n.parentId) + NODE_H / 2
    const x2 = X(n.id)
    const y2 = Y(n.id) + NODE_H / 2
    const k = Math.max(12, (x2 - x1) / 2)
    const onEdge = highlight.has(n.parentId) && highlight.has(n.id)
    svg.append(svgEl('path', {
      d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`,
      fill: 'none',
      stroke: onEdge ? 'var(--accent)' : 'var(--hairline)',
      'stroke-width': onEdge ? '1.5' : '0.5',
      opacity: highlight.size && !onEdge ? '0.3' : '1',
    }))
  }

  // 节点
  for (const n of themeNodes) {
    const x = X(n.id), y = Y(n.id)
    const isParent = n.id === suggestedParent
    const isDown = downstream.has(n.id)
    const isOn = highlight.has(n.id)
    const g = svgEl('g', {
      class: 'mini-node',
      dataset: { id: n.id, parent: String(isParent), down: String(isDown) },
      opacity: highlight.size && !isOn ? '0.35' : '1',
      role: 'button', tabindex: '0', 'aria-label': `归位到 ${n.title}`,
      onclick: () => onParentChange(n.id),
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onParentChange(n.id)
      },
    })
    g.append(svgEl('rect', {
      x, y, width: NODE_W, height: NODE_H, rx: 5,
      fill: isParent ? 'var(--accent)' : isDown ? 'var(--accent-soft)' : 'var(--surface-solid)',
      stroke: isParent ? 'none' : isOn ? 'var(--accent)' : 'var(--hairline)',
      'stroke-width': isParent ? '0' : isOn ? '1' : '0.5',
    }))
    const title = n.title.length > 12 ? n.title.slice(0, 11) + '…' : n.title
    g.append(svgEl('text', {
      x: x + 6, y: y + 13, text: title,
      fill: isParent ? '#fff' : 'var(--text-2)',
      style: 'font-size: var(--t-caption)', 'font-weight': '400',
    }))
    if (isParent) {
      g.append(svgEl('rect', {
        x: x - 2, y: y - 2, width: NODE_W + 4, height: NODE_H + 4, rx: 7,
        fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '3 2',
      }))
    }
    svg.append(g)
  }

  const wrap = h('div', { class: 'mini-graph-wrap' }, svg)
  if (suggestedParent) {
    const parentName = themeNodes.find((n) => n.id === suggestedParent)?.title || '?'
    wrap.append(h('div', { class: 'mini-graph-hint' },
      h('span', {}, `挂点：${parentName.length > 16 ? parentName.slice(0, 15) + '…' : parentName}`),
      h('span', { style: { color: 'var(--text-3)' } }, ' · 点节点改挂点'),
    ))
  } else {
    wrap.append(h('div', { class: 'mini-graph-hint' }, h('span', { style: { color: 'var(--text-3)' } }, '点一个节点设为挂点')))
  }
  return wrap
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