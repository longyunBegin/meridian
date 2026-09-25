/**
 * 来源打标器。
 *
 * 这是整个产品里唯一必须可替换的模块：换打标器不触动抽取、存储和 UI。
 * 三种实现，按 settings.labeler 选择：
 *
 *   table —— 关键词启发式 + SOURCE_QUALITY 表裁决（默认，零依赖，永远可用）
 *   jev   —— Jev 的 Choice / Score / Noul（System One Model，只做判断不聊天）
 *   llm   —— 前沿模型打标（有 key 但没接 Jev 时的过渡）
 *
 * 硬约束：**质量分一律由 SOURCE_QUALITY 表裁决**，打标器只负责选类型。
 * 否则换一个模型，整条校准曲线的基准就漂移了。
 */
import { SOURCE_QUALITY } from './store.js'
import { readUsage } from './llmlog.js'

const KINDS = SOURCE_QUALITY.map(([k]) => k)
const QUALITY = new Map(SOURCE_QUALITY)

const RULES = [
  ['财报 / 公告', /财报|年报|季报|公告|招股|股东信|10-?[KQ]|业绩快报/i],
  ['一手数据', /我们跟踪|供应链|产业链调研|调研纪要|访谈|实测|内部数据|我们测算|草根/i],
  ['券商研报', /研报|中信|中金|海通|广发|招商|我们预计|目标价|评级|买入|增持/i],
  ['独立媒体', /据报道|据悉|彭博|路透|财新|华尔街日报|第一财经|记者/i],
  ['自媒体', /公众号|头条号|知乎|小红书|B\s?站|个人观点|笔者认为/i],
  ['群聊转发', /群里|转发|听说|有人讲|截图|小道消息|内部消息/i],
]

/** 零依赖兜底：关键词命中即归类，未命中按独立媒体处理。 */
export function tableLabel(text) {
  const t = String(text || '')
  for (const [kind, re] of RULES) if (re.test(t)) return { kind, quality: QUALITY.get(kind) }
  return { kind: '独立媒体', quality: QUALITY.get('独立媒体') }
}

/**
 * Jev 打标。一次调用同时取三个原语：
 *   Choice —— 来源类型（封闭枚举，结构上不可能返回非法值）
 *   Score  —— 来源质量 0–1
 *   Noul   —— 是否包含可独立成立的判断
 */
export async function jevLabel(settings, text) {
  const { jevBaseUrl, jevKey, jevModel } = settings
  if (!jevKey) return { ok: false, why: 'no-key' }

  const enumText = KINDS.map((k, i) => `${i + 1}.${k}`).join(' ')
  const res = await fetch(`${jevBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jevKey}` },
    body: JSON.stringify({
      model: jevModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是来源分类器。对给定文本输出三个判断，只输出 JSON，不要解释：' +
            '{"choice":枚举下标(整数),"score":0到1的小数,"noul":0到1的小数}。' +
            'choice 只能从下面这些里选：' + enumText,
        },
        { role: 'user', content: String(text).slice(0, 3000) },
      ],
    }),
  })
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }

  const usage = await readUsage(res)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  const parsed = parseJson(raw)
  if (!parsed) return { ok: false, why: 'unparsable', usage }

  const idx = Math.round(Number(parsed.choice))
  const kind = KINDS[idx - 1] || tableLabel(text).kind
  // 类型定了，质量分回到表里取——不让模型直接给分
  return {
    ok: true,
    kind,
    quality: QUALITY.get(kind),
    jevScore: clamp01(Number(parsed.score)),
    noul: clamp01(Number(parsed.noul)),
    via: 'jev',
    usage,
  }
}

/** 前沿模型打标：有 key 但没接 Jev 时的过渡路径 */
export async function llmLabel(settings, text) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, why: 'no-key' }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: `判断这段文字的来源类型，只能从这些里选一个：${KINDS.join('、')}。只输出类型名。` },
        { role: 'user', content: String(text).slice(0, 2000) },
      ],
    }),
  })
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
  const usage = await readUsage(res)
  const body = await res.json()
  const raw = (body?.choices?.[0]?.message?.content || '').trim()
  const kind = KINDS.find((k) => raw.includes(k)) || tableLabel(text).kind
  return { ok: true, kind, quality: QUALITY.get(kind), via: 'llm', usage }
}

/**
 * 统一入口：按设置选择打标器，失败一律静默降级到查表。
 *
 * 打标优先级（step 3）：通道元数据 > SOURCE_QUALITY 表 > 模型推断 > 关键词启发式
 * 前三层都不随模型漂移。channelMeta 是事实（从 arxiv 抓的就是一手数据），
 * 不是判断——由通道决定，不由模型猜。
 */
export async function labelSource(settings, text, channelMeta) {
  // 1) 通道元数据优先：由来源平台决定类型，质量分查表
  if (channelMeta?.kind && QUALITY.has(channelMeta.kind)) {
    return {
      ok: true,
      kind: channelMeta.kind,
      quality: QUALITY.get(channelMeta.kind),
      via: 'channel',
    }
  }

  try {
    if (settings.labeler === 'jev') {
      const r = await jevLabel(settings, text)
      if (r.ok) return r
    } else if (settings.labeler === 'llm') {
      const r = await llmLabel(settings, text)
      if (r.ok) return r
    }
  } catch {
    /* 打标失败不该阻塞捕获 */
  }
  const t = tableLabel(text)
  return { ok: true, kind: t.kind, quality: t.quality, via: 'table' }
}

function parseJson(raw) {
  if (!raw) return null
  const s = String(raw)
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5)
