#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_CONFIG="$SCRIPT_DIR/mcp-config.json"
CORE_URL="${SINAIN_CORE_URL:-http://localhost:9500}"
POLL_INTERVAL="${SINAIN_POLL_INTERVAL:-5}"
HEARTBEAT_INTERVAL="${SINAIN_HEARTBEAT_INTERVAL:-900}" # 15 minutes

# Verify sinain-core is running
if ! curl -sf "$CORE_URL/health" > /dev/null 2>&1; then
  echo "ERROR: sinain-core is not running at $CORE_URL"
  echo "Start it first: cd sinain-core && npm run dev"
  exit 1
fi

# Verify MCP server dependencies
if [ ! -d "$SCRIPT_DIR/../sinain-mcp-server/node_modules" ]; then
  echo "Installing sinain-mcp-server dependencies..."
  (cd "$SCRIPT_DIR/../sinain-mcp-server" && npm install)
fi

echo "sinain bare agent started"
echo "  Core: $CORE_URL"
echo "  Poll: every ${POLL_INTERVAL}s"
echo "  Heartbeat: every ${HEARTBEAT_INTERVAL}s"
echo "  Press Ctrl+C to stop"
echo ""

LAST_HEARTBEAT=$(date +%s)
ESCALATION_COUNT=0

cleanup() {
  echo ""
  echo "Agent stopped. Escalations handled: $ESCALATION_COUNT"
  exit 0
}
trap cleanup INT TERM

while true; do
  # Poll for pending escalation
  ESC=$(curl -sf "$CORE_URL/escalation/pending" 2>/dev/null || echo '{"ok":false}')
  ESC_ID=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); e=d.get('escalation'); print(e['id'] if e else '')" 2>/dev/null || true)

  if [ -n "$ESC_ID" ]; then
    ESC_MSG=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation']['message'])" 2>/dev/null)
    ESC_SCORE=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation'].get('score','?'))" 2>/dev/null)
    ESC_CODING=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation'].get('codingContext',False))" 2>/dev/null)

    echo "[$(date +%H:%M:%S)] Escalation $ESC_ID (score=$ESC_SCORE, coding=$ESC_CODING)"

    # Invoke Claude to respond to this specific escalation
    RESPONSE=$(claude --dangerously-skip-permissions \
      --mcp-config "$MCP_CONFIG" \
      --max-turns 5 \
      --output-format text \
      -p "You are the sinain HUD agent. An escalation is pending with ID=$ESC_ID.

Call sinain_get_escalation to see the full context, then call sinain_respond with the ID and your response.

Response guidelines: 5-10 sentences, address errors first, reference specific screen/audio context, never NO_REPLY. Max 4000 chars for coding context, 3000 otherwise." 2>/dev/null || echo "ERROR: claude invocation failed")

    ESCALATION_COUNT=$((ESCALATION_COUNT + 1))
    echo "[$(date +%H:%M:%S)] Responded ($ESCALATION_COUNT total): ${RESPONSE:0:120}..."
    echo ""
  fi

  # Heartbeat check
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_HEARTBEAT))
  if [ "$ELAPSED" -ge "$HEARTBEAT_INTERVAL" ]; then
    echo "[$(date +%H:%M:%S)] Running heartbeat tick..."
    claude --dangerously-skip-permissions \
      --mcp-config "$MCP_CONFIG" \
      --max-turns 8 \
      --output-format text \
      -p "You are the sinain HUD agent. Run the heartbeat cycle:
1. Call sinain_heartbeat_tick with a brief session summary
2. If the result contains a suggestion, post it to HUD via sinain_post_feed
3. Call sinain_get_feedback to review recent scores" 2>/dev/null || true
    LAST_HEARTBEAT=$NOW
    echo "[$(date +%H:%M:%S)] Heartbeat complete"
    echo ""
  fi

  sleep "$POLL_INTERVAL"
done
