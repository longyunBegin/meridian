import '../styles.css'
    import '../demo-theme.css'
    import '../demo-components.css'

    window.__MERIDIAN_TEST_SKIP_BOOT__ = true
    const report = document.querySelector('#fixture-report')
    const results = []
    const check = (name, condition, detail = '') => {
      results.push({ name, pass: Boolean(condition), detail })
      report.textContent = results.map((result) => `${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`).join('\n')
    }
    const waitFor = async (predicate, label, timeout = 5000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (predicate()) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      check(`等待：${label}`, false, '超时')
      return false
    }

    const theme = { id: 'synthetic-intake-theme', name: '隔离合成主题' }
    const emptyTheme = { id: 'synthetic-empty-theme', name: '隔离空主题' }
    let activeThemeId = theme.id
    const emptyEvents = []
    let emptyProjection = {
      nodes: [], allNodes: [], edges: [], allEdges: [], eventCount: 0,
    }
    const events = [{
      id: 'synthetic-seed', seq: 1, at: '2026-09-20T10:00:00.000Z', actor: 'user', type: 'claim.created',
      payload: { title: '合成目标观点', confidence: 60, status: 'pending', sourceRef: 'synthetic:builder-fixture' },
    }]
    const target = {
      id: 'viewpoint-synthetic', nodeType: 'viewpoint', kind: 'claim', title: '合成目标观点',
      detail: '用于隔离 UI 测试的目标节点。', currentText: '用于隔离 UI 测试的目标节点。',
      confidence: 60, status: 'pending', archived: false, external: false, createdSeq: 1,
      eventIds: ['synthetic-seed'], provenanceEventIds: ['synthetic-seed'], evidenceCount: 0,
    }
    let projection = {
      nodes: [target], allNodes: [target], edges: [], allEdges: [], eventCount: 1,
    }
    const inboxItem = {
      id: 'synthetic-inbox-item', title: '隔离合成来源条目', text: '合成摘录：本条仅用于验证摄入、抽取与复核交互，不代表真实来源。',
      createdAt: '2026-09-21T10:00:00.000Z', extracted: false,
      provenance: { platform: 'synthetic-test', sourceLabel: '隔离合成来源', url: 'https://www.reuters.com/fixture/synthetic-builder-source', publishedAt: '2026-09-18', fetchedAt: '2026-09-21T09:55:00.000Z' },
    }
    const commandCalls = []
    const decisions = new Map()
    let generatedPipeline = null
    const reviewEvents = []
    const appendReview = (eventId, decision, input) => {
      const prior = decisions.get(eventId)
      if (prior) return { ok: true, replayed: true, events: [] }
      const appended = []
      let nextSeq = events.at(-1).seq + 1
      const reviewedProposal = generatedPipeline?.results.find((result) => result.proposalEventId === eventId)
      const isNewViewpoint = reviewedProposal?.kind === 'new-proposition'
        || reviewedProposal?.recommendation?.kind === 'new-proposition'
      let createdViewpoint = null
      if (decision === 'accepted' && isNewViewpoint) {
        const viewpointId = `viewpoint-${eventId}`
        const viewpointEvent = {
          id: `event-viewpoint-${eventId}`, seq: nextSeq++, at: new Date('2026-09-22T10:00:00.000Z').toISOString(),
          type: 'node.created', payload: { nodeId: viewpointId, nodeType: 'viewpoint', title: input.title || reviewedProposal.recommendation.title, detail: '已明确确认的合成观点。', status: 'pending' },
        }
        appended.push(viewpointEvent)
        createdViewpoint = {
          id: viewpointId, nodeType: 'viewpoint', kind: 'viewpoint', title: viewpointEvent.payload.title,
          detail: viewpointEvent.payload.detail, currentText: viewpointEvent.payload.detail, status: 'pending',
          archived: false, external: false, createdSeq: viewpointEvent.seq, eventIds: [viewpointEvent.id],
          provenanceEventIds: [viewpointEvent.id], evidenceCount: 0,
        }
      }
      if (decision === 'accepted') {
        const evidenceId = `evidence-${eventId}`
        const evidenceEvent = {
          id: `event-evidence-${eventId}`, seq: nextSeq++, at: new Date('2026-09-22T10:00:00.000Z').toISOString(),
          type: 'evidence.appended', payload: {
            nodeId: evidenceId, title: '已确认合成证据', text: '合成来源的核验摘录。', sourceLabel: '隔离合成来源',
            sourcePublishedAt: '2026-09-18', sourceFetchedAt: inboxItem.provenance.fetchedAt,
            ingestedAt: inboxItem.createdAt, applicability: '2026Q2',
            scores: { matchScore: 0.84, attributionStrength: 0.62, effectiveStrength: 0.51 },
          },
        }
        const relationEvent = {
          id: `event-relation-${eventId}`, seq: nextSeq++, at: new Date('2026-09-22T10:00:01.000Z').toISOString(),
          type: 'relation.declared', payload: { rel: input.rel || 'supports', from: { eventId: evidenceId }, to: { eventId: target.id } },
        }
        appended.push(evidenceEvent, relationEvent)
        const evidenceNode = {
          id: evidenceId, nodeType: 'evidence', kind: 'evidence', title: '已确认合成证据',
          detail: '合成来源的核验摘录。', currentText: '合成来源的核验摘录。', status: 'pending',
          sourceKind: 'engine-reviewed', sourceRef: 'synthetic:builder-fixture', createdSeq: evidenceEvent.seq,
          eventIds: [evidenceEvent.id], provenanceEventIds: [evidenceEvent.id], external: false,
        }
        const relationEdge = {
          id: relationEvent.id, eventId: relationEvent.id, seq: relationEvent.seq,
          from: evidenceId, to: target.id, rel: input.rel || 'supports', relationGroup: 'argument',
          pendingReview: false, reviewDecision: 'accepted',
        }
        projection = {
          ...projection, nodes: [...projection.nodes, ...(createdViewpoint ? [createdViewpoint] : []), evidenceNode],
          allNodes: [...projection.allNodes, ...(createdViewpoint ? [createdViewpoint] : []), evidenceNode],
          edges: [...projection.edges, relationEdge], allEdges: [...projection.allEdges, relationEdge],
        }
      }
      const reviewEvent = {
        id: `event-review-${eventId}`, seq: nextSeq, at: new Date('2026-09-22T10:00:02.000Z').toISOString(),
        type: 'signal.reviewed', payload: { signalEventId: eventId, decision, change: input.change || null, rel: input.rel || null },
      }
      appended.push(reviewEvent)
      events.push(...appended)
      reviewEvents.push(...appended)
      decisions.set(eventId, decision)
      projection = { ...projection, eventCount: events.length }
      return { ok: true, events: appended }
    }

    window.meridian = {
      async chainProjection(themeId) {
        commandCalls.push(['chainProjection', themeId])
        return themeId === emptyTheme.id ? emptyProjection : projection
      },
      async chainEvents(themeId) {
        commandCalls.push(['chainEvents', themeId])
        const rows = themeId === emptyTheme.id ? emptyEvents : events
        return { ok: true, events: [...rows] }
      },
      async chainProjectionAt(themeId, sequence) {
        commandCalls.push(['chainProjectionAt', themeId, sequence])
        if (themeId === emptyTheme.id) return { ...emptyProjection, eventCount: sequence }
        return sequence <= 1
          ? { ...projection, nodes: [target], allNodes: [target], edges: [], allEdges: [], eventCount: sequence }
          : { ...projection, eventCount: sequence }
      },
      async inboxList() { return activeThemeId === emptyTheme.id ? [] : [inboxItem] },
      async inboxExtract(ids, themeId) {
        commandCalls.push(['inboxExtract', ids, themeId])
        inboxItem.extracted = true
        inboxItem.lemmas = [{ type: 'hard', title: '合成指标陈述', value: '合成变化', timeWindow: '2026Q2' }]
        return { ok: true, items: [inboxItem] }
      },
      async inboxSetTheme(id, themeId) {
        commandCalls.push(['inboxSetTheme', id, themeId])
        inboxItem.extractedThemeId = themeId
        return { ok: true, id, themeId }
      },
      async engineRunPipeline(id) {
        commandCalls.push(['engineRunPipeline', id])
        if (inboxItem.extractedThemeId !== theme.id || !String(inboxItem.text || '').trim()) return { ok: false, error: '合成原文或主题映射缺失' }
        generatedPipeline = {
          status: 'done', ranAt: '2026-09-22T09:00:00.000Z',
          statements: [
            { subject: '合成对象', attribute: '指标', value: '合成变化', type: 'hard', timeWindow: '2026Q2', sourceText: '合成来源的核验摘录。', sourceQuoteVerified: true },
            { subject: '合成对象', attribute: '关系', value: '待创建关系观点', type: 'relational', timeWindow: '2026Q2', sourceText: '合成来源的关系摘录。', sourceQuoteVerified: true },
          ],
          results: [
            {
              proposalEventId: 'proposal-synthetic-evidence', kind: 'evidence', statement: { subject: '合成对象', attribute: '指标', value: '合成变化', type: 'hard', timeWindow: '2026Q2', sourceText: '合成来源的核验摘录。', sourceQuoteVerified: true },
              proposition: { id: target.id, title: target.title },
              recommendation: { kind: 'evidence', propositionId: target.id, propositionTitle: target.title, rel: 'supports', strength: 0.62, effectiveStrength: 0.51, matchScore: 0.84, change: { direction: 'stable', nature: 'quantitative', themeTag: '合成指标' } },
            },
            {
              proposalEventId: 'proposal-synthetic-relation', kind: 'new-proposition', suggestedTitle: '模型建议的合成关系观点', statement: { subject: '合成对象', attribute: '关系', value: '待创建关系观点', type: 'relational', timeWindow: '2026Q2', sourceText: '合成来源的关系摘录。', sourceQuoteVerified: true },
              recommendation: { kind: 'new-proposition', title: '模型建议的合成关系观点', rel: 'related', strength: 0.7, change: { direction: 'stable', nature: 'structural', themeTag: '合成关系' } },
            },
            {
              proposalEventId: 'proposal-synthetic-evidence-rejected', kind: 'evidence', statement: { subject: '合成对象', attribute: '指标', value: '待驳回证据', type: 'hard', timeWindow: '2026Q2', sourceText: '用于测试驳回的合成证据。', sourceQuoteVerified: true },
              proposition: { id: target.id, title: target.title },
              recommendation: { kind: 'evidence', propositionId: target.id, propositionTitle: target.title, rel: 'contradicts', strength: 0.42, effectiveStrength: 0.31, matchScore: 0.72, change: { direction: 'declining', nature: 'quantitative', themeTag: '待驳回证据' } },
            },
            {
              proposalEventId: 'proposal-synthetic-viewpoint', kind: 'new-proposition', suggestedTitle: '用户确认的合成观点', statement: { subject: '合成对象', attribute: '关系', value: '用户确认的合成观点', type: 'relational', timeWindow: '2026Q2', sourceText: '用于测试确认观点的合成原文。', sourceQuoteVerified: true },
              recommendation: { kind: 'new-proposition', title: '用户确认的合成观点', rel: 'related', strength: 0.7, change: { direction: 'stable', nature: 'structural', themeTag: '合成观点' } },
            },
          ],
        }
        inboxItem.enginePipeline = generatedPipeline
        for (const result of generatedPipeline.results) events.push({
          id: result.proposalEventId, seq: events.at(-1).seq + 1, at: generatedPipeline.ranAt,
          type: 'engine.recommendation.proposed', payload: { pendingReview: true, recommendationId: result.proposalEventId, inboxId: id },
        })
        projection = { ...projection, eventCount: events.length }
        return { ok: true, pipeline: generatedPipeline }
      },
      async chainReviewEngineRecommendation(themeId, eventId, decision, input) {
        commandCalls.push(['chainReviewEngineRecommendation', themeId, eventId, decision, input])
        return appendReview(eventId, decision, input)
      },
      async chainCreateNode(themeId, input) {
        commandCalls.push(['chainCreateNode', themeId, input])
        if (themeId === emptyTheme.id) {
          const id = 'manual-first-viewpoint-empty-theme'
          const event = {
            id: 'event-empty-first-viewpoint', seq: emptyEvents.length + 1, at: '2026-09-25T10:00:00.000Z',
            type: 'node.created', payload: { ...input, nodeId: id, sourceRef: 'synthetic:empty-topic-manual-create' },
          }
          emptyEvents.push(event)
          const created = {
            id, nodeType: input.nodeType, kind: input.nodeType, title: input.title,
            detail: input.detail, currentText: input.detail, applicability: input.applicability,
            status: input.status, archived: false, external: false, createdSeq: event.seq,
            eventIds: [event.id], provenanceEventIds: [event.id], evidenceCount: 0,
          }
          emptyProjection = {
            ...emptyProjection, nodes: [created], allNodes: [created], eventCount: emptyEvents.length
          }
          return { ok: true, event }
        }
        const id = 'manual-concept-synthetic'
        const event = {
          id: 'event-manual-concept', seq: events.at(-1).seq + 1, at: '2026-09-23T10:00:00.000Z',
          type: 'node.created', payload: { ...input, nodeId: id, sourceRef: 'synthetic:manual-create' },
        }
        events.push(event)
        const created = {
          id, nodeType: input.nodeType, kind: input.nodeType, title: input.title,
          detail: input.detail, currentText: input.detail, applicability: input.applicability,
          status: input.status, archived: false, external: false, createdSeq: event.seq,
          eventIds: [event.id], provenanceEventIds: [event.id], evidenceCount: 0,
        }
        projection = {
          ...projection, nodes: [...projection.nodes, created], allNodes: [...projection.allNodes, created],
          eventCount: events.length,
        }
        return { ok: true, event }
      },
      async chainAddEvidence(themeId, nodeId, input) {
        commandCalls.push(['chainAddEvidence', themeId, nodeId, input])
        const evidenceId = 'manual-evidence-synthetic'
        const evidenceEvent = {
          id: 'event-manual-evidence', seq: events.at(-1).seq + 1, at: '2026-09-24T10:00:00.000Z',
          type: 'evidence.appended', payload: { ...input, nodeId: evidenceId, title: '手工合成证据', ingestedAt: '2026-09-24T10:00:00.000Z' },
        }
        const relationEvent = {
          id: 'event-manual-evidence-relation', seq: evidenceEvent.seq + 1, at: '2026-09-24T10:00:01.000Z',
          type: 'relation.declared', payload: { rel: 'supports', from: { eventId: evidenceId }, to: { eventId: nodeId } },
        }
        events.push(evidenceEvent, relationEvent)
        const evidenceNode = {
          id: evidenceId, nodeType: 'evidence', kind: 'evidence', title: '手工合成证据',
          detail: input.text, currentText: input.text, status: 'pending', sourceKind: 'manual',
          sourceRef: 'synthetic:manual-evidence', createdSeq: evidenceEvent.seq,
          eventIds: [evidenceEvent.id], provenanceEventIds: [evidenceEvent.id], external: false,
        }
        const edge = { id: relationEvent.id, eventId: relationEvent.id, seq: relationEvent.seq, from: evidenceId, to: nodeId, rel: 'supports', relationGroup: 'argument' }
        projection = {
          ...projection, nodes: [...projection.nodes, evidenceNode], allNodes: [...projection.allNodes, evidenceNode],
          edges: [...projection.edges, edge], allEdges: [...projection.allEdges, edge],
          eventCount: events.length,
        }
        return { ok: true, events: [evidenceEvent, relationEvent] }
      },
      async chainMountEvent() { return { ok: true } },
      async chainReviewRelation() { return { ok: true } },
      async chainArchiveNode() { return { ok: true } },
      async chainRestoreNode() { return { ok: true } },
    }

    try {
      const { normalizeBuilderState } = await import('../views/chain.js')
      const { renderTheme } = await import('../views/theme.js')
      const { state } = await import('../app.js')
      const host = document.querySelector('#fixture-root')
      state.themes = [theme, emptyTheme]
      state.themeId = theme.id
      localStorage.setItem(`meridian:theme-view:${theme.id}`, 'builder')
      const themeMount = document.createElement('section')
      activeThemeId = theme.id
      renderTheme(themeMount)
      host.append(themeMount)
      const builderTab = host.querySelector('.theme-view-tab:nth-child(2)')
      builderTab.click()
      await waitFor(() => host.querySelector('.theme-view-host .builder-intake-queue'), '主题建设者标签挂载新工作台')
      check('旧 stream 状态迁移到工作台，首次建设者主舞台就是双栏审核队列而非信号流',
        JSON.stringify(normalizeBuilderState({ mode: 'stream', nodeId: null })) === JSON.stringify({ mode: 'inbox', nodeId: null })
        && host.querySelector('.theme-view-host .builder-intake-queue')
        && host.querySelector('.theme-view-host .builder-intake-review')
        && !host.querySelector('.theme-view-host .stream-head')
        && host.querySelector('.theme-view-host [data-mode="inbox"]')?.classList.contains('active'))
      check('重新进入时历史/节点子页旧状态都回到工作台，只有读者显式定位才打开节点',
        normalizeBuilderState({ mode: 'history' }).mode === 'inbox'
        && normalizeBuilderState({ mode: 'node', nodeId: 'viewpoint-synthetic' }).mode === 'inbox'
        && normalizeBuilderState({ mode: 'stream' }).mode === 'inbox')
      check('建设者导航不再重复展示信号历史入口，旧事件只从账本/来源追溯访问',
        !host.querySelector('.theme-view-host [data-mode="history"]')
        && !host.querySelector('.theme-view-host .side-nav-history')
        && host.querySelector('.theme-view-host [data-mode="inbox"]')?.classList.contains('active'))
      const navLedgerButton = host.querySelector('.theme-view-host button.cog-ledger-open')
      navLedgerButton.click()
      await waitFor(() => {
        const pane = host.querySelector('.theme-view-host .cog-ledger-pane')
        return pane && !pane.hidden && pane.querySelector('.cog-ledger-head')
      }, '事件账本抽屉可打开')
      const ledgerPane = host.querySelector('.theme-view-host .cog-ledger-pane')
      check('历史导航移除后，追加式账本与关闭控件仍可用',
        ledgerPane.getAttribute('role') === 'dialog'
        && ledgerPane.querySelector('.cog-ledger-title')?.textContent.includes('谁在什么时候改了什么')
        && !!ledgerPane.querySelector('.cog-ledger-close'))
      ledgerPane.querySelector('.cog-ledger-close').click()
      await waitFor(() => ledgerPane.hidden, '关闭账本抽屉')
      await waitFor(() => host.querySelector('.theme-view-host .builder-intake-card'), '回到默认工作台并加载合成来源')
      await waitFor(() => host.querySelector('.builder-intake-card'), '合成来源收件箱卡片')
      check('来源摄入区明确无事实变化前提，显示不同来源与摄入时间',
        host.querySelector('.builder-intake-card')?.textContent.includes('来源时间')
        && host.querySelector('.builder-intake-card')?.textContent.includes('系统摄入'))
      check('建设者不以人工表单冒充引擎抽取，来源原文尚未运行前没有模型候选',
        ![...host.querySelectorAll('.builder-intake-card button')].some((button) => button.textContent.includes('抽取原子陈述'))
        && !inboxItem.lemmas?.length && !commandCalls.some((call) => call[0] === 'inboxExtract')
        && !events.some((event) => event.type === 'evidence.appended'))
      const map = [...host.querySelectorAll('.builder-intake-card button')].find((button) => button.textContent.includes('映射到'))
      map.click()
      await waitFor(() => inboxItem.extractedThemeId === theme.id && host.textContent.includes('已映射到当前主题'), '主题映射状态')
      check('映射阶段只更新收件箱归属，尚未写入观点或关系', inboxItem.extractedThemeId === theme.id
        && projection.nodes.length === 1 && !events.some((event) => ['evidence.appended', 'relation.declared'].includes(event.type)))
      const generate = [...host.querySelectorAll('.builder-intake-card button')].find((button) => button.textContent.includes('运行模型抽取与映射'))
      check('已映射来源以其真实原文启用配置引擎入口', !!generate && !generate.disabled
        && host.querySelector('.engine-pipe')?.textContent.includes('模型只提出建议'))
      generate.click()
      await waitFor(() => host.querySelectorAll('.builder-queue-item').length === 4
        && host.querySelectorAll('.engine-attr').length === 1, '两条建议进入队列并显示选中建议')
      check('configured engine 自动抽取并映射候选；用户审核前只追加建议事件',
        commandCalls.filter((call) => call[0] === 'engineRunPipeline').length === 1
        && generatedPipeline?.status === 'done'
        && events.filter((event) => event.type === 'engine.recommendation.proposed').length === generatedPipeline.results.length
        && !events.some((event) => ['evidence.appended', 'relation.declared'].includes(event.type)))
      check('建设者采用待处理/已处理双栏队列，所有建议可逐项选择而非被截断',
        host.querySelector('.builder-intake-queue') && host.querySelector('.builder-intake-review')
        && host.querySelectorAll('.builder-queue-item').length === 4)
      const historyPrefixBeforeReview = events.map((event) => event.id)
      check('建议阶段显示变更前后预览、已核验原文和人工确认/驳回，不提前改投影',
        host.textContent.includes('确认前 · 当前模型') && host.textContent.includes('确认后 · 建议投影')
        && host.querySelector('.engine-review-quote')?.textContent.includes('合成来源的核验摘录')
        && [...host.querySelectorAll('.engine-attr button')].some((button) => button.textContent.includes('确认并追加'))
        && [...host.querySelectorAll('.engine-attr button')].some((button) => button.textContent.includes('驳回建议'))
        && projection.nodes.length === 1 && !events.some((event) => event.type === 'evidence.appended'))
      const newProposalRow = [...host.querySelectorAll('.builder-queue-item')].find((button) => button.textContent.includes('模型建议'))
      newProposalRow.click()
      await waitFor(() => host.querySelector('.engine-review-title'), '选中新观点建议')
      const relationCard = [...host.querySelectorAll('.engine-attr')].find((card) => card.querySelector('.engine-review-title'))
      const titleInput = relationCard.querySelector('.engine-review-title')
      titleInput.value = '用户命名的合成观点'
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      check('新观点变更后预览随用户编辑实时更新', relationCard.querySelector('.engine-preview-column.is-after')?.textContent.includes('用户命名的合成观点'))
      const evidenceRow = host.querySelector('.builder-queue-item[data-entry-id="proposal:proposal-synthetic-evidence"]')
      evidenceRow.click()
      await waitFor(() => host.querySelector('.engine-review-select'), '重新选中证据映射建议')
      const evidenceCard = host.querySelector('.engine-attr')
      evidenceCard.querySelector('.engine-review-select').value = 'contradicts'
      evidenceCard.querySelector('.engine-review-select').dispatchEvent(new Event('change', { bubbles: true }))
      check('关系修正反映在确认后预览，而不是提前写入', evidenceCard.querySelector('.engine-preview-column.is-after')?.textContent.includes('反驳')
        && !events.some((event) => event.type === 'relation.declared'))
      evidenceCard.querySelector('.engine-review-select').value = 'supports'
      evidenceCard.querySelector('.engine-review-select').dispatchEvent(new Event('change', { bubbles: true }))
      ;[...evidenceCard.querySelectorAll('button')].find((button) => button.textContent.includes('确认并追加')).click()
      await waitFor(() => events.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-evidence'), '确认事件写入与投影刷新')
      await waitFor(() => host.querySelector('.builder-intake-card')?.textContent.includes('已确认'), '建设者复核状态恢复')
      check('用户确认后审核 bridge 追加证据/关系/决定并刷新投影，仍留在收件箱工作流',
        decisions.get('proposal-synthetic-evidence') === 'accepted'
        && events.some((event) => event.type === 'evidence.appended')
        && events.some((event) => event.type === 'relation.declared')
        && projection.nodes.length === 2 && projection.edges.length === 1
        && host.querySelector('.builder-queue-tab[aria-pressed="true"]')?.textContent.includes('已处理')
        && host.querySelector('.side-nav-item[data-mode="inbox"]')?.classList.contains('active'))
      const confirmedReview = await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-evidence', 'accepted', {
        change: { direction: 'stable', nature: 'quantitative', themeTag: '合成指标' }, rel: 'supports',
      })
      check('相同审核决定重试由命令幂等复用，不增加第二个决定事件', confirmedReview.replayed === true
        && events.filter((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-evidence').length === 1)
      await waitFor(() => host.querySelectorAll('.builder-queue-item').length === 1, '确认项显示在已处理队列')
      check('确认后项目进入已处理队列并可与待处理队列切换',
        host.querySelector('.builder-queue-tab[aria-pressed="true"]')?.textContent.includes('已处理')
        && host.querySelector('.builder-queue-item')?.getAttribute('data-entry-id') === 'proposal:proposal-synthetic-evidence')
      ;[...host.querySelectorAll('.builder-queue-tab')].find((button) => button.textContent.includes('待处理')).click()
      const pendingNewProposal = [...host.querySelectorAll('.builder-queue-item')].find((button) => button.textContent.includes('模型建议'))
      pendingNewProposal.click()
      await waitFor(() => host.querySelector('.engine-review-title'), '切换回待处理并选中新观点建议')
      const refreshedRelationCard = [...host.querySelectorAll('.engine-attr')].find((card) => card.querySelector('.engine-review-title'))
      ;[...refreshedRelationCard.querySelectorAll('button')].find((button) => button.textContent.includes('驳回建议')).click()
      await waitFor(() => events.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-relation'), '驳回决定事件写入')
      await waitFor(() => host.querySelector('.builder-queue-tab[aria-pressed="true"]')?.textContent.includes('已处理')
        && host.querySelector('.builder-queue-item[data-entry-id="proposal:proposal-synthetic-relation"]'), '驳回项刷新到已处理队列')
      check('用户驳回追加决定事件但不创建该建议命题；真实命令闭环另由集成测试验证幂等',
        decisions.get('proposal-synthetic-relation') === 'rejected'
        && !events.some((event) => event.type === 'node.created' && event.payload.title === '模型建议的合成关系观点')
        && !projection.nodes.some((node) => node.title === '模型建议的合成关系观点')
        && events.filter((event) => event.type === 'signal.reviewed').length === 2
        && commandCalls.filter((call) => call[0] === 'engineRunPipeline').length === 1)
      ;[...host.querySelectorAll('.builder-queue-tab')].find((button) => button.textContent.includes('待处理')).click()
      const rejectedEvidenceRow = host.querySelector('.builder-queue-item[data-entry-id="proposal:proposal-synthetic-evidence-rejected"]')
      rejectedEvidenceRow.click()
      await waitFor(() => host.querySelector('.engine-review-quote')?.textContent.includes('用于测试驳回的合成证据'), '选中待驳回证据建议')
      const rejectedEvidenceCard = host.querySelector('.engine-attr')
      ;[...rejectedEvidenceCard.querySelectorAll('button')].find((button) => button.textContent.includes('驳回建议')).click()
      await waitFor(() => decisions.get('proposal-synthetic-evidence-rejected') === 'rejected', '证据建议驳回事件写入')
      await waitFor(() => host.querySelector('.builder-queue-tab[aria-pressed="true"]')?.textContent.includes('已处理')
        && host.querySelector('.builder-queue-item[data-entry-id="proposal:proposal-synthetic-evidence-rejected"]'), '证据驳回刷新到已处理队列')
      check('证据驳回只追加决定，不创建证据节点或关系',
        decisions.get('proposal-synthetic-evidence-rejected') === 'rejected'
        && !events.some((event) => event.type === 'evidence.appended' && event.payload.title === '已确认合成证据' && event.payload.sourceRef === 'proposal-synthetic-evidence-rejected')
        && projection.nodes.filter((node) => node.nodeType === 'evidence').length === 1
        && projection.edges.length === 1)
      ;[...host.querySelectorAll('.builder-queue-tab')].find((button) => button.textContent.includes('待处理')).click()
      const acceptedViewpointRow = host.querySelector('.builder-queue-item[data-entry-id="proposal:proposal-synthetic-viewpoint"]')
      acceptedViewpointRow.click()
      await waitFor(() => host.querySelector('.engine-review-title')?.value === '用户确认的合成观点', '选中新观点建议')
      const viewpointCard = host.querySelector('.engine-attr')
      ;[...viewpointCard.querySelectorAll('button')].find((button) => button.textContent.includes('确认并追加')).click()
      await waitFor(() => events.some((event) => event.type === 'node.created' && event.payload.nodeId === 'viewpoint-proposal-synthetic-viewpoint'), '确认观点后追加节点事件')
      await waitFor(() => host.querySelector('.builder-queue-tab[aria-pressed="true"]')?.textContent.includes('已处理'), '审核结果刷新到已处理队列')
      check('观点确认追加节点事件并进入投影，观点拒绝不创建节点，所有四种结果可回放',
        decisions.get('proposal-synthetic-viewpoint') === 'accepted'
        && projection.nodes.some((node) => node.id === 'viewpoint-proposal-synthetic-viewpoint' && node.nodeType === 'viewpoint')
        && events.filter((event) => event.type === 'signal.reviewed').length === 4
        && events.some((event) => event.type === 'node.created' && event.payload.nodeId === 'viewpoint-proposal-synthetic-viewpoint')
        && !projection.nodes.some((node) => node.title === '用户命名的合成观点'))
      await waitFor(() => host.querySelectorAll('.builder-queue-item').length === 4, '四条审核记录出现在已处理队列')
      check('待处理/已处理过滤稳定切换，四条明确审核决定落入已处理队列',
        host.querySelector('.builder-queue-tab[aria-pressed="true"]')?.textContent.includes('已处理')
        && host.querySelectorAll('.builder-queue-item').length === 4)
      ;[...host.querySelectorAll('.builder-queue-tab')].find((button) => button.textContent.includes('待处理')).click()
      check('全部审核完成后待处理队列为空且不会自动生成事实',
        host.querySelector('.builder-queue-empty') && host.querySelectorAll('.builder-queue-item').length === 0)
      ;[...host.querySelectorAll('.builder-queue-tab')].find((button) => button.textContent.includes('已处理')).click()
      const uniqueEventIds = new Set(events.map((event) => event.id))
      check('账本 append-only：原事件前缀不变、序号严格递增且事件 ID 不重复',
        historyPrefixBeforeReview.every((id, index) => events[index]?.id === id)
        && uniqueEventIds.size === events.length
        && events.every((event, index) => index === 0 || event.seq > events[index - 1].seq))
      const ledgerButton = host.querySelector('.cog-ledger-open')
      ledgerButton.click()
      await waitFor(() => !host.querySelector('.cog-ledger-drawer').hidden
        && host.querySelector('.cog-ledger-list .cog-ev[data-event-id="synthetic-seed"]'), '打开账本抽屉并显示追加事件')
      const ledgerDrawer = host.querySelector('.cog-ledger-drawer')
      const hiddenInClosedDetails = (element) => {
        let parent = element.parentElement
        while (parent) {
          if (parent.tagName === 'DETAILS' && !parent.open
            && !(element.tagName === 'SUMMARY' && element.parentElement === parent)) return true
          parent = parent.parentElement
        }
        return false
      }
      const ledgerFocusables = [...ledgerDrawer.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary')]
        .filter((element) => !element.hidden && getComputedStyle(element).display !== 'none' && !hiddenInClosedDetails(element))
      const trapEvent = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      ledgerDrawer.querySelector('.cog-ledger-close').focus()
      ledgerDrawer.dispatchEvent(trapEvent)
      const focusDescription = (element) => element?.getAttribute('aria-label') || element?.textContent?.trim().slice(0, 32) || element?.tagName || 'none'
      check('账本抽屉键盘焦点循环与 Escape 关闭/焦点归还可用',
        trapEvent.defaultPrevented && document.activeElement === ledgerFocusables.at(-1)
        && ledgerButton.getAttribute('aria-expanded') === 'true',
        `prevented=${trapEvent.defaultPrevented}; active=${focusDescription(document.activeElement)}; last=${focusDescription(ledgerFocusables.at(-1))}`)
      ledgerDrawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      check('Escape 关闭账本抽屉并将焦点归还触发按钮',
        ledgerDrawer.hidden && ledgerButton.getAttribute('aria-expanded') === 'false' && document.activeElement === ledgerButton)
      host.querySelector('.builder-queue-add').click()
      await waitFor(() => document.querySelector('.cog-entry-dialog'), '打开手工节点创建表单')
      const nodeDialog = document.querySelector('.cog-entry-dialog')
      nodeDialog.querySelector('[aria-label="节点类型"]').value = 'concept'
      nodeDialog.querySelector('[aria-label="节点名称"]').value = '手工合成概念'
      nodeDialog.querySelector('[aria-label="节点说明"]').value = '只用于验证显式节点录入。'
      nodeDialog.querySelector('[aria-label="适用时间"]').value = '2026Q3'
      nodeDialog.querySelector('button[type="submit"]').click()
      await waitFor(() => commandCalls.some((call) => call[0] === 'chainCreateNode')
        && !document.querySelector('.cog-entry-dialog'), '追加手工节点并关闭表单')
      const nodeCall = commandCalls.find((call) => call[0] === 'chainCreateNode')
      check('手工节点表单把显式类型/名称/说明/适用时间送到追加命令，不造证据事件',
        nodeCall?.[2]?.nodeType === 'concept' && nodeCall[2].title === '手工合成概念'
        && nodeCall[2].detail === '只用于验证显式节点录入。' && nodeCall[2].applicability === '2026Q3'
        && events.some((event) => event.type === 'node.created' && event.payload.nodeId === 'manual-concept-synthetic')
        && !events.some((event) => event.type === 'evidence.appended' && event.payload.nodeId === 'manual-concept-synthetic'))
      const addEvidence = [...host.querySelectorAll('.cog-global-toolbar button')].find((button) => button.textContent.includes('补充证据'))
      addEvidence.click()
      await waitFor(() => document.querySelector('.cog-entry-dialog'), '打开手工证据来源表单')
      const evidenceDialog = document.querySelector('.cog-entry-dialog')
      evidenceDialog.querySelector('[aria-label="要关联到的非证据节点"]').value = target.id
      evidenceDialog.querySelector('[aria-label="证据摘要或原文摘录"]').value = '手工输入的合成来源摘录。'
      evidenceDialog.querySelector('[aria-label="来源名称"]').value = '隔离手工来源'
      evidenceDialog.querySelector('[aria-label="来源链接"]').value = 'https://www.reuters.com/fixture/manual-source'
      evidenceDialog.querySelector('[aria-label="来源发布时间"]').value = '2026-09-12'
      evidenceDialog.querySelector('[aria-label="适用时间"]').value = '2026Q3'
      evidenceDialog.querySelector('button[type="submit"]').click()
      await waitFor(() => commandCalls.some((call) => call[0] === 'chainAddEvidence')
        && !document.querySelector('.cog-entry-dialog'), '追加手工证据并关闭表单')
      const evidenceCall = commandCalls.find((call) => call[0] === 'chainAddEvidence')
      check('手工证据表单分开传来源发布时间与适用时间，不允许输入摄入/抓取系统时间',
        evidenceCall?.[2] === target.id && evidenceCall?.[3]?.sourcePublishedAt === '2026-09-12'
        && evidenceCall[3].applicability === '2026Q3' && evidenceCall[3].sourceLabel === '隔离手工来源'
        && !('ingestedAt' in evidenceCall[3]) && !('sourceFetchedAt' in evidenceCall[3])
        && events.some((event) => event.type === 'evidence.appended' && event.payload.ingestedAt === '2026-09-24T10:00:00.000Z'))
      const liveEventCount = events.length
      const readerTab = themeMount.querySelector('.theme-view-tab')
      readerTab.click()
      /* 用户决定：读者页不要时间回放、也不要全节点关系图——两者已连代码一并删除。
         这里改为断言"回放块不存在"，并把"选节点"改走观点卡片（图下线后的等价路径）。 */
      await waitFor(() => themeMount.querySelector('.theme-view-host .rdr-brief'), '主题读者视图挂载')
      check('读者页不再展示时间回放（播放 / 与当前对比 / 返回当前模型）',
        !themeMount.querySelector('.rdr-replay-details') && events.length === liveEventCount)
      const readerNode = themeMount.querySelector(`.rdr-multiple-card[data-atom-id="${target.id}"]`)
      readerNode.click()
      await waitFor(() => themeMount.querySelector('.rdr-node-identity button'), '点读者观点卡片后出现建设者定位入口')
      check('读者观点卡片可选中同一节点并显示其建设者定位入口',
        readerNode.classList.contains('is-selected')
        && themeMount.querySelector('.rdr-node-identity button')?.textContent.includes('在建设者视图定位'))
      const readerSourceEvent = themeMount.querySelector('.rdr-evidence-list .rdr-event-link')
      check('Reader 证据详情提供可达的来源事件入口', !!readerSourceEvent)
      if (readerSourceEvent) {
        readerSourceEvent.click()
        const expectedSourceEventId = 'event-evidence-proposal-synthetic-evidence'
        await waitFor(() => {
          const drawer = themeMount.querySelector('.theme-view-host .cog-ledger-drawer')
          return drawer && !drawer.hidden && drawer.querySelector(`[data-event-id="${expectedSourceEventId}"]`)
        }, 'Reader 来源事件跳转到对应账本行')
        const sourceLedger = themeMount.querySelector('.theme-view-host .cog-ledger-drawer')
        check('Reader 来源事件保留 eventId，打开追加账本并定位同一条校验前缀记录',
          !sourceLedger.hidden
          && sourceLedger.querySelector(`[data-event-id="${expectedSourceEventId}"]`)
          && document.activeElement?.getAttribute('data-event-id') === expectedSourceEventId)
        sourceLedger.querySelector('.cog-ledger-close').click()
        await waitFor(() => sourceLedger.hidden, '关闭 Reader 来源事件账本')
        themeMount.querySelector('.theme-view-tab').click()
        await waitFor(() => themeMount.querySelector('.theme-view-host .rdr-root'), '返回 Reader 继续节点定位验证')
        await waitFor(() => themeMount.querySelector(`.rdr-multiple-card[data-atom-id="${target.id}"]`), 'Reader 来源回程数据加载')
        themeMount.querySelector(`.rdr-multiple-card[data-atom-id="${target.id}"]`).click()
        await waitFor(() => themeMount.querySelector('.rdr-node-identity button'), '恢复 Reader 节点定位按钮')
      }
      themeMount.querySelector('.rdr-node-identity button').click()
      await waitFor(() => themeMount.querySelector('.theme-view-host .node-view-head'), '从读者定位返回建设者节点页')
      check('读者定位回到同一节点，且侧栏主入口仍指向待处理工作台',
        themeMount.querySelector('.node-title')?.textContent === target.title
        && themeMount.querySelector('[data-mode="inbox"]')?.classList.contains('active')
        && !themeMount.querySelector('.stream-head'))
      themeMount.querySelector('.back-btn').click()
      await waitFor(() => themeMount.querySelector('.theme-view-host .builder-intake-queue'), '节点返回建设者主工作台')
      check('节点返回路径回到新版待处理工作台而非旧信号流',
        !!themeMount.querySelector('.theme-view-host .builder-intake-review')
        && !themeMount.querySelector('.theme-view-host .stream-head'))
      const viewSwitch = themeMount.querySelector('.theme-view-switch')
      viewSwitch.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      await waitFor(() => themeMount.querySelector('.theme-view-host .rdr-root'), '键盘切换到读者视图')
      viewSwitch.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await waitFor(() => themeMount.querySelector('.theme-view-host .builder-intake-queue'), '键盘返回建设者工作台')
      check('读者/建设者标签支持方向键往返并保持工作台作为建设者落点',
        themeMount.querySelector('.theme-view-tab[aria-selected="true"]')?.textContent.includes('建设者')
        && !themeMount.querySelector('.theme-view-host .stream-head'))
      const reopenedTheme = document.createElement('section')
      activeThemeId = theme.id
      state.themeId = theme.id
      renderTheme(reopenedTheme)
      host.append(reopenedTheme)
      await waitFor(() => reopenedTheme.querySelector('.theme-view-host .builder-intake-queue'), '重新打开主题并恢复建设者工作台')
      check('重新进入主题后建设者标签仍默认挂载工作台，不恢复旧信号流',
        !!reopenedTheme.querySelector('.theme-view-host .builder-intake-review')
        && !reopenedTheme.querySelector('.theme-view-host .stream-head'))

      const emptyThemeMount = document.createElement('section')
      activeThemeId = emptyTheme.id
      state.themeId = emptyTheme.id
      localStorage.setItem(`meridian:theme-view:${emptyTheme.id}`, 'builder')
      renderTheme(emptyThemeMount)
      host.append(emptyThemeMount)
      emptyThemeMount.querySelector('.theme-view-tab:nth-child(2)').click()
      await waitFor(() => emptyThemeMount.querySelector('.theme-view-host .builder-intake-queue'), '空主题建设者工作台')
      await waitFor(() => emptyThemeMount.querySelector('.builder-queue-empty'), '空主题的待处理队列空态')
      check('新主题首屏是真实空投影，无自动观点、证据或虚构来源',
        emptyEvents.length === 0 && emptyProjection.nodes.length === 0
        && emptyThemeMount.querySelectorAll('.builder-queue-item').length === 0
        && emptyThemeMount.querySelector('.builder-queue-empty'))
      const firstViewpointButton = emptyThemeMount.querySelector('.builder-queue-add')
      check('新主题“手工添加观点”入口真实可用而非禁用', firstViewpointButton && !firstViewpointButton.disabled)
      firstViewpointButton.click()
      await waitFor(() => document.querySelector('.cog-entry-dialog'), '打开空主题第一条观点表单')
      const firstViewpointDialog = document.querySelector('.cog-entry-dialog')
      check('第一条手工记录默认类型为观点，未暗中预填事实内容',
        firstViewpointDialog.querySelector('[aria-label="节点类型"]').value === 'viewpoint'
        && !firstViewpointDialog.querySelector('[aria-label="节点名称"]').value
        && !firstViewpointDialog.querySelector('[aria-label="节点说明"]').value)
      firstViewpointDialog.querySelector('[aria-label="节点名称"]').value = '用户手工写下的首条观察'
      firstViewpointDialog.querySelector('[aria-label="节点说明"]').value = '这是隔离 fixture 中明确输入的合成观察。'
      firstViewpointDialog.querySelector('[aria-label="适用时间"]').value = '2026Q3'
      firstViewpointDialog.querySelector('button[type="submit"]').click()
      await waitFor(() => emptyEvents.length === 1 && !document.querySelector('.cog-entry-dialog'), '追加空主题首个手工观点')
      check('手工首条观点通过真实追加写入入口创建；未自动制造证据/关系或事实',
        emptyEvents[0].type === 'node.created'
        && emptyEvents[0].payload.nodeType === 'viewpoint'
        && emptyEvents[0].payload.title === '用户手工写下的首条观察'
        && emptyProjection.nodes.length === 1 && emptyProjection.nodes[0].nodeType === 'viewpoint'
        && !emptyEvents.some((event) => ['evidence.appended', 'relation.declared'].includes(event.type)))
      const firstEvidenceAction = [...emptyThemeMount.querySelectorAll('.cog-global-toolbar button')]
        .find((button) => button.textContent.includes('补充证据'))
      await waitFor(() => firstEvidenceAction && !firstEvidenceAction.disabled, '首条观点追加后刷新并启用证据入口')
      check('初始预载投影只用于首次挂载；追加观点后建设者重新读取账本并启用补充证据',
        !firstEvidenceAction.disabled
        && firstEvidenceAction.title === ''
        && emptyThemeMount.querySelector('[data-cog-counts]')?.textContent.includes('观点 1'))
      firstEvidenceAction.click()
      await waitFor(() => document.querySelector('.cog-entry-dialog'), '打开首条观点对应的补充证据表单')
      const firstEvidenceDialog = document.querySelector('.cog-entry-dialog')
      check('补充证据表单关联到刚刚创建的合成观点',
        firstEvidenceDialog.querySelector('[aria-label="要关联到的非证据节点"]')?.value === 'manual-first-viewpoint-empty-theme')
      firstEvidenceDialog.querySelector('[aria-label="关闭"]').click()
      await waitFor(() => !document.querySelector('.cog-entry-dialog'), '取消补充证据表单')
      emptyThemeMount.querySelector('.theme-view-tab').click()
      await waitFor(() => emptyThemeMount.querySelector('.rdr-builder-link'), '空主题读者视图')
      emptyThemeMount.querySelector('.rdr-builder-link').click()
      await waitFor(() => emptyThemeMount.querySelector('.theme-view-host .builder-intake-queue'), '从读者主题返回建设者')
      check('空主题 reader → builder 返回同一新工作台，不落回信号流',
        !!emptyThemeMount.querySelector('.theme-view-host .builder-intake-review')
        && !emptyThemeMount.querySelector('.theme-view-host .stream-head'))
      document.body.dataset.fixture = results.every((row) => row.pass) ? 'pass' : 'fail'
      report.textContent = `RESULT (${results.filter((row) => row.pass).length}/${results.length})\n${results.map((row) => `${row.pass ? 'PASS' : 'FAIL'}: ${row.name}${row.detail ? ` — ${row.detail}` : ''}`).join('\n')}`
    } catch (error) {
      check('fixture 执行无未捕获异常', false, error?.stack || String(error))
      document.body.dataset.fixture = 'fail'
    }
