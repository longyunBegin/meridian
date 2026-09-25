import { h, icon, clear, add, $, toast, confirmToast } from '../lib/dom.js'
import { state, selectTheme, selectNode, setView } from '../app.js'
import { confColor, TYPE_LABEL, nodePath } from './shared.js'
import { groupReadings } from '../../shared/readings.js'
import { SCENARIO_LABELS } from '../../main/llmlog.js'

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
  const conflicts = await m.conflicts()
  const all = await m.allNodes()
  const byId = new Map(all.map((n) => [n.id, n]))

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, meta.title),
      h('p', {}, meta.note),
    ),
    conflicts.length
      ? h('section', { class: 'sect' },
          h('div', { class: 'sect-h' }, h('h2', {}, '待你裁决'), h('em', {}, String(conflicts.length))),
          h('div', { class: 'sect-b' },
            ...conflicts.map((c) => {
              const a = byId.get(c.a)
              const b = byId.get(c.b)
              if (!a || !b) return null
              return h('div', { class: 'conflict' },
                h('div', { class: 'note' }, `${c.note} · 发现于 ${c.at}`),
                h('div', { class: 'pair' },
                  side(a, 'A'),
                  h('span', { class: 'vs' }, 'vs'),
                  side(b, 'B'),
                ),
                h('div', { class: 'acts' },
                  h('button', { class: 'btn', onclick: async () => { await m.resolveConflict(c.id, 'a'); await renderVault(mid, 'conflicts') } }, 'A 成立'),
                  h('button', { class: 'btn', onclick: async () => { await m.resolveConflict(c.id, 'b'); await renderVault(mid, 'conflicts') } }, 'B 成立'),
                  h('button', { class: 'btn', onclick: async () => { await m.resolveConflict(c.id, 'both'); await renderVault(mid, 'conflicts') } }, '两者都对（我搞错了）'),
                ),
              )
            }).filter(Boolean),
          ),
        )
      : empty(meta),
  ))
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

  const [series, filterCalib, verdicts, byChannel, channels, vsData, llm] = await Promise.all([
    m.intakeSeries(30),
    m.filterCalibration(),
    m.verdicts(),
    m.falseKillByChannel(30),
    m.channelList(),
    m.vsInstitution(90),
    m.llmUsage(),
  ])
  const chName = (id) => channels.find((c) => c.id === id)?.kind || id

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
    { label: '摩擦率', value: friction, target: '< 20%', raw: `${agg.toInbox} / ${agg.captured}`, color: friction > 20 ? 'var(--orange)' : 'var(--accent)' },
    { label: '撤销率', value: undoRate, target: '< 5%', raw: `${agg.undone} / ${agg.autoImported}`, color: undoRate > 5 ? 'var(--orange)' : 'var(--accent)' },
    { label: '归位修改率', value: overrideRate, target: '< 15%', raw: `${agg.overridden} / ${agg.autoImported + agg.confirmed}`, color: overrideRate > 15 ? 'var(--orange)' : 'var(--accent)' },
    { label: '误杀率', value: falseKillRate, target: '< 10%', raw: `${falseKillCount} / ${verdicts.length}`, color: falseKillRate > 10 ? 'var(--orange)' : 'var(--accent)' },
    { label: '降级率', value: degradeRate, target: '—', raw: `${agg.degraded} / ${agg.captured}`, color: 'var(--text-3)' },
  ]

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
          ...metrics.map((mt) => h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num', style: { color: mt.color } }, `${mt.value}%`),
            h('div', { class: 'review-metric-label' }, mt.label),
            h('div', { class: 'review-metric-target' }, `目标 ${mt.target}`),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, mt.raw),
          )),
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
        h('em', {}, filterCalib.length ? `${filterCalib.reduce((s, b) => s + b.total, 0)} 条被筛` : '尚无数据')),
      h('div', { class: 'sect-b' },
        filterCalib.length
          ? h('div', { class: 'calib' }, ...filterCalib.map((b) => h('div', {},
              h('em', {}, `${Math.round(b.accuracy * 100)}%`),
              h('i', { style: { height: `${b.accuracy * 100}%`, background: b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)' } }),
              h('span', {}, `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`),
            )))
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
            return h('div', { class: 'review-metric' },
              h('div', { class: 'review-metric-num', style: { color: s.missed > 0 ? 'var(--orange)' : 'var(--accent)' } }, `${Math.round(s.accuracy * 100)}%`),
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
          ...byChannel.map((c) => h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num', style: { color: c.missed > 0 ? 'var(--orange)' : 'var(--accent)' } }, `${Math.round(c.rate * 100)}%`),
            h('div', { class: 'review-metric-label' }, chName(c.channelId)),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${c.missed} / ${c.total}`),
          )),
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
            h('div', { class: 'review-metric-num', style: { color: '' } },
              vsData.userTotal >= 5 && vsData.userRate != null ? `${Math.round(vsData.userRate * 100)}%` : '样本不足'),
            h('div', { class: 'review-metric-label' }, '你的命中率'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${vsData.userHits} / ${vsData.userTotal}`),
          ),
          h('div', { class: 'review-metric' },
            h('div', { class: 'review-metric-num', style: { color: '' } },
              vsData.orgTotal >= 5 && vsData.orgRate != null ? `${Math.round(vsData.orgRate * 100)}%` : '样本不足'),
            h('div', { class: 'review-metric-label' }, '机构观点命中率'),
            h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, `${vsData.orgHits} / ${vsData.orgTotal}`),
          ),
        ),
      ),
    ))
  }
}

// ------------------------------------------------------------------ 读数展示

const FOLD_THRESHOLD = 10

/** R15 · 取数器中文化。select 里不再出现 edgarConcept 这类实现名——
 *  用户该看到的是「这个通道从哪拿数据」，不是「调了哪个函数」。 */
const FETCH_LABELS = {
  manual: '手动粘贴',
  rss: 'RSS 订阅',
  web: '网页抓取',
  edgarConcept: 'SEC EDGAR（财报标签）',
  edgarFilings: 'SEC EDGAR（公告列表）',
  cninfo: '巨潮资讯',
  eastmoneyReport: '东方财富研报',
  defillamaProtocol: 'DefiLlama（协议数据）',
  defillamaStablecoins: 'DefiLlama（稳定币）',
  blockchainChart: 'Blockchain.com（链上指标）',
  tavily: 'Tavily 搜索',
  'grok-x-search': 'Grok X 搜索',
  jina: 'Jina 网页解析',
}
const fetchLabel = (f) => FETCH_LABELS[f] || f


function fmtValue(v) {
  if (typeof v !== 'number') return String(v ?? '—')
  return v.toLocaleString('en-US')
}

/**
 * 读数行——历史期紧凑网格。
 *
 * 最新一期已由卡片头的摘要区独占视觉焦点，这里只做密集参考列表：
 * caption 级、行高 32px、四列。重述标记是行内 caption 而非独立网格列——
 * 原来它是第 5 个 grid 子元素，但 grid-template-columns 只定义了 4 列，会被挤出去。
 */
function readingRow(r, prev, opts = {}) {
  const restated = !!opts.restated
  // 环比 = 当期 / 上期 − 1。上期缺失或为 0 时给占位，不出 NaN。
  let change = null
  if (prev && Number(prev.value) > 0 && Number.isFinite(Number(r.value))) {
    const ratio = Number(r.value) / Number(prev.value) - 1
    if (Number.isFinite(ratio)) change = ratio
  }
  const changeLabel = change == null
    ? '—'
    : `${change >= 0 ? '+' : '\u2212'}${Math.abs(change * 100).toFixed(1)}%`
  const changeTone = change == null ? 'flat' : change >= 0 ? 'up' : 'down'

  return h('div', { class: 'reading-row', dataset: { latest: String(!!opts.latest), restated: String(restated) } },
    h('span', { class: 'rc-asof' }, r.asOf || '无期间'),
    h('span', { class: 'rc-basis' }, r.basis === 'estimated' ? '估算' : '财报口径'),
    h('span', { class: 'rc-delta', dataset: { tone: changeTone } }, changeLabel),
    h('span', { class: 'rc-value' }, fmtValue(r.value)),
    restated ? h('span', { class: 'rc-restated', title: '同一数据期的后续申报修正了旧值' }, '已被修正') : null,
  )
}

function metricCard(group, indicators, channels, gaapLabels) {
  const channelIds = new Set(group.items.map((r) => r.channelId).filter(Boolean))
  const tracked = indicators.filter((n) => (n.channelIds || []).some((id) => channelIds.has(id)))
  const channelName = group.items.map((r) => channels.find((c) => c.id === r.channelId)?.name).find((name) => name?.trim())
  const gaapLabel = gaapLabels.find(({ tag }) => group.metric.endsWith(tag))?.label
  const title = channelName || gaapLabel || group.metric

  // 常量只在卡片头出现一次：单位、来源类型、抓取时间
  const latest = group.latest || group.items[0]
  const unit = group.items.map((r) => r.unit).find(Boolean)
  const kind = latest?.source?.kind || '未知来源'
  const fetchedAt = (latest?.at || '').slice(0, 10)

  // 最新一期的环比：上期 = items 里排在它后面的那条
  const latestIdx = group.items.indexOf(latest)
  const latestPrev = latestIdx >= 0 ? group.items[latestIdx + 1] : null
  let latestChange = null
  if (latestPrev && Number(latestPrev.value) > 0 && Number.isFinite(Number(latest.value))) {
    const ratio = Number(latest.value) / Number(latestPrev.value) - 1
    if (Number.isFinite(ratio)) latestChange = ratio
  }

  const isFolded = group.count > FOLD_THRESHOLD
  const visible = isFolded ? group.items.slice(0, FOLD_THRESHOLD) : group.items

  // 重述检测：同一 asOf 出现多次 → 只留最新一条为当前值
  const byAsOf = new Map()
  for (const r of group.items) {
    const key = r.asOf || '\u2014'
    if (!byAsOf.has(key)) byAsOf.set(key, [])
    byAsOf.get(key).push(r)
  }
  const restatedSet = new Set()
  for (const list of byAsOf.values()) {
    if (list.length < 2) continue
    for (const r of list.slice(1)) restatedSet.add(r.id)
  }

  const renderRow = (r, i) => {
    const prev = group.items[i + 1]
    return readingRow(r, prev, { latest: r === group.latest, restated: restatedSet.has(r.id) })
  }
  const body = h('div', { class: 'reading-grid' }, ...visible.map(renderRow))

  if (isFolded) {
    let expanded = false
    const moreBtn = h('button', {
      class: 'reading-more',
      onclick: () => {
        if (expanded) return
        expanded = true
        for (let i = FOLD_THRESHOLD; i < group.items.length; i++) body.append(renderRow(group.items[i], i))
        moreBtn.remove()
      },
    }, `显示其余 ${group.count - FOLD_THRESHOLD} 期`)
    body.append(moreBtn)
  }

  const latestChangeLabel = latestChange == null
    ? '—'
    : `${latestChange >= 0 ? '+' : '\u2212'}${Math.abs(latestChange * 100).toFixed(1)}%`

  return h('section', { class: 'reading-card' },
    // 卡片头：人读标题 + 跟踪态 + ⓘ 悬停看 camelCase
    h('div', { class: 'reading-card-h' },
      h('div', { class: 'reading-card-title' },
        h('h2', {}, title),
        tracked.length ? h('span', { class: 'reading-tracking' }, '跟踪中') : null,
        h('span', { class: 'reading-info', title: group.metric }, '\u24d8'),
      ),
      h('div', { class: 'reading-card-const' },
        h('span', {}, `${group.count} 期`),
        unit ? h('span', {}, unit) : null,
        h('span', {}, kind),
        fetchedAt ? h('span', {}, `抓于 ${fetchedAt}`) : null,
      ),
    ),
    // 最新一期摘要：扫读的第一落点，大字号 + 语义色环比
    h('div', { class: 'reading-hero' },
      h('div', { class: 'reading-hero-main' },
        h('span', { class: 'reading-hero-value' }, fmtValue(latest?.value)),
        unit ? h('span', { class: 'reading-hero-unit' }, unit) : null,
      ),
      h('div', { class: 'reading-hero-side' },
        h('span', {
          class: 'reading-hero-delta',
          dataset: { tone: latestChange == null ? 'flat' : latestChange >= 0 ? 'up' : 'down' },
        }, latestChangeLabel),
        h('span', { class: 'reading-hero-asof' }, `${latest?.asOf || '无期间'} · ${latest?.basis === 'estimated' ? '估算' : '财报口径'}`),
      ),
    ),
    body,
    h('div', { class: 'reading-card-foot' },
      '技术名、原文链接和每次抓取的明细，收在悬停与展开里。',
    ),
  )
}

export async function renderReadings(mid) {
  clear(mid)
  const [all, channels, nodes, gaapLabels] = await Promise.all([
    m.allReadings(), m.channelList(), m.allNodes(), m.commonUsGaap(),
  ])
  if (state.view !== 'vault' || state.vaultKind !== 'readings') return
  const page = h('div', { class: 'page' })
  mid.append(page)

  // 空态
  if (!all.length) {
    page.append(h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '读数')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'q' }, h('div', { class: 'q-body' },
          h('div', { class: 'q-text', style: { color: 'var(--text-3)' } },
            '现在是空的。读数来自取数器抓取的结构化财务数字——在「数据源」里配一个 EDGAR 通道并点「拉取」，读数就会落在这里。'),
        )),
      ),
    ))
    return
  }

  const channelIds = new Set(all.map((r) => r.channelId).filter(Boolean))
  const indicators = nodes.filter((n) =>
    n.type === 'observation' && n.status !== 'dead' && (n.channelIds || []).some((id) => channelIds.has(id)))

  let currentFilter = null
  let currentIndicator = null

  const filterBar = (label, options, select, marginBottom) => {
    if (options.length <= 1) return null
    const bar = h('div', { class: 'sect-b', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom } })
    for (const option of [{ label, value: null }, ...options]) {
      const button = h('button', {
        class: 'btn', style: { padding: '2px 10px' }, 'aria-selected': String(option.value === null),
        onclick: () => {
          for (const child of bar.children) child.setAttribute('aria-selected', String(child === button))
          select(option.value)
          refresh()
        },
      }, option.label)
      bar.append(button)
    }
    return bar
  }

  function refresh() {
    let filtered = all
    if (currentIndicator) {
      const ind = indicators.find((n) => n.id === currentIndicator)
      if (ind) filtered = filtered.filter((r) => (ind.channelIds || []).includes(r.channelId))
    }
    if (currentFilter) {
      filtered = filtered.filter((r) => r.channelId === currentFilter)
    }
    const groups = groupReadings(filtered)
    const list = $('#readings-list', mid)
    if (list) {
      clear(list)
      add(list, groups.map((g) => metricCard(g, indicators, channels, gaapLabels)))
    }
  }

  const groups = groupReadings(all)
  page.append(h('section', { class: 'sect' },
    h('div', { class: 'sect-h' }, h('h2', {}, '读数'), h('em', {}, String(all.length))),
    filterBar('全部指标', indicators.map((n) => ({ label: n.title, value: n.id })),
      (value) => { currentIndicator = value }, '10px'),
    filterBar('全部通道', [...channelIds].map((id) => ({ label: channels.find((c) => c.id === id)?.name || id, value: id })),
      (value) => { currentFilter = value }, '6px'),
    h('div', { id: 'readings-list' },
      ...groups.map((g) => metricCard(g, indicators, channels, gaapLabels)),
    ),
  ))
}

// ============================================================
// 数据源：通道管理
// ============================================================

const FETCH_OPTIONS = [
  'manual', 'rss', 'web', 'edgarConcept', 'edgarFilings',
  'cninfo', 'eastmoneyReport', 'jina', 'tavily', 'grok-x-search',
]

const KIND_OPTIONS = [
  '财报 / 公告', '一手数据', '券商研报', '独立媒体', '自媒体',
]

const EDGAR_FETCHES = new Set(['edgarConcept', 'edgarFilings'])

export async function renderSources(mid) {
  clear(mid)
  const [channels, fetchers, metricFetchers, matchRates] = await Promise.all([
    m.channelList(), m.availableFetchers(), m.metricFetchers(), m.channelMatchRates(30),
  ])
  const rateById = new Map((matchRates || []).map((r) => [r.channelId, r]))

  const flash = h('span', { style: { fontSize: 'var(--t-body)', color: 'var(--text-3)', marginLeft: '8px' } }, '')
  const showFlash = (msg, color = 'var(--text-2)') => {
    flash.textContent = msg
    flash.style.color = color
    setTimeout(() => { flash.textContent = '' }, 4000)
  }

  mid.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '数据源'),
      h('p', {}, '通道描述符：按内容类型选取数器。已实现的取数器：' + fetchers.join('、') + '。'),
      h('p', {}, '「未匹配」= 近 30 天该通道进入收件箱、但没被抽取的比例（低质 / 未命中标签库 / 未达阈值）——只作参考，不会自动停用通道。'),
      flash,
    ),

    // R15 · 三段式行：状态点 + 名称/说明 + 右簇 + ›
    channels.length ? h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '通道'), h('span', { class: 'spacer' }), h('em', {}, String(channels.length))),
      h('div', { class: 'channel-rows' },
        ...channels.map((ch) => {
          const rate = rateById.get(ch.id)
          const hasError = !!ch.lastError
          const matchRate = rate?.total ? Math.round(rate.rate * 100) : null
          const detailOpen = h('div', { class: 'channel-detail' })
          const chev = h('span', { class: 'channel-chev', dataset: { open: 'false' } }, '›')
          const toggleDetail = () => { detailOpen.hidden = !detailOpen.hidden; chev.dataset.open = String(!detailOpen.hidden) }

          const row = h('div', { class: 'channel-row', dataset: { state: hasError ? 'error' : ch.enabled ? 'on' : 'off' } },
            // ① 状态点：三态，出错最重
            h('span', { class: 'channel-dot', title: hasError ? '拉取出错' : ch.enabled ? '启用中' : '已停用' }),
            // ② 名称 + 说明 caption
            h('div', { class: 'channel-main' },
              h('div', { class: 'channel-name' }, ch.name),
              h('div', { class: 'channel-desc' }, `${ch.kind} · 每 ${ch.interval || 60} 分钟`),
              // ⑤ 出错态：名称下红色 caption，不降级进 tooltip
              hasError ? h('div', { class: 'channel-err' }, `错误：${ch.lastError}`) : null,
            ),
            // ③ 右簇：恒定宽度，扫读时成列
            h('div', { class: 'channel-right' },
              matchRate != null ? h('span', {
                class: 'channel-rate', dataset: { high: String(matchRate >= 50) },
                title: `近 30 天 ${rate.unmatched}/${rate.total} 条进入收件箱但没被抽取`,
              }, `未匹配 ${matchRate}%`) : null,
              h('button', {
                class: 'channel-pill', dataset: { on: String(ch.enabled) },
                onclick: async () => { await m.channelUpdate(ch.id, { enabled: !ch.enabled }); await renderSources(mid) },
              }, ch.enabled ? '启用' : '停用'),
              h('button', { class: 'channel-link', onclick: toggleDetail }, '详情'),
              h('button', {
                class: 'channel-link is-danger',
                onclick: async () => {
                  if (!await confirmToast(`删除通道「${ch.name}」？`, '删除')) return
                  await m.channelRemove(ch.id)
                  await renderSources(mid)
                },
              }, '删除'),
              chev,
            ),
          )
          chev.onclick = toggleDetail

          // ⑥ 工程字段收纳进详情区——默认行上只留名称/类型/间隔/未匹配/启停
          detailOpen.append(h('div', { class: 'channel-detail-grid' },
            h('div', {}, h('span', {}, '取数器'), h('b', {}, fetchLabel(ch.fetch))),
            h('div', {}, h('span', {}, 'query'), h('b', {}, ch.query || '—')),
            ch.metric ? h('div', {}, h('span', {}, '指标标签'), h('b', {}, ch.metric)) : null,
            h('div', {}, h('span', {}, '归属'), h('b', {}, ch.themeId ? (state.themes.find((t) => t.id === ch.themeId)?.name || '主题') : '全局')),
            h('div', {}, h('span', {}, '最后拉取'), h('b', {}, ch.lastFetch || '从未')),
            h('div', {}, h('span', {}, '拿到条数'), h('b', {}, ch.lastCount != null ? String(ch.lastCount) : '—')),
            ch.failCount > 0 ? h('div', {}, h('span', {}, '连续失败'), h('b', {}, String(ch.failCount))) : null,
          ), h('div', { class: 'channel-detail-acts' },
            fetchers.includes(ch.fetch) ? h('button', {
              class: 'btn',
              onclick: async () => {
                showFlash(`正在拉取「${ch.name}」…`)
                const r = await m.channelFetch(ch.id)
                if (r.error) { showFlash(`拉取失败：${r.error}`, 'var(--red)'); return }
                if (r.readings) {
                  showFlash(`拉到 ${r.readings.total} 条，新增 ${r.readings.added}，跳过 ${r.readings.skipped}`)
                } else {
                  showFlash(`拉取到 ${r.items.length} 条`)
                }
              },
            }, '立即拉取') : h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '取数器未实现'),
            h('select', {
              class: 'txt', style: { width: 'auto' },
              onchange: async (e) => {
                const newFetch = e.target.value
                const patch = { fetch: newFetch }
                // edgar ↔ 其他：query/metric 语义不同，清掉不相干字段
                if (EDGAR_FETCHES.has(ch.fetch) && !EDGAR_FETCHES.has(newFetch)) {
                  patch.metric = null
                  showFlash(`已设 ${ch.name} → ${fetchLabel(newFetch)}，已清空指标标签，请重新填写`)
                } else if (!EDGAR_FETCHES.has(ch.fetch) && EDGAR_FETCHES.has(newFetch)) {
                  patch.metric = null
                  showFlash(`已设 ${ch.name} → ${fetchLabel(newFetch)}，已清空指标标签，请重新填写`)
                } else {
                  showFlash(`已设 ${ch.name} → ${fetchLabel(newFetch)}`)
                }
                await m.channelUpdate(ch.id, patch)
                await renderSources(mid)
              },
            },
              ...FETCH_OPTIONS.map((f) => h('option', { value: f, selected: ch.fetch === f }, fetchLabel(f))),
            ),
          ))
          detailOpen.hidden = true

          return h('div', { class: 'channel-cell' }, row, detailOpen)
        }),
      ),
    ) : null,

    h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '新增通道')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'field', style: { marginTop: '8px' } },
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'flex-end' } },
            ...(() => {
              const inputs = { kind: '独立媒体', fetch: 'manual', themeId: state.themeId || null }
              // metric 输入框引用，供标签选择回填
              let metricInput = null
              let metricRow = null
              // 发现标签按钮（仅 EDGAR 类型显示）
              const discoverBtn = h('button', {
                class: 'btn', style: { display: 'none', padding: '4px 8px', fontSize: 'var(--t-caption)' },
                onclick: async () => {
                  if (!inputs.query) { showFlash('请先填 query (ticker)', 'var(--red)'); return }
                  showFlash(`正在发现标签…`)
                  const result = await m.discoverTags(inputs.query)
                  if (result.error) { showFlash(`发现失败：${result.error}`, 'var(--red)'); return }
                  showFlash(result.entityName ? `${result.entityName} · ${result.tags.length} 个标签` : `${result.tags.length} 个标签`)
                  renderTagPanel(result.tags, metricInput)
                },
              }, '发现标签')
              // 标签面板容器
              const tagPanel = h('div', { style: { marginTop: '8px', width: '100%' } })
              function renderTagPanel(tags, inputEl) {
                clear(tagPanel)
                if (!tags.length) { tagPanel.append(h('p', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '没有标签')); return }
                // 过滤框
                let filterText = ''
                const filterInput = h('input', { class: 'txt', placeholder: '过滤标签…', style: { width: '100%', marginBottom: '6px' }, oninput: (e) => { filterText = e.target.value.toLowerCase(); refreshList() } })
                const listBox = h('div', { style: { maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border, #e0e0e0)', borderRadius: 'var(--r-sm)' } })
                function refreshList() {
                  clear(listBox)
                  const filtered = filterText
                    ? tags.filter((t) => t.tag.toLowerCase().includes(filterText) || (t.label && t.label.includes(filterText)))
                    : tags
                  for (const t of filtered) {
                    const display = t.label ? `${t.label}（${t.tag}）` : t.tag
                    const row = h('div', {
                      style: { padding: '3px 8px', cursor: t.periods > 0 ? 'pointer' : 'default', fontSize: 'var(--t-caption)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border, #f0f0f0)' },
                      onclick: t.periods > 0 ? () => {
                        if (inputEl) { inputEl.value = t.tag; inputs.metric = t.tag }
                        clear(tagPanel)
                      } : null,
                    },
                      h('span', { style: { color: t.periods > 0 ? 'var(--text-2)' : 'var(--text-3)', fontWeight: t.common ? '600' : '400' } }, display),
                      h('span', { style: { color: 'var(--text-3)', fontSize: 'var(--t-caption)' } }, String(t.periods)),
                    )
                    listBox.append(row)
                  }
                }
                refreshList()
                tagPanel.append(filterInput, listBox)
              }
              return [
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '名称'),
                  h('input', { class: 'txt', placeholder: '名称', style: { flex: '1', minWidth: '120px' }, oninput: (e) => inputs.name = e.target.value }),
                ),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, 'query (URL/CIK/ticker)'),
                  h('input', { class: 'txt', placeholder: 'query', style: { flex: '1', minWidth: '120px' }, oninput: (e) => inputs.query = e.target.value }),
                ),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '取数器'),
                  h('select', { class: 'txt', style: { width: 'auto' }, onchange: (e) => {
                    inputs.fetch = e.target.value
                    const needsMetric = metricFetchers.includes(e.target.value)
                    metricRow.style.display = needsMetric ? '' : 'none'
                    discoverBtn.style.display = e.target.value === 'edgarConcept' ? '' : 'none'
                    if (!needsMetric) { inputs.metric = ''; if (metricInput) metricInput.value = '' }
                  } },
                    ...FETCH_OPTIONS.map((f) => h('option', { value: f, selected: f === 'manual' }, f)),
                  ),
                ),
                (metricRow = h('div', { style: { display: 'none', flexDirection: 'column', gap: '2px' } },
                  h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, 'metric'),
                  h('div', { style: { display: 'flex', gap: '4px', alignItems: 'flex-end' } },
                    (metricInput = h('input', { class: 'txt', placeholder: 'metric', style: { flex: '1', minWidth: '120px' }, oninput: (e) => inputs.metric = e.target.value })),
                    discoverBtn,
                  ),
                )),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '来源类型'),
                  h('select', { class: 'txt', style: { width: 'auto' }, onchange: (e) => inputs.kind = e.target.value },
                    ...KIND_OPTIONS.map((k) => h('option', { value: k, selected: k === '独立媒体' }, k)),
                  ),
                ),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '间隔 (分钟)'),
                  h('input', { class: 'txt', type: 'number', value: '60', min: '15', style: { width: '80px' }, oninput: (e) => inputs.interval = Number(e.target.value) || 60 }),
                ),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('label', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)' } }, '所属主题'),
                  h('select', { class: 'txt', style: { width: 'auto' }, onchange: (e) => inputs.themeId = e.target.value || null },
                    h('option', { value: '' }, '全局（所有主题可用）'),
                    ...state.themes.map((t) => h('option', { value: t.id, selected: t.id === state.themeId }, t.name)),
                  ),
                ),
                h('button', {
                  class: 'btn btn-primary',
                  onclick: async () => {
                    if (!inputs.name) { showFlash('请填名称', 'var(--red)'); return }
                    if (metricFetchers.includes(inputs.fetch) && !inputs.metric?.trim()) { showFlash('该取数器必须填 metric', 'var(--red)'); return }
                    await m.channelAdd({ name: inputs.name, query: inputs.query || '', fetch: inputs.fetch, metric: inputs.metric || null, kind: inputs.kind, interval: Math.max(15, Number(inputs.interval) || 60), themeId: inputs.themeId || null })
                    showFlash('已添加通道')
                    await renderSources(mid)
                  },
                }, '添加'),
                tagPanel,
              ]
            })(),
          ),
        ),
      ),
    ),
  ))
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
