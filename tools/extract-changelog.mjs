#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本的章节内容，用于 Release notes。
 * 用法: node tools/extract-changelog.mjs --tag v0.1.4 --changelog CHANGELOG.md
 * 找不到对应版本时退出码为 1（调用方可回退到 GitHub 自动生成）。
 */
import { readFileSync } from 'node:fs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') args.tag = argv[++i]
    else if (argv[i] === '--changelog') args.changelog = argv[++i]
  }
  return args
}

const { tag, changelog = 'CHANGELOG.md' } = parseArgs(process.argv.slice(2))
if (!tag) {
  console.error('usage: extract-changelog.mjs --tag v0.1.4 [--changelog CHANGELOG.md]')
  process.exit(2)
}
const version = tag.replace(/^v/, '')

let text
try {
  text = readFileSync(changelog, 'utf8')
} catch {
  console.error(`changelog not found: ${changelog}`)
  process.exit(1)
}

// 匹配 "## v0.1.4" 开头，到下一个 "## " 为止的章节
const lines = text.split('\n')
const startRe = new RegExp(`^##\\s+v${version.replace(/\./g, '\\.')}(\\s|（|\\()`)
let start = -1
let end = lines.length
for (let i = 0; i < lines.length; i++) {
  if (start === -1) {
    if (startRe.test(lines[i])) start = i
  } else if (/^##\s+/.test(lines[i])) {
    end = i
    break
  }
}
if (start === -1) {
  console.error(`version section not found for ${tag} in ${changelog}`)
  process.exit(1)
}
process.stdout.write(lines.slice(start, end).join('\n').trim() + '\n')
