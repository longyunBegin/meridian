
/**
 * 第 ② 层「观点地图」：让读者一眼看到"这主题的骨架 + 哪里空着"。
 *
 * 具象规则（口径写在图例里，全部由真实数据推导）
 * - 圆的大小 = **已表态来源条数**（支持+反对；挂载但未表态的不计入——两个数不同，图例里说清）；
 * - 圆的颜色 = **证据状况**（没有来源 / 单一来源 / 有争议 / 多来源一致），
 *   **不按强度**：confidence 为 null 表示"中性、还没有强度记录"，不是"强度 0"（Number(null) === 0 这个坑要避开）；
 * - 虚线圆 = 一个来源都还没有（= 缺口）；
 * - 连线 = 观点之间的已声明关系（用 RELATION_LABEL 说人话）。
 * 位置复用 layoutThemeNetwork（与关系图同一套布局），不新造布局算法。
 */

export const CLAIM_STATES = {
  none: { label: '没有来源', desc: '还没有任何已表态来源', color: 'var(--text-3)', dashed: true },
  single: { label: '单一来源', desc: '只有 1 家来源', color: 'var(--orange)', dashed: false },
  contested: { label: '有争议', desc: '同时收到支持与反对', color: 'var(--red)', dashed: false },
  settled: { label: '多来源一致', desc: '2 家以上来源，且没有反对', color: 'var(--green)', dashed: false },
}

export function claimStateOf({ support = 0, challenge = 0, sources = 0 } = {}) {
  if (support + challenge === 0) return 'none'
  if (support > 0 && challenge > 0) return 'contested'
  if (sources <= 1) return 'single'
  return 'settled'
}

/** 观点 → 证据状况（供地图与单条下钻共用，避免两处口径分叉）。 */
export function claimEvidenceStats(node, evidenceForNode) {
  let rows = null
  try { rows = evidenceForNode?.(node?.id) || null } catch { rows = null }
  const list = [...(rows?.supports || []), ...(rows?.against || []), ...(rows?.both || [])]
  const support = (rows?.supports?.length || 0) + (rows?.both?.length || 0)
  const challenge = (rows?.against?.length || 0) + (rows?.both?.length || 0)
  const labels = new Set(list
    .map((row) => String(row?.source?.provenance?.sourceLabel || row?.source?.sourceLabel || '').trim())
    .filter(Boolean))
  const sources = labels.size
  return { support, challenge, sources, stated: list.length, state: claimStateOf({ support, challenge, sources }) }
}
