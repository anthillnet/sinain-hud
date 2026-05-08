#!/bin/bash
# Sinain cold-install reset — run inside the sinain-test user's Terminal
# Wipes everything sinain left behind so the next `npx @geravant/sinain@latest start`
# is a true first-time install. Idempotent — safe to run repeatedly.
#
# Usage:
#   bash /tmp/sinain-cold-reset.sh
#
# /tmp is shared across macOS users, so this file is accessible from any account.

set +e   # don't bail on individual failures; report them

echo "▶ Stopping any running sinain processes..."
pkill -f '@geravant/sinain' 2>/dev/null
pkill -f 'sense_client' 2>/dev/null
pkill -f 'sck-capture' 2>/dev/null
pkill -f 'sinain-overlay' 2>/dev/null
sleep 1

echo "▶ Removing ~/.sinain/ (config, capture IPC, overlay app, sck-capture, memory, workspace, snapshots)..."
rm -rf "$HOME/.sinain"

echo "▶ Removing ~/.openclaw/ (OpenClaw config and workspace, if present)..."
rm -rf "$HOME/.openclaw"

echo "▶ Clearing npx cache for @geravant/sinain..."
# npx caches package extractions per hash; locate any containing @geravant/sinain
if [ -d "$HOME/.npm/_npx" ]; then
  find "$HOME/.npm/_npx" -maxdepth 5 -type d -path '*@geravant/sinain' 2>/dev/null | while read d; do
    # Walk up to the npx hash directory (parent of node_modules)
    cache_root="$(dirname "$(dirname "$(dirname "$d")")")"
    if [ -d "$cache_root" ]; then
      echo "    removing $cache_root"
      rm -rf "$cache_root"
    fi
  done
  # Also catch scoped-only directories
  find "$HOME/.npm/_npx" -maxdepth 4 -type d -name 'sinain' 2>/dev/null | while read d; do
    if [ "$(basename "$(dirname "$d")")" = "@geravant" ]; then
      cache_root="$(dirname "$(dirname "$(dirname "$d")")")"
      [ -d "$cache_root" ] && rm -rf "$cache_root"
    fi
  done
fi

echo "▶ Resetting macOS TCC permissions for Terminal (Screen Recording + Microphone)..."
# These will re-prompt on the next install — that's exactly what we want to measure.
tccutil reset ScreenCapture com.apple.Terminal 2>/dev/null && echo "    Screen Recording reset" || echo "    Screen Recording: already reset or no permission set"
tccutil reset Microphone com.apple.Terminal 2>/dev/null && echo "    Microphone reset" || echo "    Microphone: already reset or no permission set"
# Optional: Accessibility, ListenEvent — uncomment if your install ever requests them
# tccutil reset Accessibility com.apple.Terminal 2>/dev/null

echo "▶ Removing Flutter overlay app's macOS sandbox state..."
rm -rf "$HOME/Library/Containers/com.geravant.sinain"* 2>/dev/null
rm -rf "$HOME/Library/Application Support/com.geravant.sinain"* 2>/dev/null
rm -rf "$HOME/Library/Application Support/sinain"* 2>/dev/null
rm -rf "$HOME/Library/Caches/com.geravant.sinain"* 2>/dev/null
rm -rf "$HOME/Library/Caches/sinain"* 2>/dev/null
rm -rf "$HOME/Library/Logs/sinain"* 2>/dev/null
rm -rf "$HOME/Library/Preferences/com.geravant.sinain"* 2>/dev/null
rm -rf "$HOME/Library/Saved Application State/com.geravant.sinain"*.savedState 2>/dev/null
rm -rf "$HOME/Library/HTTPStorages/com.geravant.sinain"* 2>/dev/null
rm -rf "$HOME/Library/WebKit/com.geravant.sinain"* 2>/dev/null

echo "▶ Removing any sinain LaunchAgents (defensive — none expected)..."
rm -f "$HOME/Library/LaunchAgents/com.geravant.sinain"*.plist 2>/dev/null

echo "▶ Removing transcript / screenshot artefacts from prior cold-install runs..."
rm -f /tmp/cold-install-fresh-user.log 2>/dev/null
rm -rf /tmp/cold-install-screenshots 2>/dev/null

echo ""
echo "▶ Verifying clean state..."
[ ! -d "$HOME/.sinain" ]                                          && echo "    ✓ ~/.sinain absent"                          || echo "    ✗ ~/.sinain STILL EXISTS"
[ ! -d "$HOME/.openclaw" ]                                        && echo "    ✓ ~/.openclaw absent"                        || echo "    ✗ ~/.openclaw STILL EXISTS"
[ -z "$(find "$HOME/.npm/_npx" -name 'sinain' -type d 2>/dev/null)" ]  && echo "    ✓ npx cache clean"                          || echo "    ✗ npx cache still has sinain"
[ ! -d "$HOME/Library/Containers/com.geravant.sinain" ]           && echo "    ✓ Flutter overlay sandbox absent"            || echo "    ✗ Flutter sandbox STILL EXISTS"
[ ! -f "/tmp/cold-install-fresh-user.log" ]                       && echo "    ✓ prior cold-install log absent"             || echo "    ✗ prior log STILL EXISTS"

echo ""
echo "✓ Cold reset complete. Next 'time npx @geravant/sinain@latest start' is a true first-time install."
echo "  Expected on next install:"
echo "    - npm package download (a few MB)"
echo "    - overlay app download (~50-100 MB from GitHub Releases)"
echo "    - sck-capture binary download (~5 MB from GitHub Releases)"
echo "    - TCC permission prompts for Screen Recording + Microphone"
echo "    - Setup wizard (OpenRouter key OR Ollama-only choice)"
echo ""
echo "Pre-flight before timing:"
echo "  mkdir -p /tmp/cold-install-screenshots   # for TCC dialog screenshots"
echo ""
echo "Then start the run:"
echo "  script -a /tmp/cold-install-fresh-user.log"
echo "  time npx @geravant/sinain@latest start"
