#!/usr/bin/env bash
set -uo pipefail

# ── Provision Ollama models for full-local mode (T2) ─────────────────────────
# Ollama is a separate app the user installs (we don't bundle/redistribute it —
# SPEC §9 Q5). This detects it, ensures the server is up, and pulls the
# analyzer + vision SLMs (multi-GB). Logs to stdout (→ ~/.sinain/logs/backend.log).
#
# Exit codes: 0 = models ready, 2 = Ollama not installed (caller surfaces a
# prompt to install), 1 = a pull failed.

LLM="${SINAIN_LOCAL_LLM:-qwen2.5vl:7b}"
VISION="${SINAIN_LOCAL_VISION:-qwen2.5vl:7b}"
HOST="${OLLAMA_HOST:-http://localhost:11434}"

# Progress status the overlay reads.
PS="$HOME/.sinain/provisioning"
pstatus() { mkdir -p "$PS"; printf '%s|%s|%s\n' "$1" "${2:-}" "${3:-}" > "$PS/ollama.status"; }

if ! command -v ollama >/dev/null 2>&1; then
  echo "[provision-ollama] Ollama is not installed."
  echo "[provision-ollama] Install it from https://ollama.com/download (or 'brew install ollama'), then relaunch Sinain."
  pstatus error "" "Ollama not installed — see ollama.com/download"
  exit 2
fi

# Ensure the server is reachable; start it if needed.
if ! curl -sf "$HOST/api/tags" >/dev/null 2>&1; then
  echo "[provision-ollama] starting 'ollama serve'…"
  (ollama serve >/dev/null 2>&1 &)
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf "$HOST/api/tags" >/dev/null 2>&1 && break
    sleep 1
  done
fi
if ! curl -sf "$HOST/api/tags" >/dev/null 2>&1; then
  echo "[provision-ollama] ✗ Ollama server not reachable at $HOST"
  exit 1
fi

# One model can serve both lanes (qwen2.5vl:7b default) — pull it once.
if [ "$LLM" = "$VISION" ]; then MODELS="$LLM"; TOTAL=1; else MODELS="$LLM $VISION"; TOTAL=2; fi
idx=0
rc=0
for model in $MODELS; do
  idx=$((idx + 1))
  if curl -sf "$HOST/api/tags" 2>/dev/null | grep -q "\"name\":\"${model}"; then
    echo "[provision-ollama] $model already present"
    continue
  fi
  echo "[provision-ollama] pulling $model (multi-GB)…"
  pstatus active 0 "Downloading local model $idx/$TOTAL: $model"
  # Stream the pull via the API; a single python3 (stdlib json) translates each
  # progress frame into the overlay status file (per-layer completed/total %).
  curl -sN "$HOST/api/pull" -H 'Content-Type: application/json' \
       -d "{\"name\":\"$model\"}" 2>/dev/null \
  | python3 -c '
import sys, json, os
ps = os.path.expanduser("~/.sinain/provisioning"); os.makedirs(ps, exist_ok=True)
f = os.path.join(ps, "ollama.status"); label = sys.argv[1]
ok = False
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    if d.get("error"): break
    if d.get("status") == "success": ok = True
    c, t = d.get("completed"), d.get("total")
    pct = str(int(c * 100 / t)) if c and t else ""
    open(f, "w").write("active|%s|%s" % (pct, label))
sys.exit(0 if ok else 1)
' "Downloading local model $idx/$TOTAL: $model" || rc=1
  # Confirm it landed
  curl -sf "$HOST/api/tags" 2>/dev/null | grep -q "\"name\":\"${model}" || rc=1
done
if [ "$rc" = 0 ]; then
  echo "[provision-ollama] ✓ local models ready: $LLM, $VISION"
  pstatus done 100 "Local models ready"
else
  pstatus error "" "A local model failed to download"
fi
exit "$rc"
