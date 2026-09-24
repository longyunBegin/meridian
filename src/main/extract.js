/**
 * 抽取：把一段原文变成可独立成立的命题。
 * 走 OpenAI 兼容接口；没有 key 时调用方降级为手工录入。
 */
const SYSTEM = `你是一个严谨的研究助理。从用户粘贴的原文中抽取「可独立成立的最小命题」。

硬规则：
1. 只抽取原文确实陈述或可直接推出的内容，禁止补充外部知识，禁止评价。
2. 每条命题必须能被判断真假；抽不出来就返回空数组。
3. type 只能取三值：
   - axiom    无需证明的公理 / 定义
   - hypothesis 待验证的假设 / 推断
   - observation 来自数据或事实的观测
4. confidence 是 0-100 的整数，仅依据原文信息的可靠程度设定，不要乐观。
5. parentHint 填这条命题最可能归属的产业环节名称（原文看不出来就填 null）。
6. tags 填 1-3 个跨领域也能复用的底层概念名（如：能源成本、半导体周期、美元流动性、
   反馈延迟、复利周期）。这是跨主题共同前提的来源，宁缺毋滥，没有就填空数组。
7. sourceKind 从这些里挑最接近的：财报/公告、一手数据、券商研报、独立媒体、自媒体、群聊转发、道听途说。

只输出 JSON 数组，不要 markdown 代码块，不要任何解释：
[{"title":"...","type":"observation","confidence":0,"parentHint":null,"tags":[],"sourceKind":"..."}]`

const USER = (text, branches) =>
  `原文：\n"""\n${text.slice(0, 6000)}\n"""\n\n` +
  (branches?.length ? `已有的产业链环节（归位时参考）：${branches.join('、')}\n\n` : '')

export async function extractLemmas(settings, text, branchHints = []) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key' }

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER(text, branchHints) },
      ],
    }),
  })

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty' }

  const lemmas = parseLemmas(raw)
  if (!lemmas.length) return { ok: false, reason: 'unparsable' }
  return { ok: true, lemmas }
}

function parseLemmas(raw) {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((x) => x && typeof x.title === 'string' && x.title.trim())
    .slice(0, 12)
    .map((x) => ({
      title: x.title.trim().slice(0, 200),
      type: ['axiom', 'hypothesis', 'observation'].includes(x.type) ? x.type : 'hypothesis',
      confidence: Math.max(0, Math.min(100, Math.round(Number(x.confidence) || 50))),
      parentHint: typeof x.parentHint === 'string' && x.parentHint.trim() ? x.parentHint.trim() : null,
      tags: Array.isArray(x.tags) ? x.tags.filter((t) => typeof t === 'string').slice(0, 3) : [],
      sourceKind: typeof x.sourceKind === 'string' ? x.sourceKind : null,
    }))
}
// ----------------------------------------------------------------- socratic

const SOCRATIC_SYSTEM = `你是一个苏格拉底式的研究助理。针对用户给出的命题，只提出追问，帮助用户检查该命题的边界条件、隐含假设和证伪可能。

硬规则：
1. 只输出问题，禁止输出陈述句、判断、建议或结论。
2. 每个问题必须指向一个具体的边界条件或隐含假设。
3. 最多 5 个问题，按从最重要到最次要排列。
4. 问题必须能用是/否或具体数值回答。

只输出 JSON 数组，不要 markdown 代码块，不要任何解释：
["问题1","问题2"]`

export async function socraticQuestions(settings, lemma, context = '') {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key' }

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SOCRATIC_SYSTEM },
        { role: 'user', content: `命题：${lemma}${context ? `\n\n上下文：${context}` : ''}` },
      ],
    }),
  })

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty' }

  const questions = parseQuestions(raw)
  if (!questions.length) return { ok: false, reason: 'unparsable' }
  return { ok: true, questions }
}

function parseQuestions(raw) {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr.filter((q) => typeof q === 'string' && q.trim()).slice(0, 5).map((q) => q.trim())
  } catch { return [] }
}
// ----------------------------------------------------------------- theme tags

const THEME_TAGS_SYSTEM = `你是一个产业链分析专家。根据用户给出的主题描述，生成 3-6 个中文标签。

硬规则：
1. 只要名词性标签，不要句子。
2. 优先行业、资产类别、市场。
3. 标签要能跨主题复用——「半导体」比「台积电」好，「美股」比「纳斯达克」好。
4. 3-6 个，不多不少。

只输出 JSON 数组，不要 markdown 代码块，不要任何解释：
["标签1","标签2"]`

export async function generateThemeTags(settings, description) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key' }

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: THEME_TAGS_SYSTEM },
        { role: 'user', content: String(description).slice(0, 500) },
      ],
    }),
  })

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty' }

  const tags = parseThemeTags(raw)
  if (!tags.length) return { ok: false, reason: 'unparsable' }
  return { ok: true, tags }
}

function parseThemeTags(raw) {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr.filter((t) => typeof t === 'string' && t.trim()).slice(0, 6).map((t) => t.trim())
  } catch { return [] }
}

// ----------------------------------------------------------------- skeleton

/**
 * 模型生成骨架：输入一句话描述 → 产出环节树 + 传导权重 + scaffold。
 * 这是 step 4 的核心：建树不再需要用户写标题，模型产出草稿态，用户裁剪。
 */
const SKELETON_SYSTEM = `你是一个产业链分析专家。根据用户的描述，生成一条产业链的环节树。

硬规则：
1. 产出 JSON，不要 markdown 代码块，不要解释。
2. 结构：{"roots":[{"title":"环节名","propagation":0.5,"scaffold":{"answer":"要回答的核心问题","indicators":[{"name":"指标名","cadence":"月|季度|年度|事件"}],"falsifier":"证伪信号"},"children":[...]}]}
3. 每条边带传导权重 propagation（0-1），上游 → 下游，权重越大传导越强。
4. 通常 3-5 层深度，每层 2-5 个环节。
5. scaffold.answer 是该环节要回答的核心问题，indicators 是按周期跟踪的指标数组（每项是 {name, cadence} 对象，cadence 只能是 月 / 季度 / 年度 / 事件 四选一），falsifier 是证伪信号。
6. 环节名称简洁（4-12 字），是产业环节不是公司名。

只输出 JSON：`

const VALID_CADENCES = ['周', '月', '季度', '半年', '年度', '事件']

function normalizeCadence(c) {
  const s = String(c || '').trim()
  return VALID_CADENCES.includes(s) ? s : '季度'
}

export async function generateSkeleton(settings, description) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key' }

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SKELETON_SYSTEM },
        { role: 'user', content: String(description).slice(0, 2000) },
      ],
    }),
  })

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty' }

  const skeleton = parseSkeleton(raw)
  if (!skeleton) return { ok: false, reason: 'unparsable' }
  return { ok: true, skeleton }
}

function parseSkeleton(raw) {
  const s = String(raw)
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const parsed = JSON.parse(s.slice(a, b + 1))
    if (!parsed || !Array.isArray(parsed.roots)) return null
    // 递归清理
    const clean = (node) => ({
      title: String(node.title || '').trim().slice(0, 50),
      propagation: Math.max(0, Math.min(1, Number(node.propagation) || 0.5)),
      stableId: Math.random().toString(36).slice(2, 10),
      scaffold: node.scaffold ? {
        answer: String(node.scaffold.answer || '').trim().slice(0, 200) || null,
        indicators: Array.isArray(node.scaffold.indicators)
          ? node.scaffold.indicators
            .map((i) => typeof i === 'string'
              ? { name: i, cadence: '季度' }
              : { name: String(i?.name || '').trim().slice(0, 60), cadence: normalizeCadence(i?.cadence) })
            .filter((i) => i.name)
            .slice(0, 5)
          : [],
        falsifier: String(node.scaffold.falsifier || '').trim().slice(0, 200) || null,
      } : null,
      children: Array.isArray(node.children) ? node.children.map(clean).filter((c) => c.title) : [],
    })
    return {
      roots: parsed.roots.map(clean).filter((r) => r.title),
    }
  } catch { return null }
}
