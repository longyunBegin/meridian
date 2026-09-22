/**
 * 捕获 HUD：⌘⇧V 全局唤起。
 *
 * 两段式：输入原文 → 打标 + 抽取 + 去重 + 冲突检测 → 勾选入库。
 * 没有 API key 时降级为手工录入（整段原文作为一条观测命题），降级路径永远存在。
 */
import { h, mount, clear } from './lib/dom.js'
import { confColor, TYPE_LABEL, TYPE_CLASS } from './views/shared.js'

const m = window.meridian
const input = document.getElementById('input')
const stage = document.getElementById('stage')

let themes = []
let themeId = null
let result = null
let picked = new Set()

// ---------------------------------------------------------------- 渲染

function idle() {
  clear(stage)
  stage.append(h('div', { class: 'hud-hint' },
    h('span', {}, themeId ? '' : '先建一个主题'),
    h('span', { class: 'spacer' }),
    h('span', {}, '⏎ 入库为命题'),
    h('span', { class: 'kbd' }, 'esc'),
  ))
  m.captureResize(150)
}

function busy() {
  clear(stage)
  stage.append(h('div', { class: 'hud-spin' }, h('span', { class: 'hud-dot' }), '正在归位…'))
}

async function run() {
  const text = input.value.trim()
  if (!text || !themeId) { hide(); return }

  busy()
  try {
    result = await m.process(text, themeId)
  } catch {
    result = null
  }
  if (!result) { idle(); return }

  picked = new Set((result.lemmas || []).map((_, i) => i))
  showResult()
}

function showResult() {
  clear(stage)
  const label = result.label || {}
  const lemmas = result.lemmas || []

  // ---- Jev 三项打标
  const choiceCard = h('div', {},
    h('div', { class: 'k' }, 'CHOICE · 来源类型'),
    h('div', { class: 'v' }, label.kind || '未标'),
    h('div', { class: 'd' }, `质量 ${label.quality ?? '—'} · 经 ${viaLabel(label.via)}`),
  )

  const scoreCard = h('div', {},
    h('div', { class: 'k' }, 'SCORE · 来源质量'),
    h('div', { class: 'v' }, label.quality ?? '—'),
    h('div', { class: 'd' }, label.jevScore != null ? `Jev 打 ${label.jevScore}，最终取表值` : '查表裁决'),
  )

  const noulCard = h('div', {},
    h('div', { class: 'k' }, 'NOUL · 是否重复'),
    h('div', {
      class: 'v',
      style: { color: lemmas.some((l) => l.action === 'merge') ? 'var(--teal)' : 'var(--green)' },
    }, lemmas.some((l) => l.action === 'merge') ? '有重复' : '新 claim'),
    h('div', { class: 'd' }, lemmas.some((l) => l.action === 'merge') ? '重复项将只 +1 来源' : '与库内命题无可合并'),
  )

  const list = h('div', { class: 'hud-list' },
    ...lemmas.map((l, i) => {
      const lab = TYPE_LABEL[l.type] || TYPE_LABEL.hypothesis
      const cls = TYPE_CLASS[l.type] || TYPE_CLASS.hypothesis
      const on = picked.has(i)
      return h('button', {
        class: 'hud-item',
        'aria-selected': String(on),
        onclick: () => { on ? picked.delete(i) : picked.add(i); showResult() },
      },
        h('span', { class: 'ck', dataset: { on: String(on) } }),
        h('span', { class: `badge badge-${cls}` }, lab),
        h('span', { style: { flex: '1', minWidth: '0' } },
          h('div', { class: 't' }, l.title),
          h('div', { class: 'p' },
            l.action === 'merge'
              ? `合并到「${l.parentLabel}」· 相似度 ${l.mergeScore}`
              : (l.parentLabel || '未归位')),
        ),
        l.action === 'merge'
          ? h('span', { class: 'act act-merge' }, '+1 源')
          : h('span', { class: 'act act-new' }, '新建'),
        l.conflicts?.length ? h('span', { class: 'cf', title: `与「${l.conflicts[0].title}」${l.conflicts[0].reason}` }, '冲突') : null,
        h('span', { class: 'bar' }, h('i', { style: { width: `${l.confidence}%`, background: confColor(l.confidence) } })),
        h('span', { style: { fontSize: '11px', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums', width: '22px', textAlign: 'right' } }, String(l.confidence)),
      )
    }),
  )

  const themeSel = h('select', {
    class: 'sel', style: { height: '22px', fontSize: '11px', flex: '0 0 130px' },
    onchange: async (e) => { themeId = e.target.value; await run() },
  }, ...themes.map((t) => h('option', { value: t.id, selected: t.id === themeId || undefined }, t.name)))

  const tray = result.rejected?.length
    ? h('div', { class: 'hud-tray' },
        h('div', { class: 'k' }, `被筛掉 · ${result.rejected.length} 条（留裁决记录，不留原文）`),
        ...result.rejected.map((r) => h('div', { class: 'r' },
          h('span', {}, r.summary),
          h('span', { class: 'why' }, r.why),
        )),
      )
    : null

  clear(stage)
  mount(stage,
    h('div', { class: 'jev' }, choiceCard, scoreCard, noulCard),
    h('div', { class: 'hud-hint' }, themeSel, h('span', { class: 'spacer' }), h('span', {}, `${picked.size}/${lemmas.length} 条`)),
    list,
    tray,
    h('div', { class: 'hud-foot' },
      h('span', {}, '点击取消勾选'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'kbd' }, '⏎'), h('span', {}, '入库'),
      h('span', { class: 'kbd' }, 'esc'),
    ),
  )
  m.captureResize(Math.min(560, 250 + lemmas.length * 40 + (tray ? result.rejected.length * 20 + 34 : 0)))
}

function viaLabel(v) {
  return v === 'jev' ? 'Jev' : v === 'llm' ? '前沿模型' : '查表'
}

async function save() {
  const chosen = [...picked].sort((a, b) => a - b).map((i) => result.lemmas[i])
  // text 一起带上：主进程要把它落进原文层，否则以后无法复盘当时读的是什么
  m.captureSave({ themeId, lemmas: chosen, labelKind: result.label?.kind, text: input.value.trim() })
  hide()
}

function hide() {
  input.value = ''
  result = null
  picked.clear()
  idle()
  window.close()
}

// ---------------------------------------------------------------- 事件

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    result ? save() : run()
  }
  if (e.key === 'Escape') { e.preventDefault(); hide() }
})

stage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); save() }
  if (e.key === 'Escape') { e.preventDefault(); hide() }
})

m.onCaptureReset(() => hide())
m.onCaptureFocus((text) => { input.value = text; input.focus() })

// ---------------------------------------------------------------- 启动

async function init() {
  themes = await m.themes()
  themeId = themes[0]?.id || null
  const preset = new URLSearchParams(location.search).get('text')
  if (preset) input.value = preset
  idle()
  if (new URLSearchParams(location.search).get('autorun')) setTimeout(run, 250)
  m.captureReady()
  input.focus()
}

init()
