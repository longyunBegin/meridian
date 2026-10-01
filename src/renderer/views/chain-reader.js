/**
 * 链式阅读视图（Phase B）
 *
 * 读者进入主题首先看到的不是网，而是一条叙事链：
 * 主链 = 投影 DAG 的最重路径（linearize），同级节点并为一步，
 * 证据默认收起，对立候选链以「对立视角」页签呈现、交锋点可跳转。
 *
 * 只读投影，不创建/修改/删除 lemma，不改 confidence，不代审批（公理1）。
 */
import { h, clear } from '../lib/dom.js'
import { linearize } from '../lib/chain-linearizer.js'

const m = window.meridian

const KIND_LABEL = { claim: '观点', inference: '推断', evidence: '证据' }
const REASON_LABEL = { 'parallel-branch': '平行分支', 'no-path': '未连接' }

const kindLabel = (n) => KIND_LABEL[n?.kind] || '节点'

function nodeCard(node, opts, extra = {}) {
  const card = h('button', {
    type: 'button',
    class: 'cr-card' + (extra.clash ? ' has-clash' : ''),
    'data-node-id': node.id,
    onclick: () => opts.onOpen?.(node),
  },
    h('span', { class: `cr-kind is-${node.kind}` }, kindLabel(node)),
    h('span', { class: 'cr-card-title' }, node.title || '未命名'),
    node.status ? h('span', { class: 'cr-status' }, node.status) : null,
  )
  return card
}

function evidenceBlock(step, opts) {
  const list = step.evidence || []
  if (!list.length) return null
  const wrap = h('div', { class: 'cr-evidence' })
  const items = h('div', { class: 'cr-evidence-list', hidden: true })
  let open = false
  const btn = h('button', {
    type: 'button', class: 'cr-evidence-toggle', 'aria-expanded': 'false',
    onclick: () => {
      open = !open
      items.hidden = !open
      btn.setAttribute('aria-expanded', String(open))
      btn.querySelector('.cr-evidence-count').textContent = open ? '收起' : `证据 ${list.length} 条`
    },
  }, h('span', { class: 'cr-evidence-count' }, `证据 ${list.length} 条`))
  for (const ev of list) {
    items.append(h('button', {
      type: 'button', class: 'cr-evidence-item',
      onclick: () => opts.onOpen?.(ev),
    }, h('span', { class: 'cr-kind is-evidence' }, '证据'), h('span', {}, ev.title || '未命名')))
  }
  wrap.append(btn, items)
  return wrap
}

function connectorEl(step) {
  if (!step.connector) return null
  return h('div', { class: 'cr-connector' + (step.pendingReview ? ' is-pending' : '') },
    h('span', { class: 'cr-connector-line' }),
    h('span', { class: 'cr-connector-word' }, step.connector),
    step.pendingReview ? h('span', { class: 'cr-pending-chip' }, '待复核') : null,
  )
}

/**
 * 渲染主题页链式阅读区。
 * opts: { onOpen(node) }
 */
export function renderChainReader(theme, opts = {}) {
  const root = h('div', { class: 'chain-reader', 'aria-label': '链式阅读' })
  root.append(h('p', { class: 'cr-loading' }, '正在生成叙事链…'))

  let chains = []
  let clashes = []
  let unplaced = []
  let activeId = 'main'
  const flowBox = h('div', { class: 'cr-flow-box' })

  const clashByStep = (chainId, stepIndex) =>
    clashes.filter((c) =>
      (c.fromChainId === chainId && c.fromStepIndex === stepIndex) ||
      (c.toChainId === chainId && c.toStepIndex === stepIndex))

  function jumpToClash(clash, selfChainId, selfStep) {
    const otherChainId = clash.fromChainId === selfChainId ? clash.toChainId : clash.fromChainId
    const otherStep = clash.fromChainId === selfChainId ? clash.toStepIndex : clash.fromStepIndex
    if (otherChainId === selfChainId) {
      scrollToStep(otherStep)
      return
    }
    setActiveChain(otherChainId)
    requestAnimationFrame(() => scrollToStep(otherStep))
  }

  function scrollToStep(stepIndex) {
    const el = flowBox.querySelector(`[data-step-index="${stepIndex}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('is-flash')
      setTimeout(() => el.classList.remove('is-flash'), 1200)
    }
  }

  function setActiveChain(id) {
    activeId = id
    renderTabs()
    renderFlow()
  }

  const tabsBox = h('div', { class: 'cr-tabs', role: 'tablist', 'aria-label': '叙事链' })

  function chainTabLabel(chain) {
    if (chain.kind === 'main') return '主链'
    return '对立视角'
  }

  function renderTabs() {
    clear(tabsBox)
    if (chains.length <= 1) { tabsBox.hidden = true; return }
    tabsBox.hidden = false
    for (const c of chains) {
      const isActive = c.id === activeId
      tabsBox.append(h('button', {
        type: 'button', role: 'tab',
        class: 'cr-tab' + (isActive ? ' is-active' : ''),
        'aria-selected': String(isActive),
        onclick: () => setActiveChain(c.id),
      }, chainTabLabel(c), c.kind !== 'main' ? h('span', { class: 'cr-tab-flag' }, '待确认') : null))
    }
  }

  function renderFlow() {
    clear(flowBox)
    const chain = chains.find((c) => c.id === activeId) || chains[0]
    if (!chain) return
    if (chain.kind !== 'main') {
      flowBox.append(h('p', { class: 'cr-candidate-note' }, chain.title || '对立候选链（待确认）'))
    }
    const flow = h('ol', { class: 'cr-flow' })
    chain.steps.forEach((step, i) => {
      const stepClashes = clashByStep(chain.id, i)
      const li = h('li', { class: 'cr-step', 'data-step-index': String(i) },
        h('div', { class: 'cr-step-head' },
          h('span', { class: 'cr-step-no' }, `第 ${i + 1} 步`),
          step.nodes.length > 1 ? h('span', { class: 'cr-step-note' }, `${step.nodes.length} 个同级论据`) : null,
          stepClashes.length ? h('button', {
            type: 'button', class: 'cr-clash-btn', title: '存在交锋点，点击跳转',
            onclick: () => jumpToClash(stepClashes[0], chain.id, i),
          }, '⚔️ 交锋') : null,
        ),
        h('div', { class: 'cr-cards' }, ...step.nodes.map((n) => nodeCard(n, opts))),
        evidenceBlock(step, opts),
      )
      flow.append(li)
      const conn = connectorEl(step)
      if (conn) flow.append(h('li', { class: 'cr-connector-row', 'aria-hidden': 'true' }, conn))
    })
    flowBox.append(flow)
  }

  function renderUnplaced() {
    if (!unplaced.length) return null
    const box = h('section', { class: 'cr-unplaced', 'aria-label': '待接入' },
      h('h3', { class: 'cr-unplaced-title' }, `待接入（${unplaced.length}）`),
      h('p', { class: 'cr-unplaced-hint' }, '这些观点尚未进入叙事链，可点开查看后手动接入。'),
    )
    for (const u of unplaced) {
      box.append(h('button', {
        type: 'button', class: 'cr-unplaced-item',
        onclick: () => opts.onOpen?.(u.node),
      }, h('span', { class: `cr-kind is-${u.node.kind}` }, kindLabel(u.node)),
        h('span', {}, u.node.title || '未命名'),
        h('span', { class: 'cr-unplaced-reason' }, REASON_LABEL[u.reason] || '')))
    }
    return box
  }

  async function load() {
    try {
      const proj = await m.chainProjection(theme.id)
      const data = linearize({
        nodes: proj?.allNodes || proj?.nodes || [],
        edges: proj?.allEdges || proj?.edges || [],
      }, { mainTitle: `${theme.name} · 建模主链` })
      chains = data.chains
      clashes = data.clashes
      unplaced = data.unplaced
      if (!chains.length) {
        clear(root)
        root.append(
          h('div', { class: 'cr-empty' },
            h('p', { class: 'cr-empty-title' }, '这个主题还没有观点'),
            h('p', { class: 'cr-empty-hint' }, '添加第一个观点后，这里会自动生成叙事链。')),
        )
        // 注意：renderUnplaced() 为空时返回 null，原生 append(null) 会写入 "null" 文本，必须过滤。
        const un = renderUnplaced()
        if (un) root.append(un)
        return
      }
      if (!chains.some((c) => c.id === activeId)) activeId = chains[0].id
      clear(root)
      root.append(tabsBox, flowBox)
      const un = renderUnplaced()
      if (un) root.append(un)
      renderTabs()
      renderFlow()
    } catch (e) {
      clear(root)
      root.append(h('p', { class: 'cr-error' }, `叙事链生成失败：${e?.message || e}`))
    }
  }

  load()
  return root
}
