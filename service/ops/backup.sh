#!/usr/bin/env bash
# meridian 账本备份。
# 用法: backup.sh --data-dir <账本目录> [--out-dir <备份目录>] [--keep-days 30]
#
# 产物（out-dir 下）：
#   backup-<ts>.sql               sqlite3 .dump 全量文本备份
#   meridian-files-<ts>.tar.gz    readings.jsonl / readings-index.json / raw.jsonl 打包
# 只保留最近 --keep-days 天的产物，过期自动删除。
#
# 注意：service/config.json 含 Bearer token，绝不进备份。

set -euo pipefail

DATA_DIR=""
OUT_DIR=""
KEEP_DAYS=30

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --keep-days) KEEP_DAYS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,11p' "$0"
      echo "用法: $0 --data-dir <账本目录> [--out-dir <备份目录>] [--keep-days 30]"
      exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(dirname "$SCRIPT_DIR")"

[[ -n "$DATA_DIR" ]] || { echo "缺少 --data-dir" >&2; exit 2; }
[[ -n "$OUT_DIR" ]] || OUT_DIR="$SERVICE_DIR/backups"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || { echo "--keep-days 必须是非负整数" >&2; exit 2; }

command -v sqlite3 >/dev/null || { echo "需要 sqlite3 命令" >&2; exit 1; }
[[ -f "$DATA_DIR/meridian.sqlite" ]] || { echo "找不到 $DATA_DIR/meridian.sqlite" >&2; exit 1; }

mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
DUMP="$OUT_DIR/backup-$TS.sql"
FILES_TAR="$OUT_DIR/meridian-files-$TS.tar.gz"

echo "[backup] sqlite dump → $DUMP"
sqlite3 "$DATA_DIR/meridian.sqlite" .dump > "$DUMP"

echo "[backup] 打包读数与原文层 → $FILES_TAR"
# 只打包存在的文件；-C 让包内是相对路径。
to_pack=()
for f in readings.jsonl readings-index.json raw.jsonl; do
  [[ -f "$DATA_DIR/$f" ]] && to_pack+=("$f")
done
if [[ ${#to_pack[@]} -eq 0 ]]; then
  echo "[backup] 警告: readings.jsonl/readings-index.json/raw.jsonl 都不存在，跳过打包" >&2
else
  tar -czf "$FILES_TAR" -C "$DATA_DIR" "${to_pack[@]}"
fi

echo "[backup] 清理 $KEEP_DAYS 天前的旧备份"
find "$OUT_DIR" -maxdepth 1 \( -name 'backup-*.sql' -o -name 'meridian-files-*.tar.gz' \) \
  -mtime "+$KEEP_DAYS" -print -delete || true

echo "[backup] 完成: $DUMP"
[[ -f "$FILES_TAR" ]] && echo "[backup] 完成: $FILES_TAR"
