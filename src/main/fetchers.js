/**
 * 取数器注册表。
 *
 * channels.fetch 字段已存在但从未被读取用于分发——本模块补上这层。
 * 归一后的形状直接喂 processCapture()，不加新流水线。
 *
 * 来源类型由取数器给定（channel.kind），不走打标器猜。
 * labeler.js 看到 channelMeta.kind 会直接用，不调模型。
 */

import { fetchFeed } from './feeds.js'
import { fetchUrl } from './fetcher.js'
import { addReading } from './store.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** SEC EDGAR 硬要求：不带 UA 全站 403。邮箱要换成真实的。 */
const UA = 'Meridian/0.6 (contact: meridian@example.com)'

const { app } = globalThis.__electron

/** ticker → CIK 内存缓存 */
let tickerCache = null
let tickerCacheAt = 0
const TICKER_CACHE_TTL = 7 * 864e5 // 7 天

/**
 * ticker → CIK 解析。优先内存缓存，其次本地文件，最后拉 SEC。
 * CIK 补零到 10 位。大小写不敏感。
 */
async function resolveTicker(ticker) {
  const t = ticker.toUpperCase().trim()
  if (tickerCache && Date.now() - tickerCacheAt < TICKER_CACHE_TTL) {
    const hit = tickerCache.get(t)
    if (hit) return hit
  }
  // 尝试本地文件缓存
  const cacheFile = join(app.getPath('userData'), 'sec-tickers.json')
  if (!tickerCache && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (cached.savedAt && Date.now() - cached.savedAt < TICKER_CACHE_TTL) {
        tickerCache = new Map(Object.entries(cached.data))
        tickerCacheAt = cached.savedAt
        const hit = tickerCache.get(t)
        if (hit) return hit
      }
    } catch { /* 缓存损坏，忽略 */ }
  }
  // 拉 SEC
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`ticker 解析失败: HTTP ${res.status}`)
  const raw = await res.json()
  // 结构是字典套字典：{"0": {cik_str, ticker, title}, ...}
  const map = new Map()
  for (const entry of Object.values(raw)) {
    map.set(entry.ticker.toUpperCase(), {
      cik: String(entry.cik_str).padStart(10, '0'),
      title: entry.title,
    })
  }
  tickerCache = map
  tickerCacheAt = Date.now()
  // 写本地缓存
  try {
    writeFileSync(cacheFile, JSON.stringify({ data: Object.fromEntries(map), savedAt: tickerCacheAt }))
  } catch { /* 写缓存失败不影响主流程 */ }
  const hit = map.get(t)
  if (!hit) throw new Error(`未知 ticker: ${ticker}`)
  return hit
}

/**
 * companyconcept 响应 → reading 对象数组。纯函数，供测试用。
 *
 * 同一期间会被多个 filing 重复申报（10-K 把上一年作比较期重列），
 * 去重键 = (metric, start, end, accn)，由 addReading 内部判重。
 */
export function convertEdgarConcept(data, channel, cik, ticker, entityName) {
  const tag = channel.metric
  const metricName = `${ticker.toLowerCase()}.${tag}`
  const units = data.units || {}
  const unitName = Object.keys(units)[0]
  if (!unitName) return []
  const records = units[unitName] || []
  return records.map((rec) => ({
    metric: metricName,
    value: rec.val,
    unit: unitName,
    asOf: rec.end || null,
    dedupeKey: `${metricName}|${rec.start || ''}|${rec.end || ''}|${rec.accn || ''}`,
    basis: ['10-K', '10-Q', '8-K'].includes(rec.form) ? 'reported' : 'estimated',
    source: {
      kind: channel.kind || '财报 / 公告',
      label: `${entityName || ticker} ${rec.form || ''} ${rec.fy || ''}${rec.fp || ''}`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${rec.form || ''}&dateb=&owner=include&count=40`,
      fetchedAt: new Date().toISOString().slice(0, 10),
      platform: 'SEC EDGAR',
      start: rec.start,
      end: rec.end,
      accn: rec.accn,
    },
    basis_explicit: ['10-K', '10-Q', '8-K'].includes(rec.form) ? 'reported' : 'estimated',
    channelId: channel.id,
    indicatorId: null,
  }))
}

/**
 * Path A: 拉 companyconcept 单指标历史，逐条 addReading。
 * 不产命题，产读数。
 */
async function fetchEdgarConcept(channel) {
  const { cik, title } = await resolveTicker(channel.query)
  const tag = channel.metric
  if (!tag) return { items: [], readings: { ok: false, error: '通道缺少 metric 字段' }, error: null }
  const url = `https://data.sec.gov/api/xbrl/companyconcept/${cik}/us-gaap/${tag}.json`
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return { items: [], readings: { ok: false, error: `HTTP ${res.status}` }, error: null }
  const data = await res.json()
  const readingInputs = convertEdgarConcept(data, channel, cik, channel.query.toUpperCase().trim(), title)
  let added = 0
  let skipped = 0
  for (const input of readingInputs) {
    const result = addReading(input)
    if (result.added) added++
    else skipped++
  }
  return { items: [], readings: { ok: true, added, skipped, total: readingInputs.length }, error: null }
}

/**
 * 从 filings.recent 里筛 10-K/10-Q/8-K。纯函数，供测试用。
 */
export function filterFilings(filings, maxN = 5) {
  const recent = filings?.recent
  if (!recent || !recent.form) return []
  const forms = recent.form
  const accn = recent.accessionNumber
  const dates = recent.filingDate
  const docs = recent.primaryDocument
  const result = []
  for (let i = 0; i < forms.length; i++) {
    if (['10-K', '10-Q', '8-K'].includes(forms[i])) {
      result.push({
        form: forms[i],
        accessionNumber: accn[i],
        filingDate: dates[i],
        primaryDocument: docs[i],
      })
    }
  }
  return result.slice(0, maxN)
}

/**
 * Path B: 拉 submissions 找最近 filing，抓正文，产命题（不产 reading）。
 * 返回 items 数组，由 IPC 层喂 processCapture。
 */
async function fetchEdgarFilings(channel) {
  const { cik, title } = await resolveTicker(channel.query)
  const cikNoZero = String(parseInt(cik, 10))
  const url = `https://data.sec.gov/submissions/${cik}.json`
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return { items: [], readings: null, error: `HTTP ${res.status}` }
  const data = await res.json()
  const filings = filterFilings(data.filings, 5)
  const items = []
  for (const f of filings) {
    const accnNoDash = f.accessionNumber.replace(/-/g, '')
    const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoZero}/${accnNoDash}/${f.primaryDocument}`
    const text = await fetchUrl(docUrl)
    if (text && text.length > 50) {
      items.push({
        title: `${title} ${f.form} ${f.filingDate}`,
        text,
        url: docUrl,
        platform: 'SEC EDGAR',
        publishedAt: f.filingDate,
        kind: channel.kind || '财报 / 公告',
      })
    }
  }
  return { items, readings: null, error: null }
}

const FETCHERS = {
  rss: async (channel) => {
    const items = await fetchFeed(channel.query)
    return {
      items: items.map((item) => ({
        title: item.title,
        text: item.description || item.title,
        url: item.link || '',
        platform: null,
        publishedAt: item.pubDate || null,
        kind: channel.kind,
      })),
      readings: null,
      error: null,
    }
  },

  web: async (channel) => {
    const text = await fetchUrl(channel.query)
    if (!text || text.length < 50) return { items: [], readings: null, error: null }
    return {
      items: [{
        title: channel.name,
        text,
        url: channel.query,
        platform: null,
        publishedAt: null,
        kind: channel.kind,
      }],
      readings: null,
      error: null,
    }
  },

  edgarConcept: fetchEdgarConcept,
  edgarFilings: fetchEdgarFilings,

  // 以下未实现，静默返回空
  tavily: null,
  'grok-x-search': null,
  jina: null,
  cninfo: null,
  eastmoneyReport: null,
  manual: null,
}

/**
 * 按通道的 fetch 类型分发到对应取数器。
 * 返回 { items, readings, error }。
 * - items: 供 processCapture 的归一化数组（rss/web/edgarFilings）
 * - readings: { ok, added, skipped, total } 摘要（edgarConcept）
 * - error: 错误信息或 null
 *
 * 未实现的类型静默返回空，不抛错、不卡流水线。
 */
export async function fetchChannel(channel) {
  const fn = FETCHERS[channel.fetch]
  if (!fn) return { items: [], readings: null, error: null }
  try {
    return await fn(channel)
  } catch (e) {
    return { items: [], readings: null, error: e.message || String(e) }
  }
}

/** 列出所有已注册的 fetch 类型（供 UI 显示哪些可用） */
export function availableFetchers() {
  return Object.keys(FETCHERS).filter((k) => FETCHERS[k] != null)
}
