import { h, clear } from '../lib/dom.js'
import { state, refresh } from '../app.js'
import { confColor } from './shared.js'

const m = window.meridian

export async function renderSettings(mid) {
  clear(mid)
  const [settings, templates] = await Promise.all([m.settings(), m.templates()])
  state.settings = settings

  const field = (label, control, hint) => h('div', { class: 'field', style: { alignItems: 'flex-start' } },
    h('label', { style: { paddingTop: '5px' } }, label),
    h('div', { style: { flex: '1', minWidth: '0' } }, control,
      hint ? h('p', { style: { margin: '5px 0 0', fontSize: '11px', color: 'var(--text-3)', lineHeight: '1.5' } }, hint) : null),
  )

  const txt = (value, onCommit, placeholder) => h('input', {
    class: 'txt', value: value || '', placeholder,
    onchange: (e) => onCommit(e.target.value.trim()),
  })

  /** 密钥字段：password 类型 + 显示/隐藏 + 保存按钮 */
  const secret = (value, onCommit, placeholder) => {
    const input = h('input', {
      class: 'txt', type: 'password', value: value || '', placeholder,
      style: { flex: '1' },
    })
    const toggle = h('button', {
      class: 'btn btn-icon', title: '显示/隐藏', style: { flex: 'none' },
      onclick: () => { input.type = input.type === 'password' ? 'text' : 'password' },
    }, '👁')
    const feedback = h('span', { style: { fontSize: '11px', color: 'var(--text-3)', minWidth: '40px' } }, '')
    const save = h('button', {
      class: 'btn btn-primary', style: { height: '28px', flex: 'none' },
      onclick: async () => {
        feedback.textContent = '保存中…'
        feedback.style.color = 'var(--text-3)'
        try {
          await onCommit(input.value.trim())
          feedback.textContent = '✓ 已保存'
          feedback.style.color = 'var(--green)'
        } catch {
          feedback.textContent = '✗ 失败'
          feedback.style.color = 'var(--red)'
        }
        setTimeout(() => { feedback.textContent = '' }, 3000)
      },
    }, '保存')
    return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, input, toggle, save, feedback)
  }

  const seg = (cur, options, onPick) => h('div', { class: 'seg' },
    ...options.map(([v, label]) => h('button', {
      'aria-selected': cur === v ? 'true' : 'false',
      onclick: () => onPick(v),
    }, label)),
  )

  const stats = await m.stats()
  const raw = await m.rawStats()
  const feeds = await m.feeds()

  const mb = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)

  // ---------------------------------------------------------------- 来源分类
  const kinds = settings.sourceQuality || []
  const maxQ = Math.max(...kinds.map(([, q]) => q), 1)
  const VIA = { table: '查表', jev: 'Jev', llm: '前沿模型' }

  const testOut = h('p', {
    style: { margin: '10px 0 0', fontSize: '12px', color: 'var(--text-2)', lineHeight: '1.6', minHeight: '18px' },
  })
  const testBox = h('textarea', {
    class: 'txt', rows: '3', placeholder: '粘贴任意原文，看它怎么被归类…',
    style: { height: 'auto', padding: '7px 8px', resize: 'vertical', lineHeight: '1.5' },
  })
  const runTest = async () => {
    const text = testBox.value.trim()
    if (!text) { testOut.textContent = ''; return }
    testOut.textContent = '打标中…'
    try {
      const r = await m.labelTest(text)
      const parts = [`命中 ${r.kind}`, `质量分 ${r.quality}`, `走 ${VIA[r.via] || r.via}`]
      if (r.jevScore != null) parts.push(`Jev Score ${r.jevScore}`)
      if (r.noul != null) parts.push(`Noul ${r.noul}`)
      testOut.textContent = `→ ${parts.join(' · ')}`
    } catch {
      testOut.textContent = '→ 打标失败，请检查接口与密钥'
    }
  }

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '设置'),
      h('p', {}, '归位与打标。没有 key 也能用——捕获时整段原文会存成一条观测命题。'),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '来源打标器')),
      h('div', { class: 'sect-b' },
        field('打标器', seg(settings.labeler, [
          ['table', '查表（默认）'],
          ['jev', 'Jev'],
          ['llm', '前沿模型'],
        ], async (v) => { await m.saveSettings({ labeler: v }); await renderSettings(mid) }),
          '质量分一律由 SOURCE_QUALITY 表裁决，打标器只负责选类型——否则换一个模型，整条校准曲线的基准就漂移了。'),
        field('Jev 接口', txt(settings.jevBaseUrl, (v) => m.saveSettings({ jevBaseUrl: v }), 'https://openrouter.ai/api/v1'), 'System One Model，只做判断不聊天。'),
        field('Jev 密钥', secret(settings.jevKey, (v) => m.saveSettings({ jevKey: v }), 'sk-…'), 'AES-256-GCM 加密存储，机器绑定，不上传。'),
        field('Jev 模型', txt(settings.jevModel, (v) => m.saveSettings({ jevModel: v }), 'typesafe/jev-1.13')),
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '来源分类'), h('em', {}, `${kinds.length} 类`)),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 12px', fontSize: '12px', color: 'var(--text-2)', lineHeight: '1.6' } },
          '外部内容按来源分七类。打标器只负责选类型，质量分一律由这张表裁决——这是校准曲线唯一的基准，改一条，历史全部不可比。'),
        h('div', { class: 'kinds' },
          ...kinds.map(([label, q]) => h('div', { class: 'kind-row' },
            h('span', { class: 'kind-name' }, label),
            h('span', { class: 'kind-bar' },
              h('i', { style: { width: `${(q / maxQ) * 100}%`, background: confColor(q * 100) } })),
            h('span', { class: 'kind-q' }, q.toFixed(2)),
          )),
        ),
        h('div', { class: 'sect-h', style: { marginTop: '18px' } }, h('h2', { style: { fontSize: '12px' } }, '试一段')),
        testBox,
        h('button', { class: 'btn', style: { marginTop: '6px' }, onclick: runTest }, '打标看看'),
        testOut,
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '命题抽取')),
      h('div', { class: 'sect-b' },
        field('接口地址', txt(settings.baseUrl, (v) => m.saveSettings({ baseUrl: v }), 'https://api.stepfun.com/v1'), '任意 OpenAI 兼容端点。'),
        field('密钥', secret(settings.apiKey, (v) => m.saveSettings({ apiKey: v }), 'sk-…'), 'AES-256-GCM 加密存储，机器绑定。'),
        field('模型', txt(settings.model, (v) => m.saveSettings({ model: v }), 'step-3'), '只做「抽取命题」，不需要太强的模型。'),
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '主题骨架')),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 10px', fontSize: '12px', color: 'var(--text-2)', lineHeight: '1.6' } },
          '骨架只提供产业结构，不含任何判断。用它起步，然后填你自己的命题。'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          ...templates.map((t) => h('button', {
            class: 'btn', style: { height: '28px' },
            onclick: async () => { await m.addThemeFromTemplate(t.id); await refresh() },
          }, `＋ ${t.name} · ${t.version}`)),
        ),
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '订阅源'), h('em', {}, `${feeds.length} 个`)),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 10px', fontSize: '12px', color: 'var(--text-2)', lineHeight: '1.6' } },
          'RSS / Atom 订阅源。定时拉取，走和 ⌘⇧V 同一条捕获流水线——把「搬」从手动变自动。'),
        feeds.length ? h('div', { class: 'src-list', style: { marginBottom: '10px' } },
          ...feeds.map((f) => h('div', { class: 'src-row' },
            h('span', { class: `badge ${f.enabled ? 'badge-observation' : 'badge-hypothesis'}` }, f.kind),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
            h('span', { class: 'q' }, f.lastFetch ? `${f.lastCount} 条 · ${f.lastFetch}` : '未拉取'),
            h('button', { class: 'btn btn-icon', title: '拉取', onclick: async () => {
              const r = await m.feedFetch(f.id)
              alert(r.ok ? `拉到 ${r.items.length} 条` : `失败：${r.reason}`)
              await renderSettings(mid)
            } }, '↻'),
            h('button', { class: 'btn btn-icon', title: '删除', onclick: async () => {
              await m.feedRemove(f.id); await renderSettings(mid)
            } }, '×'),
          )),
        ) : null,
        h('div', { class: 'field', style: { marginTop: '8px' } },
          h('label', {}, 'URL'),
          h('input', {
            class: 'txt', placeholder: 'https://example.com/feed.xml',
            onkeydown: async (e) => {
              if (e.key !== 'Enter') return
              const url = e.target.value.trim()
              if (!url) return
              await m.feedAdd({ url, kind: 'rss', name: url, themeId: state.themeId, interval: 60 })
              e.target.value = ''
              await renderSettings(mid)
            },
          }),
        ),
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-b' },
        h('div', { class: 'q-meta', style: { marginBottom: '10px' } },
          `${stats.themes} 主题 · ${stats.lemmas} 命题（${stats.live} 主图谱 / ${stats.cold} 冷库 / ${stats.dead} 墓碑）· ` +
          `${stats.verdicts} 条裁决 · ${stats.conflicts} 待裁决冲突 · ${stats.due} 待结算`),
        h('p', { style: { margin: '0 0 10px', fontSize: '12px', color: 'var(--text-2)', lineHeight: '1.6' } },
          '判断在 meridian.json，原文在 raw.jsonl。原文可以随便清——清掉不影响任何一条命题，只是以后复盘不了当初读的是什么。'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => m.openDataDir() }, '打开数据目录'),
          h('button', {
            class: 'btn',
            onclick: async () => {
              const r = await m.rawPrune()
              alert(`清理了 ${r.removed} 条无引用原文，保留 ${r.kept} 条`)
              await renderSettings(mid)
            },
          }, '清理无引用原文'),
          h('button', {
            class: 'btn', style: { color: 'var(--red)' },
            onclick: async () => {
              if (!confirm('清空全部原文？\n\n判断、置信度、校准曲线全部保留，但所有「看原文」都会失效。')) return
              const r = await m.rawClear()
              alert(`已清空 ${r.removed} 条原文，摘除 ${r.unlinked} 处引用`)
              await renderSettings(mid)
            },
          }, '清空全部原文'),
        ),
      ),
    ),

    // ---- 数据主权
    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '数据主权')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'row', style: { gap: '8px' } },
          h('button', {
            class: 'btn',
            onclick: async () => {
              const json = await m.exportAll()
              const blob = new Blob([json], { type: 'application/json' })
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = `meridian-${new Date().toISOString().slice(0, 10)}.json`
              a.click()
              URL.revokeObjectURL(a.href)
            },
          }, '导出 JSON'),
          h('button', {
            class: 'btn',
            onclick: () => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.json'
              input.onchange = async () => {
                const file = input.files[0]
                if (!file) return
                const text = await file.text()
                try { await m.importAll(text); await renderSettings(mid) }
                catch { alert('导入失败：不是有效的脉络数据') }
              }
            }).click(),
          }, '导入 JSON'),
          h('button', {
            class: 'btn',
            onclick: () => m.openDataDir(),
          }, '打开数据目录'),
        ),
      ),
    ),
  ))
}
