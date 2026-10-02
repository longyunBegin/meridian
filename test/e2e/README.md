# Meridian E2E 测试（`test/e2e`）

项目内的本地 Harness 使用 `tauri-plugin-wdio-webdriver`，在 **debug Tauri App 的真实原生 WebView** 中运行 W3C WebDriver。它直接运行于当前计算机，不需要配置或启动云 CI 服务。

## 前置条件

1. 当前平台已安装 Tauri/WebView 系统依赖；Linux 还需要可用的 WebKitGTK 与 WebDriver plugin。
2. 在仓库根目录构建含 WebDriver 的 debug App：

   ```bash
   cargo build --locked --features webdriver --manifest-path src-tauri/Cargo.toml
   ```

3. 启动前端开发服务器（默认 `127.0.0.1:1420`）：

   ```bash
   npm run dev -- --host 127.0.0.1 --port 1420
   ```

4. 安装项目依赖（仓库已有 `node_modules` 时不必重复安装）。

## 运行真实原生规格

```bash
node test/e2e/run.mjs test/e2e/specs/smoke.mjs
node test/e2e/run.mjs test/e2e/specs/product-navigation.mjs
node test/e2e/run.mjs test/e2e/specs/reader-builder-visual.mjs
```

`run.mjs` 自动寻找当前平台的 debug App；每次进程运行都会创建一个**新的、空的、唯一的合成数据目录**。默认放在系统临时目录；可以用 `MERIDIAN_DATA_DIR` 显式指定一个尚不存在的目录。若目录已存在，运行器会拒绝启动，不会覆盖、复用或从其它数据目录播种。测试环境同时设置 `MERIDIAN_DATA_DIR` 和 `MERIDIAN_USER_DATA_DIR`。不得提供个人账本或复制私人数据。

可选环境变量：

- `MERIDIAN_APP`：显式指定 WebDriver debug App 二进制。
- `MERIDIAN_DATA_DIR`：为本次运行指定全新的数据目录；必须尚不存在。
- `TAURI_WEBDRIVER_PORT`：WebDriver 端口，默认 `4445`。

截图和 App 日志写入 `test/e2e/shots/<runId>/`。不要将原生应用日志或本地测试数据提交到 Git。

## 原生规格

- `specs/smoke.mjs`：真实 App 启动与基础 Reader 冒烟。
- `specs/product-navigation.mjs`：今日/收件箱、数据源、读数和五个非设置审计路由。
- `specs/reader-builder-visual.mjs`：只用本次隔离数据创建合成主题、观点与证据；检查来源事件跳转，并捕获真实 Reader/Builder 窗口截图。

`specs/builder-desk.mjs` 是旧版种子数据用例，依赖既有 Sivers 主题，不属于当前空合成数据套件；不得用个人账本副本运行。它由隔离数据下的 `reader-builder-visual.mjs` 和 renderer fixtures 替代。

## Renderer feature fixtures

运行 `npm run test:renderer-features`，通过本地 Vite + Chromium 执行确定性的合成 bridge fixtures，覆盖 Builder 收件箱确认/驳回/追加式账本、Reader 时间线/比较/回放、墓碑与事件归档完整性、更新下载/取消/安装确认，以及今日、收件箱批处理、来源连接、读数详情和非设置审计路由。旧版 `theme-network-interaction.html` 依赖已移除的图谱编辑 DOM，不在 suite 中；当前创建/证据与 Reader 使用相应新版用例和原生视觉旅程。该 suite 是真实 renderer 集成测试，**不替代**上面的原生 WebView 测试。设置页不在本轮覆盖范围。
