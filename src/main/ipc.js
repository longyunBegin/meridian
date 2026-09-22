const { ipcMain, shell, app } = globalThis.__electron
import {
  load, addNode, updateNode, removeNode, repropagate, suggestParent, settleLemma, getNode,
  allThemes, addTheme, removeTheme, renameTheme, allNodes, rootNodes, childrenOf,
  settings, saveSettings, exportAll, importAll, SOURCE_QUALITY, dueSettlements,
  calibration, filterCalibration, falseKillAudit, propagationEvents, stats,
  addVerdict, allVerdicts, allConflicts, resolveConflict,
  sharedPremises, spawnFromScaffold, findSimilar, addConflict, addSource,
  appendRaw, getRaw, rawStats, pruneRaw, clearRaw, today,
  addTicker, removeTicker, nodesByTicker, allTickers,
  allFeeds, addFeed, getFeed, updateFeed, removeFeed, markFeedFetched,
  allInbox, addInboxItem, resolveInboxItem, clearInbox, inboxCount,
  bestThemeContext,
  addTrace, allTraces, tracesByTarget, modelCalibration, labelerDivergence,
  allChannels, addChannel, updateChannel, removeChannel,
} from './store.js'
import { extractLemmas, socraticQuestions, generateSkeleton } from './extract.js'
import { labelSource } from './labeler.js'
import { list as templateList, find as templateFind, instantiate } from './templates.js'
import { fetchFeed } from './feeds.js'
import { isUrl, inferChannel, fetchUrl } from './fetcher.js'
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
  for (const l of lemmas) {
    const dup = findSimilar(l.title, themeId)[0]
    if (dup && dup.score >= 0.6) {
      const v = addVerdict({
        gate: 'dedup', reason: 'duplicate', summary: l.title,
        score: label.quality, choice: label.kind,
      })
      rejected.push({ id: v.id, summary: l.title, why: `重复 · 已有 ${dup.node.sources.length} 个独立源` })
      continue
    }
    if (label.quality < 0.35 && l.confidence < 45) {
      const v = addVerdict({
        gate: 'source', reason: 'low-quality', summary: l.title,
        score: label.quality, choice: label.kind,
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
      pills: generatePills(label.kind),
    },
    lemmas: out,
    rejected,
    noulCompared,
    noulMaxScore: Math.round(noulMaxScore * 100) / 100,
    resolvedText: actualText,
    resolvedChannel: actualChannel,
    fromUrl,
  }
}

/** 生成来源类型概率分布 pills：选中类型高概率，相邻类型递减 */
function generatePills(selectedKind) {
  const sorted = SOURCE_QUALITY.slice().sort((a, b) => b[1] - a[1])
  const selected = sorted.find(([k]) => k === selectedKind) || sorted[0]
  const others = sorted.filter(([k]) => k !== selected[0])
  const top = [
    { kind: selected[0], prob: 0.65 + selected[1] * 0.1 },
    { kind: others[0][0], prob: 0.15 + others[0][1] * 0.05 },
    { kind: others[1][0], prob: 0.05 + others[1][1] * 0.03 },
  ]
  const sum = top.reduce((s, p) => s + p.prob, 0)
  return top.map((p) => ({ kind: p.kind, prob: Math.round((p.prob / sum) * 100) / 100 }))
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
  ipcMain.handle('db:repropagate', (_, id) => repropagate(id))
  ipcMain.handle('db:settle', (_, id, correct) => settleLemma(id, correct))
  ipcMain.handle('db:addSource', (_, id, source) => addSource(id, source))

  ipcMain.handle('theme:all', () => allThemes())
  ipcMain.handle('theme:add', (_, name) => addTheme(name))
  ipcMain.handle('theme:remove', (_, id) => removeTheme(id))
  ipcMain.handle('theme:rename', (_, id, name) => renameTheme(id, name))
  ipcMain.handle('theme:templates', () => templateList())
  ipcMain.handle('theme:fromTemplate', (_, templateId) => {
    const tpl = templateFind(templateId)
    if (!tpl) return null
    const theme = addTheme(tpl.name)
    instantiate(tpl, (spec) => addNode({ ...spec, themeId: theme.id }))
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

  // ---- 订阅源 ----
  ipcMain.handle('feed:list', () => allFeeds())
  ipcMain.handle('feed:add', (_, feed) => addFeed(feed))
  ipcMain.handle('feed:update', (_, id, patch) => updateFeed(id, patch))
  ipcMain.handle('feed:remove', (_, id) => removeFeed(id))
  ipcMain.handle('feed:fetch', async (_, id) => {
    const feed = getFeed(id)
    if (!feed) return { ok: false, reason: 'not-found' }
    try {
      const items = await fetchFeed(feed.url)
      markFeedFetched(id, items.length)
      return { ok: true, items }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  })

  // 拉取 + 自动 JEV 打标：每条数据走 labelSource，返回带标签的结果
  ipcMain.handle('feed:fetchAndLabel', async (_, id) => {
    const feed = getFeed(id)
    if (!feed) return { ok: false, reason: 'not-found' }
    try {
      const items = await fetchFeed(feed.url)
      const s = settings()
      const labeled = []
      for (const item of items) {
        const text = `${item.title} ${item.description || ''}`
        const label = await labelSource(s, text)
        const dup = findSimilar(item.title, feed.themeId)[0]
        labeled.push({
          ...item,
          label: {
            kind: label.kind,
            quality: label.quality,
            via: label.via,
            jevScore: label.jevScore ?? null,
            pills: generatePills(label.kind),
          },
          dup: dup ? { id: dup.node.id, title: dup.node.title, score: dup.score } : null,
        })
      }
      markFeedFetched(id, items.length)
      return { ok: true, items: labeled }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  })

  // 批量入库：把选中的数据源条目走捕获流水线
  ipcMain.handle('feed:import', async (_, feedId, themeId, items) => {
    const feed = getFeed(feedId)
    const s = settings()
    const results = []
    for (const item of items) {
      const text = `${item.title} ${item.description || ''}`
      const label = await labelSource(s, text)
      const ex = await extractLemmas(s, text, branchTitles(themeId))
      const lemmas = ex.ok ? ex.lemmas : [{
        title: item.title,
        type: 'observation',
        confidence: 50,
        parentHint: null,
        tags: [],
        sourceKind: label.kind,
      }]
      for (const l of lemmas) {
        const dup = findSimilar(l.title, themeId)[0]
        if (dup) {
          addSource(dup.node.id, {
            kind: label.kind, label: feed?.name || label.kind,
            at: today(), quality: label.quality,
          })
          results.push({ title: l.title, action: 'merge' })
          continue
        }
        const cands = suggestParent([l.title, l.parentHint].filter(Boolean).join(' '), themeId)
        const top = cands[0]
        const node = addNode({
          themeId, parentId: top?.id || null, kind: 'lemma',
          title: l.title, type: l.type, confidence: l.confidence,
          tags: l.tags || [], sources: [{ kind: label.kind, label: feed?.name || label.kind, at: today(), quality: label.quality }],
        })
        results.push({ title: l.title, action: 'new', id: node.id })
      }
    }
    return { ok: true, results }
  })

  ipcMain.on('io:openDataDir', () => shell.openPath(app.getPath('userData')))

  // ---- 收件箱 ----
  // ⌘⇧V 粘贴进收件箱（不再立即入库）：打标 → 抽取 → 去重 → 冲突 → 等用户裁决
  ipcMain.handle('inbox:capture', async (_, text, channelMeta) => {
    const s = settings()
    // 全局收件箱不按主题分，但打标/去重需要一个主题上下文
    // 用 lemma 数最多的主题作为默认上下文（用户在裁决时确认或修改）
    const bestTheme = bestThemeContext()
    const defaultThemeId = bestTheme?.id || null
    const result = await processCapture(text, defaultThemeId, channelMeta)
    const item = addInboxItem({
      text: result.resolvedText || text,
      title: firstSentence(result.resolvedText || text),
      label: result.label,
      lemmas: result.lemmas,
      rejected: result.rejected,
      noulCompared: result.noulCompared,
      noulMaxScore: result.noulMaxScore,
      provenance: result.resolvedChannel || channelMeta || null,
    })
    return { ok: true, item }
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
    return item
  })

  // 批量入库：把选中的收件箱条目走捕获入库流水线
  ipcMain.handle('inbox:import', async (_, themeId, items) => {
    const s = settings()
    const results = []
    for (const item of items) {
      const raw = item.text
        ? appendRaw({ kind: item.label?.kind || '独立媒体', label: item.label?.kind || '未注明', text: item.text })
        : { id: null }

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
        const node = addNode({
          themeId,
          parentId: l.parentId || null,
          kind: 'lemma',
          title: l.title,
          type: l.type,
          confidence: l.confidence,
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
        results.push({ title: l.title, action: 'new', id: node.id })
      }
      // 标记收件箱条目已入库
      resolveInboxItem(item.id, 'accept')
    }
    getMainWindow?.()?.webContents.send('db:changed')
    return { ok: true, results }
  })

  ipcMain.handle('inbox:clear', () => clearInbox())

  // ---- 留痕层 trace ----
  ipcMain.handle('trace:all', () => allTraces())
  ipcMain.handle('trace:byTarget', (_, targetId) => tracesByTarget(targetId))
  ipcMain.handle('trace:modelCalibration', () => modelCalibration())
  ipcMain.handle('trace:labelerDivergence', () => labelerDivergence())

  // ---- 通道描述符 ----
  ipcMain.handle('channel:list', () => allChannels())
  ipcMain.handle('channel:add', (_, ch) => addChannel(ch))
  ipcMain.handle('channel:update', (_, id, patch) => updateChannel(id, patch))
  ipcMain.handle('channel:remove', (_, id) => removeChannel(id))

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
}


export { register }
