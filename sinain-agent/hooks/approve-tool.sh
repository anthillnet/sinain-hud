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

# Read hook input from stdin. Claude Code / openclaude typically include
# session_id per the PreToolUse contract; if missing (or if we want a sinain-
# native correlation), inject SINAIN_SPAWN_TASK_ID / SINAIN_ESC_TASK_ID as
# sinainTaskId so the server can still key YOLO on a stable id per invocation.
HOOK_STDIN=$(cat)
SINAIN_TASK_ID="${SINAIN_SPAWN_TASK_ID:-${SINAIN_ESC_TASK_ID:-}}"
if [ -n "$SINAIN_TASK_ID" ] && command -v python3 >/dev/null 2>&1; then
  HOOK_STDIN=$(printf '%s' "$HOOK_STDIN" | SINAIN_TASK_ID="$SINAIN_TASK_ID" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
    if isinstance(d, dict) and not d.get("sinainTaskId"):
        d["sinainTaskId"] = os.environ["SINAIN_TASK_ID"]
    print(json.dumps(d))
except Exception:
    # On any parse failure, pass original through — server can still work
    sys.stdout.write(os.environ.get("HOOK_STDIN_FALLBACK", ""))
')
fi

RESPONSE=$(printf '%s' "$HOOK_STDIN" | curl -sf -X POST "$CORE_URL/spawn/approve" \
  -H 'Content-Type: application/json' \
  --max-time 130 \
  --data-binary @- 2>/dev/null)

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE"
else
  # If sinain-core is unreachable, allow by default (don't block the agent)
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"sinain-core unreachable, auto-allowing"}}'
fi
