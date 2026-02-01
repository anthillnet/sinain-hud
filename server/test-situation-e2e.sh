#!/usr/bin/env bash
# E2E test for SITUATION.md writer + escalation pipeline.
# Tests that the relay writes SITUATION.md after an agent tick.
#
# Prerequisites: OPENROUTER_API_KEY must be set.
# Usage: OPENROUTER_API_KEY=sk-... bash server/test-situation-e2e.sh

set -euo pipefail

RELAY="server/hud-relay.mjs"
PORT=18799  # Use non-default port to avoid conflicts
TMP_WORKSPACE=$(mktemp -d)
RELAY_PID=""

cleanup() {
  if [ -n "$RELAY_PID" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_WORKSPACE"
  echo "[cleanup] done"
}
trap cleanup EXIT

echo "=== SITUATION.md E2E Test ==="
echo "  Workspace: $TMP_WORKSPACE"
echo "  Port: $PORT"
echo ""

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "FAIL: OPENROUTER_API_KEY not set"
  exit 1
fi

# ── Step 1: Start relay with SITUATION.md enabled ──
echo "[1/5] Starting relay..."
AGENT_ENABLED=true \
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  SITUATION_MD_ENABLED=true \
  OPENCLAW_WORKSPACE_DIR="$TMP_WORKSPACE" \
  ESCALATION_MODE=off \
  node "$RELAY" &
RELAY_PID=$!

# Wait for relay to start
sleep 2
if ! kill -0 "$RELAY_PID" 2>/dev/null; then
  echo "FAIL: relay did not start"
  exit 1
fi

# Override port via a quick health check
HEALTH=$(curl -sf "http://localhost:18791/health" 2>/dev/null || echo "")
if [ -z "$HEALTH" ]; then
  echo "FAIL: relay not responding on port 18791"
  exit 1
fi
echo "  Relay started (PID=$RELAY_PID)"

# ── Step 2: Send a test sense event ──
echo "[2/5] Sending test sense event..."
SENSE_RESP=$(curl -sf -X POST "http://localhost:18791/sense" \
  -H 'Content-Type: application/json' \
  -d "{
    \"type\": \"text\",
    \"ts\": $(date +%s)000,
    \"ocr\": \"function testSituation() { return 'hello world'; }\",
    \"meta\": {
      \"app\": \"IntelliJ IDEA\",
      \"ssim\": 0.85
    }
  }" 2>/dev/null || echo "")

if [ -z "$SENSE_RESP" ]; then
  echo "FAIL: sense POST failed"
  exit 1
fi
echo "  Sense event sent: $SENSE_RESP"

# ── Step 3: Wait for agent tick (poll /agent/digest) ──
echo "[3/5] Waiting for agent tick..."
MAX_WAIT=60
WAITED=0
DIGEST=""
while [ $WAITED -lt $MAX_WAIT ]; do
  DIGEST_RESP=$(curl -sf "http://localhost:18791/agent/digest" 2>/dev/null || echo "")
  if echo "$DIGEST_RESP" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    if (d.digest && d.digest.digest) process.exit(0);
    process.exit(1);
  " 2>/dev/null; then
    DIGEST="found"
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  echo "  ...waiting (${WAITED}s/${MAX_WAIT}s)"
done

if [ -z "$DIGEST" ]; then
  echo "FAIL: agent did not produce digest within ${MAX_WAIT}s"
  exit 1
fi
echo "  Agent tick completed"

# ── Step 4: Verify SITUATION.md exists and has expected content ──
echo "[4/5] Validating SITUATION.md..."
SITUATION_FILE="$TMP_WORKSPACE/SITUATION.md"

if [ ! -f "$SITUATION_FILE" ]; then
  echo "FAIL: SITUATION.md not found at $SITUATION_FILE"
  ls -la "$TMP_WORKSPACE/"
  exit 1
fi

FILE_SIZE=$(wc -c < "$SITUATION_FILE")
echo "  File exists ($FILE_SIZE bytes)"

ERRORS=0

check_contains() {
  if ! grep -q "$1" "$SITUATION_FILE" 2>/dev/null; then
    echo "  FAIL: missing '$1' in SITUATION.md"
    ERRORS=$((ERRORS + 1))
  else
    echo "  OK: contains '$1'"
  fi
}

check_contains "# Situation"
check_contains "## Digest"
check_contains "## Active Application"
check_contains "## Screen (OCR)"
check_contains "## Metadata"
check_contains "Auto-updated by sinain-hud relay at"

# Check file size is reasonable (200 bytes to 20KB)
if [ "$FILE_SIZE" -lt 200 ]; then
  echo "  FAIL: file too small ($FILE_SIZE bytes)"
  ERRORS=$((ERRORS + 1))
fi
if [ "$FILE_SIZE" -gt 20000 ]; then
  echo "  FAIL: file too large ($FILE_SIZE bytes)"
  ERRORS=$((ERRORS + 1))
fi

# ── Step 5: Check no .tmp file left behind ──
echo "[5/5] Checking atomic write..."
if [ -f "${SITUATION_FILE}.tmp" ]; then
  echo "  FAIL: .tmp file left behind"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: no .tmp residue"
fi

# ── Summary ──
echo ""
echo "--- SITUATION.md Content Preview ---"
head -20 "$SITUATION_FILE"
echo "..."
echo ""

if [ $ERRORS -gt 0 ]; then
  echo "=== FAIL: $ERRORS error(s) ==="
  exit 1
fi

echo "=== PASS: All checks passed ==="
