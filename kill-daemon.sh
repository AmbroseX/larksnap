#!/usr/bin/env bash
# macOS / Linux：停掉 larksnap daemon（真正的逻辑在 kill-daemon.mjs 里，三平台共用）
set -e
exec node "$(cd "$(dirname "$0")" && pwd)/kill-daemon.mjs" "$@"
