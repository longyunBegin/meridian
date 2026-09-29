import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configDir = resolve(root, 'src-tauri')
const config = JSON.parse(readFileSync(resolve(configDir, 'tauri.conf.json'), 'utf8'))
const resources = config.bundle.resources
for (const [source, destination] of Object.entries(resources)) {
  const sourcePath = resolve(configDir, source)
  assert.equal(isAbsolute(destination), false, `bundle destination must be relative: ${destination}`)
  assert.ok(destination.startsWith('sidecar/'), `sidecar resources must stay in a collision-free subdirectory: ${destination}`)
  const relativeToRoot = relative(root, sourcePath)
  assert.ok(relativeToRoot && !relativeToRoot.startsWith('..'), `resource path escapes the project: ${source}`)
  if (source === 'runtime/node.exe') {
    assert.match(readFileSync(resolve(root, 'tools/prepare-tauri-runtime.mjs'), 'utf8'), /join\(outputDir, 'node\.exe'\)/)
  } else {
    assert.ok(existsSync(sourcePath), `bundle resource source does not exist: ${sourcePath}`)
  }
}
assert.deepEqual(config.bundle.targets, ['dmg', 'nsis'])
assert.equal(config.version, JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version)
const cargoVersion = readFileSync(resolve(configDir, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1]
assert.equal(config.version, cargoVersion, 'Cargo version must match the app version')
console.log(`Tauri bundle config: ${Object.keys(resources).length} resources resolve; macOS DMG and Windows NSIS targets only`)
