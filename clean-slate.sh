#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sinain clean-slate — wipe everything a prior install (npx OR the macOS DMG)
# left behind, so the next Sinain.app first-run goes through end-to-end as a
# true first-time user. Idempotent — safe to run repeatedly.
#
# Usage:
#   bash clean-slate.sh            # dry run — prints exactly what it WOULD remove
#   bash clean-slate.sh --yes      # actually wipe
#   bash clean-slate.sh --yes --ollama     # also remove the local SLMs (multi-GB re-pull!)
#   bash clean-slate.sh --yes --keep-openclaw   # leave ~/.openclaw untouched
#
# Bundle id of the app: com.sinain.hud
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BUNDLE="com.sinain.hud"
APPLY=false; WIPE_OLLAMA=false; WIPE_OPENCLAW=true
for a in "$@"; do
  case "$a" in
    --yes|-y) APPLY=true ;;
    --ollama) WIPE_OLLAMA=true ;;
    --keep-openclaw) WIPE_OPENCLAW=false ;;
    *) echo "unknown flag: $a"; exit 64 ;;
  esac
done

# Safety: never operate without a real HOME.
[ -n "${HOME:-}" ] && [ "$HOME" != "/" ] || { echo "refusing to run: HOME is unset or /"; exit 1; }

B="\033[1m"; G="\033[0;32m"; Y="\033[0;33m"; R="\033[0;31m"; X="\033[0m"
$APPLY || echo -e "${Y}DRY RUN${X} — nothing will be deleted. Re-run with ${B}--yes${X} to apply.\n"

# run <description> <command...>  — echo always; execute only when --yes.
run() {
  local desc="$1"; shift
  echo -e "  ${desc}"
  $APPLY && "$@" >/dev/null 2>&1 || true
}
rmrf() { # rmrf <path...> — guard against empty args
  for p in "$@"; do
    [ -n "$p" ] || continue
    [ -e "$p" ] || [ -L "$p" ] || continue
    echo -e "    ${R}rm${X} $p"
    $APPLY && rm -rf "$p" 2>/dev/null || true
  done
}

echo -e "${B}1. Stop running Sinain processes${X}"
for pat in "Sinain.app" "@geravant/sinain" "sinain-core/dist/index.js" "tsx.*src/index.ts" \
           "sense_client" "sck-capture" "sinain-agent-runner/run.sh" "bash run.sh" \
           "openrouter-proxy" ".sinain/python/bin/python3" "whisper-cli" "launch-backend.sh"; do
  run "pkill -f '${pat}'" pkill -f "$pat"
done
sleep 1

echo -e "${B}2. Remove the installed app${X}"
rmrf "/Applications/Sinain.app" "$HOME/Applications/Sinain.app" \
     "$HOME/.sinain/overlay" "$HOME/.sinain/sinain_hud.app"

echo -e "${B}3. Remove Sinain data + config (~/.sinain — env, agents, memory, models, python, provisioning, logs)${X}"
rmrf "$HOME/.sinain"

echo -e "${B}4. Remove the knowledge workspace${X}"
if $WIPE_OPENCLAW; then
  rmrf "$HOME/.openclaw"
else
  echo -e "    ${Y}--keep-openclaw${X}: removing only the sinain knowledge bits"
  rmrf "$HOME/.openclaw/workspace/memory" "$HOME/.openclaw/workspace/SITUATION.md" \
       "$HOME/.openclaw/workspace/sinain-memory"
fi

echo -e "${B}5. Remove the app's macOS state (prefs, sandbox container, caches — ${BUNDLE})${X}"
rmrf "$HOME/Library/Containers/${BUNDLE}" \
     "$HOME/Library/Preferences/${BUNDLE}.plist" \
     "$HOME/Library/Caches/${BUNDLE}" \
     "$HOME/Library/HTTPStorages/${BUNDLE}" \
     "$HOME/Library/WebKit/${BUNDLE}" \
     "$HOME/Library/Application Support/${BUNDLE}" \
     "$HOME/Library/Saved Application State/${BUNDLE}.savedState" \
     "$HOME/Library/LaunchAgents/${BUNDLE}.plist"

echo -e "${B}6. Reset macOS permission prompts (so first run re-asks)${X}"
for svc in ScreenCapture Accessibility Microphone ListenEvent; do
  run "tccutil reset ${svc} ${BUNDLE}" tccutil reset "$svc" "$BUNDLE"
done

echo -e "${B}7. Clear the npx cache for @geravant/sinain${X}"
if [ -d "$HOME/.npm/_npx" ]; then
  while IFS= read -r d; do
    root="$(dirname "$(dirname "$(dirname "$d")")")"
    rmrf "$root"
  done < <(find "$HOME/.npm/_npx" -maxdepth 5 -type d -path '*@geravant/sinain' 2>/dev/null)
fi

if $WIPE_OLLAMA; then
  echo -e "${B}8. Remove local Ollama models (phi4-mini, qwen2.5vl:7b)${X}"
  if command -v ollama >/dev/null 2>&1; then
    for m in phi4-mini qwen2.5vl:7b; do
      echo -e "    ${R}ollama rm${X} $m"
      $APPLY && ollama rm "$m" >/dev/null 2>&1 || true
    done
  else
    echo "    ollama not installed — skipping"
  fi
else
  echo -e "${B}8. Ollama models — ${Y}kept${X} (pass --ollama to remove; multi-GB re-pull)"
fi

echo ""
if $APPLY; then
  echo -e "${B}Verifying clean state:${X}"
  chk() { [ ! -e "$1" ] && echo -e "  ${G}✓${X} $2" || echo -e "  ${R}✗ STILL EXISTS${X} $2 ($1)"; }
  chk "$HOME/.sinain" "~/.sinain"
  $WIPE_OPENCLAW && chk "$HOME/.openclaw" "~/.openclaw"
  chk "/Applications/Sinain.app" "/Applications/Sinain.app"
  chk "$HOME/Applications/Sinain.app" "~/Applications/Sinain.app"
  chk "$HOME/Library/Containers/${BUNDLE}" "sandbox container"
  chk "$HOME/Library/Preferences/${BUNDLE}.plist" "preferences"
  echo -e "\n${G}Clean slate ready.${X} Open Sinain.dmg, drag to Applications, and launch for a true first run."
else
  echo -e "${Y}Dry run complete.${X} Re-run with ${B}bash clean-slate.sh --yes${X} to apply."
fi
