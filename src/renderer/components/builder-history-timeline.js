import { h } from '../lib/dom.js'
import { buildEventTimeline } from '../lib/theme-network.js'

export function builderHistoryTimelineModel(events = []) {
  const points = buildEventTimeline(events)
  return {
    points,
    hasDates: points.some((point) => point.day != null),
  }
}

export function describeBuilderHistoryPoint(point) {
  if (!point) return '暂无可回放的已校验事件；不会从节点数量推断日期。'
  const date = point.day == null ? '日期未记录' : point.date
  return `${date} · 第 ${point.seq} 条事件`
}

/**
 * A genuine Builder history hand-off: the event prefix is selected here, and
 * reading/playing that network happens in Reader using chainProjectionAt.
 */
export function renderBuilderHistoryTimeline(events = [], { onViewAtSequence, onReturnLive } = {}) {
  const { points, hasDates } = builderHistoryTimelineModel(events)
  const slider = h('input', {
    class: 'builder-history-slider', type: 'range', min: '0',
    max: String(Math.max(0, points.length - 1)), step: '1',
    value: String(Math.max(0, points.length - 1)), disabled: points.length < 2,
    'aria-label': '选择 Builder 历史账本事件',
  })
  const status = h('span', { class: 'builder-history-status', role: 'status', 'aria-live': 'polite' })
  const startLabel = h('span', { class: 'builder-history-endpoint' }, points.length ? (points[0].day == null ? `第 ${points[0].seq} 条` : points[0].date) : '起点')
  const endLabel = h('span', { class: 'builder-history-endpoint' }, points.length ? (points.at(-1).day == null ? `第 ${points.at(-1).seq} 条` : points.at(-1).date) : '当前')
  const currentPoint = () => points[Math.max(0, Math.min(points.length - 1, Number(slider.value)))] || null
  const updateStatus = () => { status.textContent = describeBuilderHistoryPoint(currentPoint()) }
  slider.addEventListener('input', updateStatus)
  slider.addEventListener('change', updateStatus)
  const open = (play = false) => {
    const point = currentPoint()
    if (point) onViewAtSequence?.(point.seq, play)
  }
  const viewButton = h('button', { type: 'button', class: 'btn builder-history-view', disabled: !points.length, onclick: () => open(false) }, '查看此时网络')
  const playButton = h('button', { type: 'button', class: 'btn btn-primary builder-history-play', disabled: !points.length, onclick: () => open(true) }, '播放')
  const liveButton = h('button', {
    type: 'button', class: 'btn builder-history-live', disabled: !points.length,
    onclick: () => { if (points.length) { slider.value = String(points.length - 1); updateStatus(); onReturnLive?.() } },
  }, '当前')
  const note = h('span', { class: 'builder-history-note' }, points.length
    ? (hasDates ? '只使用已校验事件的时间；日期缺失处按账本序号显示。' : '没有可用时间元数据；按已校验账本序号选择，不推断日期。')
    : '暂无可回放的已校验事件。')
  const root = h('section', { class: 'builder-history-timeline', 'aria-label': '主题时间回放' },
    h('div', { class: 'builder-history-title' }, h('strong', {}, '时间回放'), note),
    h('div', { class: 'builder-history-track' }, startLabel, slider, endLabel),
    status,
    h('div', { class: 'builder-history-actions' }, viewButton, playButton, liveButton))
  updateStatus()
  return root
}
