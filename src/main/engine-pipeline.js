import { createStatement } from './engine-statements.js'

const EXTRACT_SYSTEM = `抽取新闻中可核验的原子陈述。保留原文数字和单位；不得推断或补充。每条包含 subject、attribute、value、time_window、quote；没有明确时间时 time_window 必须为空字符串。quote 不超过40字。只输出 JSON：{"statements":[{"subject":"...","attribute":"...","value":"...","time_window":"...","quote":"..."}]}`
const CLASSIFY_SYSTEM = `将每条陈述分类为 hard、soft、relational 或 meta。hard=可直接核验事实；soft=观点/估计；relational=关系陈述，建议新命题；meta=关于信息本身的提示。不能确定时用 soft。只输出 JSON：{"types":[{"index":0,"type":"hard"}]}`
const MATCH_SYSTEM = `判断陈述与命题的语义、主体、时间是否匹配，字段必须为严格布尔值。如果陈述没有时间窗口，temporal=false 表示无法核实；不要因此丢弃语义及主体匹配的候选，而应标为需人工复核。如果时间明确且不匹配，则不返回该候选。score 必须为 0 到 1 的数字。只输出 JSON：{"matches":[{"proposition_index":0,"semantic":true,"subject":true,"temporal":true,"score":0.85,"reason":"..."}]}`
const ATTRIBUTE_SYSTEM = `判断陈述与命题的关系：supports、contradicts、derives、supersedes、related。返回 0 到 1 的 strength、reason，以及可选的 note：不超过 40 字的一句话备注，说明这条证据改变了哪一点；说不出就留空字符串。不要输出方向、性质、标签等分类字段——领域分类由用户和主题配置决定，不由模型规定。输出仅为待用户审阅的建议；任何分数都不能自动接受或追加事件。只输出 JSON：{"rel":"supports","strength":0.62,"reason":"...","note":"营收增长"}`
const TYPES = new Set(['hard', 'soft', 'relational', 'meta'])
const RELS = new Set(['supports', 'contradicts', 'derives', 'supersedes', 'related'])

async function callLLM(llmCall, system, user) {
  if (typeof llmCall !== 'function') throw new Error('缺少 LLM 调用函数')
  const text = await llmCall(system, user)
  const match = String(text || '').match(/\{[\s\S]*\}/)
  if (!match) throw new Error('LLM 未返回有效 JSON')
  try { return JSON.parse(match[0]) } catch { throw new Error('LLM 返回的 JSON 解析失败') }
}

export async function extractStatements(llmCall, { themeName, title, text, source, inboxId = null }) {
  const user = `主题：${themeName}\n标题：${title || '（无）'}\n正文：\n"""\n${String(text || '').slice(0, 4000)}\n"""\n来源：${source || '未知'}`
  const result = await callLLM(llmCall, EXTRACT_SYSTEM, user)
  const normalizedSource = String(text || '').replace(/\s+/g, ' ').trim()
  const statements = []
  for (const raw of Array.isArray(result.statements) ? result.statements : []) {
    try {
      const quote = String(raw.quote || '').trim()
      const statement = createStatement({ subject: raw.subject, attribute: raw.attribute, value: raw.value,
        timeWindow: raw.time_window, type: 'soft', sourceText: quote, inboxId })
      statement.sourceQuoteVerified = Boolean(quote && normalizedSource.includes(quote.replace(/\s+/g, ' ').trim()))
      statements.push(statement)
    } catch { /* keep malformed extraction out of the review queue */ }
  }
  return statements
}

export async function classifyStatements(llmCall, statements) {
  if (!statements.length) return statements
  const user = statements.map((s, i) => `${i}. [${s.subject}] ${s.attribute}=${s.value}（${s.timeWindow || '时间未注明'}）`).join('\n')
  const result = await callLLM(llmCall, CLASSIFY_SYSTEM, user)
  const byIndex = new Map()
  for (const item of Array.isArray(result.types) ? result.types : []) {
    if (Number.isSafeInteger(item?.index) && item.index >= 0 && item.index < statements.length && TYPES.has(item.type)) byIndex.set(item.index, item.type)
  }
  return statements.map((s, i) => byIndex.has(i)
    ? { ...s, type: byIndex.get(i), classificationMissing: false }
    : { ...s, type: 'soft', classificationMissing: true })
}

export async function matchPropositions(llmCall, statement, propositions) {
  if (!propositions.length) return []
  const user = `陈述：[${statement.subject}] ${statement.attribute}=${statement.value}（${statement.timeWindow || '时间未注明'}）\n命题：\n${propositions.map((p, i) => `${i}. ${p.title}（${p.status || '未知'}）`).join('\n')}`
  const result = await callLLM(llmCall, MATCH_SYSTEM, user)
  const timeKnown = Boolean(String(statement.timeWindow || '').trim())
  const matches = []
  for (const item of Array.isArray(result.matches) ? result.matches : []) {
    const index = item?.proposition_index
    if (!Number.isSafeInteger(index) || index < 0 || index >= propositions.length) continue
    /* Never coerce strings such as "false" to truthy flags. */
    if (item.semantic !== true || item.subject !== true) continue
    if (timeKnown && item.temporal !== true) continue
    const proposition = propositions[index]
    const score = Number.isFinite(item.score) ? Math.max(0, Math.min(1, item.score)) : 0
    matches.push({ propositionId: proposition.id, propositionTitle: proposition.title, score,
      reason: String(item.reason || ''), timeWindowKnown: timeKnown,
      requiresTemporalReview: !timeKnown, temporalMatched: item.temporal === true })
  }
  return matches
}

export async function attributeRelation(llmCall, statement, proposition) {
  const user = `陈述：[${statement.subject}] ${statement.attribute}=${statement.value}（${statement.timeWindow || '时间未注明'}，${statement.type}）\n命题：${proposition.title}`
  const result = await callLLM(llmCall, ATTRIBUTE_SYSTEM, user)
  if (!RELS.has(result.rel)) throw new Error(`LLM 返回了非法关系类型：${result.rel}`)
  if (!Number.isFinite(result.strength) || result.strength < 0 || result.strength > 1) throw new Error('LLM 返回的 strength 必须是 0 到 1 的数字')
  /* 备注是唯一保留的自由文本；旧响应的 change.themeTag 仅作为兼容回填。 */
  const note = String(result.note ?? result.change?.note ?? result.change?.themeTag ?? '').trim().slice(0, 200)
  return { rel: result.rel, strength: result.strength, reason: String(result.reason || '').trim(), change: { note } }
}

export function statementTitle(statement) {
  const subject = String(statement?.subject || '').trim()
  const attribute = String(statement?.attribute || '').trim()
  const value = String(statement?.value || '').trim()
  const time = String(statement?.timeWindow || '').trim()
  return [subject, `${attribute}：${value}${time ? `（${time}）` : ''}`].filter(Boolean).join(' ')
}

/** Injectable end-to-end pipeline. It produces recommendations and diagnostics only. */
export async function runEnginePipeline(llmCall, { themeName, title, text, source, inboxId, propositions = [] }) {
  const extracted = await extractStatements(llmCall, { themeName, title, text, source, inboxId })
  const statements = await classifyStatements(llmCall, extracted)
  const metaCount = statements.filter((s) => s.type === 'meta').length
  const metaMultiplier = Math.pow(0.85, metaCount)
  const results = []
  const diagnostics = []
  for (const statement of statements) {
    if (statement.type === 'meta') continue
    if (statement.classificationMissing) {
      diagnostics.push({ statement, reason: '分类响应缺失；已保守标为软事实，需人工检查' })
      continue
    }
    if (statement.type === 'relational') {
      results.push({ kind: 'new-proposition', statement, match: null, proposition: null,
        suggestedTitle: statementTitle(statement), attribution: { rel: 'related', strength: 1,
          reason: '关系陈述仅用于提出新命题，不自动建立既成关系。',
          change: { note: String(statement.attribute || '').trim().slice(0, 200) } },
        metaCount, metaMultiplier, requiresTemporalReview: !statement.timeWindow })
      continue
    }
    const matches = await matchPropositions(llmCall, statement, propositions)
    if (!matches.length) {
      diagnostics.push({ statement, reason: statement.timeWindow ? '未找到满足语义、主体和时间约束的命题' : '没有时间窗口；未静默丢弃，当前没有语义/主体匹配候选' })
      continue
    }
    for (const match of matches) {
      const proposition = propositions.find((p) => p.id === match.propositionId)
      if (!proposition) continue
      try {
        const attribution = await attributeRelation(llmCall, statement, proposition)
        results.push({ kind: 'evidence', statement, match, attribution, proposition,
          metaCount, metaMultiplier, requiresTemporalReview: match.requiresTemporalReview })
      } catch (error) {
        diagnostics.push({ statement, proposition, reason: error?.message || '归因建议无效' })
      }
    }
  }
  return { statements, results, diagnostics, metaCount, metaMultiplier, status: 'done' }
}
