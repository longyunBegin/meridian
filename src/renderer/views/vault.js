import { h, clear, toast } from '../lib/dom.js'
import { state } from '../app.js'
import { TYPE_LABEL } from './shared.js'

export { renderReadings, renderSources } from './readings.js'

const m = window.meridian

const META = {
  cold: {
    title: '冷库',
    note: '暂存的外部弱信号：低质、未证实，但可能为真。维度是外部数据源，不是主题原子。解冻只改状态，不碰权重，也不是归档恢复。',
  },
  archive: {
    title: '归档',
    note: '外部数据的归档记录。维度是证据 / 来源，不是主题原子。恢复会追加新事件，不删除旧记录。',
  },
}
let eventArchiveFilter = 'evidence'
let eventArchiveQuery = ''
const EVENT_ARCHIVE_FILTERS = [
  ['evidence', '证据'],
  ['all', '全部'],
  ['viewpoint', '观点'],
  ['concept', '概念'],
  ['object', '对象'],
  ['event', '事件'],
]

function archiveNodeType(node) {
  if (node?.nodeType) return node.nodeType
  if (node?.kind === 'claim' || node?.kind === 'inference') return 'viewpoint'
  return node?.kind || ''
}

function themeNameOf(themeId, theme) {
  return theme?.name || state.themes.find((t) => t.id === themeId)?.name || '已删主题'
}

function textOr(value, fallback = '未记录') {
  const text = String(value || '').trim()
  return text || fallback
}

/** chain:getArchive 已不再返回 integrity（verifyChain 已删除）；缺省视为可读。 */
function normalizeArchiveResult(result) {
  if (!result || !Array.isArray(result.nodes) || !Array.isArray(result.edges)) return null
  const integrity = result.integrity && typeof result.integrity.ok === 'boolean'
    ? result.integrity
    : { ok: true }
  return { ...result, integrity }
}

/** 详情字段行：只展示有内容的项。 */
function detailRows(rows) {
  return rows
    .filter((row) => row && row.value != null && String(row.value).trim() !== '')
    .map((row) => h('div', { class: 'vault-detail-row' },
      h('span', { class: 'vault-detail-k' }, row.label),
      h('span', { class: 'vault-detail-v' }, String(row.value))))
}

/**
 * 「查看」= 本页展开该条详情。
 * 禁止 selectNode / setView('theme')：冷库与归档的维度是外部数据，不是建设者原子。
 */
function attachDetailToggle(row, detail, viewBtn) {
  viewBtn.setAttribute('aria-expanded', 'false')
  viewBtn.onclick = (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    const open = detail.hasAttribute('hidden')
    if (open) detail.removeAttribute('hidden')
    else detail.setAttribute('hidden', '')
    viewBtn.setAttribute('aria-expanded', String(open))
    viewBtn.textContent = open ? '收起' : '查看'
    row.classList.toggle('is-open', open)
  }
}

function viewDetailButton() {
  return h('button', { type: 'button', class: 'btn vault-view-btn' }, '查看')
}

export async function renderVault(mid, kind) {
  clear(mid)
  if (kind === 'archive' || kind === 'dead') return renderArchive(mid, META.archive)
  return renderCold(mid, META.cold)
}

/**
 * 冷库：外部数据冷冻条目。
 * - 账本投影：node.parked → cold 的证据（建设者判卡「冷冻」写入）
 * - 旧命题库：status==='cold' 的 lemma（兼容历史）
 */
async function renderCold(mid, meta) {
  clear(mid)
  const themes = Array.isArray(state.themes) ? state.themes.filter((t) => t && typeof t.id === 'string') : []
  const [lemmas, parkedResults] = await Promise.all([
    m.allNodes().catch(() => null),
    Promise.all(themes.map((theme) => loadParkedForTheme(theme))),
  ])
  if (!Array.isArray(lemmas)) {
    mid.append(h('div', { class: 'page vault-page' },
      h('div', { class: 'page-head' }, h('h1', {}, meta.title), h('p', {}, meta.note)),
      h('p', { class: 'cog-integrity is-error', role: 'alert' }, '冷库暂时无法读取。'),
      h('button', { type: 'button', class: 'btn', onclick: () => renderCold(mid, meta) }, '重试')))
    return
  }

  const legacyCold = lemmas.filter((n) => n && n.status === 'cold')
  const parked = parkedResults.flatMap(({ theme, nodes }) => (nodes || []).map((node) => ({ theme, node })))
  const total = legacyCold.length + parked.length

  const page = h('div', { class: 'page vault-page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note)))

  if (!total) {
    page.append(empty(meta))
    mid.append(page)
    return
  }

  const list = h('div', { class: 'vault-entries', role: 'list' })
  for (const item of parked) list.append(parkedColdRow(item, () => renderCold(mid, meta)))
  for (const node of legacyCold) list.append(legacyColdRow(node, () => renderCold(mid, meta)))

  page.append(h('section', { class: 'sect vault-sect' },
    h('div', { class: 'sect-h' },
      h('h2', {}, parked.length ? '冷冻条目' : '历史冷库条目'),
      h('em', {}, String(total))),
    list))
  mid.append(page)
}

/**
 * 优先 chain:getParked；命令不可用或主题无账本时回退投影。
 * 单主题失败只当「无冷冻条目」，不刷整页红条——冷库页要能稳定浏览其余主题。
 */
async function loadParkedForTheme(theme) {
  try {
    if (typeof m.chainParked === 'function') {
      const result = await m.chainParked(theme.id)
      if (Array.isArray(result?.nodes)) return { theme, nodes: result.nodes }
    }
  } catch { /* 回退投影 */ }
  try {
    const proj = await m.chainProjection(theme.id)
    const rows = Array.isArray(proj?.allNodes) ? proj.allNodes
      : Array.isArray(proj?.nodes) ? proj.nodes : []
    const nodes = rows.filter((node) => node && node.nodeType === 'evidence'
      && node.cold && !node.archived && !node.external)
    return { theme, nodes }
  } catch {
    return { theme, nodes: [] }
  }
}

function parkedColdRow({ theme, node }, refresh) {
  const title = textOr(node.title || node.currentText, '未命名外部数据')
  const detail = h('div', { class: 'vault-detail', hidden: true },
    ...detailRows([
      { label: '原文', value: node.currentText || node.title },
      { label: '主题', value: themeNameOf(theme.id, theme) },
      { label: '来源', value: node.sourceLabel },
      { label: '链接', value: node.sourceUrl },
      { label: '冷冻原因', value: node.parkReason },
      { label: '冷冻时间', value: String(node.parkedAt || '').slice(0, 19).replace('T', ' ') },
      { label: '引用', value: node.sourceRef },
    ]))
  const viewBtn = viewDetailButton()
  const row = h('article', { class: 'tomb-row vault-row', role: 'listitem' },
    h('div', { class: 'tomb-body' },
      h('div', { class: 'tomb-title' },
        h('span', { class: 'tomb-pill' }, '外部数据 · 冷库'),
        h('span', {}, title.length > 120 ? `${title.slice(0, 120)}…` : title)),
      h('div', { class: 'tomb-meta' },
        `${themeNameOf(theme.id, theme)}`,
        node.sourceLabel ? ` · ${node.sourceLabel}` : '',
        node.parkedAt ? ` · ${String(node.parkedAt).slice(0, 10)}` : ''),
      detail),
    h('div', { class: 'tomb-acts vault-acts' },
      viewBtn,
      h('button', {
        type: 'button', class: 'btn btn-primary',
        onclick: async (ev) => {
          const button = ev.currentTarget
          button.disabled = true
          try {
            const result = await m.chainUnparkNode(theme.id, node.sourceRef, '从冷库解冻')
            if (result?.ok === false) throw new Error(result.error || '解冻未完成')
            toast('已解冻，外部数据回到主题待判')
            await refresh()
          } catch (error) {
            toast(`解冻失败：${error?.message || error}`, 'var(--red)')
            button.disabled = false
          }
        },
      }, '解冻')))
  attachDetailToggle(row, detail, viewBtn)
  return row
}

function legacyColdRow(node, refresh) {
  const title = textOr(node.title, '未命名')
  const detail = h('div', { class: 'vault-detail', hidden: true },
    ...detailRows([
      { label: '标题', value: node.title },
      { label: '类型', value: TYPE_LABEL[node.type] || node.type },
      { label: '主题', value: themeNameOf(node.themeId) },
      { label: '权重', value: Number.isFinite(Number(node.confidence)) ? String(Math.round(Number(node.confidence))) : null },
      { label: '状态', value: '冷库（历史条目）' },
    ]))
  const viewBtn = viewDetailButton()
  const row = h('article', { class: 'tomb-row vault-row', role: 'listitem' },
    h('div', { class: 'tomb-body' },
      h('div', { class: 'tomb-title' },
        h('span', { class: 'tomb-pill' }, '历史条目 · 冷库'),
        h('span', {}, title)),
      h('div', { class: 'tomb-meta' },
        TYPE_LABEL[node.type] || node.type || '未分类',
        Number.isFinite(Number(node.confidence)) ? ` · 权重 ${Math.round(Number(node.confidence))}` : '',
        ` · ${themeNameOf(node.themeId)}`),
      detail),
    h('div', { class: 'tomb-acts vault-acts' },
      viewBtn,
      h('button', {
        type: 'button', class: 'btn btn-primary',
        onclick: async (ev) => {
          const button = ev.currentTarget
          button.disabled = true
          try {
            await m.updateNode(node.id, { status: 'live' })
            toast('已解冻，条目回到主题')
            await refresh()
          } catch (error) {
            toast(`解冻失败：${error?.message || error}`, 'var(--red)')
            button.disabled = false
          }
        },
      }, '解冻')))
  attachDetailToggle(row, detail, viewBtn)
  return row
}

// ============================================================
// 归档：只读事件账本投影（node.archived）。恢复 = 追加 node.restored。
// ============================================================

function eventArchiveRow(item, refreshView) {
  const { theme, node, edges, integrity } = item
  const connectedEvidence = new Set(edges.filter((e) => e.rel === 'supports' && (e.from === node.id || e.to === node.id))
    .map((e) => e.from === node.id ? e.to : e.from)).size
  const date = String(node.archivedAt || '').slice(0, 10) || '未记录'
  const typeKey = archiveNodeType(node)
  const typeLabel = {
    claim: '主张', inference: '推断', evidence: '证据',
    viewpoint: '观点', concept: '概念', object: '对象', event: '事件',
  }[typeKey] || typeKey || node.kind
  const sourceRef = String(node.sourceRef || '')
  const lemmaId = sourceRef.match(/^lemma:(.+)$/)?.[1]
  const legacySource = lemmaId ? (state.nodes || []).find((candidate) => candidate.id === lemmaId) : null
  const sourceKindLabel = { segment: '主题观点', branch: '主题分支', mount: '收件箱挂载', lemma: '旧命题', 'legacy-node-source': '旧节点来源', 'shelved-proposal': '冷冻/归档的建议', 'engine-reviewed': '引擎复核' }[node.sourceKind]
  const sourceLabel = node.sourceLabel
    || (legacySource?.title ? legacySource.title : null)
    || sourceKindLabel
    || (sourceRef ? '有来源引用' : null)

  const detail = h('div', { class: 'vault-detail', hidden: true },
    ...detailRows([
      { label: '原文', value: node.currentText || node.title },
      { label: '主题', value: theme.name || themeNameOf(theme.id, theme) },
      { label: '类型', value: typeLabel },
      { label: '来源', value: sourceLabel },
      { label: '链接', value: node.sourceUrl },
      { label: '归档原因', value: node.archiveReason },
      { label: '归档时间', value: date },
      { label: '关联证据', value: String(node.evidenceCount ?? connectedEvidence) },
      { label: '引用', value: node.sourceRef },
      { label: '事件', value: (node.provenanceEventIds || node.eventIds || []).join(' · ') },
    ]),
    integrity?.ok === false
      ? h('p', { class: 'cog-integrity is-error', role: 'status' }, '仅展示最后校验有效前缀；账本损坏时不可追加恢复。')
      : null)

  const viewBtn = viewDetailButton()
  const row = h('article', { class: 'tomb-row event-archive-row vault-row', role: 'listitem' },
    h('div', { class: 'tomb-body' },
      h('div', { class: 'tomb-title' },
        h('span', { class: 'tomb-pill' }, `${typeLabel} · 已归档`),
        h('span', {}, node.title || '未命名')),
      node.archiveReason
        ? h('div', { class: 'tomb-core' }, `归档原因：${node.archiveReason}`)
        : null,
      h('div', { class: 'tomb-meta' },
        `${theme.name || '未命名主题'}`,
        sourceLabel ? ` · ${sourceLabel}` : '',
        ` · ${date}`),
      detail),
    h('div', { class: 'tomb-acts vault-acts' },
      viewBtn,
      h('button', {
        type: 'button', class: 'btn btn-primary',
        disabled: integrity?.ok !== true,
        title: integrity?.ok === true ? '追加恢复事件' : '账本未通过完整性校验，不能追加恢复',
        onclick: async (ev) => {
          const button = ev.currentTarget
          button.disabled = true
          try {
            const result = await m.chainRestoreNode(theme.id, node.sourceRef, '从归档恢复')
            if (result?.ok === false) throw new Error(result.error || '恢复未完成')
            toast('已追加恢复事件；原归档记录仍保留')
            await refreshView()
          } catch (error) {
            toast(`恢复失败：${error.message || error}`, 'var(--red)')
            button.disabled = false
          }
        },
      }, '恢复')))
  attachDetailToggle(row, detail, viewBtn)
  return row
}

async function renderArchive(mid, meta) {
  clear(mid)
  const themes = Array.isArray(state.themes) ? state.themes.filter((theme) => theme && typeof theme.id === 'string') : []
  const page = h('div', { class: 'page vault-page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note)))
  const loading = h('p', { class: 'chain-note', role: 'status', 'aria-live': 'polite' }, '正在读取归档记录…')
  page.append(loading)
  mid.append(page)
  const archiveResults = await Promise.all(themes.map(async (theme) => {
    try { return { theme, result: normalizeArchiveResult(await m.chainArchives(theme.id)) } }
    catch (error) { return { theme, error } }
  }))
  if (!page.isConnected) return
  loading.remove()
  const unreadableArchiveThemes = archiveResults.filter(({ result, error }) => error || !result
    || result.nodes.some((node) => !node || typeof node !== 'object')
    || result.edges.some((edge) => !edge || typeof edge !== 'object')).length
  const eventArchives = archiveResults.flatMap(({ theme, result }) => !result ? []
    : result.nodes.filter((node) => node && typeof node === 'object').map((node) => ({
      theme, node, edges: result.edges.filter((edge) => edge && typeof edge === 'object'), integrity: result.integrity,
    })))
  const damagedArchiveThemes = archiveResults.filter(({ result }) => result?.integrity?.ok === false).length

  const hasRecords = eventArchives.length > 0
  const hasWarnings = damagedArchiveThemes > 0 || unreadableArchiveThemes > 0
  if (damagedArchiveThemes) {
    page.append(h('p', { class: 'cog-integrity is-error tomb-data-warning', role: 'alert' },
      `${damagedArchiveThemes} 个主题的事件链校验失败；归档仅展示校验后的有效前缀，恢复操作已禁用。`))
  }
  if (unreadableArchiveThemes) {
    page.append(h('p', { class: 'cog-integrity is-error tomb-data-warning', role: 'alert' },
      `${unreadableArchiveThemes} 个主题的归档返回不完整或无法解析；可安全展示的部分仍保留。`))
  }
  if (!hasRecords && !hasWarnings) {
    page.append(empty(meta))
    return
  }

  if (eventArchives.length || unreadableArchiveThemes || damagedArchiveThemes) {
    const archiveList = h('div', { class: 'vault-entries event-archive-list', role: 'list' })
    const search = h('input', {
      class: 'txt event-archive-search', type: 'search', value: eventArchiveQuery,
      placeholder: '搜索名称、原因、主题或来源', 'aria-label': '搜索事件归档',
    })
    const controls = h('div', { class: 'event-archive-controls' },
      search,
      h('div', { class: 'tomb-filters', role: 'group', 'aria-label': '按类型筛选' },
        ...EVENT_ARCHIVE_FILTERS.map(([key, label]) => h('button', {
          type: 'button', class: `tomb-filter${eventArchiveFilter === key ? ' is-on' : ''}`,
          'aria-pressed': String(eventArchiveFilter === key),
          onclick: () => {
            eventArchiveFilter = key
            controls.querySelectorAll('.tomb-filter').forEach((button) => {
              const on = button.textContent === label
              button.classList.toggle('is-on', on)
              button.setAttribute('aria-pressed', String(on))
            })
            renderEventArchiveRows()
          },
        }, label))))
    const refreshView = () => renderArchive(mid, meta)
    const renderEventArchiveRows = () => {
      clear(archiveList)
      const query = eventArchiveQuery.trim().toLocaleLowerCase()
      const rows = eventArchives.filter(({ theme, node }) => {
        if (eventArchiveFilter !== 'all' && archiveNodeType(node) !== eventArchiveFilter) return false
        if (!query) return true
        return [node.title, node.currentText, node.archiveReason, theme.name, node.sourceRef, node.sourceLabel, node.nodeType, node.kind]
          .some((text) => String(text || '').toLocaleLowerCase().includes(query))
      })
      if (!rows.length) {
        archiveList.append(h('p', { class: 'chain-note' }, eventArchives.length
          ? '当前筛选没有匹配的归档。'
          : '没有事件归档。'))
      } else {
        for (const item of rows) archiveList.append(eventArchiveRow(item, refreshView))
      }
    }
    search.addEventListener('input', () => { eventArchiveQuery = search.value; renderEventArchiveRows() })
    renderEventArchiveRows()
    page.append(h('section', { class: 'sect vault-sect' },
      h('div', { class: 'sect-h sect-h-row' }, h('h2', {}, '归档条目'), h('em', {}, String(eventArchives.length))),
      controls, archiveList))
  }
}

function empty(meta) {
  return h('section', { class: 'tomb-empty-state', 'aria-labelledby': 'vault-empty-title' },
    h('h2', { id: 'vault-empty-title' }, `${meta.title}是空的`),
    h('p', {}, meta.note))
}
