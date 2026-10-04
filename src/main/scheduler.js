/**
 * 定时器：每 15 分钟检查待处理工作，发通知 + dock 角标。
 * 纯函数部分（freshToNotify / isQuietHours / buildNotification）不依赖桌面宿主，可在 Node 中直接断言。
 *
 * 角标与通知口径 = 今日待确认（收件箱）+ 各主题建设者待判；
 * 不再按「到期未结算 / 命题校准」提醒——产品面已去掉这两块。
 */

const TICK_MS = 15 * 60 * 1000
const QUIET_START = 22
const QUIET_END = 9

/** 是否在静默时段（22:00–次日 9:00） */
export function isQuietHours(date = new Date()) {
  const h = date.getHours()
  return h >= QUIET_START || h < QUIET_END
}

/** 从待通知列表中筛出未通知过的（按稳定 id） */
export function freshToNotify(items, notified) {
  return (items || []).filter((item) => item && item.id != null && !notified.has(item.id))
}

/** @deprecated 旧名，等同 freshToNotify */
export const dueToNotify = freshToNotify

/**
 * 构造通知内容。
 * items: [{ id, kind: 'inbox'|'judge', title?, themeName? }]
 */
export function buildNotification(items) {
  if (!items?.length) return null
  const inbox = items.filter((item) => item.kind === 'inbox')
  const judge = items.filter((item) => item.kind === 'judge')
  const parts = []
  if (inbox.length) parts.push(inbox.length === 1
    ? (inbox[0].title || '1 条待确认')
    : `${inbox.length} 条待确认`)
  if (judge.length) {
    const theme = judge[0].themeName
    parts.push(judge.length === 1
      ? (theme ? `「${theme}」有待判` : '1 条待判')
      : `${judge.length} 条待判`)
  }
  if (!parts.length) {
    const first = items[0]
    parts.push(first.title || '有待处理的工作')
  }
  const body = parts.join(' · ')
  if (items.length === 1 && inbox.length === 1) {
    return { title: 'Meridian · 待确认', body: inbox[0].title || body }
  }
  if (items.length === 1 && judge.length === 1) {
    return { title: 'Meridian · 待判', body }
  }
  return { title: `Meridian · ${items.length} 项待处理`, body }
}

/**
 * 启动定时器。
 * @param {object} opts
 * @param {function} opts.attention - () => { count, items: [{id, kind, title?, themeName?}] }
 *   兼容旧调用：若只提供 opts.due，则把返回列表当作待处理 items（count=length）
 * @param {function} opts.notify - (notification) => void
 * @param {function} opts.badge - (count) => void，设角标
 * @param {function} opts.onClick - () => void，通知点击回调
 * @returns {function} stop
 */
export function startScheduler({ attention, due, notify, badge, onClick }) {
  const notified = new Set()
  let running = false
  let stopped = false

  const snapshot = () => {
    if (typeof attention === 'function') {
      const snap = attention() || {}
      const items = Array.isArray(snap.items) ? snap.items.filter((item) => item && item.id != null) : []
      const count = Number.isFinite(Number(snap.count)) ? Number(snap.count) : items.length
      return { count, items }
    }
    // 旧测试 / 旧接线：due() 返回列表
    const items = (typeof due === 'function' ? (due() || []) : []).map((item, index) => ({
      id: item?.id ?? `legacy:${index}`,
      kind: item?.kind || 'inbox',
      title: item?.title,
      themeName: item?.themeName,
    }))
    return { count: items.length, items }
  }

  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      const { count, items } = snapshot()
      if (badge) badge(count)

      if (items.length > 0 && !isQuietHours()) {
        const fresh = freshToNotify(items, notified)
        if (fresh.length > 0) {
          for (const item of fresh) notified.add(item.id)
          const notice = buildNotification(fresh)
          if (notice && notify) notify(notice, onClick)
        }
      }
    } finally { running = false }
  }

  tick().catch(() => {})
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS)

  return () => { stopped = true; clearInterval(timer) }
}
