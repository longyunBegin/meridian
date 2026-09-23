import { h, clear } from '../lib/dom.js'
import { state, refresh } from '../app.js'
import { confColor } from './shared.js'

const m = window.meridian

const planPurge = (scope, dryRunResult, confirmed) => {
  if (dryRunResult.removed === 0) return { willDelete: false, scope, reason: 'empty' }
  if (!confirmed) return { willDelete: false, scope, reason: 'canceled' }
  return { willDelete: true, scope, count: dryRunResult.removed }
}

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
  const deletedTs = await m.deletedThemes()
  const purgePreview = await m.purgeDead('all', { dryRun: true })
  const channels = await m.channelList()
  const fetchers = await m.availableFetchers()

  const toast = h('div', { style: { fontSize: '12px', color: 'var(--text-2)', padding: '6px 0', minHeight: '18px' } }, '')
  const flash = (msg, color = 'var(--text-2)') => {
    toast.textContent = msg
    toast.style.color = color
    setTimeout(() => { toast.textContent = '' }, 3000)
  }

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
      toast,
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
              flash(r.ok ? `拉到 ${r.items.length} 条` : `失败：${r.reason}`)
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

    // ---- 通道与取数
    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '通道与取数'), h('em', {}, String(channels.length))),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 10px', fontSize: '12px', color: 'var(--text-3)', lineHeight: '1.6' } },
          '通道描述符：按内容类型选取数器。已实现的取数器：' + fetchers.join('、') + '。'),
        ...channels.map((ch) => h('div', { class: 'q' },
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text' }, ch.name),
            h('div', { class: 'q-meta' },
              h('span', {}, `${ch.kind} · ${ch.fetch} · ${ch.enabled ? '启用' : '停用'}`),
              fetchers.includes(ch.fetch) ? h('button', {
                class: 'btn', style: { marginLeft: '8px', padding: '2px 8px' },
                onclick: async () => {
                  flash(`正在拉取「${ch.name}」…`)
                  const r = await m.channelFetch(ch.id)
                  if (r.error) { flash(`拉取失败：${r.error}`, 'var(--red)'); return }
                  flash(`拉取到 ${r.items.length} 条`)
                },
              }, '拉取') : h('span', { style: { marginLeft: '8px', color: 'var(--text-3)' } }, '（未实现）'),
            ),
          ),
          h('div', { class: 'q-acts' },
            h('select', {
              class: 'txt', style: { width: 'auto' },
              onchange: async (e) => { await m.channelUpdate(ch.id, { fetch: e.target.value }); flash(`已设 ${ch.name} → ${e.target.value}`) },
            },
              ...['manual', 'rss', 'web', 'edgarConcept', 'edgarFilings', 'cninfo', 'eastmoneyReport', 'jina', 'tavily', 'grok-x-search'].map((f) =>
                h('option', { value: f, selected: ch.fetch === f }, f),
              ),
            ),
            h('button', {
              class: 'btn',
              onclick: async () => { await m.channelUpdate(ch.id, { enabled: !ch.enabled }); await renderSettings(mid) },
            }, ch.enabled ? '停用' : '启用'),
            h('button', {
              class: 'btn', style: { color: 'var(--red)' },
              onclick: async () => { await m.channelRemove(ch.id); flash('已删除通道'); await renderSettings(mid) },
            }, '删除'),
          ),
        )),
        h('div', { class: 'field', style: { marginTop: '8px' } },
          h('label', {}, '新增通道'),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            ...(() => {
              const inputs = {}
              return [
                h('input', { class: 'txt', placeholder: '名称', style: { flex: '1', minWidth: '80px' }, oninput: (e) => inputs.name = e.target.value }),
                h('input', { class: 'txt', placeholder: 'query (URL/CIK/ticker)', style: { flex: '1', minWidth: '80px' }, oninput: (e) => inputs.query = e.target.value }),
                h('select', { class: 'txt', style: { width: 'auto' }, onchange: (e) => inputs.fetch = e.target.value },
                  h('option', { value: 'manual' }, 'manual'),
                  h('option', { value: 'rss' }, 'rss'),
                  h('option', { value: 'web' }, 'web'),
                  h('option', { value: 'edgarConcept' }, 'edgarConcept'),
                  h('option', { value: 'edgarFilings' }, 'edgarFilings'),
                ),
                h('button', {
                  class: 'btn btn-primary',
                  onclick: async () => {
                    if (!inputs.name) { flash('请填名称', 'var(--red)'); return }
                    await m.channelAdd({ name: inputs.name, query: inputs.query || '', fetch: inputs.fetch || 'manual', kind: '自媒体' })
                    flash('已添加通道')
                    await renderSettings(mid)
                  },
                }, '添加'),
              ]
            })(),
          ),
        ),
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-b' },
        h('div', { class: 'q-meta', style: { marginBottom: '10px' } },
          `${stats.themes} 主题 · ${stats.lemmas} 命题（${stats.live} 主图谱 / ${stats.cold} 冷库 / ${stats.dead} 墓碑）· ` +
          `${stats.verdicts} 条裁决 · ${stats.conflicts} 待裁决冲突 · ${stats.due} 待结算 · ${stats.readings} 读数`),
        h('p', { style: { margin: '0 0 10px', fontSize: '12px', color: 'var(--text-2)', lineHeight: '1.6' } },
          '判断在 meridian.json，原文在 raw.jsonl。原文可以随便清——清掉不影响任何一条命题，只是以后复盘不了当初读的是什么。'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => m.openDataDir() }, '打开数据目录'),
          h('button', {
            class: 'btn',
            onclick: async () => {
              const r = await m.rawPrune()
              flash(`清理了 ${r.removed} 条无引用原文，保留 ${r.kept} 条`)
              await renderSettings(mid)
            },
          }, '清理无引用原文'),
          h('button', {
            class: 'btn', style: { color: 'var(--red)' },
            onclick: async () => {
              if (!confirm('清空全部原文？\n\n判断、置信度、校准曲线全部保留，但所有「看原文」都会失效。')) return
              const r = await m.rawClear()
              flash(`已清空 ${r.removed} 条原文，摘除 ${r.unlinked} 处引用`)
              await renderSettings(mid)
            },
          }, '清空全部原文'),
          h('button', {
            class: 'btn', style: { color: 'var(--red)' },
            onclick: async () => {
              const preview = await m.purgeDead('user', { dryRun: true })
              const confirmed = preview.removed > 0 && confirm(`真删 ${preview.removed} 条你用 ⌘⌫ 删的节点？\n\n不可恢复。`)
              const plan = planPurge('user', preview, confirmed)
              if (!plan.willDelete) { if (plan.reason === 'empty') flash('没有你删的节点'); return }
              const r = await m.purgeDead(plan.scope)
              flash(`已真删 ${r.removed} 条你删的节点`)
              await renderSettings(mid)
            },
          }, `清空我删的（${purgePreview.userDeleted}）`),
          h('button', {
            class: 'btn', style: { color: 'var(--red)' },
            onclick: async () => {
              const preview = await m.purgeDead('auto', { dryRun: true })
              const confirmed = preview.removed > 0 && confirm(`真删 ${preview.removed} 条置信度跌破 20 自动进墓的节点？\n\n不可恢复。`)
              const plan = planPurge('auto', preview, confirmed)
              if (!plan.willDelete) { if (plan.reason === 'empty') flash('没有跌死的节点'); return }
              const r = await m.purgeDead(plan.scope)
              flash(`已真删 ${r.removed} 条跌死的节点`)
              await renderSettings(mid)
            },
          }, `清空跌死的（${purgePreview.autoDead}）`),
        ),
      ),
    ),

    // ---- 已删主题（可恢复）
    deletedTs.length ? h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '已删主题'), h('em', {}, String(deletedTs.length))),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 10px', fontSize: '12px', color: 'var(--text-3)', lineHeight: '1.6' } },
          '软删的主题可恢复。节点仍在墓碑区，恢复后整棵子树复活。'),
        ...deletedTs.map((t) => h('div', { class: 'q' },
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text' }, t.name),
            h('div', { class: 'q-meta' }, h('span', {}, `删于 ${t.deletedAt}`)),
          ),
          h('div', { class: 'q-acts' },
            h('button', {
              class: 'btn',
              onclick: async () => { await m.restoreTheme(t.id); flash(`已恢复主题「${t.name}」`, 'var(--green)'); await renderSettings(mid) },
            }, '恢复'),
            h('button', {
              class: 'btn', style: { color: 'var(--red)' },
              onclick: async () => {
                if (!confirm(`永久删除主题「${t.name}」及其所有节点？\n\n不可恢复。`)) return
                await m.removeTheme(t.id)
                await m.purgeDead('all')
                flash(`已永久删除主题「${t.name}」`)
                await renderSettings(mid)
              },
            }, '真删'),
          ),
        )),
      ),
    ) : null,

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
                catch { flash('导入失败：不是有效的脉络数据', 'var(--red)') }
              }
              input.click()
            },
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
