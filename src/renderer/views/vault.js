import { h, clear, toast } from '../lib/dom.js'
import { state, selectNode, setView } from '../app.js'
import { confColor, TYPE_LABEL, nodePath } from './shared.js'
import { SCENARIO_LABELS } from '../../main/llmlog.js'

export { renderReadings, renderSources } from './readings.js'
import { fmtValue, periodLabel, safeSourceLink, trustMark } from './readings.js'

const m = window.meridian

const META = {
  conflicts: {
    title: '待裁决冲突',
    note: '系统只标出矛盾，不替你裁决。每条冲突都是一次必须由你做出的判断。',
  },
  cold: {
    title: '冷库',
    note: '低质但可能为真的内容。不进主图谱，但仍参与共同前提扫描——弱信号经常来自弱来源。',
  },
  dead: {
    title: '墓碑区',
    note: '置信度跌破 20 或被证伪的命题。不删除——负资产的价值是避免重复犯错。',
  },
  filtered: {
    title: '已筛掉',
    note: '只留裁决记录，不留原文。若同一条 claim 后来从别的源进了图谱，记为一次误杀。',
  },
}

export async function renderVault(mid, kind) {
  clear(mid)
  const meta = META[kind] || META.cold

  if (kind === 'review') return renderReview(mid)
  if (kind === 'conflicts') return renderConflicts(mid, meta)


  const nodes = (await m.allNodes()).filter((n) =>
    kind === 'cold' ? n.status === 'cold' : n.status === 'dead')

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note),
    ),
    nodes.length
      ? h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, state.themes.find((t) => t.id === state.themeId)?.name || ''), h('em', {}, String(nodes.length))),
          h('div', { class: 'sect-b' },
            ...nodes.map((n) => h('div', { class: 'q' },
              h('span', { class: 'dot', style: { background: confColor(n.confidence), marginTop: '6px' } }),
              h('div', { class: 'q-body' },
                h('div', { class: 'q-text' }, n.title),
                h('div', { class: 'q-meta' },
                  h('span', {}, TYPE_LABEL[n.type]),
                  h('span', {}, `· 置信度 ${Math.round(n.confidence)}`),
                  h('span', {}, `· ${nodePath(state.nodes, n.id) || '未归档'}`),
                  h('span', {}, `· ${state.themes.find((t) => t.id === n.themeId)?.name || '已删主题'}`),
                  n.deletedAt ? h('span', { style: { color: 'var(--text-3)' } }, `· 删于 ${n.deletedAt}`) : null,
                ),
              ),
              h('div', { class: 'q-acts' },
                h('button', {
                  class: 'btn',
                  onclick: async () => {
                    if (n.deletedAt) {
                      await m.restoreNode(n.id)
                    } else {
                      await m.updateNode(n.id, { status: 'live', confidence: kind === 'dead' ? Math.max(25, n.confidence) : n.confidence })
                    }
                    await renderVault(mid, kind)
                  },
                }, n.deletedAt ? '整棵复活' : (kind === 'cold' ? '移回主图谱' : '复活')),
                h('button', { class: 'btn', onclick: () => { selectNode(n.id); setView('lattice') } }, '查看'),
              ),
            )),
          ),
        )
      : empty(meta),
  ))
}

async function renderConflicts(mid, meta) {
  const page = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, meta.title), h('p', {}, meta.note)))
  const list = h('div', {}, h('p', { role: 'status' }, '正在读取冲突…'))
  page.append(list)
  mid.append(page)
  try {
    const [conflicts, all] = await Promise.all([m.conflicts(), m.allNodes()])
    if (!page.isConnected) return
    const byId = new Map(all.map(n => [n.id, n]))
    clear(list)
    if (!conflicts.length) { list.append(empty(meta)); return }
    for (const c of conflicts) {
      const card = h('div', { class: 'conflict', dataset: { id: c.id, type: c.type || 'node' } })
      list.append(card)
      const loadPair = async () => {
        clear(card).append(h('p', { role: 'status' }, '正在读取双方记录…'))
        try {
          const reading = c.type === 'reading'
          const [a, b] = reading
            ? await Promise.all([m.getReading(c.readingA || c.a), m.getReading(c.readingB || c.b)])
            : [byId.get(c.a), byId.get(c.b)]
          if (!a || !b) throw new Error('missing-record')
          const readingSide = (r, label) => h('div', { class: 'side' }, h('b', {}, label),
            h('strong', { class: 'reading-number' }, `${fmtValue(r.value)} ${r.unit || ''}`),
            h('span', {}, periodLabel(r)), h('span', {}, r.source?.label || '未命名来源'), trustMark(r), safeSourceLink(r.source?.url))
          const actions = h('div', { class: 'acts' })
          // 决策动作要有决策的分量：A / B 是主要判断，用实心主按钮；
          // 「两者都对」是低频的自我纠正，降为次要样式，不跟主判断抢。
          for (const [choice, label, primary] of [['a', 'A 成立', true], ['b', 'B 成立', true], ['both', '两者都对（我搞错了）', false]]) {
            actions.append(h('button', { class: primary ? 'btn btn-primary' : 'btn', onclick: async () => {
              actions.querySelectorAll('button').forEach(button => { button.disabled = true })
              try {
                const result = await m.resolveConflict(c.id, choice)
                if (result?.ok === false) throw new Error('resolve-failed')
                if (page.isConnected) await renderVault(mid, 'conflicts')
              } catch { toast('裁决未保存，请重试', 'var(--red)') }
              finally { actions.querySelectorAll('button').forEach(button => { button.disabled = false }) }
            } }, label))
          }
          const sumSide = c.comparison ? h('div', { class: 'side' }, h('b', {}, 'B · 分部之和'),
            h('strong', { class: 'reading-number' }, `${fmtValue(c.comparison.sum)} ${c.comparison.unit || ''}`),
            h('span', {}, periodLabel(b)), h('span', {}, `${c.componentIds?.length || 0} 条分部作证；选择 A 将驳回这些分部作证，选择 B 将驳回总计作证。`)) : null
          clear(card).append(h('div', { class: 'note' }, `${c.note || (reading ? '同一期间出现不同数值，等待你裁决' : '判断不一致')} · 发现于 ${c.at || '未记录'}`),
            h('div', { class: 'pair' }, reading ? readingSide(a, c.comparison ? 'A · 总计' : 'A') : side(a, 'A'), h('span', { class: 'vs' }, 'vs'), sumSide || (reading ? readingSide(b, 'B') : side(b, 'B'))), actions)
        } catch {
          clear(card).append(h('p', { role: 'status' }, '双方记录暂时无法读取。'), h('button', { class: 'btn', onclick: loadPair }, '重试'))
        }
      }
      await loadPair()
      if (!page.isConnected) return
    }
  } catch {
    clear(list).append(h('p', { role: 'status' }, '冲突读取失败。'), h('button', { class: 'btn', onclick: () => renderVault(mid, 'conflicts') }, '重试'))
  }
}

function side(n, label) {
  return h('div', { class: 'side' },
    h('b', {}, `${label} · ${Math.round(n.confidence)}`),
    h('span', {}, n.title),
  )
}


// ============================================================
// 复盘：采集漏斗 + 误杀校准曲线
// ============================================================

async function renderReview(mid) {
  clear(mid)

  const [series, filterCalib, verdicts, byChannel, vsData, llm] = await Promise.all([
    m.intakeSeries(30),
    m.filterCalibration(),
    m.verdicts(),
    m.falseKillByChannel(30),
    m.vsInstitution(90),
    m.llmUsage(),
  ])
  // 通道已移除：只显示来源 id
  const chName = (id) => id

  // LLM 账本：按天聚合，今天与近 30 天两个口径
  const llmDays = llm?.daily || []
  const todayKey = new Date().toISOString().slice(0, 10)
  const llmToday = llmDays.find((d) => d.date === todayKey) || { calls: 0, failed: 0, degraded: 0, tokens: 0, byScenario: {} }
  const llmTotals = llmDays.reduce((a, d) => ({
    calls: a.calls + d.calls, failed: a.failed + d.failed, degraded: a.degraded + d.degraded, tokens: a.tokens + d.tokens,
  }), { calls: 0, failed: 0, degraded: 0, tokens: 0 })
  const llmScenarios = Object.entries(llmToday.byScenario || {}).sort((a, b) => b[1] - a[1])
  const llmRecent = llm?.recent || []

  // 聚合最近 30 天
  const agg = series.reduce((a, b) => ({
    captured: a.captured + b.captured,
    gatedIn: a.gatedIn + b.gatedIn,
    autoImported: a.autoImported + b.autoImported,
    toInbox: a.toInbox + b.toInbox,
    confirmed: a.confirmed + b.confirmed,
    rejected: a.rejected + b.rejected,
    undone: a.undone + b.undone,
    overridden: a.overridden + b.overridden,
    degraded: a.degraded + b.degraded,
  }), { captured: 0, gatedIn: 0, autoImported: 0, toInbox: 0, confirmed: 0, rejected: 0, undone: 0, overridden: 0, degraded: 0 })

  const pct = (n, d) => d > 0 ? Math.round((n / d) * 100) : 0
  const friction = pct(agg.toInbox, agg.captured)
  const undoRate = pct(agg.undone, agg.autoImported)
  const overrideRate = pct(agg.overridden, agg.autoImported + agg.confirmed)
  const falseKillCount = verdicts.filter(v => v.promotedTo != null).length
  const falseKillRate = pct(falseKillCount, verdicts.length)
  const degradeRate = pct(agg.degraded, agg.captured)

  const metrics = [
    { label: '摩擦率', value: friction, target: '< 20%', raw: `${agg.toInbox} / ${agg.captured}`, denom: agg.captured, color: friction > 20 ? 'var(--orange)' : 'var(--accent)' },
    { label: '撤销率', value: undoRate, target: '< 5%', raw: `${agg.undone} / ${agg.autoImported}`, denom: agg.autoImported, color: undoRate > 5 ? 'var(--orange)' : 'var(--accent)' },
    { label: '归位修改率', value: overrideRate, target: '< 15%', raw: `${agg.overridden} / ${agg.autoImported + agg.confirmed}`, denom: agg.autoImported + agg.confirmed, color: overrideRate > 15 ? 'var(--orange)' : 'var(--accent)' },
    { label: '误杀率', value: falseKillRate, target: '< 10%', raw: `${falseKillCount} / ${verdicts.length}`, denom: verdicts.length, color: falseKillRate > 10 ? 'var(--orange)' : 'var(--accent)' },
    { label: '降级率', value: degradeRate, target: '—', raw: `${agg.degraded} / ${agg.captured}`, denom: agg.captured, color: 'var(--text-3)' },
  ]

  // 校准曲线永远返回 4 个桶，"有没有数据"要看桶里有没有样本。
  const calibTotal = filterCalib.reduce((s, b) => s + b.total, 0)

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '复盘'),
      h('p', {}, '入库链路的健康度——不是你拥有什么，是搬得准不准。'),
    ),

    // 漏斗五项
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '采集漏斗'), h('em', {}, `近 30 天 · ${agg.captured} 次捕获`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          ...metrics.map((mt) => {
            // 0/0 不是 0%：分母为 0 说明没有数据，给灰色破折号，别装作"完美"。
            const noData = !mt.denom
            return h('div', { class: 'review-metric' },
              h('div', { class: 'review-metric-num', style: { color: noData ? 'var(--text-3)' : mt.color } }, noData ? '—' : `${mt.value}%`),
              h('div', { class: 'review-metric-label' }, mt.label),
              h('div', { class: 'review-metric-target' }, `目标 ${mt.target}`),
              h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, mt.raw),
            )
          }),
        ),
      ),
    ),

    // LLM 成本账本
    llmDays.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'LLM 调用'), h('em', {}, `近 ${llmDays.length} 天 · ${llmTotals.calls} 次`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num' }, String(llmToday.calls)),
            h('div', { class: 'review-metric-label' }, '今日调用'),
            h('div', { class: 'review-metric-raw', style: { color: llmToday.failed ? 'var(--orange)' : 'var(--text-3)' } },
              `${llmToday.failed} 失败 · ${llmToday.degraded} 降级`),
          ),
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num' }, llmToday.tokens.toLocaleString('en-US')),
            h('div', { class: 'review-metric-label' }, '今日 token'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `近 30 天 ${llmTotals.tokens.toLocaleString('en-US')}`),
          ),
        ),
        llmScenarios.length
          ? h('div', { class: 'llm-scenarios' },
              ...llmScenarios.map(([scene, n]) => h('span', { class: 'badge' }, `${SCENARIO_LABELS[scene] || scene} ${n}`)),
            )
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '今天还没有调用模型。'),
            )),
        h('p', { class: 'llm-note' }, 'token 数取自响应的 usage；模型不返回时按 0 计。'),
        llmRecent.length ? h('details', { class: 'llm-failures' },
          h('summary', {}, `最近失败 · ${llmRecent.length} 条（上限 50）`),
          ...llmRecent.slice(0, 8).map((f) => h('div', { class: 'q' },
            h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { fontSize: 'var(--t-body)' } },
                `${SCENARIO_LABELS[f.scenario] || f.scenario} · ${f.error || '失败'}`),
              h('div', { class: 'q-meta' },
                h('span', {}, String(f.at || '').replace('T', ' ').slice(0, 16)),
                h('span', {}, `· ${f.latency} ms`),
                f.channelId ? h('span', {}, `· 通道 ${chName(f.channelId)}`) : null,
              ),
            ),
          )),
          llmRecent.length > 8 ? h('div', { class: 'q-meta', style: { padding: '6px 0' } }, `还有 ${llmRecent.length - 8} 条未展开`) : null,
        ) : null,
      ),
    ) : null,

    // 每日趋势
    series.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '每日趋势'), h('em', {}, `${series.length} 天`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-daily' },
          ...series.slice(-14).map((b) => h('div', { class: 'review-day' },
            h('span', { class: 'review-day-date', style: { color: 'var(--text-3)' } }, b.date.slice(5)),
            h('span', { class: 'review-day-bar' },
              h('i', { style: { width: `${pct(b.autoImported, b.captured)}%`, background: 'var(--accent)' } }),
              h('i', { style: { width: `${pct(b.toInbox, b.captured)}%`, background: 'var(--orange)' } }),
            ),
            h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' } }, String(b.captured)),
          )),
        ),
      ),
    ) : null,

    // 误杀校准曲线
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '过滤器校准曲线'),
        h('em', {}, calibTotal ? `${calibTotal} 条被筛` : '尚无数据')),
      h('div', { class: 'sect-b' },
        calibTotal
          ? h('div', { class: 'calib' }, ...filterCalib.map((b) => {
              // 空桶不画"0%"：没有样本的柱子不该用颜色讲故事。
              const empty = !b.total
              return h('div', {},
                h('em', { style: { color: empty ? 'var(--text-3)' : '' } }, empty ? '—' : `${Math.round(b.accuracy * 100)}%`),
                h('i', { style: { height: `${b.accuracy * 100}%`, background: empty ? 'var(--line)' : b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } }),
                h('span', {}, `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`),
              )
            }))
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '尚无被筛掉的记录。有了数据之后，这里会显示各质量段的误杀率。'),
            )),
      ),
    ),

    // 误杀率按 gate 拆分
    filterCalib.byGate ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '误杀率按 gate 拆分')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          ...['source', 'dedup', 'user', 'other'].map((g) => {
            const s = filterCalib.byGate[g]
            // 0/0 不是 0%：没有数据就不该给一个"完美"的数字，看着像健康。
            const noData = !s.total
            return h('div', { class: 'review-metric' },
              h('div', { class: 'review-metric-num', style: { color: noData ? 'var(--text-3)' : s.missed > 0 ? 'var(--orange)' : 'var(--accent)' } }, noData ? '—' : `${Math.round(s.accuracy * 100)}%`),
              h('div', { class: 'review-metric-label' }, s.label),
              h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${s.missed} / ${s.total}`),
            )
          }),
        ),
      ),
    ) : null,

    // 误杀归因到通道
    byChannel.length ? h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '误杀归因到通道'), h('em', {}, `近 30 天 · ${byChannel.length} 通道`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          ...byChannel.map((c) => {
            // 0/0 不是 0%：没有数据就不该给一个"完美"的数字。
            const noData = !c.total
            return h('div', { class: 'review-metric' },
              h('div', { class: 'review-metric-num', style: { color: noData ? 'var(--text-3)' : c.missed > 0 ? 'var(--orange)' : 'var(--accent)' } }, noData ? '—' : `${Math.round(c.rate * 100)}%`),
              h('div', { class: 'review-metric-label' }, chName(c.channelId)),
              h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${c.missed} / ${c.total}`),
            )
          }),
        ),
      ),
    ) : null,

    // 最近采集条目（下钻）
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '最近采集'), h('em', {}, `近 ${series.length} 天`)),
      h('div', { class: 'sect-b' },
        agg.captured > 0
          ? h('div', {}, ...series.slice(-3).reverse().flatMap((b) =>
              h('div', { class: 'review-day-group' },
                h('div', { class: 'review-day-header' }, `${b.date} · 捕获 ${b.captured} · 自动 ${b.autoImported} · 收件箱 ${b.toInbox} · 撤销 ${b.undone}`),
              )
            ))
          : h('div', { class: 'q' }, h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '还没有采集记录。'),
            )),
      ),
    ),
  ))

  if (vsData.settledCount > 0) {
    mid.append(h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, '你 vs 机构'), h('em', {}, `近 90 天 · ${vsData.settledCount} 条已结算命题`)),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num', style: { color: vsData.userTotal >= 5 && vsData.userRate != null ? '' : 'var(--text-3)' } },
              vsData.userTotal >= 5 && vsData.userRate != null ? `${Math.round(vsData.userRate * 100)}%` : '—'),
            h('div', { class: 'review-metric-label' }, '你的命中率'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${vsData.userHits} / ${vsData.userTotal}${vsData.userTotal < 5 ? ' · 样本不足' : ''}`),
          ),
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num', style: { color: vsData.orgTotal >= 5 && vsData.orgRate != null ? '' : 'var(--text-3)' } },
              vsData.orgTotal >= 5 && vsData.orgRate != null ? `${Math.round(vsData.orgRate * 100)}%` : '—'),
            h('div', { class: 'review-metric-label' }, '机构观点命中率'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${vsData.orgHits} / ${vsData.orgTotal}${vsData.orgTotal < 5 ? ' · 样本不足' : ''}`),
          ),
        ),
      ),
    ))
  }
}

function empty(meta) {
  return h('section', { class: 'sect' },
    h('div', { class: 'sect-h' }, h('h2', {}, meta.title)),
    h('div', { class: 'sect-b' },
      h('div', { class: 'q' }, h('div', { class: 'q-body' },
        h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '现在是空的。'),
        h('div', { class: 'q-meta' }, meta.note),
      )),
    ),
  )
}
