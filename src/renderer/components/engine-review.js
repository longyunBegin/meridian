import { h, toast } from '../lib/dom.js'

export function renderEnginePipeline(item, { themeId, onDone, projection = {} } = {}) {
  const m = globalThis.window?.meridian || {}
  const wrap = h('div', { class: 'engine-pipe' },
    h('div', { class: 'draft-head' }, h('span', { class: 'draft-title' }, '摄入 → 抽取 → 映射 → 人工审核'),
      h('span', { class: 'draft-sub' }, '建议只读预览；确认或驳回后才追加决定事件')))
  const pipeline = item.enginePipeline
  const runButton = (label, callback) => {
    const button = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, label)
    button.addEventListener('click', callback)
    return button
  }
  if (!pipeline || pipeline.status !== 'done') {
    const sourceText = String(item.text || '').trim()
    const hint = h('p', { class: 'chain-note' }, sourceText
      ? '运行已配置的模型来抽取原子陈述、映射候选关系并生成变更前后预览。模型只提出建议；确认或驳回前不会修改主题投影。未配置模型或运行失败时会显示实际错误。'
      : '此来源没有保存可供分析的正文。请重新接入原文或摘录；仅凭标题或 URL 不会伪造抽取结果。')
    const error = h('p', { class: 'cog-entry-error', role: 'alert', hidden: true })
    const button = runButton('运行模型抽取与映射', async () => {
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
    })
    button.disabled = !sourceText
    wrap.append(hint, h('div', { class: 'draft-actions' }, button), error)
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
    const targetNode = (projection?.allNodes || projection?.nodes || []).find((node) =>
      node.id === (suggestion.propositionId || result.proposition?.id))
    const relation = changeOptions(['supports', 'contradicts', 'derives', 'supersedes', 'related'], suggestion.rel || attribution.rel,
      relLabel)
    const direction = changeOptions(['improving', 'declining', 'stable'], suggestion.change?.direction || attribution.change?.direction,
      { improving: '好转', declining: '承压', stable: '稳定' })
    const nature = changeOptions(['quantitative', 'pivot', 'epistemic', 'structural'], suggestion.change?.nature || attribution.change?.nature,
      { quantitative: '量变', pivot: '质变', epistemic: '认识变化', structural: '结构变化' })
    const themeTag = h('input', { class: 'engine-review-tag', type: 'text', maxlength: '20', value: suggestion.change?.themeTag || attribution.change?.themeTag || statement.attribute || '待复核', 'aria-label': '变化标签' })
    const titleInput = isNew ? h('input', { class: 'engine-review-title', type: 'text', maxlength: '180', value: suggestion.title || result.suggestedTitle || '', 'aria-label': '新观点标题' }) : null
    const quoteVerified = statement.sourceQuoteVerified === true
    const warning = !quoteVerified
      ? h('p', { class: 'engine-review-warning', role: 'alert' }, '来源摘录未能与原文核验；为避免把模型编造内容写入账本，本条不能直接确认。')
      : result.requiresTemporalReview || result.match?.requiresTemporalReview
        ? h('p', { class: 'engine-review-warning' }, '原文未注明时间窗口；仅语义/主体作为候选，确认前请核对时间适用性。')
        : null
    const quote = h('blockquote', { class: 'engine-review-quote' }, statement.sourceText || '（缺少来源摘录）')
    const beforeText = isNew
      ? '当前投影中尚未创建这条建议命题。'
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
    titleInput?.addEventListener('input', updateAfterPreview)
    relation.addEventListener('change', updateAfterPreview)
    const preview = h('section', { class: 'engine-before-after', 'aria-label': '变更前后预览' },
      h('div', { class: 'engine-preview-column is-before' }, h('strong', {}, '确认前 · 当前模型'), h('p', {}, beforeText)),
      h('div', { class: 'engine-preview-arrow', 'aria-hidden': 'true' }, '→'),
      h('div', { class: 'engine-preview-column is-after' }, h('strong', {}, '确认后 · 建议投影'), afterPreviewText),
      h('p', { class: 'engine-preview-note' }, '此处为预览。确认前不会写入事实或关系；决定后以追加事件更新投影。'))
    const status = h('span', { class: 'engine-review-status', role: 'status' })
    const confirm = runButton('确认并追加', async () => {
      confirm.disabled = true; reject.disabled = true
      try {
        const input = { change: { direction: direction.value, nature: nature.value, themeTag: themeTag.value.trim() } }
        if (isNew) input.title = titleInput.value.trim()
        else input.rel = relation.value
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
    const card = h('li', { class: 'engine-attr' },
      h('div', { class: 'engine-attr-main' },
        kindLabel,
        h('span', { class: 'engine-attr-prop' }, isNew ? (suggestion.title || result.suggestedTitle || '待命名观点') : (suggestion.propositionTitle || result.proposition?.title || '待选择观点')),
        status),
      h('div', { class: 'engine-attr-reason' }, suggestion.reason || attribution.reason || ''),
      h('div', { class: 'engine-attr-sub' }, h('span', {}, `归因把握 ${(Number(suggestion.strength ?? attribution.strength) * 100).toFixed(0)}%`),
        Number.isFinite(suggestion.effectiveStrength) && ['supports', 'contradicts'].includes(suggestion.rel)
          ? h('span', { class: 'engine-attr-strength' }, `置信度更新强度 ${(suggestion.effectiveStrength * 100).toFixed(0)}%`) : null,
        Number.isFinite(suggestion.matchScore) ? h('span', {}, `匹配 ${(suggestion.matchScore * 100).toFixed(0)}%`) : null),
      quote, warning, preview,
      isNew ? h('label', { class: 'engine-review-field' }, '建议新观点', titleInput) : h('label', { class: 'engine-review-field' }, '关系类型', relation),
      h('div', { class: 'engine-review-controls' },
        h('label', { class: 'engine-review-field' }, '方向', direction),
        h('label', { class: 'engine-review-field' }, '性质', nature),
        h('label', { class: 'engine-review-field' }, '标签', themeTag)),
      h('div', { class: 'draft-actions' }, confirm, reject))
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
