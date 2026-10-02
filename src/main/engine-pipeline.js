/**
 * 认知发动机 · 四步流水线（抽取→分类→匹配→归因）。
 *
 * 第五步"更新"（置信度公式）是红区，需书面评审，本模块不实现。
 * 前四步走 LLM，每一步输出结构化 JSON，存到收件箱条目上。
 *
 * 流程：
 * 1. extract: 新闻 → 原子陈述[]
 * 2. classify: 陈述 → 类型标注
 * 3. match: 陈述 × 命题 → 三维匹配
 * 4. attribute: 陈述 × 命题 → 五种关系
 *
 * 人机分工：
 * - 系统做前四步，给出建议
 * - 人做确认（归因确认在 UI 层）
 */
import { createStatement, validateStatement } from './engine-statements.js'

/* Prompt 模板（从 docs/engine-prompts.md 加载，内联以避免文件依赖） */
const EXTRACT_SYSTEM = `你是严谨的信息抽取助手。用户在跟踪某个主题的认知变化。
你的任务：把一篇新闻拆成"原子陈述"——最小可验证单元。

拆分标准（只有一条）：任何两个数字、事件、判断，如果可以被独立验证或反驳，就必须拆开。

每个陈述必须包含四个属性：
- subject（主体）：这条陈述说的是谁/什么
- attribute（属性）：主体的哪个方面
- value（值）：具体数值或内容
- time_window（时间窗口）：如 "2026Q2"、"2026H2"、"2027年前"；没有明确时间的填 ""

硬规则：
1. 只写新闻确实陈述的内容，禁止补充外部知识，禁止评价，禁止推断
2. 数字必须原样保留（单位、精度都不改）
3. 每条陈述附上原文片段（quote），不超过 40 字

只输出 JSON，不要 markdown 代码块，不要任何解释：
{"statements":[{"subject":"...","attribute":"...","value":"...","time_window":"...","quote":"..."}]}`

const CLASSIFY_SYSTEM = `你是严谨的信息分类助手。输入是一批原子陈述，你的任务：给每条陈述定类型。

四种类型：
- hard（硬事实）：可直接验证的数值、事件、日期。权重最高，可直接归因。
- soft（软事实）：观点、预测、估计。不能直接验证，权重取决于来源可靠性。
- relational（关系陈述）："A 导致 B"、"A 与 B 相关"。不直接支持/反驳命题，而是催生新命题。
- meta（元陈述）：关于信息本身的说明。不改变命题置信度，但改变其他证据的权重。

只输出 JSON：
{"types":[{"index":0,"type":"hard","reason":"..."}]}`

const MATCH_SYSTEM = `你是严谨的语义匹配助手。输入：一条原子陈述 + 主题的命题列表。
你的任务：判断这条陈述与哪些命题相关。

三个维度（都过才有资格进入归因）：
- semantic（语义）：陈述和命题说的是不是同一件事？不要求字面相似，要判断是否在因果链或时间链上。
- subject（主体）：陈述里的主体和命题里的主体是否一致？
- temporal（时间）：陈述的时间窗口是否落在命题的时间范围内？

只输出 JSON：
{"matches":[{"proposition_index":0,"semantic":true,"subject":true,"temporal":true,"score":0.85,"reason":"..."}]}`

const ATTRIBUTE_SYSTEM = `你是严谨的归因判断助手。输入：一条陈述 + 一个命题。
你的任务：判断这条陈述与命题的关系类型。

五种关系：
- supports（支持）：证据增加了命题成立的可能性
- contradicts（反驳）：证据降低了命题成立的可能性
- derives（衍生）：证据比命题更窄/更具体，催生子命题
- supersedes（取代）：证据表明原命题假设错了，需要重写
- related（相关）：有关联但不明确，不进置信度计算

判断标准：
- 证据与命题预测方向一致 → supports
- 方向相反 → contradicts
- 证据更窄/更具体 → derives

只输出 JSON：
{"rel":"supports","strength":0.62,"reason":"..."}`

/**
 * 调用 LLM（通过现有的 llm 接口）。
 * @param {string} system System prompt
 * @param {string} user User prompt
 * @returns {Promise<object>} 解析后的 JSON
 */
async function callLLM(llmCall, system, user) {
  const text = await llmCall(system, user)
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) throw new Error('LLM 未返回有效 JSON')
  try {
    return JSON.parse(m[0])
  } catch {
    throw new Error('LLM 返回的 JSON 解析失败')
  }
}

/**
 * Step 1: 抽取原子陈述。
 */
export async function extractStatements(llmCall, { themeName, title, text, source }) {
  const user = `主题：${themeName}\n\n新闻标题：${title || '（无）'}\n\n新闻正文：\n"""\n${(text || '').slice(0, 4000)}\n"""\n\n信息来源：${source || '未知'}`
  const result = await callLLM(llmCall, EXTRACT_SYSTEM, user)
  const statements = []
  for (const s of result.statements || []) {
    try {
      statements.push(createStatement({
        subject: s.subject,
        attribute: s.attribute,
        value: s.value,
        timeWindow: s.time_window,
        type: 'hard', // 先默认，分类步骤会修正
        sourceText: s.quote || '',
      }))
    } catch (e) {
      // 跳过无效陈述，继续处理其他的
      console.warn('跳过无效陈述:', e.message)
    }
  }
  return statements
}

/**
 * Step 2: 分类陈述类型。
 */
export async function classifyStatements(llmCall, statements) {
  if (!statements.length) return statements
  const user = `陈述列表：\n${statements.map((s, i) =>
    `${i}. [${s.subject}] ${s.attribute} = ${s.value}（${s.timeWindow}）`
  ).join('\n')}`
  const result = await callLLM(llmCall, CLASSIFY_SYSTEM, user)
  const typeByIndex = new Map((result.types || []).map((t) => [t.index, t.type]))
  return statements.map((s, i) => {
    const type = typeByIndex.get(i)
    if (type && ['hard', 'soft', 'relational', 'meta'].includes(type)) {
      return { ...s, type }
    }
    return s
  })
}

/**
 * Step 3: 匹配命题。
 */
export async function matchPropositions(llmCall, statement, propositions) {
  if (!propositions.length) return []
  const user = `陈述：[${statement.subject}] ${statement.attribute} = ${statement.value}（${statement.timeWindow}）\n\n命题列表：\n${propositions.map((p, i) =>
    `${i}. ${p.title}（状态：${p.status || '未知'}）`
  ).join('\n')}`
  const result = await callLLM(llmCall, MATCH_SYSTEM, user)
  return (result.matches || [])
    .filter((m) => m.semantic && m.subject && m.temporal)
    .map((m) => ({
      propositionId: propositions[m.proposition_index]?.id || null,
      propositionTitle: propositions[m.proposition_index]?.title || '',
      score: Math.max(0, Math.min(1, Number(m.score) || 0)),
      reason: m.reason || '',
    }))
    .filter((m) => m.propositionId)
}

/**
 * Step 4: 判断归因关系。
 */
export async function attributeRelation(llmCall, statement, proposition) {
  const user = `陈述：[${statement.subject}] ${statement.attribute} = ${statement.value}（${statement.timeWindow}，类型：${statement.type}）\n\n命题：${proposition.title}`
  const result = await callLLM(llmCall, ATTRIBUTE_SYSTEM, user)
  const rel = result.rel
  if (!['supports', 'contradicts', 'derives', 'supersedes', 'related'].includes(rel)) {
    throw new Error(`LLM 返回了非法关系类型：${rel}`)
  }
  return {
    rel,
    strength: Math.max(0, Math.min(1, Number(result.strength) || 0)),
    reason: String(result.reason || '').trim(),
  }
}
