#!/usr/bin/env bash
# Batch-replay a folder of call recordings through the real ARSinain teleprompter
# and capture ALL sinain output, one directory per call, for post-hoc eval.
#
# Each call is streamed over WebRTC by bridge.py (--audio-file) at realtime; the
# guide lines ARSinain sends back are captured as untruncated JSONL (meta.jsonl)
# plus the spoken guide as a wav (guide-tts.wav). Runs N calls in parallel.
#
#   ./replay-eval.sh [CORPUS_DIR]
#
# Env knobs:
#   SERVER    ARSinain base URL           (default: paired server, else ARSINAIN_URL, else https://ar.sinain.com)
#   PARALLEL  concurrent calls            (default: 1 — the server allows ONE session per account)
#   FPS       screen publish rate         (default: 1 — audio-only, black frame)
#   SLACK     max-seconds = dur + SLACK   (default: 180)
#   SETTLE    seconds to wait between calls for server-side session teardown (default: 8)
#   RETRIES   per-call retries on 429 "session already running" (default: 6)
#   OUT       output root                 (default: <corpus>/../logs)
#
# NOTE: ARSinain permits only ONE live session per account, so PARALLEL>1 makes
# every concurrent offer 429. Keep PARALLEL=1 unless you know the cap was raised.
set -uo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$BRIDGE_DIR/.venv/bin/python"
[ -x "$PY" ] || PY="python3"

CORPUS="${1:-/Users/Igor.Gerasimov/IdeaProjects/sinain-hud-2/.live-teleprompter-eval/drive-download-20260722T082435Z-1-001}"
PARALLEL="${PARALLEL:-1}"
FPS="${FPS:-1}"
SLACK="${SLACK:-180}"
SETTLE="${SETTLE:-8}"
RETRIES="${RETRIES:-6}"
PAIR="$HOME/.sinain/arsinain-session.json"

# ── Auth + server from the same pair store VoiceSessionManager uses ──
read_pair() { [ -f "$PAIR" ] && "$PY" -c "import json,sys;print(json.load(open('$PAIR')).get('$1','') or '')" 2>/dev/null || echo ""; }
TOKEN="$(read_pair token)"
EMAIL="$(read_pair email)"
PAIR_SERVER="$(read_pair server)"
SERVER="${SERVER:-${PAIR_SERVER:-${ARSINAIN_URL:-https://ar.sinain.com}}}"

RUN_TS="$(date +%Y%m%dT%H%M%S)"
OUT_ROOT="${OUT:-$(cd "$CORPUS/.." && pwd)/logs}/$RUN_TS"
mkdir -p "$OUT_ROOT"
RUN_LOG="$OUT_ROOT/replay-eval.log"

# A black frame the ScreenTrack falls back to for these audio-only calls.
BLANK_FRAME="$OUT_ROOT/.blank.frame"; : > "$BLANK_FRAME"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RUN_LOG"; }

log "corpus=$CORPUS"
log "server=$SERVER  email=${EMAIL:-<none>}  token=$([ -n "$TOKEN" ] && echo present || echo MISSING)"
log "parallel=$PARALLEL  fps=$FPS  settle=${SETTLE}s  retries=$RETRIES  out=$OUT_ROOT"
[ "$PARALLEL" -gt 1 ] && log "WARNING: PARALLEL=$PARALLEL but the server allows one session per account — expect 429s"

# ── Pre-flight: is the server/token good, and is the account free? ──
# POST /offer with an empty body: a free+authed account 500s (bad SDP); a login
# wall 3xx/401/403s; a busy account 429s ("session already running").
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        ${TOKEN:+-H "X-Sinain-Device: $TOKEN"} ${EMAIL:+-H "X-Auth-Request-Email: $EMAIL"} \
        -X POST -H 'Content-Type: application/json' -d '{}' "$SERVER/offer" 2>/dev/null || echo 000)"
log "pre-flight POST $SERVER/offer -> HTTP $CODE"
case "$CODE" in
  000) log "FATAL: cannot reach $SERVER — is ARSinain up?"; exit 1 ;;
  301|302|303|307|308|401|403) log "FATAL: $SERVER wants a login (HTTP $CODE) — re-pair the HUD (device token rejected)"; exit 1 ;;
  429) log "FATAL: account already has a live Sinain session (HTTP 429) — close your running HUD/voice call first"; exit 1 ;;
  *) log "pre-flight OK (server answered /offer; a 400/422/500 on empty body is expected)" ;;
esac

shopt -s nullglob
MP3S=("$CORPUS"/*.mp3)
log "found ${#MP3S[@]} calls"

run_one() {
  local mp3="$1"
  local name; name="$(basename "$mp3" .mp3)"
  local dir="$OUT_ROOT/$name"; mkdir -p "$dir"
  local dur; dur="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$mp3" 2>/dev/null)"
  local maxs; maxs="$("$PY" -c "print(round(float('${dur:-0}')+$SLACK))")"
  local start_iso; start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  log "START  $name  (${dur%.*}s audio, ceiling ${maxs}s)"
  local rc=1 attempt=0
  while :; do
    attempt=$((attempt+1))
    "$PY" "$BRIDGE_DIR/bridge.py" \
        --server "$SERVER" \
        --audio-file "$mp3" \
        --frame "$BLANK_FRAME" \
        --fps "$FPS" \
        --max-seconds "$maxs" \
        ${TOKEN:+--device-token "$TOKEN"} \
        ${EMAIL:+--email "$EMAIL"} \
        --meta-log "$dir/meta.jsonl" \
        --record-audio "$dir/guide-tts.wav" \
        > "$dir/bridge.stdout.log" 2>&1
    rc=$?
    # Retry only the "session still reaping" race — a 429 right after the prior
    # call closed. Any other outcome (success or a real error) is final.
    if grep -q "signaling 429" "$dir/bridge.stdout.log" 2>/dev/null && [ "$attempt" -le "$RETRIES" ]; then
      log "RETRY  $name  429 (attempt $attempt/$RETRIES) — waiting ${SETTLE}s for teardown"
      : > "$dir/meta.jsonl"; sleep "$SETTLE"; continue
    fi
    break
  done
  local end_iso; end_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local meta_lines; meta_lines="$(wc -l < "$dir/meta.jsonl" 2>/dev/null | tr -d ' ')"
  local wav_bytes;  wav_bytes="$(stat -f%z "$dir/guide-tts.wav" 2>/dev/null || echo 0)"

  "$PY" - "$dir/manifest.json" "$name" "$mp3" "$SERVER" "$dur" "$start_iso" "$end_iso" "$rc" "${meta_lines:-0}" "$wav_bytes" <<'PYEOF'
import json,sys
p,name,mp3,server,dur,s,e,rc,meta,wav = sys.argv[1:11]
json.dump({"call":name,"mp3":mp3,"server":server,"duration_s":float(dur or 0),
          "start":s,"end":e,"exit_code":int(rc),"meta_lines":int(meta),
          "guide_wav_bytes":int(wav)}, open(p,"w"), indent=2)
PYEOF
  log "DONE   $name  rc=$rc  meta_lines=${meta_lines:-0}  wav_bytes=$wav_bytes"
  # Let the server reap this session before the next call claims the slot.
  sleep "$SETTLE"
}
export -f run_one log
export PY BRIDGE_DIR SERVER TOKEN EMAIL FPS SLACK SETTLE RETRIES OUT_ROOT BLANK_FRAME RUN_LOG

# ── Parallel pool (xargs -P) ──
printf '%s\0' "${MP3S[@]}" | xargs -0 -P "$PARALLEL" -I{} bash -c 'run_one "$@"' _ {}

log "ALL DONE — summary:"
for m in "$OUT_ROOT"/*/manifest.json; do
  "$PY" -c "import json;d=json.load(open('$m'));print(f\"  {d['call']:<40} rc={d['exit_code']} meta={d['meta_lines']:>4} wav={d['guide_wav_bytes']}\")"
done | tee -a "$RUN_LOG"
log "logs in $OUT_ROOT"
