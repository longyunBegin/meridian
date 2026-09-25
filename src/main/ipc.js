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
  bestThemeContext, channelMatchRates,
  addTrace, allTraces, tracesByTarget, modelCalibration, labelerDivergence, llmUsage,
  allChannels, addChannel, updateChannel, removeChannel,
  addReading, allReadings, indicatorsForReading, latestReadingByChannel,
  updateTheme, rankChannelsByTags, kindToTags, sicToTags,
  addResearchNote, allResearchNotes, researchNotesByNode, researchHitRate, vsInstitution,
  matchTagLibrary, crossThemeMatch, recordTagHits, updateTagLibraryTag, deleteTagLibraryTags,
  uid,
} from './store.js'
import { extractLemmas, socraticQuestions, generateSkeleton, generateThemeTags, generateTagLibrary, pickChannelsFromLibrary } from './extract.js'
import { labelSource, jevLabel, llmLabel } from './labeler.js'
import { tracked } from './llmlog.js'
import { genericFallback, channelLibrary, instantiate } from './templates.js'

import { fetchChannel, availableFetchers, METRIC_FETCHERS } from './fetchers.js'
import { discoverTags, deriveChannelTags } from './discover.js'
import { isUrl, inferChannel, fetchUrl } from './fetcher.js'
import { proposeChannelLinks } from './propose.js'
import { createHash } from 'node:crypto'

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
  const traces = allTraces()
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i]
    if (t.input?.textHash !== h) continue
    if (t.stage === 'extract' && t.decision?.lemmas) {
      // 只复用同主题的抽取结果——别的主题的挂点在当前主题里是悬空的
      const traced = t.target?.themeId || null
      if (traced && themeId && traced !== themeId) continue
      return { kind: 'lemmas', lemmas: t.decision.lemmas, themeId: traced }
    }
    if (t.stage === 'gate' && t.decision?.skipped) {
      return { kind: 'skipped', skipped: t.decision.skipped, matchScore: t.decision.matchScore || 0 }
    }
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
  if (seen) return { action: 'reuse', seen }

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

  // 留痕：打标阶段
  addTrace({
    target: { type: 'inbox', id: null },
    stage: 'label',
    actor: { by: label.via || 'table', model: s.model || null, promptVersion: 'v1' },
    input: { textHash: h, textLen: actualText.length, channelMeta: actualChannel || null },
    output: { kind: label.kind, quality: label.jevScore ?? null, via: label.via },
    decision: { kind: label.kind, quality: label.quality },
    reason: label.jevScore != null && label.jevScore !== label.quality
      ? `表值 ${label.quality} ≠ 模型值 ${label.jevScore}` : null,
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
    input: { textHash: h, textLen: actualText.length, channelMeta: actualChannel || null },
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
function register({ getMainWindow }) {
  ipcMain.handle('db:stats', () => stats())
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
  ipcMain.handle('db:resolveConflict', (_, id, verdict) => resolveConflict(id, verdict))
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

  async function scaffoldTheme(themeId, description, s) {
    const library = channelLibrary()
    const [skeletonResult, tagResult, channelResult] = await Promise.all([
      tracked('skeleton', () => generateSkeleton(s, description), { themeId }),
      tracked('themeTags', () => generateThemeTags(s, description), { themeId }),
      tracked('pickChannels', () => pickChannelsFromLibrary(s, description, library), { themeId }),
    ])

    if (skeletonResult.ok) {
      const walk = (node, parentId) => {
        const n = addNode({
          themeId, parentId, kind: 'branch', title: node.title,
          propagation: node.propagation || 0.6, by: 'model',
          stableId: node.id, scaffold: node.scaffold || null,
        })
        for (const c of node.children || []) walk(c, n.id)
      }
      for (const root of skeletonResult.skeleton.roots || []) walk(root, null)
    } else {
      const fallback = genericFallback()
      if (fallback) instantiate(fallback, (spec) => addNode({ ...spec, themeId }))
    }

    for (const ch of channelResult.channels || []) {
      addChannel({
        name: ch.name, kind: ch.kind, fetch: ch.fetch, query: ch.query,
        metric: ch.metric || null, interval: Math.max(15, Number(ch.interval) || 60),
        cadence: ch.cadence, themeId, tags: ch.tags || [],
        enabled: !ch.needsKey,
      })
    }

    if (tagResult.ok && tagResult.tags.length) updateTheme(themeId, { tags: tagResult.tags })
    const titles = allNodes().filter((n) => n.themeId === themeId && n.kind === 'branch').map((n) => n.title)
    const tagLibraryResult = await tracked('tagLibrary', () => generateTagLibrary(s, description, titles), { themeId })
    if (tagLibraryResult.ok) updateTheme(themeId, { tagLibrary: tagLibraryResult.tagLibrary })

    return {
      degraded: !skeletonResult.ok,
      channelCount: channelResult.channels?.length || 0,
    }
  }

  ipcMain.handle('theme:setupNew', async (_, description) => {
    const theme = addTheme(description)
    const result = await scaffoldTheme(theme.id, description, settings())
    return { ...theme, ...result }
  })

  // 空白主题补生成骨架 + 标签库（E3）
  ipcMain.handle('theme:scaffoldExisting', async (_, themeId, description) => {
    const result = await scaffoldTheme(themeId, description, settings())
    return { ok: true, ...result }
  })

  ipcMain.handle('settings:get', () => ({ ...settings(), sourceQuality: SOURCE_QUALITY }))
  ipcMain.handle('settings:set', (_, patch) => saveSettings(patch))
  // 试标：不落库，只为在捕获之前验证打标器通不通、规则命中得对不对
  ipcMain.handle('label:test', (_, text) => labelSource(settings(), text))

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

  // ---- 订阅源（已统一为通道，见 channel:* handler）----

  ipcMain.on('io:openDataDir', () => shell.openPath(app.getPath('userData')))
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
  // 复盘页：LLM 账本 + 通道未匹配率
  ipcMain.handle('llm:usage', () => llmUsage())
  ipcMain.handle('channel:matchRates', () => channelMatchRates(30))

  ipcMain.handle('inbox:list', () => allInbox())
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

  // ---- 通道描述符 ----
  ipcMain.handle('channel:list', () => allChannels())
  ipcMain.handle('channel:add', async (_, ch) => {
    const channel = addChannel(ch)
    try {
      const tags = await deriveChannelTags(channel, settings())
      if (tags.length) return updateChannel(channel.id, { tags })
    } catch { /* 推导失败不阻塞建通道 */ }
    return channel
  })
  ipcMain.handle('channel:update', async (_, id, patch) => {
    const updated = updateChannel(id, patch)
    if (!updated) return null
    // 改了 query / fetch / kind 时重算 tags
    if (patch.query !== undefined || patch.fetch !== undefined || patch.kind !== undefined) {
      try {
        const tags = await deriveChannelTags(updated, settings())
        return updateChannel(id, { tags })
      } catch { /* 重算失败保留旧 tags */ }
    }
    return updated
  })
  ipcMain.handle('channel:remove', (_, id) => removeChannel(id))

  /** 通道拉取的分流逻辑——handler 和轮询器都调它，不复制粘贴 */
  async function runChannelFetch(channelId) {
    const ch = allChannels().find((c) => c.id === channelId)
    if (!ch) return { items: [], readings: null, error: 'channel not found' }
    const result = await fetchChannel(ch)
    if (result.error) {
      // lastFetch 必须是完整时间：只存日期会被 Date.parse 还原成当天 00:00，interval 形同虚设
      updateChannel(channelId, { lastError: result.error, lastFetch: new Date().toISOString(), failCount: (ch.failCount || 0) + 1 })
      return result
    }
    const count = (result.readings?.added || 0) + (result.items?.length || 0)
    // lastOk / lastError 仍是日期——那是给人看的，不需要精度
    updateChannel(channelId, { lastOk: today(), lastError: null, lastFetch: new Date().toISOString(), lastCount: count, failCount: 0 })
    // Path B：有 items 需要走 processCapture 产命题
    let processed = 0
    if (result.items && result.items.length) {
      const themeId = ch.themeId || bestThemeContext()?.id || null
      for (const item of result.items) {
        if (!themeId) continue
        processed++
        const cap = await processCapture(item.text, themeId, {
          kind: item.kind || ch.kind,
          platform: item.platform || null,
          url: item.url || null,
          channelId: ch.id,
        })
        const gate = gateCheck(cap)
        if (cap.extracted !== false && gate.pass && cap.lemmas.length > 0) {
          autoImport(cap, themeId, gate.reasons, uid(), uid())
        } else {
          addInboxItem({
            text: item.text,
            title: firstSentence(item.text),
            label: cap.label,
            lemmas: cap.lemmas,
            rejected: cap.rejected,
            noulCompared: cap.noulCompared,
            noulMaxScore: cap.noulMaxScore,
            provenance: { platform: item.platform || null, url: item.url || null, channelId: ch.id },
            extracted: cap.extracted !== false,
            matchScore: cap.matchScore || 0,
            ...(cap.skipped ? { skipped: cap.skipped } : {}),
          })
        }
      }
    }
    // processed：本轮处理的条数（含被免费过滤层拦下的），轮询器据此扣 tick 预算
    return { ...result, processed }
  }

  ipcMain.handle('channel:fetch', (_, channelId) => runChannelFetch(channelId))
  ipcMain.handle('channel:fetchers', () => availableFetchers())
  ipcMain.handle('channel:metricFetchers', () => METRIC_FETCHERS)

  // ---- EDGAR 标签发现（仅手动触发）----
  ipcMain.handle('edgar:discoverTags', async (_, ticker) => {
    try {
      return await discoverTags(ticker)
    } catch (e) {
      return { tags: [], error: e.message || String(e), entityName: null }
    }
  })

  // ---- LLM 提议指针 ----
  ipcMain.handle('llm:proposeLinks', async (_, indicatorId) => {
    try {
      const node = getNode(indicatorId)
      return await tracked('propose', () => proposeChannelLinks(settings(), node, allChannels()), { themeId: node?.themeId })
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    }
  })

  // ---- 读数层 ----
  ipcMain.handle('reading:add', (_, input) => addReading(input))
  ipcMain.handle('reading:all', () => allReadings())
  ipcMain.handle('reading:indicatorsFor', (_, reading) => indicatorsForReading(reading))
  ipcMain.handle('reading:latestByChannel', (_, channelId) => latestReadingByChannel(channelId))

  // ---- 研究观点 ----
  ipcMain.handle('research:add', (_, input) => addResearchNote(input))
  ipcMain.handle('research:all', () => allResearchNotes())
  ipcMain.handle('research:byNode', (_, nodeId) => researchNotesByNode(nodeId))
  ipcMain.handle('research:hitRate', (_, notes, correct) => researchHitRate(notes, correct))
  ipcMain.handle('research:vsInstitution', (_, days) => vsInstitution(days || 90))

  // ---- 模型生成骨架（step 4）----
  ipcMain.handle('theme:generateSkeleton', async (_, description) => {
    const s = settings()
    const result = await generateSkeleton(s, description)
    return result
  })

  ipcMain.handle('theme:instantiateSkeleton', async (_, themeId, skeleton) => {
    // 把模型生成的骨架落库为草稿态节点
    const created = []
    const walk = (node, parentId) => {
      const n = addNode({
        themeId,
        parentId,
        kind: 'branch',
        title: node.title,
        propagation: node.propagation ?? 0.5,
        scaffold: node.scaffold || null,
        by: 'model',
        stableId: node.stableId,
      })
      created.push(n)
      for (const child of node.children || []) walk(child, n.id)
    }
    for (const root of skeleton.roots || []) walk(root, null)
    getMainWindow?.()?.webContents.send('db:changed')
    return { ok: true, count: created.length }
  })

  return { runChannelFetch }
}


export { register }
