// 探索 fd184d2 新建设者工作台：点击"信号与事件"，查看 7 条信号的新位置与交互。
import { connect, screenshot } from '../lib/driver.mjs';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  try {
    await browser.pause(3000);
    const themeBtn = await browser.$("//button[contains(.,'Sivers')]");
    await themeBtn.waitForDisplayed({ timeout: 20000 });
    await themeBtn.click();
    await browser.pause(2000);

    // 进建设者视图
    const builderTab = await browser.$("//button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]");
    await builderTab.click();
    await browser.pause(2000);
    await screenshot(browser, shotsDir, '10-workbench');

    // 点击"信号与事件"
    const sigBtn = await browser.$("//*[contains(.,'信号与事件')]");
    console.log('[explore] 信号与事件可见:', await sigBtn.isDisplayed().catch(() => false));
    try {
      await sigBtn.click();
      await browser.pause(2000);
      await screenshot(browser, shotsDir, '11-signals');
    } catch (e) {
      console.log('[explore] 点击失败:', e.message.slice(0, 100));
    }

    // dump 当前可见的判决相关按钮
    const btns = await browser.execute(() => {
      return [...document.querySelectorAll('button')]
        .map(b => b.textContent.trim())
        .filter(t => /接受|驳回|修正|确认|判决/.test(t))
        .slice(0, 20);
    });
    console.log('[explore] 判决按钮:', JSON.stringify(btns));

    // dump 六步工作流状态
    const steps = await browser.execute(() => document.body.innerText.match(/①[^⑥]*⑥[^\n]*/)?.[0] || '未找到');
    console.log('[explore] 工作流:', steps.slice(0, 120));

    console.log('[explore] OK');
  } finally {
    await browser.deleteSession();
  }
}
