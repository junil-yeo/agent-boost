#!/bin/zsh
# Legacy: builds the retired SwiftUI version (Sources/). The app is now the Electron one — see build.sh.
set -e
cd "$(dirname "$0")"
APP="AgentBoost.app"; C="$APP/Contents"
MODE="${1:-dev}"          # dev: quick build / release: -O, for this Mac / dist: -O, Intel + Apple Silicon (for distribution)
running() { pgrep -f "$PWD/$1/Contents/MacOS/$2\$" >/dev/null; }
# the app used to be AgentBridge.app: quit it the way a rebuild does (sessions keep running), then remove it
WAS_RUNNING=0
if [ -d AgentBridge.app ]; then
  if running AgentBridge.app AgentBridge; then
    WAS_RUNNING=1
    mkdir -p "$HOME/.agent-bridge"; touch "$HOME/.agent-bridge/skip-shutdown-once"
    osascript -e 'tell application id "local.junil.agentbridge" to quit' >/dev/null 2>&1 || true
    for i in $(seq 1 30); do running AgentBridge.app AgentBridge || break; sleep 0.5; done
    pkill -f "$PWD/AgentBridge.app/Contents/MacOS/AgentBridge\$" 2>/dev/null || true
  fi
  rm -rf AgentBridge.app
fi
rm -rf "$APP"; mkdir -p "$C/MacOS" "$C/Resources"
OPT="-Onone"; [ "$MODE" = "release" -o "$MODE" = "dist" ] && OPT="-O"
if [ "$MODE" = "dist" ]; then
  # universal, for other Macs: an Intel-only app runs on Apple Silicon through Rosetta (and asks to install it). The two
  # slices compile at the same time (the arm64 one is cross-compiled); each fails the build on its own.
  swiftc $OPT -parse-as-library -target x86_64-apple-macosx15.0 Sources/AgentBoost/*.swift -o "$C/MacOS/AgentBoost.x86_64" & P1=$!
  swiftc $OPT -parse-as-library -target arm64-apple-macosx15.0 Sources/AgentBoost/*.swift -o "$C/MacOS/AgentBoost.arm64" & P2=$!
  wait $P1; wait $P2
  lipo -create "$C/MacOS/AgentBoost.x86_64" "$C/MacOS/AgentBoost.arm64" -output "$C/MacOS/AgentBoost"
  rm "$C/MacOS/AgentBoost.x86_64" "$C/MacOS/AgentBoost.arm64"
else
  swiftc $OPT -parse-as-library Sources/AgentBoost/*.swift -o "$C/MacOS/AgentBoost"
fi
cp Resources/AppIcon.icns "$C/Resources/AppIcon.icns"
[ -d Resources/l10n ] && cp -R Resources/l10n "$C/Resources/l10n"     # translations (L10n.swift)
cat > "$C/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Agent Boost</string>
  <key>CFBundleDisplayName</key><string>Agent Boost</string>
  <key>CFBundleIdentifier</key><string>local.junil.agentboost</string>
  <key>CFBundleVersion</key><string>0.1</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleExecutable</key><string>AgentBoost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>
PLIST
# A fixed local certificate (own keychain below, "AgentBoard Local Signing") keeps the app's identity the same across builds,
# so macOS privacy permissions (Desktop folder etc.) stick. Without it: ad-hoc, which macOS treats as a new app each build.
# the key lives in its own keychain (password known to this script; only codesign may use the key), so signing never prompts
security unlock-keychain -p agentboard-local "$HOME/Library/Keychains/agentboard-sign.keychain-db" 2>/dev/null || true
SIGN_ID=$(security find-identity -p codesigning 2>/dev/null | awk '/"AgentBoard Local Signing"/ {print $2; exit}')
codesign --force --sign "${SIGN_ID:--}" "$APP" 2>/dev/null || codesign --force --sign - "$APP" 2>/dev/null || true
echo "Build finished: $PWD/$APP"
# relaunch: macOS only brings a running copy forward, so a rebuilt app would never load.
if [ "$MODE" != "dev" ] && { running "$APP" AgentBoost || [ $WAS_RUNNING = 1 ]; }; then
  if running "$APP" AgentBoost; then
    touch "$HOME/.agent-boost/skip-shutdown-once"   # a rebuild must not switch sessions off
    osascript -e 'tell application id "local.junil.agentboost" to quit' >/dev/null 2>&1 || true
    for i in $(seq 1 30); do running "$APP" AgentBoost || break; sleep 0.5; done   # wait until really gone
    pkill -f "$PWD/$APP/Contents/MacOS/AgentBoost\$" 2>/dev/null || true   # usually already gone; must not trip set -e
    sleep 0.5
  fi
  # LaunchServices can swallow an `open` issued right after the old copy exits, so verify and retry.
  for try in 1 2 3 4; do
    open "$APP" 2>/dev/null || true
    for i in $(seq 1 16); do running "$APP" AgentBoost && break 2; sleep 0.5; done
    sleep 1
  done
  if running "$APP" AgentBoost; then echo "Relaunched the running app with the new build"
  else echo "Warning: could not reopen the app. Run: open $PWD/$APP"; fi
fi
