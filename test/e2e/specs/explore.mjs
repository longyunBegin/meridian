// 全面探索测试：双主题 × 双视图 × builder 三模式，像人一样把界面走一遍。
// 目标：记录每个界面的状态、截图，发现 bug。
import { connect, screenshot } from '../lib/driver.mjs';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  const note = (s) => console.log('[explore]', s);
  const shot = (n) => screenshot(browser, shotsDir, n);
  try {
    await browser.pause(2500);

    for (const [themeKey, themeName] of [['Sivers', 'Sivers'], ['光互连', '光互连']]) {
      note(`=== 主题：${themeName} ===`);
      const themeBtn = await browser.$(
        `//button[contains(@class,'theme-item') and contains(.,'${themeKey}')]`,
      );
      await themeBtn.click();
      await browser.pause(1500);

      // 读者视图（默认）
      note(`[${themeName}] 读者视图`);
      const readerText = await browser.$('.theme-view-host').getText();
      note(`  正文字符数=${readerText.length}`);
      await shot(`20-${themeKey}-reader`);

      // 建设者视图
      note(`[${themeName}] 建设者视图`);
      const builderTab = await browser.$(
        `//button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`,
      );
      await builderTab.click();
      await browser.pause(3000);

      // builder 三模式
      const modes = await browser.execute(() => {
        const items = [...document.querySelectorAll('.side-nav-item[data-mode]')].map((el) => ({
          mode: el.dataset.mode,
          text: el.innerText.replace(/\n/g, ' ').trim(),
          active: el.classList.contains('active'),
        }));
        const mainText = document.querySelector('.builder-main')?.innerText.slice(0, 300) || '';
        return { items, mainText };
      });
      note(`  侧栏模式=${JSON.stringify(modes.items)}`);
      note(`  主舞台前300字=${JSON.stringify(modes.mainText.slice(0, 120))}`);
      await shot(`21-${themeKey}-builder-stream`);

      // 切到待处理（inbox 模式）
      const inboxNav = await browser.$('.side-nav-item[data-mode="inbox"]');
      if (await inboxNav.isExisting()) {
        await inboxNav.click();
        await browser.pause(2000);
        const inboxInfo = await browser.execute(() => {
          const main = document.querySelector('.builder-main');
          return {
            text: main?.innerText.slice(0, 400) || '',
            active: document.querySelector('.side-nav-item[data-mode="inbox"]')?.classList.contains('active'),
          };
        });
        note(`  待处理模式 active=${inboxInfo.active}，内容前200字=${JSON.stringify(inboxInfo.text.slice(0, 200))}`);
        await shot(`22-${themeKey}-builder-inbox`);
        // 切回信号流
        await browser.$('.side-nav-item[data-mode="stream"]').click();
        await browser.pause(1500);
      }

      // 账本按钮
      const ledgerBtn = await browser.$('button.cog-ledger-open');
      note(`  账本按钮存在=${await ledgerBtn.isExisting()}`);
    }

    note('探索完成');
  } finally {
    await browser.deleteSession();
  }
}
