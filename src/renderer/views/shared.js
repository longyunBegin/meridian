export function confColor(c) {
  if (c < 30) return 'var(--red)'
  if (c < 60) return 'var(--orange)'
  return 'var(--green)'
}

/** 确信度连续渐变色：红(255,59,48) → 橙(255,149,0) → 绿(52,199,89) */
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

/** 收件箱条目所属主题：抽取路由所用的主题。
 * 新数据直接记在条目 extractedThemeId 上；老数据从命题挂点反推
 * （合并类命题看 mergeInto）；都拿不到才回退到当前主题 id。 */
export function inferInboxThemeId(item, allNodes, currentThemeId) {
  if (item?.extractedThemeId) return item.extractedThemeId
  for (const lemma of item?.lemmas || []) {
    const node = allNodes.find((n) => n.id === (lemma.mergeInto || lemma.parentId))
    if (node?.themeId) return node.themeId
  }
  return currentThemeId
}

/** 多主题：返回条目的主题 ID 列表（向后兼容）。
 * 优先用 extractedThemeIds 数组；没有则从 extractedThemeId 推导单元素数组；
 * 再没有则从 lemma 挂点推导；最后回退到当前主题。 */
export function inferInboxThemeIds(item, allNodes, currentThemeId) {
  if (Array.isArray(item?.extractedThemeIds) && item.extractedThemeIds.length > 0) {
    return [...item.extractedThemeIds]
  }
  if (item?.extractedThemeId) return [item.extractedThemeId]
  const fromLemmas = new Set()
  for (const lemma of item?.lemmas || []) {
    const node = allNodes.find((n) => n.id === (lemma.mergeInto || lemma.parentId))
    if (node?.themeId) fromLemmas.add(node.themeId)
    if (lemma.mappedTopic) fromLemmas.add(lemma.mappedTopic)
  }
  if (fromLemmas.size > 0) return [...fromLemmas]
  return currentThemeId ? [currentThemeId] : []
}

/** 收件箱条目路由是否有效：每条非合并命题的挂点（建议挂点或用户手动改的挂点）
 * 都必须落在该条目主题的存活节点里，否则勾选/入库都要禁用。 */
export function inboxRouteValid(item, themeNodes, override = {}) {
  return (item.lemmas || []).every((lemma) => {
    if (lemma.action === 'merge') return true
    const parentId = override.parentId ?? lemma.parentId
    return !parentId || themeNodes.some((node) => node.id === parentId && node.status !== 'dead')
  })
}

/** 把选中的收件箱条目按可执行操作分组（今日收件箱分拣用）：
 *  importable: 已抽取、有命题、挂点在其主题下有效 → 可批量入库
 *  extractable: 未抽取 → 可批量抽取
 *  overrideOf(item, themeId) 返回该条目的手动调整 { parentId } */
