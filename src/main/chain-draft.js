/**
 * 提案草稿生成：给一条收件箱条目起草"挂到认知链哪个段、参数怎么变"。
 * 只起草、不拍板——草稿存到条目上，由用户点"确认挂载"生效。
 * 走 OpenAI 兼容接口；没有 key 时调用方降级为手动起草。
 */
import { __testHooks } from './llmlog.js'

const SYSTEM = `你是一个严谨的研究助理。用户在跟踪某个主题的认知变化：他把主题拆成若干"认知段"（每个段一段一句话核心信息）。
现在来了一条新信息，你的任务是起草一份"挂载提案"：这条信息应该挂到哪个段、改变了哪个参数。

硬规则：
1. segmentName 优先选已有的段（下面会列出），实在没有合适的才建议新开段名。
2. coreInfo 必须是一句话，能让陌生人在 30 秒内复述这条变化。
3. 只写信息确实陈述或可直接推出的内容，禁止补充外部知识，禁止评价。
4. oldValue 是该参数在段里的旧值（不知道就填空字符串），newValue 是这条信息给出的新值。
5. falsifier 填"什么证据出现会推翻这个判断"，想不出来就填空字符串。
6. evidence 填一句话依据（信息来源 + 关键事实）。

只输出 JSON，不要 markdown 代码块，不要任何解释：
{"segmentName":"...","coreInfo":"...","oldValue":"...","newValue":"...","evidence":"...","falsifier":"..."}`

const USER = (item, segmentNames) =>
  `已有认知段：${segmentNames.length ? segmentNames.join('、') : '（还没有段）'}\n\n` +
  `新信息标题：${item.title || '（无）'}\n` +
  `新信息正文：\n"""\n${(item.text || item.raw || '').slice(0, 4000)}\n"""\n` +
  `信息来源：${item.provenance?.platform || item.source?.label || '未知'}`

const LLM_TIMEOUT_MS = 20000

function errorReason(e) {
  return e?.name === 'TimeoutError' ? 'timeout' : (e.message || String(e))
}

function parseDraft(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const d = JSON.parse(m[0])
    if (!d || typeof d !== 'object') return null
    return {
      segmentNames: d.segmentName ? [String(d.segmentName).trim()].filter(Boolean) : [],
      newSegmentName: '',
      coreInfo: String(d.coreInfo || '').trim(),
      oldValue: String(d.oldValue || '').trim(),
      newValue: String(d.newValue || '').trim(),
      evidence: String(d.evidence || '').trim(),
      falsifier: String(d.falsifier || '').trim(),
    }
  } catch { return null }
}

export async function generateChainDraft(settings, item, segmentNames = []) {
  const { baseUrl, apiKey, model } = settings || {}
  if (!apiKey) return { ok: false, reason: 'no-key' }
  if (__testHooks.run) return __testHooks.run('chainDraft', { settings, item, segmentNames })

  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(new Error('TimeoutError')), LLM_TIMEOUT_MS)
    const res = await fetch(`${String(baseUrl || '').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: USER(item, segmentNames) },
        ],
      }),
    }).finally(() => clearTimeout(t))

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content || ''
    const draft = parseDraft(text)
    if (!draft) return { ok: false, reason: 'parse-failed' }
    return {
      ok: true,
      draft: {
        ...draft,
        status: 'draft',
        createdBy: 'llm',
        createdAt: new Date().toISOString().slice(0, 10),
      },
    }
  } catch (e) {
    return { ok: false, reason: errorReason(e) }
  }
}
