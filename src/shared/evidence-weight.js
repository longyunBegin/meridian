/**
 * 外部数据的权重：这条数据能把原子的强度推动多少（主进程与渲染层共用，规则只写这一处）。
 *
 *   权重 = 来源类型分 × 硬度系数
 *
 * - 来源类型分：SOURCE_QUALITY 表裁决（全产品唯一的来源质量基准，打标器也只负责选类型、不改分）。
 * - 硬度系数：硬数据（引文里有具体数字）1.0，观点 / 叙述 0.7——与引擎强度公式里的硬 / 软口径一致。
 * - 权重只在佐证 / 反对时进入强度公式（engine-confidence.updateConfidence 的 strength）；中立 / 不相关不推动强度。
 * - 数据进主题时按规则给出建议（来源类型优先看域名，其次看打标结果，再看来源名与原文里的关键词，最后按独立媒体）；
 *   判的时候人可以改来源类型 / 硬度，权重随之重算——落账的永远是 { 来源类型, 硬度 }，分值由本模块重算，不信任外部传入的数值。
 */

import { evidenceSourceUrl } from './evidence-source.js'

export const SOURCE_QUALITY = [
  ['财报 / 公告', 0.95],
  ['一手数据', 0.9],
  ['券商研报', 0.8],
  ['独立媒体', 0.65],
  ['自媒体', 0.5],
  ['群聊转发', 0.35],
  ['道听途说', 0.2],
]
export const SOURCE_TYPES = SOURCE_QUALITY.map(([type]) => type)
export const DEFAULT_SOURCE_TYPE = '独立媒体'
const QUALITY = new Map(SOURCE_QUALITY)

export const HARDNESS = Object.freeze({
  hard: Object.freeze({ label: '硬数据', factor: 1 }),
  soft: Object.freeze({ label: '观点 / 叙述', factor: 0.7 }),
})
export const HARDNESS_ORDER = ['hard', 'soft']

/** 域名 → 来源类型。命中即归类（域名是事实，不是判断）；子域名同样命中。 */
export const SOURCE_DOMAIN_TYPES = [
  ['arxiv.org', '一手数据'],
  ['mp.weixin.qq.com', '自媒体'],
  ['wechat.com', '自媒体'],
  ['eastmoney.com', '财报 / 公告'],
  ['cninfo.com.cn', '财报 / 公告'],
  ['sse.com.cn', '财报 / 公告'],
  ['szse.cn', '财报 / 公告'],
  ['caixin.com', '独立媒体'],
  ['reuters.com', '独立媒体'],
  ['bloomberg.com', '独立媒体'],
  ['ft.com', '独立媒体'],
  ['wsj.com', '独立媒体'],
  ['nytimes.com', '独立媒体'],
  ['thepaper.cn', '独立媒体'],
  ['zhihu.com', '自媒体'],
  ['xueqiu.com', '自媒体'],
  ['36kr.com', '自媒体'],
  ['cs.com.cn', '券商研报'],
  ['cicc.com', '券商研报'],
  ['htsec.com', '券商研报'],
  ['gf.com.cn', '券商研报'],
  ['cmschina.com', '券商研报'],
]

/** 关键词 → 来源类型（零依赖兜底，按顺序命中第一条）。 */
export const SOURCE_KEYWORD_RULES = [
  ['财报 / 公告', /财报|年报|季报|公告|招股|股东信|10-?[KQ]|业绩快报/i],
  ['一手数据', /我们跟踪|供应链|产业链调研|调研纪要|访谈|实测|内部数据|我们测算|草根/i],
  ['券商研报', /研报|中信|中金|海通|广发|招商|我们预计|目标价|评级|买入|增持/i],
  ['独立媒体', /据报道|据悉|彭博|路透|财新|华尔街日报|第一财经|记者/i],
  ['自媒体', /公众号|头条号|知乎|小红书|B\s?站|个人观点|笔者认为/i],
  ['群聊转发', /群里|转发|听说|有人讲|截图|小道消息|内部消息/i],
]

const TIME_WINDOW = /20\d{2}\s*年(?:\s*\d{1,2}\s*月)?|20\d{2}\s*Q[1-4]|\d{1,2}\s*月(?:\d{1,2}\s*日)?/
const TIME_WINDOW_ALL = new RegExp(TIME_WINDOW.source, 'g')
const NUMBER = /(\d+(?:[.,]\d+)?)\s*(%|％|亿元|万元|万台|万|亿|倍|个|条|天)?/
export const TIME_WINDOW_PATTERN = TIME_WINDOW

const text = (value) => (typeof value === 'string' ? value.trim() : '')

export const isSourceType = (value) => QUALITY.has(value)

/** 句中第一个数量（先剔掉日期，免得把"2026 年"当成数值、把纯叙述当成硬数据）。 */
export function quantityOf(sentence) {
  return String(sentence ?? '').replace(TIME_WINDOW_ALL, ' ').match(NUMBER)
}

/** 硬度：剔掉日期后还有具体数字 → 硬数据，否则观点 / 叙述。 */
export function hardnessOf(sentence) {
  return quantityOf(sentence) ? 'hard' : 'soft'
}

/** 链接域名对应的来源类型；不在表里返回 null。 */
export function sourceTypeOfUrl(url) {
  let host
  try { host = new URL(text(url)).hostname.toLowerCase().replace(/\.$/, '') } catch { return null }
  for (const [domain, type] of SOURCE_DOMAIN_TYPES) {
    if (host === domain || host.endsWith(`.${domain}`)) return type
  }
  return null
}

/** 关键词命中的来源类型；一条都没命中返回 null（调用方决定兜底）。 */
export function sourceTypeOfText(value) {
  const body = String(value ?? '')
  for (const [type, pattern] of SOURCE_KEYWORD_RULES) if (pattern.test(body)) return type
  return null
}

/**
 * { 来源类型, 硬度 } → 规范化的权重；任一项不合法返回 null。分值永远在这里重算。
 * @returns {{ sourceType: string, hardness: 'hard' | 'soft', value: number } | null}
 */
export function weightOf(input) {
  if (!input || typeof input !== 'object') return null
  const sourceType = input.sourceType
  const hardness = input.hardness
  if (!isSourceType(sourceType) || !Object.hasOwn(HARDNESS, hardness)) return null
  /* 整数运算（分 × 十分位）再四舍五入，避开浮点误差：0.95 × 0.7 在浮点里是 0.66499…，按整数算才是 0.665 → 0.67。 */
  const qualityHundredths = Math.round(QUALITY.get(sourceType) * 100)
  const factorTenths = Math.round(HARDNESS[hardness].factor * 10)
  return { sourceType, hardness, value: Math.round((qualityHundredths * factorTenths) / 10) / 100 }
}

/**
 * 进主题时的建议权重。来源类型：域名 > 打标结果 > 旧数据记下的来源类型 > 来源名与原文关键词 > 独立媒体；
 * 硬度：引擎给了陈述类型（hard / soft）就用它，否则看原文有没有具体数字。
 * @param {{ url?: string, labelType?: string, legacyType?: string, sourceLabel?: string, text?: string, statementType?: string }} input
 * @returns {{ weight: { sourceType: string, hardness: 'hard' | 'soft', value: number }, sourceVia: 'domain' | 'label' | 'legacy' | 'keywords' | 'default', hardnessVia: 'statement' | 'quantity' }}
 */
export function suggestWeight({ url = '', labelType = '', legacyType = '', sourceLabel = '', text: body = '', statementType = '' } = {}) {
  let sourceType = sourceTypeOfUrl(url)
  let sourceVia = 'domain'
  if (!sourceType && isSourceType(labelType)) { sourceType = labelType; sourceVia = 'label' }
  if (!sourceType && isSourceType(legacyType)) { sourceType = legacyType; sourceVia = 'legacy' }
  if (!sourceType) {
    sourceType = sourceTypeOfText(`${String(sourceLabel ?? '')}\n${String(body ?? '')}`)
    sourceVia = 'keywords'
  }
  if (!sourceType) { sourceType = DEFAULT_SOURCE_TYPE; sourceVia = 'default' }
  const fromStatement = statementType === 'hard' || statementType === 'soft'
  const hardness = fromStatement ? statementType : hardnessOf(body)
  return { weight: weightOf({ sourceType, hardness }), sourceVia, hardnessVia: fromStatement ? 'statement' : 'quantity' }
}

/**
 * 投影证据节点当前的权重：
 * - judged：判的时候确认过的（会进强度公式的就是它）；
 * - suggested：进主题时按规则记下的建议，还没判；
 * - estimated：旧数据没记权重，按同一规则现算（只用于判之前的默认值）。
 */
export function evidenceWeightOf(node) {
  const stored = weightOf(node?.weight)
  if (stored) return { weight: stored, source: node.weightSource === 'judged' ? 'judged' : 'suggested', sourceVia: null }
  const suggestion = suggestWeight({
    url: evidenceSourceUrl(node) || '', legacyType: node?.sourceCategory || '',
    sourceLabel: node?.sourceLabel || '', text: node?.currentText || node?.title || '',
  })
  return { weight: suggestion.weight, source: 'estimated', sourceVia: suggestion.sourceVia }
}

export const SOURCE_VIA_LABEL = {
  domain: '按链接域名', label: '按来源打标', legacy: '按旧数据记下的类型', keywords: '按来源名 / 原文关键词', default: '没有线索，按独立媒体',
}

/** 0.57 这样的两位小数。 */
export function weightText(weight) {
  return Number.isFinite(weight?.value) ? weight.value.toFixed(2) : '—'
}

/** 「券商研报 0.80 × 硬数据 1.0」：权重怎么来的，一眼可核对。 */
export function weightFormula(weight) {
  if (!weightOf(weight)) return ''
  return `${weight.sourceType} ${QUALITY.get(weight.sourceType).toFixed(2)} × ${HARDNESS[weight.hardness].label} ${HARDNESS[weight.hardness].factor.toFixed(1)}`
}

/** 高 / 中 / 低 三档（展示用，阈值固定）：≥0.75 高，≥0.45 中，其余低。 */
export function weightTier(weight) {
  const value = weight?.value
  if (!Number.isFinite(value)) return null
  return value >= 0.75 ? 'high' : value >= 0.45 ? 'mid' : 'low'
}
export const WEIGHT_TIER_LABEL = { high: '高', mid: '中', low: '低' }
