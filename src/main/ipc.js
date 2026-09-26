const { ipcMain, shell, app, clipboard } = globalThis.__electron
import {
  load, addNode, updateNode, removeNode, restoreNode, purgeDead, repropagate, suggestParent, settleLemma, getNode,
  allThemes, addTheme, removeTheme, restoreTheme, renameTheme, deletedThemes, allNodes, rootNodes, childrenOf,
  settings, saveSettings, exportAll, importAll, SOURCE_QUALITY, COMMON_US_GAAP, dueSettlements,
  calibration, filterCalibration, falseKillAudit, propagationEvents, stats,
  addVerdict, allVerdicts, allConflicts, resolveConflict, promoteMatchingVerdicts,
  falseKillByChannel,
  sharedPremises, spawnFromScaffold, findSimilar, addConflict, addSource,
  appendRaw, getRaw, rawStats, pruneRaw, clearRaw, today,
  addTicker, removeTicker, nodesByTicker, allTickers,

  allInbox, ignoredInbox, addInboxItem, resolveInboxItem, clearInbox, setInboxExtraction, inboxCount,
  addIntakeEvent, getIntakeEvent, markIntakeUndone, markIntakeResolved, lastAutoIntakeEvent, intakeSeries,
  bestThemeContext,
  addTrace, allTraces, tracesByTarget, modelCalibration, labelerDivergence, llmUsage,
  traceIndexByHash, recordLabelAggregate, pruneInbox, lastInboxPrune, INBOX_TTL_DAYS,
  addReading, indicatorsForReading,
  getReading, readingsPage, readingEvidence, latestReadings, sourcesPage,
  assignReading, verifyReadingChain, exportIntent,
  updateTheme, kindToTags, sicToTags,
  addResearchNote, allResearchNotes, researchNotesByNode, researchHitRate, vsInstitution,
  matchTagLibrary, crossThemeMatch, recordTagHits, updateTagLibraryTag, deleteTagLibraryTags,
  uid, readingSnapshot,
} from './store.js'
import { extractLemmas, socraticQuestions, generateSkeleton, generateThemeTags, generateTagLibrary } from './extract.js'
import { labelSource, jevLabel } from './labeler.js'
import { tracked } from './llmlog.js'
import { genericFallback, instantiate } from './templates.js'

import { discoverTags } from './discover.js'
import { withOutbox } from './sync-outbox.js'
import { isUrl, inferChannel, fetchUrl } from './fetcher.js'
import { createHash } from 'node:crypto'
import { ingestReadings } from './reading-ingest.js'

function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function branchTitles(themeId, depth = 3) {
  const out = []
  const walk = (pid, d) => {
    if (d > depth) return
    for (const c of childrenOf(pid)) {
      if (c.kind !== 'branch') continue
      out.push(c.title)
      walk(c.id, d + 1)
    }
  }
  for (const r of rootNodes(themeId || '')) {
    out.push(r.title)
    walk(r.id, 1)
  }
  return out.slice(0, 60)
}

function pathOf(id) {
  const out = []
  let cur = allNodes().find((n) => n.id === id)
  while (cur) {
    out.unshift(cur.title)
    cur = cur.parentId ? allNodes().find((n) => n.id === cur.parentId) : null
  }
  return out.join(' / ')
}

// ============================================================
// 抽取前的免费过滤层
// 四层全免费：hash 是 O(1)，通道质量分是查表，findSimilar 和标签匹配都是内存遍历。
// 只有四层都过不了的才花钱调模型；拦下的内容一律有去处（收件箱或 verdict）。
// ============================================================

const LOW_QUALITY_GATE = 0.35 // 与现有闸门同值，不引入新阈值
const SIMILAR_DUPLICATE = 0.85 // 比抽完再合并的 0.6 严：宁可漏合，不可错合

/** 本主题标签库的最高匹配分。没命中返回 0；主题没词库返回 hasLibrary: false */
function targetTagScore(themeId, text) {
  const theme = allThemes().find((t) => t.id === themeId)
  if (!theme?.tagLibrary?.length) return { score: 0, hasLibrary: false, threshold: 0.6 }
  const top = matchTagLibrary(text, theme.tagLibrary)[0]
  if (!top) return { score: 0, hasLibrary: true, threshold: 0.6 }
  const tag = theme.tagLibrary.find((t) => t.id === top.tagId)
  return { score: top.score, hasLibrary: true, threshold: tag?.threshold ?? 0.6 }
}

/**
 * 命中过的内容查留痕：抽取成功的复用当次结果，被拦下的原样回到收件箱。
 * 两种都零 LLM 调用——这是同 hash 内容第二次进来不花钱的关键。
 */
function findReuse(h, themeId = null) {
  // 走 textHash 索引，不扫全量 traces——traces 只增不减，扫下去会线性恶化
  const t = traceIndexByHash().get(h)
  if (!t) return null
  if (t.stage === 'extract' && t.decision?.lemmas) {
    // 只复用同主题的抽取结果——别的主题的挂点在当前主题里是悬空的
    const traced = t.target?.themeId || null
    if (traced && themeId && traced !== themeId) return null
    return { kind: 'lemmas', lemmas: t.decision.lemmas, themeId: traced }
  }
  if (t.stage === 'gate' && t.decision?.skipped) {
    return { kind: 'skipped', skipped: t.decision.skipped, matchScore: t.decision.matchScore || 0 }
  }
  return null
}

/** 拦截留痕：让同 hash 的内容第二次进来时直接被 B1 拦下 */
function recordGateTrace({ h, text, skip, matchScore, channel }) {
  addTrace({
    target: { type: 'inbox', id: null },
    stage: 'gate',
    actor: { by: 'free-filter', model: null, promptVersion: 'v1' },
    input: { textHash: h, textLen: String(text || '').length, channelMeta: channel || null },
    output: { skipped: skip, matchScore },
    decision: { skipped: skip, matchScore },
    reason: `免费过滤层拦下：${skip}`,
  })
}

/**
 * 四层免费过滤。返回 { action }：
 *   'reuse'  → 命中留痕，零调用
 *   'skip'   → 不值得花钱，内容进收件箱
 *   'dup'    → 同一 claim 已有来源，直接加源
 *   'extract'→ 四层都过，可以抽了
 */
function captureGate({ text, h, themeId, label }) {
  const seen = findReuse(h, themeId)
  // 只复用真正抽取过的留痕（kind 'lemmas'）：被免费层拦下的 'skipped' 留痕
  // 没有 lemmas 可复用，掉下去重走闸门（大概率再次拦下，零 LLM 调用）。
  // 之前这里把 'skipped' 也当复用返回，导致 processCapture 读到
  // gate.seen.lemmas === undefined，在 ex.lemmas.length 抛 TypeError。
  if (seen?.kind === 'lemmas') return { action: 'reuse', seen }

  // B2 · 通道元数据已经告诉我们这是低质源，抽它干什么
  if (label.via === 'channel' && label.quality < LOW_QUALITY_GATE) {
    return { action: 'skip', skip: 'low-quality', matchScore: 0 }
  }

  // B3 · 文本级预判：高相似度直接并源，不抽
  const dup = findSimilar(text, themeId)[0]
  if (dup && dup.score >= SIMILAR_DUPLICATE) {
    return { action: 'dup', dup }
  }

  // B4 · 标签库分级：只有 score >= threshold 才为它花钱
  const { score, hasLibrary, threshold } = targetTagScore(themeId, text)
  if (hasLibrary) {
    if (score <= 0) return { action: 'skip', skip: 'no-tags', matchScore: 0 }
    if (score < threshold) return { action: 'skip', skip: 'weak-tags', matchScore: score }
  }
  // 词库为空的主题全部放行：没有声明过关心什么，就不该替用户过滤

  return { action: 'extract', matchScore: score }
}

/**
 * 命题分流：去重 → 归位 → 冲突检测 → 被筛掉的留裁决。
 * 复用重建的捕获结果也走这里，保证和首次抽取同一套判定。
 */
function routeLemmas({ lemmas, themeId, label, channelId, textHash = null }) {
  const rejected = []
  const out = []
  let noulMaxScore = 0

  const noulCompared = themeId
    ? allNodes().filter((n) => n.themeId === themeId && n.kind === 'lemma' && n.status !== 'dead').length
    : 0

  for (const l of lemmas) {
    // 1) 去重：同一条 claim 已有独立来源 → 不新建，只 +1 源
    const dup = findSimilar([l.title, l.parentHint].filter(Boolean).join(' '), themeId)[0]
    if (dup) {
      if (dup.score > noulMaxScore) noulMaxScore = dup.score
      out.push({
        ...l,
        action: 'merge',
        mergeInto: dup.node.id,
        mergeScore: dup.score,
        parentId: dup.node.parentId,
        parentLabel: pathOf(dup.node.id),
      })
      continue
    }

    // 2) 归位
    const cands = suggestParent([l.title, l.parentHint].filter(Boolean).join(' '), themeId)
      .map((r) => ({ id: r.node.id, title: r.node.title, path: pathOf(r.node.id) }))
    const top = cands[0]

    // 3) 冲突检测（落在既有节点上才查得到）
    const conflicts = top
      ? findConflictsIn(top.id).map((c) => ({ id: c.node.id, title: c.node.title, reason: c.reason }))
      : []

    out.push({
      ...l,
      action: 'new',
      parentId: top?.id || null,
      parentLabel: top?.path || '',
      candidates: cands,
      conflicts,
    })
  }

  // 4) 分拣记录：被筛掉的只留判断，不留原文
  for (const l of lemmas) {
    const dup = findSimilar(l.title, themeId)[0]
    if (dup && dup.score >= 0.6) {
      const v = addVerdict({
        gate: 'dedup', reason: 'duplicate', summary: l.title,
        score: label.quality, choice: label.kind, themeId,
        ...(channelId ? { channelId } : {}),
        ...(textHash ? { textHash } : {}),
      })
      rejected.push({ id: v.id, summary: l.title, why: `重复 · 已有 ${dup.node.sources.length} 个独立源` })
      continue
    }
    if (label.quality < LOW_QUALITY_GATE && l.confidence < 45) {
      const v = addVerdict({
        gate: 'source', reason: 'low-quality', summary: l.title,
        score: label.quality, choice: label.kind, themeId,
        ...(channelId ? { channelId } : {}),
        ...(textHash ? { textHash } : {}),
      })
      rejected.push({ id: v.id, summary: l.title, why: `低质 · ${label.kind} Score ${label.quality}` })
    }
  }

  return { out, rejected, noulMaxScore, noulCompared }
}

/**
 * 捕获流水线：免费过滤 → 打标 → 抽取 → 去重 → 冲突检测 → 分拣
 * 每一步失败都单独降级，不让整条链路断掉。
 */
async function processCapture(text, themeId, channelMeta, { forceExtract = false } = {}) {
  const s = settings()
  // URL 抓取：粘贴 URL 时自动抓取网页正文，推断通道元数据
  let actualText = text
  let actualChannel = channelMeta
  let fromUrl = null
  if (isUrl(text)) {
    fromUrl = text
    const ch = inferChannel(text)
    if (ch) {
      actualChannel = channelMeta
        ? { ...channelMeta, url: text, platform: ch.platform || channelMeta.platform }
        : ch
    }
    const fetched = await fetchUrl(text).catch(() => null)
    if (fetched && fetched.length > 50) {
      actualText = fetched
      actualChannel = { ...actualChannel, fetchedAt: new Date().toISOString() }
    }
  }

  // 打标大多走免费层（通道元数据 / 表 / 关键词）；只有配了 jev 或 llm 才真的花钱
  const label = await tracked(
    'label',
    () => labelSource(settings(), actualText, actualChannel),
    { themeId },
  )

  const h = hashText(actualText)
  // forceExtract（用户主动点「抽取这 N 条」）越过闸门，但不重复付钱：
  // 同主题同 hash 已经抽过的，直接复用那次结果。
  const seen = forceExtract ? findReuse(h, themeId) : null
  const gate = forceExtract
    ? (seen?.kind === 'lemmas'
        ? { action: 'reuse', seen }
        : { action: 'extract', matchScore: targetTagScore(themeId, actualText).score })
    : captureGate({ text: actualText, h, themeId, label })

  if (gate.action === 'skip') {
    recordGateTrace({ h, text: actualText, skip: gate.skip, matchScore: gate.matchScore, channel: actualChannel })
    return {
      ok: true,
      skipped: gate.skip,
      extracted: false,
      matchScore: gate.matchScore || 0,
      label,
      lemmas: [],
      rejected: [],
      resolvedText: actualText,
      resolvedChannel: actualChannel,
      fromUrl,
      routeProposals: [],
    }
  }

  if (gate.action === 'dup') {
    // 合成一条命题直接走分流：该加的来源会加上，该记的 verdict 也会记
    const { out, rejected, noulMaxScore, noulCompared } = routeLemmas({
      lemmas: [{ title: gate.dup.node.title, type: gate.dup.node.type || 'observation', confidence: gate.dup.node.confidence ?? 50 }],
      themeId, label, channelId: channelMeta?.channelId || null, textHash: h,
    })
    return {
      ok: true,
      skipped: 'duplicate',
      // 不是「未匹配」：命题已经有了，这里只是多一个来源。留可勾选状态让用户确认合并。
      extracted: true,
      matchScore: gate.dup.score,
      mergedInto: gate.dup.node.id,
      label,
      lemmas: out,
      rejected,
      noulCompared,
      noulMaxScore: Math.round(noulMaxScore * 100) / 100,
      resolvedText: actualText,
      resolvedChannel: actualChannel,
      fromUrl,
      routeProposals: [],
    }
  }

  // 标签库跨主题匹配
  const tagMatches = crossThemeMatch(actualText)
  const routeProposals = []
  for (const m of tagMatches) {
    const tag = allThemes().find((t) => t.id === m.themeId)?.tagLibrary?.find((t) => t.id === m.tagId)
    const threshold = tag?.threshold ?? 0.6
    if (m.score >= threshold && m.themeId !== themeId) {
      routeProposals.push({
        type: 'route-proposal',
        text: actualText,
        matchedTheme: { id: m.themeId, name: m.themeName },
        matchedTags: [{ name: m.name, score: m.score, tagId: m.tagId }],
        bestScore: m.score,
        originChannel: actualChannel || null,
        at: today(),
      })
      recordTagHits(m.themeId, [m.tagId])
    }
  }

  // 留痕：打标阶段。只被 labelerDivergence 消费（按 kind 的条数和分差均值），
  // 所以按天聚合成计数，不逐条存——逐条存时 3175 条里 1556 条 label 占了 2MB。
  recordLabelAggregate({
    kind: label.kind,
    tableQuality: label.quality,
    modelQuality: label.jevScore,
  })

  const hints = branchTitles(themeId)
  const reused = gate.action === 'reuse'
  const ex = reused
    ? { ok: true, lemmas: gate.seen.lemmas, reused: true }
    : await tracked(
        'extract',
        () => extractLemmas(settings(), actualText, hints),
        { themeId, channelId: channelMeta?.channelId || null },
      )

  // 留痕：抽取阶段
  addTrace({
    target: { type: 'inbox', id: null, themeId },
    stage: 'extract',
    actor: { by: reused ? 'reuse' : (ex.ok ? 'model' : 'table'), model: s.model || null, promptVersion: 'v1' },
    // input 只留 findReuse 要用的 textHash。textLen 没有任何消费者，
    // channelMeta 在 inbox 条目的 provenance 里已有——各砍掉能省约 30% 体积。
    input: { textHash: h },
    output: ex.ok ? { lemmas: ex.lemmas, model: ex.model || null, reused } : { error: ex.reason || 'no-key' },
    decision: ex.ok ? { lemmas: ex.lemmas } : { degraded: true },
    reason: reused ? '同 hash 内容复用上次抽取结果，零调用'
      : (ex.ok ? null : '无 API key 或抽取失败，降级为单条 observation'),
  })

  const lemmas = ex.ok && ex.lemmas.length ? ex.lemmas : [{
    title: firstSentence(actualText),
    type: 'observation',
    confidence: 50,
    parentHint: null,
    tags: [],
    sourceKind: label.kind,
  }]
  const degraded = !ex.ok

  const { out, rejected, noulMaxScore, noulCompared } = routeLemmas({
    lemmas, themeId, label, channelId: channelMeta?.channelId || null, textHash: h,
  })
  const extracted = true

  return {
    ok: true,
    degraded,
    extracted,
    matchScore: gate.matchScore || 0,
    reused,
    label: {
      kind: label.kind,
      quality: label.quality,
      via: label.via,
      jevScore: label.jevScore ?? null,
      noul: label.noul ?? null,

    },
    lemmas: out,
    rejected,
    noulCompared,
    noulMaxScore: Math.round(noulMaxScore * 100) / 100,
    resolvedText: actualText,
    resolvedChannel: actualChannel,
    fromUrl,
    routeProposals,
  }
}

/**
 * 不确定性闸门：任一条件不满足就退回收件箱等人裁决。
 * 顺利通过闸门的信息自动入库，收件箱只留真正需要判断的少数。
 */
function gateCheck(result) {
  const reasons = []
  if (result.label.quality < 0.4) reasons.push('low-quality')
  if (result.noulMaxScore >= 0.6 && result.noulMaxScore <= 0.85) reasons.push('dedup-gray')
  for (const l of result.lemmas) {
    if (l.action === 'new' && !l.parentId) reasons.push('no-parent')
    if (l.conflicts?.length > 0) reasons.push('conflict')
  }
  return { pass: reasons.length === 0, reasons }
}

/** 自动归位入库：通过闸门的信息直接进图谱，by:'source' 标记为搬运品 */
function autoImport(result, themeId, gateReasons, batchId, intakeId) {
  const raw = result.resolvedText
    ? appendRaw({ kind: result.label.kind || '独立媒体', label: result.fromUrl || result.resolvedChannel?.url || result.resolvedChannel?.platform || `手工粘贴 · ${today()}`, text: result.resolvedText, channel: result.resolvedChannel || null })
    : { id: null }

  const sourceQuality = result.label.quality ?? 0.5
  const derivedConfidence = Math.round(sourceQuality * 100)

  const imported = []
  for (const l of result.lemmas) {
    if (l.action === 'merge' && l.mergeInto) {
      addSource(l.mergeInto, {
        kind: l.sourceKind || result.label.kind || '独立媒体',
        label: l.label || result.label.kind || '未注明',
        at: today(), rawId: raw.id,
        ...(result.resolvedChannel?.platform ? { platform: result.resolvedChannel.platform } : {}),
        ...(result.resolvedChannel?.url ? { url: result.resolvedChannel.url } : {}),
        ...(result.resolvedChannel?.fetchedAt ? { fetchedAt: result.resolvedChannel.fetchedAt } : {}),
      })
      imported.push({ title: l.title, action: 'merge', id: l.mergeInto })
      continue
    }
    const node = addNode({
      themeId, parentId: l.parentId || null, kind: 'lemma',
      title: l.title, type: l.type,
      confidence: derivedConfidence,
      tags: l.tags || [],
      sources: [{
        kind: l.sourceKind || result.label.kind || '独立媒体',
        label: l.label || result.label.kind || '未注明',
        at: today(), rawId: raw.id,
        ...(result.resolvedChannel?.platform ? { platform: result.resolvedChannel.platform } : {}),
        ...(result.resolvedChannel?.url ? { url: result.resolvedChannel.url } : {}),
        ...(result.resolvedChannel?.fetchedAt ? { fetchedAt: result.resolvedChannel.fetchedAt } : {}),
      }],
      settlement: l.settlement || null,
      by: 'source',
      intakeId,
    })
    for (const c of l.conflicts || []) addConflict(node.id, c.id, c.reason)
    promoteMatchingVerdicts(l.title, node.id, themeId)
    // route trace：记录闸门自动归位的建议值和最终值
    addTrace({
      target: { type: 'node', id: node.id },
      stage: 'route',
      actor: { by: 'gate', model: null, promptVersion: 'v1' },
      input: { textHash: hashText(result.resolvedText || ''), suggestedParentId: l.parentId || null, suggestedConfidence: derivedConfidence },
      output: { parentId: l.parentId || null, confidence: derivedConfidence },
      decision: { parentId: node.parentId, confidence: node.confidence },
      reason: `gate-pass${gateReasons?.length ? ':' + gateReasons.join(',') : ''}`,
    })
    imported.push({ title: l.title, action: 'new', id: node.id })
  }
  return { imported, rawId: raw.id }
}


/** 降级路径的标题：取第一句，别把整段原文塞进标题栏 */
function firstSentence(text) {
  const raw = String(text).trim()
  // 只按中文句号和换行切——按 ASCII 句点切会把「1.6T」切成「1.」
  const head = raw.split(/(?<=[。！？；\n])/)[0] || raw
  return head.slice(0, 80)
}

/** 在某父节点下查方向相反的兄弟命题 */
function findConflictsIn(parentId) {
  const kids = childrenOf(parentId).filter((n) => n.kind === 'lemma' && n.status !== 'dead')
  const neg = /(不会|未能|低于|下跌|下降|推迟|不及|放缓|停滞|失败|压制)/
  const pos = /(超|上调|增长|上升|突破|提前|加速|放量|创新高)/
  const out = []
  for (const a of kids) {
    for (const b of kids) {
      if (a.id >= b.id) continue
      const shared = tokenOverlap(a.title, b.title)
      if (!shared) continue
      const flip = (neg.test(a.title) && pos.test(b.title)) || (pos.test(a.title) && neg.test(b.title))
      if (flip) out.push({ node: b, reason: '方向相反' })
    }
  }
  return out
}

function tokenOverlap(a, b) {
  const tk = (s) => new Set((s.match(/[一-龥]{2,}/g) || []).flatMap((x) => x.split(/(?=[上中下游内])/)))
  const A = tk(a)
  const B = tk(b)
  for (const t of A) if (t.length >= 2 && B.has(t)) return true
  return false
}

// ---------------------------------------------------------------- ipc

/**
 * 窗口相关的东西由 main.js 注入，不在这里 import。
 */
function register({ getMainWindow, getAgentConnection = () => ({ available: false }), enableOutbox = false }) {
  // 反向同步 outbox：只在 Mac 真实 App 显式开启（main.js 传 enableOutbox: true）。
  // service（shim）与测试默认关闭。用局部变量遮蔽模块顶层的 ipcMain，
  // 下面全部 ipcMain.handle 调用零改动，白名单 channel 自动被包装记录。
  const ipcMain = enableOutbox ? withOutbox(globalThis.__electron.ipcMain) : globalThis.__electron.ipcMain
  ipcMain.handle('db:stats', () => stats())
  // 反向同步快照导出：VM 桥用它拿 readingSnapshot()（persist 写盘的同一形状），推给 Mac。
  // 只读，不进 outbox 白名单。
  ipcMain.handle('sync:snapshot', () => readingSnapshot())
  ipcMain.handle('db:nodes', (_, themeId) => allNodes().filter((n) => n.themeId === themeId))
  ipcMain.handle('db:allNodes', () => allNodes())
  ipcMain.handle('db:getNode', (_, id) => getNode(id))
  ipcMain.handle('db:due', () => dueSettlements())
  ipcMain.handle('db:calibration', () => calibration())
  ipcMain.handle('db:filterCalibration', () => filterCalibration())
  ipcMain.handle('db:falseKill', (_, days) => falseKillAudit(days))
  ipcMain.handle('db:falseKillByChannel', (_, days) => falseKillByChannel(days))
  ipcMain.handle('db:events', () => propagationEvents(14).slice(0, 40))
  ipcMain.handle('db:conflicts', () => allConflicts().filter((c) => !c.resolved))
  ipcMain.handle('db:resolveConflict', (_, id, verdict) => {
    if (!['a', 'b', 'both'].includes(verdict)) return { ok: false, error: '请选择有效的裁决' }
    const result = resolveConflict(id, verdict)
    if (result) getMainWindow?.()?.webContents.send('db:changed')
    return result
  })
  ipcMain.handle('db:verdicts', () => allVerdicts())
  ipcMain.handle('db:premises', () => sharedPremises())
  ipcMain.handle('db:spawn', (_, branchId) => spawnFromScaffold(branchId))
  ipcMain.handle('db:suggestParent', (_, text, themeId) => suggestParent(text, themeId))

  ipcMain.handle('db:addNode', (_, input) => addNode(input))
  ipcMain.handle('db:updateNode', (_, id, patch) => updateNode(id, patch))
  ipcMain.handle('db:removeNode', (_, id) => removeNode(id))
  ipcMain.handle('db:restoreNode', (_, id) => restoreNode(id))
  ipcMain.handle('db:purgeDead', (_, scope, opts) => purgeDead(scope, opts))
  ipcMain.handle('db:repropagate', (_, id) => repropagate(id))
  ipcMain.handle('db:settle', (_, id, correct) => settleLemma(id, correct))
  ipcMain.handle('db:addSource', (_, id, source) => addSource(id, source))

  ipcMain.handle('theme:all', () => allThemes())
  ipcMain.handle('theme:deleted', () => deletedThemes())
  ipcMain.handle('theme:add', (_, name) => addTheme(name))
  ipcMain.handle('theme:remove', (_, id) => removeTheme(id))
  ipcMain.handle('theme:restore', (_, id) => restoreTheme(id))
  ipcMain.handle('theme:rename', (_, id, name) => renameTheme(id, name))
  ipcMain.handle('theme:update', (_, id, patch) => updateTheme(id, patch))
  ipcMain.handle('theme:tagLibrary:updateTag', (_, themeId, tagId, patch) => updateTagLibraryTag(themeId, tagId, patch))
  ipcMain.handle('theme:tagLibrary:deleteTags', (_, themeId, tagIds) => deleteTagLibraryTags(themeId, tagIds))

  /** 正在铺骨架的 themeId。渲染层据此显示「生成中」而不是再给一个生成按钮——
   *  曾经建主题后立刻切到脉络页，那一刻节点还没落，界面照常给出「这个主题还没有骨架」
   *  和生成按钮，用户点了就触发第二次 scaffoldTheme：两次 LLM 调用、一次白失败，
   *  还弹一个「骨架没生成」的假警报（树其实是第一次铺好的）。 */
  const scaffolding = new Set()
  /** themeId → 最后一次铺设结果。推送事件会丢（窗口没起来、渲染层还没订阅），
   *  创建页因此不能只靠事件——留一份可查的结果，让它轮询兜底。 */
  const scaffoldResults = new Map()

  async function scaffoldTheme(themeId, description, s) {
    if (scaffolding.has(themeId)) return { degraded: false, skipped: 'in-flight' }
    scaffolding.add(themeId)
    // 新一轮开始，上一轮的结果作废——否则轮询可能在新一轮还没结束时读到旧结果并提前 settle
    scaffoldResults.delete(themeId)
    try {
      const result = await runScaffold(themeId, description, s)
      scaffoldResults.set(themeId, result)
      // 只留最近 20 个主题的结果，别让这张表跟着主题数无限长
      if (scaffoldResults.size > 20) scaffoldResults.delete(scaffoldResults.keys().next().value)
      return result
    } finally {
      scaffolding.delete(themeId)
    }
  }

  async function runScaffold(themeId, description, s) {
      // 幂等：骨架铺过就不再重铺。兜底模板没有去重，连点几次「生成」
      // 就会 instantiate 好几遍——实测同一个主题下摞了三套上中下游。
      // theme:regenerate 是先删后建，走到底下时已经是空树，不受这里挡。
      // 但标签库缺了仍然要补：它是归位的依据，缺了读数匹配不上指标节点。
      // 曾经这里只要看到环节就整体返回，结果「环节已有、标签库为空」的主题
      // 永远补不上标签库——用户点多少次生成都没用。
      const hasBranches = allNodes().some((n) => n.themeId === themeId && n.kind === 'branch')
      const hasTagLibrary = (allThemes().find((t) => t.id === themeId)?.tagLibrary || []).length > 0
      if (hasBranches && hasTagLibrary) {
        return {
          degraded: false, skipped: 'complete',
          hasKey: !!s.apiKey,
          skeletonOk: true, skeletonReason: null, skeletonFallback: false,
          themeTagsOk: true, themeTagsReason: null,
          tagLibraryOk: true, tagLibraryReason: null, tagLibraryCount: 1,
        }
      }

      // 分阶段进度：骨架一次 LLM 最长 90s，三个阶段串下来用户要等两分多钟。
      // 没有进度就只有一句「生成中」，用户只能干等——每阶段起止都推一个事件，
      // 创建页据此点亮步骤。事件丢了也不怕，settle 时按结果一次性校准。
      const emitStage = (stage, state, extra = {}) => {
        getMainWindow?.()?.webContents.send('theme:scaffoldProgress', { themeId, stage, state, ...extra })
      }

      emitStage('skeleton', 'start')
      emitStage('tags', 'start')
      const [skeletonResult, tagResult] = await Promise.all([
        tracked('skeleton', () => generateSkeleton(s, description), { themeId }),
        tracked('themeTags', () => generateThemeTags(s, description), { themeId }),
      ])
      emitStage('skeleton', skeletonResult.ok ? 'ok' : 'fail', { reason: skeletonResult.reason })
      emitStage('tags', tagResult.ok ? 'ok' : 'fail', { reason: tagResult.reason })

      if (hasBranches) {
        // 这一轮只补标签库，骨架、指标节点都不重铺
      } else if (skeletonResult.ok) {
        const walk = (node, parentId) => {
          const n = addNode({
            themeId, parentId, kind: 'branch', title: node.title,
            propagation: node.propagation || 0.6, by: 'model',
            stableId: node.id, scaffold: node.scaffold || null,
          })
          for (const c of node.children || []) walk(c, n.id)
        }
        for (const root of skeletonResult.skeleton.roots || []) walk(root, null)
      } else if (!s.apiKey) {
        // 只有完全没有 key 时才用兜底模板——那是唯一还能给出结构的情形。
        // key 在却失败了（超时 / 解析不出来）就留空：铺一套上中下游上去，
        // 用户会以为模型分析过了，只是水平差。留空 + 明说失败，比假的通用骨架诚实。
        const fallback = genericFallback()
        if (fallback) instantiate(fallback, (spec) => addNode({ ...spec, themeId }))
      }
      // 兜底模板不是模型生成的——UI 上要诚实标注，不能显示成「模型搭好了」
      const skeletonFallback = !hasBranches && !skeletonResult.ok && !s.apiKey

      if (!hasBranches) for (const branch of allNodes().filter((n) => n.themeId === themeId && n.kind === 'branch' && n.status !== 'dead')) {
        for (const spec of branch.scaffold?.indicators || []) {
          const name = typeof spec === 'string' ? spec : spec.name
          if (!name || allNodes().some((n) => n.themeId === themeId && n.parentId === branch.id && n.title === name && n.status !== 'dead')) continue
          addNode({
            themeId, parentId: branch.id, title: name, type: 'observation', by: 'model',
            cadence: spec.cadence || '季度',
          })
        }
      }

      if (tagResult.ok && tagResult.tags.length) updateTheme(themeId, { tags: tagResult.tags })
      const titles = allNodes().filter((n) => n.themeId === themeId && n.kind === 'branch').map((n) => n.title)
      emitStage('library', 'start')
      const tagLibraryResult = await tracked('tagLibrary', () => generateTagLibrary(s, description, titles), { themeId })
      emitStage('library', tagLibraryResult.ok ? 'ok' : 'fail', { reason: tagLibraryResult.reason })
      const tagLibraryCount = tagLibraryResult.ok
        ? (updateTheme(themeId, { tagLibrary: tagLibraryResult.tagLibrary }), tagLibraryResult.tagLibrary.length)
        : 0

      // degraded 必须按「结束时树上到底有没有环节」判，不能按进入时的 hasBranches 快照。
      // 并发的另一次铺设可能已经把树铺好了，此时报「骨架没生成」是在说谎——
      // 用户明明看见树上有一堆环节。实测踩过：两次调用并发，第二次失败，
      // 弹了假警报，而树是第一轮的成果。
      const treeExists = allNodes().some((n) => n.themeId === themeId && n.kind === 'branch')
      return {
        degraded: !treeExists && !skeletonResult.ok,
        // 树没生成和 key 没配是两件事，用户该知道是哪件
        reason: treeExists || skeletonResult.ok ? null : (skeletonResult.reason || 'unknown'),
        hasKey: !!s.apiKey,
        skeletonOk: !!skeletonResult.ok,
        skeletonReason: skeletonResult.ok ? null : (skeletonResult.reason || 'unknown'),
        skeletonFallback,
        // 主题标签以前是静默的：失败了只表现为 tags 为空，用户无从判断是模型没给还是没跑。
        // 部分失败（骨架成了、标签没成）要能分别展示、分别重试。
        themeTagsOk: !!tagResult.ok,
        themeTagsReason: tagResult.ok ? null : (tagResult.reason || 'unknown'),
        // 标签库失败以前是静默的——骨架成功就报「已生成」，用户只看到标签库是 0，无从判断
        tagLibraryOk: !!tagLibraryResult.ok,
        tagLibraryReason: tagLibraryResult.ok ? null : (tagLibraryResult.reason || 'unknown'),
        tagLibraryCount,
        skipped: treeExists && hasBranches ? 'tag-library-only' : null,
      }
  }

  ipcMain.handle('theme:scaffoldResult', (_, themeId) => scaffoldResults.get(themeId) || null)
  // 轮询兜底的另一半：渲染层先问「还在铺吗」，不铺了再取 scaffoldResult。
  // 曾经只暴露了取结果、没暴露查状态，pollScaffold 每次都抛 No handler registered、
  // 被 catch 吞掉——推送事件一丢，用户就永远卡在「骨架生成中」。
  ipcMain.handle('theme:scaffoldStatus', () => [...scaffolding])

  // 建主题分两步：主题立即建好返回（UI 不必卡住），骨架异步铺。
  // 铺完由 db:changed 通知渲染层刷新——用户在等的时候还能看别的东西。
  ipcMain.handle('theme:setupNew', async (_, description) => {
    const theme = addTheme(description)
    scaffoldTheme(theme.id, description, settings())
      .then((result) => {
        getMainWindow?.()?.webContents.send('theme:scaffolded', { themeId: theme.id, ...result })
      })
      .catch(() => {})
    return { ...theme, degraded: !settings().apiKey }
  })

  // 重新生成骨架：删掉原有的，再走一次 scaffoldTheme。
  // 破坏性操作——UI 必须先提示「将删除原有环节和命题」。
  ipcMain.handle('theme:regenerate', async (_, themeId) => {
    const theme = allThemes().find((t) => t.id === themeId)
    if (!theme) return { ok: false, error: 'not-found' }
    // 删旧：整棵环节树 + 标签库
    for (const n of allNodes().filter((n) => n.themeId === themeId)) removeNode(n.id)
    updateTheme(themeId, { tags: [], tagLibrary: [] })
    scaffoldTheme(themeId, theme.name, settings())
      .then((result) => {
        getMainWindow?.()?.webContents.send('theme:scaffolded', { themeId, ...result })
      })
      .catch(() => {})
    return { ok: true }
  })

  // 空白主题补生成骨架 + 标签库（E3）
  // 给已有主题补骨架。同样是异步——UI 立即返回，铺完由 theme:scaffolded 通知
  ipcMain.handle('theme:scaffoldExisting', async (_, themeId, description) => {
    scaffoldTheme(themeId, description, settings())
      .then((result) => {
        getMainWindow?.()?.webContents.send('theme:scaffolded', { themeId, ...result })
      })
      .catch(() => {})
    return { ok: true, async: true }
  })

  ipcMain.handle('settings:get', () => ({ ...settings(), sourceQuality: SOURCE_QUALITY }))
  ipcMain.handle('settings:set', (_, patch) => saveSettings(patch))
  // 试标：不落库，只为在捕获之前验证打标器通不通、规则命中得对不对
  ipcMain.handle('label:test', (_, text) => labelSource(settings(), text))
  // Jev 连通性测试：往 baseUrl 本体 POST 一个最小原生请求，一次验证三件事——
  // 通不通（HTTP 200）、key 对不对（401 就挂）、模型有没有（看返回的 model）。
  // 不写账本、不记用量——测试是测试，数据是数据。
  ipcMain.handle('jev:test', async () => {
    const s = settings()
    if (!s.jevKey) return { ok: false, reason: 'no-key' }
    if (!s.jevBaseUrl) return { ok: false, reason: 'no-endpoint' }
    const t0 = Date.now()
    try {
      const res = await fetch(s.jevBaseUrl.replace(/\/$/, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.jevKey}` },
        body: JSON.stringify({
          model: s.jevModel,
          state: 'ping',
          questions: { ok: { type: 'noul', criteria: { true: '是', false: '否' } } },
        }),
        signal: AbortSignal.timeout(20000),
      })
      const latency = Date.now() - t0
      if (!res.ok) {
        // 401 是 Jev 配置里最常见的坑：key 填了但服务端不认。单独拎出来说人话。
        if (res.status === 401) return { ok: false, reason: 'bad-key', latency }
        if (res.status === 422) return { ok: false, reason: 'bad-question', latency }
        if (res.status === 404) return { ok: false, reason: 'bad-model', model: s.jevModel, latency }
        return { ok: false, reason: `HTTP ${res.status}`, latency }
      }
      const body = await res.json().catch(() => null)
      const ans = body?.answers?.ok
      if (ans?.type === 'noul' && Number.isFinite(Number(ans.noul))) {
        // model 是服务端解析后的真实版本（如 jev-latest → jev-1.13.0）
        return { ok: true, model: body?.model || s.jevModel, latency, noul: Number(ans.noul) }
      }
      return { ok: false, reason: 'empty', latency }
    } catch (e) {
      return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : 'network', latency: Date.now() - t0 }
    }
  })
  // Jev 打标测试：强制走 Jev 路径（不静默降级查表），只返回结果、不写账本。
  // jevLabel 自带 20s 超时，这里的竞速只是双保险。
  ipcMain.handle('jev:labelTest', async (_, text) => {
    const t = String(text || '').slice(0, 3000)
    if (!t.trim()) return { ok: false, why: 'empty-input' }
    const p = jevLabel(settings(), t)
    p.catch(() => {}) // 竞速超时后原请求仍在后台，吞掉它的 rejection
    try {
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
      ])
    } catch (e) {
      return { ok: false, why: e.message === 'timeout' ? 'timeout' : 'network' }
    }
  })
  // LLM 连通性测试：打一次最小请求，验证 key / 端点 / 模型三件事。
  // max_tokens 必须给足：推理模型（step-3 / o 系列）会把预算全花在 reasoning 上，
  // content 回来是空串、finish_reason 是 length。16 实测不够，512 起。
  ipcMain.handle('llm:test', async () => {
    const s = settings()
    if (!s.apiKey) return { ok: false, reason: 'no-key' }
    const t0 = Date.now()
    try {
      const res = await fetch(`${s.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify({
          model: s.model,
          max_tokens: 512,
          messages: [{ role: 'user', content: '回复「连通」两个字' }],
        }),
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) {
        // 模型 ID 写错是最常见也最难自查的失败——服务端只回 404 + 一句英文，
        // 用户看到「HTTP 404」不知道往哪儿查。默认模型就曾因为下线白屏过。
        const detail = await res.clone().json().then((b) => b?.error?.message || '').catch(() => '')
        if (res.status === 404 || /model.*(not exist|invalid|not found)/i.test(detail)) {
          return { ok: false, reason: 'bad-model', model: s.model, latency: Date.now() - t0 }
        }
        return { ok: false, reason: `HTTP ${res.status}`, latency: Date.now() - t0 }
      }
      const body = await res.json()
      const msg = body?.choices?.[0]?.message
      const text = msg?.content?.trim()
      if (text) return { ok: true, text: text.slice(0, 40), model: s.model, latency: Date.now() - t0 }
      // 有 reasoning 没正文——推理模型的预算被思考吃光了，不是接口坏了
      if (msg?.reasoning_content || msg?.reasoning) {
        return { ok: false, reason: body?.choices?.[0]?.finish_reason === 'length' ? 'reasoning-only' : 'no-content', latency: Date.now() - t0 }
      }
      return { ok: false, reason: 'empty', latency: Date.now() - t0 }
    } catch (e) {
      return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : (e.message || 'network'), latency: Date.now() - t0 }
    }
  })

  // 原文层：单独一个 stats，不并进 db:stats——那个每次渲染都调，会把原文文件拖进启动路径
  ipcMain.handle('raw:stats', () => rawStats())
  ipcMain.handle('raw:get', (_, id) => getRaw(id))
  ipcMain.handle('raw:prune', () => pruneRaw())
  ipcMain.handle('raw:clear', () => clearRaw())
  ipcMain.handle('io:export', () => exportAll())
  ipcMain.handle('io:import', (_, json) => importAll(json))
  ipcMain.handle('io:readClipboard', () => clipboard.readText())
  ipcMain.handle('db:commonUsGaap', () => COMMON_US_GAAP)

  ipcMain.handle('agent:process', (_, text, themeId) => processCapture(text, themeId))

  ipcMain.handle('agent:socratic', async (_, nodeId) => {
    const node = allNodes().find((n) => n.id === nodeId)
    if (!node) return { ok: false, reason: 'not-found' }
    const context = node.parentId ? pathOf(node.parentId) : ''
    return tracked('socratic', () => socraticQuestions(settings(), node.title, context), { themeId: node.themeId })
  })

  // ---- 标的映射：只做可见性，不做信号 ----
  ipcMain.handle('db:addTicker', (_, id, ticker) => addTicker(id, ticker))
  ipcMain.handle('db:removeTicker', (_, id, code) => removeTicker(id, code))
  ipcMain.handle('db:tickerLookup', (_, code, themeId) => nodesByTicker(code, themeId))
  ipcMain.handle('db:tickers', (_, themeId) => allTickers(themeId))

  // ---- 数据目录 ----

  ipcMain.handle('io:openDataDir', async () => {
    const path = app.getPath('userData')
    try {
      const error = await shell.openPath(path)
      return error ? { ok: false, error } : { ok: true, path }
    } catch (e) { return { ok: false, error: e.message || '无法打开数据目录' } }
  })
  ipcMain.handle('io:openExternal', (_, url) => {
    if (typeof url !== 'string') return false
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    } catch { return false }
    return shell.openExternal(url)
  })

  // ---- 收件箱 ----
  // ⌘⇧V 粘贴 → 免费过滤 → 打标 → 抽取 → 去重 → 冲突 → 闸门 → 自动归位 or 进收件箱
  const runCapture = async (text, channelMeta) => {
    const bestTheme = bestThemeContext()
    const defaultThemeId = bestTheme?.id || null
    const result = await processCapture(text, defaultThemeId, channelMeta)

    // 不确定性闸门
    const gate = gateCheck(result)
    const textHash = hashText(result.resolvedText || text)
    const channel = result.resolvedChannel || channelMeta || null
    const degraded = result.degraded || false

    // 标签库匹配 → 提议归位（进收件箱，不静默建节点）
    if (result.routeProposals?.length) {
      const items = []
      for (const rp of result.routeProposals) {
        const item = addInboxItem({
          text: rp.text,
          title: firstSentence(rp.text),
          label: result.label,
          lemmas: result.lemmas,
          kind: 'route-proposal',
          matchedTheme: rp.matchedTheme,
          matchedTags: rp.matchedTags,
          originChannel: rp.originChannel,
          bestScore: rp.bestScore,
          provenance: result.resolvedChannel || channel,
          extracted: true,
          matchScore: rp.bestScore || 0,
        })
        items.push(item)
      }
      return { ok: true, autoImported: false, routeProposals: items, gateReasons: ['route-proposal'] }
    }

    if (gate.pass && defaultThemeId && result.lemmas.length > 0) {
      const batchId = uid()
      const intakeId = uid()
      const { imported, rawId } = autoImport(result, defaultThemeId, gate.reasons, batchId, intakeId)
      // 采集漏斗记录
      const intakeEvent = addIntakeEvent({
        themeId: defaultThemeId, textHash, rawId,
        channel: channel ? {
          platform: channel.platform || null, url: channel.url || null,
          fetchedAt: channel.fetchedAt || null, kind: result.label?.kind || null,
        } : null,
        label: result.label,
        gate: { pass: true, reasons: gate.reasons },
        outcome: 'auto',
        lemmas: result.lemmas.map((l, i) => ({
          title: l.title, action: imported[i]?.action || 'new',
          nodeId: imported[i]?.id || null,
          suggestedParentId: l.parentId || null,
          suggestedConfidence: Math.round((result.label.quality ?? 0.5) * 100),
        })),
        batchId, intakeId, degraded,
        captureSnapshot: {
          text: result.resolvedText || text,
          title: firstSentence(result.resolvedText || text),
          label: result.label, lemmas: result.lemmas,
          rejected: result.rejected, noulCompared: result.noulCompared,
          noulMaxScore: result.noulMaxScore, provenance: result.resolvedChannel || channel,
        },
      })
      getMainWindow?.()?.webContents.send('db:changed')
      return {
        ok: true, autoImported: true, imported, count: imported.length,
        intakeEventId: intakeEvent.id,
      }
    }

    // 未通过闸门（或免费过滤层拦下）→ 进收件箱等人裁决
    const item = addInboxItem({
      text: result.resolvedText || text,
      title: firstSentence(result.resolvedText || text),
      label: result.label,
      lemmas: result.lemmas,
      rejected: result.rejected,
      noulCompared: result.noulCompared,
      noulMaxScore: result.noulMaxScore,
      provenance: result.resolvedChannel || channel,
      extracted: result.extracted !== false,
      matchScore: result.matchScore || 0,
      ...(result.skipped ? { skipped: result.skipped } : {}),
    })
    // 采集漏斗记录
    addIntakeEvent({
      themeId: defaultThemeId, textHash, rawId: null,
      channel: channel ? {
        platform: channel.platform || null, url: channel.url || null,
        fetchedAt: channel.fetchedAt || null, kind: result.label?.kind || null,
      } : null,
      label: result.label,
      gate: { pass: false, reasons: gate.reasons },
      outcome: 'inbox',
      extracted: result.extracted !== false,
      matchScore: result.matchScore || 0,
      lemmas: result.lemmas.map((l) => ({
        title: l.title, action: l.action || 'new',
        nodeId: null,
        suggestedParentId: l.parentId || null,
        suggestedConfidence: l.confidence || 50,
      })),
      degraded, inboxItemId: item.id,
    })
    return { ok: true, autoImported: false, item, gateReasons: gate.reasons, skipped: result.skipped || null }
  }

  ipcMain.handle('inbox:capture', (_, text, channelMeta) => runCapture(text, channelMeta))
  // 复盘页：LLM 账本
  ipcMain.handle('llm:usage', () => llmUsage())

  // 分页：无分页时每次渲染把全部 pending（含 text+lemmas）拉过 IPC，
  // 而 refresh() 挂在 db:changed 上——改任何东西都会重跑一遍。
  ipcMain.handle('inbox:list', (_, { limit = 50, offset = 0 } = {}) => {
    const pending = allInbox()
    return { items: pending.slice(offset, offset + limit), total: pending.length }
  })
  ipcMain.handle('inbox:ignored', () => ignoredInbox())

  ipcMain.handle('inbox:resolve', (_, id, action) => {
    // 分类和幂等性由 store 中的原记录决定，不信任客户端的建议元数据。
    const item = resolveInboxItem(id, action)
    if (item && (action === 'accept' || action === 'reject')) markIntakeResolved(id, false)
    return item
  })

  // 批量入库：把选中的收件箱条目走捕获入库流水线（override 在 IPC 层应用并记 trace）
  ipcMain.handle('inbox:import', async (_, themeId, items, overrides) => {
    const s = settings()
    const ovMap = overrides || {}
    const results = []
    for (const item of items) {
      const raw = item.text
        ? appendRaw({ kind: item.label?.kind || '独立媒体', label: item.provenance?.url || item.provenance?.platform || `手工粘贴 · ${item.createdAt || today()}`, text: item.text, channel: item.provenance || null })
        : { id: null }

      const ov = ovMap[item.id] || {}
      for (const l of item.lemmas || []) {
        if (l.action === 'merge' && l.mergeInto) {
          addSource(l.mergeInto, {
            kind: l.sourceKind || item.label?.kind || '独立媒体',
            label: l.label || item.label?.kind || '未注明',
            at: today(),
            rawId: raw.id,
            ...(item.provenance?.platform ? { platform: item.provenance.platform } : {}),
            ...(item.provenance?.url ? { url: item.provenance.url } : {}),
            ...(item.provenance?.fetchedAt ? { fetchedAt: item.provenance.fetchedAt } : {}),
          })
          results.push({ title: l.title, action: 'merge' })
          continue
        }
        // IPC 层应用 override
        const origConfidence = l.confidence
        const origParentId = l.parentId || null
        const finalConfidence = ov.confidence != null ? ov.confidence : l.confidence
        const finalParentId = ov.parentId != null ? ov.parentId : (l.parentId || null)
        const hasOverride = ov.confidence != null || ov.parentId != null
        const node = addNode({
          themeId,
          parentId: finalParentId,
          kind: 'lemma',
          title: l.title,
          type: l.type,
          confidence: finalConfidence,
          tags: l.tags || [],
          sources: [{
            kind: l.sourceKind || item.label?.kind || '独立媒体',
            label: l.label || item.label?.kind || '未注明',
            at: today(),
            rawId: raw.id,
            ...(item.provenance?.platform ? { platform: item.provenance.platform } : {}),
            ...(item.provenance?.url ? { url: item.provenance.url } : {}),
            ...(item.provenance?.fetchedAt ? { fetchedAt: item.provenance.fetchedAt } : {}),
          }],
          settlement: l.settlement || null,
          by: 'manual',
        })
        for (const c of l.conflicts || []) addConflict(node.id, c.id, c.reason)
        promoteMatchingVerdicts(l.title, node.id, themeId)
        // route trace：记录原始建议值和用户最终值
        addTrace({
          target: { type: 'node', id: node.id },
          stage: 'route',
          actor: { by: 'user', model: null, promptVersion: 'v1' },
          input: { textHash: item.text ? hashText(item.text) : null, suggestedParentId: origParentId, suggestedConfidence: origConfidence },
          output: { parentId: origParentId, confidence: origConfidence },
          decision: { parentId: finalParentId, confidence: finalConfidence },
          reason: hasOverride ? 'user-override' : 'user-confirmed',
        })
        results.push({ title: l.title, action: 'new', id: node.id })
      }
      // 标记收件箱条目已入库
      resolveInboxItem(item.id, 'accept')
      // 标记采集漏斗已确认
      const hasAnyOverride = Object.keys(ov).length > 0 && (ov.confidence != null || ov.parentId != null)
      markIntakeResolved(item.id, hasAnyOverride)
    }
    getMainWindow?.()?.webContents.send('db:changed')
    return { ok: true, results }
  })

  // 主动决定：把「待抽取」组批量过一遍模型——让花费从自动变成主动的那个按钮
  ipcMain.handle('inbox:extract', async (_, ids) => {
    const targets = allInbox().filter((i) => !ids?.length || ids.includes(i.id))
    let extracted = 0
    for (const item of targets) {
      if (item.extracted) continue
      const result = await processCapture(item.text, bestThemeContext()?.id || null, item.provenance, { forceExtract: true })
      if (!result.lemmas.length) continue
      setInboxExtraction(item.id, { extracted: true, matchScore: result.matchScore || 0, lemmas: result.lemmas })
      extracted++
    }
    getMainWindow?.()?.webContents.send('db:changed')
    return { ok: true, extracted }
  })

  ipcMain.handle('inbox:clearUnextracted', () => clearInbox({ onlyUnextracted: true }))
  ipcMain.handle('inbox:prune', (_, days, opts) => pruneInbox(days, opts))
  ipcMain.handle('inbox:clear', () => clearInbox())

  // 撤销自动归位：按 intakeEventId 撤销，不再依赖渲染层传 batch
  ipcMain.handle('inbox:undoAutoImport', (_, intakeEventId) => {
    const event = getIntakeEvent(intakeEventId)
    if (!event || event.outcome !== 'auto') return { ok: false }
    // 删除自动创建的节点 / 移除合并的来源
    for (const l of event.lemmas || []) {
      if (l.action === 'new' && l.nodeId) {
        removeNode(l.nodeId)
      } else if (l.action === 'merge' && l.nodeId) {
        const node = getNode(l.nodeId)
        if (node && node.sources.length > 1) {
          updateNode(l.nodeId, { sources: node.sources.slice(0, -1) })
        }
      }
    }
    // 原文退回收件箱
    const cr = event.captureSnapshot
    if (cr) {
      addInboxItem({
        text: cr.text || '', title: cr.title || '',
        label: cr.label || null, lemmas: cr.lemmas || [],
        rejected: cr.rejected || [], noulCompared: cr.noulCompared || 0,
        noulMaxScore: cr.noulMaxScore || 0, provenance: cr.provenance || null,
      })
    }
    markIntakeUndone(intakeEventId)
    getMainWindow?.()?.webContents.send('db:changed')
    return { ok: true }
  })

  // 恢复撤销入口：重启后渲染层用这个拿回最近一次自动归位
  ipcMain.handle('inbox:lastAutoImport', () => {
    const event = lastAutoIntakeEvent()
    if (!event) return null
    return { id: event.id, count: (event.lemmas || []).length }
  })

  // 采集漏斗按天聚合
  ipcMain.handle('intake:series', (_, sinceDays) => intakeSeries(sinceDays))

  // ---- 留痕层 trace ----
  ipcMain.handle('trace:all', () => allTraces())
  ipcMain.handle('trace:byTarget', (_, targetId) => tracesByTarget(targetId))
  ipcMain.handle('trace:modelCalibration', () => modelCalibration())
  ipcMain.handle('trace:labelerDivergence', () => labelerDivergence())

  // ---- EDGAR 标签发现（仅手动触发）----
  ipcMain.handle('edgar:discoverTags', async (_, ticker) => {
    try {
      return await discoverTags(ticker)
    } catch (e) {
      return { tags: [], error: e.message || String(e), entityName: null }
    }
  })

  // ---- 读数层 ----
  ipcMain.handle('reading:add', (_, input) => addReading({
    metric: input?.metric, value: input?.value, unit: input?.unit, asOf: input?.asOf,
    period: input?.period, basis: input?.basis, source: input?.source,
    channelId: input?.channelId, nodeId: input?.nodeId, tier: 'agent',
  }))
  ipcMain.handle('reading:indicatorsFor', (_, reading) => indicatorsForReading(reading))
  ipcMain.handle('reading:get', (_, id) => getReading(id))
  ipcMain.handle('reading:page', (_, opts) => readingsPage(opts))
  ipcMain.handle('reading:evidence', (_, opts) => readingEvidence(opts))
  ipcMain.handle('reading:latest', () => latestReadings())
  ipcMain.handle('source:page', (_, opts) => sourcesPage(opts))
  ipcMain.handle('reading:assign', (_, id, nodeId) => {
    const result = assignReading(id, nodeId)
    if (result.ok) getMainWindow?.()?.webContents.send('db:changed')
    return result
  })
  ipcMain.handle('reading:verify', (_, key) => verifyReadingChain(key))
  ipcMain.handle('reading:push', async (_, envelope) => {
    const result = await ingestReadings(envelope, {
      onProgress: (progress) => getMainWindow?.()?.webContents.send('reading:progress', progress),
    })
    if (result.accepted) getMainWindow?.()?.webContents.send('db:changed')
    return result
  })
  ipcMain.handle('agent:intent', () => exportIntent())
  ipcMain.handle('agent:connection', () => getAgentConnection())

  // ---- 研究观点 ----
  ipcMain.handle('research:add', (_, input) => addResearchNote(input))
  ipcMain.handle('research:all', () => allResearchNotes())
  ipcMain.handle('research:byNode', (_, nodeId) => researchNotesByNode(nodeId))
  ipcMain.handle('research:hitRate', (_, notes, correct) => researchHitRate(notes, correct))
  ipcMain.handle('research:vsInstitution', (_, days) => vsInstitution(days || 90))
  // 旧的两步式骨架流程（先调 theme:generateSkeleton 取 JSON，再调 theme:instantiateSkeleton 落库）
  // 已被 theme:setupNew / theme:scaffoldExisting 的一步异步流程取代，渲染层无调用，移除。
}


export { register }
