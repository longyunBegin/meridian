import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const legacy = readFileSync(new URL('../src/main/preload.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../src/renderer/lib/tauri-bridge.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const methodNames = (source) => [...source.matchAll(/\b(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g)].map((match) => match[1])
const legacyNames = new Set(methodNames(legacy))
const bridgeNames = new Set(methodNames(bridge))
for (const name of legacyNames) assert.ok(bridgeNames.has(name), `Tauri bridge is missing legacy method ${name}`)

const channels = (source, method) => {
  const match = source.match(new RegExp(`${method}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*(?:ipcRenderer\\.invoke|call)\\('([^']+)'`))
  return match?.[1]
}
let preservedChannels = 0
for (const name of legacyNames) {
  if (name === 'readClipboard') {
    assert.match(bridge, /readClipboard:\s*\(\)\s*=>\s*readText\(/, 'clipboard now uses the native Tauri plugin')
    continue
  }
  if (name === 'openDataDir') {
    assert.match(bridge, /openDataDir:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?invoke\('legacy_data_dir'\)[\s\S]*?openPath\(path\)/)
    continue
  }
  if (name === 'openExternal') {
    assert.match(bridge, /openExternal:\s*async\s*\(url\)\s*=>\s*\{[\s\S]*?new URL\(url\)[\s\S]*?openUrl\(/)
    continue
  }
  if (channels(legacy, name)) preservedChannels++
  assert.equal(channels(bridge, name), channels(legacy, name), `${name} still routes to its original IPC channel`)
}
assert.match(html, /tauri-bootstrap\.js/)
assert.doesNotMatch(html, /src="\.\/app\.js"/)
console.log(`Tauri bridge compatibility: ${legacyNames.size} legacy methods, ${preservedChannels} IPC channels, and 3 native plugin replacements preserved`)
