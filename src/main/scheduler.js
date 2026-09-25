/**
 * 定时器：每 15 分钟检查到期结算，发通知 + dock 角标。
 * 纯函数部分（dueToNotify / isQuietHours）不依赖 Electron，可在测试桩里直接断言。
 */

const TICK_MS = 15 * 60 * 1000
const QUIET_START = 22
const QUIET_END = 9

/** 每个 tick 最多处理多少条内容——订阅源一次回几十条的防爆阀 */
export const MAX_ITEMS_PER_TICK = 10

/** 是否在静默时段（22:00–次日 9:00） */
export function isQuietHours(date = new Date()) {
  const h = date.getHours()
  return h >= QUIET_START || h < QUIET_END
}

/** 从到期列表中筛出未通知过的 */
export function dueToNotify(due, notified) {
  return due.filter((d) => !notified.has(d.id))
}

/** 构造通知内容（正文附带上下文：当时置信度 · 挂点 · 下游数） */
export function buildNotification(items) {
  if (!items?.length) return null
  const first = items[0]
  const parts = [first.title]
  if (first.confidence != null) parts.push(`当时 ${Math.round(first.confidence)}%`)
  if (first.branchPath) parts.push(first.branchPath)
  if (first.downstreamCount > 0) parts.push(`${first.downstreamCount} 条下游`)
  const body = parts.join(' · ')
  if (items.length === 1) {
    return { title: '脉络 · 到期结算', body }
  }
  return { title: `脉络 · ${items.length} 条判断到期`, body }
}

/**
 * 通道抖动：interval 相同的通道会在同一分钟集体到期，用 id 的稳定 hash 错开。
 * 同一通道每次结果一致；抖动只影响调度判定，不改存储的 interval。
 */
export function channelJitter(channelId) {
  let sum = 0
  for (const ch of String(channelId || '')) sum += ch.charCodeAt(0)
  return sum % 10
}

/**
 * 筛出该拉取的通道。纯函数，无 I/O。
 * @param {Array} channels 全部通道
 * @param {number} now Date.now()
 * @param {Map} failCounts channelId → 连续失败次数
 * @param {Array} fetchers 已实现的取数器列表
 */
export function dueChannels(channels, now, failCounts = new Map(), fetchers = []) {
  return channels.filter((c) => {
    if (!c.enabled) return false
    if (c.fetch === 'manual') return false
    if (!fetchers.includes(c.fetch)) return false
    const fails = failCounts.get(c.id) || 0
    const backoff = fails > 0 ? Math.min(60, c.interval) * Math.pow(2, Math.min(fails, 5)) : 0
    const wait = (c.interval + channelJitter(c.id)) * 60000 + backoff * 60000
    // 老数据里 lastFetch 只存日期（'2026-09-24'），Date.parse 会还原成当天 00:00，于是每次 tick 都到期。
    // 不做迁移：这类通道会先被判到期、拉一次，lastFetch 随即被改写成完整时间，之后 interval 才真正生效。
    const last = c.lastFetch ? Date.parse(c.lastFetch) : 0
    return now - last >= wait
  })
}

/**
 * 启动定时器。
 * @param {object} opts
 * @param {function} opts.due - 返回到期命题列表
 * @param {function} opts.notify - (notification) => void，发通知
 * @param {function} opts.badge - (count) => void，设角标
 * @param {function} opts.onClick - () => void，通知点击回调
 * @param {function} [opts.channels] - () => 通道列表（轮询用）
 * @param {function} [opts.runChannel] - async (ch) => void，拉取单个通道
 * @param {function} [opts.fetchers] - () => 已实现取数器列表
 * @returns {function} stop 函数
 */
export function startScheduler({ due, notify, badge, onClick, channels, runChannel, fetchers, indicators, metricFetchers = [] }) {
  const notified = new Set()
  const failCounts = new Map()
  let running = false
  let stopped = false

  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      const items = due() || []
      if (badge) badge(items.length)

      if (items.length > 0 && !isQuietHours()) {
        const fresh = dueToNotify(items, notified)
        if (fresh.length > 0) {
          for (const d of fresh) notified.add(d.id)
          const n = buildNotification(fresh)
          if (n && notify) notify(n, onClick)
        }
      }

      if (channels && runChannel && !isQuietHours()) {
        const all = channels() || []
        const avail = fetchers ? fetchers() : []
        const dueIds = indicators ? new Set((indicators(Date.now()) || []).flatMap((n) => n.channelIds || [])) : null
        const eligible = dueIds ? all.filter((ch) => !metricFetchers.includes(ch.fetch) || dueIds.has(ch.id)) : all
        const due_ = dueChannels(eligible, Date.now(), failCounts, avail)
        let budget = MAX_ITEMS_PER_TICK
        for (const ch of due_) {
          if (budget <= 0 || stopped) break
          try {
            const r = await runChannel(ch)
            budget -= Math.max(1, typeof r === 'number' ? r : (Number(r?.processed) || 0) + (Number(r?.readings?.total) || 0))
            if (r?.error || r?.readings?.ok === false) failCounts.set(ch.id, (failCounts.get(ch.id) || 0) + 1)
            else failCounts.delete(ch.id)
          } catch {
            budget--
            failCounts.set(ch.id, (failCounts.get(ch.id) || 0) + 1)
          }
        }
      }
    } finally { running = false }
  }

  tick().catch(() => {})
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS)

  return () => { stopped = true; clearInterval(timer) }
}