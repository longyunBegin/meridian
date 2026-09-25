import { rankChannelsByTags } from './store.js'
import { readUsage, __testHooks } from './llmlog.js'

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

function extractCadence(title) {
  const match = String(title).match(/按(.+?)节奏更新/)
  return match ? match[1] : ''
}

const PROPOSE_SYSTEM = `你是一个产业链分析专家。请为当前指标提议该挂哪些数据通道。

硬规则：
1. 只能从给出的通道中选择，不能创造或修改通道。
2. 可以选择多个通道，也可以一个都不选。
3. 没有合适通道时，在 reason 里说明缺什么，不要猜。
4. 只输出 JSON，不要 markdown 或解释。
5. 结构：{"proposal":{"indicatorId":"指标id","channelIds":["通道id"],"reason":"理由"}}

只输出 JSON：`

export async function proposeChannelLinks(settings, indicatorNode, channels) {
  const { baseUrl, apiKey, model } = settings
  if (!apiKey) return { ok: false, error: 'no-key' }
  if (!indicatorNode || indicatorNode.type !== 'observation' || indicatorNode.status === 'dead') {
    return { ok: false, error: 'indicator not found' }
  }
  if (__testHooks.run) return __testHooks.run('propose', { settings, indicatorNode, channels })

  const ranked = rankChannelsByTags(channels || [], indicatorNode.tags || [])
  if (!ranked.length) {
    return {
      ok: true,
      proposal: { indicatorId: indicatorNode.id, channelIds: [], reason: '没有可用通道' },
    }
  }

  const cadence = extractCadence(indicatorNode.title)
  const channelLines = ranked.map(({ channel: channel }) => {
    const tags = (channel.tags || []).join(', ')
    return `  ${channel.name}  ${channel.fetch}${channel.metric ? ' ' + channel.metric : ''}  [${tags}]  [id: ${channel.id}]`
  }).join('\n')
  const userContent = `指标：${indicatorNode.title}${cadence ? `  更新节奏：${cadence}` : ''}  [id: ${indicatorNode.id}]
指标标签：[${(indicatorNode.tags || []).join(', ')}]

可用通道（按相关性排序）：
${channelLines}`

  let response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  }

  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
  const usage = await readUsage(response)
  const body = await response.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return { ok: false, error: 'empty', usage }

  const parsed = parseProposal(raw)
  if (!parsed) return { ok: false, error: 'unparsable', usage }

  const proposals = sanitize(
    [parsed],
    new Set([indicatorNode.id]),
    new Set((channels || []).map((channel) => channel.id)),
  )
  if (!proposals.length) return { ok: false, error: 'invalid proposal', usage }
  return { ok: true, proposal: proposals[0], usage }
}

function parseProposal(raw) {
  const value = String(raw)
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(value.slice(start, end + 1))
    const proposal = parsed?.proposal || parsed?.proposals?.[0]
    if (!proposal || typeof proposal.indicatorId !== 'string' || !Array.isArray(proposal.channelIds)) return null
    return proposal
  } catch {
    return null
  }
}
