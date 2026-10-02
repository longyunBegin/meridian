// 诊断：点击建设者 tab 后 DOM 状态
import { connect, screenshot } from '../lib/driver.mjs';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  try {
    await browser.pause(2500);
    const themeBtn = await browser.$(
      `//button[contains(@class,'theme-item') and contains(.,'Sivers')]`,
    );
    await themeBtn.click();
    await browser.pause(1500);

    const tab = await browser.$(
      `//button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`,
    );
    console.log('[diag] tab exists, clicking...');
    await tab.click();
    await browser.pause(4000);

    const info = await browser.execute(() => {
      const host = document.querySelector('.theme-view-host');
      const tabs = [...document.querySelectorAll('.theme-view-tab')].map((t) => ({
        text: t.textContent.trim(),
        active: t.classList.contains('is-active'),
        selected: t.getAttribute('aria-selected'),
      }));
      return {
        hostHTMLLen: host ? host.innerHTML.length : -1,
        hostText: host ? host.innerText.slice(0, 200) : null,
        tabs,
        focusExists: !!document.querySelector('.builder-focus'),
        errors: (window.__e2eErrors || []).slice(0, 3),
      };
    });
    console.log('[diag]', JSON.stringify(info, null, 1).slice(0, 1500));
    await screenshot(browser, shotsDir, 'diag-after-click');
  } finally {
    await browser.deleteSession();
  }
}
