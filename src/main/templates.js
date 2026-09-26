import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'templates.json')

let cache = null

function read() {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    cache = { version: 0, genericFallback: null, channelLibrary: [] }
  }
  return cache
}

export const version = () => read().version
export const genericFallback = () => read().genericFallback

export function instantiate(template, createBranch) {
  const terminal = new Map()
  for (const spec of template.nodes) {
    if (spec.scaffold) terminal.set(spec.path.split('/').filter(Boolean).join('/'), spec.scaffold)
  }

  const byPath = new Map()
  const roots = []

  for (const spec of template.nodes) {
    const parts = spec.path.split('/').filter(Boolean)
    let parentId = null

    parts.forEach((part, i) => {
      const acc = parts.slice(0, i + 1).join('/')
      if (byPath.has(acc)) {
        parentId = byPath.get(acc)
        return
      }
      const node = createBranch({
        kind: 'branch',
        title: part.trim(),
        parentId,
        propagation: 0.6,
        scaffold: terminal.get(acc) || null,
      })
      byPath.set(acc, node.id)
      if (i === 0) roots.push(node.id)
      parentId = node.id
    })
  }
  return roots
}
