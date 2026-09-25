import { h, icon, clear, toast, confirmToast } from '../lib/dom.js'
import { state, refresh, selectNode, setShape, setView, deleteNodeWithUndo } from '../app.js'
import { confColor, confColorContinuous, TYPE_LABEL, todayStr } from './shared.js'
import { renderGraph } from './graph.js'
import { isConflicted, trustMark, periodLabel } from './readings.js'

const m = window.meridian

/** 紧凑数值：树里 inline 用，$130.6B 而不是 130,570,000,000 */
function fmtCompact(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '—')
  const abs = Math.abs(v)
  if (abs >= 1e12) return `${(v / 1e12).toFixed(1)}T`
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return String(v)
}

/** 每一层的缩进与导轨位置都由它推导，改一处全树同步 */
const INDENT = 15
const PAD = 20
/** 导轨落在父行箭号的圆心上：内容起点 - 8（号宽 16 的一半） */
const railX = (depth) => PAD + (depth - 1) * INDENT - 8
const expandedTagLibraries = new Set()

function renderTagLibraryBand(theme) {
  if (!theme) return h('div')
  const lib = Array.isArray(theme.tagLibrary) ? theme.tagLibrary : []
  const total = lib.length
  const unmatched = lib.filter((t) => !t.hits).length
  const recentCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const recentHits = lib.filter((t) => t.lastHitAt && t.lastHitAt >= recentCutoff).length
  let expanded = expandedTagLibraries.has(theme.id)
  let organizeMode = false

  const body = h('div', {
    class: 'sect-b tag-library-body', id: `tag-library-${theme.id}`,
    role: 'region', 'aria-label': '标签库内容', tabindex: '0',
  })
  const toggleLabel = h('span')
  const header = h('button', {
    type: 'button', class: 'sect-h tag-library-toggle',
    'aria-controls': body.id,
    onclick: () => {
      expanded = !expanded
      if (expanded) expandedTagLibraries.add(theme.id)
      else expandedTagLibraries.delete(theme.id)
      render()
    },
  },
    h('span', { class: 'tag-library-title' }, '标签库'),
    h('em', {}, `${total} 个 · ${unmatched} 个未命中 · 近 7 天命中 ${recentHits}`),
    h('span', { class: 'tag-library-action' }, toggleLabel, icon('chevron', 12)),
  )
  const band = h('div', { class: 'sect tag-library' }, header, body)

  function render() {
    header.setAttribute('aria-expanded', String(expanded))
    toggleLabel.textContent = expanded ? '收起' : '展开'
    body.hidden = !expanded
    clear(body)
    if (!expanded) return
    if (!total) {
      body.append(h('p', { style: { fontSize: 'var(--t-body)', color: 'var(--text-3)', padding: '6px 0' } }, '暂无标签库'))
    } else if (organizeMode) {
      renderOrganize(body)
    } else {
      renderList(body)
    }
    renderThemeOps(body)
  }

  function renderList(body) {
    body.append(h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
      h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: () => { organizeMode = true; render() } }, '整理'),
    ))
    for (const tag of lib) {
      const row = h('div', { class: 'q', style: { cursor: 'pointer' },
        onclick: () => renderTagDetail(body, tag),
      },
        h('span', { class: 'dot', style: { background: tag.hits ? 'var(--accent)' : 'var(--orange)', marginTop: '6px' } }),
        h('div', { class: 'q-body' },
          h('div', { class: 'q-text' }, tag.name),
          h('div', { class: 'q-meta' },
            h('span', {}, `${tag.synonyms?.length || 0} 个同义词`),
            h('span', {}, `· 命中 ${tag.hits || 0} 次`),
            h('span', {}, `· 匹配阈值 ${tag.threshold}`),
          ),
        ),
        h('span', { style: { color: 'var(--text-3)', marginLeft: '4px' } }, '▸'),
      )
      body.append(row)
    }
  }

  function renderTagDetail(body, tag) {
    clear(body)
    body.append(h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)', marginBottom: '6px' }, onclick: () => render() }, '返回'))
    const nameInput = h('input', { class: 'txt', value: tag.name, style: { width: '100%', marginBottom: '6px' } })
    const synInput = h('input', { class: 'txt', value: (tag.synonyms || []).join(', '), style: { width: '100%', marginBottom: '6px' } })
    const thrInput = h('input', { class: 'txt', type: 'number', value: tag.threshold, min: '0.4', max: '0.85', step: '0.05', style: { width: '80px', marginBottom: '6px' } })
    body.append(
      h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '名称'),
      nameInput,
      h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '同义词（逗号分隔）'),
      synInput,
      h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '阈值'),
      thrInput,
      h('button', { class: 'btn btn-primary', style: { padding: '2px 8px', fontSize: 'var(--t-caption)', marginTop: '4px' }, onclick: async () => {
        await m.updateTagLibraryTag(theme.id, tag.id, {
          name: nameInput.value.trim(),
          synonyms: synInput.value.split(',').map((s) => s.trim()).filter(Boolean),
          threshold: Number(thrInput.value) || 0.6,
        })
        await refresh()
      } }, '保存'),
    )
  }

  function renderOrganize(body) {
    const checked = new Set()
    body.append(h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
      h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: () => { organizeMode = false; render() } }, '完成'),
      h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: () => {
        for (const t of lib) if (!t.hits) checked.add(t.id)
        renderOrganizeBody(body, checked)
      } }, '全选命中 0'),
    ))
    renderOrganizeBody(body, checked)
  }

  function renderOrganizeBody(body, checked) {
    const listEl = h('div')
    for (const tag of lib) {
      const cb = h('input', { type: 'checkbox', checked: checked.has(tag.id),
        onchange: (e) => { if (e.target.checked) checked.add(tag.id); else checked.delete(tag.id) },
      })
      listEl.append(h('div', { class: 'q', style: { cursor: 'default' } },
        cb,
        h('div', { class: 'q-body' },
          h('div', { class: 'q-text' }, tag.name),
          h('div', { class: 'q-meta' },
            h('span', {}, `${tag.synonyms?.length || 0} 个同义词`),
            h('span', {}, `· 命中 ${tag.hits || 0} 次`),
            h('span', {}, `· 匹配阈值 ${tag.threshold}`),
          ),
        ),
      ))
    }
    const deleteBtn = h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)', color: 'var(--red)', marginTop: '6px' }, onclick: async () => {
      if (!checked.size) return
      await m.deleteTagLibraryTags(theme.id, [...checked])
      await refresh()
    } }, `删除所选 ${checked.size}`)
    clear(body)
    body.append(h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
      h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: () => { organizeMode = false; render() } }, '完成'),
      h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: () => {
        for (const t of lib) if (!t.hits) checked.add(t.id)
        renderOrganizeBody(body, checked)
      } }, '全选命中 0'),
    ), listEl, deleteBtn)
  }

  function renderThemeOps(body) {
    const nameInput = h('input', { class: 'txt', value: theme.name, style: { flex: '1', minWidth: '120px' } })
    const tagsInput = h('input', { class: 'txt', value: (theme.tags || []).join(', '), style: { flex: '1', minWidth: '120px' } })
    body.append(h('div', { class: 'q', style: { marginTop: '8px', flexDirection: 'column', alignItems: 'stretch', gap: '6px' } },
      h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '主题名'),
      h('div', { style: { display: 'flex', gap: '4px' } },
        nameInput,
        h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: async () => {
          const name = nameInput.value.trim()
          if (!name) return
          await m.renameTheme(theme.id, name)
          await refresh()
        } }, '保存'),
      ),
      h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '主题标签（逗号分隔）'),
      h('div', { style: { display: 'flex', gap: '4px' } },
        tagsInput,
        h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' }, onclick: async () => {
          await m.themeUpdate(theme.id, { tags: tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean) })
          await refresh()
        } }, '保存'),
      ),
      h('button', { class: 'btn', style: { padding: '2px 8px', fontSize: 'var(--t-caption)', color: 'var(--red)' }, onclick: async () => {
        await m.removeTheme(theme.id)
        await refresh()
        toast(`已删除主题「${theme.name}」`, 'var(--text-2)')
      } }, '删除主题…'),
    ))
  }

  render()
  return band
}

/** 空白主题补生成骨架入口（E3） */
function renderSkeletonPrompt(theme) {
  if (!theme) return null
  const hasBranch = state.nodes.some((n) => n.kind === 'branch')
  if (hasBranch) return null
  const box = h('div', { class: 'sect', style: { marginBottom: '0' } },
    h('div', { class: 'sect-b' },
      h('p', { style: { margin: '0 0 8px', fontSize: 'var(--t-body)', color: 'var(--text-3)' } }, '这个主题还没有骨架。'),
      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        (() => {
          const input = h('input', {
            class: 'txt', placeholder: '一句话描述生成骨架 + 标签库',
            style: { flex: '1', minWidth: '180px' },
            onkeydown: async (e) => {
              if (e.key === 'Enter') {
                const desc = input.value.trim()
                if (!desc) return
                input.disabled = true
                await m.scaffoldExisting(theme.id, desc)
                await refresh()
              }
            },
          })
          return h('div', { style: { display: 'flex', gap: '4px', flex: '1', minWidth: '180px' } },
            input,
            h('button', {
              class: 'btn btn-primary', style: { padding: '2px 10px' },
              onclick: async () => {
                const desc = input.value.trim()
                if (!desc) return
                input.disabled = true
                await m.scaffoldExisting(theme.id, desc)
                await refresh()
              },
            }, '生成'),
          )
        })(),
      ),
    ),
  )
  return box
}

export function renderLattice(mid) {
  const theme = state.themes.find((t) => t.id === state.themeId)
  const isGraph = state.shape === 'graph'
  const indicators = state.nodes.filter((node) => node.type === 'observation' && node.status !== 'dead')
  // 有没有读数看的是「服务端判定的最新快照里有没有这个节点」。
  // 曾经数的是 channelIds——读数早就不通过通道挂了，那个数永远是满的。
  const unlinked = indicators.filter((node) => !state.latestByNode.has(node.id)).length
  const pendingCount = state.pendingReadings.length
  const headStats = h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } },
    `${indicators.length} 个指标 · ${unlinked} 个未接数据`,
    // 待归位的读数没有节点可挂，树里永远排不下它——给个入口跳去读数页处理
    pendingCount ? h('button', {
      class: 'link-btn', style: { marginLeft: '6px' },
      onclick: () => setView('readings'),
      title: '有待归位的读数，去读数页把它们挂到指标上',
    }, `· ${pendingCount} 个待归位`) : null,
  )

  // 树形管逐条编辑，图管看清结构——同一个主题、同一个选中项，来回切不丢上下文
  const head = h('div', { class: 'mid-head hairline-b' },
    h('h1', {}, theme ? theme.name : ''),
    h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, headStats),
    h('div', { class: 'spacer' }),
    // 重新生成骨架：产业链每季度都在变，这是常态按钮不是一次性冷启动。
    // 破坏性操作——先提示会删掉原有环节和命题，确认后才动。异步执行，不卡界面。
    isGraph ? null : (() => {
      const btn = h('button', {
        class: 'btn regenerate-btn', title: '重新生成骨架',
        onclick: async () => {
          if (!theme) return
          const ok = await confirmToast(
            `重新生成「${theme.name}」的骨架？\n\n将删除该主题下所有环节和命题，并重新生成。此操作不可撤销。`,
            '重新生成',
          )
          if (!ok) return
          btn.disabled = true
          btn.textContent = '生成中…'
          try {
            await m.regenerateTheme(theme.id)
          } catch {
            btn.disabled = false
            btn.textContent = '重新生成'
          }
        },
      }, icon('lattice', 12), '重新生成')
      return btn
    })(),
    h('div', { class: 'seg seg-shape' },
      h('button', {
        'aria-selected': isGraph ? 'false' : 'true',
        onclick: () => setShape('tree'),
      }, '树形'),
      h('button', {
        'aria-selected': isGraph ? 'true' : 'false',
        onclick: () => setShape('graph'),
      }, '图'),
    ),
    isGraph ? null : h('button', {
      class: 'btn btn-icon', title: '新建环节', onclick: () => newNode(null),
    }, icon('plus', 14)),
  )

  if (isGraph) {
    const wrap = h('div', { class: 'graph-wrap' })
    for (const el of [head, renderSkeletonPrompt(theme), renderTagLibraryBand(theme), h('div', { class: 'graph-debug' }, wrap)]) if (el) mid.append(el)
    try {
      renderGraph(wrap)
    } catch (e) {
      console.error('[graph] render failed:', e)
      wrap.append(h('div', { class: 'graph-error', style: { padding: '20px', color: 'red' } },
        h('p', {}, '图渲染失败：' + e.message)))
    }
    wireKeys(wrap)
    return
  }

  const tree = h('div', { class: 'tree' })
  for (const el of [head, renderSkeletonPrompt(theme), renderTagLibraryBand(theme), h('div', { class: 'tree-wrap' }, tree)]) if (el) mid.append(el)
  paint(tree)
  wireKeys(tree)
}

function flatten() {
  const byParent = new Map([[null, []]])
  for (const n of state.nodes) {
    const key = n.parentId || null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(n)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return byParent
}

/**
 * 聚合一层下面的命题：平均确信度、条数、待结算数。
 * 收起时整棵树只剩环节名——没有这三个数，「一目了然」就只是句空话。
 */
function aggregate(byParent, id) {
  let sum = 0, n = 0, due = 0
  const stack = [id]
  const seen = new Set()
  while (stack.length) {
    for (const c of byParent.get(stack.pop()) || []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (c.kind === 'lemma') {
        if (c.status !== 'dead') { sum += c.confidence; n++ }
        if (c.settlement && c.settlement.resolved == null && c.settlement.date <= todayStr()) due++
      }
      stack.push(c.id)
    }
  }
  return { avg: n ? Math.round(sum / n) : null, count: n, due }
}

/**
 * 信心组件——全产品唯一形态。
 *
 * 档位 + 悬停精确值：扫读时看档位（四档色），校准要的数值在 hover/选中时给出。
 * 条和数字是同一个元素，不再是两个同权重的元信息。
 */
function confCell(value, opts = {}) {
  const v = Math.max(0, Math.min(100, Math.round(value)))
  const tier = v >= 70 ? 'ok' : v >= 45 ? 'warn' : v >= 20 ? 'risk' : 'dead'
  return h('span', {
    class: `conf${opts.agg ? ' conf-agg' : ''}`,
    dataset: { tier },
    title: `信心 ${v} / 100`,
  },
    // 填充量走 CSS 变量——::after 读它，元素本身只做轨道
    h('i', { class: 'conf-bar', style: { '--w': `${v}%` } }),
    h('b', { class: 'conf-num' }, String(v)),
  )
}

function paint(container) {
  clear(container)
  const byParent = flatten()
  const q = state.query.trim().toLowerCase()

  const keep = (n) => {
    if (!q) return true
    if (n.title.toLowerCase().includes(q)) return true
    return (byParent.get(n.id) || []).some(keep)
  }

  // 环节序号按未过滤的根序列算，过滤时编号才不会跳
  const stageNo = new Map((byParent.get(null) || []).map((n, i) => [n.id, i + 1]))
  const aggCache = new Map()
  const agg = (id) => {
    if (!aggCache.has(id)) aggCache.set(id, aggregate(byParent, id))
    return aggCache.get(id)
  }

  /** scaffold 摘要：环节的子命题回答了几道题，几条指标有结算日 */
  function scaffoldSummary(node) {
    const sc = node.scaffold
    if (!sc) return null
    const kids = byParent.get(node.id) || []
    const lemmas = kids.filter((k) => k.kind === 'lemma')
    const answered = lemmas.filter((l) => l.settlement?.resolved != null).length
    const indicators = (sc.indicators || []).length
    const hasSettlement = lemmas.some((l) => l.settlement?.date)
    return { answered, total: (sc.answer || []).length, indicators, hasSettlement }
  }

  /**
   * 每个子层包一层 .lvl，导轨画在它左边。
   * 之前 draw() 把所有行平铺进同一个容器，styles.css 里的 .children::before
   * 从来没有对应的元素，等于白写——缩进成了唯一的层级线索。
   */
  const draw = (parentId, depth) => {
    const list = byParent.get(parentId) || []
    if (!list.length) return null
    const lvl = h('div', {
      class: 'lvl',
      dataset: { depth: String(depth) },
      style: { '--rail': `${railX(depth)}px` },
    })

    for (const node of list) {
      if (q && !keep(node)) continue
      const kids = byParent.get(node.id) || []
      const open = q ? true : state.open.has(node.id)
      const isLemma = node.kind === 'lemma'
      const isStage = !isLemma && depth === 0
      const conf = Math.round(node.confidence)
      const propagated = node.history.some((x) => x.by === 'propagation')
      const due = node.settlement && node.settlement.resolved == null && node.settlement.date <= todayStr()
      const dead = node.status === 'dead'
      const cold = node.status === 'cold'
      const srcs = node.sources?.length || 0
      const a = isLemma ? null : agg(node.id)

      const sc = node.scaffold
      const scSum = !isLemma && sc ? scaffoldSummary(node) : null
      // 右缘只留三样，优先级固定：裁决状态 > 信心 > 源计数。其余全部降为 hover 提示——
      // 一行摆 8-9 个同权重元素时，用户找不到该看哪个。
      // 指标节点 inline 显示最新读数——总览层：打开树就看见所有指标当前站哪，
      // 不用切去读数页。读数是流水，这里是快照，两个视角不重叠。
      const latestReading = isLemma && node.type === 'observation'
        ? state.latestByNode.get(node.id)
        : null
      const meta = h('span', { class: 'row-meta' },
        // ① 裁决状态：结算旗 / 已证伪 / 环节的待结算数，合并成一个图标位
        isLemma
          ? (node.settlement?.resolved != null && !node.settlement?.correct
              ? h('span', { class: 'verdict-ic is-cf', title: '已证伪' }, icon('flag', 11))
              : h('span', { class: 'verdict-ic', dataset: { due: String(!!due) }, title: due ? '已到结算日' : '有结算日' }, icon('flag', 11)))
          : a.due ? h('span', { class: 'chip chip-due', title: `${a.due} 条待结算` }, icon('flag', 9), String(a.due)) : null,
        // ② 信心：唯一组件，条 + 数字一体
        isLemma || a.avg != null ? confCell(isLemma ? conf : a.avg, { agg: !isLemma }) : null,
        latestReading ? h('span', { class: 'row-reading', title: periodLabel(latestReading), dataset: { status: latestReading.status || '' } },
          isConflicted(latestReading) ? '待裁决' : `${fmtCompact(latestReading.value)}${latestReading.unit ? ' ' + latestReading.unit : ''}`,
          trustMark(latestReading),
        ) : isLemma && node.type === 'observation' ? h('span', { class: 'row-reading' }, state.readingsError ? '读数暂不可用' : '尚无读数') : null,
        // ③ 源计数
        srcs > 1 ? h('span', { class: 'src-chip', title: `${srcs} 个独立来源` }, `${srcs} 源`) : null,
        // 以下都只是 hover：类型徽章、冷库、传导、scaffold 进度
        isLemma ? h('span', { class: 'row-hint', title: `类型：${TYPE_LABEL[node.type]}` }, TYPE_LABEL[node.type]) : null,
        cold ? h('span', { class: 'row-hint', title: '在冷库' }, '冷') : null,
        propagated ? h('span', { class: 'row-hint', title: '14 天内有传导' }, '传导') : null,
        scSum ? h('span', { class: 'row-hint', title: `已回答 ${scSum.answered} / ${scSum.total} 题 · ${scSum.indicators} 项指标` },
            `已答 ${scSum.answered}/${scSum.total}`
          ) : null,
        // 悬停操作：删除、加子项、切换冷库。不用点到右边栏
        h('span', { class: 'row-acts' },
          h('button', {
            class: 'row-act', title: '删除', onclick: (e) => { e.stopPropagation(); confirmDelete(node.id) },
          }, icon('trash', 11)),
          isLemma
            ? h('button', {
                class: 'row-act', title: node.status === 'cold' ? '移出冷库' : '移入冷库',
                onclick: (e) => { e.stopPropagation(); toggleCold(node.id) },
              }, icon('lattice', 11))
            : h('button', {
                class: 'row-act', title: '加子命题',
                onclick: (e) => { e.stopPropagation(); addChildHere(node.id) },
              }, icon('plus', 11)),
        ),
      )

      const row = h('button', {
        class: `row ${isLemma ? 'row-lemma' : 'row-branch'}${isStage ? ' row-stage' : ''}`,
        dataset: { id: node.id, depth: String(depth) },
        'aria-selected': state.selectedId === node.id ? 'true' : 'false',
        style: { paddingLeft: `${PAD + depth * INDENT}px`, opacity: dead ? 0.45 : 1 },
        onclick: () => selectNode(node.id),
        ondblclick: () => {
          if (isLemma) startEdit(row, node)
          else toggle(node.id, container)
        },
      },
        h('span', {
          class: 'twist',
          dataset: { open: kids.length ? String(open) : 'true', leaf: kids.length ? 'false' : 'true' },
          onclick: (e) => { e.stopPropagation(); toggle(node.id, container) },
        }, kids.length ? icon('chevron', 10) : h('i', { class: 'leaf-dot' })),
        isStage ? h('span', { class: 'stage-no', title: '产业链第几层' }, String(stageNo.get(node.id))) : null,
        h('span', { class: 'row-title' }, node.title),
        meta,
      )

      lvl.append(row)
      if (kids.length && open) {
        const sub = draw(node.id, depth + 1)
        if (sub) lvl.append(sub)
      }
    }
    return lvl
  }

  // draw() 在没有子节点时返回 null。原生 append(null) 会把 null 转成字符串 "null"
  // 追加进去——新主题还没铺骨架的那几秒，树里就挂着一个裸 "null"。
  const root = draw(null, 0)
  if (root) container.append(root)
}

function toggle(id, container) {
  state.open.has(id) ? state.open.delete(id) : state.open.add(id)
  paint(container)
}

function startEdit(row, node) {
  const titleEl = row.querySelector('.row-title')
  if (!titleEl || titleEl.dataset.editing === 'true') return
  titleEl.dataset.editing = 'true'
  row.classList.add('row-editing')
  let saving = false
  const input = h('input', { class: 'txt row-edit', value: node.title, 'aria-label': '命题标题' })
  const type = h('select', { class: 'sel', 'aria-label': '命题类型' },
    ...Object.entries(TYPE_LABEL).map(([value, label]) => h('option', { value }, label)))
  type.value = node.type
  const confidence = h('input', { class: 'txt', type: 'number', min: 0, max: 100, value: node.confidence, 'aria-label': '置信度' })
  const date = h('input', { class: 'txt', type: 'date', value: node.settlement?.date || '', 'aria-label': '结算日' })
  const save = h('button', { class: 'btn row-edit-save', type: 'button', onclick: commit }, '保存')
  const editor = h('span', {
    class: 'row-editor', onclick: (e) => e.stopPropagation(),
    onkeydown: (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); cancel() }
      if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'SELECT') { e.preventDefault(); commit() }
    },
  }, input,
    node.kind === 'lemma' ? [
      type,
      h('label', {}, '置信度', confidence),
      h('label', {}, '结算日', date),
    ] : null,
    save, h('button', { class: 'btn', type: 'button', onclick: cancel }, '取消'),
  )
  titleEl.replaceChildren(editor)
  input.focus()
  input.select()

  function cancel() {
    if (saving) return
    titleEl.dataset.editing = 'false'
    titleEl.textContent = node.title
    row.classList.remove('row-editing')
    row.focus()
  }

  async function commit() {
    if (saving || !input.value.trim() || !input.checkValidity() || (node.kind === 'lemma' && (!confidence.checkValidity() || !date.checkValidity()))) return
    saving = true
    save.disabled = true
    const patch = { title: input.value.trim() }
    if (node.kind === 'lemma') {
      patch.type = type.value
      patch.confidence = Number(confidence.value)
      patch.settlement = date.value === (node.settlement?.date || '')
        ? node.settlement
        : date.value ? { date: date.value, resolved: null, correct: null } : null
    }
    try {
      await m.updateNode(node.id, patch)
      await refresh()
      document.querySelector(`.row[data-id="${node.id}"]`)?.focus()
    } catch (e) {
      toast('保存失败：' + e.message, 'var(--red)')
      saving = false
      save.disabled = false
    }
  }
}

async function confirmDelete(id) {
  await deleteNodeWithUndo(id)
}

async function toggleCold(id) {
  const node = state.nodes.find((n) => n.id === id)
  if (!node) return
  await m.updateNode(id, { status: node.status === 'cold' ? 'live' : 'cold' })
  await refresh()
}

async function addChildHere(parentId) {
  const node = await m.getNode(parentId)
  if (!node) return
  const child = await m.addNode({
    themeId: state.themeId,
    parentId,
    kind: node.kind === 'branch' ? 'lemma' : 'lemma',
    title: '未命名命题',
    confidence: 50,
  })
  state.selectedId = child.id
  state.open.add(parentId)
  await refresh()
  const row = document.querySelector(`.row[data-id="${child.id}"]`)
  row?.scrollIntoView({ block: 'nearest' })
  if (row) startEdit(row, child)
}

/** ⏎ = 兄弟，Tab = 子层。树形和图共用一套——编辑动作不该因为换了视图就变。 */
export async function newNode(mode) {
  const sel = state.nodes.find((n) => n.id === state.selectedId)
  let spec

  if (!sel) spec = { parentId: null, kind: 'branch', title: '新的环节' }
  else if (mode === 'child') {
    spec = { parentId: sel.id, kind: 'lemma', title: '未命名命题' }
    state.open.add(sel.id)
  } else {
    spec = { parentId: sel.parentId || null, kind: sel.kind, title: sel.kind === 'branch' ? '新的环节' : '新命题' }
    if (sel.parentId) state.open.add(sel.parentId)
  }

  const node = await m.addNode({ themeId: state.themeId, confidence: 50, ...spec })
  state.selectedId = node.id
  await refresh()
  const row = document.querySelector(`.row[data-id="${node.id}"]`)
  row?.scrollIntoView({ block: 'nearest' })
  if (row) startEdit(row, node)
}

/** 树中回车建同级、Tab 建子层；图中回车回树编辑。两种形态共享移动和软删。 */
export function wireKeys(container) {
  container.tabIndex = 0
  container.onkeydown = async (e) => {
    if (e.target.closest('input, textarea, select, .row-editor, [contenteditable]')) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (state.shape === 'graph') {
        const node = state.nodes.find((item) => item.id === state.selectedId)
        setShape('tree')
        requestAnimationFrame(() => {
          const row = document.querySelector(`.row[data-id="${state.selectedId}"]`)
          if (row && node) startEdit(row, node)
        })
      } else {
        await newNode('sibling')
      }
      return
    }
    if (e.key === 'Tab' && state.shape === 'tree') { e.preventDefault(); await newNode('child'); return }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
      e.preventDefault()
      if (state.selectedId) await deleteNodeWithUndo(state.selectedId)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const selector = state.shape === 'graph' ? '.node' : '.row'
      const rows = [...container.querySelectorAll(selector)]
      const i = rows.findIndex((row) => row.dataset.id === state.selectedId)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta))]
      if (next) selectNode(next.dataset.id)
    }
  }
}
