#!/bin/bash
# Agent Boost 설치: 터미널에 아래 한 줄을 붙여 넣으면 이 Mac에 맞게 빌드해서 응용 프로그램 폴더에 넣고 실행합니다.
#   curl -fsSL https://raw.githubusercontent.com/junil-yeo/agent_bridge/main/install.sh | bash
# 다시 실행하면 최신 소스로 업데이트됩니다. 실행 중인 세션은 그대로 유지됩니다.
# (curl로 받은 파일에는 "인터넷에서 받음" 표시가 붙지 않아, 서명 없이도 macOS가 막지 않습니다.)
set -euo pipefail

REPO="${AGENT_BOOST_REPO:-junil-yeo/agent_bridge}"
BRANCH="${AGENT_BOOST_BRANCH:-main}"
SRC="$HOME/Library/Application Support/AgentBoost/source"
APP_NAME="AgentBoost.app"

say()  { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

# 1. macOS 15 이상
[ "$(uname)" = "Darwin" ] || die "macOS에서만 설치할 수 있습니다."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 15 ] || die "macOS 15 이상이 필요합니다 (현재 $(sw_vers -productVersion))."

# 2. Command Line Tools (Swift 컴파일러). 없으면 macOS 설치 창을 띄우고 끝날 때까지 기다립니다.
if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then
  say "개발 도구(Command Line Tools)가 필요합니다. 화면에 뜨는 설치 창에서 '설치'를 눌러 주세요."
  xcode-select --install >/dev/null 2>&1 || true
  for _ in $(seq 1 360); do                         # 최대 30분
    xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1 && break
    sleep 5
  done
  xcrun --find swiftc >/dev/null 2>&1 || die "개발 도구 설치가 끝나지 않았습니다. 설치를 마친 뒤 같은 명령을 다시 실행해 주세요."
fi

# 3. 소스 받기 (git 없이 압축 파일로)
say "소스를 받는 중 ($REPO, $BRANCH)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$tmp/src.tar.gz" \
  || die "소스를 받지 못했습니다. 인터넷 연결과 저장소 주소($REPO)를 확인해 주세요."
mkdir -p "$tmp/x" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/x"
top=$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -f "$top/build.sh" ] || die "받은 소스에 build.sh가 없습니다."
rm -rf "$SRC"; mkdir -p "$(dirname "$SRC")"; mv "$top" "$SRC"

# 4. 이 Mac에 맞게 최적화 빌드 (몇 분 걸립니다)
say "빌드 중입니다. 몇 분 걸립니다…"
( cd "$SRC" && /bin/zsh ./build.sh release ) || die "빌드에 실패했습니다. 위 메시지를 확인해 주세요."
[ -d "$SRC/$APP_NAME" ] || die "빌드 결과($APP_NAME)를 찾지 못했습니다."

# 5. 응용 프로그램 폴더에 넣기 (쓸 권한이 없으면 내 홈의 Applications)
DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
running() { pgrep -f "$DEST/$APP_NAME/Contents/MacOS/AgentBoost\$" >/dev/null; }
if running; then
  say "실행 중인 Agent Boost를 새 버전으로 바꿉니다 (세션은 계속 실행됩니다)"
  mkdir -p "$HOME/.agent-boost"; touch "$HOME/.agent-boost/skip-shutdown-once"
  osascript -e 'tell application id "local.junil.agentboost" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do running || break; sleep 0.5; done
fi
rm -rf "$DEST/$APP_NAME"
ditto "$SRC/$APP_NAME" "$DEST/$APP_NAME"
rm -rf "$SRC/$APP_NAME"

# 6. 앱이 쓰는 도구 확인 (없어도 설치는 끝나며, 앱 상단 알림에도 안내가 뜹니다)
has() {
  command -v "$1" >/dev/null 2>&1 && return 0
  for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin /opt/local/bin; do [ -x "$d/$1" ] && return 0; done
  return 1
}
missing=0
if ! has tmux; then
  missing=1
  if has brew; then
    say "tmux 설치 중 (Homebrew)"
    brew install tmux || { warn "tmux 설치에 실패했습니다. 터미널에서 'brew install tmux'를 실행해 주세요."; }
  else
    warn "tmux가 없습니다. 세션 실행에 필요합니다. Homebrew(https://brew.sh)를 설치한 뒤 'brew install tmux'를 실행해 주세요."
  fi
fi
if ! has claude; then
  missing=1
  warn "Claude Code CLI(claude)가 없습니다. 설치 안내: https://docs.claude.com/en/docs/claude-code/setup"
fi

say "설치 완료: $DEST/$APP_NAME"
open "$DEST/$APP_NAME"
[ $missing = 0 ] || warn "위에 안내한 도구를 설치한 뒤 Agent Boost를 한 번 종료했다가 다시 열어 주세요."
