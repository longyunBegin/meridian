import { h, toast } from '../lib/dom.js'
import { evidenceForNode } from '../lib/chain-workbench-model.js'

/**
 * 前端贝叶斯置信度预览（与后端 engine-confidence.js 公式一致）
 * 支持：new = old + (1-old) × strength × 0.3
 * 反驳：new = old - old × strength × 0.5
 */
function previewConfidence(old, strength, rel) {
  if (old == null || !Number.isFinite(old)) return null
  const s = Math.max(0, Math.min(1, Number(strength) || 0))
  const o = Math.max(0, Math.min(1, old > 1 ? old / 100 : old))
  let next
  if (rel === 'supports') next = o + (1 - o) * s * 0.3
  else if (rel === 'contradicts') next = o - o * s * 0.5
  else return o
  return Math.max(0, Math.min(1, next))
}

/** 生成短来源 ID（IN-014 风格） */
function shortSourceId(item) {
  const id = String(item.id || '')
  // 从 ID 中提取数字部分，或用 hash 生成
  const num = id.replace(/\D/g, '').slice(-3).padStart(3, '0')
  if (num && num !== '000') return `IN-${num}`
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  return `IN-${String(Math.abs(hash) % 900 + 100)}`
}

export function renderEnginePipeline(item, { themeId, onDone, projection = {} } = {}) {
  const m = globalThis.window?.meridian || {}
  const wrap = h('div', { class: 'engine-pipe-v2' })
  const pipeline = item.enginePipeline
  const runButton = (label, callback) => {
    const button = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, label)
    button.addEventListener('click', callback)
    return button
  }
  if (!pipeline || pipeline.status !== 'done') {
    const sourceText = String(item.text || '').trim()
    const shortId = shortSourceId(item)
    const sourceTitle = item.title || '未命名来源'
    const sourceLabel = item.provenance?.sourceLabel || item.provenance?.platform || '未标注来源'
    const publishTime = (() => {
      const d = item.provenance?.publishedAt || item.createdAt
      if (!d) return '未记录'
      try { return new Date(d).toISOString().slice(0, 10) } catch { return '未记录' }
    })()
    const sourceDesc = sourceText.replace(/\s+/g, ' ').slice(0, 150)
    const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
    const button = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
      button.disabled = true
      error.hidden = true
      try {
        const response = await m.engineRunPipeline(item.id)
        if (!response?.ok) throw new Error(response?.error || '运行失败')
        item.enginePipeline = response.pipeline
        toast('建议已生成；请逐条审阅后确认或驳回')
        onDone?.({ kind: 'pipeline', item })
      } catch (cause) {
        error.hidden = false; error.textContent = cause?.message || String(cause); button.disabled = false
      }
    } }, '运行模型抽取与映射')
    button.disabled = !sourceText
    // 新卡片风格（与待审卡片设计语言一致）
    wrap.append(
      h('div', { class: 'review-card-v2' },
        h('div', { class: 'review-card-head' },
          h('span', { class: 'review-card-kicker' }, `外部数据待处理 · ${shortId}`),
          h('span', { class: 'review-badge-pending' }, '待运行模型')),
        h('div', { class: 'review-source-card' },
          h('div', { class: 'review-source-title-row' },
            h('strong', {}, sourceTitle),
            h('span', { class: 'review-source-id' }, shortId)),
          h('div', { class: 'review-source-meta' },
            h('span', {}, '来源 '), h('b', {}, sourceLabel),
            h('span', { class: 'review-meta-sep' }, '发布时间 '), h('b', {}, publishTime)),
          sourceDesc ? h('p', { class: 'review-source-desc' }, sourceDesc) : null),
        h('div', { class: 'review-runmodel-box' },
          h('div', { class: 'review-runmodel-title' }, '外部数据 → 抽取 → 归因/建议 → 人工确认'),
          h('p', { class: 'review-runmodel-desc' }, sourceText
            ? '运行已配置的模型来抽取原子陈述、映射候选关系并生成变更前后预览。模型只提出建议；确认或驳回前不会修改主题投影。'
            : '此来源没有保存可供分析的正文。请重新接入原文或摘录；仅凭标题或 URL 不会伪造抽取结果。'),
          h('div', { class: 'review-runmodel-actions' }, button)),
        error))
    return wrap
  }

  const { statements = [], results = [], diagnostics = [] } = pipeline
  const typeLabel = { hard: '硬事实', soft: '软事实', relational: '关系陈述', meta: '元陈述' }
  const relLabel = { supports: '支持', contradicts: '反驳', derives: '衍生', supersedes: '取代', related: '相关' }
  const provenance = item.provenance || {}
  const sourceLabel = provenance.sourceLabel || provenance.platform || item.source || item.label?.kind || '来源未记录'
  const sourceDate = provenance.publishedAt || provenance.sourceDate || item.publishedAt || item.sourceDate || null
  const ingestedAt = item.createdAt || item.capturedAt || provenance.capturedAt || null
  wrap.append(h('div', { class: 'engine-source-meta' },
    h('span', {}, `来源 · ${sourceLabel}`),
    h('span', {}, `来源时间 · ${sourceDate || '未记录'}`),
    h('span', {}, `系统摄入 · ${ingestedAt || '未记录'}`),
    provenance.fetchedAt ? h('span', {}, `抓取时间 · ${provenance.fetchedAt}`) : null))
  wrap.append(h('p', { class: 'engine-step-title' }, `抽取 · ${statements.length} 条原子陈述（待核对）`))
  const statementList = h('ul', { class: 'engine-stmt-list' })
  for (const statement of statements) {
    statementList.append(h('li', { class: 'engine-stmt' },
      h('span', { class: `engine-type is-${statement.type}` }, typeLabel[statement.type] || '软事实'),
      h('span', { class: 'engine-stmt-text' }, `[${statement.subject}] ${statement.attribute} = ${statement.value}`),
      statement.timeWindow ? h('span', { class: 'engine-stmt-time' }, statement.timeWindow) : h('span', { class: 'engine-stmt-time is-unknown' }, '时间未注明')))
  }
  wrap.append(statementList)
  if (pipeline.metaCount) wrap.append(h('p', { class: 'chain-note' }, `同批元信息 ${pipeline.metaCount} 条；证据强度乘数 ${(Number(pipeline.metaMultiplier ?? 1) * 100).toFixed(0)}%。`))
  if (diagnostics.length) {
    const diagnosticList = h('ul', { class: 'engine-diagnostics' })
    for (const diagnostic of diagnostics) diagnosticList.append(h('li', {}, `${diagnostic.statement?.subject || '陈述'}：${diagnostic.reason}`))
    wrap.append(h('p', { class: 'engine-step-title' }, `待人工检查 · ${diagnostics.length} 条`), diagnosticList)
  }
  if (!results.length) {
    wrap.append(h('p', { class: 'chain-note' }, '没有形成可确认的归因建议。原始收件箱来源仍保留；你也可以使用下方手动归因。'))
    return wrap
  }
  wrap.append(h('p', { class: 'engine-step-title' }, `映射建议 · ${results.length} 条（未确认不进入投影）`))
  const list = h('ul', { class: 'engine-attr-list' })
  const reviewStatuses = []
  const changeOptions = (values, selected, labels) => {
    const select = h('select', { class: 'engine-review-select' })
    for (const value of values) {
      const option = h('option', { value }, labels[value] || value)
      select.append(option)
    }
    select.value = values.includes(selected) ? selected : values[0]
    return select
  }
  for (const result of results) {
    const suggestion = result.recommendation || {}
    const attribution = result.attribution || {}
    const statement = result.statement || {}
    const isNew = result.kind === 'new-proposition' || suggestion.kind === 'new-proposition'
    const allAtoms = (projection?.allNodes || projection?.nodes || []).filter((n) => !n.archived && !n.invalidated && !n.external)
    const targetNode = allAtoms.find((node) =>
      node.id === (suggestion.propositionId || result.proposition?.id))
    // 目标原子选择器：用户可覆盖 AI 的结构决策（换挂载目标 / 改为新建）
    const targetSelect = h('select', { class: 'engine-review-target', 'aria-label': '目标原子' },
      h('option', { value: '__new__' }, '＋ 新建原子'),
      ...allAtoms.map((n) => h('option', { value: n.id }, n.title || '未命名原子')))
    // 默认选中 AI 建议
    targetSelect.value = isNew ? '__new__' : (targetNode?.id || '__new__')
    const relation = changeOptions(['supports', 'contradicts', 'derives', 'supersedes', 'related'],
      suggestion.rel || attribution.rel, relLabel)
    /* 新原子标题只在目标选择器停在「＋ 新建原子」时才需要——包括 AI 没给 propositionId、
       或目标已被归档/失效导致下拉默认落在新建的情形（那种情形下若没有输入框，点确认会抛
       null.value）。它按需插入 DOM，所以正常归因卡的高级选项仍然只有
       目标原子 / 关系类型 / 备注 三个控件。 */
    const suggestedTitle = suggestion.title || result.suggestedTitle || ''
    let titleInput = null
    let titleInputListener = null
    const titleField = h('label', { class: 'engine-review-field' }, '新原子标题')
    const ensureTitleInput = () => {
      if (!titleInput) {
        titleInput = h('input', {
          class: 'engine-review-title', type: 'text', maxlength: '180',
          value: suggestedTitle, 'aria-label': '新原子标题',
        })
        titleInput.addEventListener('input', () => titleInputListener?.())
        titleField.append(titleInput)
      }
      return titleInput
    }
    /* 备注取代了写死的方向/性质/标签：模型至多建议一句自由文本，用户可改可删，后端不做枚举校验。
       旧账本里已写入的 change.themeTag 仅作为备注初值回填，不再作为类型字段。 */
    const suggestedNote = suggestion.change?.note || attribution.change?.note
      || suggestion.change?.themeTag || attribution.change?.themeTag || ''
    const changeNote = h('input', {
      class: 'engine-review-note', type: 'text', maxlength: '200', value: suggestedNote,
      placeholder: '可留空；例如：这条证据改写了哪一点', 'aria-label': '备注（可选）',
    })
    /* 高级选项：默认只有 目标原子 / 关系类型 / 备注。选到「＋ 新建原子」时才把
       新原子标题插到关系类型前面；切回已有原子就移除。 */
    const relationField = h('label', { class: 'engine-review-field' }, '关系类型', relation)
    const advancedOptions = h('details', { class: 'review-advanced' },
      h('summary', {}, '高级选项'),
      h('label', { class: 'engine-review-field' }, '目标原子', targetSelect),
      relationField,
      h('label', { class: 'engine-review-field' }, '备注', changeNote))
    const attachTitleField = () => {
      if (titleField.isConnected) return
      ensureTitleInput()
      advancedOptions.insertBefore(titleField, relationField)
    }
    targetSelect.addEventListener('change', () => {
      if (targetSelect.value === '__new__') attachTitleField()
      else titleField.remove()
    })
    if (targetSelect.value === '__new__') attachTitleField()
    const quoteVerified = statement.sourceQuoteVerified === true
    const warning = !quoteVerified
      ? h('p', { class: 'engine-review-warning', role: 'alert' }, '来源摘录未能与原文核验；为避免把模型编造内容写入账本，本条不能直接确认。')
      : result.requiresTemporalReview || result.match?.requiresTemporalReview
        ? h('p', { class: 'engine-review-warning' }, '原文未注明时间窗口；仅语义/主体作为候选，确认前请核对时间适用性。')
        : null
    const quote = h('blockquote', { class: 'engine-review-quote' }, statement.sourceText || '（缺少来源摘录）')
    const beforeText = isNew
      ? '当前投影中尚未创建这条建议原子。'
      : targetNode
        ? `${targetNode.title || '未命名节点'}：${targetNode.currentText || targetNode.detail || '当前没有保存说明。'}`
        : `建议目标「${suggestion.propositionTitle || result.proposition?.title || '未映射'}」尚未定位到当前投影。`
    const afterPreviewText = h('p', {}, '')
    const kindLabel = h('span', { class: `engine-rel is-${suggestion.rel || attribution.rel || 'related'}` }, '')
    const updateAfterPreview = () => {
      const revisesNode = !isNew && relation.value === 'supersedes'
      kindLabel.textContent = isNew ? '新观点建议' : revisesNode ? '修订观点建议' : (relLabel[relation.value] || '归因建议')
      kindLabel.className = `engine-rel is-${relation.value || 'related'}${revisesNode ? ' is-revision' : ''}`
      afterPreviewText.textContent = isNew
        ? `若确认，将新增观点「${titleInput?.value || suggestion.title || result.suggestedTitle || '待命名观点'}」并追加已核验来源证据。`
        : revisesNode
          ? `若确认，将把「${targetNode?.title || suggestion.propositionTitle || result.proposition?.title || '目标观点'}」的当前表述「${targetNode?.currentText || targetNode?.detail || targetNode?.title || '未记录'}」修订为已核验来源摘录「${sourceQuote}」${statement.timeWindow ? `（适用时间：${statement.timeWindow}）` : '（适用时间未注明）'}；旧版本保留，并追加证据与更正事件。`
          : `若确认，将向「${targetNode?.title || suggestion.propositionTitle || result.proposition?.title || '目标观点'}」追加证据与「${relLabel[relation.value] || '关系待审核'}」关系；原有记录保留。`
    }
    updateAfterPreview()
    titleInputListener = updateAfterPreview
    relation.addEventListener('change', updateAfterPreview)
    const preview = h('section', { class: 'engine-before-after', 'aria-label': '变更前后预览' },
      h('div', { class: 'engine-preview-column is-before' }, h('strong', {}, '确认前 · 当前模型'), h('p', {}, beforeText)),
      h('div', { class: 'engine-preview-arrow', 'aria-hidden': 'true' }, '→'),
      h('div', { class: 'engine-preview-column is-after' }, h('strong', {}, '确认后 · 建议投影'), afterPreviewText),
      h('p', { class: 'engine-preview-note' }, '此处为预览。确认前不会写入事实或关系；决定后以追加事件更新投影。'))
    /* 判决结果的 live region：这段文案给读屏软件播报，视觉上不占位（.sr-only）。
       之前它构造后从未插入 DOM，五处 textContent 赋值等于白写。 */
    const status = h('span', { class: 'engine-review-status sr-only', role: 'status' })
    const confirm = runButton('确认并追加', async () => {
      confirm.disabled = true; reject.disabled = true
      try {
        const input = { change: { note: changeNote.value.trim() } }
        const userTarget = targetSelect.value
        const userWantsNew = userTarget === '__new__'
        if (userWantsNew) {
          input.title = (titleInput?.value ?? suggestedTitle).trim()
          // 明确告诉后端这是新建（覆盖 AI 的挂载建议）
          input.targetNodeId = null
        } else {
          input.targetNodeId = userTarget
          input.rel = relation.value
        }
        const response = await m.chainReviewEngineRecommendation(themeId, result.proposalEventId, 'accepted', input)
        if (response?.ok === false) throw new Error(response.error || '写入失败')
        result.reviewDecision = 'accepted'
        status.textContent = '已确认 · 事件已追加'
        card.classList.add('is-done'); onDone?.({ kind: 'decision', result, decision: 'accepted' })
      } catch (cause) { toast(`未能确认：${cause?.message || cause}`, 'var(--red)'); confirm.disabled = false; reject.disabled = false }
    })
    const reject = h('button', { type: 'button', class: 'btn btn-sm' }, '驳回建议')
    reject.addEventListener('click', async () => {
      confirm.disabled = true; reject.disabled = true
      try {
        const response = await m.chainReviewEngineRecommendation(themeId, result.proposalEventId, 'rejected', {})
        if (response?.ok === false) throw new Error(response.error || '驳回失败')
        result.reviewDecision = 'rejected'; status.textContent = '已驳回'; card.classList.add('is-done'); onDone?.({ kind: 'decision', result, decision: 'rejected' })
      } catch (cause) { toast(`未能驳回：${cause?.message || cause}`, 'var(--red)'); confirm.disabled = false; reject.disabled = false }
    })
    // === 新版待审卡片：按数据流转设计（截图信息架构） ===
    const shortId = shortSourceId(item)
    const sourceTitle = item.title || statement.subject || '未命名来源'
    const sourceLabel = item.provenance?.sourceLabel || item.provenance?.platform || '未标注来源'
    const publishTime = (() => {
      const d = item.provenance?.publishedAt || item.createdAt
      if (!d) return '未记录'
      try { return new Date(d).toISOString().slice(0, 10) } catch { return '未记录' }
    })()
    const sourceDesc = String(item.text || '').replace(/\s+/g, ' ').slice(0, 120)
    const extractedQuote = statement.sourceText || ''
    const targetTitle = targetNode?.title || suggestion.propositionTitle || result.proposition?.title || '未映射目标'
    const polarity = relation.value || suggestion.rel || 'related'
    const polarityLabel = { supports: '支持', contradicts: '反驳', derives: '推导', supersedes: '修订', related: '相关' }[polarity] || polarity
    const weight = Number(suggestion.effectiveStrength ?? suggestion.strength ?? attribution.strength ?? 0.5)
    // 当前强度与信号统计
    const curConf = targetNode ? Number(targetNode.confidence ?? 50) : null
    const curConfPct = curConf != null ? Math.round(curConf > 1 ? curConf : curConf * 100) : null
    // 预览计算（贝叶斯）
    const newConf = curConf != null && ['supports', 'contradicts'].includes(polarity)
      ? previewConfidence(curConf, weight, polarity) : null
    const newConfPct = newConf != null ? Math.round(newConf * 100) : null
    /* 设计稿的预览卡带信号计数：同一套 evidenceForNode 口径（支持/挑战/两边都算），
       和读者视图的强度块保持一致；确认后按本次极性推演目标原子的计数变化。 */
    const evidenceCounts = (() => {
      if (!targetNode) return null
      try {
        const summary = evidenceForNode({ projection }, targetNode.id)
        return { supports: summary.supports.length + summary.both.length,
          challenges: summary.against.length + summary.both.length }
      } catch { return null }
    })()
    const beforeCounts = evidenceCounts
      ? ` · 支持 ${evidenceCounts.supports} / 挑战 ${evidenceCounts.challenges}` : ''
    const afterCounts = evidenceCounts ? {
      supports: evidenceCounts.supports + (polarity === 'supports' ? 1 : 0),
      challenges: evidenceCounts.challenges + (polarity === 'contradicts' ? 1 : 0),
    } : null
    const afterCountsText = afterCounts
      ? ` · 支持 ${afterCounts.supports} / 挑战 ${afterCounts.challenges}` : ''
    // 变化描述
    const changeDesc = isNew
      ? `将新增原子「${suggestion.title || result.suggestedTitle || '待命名'}」；来源 ${shortId}。`
      : polarity === 'contradicts'
        ? `为「${targetTitle}」追加一条挑战信号；来源 ${shortId}。`
        : polarity === 'supports'
          ? `为「${targetTitle}」追加一条支持信号；来源 ${shortId}。`
          : `为「${targetTitle}」追加一条「${polarityLabel}」关系；来源 ${shortId}。`

    const card = h('li', { class: 'review-card-v2' },
      // 头部
      h('div', { class: 'review-card-head' },
        h('span', { class: 'review-card-kicker' }, `外部数据归因 · ${shortId}`),
        h('span', { class: 'review-badge-pending' }, '待人工确认')),
      // 来源卡片
      h('div', { class: 'review-source-card' },
        h('div', { class: 'review-source-title-row' },
          h('strong', {}, sourceTitle),
          h('span', { class: 'review-source-id' }, shortId)),
        h('div', { class: 'review-source-meta' },
          h('span', {}, '来源 '), h('b', {}, sourceLabel),
          h('span', { class: 'review-meta-sep' }, '发布时间 '), h('b', {}, publishTime)),
        sourceDesc ? h('p', { class: 'review-source-desc' }, sourceDesc) : null,
        extractedQuote ? h('div', { class: 'review-quote-box' },
          h('div', { class: 'review-quote-label' }, '抽取结果 · 原文线索'),
          h('p', { class: 'review-quote-text' }, `“${extractedQuote}”`)) : null),
      warning,
      // 建议归因
      h('div', { class: 'review-section' },
        h('div', { class: 'review-section-head' },
          h('strong', {}, '建议归因'),
          h('span', { class: 'review-badge-ai' }, 'AI 建议 · 未确认')),
        h('div', { class: 'review-attr-row' },
          h('div', { class: 'review-attr-card' },
            h('span', { class: 'review-attr-label' }, '目标原子'),
            h('span', { class: 'review-attr-target' },
              h('span', { class: 'review-dot', style: `background:${targetNode?.color || '#14b8a6'}` }),
              targetTitle)),
          h('span', { class: 'review-attr-arrow' }, '→'),
          h('div', { class: 'review-attr-card' },
            h('span', { class: 'review-attr-label' }, '极性 / 权重'),
            h('span', {},
              h('span', { class: `review-polarity is-${polarity}` }, polarityLabel),
              h('span', { class: 'review-weight' }, ` 权重 ${weight.toFixed(2)}`))))),
      // 确认后变化预览
      !isNew && curConfPct != null ? h('div', { class: 'review-section' },
        h('div', { class: 'review-section-head' },
          h('strong', {}, '确认后变化预览'),
          h('span', { class: 'review-preview-note' }, '以下仅为预览 · 当前模型未改变')),
        h('div', { class: 'review-preview-row' },
          h('div', { class: 'review-preview-card' },
            h('span', { class: 'review-attr-label' }, '● 当前原子强度'),
            h('p', {}, `${targetTitle}：强度 ${curConfPct}%${beforeCounts}`)),
          h('div', { class: 'review-preview-card is-after' },
            h('span', { class: 'review-attr-label' }, '● 确认后'),
            h('p', {}, newConfPct != null
              ? `${targetTitle}：强度将变为 ${newConfPct}%${afterCountsText}`
              : `${targetTitle}：强度不变（${polarityLabel}不直接改变强度）${afterCountsText}`))),
        h('div', { class: 'review-change-summary' },
          h('strong', {}, '将产生的变化：'), h('span', {}, changeDesc)),
        h('p', { class: 'review-ai-note' }, '○ AI 只提出映射建议。确认前，原子节点的强度不改变；驳回也不会改写既有模型。'))
        : h('div', { class: 'review-change-summary' },
          h('strong', {}, '将产生的变化：'), h('span', {}, changeDesc)),
      // 高级选项（折叠）：新原子标题按需挂载
      advancedOptions,
      // 底部操作
      h('div', { class: 'review-card-foot' },
        status,
        h('span', { class: 'review-foot-hint' }, '选择后仅更新当前页面演示状态。'),
        h('div', { class: 'review-foot-actions' }, reject, confirm)))
    // 更新按钮文本
    confirm.textContent = '确认并追加'
    reject.textContent = '驳回'
    confirm.disabled = !result.proposalEventId || !quoteVerified
    reject.disabled = !result.proposalEventId
    if (result.reviewDecision === 'rejected') { status.textContent = '已驳回'; confirm.disabled = true; reject.disabled = true; card.classList.add('is-done') }
    else if (result.reviewDecision === 'accepted' || result.reviewDecision === 'corrected') { status.textContent = '已确认 · 事件已追加'; confirm.disabled = true; reject.disabled = true; card.classList.add('is-done') }
    list.append(card)
    reviewStatuses.push({ result, status, card, confirm, reject })
  }
  wrap.append(list)
  /* Hydrate persisted decisions after reopening; main command remains the idempotent authority. */
  if (typeof m.chainEvents === 'function') Promise.resolve(m.chainEvents(themeId)).then((response) => {
    const events = Array.isArray(response) ? response : response?.events || []
    const reviewed = new Map(events.filter((event) => event.type === 'signal.reviewed')
      .map((event) => [event.payload?.signalEventId, event.payload]))
    for (const row of reviewStatuses) {
      const decision = reviewed.get(row.result.proposalEventId)?.decision
      if (!decision) continue
      row.result.reviewDecision = decision
      row.status.textContent = decision === 'rejected' ? '已驳回' : '已确认 · 事件已追加'
      row.confirm.disabled = true; row.reject.disabled = true; row.card.classList.add('is-done')
    }
  }).catch(() => {})
  return wrap
}
