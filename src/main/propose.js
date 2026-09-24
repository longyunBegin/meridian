/**
 * LLM 提议指针：为整个主题的未接线指标提议该挂哪些通道。
 * 一次 LLM 调用，产出建议列表；用户逐个「采用」或「忽略」。
 * 提议是一次性的——不进 DB，刷新即消失。
 */

import { allNodes, allChannels, allThemes, rankChannelsByTags } from './store.js'

/**
 * 过滤非法提议。纯函数，无 I/O。
 * 任一 channelId 非法 → 整条丢弃（不是过滤掉那个 id 就留剩下的）。
 * 重复 channelId → 去重。
 * @param {Array} proposals LLM 返回的提议列表
 * @param {Set} validIndicatorIds 合法的指标 id 集合
 * @param {Set} validChannelIds 合法的通道 id 集合
 * @returns {Array} 过滤后的提议列表
 */
export function sanitize(proposals, validIndicatorIds, validChannelIds) {
  return proposals.filter((p) =>
    validIndicatorIds.has(p.indicatorId) &&
    Array.isArray(p.channelIds) &&
    p.channelIds.every((id) => validChannelIds.has(id))
  ).map((p) => ({
    indicatorId: p.indicatorId,
    channelIds: [...new Set(p.channelIds)],
    reason: typeof p.reason === 'string' ? p.reason : '',
  }))
}

/** 构造节点完整路径（从根到当前节点） */
function fullPath(nodes, id) {
  const out = []
  let cur = nodes.find((n) => n.id === id)
  while (cur) {
    out.unshift(cur.title)
    cur = cur.parentId ? nodes.find((n) => n.id === cur.parentId) : null
  }
  return out.join(' / ')
}

/** 从指标标题里提取 cadence（标题形如「废旧电池采购量：按月度节奏更新，本期读数待填」） */
function extractCadence(title) {
  const m = String(title).match(/按(.+?)节奏更新/)
  return m ? m[1] : ''
}

const PROPOSE_SYSTEM = `你是一个产业链分析专家。你的任务是为未接线的指标提议该挂哪些数据通道。

硬规则：
1. 你只能从下面列出的通道里选，不能创造新通道。
2. 一个指标可以挂多个通道，也可以一个都不挂。
3. 挂不上的就在 reason 里说明缺什么，不要猜。
4. 产出 JSON，不要 markdown 代码块，不要解释。
5. 结构：{"proposals":[{"indicatorId":"指标id","channelIds":["通道id"],"reason":"为什么挂这些"}]}

示例：
输入指标「四大云 capex」可用通道有 MSFT capex、GOOGL capex、AMZN capex
→ {"proposals":[{"indicatorId":"n_x1","channelIds":["ch_msft","ch_googl","ch_amzn"],"reason":"四大云 capex 由三巨头财报直接反映"}]}

输入指标「回收产能利用率」无匹配通道
→ {"proposals":[{"indicatorId":"n_x2","channelIds":[],"reason":"产能利用率无公开结构化数据源，只能手填"}]}

只输出 JSON：`

/**
 * 为整个主题的未接线指标提议通道。
 * @param {object} settings — baseUrl / apiKey / model
 * @param {string} themeId — 主题 id
 * @returns {Promise<{ok, proposals, error}>}
 *   proposals: [{ indicatorId, channelIds, reason }]
 *   失败 / 无 key → { ok: false, error }
 */
export async function proposeChannelLinks(settings, themeId) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, error: 'no-key' }

  const nodes = allNodes()
  const theme = allThemes().find((t) => t.id === themeId)
  if (!theme) return { ok: false, error: 'theme not found' }

  // 未接线指标：observation + 无 channelIds + 属于该主题 + 非 dead
  const indicators = nodes.filter((n) =>
    n.type === 'observation' &&
    n.status !== 'dead' &&
    n.themeId === themeId &&
    (!n.channelIds || n.channelIds.length === 0))

  if (!indicators.length) return { ok: true, proposals: [] }

  // 通道按相关性排序
  const channels = allChannels()
  const ranked = rankChannelsByTags(channels, theme.tags || [])
  if (!ranked.length) return { ok: true, proposals: [] }

  // 构造输入
  const indicatorLines = indicators.map((n) => {
    const path = fullPath(nodes, n.id)
    const cadence = extractCadence(n.title)
    return `  ${path || n.title}${cadence ? '  ' + cadence : ''}  [id: ${n.id}]`
  }).join('\n')

  const channelLines = ranked.map(({ channel: c, score }) => {
    const tags = (c.tags || []).join(', ')
    return `  ${c.name}  ${c.fetch}${c.metric ? ' ' + c.metric : ''}  [${tags}]  [id: ${c.id}]`
  }).join('\n')

  const userContent = `主题：${theme.name}  tags: [${(theme.tags || []).join(', ')}]

未接线的 observation 指标（含完整路径 + cadence）：
${indicatorLines}

可用通道（带 tags，按相关性排序）：
${channelLines}`

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: PROPOSE_SYSTEM },
          { role: 'user', content: userContent.slice(0, 4000) },
        ],
      }),
    })
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }

  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, error: 'empty' }

  const parsed = parseProposals(raw)
  if (!parsed) return { ok: false, error: 'unparsable' }

  // 过滤非法 id
  const validIndicatorIds = new Set(indicators.map((n) => n.id))
  const validChannelIds = new Set(channels.map((c) => c.id))
  const proposals = sanitize(parsed, validIndicatorIds, validChannelIds)

  return { ok: true, proposals }
}

function parseProposals(raw) {
  const s = String(raw)
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const parsed = JSON.parse(s.slice(a, b + 1))
    if (!parsed || !Array.isArray(parsed.proposals)) return null
    return parsed.proposals.filter((p) =>
      p && typeof p.indicatorId === 'string' && Array.isArray(p.channelIds))
  } catch { return null }
}