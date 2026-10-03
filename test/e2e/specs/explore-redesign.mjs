// 探索 42da204 重构后的主题页结构：打开 Sivers 主题，截图读者视图，dump 关键 DOM。
import { connect, screenshot } from '../lib/driver.mjs';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  try {
    await browser.pause(3000);

    // 进 Sivers 主题
    const themeBtn = await browser.$("//button[contains(.,'Sivers')]");
    await themeBtn.waitForDisplayed({ timeout: 20000 });
    await themeBtn.click();
    await browser.pause(2000);
    await screenshot(browser, shotsDir, '10-theme-opened');

    // dump 主题页的关键结构：视图切换、主要容器
    const structure = await browser.execute(() => {
      const out = {};
      // 视图 tab
      out.tabs = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t.length < 20).slice(0, 30);
      // 主要容器类名
      out.containers = [...document.querySelectorAll('[class*="reader"],[class*="builder"],[class*="chain"],[class*="theme"]')]
        .map(el => el.className).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);
      // 观点/命题相关元素
      out.claimCount = document.querySelectorAll('[class*="claim"],[class*="viewpoint"],[class*="node"]').length;
      // 待审阅信号
      out.signalCount = document.querySelectorAll('[class*="signal"],[class*="pending"],[class*="review"]').length;
      // 证据
      out.evidenceCount = document.querySelectorAll('[class*="evidence"]').length;
      return out;
    });
    console.log('[explore] tabs =', JSON.stringify(structure.tabs));
    console.log('[explore] containers =', JSON.stringify(structure.containers));
    console.log('[explore] claim/viewpoint els =', structure.claimCount);
    console.log('[explore] signal/review els =', structure.signalCount);
    console.log('[explore] evidence els =', structure.evidenceCount);

    // 如果有读者/建设者视图切换，逐个截图
    for (const tabName of ['读者', '建设者', 'Reader', 'Builder']) {
      try {
        const tab = await browser.$(`//button[contains(.,'${tabName}')]`);
        if (await tab.isDisplayed()) {
          await tab.click();
          await browser.pause(1500);
          await screenshot(browser, shotsDir, `11-tab-${tabName}`);
          console.log('[explore] 截图 tab:', tabName);
        }
      } catch { /* 不存在则跳过 */ }
    }

    console.log('[explore] OK');
  } finally {
    await browser.deleteSession();
  }
}
