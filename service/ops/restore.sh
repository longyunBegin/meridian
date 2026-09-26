#!/usr/bin/env bash
# 从备份恢复 meridian 账本。
# 用法: restore.sh --backup <meridian-files-<ts>.tar.gz> --data-dir <账本目录>
#                  [--sql <backup-<ts>.sql>] [--dry-run] [--yes]
#
# 流程：解包到临时目录 → 用 sqlite3 重放 .dump 并做 integrity_check →
#   （非 dry-run）停服务 → 备份现场 → 拷入 → 起服务。
# --dry-run 只做校验，不写任何数据、不碰服务。
#
# --backup 默认找同目录下同时间戳的 backup-<ts>.sql；找不到可用 --sql 显式指定。

set -euo pipefail

BACKUP=""
DATA_DIR=""
SQL_DUMP=""
DRY_RUN=0
YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --sql) SQL_DUMP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help)
      sed -n '2,11p' "$0"
      echo "用法: $0 --backup <tar.gz> --data-dir <账本目录> [--sql <dump.sql>] [--dry-run] [--yes]"
      exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$BACKUP" ]] || { echo "缺少 --backup" >&2; exit 2; }
[[ -n "$DATA_DIR" ]] || { echo "缺少 --data-dir" >&2; exit 2; }
[[ -f "$BACKUP" ]] || { echo "备份文件不存在: $BACKUP" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "需要 sqlite3 命令" >&2; exit 1; }

# 同目录同时间戳的 backup-<ts>.sql
if [[ -z "$SQL_DUMP" ]]; then
  bdir="$(dirname "$BACKUP")"
  bname="$(basename "$BACKUP")"
  ts="${bname#meridian-files-}"
  ts="${ts%.tar.gz}"
  SQL_DUMP="$bdir/backup-$ts.sql"
fi
[[ -f "$SQL_DUMP" ]] || { echo "找不到 sqlite dump: $SQL_DUMP（可用 --sql 指定）" >&2; exit 1; }

REAL_LEDGER="/home/hatch/.config/脉络"
is_real=0
[[ "$(realpath -m "$DATA_DIR")" == "$(realpath -m "$REAL_LEDGER")" ]] && is_real=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[restore] 解包 $BACKUP → $TMP"
tar -xzf "$BACKUP" -C "$TMP"
[[ -f "$TMP/readings.jsonl" ]] || echo "[restore] 注意: 包内没有 readings.jsonl" >&2

echo "[restore] 重放 sqlite dump 并校验完整性"
RESTORED="$TMP/restored.sqlite"
sqlite3 "$RESTORED" < "$SQL_DUMP"
CHECK="$(sqlite3 "$RESTORED" "PRAGMA integrity_check;")"
[[ "$CHECK" == "ok" ]] || { echo "[restore] integrity_check 未通过: $CHECK" >&2; exit 1; }
TABLES="$(sqlite3 "$RESTORED" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';")"
echo "[restore] 校验通过：integrity_check=ok，表数=$TABLES"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[restore] dry-run：将恢复以下文件到 $DATA_DIR（未实际写入）："
  echo "  - meridian.sqlite（由 $SQL_DUMP 重放生成，integrity_check=ok）"
  (cd "$TMP" && ls readings.jsonl readings-index.json raw.jsonl 2>/dev/null || true) \
    | sed 's/^/  - /'
  echo "[restore] dry-run 结束，未改动任何数据与服务。"
  exit 0
fi

if [[ "$is_real" -eq 1 && "$YES" -eq 0 ]]; then
  if [[ -t 0 ]]; then
    read -r -p "[restore] 目标是真实账本 $REAL_LEDGER，确认覆盖？(yes/NO) " ans
    [[ "$ans" == "yes" ]] || { echo "已取消" >&2; exit 1; }
  else
    echo "[restore] 目标是真实账本且非交互终端：请加 --yes 显式确认" >&2
    exit 1
  fi
fi

mkdir -p "$DATA_DIR"
if [[ -f "$DATA_DIR/meridian.sqlite" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  cp "$DATA_DIR/meridian.sqlite" "$DATA_DIR/meridian.sqlite.pre-restore-$TS"
  echo "[restore] 现场已备份为 meridian.sqlite.pre-restore-$TS"
fi

echo "[restore] 停服务"
systemctl --user stop meridian-service 2>/dev/null || echo "[restore] 服务未在运行或停止失败，继续" >&2

echo "[restore] 拷入恢复文件"
cp "$RESTORED" "$DATA_DIR/meridian.sqlite"
sqlite3 "$DATA_DIR/meridian.sqlite" "PRAGMA journal_mode=WAL;" >/dev/null
for f in readings.jsonl readings-index.json raw.jsonl; do
  [[ -f "$TMP/$f" ]] && cp "$TMP/$f" "$DATA_DIR/$f" && echo "[restore] 已恢复 $f"
done

echo "[restore] 起服务"
systemctl --user start meridian-service 2>/dev/null || echo "[restore] 服务启动失败，请人工检查" >&2

echo "[restore] 完成"
