import assert from 'node:assert/strict'
import { connect, screenshot, waitVisible } from '../lib/driver.mjs'

const WAIT_MS = 20000

async function waitUntil(browser, predicate, label) {
  await browser.waitUntil(predicate, { timeout: WAIT_MS, timeoutMsg: label })
}

export default async function ({ port, shotsDir }) {
  const browser = await connect(port)
  try {
    const initialWindowSize = await browser.getWindowSize().catch(() => null)
    let visualWindowSize = initialWindowSize
    try { visualWindowSize = await browser.setWindowSize(2048, 1120) } catch { /* retain the platform's available desktop size */ }
    console.log(`[native-visual] window=${JSON.stringify(visualWindowSize || initialWindowSize)}`)
    await browser.pause(1200)
    const themeName = '合成验收主题 · 事件可追溯'
    const themeInput = await waitVisible(browser, '#theme-name')
    await themeInput.setValue(themeName)
    await browser.$("//button[contains(normalize-space(.), '创建主题')]").click()

    await waitVisible(browser, '.theme-view-switch')
    await waitUntil(browser, async () => (await browser.$('.builder-intake-queue')).isDisplayed(), '新主题建设者工作台显示')
    await waitUntil(browser, async () => (await browser.$('.meridian-theme').getText()).includes(themeName), '工作区显示刚创建的主题名称')
    const emptyBuilderText = await browser.$('.meridian-theme').getText()
    assert.match(emptyBuilderText, /待处理工作台/)
    assert.match(emptyBuilderText, /接入外部来源/)
    assert.match(emptyBuilderText, /添加观点|手工观点/)
    const builderHeaderState = await browser.execute(() => {
      const legacyTitle = document.querySelector('.chain-section .cog-global-brand .chain-kicker')
      const duplicateAddNode = document.querySelector('.chain-section .cog-global-actions > button:first-child')
      const queueAdd = document.querySelector('.builder-queue-add')
      return {
        legacyTitleVisible: !!legacyTitle && getComputedStyle(legacyTitle).display !== 'none',
        duplicateAddVisible: !!duplicateAddNode && getComputedStyle(duplicateAddNode).display !== 'none',
        queueAddVisible: !!queueAdd && getComputedStyle(queueAdd).display !== 'none',
      }
    })
    assert.deepEqual(builderHeaderState, { legacyTitleVisible: false, duplicateAddVisible: false, queueAddVisible: true },
      'Builder 参考布局只显示工作台标题与队列中的唯一手工入口')
    const emptyBuilderShot = await screenshot(browser, shotsDir, '01-builder-empty-guidance')

    const emptyNodeCount = await browser.$$('.meridian-theme .cog-node').length
    await browser.$('.builder-queue-source').click()
    const sourceDialog = await waitVisible(browser, '.builder-source-capture')
    const sourcePolicy = await sourceDialog.getText()
    assert.match(sourcePolicy, /不会自动抓取 URL、创建观点或写入主题事实/)
    await sourceDialog.$('[aria-label="来源标题"]').setValue('合成待审核来源')
    await sourceDialog.$('[aria-label="来源名称"]').setValue('隔离合成输入')
    await sourceDialog.$('[aria-label="来源链接"]').setValue('https://www.reuters.com/fixture/reader-builder-source')
    await sourceDialog.$('[aria-label="来源原文或摘录"]').setValue('仅供原生界面验收的合成原文：该记录应先进入待审核来源队列，不得自动成为主题观点。')
    await sourceDialog.$("//button[contains(normalize-space(.), '保存到待处理')]").click()
    await waitUntil(browser, async () => browser.execute(() => [...document.querySelectorAll('.builder-queue-item')]
      .some((item) => item.textContent.includes('合成待审核来源'))), '合成外部来源仅进入 Builder 待处理队列')
    assert.equal(await browser.$$('.meridian-theme .cog-node').length, emptyNodeCount, '来源接入不能自动创建主题网络节点')

    await browser.$('.builder-queue-add').click()
    const nodeDialog = await waitVisible(browser, '.cog-entry-dialog')
    await nodeDialog.$('[aria-label="节点类型"]').selectByAttribute('value', 'viewpoint')
    await nodeDialog.$('[aria-label="节点名称"]').setValue('来源可追溯观点')
    await nodeDialog.$('[aria-label="节点说明"]').setValue('一条只在今日验收合成账本中存在的观点，用于检查 Reader 与 Builder 的来源追溯。')
    await nodeDialog.$('[aria-label="适用时间"]').setValue('2026Q3')
    await nodeDialog.$('[data-entry-save]').click()
    await waitUntil(browser, async () => browser.execute(() => {
      const dialog = document.querySelector('.cog-entry-dialog')
      const error = dialog?.querySelector('.cog-entry-error')
      return !dialog || (error && !error.hidden && error.textContent.trim())
    }), '手工观点追加完成或返回表单校验错误')
    const nodeSaveState = await browser.execute(() => {
      const dialog = document.querySelector('.cog-entry-dialog')
      const error = dialog?.querySelector('.cog-entry-error')
      return {
        dialogOpen: !!dialog,
        title: dialog?.querySelector('[aria-label="节点名称"]')?.value || '',
        saveDisabled: dialog?.querySelector('[data-entry-save]')?.disabled || false,
        error: error && !error.hidden ? error.textContent.trim() : '',
      }
    })
    if (nodeSaveState.dialogOpen) {
      await screenshot(browser, shotsDir, 'debug-node-create')
      throw new Error(`手工观点未追加：${JSON.stringify(nodeSaveState)}`)
    }
    await waitUntil(browser, async () => (await browser.$('[data-ledger-status]').getText()).includes('校验通过'), '手工观点追加并通过账本校验')

    const addEvidence = await browser.$("//header[contains(@class, 'cog-global-toolbar')]//button[contains(normalize-space(.), '补充证据')]")
    await waitUntil(browser, async () => addEvidence.isEnabled(), '补充证据按钮启用')
    await addEvidence.click()
    const evidenceDialog = await waitVisible(browser, '.cog-entry-dialog')
    const targetSelect = await evidenceDialog.$('[aria-label="要关联到的非证据节点"]')
    const targetOptions = await browser.execute((title) => {
      const select = [...document.querySelectorAll('select')].find((item) => item.getAttribute('aria-label') === '要关联到的非证据节点')
      return [...(select?.options || [])].map((option) => ({ value: option.value, text: option.textContent.trim() }))
        .filter((option) => option.value && option.text.includes(title))
    }, '来源可追溯观点')
    assert.equal(targetOptions.length, 1, '合成观点应是唯一可关联的非证据节点')
    await targetSelect.selectByAttribute('value', targetOptions[0].value)
    await evidenceDialog.$('[aria-label="证据摘要或原文摘录"]').setValue('合成来源记载：本条只为验证证据、关系和来源事件路径，不表示外部事实。')
    await evidenceDialog.$('[aria-label="来源名称"]').setValue('隔离合成验收来源')
    await evidenceDialog.$('[aria-label="来源链接"]').setValue('https://www.reuters.com/fixture/meridian-review-source')
    await evidenceDialog.$('[aria-label="来源发布时间"]').setValue('2026-09-25')
    await evidenceDialog.$('[aria-label="适用时间"]').setValue('2026Q3')
    await evidenceDialog.$('[data-entry-save]').click()
    await waitUntil(browser, async () => browser.execute(() => {
      const dialog = document.querySelector('.cog-entry-dialog')
      const error = dialog?.querySelector('.cog-entry-error')
      return !dialog || (error && !error.hidden && error.textContent.trim())
    }), '手工证据追加完成或返回表单校验错误')
    const evidenceSaveState = await browser.execute(() => {
      const dialog = document.querySelector('.cog-entry-dialog')
      const error = dialog?.querySelector('.cog-entry-error')
      return {
        dialogOpen: !!dialog,
        target: dialog?.querySelector('[aria-label="要关联到的非证据节点"]')?.value || '',
        summary: dialog?.querySelector('[aria-label="证据摘要或原文摘录"]')?.value || '',
        sourceUrl: dialog?.querySelector('[aria-label="来源链接"]')?.value || '',
        saveDisabled: dialog?.querySelector('[data-entry-save]')?.disabled || false,
        error: error && !error.hidden ? error.textContent.trim() : '',
      }
    })
    if (evidenceSaveState.dialogOpen) {
      await screenshot(browser, shotsDir, 'debug-evidence-create')
      throw new Error(`手工证据未追加：${JSON.stringify(evidenceSaveState)}`)
    }
    await waitUntil(browser, async () => (await browser.$('[data-cog-counts]').getText()).includes('证据 1'), '证据投影刷新并显示新证据节点')
    await waitUntil(browser, async () => (await browser.$('[data-ledger-status]').getText()).includes('校验通过'), '证据追加并通过账本校验')

    const builderText = await browser.$('.meridian-theme').getText()
    assert.match(builderText, /待处理工作台/)
    assert.doesNotMatch(builderText, /信号与事件/)
    assert.match(builderText, /账本/)
    const queuedSource = await browser.$('.builder-queue-item[data-entry-id^="source:"]')
    await queuedSource.click()
    await waitUntil(browser, async () => (await browser.$('.engine-pipe').getText()).includes('运行模型抽取与映射'), '来源详情显示真实模型抽取入口')
    const pipelineCopy = await browser.$('.engine-pipe').getText()
    assert.match(pipelineCopy, /模型只提出建议/)
    assert.match(pipelineCopy, /确认或驳回前不会修改主题投影/)
    assert.equal(await browser.$('.engine-pipe .engine-stmt').isExisting(), false, '未运行模型时不得显示伪造抽取结果')
    await waitUntil(browser, async () => browser.execute(() => !document.querySelector('.toast')), 'Builder 操作提示消失')
    const builderShot = await screenshot(browser, shotsDir, '02-builder-workbench')

    const builderTimeline = await browser.execute(() => {
      const slider = document.querySelector('.builder-history-slider')
      return { exists: !!slider, max: Number(slider?.max || 0), disabled: !!slider?.disabled }
    })
    assert.equal(builderTimeline.exists, true, 'Builder 有真实账本事件时间轴')
    assert.ok(builderTimeline.max >= 2, `Builder 时间轴至少有三个真实事件停点，实际 max=${builderTimeline.max}`)
    assert.equal(builderTimeline.disabled, false, '有多条已校验事件时 Builder 时间轴启用')
    await browser.execute(() => {
      const slider = document.querySelector('.builder-history-slider')
      slider.value = '0'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      slider.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitUntil(browser, async () => (await browser.$('.builder-history-status').getText()).includes('第 1 条'), 'Builder 时间轴选中第一条事件')
    await browser.$('.builder-history-view').click()
    await waitVisible(browser, '.rdr-root')
    await waitUntil(browser, async () => (await browser.$('.rdr-history-caption').getText()).includes('第 1 条'), 'Builder 历史点进入精确 Reader 事件前缀')
    assert.equal(await browser.$$('.rdr-graph-canvas .cog-node').length, 1, 'Builder 时间轴跳转显示第一事件时真实存在的节点')

    await browser.$('.theme-view-tab:nth-child(2)').click()
    await waitVisible(browser, '.builder-history-slider')
    await browser.execute(() => {
      const slider = document.querySelector('.builder-history-slider')
      slider.value = '0'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      slider.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await browser.$('.builder-history-play').click()
    await waitVisible(browser, '.rdr-play-button')
    await waitUntil(browser, async () => (await browser.$('.rdr-play-button').getAttribute('aria-pressed')) === 'true', 'Builder 播放按钮在 Reader 中启动真实时间回放')
    await browser.$('.rdr-play-button').click()
    await waitUntil(browser, async () => (await browser.$('.rdr-play-button').getAttribute('aria-pressed')) === 'false', 'Builder 发起的时间回放可暂停')
    await browser.$('.theme-view-tab:nth-child(2)').click()
    await waitVisible(browser, '.builder-history-live')
    await browser.$('.builder-history-live').click()
    await waitVisible(browser, '.rdr-root')
    await waitUntil(browser, async () => !(await browser.$('.rdr-live-button').isDisplayed()), 'Builder 当前按钮返回 Reader 实时投影')

    await browser.$('.theme-view-tab').click()
    await waitVisible(browser, '.rdr-root')
    await waitUntil(browser, async () => (await browser.$$('.rdr-graph-canvas .cog-node')).length >= 2, 'Reader 图谱显示合成观点与证据节点')
    const graphCount = await browser.$$('.rdr-graph-canvas .cog-node').length
    assert.ok(graphCount >= 2, `Reader 至少显示两个合成节点，实际 ${graphCount}`)

    const selectedNode = await browser.execute((id) => {
      const node = [...document.querySelectorAll('.rdr-graph-canvas .cog-node')]
        .find((element) => element.getAttribute('data-node-id') === id)
      if (!node) return false
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    }, targetOptions[0].value)
    assert.equal(selectedNode, true, 'Reader SVG 观点节点存在并接收 click 事件')
    const sourceEventLink = await waitVisible(browser, '.rdr-evidence-list .rdr-event-link')
    const evidenceSections = await browser.$('.rdr-inspector-scroll').getText()
    assert.match(evidenceSections, /哪些关系支持该观点/)
    assert.match(evidenceSections, /支持 · 1/)
    await waitUntil(browser, async () => browser.execute(() => !document.querySelector('.toast')), 'Reader 操作提示消失')
    await waitUntil(browser, async () => browser.execute(() => {
      const svg = document.querySelector('.rdr-graph-canvas .cog-network-svg')
      return !!svg && Number(getComputedStyle(svg).opacity) >= 0.98
    }), 'Reader 网络 SVG 完成渐入绘制')
    const readerShot = await screenshot(browser, shotsDir, '03-reader-network')

    const targetTransformBeforeReplay = await browser.execute((id) => document.querySelector(`.rdr-graph-canvas .cog-node[data-node-id="${CSS.escape(id)}"]`)?.getAttribute('transform') || '', targetOptions[0].value)
    const slider = await browser.$('.rdr-time-slider')
    const sliderState = await browser.execute(() => {
      const element = document.querySelector('.rdr-time-slider')
      return { max: Number(element?.max || 0), disabled: Boolean(element?.disabled), step: element?.step || '' }
    })
    assert.ok(sliderState.max >= 2, `至少有观点、证据和关系三个独立时间停点，实际 max=${sliderState.max}`)
    assert.equal(sliderState.disabled, false, '多事件主题必须启用时间回放')
    await browser.execute(() => {
      const element = document.querySelector('.rdr-time-slider')
      element.value = '0'
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitUntil(browser, async () => (await browser.$('.rdr-history-caption').getText()).includes('第 1 条'), '滑杆回放到第一条账本事件')
    const firstHistoryState = await browser.execute(() => ({
      nodes: document.querySelectorAll('.rdr-graph-canvas .cog-node').length,
      selectedSeq: document.querySelector('.rdr-graph-canvas .cog-network-svg')?.getAttribute('aria-label') || '',
    }))
    assert.equal(firstHistoryState.nodes, 1, '第一条 node.created 前缀只能显示当时已存在的观点节点')
    const targetTransformInHistory = await browser.execute((id) => document.querySelector(`.rdr-graph-canvas .cog-node[data-node-id="${CSS.escape(id)}"]`)?.getAttribute('transform') || '', targetOptions[0].value)
    assert.equal(targetTransformInHistory, targetTransformBeforeReplay, '同一观点在当前与历史帧使用完全相同的布局坐标')
    await browser.$('.rdr-compare-button').click()
    await waitUntil(browser, async () => browser.execute(() => Number(document.querySelector('.rdr-graph-canvas .cog-network-svg')?.getAttribute('data-comparison-ghosts') || 0) > 0), '当前对比显示后续新增节点 ghost')
    assert.ok(await browser.$('.rdr-graph-canvas .cog-node.is-not-yet-created').isExisting(), '未来新增节点以 ghost 状态显示而不混入历史事实')
    await browser.$('.rdr-compare-button').click()
    await browser.$('.rdr-play-button').click()
    await waitUntil(browser, async () => (await browser.$('.rdr-play-button').getAttribute('aria-pressed')) === 'true', '时间回放进入播放状态')
    await browser.$('.rdr-play-button').click()
    await waitUntil(browser, async () => (await browser.$('.rdr-play-button').getAttribute('aria-pressed')) === 'false', '时间回放可暂停')
    await browser.$('.rdr-live-button').click()
    await waitUntil(browser, async () => !(await browser.$('.rdr-live-button').isDisplayed()), '时间回放可回到当前模型')

    const search = await browser.$('.rdr-search')
    await search.setValue('来源可追溯观点')
    await waitUntil(browser, async () => browser.$$('.rdr-search-result').then((items) => items.length > 0), 'Reader 全主题搜索返回观点')
    await browser.$('.rdr-search-result').click()
    await waitUntil(browser, async () => (await browser.$('.rdr-search-status').getText()).includes('已定位并高亮'), '搜索结果在 SVG 画布定位、高亮并报出空间位置')
    assert.ok(await browser.$('.rdr-graph-canvas .cog-node.is-search-match').isExisting(), '搜索命中节点具有可见 SVG 高亮状态')
    assert.match(await browser.$('.rdr-search-status').getText(), /画布.*窗口/)

    await search.clearValue()
    const typeFilter = await browser.$('.rdr-filter[aria-label="按节点类型筛选"]')
    const filteredGraph = await browser.execute(() => {
      const select = document.querySelector('.rdr-filter[aria-label="按节点类型筛选"]')
      select.value = 'evidence'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return {
        selectedFilter: select.value,
        query: document.querySelector('.rdr-search')?.value || '',
        nodes: [...document.querySelectorAll('.rdr-graph-canvas .cog-node')].map((node) => ({ type: node.getAttribute('data-node-type'), id: node.getAttribute('data-node-id') })),
      }
    })
    assert.equal(filteredGraph.selectedFilter, 'evidence', `Reader 类型筛选切换到证据值：${JSON.stringify(filteredGraph)}`)
    assert.deepEqual(filteredGraph.nodes.map((node) => node.type), ['evidence'], `Reader 类型筛选只显示证据节点，实际 ${JSON.stringify(filteredGraph)}`)
    await browser.execute(() => {
      const select = document.querySelector('.rdr-filter[aria-label="按节点类型筛选"]')
      select.value = 'all'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(await typeFilter.getValue(), 'all', 'Reader 类型筛选可恢复全量视图')
    await search.setValue('来源可追溯观点')
    const keyboardFocusedResult = await browser.execute(() => {
      const input = document.querySelector('.rdr-search')
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      return document.activeElement?.classList.contains('rdr-search-result') || false
    })
    assert.equal(keyboardFocusedResult, true, 'ArrowDown 将焦点移至 Reader 搜索结果')
    await browser.execute(() => {
      const input = document.querySelector('.rdr-search')
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await waitUntil(browser, async () => (await browser.$('.rdr-search-status').getText()).includes('已定位并高亮'), 'Reader 搜索键盘上下选择与回车定位可用')
    await search.clearValue()

    const finalSourceEventLink = await waitVisible(browser, '.rdr-evidence-list .rdr-event-link')
    const sequenceMatch = (await finalSourceEventLink.getText()).match(/第\s*(\d+)\s*条/)
    assert.ok(sequenceMatch, 'Reader 来源事件入口应标明账本序号')
    const sourceSequence = Number(sequenceMatch[1])
    await finalSourceEventLink.click()
    await waitUntil(browser, async () => browser.execute((sequence) => {
      const drawer = document.querySelector('.cog-ledger-drawer')
      const active = document.activeElement
      const row = active?.closest?.('.cog-ev')
      const label = row?.querySelector('.cog-event-focus')?.getAttribute('aria-label') || ''
      return !!drawer && !drawer.hidden && !!row && label.includes(`第 ${sequence} 条事件`)
    }, sourceSequence), 'Reader 来源事件应打开 Builder 追加账本并定位同一序号')
    const focusedEvent = await browser.execute(() => ({
      id: document.activeElement?.closest?.('.cog-ev')?.getAttribute('data-event-id') || '',
      summary: document.activeElement?.closest?.('.cog-ev')?.querySelector('.cog-ev-summary-text')?.textContent || '',
      integrity: document.querySelector('.cog-ledger-drawer .cog-integrity')?.textContent || '',
    }))
    assert.ok(focusedEvent.id, '账本应聚焦一个带事件 ID 的记录')
    assert.match(focusedEvent.summary, /新增证据|证据追加/)
    assert.match(focusedEvent.integrity, /校验通过/)
    console.log(`[native-visual] screenshots: ${emptyBuilderShot}; ${builderShot}; ${readerShot}`)
    console.log(`[native-visual] source event focus: seq=${sourceSequence}, id=${focusedEvent.id}`)
  } finally {
    await browser.deleteSession()
  }
}
