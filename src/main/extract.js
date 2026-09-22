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
