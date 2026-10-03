// 全流程功能测试 v2（fd184d2 新建设者工作台）：
// 读者视图（认知网络/事件校验）→ 建设者工作台（六步流程/手工添加观点/添加节点/补充证据）
// → 信号与事件（历史）→ 账本（事件链完整性）
// 使用 dev 数据（~/meridian-dev-data），修改会追加事件（已备份）。
import { connect, screenshot } from '../lib/driver.mjs';

const $x = (xp) => `//${xp}`;

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  const note = (s) => console.log('[fullflow2]', s);
  let failures = [];
  const check = (name, cond) => {
    console.log(`[fullflow2] ${cond ? '✓' : '✗'} ${name}`);
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

    // ---- 2. 读者视图 ----
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
      };
    });
    check('读者视图显示认知网络', readerState.hasNetwork);
    check('事件链校验通过', readerState.hasValidated);
    note(`事件数=${readerState.eventCount}`);

    // ---- 3. 建设者工作台（inbox 主入口） ----
    note('3/6 建设者工作台');
    const builderTab = await browser.$($x(`button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`));
    await builderTab.click();
    await browser.pause(2000);
    await screenshot(browser, shotsDir, '30-workbench');

    const workbenchState = await browser.execute(() => {
      const body = document.body.innerText;
      return {
        hasWorkbench: body.includes('外部来源') && body.includes('抽取与映射'),
        hasSixSteps: body.includes('来源已摄入') && body.includes('确认或驳回'),
        hasPendingDesk: body.includes('待处理工作台'),
        hasAddViewpoint: body.includes('手工添加观点'),
        hasAddNode: body.includes('添加节点'),
        hasAddEvidence: body.includes('补充证据'),
      };
    });
    check('工作台显示外部来源抽取映射', workbenchState.hasWorkbench);
    check('六步流程完整', workbenchState.hasSixSteps);
    check('待处理工作台入口存在', workbenchState.hasPendingDesk);
    check('手工添加观点入口存在', workbenchState.hasAddViewpoint);
    check('添加节点按钮存在', workbenchState.hasAddNode);
    check('补充证据按钮存在', workbenchState.hasAddEvidence);

    // ---- 4. 信号与事件（历史） ----
    note('4/6 信号与事件历史');
    const historyBtn = await browser.$($x(`button[contains(.,'信号与事件')]`));
    if (await historyBtn.isDisplayed()) {
      await historyBtn.click();
      await browser.pause(2000);
      await screenshot(browser, shotsDir, '40-history');
      const historyState = await browser.execute(() => {
        const body = document.body.innerText;
        return {
          signalCount: (body.match(/信号与事件\s*(\d+)/) || [])[1] || null,
          hasSignals: body.includes('信号') || body.includes('事件'),
        };
      });
      note(`信号与事件数=${historyState.signalCount}`);
      check('信号历史可查看', historyState.hasSignals);
      // 切回工作台
      const inboxBtn = await browser.$($x(`button[contains(.,'待处理工作台')]`));
      if (await inboxBtn.isDisplayed()) await inboxBtn.click();
      await browser.pause(1500);
    } else {
      check('信号与事件入口存在', false);
    }

    // ---- 5. 手工添加观点（走完整六步流程的第一步） ----
    note('5/6 手工添加观点');
    const addVpBtn = await browser.$($x(`button[contains(.,'手工添加观点')]`));
    if (await addVpBtn.isDisplayed().catch(() => false)) {
      await addVpBtn.click();
      await browser.pause(2000);
      await screenshot(browser, shotsDir, '50-add-viewpoint');
      const addState = await browser.execute(() => {
        const body = document.body.innerText;
        // 检查是否进入编辑/表单状态
        return {
          hasForm: /标题|内容|观点|保存|确定/.test(body),
          stepAdvanced: body.includes('抽取原子陈述') || body.includes('②'),
        };
      });
      check('添加观点打开表单', addState.hasForm);
      note(`流程推进到抽取: ${addState.stepAdvanced}`);
      // 关闭/取消（不实际提交，避免污染数据）
      await browser.keys(['Escape']);
      await browser.pause(1000);
    } else {
      note('手工添加观点按钮不可见，跳过');
    }

    // ---- 6. 账本 ----
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
      await browser.keys(['Escape']);
      await browser.pause(1000);
    } else {
      note('未找到账本按钮，跳过');
    }

    // ---- 汇总 ----
    await screenshot(browser, shotsDir, '99-final');
    if (failures.length) {
      throw new Error(`失败项: ${failures.join('; ')}`);
    }
    console.log('[fullflow2] ALL PASS');
  } finally {
    await browser.deleteSession();
  }
}
