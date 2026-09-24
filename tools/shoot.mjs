/**
 * 视觉验证工具：不需要 macOS 屏幕录制权限。
 *
 * 用 Electron 进程内的 capturePage() 抓窗口内容，而不是 screencapture 抓屏幕。
 * 用独立的临时 userData 目录，不会碰你真实的数据文件。
 *
 * 注意：Electron 主进程入口里不能用顶层 await——它会让 app.whenReady() 永远不 resolve。
 * 所以这里整体包在 whenReady().then() 里。
 *
 * 运行：npm run shoot
 * 输出：/tmp/meridian-shots/*.png
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
globalThis.__electron = require('electron')
const { app, BrowserWindow, ipcMain } = globalThis.__electron

let load, addTheme, addNode, updateNode, addVerdict, markPromoted, addConflict, addChannel
let settleLemma, allNodes, addInboxItem, allInbox, genericFallback, instantiate, register

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const RENDERER = join(ROOT, 'src/renderer/index.html')
const HUD = join(ROOT, 'src/renderer/capture.html')
const OUT = '/tmp/meridian-shots'
const DATA = '/tmp/meridian-shoot-data'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, label) => {
  if (!condition) throw new Error(`交互验收失败：${label}`)
  console.log('  ✓', label)
}

const SAMPLE = '我们跟踪的 1.6T 光模块供应链显示，北美某云厂商 Q4 订单能见度已排到明年 Q2，产能被头部客户锁定。但同时，一家新进入者宣布其硅光方案成本低 30%，预计 2027 年量产。——某产业调研纪要'

// 抛了异常要响亮地退，不能挂着——Electron 不会因未处理 rejection 而退出
process.on('unhandledRejection', (e) => { console.error('未处理异常：', e); app.exit(1) })

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(ROOT, 'src/main/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
}

let hudWin = null

function createHudWindow() {
  hudWin = new BrowserWindow({
    width: 680, height: 430, show: false,
    frame: false, backgroundColor: 'rgba(0,0,0,0)',
    webPreferences: {
      preload: join(ROOT, 'src/main/preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
}

async function shoot(label, query = {}, hud = false) {
  if (hud) {
    if (!hudWin) createHudWindow()
    await hudWin.loadFile(HUD, { query })
    await sleep(1100)
    const img = await hudWin.webContents.capturePage()
    writeFileSync(join(OUT, `${label}.png`), img.toPNG())
  } else {
    if (!win) createWindow()
    await win.loadFile(RENDERER, { query })
    await sleep(900)
    const img = await win.webContents.capturePage()
    writeFileSync(join(OUT, `${label}.png`), img.toPNG())
  }
  console.log('  →', label + '.png')
}

Promise.all([
  import('../src/main/store.js'),
  import('../src/main/templates.js'),
  import('../src/main/ipc.js'),
]).then(([store, templates, ipc]) => {
  ({
    load, addTheme, addNode, updateNode, addVerdict, markPromoted, addConflict, addChannel,
    settleLemma, allNodes, addInboxItem, allInbox,
  } = store)
  genericFallback = templates.genericFallback
  instantiate = templates.instantiate
  register = ipc.register
  return app.whenReady()
}).then(async () => {
  // 独立数据目录，绝不碰真实数据
  rmSync(DATA, { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  app.setPath('userData', DATA)

  load()
  register({ resizeCapture: () => {} })

  const inTheme = (t) => allNodes().filter((n) => n.themeId === t.id)
  const branchOf = (t, frag) => inTheme(t).find((n) => n.kind === 'branch' && n.title.includes(frag))

  // ---------------------------------------------------------------- 造数据
  const ai = addTheme('AI 产业链')
  instantiate(genericFallback(), (spec) => addNode({ ...spec, themeId: ai.id }))

  const gpu = branchOf(ai, '上游')
  const hbm = gpu
  const opt = branchOf(ai, '中游')
  const power = branchOf(ai, '下游')
  const trade = power

  // 多来源收敛 + 一条方向冲突
  const l1 = addNode({
    themeId: ai.id, parentId: opt.id, kind: 'lemma',
    title: '1.6T 光模块 Q3 出货 12 万只，超此前指引', type: 'observation', confidence: 85,
    tags: ['半导体周期'], settlement: { date: '2026-12-31', resolved: null, correct: null },
    sources: [
      { kind: '券商研报', label: '中信 2026-09-18' },
      { kind: '一手数据', label: '产业调研纪要' },
      { kind: '财报 / 公告', label: '公司公告' },
    ],
  })
  const l2 = addNode({
    themeId: ai.id, parentId: opt.id, kind: 'lemma',
    title: '铜连接在 3 米内可替代光模块，成本低 40%', type: 'hypothesis', confidence: 62,
    tags: ['半导体周期'],
  })
  addConflict(l1.id, l2.id, '方向相反')

  addNode({ themeId: ai.id, parentId: gpu.id, kind: 'lemma', title: '下一代产品量产推迟两个季度', type: 'observation', confidence: 79, tags: ['半导体周期'] })
  addNode({ themeId: ai.id, parentId: hbm.id, kind: 'lemma', title: 'HBM 合约价 Q4 再涨 12%', type: 'observation', confidence: 84, tags: ['半导体周期'] })
  addNode({ themeId: ai.id, parentId: power.id, kind: 'lemma', title: '某州并网队列排队 38 个月，创新高', type: 'observation', confidence: 88, tags: ['能源成本'] })
  addNode({ themeId: ai.id, parentId: trade.id, kind: 'lemma', title: '市场按增速而非利润给这一层定价', type: 'hypothesis', confidence: 72, tags: ['美元流动性'] })

  // 校准样本：让两条曲线都有形状
  for (const [c, ok] of [[52, true], [58, true], [64, false], [68, false], [72, true], [78, true], [81, false], [84, true], [88, true], [92, false]]) {
    const n = addNode({ themeId: ai.id, parentId: null, kind: 'lemma', title: `校准样本 ${c}`, confidence: c, settlement: { date: '2026-01-01' } })
    settleLemma(n.id, ok)
  }

  addNode({ themeId: ai.id, parentId: null, kind: 'lemma', title: '某野号快讯：国产加速卡流片成功', confidence: 38, status: 'cold', tags: ['能源成本'] })
  addNode({ themeId: ai.id, parentId: null, kind: 'lemma', title: '曾被证伪：HBM 供给不再是瓶颈', confidence: 8, status: 'dead' })

  // 误杀：筛掉过，其中两条后来从别的源进了图谱
  const promoted = addNode({ themeId: ai.id, parentId: null, kind: 'lemma', title: '某国产加速卡流片成功', confidence: 74, tags: ['能源成本'] })
  markPromoted(addVerdict({ gate: 'source', reason: 'low-quality', summary: '某国产加速卡流片成功', score: 0.24, choice: '自媒体' }).id, promoted.id)
  markPromoted(addVerdict({ gate: 'source', reason: 'low-quality', summary: '某云厂商暂停自研芯片', score: 0.42, choice: '自媒体' }).id, promoted.id)
  addVerdict({ gate: 'dedup', reason: 'duplicate', summary: '1.6T 光模块产能已被头部锁定', score: 0.68, choice: '券商研报' })

  // 第二个主题，共享「能源成本」→ 共同前提
  const crypto = addTheme('虚拟货币')
  instantiate(genericFallback(), (spec) => addNode({ ...spec, themeId: crypto.id }))
  const miner = branchOf(crypto, '上游')
  addNode({ themeId: crypto.id, parentId: miner.id, kind: 'lemma', title: '矿机关机价随电价上移', type: 'observation', confidence: 66, tags: ['能源成本', '半导体周期'] })
  addNode({ themeId: crypto.id, parentId: null, kind: 'lemma', title: '稳定币净发行回升', type: 'observation', confidence: 71, tags: ['美元流动性'] })

  addChannel({
    name: '失败状态示例', fetch: 'rss', kind: '独立媒体', query: 'https://example.com/feed',
    themeId: ai.id, lastError: '连接超时',
  })

  // 触发一次传导：环节有子节点，拖动它的确信度才会向下游衰减
  updateNode(opt.id, { confidence: 78 })

  // 走一遍真实的 capture:save，让原文层有数据——否则「看原文」按钮不会出现
  ipcMain.emit('capture:save', {}, {
    themeId: ai.id,
    labelKind: '一手数据',
    text: SAMPLE,
    lemmas: [{
      title: '1.6T 光模块 Q4 订单能见度排到明年 Q2，产能被头部客户锁定',
      type: 'observation', confidence: 86, action: 'new', parentId: opt.id,
      tags: ['半导体周期'], settlement: { date: '2026-12-31', resolved: null, correct: null },
    }],
  })

  const pendingItems = [
    addInboxItem({
      title: '光模块订单能见度延长，供应链出现分化',
      text: '北美云厂商新一轮采购已启动，头部光模块供应商的订单能见度延伸至明年二季度，部分产能已被提前锁定。\n\n与此同时，新进入者宣布硅光方案成本降低约 30%，预计 2027 年量产。短期交付确定性与长期技术替代，需要分开跟踪。',
      label: { kind: '券商研报', quality: 0.8, via: 'llm' },
      provenance: { platform: '产业调研纪要', url: 'https://example.com/research' },
      lemmas: [
        { title: '光模块订单能见度延伸至明年二季度', type: 'observation', confidence: 78, parentId: opt.id },
        { title: '硅光新方案有望降低 30% 的成本', type: 'hypothesis', confidence: 60, parentId: opt.id },
        { title: '头部客户提前锁定光模块产能', type: 'observation', confidence: 75, parentId: opt.id },
      ],
    }),
    addInboxItem({
      title: 'HBM 合约价继续上调，供给仍偏紧',
      text: '最新渠道调研显示，HBM 合约价在上一季度基础上继续上调。产能爬坡速度与良率仍是需要核实的变量。',
      label: { kind: '一手数据', quality: 0.9, via: 'channel' },
      lemmas: [{ title: 'HBM 合约价继续上涨', type: 'observation', confidence: 82, parentId: gpu.id }],
    }),
    addInboxItem({
      title: '铜连接替代方案进入验证阶段',
      text: '一份新纪要再次提到三米内互联可以采用铜连接，成本低于光模块。此前已有相同方向的研究记录。',
      label: { kind: '独立媒体', quality: 0.65, via: 'table' },
      lemmas: [{ title: '铜连接在短距离内可替代光模块', type: 'hypothesis', confidence: 62, action: 'merge', mergeInto: l2.id, parentId: opt.id, conflicts: [{ id: l1.id, reason: '技术路线判断不同' }] }],
    }),
    addInboxItem({
      title: '数据中心电力供给：长期跟踪记录',
      text: Array.from({ length: 18 }, (_, i) => `第 ${i + 1} 次记录：数据中心并网排队时间仍然较长。需跟踪电网改造、审批进度和实际交付，避免把远期规划当作当期供给。`).join('\n\n') + '\n<未经核实的原文标记>',
      label: { kind: '独立媒体', quality: 0.65 },
      lemmas: [{ title: '电力并网约束影响交付节奏', type: 'hypothesis', confidence: 55, parentId: power.id }],
    }),
    addInboxItem({ title: '只有线索，尚待补充证据', text: '', label: null, lemmas: [] }),
  ]

  // ---------------------------------------------------------------- 拍摄
  console.log('\n截图输出到', OUT, '\n')
  await shoot('01-empty', { view: 'settings' })

  // 设置页滚到底，看「数据」段的原文层统计与清理按钮
  if (win) {
    await win.webContents.executeJavaScript(`
      document.querySelector('.page')?.scrollTo(0, 99999)
    `)
    await sleep(400)
    writeFileSync(join(OUT, '01b-settings-data.png'), (await win.webContents.capturePage()).toPNG())
    console.log('  →', '01b-settings-data.png')
  }
  await shoot('02-lattice', { view: 'lattice' })

  // 全展开的树：导轨要对齐每一层父行的箭头，只有展开才看得见
  if (win) {
    await win.webContents.executeJavaScript(`
      for (let i = 0; i < 40; i++) {
        const el = document.querySelector('.twist[data-open="false"]')
        if (!el) break
        el.click()
      }
    `)
    await sleep(350)
    writeFileSync(join(OUT, '02b-lattice-open.png'), (await win.webContents.capturePage()).toPNG())
    console.log('  →', '02b-lattice-open.png')
  }

  await shoot('03-scaffold', { view: 'lattice', select: opt.id })
  await shoot('04-lemma', { view: 'lattice', select: l1.id })
  await shoot('05-today', { view: 'today' })
  await shoot('06-audit', { view: 'vault', vault: 'filtered' })
  await shoot('07-premise', { view: 'lattice' })
  await shoot('08-conflicts', { view: 'vault', vault: 'conflicts' })
  await shoot('09-cold', { view: 'vault', vault: 'cold' })
  await shoot('10-filtered', { view: 'vault', vault: 'filtered' })

  await shoot('11-newtheme', { newtheme: '有色金属' })

  // 产业链图：全貌 + 选中后的因果聚焦（上游凭什么成立 / 下游会被带倒几条）
  await shoot('13-graph', { view: 'lattice', shape: 'graph' })
  await shoot('14-graph-focus', { view: 'lattice', shape: 'graph', select: opt.id })
  await shoot('15-graph-stage', { view: 'lattice', shape: 'graph', select: gpu.id })

  const graphKeys = await win.webContents.executeJavaScript(`
    (async () => {
      const wrap = document.querySelector('.graph-wrap')
      const before = document.querySelector('.insp-title')?.textContent
      const noCrud = !document.querySelector('[title="新建环节"]') && !document.querySelector('.regenerate-btn')
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 120))
      const after = document.querySelector('.insp-title')?.textContent
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 120))
      return {
        noCrud,
        moved: Boolean(before && after && before !== after),
        tree: document.querySelector('.seg-shape button[aria-selected="true"]')?.textContent === '树形',
        editing: Boolean(document.querySelector('.row-edit')),
      }
    })()
  `)
  check(graphKeys.noCrud, '图形态无结构操作按钮')
  check(graphKeys.moved, '图形态 ↑↓ 移动选中')
  check(graphKeys.tree && graphKeys.editing, '图形态 Enter 回树编辑')

  await win.loadFile(RENDERER, { query: { view: 'lattice', shape: 'graph', select: opt.id } })
  await sleep(700)
  const deleteUndo = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.graph-wrap').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, bubbles: true })
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      const toast = document.querySelector('.toast')?.textContent || ''
      const softDeleted = document.querySelector('.node[data-id="${opt.id}"]')?.getAttribute('opacity') === '0.45'
      document.querySelector('.toast-btn')?.click()
      await new Promise(resolve => setTimeout(resolve, 300))
      const restored = document.querySelector('.node[data-id="${opt.id}"]')?.getAttribute('opacity') === '1'
      return { toast, softDeleted, restored }
    })()
  `)
  check(deleteUndo.softDeleted && deleteUndo.toast.includes('撤销'), '图形态 Cmd+Backspace 软删并提示撤销')
  check(deleteUndo.restored, '删除 toast 可恢复整棵子树')

  await win.loadFile(RENDERER, { query: { view: 'lattice', select: l1.id } })
  await sleep(700)
  check(await win.webContents.executeJavaScript(`document.body.textContent.includes('让 LLM 提议')`), '空指标显示单指标 LLM 提议')

  await win.loadFile(RENDERER, { query: { view: 'vault', vault: 'feeds' } })
  await sleep(700)
  const channelState = await win.webContents.executeJavaScript(`({
    lastError: document.body.textContent.includes('连接超时'),
    noReview: !document.body.textContent.includes('免复审') && !document.body.textContent.includes('需复审'),
  })`)
  check(channelState.lastError, '数据源显示 lastError')
  check(channelState.noReview, '数据源无复审状态控件')

  // 原文层：选中刚入库的那条，点开「看原文」
  if (win) {
    await win.loadFile(RENDERER, { query: { view: 'lattice' } })
    await sleep(700)
    try {
      // 包在 async IIFE 里——executeJavaScript 的顶层不能用 await
      await win.webContents.executeJavaScript(`
        (async () => {
          // 先把整棵树展开，否则新节点藏在收起的环节里，点不到
          for (let i = 0; i < 40; i++) {
            const el = document.querySelector('.twist[data-open="false"]')
            if (!el) break
            el.click()
          }
          await new Promise(r => setTimeout(r, 250))
          const row = [...document.querySelectorAll('.row')]
            .find(r => r.textContent.includes('订单能见度排到明年'))
          row?.click()
          await new Promise(r => setTimeout(r, 300))
          document.querySelector('.btn-raw')?.click()
          await new Promise(r => setTimeout(r, 400))
        })()
      `)
    } catch (e) {
      console.log('  ! 16-raw 交互失败：', e.message)
    }
    writeFileSync(join(OUT, '16-raw.png'), (await win.webContents.capturePage()).toPNG())
    console.log('  →', '16-raw.png')
  }

  await win.loadFile(RENDERER, { query: { view: 'lattice' } })
  await sleep(700)
  const themeCreation = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('[title="新建主题"]')?.click()
      const creator = document.querySelector('#themes .theme-creator')
      const singleInput = creator?.querySelectorAll('input').length === 1
      const noTemplates = !creator?.textContent.includes('模板')
      const input = creator?.querySelector('#skeleton-desc')
      input.value = '城市轨交客流与设备更新'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 700))
      const text = document.body.textContent
      return {
        singleInput,
        noTemplates,
        fallback: text.includes('上游') && text.includes('中游') && text.includes('下游'),
        notice: document.querySelector('.toast')?.textContent.includes('API key') || false,
      }
    })()
  `)
  check(themeCreation.singleInput && themeCreation.noTemplates, '新建主题只有描述输入')
  check(themeCreation.fallback, '无 key 建成领域中立上中下游骨架')
  check(themeCreation.notice, '无 key 显示降级提示')
  writeFileSync(join(OUT, '17-generic-fallback.png'), (await win.webContents.capturePage()).toPNG())
  console.log('  →', '17-generic-fallback.png')

  win.show()
  win.focus()
  win.webContents.focus()
  const tagLibraryErrors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') tagLibraryErrors.push(event.message)
  })
  const tagLibraryLayout = await win.webContents.executeJavaScript(`
    (async () => {
      const { state, refresh } = await import('./app.js')
      await window.meridian.themeUpdate(state.themeId, {
        tagLibrary: Array.from({ length: 40 }, (_, i) => ({
          id: 'tag-' + i, name: '测试标签 ' + (i + 1), synonyms: ['别名 ' + i],
          threshold: 0.6, hits: 0, lastHitAt: null,
        })),
      })
      await refresh()
      const header = [...document.querySelectorAll('#mid .sect-h')].find(el => el.textContent.includes('标签库'))
      header.click()
      const body = header.parentElement.querySelector('.sect-b')
      const tree = document.querySelector('.tree-wrap, .graph-debug')
      return {
        scrollable: body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto',
        treeVisible: tree.getBoundingClientRect().height > 150 && tree.getBoundingClientRect().bottom <= innerHeight,
      }
    })()
  `)
  await sleep(200)
  writeFileSync(join(OUT, '18-tag-library.png'), (await win.webContents.capturePage()).toPNG())
  check(tagLibraryLayout.scrollable, '标签库长列表可独立向下滚动')
  check(tagLibraryLayout.treeVisible, '展开标签库不会挤掉下方树或图')

  const scrollTarget = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.tag-library-body').getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  win.webContents.sendInputEvent({ type: 'mouseWheel', ...scrollTarget, deltaY: -5000, deltaX: 0 })
  await sleep(200)
  check(await win.webContents.executeJavaScript(`document.querySelector('.tag-library-body').scrollTop > 0`), '鼠标滚轮可向下浏览标签')

  await win.webContents.executeJavaScript(`document.querySelector('.tag-library-toggle').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await sleep(100)
  check(await win.webContents.executeJavaScript(`
    document.querySelector('.tag-library-toggle').getAttribute('aria-expanded') === 'false' &&
    document.querySelector('.tag-library-body').hidden &&
    document.activeElement.matches('.tag-library-toggle')
  `), '空格收起标签库且焦点不丢失')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await sleep(100)
  check(await win.webContents.executeJavaScript(`
    document.querySelector('.tag-library-toggle').getAttribute('aria-expanded') === 'true' &&
    !document.querySelector('.tag-library-body').hidden
  `), '回车重新展开标签库')

  const tagLibrarySave = await win.webContents.executeJavaScript(`
    (async () => {
      const { state } = await import('./app.js')
      document.querySelector('.tag-library-body .q').click()
      document.querySelector('.tag-library-body input').value = '修改后的标签'
      document.querySelector('.tag-library-body .btn-primary').click()
      await new Promise(resolve => setTimeout(resolve, 300))
      const saved = (await window.meridian.themes()).find(t => t.id === state.themeId).tagLibrary[0].name
      return saved === '修改后的标签' &&
        document.querySelector('.tag-library-toggle').getAttribute('aria-expanded') === 'true' &&
        document.querySelector('.tag-library-body').textContent.includes('修改后的标签')
    })()
  `)
  check(tagLibrarySave, '保存标签后刷新仍保持展开')

  const themeSwitch = await win.webContents.executeJavaScript(`
    (async () => {
      const currentName = document.querySelector('.theme-item[aria-selected="true"] span:nth-child(2)').textContent
      const otherTheme = [...document.querySelectorAll('.theme-item')].find(el => el.textContent.includes('AI 产业链'))
      otherTheme.click()
      await new Promise(resolve => setTimeout(resolve, 250))
      const separate = document.querySelector('.tag-library-toggle').getAttribute('aria-expanded') === 'false'
      document.querySelector('.tag-library-toggle').click()
      const empty = document.querySelector('.tag-library-body').textContent.includes('暂无标签库')
      const originalTheme = [...document.querySelectorAll('.theme-item')].find(el => el.textContent.includes(currentName))
      originalTheme.click()
      await new Promise(resolve => setTimeout(resolve, 250))
      return {
        separate, empty,
        retained: document.querySelector('.tag-library-toggle').getAttribute('aria-expanded') === 'true',
      }
    })()
  `)
  check(themeSwitch.separate && themeSwitch.retained, '切换主题分别保留标签库展开状态')
  check(themeSwitch.empty, '空标签库也可展开并显示空态')

  win.setSize(1000, 680)
  await win.webContents.executeJavaScript(`(async () => {
    const { setShape } = await import('./app.js')
    setShape('tree')
  })()`)
  await sleep(200)
  check(await win.webContents.executeJavaScript(`(() => {
    const tree = document.querySelector('.tree-wrap').getBoundingClientRect()
    const header = document.querySelector('.tag-library-toggle').getBoundingClientRect()
    return tree.height > 150 && tree.bottom <= innerHeight && header.right <= innerWidth &&
      document.querySelector('.tag-library-toggle').getAttribute('aria-expanded') === 'true'
  })()`), '小窗口切回树形仍可展开标签库并查看树')
  writeFileSync(join(OUT, '19-tag-library-tree.png'), (await win.webContents.capturePage()).toPNG())
  check(tagLibraryErrors.length === 0, '标签库交互无渲染器错误：' + tagLibraryErrors.join('; '))

  const todayErrors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') todayErrors.push(event.message)
  })
  win.setSize(1280, 820)
  await win.loadFile(RENDERER, { query: { view: 'today' } })
  await sleep(500)
  const inboxInitial = await win.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.inbox-workspace').getBoundingClientRect()
    const mid = document.querySelector('#mid').getBoundingClientRect()
    return {
      fullWidth: workspace.width > mid.width * 0.9,
      selected: document.querySelector('.inbox-item[data-sel="true"]').dataset.id,
      original: document.querySelector('.inbox-original-text').textContent,
      count: document.querySelectorAll('.inbox-proposals li').length,
      source: !!document.querySelector('.inbox-source-link'),
      noBatchSelection: document.querySelector('.inbox-import-picked').disabled,
    }
  })()`)
  check(inboxInitial.fullWidth && inboxInitial.selected === pendingItems[0].id, '今日铺满可用宽度并默认显示首条详情')
  check(inboxInitial.original === pendingItems[0].text && inboxInitial.count === 3 && inboxInitial.source, '阅读面板展示完整原文、命题及来源入口')
  check(inboxInitial.noBatchSelection, '阅读选中与批量勾选相互独立')

  await win.webContents.executeJavaScript(`document.querySelector('.inbox-body').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
  await sleep(100)
  check(await win.webContents.executeJavaScript(`document.querySelector('.inbox-item[data-sel="true"]').dataset.id`) === pendingItems[1].id, '方向键在待确认列表中切换详情')

  const draftPreserved = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#inbox-textarea')
    input.value = '尚未提交的原文草稿'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.inbox-pick-all').click()
    const allPicked = document.querySelectorAll('.inbox-ck:checked').length === 4
    document.querySelector('.inbox-pick-all').click()
    const cleared = document.querySelector('.inbox-import-picked').disabled
    const { refresh } = await import('./app.js')
    await refresh()
    await new Promise(resolve => setTimeout(resolve, 200))
    const retained = document.querySelector('#inbox-textarea').value === '尚未提交的原文草稿' &&
      document.querySelector('.inbox-item[data-sel="true"]').dataset.id === '${pendingItems[1].id}'
    return allPicked && cleared && retained
  })()`)
  check(draftPreserved, '全选/取消生效，刷新保留草稿与当前阅读条目')

  let finishCapture
  ipcMain.removeHandler('inbox:capture')
  ipcMain.handle('inbox:capture', () => new Promise(resolve => { finishCapture = resolve }))
  await win.webContents.executeJavaScript(`document.querySelector('.inbox-capture').click()`)
  await sleep(200)
  check(typeof finishCapture === 'function' && await win.webContents.executeJavaScript(`
    !!document.querySelector('.inbox-capture-status') && document.querySelectorAll('.inbox-item').length === 5
  `), '捕获进行中保留已有待确认列表')
  await win.webContents.executeJavaScript(`document.querySelectorAll('.inbox-body')[2].click()`)
  check(await win.webContents.executeJavaScript(`document.querySelector('.inbox-item[data-sel="true"]').dataset.id`) === pendingItems[2].id, '捕获进行中仍可阅读其他信息')
  check(await win.webContents.executeJavaScript(`
    !document.querySelector('#inbox-confidence') && !document.querySelector('#inbox-parent') &&
    document.querySelector('.inbox-proposals').textContent.includes('保留原置信度与挂点')
  `), '合并来源显示真实目标，不提供无效的置信度和挂点编辑')
  await win.webContents.executeJavaScript(`(async () => {
    const { setView } = await import('./app.js')
    setView('settings')
  })()`)
  finishCapture({ ok: true, autoImported: false })
  await sleep(250)
  check(await win.webContents.executeJavaScript(`document.querySelector('.app').dataset.view === 'settings' && !document.querySelector('#inbox-section')`), '后台捕获完成不会抢回当前页面')
  await win.webContents.executeJavaScript(`(async () => {
    const { setView } = await import('./app.js')
    setView('today')
  })()`)
  await sleep(250)

  ipcMain.removeHandler('inbox:capture')
  ipcMain.handle('inbox:capture', () => { throw new Error('模拟捕获失败') })
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#inbox-textarea')
    input.value = '失败后不能丢失的原文'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.inbox-capture').click()
  })()`)
  await sleep(250)
  check(await win.webContents.executeJavaScript(`
    document.querySelector('#inbox-textarea').value === '失败后不能丢失的原文' &&
    !document.querySelector('.inbox-capture').disabled &&
    document.querySelectorAll('.inbox-item').length === 5
  `), '捕获失败保留原文并恢复重试入口')

  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#inbox-textarea')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelectorAll('.toast').forEach(el => el.remove())
    document.querySelector('.inbox-body').click()
    const slider = document.querySelector('#inbox-confidence')
    slider.value = '61'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    const parent = document.querySelector('#inbox-parent')
    parent.value = '${gpu.id}'
    parent.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector('.inbox-map').open = true
    document.querySelector('.mini-node[data-id="${power.id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.querySelector('.inbox-detail-scroll').scrollTop = 10000
  })()`)
  check(await win.webContents.executeJavaScript(`
    document.querySelector('.inbox-conf-val').value === '61' &&
    document.querySelector('#inbox-parent').value === '${power.id}' &&
    !!document.querySelector('.mini-node[data-parent="true"][data-id="${power.id}"]')
  `), '置信度实时显示，图与下拉挂点双向同步')
  const crossThemeRouting = await win.webContents.executeJavaScript(`(async () => {
    const { state, refresh } = await import('./app.js')
    const originalTheme = state.themeId
    state.themeId = state.themes.find(theme => theme.id !== originalTheme).id
    await refresh()
    await new Promise(resolve => setTimeout(resolve, 200))
    const blocked = document.querySelector('.inbox-confirm').disabled && !document.querySelector('.inbox-route-warning').hidden
    const parent = document.querySelector('#inbox-parent')
    parent.value = ''
    parent.dispatchEvent(new Event('change', { bubbles: true }))
    const canChooseRoot = !document.querySelector('.inbox-confirm').disabled
    state.themeId = originalTheme
    await refresh()
    await new Promise(resolve => setTimeout(resolve, 200))
    return blocked && canChooseRoot && document.querySelector('#inbox-parent').value === '${power.id}' &&
      document.querySelector('.inbox-conf-val').value === '61'
  })()`)
  check(crossThemeRouting, '切换主题隔离编辑值，不能把信息挂到其他主题的节点')
  await win.webContents.executeJavaScript(`
    document.querySelector('.inbox-map').open = true
    document.querySelector('.inbox-detail-scroll').scrollTop = 10000
  `)
  await sleep(150)
  writeFileSync(join(OUT, '20-today-routing.png'), (await win.webContents.capturePage()).toPNG())

  for (const width of [1000, 900, 840]) {
    win.setSize(width, 740)
    await sleep(100)
    const layout = await win.webContents.executeJavaScript(`(() => {
      const page = document.querySelector('.today-page')
      const detail = document.querySelector('.inbox-detail').getBoundingClientRect()
      const footer = document.querySelector('.inbox-detail-actions').getBoundingClientRect()
      return {
        pageWidth: page.clientWidth, scrollWidth: page.scrollWidth, detailWidth: detail.width,
        footerBottom: footer.bottom, detailBottom: detail.bottom,
        readingHeight: document.querySelector('.inbox-detail-scroll').clientHeight,
      }
    })()`)
    writeFileSync(join(OUT, '21-today-' + width + '.png'), (await win.webContents.capturePage()).toPNG())
    check(layout.scrollWidth <= layout.pageWidth + 1 && layout.detailWidth > 280 &&
      layout.footerBottom <= layout.detailBottom + 1 && layout.readingHeight > 80,
    '今日在 ' + width + 'px 窗口无横向溢出且操作栏可见 ' + JSON.stringify(layout))
  }
  win.setSize(1280, 820)
  const nativeTheme = globalThis.__electron.nativeTheme
  const previousTheme = nativeTheme.themeSource
  nativeTheme.themeSource = 'dark'
  await win.webContents.executeJavaScript(`document.querySelector('.inbox-detail-scroll').scrollTop = 0`)
  await sleep(200)
  writeFileSync(join(OUT, '22-today-dark.png'), (await win.webContents.capturePage()).toPNG())
  nativeTheme.themeSource = previousTheme

  await win.webContents.executeJavaScript(`document.querySelector('.inbox-confirm').click()`)
  await sleep(300)
  const confirmed = allNodes().filter(node => pendingItems[0].lemmas.some(lemma => lemma.title === node.title))
  check(confirmed.length === 3 && confirmed.every(node => node.parentId === power.id && node.confidence === 61), '单条确认保留全部命题并应用置信度/挂点调整')
  check(!allInbox().some(item => item.id === pendingItems[0].id), '确认后条目从待确认队列移除')
  check(await win.webContents.executeJavaScript(`document.querySelector('.inbox-item[data-sel="true"]').dataset.id`) === pendingItems[1].id, '处理完成自动选择下一条')
  await win.webContents.executeJavaScript(`document.querySelector('.inbox-reject').click()`)
  await sleep(250)
  check(!allInbox().some(item => item.id === pendingItems[1].id), '忽略条目仍走原有拒绝流程')

  await win.webContents.executeJavaScript(`document.querySelector('.inbox-item[data-id="${pendingItems[3].id}"] .inbox-body').click()`)
  check(await win.webContents.executeJavaScript(`(() => {
    const body = document.querySelector('.inbox-detail-scroll')
    const original = document.querySelector('.inbox-original-text')
    return body.scrollHeight > body.clientHeight && original.textContent.includes('第 18 次记录') &&
      original.textContent.includes('<未经核实的原文标记>') && original.children.length === 0
  })()`), '长原文独立滚动，文本标记不会作为 HTML 执行')
  await win.webContents.executeJavaScript(`document.querySelector('.inbox-item[data-id="${pendingItems[4].id}"] .inbox-body').click()`)
  check(await win.webContents.executeJavaScript(`document.querySelector('.inbox-confirm').disabled && document.querySelector('.inbox-detail-note').textContent.includes('未提取')`), '没有命题的条目展示说明且不能空入库')
  await win.webContents.executeJavaScript(`
    document.querySelector('.inbox-pick-all').click()
    document.querySelector('.inbox-import-picked').click()
  `)
  await sleep(300)
  check(allInbox().length === 1 && allInbox()[0].id === pendingItems[4].id, '批量入库只处理勾选且可入库的条目')
  await win.webContents.executeJavaScript(`document.querySelector('.inbox-reject').click()`)
  await sleep(250)
  check(allInbox().length === 0 && await win.webContents.executeJavaScript(`!!document.querySelector('.inbox-empty-state') && !document.querySelector('.inbox-detail')`), '全部处理后显示完整空态而非空白阅读栏')
  writeFileSync(join(OUT, '23-today-empty.png'), (await win.webContents.capturePage()).toPNG())
  addNode({
    themeId: ai.id, parentId: opt.id, kind: 'lemma', title: '今日结算跳转验收', confidence: 60,
    settlement: { date: new Date().toISOString().slice(0, 10), resolved: null, correct: null },
  })
  await win.webContents.executeJavaScript(`(async () => {
    const { refresh } = await import('./app.js')
    await refresh()
  })()`)
  await sleep(200)
  await win.webContents.executeJavaScript(`document.querySelector('#due-section .btn-hit').click()`)
  await sleep(400)
  check(await win.webContents.executeJavaScript(`document.querySelector('.app').dataset.view === 'lattice' && !!document.querySelector('.graph-wrap .node')`), '结算后跳转脉络不会被今日的异步渲染清空')
  check(todayErrors.length === 0, '今日交互无渲染器错误：' + todayErrors.join('; '))

  console.log('\n完成\n')
  app.exit(0)
})
