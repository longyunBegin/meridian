import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function parseStableTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(tag))
  if (!match) throw new Error(`Only stable vMAJOR.MINOR.PATCH tags are supported: ${tag}`)
  return match.slice(1).map(Number)
}

export function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseStableTag(left)
  const b = Array.isArray(right) ? right : parseStableTag(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export function validateReleaseOrder({ tag, packageVersion, releases }) {
  const target = parseStableTag(tag)
  const expected = `v${packageVersion}`
  if (tag !== expected) throw new Error(`Release tag ${tag} must exactly match package version ${expected}`)
  if (!Array.isArray(releases)) throw new Error('Release list must be a JSON array')
  const stable = releases.filter((release) => !release.isDraft && !release.isPrerelease && release.tagName !== tag)
  for (const release of stable) {
    const current = parseStableTag(release.tagName)
    if (compareVersions(target, current) < 0) {
      throw new Error(`Refusing to publish ${tag}: stable release ${release.tagName} is newer`)
    }
  }
  return true
}

function main(args) {
  const value = (name) => {
    const index = args.indexOf(name)
    if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`)
    return args[index + 1]
  }
  const tag = value('--tag')
  const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
  const releases = JSON.parse(readFileSync(resolve(value('--releases')), 'utf8'))
  validateReleaseOrder({ tag, packageVersion: version, releases })
  console.log(`Release version ${tag} matches package SemVer and does not roll back the latest stable release`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('tools/validate-release-version.mjs')) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
