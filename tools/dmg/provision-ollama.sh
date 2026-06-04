#!/usr/bin/env bash
set -uo pipefail

# ── Provision Ollama models for full-local mode (T2) ─────────────────────────
# Ollama is a separate app the user installs (we don't bundle/redistribute it —
# SPEC §9 Q5). This detects it, ensures the server is up, and pulls the
# analyzer + vision SLMs (multi-GB). Logs to stdout (→ ~/.sinain/logs/backend.log).
#
# Exit codes: 0 = models ready, 2 = Ollama not installed (caller surfaces a
# prompt to install), 1 = a pull failed.

LLM="${SINAIN_LOCAL_LLM:-phi4-mini}"
VISION="${SINAIN_LOCAL_VISION:-qwen2.5vl:7b}"
HOST="${OLLAMA_HOST:-http://localhost:11434}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "[provision-ollama] Ollama is not installed."
  echo "[provision-ollama] Install it from https://ollama.com/download (or 'brew install ollama'), then relaunch Sinain."
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

rc=0
for model in "$LLM" "$VISION"; do
  if curl -sf "$HOST/api/tags" 2>/dev/null | grep -q "\"name\":\"${model}"; then
    echo "[provision-ollama] $model already present"
  else
    echo "[provision-ollama] pulling $model (multi-GB)…"
    if ! ollama pull "$model"; then
      echo "[provision-ollama] ✗ failed to pull $model"
      rc=1
    fi
  fi
done
[ "$rc" = 0 ] && echo "[provision-ollama] ✓ local models ready: $LLM, $VISION"
exit "$rc"
