import { h, clear, toast } from '../lib/dom.js'
import { state, refresh, selectTheme, selectNode } from '../app.js'

const m = window.meridian
export const fmtValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—'
export const periodLabel = (r) => {
  const end = r.period?.end || r.asOf
  const start = r.period?.start
  return end ? (start && start !== end ? `${start} → ${end}` : end) : '期间未记录'
}
const basisLabel = (r) => r.basis === 'estimated' ? '估算' : '已披露'
const flagsLabel = (flags = []) => [...new Set(flags.map((flag) => ({
  jump: '变化较大', 'sum-violation': '分项与总数不一致', 'once-contradicted': '曾被反驳',
  contradicted: '曾被反驳', conflict: '数值不一致', 'unit-mismatch': '单位不一致',
  'legacy-invalid-value': '旧记录缺少有效数值', 'review-required': '来源有待复核',
}[flag] || '需复核')))].join(' · ')
export const isConflicted = (r) => r?.status === 'conflicted' || (r?.trust?.flags || []).some(f => ['sum-violation', 'conflict', 'unit-mismatch'].includes(f))
export function trustMark(r) {
  const count = r.trust?.crossCount || 1
  const warning = isConflicted(r) || (r.trust?.flags || []).length > 0
  const label = isConflicted(r) ? '有冲突' : warning ? '需复核' : count >= 2 ? `${count} 源一致` : '单一来源'
  return h('span', { class: 'trust-mark', dataset: { state: warning ? 'warning' : count >= 2 ? 'verified' : 'single' }, 'aria-label': label },
    h('i', { 'aria-hidden': 'true' }), h('span', {}, label))
}
export function safeSourceLink(url) {
  if (!url) return null
  let safe
  try {
    safe = new URL(url)
    if (!['http:', 'https:'].includes(safe.protocol) || safe.username || safe.password) return h('span', { class: 'reading-note' }, '来源链接不可打开')
  } catch { return h('span', { class: 'reading-note' }, '来源链接不可打开') }
  return h('button', { class: 'btn source-link', title: safe.href, onclick: async () => {
    try { await m.openExternal(safe.href) } catch { toast('无法打开来源链接，请稍后重试', 'var(--red)') }
  } }, '打开来源')
}
const note = (text) => h('p', { class: 'reading-note', role: 'status' }, text)
function failure(box, retry, text = '暂时无法读取，请重试。') {
  clear(box).append(note(text), h('button', { class: 'btn', onclick: retry }, '重试'))
}

/** 游标只记位置，不积累已浏览过的读数；上一页也重新查询。 */
function pager(fetchPage, renderItems, limit = 50) {
  let cursor, nextCursor, busy = false
  const previous = []
  const content = h('div')
  const status = note('加载中…')
  const prev = h('button', { class: 'btn', onclick: () => load('prev') }, '上一页')
  const next = h('button', { class: 'btn', onclick: () => load('next') }, '下一页')
  const root = h('div', { class: 'reading-pager' }, content, h('div', { class: 'reading-pagination' }, prev, status, next))
  async function load(direction) {
    if (busy) return
    busy = true
    prev.disabled = next.disabled = true
    status.textContent = '加载中…'
    root.setAttribute('aria-busy', 'true')
    const target = direction === 'next' ? nextCursor : direction === 'prev' ? previous.at(-1) : cursor
    try {
      const result = await fetchPage({ limit, cursor: target })
      if (!result || !Array.isArray(result.items)) throw new Error('invalid-page')
      if (direction === 'next') previous.push(cursor)
      if (direction === 'prev') previous.pop()
      cursor = target
      nextCursor = result.nextCursor
      clear(content)
      renderItems(content, result.items)
      status.textContent = `第 ${previous.length + 1} 页${result.total != null ? ` · 共 ${result.total} 条` : ''}`
    } catch {
      status.textContent = '读取失败，可重试'
      if (!content.childNodes.length) failure(content, () => load())
      else status.append(h('button', { class: 'btn', onclick: () => load(direction) }, '重试'))
    } finally {
      busy = false
      root.setAttribute('aria-busy', 'false')
      prev.disabled = !previous.length
      next.disabled = !nextCursor
    }
  }
  root.reload = () => load()
  // 等宿主挂载后再填充，避免异步回包抢占新页面。
  queueMicrotask(() => load())
  return root
}

function readingProof(r) {
  const raw = h('div', { class: 'reading-original' })
  let rawLoaded = false
  const rawButton = h('button', { class: 'btn reading-raw', 'aria-expanded': 'false', onclick: async () => {
    if (rawLoaded) {
      raw.hidden = !raw.hidden
      rawButton.setAttribute('aria-expanded', String(!raw.hidden))
      return
    }
    rawButton.disabled = true
    rawButton.setAttribute('aria-expanded', 'true')
    clear(raw).append(note('正在读取原文…'))
    try {
      const entry = await m.rawGet(r.rawId)
      clear(raw).append(entry ? h('pre', { class: 'raw-text' }, entry.text || '原文内容为空') : note('原文未保留，读数记录仍在。'))
      rawLoaded = true
    } catch { failure(raw, () => rawButton.click(), '原文读取失败，请重试。') }
    finally { rawButton.disabled = false }
  } }, '查看原文')
  const score = typeof r.trust?.score === 'number' ? `${Math.round(r.trust.score * 100)}%` : '尚未评定'
  const card = h('article', { class: 'reading-proof', dataset: { readingId: r.id, status: r.status || '' } },
    h('div', { class: 'reading-proof-head' }, h('b', { class: 'reading-number' }, `${fmtValue(r.value)} ${r.unit || ''}`), trustMark(r)),
    note(`${periodLabel(r)} · ${basisLabel(r)} · ${r.status === 'superseded' ? '已被修正' : r.status === 'conflicted' ? '有冲突，待裁决' : '作证记录'}`),
    note(`${r.source?.label || '未命名来源'} · ${r.source?.platform || r.source?.kind || '来源未记录'}`),
    note(`${({ structured: '结构化', 'local-llm': '模型解读', agent: '外部提供' })[r.tier] || '获取方式未记录'} · 可信度 ${score} · 记录于 ${String(r.at || '').replace('T', ' ')}`),
    r.trust?.flags?.length ? note(flagsLabel(r.trust.flags)) : null,
    h('div', { class: 'reading-actions' }, r.rawId ? rawButton : note('未附原文'), safeSourceLink(r.source?.url)), raw)
  return card
}

function verification(key) {
  const result = note('')
  const button = h('button', { class: 'btn reading-verify', disabled: !key, onclick: async () => {
    button.disabled = true
    result.textContent = '正在验证…'
    try {
      const checked = await m.verifyReadingChain(key)
      result.textContent = checked.ok
        ? `序列完整，${checked.count} 条记录，与本地存证一致`
        : checked.firstInvalid != null ? `第 ${typeof checked.firstInvalid === 'object' ? checked.firstInvalid.index ?? checked.firstInvalid.lineNo ?? '未知' : checked.firstInvalid} 条记录对不上，可能被改过`
          : '暂时无法验证，请重试'
    } catch { result.textContent = '验证失败，请重试' }
    finally { button.disabled = false }
  } }, '验证此序列')
  return h('div', { class: 'reading-actions' }, button, result)
}

function judgments(items) {
  const box = h('section', { class: 'reading-judgments' }, h('h3', {}, '关联判断'), note('读数可能帮助你裁定这些判断；不会自动结算。'))
  const list = h('div')
  let offset = 0
  const paint = () => {
    clear(list)
    for (const n of items.slice(offset, offset + 10)) {
      list.append(h('div', { class: 'reading-judgment' },
        h('span', {}, n.title || n.claim || '未命名判断'),
        note(`${n.confidence != null ? `${Math.round(n.confidence)}% 把握 · ` : ''}${n.settlement?.resolved != null || n.resolved != null ? '已结算' : '等你裁定'}${n.settlesOn || n.settlement?.date ? ` · ${n.settlesOn || n.settlement.date}` : ''}`),
        h('button', { class: 'btn', onclick: async (event) => {
          const button = event.currentTarget
          button.disabled = true
          try {
            const node = n.themeId ? n : await m.getNode(n.id)
            if (!node) throw new Error('missing-judgment')
            document.querySelector('.reading-dialog')?.close()
            selectTheme(node.themeId)
            await refresh()
            selectNode(node.id)
          } catch { toast('判断暂时无法打开，请重试', 'var(--red)') }
          finally { button.disabled = false }
        } }, '查看判断')))
    }
    back.disabled = offset === 0
    more.disabled = offset + 10 >= items.length
  }
  const back = h('button', { class: 'btn', onclick: () => { offset -= 10; paint() } }, '前十条判断')
  const more = h('button', { class: 'btn', onclick: () => { offset += 10; paint() } }, '后十条判断')
  box.append(list)
  if (items.length > 10) box.append(h('div', { class: 'reading-actions' }, back, more))
  if (!items.length) list.append(note('暂无关联判断。'))
  else paint()
  return box
}

function assignment(r, done, proof = false) {
  const box = h('div', { class: 'reading-assignment' })
  const button = h('button', { class: 'btn reading-assign', onclick: async () => {
    button.disabled = true
    const content = h('div', {}, note('正在读取可归位的指标…'))
    clear(box).append(content)
    try {
      const nodes = (await m.allNodes()).filter(n => n.type === 'observation' && n.status !== 'dead' && !n.deletedAt)
      clear(content)
      if (!nodes.length) { content.append(note('还没有可归位的指标。先到脉络里添加一条观测。')); return }
      const select = h('select', { class: 'sel', 'aria-label': '归位到哪个指标' }, h('option', { value: '' }, '选择指标…'),
        ...nodes.map(n => h('option', { value: n.id }, `${state.themes.find(t => t.id === n.themeId)?.name || '主题'} · ${n.title}`)))
      const save = h('button', { class: 'btn btn-primary', onclick: async () => {
        if (!select.value) return
        save.disabled = true
        try {
          // 观测 key 不等于作证 id；待归位且冲突时可能没有 currentReadingId。
          const id = proof ? r.id : r.currentReadingId || (await m.readingEvidence({ observationId: r.id, limit: 1 })).items[0]?.id
          if (!id) throw new Error('missing-reading')
          const result = await m.assignReading(id, select.value)
          if (!result.ok) throw new Error('assign-failed')
          toast('已归位')
          done()
          await refresh()
        } catch { toast('归位失败，请重试', 'var(--red)') }
        finally { save.disabled = false }
      } }, '确认归位')
      content.append(select, save)
    } catch { failure(content, () => { clear(box).append(button); button.disabled = false; button.click() }) }
  } }, '归位到…')
  box.append(button)
  return box
}

/** 详情不常驻虚拟行：关闭即释放，分页作证和历史都不会无限追加 DOM。 */
export function openObservation(r, { proof = false } = {}) {
  document.querySelector('.reading-dialog')?.close()
  const opener = document.activeElement
  const body = h('div', { class: 'reading-dialog-body' })
  const dialog = h('dialog', { class: 'reading-dialog', 'aria-labelledby': 'reading-detail-title', onclose: () => { dialog.remove(); if (opener?.isConnected) opener.focus() } },
    h('header', { class: 'reading-dialog-head' }, h('h2', { id: 'reading-detail-title' }, r.title || '读数详情'), h('button', { class: 'btn', onclick: () => dialog.close(), 'aria-label': '关闭读数详情' }, '关闭')), body)
  body.append(note(periodLabel(r)))
  if (isConflicted(r)) body.append(note('有不同数值，尚无唯一当前值。请到「待裁决冲突」比较后裁决。'))
  if (r.pending || !r.indicatorId) body.append(assignment(r, () => dialog.close(), proof))
  if (proof) body.append(h('h3', {}, '本条作证'), readingProof(r))
  const related = h('div')
  const evidence = proof && !r.indicatorId ? note('这条作证待归位，归位后可查看关联判断。') : pager(
    async (page) => {
      const result = await m.readingEvidence({ ...(proof ? { indicatorId: r.indicatorId } : { observationId: r.id }), ...page })
      clear(related).append(judgments(result.judgments || []))
      return result
    },
    (box, items) => items.length ? box.append(...items.map(readingProof)) : box.append(note('尚无作证记录。')), 10)
  body.append(h('h3', {}, proof ? '该指标的作证台账' : '作证记录'), evidence, verification(r.chainKey || r.indicatorId), related)
  if (r.indicatorId) {
    const history = h('details', { class: 'reading-history', ontoggle: () => {
      if (!history.open || history.childElementCount > 1) return
      history.append(pager(p => m.readingsPage({ indicatorId: r.indicatorId, ...p }), (box, items) => {
        if (!items.length) box.append(note('暂无历史读数。'))
        else box.append(...items.map(item => observationRow(item)))
      }, 10))
    } }, h('summary', {}, '查看历史期间'))
    body.append(history)
  }
  document.body.append(dialog)
  dialog.showModal()
}

function observationRow(r) {
  return h('button', { class: 'feed-row', dataset: { id: r.id, status: r.status || '', pending: String(!!r.pending || !r.indicatorId) },
    'aria-haspopup': 'dialog', onclick: () => openObservation(r) },
    h('span', { class: 'feed-name' }, r.title || '未归位读数'),
    h('span', { class: 'feed-value' }, isConflicted(r) ? '待裁决' : `${fmtValue(r.value)} ${r.unit || ''}`),
    h('span', { class: 'feed-period' }, `${periodLabel(r)} · ${basisLabel(r)}${r.pending || !r.indicatorId ? ' · 待归位' : ''}${r.status === 'superseded' ? ' · 已被修正' : r.status === 'rejected' ? ' · 无有效当前值' : ''}`),
    trustMark(r), r.chainKey ? h('span', { class: 'reading-seal', title: '已存证', 'aria-label': '已存证' }, '▪') : null)
}

/** 固定组高度让窗口定位无需测量全量行；展开的大组再用独立行窗口。 */
function dayFeed(items) {
  const byDay = new Map()
  for (const r of items) {
    const day = String(r.at || '').slice(0, 10) || '日期未记录'
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(r)
  }
  const groups = [...byDay].sort(([a], [b]) => b.localeCompare(a))
  const root = h('div', { class: 'feed-viewport', tabindex: '0', 'aria-label': '按天浏览读数' })
  const canvas = h('div', { class: 'feed-canvas' })
  root.append(canvas)
  const mounted = new Map()
  const heights = groups.map(([, rows]) => 36 + Math.min(rows.length, 10) * 64 + (rows.length > 10 ? 36 : 0))
  const tops = [0]
  heights.forEach(height => tops.push(tops.at(-1) + height))
  canvas.style.height = `${tops.at(-1)}px`
  function groupElement(index) {
    const [day, rows] = groups[index]
    const list = h('div')
    const group = h('section', { class: 'feed-day', dataset: { day }, style: { top: `${tops[index]}px`, height: `${heights[index]}px` } },
      h('div', { class: 'feed-day-h' }, h('b', {}, day), h('span', {}, `本页 ${rows.length} 条`)), list)
    list.append(...rows.slice(0, 10).map(observationRow))
    if (rows.length > 10) {
      let expanded = false
      const toggle = h('button', { class: 'btn feed-day-more', 'aria-expanded': 'false', onclick: () => {
        expanded = !expanded
        toggle.setAttribute('aria-expanded', String(expanded))
        toggle.textContent = expanded ? '收起当天读数' : `+${rows.length - 10} 条`
        clear(list)
        if (!expanded) { list.append(...rows.slice(0, 10).map(observationRow)); return }
        const scroll = h('div', { class: 'feed-group-scroll', tabindex: '0', 'aria-label': `${day} 全部读数` })
        const inner = h('div', { style: { height: `${rows.length * 64}px`, position: 'relative' } })
        let start = -1
        const rowElements = new Map()
        const paint = () => {
          const from = Math.max(0, Math.floor(scroll.scrollTop / 64) - 3)
          if (from === start) return
          start = from
          const to = Math.min(rows.length, from + 17)
          for (const [i, row] of rowElements) if (i < from || i >= to) {
            if (row === document.activeElement) scroll.focus({ preventScroll: true })
            row.remove()
            rowElements.delete(i)
          }
          for (let i = from; i < to; i++) if (!rowElements.has(i)) {
            const row = observationRow(rows[i])
            Object.assign(row.style, { position: 'absolute', top: `${i * 64}px` })
            rowElements.set(i, row)
            inner.insertBefore(row, [...inner.children].find(el => Number.parseInt(el.style.top) > i * 64) || null)
          }
        }
        scroll.append(inner)
        scroll.addEventListener('scroll', paint, { passive: true })
        list.append(scroll)
        paint()
      } }, `+${rows.length - 10} 条`)
      group.append(toggle)
    }
    return group
  }
  function paint() {
    const top = root.scrollTop
    const bottom = top + (root.clientHeight || 600)
    let first = 0
    while (first < groups.length && tops[first + 1] <= top) first++
    let last = first
    while (last < groups.length && tops[last] < bottom) last++
    const from = Math.max(0, first - 3)
    const to = Math.min(groups.length, last + 3)
    for (const [i, element] of mounted) if (i < from || i >= to) {
      if (element.contains(document.activeElement)) root.focus({ preventScroll: true })
      element.remove()
      mounted.delete(i)
    }
    for (let i = from; i < to; i++) if (!mounted.has(i)) {
      const element = groupElement(i)
      mounted.set(i, element)
      canvas.insertBefore(element, [...canvas.children].find(el => Number(el.style.top.slice(0, -2)) > tops[i]) || null)
    }
  }
  root.addEventListener('scroll', paint, { passive: true })
  // resize 监听绑定元素本身，销毁分页时不留下 window 监听。
  const observer = new ResizeObserver(() => {
    if (!root.isConnected) { observer.disconnect(); return }
    paint()
  })
  queueMicrotask(() => { if (root.isConnected) { observer.observe(root); paint() } })
  return root
}

export function renderReadings(mid) {
  const list = h('div', { id: 'readings-list' })
  const page = h('div', { class: 'page readings-page' }, h('div', { class: 'page-head' }, h('h1', {}, '读数'),
    h('p', {}, '最近入账的数据。不同来源合为一次观测，有分歧时等你裁决。')), list)
  clear(mid).append(page)
  list.append(pager(p => m.readingsPage(p), (box, items) => {
    if (!items.length) box.append(note('还没有读数。你可以让助手按主题抓数据推进来，也可以在检视面板给指标记一条。每条都会经过可信度检验后再入账。'))
    else box.append(dayFeed(items))
  }))
}

export function readingPanel(node) {
  if (node.type !== 'observation') return h('div')
  const box = h('section', { class: 'insp-section reading-ledger' }, h('div', { class: 'insp-h' }, '读数台账'))
  const form = h('details', { class: 'manual-reading' }, h('summary', {}, '记一条读数'))
  form.append(manualForm(node))
  box.append(form, pager(p => m.readingsPage({ indicatorId: node.id, ...p }), (content, items) => {
    if (!items.length) content.append(note('还没有读数。可在这里记一条，也可由助手按主题提供。'))
    else content.append(...items.map(observationRow))
  }, 10))
  return box
}
function manualForm(node) {
  const form = h('form', { class: 'reading-form' })
  const input = (name, label, type = 'text', required = true) => {
    const field = h('input', { class: 'txt', name, type, required, step: type === 'number' ? 'any' : null })
    form.append(h('label', {}, h('span', {}, label), field))
    return field
  }
  const value = input('value', '数值', 'number')
  const unit = input('unit', '单位')
  const start = input('start', '期间开始', 'date')
  const end = input('end', '期间结束', 'date')
  const basis = h('select', { class: 'sel', name: 'basis' }, h('option', { value: 'reported' }, '已披露'), h('option', { value: 'estimated' }, '估算'))
  form.append(h('label', {}, '口径', basis))
  const label = input('label', '来源名称')
  const kind = h('select', { class: 'sel', name: 'kind' }, ...['其他', '财报 / 公告', '一手数据', '券商研报', '独立媒体', '自媒体'].map(k => h('option', { value: k }, k)))
  form.append(h('label', {}, '来源类型', kind))
  const platform = input('platform', '发布平台（选填）', 'text', false)
  const url = input('url', '来源链接', 'url')
  const raw = h('textarea', { class: 'txt', name: 'raw', rows: '3' })
  form.append(h('label', {}, '原文（选填）', raw), note('手工记录按外部提供检验，填写来源类型不会提高可信度。'))
  const status = note('')
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, '保存读数')
  form.append(save, status)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!form.reportValidity()) return
    if (!value.value.trim() || !Number.isFinite(Number(value.value))) { status.textContent = '请填写有限的数值'; return }
    if (!unit.value.trim() || !label.value.trim()) { status.textContent = '请填写单位和来源名称'; return }
    if (!start.value || !end.value || start.value > end.value) { status.textContent = '期间开始不能晚于结束'; return }
    if (url.value) {
      const parsed = new URL(url.value)
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) { status.textContent = '来源链接只支持不含登录信息的网页地址'; return }
    }
    save.disabled = true
    status.textContent = '正在检验并入账…'
    try {
      const result = await m.pushReadings({ schema: 'meridian.reading.v1', themeHint: state.themes.find(t => t.id === node.themeId)?.name,
        readings: [{ indicator: node.title, value: Number(value.value), unit: unit.value.trim(), period: { start: start.value, end: end.value },
          basis: basis.value, tier: 'agent', source: { kind: kind.value, label: label.value.trim(), platform: platform.value.trim(), url: url.value.trim() },
          ...(raw.value.trim() ? { raw: raw.value } : {}) }] })
      if (result.rejected?.length || !result.ok) {
        status.textContent = '未能入账，请核对数值、期间和来源后重试。'
        return
      }
      toast(result.duplicates ? '这条读数已记录，无需重复入账' : '读数已入账')
      await refresh()
    } catch { status.textContent = '保存失败，填写内容已保留，请重试。' }
    finally { save.disabled = false }
  })
  return form
}

export function renderSources(mid) {
  const page = h('div', { class: 'page sources-page' }, h('div', { class: 'page-head' }, h('h1', {}, '数据源'),
    h('p', {}, '来源随读数自动记录。声誉来自交叉验证与历史表现，不是配置；只作参考，不会自动停用来源。')))
  clear(mid).append(page)
  const connection = h('details', { class: 'reading-connection' }, h('summary', {}, '让助手按主题提供数据'))
  const info = h('div')
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`已复制${label}`) }
    catch { toast('复制失败，请手动选择文本', 'var(--red)') }
  }
  const loadConnection = async () => {
    clear(info).append(note('正在读取连接信息…'))
    try {
      const c = await m.agentConnection()
      if (!c.port) {
        clear(info).append(note('本机接收服务尚未启动。'), c.error ? note(`原因：${c.error}`) : null,
          note('HTTP 与 MCP 两个入口都不可用。'))
      }
      const base = `http://${c.host || '127.0.0.1'}:${c.port}`
      const auth = c.requireToken === false ? {} : { authorization: `Bearer ${c.token}` }
      const rows = [
        // 两种接法并列说清。曾经只提 HTTP，MCP 实现了却一个字没提，
        // 用户以为只有一种接法，也没法配一个 MCP client。
        // 复制按钮直接把真凭据填进去——留 <token> 占位等于让用户自己开文件抄 64 位。
        { name: 'MCP', desc: '助手作为 MCP client 直连，可用 push_readings / list_themes / list_open_judgments 三个工具',
          action: c.port ? { label: '复制 MCP 配置', run: () => copy(JSON.stringify({
            mcpServers: { meridian: { url: `${base}/mcp`, ...(Object.keys(auth).length ? { headers: auth } : {}) } },
          }, null, 2), 'MCP 配置') } : null },
        { name: 'HTTP', desc: c.port ? `POST ${base}/readings 推送；GET ${base}/intent 读主题与未结算判断` : '服务未启动',
          action: c.port ? { label: '复制地址', run: () => copy(base, '接收地址') } : null },
      ]
      const list = h('div', { class: 'connection-rows' }, ...rows.map((r) => h('div', { class: 'connection-row' },
        h('div', { class: 'connection-main' },
          h('b', {}, r.name),
          note(r.desc)),
        r.action ? h('button', { class: 'btn', onclick: r.action.run }, r.action.label) : null,
      )))
      clear(info).append(
        note('两种接法走的是同一套验证，任选其一。'),
        list,
        c.token ? h('div', { class: 'connection-row' },
          h('div', { class: 'connection-main' },
            h('b', {}, '访问凭据'),
            note(`Bearer ${c.token.slice(0, 8)}…${c.token.slice(-4)}（共 ${c.token.length} 位）`)),
          h('button', { class: 'btn', onclick: () => copy(c.token, '访问凭据') }, '复制凭据'),
        ) : note('当前未启用访问凭据——只监听本机时才建议这样。'),
        note(`地址与端口可在 设置 → 界面 → 监听地址 / 端口 里改。完整信息也写在 ${c.path}（权限 0600）。`),
      )
    } catch { failure(info, loadConnection, '连接信息读取失败。') }
  }
  connection.addEventListener('toggle', () => { if (connection.open && !info.childNodes.length) loadConnection() })
  const exportButton = h('button', { class: 'btn export-intent', onclick: async () => {
    exportButton.disabled = true
    try {
      const result = await m.exportIntent()
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))
      const link = h('a', { href: url, download: 'meridian-intent.json' })
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast('已导出主题与未结算判断')
    } catch { toast('导出失败，请重试', 'var(--red)') }
    finally { exportButton.disabled = false }
  } }, '导出主题与待裁定判断')
  connection.append(info, exportButton)
  page.append(connection, pager(p => m.sourcesPage(p), (box, items) => {
    if (!items.length) { box.append(note('尚未收到来源。第一条读数入账后，这里会显示谁提供了它以及可信依据。')); return }
    for (const source of items) {
      const score = typeof source.trust === 'number' ? source.trust : source.trust?.score
      const detail = h('details', { class: 'source-record', dataset: { sourceId: source.id } },
        h('summary', {}, h('span', {}, h('b', {}, source.label || '未命名来源'), note(`${source.kind || '来源未分类'} · ${source.platform || '平台未记录'}`)),
          h('span', { class: 'reading-number' }, `${source.pushCount || 0} 条 · 可信度 ${typeof score === 'number' ? `${Math.round(score * 100)}%` : '待评定'}`)))
      let loaded = false
      detail.addEventListener('toggle', () => {
        if (!detail.open || loaded) return
        loaded = true
        const proofList = pager(p => m.readingEvidence({ sourceId: source.id, ...p }), (content, rows) => {
          if (!rows.length) content.append(note('暂无可查看的作证记录。'))
          else rows.forEach(r => content.append(h('button', { class: 'btn source-proof-link', onclick: () => openObservation(r, { proof: true }) }, `${periodLabel(r)} · ${fmtValue(r.value)} ${r.unit || ''} · 查看作证`)))
        }, 10)
        const extra = h('div', { class: 'source-record-detail' },
          note(`首次见到 ${source.firstSeenAt || '未记录'} · 最近见到 ${source.lastSeenAt || '未记录'}`),
          note(flagsLabel(source.flags || source.trust?.flags || []) || '尚无异常记录'), safeSourceLink(source.url), proofList)
        detail.append(extra)
      })
      box.append(detail)
    }
  }))
}
