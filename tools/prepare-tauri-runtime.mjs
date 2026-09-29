import { copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error(`Tauri sidecar packaging requires Node.js >=22.13 (found ${process.versions.node})`)
}
const outputDir = join(root, 'src-tauri', 'runtime')
const output = join(outputDir, 'node.exe')
mkdirSync(outputDir, { recursive: true })
copyFileSync(process.execPath, output)
if (process.platform !== 'win32') chmodSync(output, 0o755)
console.log(`Prepared Node ${process.versions.node} (${process.platform}/${process.arch}) at ${output}`)
