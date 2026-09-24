import { h, icon, clear, add, $, toast } from '../lib/dom.js'
import { state, selectTheme, selectNode, setView } from '../app.js'
import { confColor, TYPE_LABEL, nodePath } from './shared.js'
import { groupReadings } from '../../shared/readings.js'

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

  const [series, filterCalib, verdicts, byChannel, channels, vsData] = await Promise.all([
    m.intakeSeries(30),
    m.filterCalibration(),
    m.verdicts(),
    m.falseKillByChannel(30),
    m.channelList(),
    m.vsInstitution(90),
  ])
  const chName = (id) => channels.find((c) => c.id === id)?.kind || id

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
}

// ------------------------------------------------------------------ 读数展示

const FOLD_THRESHOLD = 10

function fmtValue(v) {
  if (typeof v !== 'number') return String(v ?? '—')
  return v.toLocaleString('en-US')
}

// R1: 反查——读数 channelId → 哪些指标的 channelIds 含它
function trackedIndicators(reading, indicators) {
  if (!reading.channelId) return []
  return indicators.filter((n) => (n.channelIds || []).includes(reading.channelId))
}

function readingRow(r, isLatest, indicators) {
  const tracked = trackedIndicators(r, indicators)
  return h('div', { class: 'q', style: isLatest ? { borderLeft: '3px solid var(--blue, #0071e3)' } : {} },
    h('div', { class: 'q-body' },
      h('div', { class: 'q-text' },
        h('span', { style: { fontWeight: isLatest ? '600' : '400' } }, fmtValue(r.value)),
        r.unit ? h('span', { style: { color: 'var(--text-3)', marginLeft: '4px' } }, r.unit) : null,
      ),
      // R1: 数据期和抓于分两行——合起来才能回答「下注时能看到的数据是什么」
      h('div', { class: 'q-meta' },
        h('span', {}, `数据期 ${r.asOf || '—'}`),
        h('span', { style: { marginLeft: '6px' } }, `· ${r.basis || 'reported'}`),
      ),
      h('div', { class: 'q-meta' },
        h('span', {}, `抓于 ${r.at || '—'}`),
        h('span', { style: { marginLeft: '6px' } }, `· ${r.source?.kind || '未知'}`),
        r.source?.url ? h('button', {
          class: 'btn', style: { marginLeft: '6px', padding: '1px 6px', fontSize: 'var(--t-caption)' },
          onclick: () => m.openExternal(r.source.url),
        }, '来源') : null,
      ),
      // R1: 跟踪——这个读数在支撑哪条判断
      tracked.length ? h('div', { class: 'q-meta' },
        h('span', { style: { color: 'var(--text-3)' } }, `跟踪：${tracked.map((n) => n.title).join('、')}`),
      ) : null,
    ),
  )
}

function metricCard(group, indicators) {
  const isFolded = group.count > FOLD_THRESHOLD
  const visible = isFolded ? group.items.slice(0, FOLD_THRESHOLD) : group.items
  const hiddenCount = group.count - FOLD_THRESHOLD

  // R1: 同 asOf 视觉归组——正常的重复申报不像数据错误
  const asOfGroups = {}
  for (const r of visible) {
    const key = r.asOf || '—'
    if (!asOfGroups[key]) asOfGroups[key] = []
    asOfGroups[key].push(r)
  }
  const asOfKeys = Object.keys(asOfGroups)

  const body = h('div', { class: 'sect-b' },
    ...visible.map((r, i) => {
      const row = readingRow(r, i === 0, indicators)
      // 同 asOf 多条：第一条加标注
      const key = r.asOf || '—'
      if (asOfGroups[key].length > 1 && asOfGroups[key][0] === r) {
        row.classList.add('asof-group-start')
      }
      return row
    }),
  )

  if (isFolded) {
    let expanded = false
    const moreBtn = h('button', {
      class: 'btn', style: { margin: '6px 0' },
      onclick: () => {
        if (expanded) return
        expanded = true
        for (const r of group.items.slice(FOLD_THRESHOLD)) {
          body.append(readingRow(r, false, indicators))
        }
        moreBtn.remove()
      },
    }, `+${hiddenCount} 条`)
    body.append(moreBtn)
  }

  return h('section', { class: 'sect' },
    h('div', { class: 'sect-h' },
      h('h2', {}, group.metric),
      h('em', {}, String(group.count)),
    ),
    body,
  )
}

export async function renderReadings(mid) {
  clear(mid)
  const [all, channels] = await Promise.all([m.allReadings(), m.channelList()])

  // 空态
  if (!all.length) {
    mid.append(h('section', { class: 'sect' },
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

  // 筛选器：按指标 / 按通道
  const channelIds = [...new Set(all.map((r) => r.channelId).filter(Boolean))]
  const channelNames = {}
  for (const id of channelIds) {
    const ch = channels.find((c) => c.id === id)
    channelNames[id] = ch ? ch.name : id
  }

  // 有通道的 observation 指标
  const indicators = state.nodes.filter((n) =>
    n.type === 'observation' && n.status !== 'dead' && (n.channelIds || []).length > 0)

  let currentFilter = null
  let currentIndicator = null
  const filterBar = h('div', { class: 'sect-b', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' } })
  const indicatorBar = h('div', { class: 'sect-b', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } })

  const filterBtn = (label, value, bar) => h('button', {
    class: 'btn', style: { padding: '2px 10px' },
    onclick: async () => { currentFilter = value; await refresh() },
  }, label)

  const indicatorBtn = (label, value) => h('button', {
    class: 'btn', style: { padding: '2px 10px' },
    onclick: async () => { currentIndicator = value; await refresh() },
  }, label)

  async function refresh() {
    let filtered = all
    if (currentIndicator) {
      const ind = state.nodes.find((n) => n.id === currentIndicator)
      if (ind) filtered = filtered.filter((r) => (ind.channelIds || []).includes(r.channelId))
    }
    if (currentFilter) {
      filtered = filtered.filter((r) => r.channelId === currentFilter)
    }
    const groups = groupReadings(filtered)
    const list = $('#readings-list')
    if (list) { clear(list); add(list, groups.map((g) => metricCard(g, indicators))) }
  }

  // 指标筛选排
  indicatorBar.append(indicatorBtn('全部指标', null))
  for (const ind of indicators) {
    indicatorBar.append(indicatorBtn(ind.title, ind.id))
  }

  // 通道筛选排
  filterBar.append(filterBtn('全部通道', null, filterBar))
  for (const id of channelIds) {
    filterBar.append(filterBtn(channelNames[id], id, filterBar))
  }

  const groups = groupReadings(all)
  mid.append(h('section', { class: 'sect' },
    h('div', { class: 'sect-h' }, h('h2', {}, '读数'), h('em', {}, String(all.length))),
    indicatorBar,
    filterBar,
    h('div', { id: 'readings-list' },
      ...groups.map((g) => metricCard(g, indicators)),
    ),
  ))

  // 你 vs 机构
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
  const [channels, fetchers, metricFetchers] = await Promise.all([m.channelList(), m.availableFetchers(), m.metricFetchers()])

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
      flash,
    ),

    channels.length ? h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '通道列表'), h('em', {}, String(channels.length))),
      h('div', { class: 'sect-b' },
        ...channels.map((ch) => h('div', { class: 'q' },
          h('div', { class: 'q-body' },
            h('div', { class: 'q-text' }, ch.name),
            h('div', { class: 'q-meta' },
              h('span', {}, `${ch.kind} · ${ch.fetch}${ch.metric ? ' · ' + ch.metric : ''} · 间隔 ${ch.interval || 60} 分钟 · ${ch.enabled ? '启用' : '停用'}`),
              ch.themeId ? h('span', { style: { marginLeft: '6px', color: 'var(--text-3)' } }, `· ${state.themes.find((t) => t.id === ch.themeId)?.name || '主题'}`) : null,
              ch.lastFetch ? h('span', { style: { marginLeft: '6px', color: 'var(--text-3)' } }, `· 最后拉取 ${ch.lastFetch}`) : null,
              ch.lastCount != null ? h('span', { style: { marginLeft: '6px', color: 'var(--text-3)' } }, `· 拉到 ${ch.lastCount} 条`) : null,
              ch.failCount > 0 ? h('span', { style: { marginLeft: '6px', color: 'var(--text-3)' } }, `· 连续失败 ${ch.failCount}`) : null,
              ch.lastError ? h('span', { style: { marginLeft: '6px', color: 'var(--red)' } }, `· 错误：${ch.lastError}`) : null,
              fetchers.includes(ch.fetch) ? h('button', {
                class: 'btn', style: { marginLeft: '8px', padding: '2px 8px' },
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
              }, '拉取') : h('span', { style: { marginLeft: '8px', color: 'var(--text-3)' } }, '（未实现）'),
            ),
          ),
          h('div', { class: 'q-acts' },
            h('select', {
              class: 'txt', style: { width: 'auto' },
              onchange: async (e) => {
                const newFetch = e.target.value
                const patch = { fetch: newFetch }
                // edgar ↔ 其他：query/metric 语义不同，清掉不相干字段
                if (EDGAR_FETCHES.has(ch.fetch) && !EDGAR_FETCHES.has(newFetch)) {
                  patch.metric = null
                  showFlash(`已设 ${ch.name} → ${newFetch}，已清空 metric，请重新填写`)
                } else if (!EDGAR_FETCHES.has(ch.fetch) && EDGAR_FETCHES.has(newFetch)) {
                  patch.metric = null
                  showFlash(`已设 ${ch.name} → ${newFetch}，已清空 metric，请重新填写`)
                } else {
                  showFlash(`已设 ${ch.name} → ${newFetch}`)
                }
                await m.channelUpdate(ch.id, patch)
                await renderSources(mid)
              },
            },
              ...FETCH_OPTIONS.map((f) =>
                h('option', { value: f, selected: ch.fetch === f }, f),
              ),
            ),
            h('button', {
              class: 'btn',
              onclick: async () => { await m.channelUpdate(ch.id, { enabled: !ch.enabled }); await renderSources(mid) },
            }, ch.enabled ? '停用' : '启用'),
            h('button', {
              class: 'btn', style: { color: 'var(--red)' },
              onclick: async () => { await m.channelRemove(ch.id); showFlash('已删除通道'); await renderSources(mid) },
            }, '删除'),
          ),
        )),
      ),
    ) : h('section', { class: 'sect' },
      h('div', { class: 'sect-h' }, h('h2', {}, '通道列表')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'q' }, h('div', { class: 'q-body' },
          h('div', { class: 'q-text', style: { color: 'var(--text-3)' } }, '还没有通道。下面添加一个。'),
        )),
      ),
    ),

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
                const listBox = h('div', { style: { maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border, #e0e0e0)', borderRadius: '4px' } })
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
