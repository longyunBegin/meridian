/**
 * 用真实引擎（src/main/store.js）算出宣传片使用的数字。
 * 片子里出现的每个置信度、变化量、校准命中率都来自这里，不手写。
 *
 * 做法与 test/engine.test.mjs 相同：把 store.js 复制到临时目录，替换掉 electron 依赖后动态导入。
 * 数据目录是独立的临时目录，不碰真实账本。引擎在一个进程里只加载一次（模块有内存状态）。
 *
 * 运行：node tools/film/chain.mjs [输出路径]
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = join(ROOT, 'test/.tmp/film-engine')
const DATA = join(WORK, 'data')

/** 产业链：上游 → 下游。propagation 是该节点向下游传导的权重。 */
export const TREE = [
  { key: 'optics',  title: '光模块',     parent: null,      propagation: 0.6, confidence: 70, kind: 'branch' },
  { key: 'capex',   title: '云 CapEx',   parent: 'optics',  propagation: 0.4, confidence: 61, kind: 'branch' },
  { key: 'apps',    title: '应用爆发',   parent: 'capex',   propagation: 0.5, confidence: 51, kind: 'lemma' },
  { key: 'power',   title: '数据中心电力', parent: 'capex', propagation: 0.5, confidence: 58, kind: 'lemma' },
  { key: 'paying',  title: '企业付费',   parent: 'apps',    propagation: 0.4, confidence: 44, kind: 'branch' },
  { key: 'renew',   title: '订阅续费',   parent: 'paying',  propagation: 0.4, confidence: 38, kind: 'branch' },
  { key: 'produce', title: '生产率拐点', parent: 'renew',   propagation: 0.5, confidence: 30, kind: 'lemma' },
]
export const ORIGIN = { key: 'optics', to: 85 }

/**
 * 校准演示的合成样本：五个信心档位轮流出题，早期系统性过度自信，偏差随结算次数指数消退。
 * 命中与否用误差扩散决定（不用随机数），每档命中率精确跟随目标概率，结果可复现。
 */
export const CALIB = {
  confidences: [55, 65, 75, 85, 95],
  total: 120,
  biasStart: 0.35,
  biasTau: 15,
  snapshots: [10, 25, 50, 85, 120],
}

let enginePromise = null

function replaceExact(src, from, to) {
  if (!src.includes(from)) throw new Error(`store.js 中找不到待替换片段：${from}`)
  return src.replace(from, to)
}

export function engine() {
  if (enginePromise) return enginePromise
  enginePromise = (async () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(join(WORK, 'service'), { recursive: true })
    for (const f of ['crypto.js', 'llmlog.js', 'reading-store.js']) {
      writeFileSync(join(WORK, f), readFileSync(join(ROOT, 'src/main', f), 'utf8'))
    }
    writeFileSync(join(WORK, 'service/db-schema.mjs'), readFileSync(join(ROOT, 'service/db-schema.mjs'), 'utf8'))
    let src = readFileSync(join(ROOT, 'src/main/store.js'), 'utf8')
    src = replaceExact(src, 'const { app } = globalThis.__electron', `const app = { getPath: () => ${JSON.stringify(DATA)} }`)
    src = replaceExact(src, "'../../service/db-schema.mjs'", "'./service/db-schema.mjs'")
    const file = join(WORK, 'store.film.mjs')
    writeFileSync(file, src)
    const s = await import(pathToFileURL(file).href)
    s.load()
    return s
  })()
  return enginePromise
}

export async function runChain() {
  const s = await engine()
  const theme = s.addTheme('光互连')
  const ids = new Map()
  for (const n of TREE) {
    const node = s.addNode({
      themeId: theme.id,
      parentId: n.parent ? ids.get(n.parent) : null,
      kind: n.kind,
      title: n.title,
      propagation: n.propagation,
      confidence: n.confidence,
    })
    ids.set(n.key, node.id)
  }
  const before = new Map(TREE.map((n) => [n.key, s.getNode(ids.get(n.key)).confidence]))
  s.updateNode(ids.get(ORIGIN.key), { confidence: ORIGIN.to })
  const nodes = TREE.map((n) => {
    const live = s.getNode(ids.get(n.key))
    return {
      key: n.key,
      title: n.title,
      parent: n.parent,
      propagation: live.propagation,
      before: before.get(n.key),
      after: live.confidence,
    }
  })
  return { theme: theme.name, origin: ORIGIN.key, nodes }
}

/** 逐条结算合成判断，在指定条数处快照引擎的 calibration()。 */
export async function runCalibration() {
  const s = await engine()
  if (s.calibration().length !== 0) throw new Error('校准演示前账本里已有结算记录，快照会被污染')
  const theme = s.addTheme('校准演示')
  const carry = new Map(CALIB.confidences.map((c) => [c, 0]))
  const snapshots = []
  for (let i = 0; i < CALIB.total; i++) {
    const conf = CALIB.confidences[i % CALIB.confidences.length]
    const bias = CALIB.biasStart * Math.exp(-i / CALIB.biasTau)
    const p = Math.max(0, Math.min(1, conf / 100 - bias))
    const acc = carry.get(conf) + p
    const hit = acc >= 1
    carry.set(conf, hit ? acc - 1 : acc)
    const node = s.addNode({
      themeId: theme.id,
      kind: 'lemma',
      title: `校准样本 ${i + 1}`,
      confidence: conf,
      settlement: { date: '2026-12-31', resolved: null, correct: null },
    })
    s.settleLemma(node.id, hit)
    if (CALIB.snapshots.includes(i + 1)) {
      snapshots.push({ settled: i + 1, buckets: s.calibration() })
    }
  }
  if (snapshots.length !== CALIB.snapshots.length) throw new Error('校准快照数量不符')
  return { confidences: CALIB.confidences, snapshots }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] || join(ROOT, 'test/.tmp/film/chain.json')
  const chain = await runChain()
  const calib = await runCalibration()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ chain, calib }, null, 2))
  for (const n of chain.nodes) {
    const d = n.after - n.before
    console.log(`${n.title.padEnd(8, '　')} ${n.before} → ${n.after}  ${d > 0 ? '+' : ''}${d}`)
  }
  for (const snap of calib.snapshots) {
    console.log(`已结算 ${String(snap.settled).padStart(3)}：` + snap.buckets.map((b) => `${b.bucket}档 ${Math.round(b.accuracy * 100)}%`).join('  '))
  }
  console.log('→', out)
}
