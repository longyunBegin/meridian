// E2E 编排器：拉起 App（隔离数据目录 + 内嵌 WebDriver）→ 等待就绪 → 跑 spec → 收尾。
// 用法: node run.mjs <spec 文件路径>
// 环境变量:
//   MERIDIAN_REPO     仓库根目录（默认本文件向上两级）
//   MERIDIAN_APP      App 二进制路径（自动探测平台 debug 输出）
//   TAURI_WEBDRIVER_PORT  内嵌 WebDriver 端口（默认 4445）
//   MERIDIAN_DATA_DIR 测试账本目录（默认每次新建唯一空目录；拒绝复用已有目录）
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MERIDIAN_REPO || path.resolve(__dirname, '../..');
const PORT = Number(process.env.TAURI_WEBDRIVER_PORT || 4445);
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const appCandidates = process.env.MERIDIAN_APP
  ? [path.resolve(process.env.MERIDIAN_APP)]
  : [
      path.join(REPO, 'src-tauri/target/debug/meridian'),
      path.join(REPO, 'src-tauri/target/x86_64-unknown-linux-gnu/debug/meridian'),
      path.join(REPO, 'src-tauri/target/aarch64-apple-darwin/debug/meridian'),
      path.join(REPO, 'src-tauri/target/aarch64-apple-ios/debug/meridian'),
    ];
const APP = appCandidates.find((candidate) => {
  try { return fs.statSync(candidate).isFile() } catch { return false }
});
const DATA_DIR = process.env.MERIDIAN_DATA_DIR
  ? path.resolve(process.env.MERIDIAN_DATA_DIR)
  : path.join(os.tmpdir(), `meridian-e2e-${runId}-${process.pid}`);

const specFile = process.argv[2];
if (!specFile) {
  console.error('用法: node run.mjs <spec 文件路径>');
  process.exit(2);
}
if (!APP) {
  console.error(`[e2e] 找不到 App 二进制，已检查: ${appCandidates.join(', ')}（先构建带 webdriver feature 的 debug App）`);
  process.exit(2);
}
const shotsDir = path.join(__dirname, 'shots', runId);
fs.mkdirSync(shotsDir, { recursive: true });
try {
  fs.mkdirSync(DATA_DIR, { recursive: false });
} catch (error) {
  console.error(`[e2e] 拒绝复用已有数据目录；每次运行必须使用全新空目录: ${DATA_DIR}`);
  process.exit(2);
}
const logFile = path.join(shotsDir, 'app.log');
const logStream = fs.createWriteStream(logFile);

console.log(`[e2e] runId=${runId}`);
console.log(`[e2e] App=${APP}`);
console.log(`[e2e] DATA_DIR=${DATA_DIR}（测试账本，与真实账本隔离）`);

const app = spawn(APP, [], {
  env: {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(PORT),
    MERIDIAN_DATA_DIR: DATA_DIR,
    MERIDIAN_USER_DATA_DIR: DATA_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.pipe(logStream);
app.stderr.pipe(logStream);
app.on('error', (e) => console.error('[e2e] App 启动失败:', e.message));

async function waitForDriver(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`App 进程已退出(${app.signalCode || app.exitCode})，见 ${logFile}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/status`);
      if (r.ok) {
        const j = await r.json();
        if (j.value && j.value.ready !== false) return;
      }
    } catch {
      /* 未就绪，继续等 */
    }
    await sleep(1000);
  }
  throw new Error(`WebDriver 服务 ${timeoutMs}ms 未就绪，见 ${logFile}`);
}

let failed = false;
try {
  await waitForDriver();
  console.log('[e2e] WebDriver 就绪，执行', specFile);
  const spec = await import(path.resolve(specFile));
  await spec.default({ port: PORT, shotsDir, repo: REPO, dataDir: DATA_DIR });
  console.log('[e2e] PASS');
} catch (e) {
  failed = true;
  console.error('[e2e] FAIL:', e.message);
} finally {
  app.kill('SIGTERM');
  await sleep(2500);
  if (app.exitCode === null) {
    try {
      app.kill('SIGKILL');
    } catch {}
  }
  console.log(`[e2e] 截图与日志: ${shotsDir}`);
  process.exit(failed ? 1 : 0);
}
