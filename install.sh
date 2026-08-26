#!/usr/bin/env bash
#
# LarkSnap 一键安装（macOS / Linux）
#
# 远程一键装（不用先 clone）：
#   curl -fsSL https://raw.githubusercontent.com/AmbroseX/larksnap/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/AmbroseX/larksnap/main/install.sh | bash -s -- --yes
#
# 已经 clone 了仓库：
#   ./install.sh                # 装技能 + 检查依赖 + 把 daemon 装成开机自启的常驻服务
#   ./install.sh --link         # 技能用软链指向仓库（改代码即时生效，适合开发）
#   ./install.sh --no-service   # 只装技能和依赖，不注册常驻服务
#   ./install.sh --yes          # 一路默认同意（管道执行时本来就不会问）
#   ./install.sh --uninstall    # 停服务、删服务文件、删已安装的技能目录
#
# Windows 请照 skills/larksnap-fetch/references/setup.md 手动操作。
set -euo pipefail

REPO_SLUG="${LARKSNAP_REPO:-AmbroseX/larksnap}"
REPO_BRANCH="${LARKSNAP_BRANCH:-main}"
SKILL_NAME="larksnap-fetch"
SKILLS_DIR="${LARKSNAP_SKILLS_DIR:-$HOME/.claude/skills}"
SKILL_DST="$SKILLS_DIR/$SKILL_NAME"
DAEMON_REL="scripts/bridge/daemon.mjs"
SERVICE_LABEL="com.larksnap.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
UNIT_PATH="$HOME/.config/systemd/user/larksnap-daemon.service"
PORT="${LARKSNAP_PORT:-19925}"
HOME_DIR="$HOME/.larksnap"
LOG_PATH="$HOME_DIR/daemon.log"
PID_PATH="$HOME_DIR/daemon.pid"
OS="$(uname -s)"

MODE_LINK=0
WITH_SERVICE=1
ASSUME_YES=0
DO_UNINSTALL=0

usage() {
  cat <<'USAGE'
用法：
  curl -fsSL https://raw.githubusercontent.com/AmbroseX/larksnap/main/install.sh | bash
  ./install.sh [--link] [--no-service] [--yes] [--uninstall]

  --link        技能用软链指向仓库（开发用，仅本地仓库模式有效）
  --no-service  不注册 daemon 常驻服务
  --yes, -y     不询问，一路同意
  --uninstall   卸载：停服务、删服务文件与技能目录
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --link) MODE_LINK=1 ;;
    --no-service) WITH_SERVICE=0 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：${arg}（--help 看用法）" >&2; exit 1 ;;
  esac
done
[ "${LARKSNAP_YES:-0}" = "1" ] && ASSUME_YES=1

info() { echo -e "\033[32m[安装]\033[0m $*"; }
warn() { echo -e "\033[33m[注意]\033[0m $*"; }
err()  { echo -e "\033[31m[失败]\033[0m $*" >&2; exit 1; }

# 管道执行（curl | bash）时 stdin 是脚本本身，问也问不到人，一律走默认
ask() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  local reply=''
  read -r -p "$1 [y/N] " reply || true
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------- 源码位置：本地仓库直接用，管道执行就去 GitHub 拉一份 ----------

# 脚本自身所在目录；管道执行时 $0 是 bash，拿不到目录
self_dir() {
  local self="${BASH_SOURCE[0]:-$0}"
  [ -f "$self" ] || return 1
  (cd "$(dirname "$self")" && pwd)
}

# 从 GitHub 取技能：下到临时目录，装完就删，本机不留源码副本
TMP_DIR=""
cleanup() { if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi; }
trap cleanup EXIT

fetch_skill_src() {
  local url="https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$REPO_BRANCH"
  command -v curl >/dev/null 2>&1 || err "没找到 curl，装一个再来"
  TMP_DIR="$(mktemp -d)"
  info "从 GitHub 取技能（$REPO_SLUG@${REPO_BRANCH}）…" >&2
  curl -fsSL "$url" -o "$TMP_DIR/src.tar.gz" || err "下载失败：$url"
  tar -xzf "$TMP_DIR/src.tar.gz" -C "$TMP_DIR" || err "解包失败，下载的包可能不完整"
  local dir
  dir="$(find "$TMP_DIR" -maxdepth 3 -type d -path "*/skills/$SKILL_NAME" | head -1)"
  [ -n "$dir" ] || err "包里没找到技能目录 skills/$SKILL_NAME"
  echo "$dir"
}

REMOTE=0
REPO_DIR="$(self_dir || true)"
if [ -z "$REPO_DIR" ] || [ ! -d "$REPO_DIR/skills/$SKILL_NAME" ]; then
  REMOTE=1
  REPO_DIR=""   # 管道执行：技能从 GitHub 现取现装，本机不留仓库副本
fi

# ---------- 停 daemon：只认 PID 文件，不依赖仓库里的 kill-daemon.mjs ----------
stop_daemon() {
  [ -f "$PID_PATH" ] || return 0
  local pid
  pid="$(tr -d '[:space:]' < "$PID_PATH")"
  [[ "$pid" =~ ^[0-9]+$ ]] || { rm -f "$PID_PATH"; return 0; }
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_PATH"
}

# ---------- 常驻服务：macOS 用 launchd，Linux 用 systemd --user ----------

# daemon 要调用 yt-dlp / ffmpeg，而 launchd / systemd 给的 PATH 很窄，
# 这里把常见目录加上工具的真实所在目录（yt-dlp 常被装在 conda / pipx 里）一起写进去
service_path() {
  local dirs="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"
  local found dir bin
  for bin in yt-dlp ffmpeg node; do
    found="$(command -v "$bin" 2>/dev/null || true)"
    [ -n "$found" ] || continue
    dir="$(dirname "$found")"
    case ":$dirs:" in *":$dir:"*) ;; *) dirs="$dirs:$dir" ;; esac
  done
  echo "$dirs"
}

write_launchd() {
  mkdir -p "$(dirname "$PLIST_PATH")"
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SKILL_DST/$DAEMON_REL</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- daemon 空闲 30 分钟会自退，KeepAlive 负责再把它拉起来，等于常驻 -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(service_path)</string>
    <key>LARKSNAP_PORT</key><string>$PORT</string>
  </dict>
  <key>StandardErrorPath</key><string>$HOME_DIR/service.err.log</string>
</dict>
</plist>
PLIST
}

write_systemd() {
  mkdir -p "$(dirname "$UNIT_PATH")"
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=LarkSnap 桥接 daemon（浏览器扩展 <-> 本地 CLI）
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $SKILL_DST/$DAEMON_REL
# daemon 空闲 30 分钟自退，always 负责再拉起来，等于常驻
Restart=always
RestartSec=5
Environment=PATH=$(service_path)
Environment=LARKSNAP_PORT=$PORT

[Install]
WantedBy=default.target
UNIT
}

has_systemd_user() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

stop_service() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null ||
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
  elif has_systemd_user; then
    systemctl --user disable --now larksnap-daemon.service 2>/dev/null || true
  fi
}

start_service() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null ||
      launchctl load -w "$PLIST_PATH"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now larksnap-daemon.service
  fi
}

# ---------- 卸载 ----------
if [ "$DO_UNINSTALL" = 1 ]; then
  info "停掉常驻服务…"
  stop_service
  rm -f "$PLIST_PATH" "$UNIT_PATH"
  stop_daemon   # 服务之外还可能有 fetch.mjs 顺手拉起的 daemon
  if [ -e "$SKILL_DST" ] || [ -L "$SKILL_DST" ]; then
    rm -rf "$SKILL_DST"
    info "已删除技能目录：$SKILL_DST"
  fi
  info "卸载完成（$HOME_DIR 下的日志和密钥保留，不需要就自己删）"
  exit 0
fi

# ---------- 1. 检查 Node ----------
command -v node >/dev/null 2>&1 ||
  err "没找到 node。先装 Node.js 18+：macOS \`brew install node\`，Linux 用发行版包管理器或 nvm"
NODE_BIN="$(command -v node)"
NODE_VER="$(node -p 'process.versions.node')"
[ "${NODE_VER%%.*}" -ge 18 ] || err "Node 版本太低（当前 v${NODE_VER}），需要 18 以上"
info "Node 就绪：$NODE_BIN (v$NODE_VER)"

# ---------- 2. 找到技能来源 ----------
if [ "$REMOTE" = 1 ]; then
  SKILL_SRC="$(fetch_skill_src)"
  if [ "$MODE_LINK" = 1 ]; then
    warn "--link 只在本地仓库里有意义，这次改成复制安装"
    MODE_LINK=0
  fi
else
  SKILL_SRC="$REPO_DIR/skills/$SKILL_NAME"
fi
[ -d "$SKILL_SRC" ] || err "找不到技能目录：$SKILL_SRC"

# ---------- 3. 装技能 ----------
mkdir -p "$SKILLS_DIR" "$HOME_DIR"
rm -rf "$SKILL_DST"   # 软链和目录都清掉，避免复制进了旧目录里面
if [ "$MODE_LINK" = 1 ]; then
  ln -s "$SKILL_SRC" "$SKILL_DST"
  info "技能已软链：$SKILL_DST -> ${SKILL_SRC}（改仓库代码即时生效）"
else
  cp -R "$SKILL_SRC" "$SKILL_DST"
  info "技能已安装：$SKILL_DST"
fi

# ---------- 4. 可选依赖：yt-dlp / ffmpeg（只有「下载视频」用得到） ----------
missing=()
command -v yt-dlp >/dev/null 2>&1 || missing+=("yt-dlp")
command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg")

if [ ${#missing[@]} -eq 0 ]; then
  info "视频下载依赖齐全：yt-dlp、ffmpeg"
else
  warn "缺少 ${missing[*]}（只影响「下载视频」，抓取和编辑飞书文档不需要）"
  install_cmd=""
  if command -v brew >/dev/null 2>&1; then
    install_cmd="brew install ${missing[*]}"
  elif command -v apt-get >/dev/null 2>&1; then
    install_cmd="sudo apt-get install -y ${missing[*]}"
  elif command -v dnf >/dev/null 2>&1; then
    install_cmd="sudo dnf install -y ${missing[*]}"
  elif command -v pacman >/dev/null 2>&1; then
    install_cmd="sudo pacman -S --noconfirm ${missing[*]}"
  fi

  if [ -z "$install_cmd" ]; then
    warn "没认出包管理器，请自行安装：${missing[*]}"
  elif ask "现在执行 \`$install_cmd\` 装上吗？"; then
    # 装失败不该中断整个安装：视频下载只是可选功能
    if eval "$install_cmd"; then
      info "依赖安装完成"
    else
      warn "安装没成功，之后可手动跑：$install_cmd"
    fi
  else
    warn "跳过了，之后想装就跑：$install_cmd"
  fi
fi

# ---------- 5. daemon 常驻服务 ----------
if [ "$WITH_SERVICE" = 0 ]; then
  info "按 --no-service 跳过常驻服务；daemon 会在第一次跑 fetch.mjs 时自动拉起"
else
  # 先把旧的都停掉：服务里的和之前自动拉起的，免得抢 $PORT 端口
  stop_service
  stop_daemon

  if [ "$OS" = "Darwin" ]; then
    write_launchd
    start_service
    info "已注册开机自启（launchd）：$PLIST_PATH"
  elif has_systemd_user; then
    write_systemd
    start_service
    info "已注册开机自启（systemd --user）：$UNIT_PATH"
    warn "想在没登录时也常驻，跑一次：sudo loginctl enable-linger $USER"
  else
    # 没有 systemd --user 的环境（容器、老 WSL 等）：退而求其次，先后台跑起来
    warn "这台机器没有可用的 systemd --user，改成后台直接启动（重启后要再跑一次本脚本）"
    LARKSNAP_PORT="$PORT" nohup "$NODE_BIN" "$SKILL_DST/$DAEMON_REL" >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi

  # 等它真的在听端口，最多 5 秒
  ready=0
  for _ in $(seq 1 25); do
    if curl -fsS "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.2
  done
  if [ "$ready" = 1 ]; then
    ver="$(curl -fsS "http://127.0.0.1:$PORT/ping" | sed -n 's/.*"daemonVersion":"\([^"]*\)".*/\1/p')"
    info "daemon 已在 127.0.0.1:${PORT} 运行（v${ver:-?}）"
  else
    warn "daemon 5 秒内没应答 /ping，看日志：$LOG_PATH"
  fi
fi

echo
info "装好了。还差最后一步——装浏览器扩展（登录态和导出引擎都在扩展里）："
if [ "$REMOTE" = 1 ]; then
  echo "  1) Chrome 应用商店搜 LarkSnap 安装，或到 https://github.com/$REPO_SLUG/releases 下 zip 解压"
  echo "     （下 zip 的话：chrome://extensions → 开「开发者模式」→「加载已解压的扩展程序」选解压出的目录）"
elif [ -d "$REPO_DIR/dist" ]; then
  echo "  1) chrome://extensions → 开「开发者模式」→「加载已解压的扩展程序」，选：$REPO_DIR/dist"
else
  echo "  1) 先构建：cd $REPO_DIR && npm install && npm run build，再到 chrome://extensions 加载 dist/"
fi
echo "  2) 点一下扩展图标唤醒后台，它会自动连上本地 daemon"
echo
if [ "$REMOTE" = 1 ]; then
  echo "  日志：$LOG_PATH"
  echo "  卸载：curl -fsSL https://raw.githubusercontent.com/$REPO_SLUG/$REPO_BRANCH/install.sh | bash -s -- --uninstall"
else
  echo "  日志：$LOG_PATH ｜ 卸载：$0 --uninstall"
fi
