/**
 * 抽取：把一段原文变成可独立成立的命题。
 * 走 OpenAI 兼容接口；没有 key 时调用方降级为手工录入。
 */
import { readUsage, __testHooks } from './llmlog.js'

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

const LLM_TIMEOUT_MS = 15000
/** 骨架是一次性生成整棵树（3-5 层 × 每层 2-5 个环节，每个还带 answer/indicators/falsifier），
 *  输出量是其它调用的十倍以上。共用 15s 会稳定超时——实测三次全部卡在 15001-15010ms，
 *  结果每次都用兜底模板盖掉 LLM 真生成的结构，标签却生成了，看着像模型只干了一半。 */
const SKELETON_TIMEOUT_MS = 90000
/** 标签库要产 8-15 个标签、每个带 3-6 个中英同义词，输出量同样远超 15s 的舒适区。
 *  实测有一次正好卡在 15004ms 超时，而失败是静默的——用户只看到「骨架已生成」。 */
const LIBRARY_TIMEOUT_MS = 60000

function errorReason(e) {
  return e?.name === 'TimeoutError' ? 'timeout' : (e.message || String(e))
}

export async function extractLemmas(settings, text, branchHints = []) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key' }
  if (__testHooks.run) return __testHooks.run('extract', { settings, text, branchHints })

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
  const usage = await readUsage(res)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty', usage }

  const lemmas = parseLemmas(raw)
  if (!lemmas.length) return { ok: false, reason: 'unparsable', usage }
  return { ok: true, lemmas, usage }
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
  if (__testHooks.run) return __testHooks.run('socratic', { settings, lemma, context })

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
  const usage = await readUsage(res)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty', usage }

  const questions = parseQuestions(raw)
  if (!questions.length) return { ok: false, reason: 'unparsable', usage }
  return { ok: true, questions, usage }
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
  if (__testHooks.run) return __testHooks.run('themeTags', { settings, description })

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: THEME_TAGS_SYSTEM },
          { role: 'user', content: String(description).slice(0, 500) },
        ],
      }),
    })
  } catch (e) {
    return { ok: false, reason: errorReason(e) }
  }

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const usage = await readUsage(res)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty', usage }

  const tags = parseThemeTags(raw)
  if (!tags.length) return { ok: false, reason: 'unparsable', usage }
  return { ok: true, tags, usage }
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

// ----------------------------------------------------------------- tag library

const TAG_LIBRARY_SYSTEM = `你是一个领域分析专家。根据主题描述和环节树，生成该主题的专属标签库。

硬规则：
1. 产出 JSON 数组，不要 markdown 代码块，不要解释。
2. 每个标签是 {"name":"名称","synonyms":["同义词1","同义词2"],"threshold":0.6}
3. 8-15 个标签，不多不少。
4. name 是 2-8 字名词，是领域概念不是公司名。
5. synonyms 必须包含中英双语（3-6 个），覆盖常见说法。
6. threshold 默认 0.6，概念越窄阈值越高（具体产品名 0.7，宽泛概念 0.5），范围 [0.4, 0.85]。
7. 不要生成环节名本身（那是树，不是标签）。
8. 不要假设领域——任何主题都用同一套机制。

只输出 JSON 数组：`

export async function generateTagLibrary(settings, description, branchTitles = []) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key' }
  if (__testHooks.run) return __testHooks.run('tagLibrary', { settings, description, branchTitles })

  const userContent = `主题：${description}\n环节树标题：${branchTitles.join('、') || '（无）'}`
  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: TAG_LIBRARY_SYSTEM },
          { role: 'user', content: userContent.slice(0, 1000) },
        ],
      }),
    })
  } catch (e) {
    return { ok: false, reason: errorReason(e) }
  }

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const usage = await readUsage(res)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty', usage }

  const lib = parseTagLibrary(raw)
  if (!lib.length) return { ok: false, reason: 'unparsable', usage }
  return { ok: true, tagLibrary: lib, usage }
}

function parseTagLibrary(raw) {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((t) => t && typeof t.name === 'string' && t.name.trim())
      .slice(0, 15)
      .map((t) => ({
        id: 'tl_' + Math.random().toString(36).slice(2, 10),
        name: String(t.name).trim().slice(0, 30),
        synonyms: Array.isArray(t.synonyms)
          ? t.synonyms.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 10)
          : [],
        threshold: Math.max(0.4, Math.min(0.85, Number(t.threshold) || 0.6)),
        hits: 0,
        lastHitAt: null,
      }))
  } catch { return [] }
}

const CHANNEL_PICK_SYSTEM = `你是一个产业链数据源配置助手。根据主题描述，从给定的已验证通道库中选择相关通道。

硬规则：
1. 只能返回库中已有的 id，不能创建或修改通道配置。
2. 不相关时返回空数组，不要为了凑数而选择。
3. 只输出 JSON，不要 markdown 或解释。
4. 结构：{"channelIds":["id"]}`

export async function pickChannelsFromLibrary(settings, description, library) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key', channels: [] }
  if (!library.length) return { ok: true, channels: [] }
  if (__testHooks.run) return __testHooks.run('pickChannels', { settings, description, library })

  const candidates = library.map((ch) => ({
    id: ch.id,
    name: ch.name,
    fetch: ch.fetch,
    query: ch.query || null,
    metric: ch.metric || null,
    tags: ch.tags || [],
  }))

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: CHANNEL_PICK_SYSTEM },
          { role: 'user', content: `主题：${String(description).slice(0, 500)}\n\n已验证通道库：${JSON.stringify(candidates)}` },
        ],
      }),
    })
  } catch (e) {
    return { ok: false, reason: errorReason(e), channels: [] }
  }

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, channels: [] }
  const usage = await readUsage(res)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty', channels: [], usage }

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, reason: 'unparsable', channels: [], usage }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed.channelIds)) return { ok: false, reason: 'unparsable', channels: [], usage }
    const byId = new Map(library.map((ch) => [ch.id, ch]))
    const ids = [...new Set(parsed.channelIds.filter((id) => typeof id === 'string'))]
    return { ok: true, channels: ids.map((id) => byId.get(id)).filter(Boolean), usage }
  } catch {
    return { ok: false, reason: 'unparsable', channels: [], usage }
  }
}

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

function normalizeAnswers(answer) {
  if (Array.isArray(answer)) return answer.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 6)
  const text = String(answer || '').trim().slice(0, 200)
  return text ? [text] : []
}

export async function generateSkeleton(settings, description) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, reason: 'no-key' }
  if (__testHooks.run) return __testHooks.run('skeleton', { settings, description })

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(SKELETON_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SKELETON_SYSTEM },
          { role: 'user', content: String(description).slice(0, 2000) },
        ],
      }),
    })
  } catch (e) {
    return { ok: false, reason: errorReason(e) }
  }

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const usage = await readUsage(res)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, reason: 'empty', usage }

  const skeleton = parseSkeleton(raw)
  if (!skeleton) return { ok: false, reason: 'unparsable', usage }
  return { ok: true, skeleton, usage }
}

/** 模型不总按 schema 吐：标题可能叫 name/label，子层可能叫 sub/nodes，顶层可能直接是数组。
 *  这些都得认。认不出来才该降级——把一棵合法的树扔了换成上中下游，比解析失败更糟：
 *  用户看到的是「模型分析过了但只给了通用模板」，而事实是模型给的结构被我们丢了。 */
const TITLE_KEYS = ['title', 'name', 'label', 'stage']
const CHILD_KEYS = ['children', 'child', 'sub', 'subStages', 'nodes']

const pickTitle = (n) => {
  for (const k of TITLE_KEYS) {
    const v = n?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

const pickChildren = (n) => {
  for (const k of CHILD_KEYS) if (Array.isArray(n?.[k])) return n[k]
  return []
}

const pickRoots = (parsed) => {
  if (Array.isArray(parsed)) return parsed
  for (const k of ['roots', 'stages', 'tree', 'chain', 'skeleton', 'layers']) {
    if (Array.isArray(parsed?.[k])) return parsed[k]
  }
  return []
}

function normalizeScaffoldSpec(sc) {
  if (!sc) return null
  return {
    answer: normalizeAnswers(sc.answer),
    indicators: Array.isArray(sc.indicators)
      ? sc.indicators
        .map((i) => typeof i === 'string'
          ? { name: i, cadence: '季度' }
          : { name: String(i?.name || '').trim().slice(0, 60), cadence: normalizeCadence(i?.cadence) })
        .filter((i) => i.name)
        .slice(0, 5)
      : [],
    falsifier: String(sc.falsifier || '').trim().slice(0, 200) || null,
  }
}

/** 从模型回复里切出候选 JSON 片段：先对象后数组。
 *  顶层是数组时，对象切法会切到第一个元素身上——解析"成功"却只剩一个环节。
 *  所以两种切法都要试，谁真能给出 roots 用谁。 */
function skeletonCandidates(s) {
  const spans = []
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) spans.push(s.slice(a, b + 1))
  const a2 = s.indexOf('[')
  const b2 = s.lastIndexOf(']')
  if (a2 >= 0 && b2 > a2) spans.push(s.slice(a2, b2 + 1))
  return spans
}

export function parseSkeleton(raw) {
  const s = String(raw)
  const clean = (node) => ({
    title: pickTitle(node).slice(0, 50),
    propagation: Math.max(0, Math.min(1, Number(node.propagation) || 0.5)),
    stableId: Math.random().toString(36).slice(2, 10),
    scaffold: normalizeScaffoldSpec(node.scaffold),
    children: pickChildren(node).map(clean),
  })

  // 没标题的中间层直接穿透，孩子并进父级——不为一个空名的环节造一行
  const flatten = (nodes) => {
    const out = []
    for (const n of nodes) {
      if (!n.title) { out.push(...flatten(n.children)); continue }
      out.push({ ...n, children: flatten(n.children) })
    }
    return out
  }

  for (const span of skeletonCandidates(s)) {
    let parsed = null
    try { parsed = JSON.parse(span) } catch { continue }
    const rawRoots = pickRoots(parsed)
    if (!rawRoots.length) continue
    const roots = flatten(rawRoots.map(clean))
    if (roots.length) return { roots }
  }
  return null
}
