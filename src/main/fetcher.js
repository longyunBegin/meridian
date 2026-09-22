/**
 * URL 抓取器。粘贴 URL 时自动抓取网页正文，替代把 URL 当普通文本处理的降级路径。
 *
 * 零依赖——用正则切 HTML，不引外部包。够走捕获流水线就行。
 * 通道推断由域名决定：arxiv 是一手数据、公众号是自媒体——这是事实不是判断。
 */

/** 域名 → 来源类型映射。命中即归类，质量分由 SOURCE_QUALITY 表裁决。 */
const DOMAIN_MAP = [
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

/** 检测文本是否为 URL：以 http(s):// 开头，无换行，无空格 */
export function isUrl(text) {
  const t = String(text || '').trim()
  if (!t || t.includes('\n') || t.includes(' ')) return false
  return /^https?:\/\/[^\s]+$/i.test(t)
}

/** 从 URL 域名推断通道元数据 */
export function inferChannel(url) {
  let host
  try { host = new URL(url).hostname.toLowerCase() } catch { return null }
  for (const [domain, kind] of DOMAIN_MAP) {
    if (host === domain || host.endsWith('.' + domain)) {
      return { kind, platform: host, url }
    }
  }
  return { kind: null, platform: host, url }
}

/**
 * 抓取 URL 并提取正文。失败时返回 null，调用方降级到原文本。
 * 超时 15s，只取 HTML，非 HTML 返回 null。
 */
export async function fetchUrl(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Meridian/0.2 (local-first judgment ledger)' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  })
  if (!res.ok) return null
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null
  const html = await res.text()
  return extractText(html)
}

/**
 * 从 HTML 中提取正文。策略：
 * 1) 先移除 script/style/nav/footer/header/aside
 * 2) 尝试常见内容容器（article/main/js_content/abstract/content）
 * 3) 找到则用容器内容，否则用 body
 * 4) 去 HTML 标签、解码实体、压空白
 */
function extractText(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')

  const containers = [
    /<article[\s\S]*?<\/article>/i,
    /<main[\s\S]*?<\/main>/i,
    /<div[^>]*id=["']js_content["'][\s\S]*?<\/div>/i,
    /<div[^>]*class=["'][^"']*content[^"']*["'][\s\S]*?<\/div>/i,
    /<div[^>]*class=["'][^"']*article[^"']*["'][\s\S]*?<\/div>/i,
    /<blockquote[\s\S]*?<\/blockquote>/i,
  ]
  let body = null
  for (const re of containers) {
    const m = h.match(re)
    if (m) { body = m[0]; break }
  }
  if (!body) {
    const m = h.match(/<body[\s\S]*?<\/body>/i)
    body = m ? m[0] : h
  }

  return stripHtml(body).slice(0, 20000)
}

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}