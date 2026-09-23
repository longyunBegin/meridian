/**
 * us-gaap 标签发现：仅手动触发，不进任何定时/轮询路径。
 *
 * R3 立的规矩：companyfacts 只用于发现，不用于轮询。
 * 所以这个模块独立于 fetchers.js，不被 scheduler 或 FETCHERS map 引用。
 */

import { resolveTicker, UA } from './fetchers.js'
import { COMMON_US_GAAP, SYNONYM_GROUPS } from './store.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { app } = globalThis.__electron

const FACTS_CACHE_TTL = 7 * 864e5 // 7 天

const COMMON_TAGS = new Map(COMMON_US_GAAP.map((c) => [c.tag, c.label]))
const COMMON_ORDER = new Map(COMMON_US_GAAP.map((c, i) => [c.tag, i]))
// 反查：tag → 同义组索引
const SYNONYM_INDEX = new Map()
SYNONYM_GROUPS.forEach((group, i) => {
  for (const tag of group) SYNONYM_INDEX.set(tag, i)
})

/**
 * companyfacts 响应 → 标签列表。纯函数，供测试用。
 * 每条：{ tag, label, periods, common, synonymGroup }
 * 常用标签置顶，其余按字母序。periods = 0 的置灰（公司不用该标签）。
 * 同义标签标注 synonymGroup，UI 可据此归组显示。
 */
export function parseCompanyFacts(data) {
  const usGaap = data?.facts?.['us-gaap']
  if (!usGaap || typeof usGaap !== 'object') return []
  const tags = []
  for (const [tag, detail] of Object.entries(usGaap)) {
    const units = detail?.units || {}
    let periods = 0
    for (const recs of Object.values(units)) {
      if (Array.isArray(recs)) periods += recs.length
    }
    const common = COMMON_TAGS.has(tag)
    const synonymGroup = SYNONYM_INDEX.has(tag) ? SYNONYM_INDEX.get(tag) : null
    tags.push({
      tag,
      label: COMMON_TAGS.get(tag) || null,
      periods,
      common,
      synonymGroup,
    })
  }
  // 常用置顶（按 COMMON_US_GAAP 中的顺序），其余按字母序
  tags.sort((a, b) => {
    if (a.common && b.common) return COMMON_ORDER.get(a.tag) - COMMON_ORDER.get(b.tag)
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