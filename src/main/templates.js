/**
 * 主题骨架模板。
 *
 * 数据在 templates.json（按版本维护，产业链每季度都在变）。
 * 运行时读文件而不是 import，是为了之后能整体搬到用户数据目录、让用户自己改。
 *
 * 每个 path 上的节点可选挂 scaffold：
 *   answer     — 在这一层必须先回答的问题
 *   indicators — 要跟踪的指标及更新频率
 *   falsifier  — 什么信号出现，就说明这一层的判断错了
 */
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
    cache = { version: 0, templates: [] }
  }
  return cache
}

export const version = () => read().version

/** 列表用：只给 id / 名称 / 环节数 / 版本 */
export function list() {
  return read().templates.map((t) => ({
    id: t.id,
    name: t.name,
    version: t.version || '',
    count: t.nodes.length,
  }))
}

export function find(id) {
  return read().templates.find((t) => t.id === id) || null
}

export function channelPack(templateId) {
  const packs = read().channelPacks || {}
  return packs[templateId] || []
}

/** 按 "/" 路径把骨架铺成节点树，返回新建的根节点 id 列表。 */
export function instantiate(template, createBranch) {
  // 只有路径的终点才挂 scaffold——中间层是分组，不继承子层的问题。
  // 「上游·算力供给」该问什么，和「GPU · 加速卡」该问什么不是一回事。
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
