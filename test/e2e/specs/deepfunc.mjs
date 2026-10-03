// 深度功能测试：真实提交数据并验证
// 1. 读者视图点击节点看详情 2. 建设者添加节点（填表单+提交）3. 验证事件追加+投影更新 4. 账本校验
import { connect, screenshot } from '../lib/driver.mjs';

const $x = (xp) => `//${xp}`;
const TEST_NAME = '[E2E测试] 光子业务持续向好';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  const note = (s) => console.log('[deepfunc]', s);
  let failures = [];
  const check = (name, cond) => {
    console.log(`[deepfunc] ${cond ? '✓' : '✗'} ${name}`);
    if (!cond) failures.push(name);
  };

  const getEventCount = () => browser.execute(() => {
    const m = document.body.innerText.match(/(\d+)\s*事件/);
    return m ? parseInt(m[1]) : null;
  });

  try {
    await browser.pause(3000);

    // ---- 1. 进主题，读者视图点节点详情 ----
    note('1/5 读者视图节点详情');
    const themeBtn = await browser.$($x(`button[contains(.,'Sivers')]`));
    await themeBtn.waitForDisplayed({ timeout: 20000 });
    await themeBtn.click();
    await browser.pause(2000);

    const readerTab = await browser.$($x(`button[contains(@class,'theme-view-tab') and contains(.,'读者视图')]`));
    if (await readerTab.isDisplayed()) await readerTab.click();
    await browser.pause(2000);

    // 等节点渲染出来
    await browser.waitUntil(async () => {
      return await browser.execute(() => document.body.innerText.includes('光子业务'));
    }, { timeout: 15000, timeoutMsg: '节点未渲染' });
    await browser.pause(1000);

    // 点击"光子业务"节点（用 XPath 直接定位 SVG text 元素）
    let clicked = false;
    try {
      const nodeText = await browser.$($x(`//*[contains(@class,'rdr-') or contains(@class,'node')]//*[text()='光子业务']`));
      if (await nodeText.isDisplayed().catch(() => false)) {
        await nodeText.click();
        clicked = true;
      }
    } catch {}
    if (!clicked) {
      // 兜底：JS dispatch
      clicked = await browser.execute(() => {
        const els = [...document.querySelectorAll('*')].filter(el =>
          el.textContent?.trim() === '光子业务');
        // 找最小的包含者（最具体的节点）
        els.sort((a, b) => a.textContent.length - b.textContent.length);
        const target = els[0];
        if (target) { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
        return false;
      });
    }
    await browser.pause(2000);
    await screenshot(browser, shotsDir, '10-node-detail');

    const detailState = await browser.execute(() => {
      const body = document.body.innerText;
      return {
        showsSelected: body.includes('已选择') && body.includes('光子业务'),
        hasProvenance: body.includes('来源记录') || body.includes('系统摄入时间'),
        hasRelations: body.includes('关系与方向'),
      };
    });
    check('点击节点选中光子业务', clicked && detailState.showsSelected);
    check('详情显示来源记录', detailState.hasProvenance);
    check('详情显示关系与方向', detailState.hasRelations);

    // ---- 2. 建设者视图，添加节点 ----
    note('2/5 建设者添加节点');
    const builderTab = await browser.$($x(`button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`));
    await builderTab.click();
    await browser.pause(2000);

    const beforeEvents = await getEventCount();
    note(`提交前事件数=${beforeEvents}`);

    const addNodeBtn = await browser.$($x(`button[contains(.,'添加节点')]`));
    await addNodeBtn.click();
    await browser.pause(1500);
    await screenshot(browser, shotsDir, '20-add-dialog');

    // 填写表单：名称字段
    const nameInput = await browser.$($x(`input[contains(@placeholder,'写下观察')]`));
    await nameInput.waitForDisplayed({ timeout: 10000 });
    await nameInput.setValue(TEST_NAME);
    await browser.pause(500);

    // 说明字段（可选）
    const descInput = await browser.$($x(`textarea[contains(@placeholder,'说明')]`));
    if (await descInput.isDisplayed().catch(() => false)) {
      await descInput.setValue('E2E 自动化测试创建的观点，用于验证添加节点功能。');
      await browser.pause(500);
    }
    await screenshot(browser, shotsDir, '21-form-filled');

    // 提交
    const createBtn = await browser.$($x(`button[contains(.,'创建节点')]`));
    await createBtn.click();
    await browser.pause(3000);
    await screenshot(browser, shotsDir, '22-after-create');

    // ---- 3. 验证事件追加 ----
    note('3/5 验证事件追加');
    const afterEvents = await getEventCount();
    note(`提交后事件数=${afterEvents}`);
    check('事件数+1', beforeEvents !== null && afterEvents === beforeEvents + 1);

    // ---- 4. 验证投影更新（读者视图能看到新节点） ----
    note('4/5 验证投影更新');
    await readerTab.click();
    await browser.pause(2000);

    // 搜索新节点
    const searchInput = await browser.$($x(`input[contains(@placeholder,'搜索')]`));
    if (await searchInput.isDisplayed().catch(() => false)) {
      await searchInput.setValue(TEST_NAME);
      await browser.pause(1500);
      await screenshot(browser, shotsDir, '30-search-new-node');
    }

    const foundNew = await browser.execute((name) => {
      return document.body.innerText.includes(name);
    }, TEST_NAME);
    check('读者视图显示新节点', foundNew);

    // ---- 5. 账本校验 ----
    note('5/5 账本校验');
    const ledgerBtn = await browser.$($x(`button[contains(.,'账本')]`));
    if (await ledgerBtn.isDisplayed()) {
      await ledgerBtn.click();
      await browser.pause(2000);
      await screenshot(browser, shotsDir, '40-ledger');
      const ledgerOk = await browser.execute(() => {
        const body = document.body.innerText;
        return !/校验异常|校验失败/.test(body) && /账本|事件链/.test(body);
      });
      check('账本无校验异常', ledgerOk);
      await browser.keys(['Escape']);
      await browser.pause(1000);
    }

    await screenshot(browser, shotsDir, '99-final');
    if (failures.length) throw new Error(`失败项: ${failures.join('; ')}`);
    console.log('[deepfunc] ALL PASS');
  } finally {
    await browser.deleteSession();
  }
}
