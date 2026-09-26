/**
 * 来源打标器。
 *
 * 这是整个产品里唯一必须可替换的模块：换打标器不触动抽取、存储和 UI。
 * 两种实现，按 settings.labeler 选择：
 *
 *   table —— 关键词启发式 + SOURCE_QUALITY 表裁决（默认，零依赖，永远可用）
 *   jev   —— Jev 的 Choice / Score / Noul（System One Model，只做判断不聊天）
 *
 * Jev 走原生协议：POST baseUrl 本体（不拼 /chat/completions），body 为
 * { model, state, questions }，回答在 answers 里直接是结构化数值，不需要
 * 从聊天文本里抠 JSON——以前按 OpenAI chat 协议打是错的，端点和协议都对不上。
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
 * Jev 打标。一次调用同时取三个原语（原生协议，一个请求里并行求值）：
 *   Choice —— 来源类型（封闭枚举：选项就是 KINDS，结构上不可能返回非法值）
 *   Score  —— 来源质量档位（只记 jevScore 做观测，业务质量分仍走表）
 *   Noul   —— 是否包含可独立成立的判断
 *
 * 请求打到 jevBaseUrl 本体：Jev 只有一个端点，不需要拼 /chat/completions。
 */
export async function jevLabel(settings, text) {
  const { jevBaseUrl, jevKey, jevModel } = settings
  if (!jevKey) return { ok: false, why: 'no-key' }
  if (!jevBaseUrl) return { ok: false, why: 'no-endpoint' }

  const state = String(text || '').slice(0, 3000)
  // Choice 的选项 key 直接用类型名：返回的 choice 就是 key，不用下标映射
  const kindCriteria = {}
  for (const k of KINDS) kindCriteria[k] = k

  let res
  try {
    res = await fetch(jevBaseUrl.replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jevKey}` },
      body: JSON.stringify({
        model: jevModel,
        state,
        questions: {
          kind: {
            type: 'choice',
            instructions: '判断这段文本属于哪种来源类型，只能从给定选项中选择最贴切的一个。',
            criteria: kindCriteria,
          },
          quality: {
            type: 'score',
            instructions: '这段文本作为信息来源，质量处于哪个档位？档位从低到高排列。',
            criteria: [
              '很低：营销号、群聊转发，未经核实的传闻',
              '较低：自媒体个人观点，有立场无实证',
              '中等：独立媒体报道，有采编流程',
              '较高：券商研报，有数据与逻辑支撑',
              '很高：财报公告、一手数据等官方披露',
            ],
          },
          noul: {
            type: 'noul',
            instructions: '这段文本是否包含可独立成立的判断（而非纯信息搬运）？',
            criteria: { true: '包含可独立成立的判断', false: '纯信息搬运，无独立判断' },
          },
        },
      }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (e) {
    return { ok: false, why: e?.name === 'TimeoutError' ? 'timeout' : 'network' }
  }
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }

  const usage = await readUsage(res)
  const body = await res.json().catch(() => null)
  const answers = body?.answers
  if (!answers || typeof answers !== 'object') return { ok: false, why: 'unparsable', usage }

  const choice = answers.kind?.choice
  const kind = KINDS.includes(choice) ? choice : tableLabel(text).kind
  // 类型定了，质量分回到表里取——不让模型直接给分
  return {
    ok: true,
    kind,
    quality: QUALITY.get(kind),
    jevScore: normalizeScore(answers.quality),
    noul: clamp01(Number(answers.noul?.noul)),
    via: 'jev',
    usage,
    model: body?.model || undefined, // 别名（如 jev-latest）解析成的真实版本
  }
}

/**
 * Score 回答是档位位置（可能落在档位之间），归一到 0–1 只做观测用。
 * 优先用服务端给的 normalized；没有就用 legend 的刻度自己归一；
 * 都没有回中性 0.5——错了也只影响 jevScore 这个观测值，不影响业务。
 */
function normalizeScore(answer) {
  const n = Number(answer?.normalized)
  if (Number.isFinite(n)) return clamp01(n)
  const s = Number(answer?.score)
  const keys = Object.keys(answer?.legend || {}).map(Number).filter((x) => Number.isFinite(x))
  if (Number.isFinite(s) && keys.length >= 2) {
    const lo = Math.min(...keys)
    const hi = Math.max(...keys)
    if (hi > lo) return clamp01((s - lo) / (hi - lo))
  }
  return 0.5
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
    }
  } catch {
    /* 打标失败不该阻塞捕获 */
  }
  const t = tableLabel(text)
  return { ok: true, kind: t.kind, quality: t.quality, via: 'table' }
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5)
