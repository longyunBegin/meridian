export function confColor(c) {
  if (c < 30) return 'var(--red)'
  if (c < 60) return 'var(--orange)'
  return 'var(--green)'
}

export const TYPE_LABEL = { axiom: '公理', hypothesis: '假设', observation: '观测' }
export const TYPE_CLASS = { axiom: 'axiom', hypothesis: 'hypothesis', observation: 'observation' }
export const todayStr = () => new Date().toISOString().slice(0, 10)

export function nodePath(nodes, id) {
  const out = []
  let cur = nodes.find((n) => n.id === id)
  while (cur) {
    out.unshift(cur.title)
    cur = cur.parentId ? nodes.find((n) => n.id === cur.parentId) : null
  }
  return out.join(' / ')
}
