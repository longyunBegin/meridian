# 交接：Meridian 设计结论 → 实施计划

> 来源：`session-7ce73dfd`（「产品设计」会话）与用户 2026-10-03 的设计讨论。
> 本文是**实施规格**：已定的方向 + 分阶段任务 + 验收标准 + 验证配方 + 红线。
> **2026-10-03 追加 §10：读者建模——图以外的数据结构**（用户要求：除图之外，有没有更适合"让陌生读者建模"的结构）。
> 仓库：`/Applications/longyun/project/meridian`，分支 **`feat/chain-event-ledger`（不要切分支、不要 push）**。

---

## 0. 一句话

在既有事件账本上补齐「**溯源保真**」与「**时间/外部数据两个变量**」两条主线，并把账本从"一个抽屉"拆成"上下文账本 + 全量审计"，同时给图谱做规模分级与语义着色。

## 1. 已定方向（不要再回头问，除非用户改口）

| # | 决定 |
|---|---|
| 1 | **时间轴＝日期轴**（人读），事件序号降为内部回放坐标 |
| 2 | **颜色＝语义**（支持/挑战/待复核/修订）+ **主题自定义分类色**（`theme.config.atomCategories`）；不按领域类型配色 |
| 3 | **读者界面不出现**"账本/事件/seq/哈希"字样；新增「标记缺口 → 今日收件箱待办」回流入口 |
| 4 | 账本跨端：**先 B 后 A**（B＝明确"本机账本"语义并改措辞；A＝事件同步、冲突进现有"待裁决冲突"视图） |
| 5 | 账本性能：**引入检查点/快照**；快照必须带事件引用或事件切片，**不能只存投影**（否则丢出处） |
| 6 | 存储：整库 JSON → 事件 JSONL 分离，**最后做** |
| 7 | 设计 demo 外壳：按项目真实三栏（`sidebar + mid + inspect`）重做，不引入顶栏 |

参考原型：`docs/design-proposal.html`（本会话产出，可交互；支持 `?view=reader|builder|inbox&scale=60|300|1000&theme=0|1&mode=dark`）。

---

## 2. P0：溯源保真与措辞（低风险，先做这批）

### P0-1 挂载路径必须带上 URL 与来源元数据
**问题**：`src/renderer/views/chain.js:3207` 挂载收件箱条目时只发
`evidenceRefs: [{ type:'inbox', id:item.id, title:item.title }, ...lemmaRefs]` —— **不带 URL**。
后果：① 读者 `reader.js:82` 找不到 `sourceUrl` / `type:'url'` ref → 没有「查看来源」；② `sourceRef:'inbox:<id>'` 是弱引用，而收件箱有 30 天 TTL（`store.js:294 INBOX_TTL_DAYS=30`、`pruneInbox`）→ 清理后溯源断链。

**改法**
- `src/renderer/views/chain.js` 挂载 payload：加
  `{ type:'url', id:item.provenance?.url, title:item.provenance?.sourceLabel || item.title }`（仅当 url 非空）
  以及 `sourceUrl / sourceLabel / sourcePublishedAt`（从 `item.provenance` 取）。
- `src/main/chain-projector.js` 挂载分支（`mountProjectedClaim`，约 931–1050 的 `evidencePayload` 构造处）：把上述字段写进 `evidence.appended` 的 payload。
- 原则：**账本不依赖收件箱条目存活**。

**验收**：挂载一条带 URL 的收件箱条目 → `chainEvents(themeId)` 中 `evidence.appended.payload` 含 `evidenceRefs:[{type:'url',…}]` 与 `sourceUrl`；读者出现「查看来源」；再模拟 `pruneInbox`/删除条目后，溯源仍可用。

### P0-2 写入侧协议校验 + 校验器收口
**问题**：engine 路径有 `validUrl`（`chain-projector.js:718-719`），**手工补证路径没有**（`chain-projector.js:623-625` 直接用 `input.url`）→ 脏 ref（如 `javascript:`）可进账本。显示层 `safeUrl` 有兜底，但账本应当干净。

**改法**：手工路径加同样的 http(s) 判定；`src/main/chain-events.js` 的 `evidence.appended` 校验里补一条"url 类 ref 必须是 http(s)"。

**验收**：写入 `javascript:alert(1)` 不产生 url ref；合法 URL 正常入库；`node test/chain-events.test.mjs` 全绿 + 新增断言。

### P0-3 投影携带出处
**问题**：投影的证据节点（`chain-projector.js:147-172`）只保留 `sourceRef/sourceKind/currentText/targetNodeIds`，**不带 `evidenceRefs`/URL**，任何从投影出发的 UI（图谱证据节点、检视器、未来快照）都拿不到出处。

**改法**：证据节点加 `evidenceRefs`（用已有的 `uniqueEvidenceRefs` 去重）。

**验收**：`chainProjection()` 的证据节点含 `evidenceRefs`；fixture/单测补断言。

### P0-4 措辞
- `✓ N 事件 · 校验通过` → `✓ N 条事件 · 链完整（内容真伪由你判断）`（立场与代码注释一致；有跨端时写"本机账本 N 条"）
- 账本列表 **14 类事件各一句人话模板**（用户不该看到 `claim.created`）：
  `claim.created`→"新增观点：X"、`correction.appended`→"修正：A → B"、`confidence.updated`→"强度 62% → 67%"、
  `evidence.appended`→"追加证据：…（来源 Y）"、`relation.declared`→"声明关系：X —支持→ Y"、`signal.reviewed`→"判决：确认/驳回"、
  `engine.recommendation.proposed`→"模型建议：…"、`settlement.recorded`→"结算：…"、`node.*`→"改名/失效/归档/恢复：…"。

### P0-5 溯源条固定 5 格（建设者，变更预览旁）
来源名称 · 来源链接 ↗ · 来源发布时间 · 抓取/摄入时间 · 适用时间。
数据已全部在 payload 里（`sourceLabel / evidenceRefs[url] / sourcePublishedAt / sourceFetchedAt / ingestedAt / applicability`）。

---

## 3. P1：结构与交互

1. **上下文账本 vs 全量账本**
   - 上下文：就地嵌在建设者变更预览旁，按 `currentAtomId / sourceRef / evidenceRefs / recommendationId` 过滤，只显示 3–8 条
   - 全量：留在审计五视图（冷库/墓碑区/误杀审计/复盘/待裁决冲突）——它是台账，不是工作面
2. **合成轴（读者首屏）**：强度线 × 外部数据点 × 确认/修订台阶，同一**日期轴**；y 轴按数据自适应。替换现在"事件序号滑杆 + 列表"的分裂口径。
3. **图谱 LOD**：<0.75 只画点（无字）；0.75–1.15 卡片无字；>1.15 出标题；**≥600 节点强制点阵**并在右上如实标注"已降级为网格布局"。
4. **邻域聚焦**：点节点点亮一跳邻域，其余降到 12%；点空白复原。
5. **读者回流**：底部「标记缺口」→ 生成收件箱待办（可撤销）。

---

## 4. P2：性能（回放与账本规模）

- **检查点**：每 200 条事件落 `{ seq, hash, 事件引用/切片 }`；`getChainProjectionAt` 从最近检查点起算。
  现状：`chain-projector.js:466-476` = `events.slice(0, seq)` 后**全量重投影**，拖时间轴是 O(n)/tick。
- **分段校验**：每批事件根哈希 → 支持增量校验；替代全量 `verifyChain`（保留全量作为兜底）。
- **账本列表虚拟化**（>200 条；现有 `LEDGER_PAGE_SIZE=40` 分页先够用）。
- ⚠️ 快照必须携带出处（见 P0-3），否则回放/快照出来的模型失去 URL。

---

## 5. P3：跨端口径（二选一，B 优先）

**现状（已核实）**：产生事件的 8 个命令（`chain:createNode` / `addEvidence` / `declareRelation` / `confirmSignal` / `reviewEngineRecommendation` / `reviewRelation` / `correctNode` / `archiveNode`）**都不在** `src/main/sync-outbox.js` 的 `OUTBOX_CHANNELS`；同步只走 VM→Mac 的节点/读数/收件箱快照（`db:upsertNode` 等）与 Mac→VM 的旧段链操作。**即：事件账本当前没有任何跨端语义**，两台设备各自追加、各自自洽。

- **方案 B（先做）**：明确"账本＝本机日志"。改徽标措辞；`settlement.recorded` 这类需全局共识的事件改走快照通道；设置/文档里说明。
- **方案 A（后做）**：新增 `chain:appendEvents`（幂等 event id + 期望 `prevHash`），对端校验后追加，冲突写入现有"待裁决冲突"视图。**URL/出处随事件走**——这是选 A 的硬理由：只同步节点快照的话，第二台设备上没有任何出处。

---

## 6. 红线（必须遵守）

- 分支 `feat/chain-event-ledger`，**不切分支、不 push**
- **不改事件类型名**（如 `claim.created`），只改用户可见文案
- 红区不碰：`SOURCE_QUALITY`、`calibration()`、`trustFor()`、**哈希链核心语义**、`ingestReadingCore`、`migrate()`、`importAll()`、agent 安全边界
- **不要删 `nodeType` 字段**：旧账本可读性依赖它；去领域化用"字段保留、语义降级（映射到角色）"
- **用户当前有未提交 WIP**：`src/renderer/lib/theme-network.js`、`src/renderer/lib/theme-network-render.js` —— 改动前先 `git diff` 看清，不要覆盖
- `commit` 前缀用 `refactor:`（用户既有约定）

---

## 7. 验证配方（本会话已跑通，直接复用）

```bash
# 语法
node --check <file>

# 单测：29 个文件逐个跑；updater.test.mjs 在 macOS 上恒红（hdiutil 恒可用），与本次无关
node test/chain-events.test.mjs && node test/chain-projector.test.mjs && node test/commands.test.mjs

# 渲染层 fixture（Chrome 路径按本机）
CHROMIUM_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:renderer-features
#  期望 4/5 绿：唯一红的是 Builder / append-only ledger —— 它的前提（未抽取来源在建设者队列渲染摄入卡）
#  已被 chain.js:867 的跨视图分工移除，需要单独立项

# dev 环境：1420（Vite，改前端走 HMR）+ 4445（WebDriver，可跑只读探针）
#  ⚠️ 改 src/main 必须重启 dev：launch_sidecar 在 debug 下直接跑仓库源码，node 进程启动时才加载模块
pkill -f 'src/tauri/backend[.]mjs'
MERIDIAN_DATA_DIR=/Users/longyun/meridian-dev-data MERIDIAN_MOCK_ENGINE=1 npx tauri dev -- --features webdriver

# 只读判定"后端是否已换新代码"：chainProjection() 的节点是否带 atomCategory 键
#   （新代码给每个投影节点都加这个键；无缓存，现算）
```

探针模板：`test/e2e/lib/driver.mjs` 的 `connect(4445)` + `browser.executeAsync(...)`。
写 dev 探针时注意：页面加载的是 HMR 版本 `/app.js?t=…`，**要拿 App 正在用的 `state` 必须 import 那个带 `?t=` 的实时 URL**，否则是另一个模块实例。

---

## 8. 现状事实清单（供实现者核对）

| 项 | 事实 |
|---|---|
| 事件类型 | 14 种：`claim.created` `inference.created` `node.created/renamed/invalidated/archived/restored` `evidence.appended` `relation.declared` `correction.appended` `confidence.updated` `signal.reviewed` `engine.recommendation.proposed` `settlement.recorded` |
| 账本存储 | `theme.eventChain = { version, events: [] }`，在 `meridian.json`（单文件，persist 整库重写）；版本不符拒绝读写（fail-closed） |
| 校验 | 单链 `prevHash` + 全量 `verifyChain`；**无快照/检查点/Merkle** |
| 回放 | `getChainProjectionAt(seq)` = slice + 全量重投影（O(n)） |
| 原文层 | `raw.jsonl`（append-only + 内容 sha 去重 + 仅清理无人引用 `referencedRawIds`）→ **这正是账本存储分离要照抄的形态** |
| 导出/导入 | `exportAll` 散开整个 db（**含 eventChain**）+ 导入前自动归档；有"不能删事件冒充旧数据"的测试 |
| 渲染层 fixture | Reader 26 项 / Vault / Product / Builder-atom-form(11) 全绿；Builder/append-only-ledger 长期红（前提已被移除） |
| 图谱布局 | O(n²)：实测 60→21ms、300→102ms、600→584ms、1000→1425ms、2000→4577ms（纯 JS，主线程） |
| 图谱窗口上限 | `GRAPH_FRAME_NODE_LIMIT=60` / `GRAPH_FRAME_EDGE_LIMIT=72`（`chain-ui-model.js`） |
| 检查点默认流 | 建设者的全量账本抽屉（`.cog-ledger-pane`，标题"追加式审计记录"）；读者侧无账本入口 |

---

## 9. 建议的落地顺序

1. **P0 全部**（溯源保真 + 措辞 + 投影带 refs）——一天量级，风险低，用户可见
2. **R1 论证大纲 + R2 小倍数网格**（纯前端、HMR 可验、对"建模"收益最大，详见 §10）
3. **P1-1 上下文账本 + P1-5 读者回流**（前端为主，HMR 可验）
4. **P1-2 合成轴** 与 **P1-3/4 图谱 LOD + 邻域**（视觉改动，按 `docs/design-proposal.html` 定稿）；同时做 **R6 矩阵 / R7 图的重新定位**（详见 §10）
5. **P2-1 检查点**（含出处）→ **P2-2 分段校验**
6. **P3-B 语义澄清**；有跨端需求时再做 **P3-A 事件同步**
7. **P2-3 存储分离（JSONL）** —— 收益最大、改动最深，放最后

每步完成后：`node --check` + 相关单测 + fixture 套件 + (改到界面时) dev 实测截图。

---

## 10. 读者建模：图以外的数据结构（2026-10-03 追加，用户明确要求）

### 10.0 结论：图的定位要改

图**不该是主题的主视图**，应退化为**局部工具**（看邻域 / 路径 / 意外发现）。判断"何时不该用图"的三条：

1. **密度高**（边 > 节点 × 1.5）→ 毛线球（实测 1000 节点 / 1350 边不可读，见 `docs/design-proposal.html?scale=1000`）
2. 读者要**比较**（谁强谁弱、谁涨谁跌）→ 图上读不出**量**
3. 读者要**读完** → 图**没有唯一阅读顺序**

→ 口径：**要"读完 / 比较 / 穷举"就用有序结构；要"找路径 / 看邻域"才用图。**
→ **>300 节点时图应自动切换为矩阵**（R6），主题级默认不再画全图（R7）。

### 10.1 候选结构（按对"建模"的收益排序）

| # | 结构 | 回答读者的什么 | 为什么胜出 | 数据来源 | 成本 | 任务号 |
|---|---|---|---|---|---|---|
| 1 | 强度-时间曲线（合成轴） | 结论怎么长起来的、哪次下修 | 时间是最强的组织维度 + 能表达因果时机 | `confidence.updated` + `evidence.appended` | 中 | 已并入 P1-2 |
| 2 | **论证大纲（可折叠树）** | 凭什么这么说、反例是什么 | **有唯一阅读顺序**，能读完；折叠＝按需展开 | `relation.declared` + 证据 + 观点 | 低 | **R1** |
| 3 | **小倍数网格（每原子 sparkline + 强度条 + 支持/挑战计数）** | 谁在涨、谁在跌、谁没动 | 图上做不了并排比较，网格可以 | `confidence.updated` 序列 + 计数 | 低-中 | **R2** |
| 4 | 双边清单（支持 ⟷ 挑战） | 争议点到底在哪 | 图里"反驳"只是一条红线，极易被忽略 | 证据的 rel / 立场 | 低 | R3 |
| 5 | 编年史（外部数据流 feed） | 何时来了什么、归到哪 | 线性、可滚动、可搜索＝"跟随时间"本身 | 账本事件 + 人话模板（P0-4） | 低 | R4 |
| 6 | 缺口清单 | 哪里还不知道 | 模型一半价值在"知道哪里不知道" | `reader-model` 已有统计 | 低 | R5 |
| 7 | 邻接矩阵（原子×证据 / 原子×原子）+ 重排序 | 哪些证据共同支撑哪些原子 | 边密时人眼在矩阵里找块状结构远快于看图 | `evidence.targetNodeIds` × 原子 | 中 | R6 |
| 8 | 分类聚合（分组条形 / treemap） | 重心在哪个分类 | 图里分类只是染色，聚合才能比较 | `theme.config.atomCategories` | 低-中 | R7 |
| 9 | 桑基 / 传导流（可选） | 信息流向哪 | 直观，但节点一多就乱；仅 ≤5 分类且 ≤15 原子时用 | 关系 + 证据 | 高 | 暂不做 |

**设计依据（定性引用，不引具体数字）**：
- node-link 与矩阵的可读性研究，倾向"**边越密，矩阵越有优势**"；
- Shneiderman：**overview first → zoom & filter → details on demand**（图只适合最后一层"按需细节"）；
- Tufte 的 **small multiples** ＝ 比较场景的最优解；
- 论证结构（claim / evidence）在学术上本来就是**树 / 大纲**，不是网。

### 10.2 读者首屏配方（是分工，不是二选一）

```
第 1 屏  一句话结论 + 当前强度 + 支持/挑战 + 合成轴          ← 时间 & 外部数据（主轴）
第 2 屏  论证大纲（结论→要点→证据，可折叠） | 双边清单        ← 建模的主结构
第 3 屏  小倍数网格 或 可排序表格（名称/分类/强度/趋势/证据数/最近证据/状态）
第 4 屏  编年史 + 缺口清单                                    ← 跟随时间 + 继续建模
—— 图退到"点开某个原子"之后（1–2 跳邻域）；>300 节点自动换矩阵
```

### 10.3 任务与验收

- **R1 论证大纲**（`src/renderer/views/reader.js` 新增区块）
  结构：结论行 → 要点（支持 / 挑战分组）→ 每条外部数据（来源名 + 时间 + 「查看来源」链接，展开看原文与 URL）
  验收：一个 20 原子的主题能自上而下读完；折叠状态只存内存；**不出现"事件 / seq / 哈希"字样**；渲染层 fixture 新增断言
- **R2 小倍数网格**
  每个原子：名称 + sparkline（由 `confidence.updated` 序列算）+ 当前强度条 + 支持/挑战计数 + 分类色点；点卡片＝聚焦并联动检视器
  验收：≥30 原子仍可扫读；位置可被 R6 直接替换；呼应原型里的 `node-badge` / `node-strength-bar`（原型有卡片形态，当前实现未接）
- **R3 双边清单**：支持一列 / 挑战一列 / 中间当前强度；点任一条跳到证据详情
- **R4 编年史**：一行一条外部数据（日期 · 来源 · 归入哪个原子 · 支持/挑战 · 强度变化）；**依赖 P0-4 的人话模板**
- **R5 缺口清单**：无任何证据的原子 / 待复核关系 / 已过期证据 / 跨主题未归位条目；每项可一键进收件箱或建设者
- **R6 矩阵视图**：行＝原子、列＝证据（或原子）；支持 / 挑战 / 推导着色；单元格点击定位；行/列按相似度**重排序**让块状结构显现；**>300 节点自动替代图**
- **R7 图的重新定位 + 分类聚合**：主题级默认不画全图；选中原子后才画 1–2 跳邻域；保留"两原子之间的路径"查询；分类聚合（分组条形）作为分类维度的比较视图

**依赖关系**：R1 / R2 / R3 **纯前端**，不需要后端改动（HMR 可验）；R4 依赖 P0-4 的人话模板；R5 依赖 `reader-model` 现成统计；R6 / R7 与图谱改造（P1-3/4）一起做。

### 10.4 可选：五视图并列对比 demo

把 `docs/design-proposal.html` 扩成**同一主题五视图并列**（论证大纲 / 矩阵 / 小倍数 / 编年史 / 图），用于视觉定稿；`?view=` 参数可切换单视图。用户已表示"让它来做"，建议先出这个对比页，再按结论定稿首屏配方。
