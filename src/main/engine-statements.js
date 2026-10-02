/**
 * 认知发动机 · 原子陈述数据模型。
 *
 * 五步中的第一步：从外部信息抽取原子陈述。
 * 拆分标准：任何两个数字、事件、判断，如果可以被独立验证或反驳，就必须拆开。
 *
 * 每个陈述带四个属性（决定它后面能匹配上什么命题）：
 * - subject: 主体（如"光子业务"）
 * - attribute: 属性（如"Q2营收占比"）
 * - value: 值（如"28%"）
 * - timeWindow: 时间窗口（如"2026Q2"）
 *
 * 四种类型（决定陈述在后续流程里能做什么）：
 * - hard: 硬事实。可直接验证的数值、事件、日期。权重最高。
 * - soft: 软事实。观点、预测、估计。权重取决于来源。
 * - relational: 关系陈述。"A导致B"。催生新命题。
 * - meta: 元陈述。关于信息本身，不改变置信度，但改变其他证据权重。
 */

export const STATEMENT_TYPES = ['hard', 'soft', 'relational', 'meta']

export const STATEMENT_TYPE_LABEL = {
  hard: '硬事实',
  soft: '软事实',
  relational: '关系陈述',
  meta: '元陈述',
}

/** 五种归因关系（用户定义）。 */
export const ATTRIBUTION_RELS = ['supports', 'contradicts', 'derives', 'supersedes', 'related']

export const ATTRIBUTION_REL_LABEL = {
  supports: '支持',
  contradicts: '反驳',
  derives: '衍生',
  supersedes: '取代',
  related: '相关',
}

/**
 * 验证原子陈述结构。
 * @returns {string[]} 错误列表，为空表示有效。
 */
export function validateStatement(stmt) {
  const errors = []
  if (!stmt || typeof stmt !== 'object') return ['陈述必须是一个对象']
  if (!String(stmt.subject || '').trim()) errors.push('缺少主体')
  if (!String(stmt.attribute || '').trim()) errors.push('缺少属性')
  if (!String(stmt.value || '').trim()) errors.push('缺少值')
  if (!String(stmt.timeWindow || '').trim()) errors.push('缺少时间窗口')
  if (!STATEMENT_TYPES.includes(stmt.type)) errors.push(`类型必须是 ${STATEMENT_TYPES.join('/')} 之一`)
  return errors
}

/**
 * 创建原子陈述。
 */
export function createStatement({ subject, attribute, value, timeWindow, type, sourceText = '', inboxId = null }) {
  const stmt = {
    id: `stmt:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    subject: String(subject || '').trim(),
    attribute: String(attribute || '').trim(),
    value: String(value || '').trim(),
    timeWindow: String(timeWindow || '').trim(),
    type,
    sourceText: String(sourceText || '').trim(),
    inboxId,
    createdAt: new Date().toISOString(),
  }
  const errors = validateStatement(stmt)
  if (errors.length) throw new Error(`原子陈述无效：${errors.join('；')}`)
  return stmt
}

/**
 * 匹配结果结构。
 * 三个维度：语义、主体、时间。都过才有资格进入归因。
 */
export function createMatch(statementId, propositionId, { semantic, subject, temporal, score }) {
  return {
    statementId,
    propositionId,
    dimensions: {
      semantic: Boolean(semantic),
      subject: Boolean(subject),
      temporal: Boolean(temporal),
    },
    eligible: Boolean(semantic && subject && temporal),
    score: Math.max(0, Math.min(1, Number(score) || 0)),
  }
}

/**
 * 归因结果结构。
 */
export function createAttribution(statementId, propositionId, { rel, strength, reason }) {
  if (!ATTRIBUTION_RELS.includes(rel)) throw new Error(`关系类型必须是 ${ATTRIBUTION_RELS.join('/')} 之一`)
  return {
    statementId,
    propositionId,
    rel,
    strength: Math.max(0, Math.min(1, Number(strength) || 0)),
    reason: String(reason || '').trim(),
    createdAt: new Date().toISOString(),
  }
}
