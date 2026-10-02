// 连接应用内嵌的 W3C WebDriver 服务（tauri-plugin-wdio-webdriver，debug 构建）。
// App 由 run.mjs 负责拉起（带 TAURI_WEBDRIVER_PORT / MERIDIAN_DATA_DIR），这里只负责连。
import { remote } from 'webdriverio';
import path from 'node:path';

export async function connect(port = 4445) {
  const browser = await remote({
    hostname: '127.0.0.1',
    port,
    path: '/',
    logLevel: 'warn',
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    capabilities: { browserName: 'tauri' },
  });
  return browser;
}

export async function screenshot(browser, shotsDir, name) {
  const p = path.join(shotsDir, `${name}.png`);
  await browser.saveScreenshot(p);
  console.log('[shot]', p);
  return p;
}

// 像人一样：先等元素出现再操作，避免时序 flake
export async function waitVisible(browser, selector, timeout = 20000) {
  const el = await browser.$(selector);
  await el.waitForDisplayed({ timeout });
  return el;
}

export async function waitText(browser, selector, timeout = 20000) {
  const el = await waitVisible(browser, selector, timeout);
  await browser.waitUntil(async () => (await el.getText()).trim().length > 0, {
    timeout,
    timeoutMsg: `元素 ${selector} 文本为空`,
  });
  return el;
}
