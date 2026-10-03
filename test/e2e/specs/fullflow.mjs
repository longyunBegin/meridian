// 全流程功能测试（42da204 重构后）：
// 读者视图（认知网络/事件校验）→ 建设者信号流（接受/驳回/修正）→ 账本（事件链完整性）
// 使用 dev 数据（~/meridian-dev-data），修改会追加事件（已备份）。
import { connect, screenshot, waitVisible } from '../lib/driver.mjs';

const $x = (xp) => `//${xp}`;

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  const note = (s) => console.log('[fullflow]', s);
  let failures = [];
  const check = (name, cond) => {
    console.log(`[fullflow] ${cond ? '✓' : '✗'} ${name}`);
    if (!cond) failures.push(name);
  };

  try {
    await browser.pause(3000);

    // ---- 1. 进 Sivers 主题 ----
    note('1/6 进入 Sivers 主题');
    const themeBtn = await browser.$($x(`button[contains(.,'Sivers')]`));
    await themeBtn.waitForDisplayed({ timeout: 20000 });
    await themeBtn.click();
    await browser.pause(2000);

    // ---- 2. 读者视图：认知网络 + 事件校验 ----
    note('2/6 读者视图检查');
    const readerTab = await browser.$($x(`button[contains(@class,'theme-view-tab') and contains(.,'读者视图')]`));
    if (await readerTab.isDisplayed()) await readerTab.click();
    await browser.pause(2000);
    await screenshot(browser, shotsDir, '20-reader');

    const readerState = await browser.execute(() => {
      const body = document.body.innerText;
      return {
        hasNetwork: body.includes('主题认知网络'),
        hasValidated: /已校验|校验通过/.test(body),
        eventCount: (body.match(/(\d+)\s*条事件/) || [])[1] || null,
        nodeCards: document.querySelectorAll('[class*="rdr-"],[class*="node-card"],[class*="cog-node"]').length,
      };
    });
    check('读者视图显示认知网络', readerState.hasNetwork);
    check('事件链校验通过', readerState.hasValidated);
    note(`事件数=${readerState.eventCount}, 节点卡片=${readerState.nodeCards}`);

    // ---- 3. 建设者视图：信号流 ----
    note('3/6 建设者视图信号流');
    const builderTab = await browser.$($x(`button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`));
    await builderTab.click();
    await browser.pause(2000);
    await screenshot(browser, shotsDir, '30-builder');

    const signalState = await browser.execute(() => {
      const body = document.body.innerText;
      const m = body.match(/信号流/);
      // 数信号卡片（有"系统提取"的卡片）
      const cards = [...document.querySelectorAll('*')].filter(el =>
        el.textContent && el.textContent.includes('系统提取') && el.children.length < 30).length;
      return {
        hasSignalFlow: !!m,
        pendingCount: (body.match(/(\d+)\s*新增/) || [])[1] || null,
      };
    });
    check('建设者视图显示信号流', signalState.hasSignalFlow);
    note(`待处理信号=${signalState.pendingCount}`);

    // ---- 4. 接受一条信号 ----
    note('4/6 接受信号');
    const acceptBtns = await browser.$$($x(`button[contains(.,'接受')]`));
    note(`找到 ${acceptBtns.length} 个接受按钮`);
    if (acceptBtns.length > 0) {
      // 记录接受前的事件数
      const beforeEvents = await browser.execute(() => {
        const m = document.body.innerText.match(/(\d+)\s*事件/);
        return m ? parseInt(m[1]) : null;
      });
      await acceptBtns[0].click();
      await browser.pause(2500);
      await screenshot(browser, shotsDir, '40-after-accept');
      const afterEvents = await browser.execute(() => {
        const m = document.body.innerText.match(/(\d+)\s*事件/);
        return m ? parseInt(m[1]) : null;
      });
      note(`事件数: ${beforeEvents} → ${afterEvents}`);
      check('接受后事件数+1', beforeEvents !== null && afterEvents === beforeEvents + 1);
    } else {
      check('有可接受的信号', false);
    }

    // ---- 5. 驳回一条信号 ----
    note('5/6 驳回信号');
    const rejectBtns = await browser.$$($x(`button[contains(.,'驳回')]`));
    note(`找到 ${rejectBtns.length} 个驳回按钮`);
    if (rejectBtns.length > 0) {
      const beforeEvents = await browser.execute(() => {
        const m = document.body.innerText.match(/(\d+)\s*事件/);
        return m ? parseInt(m[1]) : null;
      });
      await rejectBtns[0].click();
      await browser.pause(2500);
      await screenshot(browser, shotsDir, '50-after-reject');
      const afterEvents = await browser.execute(() => {
        const m = document.body.innerText.match(/(\d+)\s*事件/);
        return m ? parseInt(m[1]) : null;
      });
      note(`事件数: ${beforeEvents} → ${afterEvents}`);
      check('驳回后事件数+1', beforeEvents !== null && afterEvents === beforeEvents + 1);
    } else {
      check('有可驳回的信号', false);
    }

    // ---- 6. 账本：事件链完整性 ----
    note('6/6 账本事件链');
    const ledgerBtn = await browser.$($x(`button[contains(.,'账本')]`));
    if (await ledgerBtn.isDisplayed()) {
      await ledgerBtn.click();
      await browser.pause(2000);
      await screenshot(browser, shotsDir, '60-ledger');
      const ledgerState = await browser.execute(() => {
        const body = document.body.innerText;
        return {
          hasLedger: /账本|事件链/.test(body),
          allValidated: !/校验异常|校验失败/.test(body),
        };
      });
      check('账本可打开', ledgerState.hasLedger);
      check('账本无校验异常', ledgerState.allValidated);
      // 关闭账本
      const closeBtn = await browser.$($x(`button[contains(@aria-label,'关闭') or contains(.,'×')]`));
      if (await closeBtn.isDisplayed().catch(() => false)) await closeBtn.click();
    } else {
      note('未找到账本按钮，跳过');
    }

    // ---- 汇总 ----
    await browser.pause(1000);
    await screenshot(browser, shotsDir, '99-final');
    if (failures.length) {
      throw new Error(`失败项: ${failures.join('; ')}`);
    }
    console.log('[fullflow] ALL PASS');
  } finally {
    await browser.deleteSession();
  }
}
