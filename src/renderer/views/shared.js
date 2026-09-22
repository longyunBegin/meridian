export function confColor(c) {
  if (c < 30) return 'var(--red)'
  if (c < 60) return 'var(--orange)'
  return 'var(--green)'
}

/** 确信度连续渐变色：红(255,59,48) → 橙(255,149,0) → 绿(52,199,89) */
export function confColorContinuous(c) {
  const v = Math.max(0, Math.min(100, c))
  if (v < 50) {
    const t = v / 50
    return `rgb(255,${Math.round(59 + 90 * t)},${Math.round(48 - 48 * t)})`
  }
  const t = (v - 50) / 50
  return `rgb(${Math.round(255 - 203 * t)},${Math.round(149 + 50 * t)},${Math.round(89 * t)})`
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
