/**
 * 主题认知链 · 视图组件
 *
 * 链 = 主题的认知快照：反映"我对这个主题认知的变化"。
 * 无预设模板，段名由挂载自然生长；不创建 ledger node，不碰 lemma/confidence（公理1）。
 */
import { h, clear, toast } from '../lib/dom.js'
import { state, setView, selectNode } from '../app.js'

const m = window.meridian

/** 段状态 → 文案/语义色。状态色由数据质量推导，不是置信度。 */
export const SEG_STATUS = {
  confirmed: { label: '已确认', cls: 'st-confirmed' },
  pending: { label: '待验证', cls: 'st-pending' },
  stale: { label: '数据待更新', cls: 'st-stale' },
  forking: { label: '分叉待收敛', cls: 'st-forking' },
  closed: { label: '已关闭', cls: 'st-closed' },
}

export function segStatusLabel(status) {
  return (SEG_STATUS[status] || SEG_STATUS.pending).label
}
export function segStatusCls(status) {
  return (SEG_STATUS[status] || SEG_STATUS.pending).cls
}

function fmtDate(at) {
  if (!at) return ''
  return String(at).slice(0, 10)
}

/** 一段一卡。分叉段首屏只显示分支数，不展开。 */
export function renderSegmentCard(theme, segment, opts = {}) {
  const st = SEG_STATUS[segment.status] || SEG_STATUS.pending
  const subs = Array.isArray(segment.subsegments) ? segment.subsegments : []
  const openSubs = subs.filter((s) => s.status !== 'closed')
  const isFork = subs.length > 0

  const head = h('div', { class: 'chain-card-head' },
    h('span', { class: 'chain-seg-title' },
      opts.index != null ? h('span', { class: 'chain-seq' }, String(opts.index + 1).padStart(2, '0')) : null,
      h('span', { class: 'chain-seg-name' }, segment.name || '未命名段')),
    h('span', { class: `chain-pill ${st.cls}` }, st.label),
  )
  const core = h('div', { class: 'chain-core' }, segment.coreInfo || '—')

  const metaBits = []
  if (segment.source?.label) {
    metaBits.push(h('span', { class: segment.source.firstHand ? 'chain-src-ok' : '' },
      `${segment.source.label}${segment.source.firstHand ? ' ✓' : ''}`))
  }
  if (segment.source?.at) metaBits.push(h('span', {}, fmtDate(segment.source.at)))
  const affects = Array.isArray(segment.affects) ? segment.affects.filter(Boolean) : []
  for (const a of affects) metaBits.push(h('span', { class: 'chain-affect' }, `→ 影响：${a}`))
  if (segment.mergedInto?.length) {
    metaBits.push(h('span', { class: 'chain-merge' }, `汇入：${segment.mergedInto.join(' · ')}`))
  }
  const meta = metaBits.length ? h('div', { class: 'chain-meta' }, ...metaBits) : null

  // 分叉段：首屏只露分支数
  let forkNote = null
  if (isFork) {
    const kindLabel = subs[0]?.kind === 'structural' ? '结构分叉' : '条件分叉'
    forkNote = h('div', { class: 'chain-forknote' },
      `${kindLabel} · ${openSubs.length} 个分支${segment.status === 'forking' ? ' · 待收敛' : ' · 并存'}`)
  }

  const card = h('button', {
    type: 'button', class: 'chain-card', 'data-seg-id': segment.id,
    'data-status': segment.status || 'pending',
    onclick: () => opts.onOpen?.(segment),
  }, head, core, meta, forkNote)
  return card
}

/** 主链视图：主题下的段列表。空链给引导态。 */
export function renderChainSection(theme, opts = {}) {
  const chain = theme.chain || { segments: [] }
  const segments = Array.isArray(chain.segments) ? chain.segments : []
  const wrap = h('section', { class: 'chain-section', 'aria-label': '认知链' },
    h('div', { class: 'chain-sect-h' },
      h('span', { class: 'chain-sect-title' }, '认知链'),
      h('span', { class: 'chain-sect-sub' }, segments.length ? `${segments.length} 个认知维度` : ''),
    ))

  if (!segments.length) {
    wrap.append(h('div', { class: 'chain-empty' },
      h('p', {}, '还没有认知维度。'),
      h('p', { class: 'chain-empty-sub' }, '在收件箱用提案草稿确认挂载后，段会在这里长出来。')))
    return wrap
  }

  const list = h('div', { class: 'chain-list' })
  segments.forEach((seg, i) => {
    list.append(renderSegmentCard(theme, seg, { ...opts, index: i }))
  })
  wrap.append(list)
  return wrap
}

/** 证据引用行：读数 → 读数详情抽屉；lemma → 点击选中，右栏检查器只读查看详情；收件箱 → 条目（预留）。 */
function renderEvidenceRef(ref, opts) {
  if (ref.type === 'lemma') {
    const node = (state.nodes || []).find((n) => n.id === ref.id)
    return h('button', {
      type: 'button', class: 'chain-evidence', title: '在右栏查看命题详情',
      onclick: () => { closeSegmentDetail(); selectNode(ref.id) },
    },
      h('span', { class: 'chain-evidence-type' }, '命题'),
      h('span', { class: 'chain-evidence-id' }, node?.title || ref.title || ref.id.slice(0, 8)),
      node ? h('span', { class: 'chain-evidence-conf' }, `置信度 ${Math.round(node.confidence ?? 0)}%`) : null)
  }
  const label = ref.type === 'reading' ? '读数' : '收件箱条目'
  return h('button', {
    type: 'button', class: 'chain-evidence',
    onclick: () => opts.onEvidence?.(ref),
  }, h('span', { class: 'chain-evidence-type' }, label),
    h('span', { class: 'chain-evidence-id' }, ref.title || ref.id.slice(0, 8)))
}

/** 变化历史时间线 */
function renderChangeLog(changeLog) {
  const logs = Array.isArray(changeLog) ? changeLog : []
  if (!logs.length) return h('p', { class: 'chain-note' }, '暂无变化记录。')
  const items = [...logs].reverse().map((e) => h('div', { class: 'chain-log-item' },
    h('div', { class: 'chain-log-at' }, fmtDate(e.at)),
    h('div', { class: 'chain-log-body' },
      e.oldValue || e.newValue
        ? h('div', { class: 'chain-log-delta' },
          h('span', { class: 'chain-log-old' }, e.oldValue || '—'),
          h('span', { class: 'chain-log-arrow' }, '→'),
          h('span', { class: 'chain-log-new' }, e.newValue || '—'))
        : null,
      e.reason ? h('div', { class: 'chain-log-reason' }, e.reason) : null,
    )))
  return h('div', { class: 'chain-timeline' }, ...items)
}

/** 子段（分叉）展示：与段同构 */
function renderSubsegments(segment) {
  const subs = (segment.subsegments || []).filter((s) => s.status !== 'closed')
  const closed = (segment.subsegments || []).filter((s) => s.status === 'closed')
  if (!subs.length && !closed.length) return null
  const box = h('div', { class: 'chain-subsegs' },
    h('div', { class: 'chain-detail-h' }, `分支（${subs.length}）`))
  for (const s of subs) {
    const st = SEG_STATUS[s.status] || SEG_STATUS.pending
    box.append(h('div', { class: 'chain-subseg' },
      h('div', { class: 'chain-subseg-head' },
        h('span', { class: 'chain-subseg-name' }, s.name),
        h('span', { class: `chain-pill ${st.cls}` }, st.label)),
      s.coreInfo ? h('div', { class: 'chain-subseg-core' }, s.coreInfo) : null,
      s.kind === 'conditional' && s.convergeCondition
        ? h('div', { class: 'chain-converge' }, `收敛条件：${s.convergeCondition}`) : null,
    ))
  }
  if (closed.length) {
    box.append(h('div', { class: 'chain-detail-h' }, `已关闭分支（${closed.length}）· 留痕可复盘`))
    for (const s of closed) {
      box.append(h('div', { class: 'chain-subseg closed' },
        h('div', { class: 'chain-subseg-head' },
          h('span', { class: 'chain-subseg-name' }, s.name),
          h('span', { class: 'chain-pill st-closed' }, '已关闭')),
        s.closeReason ? h('div', { class: 'chain-subseg-core' }, `关闭原因：${s.closeReason}`) : null,
      ))
    }
  }
  return box
}

/**
 * 段详情抽屉。右侧滑入，200-300ms transform/opacity 过渡。
 * 只读展示 + 回溯入口；写操作（合并段、关闭分支）走确认。
 */
export function openSegmentDetail(theme, segment, opts = {}) {
  closeSegmentDetail()
  const st = SEG_STATUS[segment.status] || SEG_STATUS.pending

  const backdrop = h('div', { class: 'chain-drawer-backdrop' })
  const drawer = h('aside', { class: 'chain-drawer', role: 'dialog', 'aria-label': `段详情：${segment.name}` })

  const close = () => {
    backdrop.classList.remove('show')
    drawer.classList.remove('show')
    setTimeout(() => { backdrop.remove(); drawer.remove() }, 280)
  }

  drawer.append(
    h('div', { class: 'chain-drawer-head' },
      h('div', {},
        h('div', { class: 'chain-drawer-title' }, segment.name || '未命名段'),
        h('span', { class: `chain-pill ${st.cls}` }, st.label)),
      h('button', { type: 'button', class: 'btn btn-icon', title: '关闭', onclick: close }, '✕')),
    h('div', { class: 'chain-drawer-body' },
      // 核心信息
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '核心信息'),
        h('p', { class: 'chain-dcore' }, segment.coreInfo || '—'),
        segment.metrics?.length ? h('div', { class: 'chain-metrics' },
          ...segment.metrics.map((mm) => h('span', { class: 'chain-metric' },
            h('b', {}, String(mm.value ?? '—')), h('i', {}, mm.label || '')))) : null),
      // 关系
      (segment.affects?.length || segment.mergedInto?.length)
        ? h('section', { class: 'chain-dsect' },
          h('div', { class: 'chain-detail-h' }, '关系'),
          segment.affects?.length ? h('p', {}, `→ 影响：${segment.affects.join('、')}`) : null,
          segment.mergedInto?.length ? h('p', {}, `汇入：${segment.mergedInto.join(' · ')}`) : null,
          segment.mergedFrom?.length ? h('p', { class: 'chain-note' }, `由 ${segment.mergedFrom.join('、')} 合并而来`) : null)
        : null,
      // 子段 / 分叉
      renderSubsegments(segment),
      // 变化历史
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '变化历史'),
        renderChangeLog(segment.changeLog)),
      // 依据文章
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '依据文章'),
        (segment.evidenceRefs?.length
          ? h('div', { class: 'chain-evidence-list' },
            ...segment.evidenceRefs.map((r) => renderEvidenceRef(r, opts)))
          : h('p', { class: 'chain-note' }, '暂无。'))),
      // 挂载数据（lemma 只读：含置信度展示，不可改）
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '挂载数据'),
        (segment.evidenceRefs || []).some((r) => r.type === 'lemma')
          ? h('div', { class: 'chain-evidence-list' },
            ...segment.evidenceRefs.filter((r) => r.type === 'lemma').map((r) => renderEvidenceRef(r, opts)))
          : h('p', { class: 'chain-note' }, '暂无关联命题。命题与置信度只读，不在此修改。')),
      // 证伪 / 收敛 / 结算
      (segment.falsifier || segment.convergeCondition || segment.settleAt)
        ? h('section', { class: 'chain-dsect' },
          h('div', { class: 'chain-detail-h' }, '证伪 · 收敛 · 结算'),
          segment.falsifier ? h('p', {}, `证伪：${segment.falsifier}`) : null,
          segment.convergeCondition ? h('p', {}, `收敛条件：${segment.convergeCondition}`) : null,
          segment.settleAt ? h('p', {}, `结算日：${segment.settleAt}`) : null)
        : null,
    ))

  backdrop.onclick = close
  document.body.append(backdrop, drawer)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('show')
    drawer.classList.add('show')
  }))
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) } }
  document.addEventListener('keydown', onKey)
}

export function closeSegmentDetail() {
  document.querySelectorAll('.chain-drawer, .chain-drawer-backdrop').forEach((el) => el.remove())
}

/** 证据详情：读数走 reading:evidence，来源 URL 外链原文。 */
export async function openEvidenceDetail(ref) {
  try {
    if (ref.type === 'reading') {
      const res = await m.readingEvidence({ observationId: ref.id, limit: 1 }).catch(() => null)
      const item = res?.items?.[0]
      if (!item) { toast('读数不存在或已被清理', 'var(--red)'); return }
      // 切到读数页并高亮：读数页按 indicator 分组，直接打开证据浮层更直接
      openReadingModal(item)
      return
    }
    toast('收件箱条目跳转 coming soon', 'var(--text-2)')
  } catch (e) {
    toast('打开依据失败：' + (e.message || e), 'var(--red)')
  }
}

function openReadingModal(reading) {
  closeSegmentDetail()
  const backdrop = h('div', { class: 'chain-drawer-backdrop' })
  const drawer = h('aside', { class: 'chain-drawer', role: 'dialog', 'aria-label': '读数详情' })
  const close = () => {
    backdrop.classList.remove('show'); drawer.classList.remove('show')
    setTimeout(() => { backdrop.remove(); drawer.remove() }, 280)
  }
  const src = reading.source || {}
  drawer.append(
    h('div', { class: 'chain-drawer-head' },
      h('div', { class: 'chain-drawer-title' }, reading.indicator || reading.metric || '读数'),
      h('button', { type: 'button', class: 'btn btn-icon', title: '关闭', onclick: close }, '✕')),
    h('div', { class: 'chain-drawer-body' },
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '数值'),
        h('p', { class: 'chain-dcore' }, `${reading.value ?? '—'} ${reading.unit || ''}`),
        h('p', { class: 'chain-note' }, `周期：${reading.period?.start || ''} ~ ${reading.period?.end || ''}`)),
      h('section', { class: 'chain-dsect' },
        h('div', { class: 'chain-detail-h' }, '来源'),
        h('p', {}, src.label || '—'),
        src.url ? h('button', {
          type: 'button', class: 'chain-linkbtn',
          onclick: async () => { try { await m.openExternal(src.url) } catch { toast('无法打开来源链接', 'var(--red)') } },
        }, '在系统浏览器打开原文 ↗') : null),
      h('section', { class: 'chain-dsect' },
        h('button', {
          type: 'button', class: 'btn',
          onclick: () => { close(); state.readingHighlight = reading.id; setView('readings') },
        }, '去读数页查看')),
    ))
  backdrop.onclick = close
  document.body.append(backdrop, drawer)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('show'); drawer.classList.add('show')
  }))
}

/* ------------------------------------------------------------------ */
/* 提案草稿：收件箱条目详情内展开。只起草、不拍板；用户点"确认挂载"生效。 */
/* ------------------------------------------------------------------ */

/** 简单相似度：新段名 vs 已有段名，提醒防重（不拦截）。 */
function segNameSimilarity(a, b) {
  const x = String(a || '').trim().toLowerCase()
  const y = String(b || '').trim().toLowerCase()
  if (!x || !y || x === y) return 0
  if (x.includes(y) || y.includes(x)) return 0.9
  // 字符级 Jaccard
  const set = (s) => new Set([...s])
  const sx = set(x), sy = set(y)
  let inter = 0
  for (const c of sx) if (sy.has(c)) inter++
  const union = new Set([...sx, ...sy]).size
  return union ? inter / union : 0
}

/**
 * 提案草稿区。
 * @param item 收件箱条目（含 chainDraft）
 * @param existingSegments 该主题已有段名列表 [{id, name}]
 * @param opts { themeId, onDraft(), onMounted() } 挂载成功回调
 */
export function renderProposalDraft(item, existingSegments = [], opts = {}) {
  const draft = item.chainDraft
  const themeId = opts.themeId
  const box = h('section', { class: 'inbox-detail-section chain-draft-sect' },
    h('h4', { class: 'inbox-section-title' }, '提案草稿 · 认知链挂载'))

  // 无草稿：生成按钮
  if (!draft || draft.status !== 'draft') {
    const genBtn = h('button', { type: 'button', class: 'btn' }, '用模型起草')
    const manualBtn = h('button', { type: 'button', class: 'btn' }, '手动起草')
    const hint = h('p', { class: 'inbox-detail-note' }, '草稿只给建议：挂到哪个段、参数怎么变。最终由你确认。')
    genBtn.onclick = async () => {
      genBtn.disabled = true
      try {
        const res = await m.chainGenerateDraft(item.id)
        if (res?.ok && res.draft) {
          item.chainDraft = res.draft
          toast('草稿已生成，请检查后确认挂载')
          opts.onDraft?.()
        } else {
          toast('生成失败：' + (res?.error || '未配置 API key，可手动起草'), 'var(--red)')
        }
      } catch (e) {
        toast('生成失败：' + (e.message || e), 'var(--red)')
      } finally { genBtn.disabled = false }
    }
    manualBtn.onclick = () => {
      item.chainDraft = {
        segmentNames: [], newSegmentName: '', coreInfo: '', oldValue: '', newValue: '',
        evidence: '', falsifier: '', status: 'draft', createdBy: 'user', createdAt: new Date().toISOString().slice(0, 10),
      }
      opts.onDraft?.()
    }
    box.append(hint, h('div', { class: 'chain-draft-actions' }, genBtn, manualBtn))
    return box
  }

  // 有草稿：可编辑表单
  const segNames = Array.isArray(draft.segmentNames) ? [...draft.segmentNames] : []
  const warnBox = h('p', { class: 'chain-simwarn', hidden: true })

  // 已有段多选
  const checkWrap = h('div', { class: 'chain-segcheck' })
  const refreshChecks = () => {
    clear(checkWrap)
    for (const s of existingSegments) {
      const on = segNames.includes(s.name)
      checkWrap.append(h('label', { class: `chain-check${on ? ' on' : ''}` },
        h('input', {
          type: 'checkbox', checked: on,
          onchange: (e) => {
            const i = segNames.indexOf(s.name)
            if (e.target.checked && i < 0) segNames.push(s.name)
            if (!e.target.checked && i >= 0) segNames.splice(i, 1)
            refreshChecks()
          },
        }), h('span', {}, s.name)))
    }
    if (!existingSegments.length) checkWrap.append(h('span', { class: 'chain-note' }, '该主题还没有段，可在下方新开。'))
  }
  refreshChecks()

  // 新开段名输入 + 自动补全 + 相似提醒
  const nameInput = h('input', {
    class: 'txt', placeholder: '新开段名（留空则只挂已有段）', value: draft.newSegmentName || '',
  })
  const suggestBox = h('div', { class: 'chain-suggest', hidden: true })
  const checkSimilar = () => {
    const v = nameInput.value.trim()
    if (!v) { warnBox.hidden = true; suggestBox.hidden = true; return }
    // 自动补全：前缀匹配
    const cands = existingSegments.filter((s) => s.name.toLowerCase().startsWith(v.toLowerCase()) && s.name !== v).slice(0, 5)
    clear(suggestBox)
    if (cands.length) {
      suggestBox.hidden = false
      for (const c of cands) {
        suggestBox.append(h('button', {
          type: 'button', class: 'chain-suggest-item',
          onclick: () => {
            nameInput.value = c.name
            if (!segNames.includes(c.name)) segNames.push(c.name)
            refreshChecks(); checkSimilar()
          },
        }, c.name))
      }
    } else suggestBox.hidden = true
    // 相似提醒：不拦截
    const sims = existingSegments
      .map((s) => ({ name: s.name, sim: segNameSimilarity(v, s.name) }))
      .filter((x) => x.sim >= 0.6)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 2)
    if (sims.length) {
      warnBox.hidden = false
      clear(warnBox).append(`已有相似段「${sims.map((x) => x.name).join('」「')}」，确定要新开吗？`)
    } else warnBox.hidden = true
  }
  nameInput.addEventListener('input', checkSimilar)

  const coreInput = h('input', { class: 'txt', placeholder: '一句话核心信息', value: draft.coreInfo || '' })
  const oldInput = h('input', { class: 'txt', placeholder: '旧值（可空）', value: draft.oldValue || '' })
  const newInput = h('input', { class: 'txt', placeholder: '新值', value: draft.newValue || '' })
  const evInput = h('input', { class: 'txt', placeholder: '依据（一句话）', value: draft.evidence || '' })
  const falInput = h('input', { class: 'txt', placeholder: '证伪条件（可空）', value: draft.falsifier || '' })

  const mountBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '确认挂载')
  const dismissBtn = h('button', { type: 'button', class: 'btn' }, '放弃草稿')
  const saveDraft = async () => {
    const payload = {
      segmentNames: segNames, newSegmentName: nameInput.value.trim(),
      coreInfo: coreInput.value.trim(), oldValue: oldInput.value.trim(), newValue: newInput.value.trim(),
      evidence: evInput.value.trim(), falsifier: falInput.value.trim(),
      status: 'draft', createdBy: draft.createdBy || 'user', createdAt: draft.createdAt,
    }
    const res = await m.chainSetDraft(item.id, payload).catch(() => null)
    if (res?.ok) item.chainDraft = { ...payload }
    return !!res?.ok
  }

  mountBtn.onclick = async () => {
    const allSegs = [...segNames]
    if (nameInput.value.trim() && !allSegs.includes(nameInput.value.trim())) allSegs.push(nameInput.value.trim())
    if (!allSegs.length) { toast('请至少选择或新开一个段', 'var(--red)'); return }
    if (!newInput.value.trim() && !coreInput.value.trim()) { toast('请填写新值或核心信息', 'var(--red)'); return }
    mountBtn.disabled = true
    try {
      await saveDraft()
      if (!themeId) { toast('该条目没有可用主题，无法挂载', 'var(--red)'); mountBtn.disabled = false; return }
      // 条目的命题一并记为证据引用（只读展示置信度，不创建/修改 lemma）
      const lemmaRefs = (item.lemmas || [])
        .filter((l) => l.id)
        .map((l) => ({ type: 'lemma', id: l.id, title: l.title }))
      const res = await m.chainMount(themeId, {
        inboxId: item.id,
        segmentNames: allSegs,
        coreInfo: coreInput.value.trim(),
        oldValue: oldInput.value.trim(),
        newValue: newInput.value.trim(),
        evidence: evInput.value.trim(),
        falsifier: falInput.value.trim(),
        evidenceRefs: [{ type: 'inbox', id: item.id, title: item.title }, ...lemmaRefs],
      })
      if (res?.ok) {
        item.chainDraft = { ...item.chainDraft, status: 'mounted', mountedAt: new Date().toISOString().slice(0, 10) }
        toast(`已挂载到「${allSegs.join('」「')}」`)
        opts.onMounted?.(res)
      } else {
        toast('挂载失败：' + (res?.error || '请重试'), 'var(--red)')
      }
    } catch (e) {
      toast('挂载失败：' + (e.message || e), 'var(--red)')
    } finally { mountBtn.disabled = false }
  }
  dismissBtn.onclick = async () => {
    await m.chainSetDraft(item.id, null).catch(() => null)
    item.chainDraft = null
    toast('草稿已放弃')
    opts.onDraft?.()
  }

  const field = (label, el) => h('label', { class: 'chain-field' }, h('span', {}, label), el)
  box.append(
    h('p', { class: 'inbox-detail-note' }, `草稿来源：${{ agent: '助手研究', llm: '模型起草', user: '手动' }[draft.createdBy] || '未知'} · 只给建议，由你确认`),
    field('挂到已有段（可多选）', checkWrap),
    field('新开段名', h('div', {}, nameInput, suggestBox)),
    warnBox,
    field('一句话核心信息', coreInput),
    h('div', { class: 'chain-duo' }, field('旧值', oldInput), field('新值', newInput)),
    field('依据', evInput),
    field('证伪条件', falInput),
    h('div', { class: 'chain-draft-actions' }, mountBtn, dismissBtn),
  )
  return box
}
