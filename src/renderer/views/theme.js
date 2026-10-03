import { h, toast, confirmToast } from '../lib/dom.js'
import { state, refresh, setView } from '../app.js'
import { renderChainSection, openNodeDetail, openEvidenceDetail } from './chain.js'
import { renderReaderView } from './reader.js'
import { requestBuilderPane, requestBuilderNodeFocus, requestChainEventJump } from '../lib/chain-ui-model.js'

const m = window.meridian
const themeViewKey = (themeId) => `meridian:theme-view:${themeId}`

/** 主题操作区：主题名 / 主题标签 / 删除主题（原嵌在标签库段内，标签库删除后独立成段）。 */
function renderThemeOpsSection(theme) {
  if (!theme) return null
  const nameInput = h('input', { class: 'txt', value: theme.name, style: { flex: '1', minWidth: '120px' } })
  const tagsInput = h('input', { class: 'txt', value: (theme.tags || []).join(', '), style: { flex: '1', minWidth: '120px' } })
  const body = h('div', { class: 'sect-b', id: `theme-ops-${theme.id}`, role: 'region', 'aria-label': '主题设置', hidden: true })
  let expanded = false
  const toggle = h('button', {
    type: 'button', class: 'sect-h', 'aria-controls': body.id, 'aria-expanded': 'false',
    onclick: () => {
      expanded = !expanded
      body.hidden = !expanded
      toggle.setAttribute('aria-expanded', String(expanded))
    },
  }, h('span', {}, '主题设置'))
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
      const ok = await confirmToast(`删除主题「${theme.name}」？\n\n将删除该主题下所有内容，此操作不可撤销。`, '删除主题')
      if (!ok) return
      await m.removeTheme(theme.id)
      await refresh()
      toast(`已删除主题「${theme.name}」`, 'var(--text-2)')
    } }, '删除主题…'),
  ))
  return h('div', { class: 'sect theme-ops' }, toggle, body)
}

/** Display existing theme tags without inventing a separate category field. */
function renderThemeMetadata(theme) {
  const tags = Array.isArray(theme?.tags) ? theme.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : []
  if (!tags.length) return null
  return h('section', { class: 'theme-topic-meta', 'aria-label': '主题标签' },
    h('span', { class: 'theme-topic-meta-label' }, '主题标签'),
    tags.length
      ? h('div', { class: 'theme-topic-tags' }, ...tags.map((tag) => h('span', { class: 'theme-topic-tag' }, tag)))
      : h('span', { class: 'theme-topic-empty-tag' }, '暂未添加标签 · 可在主题设置中补充'))
}

/** Legacy optional scaffold helper; the graph-first theme page no longer mounts it. */
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
            class: 'txt', placeholder: '一句话描述生成骨架',
            style: { flex: '1', minWidth: '180px' },
          })
          const btn = h('button', {
            class: 'btn btn-primary', style: { padding: '2px 10px' },
            onclick: () => startGen(),
          }, '生成')
          const startGen = async () => {
            const desc = input.value.trim()
            if (!desc || btn.disabled) return
            // 两个控件一起锁——之前只禁了 input，按钮还能点，连点就触发 in-flight，
            // 渲染层还把它当成功弹「骨架已生成」。
            input.disabled = true
            btn.disabled = true
            btn.textContent = '生成中…'
            state.pendingScaffoldDesc = desc
            try {
              // 不在这里 refresh——等 theme:scaffolded / 轮询回来统一 settle，
              // 按钮由 settle 刷新恢复，事件丢了也有轮询兜底。
              trackScaffold(theme.id)
              await m.scaffoldExisting(theme.id, desc)
            } catch {
              input.disabled = false
              btn.disabled = false
              btn.textContent = '生成'
            }
          }
          input.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            await startGen()
          })
          return h('div', { style: { display: 'flex', gap: '4px', flex: '1', minWidth: '180px' } },
            input,
            btn,
          )
        })(),
      ),
    ),
  )
  return box
}

/**
 * 主题页：顶层只有两个视图——读者视图（当前结论是什么、如何推导）与
 * 建设者视图（认知如何一步一步演化）。记住用户上次的选择；新主题
 * （0 节点）首次打开直接进建设者视图，因为没什么可读的。
 */
export function renderTheme(mid) {
  const theme = state.themes.find((t) => t.id === state.themeId)
  const readerTab = h('button', { type: 'button', class: 'theme-view-tab', role: 'tab', 'aria-selected': 'false', tabindex: '-1' }, '读者')
  const builderTab = h('button', { type: 'button', class: 'theme-view-tab', role: 'tab', 'aria-selected': 'false', tabindex: '-1' }, '建设者')
  const viewSwitch = h('div', { class: 'theme-view-switch', role: 'tablist', 'aria-label': '主题视图' }, readerTab, builderTab)
  const leading = h('div', { class: 'theme-reference-leading' },
    h('button', { type: 'button', class: 'theme-reference-back', 'aria-label': '返回应用导航', onclick: () => setView('today') }, '‹'))
  const head = h('header', { class: 'mid-head hairline-b theme-reference-head' })

  const openOpts = {
    onEvidence: openEvidenceDetail,
    onOpen: (node, callbacks = {}) => openNodeDetail(theme, node, { ...callbacks, onEvidence: openEvidenceDetail }),
  }
  const body = h('div', { class: 'theme-body' })
  const metaEl = renderThemeMetadata(theme)
  const viewHost = h('div', { class: 'theme-view-host' })
  const opsEl = renderThemeOpsSection(theme)
  for (const el of [metaEl, viewHost]) if (el) body.append(el)
  const headActions = h('div', { class: 'theme-reference-right' },
    h('span', { class: 'theme-reference-context' }, '事件账本 · 可追溯'), opsEl)
  head.append(leading, viewSwitch, headActions)
  mid.append(head, body)

  const paintTabs = (view) => {
    const isReader = view === 'reader'
    readerTab.classList.toggle('is-active', isReader)
    builderTab.classList.toggle('is-active', !isReader)
    readerTab.setAttribute('aria-selected', String(isReader))
    builderTab.setAttribute('aria-selected', String(!isReader))
    readerTab.tabIndex = isReader ? 0 : -1
    builderTab.tabIndex = isReader ? -1 : 0
  }

  const mount = (view, preloaded = null) => {
    paintTabs(view)
    viewHost.innerHTML = ''
    try { localStorage.setItem(themeViewKey(theme.id), view) } catch { /* 忽略存储失败 */ }
    if (view === 'reader') {
      viewHost.append(renderReaderView(theme, {
        loadProjection: async () => preloaded?.projection || m.chainProjection(theme.id),
        loadProjectionAt: async (sequence) => m.chainProjectionAt(theme.id, sequence),
        initialSequence: preloaded?.initialSequence,
        autoPlay: preloaded?.autoPlay,
        loadEvents: async () => preloaded?.events
          || (await m.chainEvents(theme.id).catch(() => null))?.events || [],
        onOpenBuilder: (kind, nodeId, eventId) => {
          if (kind && kind !== 'network') requestBuilderPane(theme.id, kind)
          if (nodeId) requestBuilderNodeFocus(theme.id, nodeId)
          if (eventId) requestChainEventJump(theme.id, eventId)
          mount('builder')
        },
      }))
    } else {
      viewHost.append(renderChainSection(theme, {
        ...openOpts,
        initialProjection: preloaded?.projection || null,
        initialEvents: preloaded?.events || null,
        onViewAtSequence: (sequence, play = false) => mount('reader', { initialSequence: sequence, autoPlay: play }),
        onReturnLive: () => mount('reader'),
      }))
    }
  }
  readerTab.addEventListener('click', () => mount('reader'))
  builderTab.addEventListener('click', () => mount('builder'))
  viewSwitch.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    mount(readerTab.classList.contains('is-active') ? 'builder' : 'reader')
  })

  const saved = (() => { try { return localStorage.getItem(themeViewKey(theme.id)) } catch { return null } })()
  if (saved === 'reader' || saved === 'builder') {
    mount(saved)
  } else {
    paintTabs('builder')
    viewHost.append(h('p', { class: 'chain-note' }, '正在判断主题成熟度…'))
    Promise.all([
      m.chainProjection(theme.id).catch(() => null),
      m.chainEvents(theme.id).catch(() => null),
    ]).then(([proj, evRes]) => {
      const count = proj?.allNodes?.length || proj?.nodes?.length || 0
      mount(count === 0 ? 'builder' : 'reader', { projection: proj, events: evRes?.events || [] })
    }).catch(() => mount('builder'))
  }
}
