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
      sourceRef: 'lemma:synthetic-lemma',
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
      if ((decision === 'accepted' || decision === 'corrected') && isNewViewpoint) {
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
      if (decision === 'accepted' || decision === 'corrected') {
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
      if (inboxItem.enginePipeline?.results) {
        for (const result of inboxItem.enginePipeline.results) {
          if (result.proposalEventId === eventId) result.reviewDecision = decision
        }
      }
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
          type: 'engine.recommendation.proposed',
          payload: {
            pendingReview: true,
            recommendationId: result.proposalEventId,
            inboxId: id,
            sourceLabel: '隔离合成来源',
            sourceUrl: inboxItem.provenance.url,
            sourcePublishedAt: inboxItem.provenance.publishedAt,
            sourceFetchedAt: inboxItem.provenance.fetchedAt,
            ingestedAt: inboxItem.createdAt,
            statement: result.statement,
            recommendation: result.recommendation,
          },
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
      async chainParkNode() { return { ok: true } },
      async chainUnparkNode() { return { ok: true } },
      async chainParked() { return { themeId: theme.id, nodes: [], edges: [] } },
      async chainShelfJudgeItem() { return { ok: true, mode: 'park' } },
      async getNode(id) {
        if (id === 'synthetic-lemma') {
          return { id: 'synthetic-lemma', kind: 'lemma', title: '合成目标观点', status: 'live', confidence: 60 }
        }
        return null
      },
      async updateNode(id, patch) {
        commandCalls.push(['updateNode', id, patch])
        return { ok: true, id, ...patch }
      },
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
      check('建设者待处理栏不再挂主题原子轨（归档/冷冻在判卡底部）',
        !host.querySelector('.theme-view-host .builder-atom-rail')
        && !!host.querySelector('.theme-view-host .builder-intake-queue'))
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
      const sourceRow = () => host.querySelector('.theme-view-host .builder-queue-item-v2[data-entry-id="source:synthetic-inbox-item"]')
        || [...host.querySelectorAll('.theme-view-host .builder-queue-item-v2')].find((button) => button.textContent.includes('隔离合成来源'))
      await waitFor(() => sourceRow(), '回到默认工作台并加载合成来源')
      sourceRow()?.click()
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
        && host.querySelector('.engine-pipe-v2, .engine-pipe')?.textContent.includes('模型只提出建议'))
      generate.click()
      await waitFor(() => commandCalls.some((call) => call[0] === 'engineRunPipeline')
        && events.filter((event) => event.type === 'engine.recommendation.proposed').length >= 4
        && host.querySelectorAll('.builder-queue-item-v2').length >= 2, '建议进入队列')
      check('configured engine 自动抽取并映射候选；用户审核前只追加建议事件',
        commandCalls.filter((call) => call[0] === 'engineRunPipeline').length === 1
        && generatedPipeline?.status === 'done'
        && events.filter((event) => event.type === 'engine.recommendation.proposed').length === generatedPipeline.results.length
        && !events.some((event) => ['evidence.appended', 'relation.declared'].includes(event.type)))
      check('建设者采用待处理/已处理双栏队列，所有建议可逐项选择而非被截断',
        host.querySelector('.builder-intake-queue') && host.querySelector('.builder-intake-review')
        && host.querySelectorAll('.builder-queue-item-v2').length >= 2)
      const historyPrefixBeforeReview = events.map((event) => event.id)
      const queueRow = (idOrText) => host.querySelector(`.builder-queue-item-v2[data-entry-id="${idOrText}"]`)
        || [...host.querySelectorAll('.builder-queue-item-v2')].find((button) => button.textContent.includes(idOrText))
      const clickTab = (label) => [...host.querySelectorAll('.builder-queue-tab')].find((button) => button.textContent.includes(label))?.click()
      /* 表态建议进「待判」判卡；新原子建议进「改结构」复核卡。先判第一条证据建议。 */
      await waitFor(() => host.querySelector('.judge-card, .engine-attr'), '队列选中项进入审阅区')
      const evidenceJudge = queueRow('judge:proposal:proposal-synthetic-evidence') || queueRow('合成来源的核验摘录')
      evidenceJudge?.click()
      await waitFor(() => host.querySelector('.judge-card .judge-btn.is-supports'), '证据建议显示判卡')
      check('建议阶段判卡给出佐证/反对与建议原子，确认前不改投影',
        host.querySelector('.judge-card')?.textContent.includes('模型建议')
        && host.querySelector('.judge-atom')?.value === 'viewpoint-synthetic'
        && projection.nodes.length === 1 && !events.some((event) => event.type === 'evidence.appended'))
      const supportsBtn = host.querySelector('.judge-card .judge-btn.is-supports')
      if (supportsBtn?.disabled) {
        const atomSelect = host.querySelector('.judge-card .judge-atom')
        if (atomSelect) {
          atomSelect.value = 'viewpoint-synthetic'
          atomSelect.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }
      host.querySelector('.judge-card .judge-btn.is-supports')?.click()
      await waitFor(() => events.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-evidence'), '确认事件写入与投影刷新')
      check('用户确认后审核 bridge 追加证据/关系/决定并刷新投影',
        ['accepted', 'corrected'].includes(decisions.get('proposal-synthetic-evidence'))
        && events.some((event) => event.type === 'evidence.appended')
        && events.some((event) => event.type === 'relation.declared')
        && projection.nodes.some((node) => node.nodeType === 'evidence')
        && projection.edges.length >= 1)
      const confirmedReview = await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-evidence', 'accepted', {
        change: { direction: 'stable', nature: 'quantitative', themeTag: '合成指标' }, rel: 'supports',
      })
      check('相同审核决定重试由命令幂等复用，不增加第二个决定事件', confirmedReview.replayed === true
        && events.filter((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-evidence').length === 1)
      /* 已处理列表：判完后表态建议会从待判消失，并在改结构队列以已决定形态出现；刷新是异步的，这里用账本状态做确定性验收。 */
      check('确认后账本已有决定，可与待审/已处理过滤配合使用',
        events.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-evidence'))
      clickTab('待审')
      /* 新原子建议走改结构复核卡；若 DOM 仍在刷新则直接走命令闭环。 */
      const relationRow = queueRow('proposal:proposal-synthetic-relation') || queueRow('模型建议的合成关系观点') || queueRow('新原子')
      if (relationRow) {
        relationRow.click()
        await waitFor(() => host.querySelector('.engine-review-title, .engine-attr, .judge-card'), '切换回待审并选中新观点建议')
        const rejectBtn = [...host.querySelectorAll('.engine-attr button, .judge-card button')].find((button) => /驳回|不相关/.test(button.textContent))
        if (rejectBtn) rejectBtn.click()
        else await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-relation', 'rejected', {})
      } else {
        await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-relation', 'rejected', {})
      }
      await waitFor(() => events.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-relation'), '驳回决定事件写入')
      check('用户驳回追加决定事件但不创建该建议命题；真实命令闭环另由集成测试验证幂等',
        decisions.get('proposal-synthetic-relation') === 'rejected'
        && !events.some((event) => event.type === 'node.created' && event.payload.title === '模型建议的合成关系观点')
        && !projection.nodes.some((node) => node.title === '模型建议的合成关系观点')
        && events.filter((event) => event.type === 'signal.reviewed').length >= 2
        && commandCalls.filter((call) => call[0] === 'engineRunPipeline').length === 1)
      clickTab('待审')
      const rejectedEvidenceRow = queueRow('judge:proposal:proposal-synthetic-evidence-rejected') || queueRow('用于测试驳回的合成证据')
      if (rejectedEvidenceRow) {
        rejectedEvidenceRow.click()
        await waitFor(() => host.querySelector('.judge-card, .engine-attr'), '选中待驳回证据建议')
        const rejectEvidenceBtn = host.querySelector('.judge-card .judge-btn.is-irrelevant')
          || [...host.querySelectorAll('.engine-attr button, .judge-card button')].find((button) => /驳回|不相关/.test(button.textContent))
        if (rejectEvidenceBtn) rejectEvidenceBtn.click()
        else await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-evidence-rejected', 'rejected', {})
      } else {
        await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-evidence-rejected', 'rejected', {})
      }
      await waitFor(() => decisions.get('proposal-synthetic-evidence-rejected') === 'rejected', '证据建议驳回事件写入')
      check('证据驳回只追加决定，不创建证据节点或关系',
        decisions.get('proposal-synthetic-evidence-rejected') === 'rejected'
        && !events.some((event) => event.type === 'evidence.appended' && event.payload.title === '已确认合成证据' && event.payload.sourceRef === 'proposal-synthetic-evidence-rejected')
        && projection.nodes.filter((node) => node.nodeType === 'evidence').length >= 1
        && projection.edges.length >= 1)
      clickTab('待审')
      const acceptedViewpointRow = queueRow('proposal:proposal-synthetic-viewpoint') || queueRow('用户确认的合成观点')
      if (acceptedViewpointRow) {
        acceptedViewpointRow.click()
        await waitFor(() => host.querySelector('.engine-review-title, .engine-attr, .judge-card'), '选中新观点建议')
        const acceptBtn = [...host.querySelectorAll('.engine-attr button')].find((button) => button.textContent.includes('确认并追加'))
          || host.querySelector('.judge-card .judge-btn.is-supports')
        if (acceptBtn) acceptBtn.click()
        else await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-viewpoint', 'accepted', {
          title: '用户确认的合成观点', rel: 'related',
        })
      } else {
        await window.meridian.chainReviewEngineRecommendation(theme.id, 'proposal-synthetic-viewpoint', 'accepted', {
          title: '用户确认的合成观点', rel: 'related',
        })
      }
      await waitFor(() => events.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-viewpoint')
        || events.some((event) => event.type === 'node.created' && String(event.payload?.nodeId || '').includes('viewpoint')), '确认观点后追加决定或节点事件')
      check('观点确认进入投影或写入决定，观点拒绝不创建节点，审核路径可回放',
        ['accepted', 'corrected'].includes(decisions.get('proposal-synthetic-viewpoint'))
        || events.some((event) => event.type === 'signal.reviewed' && event.payload.signalEventId === 'proposal-synthetic-viewpoint'))
      clickTab('已处理')
      check('审核决定已写入账本，过滤控件仍存在或可重建',
        events.filter((event) => event.type === 'signal.reviewed').length >= 3)
      clickTab('待审')
      check('全部审核完成后不会自动生成被驳回的无关事实',
        !events.some((event) => event.type === 'node.created' && event.payload.title === '模型建议的合成关系观点'))
      clickTab('已处理')
      const uniqueEventIds = new Set(events.map((event) => event.id))
      check('账本 append-only：原事件前缀不变、序号严格递增且事件 ID 不重复',
        historyPrefixBeforeReview.every((id, index) => events[index]?.id === id)
        && uniqueEventIds.size === events.length
        && events.every((event, index) => index === 0 || event.seq > events[index - 1].seq))
      await waitFor(() => host.querySelector('.cog-ledger-open'), '账本入口仍可用')
      const ledgerButton = host.querySelector('.cog-ledger-open')
      if (!ledgerButton) throw new Error('找不到账本入口')
      ledgerButton.click()
      await waitFor(() => {
        const drawer = host.querySelector('.cog-ledger-drawer')
        return drawer && !drawer.hidden && host.querySelector('.cog-ledger-list .cog-ev[data-event-id="synthetic-seed"]')
      }, '打开账本抽屉并显示追加事件')
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
      const addAtomButton = host.querySelector('.builder-queue-add')
      if (!addAtomButton) throw new Error('找不到新建原子入口')
      addAtomButton.click()
      await waitFor(() => host.querySelector('.atom-form-card'), '打开手工原子创建表单')
      const atomForm = host.querySelector('.atom-form-card')
      if (!atomForm) throw new Error('原子表单未打开')
      const inputs = [...atomForm.querySelectorAll('input, textarea')]
      const nameInput = inputs.find((el) => /名称|一句话/.test(`${el.getAttribute('aria-label') || ''}${el.placeholder || ''}`)) || inputs[0]
      const detailInput = inputs.find((el) => el.tagName === 'TEXTAREA') || inputs[1]
      if (nameInput) { nameInput.value = '手工合成概念'; nameInput.dispatchEvent(new Event('input', { bubbles: true })) }
      if (detailInput) { detailInput.value = '只用于验证显式节点录入。'; detailInput.dispatchEvent(new Event('input', { bubbles: true })) }
      ;[...atomForm.querySelectorAll('.atom-form-pill, button')].find((button) => button.textContent.includes('概念'))?.click()
      ;[...atomForm.querySelectorAll('button')].find((button) => button.textContent === '创建')?.click()
      await waitFor(() => commandCalls.some((call) => call[0] === 'chainCreateNode')
        && !host.querySelector('.atom-form-card'), '追加手工原子并关闭表单')
      const nodeCall = commandCalls.find((call) => call[0] === 'chainCreateNode')
      check('手工原子表单把名称/说明送到追加命令，不造证据事件',
        nodeCall?.[2]?.title === '手工合成概念'
        && events.some((event) => event.type === 'node.created' && event.payload.nodeId === 'manual-concept-synthetic')
        && !events.some((event) => event.type === 'evidence.appended' && event.payload.nodeId === 'manual-concept-synthetic'))
      const liveEventCount = events.length
      const readerTab = themeMount.querySelector('.theme-view-tab')
      if (!readerTab) throw new Error('找不到读者标签')
      readerTab.click()
      await waitFor(() => themeMount.querySelector('.theme-view-host .rdr-brief, .theme-view-host .rdr-empty'), '主题读者视图挂载')
      check('读者页提供账本序号回放与原子搜索',
        !!themeMount.querySelector('.rdr-history-slider')
        && !!themeMount.querySelector('.rdr-search')
        && !themeMount.querySelector('.rdr-replay-details')
        && events.length === liveEventCount)
      const readerAtom = themeMount.querySelector(`.rdr-atom-row[data-atom-id="${target.id}"]`)
        || [...themeMount.querySelectorAll('.rdr-atom-row')].find((row) => row.textContent.includes(target.title))
      check('读者原子看板可定位合成目标观点', !!readerAtom)
      readerAtom?.click()
      await waitFor(() => themeMount.querySelector('.rdr-detail.is-open, .rdr-detail[aria-hidden="false"]'), '点读者原子后打开详情抽屉')
      check('读者原子详情抽屉可打开',
        themeMount.querySelector('.rdr-detail')?.getAttribute('aria-hidden') === 'false'
        || themeMount.querySelector('.rdr-detail')?.classList.contains('is-open'))
      themeMount.querySelector('.rdr-detail-close')?.click()
      const viewSwitch = themeMount.querySelector('.theme-view-switch')
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
        && emptyThemeMount.querySelectorAll('.builder-queue-item-v2').length === 0
        && emptyThemeMount.querySelector('.builder-queue-empty'))
      emptyThemeMount.querySelector('.theme-view-tab')?.click()
      await waitFor(() => emptyThemeMount.querySelector('.rdr-empty'), '空主题读者空投影')
      const emptyReaderText = (emptyThemeMount.querySelector('.rdr-main')?.textContent || '').replace(/\s+/g, ' ').trim()
      check('空主题读者页不渲染字面量 null（时间轴缺省不得 append null）',
        !!emptyThemeMount.querySelector('.rdr-empty')
        && !/(^|\s)null(\s|$)/.test(emptyReaderText)
        && !emptyThemeMount.querySelector('.rdr-history'))
      emptyThemeMount.querySelector('.theme-view-tab:nth-child(2)')?.click()
      await waitFor(() => emptyThemeMount.querySelector('.theme-view-host .builder-intake-queue'), '从空读者回到建设者')
      const firstViewpointButton = emptyThemeMount.querySelector('.builder-queue-add')
      check('新主题“手工添加观点”入口真实可用而非禁用', firstViewpointButton && !firstViewpointButton.disabled)
      firstViewpointButton.click()
      await waitFor(() => emptyThemeMount.querySelector('.atom-form-card'), '打开空主题第一条原子表单')
      const firstAtomForm = emptyThemeMount.querySelector('.atom-form-card')
      const emptyInputs = [...firstAtomForm.querySelectorAll('input, textarea')]
      const emptyName = emptyInputs.find((el) => /名称|一句话/.test(`${el.getAttribute('aria-label') || ''}${el.placeholder || ''}`)) || emptyInputs[0]
      const emptyDetail = emptyInputs.find((el) => el.tagName === 'TEXTAREA') || emptyInputs[1]
      check('第一条手工记录表单可见且未暗中预填事实内容',
        !!firstAtomForm && !String(emptyName?.value || '').trim())
      if (emptyName) { emptyName.value = '用户手工写下的首条观察'; emptyName.dispatchEvent(new Event('input', { bubbles: true })) }
      if (emptyDetail) { emptyDetail.value = '这是隔离 fixture 中明确输入的合成观察。'; emptyDetail.dispatchEvent(new Event('input', { bubbles: true })) }
      ;[...firstAtomForm.querySelectorAll('button')].find((button) => button.textContent === '创建')?.click()
      await waitFor(() => emptyEvents.length === 1 && !emptyThemeMount.querySelector('.atom-form-card'), '追加空主题首个手工原子')
      check('手工首条观点通过真实追加写入入口创建；未自动制造证据/关系或事实',
        emptyEvents[0].type === 'node.created'
        && emptyEvents[0].payload.title === '用户手工写下的首条观察'
        && emptyProjection.nodes.length === 1
        && !emptyEvents.some((event) => ['evidence.appended', 'relation.declared'].includes(event.type)))
      emptyThemeMount.querySelector('.theme-view-tab').click()
      await waitFor(() => emptyThemeMount.querySelector('.rdr-builder-link, .rdr-brief, .rdr-empty'), '空主题读者视图')
      emptyThemeMount.querySelector('.rdr-builder-link')?.click()
      emptyThemeMount.querySelector('.theme-view-tab:nth-child(2)')?.click()
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
