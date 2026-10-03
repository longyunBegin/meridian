/**
 * 外部数据的来源口径（主进程与渲染层共用，规则只写这一处）。
 *
 * 1) 来源链接：进入主题的每条外部数据都必须指向一个真实可打开的网页。
 *    「真实」在本地能确定性判断的部分：http(s)、不带账号密码、域名完整（有点、标签合法、顶级域合法），
 *    且不是保留 / 示例 / 内网域名（RFC 2606 / 6761：test、example、invalid、localhost，以及 local、internal、arpa），
 *    也不是 IP 字面量（来源要落到可辨认的发布方域名上）。能否打开要联网才知道，这里不做。
 * 2) 要点：抽取出来的要点跟着原文进主题，当判的上下文；判的单位仍是一条原文 / 一句引文。
 */

const MAX_URL_LENGTH = 2048
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local', 'internal', 'arpa', 'onion'])
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org'])
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

export const MAX_POINTS = 12
export const MAX_POINT_LENGTH = 200

/**
 * @param {unknown} raw
 * @returns {{ ok: true, url: string } | { ok: false, url: null, error: string }}
 */
export function checkSourceUrl(raw) {
  const fail = (error) => ({ ok: false, url: null, error })
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return fail('缺来源链接')
  if (value.length > MAX_URL_LENGTH) return fail('链接太长')
  if (/\s/.test(value)) return fail('链接里不能有空格或换行')
  let url
  try { url = new URL(value) } catch { return fail('不是有效的网址') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('只接受 http / https 链接')
  if (url.username || url.password) return fail('链接里不能带账号密码')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return fail('链接缺域名')
  if (host.startsWith('[') || IPV4.test(host)) return fail('请用发布方的域名链接，不要用 IP 地址')
  const labels = host.split('.')
  if (labels.length < 2) return fail('域名不完整')
  if (!labels.every((label) => LABEL.test(label))) return fail('域名不合法')
  const tld = labels[labels.length - 1]
  if (!TLD.test(tld)) return fail('域名不合法')
  if (RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.has(labels.slice(-2).join('.'))) return fail('这是示例或内网域名，不是真实来源')
  return { ok: true, url: url.href }
}

/** 合格的来源链接（规范化后的 href）；不合格返回 null。 */
export function sourceUrlOf(raw) {
  return checkSourceUrl(raw).url
}

/** 来源链接的域名（展示用）；不合格返回 null。 */
export function sourceHostOf(raw) {
  const url = sourceUrlOf(raw)
  return url ? new URL(url).hostname.replace(/^www\./, '') : null
}

/** 投影证据节点的来源链接：sourceUrl → provenance.url → evidenceRefs 里的 url 引用，取第一个合格的。 */
export function evidenceSourceUrl(node) {
  const refs = Array.isArray(node?.evidenceRefs) ? node.evidenceRefs : []
  const candidates = [node?.sourceUrl, node?.provenance?.url, ...refs.filter((ref) => ref?.type === 'url').map((ref) => ref.id)]
  for (const candidate of candidates) {
    const url = sourceUrlOf(candidate)
    if (url) return url
  }
  return null
}

/**
 * 要点归一：接受字符串或 { title | text } 对象；空白归一、截断到 MAX_POINT_LENGTH、按文字去重、最多 MAX_POINTS 条，保持原顺序。
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizePoints(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const points = []
  for (const entry of list) {
    const raw = typeof entry === 'string' ? entry
      : entry && typeof entry === 'object' ? (typeof entry.title === 'string' ? entry.title : typeof entry.text === 'string' ? entry.text : '')
        : ''
    const point = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_POINT_LENGTH)
    if (!point || seen.has(point)) continue
    seen.add(point)
    points.push(point)
    if (points.length === MAX_POINTS) break
  }
  return points
}
