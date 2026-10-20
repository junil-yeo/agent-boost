#!/bin/bash
# Agent Boost installer. Paste this one line into Terminal:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/junil-yeo/agent-boost/main/install.sh)"
#
# One app (Electron, in app/) for macOS and Linux; this script detects which one it runs on.
# macOS: installs what is missing (Homebrew for tmux and the GitHub CLI, a private Node.js, Claude Code), signs you in
# to Claude if needed, packages the app, puts it in Applications and opens it.
# Linux: installs tmux and the app window's system libraries through the package manager, a private Node.js, Claude Code
# and the GitHub CLI, signs you in, installs the app under ~/.local/share/agent-boost with an app-menu entry and an
# `agent-boost` command, and opens it.
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

download_source() {   # → $top: the unpacked source tree
  say "Downloading the source ($REPO, $BRANCH)"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$tmp/src.tar.gz" \
    || die "Could not download the source. Check the internet connection and the repository ($REPO)."
  mkdir -p "$tmp/x" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/x"
  top=$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -1)
  ok "Source ready"
}

NODE_VER="v22.11.0"
install_node() {   # $1: install dir — a private Node.js for the app's packages (no system change, no version conflicts)
  local dir="$1" os arch
  case "$(uname -s)" in Darwin) os=darwin ;; *) os=linux ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "Unsupported CPU: $(uname -m) (x86_64 or arm64 needed)." ;; esac
  if [ ! -x "$dir/bin/node" ] || [ "$("$dir/bin/node" -v)" != "$NODE_VER" ]; then
    say "Installing Node.js $NODE_VER (private copy for Agent Boost)"
    rm -rf "$dir"; mkdir -p "$dir"
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$os-$arch.tar.xz" | tar -xJ -C "$dir" --strip-components=1 \
      || die "Could not download Node.js."
  fi
  export PATH="$dir/bin:$PATH"
  ok "Node.js $(node -v)"
}

sign_in() {
  if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
    ok "Signed in to Claude"
  elif interactive; then
    say "Signing in to Claude (a browser window opens)"
    claude auth login </dev/tty || warn "Not signed in yet. Run 'claude' in a terminal later to sign in."
  else
    warn "Not signed in to Claude. Run 'claude' in a terminal to sign in."
  fi
}

# ════════════════════════════════════ Linux ════════════════════════════════════════════
install_linux() {
  local DEST="$HOME/.local/share/agent-boost" NODE_DIR="$HOME/.local/share/agent-boost/node"
  say "Checking this computer"
  ok "$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr) ($(uname -m))"
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "Unsupported CPU: $(uname -m) (x86_64 or arm64 needed)." ;; esac

  # package manager (system packages need sudo; it asks for your password once)
  local pm="" SUDO=""
  [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  if has apt-get; then pm=apt; elif has dnf; then pm=dnf; elif has pacman; then pm=pacman; elif has zypper; then pm=zypper; fi
  pkg_install() {
    [ -n "$pm" ] || return 1
    case $pm in
      apt) $SUDO apt-get update -qq </dev/tty && $SUDO apt-get install -y "$@" </dev/tty ;;
      dnf) $SUDO dnf install -y "$@" </dev/tty ;;
      pacman) $SUDO pacman -S --needed --noconfirm "$@" </dev/tty ;;
      zypper) $SUDO zypper --non-interactive install "$@" </dev/tty ;;
    esac
  }

  # tmux (required)
  if has tmux; then ok "tmux $(tmux -V | cut -d' ' -f2)"
  else
    say "Installing tmux"
    pkg_install tmux || true
    has tmux || die "tmux could not be installed. Install it with your package manager, then run this again."
    ok "tmux $(tmux -V | cut -d' ' -f2)"
  fi

  # git and curl helpers some distros lack
  has git || pkg_install git >/dev/null 2>&1 || true

  install_node "$NODE_DIR"

  # Claude Code CLI (required)
  if has claude; then ok "Claude Code $(claude --version 2>/dev/null | cut -d' ' -f1)"
  else
    say "Installing Claude Code"
    curl -fsSL https://claude.ai/install.sh | bash || true
    has claude || die "Claude Code could not be installed. See https://code.claude.com/docs/en/setup, then run this again."
    ok "Claude Code $(claude --version 2>/dev/null | cut -d' ' -f1)"
  fi

  # GitHub CLI (optional: repository list for cloud sessions)
  if has gh; then ok "GitHub CLI"
  else
    pkg_install gh >/dev/null 2>&1 || pkg_install github-cli >/dev/null 2>&1 || true
    has gh && ok "GitHub CLI" || warn "GitHub CLI not installed (optional; used to list repositories for cloud sessions)."
  fi

  sign_in
  download_source
  [ -f "$top/app/package.json" ] || die "The downloaded source has no app/ folder."

  say "Installing Agent Boost"
  local NEW="$DEST/app.new"
  rm -rf "$NEW"; mkdir -p "$DEST"
  cp -R "$top/app" "$NEW"
  cp -R "$top/Resources/l10n" "$NEW/l10n"
  ( cd "$NEW" && npm install --omit=optional --no-audit --no-fund --foreground-scripts >/dev/null 2>&1 \
      || npm install --no-audit --no-fund ) || die "Installing the app's packages failed. See the messages above."
  local ELECTRON="$NEW/node_modules/electron/dist/electron"
  [ -x "$ELECTRON" ] || ( cd "$NEW" && node node_modules/electron/install.js ) || die "Electron could not be downloaded."

  # system libraries Electron needs (desktop distros usually have them)
  local missing_libs
  missing_libs=$(ldd "$ELECTRON" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ')
  if [ -n "$missing_libs" ]; then
    say "Installing system libraries for the app window"
    case $pm in
      apt) pkg_install libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libxss1 libxshmfence1 libdrm2 libxkbcommon0 \
             libasound2t64 2>/dev/null || pkg_install libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libxss1 libxshmfence1 libdrm2 libxkbcommon0 libasound2 ;;
      dnf) pkg_install nss atk at-spi2-atk gtk3 mesa-libgbm libXScrnSaver libxshmfence libdrm libxkbcommon alsa-lib ;;
      pacman) pkg_install nss atk at-spi2-core gtk3 mesa libxss libxshmfence libdrm libxkbcommon alsa-lib ;;
      zypper) pkg_install mozilla-nss libatk-1_0-0 libatk-bridge-2_0-0 gtk3 libgbm1 libXss1 libxshmfence1 libdrm2 libxkbcommon0 alsa ;;
    esac || warn "Some libraries may be missing: $missing_libs"
  fi

  # Chromium's sandbox helper must be owned by root (setuid); without sudo the app starts with --no-sandbox
  local SANDBOX_FLAG=""
  if [ -f "$NEW/node_modules/electron/dist/chrome-sandbox" ] && $SUDO chown root:root "$NEW/node_modules/electron/dist/chrome-sandbox" </dev/tty 2>/dev/null \
     && $SUDO chmod 4755 "$NEW/node_modules/electron/dist/chrome-sandbox" 2>/dev/null; then :; else SANDBOX_FLAG="--no-sandbox"; fi

  # replace the running copy (sessions keep running: they live in tmux)
  pkill -f "$DEST/app/node_modules/electron/dist/electron" 2>/dev/null || true
  rm -rf "$DEST/app"; mv "$NEW" "$DEST/app"
  ELECTRON="$DEST/app/node_modules/electron/dist/electron"

  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
  cat > "$HOME/.local/bin/agent-boost" <<LAUNCH
#!/bin/sh
exec "$ELECTRON" $SANDBOX_FLAG "$DEST/app" "\$@"
LAUNCH
  chmod +x "$HOME/.local/bin/agent-boost"
  cp "$DEST/app/assets/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/agent-boost.png"
  cat > "$HOME/.local/share/applications/agent-boost.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Agent Boost
Comment=Watch and drive teams of Claude Code agents
Exec=$HOME/.local/bin/agent-boost
Icon=agent-boost
Terminal=false
Categories=Development;
StartupWMClass=Agent Boost
DESKTOP
  has update-desktop-database && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
  ok "Installed: $DEST/app (command: agent-boost, and 'Agent Boost' in the app menu)"

  say "Done"
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup "$HOME/.local/bin/agent-boost" >/dev/null 2>&1 &
  else
    warn "No graphical session here: start it later with 'agent-boost' or from the app menu."
  fi
  exit 0
}

[ "$(uname)" = "Linux" ] && install_linux

# ════════════════════════════════════ macOS ════════════════════════════════════════════
say "Checking this Mac"
[ "$(uname)" = "Darwin" ] || die "Agent Boost runs on macOS and Linux only."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 12 ] || die "macOS 12 or later is required (this Mac: $(sw_vers -productVersion))."
ok "macOS $(sw_vers -productVersion) ($(uname -m))"

# Homebrew (for tmux and the GitHub CLI)
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

# tmux (required: every session runs in it)
if has tmux; then
  ok "tmux $(tmux -V | cut -d' ' -f2)"
else
  say "Installing tmux"
  has brew && brew install tmux || true
  has tmux || die "tmux could not be installed. Install it (e.g. 'brew install tmux'), then run this again."
  ok "tmux $(tmux -V | cut -d' ' -f2)"
fi

install_node "$HOME/Library/Application Support/AgentBoost/node"

# Claude Code CLI (required)
if has claude; then
  ok "Claude Code $(claude --version 2>/dev/null | cut -d' ' -f1)"
else
  say "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash || true
  has claude || die "Claude Code could not be installed. See https://code.claude.com/docs/en/setup, then run this again."
  ok "Claude Code $(claude --version 2>/dev/null | cut -d' ' -f1)"
fi

# GitHub CLI (optional: lists your repositories for cloud sessions)
if has gh; then
  ok "GitHub CLI"
elif has brew; then
  say "Installing GitHub CLI (optional)"
  brew install gh >/dev/null 2>&1 && ok "GitHub CLI" || warn "GitHub CLI was not installed; cloud sessions still work by typing owner/repo."
else
  warn "GitHub CLI not installed (optional; used to list repositories for cloud sessions)."
fi

sign_in
download_source
[ -f "$top/build.sh" ] && [ -f "$top/app/package.json" ] || die "The downloaded source has no app/."
rm -rf "$SRC"; mkdir -p "$(dirname "$SRC")"; mv "$top" "$SRC"

say "Packaging the app"
( cd "$SRC" && /bin/zsh ./build.sh ) || die "Packaging failed. See the messages above."
[ -d "$SRC/$APP_NAME" ] || die "The packaged app ($APP_NAME) was not found."
ok "Packaged"

# Install into Applications (replacing a running copy: sessions keep running) and open
DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
running() { pgrep -f "$DEST/$APP_NAME/Contents/MacOS/AgentBoost" >/dev/null; }
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
