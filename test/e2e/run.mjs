// E2E 编排器：拉起 App（隔离数据目录 + 内嵌 WebDriver）→ 等待就绪 → 跑 spec → 收尾。
// 用法: node run.mjs <spec 文件路径>
// 环境变量:
//   MERIDIAN_REPO     仓库根目录（默认本文件向上两级）
//   MERIDIAN_APP      App 二进制路径（默认 $MERIDIAN_REPO/src-tauri/target/debug/meridian）
//   TAURI_WEBDRIVER_PORT  内嵌 WebDriver 端口（默认 4445）
//   MERIDIAN_DATA_DIR 测试账本目录（默认 /tmp/meridian-e2e-data，与真实账本隔离）
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MERIDIAN_REPO || path.resolve(__dirname, '../..');
const APP = process.env.MERIDIAN_APP || path.join(REPO, 'src-tauri/target/debug/meridian');
const PORT = Number(process.env.TAURI_WEBDRIVER_PORT || 4445);
const DATA_DIR = process.env.MERIDIAN_DATA_DIR || '/tmp/meridian-e2e-data';

const specFile = process.argv[2];
if (!specFile) {
  console.error('用法: node run.mjs <spec 文件路径>');
  process.exit(2);
}
if (!fs.existsSync(APP)) {
  console.error(`[e2e] App 二进制不存在: ${APP}（先在 src-tauri 下 cargo build）`);
  process.exit(2);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const shotsDir = path.join(__dirname, 'shots', runId);
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
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
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.pipe(logStream);
app.stderr.pipe(logStream);
app.on('error', (e) => console.error('[e2e] App 启动失败:', e.message));

async function waitForDriver(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (app.exitCode !== null && app.signalCode !== null) {
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
