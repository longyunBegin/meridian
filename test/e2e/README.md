# Meridian E2E 测试（test/e2e）

用"测试者"视角驱动真实 App 的自动化测试：`tauri-plugin-wdio-webdriver`
（仅 debug 构建）在应用内嵌入 W3C WebDriver 服务，测试脚本经 WebDriver
协议操作界面、断言、截图。macOS 下这是官方推荐路线（`tauri-driver`
直连不支持 macOS）。

## 组成

- `run.mjs` —— 编排器：拉起 App（`TAURI_WEBDRIVER_PORT` + `MERIDIAN_DATA_DIR`
  隔离账本）→ 等 WebDriver 就绪 → 跑 spec → 杀 App。截图与 `app.log`
  落在 `shots/<runId>/`。
- `lib/driver.mjs` —— 连接与常用 helper（等元素、截图）。
- `specs/` —— 测试用例，每个文件导出 `async function (ctx)`。

## 前置

1. Mac 上本分支已构建：`cd src-tauri && cargo build --features webdriver`
   （WebDriver 插件是 cargo feature，默认构建不含；release 构建永远不含）。
2. `cd test/e2e && npm install`。
3. 前端 dev server 在跑（`npm run dev`，默认 :1420），或 App 已打 release 包
   （release 构建不含 WebDriver 插件，只能测 debug）。

## 跑

```bash
cd test/e2e
node run.mjs specs/smoke.mjs          # 冒烟
node run.mjs specs/builder-desk.mjs   # 建设者工作台
```

## 约定

- 测试账本一律走 `MERIDIAN_DATA_DIR`（默认 `/tmp/meridian-e2e-data`），
  不碰 `~/Library/Application Support/脉络` 真实账本。
- 截图与日志是测试产物，不提交 git（见根 `.gitignore`）。
- 测试中允许按用例点确认按钮（用户已授权触碰置信度），跑在隔离账本上。
