#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sinain uninstaller — remove Sinain from everywhere, KEEPING your knowledge
# graph. Reverses what an npx OR macOS DMG install set up: stops services,
# deregisters the MCP server from your coding agents, moves the app to the
# Trash, and clears config/state/caches — but preserves the distilled knowledge
# (the EAV triplestore + portable knowledge docs) so a future reinstall picks
# up where you left off. Idempotent; safe to run repeatedly.
#
# Usage:
#   bash uninstall.sh                  # DRY RUN — prints exactly what it WOULD do
#   bash uninstall.sh --yes            # apply (knowledge graph preserved)
#   bash uninstall.sh --yes --purge-knowledge   # ALSO delete the knowledge graph
#   bash uninstall.sh --yes --skip-mcp          # don't touch agent MCP configs
#
# Bundle id: com.sinain.hud
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BUNDLE="com.sinain.hud"
APPLY=false; PURGE_KG=false; SKIP_MCP=false
for a in "$@"; do
  case "$a" in
    --yes|-y)          APPLY=true ;;
    --purge-knowledge) PURGE_KG=true ;;
    --skip-mcp)        SKIP_MCP=true ;;
    *) echo "unknown flag: $a"; exit 64 ;;
  esac
done

# Safety: never operate without a real HOME.
[ -n "${HOME:-}" ] && [ "$HOME" != "/" ] || { echo "refusing to run: HOME is unset or /"; exit 1; }

# Directories that hold the knowledge graph — preserved unless --purge-knowledge.
KG_LOCAL="$HOME/.sinain/memory"
KG_WORKSPACE="$HOME/.openclaw/workspace/memory"

B="\033[1m"; G="\033[0;32m"; Y="\033[0;33m"; R="\033[0;31m"; X="\033[0m"
$APPLY || echo -e "${Y}DRY RUN${X} — nothing will change. Re-run with ${B}--yes${X} to apply.\n"
if $PURGE_KG; then
  echo -e "${R}⚠ --purge-knowledge: your distilled knowledge graph WILL be deleted.${X}\n"
else
  echo -e "${G}Knowledge graph will be PRESERVED${X} (${KG_LOCAL}, ${KG_WORKSPACE}).\n"
fi

run() {  # run <description> <command...> — echo always; execute only when --yes.
  local desc="$1"; shift
  echo -e "  ${desc}"
  $APPLY && "$@" >/dev/null 2>&1 || true
}
rmrf() {  # rmrf <path...> — guard against empty args + the KG dirs.
  for p in "$@"; do
    [ -n "$p" ] || continue
    [ -e "$p" ] || [ -L "$p" ] || continue
    if ! $PURGE_KG && { [ "$p" = "$KG_LOCAL" ] || [ "$p" = "$KG_WORKSPACE" ]; }; then
      echo -e "    ${G}keep${X} $p ${Y}(knowledge graph)${X}"; continue
    fi
    echo -e "    ${R}rm${X} $p"
    $APPLY && rm -rf "$p" 2>/dev/null || true
  done
}
# Remove every top-level entry under $1 except those named in the rest of args.
rm_except() {
  local dir="$1"; shift
  [ -d "$dir" ] || return 0
  local entry name keep
  for entry in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"; keep=false
    for k in "$@"; do [ "$name" = "$k" ] && keep=true; done
    $keep && { echo -e "    ${G}keep${X} $entry"; continue; }
    rmrf "$entry"
  done
}

echo -e "${B}1. Stop running Sinain processes${X}"
for pat in "Sinain.app" "sinain_hud.app" "@geravant/sinain" "sinain-core" "sinain-core/dist/index.js" \
           "tsx.*src/index.ts" "sense_client" "sck-capture" "sinain-agent-runner/run.sh" "bash run.sh" \
           "sinain-proxy" "openrouter-proxy" ".sinain/python/bin/python3" "whisper-cli" "launch-backend.sh"; do
  run "pkill -f '${pat}'" pkill -f "$pat"
done
sleep 1

echo -e "${B}2. Deregister the MCP server from your coding agents${X}"
if $SKIP_MCP; then
  echo -e "    ${Y}--skip-mcp${X}: leaving agent MCP configs untouched"
elif command -v npx >/dev/null 2>&1; then
  # mcp-register.js knows every backend's config format (claude/codex/cursor/
  # goose/junie/Claude Desktop) and removes the `sinain` entry idempotently.
  run "npx @geravant/sinain mcp remove --all" npx -y @geravant/sinain@latest mcp remove --all
else
  echo -e "    ${Y}npx not found${X} — run ${B}npx @geravant/sinain mcp remove --all${X} yourself to deregister"
fi

echo -e "${B}3. Move the app to the Trash${X}"
for app in "/Applications/Sinain.app" "$HOME/Applications/Sinain.app"; do
  [ -d "$app" ] || continue
  echo -e "    ${R}trash${X} $app"
  $APPLY && osascript -e "tell application \"Finder\" to delete (POSIX file \"$app\" as alias)" >/dev/null 2>&1 || true
done
rmrf "$HOME/.sinain/overlay" "$HOME/.sinain/sinain_hud.app"

echo -e "${B}4. Remove Sinain config + data (~/.sinain — env, agents, models, python, provisioning, logs)${X}"
echo -e "   ${Y}keeping ~/.sinain/memory (knowledge graph)${X}"
rm_except "$HOME/.sinain" memory

echo -e "${B}5. Remove the knowledge workspace (keeping its memory db)${X}"
if [ -d "$HOME/.openclaw/workspace" ]; then
  rm_except "$HOME/.openclaw/workspace" memory
  # If the workspace is now empty (KG purged) and openclaw holds nothing else, drop it.
  rmdir "$HOME/.openclaw/workspace" "$HOME/.openclaw" 2>/dev/null || true
fi

echo -e "${B}6. Remove the app's macOS state (prefs, container, caches, LaunchAgent — ${BUNDLE})${X}"
rmrf "$HOME/Library/Containers/${BUNDLE}" \
     "$HOME/Library/Preferences/${BUNDLE}.plist" \
     "$HOME/Library/Caches/${BUNDLE}" \
     "$HOME/Library/HTTPStorages/${BUNDLE}" \
     "$HOME/Library/WebKit/${BUNDLE}" \
     "$HOME/Library/Application Support/${BUNDLE}" \
     "$HOME/Library/Saved Application State/${BUNDLE}.savedState" \
     "$HOME/Library/LaunchAgents/${BUNDLE}.plist"

echo -e "${B}7. Revoke the app's macOS permission grants (Screen Recording, etc.)${X}"
for svc in ScreenCapture Accessibility Microphone ListenEvent; do
  run "tccutil reset ${svc} ${BUNDLE}" tccutil reset "$svc" "$BUNDLE"
done

echo -e "${B}8. Remove leftover temp files${X}"
rmrf /tmp/sinain-pids.txt /tmp/sinain-sense-control.json \
     /tmp/openrouter-proxy.log /tmp/openrouter-proxy.stdout.log

echo ""
if $APPLY; then
  echo -e "${G}✓ Sinain uninstalled.${X}"
  if $PURGE_KG; then
    echo -e "  Knowledge graph deleted."
  else
    echo -e "  Your knowledge graph is preserved at ${B}${KG_LOCAL}${X}."
    echo -e "  Reinstall any time and it picks up where you left off, or back it up:"
    echo -e "    ${B}npx @geravant/sinain@latest export-knowledge${X}"
  fi
  echo -e "  Note: macOS may keep a stale 'Sinain' row under Privacy & Security →"
  echo -e "  Screen Recording until you toggle/remove it — that's cosmetic."
else
  echo -e "${Y}Dry run complete.${X} Re-run with ${B}bash uninstall.sh --yes${X} to apply."
fi
