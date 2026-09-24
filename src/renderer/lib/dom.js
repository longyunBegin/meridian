/** 够用就好的 DOM 助手——不引框架。 */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') {
      // 自定义属性（--x）必须走 setProperty，直接赋值在部分内核上不生效
      for (const [prop, val] of Object.entries(v)) {
        if (val == null) continue
        if (prop.startsWith('--')) el.style.setProperty(prop, String(val))
        else el.style[prop] = val
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  add(el, children)
  return el
}

export function add(parent, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return parent
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}

/**
 * 原生 Element.append(null) 会把 null 转成字符串 "null" 追加进去。
 * 需要传可能为 null 的子节点时，一律走这里。
 */
export function mount(parent, ...children) {
  add(parent, children)
  return parent
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/** 临时浮层提示，4 秒后自动消失。替代 alert()。 */
export function toast(msg, color = 'var(--text-2)', action = null) {
  const el = document.createElement('div')
  el.className = 'toast' + (color === 'var(--red)' ? ' toast-error' : '')
  el.append(document.createTextNode(msg))
  let timer = setTimeout(() => el.remove(), 4000)
  if (action) {
    const button = document.createElement('button')
    button.className = 'toast-btn'
    button.textContent = action.label
    button.addEventListener('click', async () => {
      clearTimeout(timer)
      el.remove()
      await action.onClick()
    })
    el.append(button)
  }
  document.body.append(el)
  return el
}

export function confirmToast(msg, label = '确认') {
  return new Promise((resolve) => {
    const el = toast(msg, 'var(--red)', { label, onClick: () => resolve(true) })
    setTimeout(() => {
      if (el.isConnected) el.remove()
      resolve(false)
    }, 4000)
  })
}

/** 行内 SVG 图标，1.5px 描边，风格贴近 SF Symbols。 */
const PATHS = {
  capture: 'M4 8v8M8 4v16M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  lattice: 'M5 5v14M5 12h9M19 5v4M19 17v2M14 7h5M14 19h5M19 11h.01M19 17h.01',
  settle: 'M12 8v4l3 2M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z',
  plus: 'M12 5v14M5 12h14',
  export: 'M12 15V3m0 12-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  chevron: 'm9 18 6-6-6-6',
  flag: 'M4 21V4m0 0 8 2 8-2v10l-8 2-8-2',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3',
}

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.classList.add('icon')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', PATHS[name] || '')
  svg.append(p)
  return svg
}
