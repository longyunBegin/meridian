import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const root = resolve(new URL('..', import.meta.url).pathname)
const work = mkdtempSync(join(tmpdir(), 'meridian-tauri-'))
const dataDir = join(work, 'legacy-data')
mkdirSync(dataDir, { recursive: true })
const legacy = {
  version: 4,
  settings: {},
  themes: [{ id: 'legacy-theme', name: 'Legacy theme' }],
  nodes: [], verdicts: [], conflicts: [], feeds: [], inbox: [], traces: [],
  intakeEvents: [], readings: [], sources: [], researchNotes: [],
}
writeFileSync(join(dataDir, 'meridian.json'), JSON.stringify(legacy))
const token = 'test-only-sidecar-secret'
const child = spawn(process.execPath, [join(root, 'src/tauri/backend.mjs')], {
  cwd: root,
  env: { ...process.env, MERIDIAN_SIDECAR_TOKEN: token, MERIDIAN_USER_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text })
const lines = readline.createInterface({ input: child.stdout })
let resolveReady
const ready = new Promise((resolveReadyFn, reject) => { resolveReady = resolveReadyFn; setTimeout(() => reject(new Error(`sidecar startup timed out: ${stderr}`)), 20000).unref() })
lines.on('line', (line) => {
  try {
    const value = JSON.parse(line)
    if (value.ready && Number.isInteger(value.port)) resolveReady(value)
  } catch { /* stdout diagnostics may precede the readiness record */ }
})
child.once('exit', (code, signal) => { resolveReady(new Error(`sidecar exited (${code ?? signal}): ${stderr}`)) })

try {
  const { port } = await ready
  const base = `http://127.0.0.1:${port}`
  const post = (path, body = {}, auth = true) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-meridian-token': token } : {}) },
    body: JSON.stringify(body),
  })

  const unauthorized = await post('/invoke', { command: 'theme:all', args: [] }, false)
  assert.equal(unauthorized.status, 403, 'sidecar rejects requests without its per-run token')

  const themesResponse = await post('/invoke', { command: 'theme:all', args: [] })
  assert.equal(themesResponse.status, 200)
  const themes = (await themesResponse.json()).result
  assert.equal(themes[0]?.id, 'legacy-theme', 'existing meridian.json data stays readable')

  const statsResponse = await post('/invoke', { command: 'db:stats', args: [] })
  assert.equal(statsResponse.status, 200, 'domain stats command is callable')
  assert.ok((await statsResponse.json()).result)

  const unknown = await post('/invoke', { command: 'not-a-registered-command', args: [] })
  assert.equal(unknown.status, 404, 'only registered domain commands are exposed')

  const events = await post('/events')
  assert.equal(events.status, 200)
  assert.ok(Array.isArray(await events.json()))
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'meridian.json'), 'utf8')).themes[0].id, 'legacy-theme')
  console.log('Tauri sidecar integration: authenticated RPC, legacy JSON compatibility, and event polling passed')
} finally {
  child.kill('SIGTERM')
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit()
    const timer = setTimeout(resolveExit, 3000)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
  })
  lines.close()
  rmSync(work, { recursive: true, force: true })
}
