#!/bin/bash
# Push a message to the SinainHUD overlay
# Usage: hud-push.sh "message text" [priority]
# Priority: normal (default), high, urgent

TEXT="${1:?Usage: hud-push.sh \"message\" [normal|high|urgent]}"
PRIORITY="${2:-normal}"
RELAY="http://localhost:18791"

curl -s -X POST "$RELAY/feed" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":$(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),\"priority\":\"$PRIORITY\"}"
