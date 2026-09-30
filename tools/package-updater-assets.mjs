import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function projectVersion(projectRoot) {
  return JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version
}

function listFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function exactlyOne(files, description) {
  if (files.length !== 1) throw new Error(`Expected exactly one ${description}; found ${files.length}`)
  return files[0]
}

function copyRequired(source, destination) {
  if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
    throw new Error(`Missing or empty build artifact: ${source}`)
  }
  copyFileSync(source, destination)
}

export function packageUpdaterAssets({ projectRoot = defaultProjectRoot, platform, target, outputDir, version = projectVersion(projectRoot) }) {
  if (!['darwin', 'windows'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`)
  if (platform === 'darwin' && target !== 'aarch64-apple-darwin') throw new Error('macOS updater builds must target Apple Silicon (aarch64-apple-darwin)')
  if (platform === 'windows' && target !== 'x86_64-pc-windows-msvc') throw new Error('Windows updater builds must target x86_64-pc-windows-msvc')
  if (!outputDir) throw new Error('Missing output directory')

  const bundleRoot = resolve(projectRoot, 'src-tauri', 'target', target, 'release', 'bundle')
  if (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory()) throw new Error(`Tauri bundle output not found: ${bundleRoot}`)
  const output = resolve(outputDir)
  mkdirSync(output, { recursive: true })

  if (platform === 'darwin') {
    // Tauri writes the updater archive beside the .app in bundle/macos; the DMG has its own bundle/dmg directory.
    const macosDir = join(bundleRoot, 'macos')
    const dmgDir = join(bundleRoot, 'dmg')
    const archive = exactlyOne(listFiles(macosDir).filter((path) => basename(path).endsWith('.app.tar.gz')), 'macOS .app.tar.gz updater archive')
    const dmg = exactlyOne(listFiles(dmgDir).filter((path) => path.endsWith('.dmg')), 'Apple Silicon DMG installer')
    const archiveName = `Meridian_${version}_aarch64.app.tar.gz`
    copyRequired(archive, join(output, archiveName))
    copyRequired(`${archive}.sig`, join(output, `${archiveName}.sig`))
    const dmgName = `Meridian_${version}_aarch64.dmg`
    copyRequired(dmg, join(output, dmgName))
    return [archiveName, `${archiveName}.sig`, dmgName]
  }

  const nsisDir = join(bundleRoot, 'nsis')
  const installer = exactlyOne(listFiles(nsisDir).filter((path) => path.endsWith('.exe')), 'Windows NSIS installer')
  const installerName = `Meridian_${version}_x64-setup.exe`
  copyRequired(installer, join(output, installerName))
  copyRequired(`${installer}.sig`, join(output, `${installerName}.sig`))
  return [installerName, `${installerName}.sig`]
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return process.argv[index + 1]
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const assets = packageUpdaterAssets({
    platform: option('--platform'),
    target: option('--target'),
    outputDir: resolve(option('--output')),
  })
  console.log(`Packaged ${assets.join(', ')}`)
}
