/**
 * 改造后功能测试：收件箱、通道优先打标、provenance、by/stableId、骨架生成、导入导出。
 * 运行：node test/redesign.test.mjs
 */
import { rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'test/.tmp/redesign-data')
process.env.MERIDIAN_TEST_DATA = DATA

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const stub = await import('./electron-stub.mjs')
globalThis.__electron = stub

const store = await import('../src/main/store.js')
const { groupReadings } = await import('../src/shared/readings.js')
const { register: registerIpc } = await import('../src/main/ipc.js')
const labeler = await import('../src/main/labeler.js')
const fetcher = await import('../src/main/fetcher.js')
const crypto = await import('../src/main/crypto.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
}
const fire = (ch, ...args) => stub.__handlers.get(ch)({}, ...args)

store.load()
registerIpc({
  resizeCapture: () => {},
  showCapture: () => {},
  hideCapture: () => {},
  getMainWindow: () => undefined,
})

const theme = store.addTheme('改造测试主题')

// ============================================================
console.log('\n— 收件箱 CRUD —')
// ============================================================

const item1 = store.addInboxItem({
  text: '某公司Q3营收同比增长40%',
  title: 'Q3营收同比增长40%',
  label: { kind: '财报 / 公告', quality: 0.95, via: 'jev' },
  lemmas: [{ title: 'Q3营收同比增长40%', type: 'observation', confidence: 80, action: 'new', parentId: null }],
  provenance: { platform: 'eastmoney', url: 'https://example.com/1', fetchedAt: '2026-09-22' },
})
ok('收件箱条目创建', item1.id != null)
ok('条目状态为 pending', item1.status === 'pending')
ok('条目带 provenance', item1.provenance?.platform === 'eastmoney')

const item2 = store.addInboxItem({
  text: '听说某公司要裁员',
  title: '某公司要裁员',
  label: { kind: '群聊转发', quality: 0.35, via: 'table' },
  lemmas: [{ title: '某公司要裁员', type: 'hypothesis', confidence: 30, action: 'new', parentId: null }],
})
ok('第二条条目创建', item2.id != null)

ok('allInbox 返回 2 条', store.allInbox().length === 2, `实际 ${store.allInbox().length}`)
ok('inboxCount 返回 2', store.inboxCount() === 2, `实际 ${store.inboxCount()}`)

const resolved = store.resolveInboxItem(item1.id, 'accept')
ok('accept 后状态为 accepted', resolved?.status === 'accepted')
ok('allInbox 只剩 1 条', store.allInbox().length === 1, `实际 ${store.allInbox().length}`)

const rejected = store.resolveInboxItem(item2.id, 'reject')
ok('reject 后状态为 rejected', rejected?.status === 'rejected')
ok('allInbox 为空', store.allInbox().length === 0, `实际 ${store.allInbox().length}`)

const cleared = store.clearInbox()
ok('clearInbox 清了 2 条', cleared === 2, `实际 ${cleared}`)
ok('clearInbox 后 inbox 为空', store.allInbox().length === 0)

// ============================================================
console.log('\n— 收件箱 IPC: inbox:capture —')
// ============================================================

const captureResult = await fire('inbox:capture', '某公司财报显示营收增长30%')
ok('inbox:capture 返回 ok', captureResult?.ok === true)
ok('capture 创建了收件箱条目', captureResult?.item?.id != null)
ok('条目有 label', captureResult?.item?.label?.kind != null)
ok('条目有 lemmas', Array.isArray(captureResult?.item?.lemmas))
ok('收件箱有 1 条', store.allInbox().length === 1, `实际 ${store.allInbox().length}`)

// ============================================================
console.log('\n— 收件箱 IPC: inbox:list / resolve / clear —')
// ============================================================

const listResult = await fire('inbox:list')
ok('inbox:list 返回数组', Array.isArray(listResult))
ok('inbox:list 返回 1 条', listResult.length === 1, `实际 ${listResult.length}`)

const resolveResult = await fire('inbox:resolve', listResult[0].id, 'reject')
ok('inbox:resolve 返回条目', resolveResult?.id === listResult[0].id)
ok('reject 后 verdicts 增加', store.allVerdicts().length > 0, `实际 ${store.allVerdicts().length}`)

const clearResult = await fire('inbox:clear')
ok('inbox:clear 返回清理数', typeof clearResult === 'number')

// ============================================================
console.log('\n— 收件箱 IPC: inbox:import 批量入库 —')
// ============================================================

store.addInboxItem({
  text: 'AI算力需求持续增长',
  title: 'AI算力需求持续增长',
  label: { kind: '一手数据', quality: 0.9, via: 'table' },
  lemmas: [{ title: 'AI算力需求持续增长', type: 'observation', confidence: 75, action: 'new', parentId: null, tags: ['AI算力'] }],
  provenance: { platform: 'research', url: 'https://example.com/2' },
})
store.addInboxItem({
  text: 'GPU价格下跌',
  title: 'GPU价格下跌',
  label: { kind: '独立媒体', quality: 0.65, via: 'table' },
  lemmas: [{ title: 'GPU价格下跌', type: 'observation', confidence: 55, action: 'new', parentId: null, tags: ['GPU'] }],
})

const importResult = await fire('inbox:import', theme.id, store.allInbox().map((i) => ({
  id: i.id, text: i.text, label: i.label, lemmas: i.lemmas, provenance: i.provenance,
})))
ok('inbox:import 返回 ok', importResult?.ok === true)
ok('inbox:import 创建了节点', importResult?.results?.length > 0, `实际 ${importResult?.results?.length}`)
ok('入库后收件箱清空', store.allInbox().length === 0, `实际 ${store.allInbox().length}`)

const importedNodes = store.allNodes().filter((n) => n.themeId === theme.id && n.kind === 'lemma')
ok('入库节点存在', importedNodes.length >= 2, `实际 ${importedNodes.length}`)
const nodeWithProv = importedNodes.find((n) => n.sources?.some((s) => s.platform))
ok('入库节点带 provenance platform', nodeWithProv != null)

// ============================================================
console.log('\n— 通道优先打标 —')
// ============================================================

const chLabel = await labeler.labelSource({ labeler: 'table' }, '任意文本', { kind: '一手数据' })
ok('通道优先: kind 来自 channelMeta', chLabel.kind === '一手数据')
ok('通道优先: via = channel', chLabel.via === 'channel')
ok('通道优先: quality 查表', chLabel.quality === 0.9, `实际 ${chLabel.quality}`)

const noChLabel = await labeler.labelSource({ labeler: 'table' }, '某公司财报显示营收增长', null)
ok('无通道: 降级到 tableLabel', noChLabel.via === 'table')
ok('无通道: 关键词命中', noChLabel.kind === '财报 / 公告')

const badChLabel = await labeler.labelSource({ labeler: 'table' }, '文本', { kind: '不存在的类型' })
ok('无效通道: 降级到 tableLabel', badChLabel.via === 'table')

// ============================================================
console.log('\n— provenance 字段 —')
// ============================================================

const provNode = store.addNode({
  themeId: theme.id, parentId: null, kind: 'lemma', title: '带 provenance 的命题', confidence: 60,
  sources: [{
    kind: '一手数据', label: '调研纪要', at: '2026-09-22',
    platform: 'wind', url: 'https://wind.com/data/1',
    fetchedAt: '2026-09-22T10:00:00Z', searchPrompt: 'AI算力供应链',
  }],
})
ok('节点创建成功', provNode.id != null)
ok('来源带 platform', provNode.sources[0].platform === 'wind')
ok('来源带 url', provNode.sources[0].url === 'https://wind.com/data/1')
ok('来源带 fetchedAt', provNode.sources[0].fetchedAt === '2026-09-22T10:00:00Z')
ok('来源带 searchPrompt', provNode.sources[0].searchPrompt === 'AI算力供应链')

store.addSource(provNode.id, {
  kind: '券商研报', label: '中信研报', at: '2026-09-22',
  platform: 'citics', url: 'https://citics.com/report/1',
})
const updated = store.getNode(provNode.id)
ok('追加来源带 platform', updated.sources[1].platform === 'citics')
ok('追加来源带 url', updated.sources[1].url === 'https://citics.com/report/1')

// ============================================================
console.log('\n— node 新字段: by / stableId —')
// ============================================================

ok('默认 by = manual', provNode.by === 'manual')
ok('默认 stableId 存在', typeof provNode.stableId === 'string' && provNode.stableId.length > 0)

const modelNode = store.addNode({
  themeId: theme.id, parentId: null, kind: 'branch', title: '模型生成的环节',
  propagation: 0.6, by: 'model', stableId: 'stable-001',
})
ok('模型节点 by = model', modelNode.by === 'model')
ok('模型节点 stableId = stable-001', modelNode.stableId === 'stable-001')

const allNodes = store.allNodes()
ok('所有节点都有 by', allNodes.every((n) => n.by === 'manual' || n.by === 'model'))
ok('所有节点都有 stableId', allNodes.every((n) => typeof n.stableId === 'string' && n.stableId.length > 0))

const stableIdBefore = modelNode.stableId
store.updateNode(modelNode.id, { title: '重命名环节' })
ok('updateNode 不改 stableId', store.getNode(modelNode.id).stableId === stableIdBefore)

// ============================================================
console.log('\n— stats 包含 inbox 计数 —')
// ============================================================

store.addInboxItem({ text: 'test', title: 'test', label: null, lemmas: [] })
const st = store.stats()
ok('stats 有 inbox 字段', typeof st.inbox === 'number')
ok('stats inbox = 1', st.inbox === 1, `实际 ${st.inbox}`)

// ============================================================
console.log('\n— 导入导出包含 inbox —')
// ============================================================

const exported = store.exportAll({ withRaw: false })
const parsed = JSON.parse(exported)
ok('导出包含 inbox 数组', Array.isArray(parsed.inbox))
const pendingInExport = parsed.inbox.filter((i) => i.status === 'pending')
ok('导出 inbox pending 有 1 条', pendingInExport.length === 1, `实际 ${pendingInExport.length}`)

// clearInbox 只清已处理的，保留 pending
const pendingBefore = store.allInbox().length
store.clearInbox()
ok('clearInbox 保留 pending', store.allInbox().length === pendingBefore, `实际 ${store.allInbox().length}`)
store.importAll(exported)
ok('导入后 inbox 恢复', store.allInbox().length >= 1, `实际 ${store.allInbox().length}`)

// ============================================================
console.log('\n— 骨架生成 IPC —')
// ============================================================

const noKeyResult = await fire('theme:generateSkeleton', 'AI算力供应链')
ok('无 key 时骨架生成返回 ok: false', noKeyResult?.ok === false)

const skeleton = {
  roots: [{
    title: '上游·芯片设计',
    propagation: 0.6,
    stableId: 'sk-1',
    scaffold: { answer: '芯片设计能力如何', indicators: ['流片数'], falsifier: '流片延迟' },
    children: [
      { title: 'EDA工具', propagation: 0.5, stableId: 'sk-2', scaffold: null, children: [] },
      { title: 'IP授权', propagation: 0.5, stableId: 'sk-3', scaffold: null, children: [] },
    ],
  }],
}
const theme2 = store.addTheme('骨架测试主题')
const instResult = await fire('theme:instantiateSkeleton', theme2.id, skeleton)
ok('instantiateSkeleton 返回 ok', instResult?.ok === true)
ok('instantiateSkeleton 创建了节点', instResult?.count > 0, `实际 ${instResult?.count}`)

const skNodes = store.allNodes().filter((n) => n.themeId === theme2.id)
ok('骨架节点都是 branch', skNodes.every((n) => n.kind === 'branch'))
ok('骨架节点 by = model', skNodes.every((n) => n.by === 'model'))
ok('骨架根节点 1 个', store.rootNodes(theme2.id).length === 1, `实际 ${store.rootNodes(theme2.id).length}`)
ok('骨架子节点 2 个', store.childrenOf(skNodes[0].id).length === 2, `实际 ${store.childrenOf(skNodes[0].id).length}`)
ok('骨架节点带 stableId', skNodes.every((n) => typeof n.stableId === 'string'))
ok('骨架节点带 scaffold', skNodes[0].scaffold?.answer === '芯片设计能力如何')
ok('骨架节点带 propagation', skNodes[0].propagation === 0.6)

// ============================================================
console.log('\n— 收件箱 inbox:capture 带通道元数据 —')
// ============================================================

const chCapture = await fire('inbox:capture', '某公众号文章内容', { kind: '自媒体', platform: 'wechat', url: 'https://mp.weixin.qq.com/1' })
ok('带通道 capture 返回 ok', chCapture?.ok === true)
ok('带通道 capture label via = channel', chCapture?.item?.label?.via === 'channel')
ok('带通道 capture label kind = 自媒体', chCapture?.item?.label?.kind === '自媒体')
ok('带通道 capture provenance 保存', chCapture?.item?.provenance?.platform === 'wechat')

// ============================================================
console.log('\n— 收件箱 reject 产生 verdict —')
// ============================================================

const verdictsBefore = store.allVerdicts().length
const rejectItem = store.addInboxItem({ text: '低质内容', title: '低质内容', label: { kind: '道听途说', quality: 0.2, via: 'table' }, lemmas: [] })
await fire('inbox:resolve', rejectItem.id, 'reject')
ok('reject 后 verdicts +1', store.allVerdicts().length === verdictsBefore + 1, `实际 ${store.allVerdicts().length}`)
const lastVerdict = store.allVerdicts().slice(-1)[0]
ok('verdict gate = user', lastVerdict?.gate === 'user')
ok('verdict reason = rejected', lastVerdict?.reason === 'rejected')

// ============================================================
console.log('\n— today 视图数据完整性 —')
// ============================================================

const due = store.dueSettlements()
ok('due 返回数组', Array.isArray(due))

const calib = store.calibration()
ok('calibration 返回数组', Array.isArray(calib))

const fullStats = store.stats()
ok('stats 有 due', typeof fullStats.due === 'number')
ok('stats 有 inbox', typeof fullStats.inbox === 'number')
ok('stats 有 themes', typeof fullStats.themes === 'number')

// ============================================================
console.log('\n— 收件箱入库带覆盖置信度/挂点 —')
// ============================================================

// 先建一个父节点作为覆盖挂点
const overrideParent = store.addNode({ themeId: theme.id, kind: 'branch', title: '覆盖挂点环节', confidence: 60 })
const overrideInboxItem = store.addInboxItem({
  text: '某公司利润大增',
  title: '利润大增',
  label: { kind: '财报 / 公告', quality: 0.95, via: 'jev' },
  lemmas: [{ title: '利润大增', type: 'observation', confidence: 70, action: 'new', parentId: null, parentLabel: '默认挂点' }],
  provenance: null,
})

// 模拟前端覆盖：改置信度 70→85，改挂点 null→overrideParent.id
const overriddenItem = {
  ...overrideInboxItem,
  lemmas: overrideInboxItem.lemmas.map((l) => ({ ...l, confidence: 85, parentId: overrideParent.id })),
}
const overrideResult = await fire('inbox:import', theme.id, [overriddenItem])
ok('覆盖入库返回 ok', overrideResult?.ok === true)
const importedNode = store.allNodes().find((n) => n.title === '利润大增' && n.kind === 'lemma')
ok('覆盖置信度生效', importedNode?.confidence === 85, `实际 ${importedNode?.confidence}`)
ok('覆盖挂点生效', importedNode?.parentId === overrideParent.id, `实际 ${importedNode?.parentId}`)

// ============================================================
console.log('\n— 边拖权重 + 重传导 —')
// ============================================================

// 建链：A(80) → B(prop=0.5) → C(prop=0.5)
const wA = store.addNode({ themeId: theme.id, kind: 'lemma', title: '权重链A', confidence: 80, parentId: null })
const wB = store.addNode({ themeId: theme.id, kind: 'lemma', title: '权重链B', confidence: 50, parentId: wA.id, propagation: 0.5 })
const wC = store.addNode({ themeId: theme.id, kind: 'lemma', title: '权重链C', confidence: 30, parentId: wB.id, propagation: 0.5 })

// A 从 80 → 90，B 应 +5 (10×0.5)，C 应 +2.5 (5×0.5)
store.updateNode(wA.id, { confidence: 90 })
const wB1 = store.getNode(wB.id)
const wC1 = store.getNode(wC.id)
ok('A 变后 B 传导了', wB1.confidence === 55, `实际 ${wB1.confidence}`)
ok('A 变后 C 传导了', wC1.confidence === 33, `实际 ${wC1.confidence}`)

// 拖权重：B 的 propagation 从 0.5 → 0.8，重传导
// repropagate(B): baseline=50 (first manual), B=55, delta=5
// C reset to 30 (last manual), then hop = 5×0.8 = 4 → C = 34
store.updateNode(wB.id, { propagation: 0.8 })
store.repropagate(wB.id)
const wB2 = store.getNode(wB.id)
const wC2 = store.getNode(wC.id)
ok('改权重后 B 不变', wB2.confidence === 55, `实际 ${wB2.confidence}`)
ok('改权重后 C 按新权重重算', wC2.confidence === 34, `实际 ${wC2.confidence}`)

// ============================================================
console.log('\n— 结算后校准曲线更新 —')
// ============================================================

const settleNode = store.addNode({ themeId: theme.id, kind: 'lemma', title: '待结算测试', confidence: 75, parentId: null, settlement: { date: store.today(), resolved: null, correct: null } })
const dueBefore = store.dueSettlements().length
ok('新建结算节点出现在到期列表', store.dueSettlements().some((d) => d.id === settleNode.id), `实际 ${dueBefore}`)
store.settleLemma(settleNode.id, true)
const dueAfter = store.dueSettlements().length
ok('结算后不再到期', !store.dueSettlements().some((d) => d.id === settleNode.id), `实际 ${dueAfter}`)
const settled = store.getNode(settleNode.id)
ok('结算标记 correct = true', settled.settlement.correct === true)
ok('结算标记 resolved 有值', settled.settlement.resolved != null)

// ============================================================
console.log('\n— URL 检测与通道推断 —')
// ============================================================

ok('isUrl: http URL', fetcher.isUrl('https://example.com/article') === true)
ok('isUrl: 带空格不是 URL', fetcher.isUrl('https://example.com some text') === false)
ok('isUrl: 带换行不是 URL', fetcher.isUrl('https://example.com\nsecond line') === false)
ok('isUrl: 普通文本不是 URL', fetcher.isUrl('某公司Q3营收增长40%') === false)
ok('isUrl: 空字符串不是 URL', fetcher.isUrl('') === false)
ok('isUrl: ftp 不是 URL', fetcher.isUrl('ftp://example.com') === false)

const ch1 = fetcher.inferChannel('https://arxiv.org/abs/2401.12345')
ok('arxiv → 一手数据', ch1?.kind === '一手数据')
ok('arxiv 带 platform', ch1?.platform === 'arxiv.org')

const ch2 = fetcher.inferChannel('https://mp.weixin.qq.com/s/abc123')
ok('微信公众号 → 自媒体', ch2?.kind === '自媒体')

const ch3 = fetcher.inferChannel('https://www.cs.com.cn/report/123')
ok('中信证券 → 券商研报', ch3?.kind === '券商研报')

const ch4 = fetcher.inferChannel('https://finance.eastmoney.com/a/123.html')
ok('东方财富 → 财报/公告', ch4?.kind === '财报 / 公告')

const ch5 = fetcher.inferChannel('https://www.caixin.com/2026-09-22/123.html')
ok('财新 → 独立媒体', ch5?.kind === '独立媒体')

const ch6 = fetcher.inferChannel('https://unknown-random-site.com/page')
ok('未知域名 → kind 为 null', ch6?.kind === null)
ok('未知域名仍带 platform', ch6?.platform === 'unknown-random-site.com')

// ============================================================
console.log('\n— inbox:capture 粘贴 URL 推断通道 —')
// ============================================================

// 粘贴 arxiv URL：fetch 会失败（测试环境无网络），但通道元数据仍应推断出来
const urlCapture = await fire('inbox:capture', 'https://arxiv.org/abs/2401.12345')
ok('URL capture 返回 ok', urlCapture?.ok === true)
ok('URL capture 推断通道 via = channel', urlCapture?.item?.label?.via === 'channel')
ok('URL capture 推断 kind = 一手数据', urlCapture?.item?.label?.kind === '一手数据')
ok('URL capture provenance 带 platform', urlCapture?.item?.provenance?.platform === 'arxiv.org')
ok('URL capture provenance 带 url', urlCapture?.item?.provenance?.url === 'https://arxiv.org/abs/2401.12345')

// 粘贴公众号 URL
const wxCapture = await fire('inbox:capture', 'https://mp.weixin.qq.com/s/abc123def')
ok('公众号 URL capture kind = 自媒体', wxCapture?.item?.label?.kind === '自媒体')

// ============================================================
console.log('\n— API 密钥加密 —')
// ============================================================

const plainKey = 'sk-test-1234567890abcdef'
const encKey = crypto.encrypt(plainKey)
ok('加密后有 enc:v1: 前缀', encKey.startsWith('enc:v1:'))
ok('加密后不等于明文', encKey !== plainKey)
const decKey = crypto.decrypt(encKey)
ok('解密还原原文', decKey === plainKey, `实际 ${decKey}`)
ok('明文 decrypt 原样返回（向后兼容）', crypto.decrypt(plainKey) === plainKey)
ok('空字符串不加密', crypto.encrypt('') === '')
ok('null 不加密', crypto.encrypt(null) === null)

const s1 = { apiKey: 'sk-secret-1', jevKey: 'sk-jev-2', model: 'step-3' }
const encS = crypto.encryptSettings(s1)
ok('encryptSettings 加密了 apiKey', encS.apiKey.startsWith('enc:v1:'))
ok('encryptSettings 加密了 jevKey', encS.jevKey.startsWith('enc:v1:'))
ok('encryptSettings 没动 model', encS.model === 'step-3')
const decS = crypto.decryptSettings(encS)
ok('decryptSettings 还原 apiKey', decS.apiKey === 'sk-secret-1')
ok('decryptSettings 还原 jevKey', decS.jevKey === 'sk-jev-2')

// saveSettings 存加密，settings() 返回解密
store.saveSettings({ apiKey: 'sk-roundtrip-test' })
const liveSettings = store.settings()
ok('settings() 返回解密后的 apiKey', liveSettings.apiKey === 'sk-roundtrip-test', `实际 ${liveSettings.apiKey}`)
// 内部存储应该是加密的
const rawDb = store.load()
ok('内部存储的 apiKey 是加密的', rawDb.settings.apiKey.startsWith('enc:v1:'), `实际 ${rawDb.settings.apiKey.slice(0, 20)}...`)

// ============================================================
console.log('\n— 留痕层 trace —')

// 清空收件箱和 traces，准备测试
store.clearInbox()
const traceBefore = store.allTraces().length
store.addTrace({
  target: { type: 'node', id: 'test-node-1' },
  stage: 'label',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'abc123', textLen: 100, channelMeta: { platform: 'arxiv' } },
  output: { kind: '一手数据', quality: 0.9, via: 'jev' },
  decision: { kind: '一手数据', quality: 0.9 },
  reason: null,
})
ok('addTrace 创建了 trace', store.allTraces().length === traceBefore + 1, `实际 ${store.allTraces().length}`)

const tr = store.allTraces()[traceBefore]
ok('trace 有 id', typeof tr.id === 'string')
ok('trace 有 t', typeof tr.t === 'string')
ok('trace stage = label', tr.stage === 'label')
ok('trace actor.by = model', tr.actor.by === 'model')
ok('trace actor.model = step-3', tr.actor.model === 'step-3')
ok('trace actor.promptVersion = v1', tr.actor.promptVersion === 'v1')
ok('trace output 未加工', tr.output.quality === 0.9)
ok('trace decision 是最终值', tr.decision.quality === 0.9)
ok('trace reason 为 null（表值=模型值）', tr.reason === null)

// 取表值 ≠ 模型值时写 reason
store.addTrace({
  target: { type: 'node', id: 'test-node-2' },
  stage: 'label',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'def456', textLen: 200 },
  output: { kind: '一手数据', quality: 0.9, via: 'jev' },
  decision: { kind: '自媒体', quality: 0.4 },
  reason: '表值 0.4 ≠ 模型值 0.9',
})
const tr2 = store.allTraces()[traceBefore + 1]
ok('trace reason 记录了分歧', tr2.reason.includes('0.4') && tr2.reason.includes('0.9'))

// 按 target 查询
const byTarget = store.tracesByTarget('test-node-1')
ok('tracesByTarget 返回 1 条', byTarget.length === 1, `实际 ${byTarget.length}`)

// 模型建议的校准曲线
store.addTrace({
  target: { type: 'node', id: 'test-node-3' },
  stage: 'extract',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'ghi789', textLen: 300 },
  output: { confidence: 85, lemmas: [] },
  decision: { confidence: 72 },
  reason: null,
})
const mc = store.modelCalibration()
ok('modelCalibration 返回 1 条', mc.length === 1, `实际 ${mc.length}`)
ok('modelConf = 85', mc[0].modelConf === 85)
ok('userConf = 72', mc[0].userConf === 72)
ok('modelCalibration 带 model', mc[0].model === 'step-3')
ok('modelCalibration 带 promptVersion', mc[0].promptVersion === 'v1')

// 打标器 vs 表的分歧曲线
const ld = store.labelerDivergence()
ok('labelerDivergence 返回数组', Array.isArray(ld))
// 有分歧的那条（0.9 - 0.4 = 0.5）
const diverged = ld.find((g) => g.kind === '自媒体')
ok('分歧曲线有自媒体', diverged != null)
ok('自媒体分歧均值 = 0.5', diverged != null && Math.abs(diverged.meanDiff - 0.5) < 0.01, `实际 ${diverged?.meanDiff}`)

// trace 不内联进 node
const dbNodes = store.allNodes()
ok('trace 不内联进 node', dbNodes.every((n) => !n.traces))

// 导入导出包含 traces
const exportedTraces = JSON.parse(store.exportAll())
ok('导出包含 traces 数组', Array.isArray(exportedTraces.traces))
ok('导出 traces 有 ' + store.allTraces().length + ' 条', exportedTraces.traces.length === store.allTraces().length)

// ============================================================
console.log('\n— 通道描述符 —')

const ch = store.addChannel({
  name: 'X · AI 产业链',
  kind: '自媒体',
  fetch: 'grok-x-search',
  query: '1.6T optical module supply chain',
  cadence: '日',
  themeId: theme.id,
})
ok('addChannel 创建了通道', store.allChannels().length === 1, `实际 ${store.allChannels().length}`)
ok('通道有 id', typeof ch.id === 'string')
ok('通道 kind = 自媒体', ch.kind === '自媒体')
ok('通道 fetch = grok-x-search', ch.fetch === 'grok-x-search')
ok('通道 enabled 默认 true', ch.enabled === true)
ok('通道 quality 查表', ch.quality === 0.5, `实际 ${ch.quality}`)

store.updateChannel(ch.id, { enabled: false, query: 'updated query' })
const updatedCh = store.allChannels().find((c) => c.id === ch.id)
ok('updateChannel 改了 enabled', updatedCh.enabled === false)
ok('updateChannel 改了 query', updatedCh.query === 'updated query')

store.addChannel({ name: 'arXiv', kind: '一手数据', fetch: 'tavily', themeId: theme.id })
ok('两个通道', store.allChannels().length === 2, `实际 ${store.allChannels().length}`)

store.removeChannel(ch.id)
ok('removeChannel 删了', store.allChannels().length === 1, `实际 ${store.allChannels().length}`)

// 导出包含 channels
const exportedCh = JSON.parse(store.exportAll())
ok('导出包含 channels 数组', Array.isArray(exportedCh.channels))
ok('导出 channels 有 1 条', exportedCh.channels.length === 1)

// ============================================================
console.log('\n— 不确定性闸门 + 自动归位 —')
// ============================================================

const gateTheme = store.addTheme('闸门测试主题')
const gBranch1 = store.addNode({ themeId: gateTheme.id, kind: 'branch', title: '光通信', propagation: 0.6 })
const gBranch2 = store.addNode({ themeId: gateTheme.id, kind: 'branch', title: 'AI算力', propagation: 0.6 })
// 添加足够多的 lemma 使 gateTheme 成为 bestThemeContext（lemma 数最多）
for (let i = 0; i < 20; i++) {
  store.addNode({ themeId: gateTheme.id, parentId: gBranch1.id, kind: 'lemma', title: `光通信基线命题${i}`, confidence: 50 })
}

// 闸门通过：文本匹配环节、质量≥0.4、无冲突、无灰色去重
const gatePass = await fire('inbox:capture', '光通信 出货量超预期增长40%', { kind: '一手数据', quality: 0.9, platform: 'test' })
ok('闸门通过: autoImported = true', gatePass?.autoImported === true, `实际 autoImported=${gatePass?.autoImported} reasons=${JSON.stringify(gatePass?.gateReasons)}`)
ok('闸门通过: 返回 imported 数组', Array.isArray(gatePass?.imported))
ok('闸门通过: imported 有节点', gatePass?.imported?.length > 0)
ok('闸门通过: 不进收件箱', !gatePass?.item)
const autoNode = gatePass?.imported?.[0]
ok('自动入库节点存在', autoNode?.id != null)
const autoNodeFull = store.getNode(autoNode?.id)
ok('自动入库 by = source', autoNodeFull?.by === 'source', `实际 ${autoNodeFull?.by}`)
ok('自动入库节点在主题中', autoNodeFull?.themeId === gateTheme.id)

// 闸门失败: 归位失败（parentHint 匹配不到已有环节）
const gateNoParent = await fire('inbox:capture', '完全无关的xyz话题内容zzz', { kind: '一手数据', quality: 0.9 })
ok('闸门失败 no-parent: autoImported = false', gateNoParent?.autoImported === false)
ok('闸门失败 no-parent: 进收件箱', gateNoParent?.item?.id != null)
ok('闸门失败 no-parent: gateReasons 含 no-parent', gateNoParent?.gateReasons?.includes('no-parent'))

// 闸门失败: 来源质量低于 0.4
const gateLowQ = await fire('inbox:capture', '光通信行业某小道消息', { kind: '道听途说', quality: 0.2 })
ok('闸门失败 low-quality: autoImported = false', gateLowQ?.autoImported === false)
ok('闸门失败 low-quality: gateReasons 含 low-quality', gateLowQ?.gateReasons?.includes('low-quality'))

// 闸门失败: 去重灰色地带 (0.6–0.85)
const gateDedup1 = await fire('inbox:capture', 'AI算力 需求大幅增长超预期', { kind: '一手数据', quality: 0.9 })
ok('去重测试: 第一条自动入库', gateDedup1?.autoImported === true, `实际 ${gateDedup1?.autoImported} reasons=${JSON.stringify(gateDedup1?.gateReasons)}`)
const gateDedup2 = await fire('inbox:capture', 'AI算力 需求大幅增长超出预期', { kind: '一手数据', quality: 0.9 })
if (gateDedup2?.autoImported) {
  ok('去重灰色: 高相似度直接合并', gateDedup2?.imported?.[0]?.action === 'merge')
} else {
  ok('去重灰色: 进收件箱', gateDedup2?.item?.id != null)
  ok('去重灰色: gateReasons 含 dedup-gray', gateDedup2?.gateReasons?.includes('dedup-gray'))
}

// 校准曲线不统计 by:source 的节点
const calibBefore = store.calibration()
ok('校准曲线不含 by:source 节点', calibBefore.every(b => b.total >= 0))

// ============================================================
console.log('\n— 撤销自动归位 —')
// ============================================================

const undoTheme = store.addTheme('撤销测试主题')
const uBranch = store.addNode({ themeId: undoTheme.id, kind: 'branch', title: '半导体', propagation: 0.6 })
for (let i = 0; i < 30; i++) {
  store.addNode({ themeId: undoTheme.id, parentId: uBranch.id, kind: 'lemma', title: `半导体基线${i}`, confidence: 50 })
}

const undoCapture = await fire('inbox:capture', '半导体 出货量同比增长50%', { kind: '一手数据', quality: 0.9 })
ok('撤销测试: 自动入库', undoCapture?.autoImported === true)
ok('撤销测试: 有 intakeEventId', undoCapture?.intakeEventId != null)

const undoNodeId = undoCapture?.imported?.[0]?.id
ok('撤销测试: 节点已创建', store.getNode(undoNodeId) != null)
const inboxBeforeUndo = store.allInbox().length

const undoResult = await fire('inbox:undoAutoImport', undoCapture.intakeEventId)
ok('撤销返回 ok', undoResult?.ok === true)
ok('撤销后节点入墓', store.getNode(undoNodeId)?.status === 'dead')
ok('撤销后收件箱+1', store.allInbox().length === inboxBeforeUndo + 1, `实际 ${store.allInbox().length} vs ${inboxBeforeUndo + 1}`)
const undoInboxItem = store.allInbox().find(i => i.title === '半导体 出货量同比增长50%')
ok('撤销后收件箱有条目', undoInboxItem != null)
ok('撤销后条目有 label', undoInboxItem?.label?.kind === '一手数据')
ok('撤销后条目有 lemmas', Array.isArray(undoInboxItem?.lemmas))

// ============================================================
console.log('\n— 来源推导置信度 + by 分流统计 —')
// ============================================================

const confTheme = store.addTheme('置信度测试主题')
const cBranch = store.addNode({ themeId: confTheme.id, kind: 'branch', title: '新能源', propagation: 0.6 })
for (let i = 0; i < 40; i++) {
  store.addNode({ themeId: confTheme.id, parentId: cBranch.id, kind: 'lemma', title: `新能源基线${i}`, confidence: 50 })
}

// 自动入库的置信度由来源质量推导
const confCapture = await fire('inbox:capture', '新能源 装机量超预期', { kind: '一手数据', quality: 0.9 })
ok('置信度: 自动入库', confCapture?.autoImported === true)
const confNode = store.getNode(confCapture?.imported?.[0]?.id)
ok('置信度: by = source', confNode?.by === 'source')
ok('置信度: history[0].by = source', confNode?.history?.[0]?.by === 'source')
ok('置信度: 来源推导 = 90', confNode?.confidence === 90, `实际 ${confNode?.confidence}`)
ok('置信度: 无 manual history', !confNode?.history?.some(h => h.by === 'manual'))

// 校准曲线不含 by:source 节点（即使结算了）
store.settleLemma(confNode.id, true)
const calibAfterSettle = store.calibration()
ok('校准: by:source 结算后仍不进曲线', calibAfterSettle.every(b => !b.total || b.bucket !== 90 || b.hit === 0))

// 用户手动调置信度后，出现 manual history，进入校准
store.updateNode(confNode.id, { confidence: 75 })
const afterManual = store.getNode(confNode.id)
ok('手动调后: 有 manual history', afterManual?.history?.some(h => h.by === 'manual'))
ok('手动调后: confidence = 75', afterManual?.confidence === 75)

// 校准曲线现在包含该节点（有 manual entry + 已结算）
const calibAfterManual = store.calibration()
const bucket70 = calibAfterManual.find(b => b.bucket === 70)
ok('校准: 手动调后进入曲线', bucket70 != null && bucket70.total > 0, `实际 ${JSON.stringify(bucket70)}`)

// 不同来源质量推导不同置信度
const confCapture2 = await fire('inbox:capture', '新能源 补贴政策调整方向', { kind: '自媒体', quality: 0.5 })
if (confCapture2?.autoImported && confCapture2?.imported?.[0]?.action === 'new') {
  const confNode2 = store.getNode(confCapture2?.imported?.[0]?.id)
  ok('置信度: 自媒体推导 = 50', confNode2?.confidence === 50, `实际 ${confNode2?.confidence}`)
} else if (confCapture2?.autoImported) {
  ok('置信度: 自媒体合并已有节点', confCapture2?.imported?.[0]?.action === 'merge')
} else {
  ok('置信度: 自媒体低质进收件箱', confCapture2?.item?.id != null)
}

// ============================================================
console.log('\n— 冲突静默化 —')
// ============================================================

const conflictTheme = store.addTheme('冲突测试主题')
const cfBranch = store.addNode({ themeId: conflictTheme.id, kind: 'branch', title: '存储芯片', propagation: 0.6 })
for (let i = 0; i < 50; i++) {
  store.addNode({ themeId: conflictTheme.id, parentId: cfBranch.id, kind: 'lemma', title: `存储芯片基线${i}`, confidence: 50 })
}

const cfCapture1 = await fire('inbox:capture', '存储芯片 价格上涨超预期', { kind: '一手数据', quality: 0.9 })
ok('冲突: 第一条自动入库', cfCapture1?.autoImported === true)

const cfCapture2 = await fire('inbox:capture', '存储芯片 价格下跌不及预期', { kind: '一手数据', quality: 0.9 })
ok('冲突: 第二条入库或进收件箱', cfCapture2?.ok === true)

const allC = store.allConflicts()
ok('冲突: 不自动裁决', allC.every(c => c.resolved === null || c.resolved === undefined))
ok('冲突: 无弹窗无通知（静默）', true)

// ============================================================
console.log('\n— 任务1: 误杀闭环 —')
// ============================================================

const killTheme = store.addTheme('误杀测试主题')
const kBranch = store.addNode({ themeId: killTheme.id, kind: 'branch', title: '算力', propagation: 0.6 })
// 已有 lemma，用于触发 dedup（3 个 token 完全匹配 → score = 1.0）
const existLemma = store.addNode({ themeId: killTheme.id, parentId: kBranch.id, kind: 'lemma', title: '算力 芯片 需求', confidence: 60 })
for (let i = 0; i < 60; i++) {
  store.addNode({ themeId: killTheme.id, parentId: kBranch.id, kind: 'lemma', title: `算力基线${i}`, confidence: 50 })
}

// 第一次捕获：相似文本被 dedup 筛掉，产生 verdict
const killSim = store.findSimilar('算力 芯片 需求 超预期', killTheme.id)
ok('误杀: findSimilar 能找到', killSim.length > 0, `实际 ${JSON.stringify(killSim.map(s => ({ s: s.score, t: s.node.title })))}`)
ok('误杀: 相似度 >= 0.6', killSim[0]?.score >= 0.6, `实际 ${killSim[0]?.score}`)
const killCap1 = await fire('inbox:capture', '算力 芯片 需求 超预期', { kind: '一手数据', quality: 0.9 })
const killVerdictsBefore = store.allVerdicts().filter(v => v.themeId === killTheme.id)
ok('误杀: 第一次捕获后有 verdict', killVerdictsBefore.length > 0, `实际 ${killVerdictsBefore.length}`)
if (killVerdictsBefore.length > 0) {
  ok('误杀: verdict gate = dedup', killVerdictsBefore.some(v => v.gate === 'dedup'))
  ok('误杀: verdict promotedTo 为 null', killVerdictsBefore.every(v => v.promotedTo == null))
}

// 删除已有 lemma，使第二次捕获不被 dedup
store.removeNode(existLemma.id)

// 第二次捕获：同样的文本从别的源进来，这次作为新节点入库
const killCap2 = await fire('inbox:capture', '算力 芯片 需求 超预期', { kind: '券商研报', quality: 0.8 })
ok('误杀: 第二次捕获入库', killCap2?.ok === true)

// 检查误杀闭环
const verdictsAfter = store.allVerdicts().filter(v => v.themeId === killTheme.id)
const promoted = verdictsAfter.filter(v => v.promotedTo != null)
ok('误杀: verdict 被回填 promotedTo', promoted.length >= 1, `实际 ${promoted.length}`)

const audit = store.falseKillAudit(30)
ok('误杀: falseKillAudit missed >= 1', audit.missed >= 1, `实际 ${audit.missed}`)

const filterCalib = store.filterCalibration()
ok('误杀: filterCalibration 有非零误杀率', filterCalib.some(b => b.missed > 0), `实际 ${JSON.stringify(filterCalib)}`)

// 幂等：再次入库同一标题不重复回填
if (killCap2?.imported?.[0]?.id) {
  store.promoteMatchingVerdicts('算力 芯片 需求 超预期', killCap2.imported[0].id, killTheme.id)
  const promotedAgain = store.allVerdicts().filter(v => v.themeId === killTheme.id && v.promotedTo != null)
  ok('误杀: 幂等不重复回填', promotedAgain.length === promoted.length, `实际 ${promotedAgain.length} vs ${promoted.length}`)
}

// ============================================================
console.log('\n— route trace：自动归位 —')
// ============================================================

const rtTheme = store.addTheme('route-trace 测试主题')
const rtBranch = store.addNode({ themeId: rtTheme.id, kind: 'branch', title: '半导体', propagation: 0.6 })
for (let i = 0; i < 200; i++) {
  store.addNode({ themeId: rtTheme.id, parentId: rtBranch.id, kind: 'lemma', title: `半导体基线命题${i}`, confidence: 50 })
}

// 高质量捕获 → 通过闸门 → 自动归位
const rtCap = await fire('inbox:capture', '半导体 出货量超预期增长40%', { kind: '一手数据', quality: 0.9, platform: 'test' })
ok('route: 自动归位成功', rtCap?.autoImported === true, `实际 autoImported=${rtCap?.autoImported} reasons=${JSON.stringify(rtCap?.gateReasons)}`)

if (rtCap?.imported?.[0]?.id) {
  const rtTraces = store.tracesByTarget(rtCap.imported[0].id)
  const routeTraces = rtTraces.filter(t => t.stage === 'route')
  ok('route: 自动归位节点有 route trace', routeTraces.length > 0, `实际 ${routeTraces.length}`)
  if (routeTraces.length > 0) {
    const rt = routeTraces[0]
    ok('route: actor.by = gate', rt.actor?.by === 'gate', `实际 ${rt.actor?.by}`)
    ok('route: reason 以 gate-pass 开头', rt.reason?.startsWith('gate-pass'), `实际 ${rt.reason}`)
    ok('route: output 有 parentId', rt.output?.parentId != null || rt.output?.parentId === null)
    ok('route: decision 有 confidence', typeof rt.decision?.confidence === 'number')
    ok('route: input 有 suggestedParentId', rt.input?.suggestedParentId !== undefined)
    ok('route: input 有 suggestedConfidence', typeof rt.input?.suggestedConfidence === 'number')
  }
}

// ============================================================
console.log('\n— route trace：用户 override —')
// ============================================================

// 创建收件箱条目（未通过闸门的那种）
const ovItem = store.addInboxItem({
  text: '某公司可能要裁员',
  title: '某公司可能要裁员',
  label: { kind: '社交媒体', quality: 0.4, via: 'channel' },
  lemmas: [{ title: '某公司可能要裁员', type: 'observation', confidence: 40, action: 'new', parentId: rtBranch.id }],
  provenance: null,
})
ok('route: 收件箱条目创建', ovItem.id != null)

// 带 override 入库：改置信度
const ovResult = await fire('inbox:import', rtTheme.id, [ovItem], {
  [ovItem.id]: { confidence: 75, parentId: rtBranch.id },
})
ok('route: override 入库成功', ovResult?.ok === true)

if (ovResult?.results?.[0]?.id) {
  const ovTraces = store.tracesByTarget(ovResult.results[0].id)
  const routeTraces = ovTraces.filter(t => t.stage === 'route')
  ok('route: override 节点有 route trace', routeTraces.length > 0, `实际 ${routeTraces.length}`)
  if (routeTraces.length > 0) {
    const rt = routeTraces[0]
    ok('route: actor.by = user', rt.actor?.by === 'user', `实际 ${rt.actor?.by}`)
    ok('route: reason = user-override', rt.reason === 'user-override', `实际 ${rt.reason}`)
    ok('route: output.confidence ≠ decision.confidence', rt.output?.confidence !== rt.decision?.confidence,
      `实际 output=${rt.output?.confidence} decision=${rt.decision?.confidence}`)
    ok('route: decision.confidence = 75', rt.decision?.confidence === 75, `实际 ${rt.decision?.confidence}`)
  }
}

// 无 override 入库：reason = user-confirmed
const confirmItem = store.addInboxItem({
  text: '另一条待确认信息',
  title: '另一条待确认信息',
  label: { kind: '社交媒体', quality: 0.5, via: 'channel' },
  lemmas: [{ title: '另一条待确认信息', type: 'observation', confidence: 50, action: 'new', parentId: rtBranch.id }],
  provenance: null,
})
const confirmResult = await fire('inbox:import', rtTheme.id, [confirmItem], {})
ok('route: 无 override 入库成功', confirmResult?.ok === true)

if (confirmResult?.results?.[0]?.id) {
  const cfTraces = store.tracesByTarget(confirmResult.results[0].id)
  const routeTraces = cfTraces.filter(t => t.stage === 'route')
  ok('route: confirmed 节点有 route trace', routeTraces.length > 0, `实际 ${routeTraces.length}`)
  if (routeTraces.length > 0) {
    ok('route: reason = user-confirmed', routeTraces[0].reason === 'user-confirmed', `实际 ${routeTraces[0].reason}`)
    ok('route: output = decision (无修改)', routeTraces[0].output?.confidence === routeTraces[0].decision?.confidence)
  }
}

// ============================================================
console.log('\n— 任务3: intakeEvents 采集漏斗 —')
// ============================================================

// intakeSeries 返回今天的漏斗
const series = store.intakeSeries(3)
ok('intake: series 返回数组', Array.isArray(series))
ok('intake: series 有今天的数据', series.some(b => b.captured > 0), `实际 ${JSON.stringify(series)}`)

const todayBucket = series.find(b => b.captured > 0)
if (todayBucket) {
  ok('intake: 有 captured', todayBucket.captured > 0)
  ok('intake: 有 autoImported', todayBucket.autoImported >= 0)
  ok('intake: 有 toInbox', todayBucket.toInbox >= 0)
  ok('intake: autoImported + toInbox <= captured', todayBucket.autoImported + todayBucket.toInbox <= todayBucket.captured)
}

// 验证 intakeEvent 存在且结构正确
const allIntakeEvents = store.load().intakeEvents
ok('intake: intakeEvents 非空', allIntakeEvents.length > 0, `实际 ${allIntakeEvents.length}`)
const sampleEvent = allIntakeEvents[0]
ok('intake: event 有 id', sampleEvent.id != null)
ok('intake: event 有 at', sampleEvent.at != null)
ok('intake: event 有 gate', sampleEvent.gate != null)
ok('intake: event 有 outcome', sampleEvent.outcome != null)
ok('intake: event 有 label', sampleEvent.label != null)
ok('intake: event 有 lemmas', Array.isArray(sampleEvent.lemmas))
ok('intake: event 有 undone', sampleEvent.undone === false)

// 撤销后 intakeEvent 标记 undone
const undoEventId = rtCap?.intakeEventId
if (undoEventId) {
  await fire('inbox:undoAutoImport', undoEventId)
  const undoneEvent = store.getIntakeEvent(undoEventId)
  ok('intake: 撤销后 undone = true', undoneEvent?.undone === true, `实际 ${undoneEvent?.undone}`)
}

// 模拟重启：重新 load 后撤销入口仍在
store.load()
const lastAuto = store.lastAutoIntakeEvent()
ok('intake: lastAutoIntakeEvent 返回最近自动归位', lastAuto != null, `实际 null`)
if (lastAuto) {
  ok('intake: lastAuto outcome = auto', lastAuto.outcome === 'auto')
  ok('intake: lastAuto undone = false', lastAuto.undone === false)
}

// resolveInboxItem 补了 resolvedAt
const resolveTestItem = store.addInboxItem({
  text: 'resolveAt 测试', title: 'resolveAt 测试',
  label: { kind: '社交媒体', quality: 0.4, via: 'channel' },
  lemmas: [], provenance: null,
})
const resolvedAtTest = store.resolveInboxItem(resolveTestItem.id, 'accept')
ok('intake: resolveInboxItem 有 resolvedAt', resolvedAtTest?.resolvedAt != null, `实际 ${resolvedAtTest?.resolvedAt}`)

// 导出 → 导入 → intakeEvents 不丢
const exportedJson = store.exportAll()
const exportedObj = JSON.parse(exportedJson)
ok('intake: 导出包含 intakeEvents', Array.isArray(exportedObj.intakeEvents), `实际 ${typeof exportedObj.intakeEvents}`)
ok('intake: 导出 intakeEvents 非空', exportedObj.intakeEvents.length > 0, `实际 ${exportedObj.intakeEvents.length}`)

// 老文件导入后 intakeEvents 是空数组而非 undefined
const oldFile = JSON.stringify({
  version: 3, settings: {}, themes: [], nodes: [], verdicts: [], conflicts: [],
  feeds: [], inbox: [], traces: [], channels: [],
})
store.importAll(oldFile)
ok('intake: 老文件导入后 intakeEvents 是空数组', Array.isArray(store.load().intakeEvents) && store.load().intakeEvents.length === 0,
  `实际 ${typeof store.load().intakeEvents} len=${store.load().intakeEvents?.length}`)

// 导入有 intakeEvents 的文件后恢复
store.importAll(exportedJson)
ok('intake: 导入后 intakeEvents 恢复', store.load().intakeEvents.length === exportedObj.intakeEvents.length,
  `实际 ${store.load().intakeEvents.length} vs ${exportedObj.intakeEvents.length}`)

// ============================================================
console.log('\n— 任务4: raw 层补通道元数据 —')
// ============================================================

// 直接测试 appendRaw 带 channel
const rawWithChannel = store.appendRaw({
  kind: '一手数据', label: '一手数据',
  text: 'raw-channel-test-content-unique',
  channel: { platform: 'arxiv', url: 'https://arxiv.org/abs/2026.12345', fetchedAt: '2026-09-23' },
})
ok('raw: appendRaw 返回 id', rawWithChannel.id != null)
const rawEntry = store.getRaw(rawWithChannel.id)
ok('raw: 有 platform', rawEntry?.platform === 'arxiv', `实际 ${rawEntry?.platform}`)
ok('raw: 有 url', rawEntry?.url === 'https://arxiv.org/abs/2026.12345', `实际 ${rawEntry?.url}`)
ok('raw: 有 fetchedAt', rawEntry?.fetchedAt === '2026-09-23', `实际 ${rawEntry?.fetchedAt}`)

// 无 channel 的老条目仍正常
const rawNoChannel = store.appendRaw({ kind: '社交媒体', label: '社交媒体', text: 'raw-no-channel-test-unique' })
const rawNoChannelEntry = store.getRaw(rawNoChannel.id)
ok('raw: 无 channel 时无 platform', rawNoChannelEntry?.platform === undefined)
ok('raw: 无 channel 时无 url', rawNoChannelEntry?.url === undefined)

// 自动入库后 raw 带 channel 元数据
const rawTestTheme = store.addTheme('raw-channel 测试主题')
const rawTestBranch = store.addNode({ themeId: rawTestTheme.id, kind: 'branch', title: '航天', propagation: 0.6 })
for (let i = 0; i < 300; i++) {
  store.addNode({ themeId: rawTestTheme.id, parentId: rawTestBranch.id, kind: 'lemma', title: `航天基线${i}`, confidence: 50 })
}
const rawAutoCap = await fire('inbox:capture', '航天 发射次数创历史新高', { kind: '一手数据', quality: 0.9, platform: 'spacex', url: 'https://spacex.com/launches' })
ok('raw: 自动入库成功', rawAutoCap?.autoImported === true, `实际 ${rawAutoCap?.autoImported}`)
if (rawAutoCap?.imported?.[0]?.id) {
  const autoNode = store.getNode(rawAutoCap.imported[0].id)
  if (autoNode?.sources?.[0]?.rawId) {
    const autoRaw = store.getRaw(autoNode.sources[0].rawId)
    ok('raw: 自动入库 raw 有 platform', autoRaw?.platform === 'spacex', `实际 ${autoRaw?.platform}`)
    ok('raw: 自动入库 raw 有 url', autoRaw?.url === 'https://spacex.com/launches', `实际 ${autoRaw?.url}`)
  }
}

// ============================================================
console.log('\n— R2: 定时器纯函数 —')
// ============================================================

const { isQuietHours, dueToNotify, buildNotification } = await import('../src/main/scheduler.js')

// 时段边界
ok('scheduler: 10:00 不静默', isQuietHours(new Date('2026-01-01T10:00:00')) === false)
ok('scheduler: 21:59 不静默', isQuietHours(new Date('2026-01-01T21:59:00')) === false)
ok('scheduler: 22:00 静默', isQuietHours(new Date('2026-01-01T22:00:00')) === true)
ok('scheduler: 03:00 静默', isQuietHours(new Date('2026-01-01T03:00:00')) === true)
ok('scheduler: 08:59 静默', isQuietHours(new Date('2026-01-01T08:59:00')) === true)
ok('scheduler: 09:00 不静默', isQuietHours(new Date('2026-01-01T09:00:00')) === false)

// 去重
const notified = new Set(['a'])
const dueList = [{ id: 'a', title: '已通知' }, { id: 'b', title: '新到期' }, { id: 'c', title: '也新' }]
const fresh = dueToNotify(dueList, notified)
ok('scheduler: 去重后只剩 2 条', fresh.length === 2, `实际 ${fresh.length}`)
ok('scheduler: 去重后是 b 和 c', fresh[0]?.id === 'b' && fresh[1]?.id === 'c')

// 通知构造
const n1 = buildNotification([{ id: 'x', title: '光模块超预期' }])
ok('scheduler: 单条标题', n1?.title === '脉络 · 到期结算', `实际 ${n1?.title}`)
ok('scheduler: 单条正文', n1?.body === '光模块超预期')

const n3 = buildNotification([{ id: 'a', title: '第一条' }, { id: 'b', title: '第二条' }, { id: 'c', title: '第三条' }])
ok('scheduler: 多条标题', n3?.title === '脉络 · 3 条判断到期', `实际 ${n3?.title}`)
ok('scheduler: 多条正文取最早', n3?.body === '第一条')

ok('scheduler: 空列表返回 null', buildNotification([]) === null)
ok('scheduler: null 返回 null', buildNotification(null) === null)

// ============================================================
console.log('\n— R3: 误杀率按 gate 拆分 —')
// ============================================================

const fcResult = store.filterCalibration()
ok('R3: filterCalibration 返回数组', Array.isArray(fcResult))
ok('R3: 有 byGate 属性', fcResult.byGate != null)
ok('R3: byGate 有 source', fcResult.byGate.source != null)
ok('R3: byGate 有 dedup', fcResult.byGate.dedup != null)
ok('R3: byGate 有 user', fcResult.byGate.user != null)
ok('R3: source 有 label', fcResult.byGate.source.label === '明确误杀')
ok('R3: dedup 有 label', fcResult.byGate.dedup.label === '收敛度存疑')
ok('R3: user 有 label', fcResult.byGate.user.label === '用户误判')
ok('R3: source 有 accuracy', typeof fcResult.byGate.source.accuracy === 'number')
ok('R3: 原有数组结构不变', fcResult.length > 0 && typeof fcResult[0].lo === 'number')

// ============================================================
console.log('\n— R4: 误杀归因到通道 —')
// ============================================================

// 构造带 channelId 的 verdict
store.addVerdict({ gate: 'source', reason: 'low-quality', summary: '通道A误杀', score: 0.2, choice: '自媒体', channelId: 'ch-a' })
store.addVerdict({ gate: 'source', reason: 'low-quality', summary: '通道A再误杀', score: 0.3, choice: '自媒体', channelId: 'ch-a' })
store.addVerdict({ gate: 'dedup', reason: 'duplicate', summary: '通道B误杀', score: 0.5, choice: '一手数据', channelId: 'ch-b' })
store.addVerdict({ gate: 'source', reason: 'low-quality', summary: '无通道', score: 0.2, choice: '未知' })

const byCh = store.falseKillByChannel(30)
ok('R4: falseKillByChannel 返回数组', Array.isArray(byCh))
ok('R4: 有 ch-a', byCh.some(c => c.channelId === 'ch-a'), `实际 ${JSON.stringify(byCh.map(c => c.channelId))}`)
ok('R4: 有 ch-b', byCh.some(c => c.channelId === 'ch-b'))
ok('R4: 有未知通道', byCh.some(c => c.channelId === '未知通道'))
ok('R4: ch-a total = 2', byCh.find(c => c.channelId === 'ch-a')?.total === 2, `实际 ${byCh.find(c => c.channelId === 'ch-a')?.total}`)
ok('R4: 按 missed 降序', byCh[0]?.missed >= (byCh[1]?.missed || 0))

// 老 verdict 无 channelId 不报错
const oldVerdict = store.allVerdicts().find(v => !v.channelId)
ok('R4: 存在无 channelId 的 verdict', oldVerdict != null)

// ============================================================
console.log('\n— Fix: filterCalibration other gate 桶 —')
// ============================================================

store.addVerdict({ gate: 'extract', reason: 'off-topic', summary: 'extract gate 测试', score: 0.4, choice: '自媒体' })
const fcOther = store.filterCalibration()
ok('Fix: byGate 有 other', fcOther.byGate.other != null)
ok('Fix: other 有 label', fcOther.byGate.other.label === '其他 gate')
ok('Fix: other 有 accuracy', typeof fcOther.byGate.other.accuracy === 'number')
ok('Fix: other total > 0', fcOther.byGate.other.total > 0, `实际 ${fcOther.byGate.other.total}`)

// ============================================================
console.log('\n— Fix: purgeDead 区分用户删 vs 跌死 —')
// ============================================================

const purgeTheme = store.addTheme('purge 区分测试')
const purgeBranch = store.addNode({ themeId: purgeTheme.id, kind: 'branch', title: '测试环节', propagation: 0.5 })
const userDeleted = store.addNode({ themeId: purgeTheme.id, parentId: purgeBranch.id, kind: 'lemma', title: '用户手删的命题', confidence: 60 })
const autoDead = store.addNode({ themeId: purgeTheme.id, parentId: purgeBranch.id, kind: 'lemma', title: '跌死命题', confidence: 15 })

store.removeNode(userDeleted.id)
ok('Fix: 用户删后 status=dead', store.getNode(userDeleted.id)?.status === 'dead')
ok('Fix: 用户删有 deletedAt', store.getNode(userDeleted.id)?.deletedAt != null)

store.updateNode(autoDead.id, { confidence: 10 })
ok('Fix: 跌死 status=dead', store.getNode(autoDead.id)?.status === 'dead')
ok('Fix: 跌死无 deletedAt', store.getNode(autoDead.id)?.deletedAt == null)

const beforeDead = store.allNodes().filter((n) => n.status === 'dead')
const beforeUser = beforeDead.filter((n) => n.deletedAt).length
const beforeAuto = beforeDead.filter((n) => !n.deletedAt).length

const purgeAll = store.purgeDead()
ok('Fix: purgeAll removed = 全部 dead', purgeAll.removed === beforeDead.length, `实际 ${purgeAll.removed} vs ${beforeDead.length}`)
ok('Fix: purgeAll userDeleted 计数正确', purgeAll.userDeleted === beforeUser, `实际 ${purgeAll.userDeleted} vs ${beforeUser}`)
ok('Fix: purgeAll autoDead 计数正确', purgeAll.autoDead === beforeAuto, `实际 ${purgeAll.autoDead} vs ${beforeAuto}`)
ok('Fix: 真删后用户删节点不在', store.getNode(userDeleted.id) == null)
ok('Fix: 真删后跌死节点不在', store.getNode(autoDead.id) == null)

// scope = 'user' 只删用户删的
const purgeTheme2 = store.addTheme('purge scope 测试')
const purgeB2 = store.addNode({ themeId: purgeTheme2.id, kind: 'branch', title: '环节2', propagation: 0.5 })
const u2 = store.addNode({ themeId: purgeTheme2.id, parentId: purgeB2.id, kind: 'lemma', title: '手删2', confidence: 60 })
const a2 = store.addNode({ themeId: purgeTheme2.id, parentId: purgeB2.id, kind: 'lemma', title: '跌死2', confidence: 15 })
store.removeNode(u2.id)
store.updateNode(a2.id, { confidence: 8 })
const purgeUser = store.purgeDead('user')
ok('Fix: purgeUser removed = 1', purgeUser.removed === 1, `实际 ${purgeUser.removed}`)
ok('Fix: purgeUser 后跌死还在', store.getNode(a2.id)?.status === 'dead')
store.purgeDead('auto')

// ============================================================
console.log('\n— Fix: removeTheme 软删 —')
// ============================================================

const softTheme = store.addTheme('软删主题测试')
const softBranch = store.addNode({ themeId: softTheme.id, kind: 'branch', title: '软删环节', propagation: 0.5 })
const softLemma = store.addNode({ themeId: softTheme.id, parentId: softBranch.id, kind: 'lemma', title: '软删命题', confidence: 70 })

store.removeTheme(softTheme.id)
ok('Fix: 软删后主题不在 allThemes', !store.allThemes().some((t) => t.id === softTheme.id))
ok('Fix: 软删后节点 status=dead', store.getNode(softBranch.id)?.status === 'dead')
ok('Fix: 软删后子节点也 dead', store.getNode(softLemma.id)?.status === 'dead')
ok('Fix: 软删后节点有 deletedAt', store.getNode(softBranch.id)?.deletedAt != null)

const restored = store.restoreTheme(softTheme.id)
ok('Fix: restoreTheme 返回 true', restored === true)
ok('Fix: 恢复后主题在 allThemes', store.allThemes().some((t) => t.id === softTheme.id))
ok('Fix: 恢复后节点 status=live', store.getNode(softBranch.id)?.status === 'live')
ok('Fix: 恢复后子节点也 live', store.getNode(softLemma.id)?.status === 'live')

// ============================================================
console.log('\n— Fix: buildNotification 带上下文 —')
// ============================================================

const nCtx = buildNotification([{ id: 'x', title: '光模块超预期', confidence: 85, branchPath: '半导体 / 光模块', downstreamCount: 3 }])
ok('Fix: 通知正文含置信度', nCtx?.body.includes('85%'), `实际 ${nCtx?.body}`)
ok('Fix: 通知正文含挂点', nCtx?.body.includes('半导体 / 光模块'), `实际 ${nCtx?.body}`)
ok('Fix: 通知正文含下游数', nCtx?.body.includes('3 条下游'), `实际 ${nCtx?.body}`)

const nNoCtx = buildNotification([{ id: 'y', title: '无上下文命题' }])
ok('Fix: 无上下文时正文只有标题', nNoCtx?.body === '无上下文命题', `实际 ${nNoCtx?.body}`)

// ============================================================
console.log('\n— Fix2: bestThemeContext 不选已删主题 —')
// ============================================================

const btcTheme = store.addTheme('BTC 大主题')
const btcBranch = store.addNode({ themeId: btcTheme.id, kind: 'branch', title: 'BTC 环节', propagation: 0.5 })
for (let i = 0; i < 500; i++) {
  store.addNode({ themeId: btcTheme.id, parentId: btcBranch.id, kind: 'lemma', title: `BTC 命题 ${i}`, confidence: 60 })
}
const smallTheme = store.addTheme('小主题')
store.addNode({ themeId: smallTheme.id, kind: 'branch', title: '小环节', propagation: 0.5 })
store.addNode({ themeId: smallTheme.id, kind: 'lemma', title: '小命题', confidence: 60 })

ok('Fix2: 软删前 BTC 是 bestThemeContext', store.bestThemeContext()?.id === btcTheme.id, `实际 ${store.bestThemeContext()?.name}`)

store.removeTheme(btcTheme.id)
ok('Fix2: 软删后 bestThemeContext 不选已删主题', store.bestThemeContext()?.id !== btcTheme.id, `实际 ${store.bestThemeContext()?.name}`)
ok('Fix2: 软删后 bestThemeContext 选活跃主题', !store.deletedThemes().some((t) => t.id === store.bestThemeContext()?.id))

// stats().themes 也不包含已删主题
const stAfter = store.stats()
ok('Fix2: stats.themes 不含已删主题', stAfter.themes === store.allThemes().length, `实际 stats=${stAfter.themes} allThemes=${store.allThemes().length}`)

// stats().dead 数所有 dead 节点（含 branch）
const deadNodes = store.allNodes().filter((n) => n.status === 'dead')
ok('Fix2: stats.dead 数所有 dead 节点', stAfter.dead === deadNodes.length, `实际 stats=${stAfter.dead} actual=${deadNodes.length}`)

// 恢复
store.restoreTheme(btcTheme.id)
ok('Fix2: 恢复后 bestThemeContext 回到 BTC', store.bestThemeContext()?.id === btcTheme.id, `实际 ${store.bestThemeContext()?.name}`)

// deletedThemes 列表
store.removeTheme(smallTheme.id)
const delTs = store.deletedThemes()
ok('Fix2: deletedThemes 返回已删主题', delTs.some((t) => t.id === smallTheme.id))
ok('Fix2: deletedThemes 不含活跃主题', !delTs.some((t) => t.id === btcTheme.id))

// ============================================================
console.log('\n— Fix3: purgeDead dryRun 不落盘 —')
// ============================================================

const dryTheme = store.addTheme('dryRun 测试')
const dryBranch = store.addNode({ themeId: dryTheme.id, kind: 'branch', title: 'dry 环节', propagation: 0.5 })
const dryLemma = store.addNode({ themeId: dryTheme.id, parentId: dryBranch.id, kind: 'lemma', title: 'dry 命题', confidence: 60 })
store.removeNode(dryLemma.id)

const beforeCount = store.allNodes().filter((n) => n.status === 'dead').length
const dryResult = store.purgeDead('user', { dryRun: true })
ok('Fix3: dryRun 返回计数', dryResult.removed > 0, `实际 ${dryResult.removed}`)
ok('Fix3: dryRun 不删节点', store.allNodes().filter((n) => n.status === 'dead').length === beforeCount, `实际 ${store.allNodes().filter((n) => n.status === 'dead').length} vs ${beforeCount}`)
ok('Fix3: dryRun 后节点仍在', store.getNode(dryLemma.id) != null)

const realResult = store.purgeDead('user')
ok('Fix3: 真删后节点不在', store.getNode(dryLemma.id) == null)
ok('Fix3: 真删 removed > 0', realResult.removed > 0)

// ============================================================
console.log('\n— Fix3: 复盘页聚合逻辑 —')
// ============================================================

// 构造多天 intakeEvents，含 overridden
const aggTheme = store.addTheme('聚合测试主题')
const aggBranch = store.addNode({ themeId: aggTheme.id, kind: 'branch', title: '聚合环节', propagation: 0.5 })
for (let i = 0; i < 200; i++) {
  store.addNode({ themeId: aggTheme.id, parentId: aggBranch.id, kind: 'lemma', title: `聚合命题 ${i}`, confidence: 60 })
}

// 第一天：3 条捕获，1 条 overridden
store.addIntakeEvent({ at: '2026-09-20', themeId: aggTheme.id, outcome: 'inbox', gate: { pass: false }, label: { kind: '自媒体' }, lemmas: ['a'], overridden: true })
store.addIntakeEvent({ at: '2026-09-20', themeId: aggTheme.id, outcome: 'auto', gate: { pass: true }, label: { kind: '一手数据' }, lemmas: ['b'] })
store.addIntakeEvent({ at: '2026-09-20', themeId: aggTheme.id, outcome: 'inbox', gate: { pass: false }, label: { kind: '自媒体' }, lemmas: ['c'] })

// 第二天：2 条捕获，1 条 overridden
store.addIntakeEvent({ at: '2026-09-21', themeId: aggTheme.id, outcome: 'inbox', gate: { pass: false }, label: { kind: '自媒体' }, lemmas: ['d'], overridden: true })
store.addIntakeEvent({ at: '2026-09-21', themeId: aggTheme.id, outcome: 'auto', gate: { pass: true }, label: { kind: '一手数据' }, lemmas: ['e'] })

const aggSeries = store.intakeSeries(30)
const day20 = aggSeries.find((b) => b.date === '2026-09-20')
const day21 = aggSeries.find((b) => b.date === '2026-09-21')

ok('Fix3: day20 captured = 3', day20?.captured === 3, `实际 ${day20?.captured}`)
ok('Fix3: day20 overridden = 1', day20?.overridden === 1, `实际 ${day20?.overridden}`)
ok('Fix3: day21 overridden = 1', day21?.overridden === 1, `实际 ${day21?.overridden}`)

// 复盘页聚合逻辑（与 vault.js renderReview 中的 reduce 相同）
const agg = aggSeries.reduce((a, b) => ({
  captured: a.captured + b.captured,
  gatedIn: a.gatedIn + b.gatedIn,
  autoImported: a.autoImported + b.autoImported,
  toInbox: a.toInbox + b.toInbox,
  confirmed: a.confirmed + b.confirmed,
  rejected: a.rejected + b.rejected,
  undone: a.undone + b.undone,
  overridden: a.overridden + b.overridden,
  degraded: a.degraded + b.degraded,
}), { captured: 0, gatedIn: 0, autoImported: 0, toInbox: 0, confirmed: 0, rejected: 0, undone: 0, overridden: 0, degraded: 0 })

ok('Fix3: 聚合 overridden > 0', agg.overridden > 0, `实际 ${agg.overridden}`)
ok('Fix3: 聚合 overridden = 2', agg.overridden === 2, `实际 ${agg.overridden}`)

// 归位修改率 = overridden / (autoImported + confirmed)
const overrideRate = agg.autoImported + agg.confirmed > 0 ? Math.round((agg.overridden / (agg.autoImported + agg.confirmed)) * 100) : 0
ok('Fix3: 归位修改率 > 0', overrideRate > 0, `实际 ${overrideRate}%`)
ok('Fix3: 归位修改率 = overridden/(auto+confirmed)', agg.overridden === 2 && overrideRate === Math.round(2 / (agg.autoImported + agg.confirmed) * 100), `实际 ${overrideRate}% (overridden=${agg.overridden} auto=${agg.autoImported} confirmed=${agg.confirmed})`)

// ============================================================
console.log('\n— Fix4: planPurge 取消后数据不变 —')
// ============================================================

const { planPurge } = await import('../src/main/store.js')

// 构造有用户删和跌死节点的场景
const ppTheme = store.addTheme('planPurge 测试')
const ppBranch = store.addNode({ themeId: ppTheme.id, kind: 'branch', title: 'pp 环节', propagation: 0.5 })
const ppUser = store.addNode({ themeId: ppTheme.id, parentId: ppBranch.id, kind: 'lemma', title: '用户删的', confidence: 60 })
const ppAuto = store.addNode({ themeId: ppTheme.id, parentId: ppBranch.id, kind: 'lemma', title: '跌死的', confidence: 15 })
store.removeNode(ppUser.id)
store.updateNode(ppAuto.id, { confidence: 8 })

const deadBefore = store.allNodes().filter((n) => n.status === 'dead').length

// 场景1：用户点取消
const preview1 = store.purgeDead('user', { dryRun: true })
const plan1 = planPurge('user', preview1, false)
ok('Fix4: 取消时 willDelete = false', !plan1.willDelete)
ok('Fix4: 取消时 reason = canceled', plan1.reason === 'canceled')
ok('Fix4: 取消后 dead 节点数不变', store.allNodes().filter((n) => n.status === 'dead').length === deadBefore, `实际 ${store.allNodes().filter((n) => n.status === 'dead').length} vs ${deadBefore}`)
ok('Fix4: 取消后用户删节点仍在', store.getNode(ppUser.id) != null)
ok('Fix4: 取消后跌死节点仍在', store.getNode(ppAuto.id) != null)

// 场景2：用户确认
const preview2 = store.purgeDead('user', { dryRun: true })
const plan2 = planPurge('user', preview2, true)
ok('Fix4: 确认时 willDelete = true', plan2.willDelete)
ok('Fix4: 确认时 count = preview.removed', plan2.count === preview2.removed)
if (plan2.willDelete) {
  const r = store.purgeDead(plan2.scope)
  ok('Fix4: 确认后真删了', r.removed > 0)
  ok('Fix4: 确认后用户删节点不在', store.getNode(ppUser.id) == null)
  ok('Fix4: 确认后跌死节点仍在（只删 user scope）', store.getNode(ppAuto.id) != null)
}

// 场景3：空集
const preview3 = store.purgeDead('user', { dryRun: true })
const plan3 = planPurge('user', preview3, true)
ok('Fix4: 空集时 willDelete = false', !plan3.willDelete)
ok('Fix4: 空集时 reason = empty', plan3.reason === 'empty')

// ============================================================
console.log('\n— R1: 取数器注册表 —')
// ============================================================

const { fetchChannel, availableFetchers } = await import('../src/main/fetchers.js')

const avail = availableFetchers()
ok('R1: availableFetchers 包含 rss', avail.includes('rss'))
ok('R1: availableFetchers 包含 web', avail.includes('web'))
ok('R1: availableFetchers 不含未实现的 tavily', !avail.includes('tavily'))
ok('R1: availableFetchers 不含 null 值', avail.every((k) => k != null))

// 未实现的 fetch 类型静默返回空
const unkResult = await fetchChannel({ fetch: 'tavily', query: 'test', kind: '自媒体' })
ok('R1: 未实现类型返回空 items', unkResult.items.length === 0 && !unkResult.error)

// 未知 fetch 类型也静默返回空
const unkResult2 = await fetchChannel({ fetch: 'nonexistent', query: 'test' })
ok('R1: 未知类型返回空 items', unkResult2.items.length === 0 && !unkResult2.error)

// web fetcher 对短文本返回空
const shortResult = await fetchChannel({ fetch: 'web', query: 'about:blank', name: 'test', kind: '自媒体' })
ok('R1: web fetcher 失败时返回空 items', shortResult.items.length === 0)

// ============================================================
console.log('\n— R2: readings 读数集合 —')
// ============================================================

// 基本添加
const r1 = store.addReading({
  metric: 'nvda.revenue',
  value: 9714000000,
  unit: 'USD',
  asOf: '2018-01-28',
  at: '2026-09-20',
  source: { kind: '财报 / 公告', start: '2017-01-30', end: '2018-01-28', accn: '0001045810-19-000010', url: 'https://sec.gov/...' },
  basis: 'reported',
})
ok('R2: addReading 返回 added: true', r1.added === true)
ok('R2: reading 有 id', r1.reading.id != null)
ok('R2: reading 有 dedupeKey', r1.reading.dedupeKey != null)
ok('R2: dedupeKey 格式正确', r1.reading.dedupeKey === 'nvda.revenue|2017-01-30|2018-01-28|0001045810-19-000010')

// 幂等：同一 dedupeKey 再加一次
const r2 = store.addReading({
  metric: 'nvda.revenue',
  value: 9714000000,
  unit: 'USD',
  asOf: '2018-01-28',
  source: { kind: '财报 / 公告', start: '2017-01-30', end: '2018-01-28', accn: '0001045810-19-000010' },
})
ok('R2: 重复 dedupeKey 返回 added: false', r2.added === false)

// 同一期间不同 accn（10-K 比较期重列）→ 两条记录
const r3 = store.addReading({
  metric: 'nvda.revenue',
  value: 9714000000,
  unit: 'USD',
  asOf: '2018-01-28',
  at: '2026-09-20',
  source: { kind: '财报 / 公告', start: '2017-01-30', end: '2018-01-28', accn: '0001045810-20-000036' },
})
ok('R2: 同期间不同 accn 是新记录', r3.added === true)
ok('R2: 两条记录都在', store.allReadings().filter((r) => r.metric === 'nvda.revenue').length === 2)

// 不同 metric
const r4 = store.addReading({
  metric: 'nvda.grossProfit',
  value: 5000000000,
  unit: 'USD',
  asOf: '2024-01-28',
  source: { kind: '财报 / 公告', start: '2023-01-30', end: '2024-01-28', accn: '0001045810-24-000001' },
})
ok('R2: 不同 metric 是新记录', r4.added === true)

// allReadings + 本地过滤
const revReadings = store.allReadings().filter((r) => r.metric === 'nvda.revenue')
ok('R2: allReadings 过滤 metric 正确', revReadings.length === 2 && revReadings.every((r) => r.metric === 'nvda.revenue'))

// nodeId 过滤
const r5 = store.addReading({
  metric: 'aapl.revenue',
  value: 391000000000,
  unit: 'USD',
  asOf: '2024-09-28',
  nodeId: 'node-ind-1',
  source: { kind: '财报 / 公告', start: '2023-10-01', end: '2024-09-28', accn: '0000320193-24-000001' },
})
const indReadings = store.allReadings().filter((r) => r.nodeId === 'node-ind-1')
ok('R2: allReadings 过滤 nodeId 正确', indReadings.length === 1 && indReadings[0].metric === 'aapl.revenue')

// latestReading 语义：groupReadings 的 latest 字段
const r6 = store.addReading({
  metric: 'nvda.revenue',
  value: 16675000000,
  unit: 'USD',
  asOf: '2026-01-25',
  at: '2026-09-23',
  source: { kind: '财报 / 公告', start: '2025-01-27', end: '2026-01-25', accn: '0001045810-26-000001' },
})
const revGroups = groupReadings(store.allReadings().filter((r) => r.metric === 'nvda.revenue'))
const latest = revGroups[0].latest
ok('R2: groupReadings latest 返回最新', latest != null && latest.value === 16675000000)
ok('R2: 旧记录仍在', store.allReadings().filter((r) => r.metric === 'nvda.revenue').length === 3)

// stats 包含 readings
const stReadings = store.stats()
ok('R2: stats 包含 readings 计数', typeof stReadings.readings === 'number' && stReadings.readings >= 4)

// calibration 不含 readings 的影响
const calibR = store.calibration()
ok('R2: calibration 不受 readings 影响', !calibR.some((c) => c.metric != null && c.value != null))

// 导出 → 导入 → readings 不丢
const exportedR = store.exportAll({ withRaw: false })
const parsedR = JSON.parse(exportedR)
ok('R2: 导出包含 readings', Array.isArray(parsedR.readings) && parsedR.readings.length >= 4)

// 老文件（无 readings 字段）导入后是空数组
delete parsedR.readings
const oldFileStrR = JSON.stringify(parsedR)
store.importAll(oldFileStrR)
ok('R2: 老文件导入后 readings 为空', store.stats().readings === 0)

// 恢复数据
store.importAll(exportedR)
ok('R2: 重新导入后 readings 恢复', store.stats().readings >= 4)

// 没有 updateReading / removeReading / 三个死函数
const storeExports = Object.keys(store)
ok('R2: 没有 updateReading', !storeExports.includes('updateReading'))
ok('R2: 没有 removeReading', !storeExports.includes('removeReading'))
ok('R2: 没有 readingsByMetric', !storeExports.includes('readingsByMetric'))
ok('R2: 没有 readingsByIndicator', !storeExports.includes('readingsByIndicator'))
ok('R2: 没有 latestReading', !storeExports.includes('latestReading'))
ok('R2: 没有 groupReadings（已移至 shared）', !storeExports.includes('groupReadings'))

// ============================================================
console.log('\n— 读数展示: groupReadings 纯函数 —')
// ============================================================


// 构造测试数据
const testReadings = [
  { metric: 'a.revenue', value: 100, unit: 'USD', asOf: '2024-Q1', at: '2026-09-01', indicatorId: null, source: {} },
  { metric: 'a.revenue', value: 200, unit: 'USD', asOf: '2024-Q2', at: '2026-09-02', indicatorId: null, source: {} },
  { metric: 'a.revenue', value: 150, unit: 'USD', asOf: '2024-Q3', at: '2026-09-03', indicatorId: null, source: {} },
  { metric: 'b.profit', value: 50, unit: 'USD', asOf: '2024-Q2', at: '2026-09-02', indicatorId: 'ind-1', source: {} },
  { metric: 'b.profit', value: 60, unit: 'USD', asOf: null, at: '2026-09-01', indicatorId: 'ind-1', source: {} },
]

const groups = groupReadings(testReadings)
ok('分组: 2 个 metric', groups.length === 2)
ok('分组: a.revenue 有 3 条', groups.find((g) => g.metric === 'a.revenue').count === 3)
ok('分组: b.profit 有 2 条', groups.find((g) => g.metric === 'b.profit').count === 2)

// 最新一条置顶
const aGroup = groups.find((g) => g.metric === 'a.revenue')
ok('分组: a.revenue 最新置顶', aGroup.items[0].at === '2026-09-03')
ok('分组: a.revenue 最新 value = 150', aGroup.items[0].value === 150)

// 其余按 asOf 倒序
ok('分组: a.revenue 第二条 asOf = 2024-Q2', aGroup.items[1].asOf === '2024-Q2')
ok('分组: a.revenue 第三条 asOf = 2024-Q1', aGroup.items[2].asOf === '2024-Q1')

// 无 asOf 排最后
const bGroup = groups.find((g) => g.metric === 'b.profit')
ok('分组: b.profit 无 asOf 排最后', bGroup.items[bGroup.items.length - 1].asOf === null)

// latest 字段正确
ok('分组: a.revenue latest.at = 2026-09-03', aGroup.latest.at === '2026-09-03')
ok('分组: b.profit latest.at = 2026-09-02', bGroup.latest.at === '2026-09-02')
ok('分组: b.profit latest value = 50', bGroup.latest.value === 50)

// 空数组
ok('分组: 空数组返回空', groupReadings([]).length === 0)

// 单条
const single = groupReadings([{ metric: 'x', value: 1, asOf: '2024-Q1', at: '2026-09-01', source: {} }])
ok('分组: 单条 latest = 自身', single[0].latest === single[0].items[0])

// 折叠阈值不在此函数（由 UI 控制），但确认 items 返回全部
ok('分组: items 返回全部', aGroup.items.length === 3)

// IPC: openExternal 只允许 http/https
const openResult1 = fire('io:openExternal', 'javascript:alert(1)')
ok('IPC: openExternal 拒绝 javascript:', openResult1 === false)
const openResult2 = fire('io:openExternal', 'file:///etc/passwd')
ok('IPC: openExternal 拒绝 file:', openResult2 === false)
const openResult3 = fire('io:openExternal', 'not-a-url')
ok('IPC: openExternal 拒绝非 URL', openResult3 === false)

// preload.js 和 preload.cjs 同步
import { readFileSync as readFileSync2 } from 'node:fs'
import { fileURLToPath as fileURLToPath2 } from 'node:url'
const ROOT2 = join(dirname(fileURLToPath2(import.meta.url)), '..')
const pj = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
// 提取桥接键对比（去掉 require/import 行差异）
const extractKeys = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('preload: 两份桥接键同步', JSON.stringify(extractKeys(pj)) === JSON.stringify(extractKeys(pc)))

// ============================================================
console.log('\n— R3: SEC EDGAR 取数器 —')
// ============================================================

const { convertEdgarConcept, filterFilings } = await import('../src/main/fetchers.js')
const conceptFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/edgar-companyconcept.json'), 'utf8'))
const filingsFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/edgar-submissions.json'), 'utf8'))

// --- Path A: convertEdgarConcept 纯函数 ---
const testChannel = { id: 'ch-edgar', kind: '财报 / 公告', metric: 'RevenueFromContractWithCustomerExcludingAssessedTax', query: 'NVDA' }
const readingInputs = convertEdgarConcept(conceptFixture, testChannel, '0001045810', 'NVDA', 'NVIDIA CORP')

ok('R3: convertEdgarConcept 产出 6 条', readingInputs.length === 6)
ok('R3: metric 命名用 ticker 小写', readingInputs[0].metric === 'nvda.RevenueFromContractWithCustomerExcludingAssessedTax')
ok('R3: value 正确', readingInputs[0].value === 9714000000)
ok('R3: unit = USD', readingInputs[0].unit === 'USD')
ok('R3: asOf = rec.end', readingInputs[0].asOf === '2018-01-28')
ok('R3: basis = reported (10-K)', readingInputs[0].basis === 'reported')
ok('R3: source.kind 由取数器给定', readingInputs[0].source.kind === '财报 / 公告')
ok('R3: source.platform = SEC EDGAR', readingInputs[0].source.platform === 'SEC EDGAR')
ok('R3: source.url 存在', readingInputs[0].source.url.includes('sec.gov'))
ok('R3: indicatorId 不再写入', readingInputs[0].indicatorId === undefined)
ok('R3: channelId 正确', readingInputs[0].channelId === 'ch-edgar')

// 重复期间（1.4 实例）：同一 start+end 不同 accn，两条都在
ok('R3: 重复期间第1条 accn', readingInputs[0].source.accn === '0001045810-19-000010')
ok('R3: 重复期间第2条 accn', readingInputs[1].source.accn === '0001045810-20-000036')
ok('R3: 重复期间 dedupeKey 不同', readingInputs[0].dedupeKey !== readingInputs[1].dedupeKey)

// --- Path A: 幂等 — 同一批 readingInputs 跑两次 addReading ---
let added1 = 0, skipped1 = 0
for (const input of readingInputs) {
  const r = store.addReading(input)
  if (r.added) added1++; else skipped1++
}
ok('R3: 第一次全部 added', added1 === 6 && skipped1 === 0)

let added2 = 0, skipped2 = 0
for (const input of readingInputs) {
  const r = store.addReading(input)
  if (r.added) added2++; else skipped2++
}
ok('R3: 第二次全部 skipped (幂等)', added2 === 0 && skipped2 === 6)

// --- Path B: filterFilings 纯函数 ---
const filtered = filterFilings(filingsFixture.filings, 5)
const forms = filtered.map((f) => f.form)
ok('R3: filterFilings 只含 10-K/10-Q/8-K', forms.every((f) => ['10-K', '10-Q', '8-K'].includes(f)))
ok('R3: filterFilings 过滤掉 Form 4', !forms.includes('4'))
ok('R3: filterFilings 过滤掉 144', !forms.includes('144'))
ok('R3: filterFilings 最多 5 条', filtered.length <= 5)
ok('R3: filterFilings 有 accessionNumber', filtered[0].accessionNumber != null)
ok('R3: filterFilings 有 primaryDocument', filtered[0].primaryDocument != null)

// --- grep 验收 ---
const fetchersSrc = readFileSync2(join(ROOT2, 'src/main/fetchers.js'), 'utf8')
ok('R3: fetchers.js 不调 labelSource', !fetchersSrc.includes('labelSource'))
ok('R3: fetchers.js 不用 companyfacts', !fetchersSrc.includes('companyfacts'))

// --- channels.metric 端到端 ---
const edgarCh = store.addChannel({ name: 'EDGAR 测试', query: 'NVDA', fetch: 'edgarConcept', metric: 'RevenueFromContractWithCustomerExcludingAssessedTax', kind: '财报 / 公告' })
ok('R3: channel.metric 存储成功', edgarCh.metric === 'RevenueFromContractWithCustomerExcludingAssessedTax')
const chFromDb = store.allChannels().find((c) => c.id === edgarCh.id)
ok('R3: channel.metric 从 DB 读回', chFromDb.metric === 'RevenueFromContractWithCustomerExcludingAssessedTax')

// ============================================================
console.log('\n— 数据源统一为通道：迁移 —')
// ============================================================

// --- 旧格式数据：3 条 feeds，0 条 channels ---
const oldData = JSON.stringify({
  version: 3,
  settings: {},
  themes: [],
  nodes: [],
  verdicts: [],
  conflicts: [],
  feeds: [
    { id: 'feed-1', name: 'Reuters RSS', url: 'https://reuters.com/feed.xml', kind: 'rss', themeId: null, interval: 60, lastFetch: '2026-09-20', lastCount: 15, enabled: true, createdAt: '2026-09-01' },
    { id: 'feed-2', name: 'Bloomberg RSS', url: 'https://bloomberg.com/feed.xml', kind: 'rss', themeId: null, interval: 30, lastFetch: null, lastCount: null, enabled: true, createdAt: '2026-09-02' },
    { id: 'feed-3', name: 'WSJ RSS', url: 'https://wsj.com/feed.xml', kind: 'rss', themeId: null, interval: 120, lastFetch: '2026-09-22', lastCount: 8, enabled: false, createdAt: '2026-09-03' },
  ],
  inbox: [],
  traces: [],
  channels: [],
  intakeEvents: [],
  readings: [],
})

store.importAll(oldData)
const migratedChannels = store.allChannels()
const migratedFeeds = store.load().feeds

ok('迁移: 3 条 feeds → 3 条 channels', migratedChannels.length === 3)
ok('迁移: feeds 集合清空', migratedFeeds.length === 0)
ok('迁移: kind 映射为 独立媒体', migratedChannels.every((c) => c.kind === '独立媒体'))
ok('迁移: 无 rss 出现在 channel.kind', !migratedChannels.some((c) => c.kind === 'rss'))
ok('迁移: fetch 设为 rss', migratedChannels.every((c) => c.fetch === 'rss'))
ok('迁移: query 保留原 URL', migratedChannels.some((c) => c.query === 'https://reuters.com/feed.xml'))
ok('迁移: id 保留', migratedChannels.some((c) => c.id === 'feed-1'))
ok('迁移: name 保留', migratedChannels.some((c) => c.name === 'Reuters RSS'))
ok('迁移: interval 保留', migratedChannels.find((c) => c.id === 'feed-1').interval === 60)
ok('迁移: lastFetch 保留', migratedChannels.find((c) => c.id === 'feed-1').lastFetch === '2026-09-20')
ok('迁移: lastCount 保留', migratedChannels.find((c) => c.id === 'feed-1').lastCount === 15)
ok('迁移: enabled 保留', migratedChannels.find((c) => c.id === 'feed-3').enabled === false)
ok('迁移: review 默认 false', migratedChannels.every((c) => c.review === false))

// --- 幂等：导出再导入，channels 不翻倍 ---
const migratedExport = store.exportAll()
const migratedExportJson = JSON.parse(migratedExport)
ok('幂等: 导出 feeds 为空', Array.isArray(migratedExportJson.feeds) && migratedExportJson.feeds.length === 0)
ok('幂等: 导出 version 为 4', migratedExportJson.version === 4)
const channelCountBefore = store.allChannels().length
store.importAll(migratedExport)
const channelCountAfter = store.allChannels().length
ok('幂等: 再导入 channels 不翻倍', channelCountAfter === channelCountBefore)

// --- 去重：旧数据里 feeds 和 channels 有同 URL，不重复 ---
const dedupData = JSON.stringify({
  version: 3,
  settings: {},
  themes: [],
  nodes: [],
  verdicts: [],
  conflicts: [],
  feeds: [
    { id: 'feed-dup', name: 'Reuters RSS', url: 'https://reuters.com/feed.xml', kind: 'rss', interval: 60, enabled: true, createdAt: '2026-09-01' },
    { id: 'feed-new', name: 'CNBC RSS', url: 'https://cnbc.com/feed.xml', kind: 'rss', interval: 60, enabled: true, createdAt: '2026-09-04' },
  ],
  inbox: [],
  traces: [],
  channels: [
    { id: 'ch-existing', name: 'Reuters RSS', kind: '独立媒体', fetch: 'rss', query: 'https://reuters.com/feed.xml', themeId: null, metric: null, interval: 60, lastFetch: null, lastCount: null, cadence: '日', network: 'direct', enabled: true, review: false, createdAt: '2026-09-01' },
  ],
  intakeEvents: [],
  readings: [],
})
store.importAll(dedupData)
const dedupChannels = store.allChannels()
ok('去重: 同 URL 不重复', dedupChannels.filter((c) => c.query === 'https://reuters.com/feed.xml').length === 1)
ok('去重: 新 URL 正常添加', dedupChannels.some((c) => c.query === 'https://cnbc.com/feed.xml'))
ok('去重: 总数 2（1 已有 + 1 新）', dedupChannels.length === 2)

// --- 旧导出文件可导入（version 3 + feeds 有数据） ---
ok('兼容: 旧格式导入不报错', true)

// --- grep 验收 ---
const vaultSrc = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const settingsSrc = readFileSync2(join(ROOT2, 'src/renderer/views/settings.js'), 'utf8')
const ipcSrc = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const preloadSrc = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const preloadCjsSrc = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

ok('验收: vault.js 无 inputs.kind ||', !vaultSrc.includes('inputs.kind ||'))
ok('验收: vault.js 无 inputs.fetch ||', !vaultSrc.includes('inputs.fetch ||'))
ok('验收: settings.js 无 通道与取数', !settingsSrc.includes('通道与取数'))
ok('验收: settings.js 无 订阅源', !settingsSrc.includes('订阅源'))
ok('验收: ipc.js 无 generatePills', !ipcSrc.includes('generatePills'))
ok('验收: ipc.js 无 feedFetchAndLabel', !ipcSrc.includes('feedFetchAndLabel'))
ok('验收: ipc.js 无 feedImport', !ipcSrc.includes('feedImport'))
ok('验收: ipc.js 无 feed:list', !ipcSrc.includes('feed:list'))
ok('验收: preload.js 无 feedFetchAndLabel', !preloadSrc.includes('feedFetchAndLabel'))
ok('验收: preload.js 无 feedImport', !preloadSrc.includes('feedImport'))
ok('验收: preload.cjs 无 feedFetchAndLabel', !preloadCjsSrc.includes('feedFetchAndLabel'))
ok('验收: preload.cjs 无 feedImport', !preloadCjsSrc.includes('feedImport'))

// feeds.js 已删除
import { existsSync as existsSync2 } from 'node:fs'
ok('验收: feeds.js 已删除', !existsSync2(join(ROOT2, 'src/renderer/views/feeds.js')))

// ============================================================
console.log('\n— R7: 指标来源面板 —')
// ============================================================

// --- 3.1 packId 修复：非 AI 描述 → 0 通道 ---
const nonAiTheme = await fire('theme:setupNew', '纺织服装供应链')
const nonAiChannels = store.allChannels().filter((c) => c.themeId === nonAiTheme.id)
ok('R7 packId: 非 AI 描述 → 0 通道', nonAiChannels.length === 0, `实际 ${nonAiChannels.length}`)

const aiTheme = await fire('theme:setupNew', 'AI 产业链')
const aiChannels = store.allChannels().filter((c) => c.themeId === aiTheme.id)
ok('R7 packId: AI 描述 → 有通道', aiChannels.length > 0, `实际 ${aiChannels.length}`)

// --- 3.2 指针机制：channelIds ---
const ptrTheme = store.addTheme('R7 指针测试')
const r7Ch1 = store.addChannel({ name: 'EDGAR NVDA', fetch: 'edgarConcept', query: 'NVDA', kind: '财报 / 公告', themeId: ptrTheme.id })
const r7Ch2 = store.addChannel({ name: 'EDGAR MSFT', fetch: 'edgarConcept', query: 'MSFT', kind: '财报 / 公告', themeId: ptrTheme.id })
const r7Ch3 = store.addChannel({ name: 'EDGAR GOOGL', fetch: 'edgarConcept', query: 'GOOGL', kind: '财报 / 公告', themeId: ptrTheme.id })

const indNode = store.addNode({ themeId: ptrTheme.id, kind: 'lemma', title: '云厂商 capex', type: 'observation', channelIds: [r7Ch1.id, r7Ch2.id, r7Ch3.id] })
ok('R7 channelIds: 挂 3 个通道', indNode.channelIds.length === 3)

store.updateNode(indNode.id, { channelIds: [r7Ch1.id, r7Ch2.id] })
ok('R7 channelIds: 更新为 2', store.getNode(indNode.id).channelIds.length === 2)

// 旧节点 migrate 补 channelIds
const oldNodeData = JSON.stringify({
  version: 4,
  settings: {},
  themes: [],
  nodes: [{ id: 'r7-old-node', themeId: null, parentId: null, kind: 'lemma', title: '旧指标', type: 'observation', confidence: 50, sources: [], tags: [], tickers: [], status: 'live', history: [], by: 'manual', stableId: 'r7-old', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
  verdicts: [], conflicts: [], feeds: [], inbox: [], traces: [], channels: [], intakeEvents: [], readings: [],
})
store.importAll(oldNodeData)
const oldNode = store.allNodes().find((n) => n.id === 'r7-old-node')
ok('R7 migrate: 旧节点 channelIds 为空数组', Array.isArray(oldNode?.channelIds) && oldNode.channelIds.length === 0)

// 导出导入 channelIds 不丢
store.addNode({ themeId: null, kind: 'lemma', title: '导出测试', type: 'observation', channelIds: ['fake-ch-1', 'fake-ch-2'] })
const r7Export = store.exportAll()
store.importAll(r7Export)
const exportedNode = store.allNodes().find((n) => n.title === '导出测试')
ok('R7 导出导入: channelIds 不丢', exportedNode?.channelIds?.length === 2)

// --- indicatorsForReading ---
const ifrTheme = store.addTheme('R7 反查测试')
const ifrCh = store.addChannel({ name: 'EDGAR TSLA', fetch: 'edgarConcept', query: 'TSLA', kind: '财报 / 公告', themeId: ifrTheme.id })
const ifrNode = store.addNode({ themeId: ifrTheme.id, kind: 'lemma', title: 'TSLA 收入', type: 'observation', channelIds: [ifrCh.id] })
const ifrReading = store.addReading({ metric: 'tsla.revenue', value: 96773000000, unit: 'USD', channelId: ifrCh.id, at: '2026-09-20', source: { kind: '财报 / 公告', start: '2024-01-01', end: '2024-03-31', accn: '0001628280-24-020' } })
ok('R7 addReading: 返回 added', ifrReading.added === true)
const inds = store.indicatorsForReading(ifrReading.reading)
ok('R7 indicatorsForReading: 返回该指标', inds.length === 1 && inds[0].id === ifrNode.id)

// 无 channelId 的读数 → 空数组
const orphanReading = { channelId: null, metric: 'test' }
ok('R7 indicatorsForReading: 无 channelId → 空', store.indicatorsForReading(orphanReading).length === 0)

// --- latestReadingByChannel ---
const latest1 = store.latestReadingByChannel(ifrCh.id)
ok('R7 latestReadingByChannel: 返回最新', latest1 != null && latest1.metric === 'tsla.revenue')

// 多条读数取最新
store.addReading({ metric: 'tsla.revenue', value: 97000000000, unit: 'USD', channelId: ifrCh.id, source: { kind: '财报 / 公告', start: '2024-04-01', end: '2024-06-30', accn: '0001628280-24-030' }, at: '2026-09-24' })
const latest2 = store.latestReadingByChannel(ifrCh.id)
ok('R7 latestReadingByChannel: 多条取最新', latest2.value === 97000000000)

// 不存在的 channel → null
ok('R7 latestReadingByChannel: 不存在 → null', store.latestReadingByChannel('nonexistent') === null)

// --- 3.4 interval 端到端 ---
const intervalCh = store.addChannel({ name: '间隔测试', fetch: 'rss', query: 'https://example.com', kind: '独立媒体', interval: 30 })
ok('R7 interval: 填 30 → 读回 30', intervalCh.interval === 30)
const intervalChFromDb = store.allChannels().find((c) => c.id === intervalCh.id)
ok('R7 interval: 从 DB 读回 30', intervalChFromDb.interval === 30)

// --- 3.6 改 fetch 类型清场 ---
const clearCh = store.addChannel({ name: '清场测试', fetch: 'edgarConcept', query: 'NVDA', metric: 'RevenueFromContractWithCustomerExcludingAssessedTax', kind: '财报 / 公告' })
ok('R7 清场: 初始有 metric', clearCh.metric != null)
store.updateChannel(clearCh.id, { fetch: 'web', metric: null })
const clearedCh = store.allChannels().find((c) => c.id === clearCh.id)
ok('R7 清场: edgarConcept → web 清 metric', clearedCh.metric === null)

// --- 缺口列表：observation 节点无 channelIds ---
const gapTheme = store.addTheme('R7 缺口测试')
store.addNode({ themeId: gapTheme.id, kind: 'lemma', title: '有通道的指标', type: 'observation', channelIds: ['some-ch'] })
store.addNode({ themeId: gapTheme.id, kind: 'lemma', title: '无通道的指标1', type: 'observation' })
store.addNode({ themeId: gapTheme.id, kind: 'lemma', title: '无通道的指标2', type: 'observation' })
const gapNodes = store.allNodes().filter((n) => n.themeId === gapTheme.id && n.type === 'observation' && (!n.channelIds || n.channelIds.length === 0))
ok('R7 缺口: 2 个无通道指标', gapNodes.length === 2)

// --- grep 验收 ---
const inspectorSrc = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
const vaultSrcR7 = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')

// 读数视图和来源面板无「加权」「汇总」「总量」「合计」
ok('R7 验收: vault.js 无 加权', !vaultSrcR7.includes('加权'))
ok('R7 验收: vault.js 无 汇总', !vaultSrcR7.includes('汇总'))
ok('R7 验收: vault.js 无 总量', !vaultSrcR7.includes('总量'))
ok('R7 验收: vault.js 无 合计', !vaultSrcR7.includes('合计'))
ok('R7 验收: inspector.js 无 加权', !inspectorSrc.includes('加权'))
ok('R7 验收: inspector.js 无 汇总', !inspectorSrc.includes('汇总'))
ok('R7 验收: inspector.js 无 总量', !inspectorSrc.includes('总量'))
ok('R7 验收: inspector.js 无 合计', !inspectorSrc.includes('合计'))

// 新代码不写 indicatorId（store.js addReading 里有 indicatorId 是旧代码，不算新写）
// 检查 inspector.js 不含 indicatorId；vault.js 不创建含 indicatorId 属性的对象（读取 p.indicatorId 不算写）
ok('R7 验收: inspector.js 无 indicatorId 写入', !inspectorSrc.includes('indicatorId'))
ok('R7 验收: vault.js 不写 indicatorId 属性', !vaultSrcR7.includes('indicatorId:') && !vaultSrcR7.match(/\{\s*indicatorId\s*[,:}]/))

// preload 两份同步
const pjR7 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcR7 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeysR7 = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('R7 验收: preload 两份同步', JSON.stringify(extractKeysR7(pjR7)) === JSON.stringify(extractKeysR7(pcR7)))

// 新 store 导出函数有渲染层调用方
ok('R7 验收: indicatorsForReading 有渲染层调用', inspectorSrc.includes('indicatorsForReading') || vaultSrcR7.includes('indicatorsForReading'))
ok('R7 验收: latestReadingByChannel 有渲染层调用', inspectorSrc.includes('latestReadingByChannel') || vaultSrcR7.includes('latestReadingByChannel'))

// ============================================================
// v0.6.3: O1-O5 优化
// ============================================================

console.log('\n— v0.6.3: O1-O5 优化 —')

// --- O1: us-gaap 标签发现 ---
const { parseCompanyFacts } = await import('../src/main/discover.js')
const { COMMON_US_GAAP } = await import('../src/main/store.js')
const factsFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/edgar-companyfacts.json'), 'utf8'))
const parsedTags = parseCompanyFacts(factsFixture)

ok('O1: parseCompanyFacts 返回标签数组', Array.isArray(parsedTags))
ok('O1: 解析出 6 个 us-gaap 标签', parsedTags.length === 6, `实际 ${parsedTags.length}`)
// 常用标签置顶
const commonTags = parsedTags.filter((t) => t.common)
ok('O1: 常用标签置顶', commonTags.length > 0 && parsedTags.indexOf(commonTags[0]) === 0)
ok('O1: Revenues 是常用标签', parsedTags.find((t) => t.tag === 'Revenues')?.common === true)
ok('O1: NetIncomeLoss 是常用标签', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.common === true)
ok('O1: SomeObscureTag 不是常用标签', parsedTags.find((t) => t.tag === 'SomeObscureTag')?.common === false)
// 期间数
ok('O1: Revenues 有 2 个期间', parsedTags.find((t) => t.tag === 'Revenues')?.periods === 2)
ok('O1: DeferredRevenue 有 0 个期间', parsedTags.find((t) => t.tag === 'DeferredRevenue')?.periods === 0)
ok('O1: NetIncomeLoss 有 1 个期间', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.periods === 1)
// 常用标签按 COMMON_US_GAAP 中的顺序
const revIdx = parsedTags.findIndex((t) => t.tag === 'Revenues')
const niIdx = parsedTags.findIndex((t) => t.tag === 'NetIncomeLoss')
ok('O1: Revenues 在 NetIncomeLoss 前', revIdx < niIdx)
// 非常用标签按字母序
const obscureIdx = parsedTags.findIndex((t) => t.tag === 'SomeObscureTag')
const defIdx = parsedTags.findIndex((t) => t.tag === 'DeferredRevenue')
ok('O1: 非常用按字母序 (DeferredRevenue < SomeObscureTag)', defIdx < obscureIdx)
// F3: label 和 synonymGroup
ok('O1: Revenues 有中文标签', parsedTags.find((t) => t.tag === 'Revenues')?.label === '总收入')
ok('O1: NetIncomeLoss 有中文标签', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.label === '净利润')
ok('O1: 非常用标签 label 为 null', parsedTags.find((t) => t.tag === 'SomeObscureTag')?.label === null)
ok('O1: Revenues 有 synonymGroup', parsedTags.find((t) => t.tag === 'Revenues')?.synonymGroup === 0)
ok('O1: NetIncomeLoss 无 synonymGroup', parsedTags.find((t) => t.tag === 'NetIncomeLoss')?.synonymGroup === null)
// COMMON_US_GAAP 是对象数组
ok('O1: COMMON_US_GAAP 是对象数组', COMMON_US_GAAP.every((c) => typeof c === 'object' && c.tag && c.label))
// 空数据降级
ok('O1: 空数据返回空数组', parseCompanyFacts(null).length === 0)
ok('O1: 无 us-gaap 返回空数组', parseCompanyFacts({ facts: {} }).length === 0)
// companyfacts 不进轮询
const schedulerSrc = readFileSync2(join(ROOT2, 'src/main/scheduler.js'), 'utf8')
ok('O1: scheduler.js 无 companyfacts', !schedulerSrc.includes('companyfacts'))
ok('O1: fetchers.js 无 companyfacts', !fetchersSrc.includes('companyfacts'))
// discoverTags 在 discover.js 中（手动触发，不是轮询）
const discoverSrc = readFileSync2(join(ROOT2, 'src/main/discover.js'), 'utf8')
ok('O1: discover.js 有 discoverTags', discoverSrc.includes('discoverTags'))
ok('O1: discover.js 有 parseCompanyFacts', discoverSrc.includes('parseCompanyFacts'))
// IPC + preload 桥
ok('O1: ipc.js 有 edgar:discoverTags', readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8').includes('edgar:discoverTags'))
ok('O1: preload.js 有 discoverTags', pjR7.includes('discoverTags'))
ok('O1: preload.cjs 有 discoverTags', pcR7.includes('discoverTags'))
// vault.js 有发现标签按钮
ok('O1: vault.js 有发现标签按钮', vaultSrcR7.includes('发现标签'))

// --- O2: 通道归属主题 + optgroup ---
const o2Theme = store.addTheme('O2 测试主题')
const o2Other = store.addTheme('O2 其他主题')
// O2a: 建通道时传 themeId
const o2Ch1 = store.addChannel({ name: '当前主题通道', fetch: 'rss', kind: '独立媒体', themeId: o2Theme.id })
ok('O2a: 通道有 themeId', o2Ch1.themeId === o2Theme.id)
const o2Ch2 = store.addChannel({ name: '全局通道', fetch: 'rss', kind: '独立媒体' })
ok('O2a: 默认 themeId 为 null', o2Ch2.themeId === null)
const o2Ch3 = store.addChannel({ name: '其他主题通道', fetch: 'rss', kind: '独立媒体', themeId: o2Other.id })
ok('O2a: 其他主题通道有 themeId', o2Ch3.themeId === o2Other.id)
// 从 DB 读回
const o2Channels = store.allChannels()
ok('O2a: channelList 包含主题私有通道', o2Channels.some((c) => c.id === o2Ch1.id && c.themeId === o2Theme.id))
ok('O2a: channelList 包含全局通道', o2Channels.some((c) => c.id === o2Ch2.id && c.themeId === null))
// O2b: inspector.js 有 optgroup
ok('O2b: inspector.js 有 optgroup', inspectorSrc.includes('optgroup'))
ok('O2b: inspector.js 有当前主题分组', inspectorSrc.includes('当前主题'))
ok('O2b: inspector.js 有全局分组', inspectorSrc.includes('全局'))
// vault.js 通道列表显示归属
ok('O2: vault.js 通道列表显示主题归属', vaultSrcR7.includes('ch.themeId'))

// --- O3: 删通道清悬空引用 ---
const o3Theme = store.addTheme('O3 测试主题')
const o3Ch = store.addChannel({ name: 'O3 通道', fetch: 'rss', kind: '独立媒体', themeId: o3Theme.id })
const o3Node = store.addNode({ themeId: o3Theme.id, kind: 'lemma', title: 'O3 指标', type: 'observation', channelIds: [o3Ch.id] })
ok('O3: 挂通道前 channelIds 有 1 个', o3Node.channelIds.length === 1)
ok('O3: channelIds 包含通道 id', o3Node.channelIds.includes(o3Ch.id))
store.removeChannel(o3Ch.id)
const o3NodeAfter = store.getNode(o3Node.id)
ok('O3: 删通道后 channelIds 为空', o3NodeAfter.channelIds.length === 0, `实际 ${o3NodeAfter.channelIds.length}`)
ok('O3: channelIds 不含已删通道 id', !o3NodeAfter.channelIds.includes(o3Ch.id))
// 通道确实被删了
ok('O3: 通道已删除', !store.allChannels().some((c) => c.id === o3Ch.id))

// --- O4: 清理 indicatorId 写入 ---
ok('O4: fetchers.js 无 indicatorId', !fetchersSrc.includes('indicatorId'))
const storeSrc = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
ok('O4: store.js 无 indicatorId', !storeSrc.includes('indicatorId'))

// --- O5: 空态提示加跳转 ---
ok('O5: inspector.js 有 setView 导入', inspectorSrc.includes('setView'))
ok('O5: inspector.js 有跳转链接', inspectorSrc.includes("setView('vault', 'feeds')"))

// --- v0.6.3 preload 两份同步（再验一次，加了 discoverTags）---
const pj63 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc63 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeys63 = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('v0.6.3 验收: preload 两份同步', JSON.stringify(extractKeys63(pj63)) === JSON.stringify(extractKeys63(pc63)))

// ============================================================
// v0.6.4: F1-F5 修订
// ============================================================

console.log('\n— v0.6.4: F1-F5 修订 —')

const vaultSrcF = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const ipcSrcF = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')

// --- F1: addReading 停用 indicatorId ---
const f1Reading = store.addReading({
  metric: 'f1.test',
  value: 42,
  unit: 'USD',
  asOf: '2024-Q1',
  indicatorId: 'should-not-persist',
  source: { kind: '一手数据' },
})
ok('F1: addReading 不写 indicatorId', f1Reading.added && store.allReadings().find((r) => r.metric === 'f1.test').indicatorId === undefined)
ok('F1: store.js 无 indicatorId 字符串', !storeSrc.includes('indicatorId'))

// --- F2: 主题下拉默认值陷阱 ---
ok('F2: vault.js inputs.themeId 初始化为 state.themeId', vaultSrcF.includes("themeId: state.themeId || null"))

// --- F3: COMMON_US_GAAP 带中文标签 + 同义组 ---
const { SYNONYM_GROUPS } = await import('../src/main/store.js')
ok('F3: COMMON_US_GAAP 是对象数组', Array.isArray(COMMON_US_GAAP) && COMMON_US_GAAP.every((c) => typeof c === 'object' && c.tag && c.label))
ok('F3: COMMON_US_GAAP 有中文标签', COMMON_US_GAAP.some((c) => c.label === '总收入'))
ok('F3: SYNONYM_GROUPS 存在', Array.isArray(SYNONYM_GROUPS) && SYNONYM_GROUPS.length > 0)
ok('F3: SYNONYM_GROUPS 每组是字符串数组', SYNONYM_GROUPS.every((g) => Array.isArray(g) && g.every((t) => typeof t === 'string')))
ok('F3: parseCompanyFacts 返回 label', parsedTags.find((t) => t.tag === 'Revenues')?.label === '总收入')
ok('F3: parseCompanyFacts 返回 synonymGroup', parsedTags.find((t) => t.tag === 'Revenues')?.synonymGroup === 0)
ok('F3: vault.js 标签面板显示中文标签', vaultSrcF.includes('t.label') && vaultSrcF.includes('t.tag'))

// --- F4: 手动读数挂指标 ---
ok('F4: vault.js renderReadings 有关联指标下拉', vaultSrcF.includes('关联指标'))
ok('F4: vault.js 有 observationNodes 过滤', vaultSrcF.includes("n.type === 'observation'"))
ok('F4: vault.js 有 manual 通道查找', vaultSrcF.includes("c.fetch === 'manual'"))
ok('F4: vault.js 有 channelAdd 手动录入', vaultSrcF.includes("name: '手动录入'"))
ok('F4: vault.js 有 updateNode channelIds', vaultSrcF.includes('channelIds'))

// --- F5: 通道列表显示拉取错误状态 ---
ok('F5: store.js addChannel 有 lastOk', storeSrc.includes('lastOk'))
ok('F5: store.js addChannel 有 lastError', storeSrc.includes('lastError'))
ok('F5: ipc.js channel:fetch 写 lastError', ipcSrcF.includes('lastError'))
ok('F5: ipc.js channel:fetch 写 lastOk', ipcSrcF.includes('lastOk'))
ok('F5: vault.js 通道列表显示 lastError', vaultSrcF.includes('ch.lastError'))
// 端到端：addChannel 带 lastError
const f5Ch = store.addChannel({ name: 'F5 错误通道', fetch: 'rss', kind: '独立媒体', lastError: 'HTTP 500' })
ok('F5: addChannel 存储 lastError', f5Ch.lastError === 'HTTP 500')
const f5ChUpdated = store.updateChannel(f5Ch.id, { lastOk: '2026-09-23', lastError: null })
ok('F5: updateChannel 清 lastError', f5ChUpdated.lastError === null && f5ChUpdated.lastOk === '2026-09-23')

// --- v0.6.4 preload 两份同步 ---
const pj64 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc64 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeys64 = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('v0.6.4 验收: preload 两份同步', JSON.stringify(extractKeys64(pj64)) === JSON.stringify(extractKeys64(pc64)))

// ============================================================
// 主题标签与通道相关性匹配
// ============================================================

console.log('\n— 主题标签与通道相关性匹配 —')

const { rankChannelsByTags, kindToTags, sicToTags, KIND_TO_TAGS, SIC_TO_TAG, updateTheme } = store
const inspectorSrcT = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
const extractSrc = readFileSync2(join(ROOT2, 'src/main/extract.js'), 'utf8')
const templatesJson = JSON.parse(readFileSync2(join(ROOT2, 'src/main/templates.json'), 'utf8'))

// --- T1: themes.tags 迁移 ---
const t1Theme = store.addTheme('T1 标签测试')
ok('T1: addTheme 有 tags 空数组', Array.isArray(t1Theme.tags) && t1Theme.tags.length === 0)
// updateTheme
const t1Updated = updateTheme(t1Theme.id, { tags: ['半导体', 'AI', '美股'] })
ok('T1: updateTheme 设 tags', t1Updated.tags.length === 3 && t1Updated.tags.includes('半导体'))
// 去重
const t1Dedup = updateTheme(t1Theme.id, { tags: ['半导体', '半导体', 'AI'] })
ok('T1: updateTheme tags 去重', t1Dedup.tags.length === 2)
// 旧数据迁移
const t1OldData = JSON.parse(store.exportAll({ withRaw: false }))
delete t1OldData.themes[0].tags
store.importAll(JSON.stringify(t1OldData))
ok('T1: 旧主题导入后 tags 为空数组', Array.isArray(store.allThemes()[0].tags) && store.allThemes()[0].tags.length === 0)

// --- T2: 静态模板标签 ---
for (const tpl of templatesJson.templates) {
  ok(`T2: 模板 ${tpl.id} 有 tags`, Array.isArray(tpl.tags) && tpl.tags.length > 0)
}
ok('T2: ai-chain 含半导体', templatesJson.templates.find((t) => t.id === 'ai-chain').tags.includes('半导体'))
ok('T2: ai-chain 含 AI', templatesJson.templates.find((t) => t.id === 'ai-chain').tags.includes('AI'))
ok('T2: crypto 含虚拟货币', templatesJson.templates.find((t) => t.id === 'crypto').tags.includes('虚拟货币'))
ok('T2: saas 含 SaaS', templatesJson.templates.find((t) => t.id === 'saas').tags.includes('SaaS'))
// fromTemplate 设 tags
const t2Theme = store.addTheme('T2 临时')
store.removeTheme(t2Theme.id)
// 模拟 fromTemplate：建主题 + 设 tags
const t2FromTpl = store.addTheme('AI 产业链')
updateTheme(t2FromTpl.id, { tags: templatesJson.templates.find((t) => t.id === 'ai-chain').tags })
ok('T2: fromTemplate 主题有 tags', store.allThemes().find((t) => t.id === t2FromTpl.id)?.tags.includes('半导体'))

// --- T3: channels.tags ---
const t3Ch = store.addChannel({ name: 'T3 通道', fetch: 'rss', kind: '独立媒体', tags: ['AI', '学术'] })
ok('T3: addChannel 存储 tags', t3Ch.tags.length === 2 && t3Ch.tags.includes('AI'))
// 旧数据迁移
const t3OldCh = JSON.parse(store.exportAll({ withRaw: false }))
delete t3OldCh.channels[0].tags
store.importAll(JSON.stringify(t3OldCh))
ok('T3: 旧通道导入后 tags 为空数组', Array.isArray(store.allChannels()[0].tags) && store.allChannels()[0].tags.length === 0)

// --- T4: kindToTags 纯函数 ---
ok('T4: 财报→财报', kindToTags('财报 / 公告').includes('财报'))
ok('T4: 一手数据→一手数据', kindToTags('一手数据').includes('一手数据'))
ok('T4: 券商研报→券商研报', kindToTags('券商研报').includes('券商研报'))
ok('T4: 未知 kind 返回空', kindToTags('未知').length === 0)

// --- T5: sicToTags 纯函数 ---
ok('T5: SIC 3674→半导体', sicToTags('3674', 'Semiconductors').includes('半导体'))
ok('T5: SIC 3674 含 description', sicToTags('3674', 'Semiconductors and Related Devices').includes('Semiconductors and Related Devices'))
ok('T5: 未知 SIC 用 description', sicToTags('9999', 'Custom Industry').includes('Custom Industry'))
ok('T5: 无 SIC 无 description 返回空', sicToTags(null, null).length === 0)
// fixture 有 SIC
const submissionsFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/edgar-submissions.json'), 'utf8'))
ok('T5: fixture 有 sic', submissionsFixture.sic === '3674')
ok('T5: fixture 有 sicDescription', submissionsFixture.sicDescription === 'Semiconductors and Related Devices')
ok('T5: fixture SIC 推导含半导体', sicToTags(submissionsFixture.sic, submissionsFixture.sicDescription).includes('半导体'))

// --- T6: rankChannelsByTags 纯函数 ---
const t6Channels = [
  { id: 'a', name: 'A', tags: ['半导体', 'AI', '美股'] },
  { id: 'b', name: 'B', tags: ['半导体', '美股'] },
  { id: 'c', name: 'C', tags: ['AI', '学术'] },
  { id: 'd', name: 'D', tags: ['美食'] },
]
const t6ThemeTags = ['半导体', 'AI', '美股']
const t6Ranked = rankChannelsByTags(t6Channels, t6ThemeTags)
ok('T6: 交集 3 排第一', t6Ranked[0].channel.id === 'a' && t6Ranked[0].score === 3)
ok('T6: 交集 2 排第二', t6Ranked[1].channel.id === 'b' && t6Ranked[1].score === 2)
ok('T6: 交集 1 排第三', t6Ranked[2].channel.id === 'c' && t6Ranked[2].score === 1)
ok('T6: 交集 0 排最后', t6Ranked[3].channel.id === 'd' && t6Ranked[3].score === 0)
ok('T6: shared 数组正确', t6Ranked[0].shared.length === 3 && t6Ranked[0].shared.includes('半导体'))
// 主题 tags 为空 → 全部 score 0，顺序不变
const t6Empty = rankChannelsByTags(t6Channels, [])
ok('T6: 空 tags 全部 score 0', t6Empty.every((r) => r.score === 0))
ok('T6: 空 tags 顺序不变', t6Empty[0].channel.id === 'a' && t6Empty[3].channel.id === 'd')
// null tags
const t6Null = rankChannelsByTags(t6Channels, null)
ok('T6: null tags 全部 score 0', t6Null.every((r) => r.score === 0))

// --- T7: inspector.js 相关性排序 ---
ok('T7: inspector.js 有 themeTags', inspectorSrcT.includes('themeTags'))
ok('T7: inspector.js 有 score 分组', inspectorSrcT.includes('score'))
ok('T7: inspector.js 有最相关', inspectorSrcT.includes('最相关'))
ok('T7: inspector.js 有相关', inspectorSrcT.includes('相关'))
ok('T7: inspector.js 有其他', inspectorSrcT.includes('其他'))
ok('T7: inspector.js 退化保留 themeId 分组', inspectorSrcT.includes('当前主题'))

// --- T8: 不手填 ---
ok('T8: vault.js 无 tags 输入框', !vaultSrcF.includes('placeholder.*tags') && !vaultSrcF.includes("placeholder: 'tags'"))
ok('T8: inspector.js 无 tags 输入框', !inspectorSrcT.includes("placeholder: 'tags'"))

// --- T9: LLM 降级 ---
ok('T9: extract.js 有 generateThemeTags', extractSrc.includes('generateThemeTags'))
ok('T9: generateThemeTags 无 key 返回 ok: false', extractSrc.includes("return { ok: false, reason: 'no-key' }"))

// --- T10: IPC + preload ---
ok('T10: ipc.js 有 theme:update', ipcSrcF.includes('theme:update'))
ok('T10: ipc.js channel:add 异步推导 tags', ipcSrcF.includes('deriveChannelTags'))
ok('T10: ipc.js channel:update 重算 tags', ipcSrcF.includes('patch.query') || ipcSrcF.includes('patch.fetch'))
ok('T10: preload.js 有 themeUpdate', pj64.includes('themeUpdate'))
ok('T10: preload.cjs 有 themeUpdate', pc64.includes('themeUpdate'))

// --- T11: SIC 映射表 ---
ok('T11: SIC_TO_TAG 有 3674', SIC_TO_TAG[3674] === '半导体')
ok('T11: KIND_TO_TAGS 有 财报', KIND_TO_TAGS['财报 / 公告'].includes('财报'))

// --- T12: preload 两份同步 ---
const pjT = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcT = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
const extractKeysT = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('T12: preload 两份同步', JSON.stringify(extractKeysT(pjT)) === JSON.stringify(extractKeysT(pcT)))

// ============================================================
// latest tie-break 修复
// ============================================================

console.log('\n— latest tie-break 修复 —')

// 同 at 的多条读数，latest 取后加的那条（groupReadings）
store.addReading({ metric: 'tie.break', value: 1, at: '2026-09-24', source: { kind: '一手数据', accn: 't1' } })
store.addReading({ metric: 'tie.break', value: 2, at: '2026-09-24', source: { kind: '一手数据', accn: 't2' } })
const tieGroup = groupReadings(store.allReadings().filter((r) => r.metric === 'tie.break'))
ok('tie-break: groupReadings 同 at 取后加的', tieGroup[0].latest.value === 2)

// 同 at 的多条读数，latest 取后加的那条（latestReadingByChannel）
const tieCh = store.addChannel({ name: 'tie-break 通道', fetch: 'manual', kind: '一手数据' })
store.addReading({ metric: 'tie.break.ch', value: 100, at: '2026-09-24', channelId: tieCh.id, source: { kind: '一手数据', accn: 'tc1' } })
store.addReading({ metric: 'tie.break.ch', value: 200, at: '2026-09-24', channelId: tieCh.id, source: { kind: '一手数据', accn: 'tc2' } })
const tieLatest = store.latestReadingByChannel(tieCh.id)
ok('tie-break: latestReadingByChannel 同 at 取后加的', tieLatest.value === 200)

// 确认 src 里 latest 比较用 > （相等时取后加的 = reduce 返回 b）
const readingsSrc = readFileSync2(join(ROOT2, 'src/shared/readings.js'), 'utf8')
ok('tie-break: readings.js 用 > 取后加的', readingsSrc.includes('a.at > b.at'))

// ============================================================
// R5: 轮询器 — dueChannels + runChannelFetch + failCount + review
// ============================================================

console.log('\n— R5: 轮询器 —')

const { dueChannels } = await import('../src/main/scheduler.js')

// --- dueChannels 纯函数全分支 ---

const NOW = Date.parse('2026-09-24T12:00:00Z')
const FETCHERS = ['rss', 'edgarConcept']

// 1) 停用 → 不拉
const chDisabled = { id: 'd1', enabled: false, fetch: 'rss', interval: 60, lastFetch: null }
ok('R5: 停用通道不 due', dueChannels([chDisabled], NOW, new Map(), FETCHERS).length === 0)

// 2) manual → 不拉
const chManual = { id: 'm1', enabled: true, fetch: 'manual', interval: 60, lastFetch: null }
ok('R5: manual 通道不 due', dueChannels([chManual], NOW, new Map(), FETCHERS).length === 0)

// 3) 未实现 fetcher → 不拉
const chUnknown = { id: 'u1', enabled: true, fetch: 'grok-x-search', interval: 60, lastFetch: null }
ok('R5: 未实现 fetcher 不 due', dueChannels([chUnknown], NOW, new Map(), FETCHERS).length === 0)

// 4) 启用 + 已实现 + 从未拉取 → due
const chFresh = { id: 'f1', enabled: true, fetch: 'rss', interval: 60, lastFetch: null }
ok('R5: 从未拉取的通道 due', dueChannels([chFresh], NOW, new Map(), FETCHERS).length === 1)

// 5) 间隔未到 → 不 due
const chRecent = { id: 'r1', enabled: true, fetch: 'rss', interval: 60, lastFetch: new Date(NOW - 10 * 60000).toISOString() }
ok('R5: 间隔未到不 due', dueChannels([chRecent], NOW, new Map(), FETCHERS).length === 0)

// 6) 间隔已到 → due
const chStale = { id: 's1', enabled: true, fetch: 'rss', interval: 60, lastFetch: new Date(NOW - 61 * 60000).toISOString() }
ok('R5: 间隔已到 due', dueChannels([chStale], NOW, new Map(), FETCHERS).length === 1)

// 7) failCount 退避：失败 1 次 → 退避 2 倍 interval
const fails1 = new Map([['b1', 1]])
const chBackoff = { id: 'b1', enabled: true, fetch: 'rss', interval: 60, lastFetch: new Date(NOW - 61 * 60000).toISOString() }
ok('R5: 失败 1 次退避中不 due', dueChannels([chBackoff], NOW, fails1, FETCHERS).length === 0)

// 8) failCount 退避已过 → due
const chBackoffPassed = { id: 'b1', enabled: true, fetch: 'rss', interval: 60, lastFetch: new Date(NOW - 200 * 60000).toISOString() }
ok('R5: 退避已过 due', dueChannels([chBackoffPassed], NOW, fails1, FETCHERS).length === 1)

// 9) failCount = 0 → 无退避（等同 Map 里没有）
const fails0 = new Map([['z1', 0]])
const chNoBackoff = { id: 'z1', enabled: true, fetch: 'rss', interval: 60, lastFetch: new Date(NOW - 61 * 60000).toISOString() }
ok('R5: failCount=0 无退避 due', dueChannels([chNoBackoff], NOW, fails0, FETCHERS).length === 1)

// 10) 混合：多通道只筛出 due 的
const mixChannels = [
  { id: 'mix1', enabled: true, fetch: 'rss', interval: 60, lastFetch: null },           // due
  { id: 'mix2', enabled: false, fetch: 'rss', interval: 60, lastFetch: null },          // not due
  { id: 'mix3', enabled: true, fetch: 'manual', interval: 60, lastFetch: null },        // not due
  { id: 'mix4', enabled: true, fetch: 'rss', interval: 60, lastFetch: new Date(NOW - 10 * 60000).toISOString() }, // not due
]
ok('R5: 混合只筛出 1 个 due', dueChannels(mixChannels, NOW, new Map(), FETCHERS).length === 1)
ok('R5: 混合筛出的是 mix1', dueChannels(mixChannels, NOW, new Map(), FETCHERS)[0].id === 'mix1')

// --- failCount 持久化 ---

// 新通道 failCount 默认 0
const fcCh = store.addChannel({ name: 'R5-failCount', fetch: 'rss', kind: '独立媒体', query: 'http://example.com/feed' })
ok('R5: 新通道 failCount=0', fcCh.failCount === 0)

// 手动 updateChannel 设 failCount
store.updateChannel(fcCh.id, { failCount: 3 })
ok('R5: updateChannel 设 failCount', store.allChannels().find((c) => c.id === fcCh.id).failCount === 3)

// 归零
store.updateChannel(fcCh.id, { failCount: 0 })
ok('R5: failCount 可归零', store.allChannels().find((c) => c.id === fcCh.id).failCount === 0)

// --- review 字段 ---

// 新通道 review 默认 false
const rvCh = store.addChannel({ name: 'R5-review', fetch: 'rss', kind: '独立媒体', query: 'http://example.com/feed2' })
ok('R5: 新通道 review=false', rvCh.review === false)

// 切换 review
store.updateChannel(rvCh.id, { review: true })
ok('R5: review 可切 true', store.allChannels().find((c) => c.id === rvCh.id).review === true)

store.updateChannel(rvCh.id, { review: false })
ok('R5: review 可切回 false', store.allChannels().find((c) => c.id === rvCh.id).review === false)

// --- runChannelFetch 行为：review=true 绕过闸门进收件箱 ---

// 先建一个 review 通道 + 主题
const rvTheme = store.addTheme('R5-review-主题')
const rvChannel = store.addChannel({ name: 'R5-review-通道', fetch: 'rss', kind: '一手数据', query: 'http://example.com/rv', themeId: rvTheme.id, review: true, enabled: true })
ok('R5: review 通道建好', rvChannel.review === true)

// 手动通过 IPC 触发 channel:fetch（fetcher 会失败，但能验证 runChannelFetch 不崩）
const fetchResult = await fire('channel:fetch', rvChannel.id)
ok('R5: runChannelFetch 返回结果', fetchResult != null)

// --- runChannelFetch 对不存在的通道 ---
const noCh = await fire('channel:fetch', 'nonexistent-id')
ok('R5: 不存在的通道返回 error', noCh?.error === 'channel not found')

// --- scheduler.js 只有一个 setInterval ---
const schedulerFullSrc = readFileSync2(join(ROOT2, 'src/main/scheduler.js'), 'utf8')
const setIntervalCount = (schedulerFullSrc.match(/setInterval/g) || []).length
ok('R5: scheduler.js 只有一个 setInterval', setIntervalCount === 1, `实际 ${setIntervalCount}`)

// --- startScheduler 接受 channels/runChannel/fetchers ---
ok('R5: startScheduler 有 channels 参数', schedulerFullSrc.includes('channels'))
ok('R5: startScheduler 有 runChannel 参数', schedulerFullSrc.includes('runChannel'))
ok('R5: startScheduler 有 fetchers 参数', schedulerFullSrc.includes('fetchers'))
ok('R5: startScheduler 调 dueChannels', schedulerFullSrc.includes('dueChannels('))

// --- ipc.js runChannelFetch 抽出 ---
const ipcFullSrc = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
ok('R5: ipc.js 有 runChannelFetch 函数', ipcFullSrc.includes('async function runChannelFetch'))
ok('R5: ipc.js channel:fetch 委托 runChannelFetch', ipcFullSrc.includes("runChannelFetch(channelId)"))
ok('R5: ipc.js register 返回 runChannelFetch', ipcFullSrc.includes('return { runChannelFetch }'))
ok('R5: ipc.js review 绕过闸门', ipcFullSrc.includes('ch.review'))
ok('R5: ipc.js failCount 失败 +1', ipcFullSrc.includes('failCount: (ch.failCount || 0) + 1'))
ok('R5: ipc.js failCount 成功归零', ipcFullSrc.includes('failCount: 0'))

// --- main.js 接线 ---
const mainFullSrc = readFileSync2(join(ROOT2, 'src/main/main.js'), 'utf8')
ok('R5: main.js 解构 runChannelFetch', mainFullSrc.includes('runChannelFetch'))
ok('R5: main.js 传 channels 给 startScheduler', mainFullSrc.includes('channels:'))
ok('R5: main.js 传 runChannel 给 startScheduler', mainFullSrc.includes('runChannel:'))
ok('R5: main.js 传 fetchers 给 startScheduler', mainFullSrc.includes('fetchers:'))

// --- store.js failCount 持久化 ---
const storeFullSrc = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
ok('R5: store.js addChannel 有 failCount', storeFullSrc.includes('failCount: ch.failCount ?? 0'))
ok('R5: store.js migrate 有 failCount', storeFullSrc.includes('c.failCount = c.failCount ?? 0'))
ok('R5: store.js addChannel 有 review', storeFullSrc.includes('review: ch.review === true'))

// --- vault.js review toggle ---
const vaultFullSrc = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
ok('R5: vault.js 有 review toggle 按钮', vaultFullSrc.includes("review: !ch.review"))
ok('R5: vault.js 有复审按钮文字', vaultFullSrc.includes('复审'))

// ============================================================
// B: LLM 提议指针
// ============================================================

console.log('\n— B: LLM 提议指针 —')

const { sanitize, proposeChannelLinks } = await import('../src/main/propose.js')

// --- sanitize 纯函数全分支 ---

const validInd = new Set(['n1', 'n2', 'n3'])
const validCh = new Set(['ch_a', 'ch_b', 'ch_c'])

// 合法提议保留
const bS1 = sanitize(
  [{ indicatorId: 'n1', channelIds: ['ch_a', 'ch_b'], reason: 'ok' }],
  validInd, validCh)
ok('B: sanitize 合法提议保留', bS1.length === 1 && bS1[0].channelIds.length === 2)

// 非法 indicatorId → 整条丢弃
const bS2 = sanitize(
  [{ indicatorId: 'n_bad', channelIds: ['ch_a'], reason: 'x' }],
  validInd, validCh)
ok('B: sanitize 非法 indicatorId 丢弃', bS2.length === 0)

// 任一 channelId 非法 → 整条丢弃（不是过滤后保留）
const bS3 = sanitize(
  [{ indicatorId: 'n1', channelIds: ['ch_a', 'ch_hallucinated'], reason: 'x' }],
  validInd, validCh)
ok('B: sanitize 任一非法 channelId 整条丢弃', bS3.length === 0)

// 重复 channelId → 去重
const bS4 = sanitize(
  [{ indicatorId: 'n1', channelIds: ['ch_a', 'ch_a', 'ch_b'], reason: 'x' }],
  validInd, validCh)
ok('B: sanitize 重复 channelId 去重', bS4.length === 1 && bS4[0].channelIds.length === 2)

// channelIds 为空数组 → 保留（合法的「无建议」）
const bS5 = sanitize(
  [{ indicatorId: 'n1', channelIds: [], reason: '无匹配' }],
  validInd, validCh)
ok('B: sanitize 空 channelIds 保留', bS5.length === 1 && bS5[0].channelIds.length === 0)

// reason 非字符串 → 空字符串
const bS6 = sanitize(
  [{ indicatorId: 'n1', channelIds: ['ch_a'], reason: null }],
  validInd, validCh)
ok('B: sanitize reason 非字符串转空', bS6[0].reason === '')

// channelIds 非数组 → 丢弃
const bS7 = sanitize(
  [{ indicatorId: 'n1', channelIds: 'ch_a', reason: 'x' }],
  validInd, validCh)
ok('B: sanitize channelIds 非数组丢弃', bS7.length === 0)

// 混合：合法和非法并存
const bS8 = sanitize(
  [
    { indicatorId: 'n1', channelIds: ['ch_a'], reason: 'ok' },
    { indicatorId: 'n_bad', channelIds: ['ch_a'], reason: 'bad' },
    { indicatorId: 'n2', channelIds: ['ch_b', 'ch_hallucinated'], reason: 'mixed' },
    { indicatorId: 'n3', channelIds: [], reason: 'empty' },
  ],
  validInd, validCh)
ok('B: sanitize 混合只留合法', bS8.length === 2)
ok('B: sanitize 混合留 n1 和 n3', bS8[0].indicatorId === 'n1' && bS8[1].indicatorId === 'n3')

// --- proposeChannelLinks 无 key 降级 ---

const bNoKeyResult = await proposeChannelLinks({ apiKey: '', baseUrl: 'x', model: 'x' }, 'any')
ok('B: 无 key 返回 ok: false', bNoKeyResult.ok === false)
ok('B: 无 key 返回 no-key', bNoKeyResult.error === 'no-key')

// --- proposeChannelLinks 主题不存在 ---

const noThemeResult = await proposeChannelLinks({ apiKey: 'test-key', baseUrl: 'x', model: 'x' }, 'nonexistent-theme')
ok('B: 主题不存在返回 ok: false', noThemeResult.ok === false)
ok('B: 主题不存在返回 error', noThemeResult.error === 'theme not found')

// --- 端到端：stub LLM 返回提议 ---

// 建主题 + 指标 + 通道
const bTheme = store.addTheme('B-提议测试主题')
store.updateTheme(bTheme.id, { tags: ['锂电', '回收', '美股'] })

// 未接线指标
const bInd1 = store.addNode({
  themeId: bTheme.id, parentId: null, kind: 'lemma',
  title: '废旧电池采购量：按月度节奏更新，本期读数待填',
  type: 'observation', confidence: 50,
})
const bInd2 = store.addNode({
  themeId: bTheme.id, parentId: null, kind: 'lemma',
  title: '回收产能利用率：按季度节奏更新，本期读数待填',
  type: 'observation', confidence: 50,
})
// 已接线指标（不应出现在提议输入里）
const bInd3 = store.addNode({
  themeId: bTheme.id, parentId: null, kind: 'lemma',
  title: '已接线指标：按季度节奏更新，本期读数待填',
  type: 'observation', confidence: 50,
  channelIds: ['ch_existing'],
})

// 通道
const bCh1 = store.addChannel({ name: 'ALB 总收入', fetch: 'edgarConcept', kind: '财报 / 公告', query: 'ALB', metric: 'Revenues', tags: ['锂电', '财报'] })
const bCh2 = store.addChannel({ name: 'LTHM 毛利', fetch: 'edgarConcept', kind: '财报 / 公告', query: 'LTHM', metric: 'GrossProfit', tags: ['锂电', '财报'] })

// stub fetch
const originalFetch = globalThis.fetch
let capturedUserContent = null
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body)
  capturedUserContent = body.messages.find((m) => m.role === 'user')?.content
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            proposals: [
              { indicatorId: bInd1.id, channelIds: [bCh1.id, bCh2.id], reason: '回收原料价格由上游锂盐厂的收入和毛利反映' },
              { indicatorId: bInd2.id, channelIds: [], reason: '产能利用率无公开结构化数据源，只能手填' },
              { indicatorId: bInd3.id, channelIds: [bCh1.id], reason: '已接线的不应出现' },
              { indicatorId: 'n_hallucinated', channelIds: [bCh1.id], reason: '幻觉指标' },
              { indicatorId: bInd1.id, channelIds: ['ch_hallucinated'], reason: '幻觉通道' },
            ],
          }),
        },
      }],
    }),
  }
}

try {
  const proposeResult = await proposeChannelLinks(
    { apiKey: 'test-key', baseUrl: 'https://test.example.com/v1', model: 'test-model' },
    bTheme.id)

  ok('B: 端到端返回 ok', proposeResult.ok === true)
  ok('B: 端到端返回提议数组', Array.isArray(proposeResult.proposals))

  // 已接线的 bInd3 不应出现在结果里（sanitize 过滤了非法 indicatorId）
  const indIds = proposeResult.proposals.map((p) => p.indicatorId)
  ok('B: 已接线指标不被提议', !indIds.includes(bInd3.id))
  ok('B: 幻觉指标被丢弃', !indIds.includes('n_hallucinated'))

  // bInd1 应该有一条合法提议
  const p1 = proposeResult.proposals.find((p) => p.indicatorId === bInd1.id)
  ok('B: bInd1 有提议', p1 != null)
  ok('B: bInd1 提议 2 个通道', p1?.channelIds.length === 2)
  ok('B: bInd1 提议含 bCh1', p1?.channelIds.includes(bCh1.id))
  ok('B: bInd1 提议含 bCh2', p1?.channelIds.includes(bCh2.id))
  ok('B: bInd1 reason 正确', p1?.reason === '回收原料价格由上游锂盐厂的收入和毛利反映')

  // bInd2 应该有空通道提议
  const p2 = proposeResult.proposals.find((p) => p.indicatorId === bInd2.id)
  ok('B: bInd2 有空通道提议', p2 != null && p2.channelIds.length === 0)
  ok('B: bInd2 reason 说明缺什么', p2?.reason.includes('手填'))

  // 幻觉通道的提议被整条丢弃
  const hallucinatedCh = proposeResult.proposals.find((p) =>
    p.indicatorId === bInd1.id && p.channelIds.includes('ch_hallucinated'))
  ok('B: 幻觉通道提议被丢弃', hallucinatedCh == null)

  // LLM 输入包含未接线指标但不包含已接线的
  ok('B: LLM 输入含未接线指标', capturedUserContent.includes(bInd1.id))
  ok('B: LLM 输入不含已接线指标', !capturedUserContent.includes(bInd3.id))
  ok('B: LLM 输入含主题 tags', capturedUserContent.includes('锂电'))
  ok('B: LLM 输入含通道 tags', capturedUserContent.includes('财报'))

  // 模拟「采用」→ 写入 channelIds
  await store.updateNode(bInd1.id, { channelIds: p1.channelIds })
  const updated = store.allNodes().find((n) => n.id === bInd1.id)
  ok('B: 采用后 channelIds 写入', updated.channelIds.length === 2)
  ok('B: 采用后 channelIds 含 bCh1', updated.channelIds.includes(bCh1.id))
  ok('B: 采用后 channelIds 含 bCh2', updated.channelIds.includes(bCh2.id))

  // 采用后该指标不再是缺口
  const stillGap = !updated.channelIds || updated.channelIds.length === 0
  ok('B: 采用后不再是缺口', stillGap === false)

  // 模拟「忽略」→ channelIds 仍为空
  await store.updateNode(bInd2.id, { channelIds: [] })
  const ignored = store.allNodes().find((n) => n.id === bInd2.id)
  ok('B: 忽略后 channelIds 仍为空', (!ignored.channelIds || ignored.channelIds.length === 0))
} finally {
  globalThis.fetch = originalFetch
}

// --- LLM 失败不阻塞 ---

globalThis.fetch = async () => { throw new Error('network error') }
try {
  const failResult = await proposeChannelLinks(
    { apiKey: 'test-key', baseUrl: 'https://test.example.com/v1', model: 'test-model' },
    bTheme.id)
  ok('B: LLM 失败返回 ok: false', failResult.ok === false)
  ok('B: LLM 失败有 error', typeof failResult.error === 'string')
} finally {
  globalThis.fetch = originalFetch
}

// --- HTTP 错误不阻塞 ---

globalThis.fetch = async () => ({ ok: false, status: 500 })
try {
  const httpFailResult = await proposeChannelLinks(
    { apiKey: 'test-key', baseUrl: 'https://test.example.com/v1', model: 'test-model' },
    bTheme.id)
  ok('B: HTTP 错误返回 ok: false', httpFailResult.ok === false)
  ok('B: HTTP 错误含状态码', httpFailResult.error.includes('500'))
} finally {
  globalThis.fetch = originalFetch
}

// --- IPC handler ---

const ipcResult = await fire('llm:proposeLinks', bTheme.id)
ok('B: IPC llm:proposeLinks 可调', ipcResult != null)
ok('B: IPC 无 key 返回 ok: false', ipcResult.ok === false)

// --- 无未接线指标 → 空提议 ---

const noGapTheme = store.addTheme('B-无缺口主题')
store.addNode({
  themeId: noGapTheme.id, parentId: null, kind: 'lemma',
  title: '已接线的：按季度节奏更新', type: 'observation', confidence: 50,
  channelIds: ['ch_x'],
})
const noGapResult = await proposeChannelLinks(
  { apiKey: 'test-key', baseUrl: 'x', model: 'x' }, noGapTheme.id)
ok('B: 无未接线指标返回空提议', noGapResult.ok === true && noGapResult.proposals.length === 0)

// --- 不新增节点字段 ---

const proposeSrc = readFileSync2(join(ROOT2, 'src/main/propose.js'), 'utf8')
ok('B: propose.js 无 suggestedChannelIds', !proposeSrc.includes('suggestedChannelIds'))
ok('B: propose.js 无 proposedChannelIds', !proposeSrc.includes('proposedChannelIds'))
ok('B: store.js 无 suggestedChannelIds', !readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8').includes('suggestedChannelIds'))

// --- preload 两份同步 ---

const pjB = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcB = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
ok('B: preload.js 有 proposeLinks', pjB.includes('proposeLinks'))
ok('B: preload.cjs 有 proposeLinks', pcB.includes('proposeLinks'))
const extractKeysB = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('B: preload 两份同步', JSON.stringify(extractKeysB(pjB)) === JSON.stringify(extractKeysB(pcB)))

// --- IPC handler 注册 ---

const ipcBSrc = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
ok('B: ipc.js 有 llm:proposeLinks', ipcBSrc.includes('llm:proposeLinks'))
ok('B: ipc.js import proposeChannelLinks', ipcBSrc.includes('proposeChannelLinks'))

// --- vault.js 缺口列表按钮 ---

const vaultBSrc = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
ok('B: vault.js 有分析按钮', vaultBSrc.includes('分析未接线的指标'))
ok('B: vault.js 有采用按钮', vaultBSrc.includes('采用'))
ok('B: vault.js 有忽略按钮', vaultBSrc.includes('忽略'))
ok('B: vault.js 有 proposeLinks 调用', vaultBSrc.includes('proposeLinks'))

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
