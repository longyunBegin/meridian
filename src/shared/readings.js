/**
 * 读数分组纯函数。主进程和渲染层共用，无副作用、无 I/O 依赖。
 */

/**
 * 按 metric 分组，找最新，排序。
 *
 * 返回 [{ metric, count, latest, items }]，items 已排序：
 * - 最新一条置顶（latest，按 at 比较，同 at 取后加的）
 * - 其余按 asOf 倒序，无 asOf 排最后
 */
export function groupReadings(readings) {
  const byMetric = new Map()
  for (const r of readings) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, [])
    byMetric.get(r.metric).push(r)
  }
  const groups = []
  for (const [metric, items] of byMetric) {
    const sorted = [...items].sort((a, b) => {
      if (a.asOf && b.asOf) return b.asOf.localeCompare(a.asOf)
      if (a.asOf) return -1
      if (b.asOf) return 1
      return 0
    })
    const latest = items.reduce((a, b) => (a.at > b.at ? a : b))
    const reordered = [latest, ...sorted.filter((r) => r !== latest)]
    groups.push({ metric, count: items.length, latest, items: reordered })
  }
  return groups
}