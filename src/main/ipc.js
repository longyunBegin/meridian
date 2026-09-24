const { ipcMain, shell, app } = globalThis.__electron
import {
  load, addNode, updateNode, removeNode, restoreNode, purgeDead, repropagate, suggestParent, settleLemma, getNode,
  allThemes, addTheme, removeTheme, restoreTheme, renameTheme, deletedThemes, allNodes, rootNodes, childrenOf,
  settings, saveSettings, exportAll, importAll, SOURCE_QUALITY, dueSettlements,
  calibration, filterCalibration, falseKillAudit, propagationEvents, stats,
  addVerdict, allVerdicts, allConflicts, resolveConflict, promoteMatchingVerdicts,
  falseKillByChannel,
  sharedPremises, spawnFromScaffold, findSimilar, addConflict, addSource,
  appendRaw, getRaw, rawStats, pruneRaw, clearRaw, today,
  addTicker, removeTicker, nodesByTicker, allTickers,

  allInbox, addInboxItem, resolveInboxItem, clearInbox, inboxCount,
  addIntakeEvent, getIntakeEvent, markIntakeUndone, markIntakeResolved, lastAutoIntakeEvent, intakeSeries,
  bestThemeContext,
  addTrace, allTraces, tracesByTarget, modelCalibration, labelerDivergence,
  allChannels, addChannel, updateChannel, removeChannel,
  addReading, allReadings, indicatorsForReading, latestReadingByChannel,
  updateTheme, rankChannelsByTags, kindToTags, sicToTags,
  addResearchNote, allResearchNotes, researchNotesByNode, researchHitRate, vsInstitution,
  matchTagLibrary, crossThemeMatch, recordTagHits, updateTagLibraryTag, deleteTagLibraryTags,
  uid,
} from './store.js'
import { extractLemmas, socraticQuestions, generateSkeleton, generateThemeTags, generateTagLibrary } from './extract.js'
import { labelSource } from './labeler.js'
import { list as templateList, find as templateFind, instantiate, channelPack } from './templates.js'

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

/**
 * 捕获流水线：打标 → 抽取 → 去重 → 冲突检测 → 分拣
 * 每一步失败都单独降级，不让整条链路断掉。
 */
async function processCapture(text, themeId, channelMeta) {
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
    }
  }

  const label = await labelSource(settings(), actualText, actualChannel)

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
    input: { textHash: hashText(actualText), textLen: actualText.length, channelMeta: actualChannel || null },
    output: { kind: label.kind, quality: label.jevScore ?? null, via: label.via },
    decision: { kind: label.kind, quality: label.quality },
    reason: label.jevScore != null && label.jevScore !== label.quality
      ? `表值 ${label.quality} ≠ 模型值 ${label.jevScore}` : null,
  })

  const hints = branchTitles(themeId)
  const ex = await extractLemmas(settings(), actualText, hints)

  // 留痕：抽取阶段
  addTrace({
    target: { type: 'inbox', id: null },
    stage: 'extract',
    actor: { by: ex.ok ? 'model' : 'table', model: s.model || null, promptVersion: 'v1' },
    input: { textHash: hashText(actualText), textLen: actualText.length, channelMeta: actualChannel || null },
    output: ex.ok ? { lemmas: ex.lemmas, model: ex.model || null } : { error: ex.error || 'no-key' },
    decision: ex.ok ? { lemmas: ex.lemmas } : { degraded: true },
    reason: ex.ok ? null : '无 API key 或抽取失败，降级为单条 observation',
  })

  const lemmas = ex.ok ? ex.lemmas : [{
    title: firstSentence(actualText),
    type: 'observation',
    confidence: 50,
    parentHint: null,
    tags: [],
    sourceKind: label.kind,
  }]
  const degraded = !ex.ok

  const rejected = []
  const out = []
  let noulMaxScore = 0
  let noulCompared = 0

  const themeLemmas = themeId
    ? allNodes().filter((n) => n.themeId === themeId && n.kind === 'lemma' && n.status !== 'dead')
    : []
  noulCompared = themeLemmas.length

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
  const verdictChannelId = actualChannel?.channelId || channelMeta?.channelId || null
  for (const l of lemmas) {
    const dup = findSimilar(l.title, themeId)[0]
    if (dup && dup.score >= 0.6) {
      const v = addVerdict({
        gate: 'dedup', reason: 'duplicate', summary: l.title,
        score: label.quality, choice: label.kind, themeId,
        ...(verdictChannelId ? { channelId: verdictChannelId } : {}),
      })
      rejected.push({ id: v.id, summary: l.title, why: `重复 · 已有 ${dup.node.sources.length} 个独立源` })
      continue
    }
    if (label.quality < 0.35 && l.confidence < 45) {
      const v = addVerdict({
        gate: 'source', reason: 'low-quality', summary: l.title,
        score: label.quality, choice: label.kind, themeId,
        ...(verdictChannelId ? { channelId: verdictChannelId } : {}),
      })
      rejected.push({ id: v.id, summary: l.title, why: `低质 · ${label.kind} Score ${label.quality}` })
    }
  }

  return {
    ok: true,
    degraded,
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
    ? appendRaw({ kind: result.label.kind || '独立媒体', label: result.label.kind || '未注明', text: result.resolvedText, channel: result.resolvedChannel || null })
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
  ipcMain.handle('theme:templates', () => templateList())
  ipcMain.handle('theme:fromTemplate', async (_, templateId) => {
    const tpl = templateFind(templateId)
    if (!tpl) return null
    const theme = addTheme(tpl.name)
    if (Array.isArray(tpl.tags) && tpl.tags.length) updateTheme(theme.id, { tags: tpl.tags })
    instantiate(tpl, (spec) => addNode({ ...spec, themeId: theme.id }))
    // 自动配默认通道包
    for (const ch of channelPack(templateId)) {
      addChannel({
        name: ch.name, kind: ch.kind, fetch: ch.fetch, query: ch.query,
        metric: ch.metric || null, interval: Math.max(15, Number(ch.interval) || 60),
        cadence: ch.cadence, themeId: theme.id,
        enabled: !ch.needsKey,
      })
    }
    // 生成标签库（降级不阻塞）
    const s = settings()
    const titles = allNodes().filter((n) => n.themeId === theme.id && n.kind === 'branch').map((n) => n.title)
    const tlResult = await generateTagLibrary(s, tpl.name, titles)
    if (tlResult.ok) updateTheme(theme.id, { tagLibrary: tlResult.tagLibrary })
    return theme
  })

  // 一句话冷启动：建主题 → 生成骨架 → 配通道 → 打标签 → 返回
  ipcMain.handle('theme:setupNew', async (_, description) => {
    const theme = addTheme(description)
    const s = settings()
    const r = await generateSkeleton(s, description)
    if (r.ok) {
      // 模型生成骨架
      const walk = (node, parentId) => {
        const n = addNode({
          themeId: theme.id, parentId, kind: 'branch', title: node.title,
          propagation: node.propagation || 0.6, by: 'model',
          stableId: node.id, scaffold: node.scaffold || null,
        })
        for (const c of node.children || []) walk(c, n.id)
      }
      for (const root of r.skeleton) walk(root, null)
    } else {
      // 无 key 降级：用静态模板
      const tpl = templateFind('ai-chain')
      if (tpl) instantiate(tpl, (spec) => addNode({ ...spec, themeId: theme.id }))
    }
    // 按描述匹配通道包，匹配不到不配任何通道——比塞一套不相关的通道诚实
    const AI_KEYWORDS = /AI|人工智能|LLM|大模型|GPU|芯片|算力|光模块|半导体|silicon|photonics|inference|training|token|cloud|云/
    const packId = AI_KEYWORDS.test(description) ? 'ai-chain' : null
    if (packId) {
      for (const ch of channelPack(packId)) {
        addChannel({
          name: ch.name, kind: ch.kind, fetch: ch.fetch, query: ch.query,
          metric: ch.metric || null, interval: Math.max(15, Number(ch.interval) || 60),
          cadence: ch.cadence, themeId: theme.id,
          enabled: !ch.needsKey,
        })
      }
    }
    // 主题打标签（降级：无 key → tags: []，不阻塞）
    const tagResult = await generateThemeTags(s, description)
    if (tagResult.ok && tagResult.tags.length) updateTheme(theme.id, { tags: tagResult.tags })
    // 生成标签库（降级：无 key → tagLibrary: []，不阻塞）
    const titles = allNodes().filter((n) => n.themeId === theme.id && n.kind === 'branch').map((n) => n.title)
    const tlResult = await generateTagLibrary(s, description, titles)
    if (tlResult.ok) updateTheme(theme.id, { tagLibrary: tlResult.tagLibrary })
    return theme
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

  ipcMain.handle('agent:process', (_, text, themeId) => processCapture(text, themeId))

  ipcMain.handle('agent:socratic', async (_, nodeId) => {
    const node = allNodes().find((n) => n.id === nodeId)
    if (!node) return { ok: false, reason: 'not-found' }
    const context = node.parentId ? pathOf(node.parentId) : ''
    return socraticQuestions(settings(), node.title, context)
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
  // ⌘⇧V 粘贴 → 打标 → 抽取 → 去重 → 冲突 → 闸门 → 自动归位 or 进收件箱
  ipcMain.handle('inbox:capture', async (_, text, channelMeta) => {
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
          provenance: channel,
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
          noulMaxScore: result.noulMaxScore, provenance: channel,
        },
      })
      getMainWindow?.()?.webContents.send('db:changed')
      return {
        ok: true, autoImported: true, imported, count: imported.length,
        intakeEventId: intakeEvent.id,
      }
    }

    // 未通过闸门 → 进收件箱等人裁决
    const item = addInboxItem({
      text: result.resolvedText || text,
      title: firstSentence(result.resolvedText || text),
      label: result.label,
      lemmas: result.lemmas,
      rejected: result.rejected,
      noulCompared: result.noulCompared,
      noulMaxScore: result.noulMaxScore,
      provenance: channel,
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
      lemmas: result.lemmas.map((l) => ({
        title: l.title, action: l.action || 'new',
        nodeId: null,
        suggestedParentId: l.parentId || null,
        suggestedConfidence: l.confidence || 50,
      })),
      degraded, inboxItemId: item.id,
    })
    return { ok: true, autoImported: false, item, gateReasons: gate.reasons }
  })

  ipcMain.handle('inbox:list', () => allInbox())

  ipcMain.handle('inbox:resolve', (_, id, action) => {
    const item = resolveInboxItem(id, action)
    if (action === 'reject' && item) {
      // 被拒绝的进墓碑区作抽取器负样本：记判断不记原文
      addVerdict({
        gate: 'user', reason: 'rejected', summary: item.title,
        score: item.label?.quality || 0, choice: item.label?.kind || '未知',
      })
    }
    if (item) markIntakeResolved(id, false)
    return item
  })

  // 批量入库：把选中的收件箱条目走捕获入库流水线（override 在 IPC 层应用并记 trace）
  ipcMain.handle('inbox:import', async (_, themeId, items, overrides) => {
    const s = settings()
    const ovMap = overrides || {}
    const results = []
    for (const item of items) {
      const raw = item.text
        ? appendRaw({ kind: item.label?.kind || '独立媒体', label: item.label?.kind || '未注明', text: item.text })
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
      updateChannel(channelId, { lastError: result.error, lastFetch: today(), failCount: (ch.failCount || 0) + 1 })
      return result
    }
    const count = (result.readings?.added || 0) + (result.items?.length || 0)
    updateChannel(channelId, { lastOk: today(), lastError: null, lastFetch: today(), lastCount: count, failCount: 0 })
    // Path B：有 items 需要走 processCapture 产命题
    if (result.items && result.items.length) {
      const themeId = ch.themeId || bestThemeContext()?.id || null
      for (const item of result.items) {
        if (!themeId) continue
        const cap = await processCapture(item.text, themeId, {
          kind: item.kind || ch.kind,
          platform: item.platform || null,
          url: item.url || null,
          channelId: ch.id,
        })
        // review: true → 强制进收件箱等人裁决
        if (ch.review) {
          addInboxItem({
            text: item.text,
            title: firstSentence(item.text),
            label: cap.label,
            lemmas: cap.lemmas,
            rejected: cap.rejected,
            noulCompared: cap.noulCompared,
            noulMaxScore: cap.noulMaxScore,
            provenance: { platform: item.platform || null, url: item.url || null, channelId: ch.id },
          })
          continue
        }
        // review: false → 走闸门
        const gate = gateCheck(cap)
        if (gate.pass && cap.lemmas.length > 0) {
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
          })
        }
      }
    }
    return result
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
  ipcMain.handle('llm:proposeLinks', async (_, themeId) => {
    try {
      return await proposeChannelLinks(settings(), themeId)
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
