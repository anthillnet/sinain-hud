#!/usr/bin/env bash
set -euo pipefail

# ── Meeting Memory Benchmark — end-to-end capture + evaluate ─────────────────
# 1. Opens meeting recording fullscreen in QuickTime
# 2. Starts sinain (audio + sense capture, no agent, no overlay)
# 3. Waits for recording to finish
# 4. Stops sinain → saves pending session
# 5. Restarts sinain → distills pending session into knowledge graph
# 6. Runs evaluation harness against the distilled DB
#
# Usage: ./run_meeting_bench.sh <mp4_path>
# Output: eval/benchmarks/results/meeting_results.md

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SINAIN_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
KOOG_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

log()  { echo -e "${BOLD}[bench]${RESET} $*"; }
ok()   { echo -e "${BOLD}[bench]${RESET} ${GREEN}✓${RESET} $*"; }
warn() { echo -e "${BOLD}[bench]${RESET} ${YELLOW}⚠${RESET} $*"; }
fail() { echo -e "${BOLD}[bench]${RESET} ${RED}✗${RESET} $*"; exit 1; }

# ── Args ─────────────────────────────────────────────────────────────────────
RECORDING="${1:-}"
if [ -z "$RECORDING" ] || [ ! -f "$RECORDING" ]; then
  fail "Usage: $0 <path-to-mp4>"
fi

# ── Setup ────────────────────────────────────────────────────────────────────
BENCH_DIR="/tmp/sinain-bench-$(date +%s)"
mkdir -p "$BENCH_DIR"
log "Benchmark directory: ${CYAN}${BENCH_DIR}${RESET}"

# Source .env for API keys and audio config (safe parser from start-local.sh)
for _env_file in "$SINAIN_ROOT/.env" "$SINAIN_ROOT/sinain-core/.env" "$HOME/.sinain/.env"; do
  if [ -f "$_env_file" ]; then
    log "Loading $_env_file"
    while IFS='=' read -r _k _v; do
      [[ -z "$_k" || "$_k" =~ ^[[:space:]]*# ]] && continue
      _k=$(echo "$_k" | xargs)
      _v=$(echo "$_v" | xargs)
      _v="${_v%%#*}"
      _v=$(echo "$_v" | xargs)
      [[ -z "$_v" ]] && continue
      if [ -z "${!_k+x}" ]; then export "$_k=$_v"; fi
    done < "$_env_file"
    break
  fi
done

# Bench-specific overrides
export SINAIN_MEMORY_DIR="$BENCH_DIR"
export AGENT_ENABLED=false
export ESCALATION_MODE=off

# Local whisper setup (from start-local.sh)
MODEL_DIR="$HOME/models"
MODEL_NAME="ggml-large-v3-turbo.bin"
export LOCAL_WHISPER_MODEL="${LOCAL_WHISPER_MODEL:-$MODEL_DIR/$MODEL_NAME}"
export LOCAL_WHISPER_BIN="${LOCAL_WHISPER_BIN:-whisper-cli}"
export TRANSCRIPTION_BACKEND=local

# ── Get recording duration ───────────────────────────────────────────────────
DURATION_RAW=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RECORDING" 2>/dev/null || echo "")
if [ -n "$DURATION_RAW" ]; then
  DURATION=$(echo "$DURATION_RAW" | cut -d. -f1)
else
  DURATION=1620  # fallback: 27 min
fi
log "Recording duration: ${DURATION}s (~$((DURATION / 60))m)"

# ── Cleanup handler ──────────────────────────────────────────────────────────
CORE_PID=""
SENSE_PID=""

cleanup() {
  log "Cleaning up..."
  [ -n "$SENSE_PID" ] && kill "$SENSE_PID" 2>/dev/null || true
  [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true
  sleep 2
  [ -n "$SENSE_PID" ] && kill -9 "$SENSE_PID" 2>/dev/null || true
  [ -n "$CORE_PID" ] && kill -9 "$CORE_PID" 2>/dev/null || true
  # Kill anything on port 9500
  lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  # Close QuickTime
  osascript -e 'tell application "QuickTime Player" to quit' 2>/dev/null || true
}
trap cleanup EXIT

# ── Kill stale sinain processes ──────────────────────────────────────────────
log "Killing stale processes..."
pkill -f "tsx.*src/index.ts" 2>/dev/null || true
pkill -f "python3 -m sense_client" 2>/dev/null || true
pkill -f "Python -m sense_client" 2>/dev/null || true
pkill -f "tools/sck-capture/sck-capture" 2>/dev/null || true
lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 2

# ── Phase 1a: Open video fullscreen ─────────────────────────────────────────
log "Opening recording in QuickTime (fullscreen)..."
open -a "QuickTime Player" "$RECORDING"
sleep 3
osascript -e '
tell application "QuickTime Player"
  present front document
  delay 1
  play front document
end tell
' 2>/dev/null || warn "Could not auto-play — check QuickTime"
ok "Video playing fullscreen"

# ── Phase 1b: Start sinain-core ──────────────────────────────────────────────
log "Starting sinain-core (capture-only, local whisper)..."
(cd "$SINAIN_ROOT/sinain-core" && npx tsx src/index.ts 2>&1) | \
  sed -u "s/^/$(printf "${CYAN}[core]${RESET}    ")/" &
CORE_PID=$!

# Wait for health
CORE_OK=false
for i in $(seq 1 20); do
  if curl -sf http://localhost:9500/health >/dev/null 2>&1; then
    CORE_OK=true
    break
  fi
  sleep 1
done
if $CORE_OK; then
  ok "sinain-core healthy on :9500"
else
  fail "sinain-core did not start"
fi

# ── Phase 1c: Start sense_client ─────────────────────────────────────────────
log "Starting sense_client (screen capture + OCR)..."

# Propagate privacy mode
export PRIVACY_OCR_OPENROUTER="${PRIVACY_OCR_OPENROUTER:-full}"
export PRIVACY_IMAGES_OPENROUTER="${PRIVACY_IMAGES_OPENROUTER:-full}"

(cd "$SINAIN_ROOT" && python3 -m sense_client 2>&1) | \
  sed -u "s/^/$(printf "${YELLOW}[sense]${RESET}   ")/" &
SENSE_PID=$!
sleep 2

if kill -0 "$SENSE_PID" 2>/dev/null; then
  ok "sense_client running"
else
  warn "sense_client failed to start — continuing with audio only"
  SENSE_PID=""
fi

# ── Phase 1d: Wait for recording to finish ───────────────────────────────────
BUFFER=60  # extra time for trailing transcription/OCR
TOTAL_WAIT=$((DURATION + BUFFER))
log "Waiting ${TOTAL_WAIT}s for recording + buffer..."
log "  (recording ends at $(date -v+${DURATION}S '+%H:%M:%S'), buffer until $(date -v+${TOTAL_WAIT}S '+%H:%M:%S'))"

# Progress updates every 5 minutes
ELAPSED=0
while [ $ELAPSED -lt $TOTAL_WAIT ]; do
  SLEEP_CHUNK=300
  if [ $((ELAPSED + SLEEP_CHUNK)) -gt $TOTAL_WAIT ]; then
    SLEEP_CHUNK=$((TOTAL_WAIT - ELAPSED))
  fi
  sleep $SLEEP_CHUNK
  ELAPSED=$((ELAPSED + SLEEP_CHUNK))
  REMAINING=$((TOTAL_WAIT - ELAPSED))
  if [ $REMAINING -gt 0 ]; then
    # Check feed count
    FEED_COUNT=$(curl -sf http://localhost:9500/feed 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('messages',[])))" 2>/dev/null || echo "?")
    log "  ${ELAPSED}s elapsed, ${REMAINING}s remaining — feed items: ${FEED_COUNT}"
  fi
done

ok "Recording capture complete"

# Check what we captured
FEED_COUNT=$(curl -sf http://localhost:9500/feed 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('messages',[])))" 2>/dev/null || echo "?")
log "Captured ${FEED_COUNT} feed items"

# ── Phase 1e: Stop sinain (saves pending session) ───────────────────────────
log "Stopping sinain (saving pending session)..."
[ -n "$SENSE_PID" ] && kill "$SENSE_PID" 2>/dev/null || true
SENSE_PID=""

# Send SIGINT directly to the tsx/node process (not the pipe wrapper)
# The pipe means $CORE_PID is sed, not tsx — so we pkill the actual process
pkill -INT -f "tsx src/index.ts" 2>/dev/null || true
log "Sent SIGINT to tsx, waiting for graceful shutdown..."
sleep 10

# Force if still alive
pkill -9 -f "tsx src/index.ts" 2>/dev/null || true
kill -9 "$CORE_PID" 2>/dev/null || true
CORE_PID=""
lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 2

# Close QuickTime
osascript -e 'tell application "QuickTime Player" to quit' 2>/dev/null || true

# Verify pending session was saved (or inline distillation already consumed it)
if [ -f "$BENCH_DIR/pending-session.json" ]; then
  PENDING_ITEMS=$(python3 -c "import json; print(len(json.load(open('$BENCH_DIR/pending-session.json')).get('items',[])))" 2>/dev/null || echo "?")
  ok "Pending session saved: ${PENDING_ITEMS} items"
elif [ -f "$BENCH_DIR/knowledge-graph.db" ]; then
  ok "Inline distillation completed (pending-session.json already consumed)"
else
  warn "No pending-session.json and no knowledge-graph.db — will retry with longer shutdown"
  # Try again: start core briefly, let it capture a few items, then shut down gracefully
  log "Starting core for a brief capture + shutdown cycle..."
  (cd "$SINAIN_ROOT/sinain-core" && npx tsx src/index.ts 2>&1) > /tmp/sinain-bench-retry.log &
  RETRY_PID=$!
  sleep 15  # let it start and capture a few items
  # Get the actual node PID and send SIGINT
  NODE_PID=$(pgrep -f "tsx src/index.ts" 2>/dev/null | head -1 || true)
  if [ -n "$NODE_PID" ]; then
    kill -INT "$NODE_PID" 2>/dev/null || true
    sleep 10
    kill -9 "$NODE_PID" 2>/dev/null || true
  fi
  kill -9 "$RETRY_PID" 2>/dev/null || true
  lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 2
  if [ -f "$BENCH_DIR/pending-session.json" ] || [ -f "$BENCH_DIR/knowledge-graph.db" ]; then
    ok "Recovery succeeded"
  else
    fail "Could not capture any session data"
  fi
fi

# ── Phase 1f: Restart for distillation ───────────────────────────────────────
log "Restarting sinain-core for distillation..."
(cd "$SINAIN_ROOT/sinain-core" && npx tsx src/index.ts 2>&1) | \
  sed -u "s/^/$(printf "${CYAN}[core]${RESET}    ")/" &
CORE_PID=$!

# Wait for health
for i in $(seq 1 20); do
  if curl -sf http://localhost:9500/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Wait for distillation to complete (knowledge-graph.db appears or grows)
log "Waiting for distillation..."
for i in $(seq 1 120); do
  if [ -f "$BENCH_DIR/knowledge-graph.db" ]; then
    DB_SIZE=$(stat -f%z "$BENCH_DIR/knowledge-graph.db" 2>/dev/null || echo "0")
    if [ "$DB_SIZE" -gt 4096 ]; then
      ok "Distillation complete (DB: ${DB_SIZE} bytes)"
      break
    fi
  fi
  # Also check if pending-session.json is gone (distillation consumed it)
  if [ ! -f "$BENCH_DIR/pending-session.json" ] && [ -f "$BENCH_DIR/knowledge-graph.db" ]; then
    DB_SIZE=$(stat -f%z "$BENCH_DIR/knowledge-graph.db" 2>/dev/null || echo "0")
    ok "Distillation complete (DB: ${DB_SIZE} bytes)"
    break
  fi
  sleep 5
done

# Keep core running for /embed endpoint during evaluation
log "Keeping sinain-core running for embedding service during evaluation..."

# ── Phase 2: Evaluate ────────────────────────────────────────────────────────
log ""
log "═══════════════════════════════════════════════"
log "  Phase 2: Evaluation"
log "═══════════════════════════════════════════════"
log ""

DB_PATH="$BENCH_DIR/knowledge-graph.db"
if [ ! -f "$DB_PATH" ]; then
  fail "No knowledge-graph.db found — distillation may have failed"
fi

# Show what's in the DB
log "Knowledge graph contents:"
cd "$KOOG_DIR"
python3 -c "
from triplestore import TripleStore
ts = TripleStore('$DB_PATH')
facts = ts.all_facts()
print(f'  Total facts: {len(facts)}')
entities = set()
for f in facts:
    entities.add(f.get('entity', ''))
print(f'  Unique entities: {len(entities)}')
for e in sorted(entities)[:10]:
    print(f'    - {e}')
if len(entities) > 10:
    print(f'    ... and {len(entities) - 10} more')
" 2>/dev/null || warn "Could not inspect DB"

# Run evaluation
log "Running QA evaluation..."
python3 eval/benchmarks/meeting_runner.py \
    --db "$DB_PATH" \
    --conditions sinain-memory,full-context \
    --format json,markdown

log ""
log "═══════════════════════════════════════════════"
log "  Done!"
log "  Results: eval/benchmarks/results/meeting_results.md"
log "  DB: $DB_PATH"
log "═══════════════════════════════════════════════"
