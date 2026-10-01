import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/chain-persistence')
const worker = join(ROOT, 'test/chain-persistence-worker.mjs')
rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
let passed = 0
const run = (backend, phase, dataDir) => {
  const result = spawnSync(process.execPath, [worker, backend, dataDir, phase], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  })
  if (result.status !== 0) {
    throw new Error(`${backend}/${phase} failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  const lines = result.stdout.trim().split('\n')
  const report = JSON.parse(lines.at(-1))
  assert.equal(report.ok, true)
  return report
}

try {
  for (const backend of ['json', 'sqlite']) {
    const dataDir = join(DATA, backend)
    mkdirSync(dataDir, { recursive: true })
    if (backend === 'sqlite') closeSync(openSync(join(dataDir, 'meridian.sqlite'), 'w'))
    const written = run(backend, 'write', dataDir)
    assert.equal(written.count, 3)
    const reopened = run(backend, 'read', dataDir)
    assert.equal(reopened.verified, true)
    assert.equal(reopened.legacyPreserved, true)
    passed += 1
    console.log(`  ok   ${backend.toUpperCase()}：同步批量追加、整批回滚、导入导出与进程重启恢复`)
  }
} finally {
  rmSync(DATA, { recursive: true, force: true })
}
console.log(`\n${passed} 个持久化后端通过，0 失败`)
