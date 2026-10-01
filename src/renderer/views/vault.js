import { h, clear, toast } from '../lib/dom.js'
import { state, selectNode, setView, refresh } from '../app.js'
import { confColor, TYPE_LABEL, nodePath } from './shared.js'
import { SCENARIO_LABELS } from '../../main/llmlog.js'
import { requestChainEventJump } from '../lib/chain-ui-model.js'

export { renderReadings, renderSources } from './readings.js'
import { fmtValue, periodLabel, safeSourceLink, trustMark } from './readings.js'

const m = window.meridian

const META = {
  conflicts: {
    title: '待裁决冲突',
    note: '系统只标出矛盾，不替你裁决。每条冲突都是一次必须由你做出的判断。',
  },
  cold: {
    title: '冷库',
    note: '低质但可能为真的内容。不进主图谱，但仍参与共同前提扫描——弱信号经常来自弱来源。',
  },
  dead: {
    title: '墓碑区',
    note: '置信度跌破 20 或被证伪的命题。不删除——负资产的价值是避免重复犯错。',
  },
  filtered: {
    title: '已筛掉',
    note: '只留裁决记录，不留原文。若同一条 claim 后来从别的源进了图谱，记为一次误杀。',
  },
}

let deadFilter = 'all'
const DEAD_FILTERS = [['all', '全部'], ['falsified', '已证伪'], ['lowconf', '低置信度']]
let eventArchiveFilter = 'all'
let eventArchiveQuery = ''
const EVENT_ARCHIVE_FILTERS = [['all', '全部类型'], ['claim', '主张'], ['inference', '推断'], ['evidence', '证据']]

function passDeadFilter(node) {
  if (deadFilter === 'falsified') return node?.settlement?.correct === false
  if (deadFilter === 'lowconf') return !node?.deletedAt && (node?.confidence ?? 100) < 20
  return true
}

function isRenderableDeadNode(node) {
  return Boolean(node && typeof node === 'object' && node.status === 'dead'
    && typeof node.id === 'string' && node.id.length > 0 && typeof node.title === 'string')
}

function verifiedEventRows(events, integrity) {
  if (!Array.isArray(events) || !integrity || typeof integrity.ok !== 'boolean') return []
  if (integrity.ok) return events.filter((event) => event && typeof event === 'object')
  const lastValidSeq = Number.isSafeInteger(integrity.lastValidSeq) && integrity.lastValidSeq >= 0
    ? integrity.lastValidSeq : 0
  return events.slice(0, lastValidSeq).filter((event) => event && typeof event === 'object')
}

export async function renderVault(mid, kind) {
  clear(mid)
  const meta = META[kind] || META.cold

  if (kind === 'review') return renderReview(mid)
  if (kind === 'conflicts') return renderConflicts(mid, meta)
  if (kind === 'dead') return renderDead(mid, meta)


  const nodes = (await m.allNodes()).filter((n) =>
    kind === 'cold' ? n.status === 'cold' : n.status === 'dead')

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note),
    ),
    nodes.length
      ? h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, state.themes.find((t) => t.id === state.themeId)?.name || ''), h('em', {}, String(nodes.length))),
          h('div', { class: 'sect-b' },
            ...nodes.map((n) => h('div', { class: 'q' },
              h('span', { class: 'dot', style: { background: confColor(n.confidence), marginTop: '6px' } }),
              h('div', { class: 'q-body' },
                h('div', { class: 'q-text' }, n.title),
                h('div', { class: 'q-meta' },
                  h('span', {}, TYPE_LABEL[n.type]),
                  h('span', {}, `· 置信度 ${Math.round(n.confidence)}`),
                  h('span', {}, `· ${nodePath(state.nodes, n.id) || '未归档'}`),
                  h('span', {}, `· ${state.themes.find((t) => t.id === n.themeId)?.name || '已删主题'}`),
                  n.deletedAt ? h('span', { style: { color: 'var(--text-3)' } }, `· 删于 ${n.deletedAt}`) : null,
                ),
              ),
              h('div', { class: 'q-acts' },
                h('button', {
                  class: 'btn',
                  onclick: async () => {
                    if (n.deletedAt) {
                      await m.restoreNode(n.id)
                    } else {
                      // 公理1：复活只改状态，不碰 confidence（kind==='dead' 走 renderDead，不到这里）
                      await m.updateNode(n.id, { status: 'live' })
                    }
                    await renderVault(mid, kind)
                  },
                }, n.deletedAt ? '恢复整条链' : (kind === 'cold' ? '移回主图谱' : '复活')),
                h('button', { class: 'btn', onclick: () => { selectNode(n.id); setView('theme') } }, '查看'),
              ),
            )),
          ),
        )
      : empty(meta),
  ))
}

// ============================================================
// 墓碑区：链化重构
// 第一组：已关闭的认知段（按主题收）——整段复活 / 在链中查看
// 第二组：已证伪的命题——引用它的段就是它在链中的位置
// ============================================================

async function jumpToLedgerEvent(themeId, eventId) {
  state.backTo = { view: 'vault', auditKind: 'dead' }
  state.themeId = themeId
  state.selectedId = null
  requestChainEventJump(themeId, eventId)
  setView('theme')
}

function legacyClosedSegRow(theme, seg) {
  const closedSubs = (seg.subsegments || []).filter((item) => item.status === 'closed')
  const evCount = Array.isArray(seg.evidenceRefs) ? seg.evidenceRefs.length : 0
  const metaBits = [theme.name || '未命名主题', `旧格式证据引用 ${evCount} 条`, seg.updatedAt ? `更新于 ${String(seg.updatedAt).slice(0, 10)}` : null]
    .filter(Boolean)
  if (closedSubs.length) metaBits.push(`含 ${closedSubs.length} 个已关闭分支`)
  return h('div', { class: 'tomb-row legacy-tomb-row' },
    h('div', { class: 'tomb-body' },
      h('div', { class: 'tomb-title' }, h('span', { class: 'tomb-pill tomb-pill-legacy' }, '旧格式 · 待事件化'), h('span', {}, seg.name || '未命名段')),
      seg.coreInfo ? h('div', { class: 'tomb-core' }, seg.coreInfo) : null,
      h('div', { class: 'tomb-meta' }, metaBits.join(' · ')),
      h('p', { class: 'chain-note' }, '兼容只读预览：此记录尚未出现在校验后的事件投影中；原始数据保留，未对它执行复活或改写。')),
    h('div', { class: 'tomb-acts' },
      h('button', { type: 'button', class: 'btn', onclick: () => { state.themeId = theme.id; setView('theme') } }, '打开主题链')))
}

/** Readable summary from verified legacy lemma data; ledger references are supplied separately. */
function deadReason(n) {
  if (n.deletedAt) return { label: '已删除', kind: 'deleted' }
  if (n.settlement?.correct === false) return { label: '已证伪', kind: 'falsified' }
  if ((n.confidence ?? 100) < 20) return { label: '低置信度', kind: 'lowconf' }
  return { label: '已归档', kind: 'archived' }
}

function deadLemmaRow(n, cites) {
  const reason = deadReason(n)
  const themeName = state.themes.find((theme) => theme.id === n.themeId)?.name || '已删主题'
  const updated = n.updatedAt ? String(n.updatedAt).slice(0, 10) : ''
  const metaBits = [themeName, cites.length ? `被 ${cites.length} 条账本事件引用` : '账本中暂无可解析引用', updated ? `更新于 ${updated}` : null, `置信度 ${Math.round(n.confidence ?? 0)}`].filter(Boolean)
  return h('div', { class: 'tomb-row' },
    h('div', { class: 'tomb-body' },
      h('div', { class: 'tomb-title' }, h('span', { class: `tomb-pill tomb-pill-${reason.kind}` }, reason.label), h('span', {}, n.title)),
      h('div', { class: 'tomb-meta' }, metaBits.join(' · ')),
      h('div', { class: 'tomb-cites' },
        h('span', { class: 'tomb-cites-label' }, '账本引用'),
        cites.length
          ? cites.map((cite) => h('button', {
              type: 'button', class: 'tomb-cite', title: `跳到「${cite.themeName}」第 ${cite.seq} 条已校验事件`,
              onclick: () => jumpToLedgerEvent(cite.themeId, cite.eventId),
            }, `${cite.themeName} · v${String(cite.seq).padStart(2, '0')} · ${cite.label || '引用事件'}`))
          : h('span', { class: 'chain-note' }, '没有可解析的已校验事件引用；这不代表旧字段或外部来源不存在。')),
    ),
    h('div', { class: 'tomb-acts' },
      h('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          if (cites.length) return jumpToLedgerEvent(cites[0].themeId, cites[0].eventId)
          state.backTo = { view: 'vault', auditKind: 'dead' }
          state.themeId = n.themeId
          selectNode(n.id)
          setView('theme')
        },
      }, '查看'),
      h('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          if (n.deletedAt) await m.restoreNode(n.id)
          else await m.updateNode(n.id, { status: 'live' })
          await refresh()
        },
      }, n.deletedAt ? '恢复整条链' : '复活')))
}

function eventArchiveRow(item, refreshView) {
  const { theme, node, edges, integrity } = item
  const connectedEvidence = new Set(edges.filter((e) => e.rel === 'supports' && (e.from === node.id || e.to === node.id))
    .map((e) => e.from === node.id ? e.to : e.from)).size
  const date = String(node.archivedAt || '').slice(0, 10) || '未记录'
  const typeLabel = { claim: '主张', inference: '推断', evidence: '证据' }[node.kind] || node.kind
  const sourceRef = String(node.sourceRef || '')
  const lemmaId = sourceRef.match(/^lemma:(.+)$/)?.[1]
  const legacySource = lemmaId ? (state.nodes || []).find((candidate) => candidate.id === lemmaId) : null
  const sourceKindLabel = { segment: '主题观点', branch: '主题分支', mount: '收件箱挂载', lemma: '旧命题', 'legacy-node-source': '旧节点来源' }[node.sourceKind]
  const sourceLabel = legacySource?.title
    ? `对象已解析：${legacySource.title} · 来源真实性未核验`
    : sourceKindLabel ? `引用类别：${sourceKindLabel} · 对象/真实性未核验`
      : sourceRef ? '来源引用未解析' : '未记录来源'
  const row = h('div', { class: 'tomb-row event-archive-row' },
    h('div', { class: 'tomb-body' },
      h('div', { class: 'tomb-title' }, h('span', { class: 'tomb-pill' }, `${typeLabel} · 已归档`), h('span', {}, node.title || '未命名节点')),
      node.archiveReason ? h('div', { class: 'tomb-core' }, `归档原因：${node.archiveReason}`)
        : h('div', { class: 'tomb-core' }, '归档原因：未记录'),
      h('p', { class: 'chain-note' }, '来源引用仅作追溯信息；外部来源的真实性不会由账本自动验证。'),
      integrity?.ok === false ? h('p', { class: 'cog-integrity is-error', role: 'status' }, '仅展示最后校验有效前缀；账本损坏时不可追加恢复。') : null,
      h('div', { class: 'tomb-meta' }, `${theme.name || '未命名主题'} · 来源：${sourceLabel} · 证据 ${node.evidenceCount ?? connectedEvidence} 条 · 归档于 ${date}`),
      h('details', { class: 'event-archive-details' },
        h('summary', {}, '技术详情 · 原始引用与事件 ID'),
        h('p', {}, `来源引用：${node.sourceRef || '未记录'}`),
        h('p', {}, `节点事件：${(node.provenanceEventIds || node.eventIds || []).join(' · ') || '无'}`),
        h('p', {}, `归档事件：${(node.archiveEventIds || []).join(' · ') || '未记录'}`),
        h('p', {}, `关联支持边：${edges.filter((e) => e.rel === 'supports' && (e.from === node.id || e.to === node.id)).map((e) => e.eventId).join(' · ') || '无'}`))),
    h('div', { class: 'tomb-acts' },
      h('button', { type: 'button', class: 'btn', onclick: () => row.querySelector('details')?.toggleAttribute('open') }, '详情'),
      h('button', { type: 'button', class: 'btn btn-primary', disabled: integrity?.ok !== true,
        title: integrity?.ok === true ? '追加恢复事件' : '账本未通过完整性校验，不能追加恢复', onclick: async (ev) => {
        const button = ev.currentTarget
        button.disabled = true
        try {
          const result = await m.chainRestoreNode(theme.id, node.sourceRef, '从墓碑区恢复')
          if (result?.ok === false) throw new Error(result.error || '恢复未完成')
          toast('已追加恢复事件；原归档记录仍保留')
          await refreshView()
        } catch (error) { toast(`恢复失败：${error.message || error}`, 'var(--red)') }
        finally { button.disabled = false }
      } }, '追加恢复')))
  return row
}

async function renderDead(mid, meta) {
  clear(mid)
  const themes = Array.isArray(state.themes) ? state.themes.filter((theme) => theme && typeof theme.id === 'string') : []
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, '事件归档来自只读账本投影；恢复会追加新事件，不删除或改写旧记录。未解析来源会保留为未核实引用。')))
  const loading = h('p', { class: 'chain-note', role: 'status', 'aria-live': 'polite' }, '正在读取墓碑记录…')
  page.append(loading)
  mid.append(page)
  let allNodes
  try {
    allNodes = await m.allNodes()
    if (!Array.isArray(allNodes)) throw new TypeError('node-list-unparsed')
  } catch {
    if (!page.isConnected) return
    loading.className = 'cog-integrity is-error tomb-data-warning'
    loading.setAttribute('role', 'alert')
    loading.textContent = '墓碑记录暂时无法读取；没有改写或迁移任何数据。'
    page.append(h('button', { type: 'button', class: 'btn', onclick: () => renderDead(mid, meta) }, '重试'))
    return
  }
  const malformedNodes = allNodes.filter((node) => !node || typeof node !== 'object'
    || (node.status === 'dead' && !isRenderableDeadNode(node))).length
  const nodes = allNodes.filter(isRenderableDeadNode)
  const shown = nodes.filter(passDeadFilter)
  const [archiveResults, ledgerResults] = await Promise.all([
    Promise.all(themes.map(async (theme) => {
      try { return { theme, result: await m.chainArchives(theme.id) } }
      catch (error) { return { theme, error } }
    })),
    Promise.all(themes.map(async (theme) => {
      try { return { theme, result: await m.chainEvents(theme.id) } }
      catch (error) { return { theme, error } }
    })),
  ])
  if (!page.isConnected) return
  loading.remove()
  const isValidIntegrity = (integrity) => integrity && typeof integrity.ok === 'boolean'
  const unreadableArchiveThemes = archiveResults.filter(({ result, error }) => error || !result
    || !isValidIntegrity(result.integrity) || !Array.isArray(result.nodes) || !Array.isArray(result.edges)
    || result.nodes.some((node) => !node || typeof node !== 'object')
    || result.edges.some((edge) => !edge || typeof edge !== 'object')).length
  const eventArchives = archiveResults.flatMap(({ theme, result }) => !isValidIntegrity(result?.integrity) || !Array.isArray(result?.nodes) ? []
    : result.nodes.filter((node) => node && typeof node === 'object').map((node) => ({
      theme, node, edges: Array.isArray(result.edges) ? result.edges.filter((edge) => edge && typeof edge === 'object') : [], integrity: result.integrity,
    })))
  const eventBackedSourceRefs = new Set()
  for (const { theme, result } of ledgerResults) {
    const integrity = archiveResults.find((entry) => entry.theme.id === theme.id)?.result?.integrity
    if (!Array.isArray(result?.events) || !isValidIntegrity(integrity)) continue
    const verified = verifiedEventRows(result.events, integrity)
    for (const event of verified) if (typeof event?.payload?.sourceRef === 'string') eventBackedSourceRefs.add(event.payload.sourceRef)
  }
  const damagedArchiveThemes = archiveResults.filter(({ result }) => result?.integrity?.ok === false).length
  const failedLedgerThemes = ledgerResults.filter(({ result, error }) => error || !Array.isArray(result?.events)
    || result.events.some((event) => !event || typeof event !== 'object')).length

  // Legacy segments are only an explicit read-only fallback when no event-backed archive exists.
  const legacyClosedSegs = []
  for (const theme of themes) {
    const archive = archiveResults.find((entry) => entry.theme.id === theme.id)?.result
    if (!isValidIntegrity(archive?.integrity)) continue
    const segments = Array.isArray(theme.chain?.segments) ? theme.chain.segments : []
    for (const segment of segments) {
      if (segment.status === 'closed' && !eventBackedSourceRefs.has(`segment:${segment.id}`)) legacyClosedSegs.push({ theme, seg: segment })
    }
  }

  // Index only references in the verified chronological prefix. A display title is never treated as verification.
  const citeIndex = new Map()
  for (const { theme, result } of ledgerResults) {
    if (!Array.isArray(result?.events)) continue
    const archive = archiveResults.find((entry) => entry.theme.id === theme.id)?.result
    if (!isValidIntegrity(archive?.integrity)) continue
    const rows = result.events
    const safeRows = verifiedEventRows(rows, archive.integrity)
    for (const event of safeRows) {
      const payload = event?.payload || {}
      const refs = [...(Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [])]
      if (event.type === 'relation.declared') refs.push(payload.from?.ref, payload.to?.ref)
      const seen = new Set()
      for (const ref of refs) {
        if (ref?.type !== 'lemma' || !ref.id || seen.has(ref.id)) continue
        seen.add(ref.id)
        if (!citeIndex.has(ref.id)) citeIndex.set(ref.id, [])
        citeIndex.get(ref.id).push({
          themeId: theme.id, themeName: theme.name || '未命名主题', eventId: event.id, seq: event.seq,
          label: event.type === 'relation.declared' ? `关系引用${payload.mapping ? ` · ${payload.mapping}` : ''}`
            : event.type === 'correction.appended' ? '更正引用' : event.type === 'evidence.appended' ? '证据引用' : '事件引用',
        })
      }
    }
  }

  const hasRecords = legacyClosedSegs.length > 0 || eventArchives.length > 0 || nodes.length > 0
  const hasWarnings = malformedNodes > 0 || damagedArchiveThemes > 0 || unreadableArchiveThemes > 0 || failedLedgerThemes > 0
  if (malformedNodes) page.append(h('p', { class: 'cog-integrity is-error tomb-data-warning', role: 'alert' }, `${malformedNodes} 条节点数据格式异常，未作为墓碑显示；原始记录未修改。`))
  if (damagedArchiveThemes) page.append(h('p', { class: 'cog-integrity is-error tomb-data-warning', role: 'alert' }, `${damagedArchiveThemes} 个主题的事件链校验失败；归档仅展示校验后的有效前缀，恢复操作已禁用。`))
  if (unreadableArchiveThemes) page.append(h('p', { class: 'cog-integrity is-error tomb-data-warning', role: 'alert' }, `${unreadableArchiveThemes} 个主题的归档返回不完整或无法解析；可安全展示的部分仍保留，其余内容已标记为不可验证。`))
  if (failedLedgerThemes) page.append(h('p', { class: 'cog-integrity is-error tomb-data-warning', role: 'alert' }, `${failedLedgerThemes} 个主题的账本事件引用无法解析；来源链接未被推断或隐藏为已确认引用。`))
  if (!hasRecords && !hasWarnings) {
    page.append(h('section', { class: 'tomb-empty-state', 'aria-labelledby': 'tomb-empty-title' },
      h('h2', { id: 'tomb-empty-title' }, '墓碑区是空的'),
      h('p', {}, '还没有需要归档的命题或事件。旧记录会保留在账本中；恢复也只会追加新事件。')))
    return
  }

  if (legacyClosedSegs.length) {
    const sect = h('section', { class: 'sect legacy-tomb-section' },
      h('div', { class: 'sect-h' }, h('h2', {}, '旧格式 · 待事件化的关闭段'), h('em', {}, String(legacyClosedSegs.length))),
      h('p', { class: 'chain-note' }, '以下仅为旧字段的兼容只读预览，不作为当前认知状态；不会在这里直接复活或修改。'))
    for (const { theme, seg } of legacyClosedSegs) sect.append(legacyClosedSegRow(theme, seg))
    page.append(sect)
  }

  if (eventArchives.length || unreadableArchiveThemes || failedLedgerThemes || damagedArchiveThemes) {
    const archiveList = h('div', { class: 'event-archive-list' })
    const search = h('input', {
      class: 'txt event-archive-search', type: 'search', value: eventArchiveQuery,
      placeholder: '搜索名称、原因、主题或来源', 'aria-label': '搜索事件归档',
    })
    const controls = h('div', { class: 'event-archive-controls' },
      search,
      h('div', { class: 'tomb-filters', role: 'group', 'aria-label': '按归档节点类型筛选' },
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
        }, label))),
    )
    const refreshView = () => renderDead(mid, meta)
    const renderEventArchiveRows = () => {
      clear(archiveList)
      const query = eventArchiveQuery.trim().toLocaleLowerCase()
      const rows = eventArchives.filter(({ theme, node }) => {
        if (eventArchiveFilter !== 'all' && node.kind !== eventArchiveFilter) return false
        if (!query) return true
        return [node.title, node.archiveReason, theme.name, node.sourceRef].some((text) => String(text || '').toLocaleLowerCase().includes(query))
      })
      if (!rows.length) archiveList.append(h('p', { class: 'chain-note' }, eventArchives.length
        ? '当前筛选没有匹配的归档。'
        : unreadableArchiveThemes || failedLedgerThemes
          ? '没有可解析的事件归档；相关内容可能未能解析，请先查看上方提示。'
          : '没有事件归档；只读查看不会触发旧数据迁移。'))
      else for (const item of rows) archiveList.append(eventArchiveRow(item, refreshView))
    }
    search.addEventListener('input', () => { eventArchiveQuery = search.value; renderEventArchiveRows() })
    renderEventArchiveRows()
    page.append(h('section', { class: 'sect event-archive-section' },
      h('div', { class: 'sect-h sect-h-row' }, h('h2', {}, '事件归档'), h('em', {}, String(eventArchives.length))),
      controls, archiveList))
  }

  if (nodes.length) {
    const sect = h('section', { class: 'sect' },
    h('div', { class: 'sect-h sect-h-row' },
      h('h2', {}, '归档的命题'), h('em', {}, String(shown.length)),
      h('div', { class: 'tomb-filters' },
        ...DEAD_FILTERS.map(([key, label]) => h('button', {
          type: 'button', class: `tomb-filter${deadFilter === key ? ' is-on' : ''}`,
          'aria-pressed': String(deadFilter === key),
          onclick: () => { deadFilter = key; renderDead(mid, meta) },
        }, label)))),
    ...shown.map((node) => deadLemmaRow(node, citeIndex.get(node.id) || [])),
    )
    if (!shown.length) sect.append(h('p', { class: 'chain-note' }, '这个筛选下没有命题。'))
    page.append(sect)
  }
}

async function renderConflicts(mid, meta) {
  const page = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, meta.title), h('p', {}, meta.note)))
  const list = h('div', {}, h('p', { role: 'status' }, '正在读取冲突…'))
  page.append(list)
  mid.append(page)
  try {
    const [conflicts, all] = await Promise.all([m.conflicts(), m.allNodes()])
    if (!page.isConnected) return
    const byId = new Map(all.map(n => [n.id, n]))
    clear(list)
    if (!conflicts.length) { list.append(empty(meta)); return }
    for (const c of conflicts) {
      const card = h('div', { class: 'conflict', dataset: { id: c.id, type: c.type || 'node' } })
      list.append(card)
      const loadPair = async () => {
        clear(card).append(h('p', { role: 'status' }, '正在读取双方记录…'))
        try {
          const reading = c.type === 'reading'
          const [a, b] = reading
            ? await Promise.all([m.getReading(c.readingA || c.a), m.getReading(c.readingB || c.b)])
            : [byId.get(c.a), byId.get(c.b)]
          if (!a || !b) throw new Error('missing-record')
          const readingSide = (r, label) => h('div', { class: 'side' }, h('b', {}, label),
            h('strong', { class: 'reading-number' }, `${fmtValue(r.value)} ${r.unit || ''}`),
            h('span', {}, periodLabel(r)), h('span', {}, r.source?.label || '未命名来源'), trustMark(r), safeSourceLink(r.source?.url))
          const actions = h('div', { class: 'acts' })
          // 决策动作要有决策的分量：A / B 是主要判断，用实心主按钮；
          // 「两者都对」是低频的自我纠正，降为次要样式，不跟主判断抢。
          for (const [choice, label, primary] of [['a', 'A 成立', true], ['b', 'B 成立', true], ['both', '两者都对（我搞错了）', false]]) {
            actions.append(h('button', { class: primary ? 'btn btn-primary' : 'btn', onclick: async () => {
              actions.querySelectorAll('button').forEach(button => { button.disabled = true })
              try {
                const result = await m.resolveConflict(c.id, choice)
                if (result?.ok === false) throw new Error('resolve-failed')
                if (page.isConnected) await renderVault(mid, 'conflicts')
              } catch { toast('裁决未保存，请重试', 'var(--red)') }
              finally { actions.querySelectorAll('button').forEach(button => { button.disabled = false }) }
            } }, label))
          }
          const sumSide = c.comparison ? h('div', { class: 'side' }, h('b', {}, 'B · 分部之和'),
            h('strong', { class: 'reading-number' }, `${fmtValue(c.comparison.sum)} ${c.comparison.unit || ''}`),
            h('span', {}, periodLabel(b)), h('span', {}, `${c.componentIds?.length || 0} 条分部作证；选择 A 将驳回这些分部作证，选择 B 将驳回总计作证。`)) : null
          clear(card).append(h('div', { class: 'note' }, `${c.note || (reading ? '同一期间出现不同数值，等待你裁决' : '判断不一致')} · 发现于 ${c.at || '未记录'}`),
            h('div', { class: 'pair' }, reading ? readingSide(a, c.comparison ? 'A · 总计' : 'A') : side(a, 'A'), h('span', { class: 'vs' }, 'vs'), sumSide || (reading ? readingSide(b, 'B') : side(b, 'B'))), actions)
        } catch {
          clear(card).append(h('p', { role: 'status' }, '双方记录暂时无法读取。'), h('button', { class: 'btn', onclick: loadPair }, '重试'))
        }
      }
      await loadPair()
      if (!page.isConnected) return
    }
  } catch {
    clear(list).append(h('p', { role: 'status' }, '冲突读取失败。'), h('button', { class: 'btn', onclick: () => renderVault(mid, 'conflicts') }, '重试'))
  }
}

function side(n, label) {
  return h('div', { class: 'side' },
    h('b', {}, `${label} · ${Math.round(n.confidence)}`),
    h('span', {}, n.title),
  )
}


// ============================================================
// 复盘：采集漏斗 + 误杀校准曲线
// ============================================================

async function renderReview(mid) {
  clear(mid)

  const [series, filterCalib, verdicts, byChannel, vsData, llm] = await Promise.all([
    m.intakeSeries(30),
    m.filterCalibration(),
    m.verdicts(),
    m.falseKillByChannel(30),
    m.vsInstitution(90),
    m.llmUsage(),
  ])
  // 通道已移除：只显示来源 id
  const chName = (id) => id

  // LLM 账本：按天聚合，今天与近 30 天两个口径
  const llmDays = llm?.daily || []
  const todayKey = new Date().toISOString().slice(0, 10)
  const llmToday = llmDays.find((d) => d.date === todayKey) || { calls: 0, failed: 0, degraded: 0, tokens: 0, byScenario: {} }
  const llmTotals = llmDays.reduce((a, d) => ({
    calls: a.calls + d.calls, failed: a.failed + d.failed, degraded: a.degraded + d.degraded, tokens: a.tokens + d.tokens,
  }), { calls: 0, failed: 0, degraded: 0, tokens: 0 })
  const llmScenarios = Object.entries(llmToday.byScenario || {}).sort((a, b) => b[1] - a[1])
  const llmRecent = llm?.recent || []

  // 聚合最近 30 天
  const agg = series.reduce((a, b) => ({
    captured: a.captured + b.captured,
    gatedIn: a.gatedIn + b.gatedIn,
    autoImported: a.autoImported + b.autoImported,
    toInbox: a.toInbox + b.toInbox,
    confirmed: a.confirmed + b.confirmed,
    rejected: a.rejected + b.rejected,
    undone: a.undone + b.undone,
    overridden: a.overridden + b.overridden,
    degraded: a.degraded + b.degraded,
  }), { captured: 0, gatedIn: 0, autoImported: 0, toInbox: 0, confirmed: 0, rejected: 0, undone: 0, overridden: 0, degraded: 0 })

  const pct = (n, d) => d > 0 ? Math.round((n / d) * 100) : 0
  const friction = pct(agg.toInbox, agg.captured)
  const undoRate = pct(agg.undone, agg.autoImported)
  const overrideRate = pct(agg.overridden, agg.autoImported + agg.confirmed)
  const falseKillCount = verdicts.filter(v => v.promotedTo != null).length
  const falseKillRate = pct(falseKillCount, verdicts.length)
  const degradeRate = pct(agg.degraded, agg.captured)

  const metrics = [
    { label: '摩擦率', value: friction, target: '< 20%', raw: `${agg.toInbox} / ${agg.captured}`, denom: agg.captured, color: friction > 20 ? 'var(--orange)' : 'var(--accent)' },
    { label: '撤销率', value: undoRate, target: '< 5%', raw: `${agg.undone} / ${agg.autoImported}`, denom: agg.autoImported, color: undoRate > 5 ? 'var(--orange)' : 'var(--accent)' },
    { label: '归位修改率', value: overrideRate, target: '< 15%', raw: `${agg.overridden} / ${agg.autoImported + agg.confirmed}`, denom: agg.autoImported + agg.confirmed, color: overrideRate > 15 ? 'var(--orange)' : 'var(--accent)' },
    { label: '误杀率', value: falseKillRate, target: '< 10%', raw: `${falseKillCount} / ${verdicts.length}`, denom: verdicts.length, color: falseKillRate > 10 ? 'var(--orange)' : 'var(--accent)' },
    { label: '降级率', value: degradeRate, target: '—', raw: `${agg.degraded} / ${agg.captured}`, denom: agg.captured, color: 'var(--text-3)' },
  ]

  // 校准曲线永远返回 4 个桶，"有没有数据"要看桶里有没有样本。
  const calibTotal = filterCalib.reduce((s, b) => s + b.total, 0)

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '复盘'),
      h('p', {}, '入库链路的健康度——不是你拥有什么，是搬得准不准。'),
    ),

    // 漏斗五项
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '采集漏斗'), h('em', {}, `近 30 天 · ${agg.captured} 次捕获`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          ...metrics.map((mt) => {
            // 0/0 不是 0%：分母为 0 说明没有数据，给灰色破折号，别装作"完美"。
            const noData = !mt.denom
            return h('div', { class: 'review-metric' },
              h('div', { class: 'review-metric-num', style: { color: noData ? 'var(--text-3)' : mt.color } }, noData ? '—' : `${mt.value}%`),
              h('div', { class: 'review-metric-label' }, mt.label),
              h('div', { class: 'review-metric-target' }, `目标 ${mt.target}`),
              h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, mt.raw),
            )
          }),
        ),
      ),
    ),

    // LLM 成本账本
    llmDays.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'LLM 调用'), h('em', {}, `近 ${llmDays.length} 天 · ${llmTotals.calls} 次`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num' }, String(llmToday.calls)),
            h('div', { class: 'review-metric-label' }, '今日调用'),
            h('div', { class: 'review-metric-raw', style: { color: llmToday.failed ? 'var(--orange)' : 'var(--text-3)' } },
              `${llmToday.failed} 失败 · ${llmToday.degraded} 降级`),
          ),
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num' }, llmToday.tokens.toLocaleString('en-US')),
            h('div', { class: 'review-metric-label' }, '今日 token'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `近 30 天 ${llmTotals.tokens.toLocaleString('en-US')}`),
          ),
        ),
        llmScenarios.length
          ? h('div', { class: 'llm-scenarios' },
              ...llmScenarios.map(([scene, n]) => h('span', { class: 'badge' }, `${SCENARIO_LABELS[scene] || scene} ${n}`)),
            )
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '今天还没有调用模型。'),
            )),
        h('p', { class: 'llm-note' }, 'token 数取自响应的 usage；模型不返回时按 0 计。'),
        llmRecent.length ? h('details', { class: 'llm-failures' },
          h('summary', {}, `最近失败 · ${llmRecent.length} 条（上限 50）`),
          ...llmRecent.slice(0, 8).map((f) => h('div', { class: 'q' },
            h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { fontSize: 'var(--t-body)' } },
                `${SCENARIO_LABELS[f.scenario] || f.scenario} · ${f.error || '失败'}`),
              h('div', { class: 'q-meta' },
                h('span', {}, String(f.at || '').replace('T', ' ').slice(0, 16)),
                h('span', {}, `· ${f.latency} ms`),
                f.channelId ? h('span', {}, `· 通道 ${chName(f.channelId)}`) : null,
              ),
            ),
          )),
          llmRecent.length > 8 ? h('div', { class: 'q-meta', style: { padding: '6px 0' } }, `还有 ${llmRecent.length - 8} 条未展开`) : null,
        ) : null,
      ),
    ) : null,

    // 每日趋势
    series.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '每日趋势'), h('em', {}, `${series.length} 天`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-daily' },
          ...series.slice(-14).map((b) => h('div', { class: 'review-day' },
            h('span', { class: 'review-day-date', style: { color: 'var(--text-3)' } }, b.date.slice(5)),
            h('span', { class: 'review-day-bar' },
              h('i', { style: { width: `${pct(b.autoImported, b.captured)}%`, background: 'var(--accent)' } }),
              h('i', { style: { width: `${pct(b.toInbox, b.captured)}%`, background: 'var(--orange)' } }),
            ),
            h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' } }, String(b.captured)),
          )),
        ),
      ),
    ) : null,

    // 误杀校准曲线
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '过滤器校准曲线'),
        h('em', {}, calibTotal ? `${calibTotal} 条被筛` : '尚无数据')),
      h('div', { class: 'sect-b' },
        calibTotal
          ? h('div', { class: 'calib' }, ...filterCalib.map((b) => {
              // 空桶不画"0%"：没有样本的柱子不该用颜色讲故事。
              const empty = !b.total
              return h('div', {},
                h('em', { style: { color: empty ? 'var(--text-3)' : '' } }, empty ? '—' : `${Math.round(b.accuracy * 100)}%`),
                h('i', { style: { height: `${b.accuracy * 100}%`, background: empty ? 'var(--line)' : b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } }),
                h('span', {}, `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`),
              )
            }))
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '尚无被筛掉的记录。有了数据之后，这里会显示各质量段的误杀率。'),
            )),
      ),
    ),

    // 误杀率按 gate 拆分
    filterCalib.byGate ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '误杀率按 gate 拆分')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          ...['source', 'dedup', 'user', 'other'].map((g) => {
            const s = filterCalib.byGate[g]
            // 0/0 不是 0%：没有数据就不该给一个"完美"的数字，看着像健康。
            const noData = !s.total
            return h('div', { class: 'review-metric' },
              h('div', { class: 'review-metric-num', style: { color: noData ? 'var(--text-3)' : s.missed > 0 ? 'var(--orange)' : 'var(--accent)' } }, noData ? '—' : `${Math.round(s.accuracy * 100)}%`),
              h('div', { class: 'review-metric-label' }, s.label),
              h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${s.missed} / ${s.total}`),
            )
          }),
        ),
      ),
    ) : null,

    // 误杀归因到通道
    byChannel.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '误杀归因到通道'), h('em', {}, `近 30 天 · ${byChannel.length} 通道`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          ...byChannel.map((c) => {
            // 0/0 不是 0%：没有数据就不该给一个"完美"的数字。
            const noData = !c.total
            return h('div', { class: 'review-metric' },
              h('div', { class: 'review-metric-num', style: { color: noData ? 'var(--text-3)' : c.missed > 0 ? 'var(--orange)' : 'var(--accent)' } }, noData ? '—' : `${Math.round(c.rate * 100)}%`),
              h('div', { class: 'review-metric-label' }, chName(c.channelId)),
              h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${c.missed} / ${c.total}`),
            )
          }),
        ),
      ),
    ) : null,

    // 最近采集条目（下钻）
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '最近采集'), h('em', {}, `近 ${series.length} 天`)),
      h('div', { class: 'sect-b' },
        agg.captured > 0
          ? h('div', {}, ...series.slice(-3).reverse().flatMap((b) =>
              h('div', { class: 'review-day-group' },
                h('div', { class: 'review-day-header' }, `${b.date} · 捕获 ${b.captured} · 自动 ${b.autoImported} · 收件箱 ${b.toInbox} · 撤销 ${b.undone}`),
              )
            ))
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '还没有采集记录。'),
            )),
      ),
    ),
  ))

  if (vsData.settledCount > 0) {
    mid.append(h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '你 vs 机构'), h('em', {}, `近 90 天 · ${vsData.settledCount} 条已结算命题`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num', style: { color: vsData.userTotal >= 5 && vsData.userRate != null ? '' : 'var(--text-3)' } },
              vsData.userTotal >= 5 && vsData.userRate != null ? `${Math.round(vsData.userRate * 100)}%` : '—'),
            h('div', { class: 'review-metric-label' }, '你的命中率'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${vsData.userHits} / ${vsData.userTotal}${vsData.userTotal < 5 ? ' · 样本不足' : ''}`),
          ),
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num', style: { color: vsData.orgTotal >= 5 && vsData.orgRate != null ? '' : 'var(--text-3)' } },
              vsData.orgTotal >= 5 && vsData.orgRate != null ? `${Math.round(vsData.orgRate * 100)}%` : '—'),
            h('div', { class: 'review-metric-label' }, '机构观点命中率'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${vsData.orgHits} / ${vsData.orgTotal}${vsData.orgTotal < 5 ? ' · 样本不足' : ''}`),
          ),
        ),
      ),
    ))
  }
}

function empty(meta) {
  return h('section', { class: 'sect' },
    h('div', { class: 'sect-h' }, h('h2', {}, meta.title)),
    h('div', { class: 'sect-b' },
      h('div', { class: 'q' }, h('div', { class: 'q-body' },
        h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '现在是空的。'),
        h('div', { class: 'q-meta' }, meta.note),
      )),
    ),
  )
}
