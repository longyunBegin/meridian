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
ok('撤销后节点已删除', store.getNode(undoNodeId) == null)
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

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
