#!/usr/bin/env bash
# PreToolUse hook for sinain-agent (escalation + spawn paths).
#
# Forwards every tool-invocation to sinain-core /spawn/approve which:
#   - auto-approves safe read-only tools (Read, Glob, Grep, Ls, Cat)
#   - auto-approves all mcp__sinain* tools
#   - routes everything else to the overlay for Allow/Deny
#
# Scoped to sinain-agent via --settings in run.sh: regular openclaude/claude
# sessions outside this directory don't load this settings.json and aren't
# affected. Previously this hook early-exited unless SINAIN_SPAWN=1 was set,
# which broke escalation-path write permissions (agent couldn't Bash/Edit).

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
