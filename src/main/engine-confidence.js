/**
 * 认知发动机 · 置信度更新（红区已批准，用户 2026-10-02 确认）。
 *
 * 公式（贝叶斯风格，边际递减，波普尔式证伪）：
 * - 支持：new = old + (1 - old) × strength × α
 * - 反驳：new = old - old × strength × β
 * 其中 α < β（反驳比支持更有力）。
 *
 * 参数（初始值，需数据校准）：
 * - α = 0.3（支持系数）
 * - β = 0.5（反驳系数）
 *
 * 注意：
 * - 这是确定性计算，不是 AI 判断。用户确认归因后，系统机械应用公式。
 * - 只有 supports/contradicts 触发更新；derives/supersedes/related 不直接改置信度。
 * - 每次更新追加 confidence.updated 事件，可审计。
 */

export const CONFIDENCE_ALPHA = 0.3
export const CONFIDENCE_BETA = 0.5

/**
 * 计算新的置信度。
 * @param {number|null} old 旧置信度（0-1，null 表示未评估）
 * @param {number} strength 证据强度（0-1）
 * @param {'supports'|'contradicts'} rel 关系类型
 * @returns {number|null} 新置信度（0-1），输入无效返回 null
 */
export function updateConfidence(old, strength, rel) {
  if (old == null || !Number.isFinite(old)) return null
  if (!Number.isFinite(strength)) return old
  const s = Math.max(0, Math.min(1, strength))
  const o = Math.max(0, Math.min(1, old))
  let next
  if (rel === 'supports') {
    next = o + (1 - o) * s * CONFIDENCE_ALPHA
  } else if (rel === 'contradicts') {
    next = o - o * s * CONFIDENCE_BETA
  } else {
    return o
  }
  return Math.max(0, Math.min(1, next))
}

/**
 * 根据证据类型估算强度。
 * 硬事实=1.0，软事实=0.7，有 URL 来源 +0.1（封顶 1.0）。
 */
export function estimateStrength({ isHardFact = false, hasUrl = false } = {}) {
  let s = isHardFact ? 1.0 : 0.7
  if (hasUrl) s = Math.min(1.0, s + 0.1)
  return s
}
