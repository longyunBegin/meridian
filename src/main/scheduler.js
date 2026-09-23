/**
 * 定时器：每 15 分钟检查到期结算，发通知 + dock 角标。
 * 纯函数部分（dueToNotify / isQuietHours）不依赖 Electron，可在测试桩里直接断言。
 */

const TICK_MS = 15 * 60 * 1000
const QUIET_START = 22
const QUIET_END = 9

/** 是否在静默时段（22:00–次日 9:00） */
export function isQuietHours(date = new Date()) {
  const h = date.getHours()
  return h >= QUIET_START || h < QUIET_END
}

/** 从到期列表中筛出未通知过的 */
export function dueToNotify(due, notified) {
  return due.filter((d) => !notified.has(d.id))
}

/** 构造通知内容 */
export function buildNotification(items) {
  if (!items?.length) return null
  if (items.length === 1) {
    return { title: '脉络 · 到期结算', body: items[0].title }
  }
  return { title: `脉络 · ${items.length} 条判断到期`, body: items[0].title }
}

/**
 * 启动定时器。
 * @param {object} opts
 * @param {function} opts.due - 返回到期命题列表
 * @param {function} opts.notify - (notification) => void，发通知
 * @param {function} opts.badge - (count) => void，设角标
 * @param {function} opts.onClick - () => void，通知点击回调
 * @returns {function} stop 函数
 */
export function startScheduler({ due, notify, badge, onClick }) {
  const notified = new Set()

  const tick = () => {
    const items = due() || []
    if (badge) badge(items.length)

    if (items.length === 0) return
    if (isQuietHours()) return

    const fresh = dueToNotify(items, notified)
    if (fresh.length === 0) return

    for (const d of fresh) notified.add(d.id)

    const n = buildNotification(fresh)
    if (n && notify) notify(n, onClick)
  }

  tick()
  const timer = setInterval(tick, TICK_MS)

  return () => clearInterval(timer)
}