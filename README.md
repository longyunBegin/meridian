# 脉络 Meridian

> 信息搬进来 → 归位到主题脉络 → 沿产业链传导 → 到期结算。
> 资产不是知识地图，是你的**校准曲线**。

本地优先、零构建、单依赖。`npm install && npm start`。

**状态：v0.6.2** · 平台：macOS（vibrancy / 全局热键依赖桌面端）· Node ≥ 18 · Electron 37。

---

## 运行

```bash
npm install
npm start          # 启动
npm test           # 引擎 + IPC + 改造测试（438 项）
npm run shoot      # 视觉回归截图 → /tmp/meridian-shots/
```

没装 Electron 也能跑 `npm test`——引擎测试把 `electron` 模块 stub 掉了，纯 Node 执行。

---

## 为什么是这个形态

从一次产品讨论里收敛出来的，两条第一性原理约束：

1. **用户不写，只搬。** 信息来自复制粘贴和数据源。所以产品的日常动作必须是「确认」，不是「输入」。
2. **用户按主题纵向拆。** 跟踪的是一条产业链（AI 从上游到下游），不是一个分类目录。

由此推出三个不可妥协的设计：

### 一、捕获是唯一入口

`⌘⇧V` 读剪贴板 → 收件箱 → 今日视图。任何地方选中的文本，一个热键就进了系统。
粘贴 URL 时自动抓取网页正文 + 推断通道（arxiv → 一手数据、公众号 → 自媒体…）。
没有「打开 App → 找到位置 → 打字」这个流程——那一步的摩擦决定生死。

### 二、产业链是有方向的树

普通知识工具画的是无向层级；产业链是**因果方向**的：上游 → 中游 → 下游。
所以每条边带一个**传导权重**。上游命题的置信度一变，下游按权重同向衰减：

```
光模块 85 (+15) ──0.6──▶ 云 CapEx 70 (+9) ──0.4──▶ 应用爆发 55 (+4)
```

深度衰减由复利自然产生，不需要额外机制。**这是「认知利息」唯一可计算的形态**——
系统能直接告诉你「上游 1 条证据变化，击穿了你 3 条下游判断」。

### 三、结算闭环

判断只有在被对答案之后才是资产。每条命题可设**结算日**；到期后系统问一句
「还想下这个注吗？」，答案进入校准曲线。

```
我说 70% 有把握的事 → 真的发生了几次？
```

这个数字不能伪造、不能搬运、只能靠时间积累。它是留存，也是产品唯一真正的护城河。

---

## 已实现的能力（v0.6）

| 能力 | 状态 |
|---|---|
| 一句话冷启动（输入产业链描述 → 骨架 + 通道 + 今日页） | ✅ 无 key 降级到静态模板 |
| 默认通道包（模板自带 RSS + Tavily + Grok，needsKey:false 启用） | ✅ |
| 不确定性闸门 + 自动归位（通过闸门的信息自动入库，例外才进收件箱） | ✅ |
| 可撤销自动归位（toast 提示，撤销退回收件箱不丢数据） | ✅ |
| 来源推导置信度（搬运品 by:source，置信度由来源质量推导） | ✅ 用户零操作 |
| 校准曲线只算 by:manual（来源推导/模型建议/传导分开统计） | ✅ 护城河不混 |
| 冲突静默化（标记不弹窗不强制裁决，今日页文字标签待着） | ✅ |
| 今日视图（开屏=待确认+到期结算+校准曲线，资产优先） | ✅ |
| 收件箱（全局待确认区，批量裁决，默认全选零思考入库） | ✅ |
| 收件箱内联输入框（textarea，回车送入打标，Shift+回车换行，拖拽支持） | ✅ |
| ⌘⇧V 粘贴 / URL 抓取 → 收件箱 | ✅ 粘贴 URL 自动抓取网页正文+推断通道 |
| 通道优先打标（通道 > 表 > 模型 > 关键词） | ✅ |
| provenance（平台、URL、抓取时间、检索提示词） | ✅ |
| 通道描述符（按内容类型选取数器：RSS / Tavily / Brave / Grok X Search） | ✅ |
| 留痕层 trace（模型介入完整记录，可复现/可对比/可结算） | ✅ |
| 模型建议校准曲线 + 打标器 vs 表分歧曲线 | ✅ |
| 主题脉络 + 传导权重 | ✅ |
| 模型生成骨架 + 可重生成 + 判断挂 stableId | ✅ 无 key 降级到静态模板 |
| 环节 scaffold（问题 / 指标 / 证伪信号） | ✅ 模板带版本号 |
| scaffold → 命题冷启动（结算日由更新频率推导） | ✅ |
| 到期结算 + 命题校准曲线 + 结算脉冲动画 | ✅ |
| 收件箱右栏常驻图（归位可视化，点节点改挂点） | ✅ |
| 边上直接拖传导权重（实时变，松开重传导） | ✅ |
| 图密度编码（空 scaffold 淡，密集判断实） | ✅ |
| 连续传导权重滑块（替代三档预设） | ✅ |
| 侧边栏四行（今日 / 脉络 / 库 / 设置） | ✅ |
| 来源打标器（table / jev / llm，可替换） | ✅ |
| 来源收敛度（同 claim 多源只累加不新建） | ✅ |
| 冲突检测与裁决 | ✅ |
| 误杀审计 + 过滤器校准曲线 | ✅ |
| 误杀闭环（verdict → promotedTo 回填，幂等） | ✅ v0.6.1 |
| route trace（归位留痕：gate/user，output vs decision） | ✅ v0.6.1 |
| 采集漏斗 intakeEvents（每次捕获一条记录，可追溯） | ✅ v0.6.1 |
| 撤销持久化（重启后仍可撤销自动归位） | ✅ v0.6.1 |
| 原文层通道元数据（url/platform/fetchedAt 落盘） | ✅ v0.6.1 |
| 复盘视图（漏斗五项 + 过滤器校准曲线 + 每日趋势） | ✅ v0.6.1 |
| 删除护栏（⌘⌫ 降级为入墓，整棵子树可恢复，清空墓碑区二次确认） | ✅ v0.6.2 |
| 到期结算定时器 + 原生通知 + Dock 角标（9–22 时，15 分钟 tick） | ✅ v0.6.2 |
| 误杀率按 gate 拆分（source/dedup/user 三栏） | ✅ v0.6.2 |
| 误杀归因到通道（verdict 带 channelId，按通道聚合查询） | ✅ v0.6.2 |
| 检视面板数值输入（传导权重/置信度可键入精确值） | ✅ v0.6.2 |
| 跨主题共同前提扫描 | ✅ |
| 命题 ↔ 标的映射（只做可见性，不做信号） | ✅ 合规红线 |
| 苏格拉底追问（AI 只追问边界，禁止输出陈述句） | ✅ |
| 订阅源适配器（RSS / Atom，定时拉取走捕获流水线） | ✅ |
| 冷库 / 墓碑区（置信度跌破 20 自动归墓） | ✅ |
| 树形 ↔ 因果图视图（默认图，归位比编辑频繁） | ✅ |
| 原文层（raw.jsonl，与判断层分离） | ✅ |
| API 密钥加密存储（AES-256-GCM，机器绑定） | ✅ |
| 本地 JSON 主权 + 导入导出 | ✅ |
| 引擎 + IPC + 改造测试 | ✅ 438 项 |

---

## 明确不做

| 不做 | 原因 |
|---|---|
| 多端同步、协作 | 违背本地优先，且会稀释锋利度 |
| 图谱可视化美化 | 连线是后期的事，树形列表先跑通 |
| 荐股 / 信号 / 目标价 | **合规红线**。只做「命题 ↔ 标的」的可见性映射 |
| 移动端 | 桌面端足够验证逻辑 |
| 社区 / 分享流 | 三年内禁止 |

---

## 数据

判断层是单个 JSON 文件，存在 `~/Library/Application Support/脉络/meridian.json`（设置页可一键打开数据目录）。
原文层是同目录下的 `raw.jsonl`（见下节）。随时导出 / 导入。**用户想走，带着全部资产走**——这不是情怀，是信任复利。

```jsonc
{
  "version": 3,
  "settings": {
    "baseUrl": "https://api.stepfun.com/v1",
    "apiKey": "",                 // 加密存储，格式 enc:v1:base64(iv|authTag|ciphertext)，机器绑定
    "model": "step-3.5-flash",
    "hotkey": "CommandOrControl+Shift+V",
    "labeler": "table",          // table | jev | llm —— 可替换的打标器
    "jevBaseUrl": "https://openrouter.ai/api/v1",
    "jevModel": "typesafe/jev-1.13",
    "jevKey": ""                  // 同样加密存储
  },
  "themes": [{ "id": "…", "name": "AI 产业链" }],
  "inbox": [{                     // 收件箱：全局待确认区，⌘⇧V 粘贴 / URL 抓取先进这里
    "id": "…",
    "text": "…",                  // 原文或抓取正文
    "at": "2026-09-20",
    "status": "pending",          // pending | processed | rejected
    "channelMeta": null,          // 通道元数据（platform / url / fetchedAt / searchPrompt）
    "preview": null               // 抽取预览（命题 + 挂点建议），确认后才入图谱
  }],
  "nodes": [{
    "id": "…",
    "stableId": "…",              // 稳定 ID：模型重生成时靠它挂判断，不随 id 变化丢失
    "themeId": "…",
    "parentId": "…",              // 产业链位置
    "kind": "branch | lemma",     // 环节 | 命题
    "by": "manual",               // manual | model | source —— 节点来源（source=搬运品，校准只算manual）
    "title": "1.6T 光模块 Q3 出货超预期",
    "type": "axiom | hypothesis | observation",
    "confidence": 85,
    "propagation": 0.6,           // 向子节点的传导权重
    "sources": [{                 // 来源数组：同一条 claim 可被多个独立源确认
      "kind": "券商研报",
      "label": "中信 2026-09-18",
      "quality": 0.8,             // 一律由 SOURCE_QUALITY 表裁决，不让模型直接给分
      "at": "2026-09-20",
      "rawId": "…",               // 指向原文层的一条依据（可空）
      "platform": null,           // provenance：平台（arxiv / 公众号 / twitter …）
      "url": null,                // provenance：原始 URL
      "fetchedAt": null,          // provenance：抓取时间
      "searchPrompt": null        // provenance：检索提示词
    }],
    "tags": ["半导体周期"],        // 跨主题共同前提的来源
    "tickers": [{                  // 标的映射：只做可见性，不做信号
      "code": "NVDA", "name": "英伟达", "relation": "受益 | 受损 | 中性"
    }],
    "status": "live",             // live | cold | dead —— 跌破 20 自动进墓碑区
    "settlement": { "date": "2026-12-31", "resolved": null, "correct": null },
    "scaffold": null,             // 环节挂的问题 / 指标 / 证伪信号
    "history": [{ "t": "2026-09-20", "confidence": 85, "by": "manual" }]
  }],
  "verdicts": [{                  // 被筛掉的裁决记录：留判断，不留原文
    "id": "…", "at": "2026-09-20",
    "gate": "extract | source | dedup | user",
    "reason": "low-quality",
    "summary": "某野号快讯…",      // 截断到 120 字
    "score": 0.24,
    "choice": "自媒体",
    "promotedTo": null             // 后来从别的源进了图谱 → 回填，记为一次误杀
  }],
  "conflicts": [{                 // 待裁决的命题冲突
    "id": "…", "a": "…", "b": "…",
    "note": "方向相反", "at": "2026-09-20",
    "resolved": null               // 'a' | 'b' | 'both'
  }],
  "feeds": [{                     // 订阅源：RSS / Atom
    "id": "…", "url": "https://…", "kind": "rss",
    "name": "…", "themeId": "…",
    "interval": 60,               // 拉取间隔（分钟，下限 15）
    "lastFetch": null, "lastCount": null,
    "enabled": true
  }],
  "traces": [{                    // 留痕：每一次模型介入的完整记录，独立集合不内联进 node
    "id": "…", "t": "2026-09-20",
    "target": { "type": "node|inbox|verdict|channel", "id": "…" },
    "stage": "label|extract|dedup|route|settle",
    "actor": { "by": "model|user|table|channel|propagation", "model": "step-3.5-flash", "promptVersion": "v1" },
    "input": { "rawId": "…", "textHash": "…", "textLen": 100, "channelMeta": null },
    "output": null,               // 模型原始返回，未加工
    "decision": null,             // 最终落库的值
    "reason": null                // 为什么取这个值而不是模型给的值
  }],
  "channels": [{                  // 通道描述符：按内容类型选取数器
    "id": "…", "name": "X · AI 产业链",
    "kind": "自媒体",             // 通道决定，不由模型猜
    "quality": 0.5,               // SOURCE_QUALITY 表裁决
    "fetch": "grok-x-search",     // manual | rss | rsshub | tavily | brave | grok-x-search | mcp
    "query": "1.6T optical module supply chain",
    "cadence": "日",
    "network": "direct",
    "themeId": "…", "enabled": true
  }]
}
```

**schema 只加不改**：新增字段不破坏旧导出文件。`migrate()` 在加载时把 v1/v2 升到 v3。
API 密钥用 AES-256-GCM 加密后落盘（密钥由 hostname + username + scrypt 派生，机器绑定），读取时解密返回明文。无 `enc:v1:` 前缀的旧值当作明文直接返回，向后兼容。

### 原文层

判断层记「我得出了什么结论」，原文层记「我当时读的是什么」。两者生命周期不同，所以拆成两个文件：

- 判断是要复利的资产，原文只是一次性依据——**清掉原文不该动到任何一条命题**。
- 用 JSONL 而不是 JSON：追加是 O(1)，进程崩了最坏丢半行，不必为加一条而重写整个文件。
- 同内容只存一份（sha256 去重）；不同 hash 天然就是独立来源，是「N 个独立源」的免费数据源。
- 被筛掉的内容**不进原文层**，只留 `verdicts` 里的裁决记录——存原文会把产品做成垃圾抽屉。

设置页可 prune（清无引用原文）或全清（原文没了，判断、置信度、校准曲线全部保留）。

---

## 打标器

整个产品里**唯一必须可替换的模块**：换打标器不触动抽取、存储和 UI。
按 `settings.labeler` 选择，三种实现：

| 模式 | 说明 |
|---|---|
| `table` | 关键词启发式 + `SOURCE_QUALITY` 表裁决。零依赖，永远可用（默认） |
| `jev` | Jev 的 `Choice` / `Score` / `Noul`（System One Model，只做判断不聊天） |
| `llm` | 前沿模型打标（有 key 但没接 Jev 时的过渡） |

**硬约束：质量分一律由 `SOURCE_QUALITY` 表裁决，打标器只负责选类型。**
否则换一个模型，整条校准曲线的基准就漂移了。失败一律静默降级到查表，不阻塞捕获。

```js
// src/main/store.js
export const SOURCE_QUALITY = [
  ['财报 / 公告', 0.95],
  ['一手数据', 0.9],
  ['券商研报', 0.8],
  ['独立媒体', 0.65],
  ['自媒体', 0.5],
  ['群聊转发', 0.35],
  ['道听途说', 0.2],
]
```

---

## 操作

| 键 | 作用 |
|---|---|
| `⌘⇧V` | 粘贴到收件箱（全局，读剪贴板 → 收件箱 → 今日视图） |
| `⏎` | 新建兄弟节点 |
| `Tab` | 向下拆一层（子命题） |
| `↑` `↓` | 移动选择 |
| `⌘⌫` | 删除节点及子树 |
| `⌘1` | 今日视图（开屏默认：待确认 + 到期结算 + 校准曲线） |
| `⌘2` | 脉络工作区（树形 ↔ 因果图，默认图） |
| `⌘3` | 库（冷库 / 墓碑区 / 误杀审计 / 冲突 / 数据源） |
| `⌘,` | 设置（含导出 / 导入） |

脉络视图支持树形 ↔ 因果图两种形态切换，共用主题、选中项和检视面板。图视图支持边上直接拖传导权重、结算脉冲动画、密度编码（空 scaffold 淡 / 密集判断实）。

---

## 归位引擎

设置页填任意 OpenAI 兼容端点 + key。抽取 prompt 只做三件事：抽命题、定类型、猜挂点。
**没有 key 也能用**——收件箱会把整段原文存成一条观测命题，降级路径永远存在。

捕获流水线：**打标 → 抽取 → 去重 → 冲突检测 → 分拣**，每一步失败都单独降级，不让整条链路断掉。
粘贴 URL 时在流水线最前面加一步：**抓取网页正文 + 域名推断通道**，通道元数据优先于打标表。

核心 prompt 约束（`src/main/extract.js`）：只抽原文确实陈述的内容，禁止补充外部知识，
禁止评价，`type` 三选一，置信度只依据信息可靠程度设定，不乐观。

---

## 结构

```
src/
  main/                 主进程
    store.js            引擎：节点、传导、结算、校准、原文层、共同前提、标的、订阅源、收件箱、trace、通道
    extract.js          LLM 抽取（OpenAI 兼容）+ 苏格拉底追问 + 骨架生成
    labeler.js          来源打标（table / jev / llm，通道优先）
    fetcher.js          URL 抓取 + 通道推断（域名 → 一手/研报/自媒体…）
    crypto.js           API 密钥加密（AES-256-GCM，机器绑定）
    feeds.js            RSS / Atom 解析器（零依赖）
    templates.{js,json} 主题骨架模板（按版本维护）
    ipc.js              IPC 编排 + 捕获流水线 + 收件箱 + 骨架 + trace + 通道
    main.js             窗口与全局热键（⌘⇧V → inbox:paste / inbox:focus）
    preload.js          上下文桥
  renderer/             渲染进程（无框架，原生 DOM）
    views/              今日 / 脉络 / 图 / 库 / 设置 / 检视 / 订阅
    lib/dom.js          极简 DOM 工具
    app.js              状态与路由
test/
  engine.test.mjs       引擎测试（传导 / 结算 / 校准 / 收敛 / 审计 / 前提 / 标的 / 订阅源 / 模板 / 原文层）
  ipc.test.mjs          IPC 层测试（收件箱链路 + 原文层）
  redesign.test.mjs     改造测试（收件箱 / 通道 / provenance / 骨架 / 加密 / URL / trace / 通道描述符 / 闸门 / 撤销 / 置信度分流）
  electron-stub.mjs     Electron 模块 stub
tools/shoot.mjs         视觉回归截图
docs/ROADMAP.md         迭代路线（按 JEV/Effort 排序）
```

---

## 下一步

完整路线见 `docs/ROADMAP.md`，按 JEV/Effort 排序，`<10` 的不碰。当前进度：

- ✅ **今日视图**（开屏=待确认+到期结算+校准曲线，资产优先）
- ✅ **一句话冷启动**（输入产业链描述 → 骨架 + 通道 + 今日页，2 分钟进场）
- ✅ **默认通道包**（模板自带 RSS + Tavily + Grok，needsKey:false 启用）
- ✅ **不确定性闸门 + 自动归位**（通过闸门的信息自动入库，例外才进收件箱）
- ✅ **可撤销自动归位**（toast 提示，撤销退回收件箱不丢数据）
- ✅ **来源推导置信度**（搬运品 by:source，置信度由来源质量推导，用户零操作）
- ✅ **校准曲线只算 by:manual**（来源推导/模型建议/传导分开统计，护城河不混）
- ✅ **冲突静默化**（标记不弹窗不强制裁决，今日页文字标签待着）
- ✅ **收件箱**（全局待确认区，⌘⇧V 粘贴 / URL 抓取，批量裁决零思考入库）
- ✅ **URL 抓取 + 通道推断**（域名 → 一手/研报/自媒体，通道优先于打标表）
- ✅ **provenance**（平台、URL、抓取时间、检索提示词）
- ✅ **模型生成骨架 + stableId**（重生成不丢判断，无 key 降级到静态模板）
- ✅ **图改造**（边拖权重 / 结算脉冲 / 密度编码 / 迷你图 / 连续滑块）
- ✅ **API 密钥加密存储**（AES-256-GCM，机器绑定）
- ✅ **来源打标器**（table / jev / llm，可替换的模块边界）
- ✅ **来源收敛度**（同 claim 被 N 个独立源确认时合并，保留来源计数）
- ✅ **scaffold → 命题冷启动**（结算日由更新频率推导）
- ✅ **跨主题共同前提扫描**（同 tag 出现在 ≥2 个主题即共享底层假设）
- ✅ **误杀审计 + 过滤器校准曲线**（被筛掉的后来进了图谱才算误杀）
- ✅ **命题 ↔ 标的映射**（只做可见性，不做信号——合规红线）
- ✅ **苏格拉底追问**（AI 只追问边界，禁止输出陈述句）
- ✅ **订阅源适配器**（RSS / Atom，定时拉取走捕获流水线）
- **禁止** 多端同步、协作分享、图谱美化

### 骨架的版本管理

`templates.json` 带 `version` 字段（当前 `2026-Q3`）。产业链每季度都在变，
换版本 = 新起一个主题，旧主题的图谱不动——这正是「范式 Fork」应该保护的东西。

---

## 元开发

这个产品的需求池、架构决策、Bug 跟踪，用它自己管。第一课就是：
**如果你不肯用自己的产品思考，用户凭什么。**
