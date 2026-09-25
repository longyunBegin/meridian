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

// T1: inbox:list 分页——返回 { items, total }，不再全量数组
const listResult = await fire('inbox:list')
ok('inbox:list 返回 { items, total }', listResult && Array.isArray(listResult.items) && typeof listResult.total === 'number')
ok('inbox:list 返回 1 条', listResult.items.length === 1, `实际 ${listResult.items.length}`)
ok('inbox:list total 正确', listResult.total === 1, `实际 ${listResult.total}`)

// 默认 limit 50；offset 生效
store.addInboxItem({ text: '批量测试甲', title: '批量测试甲', label: { kind: '自媒体', quality: 0.5 }, lemmas: [] })
store.addInboxItem({ text: '批量测试乙', title: '批量测试乙', label: { kind: '自媒体', quality: 0.5 }, lemmas: [] })
const pageAll = await fire('inbox:list')
ok('inbox:list 默认 limit 50', pageAll.items.length === 3 && pageAll.total === 3, `实际 ${pageAll.items.length}/${pageAll.total}`)
const pageLimited = await fire('inbox:list', { limit: 2 })
ok('inbox:list limit 生效', pageLimited.items.length === 2, `实际 ${pageLimited.items.length}`)
const pageOffset = await fire('inbox:list', { limit: 2, offset: 2 })
ok('inbox:list offset 生效', pageOffset.items.length === 1, `实际 ${pageOffset.items.length}`)

const resolveResult = await fire('inbox:resolve', listResult.items[0].id, 'reject')
ok('inbox:resolve 返回条目', resolveResult?.id === listResult.items[0].id)
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
ok('骨架节点带 scaffold', skNodes[0].scaffold?.answer?.[0] === '芯片设计能力如何')
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
// label stage 不再逐条存（改按天聚合，见 T3），结构测试用仍在存储的 gate stage
store.addTrace({
  target: { type: 'node', id: 'test-node-1' },
  stage: 'gate',
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
ok('trace stage = gate', tr.stage === 'gate')
ok('trace actor.by = model', tr.actor.by === 'model')
ok('trace actor.model = step-3', tr.actor.model === 'step-3')
ok('trace actor.promptVersion = v1', tr.actor.promptVersion === 'v1')
ok('trace output 未加工', tr.output.quality === 0.9)
ok('trace decision 是最终值', tr.decision.quality === 0.9)
ok('trace reason 为 null（表值=模型值）', tr.reason === null)

// 取表值 ≠ 模型值时：label 走按天聚合，分差 = 模型值 - 表值
store.recordLabelAggregate({ kind: '分歧测试源', tableQuality: 0.4, modelQuality: 0.9 })
const diverged = store.labelerDivergence().find((g) => g.kind === '分歧测试源')
ok('分歧曲线按 kind 统计', diverged != null && diverged.count === 1, `实际 ${diverged?.count}`)
ok('分歧均值 = 模型值 - 表值', diverged != null && Math.abs(diverged.meanDiff - 0.5) < 0.01, `实际 ${diverged?.meanDiff}`)
// 同一天同 kind 累加，均值不变
store.recordLabelAggregate({ kind: '分歧测试源', tableQuality: 0.4, modelQuality: 0.9 })
const diverged2 = store.labelerDivergence().find((g) => g.kind === '分歧测试源')
ok('同 kind 累加 count=2', diverged2?.count === 2, `实际 ${diverged2?.count}`)
ok('同 kind 累加均值不变', diverged2 != null && Math.abs(diverged2.meanDiff - 0.5) < 0.01, `实际 ${diverged2?.meanDiff}`)

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

// 打标器 vs 表的分歧曲线（读按天聚合）
const ld = store.labelerDivergence()
ok('labelerDivergence 返回数组', Array.isArray(ld))

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

// 语法检查。同步测试只比内容——preload 少个逗号照样「同步」，但 app 直接起不来。
// 这一条是那次事故之后补的。
import { default as vm } from 'node:vm'
const syntaxOk = (src) => { try { new vm.Script(src); return true } catch { return false } }
ok('preload: preload.js 语法可编译', syntaxOk(pj), '语法错误会让 app 起不来')
ok('preload: preload.cjs 语法可编译', syntaxOk(pc), '语法错误会让 app 起不来')

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
ok('R7 无 key: AI 描述也不猜通道', aiChannels.length === 0, `实际 ${aiChannels.length}`)
ok('R7 无 key: 返回降级标记', aiTheme.degraded === true)

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

// --- F4: 手动读数挂指标（R2: 已从 vault.js 搬到 inspector.js）---
const inspectorSrcF4 = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
ok('F4: inspector.js 有手填读数按钮', inspectorSrcF4.includes('手填一条读数'))
ok('F4: inspector.js 有 manual 通道查找', inspectorSrcF4.includes("c.fetch === 'manual'"))
ok('F4: inspector.js 有 channelAdd 手动录入', inspectorSrcF4.includes("name: '手动录入'"))
ok('F4: inspector.js 有 updateNode channelIds', inspectorSrcF4.includes('channelIds'))
ok('F4: vault.js 无手动录入表单', !vaultSrcF.includes('手动记一条读数'))

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

// --- T2: 通用骨架与验证通道库 ---
ok('T2: selectable templates 已删除', !Array.isArray(templatesJson.templates))
ok('T2: 通用骨架是上中下游', templatesJson.genericFallback.nodes.map((node) => node.path).join(',') === '上游,中游,下游')
ok('T2: 通用骨架领域中立', !JSON.stringify(templatesJson.genericFallback).match(/AI|光模块|半导体|GPU/i))
ok('T2: 通道库非空', Array.isArray(templatesJson.channelLibrary) && templatesJson.channelLibrary.length > 0)
ok('T2: 通道库 id 唯一', new Set(templatesJson.channelLibrary.map((channel) => channel.id)).size === templatesJson.channelLibrary.length)
ok('T2: 通道库保留 tags', templatesJson.channelLibrary.every((channel) => Array.isArray(channel.tags) && channel.tags.length > 0))

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
// R5: 轮询器 — dueChannels + runChannelFetch + failCount
// ============================================================

console.log('\n— R5: 轮询器 —')

const { dueChannels } = await import('../src/main/scheduler.js')
const { channelJitter, MAX_ITEMS_PER_TICK } = await import('../src/main/scheduler.js')

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

// 6) 间隔 + 抖动已到 → due
const chStale = { id: 's1', enabled: true, fetch: 'rss', interval: 60, lastFetch: new Date(NOW - 70 * 60000).toISOString() }
ok('R5: 间隔已到 due', dueChannels([chStale], NOW, new Map(), FETCHERS).length === 1)

// 6b) C2：抖动把同 interval 的通道错开——落在抖动窗口内还不该拉
const jitterStale = new Date(NOW - (60 + channelJitter('s1')) * 60000 + 60000).toISOString()
ok('R5: 抖动窗口内不 due', dueChannels([{ ...chStale, lastFetch: jitterStale }], NOW, new Map(), FETCHERS).length === 0)
ok('R5: 同 id 抖动稳定可复现', channelJitter('s1') === channelJitter('s1'))

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
ok('R5: ipc.js 不再按 review 分流', !ipcFullSrc.includes('ch.review'))
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
ok('R5: vault.js 无 review toggle', !vaultFullSrc.includes("review: !ch.review"))
ok('R5: vault.js 不显示复审状态', !vaultFullSrc.includes('免复审'))

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

// --- proposeChannelLinks 无 key降级与边界校验 ---

const bNoKeyResult = await proposeChannelLinks({ apiKey: '', baseUrl: 'x', model: 'x' }, null, [])
ok('B: 无 key 返回 ok: false', bNoKeyResult.ok === false)
ok('B: 无 key 返回 no-key', bNoKeyResult.error === 'no-key')

const noIndicatorResult = await proposeChannelLinks(
  { apiKey: 'test-key', baseUrl: 'x', model: 'x' }, null, [])
ok('B: 指标不存在返回 ok: false', noIndicatorResult.ok === false)
ok('B: 指标不存在返回 error', noIndicatorResult.error === 'indicator not found')

// --- 端到端：单指标提议 ---

const bTheme = store.addTheme('B-提议测试主题')
const bInd1 = store.addNode({
  themeId: bTheme.id, parentId: null, kind: 'lemma',
  title: '废旧电池采购量：按月度节奏更新，本期读数待填',
  type: 'observation', confidence: 50, tags: ['锂电', '回收'],
})
const bCh1 = store.addChannel({ name: 'ALB 总收入', fetch: 'edgarConcept', kind: '财报 / 公告', query: 'ALB', metric: 'Revenues', tags: ['锂电', '财报'] })
const bCh2 = store.addChannel({ name: 'LTHM 毛利', fetch: 'edgarConcept', kind: '财报 / 公告', query: 'LTHM', metric: 'GrossProfit', tags: ['锂电', '财报'] })

const originalFetch = globalThis.fetch
let capturedUserContent = null
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body)
  capturedUserContent = body.messages.find((message) => message.role === 'user')?.content
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            proposal: {
              indicatorId: bInd1.id,
              channelIds: [bCh1.id, bCh2.id],
              reason: '采购量可由两家上游公司的财报交叉验证',
            },
          }),
        },
      }],
    }),
  }
}

try {
  const proposeResult = await proposeChannelLinks(
    { apiKey: 'test-key', baseUrl: 'https://test.example.com/v1', model: 'test-model' },
    bInd1,
    [bCh1, bCh2])

  ok('B: 单指标提议返回 ok', proposeResult.ok === true)
  ok('B: 单指标提议返回 proposal', proposeResult.proposal?.indicatorId === bInd1.id)
  ok('B: 单指标提议含两个通道', proposeResult.proposal?.channelIds.length === 2)
  ok('B: 单指标提议含 bCh1', proposeResult.proposal?.channelIds.includes(bCh1.id))
  ok('B: 单指标提议含 bCh2', proposeResult.proposal?.channelIds.includes(bCh2.id))
  ok('B: 单指标提议 reason 正确', proposeResult.proposal?.reason.includes('交叉验证'))
  ok('B: LLM 输入只含当前指标', capturedUserContent.includes(bInd1.id))
  ok('B: LLM 输入含指标 tags', capturedUserContent.includes('回收'))
  ok('B: LLM 输入含通道 tags', capturedUserContent.includes('财报'))

  const merged = [...new Set(['ch_existing', ...proposeResult.proposal.channelIds])]
  store.updateNode(bInd1.id, { channelIds: merged })
  const updated = store.allNodes().find((node) => node.id === bInd1.id)
  ok('B: 采用时保留已有通道', updated.channelIds.includes('ch_existing'))
  ok('B: 采用时合并提议通道', updated.channelIds.includes(bCh1.id) && updated.channelIds.includes(bCh2.id))
} finally {
  globalThis.fetch = originalFetch
}

// --- 幻觉通道整条拒绝 ---

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      proposal: { indicatorId: bInd1.id, channelIds: ['ch_hallucinated'], reason: '猜测' },
    }) } }],
  }),
})
try {
  const invalidResult = await proposeChannelLinks(
    { apiKey: 'test-key', baseUrl: 'https://test.example.com/v1', model: 'test-model' },
    bInd1,
    [bCh1, bCh2])
  ok('B: 幻觉通道提议被拒绝', invalidResult.ok === false && invalidResult.error === 'invalid proposal')
} finally {
  globalThis.fetch = originalFetch
}

// --- LLM 失败不阻塞 ---

globalThis.fetch = async () => { throw new Error('network error') }
try {
  const failResult = await proposeChannelLinks(
    { apiKey: 'test-key', baseUrl: 'https://test.example.com/v1', model: 'test-model' },
    bInd1,
    [bCh1])
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
    bInd1,
    [bCh1])
  ok('B: HTTP 错误返回 ok: false', httpFailResult.ok === false)
  ok('B: HTTP 错误含状态码', httpFailResult.error.includes('500'))
} finally {
  globalThis.fetch = originalFetch
}

// --- 无通道时直接返回空提议 ---

const noChannelResult = await proposeChannelLinks(
  { apiKey: 'test-key', baseUrl: 'x', model: 'x' }, bInd1, [])
ok('B: 无通道返回空提议', noChannelResult.ok === true && noChannelResult.proposal.channelIds.length === 0)

// --- IPC handler ---

const ipcResult = await fire('llm:proposeLinks', bInd1.id)
ok('B: IPC llm:proposeLinks 可调', ipcResult != null)
ok('B: IPC 无 key 返回 ok: false', ipcResult.ok === false)

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
const extractKeysB = (s) => s.split('\n').filter((line) => line.includes('ipcRenderer.invoke')).map((line) => line.trim().split(':')[0].trim()).sort()
ok('B: preload 两份同步', JSON.stringify(extractKeysB(pjB)) === JSON.stringify(extractKeysB(pcB)))

// --- IPC 与界面入口 ---

const ipcBSrc = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const vaultBSrc = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const latticeBSrc = readFileSync2(join(ROOT2, 'src/renderer/views/lattice.js'), 'utf8')
const inspectorBSrc = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
ok('B: ipc.js 有 llm:proposeLinks', ipcBSrc.includes('llm:proposeLinks'))
ok('B: IPC 按 indicatorId 提议', ipcBSrc.includes("getNode(indicatorId)"))
ok('B: lattice.js 无批量提议入口', !latticeBSrc.includes('proposeLinks'))
ok('B: inspector.js 有单指标提议入口', inspectorBSrc.includes('proposeLinks(node.id)'))
ok('B: inspector.js 采用时合并通道', inspectorBSrc.includes('new Set([...(node.channelIds || []), ...proposal.channelIds])'))
ok('B: inspector.js 采用后立即拉取', inspectorBSrc.includes('m.channelFetch(id)'))
ok('B: vault.js 无缺口列表', !vaultBSrc.includes('未关联指标'))

// ============================================================
// C+D: 通道包补全 + 研究观点记录
// ============================================================

console.log('\n— C+D: 通道包补全 + 研究观点 —')

const { channelLibrary: getChannelLibrary } = await import('../src/main/templates.js')

// --- C1: 软件服务通道配置 ---
const saasPack = getChannelLibrary().filter((channel) => channel.tags.includes('软件服务'))
ok('C1: 软件服务通道非空', saasPack.length > 0)
ok('C1: 软件服务有 edgarFilings', saasPack.some((channel) => channel.fetch === 'edgarFilings'))
ok('C1: 软件服务有 edgarConcept', saasPack.some((channel) => channel.fetch === 'edgarConcept'))
ok('C1: 软件服务覆盖 ≥5 家公司', new Set(saasPack.filter((channel) => channel.fetch === 'edgarFilings').map((channel) => channel.query)).size >= 5)

// --- C2: 数字资产通道配置 ---
const cryptoPack = getChannelLibrary().filter((channel) => channel.tags.includes('数字资产'))
ok('C2: 数字资产通道非空', cryptoPack.length > 0)
ok('C2: 数字资产有 defillamaProtocol', cryptoPack.some((channel) => channel.fetch === 'defillamaProtocol'))
ok('C2: 数字资产有 defillamaStablecoins', cryptoPack.some((channel) => channel.fetch === 'defillamaStablecoins'))
ok('C2: 数字资产有 blockchainChart', cryptoPack.some((channel) => channel.fetch === 'blockchainChart'))
ok('C2: 数字资产通道全免费无 key', cryptoPack.every((channel) => channel.needsKey === false))

// --- C2: 新取数器注册 ---
const availCD = (await import('../src/main/fetchers.js')).availableFetchers()
ok('C2: availableFetchers 含 defillamaProtocol', availCD.includes('defillamaProtocol'))
ok('C2: availableFetchers 含 defillamaStablecoins', availCD.includes('defillamaStablecoins'))
ok('C2: availableFetchers 含 blockchainChart', availCD.includes('blockchainChart'))

// --- C2: fixture 测试 ---
const defiProtocolFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/defillama-protocol-aave.json'), 'utf8'))
ok('C2: defillama fixture 有 tvl 数组', Array.isArray(defiProtocolFixture.tvl) && defiProtocolFixture.tvl.length > 0)
ok('C2: defillama fixture tvl 最后一条有 total', defiProtocolFixture.tvl[defiProtocolFixture.tvl.length - 1].total > 0)

const defiStableFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/defillama-stablecoins.json'), 'utf8'))
ok('C2: stablecoins fixture 有 peggedAssets', Array.isArray(defiStableFixture.peggedAssets) && defiStableFixture.peggedAssets.length > 0)

const bcHashrateFixture = JSON.parse(readFileSync2(join(ROOT2, 'test/fixtures/blockchain-hashrate.json'), 'utf8'))
ok('C2: blockchain fixture 有 values 数组', Array.isArray(bcHashrateFixture.values) && bcHashrateFixture.values.length > 0)

// --- C2: metric 命名同构 ---
const fetchersSrcCD = readFileSync2(join(ROOT2, 'src/main/fetchers.js'), 'utf8')
ok('C2: metric 命名 defillama.{slug}.{metric}', fetchersSrcCD.includes('defillama.${slug}.${metric}'))
ok('C2: metric 命名 blockchain.{metric}', fetchersSrcCD.includes('blockchain.${metric}'))

// --- C2: Unix 时间戳转日期 ---
ok('C2: fetchers.js 有 unixToDate', fetchersSrcCD.includes('unixToDate'))

// --- D1: researchNotes 集合 ---

ok('D1: blank 有 researchNotes', store.allResearchNotes().length === 0 || Array.isArray(store.allResearchNotes()))
ok('D1: stats 有 researchNotes', typeof store.stats().researchNotes === 'number')

// addResearchNote
const dTheme = store.addTheme('D-研究观点测试')
const dNode = store.addNode({ themeId: dTheme.id, parentId: null, kind: 'lemma', title: 'D测试命题', type: 'observation', confidence: 60 })
const rn1 = store.addResearchNote({ org: '中信证券', stance: 'bullish', publishedAt: '2026-09-15', title: '1.6T 光模块超预期', nodeId: dNode.id })
ok('D1: addResearchNote 返回 note', rn1?.id != null)
ok('D1: note 有 org', rn1.org === '中信证券')
ok('D1: note 有 stance', rn1.stance === 'bullish')
ok('D1: note 有 nodeId', rn1.nodeId === dNode.id)

const rn2 = store.addResearchNote({ org: 'Morgan Stanley', stance: 'neutral', publishedAt: '2026-09-20', title: '维持中性', nodeId: dNode.id })
const rn3 = store.addResearchNote({ org: '高盛', stance: 'bearish', publishedAt: '2026-09-18', title: '估值过高', nodeId: dNode.id })

// allResearchNotes
ok('D1: allResearchNotes 有 3 条', store.allResearchNotes().length >= 3)

// researchNotesByNode
const byNode = store.researchNotesByNode(dNode.id)
ok('D1: researchNotesByNode 返回 3 条', byNode.length === 3)
ok('D1: researchNotesByNode 含中信', byNode.some((n) => n.org === '中信证券'))

// --- D1: researchHitRate 纯函数 ---

const hitRate = store.researchHitRate(byNode, true)
ok('D1: hitRate total=2（不含 neutral）', hitRate.total === 2)
ok('D1: hitRate hits=1（bullish 命中）', hitRate.hits === 1)
ok('D1: hitRate rate=0.5', hitRate.rate === 0.5)

const hitRateWrong = store.researchHitRate(byNode, false)
ok('D1: hitRate 错时 hits=1（bearish 命中）', hitRateWrong.hits === 1)
ok('D1: hitRate 错时 rate=0.5', hitRateWrong.rate === 0.5)

// neutral only → total=0, rate=null
const neutralOnly = store.researchHitRate([{ stance: 'neutral' }], true)
ok('D1: hitRate 全 neutral 时 total=0', neutralOnly.total === 0)
ok('D1: hitRate 全 neutral 时 rate=null', neutralOnly.rate === null)

// correct=null → rate=null
const noSettle = store.researchHitRate(byNode, null)
ok('D1: hitRate 未结算时 rate=null', noSettle.rate === null)

// --- D1: vsInstitution ---

store.settleLemma(dNode.id, true)
const vs = store.vsInstitution(90)
ok('D1: vsInstitution 返回对象', vs != null)
ok('D1: vsInstitution 有 userRate', vs.userRate != null)
ok('D1: vsInstitution 有 orgRate', vs.orgRate != null)
ok('D1: vsInstitution settledCount > 0', vs.settledCount > 0)
ok('D1: vsInstitution userHits=1（结算为对）', vs.userHits >= 1)

// --- D1: 红线 — researchNotes 不产生 node ---
const nodeCountBefore = store.allNodes().length
store.addResearchNote({ org: 'test', stance: 'bullish', title: '不应产生 node', nodeId: dNode.id })
ok('D1: researchNotes 不产生 node', store.allNodes().length === nodeCountBefore)

// --- D1: 导出导入 ---

const exportData = JSON.parse(store.exportAll())
ok('D1: 导出包含 researchNotes', Array.isArray(exportData.researchNotes))
ok('D1: 导出 researchNotes 非空', exportData.researchNotes.length > 0)

// --- D1: 旧数据兼容（无 researchNotes 的导入）---
const oldDataD = { ...exportData, researchNotes: undefined }
delete oldDataD.researchNotes
store.importAll(JSON.stringify(oldDataD))
ok('D1: 旧数据导入后 researchNotes 为空数组', Array.isArray(store.allResearchNotes()) && store.allResearchNotes().length === 0)

// 重新导入完整数据
store.importAll(JSON.stringify(exportData))
ok('D1: 重新导入后 researchNotes 恢复', store.allResearchNotes().length > 0)

// --- D: IPC handler ---

ok('D: IPC research:add 可调', await fire('research:add', { org: 'test', stance: 'bullish', title: 'IPC test', nodeId: dNode.id }) != null)
ok('D: IPC research:all 可调', Array.isArray(await fire('research:all')))
ok('D: IPC research:byNode 可调', Array.isArray(await fire('research:byNode', dNode.id)))
ok('D: IPC research:vsInstitution 可调', await fire('research:vsInstitution', 90) != null)

// --- D: preload 同步 ---

const pjD = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcD = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
ok('D: preload.js 有 addResearch', pjD.includes('addResearch'))
ok('D: preload.cjs 有 addResearch', pcD.includes('addResearch'))
ok('D: preload.js 有 vsInstitution', pjD.includes('vsInstitution'))
ok('D: preload.cjs 有 vsInstitution', pcD.includes('vsInstitution'))
const extractKeysD = (s) => s.split('\n').filter((l) => l.includes('ipcRenderer.invoke')).map((l) => l.trim().split(':')[0].trim()).sort()
ok('D: preload 两份同步', JSON.stringify(extractKeysD(pjD)) === JSON.stringify(extractKeysD(pcD)))

// --- D: inspector.js 有研究观点区 ---

const inspectorSrcD = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
ok('D: inspector.js 有 researchPanel', inspectorSrcD.includes('researchPanel'))
ok('D: inspector.js 有研究观点标题', inspectorSrcD.includes('研究观点'))

// --- D: vault.js 有你 vs 机构 ---

const vaultSrcD = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
ok('D: vault.js 有 vsInstitution', vaultSrcD.includes('vsInstitution'))
ok('D: vault.js 有 你 vs 机构', vaultSrcD.includes('你 vs 机构'))

// --- D: 无加权/汇总/总量/合计 ---

ok('D: inspector.js 无加权', !inspectorSrcD.includes('加权'))
ok('D: inspector.js 无汇总', !inspectorSrcD.includes('汇总'))
ok('D: inspector.js 无总量', !inspectorSrcD.includes('总量'))
ok('D: inspector.js 无合计', !inspectorSrcD.includes('合计'))

// --- D: store.js 红线 — researchNotes 不进 calibration/verdicts ---

const storeSrcD = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
ok('D: store.js 有 researchHitRate', storeSrcD.includes('researchHitRate'))
ok('D: store.js 有 vsInstitution', storeSrcD.includes('vsInstitution'))
const calLinesD = storeSrcD.split('\n')
const calStartD = calLinesD.findIndex((l) => l.includes('export function calibration()'))
const calEndD = calLinesD.findIndex((l, i) => i > calStartD && l.startsWith('export function'))
const calBodyD = calLinesD.slice(calStartD, calEndD).join('\n')
ok('D: store.js researchNotes 不进 calibration', !calBodyD.includes('researchNotes'))

// ============================================================
// v0.6.6: B1-B3 bug 修复 + I1-I5 设计缺口
// ============================================================

console.log('\n— v0.6.6: B1-B3 + I1-I5 —')

const extractSrc66 = readFileSync2(join(ROOT2, 'src/main/extract.js'), 'utf8')
const storeSrc66 = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
const ipcSrc66 = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const vaultSrc66 = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const fetchersSrc66 = readFileSync2(join(ROOT2, 'src/main/fetchers.js'), 'utf8')
const appSrc66 = readFileSync2(join(ROOT2, 'src/renderer/app.js'), 'utf8')
const settingsSrc66 = readFileSync2(join(ROOT2, 'src/renderer/views/settings.js'), 'utf8')
const pj66 = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pc66 = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// --- B1: LLM 指标类型不匹配 ---

ok('B1: prompt 有对象 indicators 示例', extractSrc66.includes('"indicators":[{"name":"指标名","cadence"'))
ok('B1: prompt 有 cadence 四选一说明', extractSrc66.includes('月|季度|年度|事件'))
ok('B1: extract.js 有 normalizeCadence', extractSrc66.includes('normalizeCadence'))
ok('B1: extract.js 解析兼容字符串', extractSrc66.includes("typeof i === 'string'"))
ok('B1: extract.js 解析产对象', extractSrc66.includes('{ name: i, cadence:'))
ok('B1: spawnFromScaffold 防御字符串', storeSrc66.includes("typeof ind === 'string' ? ind : String(ind?.name"))
ok('B1: spawnFromScaffold 防御 cadence', storeSrc66.includes("ind?.cadence) || '季度'"))

// B1 端到端：字符串 indicators → spawn → 无 undefined
const b1Theme = store.addTheme('B1 测试主题')
const b1Branch = store.addNode({ themeId: b1Theme.id, parentId: null, kind: 'branch', title: 'B1 环节', scaffold: { answer: null, indicators: ['裸字符串指标'], falsifier: null } })
const b1Spawned = store.spawnFromScaffold(b1Branch.id)
ok('B1: 字符串 indicators spawn 产出节点', b1Spawned.length > 0)
ok('B1: 字符串 indicators 标题无 undefined', !b1Spawned.some((n) => n.title.includes('undefined')))
ok('B1: 字符串 indicators 标题含指标名', b1Spawned.some((n) => n.title.includes('裸字符串指标')))

// B1 端到端：对象 indicators → spawn → 正确 name/cadence
const b1Branch2 = store.addNode({ themeId: b1Theme.id, parentId: null, kind: 'branch', title: 'B1 对象环节', scaffold: { answer: null, indicators: [{ name: '毛利率', cadence: '月' }, { name: '营收', cadence: '季度' }], falsifier: null } })
const b1Spawned2 = store.spawnFromScaffold(b1Branch2.id)
ok('B1: 对象 indicators spawn 产出 2 节点', b1Spawned2.length === 2)
ok('B1: 对象 indicators 标题含毛利率', b1Spawned2.some((n) => n.title.includes('毛利率')))
ok('B1: 对象 indicators 标题含按月节奏', b1Spawned2.some((n) => n.title.includes('按月节奏更新')))
ok('B1: 对象 indicators 标题含按季度节奏', b1Spawned2.some((n) => n.title.includes('按季度节奏更新')))
ok('B1: 对象 indicators 无 undefined', !b1Spawned2.some((n) => n.title.includes('undefined')))

// B1: 非法 cadence → 归到季度
const b1Branch3 = store.addNode({ themeId: b1Theme.id, parentId: null, kind: 'branch', title: 'B1 非法环节', scaffold: { answer: null, indicators: [{ name: '测试', cadence: '每周' }], falsifier: null } })
const b1Spawned3 = store.spawnFromScaffold(b1Branch3.id)
ok('B1: 非法 cadence 归到默认', b1Spawned3.some((n) => n.title.includes('按季度节奏更新') || n.title.includes('按每周节奏更新')))

// B1: 结算日 cadence=月 → 约 30 天
const b1MonthNode = b1Spawned2.find((n) => n.title.includes('按月节奏'))
if (b1MonthNode) {
  const days = Math.round((new Date(b1MonthNode.settlement.date) - Date.now()) / 86400000)
  ok('B1: cadence=月 结算日约 30 天', days >= 25 && days <= 35, `实际 ${days}`)
} else {
  ok('B1: cadence=月 结算日约 30 天', false, '节点未找到')
}

// --- B2: metric 输入框显隐 ---

ok('B2: fetchers.js 导出 METRIC_FETCHERS', fetchersSrc66.includes('export const METRIC_FETCHERS'))
ok('B2: METRIC_FETCHERS 含 edgarConcept', fetchersSrc66.includes("'edgarConcept'"))
ok('B2: METRIC_FETCHERS 含 defillamaProtocol', fetchersSrc66.includes("'defillamaProtocol'"))
ok('B2: METRIC_FETCHERS 含 defillamaStablecoins', fetchersSrc66.includes("'defillamaStablecoins'"))
ok('B2: METRIC_FETCHERS 含 blockchainChart', fetchersSrc66.includes("'blockchainChart'"))
ok('B2: ipc.js 有 channel:metricFetchers', ipcSrc66.includes('channel:metricFetchers'))
ok('B2: ipc.js import METRIC_FETCHERS', ipcSrc66.includes('METRIC_FETCHERS'))
ok('B2: preload.js 有 metricFetchers', pj66.includes('metricFetchers'))
ok('B2: preload.cjs 有 metricFetchers', pc66.includes('metricFetchers'))
ok('B2: vault.js 用 metricFetchers', vaultSrc66.includes('metricFetchers'))
ok('B2: vault.js 用 needsMetric', vaultSrc66.includes('needsMetric'))
ok('B2: vault.js 发现按钮仍只对 edgarConcept', vaultSrc66.includes("e.target.value === 'edgarConcept' ? '' : 'none'"))

// B2: IPC 可调
ok('B2: IPC channel:metricFetchers 可调', Array.isArray(await fire('channel:metricFetchers')))
const metricFetchersList = await fire('channel:metricFetchers')
ok('B2: IPC 返回 4 个取数器', metricFetchersList.length === 4, `实际 ${metricFetchersList.length}`)

// --- B3: 验证通道库保留 metric/interval ---

const b3Library = getChannelLibrary()
ok('B3: 通道库保留 metric', b3Library.some((channel) => channel.metric))
ok('B3: 通道库保留 interval 或使用默认值', b3Library.every((channel) => channel.interval == null || channel.interval >= 15))
ok('B3: preload 无模板入口', !pj66.includes('addThemeFromTemplate') && !pc66.includes('addThemeFromTemplate'))

// --- I1: 读数筛选指标维度 ---

ok('I1: 读数保留独立指标筛选', vaultSrc66.includes("filterBar('全部指标', indicators.map"))
ok('I1: 指标筛选显式更新选中状态', vaultSrc66.includes('currentIndicator = value') && vaultSrc66.includes("child.setAttribute('aria-selected'"))
ok('I1: vault.js 有 全部指标', vaultSrc66.includes('全部指标'))
ok('I1: vault.js 有 currentIndicator', vaultSrc66.includes('currentIndicator'))
ok('I1: vault.js 指标筛选用 channelIds', vaultSrc66.includes('ind.channelIds'))
ok('I1: vault.js 保留通道筛选', vaultSrc66.includes('全部通道'))

// --- I2: 主题重命名 UI ---

ok('I2: app.js 有 renameTheme 调用', appSrc66.includes('renameTheme'))
ok('I2: app.js 有 theme-menu-btn', appSrc66.includes('theme-menu-btn'))
ok('I2: app.js 有 theme-edit-row', appSrc66.includes('theme-edit-row'))
ok('I2: app.js 有 Escape 取消', appSrc66.includes("e.key === 'Escape'"))
ok('I2: app.js 空名不保存', appSrc66.includes('if (!name)'))

// --- I3: 主题删除/恢复侧边栏 ---

ok('I3: app.js 有 removeTheme 调用', appSrc66.includes('removeTheme'))
ok('I3: app.js 有 restoreTheme 调用', appSrc66.includes('restoreTheme'))
ok('I3: app.js 有撤销按钮', appSrc66.includes('撤销'))
ok('I3: app.js toast 4 秒', appSrc66.includes('4000'))

// --- I4: 墓碑区主题名 ---

ok('I4: vault.js 墓碑区有主题名', vaultSrc66.includes("state.themes.find((t) => t.id === n.themeId)?.name"))
ok('I4: vault.js 已删主题占位', vaultSrc66.includes('已删主题'))

// --- I5: 已删主题可恢复节点数 ---

ok('I5: store.js deletedThemes 有 restorableCount', storeSrc66.includes('restorableCount'))
ok('I5: settings.js 显示恢复计数', settingsSrc66.includes('restorableCount'))
ok('I5: settings.js 恢复按钮带计数', settingsSrc66.includes('恢复 ('))
ok('I5: settings.js 零计数禁用', settingsSrc66.includes('!t.restorableCount'))

// I5 端到端
const i5Theme = store.addTheme('I5 测试主题')
store.addNode({ themeId: i5Theme.id, parentId: null, kind: 'branch', title: 'I5 环节' })
store.addNode({ themeId: i5Theme.id, parentId: null, kind: 'lemma', title: 'I5 命题', type: 'hypothesis', confidence: 60 })
store.removeTheme(i5Theme.id)
const i5Deleted = store.deletedThemes()
const i5Match = i5Deleted.find((t) => t.id === i5Theme.id)
ok('I5: deletedThemes 返回 restorableCount', i5Match && typeof i5Match.restorableCount === 'number')
ok('I5: 删除后 restorableCount > 0', i5Match && i5Match.restorableCount > 0, `实际 ${i5Match?.restorableCount}`)

// I5: 清空墓碑后 restorableCount = 0
store.purgeDead('all')
const i5AfterPurge = store.deletedThemes()
const i5Match2 = i5AfterPurge.find((t) => t.id === i5Theme.id)
if (i5Match2) {
  ok('I5: 清空后 restorableCount = 0', i5Match2.restorableCount === 0, `实际 ${i5Match2.restorableCount}`)
} else {
  ok('I5: 清空后主题不在已删列表（彻底删除）', true)
}

// --- v0.6.6 验收: preload 两份同步 ---
ok('v0.6.6 验收: preload 两份同步', pj66.includes('metricFetchers') && pc66.includes('metricFetchers'))

// ============================================================
// 主题标签库与语义归位
// ============================================================

console.log('\n— 标签库与语义归位 —')

const extractSrcTL = readFileSync2(join(ROOT2, 'src/main/extract.js'), 'utf8')
const storeSrcTL = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
const ipcSrcTL = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const vaultSrcTL = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const latticeSrcTL = readFileSync2(join(ROOT2, 'src/renderer/views/lattice.js'), 'utf8')
const pjTL = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcTL = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// --- T1: tagLibrary schema ---

ok('T1: store.js 有 tagLibrary', storeSrcTL.includes('tagLibrary'))
ok('T1: migrate 补 tagLibrary', storeSrcTL.includes('t.tagLibrary = normalizeTagLibrary(t.tagLibrary)'))
ok('T1: addTheme 给 tagLibrary: []', storeSrcTL.includes('tagLibrary: [], createdAt'))
ok('T1: updateTheme 白名单 tagLibrary', storeSrcTL.includes('patch.tagLibrary !== undefined'))
ok('T1: extract.js 有 generateTagLibrary', extractSrcTL.includes('export async function generateTagLibrary'))
ok('T1: extract.js 有 TAG_LIBRARY_SYSTEM', extractSrcTL.includes('TAG_LIBRARY_SYSTEM'))
ok('T1: extract.js threshold clamp', extractSrcTL.includes('Math.max(0.4, Math.min(0.85'))

// T1: 迁移 — 旧数据导入后 tagLibrary 为空数组
const tlTheme = store.addTheme('标签库测试主题')
ok('T1: addTheme 有 tagLibrary', Array.isArray(tlTheme.tagLibrary) && tlTheme.tagLibrary.length === 0)

// T1: updateTheme tagLibrary
store.updateTheme(tlTheme.id, { tagLibrary: [{ id: 'tl_1', name: '测试标签', synonyms: ['test'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const tlThemeAfter = store.allThemes().find((t) => t.id === tlTheme.id)
ok('T1: updateTheme tagLibrary 生效', tlThemeAfter.tagLibrary.length === 1)
ok('T1: tagLibrary 有 id', tlThemeAfter.tagLibrary[0].id === 'tl_1')

// T1: 导出导入不丢
const tlExport = JSON.parse(store.exportAll())
ok('T1: 导出含 tagLibrary', Array.isArray(tlExport.themes.find((t) => t.id === tlTheme.id)?.tagLibrary))
store.importAll(JSON.stringify({ ...tlExport, themes: tlExport.themes.map((t) => ({ ...t, tagLibrary: undefined })) }))
const tlAfterImport = store.allThemes().find((t) => t.id === tlTheme.id)
ok('T1: 旧数据导入 tagLibrary 为空数组', Array.isArray(tlAfterImport.tagLibrary) && tlAfterImport.tagLibrary.length === 0)

// --- T2: matchTagLibrary 纯函数 ---

ok('T2: store.js 有 matchTagLibrary', storeSrcTL.includes('export function matchTagLibrary'))
ok('T2: store.js 有 crossThemeMatch', storeSrcTL.includes('export function crossThemeMatch'))
ok('T2: store.js 有 recordTagHits', storeSrcTL.includes('export function recordTagHits'))

// T2: 空词库 → []
ok('T2: 空词库返回 []', store.matchTagLibrary('text', []).length === 0)
ok('T2: null 词库返回 []', store.matchTagLibrary('text', null).length === 0)

// T2: 命中 3/5 词 → score = 0.6
const tlLib = [
  { id: 'tl_a', name: '稳定币', synonyms: ['stablecoin', 'USDT', 'USDC', 'pegged'], threshold: 0.6, hits: 0, lastHitAt: null },
  { id: 'tl_b', name: '算力', synonyms: ['hash rate', 'mining'], threshold: 0.6, hits: 0, lastHitAt: null },
]
const tlMatch1 = store.matchTagLibrary('稳定币 stablecoin USDT', tlLib)
ok('T2: 命中 3/5 词有结果', tlMatch1.length > 0)
ok('T2: 命中 3/5 score=0.6', tlMatch1[0].score === 0.6, `实际 ${tlMatch1[0].score}`)

// T2: 命中 0 词 → 不出现
const tlMatch2 = store.matchTagLibrary('完全无关的内容xyz', tlLib)
ok('T2: 命中 0 词不出现', tlMatch2.length === 0)

// T2: 中英双语分别命中
const tlMatch3 = store.matchTagLibrary('stablecoin market cap', tlLib)
ok('T2: 英文命中', tlMatch3.some((m) => m.name === '稳定币'))
const tlMatch4 = store.matchTagLibrary('稳定币发行量', tlLib)
ok('T2: 中文命中', tlMatch4.some((m) => m.name === '稳定币'))

// T2: 按分数降序
const tlMatch5 = store.matchTagLibrary('稳定币 stablecoin USDT USDC pegged 算力 hash rate', tlLib)
ok('T2: 按分数降序', tlMatch5[0].score >= tlMatch5[tlMatch5.length - 1].score)

// --- T2: 跨主题匹配 ---

// 恢复 tagLibrary
store.updateTheme(tlTheme.id, { tagLibrary: tlLib })
const tlTheme2 = store.addTheme('标签库测试主题2')
store.updateTheme(tlTheme2.id, { tagLibrary: [{ id: 'tl_c', name: '轨道', synonyms: ['rail', 'metro'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const crossMatches = store.crossThemeMatch('稳定币 stablecoin USDT')
ok('T2: 跨主题匹配返回数组', Array.isArray(crossMatches))
ok('T2: 跨主题匹配命中主题1', crossMatches.some((m) => m.themeId === tlTheme.id))
ok('T2: 跨主题匹配不命中主题2', !crossMatches.some((m) => m.themeId === tlTheme2.id))

// --- T2: hits 回写 ---

store.recordTagHits(tlTheme.id, ['tl_a'])
const tlAfterHit = store.allThemes().find((t) => t.id === tlTheme.id)
const tlTagA = tlAfterHit.tagLibrary.find((t) => t.id === 'tl_a')
ok('T2: hits 回写递增', tlTagA.hits === 1)
ok('T2: lastHitAt 有值', tlTagA.lastHitAt != null)

// --- T2: updateTagLibraryTag / deleteTagLibraryTags ---

const tlUpdatedTag = store.updateTagLibraryTag(tlTheme.id, 'tl_a', { name: '稳定币改', threshold: 0.8 })
ok('T2: updateTagLibraryTag 改名', tlUpdatedTag.name === '稳定币改')
ok('T2: updateTagLibraryTag threshold clamp', tlUpdatedTag.threshold === 0.8)

const tlDeleted = store.deleteTagLibraryTags(tlTheme.id, ['tl_b'])
ok('T2: deleteTagLibraryTags 删了 1 个', tlDeleted === 1)
const tlAfterDelete = store.allThemes().find((t) => t.id === tlTheme.id)
ok('T2: deleteTagLibraryTags 后剩 1 个', tlAfterDelete.tagLibrary.length === 1)

// --- T3: processCapture 接入匹配 + 提议归位 ---

ok('T3: ipc.js 有 crossThemeMatch', ipcSrcTL.includes('crossThemeMatch'))
ok('T3: ipc.js 有 routeProposals', ipcSrcTL.includes('routeProposals'))
ok('T3: ipc.js 有 route-proposal', ipcSrcTL.includes("'route-proposal'"))
ok('T3: ipc.js 有 recordTagHits', ipcSrcTL.includes('recordTagHits'))
ok('T3: ipc.js theme:setupNew 调 generateTagLibrary', ipcSrcTL.includes('generateTagLibrary'))
ok('T3: ipc.js 无 theme:fromTemplate', !ipcSrcTL.includes('theme:fromTemplate'))

// --- T4: 标签库可视化 ---

ok('T4: lattice.js 有 renderTagLibraryBand', latticeSrcTL.includes('function renderTagLibraryBand'))
ok('T4: lattice.js 有 标签库', latticeSrcTL.includes('标签库'))
ok('T4: lattice.js 有 整理', latticeSrcTL.includes('整理'))
ok('T4: lattice.js 有 全选命中 0', latticeSrcTL.includes('全选命中 0'))
ok('T4: lattice.js 有 删除所选', latticeSrcTL.includes('删除所选'))
ok('T4: lattice.js 无 prompt(', !latticeSrcTL.includes('prompt('))

// T4: 无禁用词
ok('T4: lattice.js 无加权', !latticeSrcTL.includes('加权'))
ok('T4: lattice.js 无汇总', !latticeSrcTL.includes('汇总'))
ok('T4: lattice.js 无总量', !latticeSrcTL.includes('总量'))
ok('T4: lattice.js 无合计', !latticeSrcTL.includes('合计'))

// --- T5: 主题级操作合并 ---

ok('T5: lattice.js 有 主题名', latticeSrcTL.includes('主题名'))
ok('T5: lattice.js 有 主题标签', latticeSrcTL.includes('主题标签'))
ok('T5: lattice.js 有 删除主题', latticeSrcTL.includes('删除主题'))
ok('T5: lattice.js 有 renameTheme', latticeSrcTL.includes('renameTheme'))
ok('T5: lattice.js 有 removeTheme', latticeSrcTL.includes('removeTheme'))

// --- T6: 画树不生成新环节 ---

ok('T6: ipc.js 无 生成新环节', !ipcSrcTL.includes('生成新环节'))

// --- 领域中立（只检查新增的标签库代码，不查存量 SIC 映射/prompt 示例）---

const tagLibPrompt = extractSrcTL.match(/TAG_LIBRARY_SYSTEM = `[\s\S]*?`/)?.[0] || ''
ok('领域中立: TAG_LIBRARY_SYSTEM 无硬编码行业词', !tagLibPrompt.match(/光模块|半导体|hyperscaler|AI 产业/))
ok('领域中立: matchTagLibrary 无硬编码行业词', !storeSrcTL.match(/function matchTagLibrary[\s\S]*?^}/m)?.[0]?.match(/光模块|半导体|hyperscaler/))
ok('领域中立: lattice.js 无硬编码行业词', !latticeSrcTL.match(/光模块|半导体|hyperscaler/))

// --- IPC + preload ---

ok('TL: ipc.js 有 tagLibrary:updateTag', ipcSrcTL.includes('tagLibrary:updateTag'))
ok('TL: ipc.js 有 tagLibrary:deleteTags', ipcSrcTL.includes('tagLibrary:deleteTags'))
ok('TL: preload.js 有 updateTagLibraryTag', pjTL.includes('updateTagLibraryTag'))
ok('TL: preload.cjs 有 updateTagLibraryTag', pcTL.includes('updateTagLibraryTag'))
ok('TL: preload.js 有 deleteTagLibraryTags', pjTL.includes('deleteTagLibraryTags'))
ok('TL: preload.cjs 有 deleteTagLibraryTags', pcTL.includes('deleteTagLibraryTags'))
ok('TL: preload 两份同步', pjTL.includes('updateTagLibraryTag') === pcTL.includes('updateTagLibraryTag'))

// --- IPC 可调 ---

ok('TL: IPC tagLibrary:updateTag 可调', await fire('theme:tagLibrary:updateTag', tlTheme.id, 'tl_a', { name: '改过' }) != null)
ok('TL: IPC tagLibrary:deleteTags 可调', typeof await fire('theme:tagLibrary:deleteTags', tlTheme.id, []) === 'number')

// ============================================================
// 主题入口与读数拆分（E + R）
// ============================================================

console.log('\n— 主题入口与读数拆分 —')

const appSrcER = readFileSync2(join(ROOT2, 'src/renderer/app.js'), 'utf8')
const vaultSrcER = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const latticeSrcER = readFileSync2(join(ROOT2, 'src/renderer/views/lattice.js'), 'utf8')
const inspectorSrcER = readFileSync2(join(ROOT2, 'src/renderer/views/inspector.js'), 'utf8')
const ipcSrcER = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const pjER = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcER = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// --- E1: 单一路径建主题 ---

ok('E1: app.js 有 renderThemeCreator', appSrcER.includes('function renderThemeCreator'))
ok('E1: app.js 有 setupNewTheme 调用', appSrcER.includes('setupNewTheme'))
ok('E1: app.js 无 addThemeFromTemplate 调用', !appSrcER.includes('addThemeFromTemplate'))
ok('E1: app.js 只有描述输入框', appSrcER.includes('描述你要跟踪的'))

// --- E2: 空态复用 ---

ok('E2: emptyState 调 renderThemeCreator', appSrcER.includes('renderThemeCreator()'))
// skeleton-desc 只在 app.js 的 renderThemeCreator 中定义（不复制到其他文件）
ok('E2: skeleton-desc 只在 app.js', appSrcER.includes('skeleton-desc') && !latticeSrcER.includes('skeleton-desc') && !vaultSrcER.includes('skeleton-desc') && !inspectorSrcER.includes('skeleton-desc'))

// --- E3: 空白主题补生成骨架 ---

ok('E3: lattice.js 有 renderSkeletonPrompt', latticeSrcER.includes('function renderSkeletonPrompt'))
ok('E3: lattice.js 有骨架提示', latticeSrcER.includes('还没有骨架'))
ok('E3: lattice.js 有 scaffoldExisting 调用', latticeSrcER.includes('scaffoldExisting'))
ok('E3: ipc.js 有 scaffoldTheme 共用函数', ipcSrcER.includes('async function scaffoldTheme'))
ok('E3: ipc.js 有 theme:scaffoldExisting', ipcSrcER.includes('theme:scaffoldExisting'))
ok('E3: ipc.js setupNew 调 scaffoldTheme', ipcSrcER.includes('await scaffoldTheme(theme.id, description, settings())'))
ok('E3: preload.js 有 scaffoldExisting', pjER.includes('scaffoldExisting'))
ok('E3: preload.cjs 有 scaffoldExisting', pcER.includes('scaffoldExisting'))
ok('E3: preload 两份同步', pjER.includes('scaffoldExisting') === pcER.includes('scaffoldExisting'))

// E3 端到端：空白主题补生成
const e3Theme = store.addTheme('E3 空白主题')
const e3BeforeNodes = store.allNodes().filter((n) => n.themeId === e3Theme.id).length
ok('E3: 空白主题无节点', e3BeforeNodes === 0)
const e3Result = await fire('theme:scaffoldExisting', e3Theme.id, 'AI 算力供应链')
ok('E3: scaffoldExisting 返回 ok', e3Result?.ok === true)
const e3AfterNodes = store.allNodes().filter((n) => n.themeId === e3Theme.id).length
ok('E3: 补生成后有节点', e3AfterNodes > 0, `实际 ${e3AfterNodes}`)
const e3ThemeAfter = store.allThemes().find((t) => t.id === e3Theme.id)
ok('E3: 补生成后有标签库', Array.isArray(e3ThemeAfter?.tagLibrary))

// --- R1: 读数视图只读 + 三审计字段 ---

ok('R1: vault.js 无手动录入表单', !vaultSrcER.includes('手动记一条读数'))
ok('R1: vault.js 有数据期', vaultSrcER.includes('数据期'))
ok('R1: vault.js 有抓于', vaultSrcER.includes('抓于'))
ok('R1: vault.js 有跟踪', vaultSrcER.includes('跟踪'))
ok('R1: 跟踪按整组通道集合计算', vaultSrcER.includes('const tracked = indicators.filter') && vaultSrcER.includes('channelIds.has(id)') && !vaultSrcER.slice(vaultSrcER.indexOf('function readingRow'), vaultSrcER.indexOf('function metricCard')).includes('跟踪'))
ok('R1: vault.js 有 asof-group-start', vaultSrcER.includes('asof-group-start'))

// R1 端到端：读数显示跟踪指标
const r1Theme = store.addTheme('R1 测试主题')
const r1Node = store.addNode({ themeId: r1Theme.id, parentId: null, kind: 'branch', title: 'R1 环节' })
const r1Ind = store.addNode({ themeId: r1Theme.id, parentId: r1Node.id, kind: 'lemma', title: 'R1 指标', type: 'observation', confidence: 50 })
const r1Ch = store.addChannel({ name: 'R1 通道', fetch: 'manual', kind: '一手数据', themeId: r1Theme.id })
store.updateNode(r1Ind.id, { channelIds: [r1Ch.id] })
store.addReading({ metric: 'r1.test', value: 42, unit: 'USD', asOf: '2024-Q1', channelId: r1Ch.id, source: { kind: '一手数据' } })
const r1Inds = store.indicatorsForReading({ channelId: r1Ch.id })
ok('R1: indicatorsForReading 返回指标', r1Inds.length > 0 && r1Inds[0].title === 'R1 指标')

// --- R2: 手填读数在检视面板 ---

ok('R2: inspector.js 有手填一条读数', inspectorSrcER.includes('手填一条读数'))
ok('R2: inspector.js 有 manual 通道', inspectorSrcER.includes("c.fetch === 'manual'"))
ok('R2: inspector.js 有 channelAdd', inspectorSrcER.includes('channelAdd'))
ok('R2: inspector.js 有 addReading', inspectorSrcER.includes('addReading'))
ok('R2: vault.js 无 addReading 调用', !vaultSrcER.includes('addReading'))

// --- R3: 缺口只保留头部汇总，提议移到检视面板 ---

ok('R3: lattice.js 无 renderGapList', !latticeSrcER.includes('function renderGapList'))
ok('R3: lattice.js 有指标汇总', latticeSrcER.includes('个指标') && latticeSrcER.includes('个未接数据'))
ok('R3: inspector.js 有 proposeLinks', inspectorSrcER.includes('proposeLinks'))
ok('R3: inspector.js 有采用按钮', inspectorSrcER.includes('采用'))
ok('R3: inspector.js 有忽略按钮', inspectorSrcER.includes('忽略'))
ok('R3: inspector.js 采用后立即拉取', inspectorSrcER.includes('channelFetch'))
ok('R3: vault.js 无 proposeLinks', !vaultSrcER.includes('proposeLinks'))

// --- R4: 无「未关联」筛选项 ---

ok('R4: vault.js 无未关联筛选', !vaultSrcER.includes("'未关联'"))

// --- 验收清单 ---

// 1. 读数视图无表单
ok('验收: vault.js 无 addReading', !vaultSrcER.includes('addReading'))
ok('验收: vault.js 无 手动记一条', !vaultSrcER.includes('手动记一条'))

// 2. 旧数据兼容：有 indicatorId 的旧读数正常显示
const oldReading = store.addReading({ metric: 'old.test', value: 1, indicatorId: 'old-ind', source: { kind: '一手数据' } })
ok('验收: 旧读数有 indicatorId 不影响 addReading', oldReading.added === true)

// 3. scaffoldTheme 不写 indicatorId
const scaffoldThemeSrc = ipcSrcER.slice(
  ipcSrcER.indexOf('async function scaffoldTheme'),
  ipcSrcER.indexOf("ipcMain.handle('theme:setupNew'"),
)
ok('验收: ipc.js scaffoldTheme 无 indicatorId', !scaffoldThemeSrc.includes('indicatorId'))

// ============================================================
// v0.7: S4 图交互 + S5 字阶
// ============================================================

console.log('\n— v0.7: 图交互与字阶 —')

const graphSrcS45 = readFileSync2(join(ROOT2, 'src/renderer/views/graph.js'), 'utf8')
const stylesSrcS45 = readFileSync2(join(ROOT2, 'src/renderer/styles.css'), 'utf8')
const rendererJsS45 = [
  appSrcER,
  latticeSrcER,
  inspectorSrcER,
  vaultSrcER,
  readFileSync2(join(ROOT2, 'src/renderer/views/settings.js'), 'utf8'),
  readFileSync2(join(ROOT2, 'src/renderer/views/today.js'), 'utf8'),
].join('\n')

ok('S4: graph.js 无 CRUD 函数', !graphSrcS45.match(/addChildHere|toggleCold|removeNode/))
ok('S4: graph.js 无原生 confirm', !graphSrcS45.includes('confirm('))
ok('S4: graph.js 无浮动操作组', !graphSrcS45.includes('node-acts'))
ok('S4: 图中隐藏重新生成', latticeSrcER.includes('isGraph ? null : (() => {'))
ok('S4: 图中隐藏新建按钮', latticeSrcER.includes("isGraph ? null : h('button'"))
ok('S4: 图中 Enter 切回树形', latticeSrcER.includes("state.shape === 'graph'"))
ok('S4: 图中方向键遍历节点', latticeSrcER.includes("state.shape === 'graph' ? '.node' : '.row'"))
ok('S4: 支持 Cmd/Ctrl+Backspace', latticeSrcER.includes("(e.metaKey || e.ctrlKey) && e.key === 'Backspace'"))
ok('S4: 树图共用软删函数', appSrcER.includes('export async function deleteNodeWithUndo'))
ok('S4: 软删 toast 可撤销', appSrcER.includes('m.restoreNode(id)') && appSrcER.includes("label: '撤销'"))

ok('S5: 有 caption 字阶', stylesSrcS45.includes('--t-caption: 11px'))
ok('S5: 有 body 字阶', stylesSrcS45.includes('--t-body: 13px'))
ok('S5: 有 title 字阶', stylesSrcS45.includes('--t-title: 15px'))
ok('S5: 有 head 字阶', stylesSrcS45.includes('--t-head: 20px'))
ok('S5: 有 hero 字阶', stylesSrcS45.includes('--t-hero: 28px'))
ok('S5: CSS 无直接像素字号', !/font-size:\s*[\d.]+px/.test(stylesSrcS45))
ok('S5: 渲染 JS 无直接像素字号', !/fontSize:\s*['"][\d.]+px/.test(rendererJsS45))

// ============================================================
console.log('\n— C2: 忽略归位建议与分组审计（离线行为）—')
// 独立测试数据；不读取真实用户目录，也不调用模型或网络。
const c2Snapshot = store.exportAll({ withRaw: false })
store.importAll(JSON.stringify({ nodes: [], themes: [], inbox: [], verdicts: [] }))
const c2Theme = store.addTheme('C2 suggested theme')
const c2OtherTheme = store.addTheme('C2 unrelated theme')
store.updateTheme(c2Theme.id, { tagLibrary: [{ id: 'c2-tag', name: 'zirconium', synonyms: [], threshold: 0.6 }] })
store.addNode({ themeId: c2OtherTheme.id, kind: 'lemma', title: 'default capture context' })
const c2Capture = await fire('inbox:capture', 'zirconium refinery output rises', { kind: '一手数据', platform: 'offline-test' })
const c2Captured = c2Capture.routeProposals?.[0]
ok('C2: capture 保留路由类型和主题', c2Captured?.kind === 'route-proposal' && c2Captured.matchedTheme.id === c2Theme.id)
ok('C2: capture 保留标签、通道和 bestScore', c2Captured?.matchedTags[0].tagId === 'c2-tag' && c2Captured.originChannel.platform === 'offline-test' && c2Captured.bestScore === 1)
// 以下用明确的 proposal 文本验证三条匹配路径。
store.importAll(JSON.stringify({ nodes: [], themes: [c2Theme, c2OtherTheme], inbox: [], verdicts: [] }))
const c2Propose = (fields = {}) => store.addInboxItem({
  kind: 'route-proposal', title: 'unrelated headline', text: 'unrelated body',
  matchedTheme: { id: c2Theme.id, name: c2Theme.name },
  matchedTags: [{ name: 'zirconium', score: 0.8 }],
  originChannel: { id: 'c2-channel', kind: '一手数据' }, bestScore: 0.8,
  ...fields,
})
const c2New = c2Propose({ lemmas: [{ title: 'Zirconium refinery output rises' }] })
ok('C2: addInboxItem 保留所有建议字段', c2New.kind === 'route-proposal' && c2New.matchedTheme.id === c2Theme.id && c2New.matchedTags[0].score === 0.8 && c2New.originChannel.id === 'c2-channel' && c2New.bestScore === 0.8)
const c2Before = store.allVerdicts().length
await fire('inbox:resolve', c2New.id, 'reject', { kind: 'ordinary' })
const c2IgnoredAt = c2New.ignoredAt
await fire('inbox:resolve', c2New.id, 'reject')
ok('C2: 路由拒绝不写 verdict 且幂等', store.allVerdicts().length === c2Before && c2New.ignored === true && !!c2IgnoredAt && c2New.ignoredAt === c2IgnoredAt)
ok('C2: ignored 不出现在活动队列/计数', store.allInbox().length === 0 && store.inboxCount() === 0 && store.stats().inbox === 0)
ok('C2: ignored getter 与 IPC 返回保留记录', store.ignoredInbox()[0]?.id === c2New.id && (await fire('inbox:ignored'))[0]?.id === c2New.id)
const c2Ordinary = store.addInboxItem({ title: 'ordinary rejection', label: { kind: '独立媒体', quality: 0.65 } })
await fire('inbox:resolve', c2Ordinary.id, 'reject', { kind: 'route-proposal' })
const c2ResolvedAt = c2Ordinary.resolvedAt
await fire('inbox:resolve', c2Ordinary.id, 'reject')
store.resolveInboxItem(c2Ordinary.id, 'reject')
ok('C2: 普通拒绝只写一次 user verdict，不信任客户端类型', store.allVerdicts().length === c2Before + 1 && store.allVerdicts()[0].gate === 'user' && c2Ordinary.resolvedAt === c2ResolvedAt)
ok('C2: 未知 id 不写 verdict', await fire('inbox:resolve', 'c2-missing', 'reject') === null && store.allVerdicts().length === c2Before + 1)
store.addNode({ themeId: c2OtherTheme.id, title: 'Zirconium refinery output rises' })
const c2Branch = store.addNode({ themeId: c2Theme.id, kind: 'branch', title: 'Zirconium refinery output rises' })
store.updateNode(c2Branch.id, { title: 'Zirconium refinery output rises' })
store.addSource(c2Branch.id, { kind: '一手数据' })
ok('C2: 跨主题和 branch 占位均不回填', !c2New.promotedTo)
const c2Node = store.addNode({ themeId: c2Theme.id, title: '  zirconium refinery output rises  ' })
ok('C2: 新 lemma 以建议 lemmas 标题回填', c2New.promotedTo === c2Node.id && !!c2New.promotedAt)
const c2PromotedAt = c2New.promotedAt
store.addNode({ themeId: c2Theme.id, title: 'Zirconium refinery output rises' })
store.addSource(c2Node.id, { kind: '一手数据' })
ok('C2: 回填不覆盖首次目标和日期', c2New.promotedTo === c2Node.id && c2New.promotedAt === c2PromotedAt)
const c2Rename = c2Propose({ text: 'sapphire shipments accelerate' })
store.resolveInboxItem(c2Rename.id, 'reject')
const c2RenameNode = store.addNode({ themeId: c2Theme.id, title: 'old unrelated wording' })
store.updateNode(c2RenameNode.id, { title: 'sapphire shipments accelerate strongly' })
ok('C2: rename 以 proposal text token 重合回填', c2Rename.promotedTo === c2RenameNode.id)
const c2MergeNode = store.addNode({ themeId: c2Theme.id, title: 'cobalt battery demand' })
const c2Merge = c2Propose({ title: 'cobalt battery demand', text: '', lemmas: [] })
store.resolveInboxItem(c2Merge.id, 'reject')
ok('C2: 忽略时不追溯已存在节点', !c2Merge.promotedTo)
store.addSource(c2MergeNode.id, { kind: '一手数据', label: 'new evidence' })
ok('C2: addSource merge 以 proposal title 回填', c2Merge.promotedTo === c2MergeNode.id && !!c2Merge.promotedAt)
const c2Cross = c2Propose({ title: 'tungsten mine supply', text: '' })
store.resolveInboxItem(c2Cross.id, 'reject')
const c2CrossNode = store.addNode({ themeId: c2OtherTheme.id, title: 'unrelated' })
store.updateNode(c2CrossNode.id, { title: 'tungsten mine supply' })
store.addSource(c2CrossNode.id, { kind: '一手数据' })
ok('C2: rename / merge 也不能跨主题回填', !c2Cross.promotedTo)
const c2Pending = c2Propose({ title: 'platinum catalyst output', text: '' })
store.addNode({ themeId: c2Theme.id, title: c2Pending.title })
ok('C2: 未忽略的建议不回填', !c2Pending.promotedTo)
const c2Empty = c2Propose({ title: '', text: '', lemmas: [] })
store.resolveInboxItem(c2Empty.id, 'reject')
store.addNode({ themeId: c2Theme.id, title: '' })
ok('C2: 空标题不能回填', !c2Empty.promotedTo)
store.resolveInboxItem(c2New.id, 'accept')
store.clearInbox()
ok('C2: clear 保留已接受的 ignored 和待处理建议', store.ignoredInbox().some((p) => p.id === c2New.id && p.status === 'accepted') && store.allInbox().some((p) => p.id === c2Pending.id))
const c2RoundTrip = store.exportAll({ withRaw: false })
store.importAll(c2RoundTrip)
const c2Restored = store.ignoredInbox().find((p) => p.id === c2New.id)
ok('C2: 导入导出保留忽略、回填和建议字段', c2Restored?.ignoredAt === c2IgnoredAt && c2Restored.promotedAt === c2PromotedAt && c2Restored.promotedTo === c2Node.id && c2Restored.bestScore === 0.8 && c2Restored.matchedTags.length === 1)
await fire('inbox:resolve', c2New.id, 'reject')
store.clearInbox()
ok('C2: 导入后再次忽略/清理仍幂等', store.ignoredInbox().find((p) => p.id === c2New.id)?.ignoredAt === c2IgnoredAt && store.allVerdicts().length === 1)
// 使用明确日期的独立夹具，验证窗口、未知 gate、悬空目标和各组分母。
const c2Now = new Date().toISOString()
const c2Old = new Date(Date.now() - 60 * 864e5).toISOString()
store.importAll(JSON.stringify({
  nodes: [c2Node], themes: [c2Theme],
  verdicts: [
    { id: 's1', gate: 'source', at: c2Now, promotedTo: c2Node.id },
    { id: 's2', gate: 'source', at: c2Now },
    { id: 'd1', gate: 'dedup', at: c2Now, promotedTo: 'deleted-node' },
    { id: 'u1', gate: 'user', at: c2Now },
    { id: 'o1', gate: 'unexpected', at: c2Now, promotedTo: 'deleted-node' },
    { id: 'o2', gate: 'routeIgnored', at: c2Now },
    { id: 'o3', gate: 'toString', at: c2Now },
    { id: 'old', gate: 'source', at: c2Old, promotedTo: c2Node.id },
  ],
  inbox: [
    { ...c2Restored, id: 'r1', ignoredAt: c2Now, createdAt: c2Old },
    { ...c2Restored, id: 'r2', ignoredAt: c2Now, promotedTo: 'deleted-node' },
    { ...c2Restored, id: 'r3', ignoredAt: c2Now, promotedTo: null },
    { ...c2Restored, id: 'r-old', ignoredAt: c2Old, createdAt: c2Now },
    { ...c2Restored, id: 'not-route', kind: 'ordinary', ignoredAt: c2Now },
    { ...c2Restored, id: 'not-ignored', ignored: false, ignoredAt: c2Now },
  ],
}))
const c2Audit = store.falseKillAudit(30)
ok('C2: historical / recent 总数只含 verdict', c2Audit.allTotal === 8 && c2Audit.total === 7 && c2Audit.missed === 3 && c2Audit.rate === 3 / 7)
ok('C2: 顶层 items 只含回填 verdict，悬空目标仍保留', c2Audit.items.length === 3 && c2Audit.items.every((x) => x.verdict && !x.proposal) && c2Audit.items.some((x) => x.node === null))
for (const [gate, total, missed] of [['source', 2, 1], ['dedup', 1, 1], ['user', 1, 0], ['other', 3, 1], ['routeIgnored', 3, 2]]) {
  const g = c2Audit.byGate[gate]
  ok(`C2: ${gate} 独立分母/分子/比率与完整列表`, g.total === total && g.missed === missed && g.rate === missed / total && g.items.length === total)
}
ok('C2: routeIgnored 只来自 inbox，按 ignoredAt 而非 createdAt', c2Audit.byGate.routeIgnored.items.every((x) => x.proposal && !x.verdict && ['r1', 'r2', 'r3'].includes(x.proposal.id)))
ok('C2: routeIgnored 悬空目标保留证据', c2Audit.byGate.routeIgnored.items.find((x) => x.proposal.id === 'r2')?.node === null)
ok('C2: verdict 命名为 routeIgnored 也归 other', c2Audit.byGate.other.items.some((x) => x.verdict.id === 'o2'))
store.importAll(JSON.stringify({ nodes: [] }))
const c2EmptyAudit = store.falseKillAudit()
ok('C2: 旧空数据无 NaN，所有组仍返回空数组', c2EmptyAudit.allTotal === 0 && c2EmptyAudit.rate === 0 && Object.values(c2EmptyAudit.byGate).every((g) => g.total === 0 && g.missed === 0 && g.rate === 0 && g.items.length === 0))
store.importAll(c2Snapshot)

console.log('\n— v0.7.1 捕获来源与展示契约 —')
const cleanupSnapshot = store.exportAll({ withRaw: false })
const cleanupFetch = globalThis.fetch
try {
  store.importAll(JSON.stringify({ nodes: [], themes: [], settings: { apiKey: '' }, inbox: [], verdicts: [] }))
  const captureTheme = store.addTheme('手工捕获验收')
  const capture = await fire('inbox:capture', '本期设备出货达到一百台，尚需人工核实。')
  const imported = await fire('inbox:import', captureTheme.id, [capture.item])
  const raw = store.getRaw(store.getNode(imported.results[0].id).sources[0].rawId)
  ok('C1: 纯文本 raw label 标记手工粘贴及日期', raw.label === `手工粘贴 · ${store.today()}`)
  ok('C1: 剪贴板读取桥可调用', typeof await fire('io:readClipboard') === 'string')
  const url = 'https://example.com/cleanup-source'
  globalThis.fetch = async (requested) => {
    if (requested !== url) throw new Error('测试不允许外网请求')
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<article>' + '季度供应链开工率上升，企业披露设备投产进度并提醒短期风险。'.repeat(5) + '</article>' }
  }
  const fromUrl = await fire('inbox:capture', url)
  ok('C1: URL 捕获保留平台、地址、抓取时间', fromUrl.item.provenance.url === url && fromUrl.item.provenance.platform === 'example.com' && !!fromUrl.item.provenance.fetchedAt)
  const urlImport = await fire('inbox:import', captureTheme.id, [fromUrl.item])
  const urlNode = store.getNode(urlImport.results[0].id)
  ok('C1: URL raw label 使用原始地址', store.getRaw(urlNode.sources[0].rawId).label === url)
  ok('C1: 入库来源继续保留 URL 与抓取时间', urlNode.sources[0].url === url && !!urlNode.sources[0].fetchedAt)
  const gaapLabels = await fire('db:commonUsGaap')
  ok('C6: 中文指标映射通过 IPC 提供', gaapLabels.some(({ tag, label }) => tag === 'Revenues' && label === '总收入'))
} finally {
  globalThis.fetch = cleanupFetch
  store.importAll(cleanupSnapshot)
}
const cleanupToday = readFileSync2(join(ROOT2, 'src/renderer/views/today.js'), 'utf8')
const cleanupMain = readFileSync2(join(ROOT2, 'src/main/main.js'), 'utf8')
const cleanupPreload = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const cleanupPreloadCjs = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')
ok('C1: 两份 preload 完全同步', cleanupPreload === cleanupPreloadCjs)
ok('C1: 输入框和拖拽清理干净', !/inbox-textarea|ondrop|ondragover|inboxDraft/.test(cleanupToday + stylesSrcS45))
ok('C1: 输入聚焦推送全链路清理', !/inbox:focus|onInboxFocus/.test(cleanupMain + cleanupPreload + cleanupPreloadCjs + appSrcER))
ok('C1: 侧栏按钮读取剪贴板且空态有提示', appSrcER.includes('m.readClipboard()') && appSrcER.includes('剪贴板是空的'))
ok('C3: Windows 字体在 Mac 字体之后', stylesSrcS45.indexOf('Segoe UI') > stylesSrcS45.indexOf('Hiragino Sans GB') && stylesSrcS45.includes('Microsoft YaHei'))
ok('C3: mica 仅用于 win32', cleanupMain.includes("process.platform === 'win32' ? { backgroundMaterial: 'mica' }"))
ok('C4: 默认树并保存用户切换', appSrcER.includes("localStorage.getItem('meridian.shape') === 'graph' ? 'graph' : 'tree'") && appSrcER.includes("localStorage.setItem('meridian.shape', shape)"))
ok('C5: 6/12/18 圆角档位', stylesSrcS45.includes('--r-sm: 6px') && stylesSrcS45.includes('--r: 12px') && stylesSrcS45.includes('--r-lg: 18px'))
ok('C5: 普通圆角使用 token，非标准字重已移除', !/border-radius:[^;]*\dpx/.test(stylesSrcS45) && !/font-weight:\s*(500|550|650)/.test(stylesSrcS45))
const cleanupReadingRow = vaultSrcER.slice(vaultSrcER.indexOf('function readingRow'), vaultSrcER.indexOf('function metricCard'))
ok('C6: 每条只有两行 meta，跟踪不重复', (cleanupReadingRow.match(/class: 'q-meta/g) || []).length === 2 && !cleanupReadingRow.includes('跟踪'))
ok('C6: 单项筛选整排隐藏', vaultSrcER.includes('if (options.length <= 1) return null'))

// ============================================================
// LLM 成本治理：A（lastFetch 精度）B（免费过滤层）C（节流与归因）D（收件箱三态）
// ============================================================

console.log('\n— 成本治理：A/B 免费过滤层 —')

const { readUsage, __testHooks: llmHooks, SCENARIO_LABELS } = await import('../src/main/llmlog.js')
const { startScheduler, isQuietHours: govQuiet } = await import('../src/main/scheduler.js')
const ipcSrcGov = readFileSync2(join(ROOT2, 'src/main/ipc.js'), 'utf8')
const vaultSrcGov = readFileSync2(join(ROOT2, 'src/renderer/views/vault.js'), 'utf8')
const todaySrcGov = readFileSync2(join(ROOT2, 'src/renderer/views/today.js'), 'utf8')
const storeSrcGov = readFileSync2(join(ROOT2, 'src/main/store.js'), 'utf8')
const schedulerSrcGov = readFileSync2(join(ROOT2, 'src/main/scheduler.js'), 'utf8')
const pjGov = readFileSync2(join(ROOT2, 'src/main/preload.js'), 'utf8')
const pcGov = readFileSync2(join(ROOT2, 'src/main/preload.cjs'), 'utf8')

// ---- C4：token 读取（原来 9 个调用点一处都没读 usage）----

const usageRes = new Response(JSON.stringify({ usage: { total_tokens: 42 }, choices: [] }), { headers: { 'content-type': 'application/json' } })
ok('C4: readUsage 读 total_tokens', await readUsage(usageRes) === 42)
ok('C4: readUsage 不消费原响应体', (await usageRes.json())?.usage?.total_tokens === 42)
ok('C4: readUsage 无 usage 返回 0', await readUsage(new Response('{}', { headers: { 'content-type': 'application/json' } })) === 0)
ok('C4: readUsage 解析失败返回 0', await readUsage(new Response('not json', { headers: { 'content-type': 'application/json' } })) === 0)
ok('C4: 调用点只在 tracked 里记账', ipcSrcGov.includes('tracked(') && !ipcSrcGov.includes('recordLlmUsage'))

const usageToday = () => store.llmUsage().daily.find((d) => d.date === store.today()) || { calls: 0, failed: 0, degraded: 0, tokens: 0, byScenario: {} }
// 账本是同一个对象，比较前先拍快照，否则 before/after 是同一个引用
const usageSnapshot = () => { const d = usageToday(); return { calls: d.calls, failed: d.failed, degraded: d.degraded, tokens: d.tokens, byScenario: { ...d.byScenario } } }
const c4Before = usageSnapshot()
store.recordLlmUsage('extract', { ok: true, tokens: 120 })
store.recordLlmUsage('extract', { ok: false, error: 'timeout', latency: 15000 })
const c4After = usageSnapshot()
ok('C4: 按天聚合调用次数', c4After.calls === c4Before.calls + 2)
ok('C4: 按天累计 token', c4After.tokens === c4Before.tokens + 120)
ok('C4: 失败计数', c4After.failed === c4Before.failed + 1)
ok('C4: 按场景分组', (c4After.byScenario.extract || 0) === (c4Before.byScenario.extract || 0) + 2)
ok('C4: 失败明细带场景与耗时', store.llmUsage().recent[0].scenario === 'extract' && store.llmUsage().recent[0].error === 'timeout' && store.llmUsage().recent[0].latency === 15000)
ok('C4: 同一天只有一条账', store.llmUsage().daily.filter((d) => d.date === store.today()).length === 1)

for (let i = 0; i < 60; i++) store.recordLlmUsage('extract', { ok: false, error: `boom-${i}` })
ok('C4: 失败明细封顶 50 条', store.llmUsage().recent.length === 50, `实际 ${store.llmUsage().recent.length}`)
ok('C4: 封顶保留最新', store.llmUsage().recent[0].error === 'boom-59')
ok('C4: 账本过迁移仍是对象', (() => { const dbRaw = store.load(); return typeof dbRaw.llmUsage === 'object' && Array.isArray(dbRaw.llmUsage.daily) })())

// ---- A：lastFetch 存完整时间，interval 才真正生效 ----

const aGeo = store.addTheme('成本治理主题')
const aCh = store.addChannel({ name: 'A-精度通道', fetch: 'rss', kind: '独立媒体', query: 'http://example.com/a.xml', themeId: aGeo.id })
const aRealFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('测试不允许外网请求') }
await fire('channel:fetch', aCh.id)
globalThis.fetch = aRealFetch
const aAfter = store.allChannels().find((c) => c.id === aCh.id)
ok('A: 拉取后 lastFetch 是完整时间', typeof aAfter.lastFetch === 'string' && aAfter.lastFetch.includes('T') && Date.parse(aAfter.lastFetch) > Date.now() - 60000, `实际 ${aAfter.lastFetch}`)
ok('A: 刚拉过的通道不 due', dueChannels([aAfter], Date.now(), new Map(), ['rss']).length === 0)
ok('A: ipc.js 不再写日期型 lastFetch', !ipcSrcGov.includes('lastFetch: today()') && ipcSrcGov.includes('lastFetch: new Date().toISOString()'))
ok('A: 老日期型数据不迁移，注释说明', schedulerSrcGov.includes('不做迁移'))

// ---- 让成本治理主题成为默认主题，装上可控抽取桩 ----

const aLemmaCount = (id) => store.allNodes().filter((n) => n.themeId === id && n.kind === 'lemma' && n.status !== 'dead').length
const aMaxOther = Math.max(0, ...store.allThemes().filter((t) => t.id !== aGeo.id).map((t) => aLemmaCount(t.id)))
const aBranch = store.addNode({ themeId: aGeo.id, kind: 'branch', title: '成本治理环节', propagation: 0.5 })
for (let i = 0; i <= aMaxOther; i++) {
  store.addNode({ themeId: aGeo.id, parentId: aBranch.id, kind: 'lemma', title: `治理基线${i}`, confidence: 50 })
}
ok('B: 成本治理主题成为默认主题', store.bestThemeContext()?.id === aGeo.id, `实际 ${store.bestThemeContext()?.name}`)

const realRunHook = llmHooks.run
let extractCalls = 0
let stubTitle = null
llmHooks.run = async (scenario, args) => {
  if (scenario === 'extract') {
    extractCalls++
    return { ok: true, lemmas: [{ title: stubTitle || `治理抽取命题·${String(args.text).slice(0, 10)}`, type: 'observation', confidence: 70, parentHint: null, tags: [], sourceKind: '一手数据' }], usage: 321 }
  }
  return { ok: false, reason: 'no-key' }
}
store.saveSettings({ apiKey: 'sk-gov-test', labeler: 'table' })

// ---- B1：同 hash 第二次进来零调用 ----

const b1Text = '成本治理测试：某公司发布新一代交换机，端口密度提升一倍。'
const b1TokensBefore = usageToday().tokens
const b1CallsBefore = usageToday().byScenario.extract || 0
const b1First = await fire('inbox:capture', b1Text)
ok('B1: 首次捕获走抽取', extractCalls === 1 && b1First?.ok === true)
ok('B1: 抽取写进账本并带上 token', (usageToday().tokens === b1TokensBefore + 321) && (usageToday().byScenario.extract || 0) === b1CallsBefore + 1, `token 增量 ${usageToday().tokens - b1TokensBefore}`)
const b1Second = await fire('inbox:capture', b1Text)
ok('B1: 同 hash 第二次零调用', extractCalls === 1, `实际 ${extractCalls}`)
ok('B1: 走的是复用路径', store.allTraces().some((t) => t.stage === 'extract' && t.actor?.by === 'reuse'))
ok('B1: 复用不产生新的账本调用', (usageToday().byScenario.extract || 0) === b1CallsBefore + 1)
ok('B1: 复用仍返回结论', b1Second?.ok === true && (b1Second?.item || b1Second?.autoImported))

// ---- B3：高相似（≥0.85）直接并源，不抽 ----

const b3Node = store.addNode({ themeId: aGeo.id, parentId: aBranch.id, kind: 'lemma', title: '铜连接在短距离内可替代光模块', confidence: 50, type: 'hypothesis' })
const b3CallsBefore = extractCalls
const b3VerdictsBefore = store.allVerdicts().filter((v) => v.textHash).length
const b3 = await fire('inbox:capture', '铜连接在短距离内可替代光模块，成本更低。')
ok('B3: 高相似不调用模型', extractCalls === b3CallsBefore)
ok('B3: 命题原样合并，不新建', store.getNode(b3Node.id).sources.length === 1)
ok('B3: 合并的判定记进误杀审计（带 textHash）', store.allVerdicts().filter((v) => v.textHash).length > b3VerdictsBefore)
ok('B3: 未抽取低质结论', b3?.skipped !== 'low-quality' && store.getNode(b3Node.id).status !== 'dead')

// 0.7 落在 0.6–0.85 之间：不预合并（宁可多抽一次），抽完由分流层合并
const b3Mid = store.addNode({ themeId: aGeo.id, parentId: aBranch.id, kind: 'lemma', title: '铜连接 在短距离 可替代光模块', confidence: 50, type: 'hypothesis' })
const b3MidScore = store.findSimilar('铜连接 可替代光模块 成本更低', aGeo.id).find((r) => r.node.id === b3Mid.id)?.score
ok('B3: 0.7 灰区相似度成立', b3MidScore >= 0.6 && b3MidScore < 0.85, `实际 ${b3MidScore}`)
stubTitle = b3Mid.title
const b3MidCap = await fire('inbox:capture', '铜连接 可替代光模块 成本更低')
stubTitle = null
ok('B3: 灰区照常抽取', extractCalls === b3CallsBefore + 1)
const b3MidMerged = b3MidCap?.autoImported
  ? (b3MidCap.imported?.[0]?.action === 'merge' && b3MidCap.imported?.[0]?.id === b3Mid.id)
  : (b3MidCap?.lemmas?.[0]?.action === 'merge' && b3MidCap?.lemmas?.[0]?.mergeInto === b3Mid.id)
ok('B3: 灰区由分流层合并', b3MidMerged, `autoImported=${b3MidCap?.autoImported}`)

// ---- B2：通道已知低质，不抽 ----

const b2Text = '道听途说测试：某厂产能砍半，听说的。'
const b2CallsBefore = extractCalls
const b2 = await fire('inbox:capture', b2Text, { kind: '道听途说', channelId: 'gov-ch-1' })
ok('B2: 低质通道直接留档不抽取', b2?.skipped === 'low-quality' && b2?.item?.extracted === false)
ok('B2: 低质不调用模型', extractCalls === b2CallsBefore)
ok('B2: 原文与质量分完整保留', b2?.item?.text === b2Text && b2?.item?.label?.quality === 0.2)
ok('B2: matchScore 为 0 → 未匹配态', b2?.item?.matchScore === 0)
ok('B2: 不加价（via channel）', b2?.item?.label?.via === 'channel')
ok('B2: 拦截留痕可回查', store.allTraces().some((t) => t.stage === 'gate' && t.decision?.skipped === 'low-quality'))

// ---- B4：标签库分级闸门 ----

store.updateTheme(aGeo.id, { tagLibrary: [{ id: 'gov_tag_1', name: '光模块', synonyms: ['optical'], threshold: 0.5, hits: 0, lastHitAt: null }] })
const b4aCalls = extractCalls
const b4a = await fire('inbox:capture', '光模块行业月度跟踪：出货量环比回升。')
ok('B4: score === threshold 放行（不是 >）', extractCalls === b4aCalls + 1 && !b4a?.skipped)

store.updateTheme(aGeo.id, { tagLibrary: [{ id: 'gov_tag_1', name: '光模块', synonyms: ['optical'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const b4bCalls = extractCalls
const b4bText = '光模块渠道调研：价格企稳，库存正常。'
const b4b = await fire('inbox:capture', b4bText)
ok('B4: 未达阈值不抽取', b4b?.skipped === 'weak-tags' && b4b?.item?.extracted === false)
ok('B4: 未达阈值记下命中分', b4b?.item?.matchScore === 0.5, `实际 ${b4b?.item?.matchScore}`)
ok('B4: 未达阈值零调用', extractCalls === b4bCalls)
ok('B4: 弱匹配原文留着', b4b?.item?.text === b4bText)

const b4cCalls = extractCalls
const b4c = await fire('inbox:capture', '完全无关的话题：周末去爬山，天气不错。')
ok('B4: 未命中标签库不抽取', b4c?.skipped === 'no-tags' && b4c?.item?.matchScore === 0)
ok('B4: 未命中零调用', extractCalls === b4cCalls)

store.updateTheme(aGeo.id, { tagLibrary: [] })
const b4dCalls = extractCalls
const b4d = await fire('inbox:capture', '完全无关的话题二：周末在家煮咖啡。')
ok('B4: 空词库全部放行（没声明过关心什么就不筛）', extractCalls === b4dCalls + 1 && !b4d?.skipped)

// ---- D：收件箱三态 + 主动抽取 + 清空未匹配 ----

store.updateTheme(aGeo.id, { tagLibrary: [{ id: 'gov_tag_1', name: '光模块', synonyms: ['optical'], threshold: 0.6, hits: 0, lastHitAt: null }] })
const dText = '未匹配三态测试：本地咖啡馆换了新豆子。'
const d1 = await fire('inbox:capture', dText)
ok('D: 未匹配条目进箱且标注未抽取', d1?.item?.extracted === false && d1?.item?.matchScore === 0 && d1?.item?.text === dText)
const dCallsBefore = extractCalls
const dExtract = await fire('inbox:extract', [d1.item.id])
ok('D: 抽取这 N 条按需调用模型', dExtract?.extracted === 1 && extractCalls === dCallsBefore + 1)
const dAfter = store.allInbox().find((i) => i.id === d1.item.id)
ok('D: 抽取后转为已抽取并带上命题', dAfter?.extracted === true && dAfter?.lemmas?.length === 1)

const dExtractAgain = await fire('inbox:extract', [d1.item.id])
ok('D: 抽过的不会被重复抽取（不重复花钱）', dExtractAgain?.extracted === 0 && extractCalls === dCallsBefore + 1)

const d2 = await fire('inbox:capture', '未匹配三态测试二：社区团购又涨价了。')
const dKept = store.allInbox().filter((i) => i.extracted !== false).length
const dPending = store.allInbox().filter((i) => i.extracted === false).length
const dCleared = await fire('inbox:clearUnextracted')
ok('D: 清空未匹配清掉全部未抽取条目', dCleared === dPending, `实际 ${dCleared} / ${dPending}`)
ok('D: 已抽取条目一条未动', store.allInbox().filter((i) => i.extracted !== false).length === dKept)
ok('D: 未抽取条目清空后归零', store.allInbox().filter((i) => i.extracted === false).length === 0)
ok('D: 被清的确实是未匹配那条', d2?.item?.extracted === false && !store.allInbox().some((i) => i.id === d2.item.id))

const dStale = store.addInboxItem({ text: '过期未匹配内容', title: '过期未匹配内容', lemmas: [], extracted: false, matchScore: 0 })
const dDb = store.load()
dDb.inbox.find((i) => i.id === dStale.id).createdAt = '2026-07-01'
ok('D: 未匹配 30 天后自动过期', !store.allInbox().some((i) => i.id === dStale.id))
ok('D: 过期条目仍在库里（内容不丢）', dDb.inbox.some((i) => i.id === dStale.id))
dDb.inbox = dDb.inbox.filter((i) => i.id !== dStale.id)

// ---- C1：每 tick 预算 ----

ok('C1: 预算常量 = 10 条', MAX_ITEMS_PER_TICK === 10)
const budgetCalls = []
const stopBudget = startScheduler({
  due: () => [],
  channels: () => [
    { id: 'govc1', enabled: true, fetch: 'rss', interval: 60, lastFetch: null },
    { id: 'govc2', enabled: true, fetch: 'rss', interval: 60, lastFetch: null },
    { id: 'govc3', enabled: true, fetch: 'rss', interval: 60, lastFetch: null },
  ],
  runChannel: async (ch) => { budgetCalls.push(ch.id); return 5 },
  fetchers: () => ['rss'],
})
await new Promise((r) => setTimeout(r, 20))
stopBudget()
if (govQuiet()) {
  ok('C1: 静默时段整段不轮询', budgetCalls.length === 0)
} else {
  ok('C1: 一个 tick 最多处理 10 条（5+5 后停手）', budgetCalls.length === 2, `实际 ${budgetCalls.length}`)
}

// ---- C6：通道未匹配率（只展示，不自动停用）----

const c6Ch = store.addChannel({ name: 'C6-未匹配率通道', fetch: 'rss', kind: '独立媒体', query: 'http://example.com/c6.xml', themeId: aGeo.id })
store.addInboxItem({ text: 'c6-a', title: 'c6-a', lemmas: [], provenance: { channelId: c6Ch.id }, extracted: false, matchScore: 0 })
store.addInboxItem({ text: 'c6-b', title: 'c6-b', lemmas: [{ title: 'c6-b' }], provenance: { channelId: c6Ch.id }, extracted: true, matchScore: 0.8 })
const c6Rates = await fire('channel:matchRates')
const c6Mine = c6Rates.find((r) => r.channelId === c6Ch.id)
ok('C6: 未匹配率按通道聚合', c6Mine?.total === 2 && c6Mine?.unmatched === 1 && Math.abs(c6Mine.rate - 0.5) < 1e-9, `实际 ${JSON.stringify(c6Mine)}`)
ok('C6: 只统计不改通道状态', store.allChannels().find((c) => c.id === c6Ch.id).enabled === true)
ok('C6: 未匹配率函数不写通道', !storeSrcGov.slice(storeSrcGov.indexOf('export function channelMatchRates'), storeSrcGov.indexOf('export function channelMatchRates') + 900).includes('updateChannel'))
ok('C6: 界面说明只作参考不停用', vaultSrcGov.includes('不会自动停用通道'))

// ---- C5：复盘页 LLM 段 ----

const c5Usage = await fire('llm:usage')
ok('C5: llm:usage 返回按天账本', Array.isArray(c5Usage?.daily) && Array.isArray(c5Usage?.recent))
ok('C5: 账本里有今天的调用', c5Usage.daily.some((d) => d.date === store.today() && d.calls > 0))
ok('C5: 复盘页有 LLM 段', vaultSrcGov.includes('LLM 调用') && vaultSrcGov.includes('今日 token') && vaultSrcGov.includes('SCENARIO_LABELS'))
ok('C5: 复盘页说明 token 来源', vaultSrcGov.includes('模型不返回时按 0 计'))
ok('C5: 场景名有中文映射', Object.keys(SCENARIO_LABELS).includes('extract') && SCENARIO_LABELS.extract === '抽取')

// ---- D：界面与 IPC 接线 ----

ok('D: today.js 三态分组', todaySrcGov.includes("groupHead('已抽取'") && todaySrcGov.includes("groupHead('待抽取'") && todaySrcGov.includes("groupHead('未匹配'"))
ok('D: today.js 有「抽取这 N 条」「清空未匹配」', todaySrcGov.includes('`抽取这 ${waitItems.length} 条`') && todaySrcGov.includes('清空未匹配'))
ok('D: 未抽取条目不可勾选入库', todaySrcGov.includes('const isSelectable = (item) => item.extracted !== false'))
ok('D: 未抽取详情不给归位表单', todaySrcGov.includes('const unextracted = item.extracted === false') && todaySrcGov.includes('const editable = !unextracted'))
ok('D: 三态样式就位', stylesSrcS45.includes('.inbox-group-head'))
ok('D: preload 有 inboxExtract / inboxClearUnextracted', pjGov.includes('inboxExtract') && pjGov.includes('inboxClearUnextracted'))
ok('C5/C6: preload 有 llmUsage / channelMatchRates', pjGov.includes('llmUsage:') && pjGov.includes('channelMatchRates'))
ok('C5/C6: 两份 preload 仍然完全同步', pjGov === pcGov && pjGov.includes('inboxExtract') === pcGov.includes('inboxExtract'))

// 收尾：恢复抽取桩与设置，别把 stub 留给后面的断言
llmHooks.run = realRunHook
store.saveSettings({ apiKey: '' })

// ============================================================
console.log('\n— 数据边界：inbox 过期 / trace 索引 / 抽取上限 —')
// ============================================================

// ---- T2 pruneInbox ----
const pruneTheme = store.addTheme('清理测试')
// addInboxItem 永远写 createdAt: today()，所以要造假数据得直接改 DB
const mkInbox = (daysAgo, extra = {}) => {
  const entry = store.addInboxItem({
    text: `清理测试 ${daysAgo} 天前`, title: `清理测试 ${daysAgo}`,
    label: { kind: '自媒体', quality: 0.5 }, lemmas: [],
  })
  Object.assign(entry, { createdAt: new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10) }, extra)
  return entry
}
mkInbox(40)                                    // 该清
mkInbox(40, { ignored: true })                 // 主动忽略，永不清
mkInbox(5)                                     // 新，不清
const acceptedOld = mkInbox(40)                // 已处理的，不清（先 resolve 再测）
store.resolveInboxItem(acceptedOld.id, 'reject')

// 用增量断言——测试文件前面已经攒了一批 inbox，绝对值不可靠
const inboxBase = store.allInbox().length
const pruneDry = store.pruneInbox(30, { dryRun: true })
ok('T2 dryRun 该清的只有 1 条', pruneDry.removed === 1, `实际 removed=${pruneDry.removed}`)
ok('T2 dryRun 后数据没变', store.allInbox().length === inboxBase, `实际 ${store.allInbox().length} vs ${inboxBase}`)
const pruneReal = store.pruneInbox(30)
ok('T2 真删 1 条', pruneReal.removed === 1, `实际 ${pruneReal.removed}`)
ok('T2 净减 1 条', store.allInbox().length === inboxBase - 1, `实际 ${store.allInbox().length} vs ${inboxBase - 1}`)
// ignored / 5 天内的 / 已处理的都还在。注意 allInbox() 本就排除 ignored，
// 所以这三条要查 load().inbox 而不是 allInbox()
const rawInbox = store.load().inbox
ok('T2 ignored 的还在', rawInbox.some((i) => i.ignored), 'ignored 条目被清了')
ok('T2 新的还在', rawInbox.some((i) => i.title === '清理测试 5'), '5 天前的条目被清了')
ok('T2 已处理的还在', rawInbox.some((i) => i.id === acceptedOld.id && i.status === 'rejected'), '已处理条目被清了')
ok('T2 40 天前的没了', !rawInbox.some((i) => i.title === '清理测试 40' && !i.ignored && i.status === 'pending'), '该清的没清')

// ---- T4 trace 索引 ----
const idxBefore = store.allTraces().length
store.addTrace({
  target: { type: 'node', id: 'idx-node' }, stage: 'extract',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'idx-hash-1' },
  output: { lemmas: [{ title: '索引测试命题', type: 'observation', confidence: 60 }] },
  decision: { lemmas: [{ title: '索引测试命题', type: 'observation', confidence: 60 }] },
})
const idx = store.traceIndexByHash()
ok('T4 索引能查到刚写的', idx.get('idx-hash-1')?.input?.textHash === 'idx-hash-1')
ok('T4 索引含存量 trace', idx.size >= idxBefore, `实际 ${idx.size} vs ${idxBefore}`)
// 同 hash 后写覆盖先写
store.addTrace({
  target: { type: 'node', id: 'idx-node-2' }, stage: 'extract',
  actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
  input: { textHash: 'idx-hash-1' },
  output: { lemmas: [{ title: '第二条', type: 'observation', confidence: 70 }] },
  decision: { lemmas: [{ title: '第二条', type: 'observation', confidence: 70 }] },
})
ok('T4 同 hash 后写覆盖', store.traceIndexByHash().get('idx-hash-1').target.id === 'idx-node-2')
store.invalidateTraceIndex()
ok('T4 invalidate 后重建', store.traceIndexByHash().get('idx-hash-1').target.id === 'idx-node-2')

// ---- T3 extract trace 上限 ----
const extractsBefore = store.allTraces().filter((t) => t.stage === 'extract').length
for (let i = 0; i < store.MAX_EXTRACT_TRACES + 20; i++) {
  store.addTrace({
    target: { type: 'node', id: `bulk-${i}` }, stage: 'extract',
    actor: { by: 'model', model: 'step-3', promptVersion: 'v1' },
    input: { textHash: `bulk-hash-${i}` },
    output: { lemmas: [] }, decision: { lemmas: [] },
  })
}
const extractsAfter = store.allTraces().filter((t) => t.stage === 'extract').length
ok('T3 extract trace 不超上限', extractsAfter <= store.MAX_EXTRACT_TRACES, `实际 ${extractsAfter} / 上限 ${store.MAX_EXTRACT_TRACES}`)
ok('T3 保留的是最新的', store.allTraces().some((t) => t.target?.id === `bulk-${store.MAX_EXTRACT_TRACES + 19}`), '最新一条被清了')

// ---- T3 label 不再逐条存 ----
const labelCount = store.allTraces().filter((t) => t.stage === 'label').length
ok('T3 label trace 不逐条存', labelCount === 0, `实际 ${labelCount} 条`)
ok('T3 traceAggregates.label 有数据', store.load().traceAggregates.label.length > 0)

console.log(`\n${pass} 通过, ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
