#!/usr/bin/env bash
#
# 飞书文档导出助手 - 扩展打包脚本
# 用法:
#   ./build.sh          # 构建 → dist/ 目录（可直接加载未打包扩展；默认不混淆）
#   ./build.sh --zip    # 构建 + 打包成 .zip（用于 Chrome Web Store 上传）
#   混淆需显式开启：OBFUSCATE=1 ./build.sh（商店禁止混淆，勿用于上传包）
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

DIST_DIR="$SCRIPT_DIR/dist"
RELEASE_DIR="$SCRIPT_DIR/release"
VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

log()  { echo -e "\033[32m[BUILD]\033[0m $*"; }
err()  { echo -e "\033[31m[ERROR]\033[0m $*" >&2; exit 1; }

do_build() {
  log "开始构建 (v${VERSION})..."
  npm run build
  log "构建完成，输出目录: $DIST_DIR"
}

do_zip() {
  mkdir -p "$RELEASE_DIR"
  local zip_name="larksnap-v${VERSION}-${TIMESTAMP}.zip"
  local zip_path="$RELEASE_DIR/$zip_name"
  log "打包 ZIP: $zip_name"
  cd "$DIST_DIR"
  zip -r "$zip_path" . -x '*.map' '*.DS_Store'
  cd "$SCRIPT_DIR"
  log "ZIP 打包完成: $zip_path"
}

MODE="${1:-}"
do_build
case "$MODE" in
  --zip) do_zip ;;
  "")    log "仅构建完成。使用 --zip 生成发布包" ;;
  *)     err "未知参数: $MODE\n用法: $0 [--zip]" ;;
esac
log "全部完成!"
