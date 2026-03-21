# Bare Knuckles Agent — Installation Guide

Run sinain-hud with **any coding agent** (Claude Code, Codex, Junie) instead of the OpenClaw gateway. The agent polls sinain-core via HTTP, responds to escalations on the HUD, and maintains a playbook through a local knowledge pipeline.

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | 22+ | `node -v` |
| Python 3 | 3.10+ | `python3 --version` |
| Claude Code CLI | latest | `claude --version` |
| sinain-core | built | `cd sinain-core && npm install` |
| macOS | 12.3+ | ScreenCaptureKit for sck-capture |

## Architecture

```
sinain-core (port 9500)          run.sh (bash poll loop)
  ├─ agent loop (local LLM)       ├─ polls GET /escalation/pending
  ├─ escalation scorer             ├─ invokes claude -p per escalation
  ├─ HTTP escalation slot  ←────→ │   └─ MCP: sinain-mcp-server
  ├─ feed buffer → overlay WS     │        └─ 10 tools (HTTP + Python)
  └─ SITUATION.md                  └─ heartbeat every 15 min
```

No gateway, no WebSocket RPC, no server. Just HTTP polling + Claude CLI.

## Quick Start (3 steps)

### Step 1: Configure sinain-core for HTTP transport

Add to `sinain-core/.env`:

```bash
ESCALATION_TRANSPORT=http
```

This routes all escalations to the HTTP pending slot instead of the WebSocket gateway. The gateway connection is skipped entirely.

> **Tip**: Use `ESCALATION_TRANSPORT=auto` to fall back to HTTP only when the gateway is disconnected. Use `http` to bypass it completely.

### Step 2: Restore knowledge (optional)

If you have a knowledge snapshot from a previous OpenClaw deployment:

```bash
python3 sinain-agent/restore-snapshot.py
```

This populates `~/.openclaw/workspace/` with:
- `memory/playbook.md` — effective playbook
- `memory/triplestore.db` — knowledge graph (SQLite)
- `modules/` — knowledge module guidance
- `sinain-memory/` — Python curation scripts

If starting fresh, the agent works without a snapshot — it just won't have prior knowledge.

### Step 3: Start

Terminal 1 — sinain-core:
```bash
cd sinain-core && npm run dev
```

Terminal 2 — bare agent:
```bash
cd sinain-agent && ./run.sh
```

The agent polls every 5 seconds, invokes Claude per escalation, and runs a heartbeat every 15 minutes.

## What You'll See

```
sinain bare agent started
  Core: http://localhost:9500
  Poll: every 5s
  Heartbeat: every 900s
  Press Ctrl+C to stop

[14:32:15] Escalation 3cc5a765f53d4164 (score=3, coding=True)
[14:32:22] Responded (1 total): The TypeError at message-builder.ts:145...
```

Responses appear on the HUD overlay as `[🤖]` messages, identical to OpenClaw gateway responses.

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ESCALATION_TRANSPORT` | `auto` | `http` = bare agent only, `ws` = gateway only, `auto` = gateway when connected, HTTP fallback |
| `ESCALATION_MODE` | `rich` | `off` / `selective` / `focus` / `rich` — controls escalation frequency |
| `ESCALATION_COOLDOWN_MS` | `30000` | Minimum time between escalations |
| `SINAIN_CORE_URL` | `http://localhost:9500` | sinain-core URL (for MCP server) |
| `SINAIN_WORKSPACE` | `~/.openclaw/workspace` | Workspace directory for knowledge files |
| `SINAIN_POLL_INTERVAL` | `5` | Seconds between escalation polls |
| `SINAIN_HEARTBEAT_INTERVAL` | `900` | Seconds between heartbeat ticks (15 min) |

### MCP Server Config

The MCP server is configured in `sinain-agent/mcp-config.json`. It uses `tsx` from sinain-core's node_modules to run `sinain-mcp-server/index.ts`.

### Available MCP Tools

| Tool | Description |
|---|---|
| `sinain_get_escalation` | Poll for pending escalation |
| `sinain_respond` | Submit response → HUD |
| `sinain_get_context` | Full context window (screen + audio + apps) |
| `sinain_get_digest` | Current agent analysis summary |
| `sinain_get_feedback` | Feedback signals from recent escalations |
| `sinain_post_feed` | Push message to HUD feed |
| `sinain_health` | System health check |
| `sinain_knowledge_query` | Query knowledge graph (triplestore) |
| `sinain_heartbeat_tick` | Run curation pipeline (backup, signals, insights, playbook) |
| `sinain_module_guidance` | Read active module guidance |

## Using Other Agents

The bare knuckles architecture works with any agent that can call HTTP or run MCP.

### Codex / Junie (no MCP)

Use the HTTP API directly with curl:

```bash
while true; do
  ESC=$(curl -s http://localhost:9500/escalation/pending)
  if [ "$(echo "$ESC" | jq -r '.escalation')" != "null" ]; then
    ID=$(echo "$ESC" | jq -r '.escalation.id')
    MSG=$(echo "$ESC" | jq -r '.escalation.message')
    RESP=$(echo "$MSG" | your-agent-cli "Respond to this HUD escalation:")
    curl -s -X POST http://localhost:9500/escalation/respond \
      -H 'Content-Type: application/json' \
      -d "{\"id\":\"$ID\",\"response\":$(echo "$RESP" | jq -Rs .)}"
  fi
  sleep 5
done
```

### HTTP API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/escalation/pending` | GET | Returns `{ ok, escalation: { id, message, score, codingContext, ts } \| null }` |
| `/escalation/respond` | POST | Body: `{ id, response }` → pushes response to HUD feed |
| `/agent/context` | GET | Full context window |
| `/agent/digest` | GET | Latest agent digest |
| `/learning/feedback` | GET | Feedback records (`?limit=20`) |
| `/feed` | POST | Body: `{ text, priority }` → push to HUD |
| `/health` | GET | System health + escalation stats |

## Workspace Layout

```
~/.openclaw/workspace/
├── SITUATION.md              # Auto-updated by sinain-core every tick
├── memory/
│   ├── playbook.md           # Effective playbook (updated by curation)
│   ├── playbook-base.md      # Base playbook template
│   ├── playbook-archive/     # Archived playbook versions
│   ├── playbook-logs/        # Decision logs (JSONL)
│   └── triplestore.db        # Knowledge graph (SQLite)
├── modules/
│   ├── module-registry.json  # Active modules config
│   ├── base-behaviors/       # Always-active core module
│   │   ├── guidance.md
│   │   └── patterns.md
│   └── <module-name>/        # Domain-specific modules
└── sinain-memory/            # Python curation scripts
    ├── signal_analyzer.py
    ├── insight_synthesizer.py
    ├── memory_miner.py
    ├── playbook_curator.py
    ├── triple_query.py
    └── git_backup.sh
```

## What's Different from OpenClaw

| Feature | OpenClaw Gateway | Bare Agent |
|---|---|---|
| Escalation delivery | WebSocket RPC (2-phase) | HTTP polling |
| Agent runtime | Server-side (OpenClaw sessions) | Local (Claude CLI) |
| Playbook curation | Server-side plugin | Local Python scripts (same code) |
| Knowledge graph | Server-side plugin | Local SQLite (same code) |
| Cross-session history | `sessions_history` RPC | Local decision logs only |
| Spawn subagents | `sessions_spawn` RPC | `claude -p` background processes |
| Resilience watchdog | Server-side overflow detection | Not needed (local context) |
| Telegram alerts | Plugin → Telegram | Optional (if telegram-claude-mcp configured) |

## Troubleshooting

| Issue | Fix |
|---|---|
| `sinain-core is not running on port 9500` | Start sinain-core first: `cd sinain-core && npm run dev` |
| `No pending escalation` (never appears) | Check `ESCALATION_MODE` is not `off`; ensure sense_client or sck-capture is running for screen context |
| Gateway still responding | Set `ESCALATION_TRANSPORT=http` (not `auto`) to fully disable WS |
| MCP server fails to start | Run `cd sinain-mcp-server && npm install` to install dependencies |
| Python scripts fail | Install deps: `pip3 install -r ~/.openclaw/workspace/sinain-memory/requirements.txt` |
| Heartbeat tick errors | Some pipeline steps may fail without a populated triplestore — this is OK, each step runs independently |
| Escalation cooldown too long | Lower `ESCALATION_COOLDOWN_MS` (default 30000 = 30s) |
