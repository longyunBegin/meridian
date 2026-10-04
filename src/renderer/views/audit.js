import { h, clear } from '../lib/dom.js'
import { SCENARIO_LABELS } from '../../main/llmlog.js'

const m = window.meridian

// 归位忽略是用户选择，独立展示，不计入过滤裁决的分母。
const GATE_LABELS = { extract: '抽取阶段', source: '来源质量闸', dedup: '去重闸', user: '用户拒绝', routeIgnored: '归位提议忽略', other: '其他裁决' }
const REASON_LABELS = { 'off-topic': '离题', 'duplicate': '重复', 'low-quality': '低质', 'rejected': '用户拒绝' }
const percent = (rate) => `${(Number(rate) * 100).toFixed(1)}%`
const pct = (n, d) => d > 0 ? Math.round((n / d) * 100) : 0

/**
 * 系统健康（收纳与审计 · Phase 1）：
 * 过滤器误杀详情 + 入库漏斗 + LLM 成本。只读；不做通道归因；误杀口径只有一套。
 */
export async function renderHealth(mid) {
  clear(mid)
  const loading = h('p', { class: 'chain-note', role: 'status', 'aria-live': 'polite' }, '正在读取系统健康…')
  mid.append(h('div', { class: 'page audit-page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '系统健康'),
      h('p', {}, '过滤器、入库漏斗、LLM 成本——只读，不写。')),
    loading))

  const [auditRes, seriesRes, llmRes, calibRes] = await Promise.all([
    m.falseKill(30).catch(() => null),
    m.intakeSeries(30).catch(() => null),
    m.llmUsage().catch(() => null),
    m.filterCalibration().catch(() => null),
  ])
  if (!mid.isConnected) return
  clear(mid)

  const audit = normalizeAudit(auditRes)
  const series = Array.isArray(seriesRes) ? seriesRes.filter((row) => row && typeof row === 'object') : []
  const llm = llmRes && typeof llmRes === 'object' && !Array.isArray(llmRes) ? llmRes : { daily: [], recent: [] }
  const filterCalib = Array.isArray(calibRes) ? calibRes : []

  const agg = series.reduce((a, b) => ({
    captured: a.captured + (Number(b.captured) || 0),
    gatedIn: a.gatedIn + (Number(b.gatedIn) || 0),
    autoImported: a.autoImported + (Number(b.autoImported) || 0),
    toInbox: a.toInbox + (Number(b.toInbox) || 0),
    confirmed: a.confirmed + (Number(b.confirmed) || 0),
    rejected: a.rejected + (Number(b.rejected) || 0),
    undone: a.undone + (Number(b.undone) || 0),
    overridden: a.overridden + (Number(b.overridden) || 0),
    degraded: a.degraded + (Number(b.degraded) || 0),
  }), { captured: 0, gatedIn: 0, autoImported: 0, toInbox: 0, confirmed: 0, rejected: 0, undone: 0, overridden: 0, degraded: 0 })

  const llmDays = Array.isArray(llm.daily) ? llm.daily : []
  const todayKey = new Date().toISOString().slice(0, 10)
  const llmToday = llmDays.find((d) => d.date === todayKey) || { calls: 0, failed: 0, degraded: 0, tokens: 0, byScenario: {} }
  const llmTotal = llmDays.reduce((a, d) => ({
    calls: a.calls + (Number(d.calls) || 0),
    failed: a.failed + (Number(d.failed) || 0),
    degraded: a.degraded + (Number(d.degraded) || 0),
    tokens: a.tokens + (Number(d.tokens) || 0),
  }), { calls: 0, failed: 0, degraded: 0, tokens: 0 })
  const llmScenarios = Object.entries(llmToday.byScenario || {}).sort((a, b) => b[1] - a[1])
  const llmRecent = Array.isArray(llm.recent) ? llm.recent : []
  const calibTotal = filterCalib.reduce((s, b) => s + (Number(b.total) || 0), 0)

  const chName = (id) => id || '未知来源'
  const pending = audit.total - audit.missed
  const gateKeys = ['source', 'dedup', 'user']
  if (audit.byGate.other?.total) gateKeys.push('other')
  gateKeys.sort((x, y) => (audit.byGate[y].missed - audit.byGate[x].missed)
    || (audit.byGate[y].total - audit.byGate[x].total))

  const metric = (label, value, sub, warn) =>
    h('div', { class: 'fk-stat' },
      h('div', { class: 'fk-num' + (warn ? ' is-warn' : '') }, value),
      h('div', { class: 'fk-stat-label' }, label),
      h('div', { class: 'fk-stat-sub' }, sub))

  const rateMetric = (label, value, target, raw, denom, warn) => {
    const noData = !denom
    return h('div', { class: 'review-metric' },
      h('div', { class: 'review-metric-num', style: { color: noData ? 'var(--text-3)' : warn ? 'var(--orange)' : 'var(--accent)' } },
        noData ? '—' : `${value}%`),
      h('div', { class: 'review-metric-label' }, label),
      h('div', { class: 'review-metric-target' }, `目标 ${target}`),
      h('div', { class: 'review-metric-raw', style: { color: 'var(--text-3)' } }, raw))
  }

  const funnelRow = (label, n) =>
    h('div', { class: 'q-detail-row' },
      h('span', { class: 'q-detail-k' }, label),
      h('span', { class: 'q-detail-v' }, String(n)))

  const loadFailed = !auditRes || !Array.isArray(seriesRes) || !llmRes

  mid.append(h('div', { class: 'page audit-page' },
    h('div', { class: 'page-head' },
      h('h1', {}, '系统健康'),
      h('p', {}, '过滤器、入库漏斗、LLM 成本——只读，不写。')),

    loadFailed ? h('p', { class: 'cog-integrity is-error', role: 'alert' },
      '部分健康数据暂时读不到；下面只展示已拿到的部分，没有改写任何记录。') : null,

    // 一、过滤器（误杀）
    h('section', { class: 'sect u-stagger' },
      h('div', { class: 'sect-h' }, h('h2', {}, '过滤器'), h('em', {}, '30 天')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'fk-hero' },
          metric('筛掉总数', String(audit.total), '近 30 天过滤裁决'),
          metric('已确认误杀', String(audit.missed), `误杀率 ${percent(audit.rate)}`, audit.missed > 0),
          metric('待复核', String(pending), '尚未回填入图')),
        h('p', { class: 'fk-caliber' },
          '口径：误杀率 = 已确认误杀 ÷ 筛掉总数。"待复核"指尚未回填入图——可能是筛得对，也可能还没复核。'),
        audit.total === 0
          ? h('p', { class: 'fk-verdict' }, '近 30 天没有筛掉记录。')
          : audit.missed === 0
            ? h('p', { class: 'fk-verdict' }, '近 30 天没有已确认的误杀，各过滤规则暂无值得担心项。')
            : h('p', { class: 'fk-verdict' }, `有 ${audit.missed} 条已确认误杀，涉事闸门已排在前面。`),
        h('div', { class: 'fk-gates u-stagger' },
          ...gateKeys.map((key) => gateRow(key, audit.byGate[key], chName, false)),
          audit.byGate.routeIgnored?.total
            ? gateRow('routeIgnored', audit.byGate.routeIgnored, chName, true) : null),
        h('p', { class: 'fk-foot' }, `历史累计 ${audit.allTotal} 条裁决。归位忽略是用户选择，独立展示，不计入筛掉分母。`),
        audit.chainReview?.total ? h('section', { class: 'fk-chain-review' },
          h('h3', {}, `建设者里你驳回了 ${audit.chainReview.total} 条复核决定`),
          audit.chainReview.reversed
            ? h('p', { class: 'fk-caliber' }, `其中 ${audit.chainReview.reversed} 条后来被重新声明——按本页口径计入误杀。`)
            : h('p', { class: 'fk-caliber' }, '目前没有"驳回后又被重新声明"的，说明这些判断还没有被推翻。'),
          h('ul', { class: 'fk-chain-review-list' },
            ...audit.chainReview.items.slice(0, 20).map((row) => h('li', {},
              h('span', { class: 'fk-chain-review-kind' }, row.kind),
              h('span', { class: 'fk-chain-review-title' }, row.title),
              h('span', { class: 'fk-chain-review-theme' }, row.themeName || ''),
              row.reversed ? h('b', { class: 'fk-chain-review-flag' }, '已重新确认') : null,
              h('time', {}, String(row.at || '').slice(0, 10)))))) : null)),

    // 二、入库漏斗
    h('section', { class: 'sect u-stagger' },
      h('div', { class: 'sect-h' }, h('h2', {}, '入库漏斗'), h('em', {}, '30 天')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'review-funnel' },
          rateMetric('摩擦率', pct(agg.toInbox, agg.captured), '< 20%',
            `${agg.toInbox} / ${agg.captured}`, agg.captured, pct(agg.toInbox, agg.captured) > 20),
          rateMetric('撤销率', pct(agg.undone, agg.autoImported), '< 5%',
            `${agg.undone} / ${agg.autoImported}`, agg.autoImported, pct(agg.undone, agg.autoImported) > 5),
          rateMetric('归位修改率', pct(agg.overridden, agg.autoImported + agg.confirmed), '< 15%',
            `${agg.overridden} / ${agg.autoImported + agg.confirmed}`,
            agg.autoImported + agg.confirmed,
            pct(agg.overridden, agg.autoImported + agg.confirmed) > 15),
          rateMetric('降级率', pct(agg.degraded, agg.captured), '—',
            `${agg.degraded} / ${agg.captured}`, agg.captured, false)),
        h('div', { class: 'q-detail-body', style: { marginTop: '12px' } },
          funnelRow('捕获', agg.captured),
          funnelRow('过闸', agg.gatedIn),
          funnelRow('自动导入', agg.autoImported),
          funnelRow('进收件箱', agg.toInbox),
          funnelRow('确认', agg.confirmed),
          funnelRow('拒绝', agg.rejected),
          funnelRow('撤销', agg.undone),
          funnelRow('覆盖', agg.overridden),
          funnelRow('降级', agg.degraded)),
        series.length ? h('div', { class: 'review-daily', style: { marginTop: '12px' } },
          ...series.slice(-14).map((b) => h('div', { class: 'review-day' },
            h('span', { class: 'review-day-date', style: { color: 'var(--text-3)' } }, String(b.date || '').slice(5)),
            h('span', { class: 'review-day-bar' },
              h('i', { style: { width: `${pct(b.autoImported, b.captured)}%`, background: 'var(--accent)' } }),
              h('i', { style: { width: `${pct(b.toInbox, b.captured)}%`, background: 'var(--orange)' } })),
            h('span', { style: { fontSize: 'var(--t-caption)', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' } },
              String(b.captured || 0))))) : null)),

    // 三、过滤器校准
    h('section', { class: 'sect u-stagger' },
      h('div', { class: 'sect-h' }, h('h2', {}, '过滤器校准'), h('em', {}, calibTotal ? `${calibTotal} 条被筛` : '尚无数据')),
      h('div', { class: 'sect-b' },
        calibTotal
          ? h('div', { class: 'calib' }, ...filterCalib.map((b) => {
            const empty = !b.total
            return h('div', {},
              h('em', { style: { color: empty ? 'var(--text-3)' : '' } }, empty ? '—' : `${Math.round((b.accuracy || 0) * 100)}%`),
              h('i', { style: {
                height: `${(b.accuracy || 0) * 100}%`,
                background: empty ? 'var(--line)' : b.accuracy < 0.6 ? 'var(--orange)' : 'var(--accent)',
              } }),
              h('span', {}, `${Number(b.lo).toFixed(1)}–${Number(b.hi).toFixed(1)}`))
          }))
          : h('p', { class: 'fk-caliber' }, '尚无被筛掉的记录。有了数据之后，这里会显示各质量段的误杀率。'))),

    // 四、LLM 成本
    h('section', { class: 'sect u-stagger' },
      h('div', { class: 'sect-h' }, h('h2', {}, 'LLM 成本'), h('em', {}, '只读')),
      h('div', { class: 'sect-b' },
        h('div', { class: 'fk-hero' },
          metric('今日调用', String(llmToday.calls), `失败 ${llmToday.failed || 0} · 降级 ${llmToday.degraded || 0}`),
          metric('今日 Token', String(llmToday.tokens || 0), todayKey),
          metric('30 天调用', String(llmTotal.calls), `Token ${llmTotal.tokens}`)),
        llmScenarios.length
          ? h('div', { class: 'llm-scenarios' },
            ...llmScenarios.map(([scene, n]) => h('span', { class: 'badge' }, `${SCENARIO_LABELS[scene] || scene} ${n}`)))
          : h('p', { class: 'fk-caliber' }, '今天还没有调用模型。'),
        h('p', { class: 'llm-note' }, 'token 数取自响应的 usage；模型不返回时按 0 计。'),
        llmRecent.length ? h('details', { class: 'llm-failures' },
          h('summary', {}, `最近失败 · ${llmRecent.length} 条（上限 50）`),
          ...llmRecent.slice(0, 8).map((f) => h('div', { class: 'q' },
            h('div', { class: 'q-body' },
              h('div', { class: 'q-text', style: { fontSize: 'var(--t-body)' } },
                `${SCENARIO_LABELS[f.scenario] || f.scenario || '未知场景'} · ${f.error || '失败'}`),
              h('div', { class: 'q-meta' },
                h('span', {}, String(f.at || '').replace('T', ' ').slice(0, 16)),
                f.latency != null ? h('span', {}, `· ${f.latency} ms`) : null)))),
          llmRecent.length > 8
            ? h('div', { class: 'q-meta', style: { padding: '6px 0' } }, `还有 ${llmRecent.length - 8} 条未展开`)
            : null) : null)),
  ))
}

function emptyByGate() {
  return {
    source: { total: 0, missed: 0, items: [] },
    dedup: { total: 0, missed: 0, items: [] },
    user: { total: 0, missed: 0, items: [] },
    other: { total: 0, missed: 0, items: [] },
    routeIgnored: { total: 0, missed: 0, items: [] },
  }
}

function normalizeAudit(raw) {
  if (!raw || typeof raw !== 'object') return { total: 0, missed: 0, rate: 0, allTotal: 0, byGate: emptyByGate(), chainReview: null }
  const byGate = { ...emptyByGate(), ...(raw.byGate || {}) }
  for (const key of Object.keys(emptyByGate())) {
    const gate = byGate[key] || {}
    byGate[key] = {
      total: Number(gate.total) || 0,
      missed: Number(gate.missed) || 0,
      items: Array.isArray(gate.items) ? gate.items : [],
      label: gate.label,
      accuracy: gate.accuracy,
    }
  }
  return {
    total: Number(raw.total) || 0,
    missed: Number(raw.missed) || 0,
    rate: Number(raw.rate) || 0,
    allTotal: Number(raw.allTotal) || 0,
    byGate,
    chainReview: raw.chainReview && typeof raw.chainReview === 'object' ? raw.chainReview : null,
  }
}

/** 闸门行：可展开的轻量列表行。橙色只给"需处理"（有已确认误杀）。 */
function gateRow(key, group, chName, isRoute) {
  const g = group || { total: 0, missed: 0, items: [] }
  const pending = g.total - g.missed
  const warn = g.missed > 0
  const nums = isRoute
    ? `${g.total} 条 · 后来入图 ${g.missed} 条`
    : `筛掉 ${g.total} · 已确认误杀 ${g.missed} · 待复核 ${pending}`
  return h('details', { class: 'fk-gate', dataset: { gate: key } },
    h('summary', { class: 'fk-gate-head' },
      warn ? h('span', { class: 'fk-dot', title: '有已确认误杀，需关注' }) : null,
      h('span', { class: 'fk-gate-name' }, GATE_LABELS[key] || key),
      h('span', { class: 'fk-gate-nums' }, nums),
      h('span', { class: 'fk-chev' }, '›')),
    g.total
      ? h('div', { class: 'fk-recs' }, ...g.items.map((entry) => recordRow(entry, chName, isRoute)))
      : h('div', { class: 'fk-empty' }, '近 30 天没有记录。'),
  )
}

/** 单条裁决：标题行 + 展开后的定义列表。单层容器，无嵌套灰块。 */
function recordRow({ verdict, proposal, node }, chName, isRoute) {
  const record = proposal || verdict || {}
  const reason = isRoute ? '用户忽略归位建议' : REASON_LABELS[record.reason] || record.reason
  const at = isRoute ? record.ignoredAt : record.at
  const summary = isRoute ? record.title || record.text : record.summary
  const channel = isRoute ? record.originChannel : record.channelId
  const channelLabel = typeof channel === 'object' && channel
    ? channel.kind || channel.label || channel.url || chName(channel.id)
    : chName(channel)
  const filled = !!record.promotedTo
  const later = node
    ? `${node.title}（创建于 ${node.createdAt || '?'}）`
    : record.promotedTo ? `目标节点已不存在（${record.promotedTo}），保留回填记录` : '尚未回填'

  const row = (label, value) => value == null ? null : h('div', { class: 'fk-kv' },
    h('span', { class: 'fk-k' }, label),
    h('span', { class: 'fk-v' }, String(value)),
  )
  return h('details', { class: 'fk-rec' },
    h('summary', { class: 'fk-rec-head' },
      filled ? h('span', { class: 'fk-dot', title: '已确认误杀' }) : null,
      h('span', { class: 'fk-rec-title' }, node?.title || summary || '无摘要'),
      h('span', { class: 'fk-rec-meta' }, `${reason || '未标注'} · ${at || '日期未知'} · ${filled ? '已回填' : '尚未回填'}`),
    ),
    h('div', { class: 'fk-rec-body' },
      row('闸门', isRoute ? GATE_LABELS.routeIgnored : GATE_LABELS[record.gate] || record.gate),
      row('原因', reason),
      isRoute
        ? row('建议主题', record.matchedTheme?.name || record.matchedTheme?.title || record.matchedTheme?.id)
        : row('质量分', record.score),
      isRoute ? row('匹配分', record.bestScore) : record.choice ? row('来源', record.choice) : null,
      isRoute && record.matchedTags?.length
        ? row('匹配标签', record.matchedTags.map((t) => typeof t === 'string' ? t : t.name || t.text || t.id).join('、'))
        : null,
      channel ? row('通道', channelLabel) : null,
      summary ? row('摘要', summary) : null,
      row(isRoute ? '忽略于' : '筛掉于', at),
      row('后来成为', later),
      record.promotedAt ? row('回填于', record.promotedAt) : null,
    ),
  )
}
