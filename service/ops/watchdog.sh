#!/usr/bin/env bash
# meridian-service 看门狗：探活 /healthz，失败则重启服务并记日志。
# 用法: watchdog.sh [--config <service/config.json 路径>]
# 建议用 cron 或 systemd timer 每 1–5 分钟跑一次。
#
# 重启策略（防死循环）：
#   第 1 次连续失败 → systemctl --user restart meridian-service；
#   之后连续失败只写日志告警，不再重复重启；恢复后计数清零。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$SERVICE_DIR/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    -h|--help)
      echo "用法: $0 [--config <service/config.json>]"
      exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

LOG="$SCRIPT_DIR/watchdog.log"
# 连续失败计数放运行时目录：机器重启后清零是可接受的（见 README）。
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/meridian"
COUNT_FILE="$STATE_DIR/watchdog.failures"
mkdir -p "$STATE_DIR"

log() { echo "$(date '+%F %T') [watchdog] $*" >> "$LOG"; }

# 用 node 解析 config（不依赖 jq）；缺文件或解析失败则用默认端口。
read_cfg() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    try {
      const c = JSON.parse(fs.readFileSync(f, "utf8"));
      console.log(JSON.stringify({ host: c.host || "127.0.0.1", port: Number(c.port) || 3791 }));
    } catch (e) { console.log(JSON.stringify({ host: "127.0.0.1", port: 3791 })); }
  ' "$CONFIG"
}
CFG="$(read_cfg)"
HOST="$(node -p "JSON.parse(process.argv[1]).host" "$CFG")"
PORT="$(node -p "JSON.parse(process.argv[1]).port" "$CFG")"

count=0
[[ -f "$COUNT_FILE" ]] && count="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
[[ "$count" =~ ^[0-9]+$ ]] || count=0

if curl -sf --max-time 10 "http://$HOST:$PORT/healthz" -o /dev/null; then
  [[ "$count" -gt 0 ]] && log "服务恢复（此前连续失败 $count 次），计数清零"
  echo 0 > "$COUNT_FILE"
  exit 0
fi

count=$((count + 1))
echo "$count" > "$COUNT_FILE"

if [[ "$count" -eq 1 ]]; then
  log "健康检查失败（http://$HOST:$PORT/healthz），尝试重启 meridian-service"
  if systemctl --user restart meridian-service 2>>"$LOG"; then
    log "已发出重启指令"
  else
    log "systemctl --user restart 失败（见上），请人工检查"
  fi
else
  log "告警：连续失败 $count 次，不再重复重启，请人工介入"
fi

exit 1
