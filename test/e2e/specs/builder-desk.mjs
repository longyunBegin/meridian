// 建设者工作台（8aa3af7 单栏聚焦）功能测试 —— 像人一样从头走一遍。
// 前置：测试账本是真实账本的 /tmp 副本（含 Sivers / 光互连两个主题）。
import { connect, screenshot, waitVisible } from '../lib/driver.mjs';

const $x = (xp) => `//${xp}`;

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  const note = (s) => console.log('[builder]', s);
  try {
    await browser.pause(2500);

    // ---- 1. 进主题：侧栏点 Sivers ----
    note('步骤1：侧栏进入 Sivers 主题');
    const themeBtn = await waitVisible(
      browser,
      $x(`button[contains(@class,'theme-item') and contains(.,'Sivers')]`),
    );
    await themeBtn.click();
    await browser.pause(1500);
    await screenshot(browser, shotsDir, '10-theme-opened');

    // ---- 2. 切到建设者视图 ----
    note('步骤2：切换到建设者视图');
    const builderTab = await waitVisible(
      browser,
      $x(`button[contains(@class,'theme-view-tab') and contains(.,'建设者视图')]`),
    );
    await builderTab.click();
    const attentionSec = await waitVisible(browser, 'section.builder-attention', 30000);
    note('建设者视图已加载（.builder-attention 可见）');
    await screenshot(browser, shotsDir, '11-builder-view');

    // ---- 3. 需要关注区 ----
    note('步骤3：检查"需要关注"区');
    const titleEl = await browser.$('section.builder-attention h2.builder-section-title');
    const hasTitle = await titleEl.isExisting();
    const cards = await browser.$$('section.builder-attention button.builder-attention-card');
    note(`关注标题存在=${hasTitle}，卡片数=${cards.length}（期望 ≤5）`);
    if (hasTitle) note('标题文本=' + JSON.stringify(await titleEl.getText()));
    if (cards.length > 5) throw new Error(`需要关注卡片 ${cards.length} 张，超过上限 5`);
    await screenshot(browser, shotsDir, '12-attention');

    if (!cards.length) {
      note('无需要关注的命题：跳过卡片交互，检查空状态');
      await screenshot(browser, shotsDir, '13-empty-attention');
    } else {
      // ---- 4. 点第一张卡片 → 详情主舞台 ----
      const firstTitle = await cards[0].$('.builder-attention-title').getText();
      note(`步骤4：点第一张卡片「${firstTitle.slice(0, 24)}…」`);
      await cards[0].click();
      await browser.pause(1200);
      const detailTitle = await waitVisible(browser, 'section.builder-detail .cog-wb-detail-title');
      const detailText = await detailTitle.getText();
      note('详情标题=' + JSON.stringify(detailText.slice(0, 40)));
      if (!detailText.includes(firstTitle.slice(0, 12))) {
        throw new Error(`详情标题与卡片不符：卡片=${firstTitle.slice(0, 20)} 详情=${detailText.slice(0, 20)}`);
      }
      // 选中态
      const selCard = await browser.$('section.builder-attention button.builder-attention-card.is-selected');
      note('卡片选中态=' + (await selCard.isExisting()));
      await screenshot(browser, shotsDir, '14-detail-stage');

      // ---- 5. 内联归因：＋支持 → 填表 → 回车确认 ----
      note('步骤5：内联归因（＋支持 → 回车确认）');
      const beforeSupport = await browser
        .$('section.builder-detail .cog-wb-meta-counts b.is-support')
        .getText();
      note('确认前支持计数=' + beforeSupport);
      const supportBtn = await waitVisible(
        browser,
        $x(`section[contains(@class,'builder-detail')]//button[contains(.,'＋ 支持')]`),
      );
      await supportBtn.click();
      const form = await waitVisible(browser, 'section.builder-detail .inline-attr-form');
      note('内联表单已展开');
      await screenshot(browser, shotsDir, '15-attr-form');

      const textarea = await form.$('textarea');
      await textarea.setValue('E2E 测试证据：这是一条由自动化测试写入的佐证摘要，用于验证内联归因链路。');
      // 回车确认（Shift+回车换行；普通回车=确认）
      await browser.keys('Enter');
      await browser.pause(2000);
      const formGone = !(await browser.$('section.builder-detail .inline-attr-form').isExisting());
      note('回车后表单收起=' + formGone);
      if (!formGone) throw new Error('回车确认后表单未收起');
      await screenshot(browser, shotsDir, '16-attr-confirmed');

      const afterSupport = await browser
        .$('section.builder-detail .cog-wb-meta-counts b.is-support')
        .getText();
      note(`支持计数 ${beforeSupport} → ${afterSupport}`);
      if (Number(afterSupport) !== Number(beforeSupport) + 1) {
        throw new Error(`支持计数未 +1：${beforeSupport} → ${afterSupport}`);
      }
    }

    // ---- 6. 回归：读者视图 ----
    note('步骤6：回归读者视图');
    const readerTab = await waitVisible(
      browser,
      $x(`button[contains(@class,'theme-view-tab') and contains(.,'读者视图')]`),
    );
    await readerTab.click();
    await browser.pause(2500);
    const readerBody = await browser.$('.theme-view-host').getText();
    note('读者视图正文字符数=' + readerBody.length);
    if (!readerBody.length) throw new Error('读者视图空白（回归失败）');
    await screenshot(browser, shotsDir, '17-reader-regression');

    note('全部通过');
  } finally {
    await browser.deleteSession();
  }
}
