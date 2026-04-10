#!/usr/bin/env bash
# PreToolUse hook for spawn subagents.
# Only intercepts when SINAIN_SPAWN=1 (set by run.sh for spawn invocations).
# Regular user Claude sessions are unaffected — hook exits immediately.

[ -z "$SINAIN_SPAWN" ] && exit 0

CORE_URL="${SINAIN_CORE_URL:-http://localhost:9500}"

# Read hook input from stdin, forward to sinain-core for overlay approval
RESPONSE=$(curl -sf -X POST "$CORE_URL/spawn/approve" \
  -H 'Content-Type: application/json' \
  --max-time 130 \
  -d @- 2>/dev/null)

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE"
else
  # If sinain-core is unreachable, allow by default (don't block the agent)
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"sinain-core unreachable, auto-allowing"}}'
fi
