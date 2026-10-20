#!/bin/zsh
# Agent Boost build for macOS: packages the Electron app (app/) as AgentBoost.app. No compile step — it copies Electron
# and the app's files, so a build takes seconds. `./build.sh` builds; `./build.sh run` also restarts a running copy
# (sessions keep running: the same skip-shutdown-once handshake as before).
set -e
cd "$(dirname "$0")"
ROOT="$PWD"; APP="$ROOT/AgentBoost.app"; SRC="$ROOT/app"
PLB=/usr/libexec/PlistBuddy

# Electron itself (first build, or after a version change in app/package.json)
if [ ! -d "$SRC/node_modules/electron/dist/Electron.app" ] || [ ! -d "$SRC/node_modules/preact" ]; then
  ( cd "$SRC" && npm install --no-audit --no-fund >/dev/null && { npm install-scripts approve electron >/dev/null 2>&1 || true; } && npm rebuild electron >/dev/null )
fi

TMP="$ROOT/.AgentBoost.app.tmp"; rm -rf "$TMP"
cp -R "$SRC/node_modules/electron/dist/Electron.app" "$TMP"
C="$TMP/Contents"
mv "$C/MacOS/Electron" "$C/MacOS/AgentBoost"
rm -f "$C/Resources/default_app.asar"
R="$C/Resources/app"; mkdir -p "$R/node_modules"
cp -R "$SRC/main" "$SRC/renderer" "$SRC/assets" "$SRC/l10n-extra" "$SRC/package.json" "$R/"
cp -R "$ROOT/Resources/l10n" "$R/l10n"
cp -R "$SRC/node_modules/preact" "$SRC/node_modules/htm" "$R/node_modules/"
cp "$ROOT/Resources/AppIcon.icns" "$C/Resources/electron.icns"
VER=$(node -p "require('$SRC/package.json').version" 2>/dev/null || echo 0.1.0)
$PLB -c "Set :CFBundleExecutable AgentBoost" "$C/Info.plist"
$PLB -c "Set :CFBundleName Agent Boost" "$C/Info.plist"
$PLB -c "Set :CFBundleDisplayName Agent Boost" "$C/Info.plist" 2>/dev/null || $PLB -c "Add :CFBundleDisplayName string Agent Boost" "$C/Info.plist"
$PLB -c "Set :CFBundleIdentifier local.junil.agentboost" "$C/Info.plist"
$PLB -c "Set :CFBundleShortVersionString $VER" "$C/Info.plist"
$PLB -c "Set :CFBundleVersion $VER" "$C/Info.plist"

# A fixed local certificate (own keychain, "AgentBoard Local Signing") keeps the app's identity across builds, so macOS
# privacy permissions (Desktop folder etc.) stick; without it, ad-hoc signing (a new identity each build).
security unlock-keychain -p agentboard-local "$HOME/Library/Keychains/agentboard-sign.keychain-db" 2>/dev/null || true
SIGN_ID=$(security find-identity -p codesigning 2>/dev/null | awk '/"AgentBoard Local Signing"/ {print $2; exit}')
codesign --force --deep --sign "${SIGN_ID:--}" "$TMP" 2>/dev/null || codesign --force --deep --sign - "$TMP"

running() { pgrep -f "/AgentBoost.app/Contents/MacOS/AgentBoost" >/dev/null; }
WAS=0
if [ "${1:-}" = "run" ] && running; then
  WAS=1
  mkdir -p "$HOME/.agent-boost"; touch "$HOME/.agent-boost/skip-shutdown-once"   # restarting must not stop sessions
  osascript -e 'tell application id "local.junil.agentboost" to quit' >/dev/null 2>&1 || true
  for i in $(seq 1 30); do running || break; sleep 0.5; done
  pkill -f "/AgentBoost.app/Contents/MacOS/AgentBoost" 2>/dev/null || true
  sleep 0.5
fi
rm -rf "$APP"; mv "$TMP" "$APP"
echo "Build finished: $APP"
if [ "${1:-}" = "run" ]; then
  for try in 1 2 3; do open "$APP" 2>/dev/null || true; for i in $(seq 1 16); do running && break 2; sleep 0.5; done; done
  running && echo "Started Agent Boost" || echo "Warning: could not start the app. Run: open $APP"
fi
