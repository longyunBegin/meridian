import { h, clear, confirmToast, toast } from '../lib/dom.js'
import { state } from '../app.js'
import { confColor } from './shared.js'

const m = window.meridian

async function openDataDirectory(event) {
  const button = event.currentTarget
  button.disabled = true
  try {
    const result = await m.openDataDir()
    if (!result?.ok) toast(`无法打开数据目录：${result?.error || '请稍后重试'}`, 'var(--red)')
  } catch (error) {
    toast(`无法打开数据目录：${error.message || '请稍后重试'}`, 'var(--red)')
  } finally { button.disabled = false }
}

const planPurge = (scope, dryRunResult, confirmed) => {
  if (dryRunResult.removed === 0) return { willDelete: false, scope, reason: 'empty' }
  if (!confirmed) return { willDelete: false, scope, reason: 'canceled' }
  return { willDelete: true, scope, count: dryRunResult.removed }
}

export async function renderSettings(mid) {
  // 设置页任何一项改动都会整体重画，滚动位置随之归零——用户调个滑杆就被弹回页首。
  // 重画前把 .page 的 scrollTop 记下来，画完还回去。这一处覆盖全部 13 个自调点，
  // 比在每个 onclick 里各存一遍可靠。
  const keepScroll = mid.querySelector('.page')?.scrollTop || 0
  clear(mid)
  let settings = await m.settings()
  // 「前沿模型」档位已移除。旧设置里读到它时归一到查表——
  // 不归一的话两个 tab 都不选中，界面看起来像坏了。
  if (settings.labeler === 'llm') {
    await m.saveSettings({ labeler: 'table' })
    settings.labeler = 'table'
  }
  state.settings = settings

  const field = (label, control, hint) => h('div', { class: 'field', style: { alignItems: 'flex-start' } },
    h('label', { style: { paddingTop: '5px' } }, label),
    h('div', { style: { flex: '1', minWidth: '0' } }, control,
      hint ? h('p', { style: { margin: '5px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } }, hint) : null),
  )

  const txt = (value, onCommit, placeholder) => h('input', {
    class: 'txt', value: value || '', placeholder,
    onchange: (e) => onCommit(e.target.value.trim()),
  })

  /** 密钥字段：password 类型 + 显示/隐藏 + 保存按钮 */
  const secret = (value, onCommit, placeholder) => {
    // minWidth: 0 ——input 默认 min-width 是 auto，窄栏里不肯收缩，
    // 会把同一行的其他字段挤到下一行
    const input = h('input', {
      class: 'txt', type: 'password', value: value || '', placeholder,
      style: { flex: '1', minWidth: 0 },
    })
    const toggle = h('button', {
      class: 'btn btn-icon', title: '显示/隐藏', style: { flex: 'none' },
      onclick: () => { input.type = input.type === 'password' ? 'text' : 'password' },
    }, '👁')
    const feedback = h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', minWidth: '40px' } }, '')
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

  const seg = (cur, options, onPick, fit) => h('div', { class: fit ? 'seg seg-fit' : 'seg' },
    ...options.map(([v, label]) => h('button', {
      'aria-selected': cur === v ? 'true' : 'false',
      onclick: () => onPick(v),
    }, label)),
  )

  const stats = await m.stats()
  const raw = await m.rawStats()
  const deletedTs = await m.deletedThemes()
  const purgePreview = await m.purgeDead('all', { dryRun: true })

  const toast = h('div', { style: { fontSize: 'var(--t-body)', color: 'var(--text-2)', padding: '6px 0', minHeight: '18px' } }, '')
  const flash = (msg, color = 'var(--text-2)') => {
    toast.textContent = msg
    toast.style.color = color
    setTimeout(() => { toast.textContent = '' }, 3000)
  }

  const mb = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)

  // ---------------------------------------------------------------- LLM 连通性测试
  const llmTestOut = h('p', {
    style: { margin: '8px 0 0', fontSize: 'var(--t-caption)', lineHeight: '1.6', minHeight: '16px' },
  })
  const llmTestBtn = h('button', {
    class: 'btn', style: { height: '26px' },
    onclick: async () => {
      llmTestBtn.disabled = true
      llmTestBtn.textContent = '测试中…'
      llmTestOut.textContent = ''
      llmTestOut.style.color = 'var(--text-3)'
      try {
        const r = await m.llmTest()
        if (r.ok) {
          llmTestOut.style.color = 'var(--green)'
          llmTestOut.textContent = `✓ 连通 · ${r.model} · ${r.latency}ms · 返回「${r.text}」`
        } else {
          llmTestOut.style.color = 'var(--red)'
          const why = {
            'no-key': '未填密钥',
            timeout: '超时（20s）',
            empty: '模型无返回',
            'reasoning-only': '推理模型把预算全花在思考上了，正文为空——接口是通的，换非推理模型或调大预算',
            'no-content': '模型只返回了思考，没有正文',
          }[r.reason] || r.reason
          llmTestOut.textContent = `✗ ${why}${r.latency ? ` · ${r.latency}ms` : ''}`
        }
      } catch {
        llmTestOut.style.color = 'var(--red)'
        llmTestOut.textContent = '✗ 请求失败，请检查地址与密钥'
      } finally {
        llmTestBtn.disabled = false
        llmTestBtn.textContent = '测试连接'
      }
    },
  }, '测试连接')

  // ---------------------------------------------------------------- Jev 折叠
  // 三项配置必须真的放进 jevBody——之前它们是 jevBody 的兄弟节点，
  // 折叠开关藏的是个空 div，三个字段等于永久展开，把「来源打标器」撑得很长。
  const jevBody = h('div', { class: 'jev-body', hidden: true })
  const jevChev = h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', transition: 'transform var(--dur) var(--ease)' } }, '›')
  // caption 在输入框上方的紧凑排布：三个字段一行放得下，不像左标签右输入那样
  // 每个都要占一整行、还把输入框拉到 700px 宽看着很空。
  // flex 必须挂在 jevCol 自己身上——挂进内层包裹的话，父级是 column 布局，
  // flex-basis 会变成输入框的高度，把每个字段竖向撑到 250px。
  const jevCap = (text) => h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, text)
  const jevCol = (cap, control, flex) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex },
  }, cap, control)
  jevBody.append(
    h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' } },
      jevCol(jevCap('接口地址'), txt(settings.jevBaseUrl, (v) => m.saveSettings({ jevBaseUrl: v }), 'https://openrouter.ai/api/v1'), '1 1 250px'),
      jevCol(jevCap('密钥'), secret(settings.jevKey, (v) => m.saveSettings({ jevKey: v }), 'sk-…'), '1 1 280px'),
      jevCol(jevCap('模型'), txt(settings.jevModel, (v) => m.saveSettings({ jevModel: v }), 'typesafe/jev-1.13'), '1 1 170px'),
    ),
    h('p', { style: { margin: '8px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } },
      '默认跟随主模型，只有 System One Model 用独立端点时才填。密钥 AES-256-GCM 加密存储，机器绑定，不上传。'),
  )
  const jevRow = h('div', {},
    h('button', {
      class: 'jev-toggle',
      onclick: () => {
        jevBody.hidden = !jevBody.hidden
        jevChev.style.transform = jevBody.hidden ? '' : 'rotate(90deg)'
      },
    },
      h('span', {}, settings.jevKey ? '备用模型已配置' : '备用模型（可选）'),
      h('span', { style: { flex: 1 } }),
      jevChev,
    ),
    jevBody,
  )

  // ---------------------------------------------------------------- 来源分类
  const kinds = settings.sourceQuality || []
  const maxQ = Math.max(...kinds.map(([, q]) => q), 1)
  const VIA = { table: '查表', jev: 'Jev', channel: '通道声明' }

  const testOut = h('p', {
    style: { margin: '10px 0 0', fontSize: 'var(--t-body)', color: 'var(--text-2)', lineHeight: '1.6', minHeight: '18px' },
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
        ], async (v) => { await m.saveSettings({ labeler: v }); await renderSettings(mid) }, true),
          '质量分一律按内置的质量表打分，打标器只负责选类型——否则换一个模型，整条校准曲线的基准就漂移了。'),
        // Jev 的三项配置只在选中 Jev 时出现。固定显示会让人误以为换个打标器就得重新配一遍——
        // 而查表压根不需要任何配置。折成一行「备用模型」也是同一理由：默认空 = 跟随主模型。
        settings.labeler === 'jev' ? jevRow : null,
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '来源分类'), h('em', {}, `${kinds.length} 类`)),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 12px', fontSize: 'var(--t-body)', color: 'var(--text-2)', lineHeight: '1.6' } },
          '外部内容按来源分七类。打标器只负责选类型，质量分一律由这张表裁决——这是校准曲线唯一的基准，改一条，历史全部不可比。'),
        h('div', { class: 'kinds' },
          ...kinds.map(([label, q]) => h('div', { class: 'kind-row' },
            h('span', { class: 'kind-name' }, label),
            h('span', { class: 'kind-bar' },
              h('i', { style: { width: `${(q / maxQ) * 100}%`, background: confColor(q * 100) } })),
            h('span', { class: 'kind-q' }, q.toFixed(2)),
          )),
        ),
        h('div', { class: 'sect-h', style: { marginTop: '18px' } }, h('h2', { style: { fontSize: 'var(--t-body)' } }, '试一段文本')),
        testBox,
        h('button', { class: 'btn', style: { marginTop: '6px' }, onclick: runTest }, '打标看看'),
        testOut,
      ),
    ),

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' },
        h('h2', {}, '命题抽取'),
        h('span', { class: 'spacer' }),
        // LLM 连通性测试：key / 端点 / 模型一次验完，不用等建主题才失败
        llmTestBtn,
      ),
      h('div', { class: 'sect-b' },
        field('接口地址', txt(settings.baseUrl, (v) => m.saveSettings({ baseUrl: v }), 'https://api.stepfun.com/v1'), '任意 OpenAI 兼容端点。'),
        field('密钥', secret(settings.apiKey, (v) => m.saveSettings({ apiKey: v }), 'sk-…'), 'AES-256-GCM 加密存储，机器绑定。'),
        field('模型', txt(settings.model, (v) => m.saveSettings({ model: v }), 'step-3.5-flash'), '只做「抽取命题」，不需要太强的模型。'),
        llmTestOut,
      ),
    ),

    h('section', { class: 'sect' },

      h('div', { class: 'sect-b' },
        // L3 caption 带。七个数字零层级读不出「哪个需要我操心」——
        // 所以非零的异常项（待裁决冲突 / 待结算）单独升格并上语义色
        h('div', { class: 'stat-band' },
          h('span', {}, `${stats.themes} 主题`),
          h('span', {}, `${stats.lemmas} 命题`),
          h('span', {}, `${stats.verdicts} 裁决`),
          h('span', {}, `${stats.readings} 读数`),
          stats.conflicts > 0
            ? h('b', { class: 'stat-alert' }, `${stats.conflicts} 待裁决冲突`)
            : h('span', {}, '无待裁决冲突'),
          stats.due > 0
            ? h('b', { class: 'stat-alert' }, `${stats.due} 待结算`)
            : h('span', {}, '无待结算'),
          (stats.cold || stats.dead)
            ? h('span', {}, `${stats.cold} 冷库 / ${stats.dead} 墓碑`)
            : null,
        ),
        h('p', { style: { margin: '0 0 10px', fontSize: 'var(--t-body)', color: 'var(--text-2)', lineHeight: '1.6' } },
          '判断在 meridian.json，原文在 raw.jsonl。原文可以随便清——清掉不影响任何一条命题，只是以后复盘不了当初读的是什么。'),
        // 安全操作区：常规颜色
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: openDataDirectory }, '打开数据目录'),
          h('button', {
            class: 'btn',
            onclick: async () => {
              const r = await m.rawPrune()
              flash(`清理了 ${r.removed} 条无引用原文，保留 ${r.kept} 条`)
              await renderSettings(mid)
            },
          }, '清理无引用原文'),
        ),
        // 危险区：细线分隔 + caption 说明，区内统一红色纵向排列。
        // 破坏性操作和安全操作平铺时，用户会顺手点到不该点的那个。
        h('div', { class: 'danger-zone' },
          h('div', { class: 'danger-cap' }, '以下操作不可撤销'),
          h('div', { class: 'danger-list' },
            h('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!await confirmToast('清空全部原文？判断会保留，但所有原文引用会失效。', '清空')) return
                const r = await m.rawClear()
                flash(`已清空 ${r.removed} 条原文，摘除 ${r.unlinked} 处引用`)
                await renderSettings(mid)
              },
            }, '清空全部原文'),
            h('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                const preview = await m.purgeDead('user', { dryRun: true })
                const confirmed = preview.removed > 0 && await confirmToast(`彻底移除 ${preview.removed} 条已删除的节点？此操作不可恢复。`, '移除')
                const plan = planPurge('user', preview, confirmed)
                if (!plan.willDelete) { if (plan.reason === 'empty') flash('没有已删除的节点'); return }
                const r = await m.purgeDead(plan.scope)
                flash(`已彻底移除 ${r.removed} 条已删除的节点`)
                await renderSettings(mid)
              },
            }, `彻底移除已删除的节点（${purgePreview.userDeleted}）`),
            h('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                const preview = await m.purgeDead('auto', { dryRun: true })
                const confirmed = preview.removed > 0 && await confirmToast(`彻底移除 ${preview.removed} 条信心跌破的节点？此操作不可恢复。`, '移除')
                const plan = planPurge('auto', preview, confirmed)
                if (!plan.willDelete) { if (plan.reason === 'empty') flash('没有信心跌破的节点'); return }
                const r = await m.purgeDead(plan.scope)
                flash(`已彻底移除 ${r.removed} 条信心跌破的节点`)
                await renderSettings(mid)
              },
            }, `彻底移除信心跌破的节点（${purgePreview.autoDead}）`),
          ),
        ),
      ),
    ),

    // ---- 收件箱过期清理
    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '收件箱'), h('em', {}, `${stats.inbox} 条待确认`)),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 10px', fontSize: 'var(--t-body)', color: 'var(--text-3)', lineHeight: '1.6' } },
          '收件箱是队列不是档案。启动时会自动清掉超过 30 天、没人看过、也没主动忽略的待确认条目——',
          '本地优先产品的数据文件是你自己的负担。'),
        h('div', { class: 'q-acts' },
          h('button', {
            class: 'btn',
            onclick: async () => {
              const preview = await m.inboxPrune(30, { dryRun: true })
              if (preview.removed === 0) { flash('没有超过 30 天未处理的待确认'); return }
              const confirmed = await confirmToast(`清理 ${preview.removed} 条超过 30 天未处理的待确认？`, '清理')
              if (!confirmed) return
              const r = await m.inboxPrune(30)
              flash(`已清理 ${r.removed} 条，保留 ${r.kept} 条`)
              await renderSettings(mid)
            },
          }, '立即清理过期待确认'),
        ),
      ),
    ),

    // ---- 已删主题（可恢复）
    deletedTs.length ? h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '已删主题'), h('em', {}, String(deletedTs.length))),
      h('div', { class: 'sect-b' },
        h('p', { style: { margin: '6px 0 10px', fontSize: 'var(--t-body)', color: 'var(--text-3)', lineHeight: '1.6' } },
          '软删的主题可恢复。节点仍在墓碑区，恢复后整棵子树复活。'),
        ...deletedTs.map((t) => h('div', { class: 'q' },
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text' }, t.name),
            h('div', { class: 'q-meta' }, h('span', {}, `删于 ${t.deletedAt}`), h('span', {}, `· ${t.restorableCount || 0} 个可恢复节点`)),
          ),
          h('div', { class: 'q-acts' },
            h('button', {
              class: 'btn',
              disabled: !t.restorableCount,
              style: t.restorableCount ? {} : { opacity: '0.5', cursor: 'not-allowed' },
              title: t.restorableCount ? '' : '无可恢复节点（墓碑区已清空）',
              onclick: async () => { if (!t.restorableCount) return; await m.restoreTheme(t.id); flash(`已恢复主题「${t.name}」`, 'var(--green)'); await renderSettings(mid) },
            }, `恢复 (${t.restorableCount || 0})`),
            h('button', {
              class: 'btn', style: { color: 'var(--red)' },
              onclick: async () => {
                if (!await confirmToast(`永久删除主题「${t.name}」及其所有节点？此操作不可恢复。`, '真删')) return
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

    // ---- 界面
    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '界面')),
      h('div', { class: 'sect-b' },
        // 接入地址：绑哪、哪个端口、要不要凭据。曾经写死，agent 在别的机器上连不到。
        field('监听地址', (() => {
          const opts = [['127.0.0.1', '仅本机'], ['0.0.0.0', '局域网（所有网卡）']]
          return h('div', { class: 'seg seg-fit' }, ...opts.map(([v, label]) => h('button', {
            'aria-selected': (settings.agentHost || '127.0.0.1') === v ? 'true' : 'false',
            onclick: async () => { await m.saveSettings({ agentHost: v }); await renderSettings(mid) },
          }, label)))
        })(), '选「局域网」后，同一网络的其它机器也能推送读数。访问凭据会变成唯一防线，别关掉。'),
        field('端口', h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('input', {
            class: 'txt', type: 'number', min: '1024', max: '65535', placeholder: '留空 = 每次随机',
            value: settings.agentPort ? String(settings.agentPort) : '',
            style: { width: '110px' },
            onchange: async (e) => {
              const v = Number(e.target.value)
              await m.saveSettings({ agentPort: v >= 1024 && v <= 65535 ? v : 0 })
              await renderSettings(mid)
            },
          }),
          h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '留空则每次启动随机'),
        ), 'agent 要写死地址就填一个固定端口。改完重启 app 生效。'),
        field('访问凭据', (() => {
          const on = settings.agentToken !== false
          const lan = (settings.agentHost || '127.0.0.1') !== '127.0.0.1'
          return h('div', { class: 'seg seg-fit' }, ...[
            [true, '需要'], [false, '不需要'],
          ].map(([v, label]) => h('button', {
            'aria-selected': on === v ? 'true' : 'false',
            // 绑到非本机时不允许关——那等于把账本敞开在网络上
            disabled: lan && v === false,
            title: lan && v === false ? '绑定非本机地址必须启用访问凭据' : '',
            onclick: async () => { await m.saveSettings({ agentToken: v }); await renderSettings(mid) },
          }, label)))
        })(), '凭据在数据源页一键复制。仅本机模式才能关。'),
        field('监听地址', (() => {
          const opts = [['127.0.0.1', '仅本机'], ['0.0.0.0', '局域网（所有网卡）']]
          return h('div', { class: 'seg seg-fit' }, ...opts.map(([v, label]) => h('button', {
            'aria-selected': (settings.agentHost || '127.0.0.1') === v ? 'true' : 'false',
            onclick: async () => { await m.saveSettings({ agentHost: v }); await renderSettings(mid) },
          }, label)))
        })(), '选「局域网」后，同一网络的其它机器也能推送读数。访问凭据会变成唯一防线，别关掉。'),
        field('端口', h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('input', {
            class: 'txt', type: 'number', min: '1024', max: '65535', placeholder: '留空 = 每次随机',
            value: settings.agentPort ? String(settings.agentPort) : '',
            style: { width: '110px' },
            onchange: async (e) => {
              const v = Number(e.target.value)
              await m.saveSettings({ agentPort: v >= 1024 && v <= 65535 ? v : 0 })
              await renderSettings(mid)
            },
          }),
          h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '留空则每次启动随机'),
        ), 'agent 要写死地址就填一个固定端口。改完重启 app 生效。'),
        field('访问凭据', (() => {
          const on = settings.agentToken !== false
          const lan = (settings.agentHost || '127.0.0.1') !== '127.0.0.1'
          return h('div', { class: 'seg seg-fit' }, ...[
            [true, '需要'], [false, '不需要'],
          ].map(([v, label]) => h('button', {
            'aria-selected': on === v ? 'true' : 'false',
            // 绑到非本机时不允许关——那等于把账本敞开在网络上
            disabled: lan && v === false,
            title: lan && v === false ? '绑定非本机地址必须启用访问凭据' : '',
            onclick: async () => { await m.saveSettings({ agentToken: v }); await renderSettings(mid) },
          }, label)))
        })(), '凭据在数据源页一键复制。仅本机模式才能关。'),
        field('图的缩放', (() => {
          const value = Number(settings.graphZoom) || 1
          const out = h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', minWidth: '44px' } }, `${value.toFixed(1)}×`)
          const input = h('input', {
            type: 'range', min: '0.2', max: '3', step: '0.1', value: String(value),
            style: { flex: '1' },
            oninput: (e) => { out.textContent = `${Number(e.target.value).toFixed(1)}×` },
            onchange: (e) => m.saveSettings({ graphZoom: Number(e.target.value) || 1 }),
          })
          return h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, input, out)
        })(), '产业链图的滚轮灵敏度。触控板一次滚动会连发多个小步进，觉得跳得太快就调小。'),
      ),
    ),

    // ---- 数据管理
    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '数据管理')),
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
            onclick: openDataDirectory,
          }, '打开数据目录'),
        ),
      ),
    ),
  ))
  const page = mid.querySelector('.page')
  if (page && keepScroll) page.scrollTop = keepScroll
}
