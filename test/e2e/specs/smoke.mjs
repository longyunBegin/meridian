// 冒烟测试：App 能起来、主窗口渲染出内容、能截图。
// 这是所有功能测试的前置门；跑通它才证明"控制链路"打通。
import { connect, screenshot, waitText } from '../lib/driver.mjs';

export default async function ({ port, shotsDir }) {
  const browser = await connect(port);
  try {
    await browser.pause(2500);
    const title = await browser.getTitle();
    console.log('[smoke] title =', JSON.stringify(title));

    // 主界面应渲染出实质内容（body 非空）
    const body = await waitText(browser, 'body');
    const text = await body.getText();
    console.log('[smoke] body 字符数 =', text.length);
    if (!text.length) throw new Error('页面 body 为空：前端未渲染');

    await screenshot(browser, shotsDir, '01-launch');

    // 窗口句柄存在（确实连上的是 App 主窗口）
    const handles = await browser.getWindowHandles();
    console.log('[smoke] window handles =', handles.length);
    if (!handles.length) throw new Error('没有可用的窗口句柄');

    console.log('[smoke] OK');
  } finally {
    await browser.deleteSession();
  }
}
