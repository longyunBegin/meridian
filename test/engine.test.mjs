/**
 * 引擎测试：传导、结算、校准曲线、来源收敛度、误杀审计、共同前提、级联删除、模板。
 * 运行：npm test
 *
 * store.js 顶部 `import { app } from 'electron'`，Node 下没有这个模块，
 * 所以先把它替换成 stub 再动态导入。替换只针对副本，不动源码。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src/main/store.js')
const TMP_DIR = join(ROOT, 'test/.tmp')
const TMP = join(TMP_DIR, 'store.under-test.mjs')
const DATA = join(TMP_DIR, 'data')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}

mkdirSync(TMP_DIR, { recursive: true })
writeFileSync(TMP, readFileSync(SRC, 'utf8').replace(
  "import { app } from 'electron'",
  `const app = { getPath: () => ${JSON.stringify(DATA)} }`,
))
rmSync(DATA, { recursive: true, force: true })

const s = await import(TMP)
const { load, addNode, updateNode, repropagate, settleLemma, calibration, dueSettlements, descendants, stats } = s
load()

// ---------- 一棵产业链：上游 → 中游 → 下游 ----------
const theme = s.addTheme('测试主题')
const gpu = addNode({ themeId: theme.id, parentId: null, kind: 'branch', title: 'GPU', propagation: 0.5, confidence: 80 })
const cloud = addNode({ themeId: theme.id, parentId: gpu.id, kind: 'branch', title: '云 CapEx', propagation: 0.5, confidence: 60 })
const app_ = addNode({ themeId: theme.id, parentId: cloud.id, kind: 'lemma', title: '应用爆发', confidence: 50, type: 'hypothesis' })
const hbm = addNode({ themeId: theme.id, parentId: gpu.id, kind: 'lemma', title: 'HBM 涨价', confidence: 40, type: 'observation' })

console.log('\n— 传导：GPU +20，权重 0.5 → 云 +10 → 应用 +5 (0.5×0.5) —')
updateNode(gpu.id, { confidence: 100 })
ok('GPU 被更新为 100', gpu.confidence === 100)
ok('云传导到 70', Math.abs(cloud.confidence - 70) < 0.01, `实际 ${cloud.confidence}`)
ok('应用传导到 55', Math.abs(app_.confidence - 55) < 0.01, `实际 ${app_.confidence}`)
ok('兄弟节点 HBM 同受 +10', Math.abs(hbm.confidence - 50) < 0.01, `实际 ${hbm.confidence}`)
ok('应用记录了传导历史', app_.history.some((h) => h.by === 'propagation'))
ok('幅度 <1 不传导', (() => {
  const before = hbm.confidence
  updateNode(gpu.id, { confidence: 100 })
  return hbm.confidence === before
})())

console.log('\n— 只向下游传，不向上污染 —')
updateNode(app_.id, { confidence: 0 })
ok('应用为 0', app_.confidence === 0)
ok('跌破 20 自动进墓碑区', app_.status === 'dead')
updateNode(app_.id, { confidence: 50, status: 'live' })
ok('云未被反向污染', Math.abs(cloud.confidence - 70) < 0.01, `实际 ${cloud.confidence}`)
ok('GPU 未被反向污染', gpu.confidence === 100)

console.log('\n— 调节权重后重算子树 —')
updateNode(cloud.id, { propagation: 0.2 })
repropagate(gpu.id)
ok('应用按新权重重算为 52', Math.abs(app_.confidence - 52) < 0.01, `实际 ${app_.confidence}`)
ok('云仍为 70', Math.abs(cloud.confidence - 70) < 0.01, `实际 ${cloud.confidence}`)

console.log('\n— 结算与校准曲线 —')
const { list, find, instantiate } = await import(join(ROOT, 'src/main/templates.js'))
const settleTheme = s.addTheme('结算主题')
const p1 = addNode({ themeId: settleTheme.id, parentId: null, kind: 'lemma', title: '90% 确信', confidence: 90, settlement: { date: '2026-01-01' } })
const p2 = addNode({ themeId: settleTheme.id, parentId: null, kind: 'lemma', title: '90% 错', confidence: 92, settlement: { date: '2026-01-01' } })
const p3 = addNode({ themeId: settleTheme.id, parentId: null, kind: 'lemma', title: '50% 中', confidence: 55, settlement: { date: '2026-01-01' } })
const future = addNode({ themeId: settleTheme.id, parentId: null, kind: 'lemma', title: '未到期', confidence: 50, settlement: { date: '2099-01-01' } })

ok('到期未结算有 3 条', dueSettlements().length === 3, `实际 ${dueSettlements().length}`)
settleLemma(p1.id, true)
settleLemma(p2.id, false)
settleLemma(p3.id, true)
ok('结算后不再到期', dueSettlements().length === 0)
ok('未到期的仍不出现', !dueSettlements().some((n) => n.id === future.id))

const cal = calibration()
const b90 = cal.find((b) => b.bucket === 90)
const b50 = cal.find((b) => b.bucket === 50)
ok('90 分桶命中率 50%', b90 && b90.total === 2 && b90.accuracy === 0.5, JSON.stringify(b90))
ok('50 分桶命中率 100%', b50 && b50.total === 1 && b50.accuracy === 1, JSON.stringify(b50))

console.log('\n— 来源收敛度：同一条 claim 多源只累加不新建 —')
const conv = addNode({
  themeId: theme.id, parentId: null, kind: 'lemma', title: '1.6T 光模块出货超预期', confidence: 60,
  sources: [{ kind: '券商研报', label: '中信', quality: 0.8 }],
})
ok('初始 1 个来源', conv.sources.length === 1)
s.addSource(conv.id, { kind: '财报 / 公告', label: '公司公告', quality: 0.95 })
ok('追加后 2 个来源', conv.sources.length === 2, `实际 ${conv.sources.length}`)
s.addSource(conv.id, { kind: '财报 / 公告', label: '公司公告', quality: 0.95 })
ok('同源同出处不重复计数', conv.sources.length === 2, `实际 ${conv.sources.length}`)
s.addSource(conv.id, { kind: '一手数据', label: '调研纪要', quality: 0.9 })
ok('不同出处照常累加', conv.sources.length === 3, `实际 ${conv.sources.length}`)
ok('质量分由表裁决而非传入值', conv.sources[1].quality === 0.95)

console.log('\n— 去重：相似命题被识别为同一条 claim —')
const dup = s.findSimilar('1.6T 光模块出货超预期，产能锁定', theme.id)
ok('找到同一条 claim', dup.length > 0 && dup[0].node.id === conv.id, JSON.stringify(dup[0]?.score))
ok('无关内容不被判重', s.findSimilar('某公司管理层发生变动', theme.id).length === 0)

console.log('\n— 误杀审计：被筛掉的后来进了图谱才算误杀 —')
const v = s.addVerdict({ gate: 'source', reason: 'low-quality', summary: '某国产加速卡流片成功', score: 0.24, choice: '自媒体' })
const promoted = addNode({ themeId: theme.id, parentId: null, kind: 'lemma', title: '某国产加速卡流片成功', confidence: 70 })
s.markPromoted(v.id, promoted.id)
const audit = s.falseKillAudit(365)
ok('误杀计数 1', audit.missed === 1, `实际 ${audit.missed}`)
ok('误杀条目带回了节点', audit.items.length === 1 && audit.items[0].node.id === promoted.id)
ok('误杀率可算', audit.rate > 0 && audit.rate <= 1, String(audit.rate))
const fc = s.filterCalibration()
ok('过滤器分桶覆盖 0–1', fc.length === 4 && fc[0].lo === 0 && fc.at(-1).hi === 1)
ok('低分桶有一次误杀', fc[0].missed === 1, JSON.stringify(fc[0]))

console.log('\n— 冲突：方向相反的兄弟命题被登记，可裁决 —')
const cf = s.addConflict(app_.id, hbm.id, '方向相反')
ok('冲突已登记', !!cf && s.conflictsOf(app_.id).length === 1)
ok('重复登记不产生第二条', s.addConflict(hbm.id, app_.id, 'x') === cf)
s.resolveConflict(cf.id, 'a')
ok('裁决后不再待处理', s.conflictsOf(app_.id).length === 0)

console.log('\n— 共同前提：同一 tag 跨主题即共享 —')
const t2 = s.addTheme('第二主题')
const n1 = addNode({ themeId: theme.id, parentId: null, kind: 'lemma', title: '电价上行压制 IDC', confidence: 60, tags: ['能源成本'] })
addNode({ themeId: t2.id, parentId: null, kind: 'lemma', title: '矿机关机价上移', confidence: 60, tags: ['能源成本'] })
const prem = s.sharedPremises()
const hit = prem.find((p) => p.tag === '能源成本')
ok('识别出跨主题共同前提', !!hit)
ok('共同前提覆盖两个主题', hit && hit.themes.length === 2, JSON.stringify(hit?.themes.map((t) => t.name)))
ok('共同前提统计受影响命题数', hit && hit.affected === 2, `实际 ${hit?.affected}`)
ok('单主题 tag 不算共同前提', !prem.some((p) => p.tag === '仅此一家'))

console.log('\n— 冷库 / 墓碑 —')
const cold = addNode({ themeId: theme.id, parentId: null, kind: 'lemma', title: '冷库候选', confidence: 40, status: 'cold' })
ok('冷库节点可查', (await s.allNodes()).some((n) => n.id === cold.id && n.status === 'cold'))
const dying = addNode({ themeId: theme.id, parentId: null, kind: 'lemma', title: '将死', confidence: 25 })
updateNode(dying.id, { confidence: 5 })
ok('跌破 20 自动进墓碑区', dying.status === 'dead')
updateNode(dying.id, { confidence: 60 })
ok('回升自动回主图谱', dying.status === 'live')
ok('墓碑节点不再被传导', (() => {
  const tomb = addNode({ themeId: theme.id, parentId: gpu.id, kind: 'lemma', title: '墓碑子节点', confidence: 50, status: 'dead' })
  const before = tomb.confidence
  updateNode(gpu.id, { confidence: 40 })
  return tomb.confidence === before
})())

console.log('\n— 删除级联 —')
const before = stats().lemmas
s.removeNode(gpu.id)
ok('子树被删除', descendants(gpu.id).length === 0 && s.getNode(app_.id) === null)
ok('命题数减少', stats().lemmas < before, `${before} → ${stats().lemmas}`)
ok('冲突引用被清理', s.allConflicts().every((c) => s.getNode(c.a) && s.getNode(c.b)))

console.log('\n— 模板实例化 —')
const tpl = find('ai-chain')
const t3 = s.addTheme('模板主题')
const roots = instantiate(tpl, (spec) => addNode({ ...spec, themeId: t3.id }))
const created = s.allNodes().filter((n) => n.themeId === t3.id)

ok('模板铺出 5 个根环节', roots.length === 5, `实际 ${roots.length}`)
ok('上游环节含 5 个子项', s.childrenOf(roots[1]).length === 5, `实际 ${s.childrenOf(roots[1]).length}`)
ok('所有模板节点都是环节', created.every((n) => n.kind === 'branch'))
ok('没有重复 id', new Set(s.allNodes().map((n) => n.id)).size === s.allNodes().length)

const leaves = s.childrenOf(roots[1]).map((n) => n.id)
ok('叶子环节都挂了 scaffold', leaves.every((id) => s.getNode(id)?.scaffold?.answer?.length))
ok('分组层不继承子层的 scaffold', !roots.some((id) => s.getNode(id)?.scaffold), roots.map((id) => s.getNode(id).title).join(','))
ok('scaffold 含指标与证伪信号', created.filter((n) => n.scaffold).every((n) => n.scaffold.indicators?.length && n.scaffold.falsifier))

console.log('\n— 从骨架生成命题（结算日由更新频率推导）—')
const leaf = s.childrenOf(roots[1])[0]
const spawned = s.spawnFromScaffold(leaf.id)
ok('生成了命题', spawned.length > 0, `实际 ${spawned.length}`)
ok('全部挂在父环节下', spawned.every((n) => n.parentId === leaf.id && n.kind === 'lemma'))
ok('分组层本身没有 scaffold，不生成', s.spawnFromScaffold(roots[1]).length === 0)
ok('指标命题带结算日', spawned.filter((n) => n.settlement?.date).length > 0)
ok('季度节奏的结算日在 90 天左右', spawned.some((n) => {
  const d = n.settlement?.date
  if (!d) return false
  const days = (Date.parse(d) - Date.now()) / 864e5
  return days > 80 && days < 110
}))
ok('再次生成是追加而非替换', s.spawnFromScaffold(leaf.id).length === spawned.length)
ok('墓碑节点不接收传导', (() => {
  const tomb = addNode({ themeId: theme.id, parentId: leaf.id, kind: 'lemma', title: '墓碑孙节点', confidence: 50, status: 'dead' })
  const before = tomb.confidence
  updateNode(leaf.id, { propagation: 1 })
  return tomb.confidence === before
})())

console.log('\n— 模板版本与查询 —')
ok('模板带版本号', typeof tpl.version === 'string' && tpl.version.length > 0, tpl.version)
ok('三个模板都列得出', list().length === 3, `实际 ${list().length}`)
ok('列表带环节数', list().every((t) => t.count > 0))
ok('找不到的模板返回 null', find('nope') === null)

console.log('\n— 数据主权 —')
const json = s.exportAll()
const other = s.addTheme('将被覆盖的主题')
s.importAll(json)
ok('导入后不含导入后新建的主题', !s.allThemes().some((t) => t.id === other.id))
ok('导入后原有命题还在', s.getNode(conv.id) !== null)
ok('导入后 verdicts 保留', s.allVerdicts().some((x) => x.id === v.id))
ok('导入后 verdicts 的 promotedTo 保留', s.allVerdicts().find((x) => x.id === v.id)?.promotedTo === promoted.id)
// 上面那条冲突的双方已被级联删除，所以导入后应为空——这正说明删除时清理了引用
ok('级联删除后冲突不残留', s.allConflicts().length === 0)

console.log('\n— 原文层 —')
const SRC_TEXT = '我们跟踪的 1.6T 光模块供应链显示，北美某云厂商 Q4 订单能见度已排到明年 Q2。'
const r1 = s.appendRaw({ kind: '一手数据', label: '产业调研纪要', text: SRC_TEXT })
ok('原文落库返回 id', typeof r1.id === 'string' && r1.id.length > 0)
ok('首次记为新增', r1.added === true)
ok('能按 id 读回', s.getRaw(r1.id)?.text === SRC_TEXT)
ok('读回了来源类型', s.getRaw(r1.id)?.kind === '一手数据')

const r2 = s.appendRaw({ kind: '券商研报', label: '中信', text: SRC_TEXT })
ok('同内容不重复存', r2.added === false)
ok('同内容复用同一 id', r2.id === r1.id)
ok('库里仍只有一条', s.rawStats().count === 1)

const r3 = s.appendRaw({ kind: '群聊转发', label: '某群', text: '另一段完全不同的原文。' })
ok('不同内容新建一条', r3.added === true && r3.id !== r1.id)
ok('统计为 2 条', s.rawStats().count === 2)
ok('统计了字节数', s.rawStats().bytes > 0)
ok('空文本不入库', s.appendRaw({ text: '   ' }).id === null)
ok('读不存在的 id 返回 null', s.getRaw('nope') === null)

// 引用保护：挂着命题的原文不能被无引用清理掉
const rawNode = addNode({
  themeId: theme.id, parentId: leaf.id, kind: 'lemma', title: '带原文的命题', confidence: 60,
  sources: [{ kind: '一手数据', label: '产业调研纪要', at: s.today(), rawId: r1.id }],
})
ok('rawId 存进了来源', rawNode.sources[0].rawId === r1.id)
const pruned = s.pruneRaw()
ok('被引用的原文清不掉', s.getRaw(r1.id) !== null)
ok('无引用的被清掉', s.getRaw(r3.id) === null, `清理 ${pruned.removed} / 保留 ${pruned.kept}`)

// 全清：原文没了，判断还在
const cleared = s.clearRaw()
ok('原文被清空', s.rawStats().count === 0)
ok('节点上的 rawId 被摘掉', rawNode.sources.every((x) => !x.rawId))
ok('命题本身还在', s.getNode(rawNode.id) !== null)
ok('置信度没被动过', rawNode.confidence === 60)

console.log('\n— 原文层随导出导入 —')
const EXPORT_TEXT = '导出版要带得走的原文。'
const exported = s.appendRaw({ kind: '一手数据', label: '复盘用', text: EXPORT_TEXT })
const full = JSON.parse(s.exportAll())
ok('默认导出带原文', Array.isArray(full.raw) && full.raw.length === 1)
ok('导出的原文读得回', full.raw[0].text === EXPORT_TEXT)
const judgeOnly = JSON.parse(s.exportAll({ withRaw: false }))
ok('只导出判断时没有 raw 键', !('raw' in judgeOnly))
ok('只导出判断时命题仍在', judgeOnly.nodes.length > 0)

s.importAll(JSON.stringify(full))
ok('导入后原文回来了', s.getRaw(exported.id)?.text === EXPORT_TEXT)
s.importAll(JSON.stringify(judgeOnly))
ok('导入无原文的文件不动已有原文', s.getRaw(exported.id)?.text === EXPORT_TEXT)

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
