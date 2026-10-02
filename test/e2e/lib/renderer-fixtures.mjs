import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium'

const FIXTURES = [
  { file: 'builder-intake-interaction.html', name: 'Builder / append-only ledger', complete: /data-fixture="pass"/, report: 'fixture-report' },
  { file: 'reader-engine-interaction.html', name: 'Reader / timeline, compare and playback', complete: /data-fixture="pass"/, report: 'fixture-report' },
  { file: 'vault-update-interaction.html', name: 'Vault / archive integrity and updater consent flow', complete: /id="fixture-report"[^>]*data-finished="true"/, report: 'fixture-report' },
  { file: 'product-surface-interaction.html', name: 'Product surfaces / inbox and non-settings routes', complete: /data-fixture="pass"/, report: 'fixture-report' },
]

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForServer(server, url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`Vite exited early with code ${server.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`Vite did not become ready at ${url}`)
}

function runChromium(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROMIUM, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      '--virtual-time-budget=60000', '--dump-dom', url,
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 70000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`Chromium exited with code ${code} (${signal || 'no signal'}):\n${stderr.slice(-5000)}\n${stdout.slice(-5000)}`))
      resolve({ stdout, stderr })
    })
  })
}

function decodeHtml(text) {
  return text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
}

export async function runRendererFixtures() {
  const port = await freePort()
  const server = spawn(process.execPath, [
    'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--config', 'vite.config.js',
  ], { cwd: ROOT, stdio: 'ignore' })
  const summary = []
  try {
    for (const fixture of FIXTURES) {
      try {
        const url = `http://127.0.0.1:${port}/fixtures/${fixture.file}`
        await waitForServer(server, url)
        const { stdout } = await runChromium(url)
        const reportRegex = new RegExp(`<pre\\b(?=[^>]*\\bid="${fixture.report}")[^>]*>([\\s\\S]*?)<\\/pre>`)
        const report = decodeHtml(stdout.match(reportRegex)?.[1] || '')
        const complete = fixture.complete.test(stdout)
        const passed = complete && !/\bFAIL\b/.test(report)
        console.log(`--- ${fixture.name} ---\n${report || '(no report body)'}\nResult: ${passed ? 'PASS' : 'FAIL'}`)
        summary.push({ name: fixture.name, passed, report })
      } catch (error) {
        const failure = error?.stack || String(error)
        console.error(`--- ${fixture.name} ---\nFAIL: ${failure.slice(-5000)}`)
        summary.push({ name: fixture.name, passed: false, report: failure })
      }
    }
  } finally {
    if (server.exitCode == null) server.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      delay(2000),
    ])
  }
  const failed = summary.filter((fixture) => !fixture.passed)
  assert.equal(failed.length, 0, `${failed.length} renderer fixture(s) failed: ${failed.map((fixture) => fixture.name).join(', ')}`)
  return summary
}
