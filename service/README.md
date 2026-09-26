# Meridian Service

桌面 App 之外的第二种运行形态：把 `src/main/` 的账本与 IPC handler 原样搬到
一个 HTTP 服务里（`server.mjs`），供局域网内可信设备调用。业务逻辑零 fork——
跑的就是桌面版用的同一个 handler。

## 目录

| 文件 | 说明 |
|---|---|
| `server.mjs` | HTTP 服务：`POST /api/:channel`，`GET /healthz`（免认证探活） |
| `shim.mjs` | Electron 替身（`globalThis.__electron`），必须在业务模块之前 import |
| `db-schema.mjs` | SQLite 契约：`SCHEMA_VERSION` / `initSchema` / `TABLES` / `dbToRows` / `rowsToDb` |
| `migrate-json-to-sqlite.mjs` | 一次性迁移：`meridian.json` → `meridian.sqlite`（见下） |
| `config.example.json` | 配置模板；真实 `config.json` 不进 git |
| `ops/meridian-service.service` | systemd user unit |
| `ops/backup.sh` | 账本备份 |
| `ops/restore.sh` | 从备份恢复 |
| `ops/watchdog.sh` | 健康检查 + 失败重启 |

## 运行

```bash
# 1. 配置
cp service/config.example.json service/config.json
# token 用强随机值：
openssl rand -hex 32   # 填进 config.json 的 token 字段

# 2. 数据目录（默认与桌面 App 同一位置 /home/hatch/.config/脉络）
export MERIDIAN_DATA_DIR=/home/hatch/.config/脉络

# 3. 启动
node service/server.mjs
# 健康检查（免认证）
curl http://127.0.0.1:3791/healthz
```

`config.json` 字段：`host`（监听地址，默认 `127.0.0.1`）、`port`（默认 `3791`）、
`token`（除 `/healthz` 外所有接口要求 `Authorization: Bearer <token>`）。
环境变量 `HOST` / `PORT` / `MERIDIAN_TOKEN` 可覆盖配置文件。

## systemd 部署

```bash
# 1. 把 MERIDIAN_HOME 占位符替换为仓库实际检出路径
sed -i 's|/opt/meridian|/home/hatch/workspace/meridian|' service/ops/meridian-service.service

# 2. 安装 user unit
mkdir -p ~/.config/systemd/user
cp service/ops/meridian-service.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now meridian-service
systemctl --user status meridian-service
```

`MERIDIAN_DATA_DIR` 在 unit 里默认为 `%h/.config/脉络`（即真实账本），
如需指向别处请一并修改。

## 备份 / 恢复 / 看门狗

```bash
# 备份：sqlite 全量 dump + 读数/原文层打包，只保留最近 30 天
service/ops/backup.sh --data-dir "$MERIDIAN_DATA_DIR" --out-dir service/backups
# 恢复（先 dry-run 校验）
service/ops/restore.sh --backup service/backups/meridian-files-<ts>.tar.gz \
  --data-dir "$MERIDIAN_DATA_DIR" --dry-run
# 真恢复：停服务 → 拷入 → 起服务（目标是真实账本时需交互确认或 --yes）
service/ops/restore.sh --backup service/backups/meridian-files-<ts>.tar.gz \
  --data-dir "$MERIDIAN_DATA_DIR"

# 看门狗：建议 cron 或 systemd timer 每 1–5 分钟跑一次
*/2 * * * * /home/hatch/workspace/meridian/service/ops/watchdog.sh
```

看门狗用 `node` 一行解析 `service/config.json` 取 host/port（无 jq 依赖），
`curl /healthz` 失败时：第一次连续失败重启服务，之后连续失败只记日志告警、
不再重复重启；恢复后计数清零。日志在 `service/ops/watchdog.log`。

## 迁移脚本（JSON → SQLite）

```bash
# 永远先在拷贝上验证，绝不在真实账本上试运行！
cp -r /home/hatch/.config/脉络 /tmp/ledger-copy
node service/migrate-json-to-sqlite.mjs --data-dir /tmp/ledger-copy
# 目标 sqlite 已存在时覆盖
node service/migrate-json-to-sqlite.mjs --data-dir /tmp/ledger-copy --overwrite
```

流程：读 `meridian.json` → 跑 app 自己的 `migrate(db)` 做 v1→v4 归一化 →
`dbToRows()` 得 `{表:[行]}` → `initSchema()` 建 `<data-dir>/meridian.sqlite` →
事务写入 → 逐表对行数（源 JSON 数组长度 vs 写入行数）→
对 `readings.jsonl` 跑 `ReadingStore.verify()` 做哈希链校验。全部通过打印
`PASS`，任一失败以非 0 退出码 abort。

> ⚠️ 警告：`--data-dir` 指向真实账本（`/home/hatch/.config/脉络`）时脚本
> 直接拒绝运行；执意操作必须加 `--i-know-what-im-doing`，后果自负。
> 迁移前请先用 `backup.sh` 备份。

## 安全说明

- **Tailscale 内网 only**：`host` 保持 `127.0.0.1`，或绑定 Tailscale 网卡 IP；
  不要把服务暴露到公网（`0.0.0.0`）。
- **token**：`service/config.json` 含 Bearer token，已加入 `.gitignore`，
  绝不提交、绝不进备份包。token 泄露后立即重新生成并重启服务。
- **备份内容**：`backup.sh` 只备份 `meridian.sqlite` 的 dump 与
  `readings.jsonl` / `readings-index.json` / `raw.jsonl`，不含 token。
- **恢复**：`restore.sh` 会覆盖目标目录数据，恢复前自动把现场
  `meridian.sqlite` 另存为 `meridian.sqlite.pre-restore-<ts>`。
