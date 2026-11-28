#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_CONFIG="$SCRIPT_DIR/mcp-config.json"

# Verify sinain-core is running
if ! curl -sf http://localhost:9500/health > /dev/null 2>&1; then
  echo "ERROR: sinain-core is not running on port 9500"
  echo "Start it first: cd sinain-core && npm run dev"
  exit 1
fi

# Verify MCP server dependencies
if [ ! -d "$SCRIPT_DIR/../sinain-mcp-server/node_modules" ]; then
  echo "Installing sinain-mcp-server dependencies..."
  (cd "$SCRIPT_DIR/../sinain-mcp-server" && npm install)
fi

echo "Starting sinain bare agent..."
echo "  MCP config: $MCP_CONFIG"
echo "  Core URL: http://localhost:9500"

exec claude --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG" \
  -p "You are the sinain HUD agent. Begin your main loop: call sinain_get_escalation to check for pending escalations. If none, wait and poll again. Run sinain_heartbeat_tick every 15 minutes. Refer to your CLAUDE.md for full instructions."
