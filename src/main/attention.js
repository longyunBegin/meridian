/**
 * Dock 角标 / 系统通知的「待处理」快照。
 * 口径与今日页一致：待确认（收件箱）+ 各主题建设者待判；不含到期结算、不含校准。
 */

import { load, allInbox } from './store.js'
import { getEvents } from './chain-events.js'
import { projectEvents } from './chain-projector.js'
import { countJudgeItems } from '../shared/judge.js'

let lastSeenJudge = 0

/** 供测试重置「待判上涨」水位。 */
export function resetAttentionWatermark() {
  lastSeenJudge = 0
}

function judgeTotals() {
  let judge = 0
  let topThemeName = ''
  for (const theme of load().themes || []) {
    if (theme?.deletedAt || !theme?.id) continue
    try {
      const events = getEvents(theme.id)
      const { nodes, edges } = projectEvents(events)
      const total = Number(countJudgeItems({ events, nodes, edges })?.total) || 0
      if (total > 0 && !topThemeName) topThemeName = theme.name || ''
      judge += total
    } catch { /* 单主题账本读失败不拖垮角标 */ }
  }
  return { judge, topThemeName }
}

/** 只算角标数字，不碰通知水位。 */
export function attentionCount() {
  const inbox = allInbox().length
  const { judge } = judgeTotals()
  return inbox + judge
}

/**
 * 调度器用：角标数字 + 本次应推送的新项。
 * 待确认按条目 id；待判只在总数上升时推一条，避免队列位移造成重复轰炸。
 * @returns {{ count: number, inbox: number, judge: number, items: Array<{id:string, kind:string, title?:string, themeName?:string}> }}
 */
export function attentionSnapshot() {
  const inboxRows = allInbox()
  const inboxItems = inboxRows.map((item) => ({
    id: `inbox:${item.id}`,
    kind: 'inbox',
    title: String(item.title || item.lemmas?.[0]?.title || '待确认条目').slice(0, 80),
  }))
  const { judge, topThemeName } = judgeTotals()
  const items = [...inboxItems]
  if (judge > lastSeenJudge) {
    const delta = judge - lastSeenJudge
    items.push({
      id: `judge-up:${lastSeenJudge}->${judge}`,
      kind: 'judge',
      title: `${delta} 条新待判`,
      themeName: topThemeName || undefined,
    })
  }
  lastSeenJudge = judge
  return {
    count: inboxItems.length + judge,
    inbox: inboxItems.length,
    judge,
    items,
  }
}
