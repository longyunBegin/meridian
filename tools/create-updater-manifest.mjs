import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseStableVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value))
  if (!match) throw new Error(`Expected a stable SemVer version, received: ${value}`)
  return match.slice(1).map(Number)
}

function option(args, name, required = true) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) {
    if (required) throw new Error(`Missing ${name}`)
    return null
  }
  return args[index + 1]
}

function isNonemptyFile(path) {
  try {
    const info = statSync(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

function signatureAt(assetDir, filename, expectedVersion) {
  const path = resolve(assetDir, filename)
  if (basename(path) !== filename || !isNonemptyFile(path)) throw new Error(`Missing or empty signature asset: ${filename}`)
  const signature = readFileSync(path, 'utf8').trim()
  if (signature.length < 20 || /^https?:\/\//i.test(signature)) throw new Error(`Invalid signature contents in ${filename}`)
  const decoded = Buffer.from(signature, 'base64')
  if (decoded.toString('base64') !== signature) throw new Error(`Invalid base64 signature encoding in ${filename}`)
  // Tauri's minisign trusted comment stores tab-separated key:value fields; the final field may
  // be terminated by a NUL in the binary signature rather than a tab/newline.
  const signedVersions = [...decoded.toString('latin1').matchAll(/(?:^|\t)version:([0-9]+\.[0-9]+\.[0-9]+)(?![0-9.])/g)]
  if (signedVersions.length !== 1 || signedVersions[0][1] !== expectedVersion) {
    throw new Error(`Signature ${filename} must be bound to release version ${expectedVersion}`)
  }
  return signature
}

export function createUpdaterManifest({ assetDir, version, tag, notes = '', pubDate = new Date().toISOString(), baseUrl = 'https://github.com/longyunBegin/meridian/releases/download' }) {
  parseStableVersion(version)
  if (tag !== `v${version}`) throw new Error(`Release tag ${tag} must exactly match package version v${version}`)
  const root = resolve(assetDir)
  const macAsset = `Meridian_${version}_aarch64.app.tar.gz`
  const winAsset = `Meridian_${version}_x64-setup.exe`
  for (const filename of [macAsset, winAsset]) {
    const path = resolve(root, filename)
    if (basename(path) !== filename || !isNonemptyFile(path)) {
      throw new Error(`Missing or empty updater artifact: ${filename}`)
    }
  }

  const platforms = {
    'darwin-aarch64': {
      signature: signatureAt(root, `${macAsset}.sig`, version),
      url: `${baseUrl}/${tag}/${encodeURIComponent(macAsset)}`,
    },
    'windows-x86_64': {
      signature: signatureAt(root, `${winAsset}.sig`, version),
      url: `${baseUrl}/${tag}/${encodeURIComponent(winAsset)}`,
    },
  }
  const cleanNotes = String(notes || `Meridian v${version}`).trim()
  const date = new Date(pubDate)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid RFC 3339 publish date: ${pubDate}`)
  return {
    version,
    notes: cleanNotes,
    pub_date: date.toISOString(),
    platforms,
  }
}

function main(args) {
  const assets = option(args, '--assets')
  const tag = option(args, '--tag')
  const output = option(args, '--output')
  const notesFile = option(args, '--notes-file', false)
  const version = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version
  const notes = notesFile ? readFileSync(resolve(notesFile), 'utf8') : `Meridian v${version}`
  const manifest = createUpdaterManifest({ assetDir: assets, version, tag, notes })
  writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  console.log(`Validated merged updater manifest v${version}: darwin-aarch64 + windows-x86_64`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
