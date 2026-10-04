/* 精简后：只保留 chain.js 使用的 DIRECTION_META / NATURE_META，其余 15+ 个导出零引用已删除。 */
export const DIRECTION_META = {
  improving: { label: '好转', color: 'var(--green)', icon: '↑' },
  declining: { label: '恶化', color: 'var(--red)', icon: '↓' },
  stable: { label: '稳定', color: 'var(--text-3)', icon: '→' },
  undetermined: { label: '待观察', color: 'var(--text-3)', icon: '·' },
}
export const NATURE_META = {
  quantitative: { label: '量变', icon: '·' },
  pivot: { label: '质变', icon: '⇄' },
  epistemic: { label: '认识', icon: '◉' },
  structural: { label: '结构', icon: '⑂' },
}
