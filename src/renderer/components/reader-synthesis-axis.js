/**
 * 合成轴（设计提案 01）：强度（线）× 外部数据（点）× 确认/修订（台阶）画在同一条日期轴上。
 *
 * 只做展示：数据全部来自账本事件与投影的 confidenceHistory（见 reader-model 的
 * buildSynthesisAxis）。没有强度记录时如实画成"无曲线"，只用轨道显示外部数据累积，
 * 不编造叙事化的起伏。
 */
import { READER_STATE_META } from '../lib/theme-network.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
let instanceCount = 0

function svgEl(name, attrs = {}) {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null && value !== false) element.setAttribute(key, String(value))
  }
  return element
}

function svgText(value, attrs = {}) {
  const element = svgEl('text', attrs)
  element.textContent = String(value ?? '')
  return element
}

const dateLabel = (value) => {
  /* 模型给的是毫秒时间戳（也可能是 ISO 串），两种都要认，否则 x 轴会显示成 "—"。 */
  const time = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(time)) return '—'
  const date = new Date(time)
  const two = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

const DOT_COLOR = {
  supports: READER_STATE_META.supported.color,
  contradicts: READER_STATE_META.challenged.color,
  unstated: READER_STATE_META.unevaluated.color,
}

export function renderSynthesisAxis(model, { nodeTitle = '', onHover = null } = {}) {
  const W = 960
  const H = 236
  const padL = 46
  const padR = 20
  const padT = 26
  const padB = 66
  const fillId = `rdr-axis-fill-${++instanceCount}`
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'rdr-axis-svg',
    role: 'img',
    'aria-label': nodeTitle
      ? `${nodeTitle} 的强度、外部数据与确认/修订在同一条日期轴上的合成视图`
      : '主题的强度、外部数据与确认/修订在同一条日期轴上的合成视图',
  })
  const series = Array.isArray(model?.series) ? model.series : []
  const evidence = Array.isArray(model?.evidence) ? model.evidence : []
  const steps = Array.isArray(model?.steps) ? model.steps : []

  /* y 轴按数据自适应：曲线才有起伏可读，而不是被 0–100 压平（原型同款做法）。 */
  const values = series.map((point) => point.value)
  let lo = 0
  let hi = 100
  if (values.length) {
    lo = Math.max(0, Math.floor((Math.min(...values) - 6) / 5) * 5)
    hi = Math.min(100, Math.ceil((Math.max(...values) + 6) / 5) * 5)
    if (hi - lo < 10) hi = Math.min(100, lo + 10)
  }
  const x = (t) => padL + Math.min(1, Math.max(0, Number(t) || 0)) * (W - padL - padR)
  const y = (v) => padT + (1 - (Math.min(hi, Math.max(lo, Number(v) || 0)) - lo) / (hi - lo)) * (H - padT - padB)

  const defs = svgEl('defs')
  const gradient = svgEl('linearGradient', { id: fillId, x1: '0', x2: '0', y1: '0', y2: '1' })
  gradient.append(
    svgEl('stop', { offset: '0', 'stop-color': READER_STATE_META.evidenced.color, 'stop-opacity': '.18' }),
    svgEl('stop', { offset: '1', 'stop-color': READER_STATE_META.evidenced.color, 'stop-opacity': '0' }),
  )
  defs.append(gradient)
  svg.append(defs)

  const gridLayer = svgEl('g', { class: 'rdr-axis-grid', 'aria-hidden': 'true' })
  const tickCount = 4
  for (let index = 0; index <= tickCount; index++) {
    const value = Math.round(lo + ((hi - lo) * index) / tickCount)
    const lineY = y(value)
    gridLayer.append(svgEl('line', { x1: padL, x2: W - padR, y1: lineY.toFixed(1), y2: lineY.toFixed(1), class: 'rdr-axis-grid-line' }))
    gridLayer.append(svgText(`${value}%`, {
      x: padL - 9, y: (lineY + 4).toFixed(1), 'text-anchor': 'end', class: 'rdr-axis-tick',
    }))
  }
  svg.append(gridLayer)

  /* 强度线 + 面积：只有 ≥2 个点才画曲线；一个点画圆点；没有点如实留空。 */
  if (series.length >= 2) {
    const ordered = [...series].sort((a, b) => a.t - b.t)
    const line = ordered.map((point, index) => `${index ? 'L' : 'M'}${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')
    const area = svgEl('path', {
      d: `${line} L${x(ordered[ordered.length - 1].t).toFixed(1)},${(H - padB).toFixed(1)} L${x(ordered[0].t).toFixed(1)},${(H - padB).toFixed(1)} Z`,
      fill: `url(#${fillId})`, class: 'rdr-axis-area',
    })
    const path = svgEl('path', { d: line, class: 'rdr-axis-line', 'data-points': String(ordered.length) })
    svg.append(area, path)
  }
  if (series.length) {
    const seriesLayer = svgEl('g', { class: 'rdr-axis-series' })
    for (const point of series) {
      const dot = svgEl('circle', { cx: x(point.t).toFixed(1), cy: y(point.value).toFixed(1), r: 3.2, class: 'rdr-axis-point' })
      dot.append(svgText('', {}))
      const title = svgEl('title')
      title.textContent = `${dateLabel(point.at)} · 强度 ${point.value}%${point.reason ? ` · ${point.reason}` : ''}`
      dot.append(title)
      if (typeof onHover === 'function') {
        dot.addEventListener('mouseenter', () => onHover(`${dateLabel(point.at)} · 强度 ${point.value}%${point.reason ? ` · ${point.reason}` : ''}`))
      }
      seriesLayer.append(dot)
    }
    svg.append(seriesLayer)
  }

  /* 外部数据轨道 + 到曲线的细引线：一眼看出"这条数据把强度推到哪"。 */
  const railY = H - 30
  const railLayer = svgEl('g', { class: 'rdr-axis-rail' })
  railLayer.append(svgEl('line', { x1: padL, x2: W - padR, y1: railY, y2: railY, class: 'rdr-axis-rail-line' }))
  for (const point of evidence) {
    const color = DOT_COLOR[point.kind] || DOT_COLOR.unstated
    const cx = x(point.t)
    if (series.length >= 2) {
      const nearest = [...series].sort((a, b) => Math.abs(a.t - point.t) - Math.abs(b.t - point.t))[0]
      railLayer.append(svgEl('line', {
        x1: cx.toFixed(1), x2: cx.toFixed(1), y1: (railY - 5).toFixed(1), y2: y(nearest.value).toFixed(1),
        stroke: color, 'stroke-width': 0.7, opacity: 0.14, class: 'rdr-axis-leader',
      }))
    }
    const dot = svgEl('circle', { cx: cx.toFixed(1), cy: railY, r: 2.7, fill: color, class: `rdr-axis-evidence is-${point.kind}` })
    const title = svgEl('title')
    const kindLabel = point.kind === 'supports' ? '支持' : point.kind === 'contradicts' ? '挑战' : '未表态'
    title.textContent = `${dateLabel(point.at)} · ${kindLabel} · ${point.label}`
    dot.append(title)
    if (typeof onHover === 'function') {
      dot.addEventListener('mouseenter', () => onHover(`${dateLabel(point.at)} · ${kindLabel} · ${point.label}`))
    }
    railLayer.append(dot)
  }
  svg.append(railLayer)

  /* 确认/修订台阶：竖向虚线 + 台阶标记 + 标签。 */
  const stepLayer = svgEl('g', { class: 'rdr-axis-steps' })
  const usedLabelY = new Map()
  for (const step of steps) {
    const cx = x(step.t)
    const color = step.kind === 'rejected' ? READER_STATE_META.challenged.color : step.kind === 'revision' ? '#af52de' : READER_STATE_META.supported.color
    stepLayer.append(svgEl('line', {
      x1: cx.toFixed(1), x2: cx.toFixed(1), y1: padT, y2: (H - padB).toFixed(1),
      stroke: color, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.5, class: `rdr-axis-step is-${step.kind}`,
    }))
    stepLayer.append(svgEl('rect', {
      x: (cx - 4).toFixed(1), y: (padT - 5).toFixed(1), width: 8, height: 8, rx: 2, fill: color, class: 'rdr-axis-step-mark',
    }))
    const label = svgText(step.label, {
      x: cx.toFixed(1), y: (H - padB + 14 + (usedLabelY.get(step.label) || 0) * 12).toFixed(1),
      'text-anchor': 'middle', class: 'rdr-axis-step-label',
    })
    usedLabelY.set(step.label, (usedLabelY.get(step.label) || 0) + 1)
    stepLayer.append(label)
  }
  svg.append(stepLayer)

  /* x 轴：真实日期，两端一定标出。 */
  const axisLayer = svgEl('g', { class: 'rdr-axis-dates' })
  axisLayer.append(svgText(dateLabel(model?.start), { x: padL, y: H - 8, 'text-anchor': 'start', class: 'rdr-axis-date' }))
  axisLayer.append(svgText(dateLabel(model?.end), { x: W - padR, y: H - 8, 'text-anchor': 'end', class: 'rdr-axis-date' }))
  if (series.length === 0) {
    axisLayer.append(svgText('这个原子还没有强度记录：确认归因后强度才会开始累积', {
      x: W / 2, y: padT + (H - padT - padB) / 2, 'text-anchor': 'middle', class: 'rdr-axis-empty',
    }))
  }
  svg.append(axisLayer)
  return svg
}
