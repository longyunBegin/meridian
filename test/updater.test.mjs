import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdaterManifest } from '../tools/create-updater-manifest.mjs'
import { packageUpdaterAssets } from '../tools/package-updater-assets.mjs'
import { compareVersions, validateReleaseOrder } from '../tools/validate-release-version.mjs'
import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  shouldAutoCheck,
  updateProgress,
  updatePresentation,
  canPerformUpdateAction,
  canCloseUpdate,
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

const available = updatePresentation('available')
assert.equal(available.title, '有新版本')
assert.equal(available.primaryLabel, '下载更新')
assert.equal(available.primaryAction, 'download')
assert.equal(canPerformUpdateAction('available', 'download'), true)
assert.equal(canPerformUpdateAction('available', 'install'), false, 'an available update cannot skip download and go straight to install')
assert.equal(canCloseUpdate('available'), true, 'the user can dismiss an update offer')

const downloading = updatePresentation('downloading')
assert.equal(downloading.primaryDisabled, true)
assert.equal(downloading.canClose, false)
assert.equal(canPerformUpdateAction('downloading', 'install'), false, 'download completion is not install confirmation')
assert.equal(canCloseUpdate('downloading'), false, 'do not release an updater resource while its non-cancellable download is active')

const ready = updatePresentation('ready')
assert.equal(ready.title, '更新已准备好')
assert.equal(ready.primaryLabel, '重新启动以更新')
assert.equal(ready.primaryAction, 'install')
assert.equal(canPerformUpdateAction('ready', 'install'), true, 'only the explicit ready-state CTA may install')
assert.equal(canPerformUpdateAction('ready', 'download'), false)
assert.equal(canCloseUpdate('ready'), true, 'a ready update can be postponed without installation')

assert.equal(updatePresentation('error').primaryLabel, '重试下载')
assert.equal(canPerformUpdateAction('error', 'download'), true)
assert.equal(updatePresentation('error', { retryInstall: true }).primaryLabel, '重试安装')
assert.equal(canPerformUpdateAction('error', 'install', { retryInstall: true }), true)
assert.equal(canPerformUpdateAction('error', 'download', { retryInstall: true }), false)
assert.equal(canCloseUpdate('error'), true)

const cancelled = updatePresentation('cancelled')
assert.equal(cancelled.primaryAction, null)
assert.match(cancelled.description, /没有安装或重启/)
assert.equal(canPerformUpdateAction('cancelled', 'install'), false)
assert.equal(canCloseUpdate('cancelled'), true)

const temp = mkdtempSync(join(tmpdir(), 'meridian-updater-'))
try {
  const version = '0.1.3'
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
    tag: 'v0.1.3',
    notes: '0.1.3 release notes',
    pubDate: '2026-09-30T08:00:00Z',
  })
  assert.equal(manifest.version, version)
  assert.equal(manifest.notes, '0.1.3 release notes')
  assert.equal(manifest.pub_date, '2026-09-30T08:00:00.000Z')
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64', 'windows-x86_64'])
  assert.equal(manifest.platforms['darwin-aarch64'].signature, readFileSync(join(temp, `${mac}.sig`), 'utf8').trim())
  assert.equal(manifest.platforms['darwin-aarch64'].url, `https://github.com/longyunBegin/meridian/releases/download/v0.1.3/${mac}`)
  assert.equal(manifest.platforms['windows-x86_64'].url, `https://github.com/longyunBegin/meridian/releases/download/v0.1.3/${win}`)
  assert.throws(() => createUpdaterManifest({ assetDir: temp, version, tag: 'v0.1.1' }), /must exactly match/)
  assert.throws(() => createUpdaterManifest({ assetDir: temp, version: '0.1.4', tag: 'v0.1.4' }), /Missing or empty updater artifact/)
  writeFileSync(join(temp, `${win}.sig`), signatureFixture(win, '0.1.0'))
  assert.throws(() => createUpdaterManifest({ assetDir: temp, version, tag: 'v0.1.3' }), /must be bound to release version 0\.1\.3/)

  const tauriConfig = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true)
  assert.ok(tauriConfig.bundle.targets.includes('app'), 'macOS must build the updater-enabled app target as well as its DMG')
  assert.ok(tauriConfig.bundle.targets.includes('dmg'), 'the Apple Silicon DMG installer remains a release asset')

  const projectRoot = join(temp, 'macos-project')
  const buildRoot = join(projectRoot, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle')
  const macosDir = join(buildRoot, 'macos')
  const dmgDir = join(buildRoot, 'dmg')
  const outputDir = join(temp, 'normalized-macos-assets')
  mkdirSync(macosDir, { recursive: true })
  mkdirSync(dmgDir, { recursive: true })
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ version: '0.1.3' }))
  writeFileSync(join(macosDir, 'Meridian.app.tar.gz'), 'signed-updater-archive')
  writeFileSync(join(macosDir, 'Meridian.app.tar.gz.sig'), 'signature')
  writeFileSync(join(dmgDir, 'Meridian_0.1.3_aarch64.dmg'), 'dmg-installer')

  const macAssets = packageUpdaterAssets({
    projectRoot,
    platform: 'darwin',
    target: 'aarch64-apple-darwin',
    outputDir,
  })
  assert.deepEqual(macAssets, [
    'Meridian_0.1.3_aarch64.app.tar.gz',
    'Meridian_0.1.3_aarch64.app.tar.gz.sig',
    'Meridian_0.1.3_aarch64.dmg',
  ])
  for (const asset of macAssets) assert.ok(readFileSync(join(outputDir, asset)).length > 0, `${asset} should be copied and non-empty`)
  assert.equal(
    readFileSync(join(outputDir, 'Meridian_0.1.3_aarch64.dmg'), 'utf8'),
    'dmg-installer',
    'DMG must pass through byte-identical when hdiutil is unavailable (ULFO recompression is skipped, not failed)'
  )

  rmSync(join(macosDir, 'Meridian.app.tar.gz'))
  assert.throws(() => packageUpdaterAssets({
    projectRoot,
    platform: 'darwin',
    target: 'aarch64-apple-darwin',
    outputDir: join(temp, 'missing-archive-output'),
  }), /Expected exactly one macOS \.app\.tar\.gz updater archive; found 0/)
} finally {
  rmSync(temp, { recursive: true, force: true })
}

assert.equal(compareVersions('v0.1.1', 'v0.1.0'), 1)
assert.equal(compareVersions('v1.0.0', 'v0.9.9'), 1)
assert.equal(validateReleaseOrder({
  tag: 'v0.1.3',
  packageVersion: '0.1.3',
  releases: [{ tagName: 'v0.1.2', isDraft: false, isPrerelease: false }],
}), true)
assert.throws(() => validateReleaseOrder({
  tag: 'v0.1.3',
  packageVersion: '0.1.3',
  releases: [{ tagName: 'v0.2.0', isDraft: false, isPrerelease: false }],
}), /Refusing to publish/)
assert.throws(() => validateReleaseOrder({
  tag: 'v0.1.3',
  packageVersion: '0.1.2',
  releases: [],
}), /must exactly match/)
console.log('Updater packaging, policy, merged manifest, and release ordering tests passed')
