import { h, toast, confirmToast } from '../lib/dom.js'
import { state, refresh } from '../app.js'
import { renderChainSection, openSegmentDetail, openEvidenceDetail } from './chain.js'

const m = window.meridian

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
  return h('div', { class: 'sect' }, toggle, body)
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
 * 主题页：主题名 + 认知链 + 主题设置。
 * 2026-10-01 树/图视图删除，主题页只剩认知链为主要展示。
 */
export function renderTheme(mid) {
  const theme = state.themes.find((t) => t.id === state.themeId)
  const head = h('div', { class: 'mid-head hairline-b' },
    h('h1', {}, theme ? theme.name : ''),
  )
  const chainSection = () => renderChainSection(theme, {
    onOpen: (seg) => openSegmentDetail(theme, seg, { onEvidence: openEvidenceDetail }),
    onEvidence: openEvidenceDetail,
  })
  // 主题头固定，下方内容区独立滚动；右栏检视面板本就独立滚动，不受影响
  const body = h('div', { class: 'theme-body' })
  for (const el of [renderSkeletonPrompt(theme), chainSection(), renderThemeOpsSection(theme)]) if (el) body.append(el)
  mid.append(head, body)
}
