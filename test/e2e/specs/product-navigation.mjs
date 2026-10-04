import assert from 'node:assert/strict'
import { connect, waitVisible } from '../lib/driver.mjs'

const WAIT_MS = 20000

async function clickButton(browser, selector) {
  const button = await waitVisible(browser, selector, WAIT_MS)
  await button.click()
}

async function waitTextIncludes(browser, selector, text) {
  await browser.waitUntil(async () => {
    const element = await browser.$(selector)
    return element.isExisting() && (await element.getText()).includes(text)
  }, { timeout: WAIT_MS, timeoutMsg: `等待 ${selector} 包含“${text}”` })
}

export default async function ({ port }) {
  const browser = await connect(port)
  try {
    await browser.pause(700)
    await waitTextIncludes(browser, '#mid', '新建主题')
    assert.equal(await browser.$('.app').getAttribute('data-view'), 'new-theme')

    await clickButton(browser, '//nav[@id="nav"]//button[contains(normalize-space(.), "今日")]')
    await waitTextIncludes(browser, '.today-page', '今日')
    await waitTextIncludes(browser, '.inbox-empty-state', '待确认已清空')
    assert.equal(await browser.$('.app').getAttribute('data-view'), 'today')

    await clickButton(browser, '//nav[@id="nav"]//button[contains(normalize-space(.), "数据源")]')
    await waitTextIncludes(browser, '.sources-page', '数据源')
    await waitTextIncludes(browser, '.sources-page', '尚未收到来源')

    await clickButton(browser, '//nav[@id="nav"]//button[contains(normalize-space(.), "读数")]')
    await waitTextIncludes(browser, '.readings-page', '读数')
    await waitTextIncludes(browser, '.readings-page', '还没有读数')

    await clickButton(browser, '#vaults .audit-head')
    const auditLabels = await browser.execute(() => [...document.querySelectorAll('#vaults .audit-sub')].map((el) => el.textContent.replace(/\d+/g, '').trim()))
    assert.deepEqual(auditLabels, ['冷库', '归档', '系统健康'])

    const expectedRoutes = [
      ['冷库', '.page-head h1'],
      ['归档', '.page-head h1'],
      ['系统健康', '.page-head h1'],
    ]
    for (const [label, heading] of expectedRoutes) {
      await clickButton(browser, `//div[@id="vaults"]//button[contains(@class, "audit-sub") and contains(normalize-space(.), "${label}")]`)
      await waitTextIncludes(browser, '#mid', label === '系统健康' ? '系统健康' : label)
      assert.equal(await browser.$('.app').getAttribute('data-view'), 'audit')
      assert.ok(await browser.$(heading).isExisting(), `应挂载 ${label} 页面标题`)
    }

    console.log('[e2e] PASS: 今日/收件箱、数据源、读数、冷库、归档、系统健康均可达。设置页未访问。')
  } finally {
    await browser.deleteSession()
  }
}
