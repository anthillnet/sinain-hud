#!/usr/bin/env bash
# Poll the ARSinain account until its one session slot is free, then auto-launch
# the sequential replay-eval batch. Meant to run detached (nohup) — it survives
# the console and hands off to replay-eval.sh once the 429 clears.
#
#   ./wait-and-replay.sh
#
# Env knobs:
#   POLL_SECS   seconds between probes                 (default: 90)
#   MAX_WAIT_H  give up after this many hours of 429   (default: 6)
# plus everything replay-eval.sh honours (SERVER, PARALLEL, SETTLE, ...).
set -uo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$BRIDGE_DIR/.venv/bin/python"; [ -x "$PY" ] || PY="python3"
POLL_SECS="${POLL_SECS:-90}"
MAX_WAIT_H="${MAX_WAIT_H:-6}"
PAIR="$HOME/.sinain/arsinain-session.json"

read_pair() { [ -f "$PAIR" ] && "$PY" -c "import json;print(json.load(open('$PAIR')).get('$1','') or '')" 2>/dev/null || echo ""; }
TOKEN="$(read_pair token)"; EMAIL="$(read_pair email)"; PAIR_SERVER="$(read_pair server)"
SERVER="${SERVER:-${PAIR_SERVER:-${ARSINAIN_URL:-https://ar.sinain.com}}}"

PROBE_CLIP="/private/tmp/claude-602/-Users-Igor-Gerasimov-IdeaProjects-sinain-hud-2/9cae5921-838e-4134-ba36-572da7376387/scratchpad/smoke/smoke.mp3"
PROBE_LOG="$(mktemp -t arsinain-probe.XXXXXX)"
say() { echo "[$(date +%H:%M:%S)] WAIT: $*"; }

say "polling $SERVER for a free session slot (every ${POLL_SECS}s, up to ${MAX_WAIT_H}h)"
[ -f "$PROBE_CLIP" ] || { say "FATAL: probe clip missing at $PROBE_CLIP"; exit 1; }

deadline=$(( $(date +%s) + MAX_WAIT_H*3600 ))
attempt=0
while :; do
  attempt=$((attempt+1))
  # A real (short) offer is the only reliable free/busy test: 429 ⇒ busy,
  # reaching "live" ⇒ free. The --max-seconds ceiling tears the probe down fast.
  "$PY" "$BRIDGE_DIR/bridge.py" \
      --server "$SERVER" --audio-file "$PROBE_CLIP" \
      --frame "/nonexistent.frame" --fps 1 --max-seconds 10 \
      ${TOKEN:+--device-token "$TOKEN"} ${EMAIL:+--email "$EMAIL"} \
      > "$PROBE_LOG" 2>&1

  if grep -q "AR-BRIDGE live" "$PROBE_LOG"; then
    say "ACCOUNT FREE (probe #$attempt reached live) — settling then launching batch"
    sleep "${SETTLE:-8}"
    exec "$BRIDGE_DIR/replay-eval.sh"
  elif grep -q "signaling 429" "$PROBE_LOG"; then
    say "BUSY (probe #$attempt: 429) — retrying in ${POLL_SECS}s"
  else
    say "probe #$attempt inconclusive: $(grep AR-BRIDGE "$PROBE_LOG" | tail -1 | cut -c1-120) — retrying in ${POLL_SECS}s"
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "GAVE UP: account still busy after ${MAX_WAIT_H}h — clear the session and re-run wait-and-replay.sh"
    exit 2
  fi
  sleep "$POLL_SECS"
done
