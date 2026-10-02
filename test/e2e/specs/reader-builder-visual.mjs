import assert from 'node:assert/strict'
import { connect, screenshot, waitVisible } from '../lib/driver.mjs'

const WAIT_MS = 20000

async function waitUntil(browser, predicate, label) {
  await browser.waitUntil(predicate, { timeout: WAIT_MS, timeoutMsg: label })
}

export default async function ({ port, shotsDir }) {
  const browser = await connect(port)
  try {
    await browser.pause(1200)
    const themeName = '合成验收主题 · 事件可追溯'
    const themeInput = await waitVisible(browser, '#theme-name')
    await themeInput.setValue(themeName)
    await browser.$("//button[contains(normalize-space(.), '创建主题')]").click()

    await waitVisible(browser, '.theme-view-switch')
    await waitUntil(browser, async () => (await browser.$('.builder-intake-queue')).isDisplayed(), '新主题建设者工作台显示')
    assert.equal(await browser.$('.mid-head h1').getText(), themeName)

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
    await evidenceDialog.$('[aria-label="来源链接"]').setValue('https://example.test/meridian-review-source')
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
    await waitUntil(browser, async () => browser.execute(() => !document.querySelector('.toast')), 'Builder 操作提示消失')
    const builderShot = await screenshot(browser, shotsDir, '02-builder-workbench')

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
    await waitUntil(browser, async () => browser.execute(() => !document.querySelector('.toast')), 'Reader 操作提示消失')
    const readerShot = await screenshot(browser, shotsDir, '03-reader-network')
    const sequenceMatch = (await sourceEventLink.getText()).match(/第\s*(\d+)\s*条/)
    assert.ok(sequenceMatch, 'Reader 来源事件入口应标明账本序号')
    const sourceSequence = Number(sequenceMatch[1])
    await sourceEventLink.click()
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
    console.log(`[native-visual] screenshots: ${builderShot}; ${readerShot}`)
    console.log(`[native-visual] source event focus: seq=${sourceSequence}, id=${focusedEvent.id}`)
  } finally {
    await browser.deleteSession()
  }
}
