# Tailscale 反向同步（Phase 3-1）

## 为什么是反向

VM 无公网 IP、不接受任何入站；本环境的 Tailscale 是 client-only，
只能 VM → Mac 出站。所以同步方向是 **VM 主动轮询 Mac**：

```
Mac App（outbox 记录用户操作）
   │  GET /sync/outbox（VM 桥每 20s 轮询，经 Tailscale）
   ▼
VM sync-bridge ──POST /api/:channel──▶ VM meridian-service（127.0.0.1:3791）
   │  成功后 POST /sync/outbox/ack
   │  outbox 为空时：POST /api/sync:snapshot 取快照 → POST /sync/snapshot 推回 Mac
   ▼
Mac 原子写盘 → load() 重载 → 广播 db:changed → 渲染层刷新
```

单一真相仍在 VM。Mac 保持本地即时执行（UI 零改动），outbox 只是操作记录。

## Mac 端部署（用户在自己 Mac 上做）

1. 生成 token：`openssl rand -hex 32`
2. 在 Mac 的账本目录（`~/Library/Application Support/脉络/`）创建 `sync.config.json`：
   ```json
   { "host": "0.0.0.0", "port": 3821, "token": "<上一步生成的>" }
   ```
   示例见 `src/main/sync.config.example.json`（不要把真实 token 提交到 git）。
3. 重启 Meridian App。首次监听 0.0.0.0 时 macOS 防火墙会弹窗
   「是否允许传入网络连接」——点**允许**。这只在 Tailscale 内网可达，
   不暴露到公网。
4. 验证（在 Mac 终端）：`curl -H "Authorization: Bearer <token>" http://127.0.0.1:3821/sync/health`
   应返回 `{"ok":true,"outbox":0}`。

## VM 端部署

1. 复制配置：`cp service/sync-bridge.config.example.json ~/.local/share/meridian-sync-bridge/config.json`，
   填 `macToken`（与 Mac 端相同）、`serviceToken`（与 `service/config.json` 相同）、`macUrl`
   （Mac 的 tailnet 地址，`http://100.x.x.x:3821`，会变就改这里）。
   所有项也可用环境变量覆盖：`MERIDIAN_SYNC_MAC_URL`、`MERIDIAN_SYNC_MAC_TOKEN`、
   `MERIDIAN_SYNC_SERVICE_URL`、`MERIDIAN_SYNC_SERVICE_TOKEN`、`MERIDIAN_SYNC_INTERVAL_MS`。
2. 先手动跑一轮看日志：`node service/sync-bridge.mjs`（Ctrl-C 停）。
3. systemd（user）：`cp service/ops/meridian-sync-bridge.service ~/.config/systemd/user/`，
   按文件头注释改 `MERIDIAN_HOME`，然后
   `systemctl --user daemon-reload && systemctl --user enable --now meridian-sync-bridge`。
   日志：`journalctl --user -u meridian-sync-bridge -f`。

前置：VM 的 `meridian-service` 必须先跑起来（见 service/README.md），
且 VM 已加入 tailnet（`tailscale status` 显示 Connected）。

## 同步白名单（outbox 只收录这些 channel）

`inbox:resolve`（收件箱裁决，核心）、`inbox:prune`、`inbox:clear`、
`inbox:clearUnextracted`、`db:resolveConflict`、`db:settle`、`theme:rename`、`theme:update`。

刻意排除：一切 lemma 增删改（`db:addNode/updateNode/removeNode…`）、主题生命周期
（会自动建 lemma）、LLM 流水线（`inbox:capture/import/extract`，重放非确定）、
`reading:*`（ingestReadingCore/哈希链红区）、`settings:set`（密钥与机器绑定）、
`raw:*`、`io:import`、`agent:*`。完整理由见 `src/main/sync-outbox.js` 头部注释。

## 幂等与故障语义

- bridge 崩在 apply 与 ack 之间 → 下轮重放。白名单 channel 天然幂等
  （如 `inbox:resolve` 对非 pending 条目直接返回原条目）；“已应用”类错误
  视为成功并 ack，不中断。
- 真错误（handler 抛错/500）：当轮停下，**不 ack**，条目保留下轮重试，
  日志会大声报错。毒条目会每轮重试并打日志，需人工看 journal 后处理。
- Mac 不可达：指数退避（20s → 最高 5min），只打日志，不崩溃。
- 快照推送被 Mac 拒绝（409）：outbox 在拉取后又有新操作，或 Mac 已启用
  SQLite——下轮重试，不算失败。
- 快照应用时**保留 Mac 本机 settings**（密钥与机器绑定，永不同步）。

## 已知限制（本阶段）

- 秒级延迟（默认 20s 轮询），不是实时。
- Mac 关机 / Tailscale 掉线 → 同步暂停，两边账本不丢，上线后接着合。
- `readings.jsonl`（读数哈希链）不同步：红区，Mac 保留自己的读数账本。
- settings 永不同步（per-machine）。
- 快照是全量覆盖：Mac 本地未进 outbox 的改动会被 VM 快照覆盖——
  白名单之外的写操作在同步开启后应只在 VM 端做。

## 故障排查

| 现象 | 查什么 |
|---|---|
| bridge 日志 `拉取 outbox 失败` | Mac App 是否启动、sync.config.json 是否存在、token 是否一致、Mac tailnet IP 是否变了 |
| `401` | 两端 token 不一致 |
| 快照一直 `outbox-not-empty` | Mac 端持续有新操作，或 ack 失败——看 Mac 端 outbox.jsonl 行数是否在涨 |
| `mac-sqlite-enabled` | Mac 端出现过 meridian.sqlite（跑过迁移），本阶段不支持，联系处理 |
| Mac 防火墙反复弹窗 | 系统设置 → 网络 → 防火墙 → 选项，给 Meridian 永久允许 |
| bridge `service 调用失败` | meridian-service 是否在跑（`curl http://127.0.0.1:3791/healthz`） |
