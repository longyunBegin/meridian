// 核心交互测试：待处理归因 → 点"确认" → 证据进入信号流。
// 这是发动机"人做确认"的关键链路；跑在隔离账本上（用户已授权触碰置信度）。
import { connect, screenshot } from '../lib/driver.mjs';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  const note = (s) => console.log('[attr]', s);
  const shot = (n) => screenshot(browser, shotsDir, n);
  try {
    await browser.pause(2500);

    // 进 Sivers 主题 → 建设者视图 → 待处理
    const themeBtn = await browser.$(`//button[contains(@class,'theme-item') and contains(.,'Sivers')]`);
    await themeBtn.click();
    await browser.pause(1500);
    const builderTab = await browser.$(`//button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`);
    await builderTab.click();
    await browser.pause(2500);
    await browser.$('.side-nav-item[data-mode="inbox"]').click();
    await browser.pause(3000); // 等异步加载收件箱

    const before = await browser.execute(() => ({
      count: document.querySelectorAll('.inbox-inner .attr').length,
      firstId: document.querySelector('.inbox-inner .attr')?.dataset.attr || null,
      firstText: document.querySelector('.inbox-inner .attr .attr-target')?.innerText.slice(0, 60) || null,
    }));
    note(`确认前待处理数=${before.count}，首条id=${before.firstId}`);
    note(`首条内容=${JSON.stringify(before.firstText)}`);
    if (!before.count) {
      note('无待处理项，跳过确认测试');
      await shot('30-inbox-empty');
      return;
    }
    await shot('30-inbox-before');

    // 点第一条的"确认"
    const confirmBtn = await browser.$('.inbox-inner .attr .attr-btn.confirm');
    await confirmBtn.click();
    note('已点"确认"，等重新渲染…');
    await browser.pause(4000);

    const after = await browser.execute(() => ({
      count: document.querySelectorAll('.inbox-inner .attr').length,
      toast: document.querySelector('.toast')?.innerText || null,
    }));
    note(`确认后待处理数=${after.count}，toast=${JSON.stringify(after.toast)}`);
    await shot('31-inbox-after');

    if (after.count !== before.count - 1) {
      throw new Error(`待处理数未减1：${before.count} → ${after.count}`);
    }

    // 切到信号流，验证证据进入
    await browser.$('.side-nav-item[data-mode="stream"]').click();
    await browser.pause(3000);
    const stream = await browser.execute(() => ({
      navText: document.querySelector('.side-nav-item[data-mode="stream"]')?.innerText.replace(/\n/g, ' ') || '',
      mainText: document.querySelector('.builder-main')?.innerText.slice(0, 200) || '',
    }));
    note(`信号流侧栏=${JSON.stringify(stream.navText)}`);
    note(`信号流内容前200字=${JSON.stringify(stream.mainText.slice(0, 200))}`);
    await shot('32-stream-after');

    if (!/信号流\s*[1-9]/.test(stream.navText)) {
      throw new Error(`信号流计数未增加：${stream.navText}`);
    }

    note('归因确认链路通过');
  } finally {
    await browser.deleteSession();
  }
}
