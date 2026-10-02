// 验证"驳回"按钮（对照组：'reject' 是后端支持的动作，应该正常工作）
import { connect, screenshot } from '../lib/driver.mjs';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  const note = (s) => console.log('[reject]', s);
  try {
    await browser.pause(2500);
    const themeBtn = await browser.$(`//button[contains(@class,'theme-item') and contains(.,'Sivers')]`);
    await themeBtn.click();
    await browser.pause(1500);
    const builderTab = await browser.$(`//button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`);
    await builderTab.click();
    await browser.pause(2500);
    await browser.$('.side-nav-item[data-mode="inbox"]').click();
    await browser.pause(3000);

    const before = await browser.execute(() => ({
      count: document.querySelectorAll('.inbox-inner .attr').length,
    }));
    note(`驳回前待处理数=${before.count}`);
    if (!before.count) {
      note('无待处理项，跳过');
      return;
    }

    const rejectBtn = await browser.$('.inbox-inner .attr .attr-btn.reject');
    await rejectBtn.click();
    note('已点"驳回"');
    await browser.pause(4000);

    const after = await browser.execute(() => ({
      count: document.querySelectorAll('.inbox-inner .attr').length,
      toast: document.querySelector('.toast')?.innerText || null,
    }));
    note(`驳回后待处理数=${after.count}，toast=${JSON.stringify(after.toast)}`);
    await screenshot(browser, shotsDir, '40-reject-after');

    if (after.count !== before.count - 1) {
      throw new Error(`驳回后数量未减1：${before.count} → ${after.count}`);
    }
    note('驳回链路通过');
  } finally {
    await browser.deleteSession();
  }
}
