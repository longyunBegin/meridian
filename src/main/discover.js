/**
 * us-gaap 标签发现：仅手动触发，不进任何定时/轮询路径。
 *
 * R3 立的规矩：companyfacts 只用于发现，不用于轮询。
 * 所以这个模块独立于 fetchers.js，不被 scheduler 或 FETCHERS map 引用。
 */

import { resolveTicker, UA } from './fetchers.js'
import { COMMON_US_GAAP } from './store.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { app } = globalThis.__electron

const FACTS_CACHE_TTL = 7 * 864e5 // 7 天

/**
 * companyfacts 响应 → 标签列表。纯函数，供测试用。
 * 每条：{ tag, periods, common }
 * 常用标签置顶，其余按字母序。periods = 0 的置灰（公司不用该标签）。
 */
export function parseCompanyFacts(data) {
  const usGaap = data?.facts?.['us-gaap']
  if (!usGaap || typeof usGaap !== 'object') return []
  const commonSet = new Set(COMMON_US_GAAP)
  const tags = []
  for (const [tag, detail] of Object.entries(usGaap)) {
    const units = detail?.units || {}
    let periods = 0
    for (const recs of Object.values(units)) {
      if (Array.isArray(recs)) periods += recs.length
    }
    tags.push({ tag, periods, common: commonSet.has(tag) })
  }
  // 常用置顶（按 COMMON_US_GAAP 中的顺序），其余按字母序
  const commonOrder = new Map(COMMON_US_GAAP.map((t, i) => [t, i]))
  tags.sort((a, b) => {
    if (a.common && b.common) return commonOrder.get(a.tag) - commonOrder.get(b.tag)
    if (a.common) return -1
    if (b.common) return 1
    return a.tag.localeCompare(b.tag)
  })
  return tags
}

/**
 * 发现标签：ticker → CIK → companyfacts → 解析标签列表。
 * 结果缓存到本地文件（sec-facts-{cik}.json，7 天过期）。
 * 仅用户手动点击时调用，不进任何定时/轮询路径。
 */
export async function discoverTags(ticker) {
  const t = String(ticker || '').toUpperCase().trim()
  if (!t) return { tags: [], error: '请填 ticker', entityName: null }

  const { cik, title } = await resolveTicker(t)
  const cacheFile = join(app.getPath('userData'), `sec-facts-${cik}.json`)

  // 本地缓存
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (cached.savedAt && Date.now() - cached.savedAt < FACTS_CACHE_TTL) {
        return { tags: parseCompanyFacts(cached.data), error: null, entityName: cached.data?.entityName || title }
      }
    } catch { /* 缓存损坏，忽略 */ }
  }

  // 拉 SEC companyfacts（4MB 级别，缓存后不重复拉）
  const url = `https://data.sec.gov/api/xbrl/companyfacts/${cik}.json`
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) return { tags: [], error: `HTTP ${res.status}`, entityName: null }
  const data = await res.json()

  // 写缓存
  try {
    writeFileSync(cacheFile, JSON.stringify({ data, savedAt: Date.now() }))
  } catch { /* 写缓存失败不影响主流程 */ }

  return { tags: parseCompanyFacts(data), error: null, entityName: data?.entityName || title }
}