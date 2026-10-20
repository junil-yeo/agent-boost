#!/bin/bash
# Agent Boost installer. Paste this one line into Terminal:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/junil-yeo/agent-boost/main/install.sh)"
#
# It checks everything the app needs and installs what is missing (Command Line Tools, Homebrew, tmux, Claude Code,
# GitHub CLI), signs you in to Claude if needed, builds the app for this Mac, puts it in Applications and opens it.
# Run it again at any time to update to the latest source; running sessions keep running.
set -euo pipefail

REPO="${AGENT_BOOST_REPO:-junil-yeo/agent-boost}"
BRANCH="${AGENT_BOOST_BRANCH:-main}"
SRC="$HOME/Library/Application Support/AgentBoost/source"
APP_NAME="AgentBoost.app"

say()  { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }
interactive() { [ -t 0 ] || [ -r /dev/tty ]; }

# tools installed by this script live here; make them visible for the rest of it
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
has() { command -v "$1" >/dev/null 2>&1; }

# ── 1. macOS 15 or later ────────────────────────────────────────────────────────────────
say "Checking this Mac"
[ "$(uname)" = "Darwin" ] || die "Agent Boost runs on macOS only."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 15 ] || die "macOS 15 or later is required (this Mac: $(sw_vers -productVersion))."
ok "macOS $(sw_vers -productVersion) ($(uname -m))"

# ── 2. Command Line Tools (Swift compiler) ──────────────────────────────────────────────
if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
  ok "Command Line Tools"
else
  say "Installing Command Line Tools — click 'Install' in the window that opens"
  xcode-select --install >/dev/null 2>&1 || true
  for _ in $(seq 1 360); do                         # up to 30 minutes
    xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1 && break
    sleep 5
  done
  xcrun --find swiftc >/dev/null 2>&1 || die "Command Line Tools are not installed yet. Finish that install, then run the same command again."
  ok "Command Line Tools"
fi

# ── 3. Homebrew (for tmux and the GitHub CLI) ───────────────────────────────────────────
need_brew=0
has tmux || need_brew=1
has gh || need_brew=1
if [ $need_brew = 1 ] && ! has brew; then
  say "Installing Homebrew (it may ask for your Mac password)"
  if interactive; then
    NONINTERACTIVE=0 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty \
      || warn "Homebrew could not be installed."
  else
    warn "No terminal to ask for your password: install Homebrew from https://brew.sh, then run this again."
  fi
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
fi

# ── 4. tmux (required: every session runs in it) ────────────────────────────────────────
if has tmux; then
  ok "tmux $(tmux -V | cut -d' ' -f2)"
else
  say "Installing tmux"
  has brew && brew install tmux || true
  has tmux || die "tmux could not be installed. Install it (e.g. 'brew install tmux'), then run this again."
  ok "tmux $(tmux -V | cut -d' ' -f2)"
fi

# ── 5. Claude Code CLI (required) ───────────────────────────────────────────────────────
if has claude; then
  ok "Claude Code $(claude --version 2>/dev/null | cut -d' ' -f1)"
else
  say "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash || true
  has claude || die "Claude Code could not be installed. See https://code.claude.com/docs/en/setup, then run this again."
  ok "Claude Code $(claude --version 2>/dev/null | cut -d' ' -f1)"
fi

# ── 6. GitHub CLI (optional: lists your repositories for cloud sessions) ────────────────
if has gh; then
  ok "GitHub CLI"
elif has brew; then
  say "Installing GitHub CLI (optional)"
  brew install gh >/dev/null 2>&1 && ok "GitHub CLI" || warn "GitHub CLI was not installed; cloud sessions still work by typing owner/repo."
else
  warn "GitHub CLI not installed (optional; used to list repositories for cloud sessions)."
fi

# ── 7. Claude sign-in ───────────────────────────────────────────────────────────────────
if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  ok "Signed in to Claude"
elif interactive; then
  say "Signing in to Claude (a browser window opens)"
  claude auth login </dev/tty || warn "Not signed in yet. Run 'claude' in Terminal later to sign in."
else
  warn "Not signed in to Claude. Run 'claude' in Terminal to sign in."
fi

# ── 8. Source ───────────────────────────────────────────────────────────────────────────
say "Downloading the source ($REPO, $BRANCH)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$tmp/src.tar.gz" \
  || die "Could not download the source. Check the internet connection and the repository ($REPO)."
mkdir -p "$tmp/x" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/x"
top=$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -f "$top/build.sh" ] || die "The downloaded source has no build.sh."
rm -rf "$SRC"; mkdir -p "$(dirname "$SRC")"; mv "$top" "$SRC"
ok "Source ready"

# ── 9. Build for this Mac (a few minutes) ───────────────────────────────────────────────
say "Building — this takes a few minutes"
( cd "$SRC" && /bin/zsh ./build.sh release ) || die "The build failed. See the messages above."
[ -d "$SRC/$APP_NAME" ] || die "The built app ($APP_NAME) was not found."
ok "Built"

# ── 10. Install into Applications and open ──────────────────────────────────────────────
DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
running() { pgrep -f "$DEST/$APP_NAME/Contents/MacOS/AgentBoost\$" >/dev/null; }
if running; then
  say "Replacing the running Agent Boost (sessions keep running)"
  mkdir -p "$HOME/.agent-boost"; touch "$HOME/.agent-boost/skip-shutdown-once"
  osascript -e 'tell application id "local.junil.agentboost" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do running || break; sleep 0.5; done
fi
rm -rf "$DEST/$APP_NAME"
ditto "$SRC/$APP_NAME" "$DEST/$APP_NAME"
rm -rf "$SRC/$APP_NAME"

say "Done: $DEST/$APP_NAME"
open "$DEST/$APP_NAME"
