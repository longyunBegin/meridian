import { ipcMain, shell } from 'electron'
import { app } from 'electron'
import {
  load, addNode, updateNode, removeNode, repropagate, suggestParent, settleLemma,
  allThemes, addTheme, removeTheme, renameTheme, allNodes, rootNodes, childrenOf,
  settings, saveSettings, exportAll, importAll, SOURCE_QUALITY, dueSettlements,
  calibration, filterCalibration, falseKillAudit, propagationEvents, stats,
  addVerdict, allVerdicts, allConflicts, resolveConflict,
  sharedPremises, spawnFromScaffold, findSimilar, addConflict, addSource,
  appendRaw, getRaw, rawStats, pruneRaw, clearRaw, today,
} from './store.js'
import { extractLemmas } from './extract.js'
import { labelSource } from './labeler.js'
import { list as templateList, find as templateFind, instantiate } from './templates.js'

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
async function processCapture(text, themeId) {
  const label = await labelSource(settings(), text)

  const hints = branchTitles(themeId)
  const ex = await extractLemmas(settings(), text, hints)

  const lemmas = ex.ok ? ex.lemmas : [{
    title: firstSentence(text),
    type: 'observation',
    confidence: 50,
    parentHint: null,
    tags: [],
    sourceKind: label.kind,
  }]
  const degraded = !ex.ok

  const rejected = []
  const out = []

  for (const l of lemmas) {
    // 1) 去重：同一条 claim 已有独立来源 → 不新建，只 +1 源
    const dup = findSimilar([l.title, l.parentHint].filter(Boolean).join(' '), themeId)[0]
    if (dup) {
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
    label: { kind: label.kind, quality: label.quality, via: label.via, jevScore: label.jevScore ?? null, noul: label.noul ?? null },
    lemmas: out,
    rejected,
  }
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
 * 窗口相关的东西由 main.js 注入，不在这里 import——
 * ES 模块不共享作用域，直接引用 main.js 里的 hideCapture / mainWin 会在运行时
 * 抛 ReferenceError，而 capture:save 是整条捕获链路的最后一环。
 */
function register({ resizeCapture, showCapture, hideCapture, getMainWindow }) {
  ipcMain.handle('db:stats', () => stats())
  ipcMain.handle('db:nodes', (_, themeId) => allNodes().filter((n) => n.themeId === themeId))
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

  // capture:ready 只作为渲染进程的就绪信号；剪贴板由 main.js 的 showCapture()
  // 在窗口拿到焦点之后读取——app 未激活时同步读 NSPasteboard 会阻塞主进程。
  ipcMain.on('capture:resize', (_, height) => resizeCapture?.(height))
  ipcMain.on('capture:save', (_, payload) => {
    // 原文只落一次：同一段被抓出多条命题，共用一份依据。
    // sha256 去重，同内容第二次被抓直接复用旧 id。
    const raw = payload.text
      ? appendRaw({ kind: payload.labelKind || '独立媒体', label: payload.labelKind || '未注明', text: payload.text })
      : { id: null }

    for (const l of payload.lemmas || []) {
      if (l.action === 'merge' && l.mergeInto) {
        addSource(l.mergeInto, {
          kind: l.sourceKind || payload.labelKind || '独立媒体',
          label: l.label || payload.labelKind || '未注明',
          at: today(),
          rawId: raw.id,
        })
        continue
      }
      const node = addNode({
        themeId: payload.themeId,
        parentId: l.parentId || null,
        kind: 'lemma',
        title: l.title,
        type: l.type,
        confidence: l.confidence,
        tags: l.tags || [],
        sources: [{
          kind: l.sourceKind || payload.labelKind || '独立媒体',
          label: l.label || payload.labelKind || '未注明',
          at: today(),
          rawId: raw.id,
        }],
        settlement: l.settlement || null,
      })
      // 入库时发现的冲突，登记待裁决
      for (const c of l.conflicts || []) addConflict(node.id, c.id, c.reason)
    }
    hideCapture?.()
    getMainWindow?.()?.webContents.send('db:changed')
  })
  ipcMain.on('io:openDataDir', () => shell.openPath(app.getPath('userData')))
  ipcMain.on('app:showCapture', () => showCapture?.())
}


export { register }
