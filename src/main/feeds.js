/**
 * RSS / Atom 解析器。零依赖——不引外部包，用正则切。
 * 只取 title / link / pubDate / description，够走捕获流水线就行。
 */
export async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Meridian/0.2 (local-first judgment ledger)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const xml = await res.text()
  return parseRss(xml)
}

function parseRss(xml) {
  const items = []
  const itemRe = /<item[\s\S]*?<\/item>/gi
  for (const match of xml.matchAll(itemRe)) {
    const block = match[0]
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link') || extractAttr(block, 'link', 'href')
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published')
    const description = extractTag(block, 'description') || extractTag(block, 'summary')
    if (title) items.push({
      title: stripHtml(title).slice(0, 200),
      link: link?.trim() || '',
      pubDate: pubDate || '',
      description: stripHtml(description || '').slice(0, 500),
    })
  }

  if (!items.length) {
    const entryRe = /<entry[\s\S]*?<\/entry>/gi
    for (const match of xml.matchAll(entryRe)) {
      const block = match[0]
      const title = extractTag(block, 'title')
      const link = extractAttr(block, 'link', 'href') || extractTag(block, 'link')
      const pubDate = extractTag(block, 'published') || extractTag(block, 'updated')
      const summary = extractTag(block, 'summary') || extractTag(block, 'content')
      if (title) items.push({
        title: stripHtml(title).slice(0, 200),
        link: link?.trim() || '',
        pubDate: pubDate || '',
        description: stripHtml(summary || '').slice(0, 500),
      })
    }
  }

  return items
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = block.match(re)
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : null
}

function extractAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["']`, 'i')
  const m = block.match(re)
  return m ? m[1] : null
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim()
}