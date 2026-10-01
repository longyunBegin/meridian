/**
 * 链式阅读视图冒烟测试（DOM stub）。
 * 验证：步骤渲染 / 同级节点 / 连接词 / 证据折叠 / 对立页签与交锋跳转 / 待接入 / 空态。
 * 运行：node test/chain-reader-smoke.test.mjs
 */

/* ---------- 最小 DOM stub ---------- */
class Node {}
globalThis.Node = Node

const parseCls = (el) => new Set((el.className || '').split(/\s+/).filter(Boolean))
const writeCls = (el, s) => { el.className = [...s].join(' ') }

class El extends Node {
  constructor(tag) {
    super()
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = {}
    this.dataset = {}
    this.style = { setProperty() {} }
    this.className = ''
    this.hidden = false
    this.parent = null
    this._listeners = {}
    this.classList = {
      add: (c) => { const s = parseCls(this); s.add(c); writeCls(this, s) },
      remove: (c) => { const s = parseCls(this); s.delete(c); writeCls(this, s) },
      toggle: (c, force) => {
        const s = parseCls(this)
        const want = force === undefined ? !s.has(c) : !!force
        want ? s.add(c) : s.delete(c)
        writeCls(this, s)
        return want
      },
      contains: (c) => parseCls(this).has(c),
    }
  }
  get textContent() {
    return this.children.map((c) => (c && c.textContent) || '').join('')
  }
  set textContent(v) {
    this.children = [{ nodeType: 3, textContent: String(v) }]
  }
  get firstChild() { return this.children[0] || null }
  setAttribute(k, v) {
    this.attributes[k] = String(v)
    if (k === 'class') this.className = String(v)
  }
  getAttribute(k) { return this.attributes[k] ?? null }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn) }
  append(...cs) {
    for (const c of cs.flat(4)) {
      if (c == null || c === false) continue
      c.parent = this
      this.children.push(c)
    }
    return this
  }
  appendChild(c) { return this.append(c) }
  removeChild(c) {
    const i = this.children.indexOf(c)
    if (i >= 0) this.children.splice(i, 1)
    return c
  }
  click() { for (const fn of this._listeners.click || []) fn({}) }
  scrollIntoView() {}
  _match(sel) {
    if (sel.startsWith('.')) return parseCls(this).has(sel.slice(1))
    const m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/)
    if (m) return this.getAttribute(m[1]) === m[2] || this[m[1]] === m[2]
    return this.tagName === sel.toUpperCase()
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (el) => {
      for (const c of el.children || []) {
        if (c instanceof El) {
          if (c._match(sel)) out.push(c)
          walk(c)
        }
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
}

function makeDocument() {
  return {
    createElement: (tag) => new El(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    body: new El('body'),
  }
}

globalThis.document = makeDocument()
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)

/* ---------- 夹具 ---------- */
const N = (id, kind, seq, title) => ({ id, kind, title: title || id, createdSeq: seq })
const E = (id, rel, from, to, extra = {}) => ({ id, rel, from, to, ...extra })

const linear = {
  nodes: [N('A', 'claim', 1, '前提A'), N('B', 'claim', 2, '论据B'), N('C', 'claim', 3, '结论C')],
  edges: [E('e1', 'derives', 'A', 'B'), E('e2', 'derives', 'B', 'C')],
}
const siblings = {
  nodes: [N('b1', 'claim', 1), N('b2', 'claim', 2), N('b3', 'claim', 3), N('b4', 'claim', 4), N('b5', 'claim', 5),
    N('ev1', 'evidence', 6, '关键证据')],
  edges: [
    E('e1', 'supports', 'b1', 'b2'), E('e2', 'supports', 'b1', 'b3'), E('e3', 'supports', 'b1', 'b4'),
    E('e4', 'supports', 'b2', 'b5'), E('e5', 'supports', 'b3', 'b5'), E('e6', 'supports', 'b4', 'b5'),
    E('e7', 'supports', 'ev1', 'b2'),
  ],
}
const clashFx = {
  nodes: [...linear.nodes, N('X', 'claim', 4, '对立观点X')],
  edges: [...linear.edges, E('e9', 'contradicts', 'X', 'C')],
}
const unplacedFx = {
  nodes: [...linear.nodes, N('P', 'claim', 4, '侧支P'), N('Q', 'claim', 5, '侧支Q')],
  edges: [...linear.edges, E('e6', 'supports', 'P', 'Q'), E('e7', 'supports', 'Q', 'B')],
}

let currentFixture = linear
globalThis.window = {
  meridian: {
    chainProjection: async () => JSON.parse(JSON.stringify(currentFixture)),
  },
}

const { renderChainReader } = await import('../src/renderer/views/chain-reader.js')

let pass = 0
let fail = 0
function ok(name, condition, extra = '') {
  condition ? pass++ : fail++
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${extra ? `  ${extra}` : ''}`)
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const theme = { id: 't1', name: '测试主题' }

/* ---- 1. 线性链 ---- */
{
  currentFixture = linear
  let opened = null
  const root = renderChainReader(theme, { onOpen: (n) => { opened = n } })
  await tick()
  const steps = root.querySelectorAll('.cr-step')
  ok('线性：3 步', steps.length === 3, `${steps.length}`)
  const words = root.querySelectorAll('.cr-connector-word').map((e) => e.textContent)
  ok('线性：连接词推导', JSON.stringify(words) === JSON.stringify(['推导', '推导']), JSON.stringify(words))
  ok('线性：单链不显示页签', root.querySelector('.cr-tabs').hidden === true)
  const cards = root.querySelectorAll('.cr-card')
  cards.find((c) => c.textContent.includes('论据B')).click()
  ok('线性：点击卡片打开节点', opened && opened.id === 'B', opened && opened.id)
}

/* ---- 2. 同级节点 + 证据 ---- */
{
  currentFixture = siblings
  let opened = null
  const root = renderChainReader(theme, { onOpen: (n) => { opened = n } })
  await tick()
  const steps = root.querySelectorAll('.cr-step')
  const step2Cards = steps[1].querySelectorAll('.cr-card')
  ok('同级：第二步 3 卡片', step2Cards.length === 3, `${step2Cards.length}`)
  const words = root.querySelectorAll('.cr-connector-word').map((e) => e.textContent)
  ok('同级：共同支撑', words[1] === '共同支撑', JSON.stringify(words))
  const toggle = root.querySelector('.cr-evidence-toggle')
  ok('同级：证据折叠按钮', !!toggle && toggle.textContent.includes('证据 1 条'))
  toggle.click()
  const list = root.querySelector('.cr-evidence-list')
  ok('同级：证据可展开', list.hidden === false)
  list.querySelector('.cr-evidence-item').click()
  ok('同级：证据可点开', opened && opened.id === 'ev1', opened && opened.id)
}

/* ---- 3. 对立页签与交锋跳转 ---- */
{
  currentFixture = clashFx
  const root = renderChainReader(theme, { onOpen: () => {} })
  await tick()
  const tabs = root.querySelectorAll('.cr-tab')
  ok('对立：两个页签', tabs.length === 2, `${tabs.length}`)
  ok('对立：页签名为对立视角', tabs[1].textContent.includes('对立视角'))
  ok('对立：候选标待确认', tabs[1].textContent.includes('待确认'))
  const clashBtn = root.querySelector('.cr-clash-btn')
  ok('对立：交锋按钮', !!clashBtn)
  clashBtn.click()
  await tick(40)
  const activeTab = root.querySelectorAll('.cr-tab').find((t) => t.classList.contains('is-active'))
  ok('对立：交锋跳转切换页签', activeTab && activeTab.textContent.includes('对立视角'))
  const note = root.querySelector('.cr-candidate-note')
  ok('对立：候选说明', !!note && note.textContent.includes('待确认'))
  const cards = root.querySelectorAll('.cr-card')
  ok('对立：候选链含 X', cards.some((c) => c.textContent.includes('对立观点X')))
}

/* ---- 4. 待接入 ---- */
{
  currentFixture = unplacedFx
  const root = renderChainReader(theme, { onOpen: () => {} })
  await tick()
  const items = root.querySelectorAll('.cr-unplaced-item')
  ok('待接入：2 项', items.length === 2, `${items.length}`)
  ok('待接入：标平行分支', items.every((i) => i.textContent.includes('平行分支')))
}

/* ---- 5. 空态 ---- */
{
  currentFixture = { nodes: [], edges: [] }
  const root = renderChainReader(theme, { onOpen: () => {} })
  await tick()
  ok('空态：提示', !!root.querySelector('.cr-empty'))
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
