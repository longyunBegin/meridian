import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configDir = resolve(root, 'src-tauri')
const config = JSON.parse(readFileSync(resolve(configDir, 'tauri.conf.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
const resources = config.bundle.resources
for (const [source, destination] of Object.entries(resources)) {
  const sourcePath = resolve(configDir, source)
  assert.equal(isAbsolute(destination), false, `bundle destination must be relative: ${destination}`)
  assert.ok(destination.startsWith('sidecar/'), `sidecar resources must stay in a collision-free subdirectory: ${destination}`)
  const relativeToRoot = relative(root, sourcePath)
  assert.ok(relativeToRoot && !relativeToRoot.startsWith('..'), `resource path escapes the project: ${source}`)
  if (source === 'runtime/') {
    assert.equal(destination, 'sidecar/runtime/', 'the complete runtime directory must be recursively bundled')
    const prepareScript = readFileSync(resolve(root, 'tools/prepare-tauri-runtime.mjs'), 'utf8')
    assert.match(prepareScript, /copyMacOSNodeLibrary/)
    assert.match(prepareScript, /copyWindowsRuntimeDlls/)
  } else {
    assert.ok(existsSync(sourcePath), `bundle resource source does not exist: ${sourcePath}`)
  }
}
assert.ok(Object.hasOwn(resources, 'runtime/'), 'Tauri must bundle the whole generated runtime directory')
assert.deepEqual(config.bundle.targets, ['app', 'dmg', 'nsis'])
assert.equal(config.bundle.createUpdaterArtifacts, true, 'signed updater artifacts must be generated')
assert.equal(config.version, packageJson.version)
assert.equal(packageLock.version, config.version, 'npm lockfile version must match the app version')
assert.equal(packageLock.packages[''].version, config.version, 'npm lockfile root package must match the app version')
const cargoVersion = readFileSync(resolve(configDir, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1]
const cargoLockVersion = readFileSync(resolve(configDir, 'Cargo.lock'), 'utf8').match(/\[\[package\]\]\nname = "meridian"\nversion = "([^"]+)"/)?.[1]
assert.equal(config.version, cargoVersion, 'Cargo version must match the app version')
assert.equal(config.version, cargoLockVersion, 'Cargo lockfile package must match the app version')
assert.equal(config.version, '0.1.4', 'the release package and Tauri app version must be 0.1.4')
assert.match(config.plugins?.updater?.pubkey || '', /^dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6/)
assert.equal(config.plugins?.updater?.requireSignedVersion, true, 'the manifest version must match the signed updater artifact version')
assert.equal(config.plugins?.updater?.allowDowngrades, false, 'the updater must reject older releases')
assert.equal(config.bundle.windows?.allowDowngrades, false, 'the Windows installer must reject older versions')
assert.deepEqual(config.plugins?.updater?.endpoints, ['https://github.com/longyunBegin/meridian/releases/latest/download/latest.json'])
const capability = JSON.parse(readFileSync(resolve(configDir, 'capabilities/default.json'), 'utf8'))
assert.ok(capability.permissions.includes('updater:default'))
assert.ok(capability.permissions.includes('process:allow-restart'))
console.log(`Tauri bundle config: ${Object.keys(resources).length} resources resolve; complete runtime directory is recursively bundled`)
