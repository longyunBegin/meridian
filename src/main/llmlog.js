/**
 * LLM 调用账本：谁在花钱、花了多少、哪里失败了。
 *
 * 存储策略：按天聚合 + 只留最近 50 条失败明细。
 * 不给每次调用存一条记录——那会让 meridian.json 每次 persist() 全量重写时被撑爆。
 */

/** 测试钩子：stub 掉记账 / 模型调用，或从响应体里取 usage */
export const __testHooks = {
  track: null, // (scenario, info) => void
  readUsageResponse: null, // (response) => tokens
  run: null, // (scenario, args) => 结果，替代真实 fetch
}

/**
 * 从响应体读 token 用量。9 个调用点原来一处都没取，这是消耗黑盒的直接原因。
 * 读的是 clone —— 调用方还要自己读一次 body，不能把流吃掉。
 */
export async function readUsage(response) {
  if (__testHooks.readUsageResponse) return __testHooks.readUsageResponse(response)
  try {
    const src = typeof response?.clone === 'function' ? response.clone() : response
    const body = await src.json()
    const n = Number(body?.usage?.total_tokens)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
    // Jev 原生：usage 按输入 / 输出分开给，没有 total_tokens
    const parts = [body?.usage?.input_tokens, body?.usage?.output_tokens]
      .map(Number)
      .filter((x) => Number.isFinite(x) && x > 0)
    if (parts.length) return Math.round(parts.reduce((a, b) => a + b, 0))
    return 0
  } catch {
    return 0
  }
}

/** 把一次调用写进账本（由 store 落库） */
export function record(scenario, info = {}) {
  if (__testHooks.track) return __testHooks.track(scenario, info)
  return null
}

/**
 * 统一包装器：调用点只声明场景，记账在这里。
 * no-key 不是失败——一次网络请求都没发出去，只算降级，不该污染失败率。
 */
export async function tracked(scenario, fn, { themeId = null, channelId = null } = {}) {
  const t0 = Date.now()
  try {
    const r = await fn()
    const noKey = r?.ok === false && (r?.reason === 'no-key' || r?.why === 'no-key' || r?.error === 'no-key')
    const usage = r?.usage
    record(scenario, {
      ok: r?.ok !== false,
      degraded: noKey,
      tokens: Number(usage?.total_tokens ?? usage) || 0,
      latency: Date.now() - t0,
      themeId,
      channelId,
    })
    return r
  } catch (e) {
    record(scenario, { ok: false, error: e?.message || String(e), latency: Date.now() - t0, themeId, channelId })
    throw e
  }
}

/** 场景展示名：复盘页按这个分组 */
export const SCENARIO_LABELS = {
  extract: '抽取',
  skeleton: '建主题',
  themeTags: '主题标签',
  tagLibrary: '标签库',
  pickChannels: '通道挑选',
  propose: '提议指针',
  label: '打标',
  socratic: '追问',
}
