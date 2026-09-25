import { h, mount, icon, clear, toast } from '../lib/dom.js'
import { state, refresh, selectNode, setView, deleteNodeWithUndo } from '../app.js'
import { confColor, TYPE_LABEL, nodePath } from './shared.js'

const m = window.meridian

/** 读数来源面板：挂通道 → 看最新读数 → 判断有没有东西能验证 */
async function sourcePanel(node) {
  const box = h('div', { class: 'insp-section' })
  box.append(h('div', { class: 'insp-h' }, '读数来源'),
    h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '加载中…'))

  try {
    const channels = await m.channelList()
    const attached = (node.channelIds || []).map((id) => channels.find((c) => c.id === id)).filter(Boolean)
    const unattached = channels.filter((c) => !(node.channelIds || []).includes(c.id))

    // 最新读数
    const latestReadings = []
    for (const ch of attached) {
      const r = await m.latestReadingByChannel(ch.id)
      if (r) latestReadings.push({ channel: ch, reading: r })
    }

    clear(box)
    box.append(h('div', { class: 'insp-h' }, '读数来源'))

    // 已挂通道
    if (attached.length) {
      box.append(h('div', { class: 'src-list', style: { marginTop: '6px' } },
        ...attached.map((ch) => h('div', { style: { minWidth: 0 } },
          h('div', { class: 'src-row' },
            h('span', { class: 'badge badge-observation', style: { fontSize: 'var(--t-caption)' } }, ch.fetch),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ch.name),
            h('button', { class: 'btn btn-icon', title: '移除', onclick: async () => {
              await m.updateNode(node.id, { channelIds: (node.channelIds || []).filter((id) => id !== ch.id) })
              await refresh()
            } }, '×'),
          ),
          ch.lastError ? h('p', { style: { margin: '2px 0 6px', fontSize: 'var(--t-caption)', color: 'var(--red)' } }, ch.lastError) : null,
        )),
      ))
    } else {
      box.append(h('p', { style: { margin: '6px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '暂无自动源，需手填'))
      // R2: 手填一条读数——正确时机是「你正在看那个空指标的时候」
      const formInputs = {}
      let formVisible = false
      const formBox = h('div', { style: { marginTop: '6px' } })
      const toggleBtn = h('button', {
        class: 'btn', style: { marginTop: '4px', padding: '2px 8px', fontSize: 'var(--t-caption)' },
        onclick: () => {
          formVisible = !formVisible
          clear(formBox)
          if (!formVisible) return
          formBox.append(
            h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '4px' } },
              h('input', { class: 'txt', placeholder: 'metric', style: { flex: '1', minWidth: '100px' }, oninput: (e) => formInputs.metric = e.target.value }),
              h('input', { class: 'txt', placeholder: 'value', style: { width: '90px' }, oninput: (e) => formInputs.value = e.target.value }),
              h('input', { class: 'txt', placeholder: 'unit', style: { width: '60px' }, oninput: (e) => formInputs.unit = e.target.value }),
            ),
            h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
              h('input', { class: 'txt', placeholder: 'asOf（如 2024-Q3）', style: { flex: '1', minWidth: '100px' }, oninput: (e) => formInputs.asOf = e.target.value }),
              h('select', { class: 'txt', style: { width: 'auto' }, onchange: (e) => formInputs.kind = e.target.value },
                h('option', { value: '财报 / 公告' }, '财报 / 公告'),
                h('option', { value: '一手数据' }, '一手数据'),
                h('option', { value: '券商研报' }, '券商研报'),
                h('option', { value: '独立媒体' }, '独立媒体'),
                h('option', { value: '自媒体' }, '自媒体'),
              ),
              h('button', {
                class: 'btn btn-primary', style: { padding: '2px 8px', fontSize: 'var(--t-caption)' },
                onclick: async () => {
                  if (!formInputs.metric || !formInputs.value) return
                  // 复用 F4 逻辑：自动建/复用主题级手动通道 + 挂到指标
                  let ch = channels.find((c) => c.fetch === 'manual' && c.themeId === node.themeId)
                  if (!ch) {
                    ch = await m.channelAdd({ name: '手动录入', kind: '一手数据', fetch: 'manual', themeId: node.themeId })
                    channels.push(ch)
                  }
                  if (!(node.channelIds || []).includes(ch.id)) {
                    await m.updateNode(node.id, { channelIds: [...(node.channelIds || []), ch.id] })
                  }
                  await m.addReading({
                    metric: formInputs.metric,
                    value: Number(formInputs.value),
                    unit: formInputs.unit || null,
                    asOf: formInputs.asOf || null,
                    source: { kind: formInputs.kind || '一手数据' },
                    basis: 'reported',
                    channelId: ch.id,
                  })
                  await refresh()
                },
              }, '保存'),
            ),
          )
        },
      }, '手填一条读数')
      const proposalBox = h('div', { style: { marginTop: '6px' } })
      const proposeBtn = h('button', {
        class: 'btn', style: { marginTop: '4px', padding: '2px 8px', fontSize: 'var(--t-caption)' },
        onclick: async () => {
          proposeBtn.disabled = true
          proposeBtn.textContent = '提议中…'
          const result = await m.proposeLinks(node.id)
          proposeBtn.disabled = false
          proposeBtn.textContent = '让 LLM 提议'
          clear(proposalBox)
          if (!result.ok) {
            toast(result.error === 'no-key' ? '未配置 API key' : `提议失败：${result.error}`, 'var(--red)')
            return
          }
          const proposal = result.proposal
          const proposed = proposal.channelIds.map((id) => channels.find((channel) => channel.id === id)).filter(Boolean)
          proposalBox.append(h('div', { class: 'q', style: { alignItems: 'flex-start' } },
            h('div', { class: 'q-body' },
              h('div', { class: 'q-text' }, proposed.length ? `建议挂：${proposed.map((channel) => channel.name).join(' · ')}` : '没有合适的自动源'),
              proposal.reason ? h('div', { class: 'q-meta' }, proposal.reason) : null,
            ),
            h('div', { class: 'q-acts' },
              proposed.length ? h('button', {
                class: 'btn btn-primary',
                onclick: async () => {
                  const channelIds = [...new Set([...(node.channelIds || []), ...proposal.channelIds])]
                  await m.updateNode(node.id, { channelIds })
                  await Promise.all(proposal.channelIds.map((id) => m.channelFetch(id)))
                  await refresh()
                },
              }, '采用') : null,
              h('button', { class: 'btn', onclick: () => clear(proposalBox) }, '忽略'),
            ),
          ))
        },
      }, '让 LLM 提议')
      box.append(toggleBtn, proposeBtn, formBox, proposalBox)
    }

    // 挂通道下拉（按标签相关性排序，themeId 次级）
    if (unattached.length) {
      const opt = (ch) => h('option', { value: ch.id }, `${ch.name} · ${ch.fetch}${ch.metric ? ' · ' + ch.metric : ''}`)
      const themeName = state.themes.find((t) => t.id === node.themeId)?.name || '当前主题'
      const themeTags = state.themes.find((t) => t.id === node.themeId)?.tags || []
      // themeId 次级排序：当前主题 → 全局 → 其他
      const byThemeRank = (c) => c.themeId === node.themeId ? 0 : (!c.themeId ? 1 : 2)
      let groups
      if (themeTags.length) {
        const want = new Set(themeTags)
        const ranked = unattached
          .map((c) => ({ ch: c, score: (c.tags || []).filter((t) => want.has(t)).length }))
          .sort((a, b) => b.score - a.score || byThemeRank(a.ch) - byThemeRank(b.ch))
        const high = ranked.filter((r) => r.score >= 2)
        const mid = ranked.filter((r) => r.score === 1)
        const low = ranked.filter((r) => r.score === 0)
        groups = [
          high.length ? [`最相关（${high.length}）`, high.map((r) => r.ch)] : null,
          mid.length ? [`相关（${mid.length}）`, mid.map((r) => r.ch)] : null,
          low.length ? [`其他（${low.length}）`, low.map((r) => r.ch)] : null,
        ].filter(Boolean)
      } else {
        const mine = unattached.filter((c) => c.themeId === node.themeId).sort((a, b) => byThemeRank(a) - byThemeRank(b))
        const global = unattached.filter((c) => !c.themeId)
        const others = unattached.filter((c) => c.themeId && c.themeId !== node.themeId)
        groups = [
          mine.length ? [`当前主题 · ${themeName}`, mine] : null,
          global.length ? ['全局（所有主题可用）', global] : null,
          others.length ? ['其他主题', others] : null,
        ].filter(Boolean)
      }
      const chSel = h('select', {
        class: 'sel', style: { marginTop: '8px' },
        onchange: async (e) => {
          if (!e.target.value) return
          await m.updateNode(node.id, { channelIds: [...(node.channelIds || []), e.target.value] })
          e.target.value = ''
          await refresh()
        },
      },
        h('option', { value: '' }, '+ 挂通道…'),
        ...groups.map(([label, chans]) => h('optgroup', { label }, ...chans.map(opt))),
      )
      box.append(chSel)
    } else if (channels.length === 0) {
      box.append(h('p', { style: { margin: '6px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)' } },
        '没有可选通道，去',
        h('a', { style: { color: 'var(--blue, #0071e3)', cursor: 'pointer', textDecoration: 'underline' }, onclick: () => setView('vault', 'feeds') }, '数据源'),
        '建一个',
      ))
    }

    // 最新读数
    if (latestReadings.length) {
      box.append(h('div', { class: 'insp-h', style: { marginTop: '14px' } }, '最新读数'))
      for (const { channel, reading } of latestReadings) {
        const indicators = await m.indicatorsForReading(reading)
        box.append(h('div', { class: 'src-row', style: { marginTop: '4px' } },
          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--t-caption)', color: 'var(--text-2)' } },
            `${reading.metric}  ${(typeof reading.value === 'number' ? reading.value.toLocaleString('en-US') : reading.value)}${reading.unit ? ' ' + reading.unit : ''}`,
          ),
          h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', flex: 'none' } }, reading.asOf || '—'),
          reading.source?.url ? h('button', { class: 'btn', style: { padding: '1px 6px', fontSize: 'var(--t-caption)', flex: 'none' }, onclick: () => m.openExternal(reading.source.url) }, '来源') : null,
        ))
        if (indicators.length) {
          box.append(h('p', { style: { margin: '0 0 4px', fontSize: 'var(--t-caption)', color: 'var(--text-3)' } },
            `跟踪指标：${indicators.map((n) => n.title).join('、')}`))
        }
      }
    }

    // 状态行
    box.append(h('p', { style: { margin: '8px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)' } },
      attached.length ? `有 ${attached.length} 个自动源` : '暂无自动源，需手填'))
  } catch {
    clear(box)
    box.append(h('div', { class: 'insp-h' }, '读数来源'),
      h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '加载失败'))
  }
  return box
}

/** 研究观点面板：录入机构观点 → 列表 → 结算后对比 */
async function researchPanel(node) {
  const box = h('div', { class: 'insp-section' })
  box.append(h('div', { class: 'insp-h' }, '研究观点'),
    h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '加载中…'))
  try {
    const notes = await m.researchByNode(node.id)
    clear(box)
    box.append(h('div', { class: 'insp-h' }, '研究观点',
      h('span', { style: { fontWeight: '400', color: 'var(--text-3)' } }, notes.length ? `${notes.length} 条` : '')))

    // 录入表单
    const formInputs = {}
    const form = h('div', { class: 'field', style: { flexDirection: 'column', gap: '4px' } },
      h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
        h('input', { class: 'txt', placeholder: '机构', style: { flex: '1', minWidth: '80px' }, oninput: (e) => formInputs.org = e.target.value }),
        h('select', { class: 'txt', style: { width: 'auto' }, onchange: (e) => formInputs.stance = e.target.value },
          h('option', { value: 'bullish' }, '看涨'),
          h('option', { value: 'bearish' }, '看跌'),
          h('option', { value: 'neutral' }, '中性'),
        ),
        h('input', { class: 'txt', type: 'date', style: { width: '120px' }, oninput: (e) => formInputs.publishedAt = e.target.value }),
      ),
      h('input', { class: 'txt', placeholder: '一句话观点', style: { width: '100%' }, oninput: (e) => formInputs.title = e.target.value }),
      h('div', { style: { display: 'flex', gap: '4px' } },
        h('input', { class: 'txt', placeholder: '链接（可空）', style: { flex: '1' }, oninput: (e) => formInputs.url = e.target.value }),
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!formInputs.org || !formInputs.title) return
            await m.addResearch({
              org: formInputs.org,
              stance: formInputs.stance || 'neutral',
              publishedAt: formInputs.publishedAt || null,
              title: formInputs.title,
              url: formInputs.url || null,
              nodeId: node.id,
            })
            refresh()
          },
        }, '记录'),
      ),
    )
    box.append(form)

    // 观点列表
    if (notes.length) {
      const settled = node.settlement?.correct != null
      for (const n of notes) {
        const stanceLabel = { bullish: '看涨', bearish: '看跌', neutral: '中性' }[n.stance] || n.stance
        let compare = null
        if (settled) {
          const correct = node.settlement.correct
          if (n.stance === 'neutral') {
            compare = '中性不计入'
          } else if (correct) {
            compare = n.stance === 'bullish' ? '← 和你一致' : '← 不一致'
          } else {
            compare = n.stance === 'bearish' ? '← 和你一致' : '← 不一致'
          }
        }
        box.append(h('div', { class: 'q', style: { padding: '4px 0' } },
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text', style: { fontSize: 'var(--t-body)' } }, `${n.org} · ${stanceLabel} · ${n.publishedAt || n.at}`),
            h('div', { class: 'q-meta' },
              h('span', { style: { fontSize: 'var(--t-caption)' } }, n.title),
              compare ? h('span', { style: { marginLeft: '6px', fontSize: 'var(--t-caption)', color: compare.includes('一致') ? 'var(--accent)' : 'var(--text-3)' } }, compare) : null,
            ),
          ),
        ))
      }
    }
  } catch {
    clear(box)
    box.append(h('div', { class: 'insp-h' }, '研究观点'),
      h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '加载失败'))
  }
  return box
}

/**
 * 环节上的研究台：
 *   要回答什么问题 → 跟踪什么指标 → 什么信号出现说明这一层错了
 * 只读，不加勾选状态——它的作用是提醒你该想什么，不是待办清单。
 */
function scaffoldSection(sc, answered = 0) {
  const answers = Array.isArray(sc.answer) ? sc.answer : (sc.answer ? [String(sc.answer)] : [])
  const indicators = Array.isArray(sc.indicators) ? sc.indicators : []
  const bullets = (items) => h('ul', {
    style: { margin: '0', padding: '0 0 0 14px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '6px' },
  }, ...items.map((t, i) => h('li', {
    style: { position: 'relative', fontSize: 'var(--t-body)', color: i < answered ? 'var(--text-3)' : 'var(--text-2)', lineHeight: '1.55' },
  }, h('span', {
    style: {
      position: 'absolute', left: '-14px', top: '8px', width: '3px', height: '3px',
      borderRadius: '50%', background: 'var(--text-3)',
    },
  }), t)))

  return h('div', { class: 'insp-section' },
    h('div', { class: 'insp-h' }, '这一层要回答', answers.length ? h('b', {}, `${answered} / ${answers.length}`) : null),
    bullets(answers),

    indicators.length ? h('div', { class: 'insp-h', style: { marginTop: '16px' } }, '要跟踪') : null,
    ...indicators.map((ind) => h('div', { class: 'field', style: { minHeight: '22px' } },
      h('span', {
        style: { flex: '1', minWidth: '0', fontSize: 'var(--t-body)', color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: ind.name,
      }, ind.name),
      h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', flex: 'none' } }, ind.cadence),
    )),

    sc.falsifier ? h('div', {
      style: { marginTop: '16px', padding: '9px 10px', borderRadius: 'var(--r-sm)', background: 'rgba(255, 149, 0, 0.09)' },
    },
      h('div', { style: { fontSize: 'var(--t-caption)', fontWeight: '600', color: 'var(--orange)', marginBottom: '4px', letterSpacing: '0.02em' } }, '错了我怎么知道'),
      h('div', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-2)', lineHeight: '1.55' } }, sc.falsifier),
    ) : null,
  )
}

export function renderInspectorLattice(aside) {
  const node = state.nodes.find((n) => n.id === state.selectedId)
  if (!node) {
    aside.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-ic' }, icon('lattice', 36)),
      h('h2', {}, '还没有选中命题'),
      h('p', {}, '在左侧选择一条命题，这里会显示它的论证结构、来源和判断依据。'),
    ))
    return
  }

  const title = h('h1', {
    class: 'insp-title', contenteditable: 'plaintext-only', spellcheck: 'false',
    onblur: async () => {
      const v = title.textContent.trim()
      if (v && v !== node.title) { await m.updateNode(node.id, { title: v }); await refresh() }
    },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur() } },
  }, node.title)

  const head = h('div', { class: 'insp-head' },
    title,
    h('div', { class: 'insp-sub' }, nodePath(state.nodes, node.id)),
    node.status !== 'live' ? h('div', { style: { marginTop: '6px' } },
      h('span', { class: `badge ${node.status === 'dead' ? 'badge-hypothesis' : 'badge-cold'}` },
        node.status === 'dead' ? '墓碑区 · 负资产' : '冷库 · 低质但可能为真')) : null,
  )

  if (node.kind === 'branch') {
    const kids = state.nodes.filter((n) => n.parentId === node.id)
    // 连续传导权重滑块：产品最核心的连续参数不该只有三档
    // 拖动时下游置信度实时跟着变——这才是「传导」被看见
    const propOut = h('input', { type: 'number', min: '0', max: '1', step: '0.05', value: node.propagation.toFixed(2),
      style: { width: '48px', fontSize: 'var(--t-body)', textAlign: 'center' },
      onchange: async (e) => { const v = Math.max(0, Math.min(1, Number(e.target.value) || 0)); propSlider.value = String(v); await m.updateNode(node.id, { propagation: v }); await refresh() },
    })
    const propSlider = h('input', {
      type: 'range', class: 'prop-slider', min: '0', max: '1', step: '0.05',
      value: String(node.propagation),
      oninput: (e) => { propOut.value = Number(e.target.value).toFixed(2) },
      onchange: async (e) => { await m.updateNode(node.id, { propagation: Number(e.target.value) }); await refresh() },
    })
    const segs = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      propSlider, propOut,
    )
    const answers = Array.isArray(node.scaffold?.answer)
      ? node.scaffold.answer.length
      : node.scaffold?.answer ? 1 : 0
    const spawnBtn = node.scaffold
      ? h('button', {
          class: 'btn', style: { marginTop: '10px' },
          title: '把骨架里的指标和问题变成带结算日的命题',
          onclick: async () => { await m.spawn(node.id); await refresh() },
        }, icon('plus', 13), '从骨架生成命题')
      : null

    // 环节自己的确信度。没有它，传导在界面上永远触发不了——
    // 产业链上有子节点的全是环节，而环节恰恰是唯一该被拖动的那个。
    const segConfOut = h('input', { type: 'number', min: '0', max: '100', value: String(Math.round(node.confidence)),
      style: { width: '42px', fontSize: 'var(--t-body)', textAlign: 'center' },
      onchange: async (e) => { const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))); segSlider.value = String(v); segBar.style.width = `${v}%`; segBar.style.background = confColor(v); await m.updateNode(node.id, { confidence: v }); await refresh() },
    })
    const segBar = h('i', { style: { width: `${node.confidence}%`, background: confColor(node.confidence) } })
    const segSlider = h('input', {
      type: 'range', min: '0', max: '100', value: String(Math.round(node.confidence)),
      oninput: (e) => {
        const v = Number(e.target.value)
        segConfOut.value = String(v)
        segBar.style.width = `${v}%`
        segBar.style.background = confColor(v)
      },
      onchange: async (e) => {
        await m.updateNode(node.id, { confidence: Number(e.target.value) })
        await refresh()
      },
    })

    mount(aside, head,
      node.scaffold
        ? scaffoldSection(node.scaffold, Math.min(answers, kids.filter((k) => k.kind === 'lemma').length))
        : h('div', { class: 'insp-section' },
            h('div', { class: 'insp-h' }, '这一层'),
            h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } },
              '骨架没有预置问题。用 Tab 在这里往下拆，或先写下你自己的判断。'),
          ),
      h('div', { class: 'insp-section' },
        h('div', { class: 'insp-h' }, '环节'),
        h('div', { class: 'field' }, h('label', {}, '子项'), h('span', { style: { fontSize: 'var(--t-body)', color: 'var(--text-2)' } }, String(kids.length))),
        spawnBtn,
      ),
      h('div', { class: 'insp-section' },
        h('div', { class: 'insp-h' }, '确信度', segConfOut),
        h('div', { class: 'field' }, h('label', {}, '这一层'), segSlider),
        h('div', { class: 'bar', style: { width: '100%', height: '4px', marginTop: '6px' } }, segBar),
        h('p', { style: { margin: '8px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } },
          '拖动它，下面所有命题按传导权重同向重估——上游证据一变，下游判断跟着变。'),
      ),
      h('div', { class: 'insp-section' },
        h('div', { class: 'insp-h' }, '传导权重', h('b', {}, node.propagation.toFixed(2))),
        h('div', { class: 'field' }, h('label', {}, '向下游'), segs),
        h('p', { style: { margin: '8px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } },
          '拖动边上的权重，下游置信度实时跟着变——这才是「传导」被看见。'),
        h('button', {
          class: 'btn', style: { marginTop: '10px' },
          onclick: async () => { await m.repropagate(node.id); await refresh() },
        }, icon('lattice', 13), '按当前权重重算子树'),
      ),      h('div', { class: 'insp-section' },
        h('button', { class: 'btn', style: { color: 'var(--red)' }, onclick: () => deleteNodeWithUndo(node.id) }, icon('trash', 13), '删除环节及其子树'),
      ),
    )
    return
  }

  // ---------------- 命题 ----------------
  const confOut = h('input', { type: 'number', min: '0', max: '100', value: String(Math.round(node.confidence)),
    style: { width: '42px', fontSize: 'var(--t-body)', textAlign: 'center' },
    onchange: async (e) => { const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))); slider.value = String(v); bar.style.width = `${v}%`; bar.style.background = confColor(v); await m.updateNode(node.id, { confidence: v }); await refresh() },
  })
  const bar = h('i', { style: { width: `${node.confidence}%`, background: confColor(node.confidence) } })
  const slider = h('input', {
    type: 'range', min: '0', max: '100', value: String(Math.round(node.confidence)),
    oninput: (e) => {
      const v = Number(e.target.value)
      confOut.value = String(v)
      bar.style.width = `${v}%`
      bar.style.background = confColor(v)
    },
    onchange: async (e) => { await m.updateNode(node.id, { confidence: Number(e.target.value) }); await refresh() },
  })

  const typeSeg = h('div', { class: 'seg' },
    ...Object.entries(TYPE_LABEL).map(([v, label]) => h('button', {
      'aria-selected': node.type === v ? 'true' : 'false',
      onclick: async () => { await m.updateNode(node.id, { type: v }); await refresh() },
    }, label)),
  )

  const kinds = (state.settings.sourceQuality || []).map(([label, q]) => ({ label, q }))

  // 原文层：当时读的是什么。结算时能不能复盘，全看这一块。
  const rawBox = h('div', { class: 'raw-box' })
  const showRaw = async (rawId) => {
    clear(rawBox)
    rawBox.dataset.on = 'true'
    rawBox.append(h('p', { class: 'raw-muted' }, '读取中…'))
    let entry = null
    try { entry = await m.rawGet(rawId) } catch { entry = null }
    clear(rawBox)
    if (!entry) {
      rawBox.append(h('p', { class: 'raw-muted' }, '原文已被清理。判断还在，只是复盘不了当初读的是什么。'))
      return
    }
    rawBox.append(
      h('div', { class: 'raw-head' },
        h('span', { class: `badge badge-${qualityClass(entry.quality ?? 0.5)}` }, entry.kind),
        h('span', { class: 'raw-label' }, entry.label),
        h('span', { class: 'raw-meta' }, `${entry.at} · ${entry.chars} 字`),
      ),
      h('pre', { class: 'raw-text' }, entry.text),
    )
  }

  const kindSel = h('select', {
    class: 'sel',
    onchange: async (e) => {
      const found = kinds.find((k) => k.label === e.target.value)
      await m.updateNode(node.id, {
        sources: [...node.sources, { kind: e.target.value, label: e.target.value, quality: found ? found.q : 0.5 }],
      })
      await refresh()
    },
  },
    h('option', { value: '' }, '追加来源…'),
    ...kinds.map((k) => h('option', { value: k.label }, `${k.label} · ${k.q}`)),
  )

  const dueInput = h('input', {
    class: 'txt', type: 'date', value: node.settlement?.date || '',
    onchange: async (e) => {
      await m.updateNode(node.id, { settlement: e.target.value ? { date: e.target.value, resolved: null, correct: null } : null })
      await refresh()
    },
  })
  const settled = node.settlement?.resolved
    ? h('span', { class: `badge ${node.settlement.correct ? 'badge-observation' : 'badge-hypothesis'}` },
      node.settlement.correct ? '已命中' : '已证伪')
    : h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '未结算')

  const tagInput = h('input', {
    class: 'txt', placeholder: '用逗号分隔，如：能源成本, 半导体周期',
    value: (node.tags || []).join(', '),
    onchange: async (e) => {
      const tags = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      await m.updateNode(node.id, { tags })
      await refresh()
    },
  })

  // 标的映射：只做可见性，不做信号——合规红线
  const tickerBox = h('div', { class: 'src-list' })
  const tickerInput = h('input', {
    class: 'txt', placeholder: '代码 名称，如：NVDA 英伟达',
    onkeydown: async (e) => {
      if (e.key !== 'Enter') return
      const parts = e.target.value.trim().split(/\s+/)
      if (!parts[0]) return
      await m.addTicker(node.id, { code: parts[0], name: parts.slice(1).join(' ') || parts[0], relation: '受益' })
      e.target.value = ''
      await refresh()
    },
  })
  const relationSel = h('select', {
    class: 'sel', style: { width: '64px', flex: 'none' },
    onchange: () => {},
  },
    h('option', { value: '受益' }, '受益'),
    h('option', { value: '受损' }, '受损'),
    h('option', { value: '中性' }, '中性'),
  )
  const paintTickers = () => {
    clear(tickerBox)
    for (const t of node.tickers || []) {
      tickerBox.append(h('div', { class: 'src-row' },
        h('span', { class: 'badge badge-observation', style: { fontSize: 'var(--t-caption)' } }, t.code),
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.name),
        h('span', { class: 'q' }, t.relation),
        h('button', { class: 'btn btn-icon', title: '移除', onclick: async () => {
          await m.removeTicker(node.id, t.code); await refresh()
        } }, '×'),
      ))
    }
  }
  paintTickers()

  // 苏格拉底追问：AI 只追问边界，禁止输出陈述句
  const socraticBox = h('div', {})
  const socraticBtn = h('button', {
    class: 'btn', style: { marginTop: '8px' },
    onclick: async () => {
      clear(socraticBox)
      socraticBox.append(h('p', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '追问中…'))
      const r = await m.socratic(node.id)
      clear(socraticBox)
      if (!r.ok) {
        socraticBox.append(h('p', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } },
          r.reason === 'no-key' ? '需要先在设置里填 API key' : `失败：${r.reason}`))
        return
      }
      socraticBox.append(h('ul', {
        style: { margin: '0', padding: '0 0 0 14px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '6px' },
      }, ...r.questions.map((q) => h('li', {
        style: { position: 'relative', fontSize: 'var(--t-body)', color: 'var(--text-2)', lineHeight: '1.55' },
      }, h('span', {
        style: { position: 'absolute', left: '-14px', top: '8px', width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-3)' },
      }), q))))
    },
  }, icon('flag', 13), '苏格拉底追问')

  const hist = node.history.slice(-24)
  const downstream = state.nodes.filter((n) => n.parentId === node.id)

  mount(aside, head,
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '命题'),
      h('div', { class: 'field' }, h('label', {}, '类型'), typeSeg),
      h('div', { class: 'field' }, h('label', {}, '置信度'), slider,
        h('span', { style: { fontSize: 'var(--t-body)', color: 'var(--text-2)', width: '22px', textAlign: 'right' } }, confOut)),
      h('div', { class: 'bar', style: { width: '100%', height: '4px', marginTop: '6px' } }, bar),
    ),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '来源', h('b', {}, `${node.sources?.length || 0} 个独立源`)),
      node.sources?.length
        ? h('div', { class: 'src-list' }, ...node.sources.map((s) => h('div', { class: 'src-row' },
            h('span', { class: `badge badge-${qualityClass(s.quality)}` }, s.kind),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.label),
            h('span', { class: 'q' }, `${s.quality} · ${s.at}`),
            s.rawId
              ? h('button', { class: 'btn btn-raw', title: '看当时读的原文', onclick: () => showRaw(s.rawId) }, '原文')
              : null,
          )))
        : h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '还没有来源。用 ⌘⇧V 捕获时自动打标。'),
      rawBox,
      h('div', { class: 'field', style: { marginTop: '8px' } }, h('label', {}, '追加'), kindSel),
    ),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '来源收敛度', h('b', {}, node.sources?.length ? `${(node.sources.reduce((s, x) => s + x.quality, 0) / node.sources.length * 100).toFixed(0)}%` : '—')),
      node.sources?.length
        ? h('div', {},
            h('div', { class: 'bar', style: { width: '100%', height: '4px', marginBottom: '8px' } },
              h('i', { style: { width: `${node.sources.reduce((s, x) => s + x.quality, 0) / node.sources.length * 100}%`, background: 'var(--accent)' } })),
            h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } },
              `${node.sources.length} 个独立来源，平均质量 ${(node.sources.reduce((s, x) => s + x.quality, 0) / node.sources.length).toFixed(2)}。来源越多且质量越一致，这条命题的根基越稳。`),
          )
        : h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '还没有来源，无法计算收敛度。'),
    ),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '底层概念', h('span', { style: { fontWeight: '400', color: 'var(--text-3)' } }, '跨主题同构的来源')),
      h('div', { class: 'field' }, h('label', {}, '标签'), tagInput),
    ),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '标的', h('span', { style: { fontWeight: '400', color: 'var(--text-3)' } }, '只做可见性，不做信号')),
      tickerBox,
      h('div', { class: 'field', style: { marginTop: '8px' } }, h('label', {}, '追加'), tickerInput, relationSel),
      h('p', { style: { margin: '6px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } },
        '命题上挂涉及的标的，可反查这条产业链位置影响哪些票。不输出买卖建议、评分、目标价。'),
    ),
    (() => { const sp = h('div'); sourcePanel(node).then((el) => { sp.replaceWith(el) }); return sp })(),
    (() => { const rp = h('div'); researchPanel(node).then((el) => { rp.replaceWith(el) }); return rp })(),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '苏格拉底追问'),
      socraticBtn,
      socraticBox,
    ),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '下游', h('b', {}, String(downstream.length))),
      downstream.length
        ? h('div', { class: 'chain' }, ...downstream.map((d) => h('button', {
            class: 'chain-node', onclick: () => selectNode(d.id),
          }, h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.title),
            h('span', { class: 'd' }, String(Math.round(d.confidence))))))
        : h('p', { style: { margin: 0, fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '叶子节点，没有下游。'),
    ),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '传导'),
      h('div', { class: 'field' }, h('label', {}, '下游'), h('span', { style: { fontSize: 'var(--t-body)', color: 'var(--text-2)' } }, downstream.length ? `${downstream.length} 条子命题` : '叶子节点')),
      hist.length > 1 ? h('div', { class: 'hist' }, ...hist.map((x) => h('i', {
        style: { height: `${Math.max(4, x.confidence)}%` },
        dataset: { by: x.by },
        title: `${x.t} · ${Math.round(x.confidence)} · ${x.by === 'propagation' ? '传导' : '手动'}`,
      }))) : null,
      hist.length > 1 ? h('div', { style: { display: 'flex', gap: '10px', marginTop: '6px', fontSize: 'var(--t-caption)', color: 'var(--text-3)' } },
        h('span', {}, '← 历史 · 越高越确信'),
        h('span', { style: { color: 'var(--orange)' } }, '■ 传导')) : null,
    ),
    h('div', { class: 'insp-section' },
      h('div', { class: 'insp-h' }, '结算', settled),
      h('div', { class: 'field' }, h('label', {}, '到期日'), dueInput),
      h('p', { style: { margin: '8px 0 0', fontSize: 'var(--t-caption)', color: 'var(--text-3)', lineHeight: '1.5' } },
        '到期后系统会问你：还想下这个注吗？答案进入你的校准曲线。'),
    ),
    h('div', { class: 'insp-section' },
      h('div', { style: { display: 'flex', gap: '4px' } },
        h('button', { class: 'btn', onclick: async () => {
          await m.updateNode(node.id, { status: node.status === 'cold' ? 'live' : 'cold' }); await refresh()
        } }, node.status === 'cold' ? '移出冷库' : '移入冷库'),
        h('button', { class: 'btn', style: { color: 'var(--red)' }, onclick: () => deleteNodeWithUndo(node.id) }, icon('trash', 13), '删除'),
      ),
    ),
  )
}

function qualityClass(q) {
  if (q >= 0.9) return 'observation'
  if (q >= 0.6) return 'hypothesis'
  return 'axiom'
}
