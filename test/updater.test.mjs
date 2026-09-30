import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdaterManifest } from '../tools/create-updater-manifest.mjs'
import { compareVersions, validateReleaseOrder } from '../tools/validate-release-version.mjs'
import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  shouldAutoCheck,
  updateProgress,
} from '../src/renderer/lib/update-policy.js'

const now = 1_800_000_000_000
assert.equal(shouldAutoCheck(null, now), true, 'first launch should check')
assert.equal(shouldAutoCheck('not-a-time', now), true, 'corrupt stored timestamp should not block a check')
assert.equal(shouldAutoCheck(String(now - AUTO_UPDATE_CHECK_INTERVAL_MS + 1), now), false, 'checks less than 24h apart are throttled')
assert.equal(shouldAutoCheck(String(now - AUTO_UPDATE_CHECK_INTERVAL_MS), now), true, 'a check is due exactly at 24h')
assert.equal(shouldAutoCheck(String(now + 60_000), now), false, 'a future timestamp should avoid repeat checks after clock skew')
assert.deepEqual(updateProgress(25, 100), { downloaded: 25, total: 100, percent: 25 })
assert.deepEqual(updateProgress(150, 100), { downloaded: 150, total: 100, percent: 100 })
assert.deepEqual(updateProgress(1536, 0), { downloaded: 1536, total: null, percent: null })

const temp = mkdtempSync(join(tmpdir(), 'meridian-updater-'))
try {
  const version = '0.1.2'
  const mac = `Meridian_${version}_aarch64.app.tar.gz`
  const win = `Meridian_${version}_x64-setup.exe`
  const signatureFixture = (name, signedVersion = version) => Buffer.from(`untrusted comment: signature from minisign secret key\ntrusted comment: timestamp:1700000000\tfile:${name}\tversion:${signedVersion}\nRWT-test-signature-payload`).toString('base64')
  writeFileSync(join(temp, mac), 'mac updater archive')
  writeFileSync(join(temp, `${mac}.sig`), signatureFixture(mac))
  writeFileSync(join(temp, win), 'windows NSIS installer')
  writeFileSync(join(temp, `${win}.sig`), signatureFixture(win))
  const manifest = createUpdaterManifest({
    assetDir: temp,
    version,
    tag: 'v0.1.2',
    notes: '0.1.2 release notes',
    pubDate: '2026-09-30T08:00:00Z',
  })
  assert.equal(manifest.version, version)
  assert.equal(manifest.notes, '0.1.2 release notes')
  assert.equal(manifest.pub_date, '2026-09-30T08:00:00.000Z')
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64', 'windows-x86_64'])
  assert.equal(manifest.platforms['darwin-aarch64'].signature, readFileSync(join(temp, `${mac}.sig`), 'utf8').trim())
  assert.equal(manifest.platforms['darwin-aarch64'].url, `https://github.com/longyunBegin/meridian/releases/download/v0.1.2/${mac}`)
  assert.equal(manifest.platforms['windows-x86_64'].url, `https://github.com/longyunBegin/meridian/releases/download/v0.1.2/${win}`)
  assert.throws(() => createUpdaterManifest({ assetDir: temp, version, tag: 'v0.1.0' }), /must exactly match/)
  assert.throws(() => createUpdaterManifest({ assetDir: temp, version: '0.1.3', tag: 'v0.1.3' }), /Missing or empty updater artifact/)
  writeFileSync(join(temp, `${win}.sig`), signatureFixture(win, '0.1.0'))
  assert.throws(() => createUpdaterManifest({ assetDir: temp, version, tag: 'v0.1.2' }), /must be bound to release version 0\.1\.2/)
} finally {
  rmSync(temp, { recursive: true, force: true })
}

assert.equal(compareVersions('v0.1.1', 'v0.1.0'), 1)
assert.equal(compareVersions('v1.0.0', 'v0.9.9'), 1)
assert.equal(validateReleaseOrder({
  tag: 'v0.1.2',
  packageVersion: '0.1.2',
  releases: [{ tagName: 'v0.1.1', isDraft: false, isPrerelease: false }],
}), true)
assert.throws(() => validateReleaseOrder({
  tag: 'v0.1.2',
  packageVersion: '0.1.2',
  releases: [{ tagName: 'v0.2.0', isDraft: false, isPrerelease: false }],
}), /Refusing to publish/)
assert.throws(() => validateReleaseOrder({
  tag: 'v0.1.2',
  packageVersion: '0.1.1',
  releases: [],
}), /must exactly match/)
console.log('Updater policy, merged manifest, and release ordering tests passed')
