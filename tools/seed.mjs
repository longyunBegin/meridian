import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const APPDATA = process.env.APPDATA || process.env.HOME
const DATA_DIR = join(APPDATA, 'meridian')
const DATA_FILE = join(DATA_DIR, 'meridian.json')

if (existsSync(DATA_FILE)) {
  console.log('数据已存在，跳过初始化：', DATA_FILE)
  process.exit(0)
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
const now = new Date().toISOString()
const today = new Date().toISOString().slice(0, 10)
const addDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)

const themeId = uid()
const nodes = []
const idMap = new Map()

function branch(path, scaffold = null, propagation = 0.6) {
  const parts = path.split('/').filter(Boolean)
  let parentId = null
  for (let i = 0; i < parts.length; i++) {
    const acc = parts.slice(0, i + 1).join('/')
    if (idMap.has(acc)) { parentId = idMap.get(acc); continue }
    const id = uid()
    nodes.push({
      id, themeId, parentId, kind: 'branch', title: parts[i].trim(),
      confidence: 50, propagation, status: 'live',
      sources: [], tags: [], tickers: [], scaffold: i === parts.length - 1 ? scaffold : null,
      history: [], createdAt: now,
    })
    idMap.set(acc, id)
    parentId = id
  }
  return parentId
}

function lemma(parentPath, title, type, confidence, opts = {}) {
  const parentId = idMap.get(parentPath)
  if (!parentId) { console.warn('parent not found:', parentPath); return }
  nodes.push({
    id: uid(), themeId, parentId, kind: 'lemma', title, type, confidence,
    status: opts.status || 'live',
    sources: opts.sources || [],
    tags: opts.tags || [],
    tickers: opts.tickers || [],
    scaffold: null,
    history: opts.propagated ? [{ at: now, by: 'propagation', from: confidence - 10, to: confidence, t: today }] : [],
    createdAt: now,
    settlement: opts.settlement || null,
  })
}

// ---- 模板骨架 ----
const TPL = JSON.parse(readFileSync(join(process.cwd(), 'src', 'main', 'templates.json'), 'utf8'))
const aiTpl = TPL.templates.find((t) => t.id === 'ai-chain')
const terminal = new Map()
for (const spec of aiTpl.nodes) {
  if (spec.scaffold) terminal.set(spec.path.split('/').filter(Boolean).join('/'), spec.scaffold)
}
for (const spec of aiTpl.nodes) {
  const path = spec.path.split('/').filter(Boolean).join('/')
  branch(path, terminal.get(path) || null)
}

// ---- 示例命题 ----
const src = (kind, label) => [{ kind, label, at: today, quality: 0.9 }]
const due = (days) => ({ date: addDays(days), resolved: null, correct: null })

lemma('前提层/算力经济学', 'token 单价连续两季未再下降', 'observation', 71, { sources: src('一手数据', '产业调研'), tags: ['算力成本'] })

lemma('前提层/资本开支周期', '北美云 CapEx 指引上调 18%', 'observation', 88, { sources: [...src('财报 / 公告', 'Meta Q3'), ...src('财报 / 公告', 'Google Q3')], tags: ['资本开支'], propagated: true, settlement: due(30) })
lemma('前提层/资本开支周期', '自研芯片占比提升将挤压外采份额', 'hypothesis', 62, { sources: src('券商研报', '中信证券'), tags: ['半导体周期'] })

lemma('上游·算力供给/GPU · 加速卡', '下一代产品量产推迟两个季度', 'observation', 79, { sources: [...src('一手数据', '供应链'), ...src('独立媒体', '彭博')], tags: ['产能'], propagated: true })

lemma('上游·算力供给/HBM · 存储', 'HBM 合约价 Q4 再涨 12%', 'observation', 84, { sources: [...src('一手数据', '合约跟踪'), ...src('券商研报', '海通')], tags: ['存储周期'] })
lemma('上游·算力供给/HBM · 存储', 'HBM 挤占通用 DRAM 产能', 'hypothesis', 66, { sources: src('券商研报', '中金'), tags: ['存储周期'] })

lemma('上游·算力供给/光模块 · 铜连接', '1.6T 光模块 Q3 出货 12 万只，超指引', 'observation', 85, { sources: [...src('一手数据', '产业链调研'), ...src('独立媒体', '财新')], tags: ['光模块'], propagated: true, tickers: [{ code: 'LITE', name: '中际旭创', relation: '受益' }] })
lemma('上游·算力供给/光模块 · 铜连接', '铜连接在 3 米内成本低 40%', 'hypothesis', 62, { sources: src('一手数据', '技术评测'), tags: ['铜连接'] })
lemma('上游·算力供给/光模块 · 铜连接', '800G 占比 55%，2027 让位 1.6T', 'hypothesis', 70, { sources: [...src('券商研报', '招商'), ...src('一手数据', '出货跟踪')], tags: ['光模块'], settlement: due(60) })

lemma('上游·算力供给/电力 · IDC · 散热', '某州并网队列排队 38 个月，创新高', 'observation', 88, { sources: [...src('一手数据', '并网数据'), ...src('独立媒体', '华尔街日报')], tags: ['能源成本'], propagated: true })
lemma('上游·算力供给/电力 · IDC · 散热', 'PPA 电价上行压制中小 IDC 扩张', 'hypothesis', 55, { sources: src('券商研报', '广发'), tags: ['能源成本'] })

lemma('中游·模型与云/云 · MaaS', 'GPU 租赁价格连续两月跌 15%', 'observation', 78, { sources: [...src('一手数据', '价格跟踪')], tags: ['算力成本'] })
lemma('中游·模型与云/云 · MaaS', '云 AI 收入增速低于 CapEx 增速', 'hypothesis', 65, { sources: [...src('财报 / 公告', '云厂商季报')], tags: ['资本开支'] })

lemma('下游·需求侧/Agent · 工作流', '企业 Agent 付费留存停滞', 'observation', 58, { sources: [...src('一手数据', '客户调研')], tags: ['需求侧'] })

lemma('交易层/标的映射', '利润沉淀在光模块而非 GPU', 'hypothesis', 72, { sources: [...src('券商研报', '中信'), ...src('一手数据', '毛利率分析')], tags: ['利润分配'], tickers: [{ code: 'LITE', name: '中际旭创', relation: '受益' }, { code: 'NVDA', name: '英伟达', relation: '受益' }] })

// ---- 写入 ----
const db = {
  version: 3,
  settings: {
    baseUrl: 'https://api.stepfun.com/v1',
    apiKey: '',
    model: 'step-3',
    hotkey: 'CommandOrControl+Shift+V',
    labeler: 'table',
    jevBaseUrl: 'https://openrouter.ai/api/v1',
    jevModel: 'typesafe/jev-1.13',
    jevKey: '',
  },
  themes: [{ id: themeId, name: 'AI 产业链', createdAt: now }],
  nodes,
  verdicts: [],
  conflicts: [],
  feeds: [],
}

mkdirSync(DATA_DIR, { recursive: true })
writeFileSync(DATA_FILE, JSON.stringify(db, null, 2))
console.log(`初始化完成：${nodes.length} 个节点写入 ${DATA_FILE}`)