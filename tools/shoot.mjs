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
const { app, BrowserWindow, ipcMain } = globalThis.__electron || {}
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  load, addTheme, addNode, updateNode, addVerdict, markPromoted, addConflict,
  settleLemma, allNodes,
} from '../src/main/store.js'
import { find as tplFind, instantiate } from '../src/main/templates.js'
import { register } from '../src/main/ipc.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const RENDERER = join(ROOT, 'src/renderer/index.html')
const HUD = join(ROOT, 'src/renderer/capture.html')
const OUT = '/tmp/meridian-shots'
const DATA = '/tmp/meridian-shoot-data'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      preload: join(ROOT, 'src/main/preload.js'),
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
      preload: join(ROOT, 'src/main/preload.js'),
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

app.whenReady().then(async () => {
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
  instantiate(tplFind('ai-chain'), (spec) => addNode({ ...spec, themeId: ai.id }))

  const gpu = branchOf(ai, 'GPU')
  const hbm = branchOf(ai, 'HBM')
  const opt = branchOf(ai, '光模块')
  const power = branchOf(ai, '电力')
  const trade = branchOf(ai, '估值锚')

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
  instantiate(tplFind('crypto'), (spec) => addNode({ ...spec, themeId: crypto.id }))
  const miner = branchOf(crypto, '矿机')
  addNode({ themeId: crypto.id, parentId: miner.id, kind: 'lemma', title: '矿机关机价随电价上移', type: 'observation', confidence: 66, tags: ['能源成本', '半导体周期'] })
  addNode({ themeId: crypto.id, parentId: null, kind: 'lemma', title: '稳定币净发行回升', type: 'observation', confidence: 71, tags: ['美元流动性'] })

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
  await shoot('05-settle', { view: 'settle' })
  await shoot('06-audit', { view: 'audit' })
  await shoot('07-premise', { view: 'premise' })
  await shoot('08-conflicts', { view: 'vault', vault: 'conflicts' })
  await shoot('09-cold', { view: 'vault', vault: 'cold' })
  await shoot('10-filtered', { view: 'vault', vault: 'filtered' })

  await shoot('11-hud', { text: SAMPLE, autorun: '1' }, true)
  await shoot('12-newtheme', { newtheme: '有色金属' })

  // 产业链图：全貌 + 选中后的因果聚焦（上游凭什么成立 / 下游会被带倒几条）
  await shoot('13-graph', { view: 'lattice', shape: 'graph' })
  await shoot('14-graph-focus', { view: 'lattice', shape: 'graph', select: opt.id })
  await shoot('15-graph-stage', { view: 'lattice', shape: 'graph', select: gpu.id })

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

  console.log('\n完成\n')
  app.exit(0)
})
