# Bare Knuckles Agent — Installation Guide

Run sinain-hud with **any coding agent** (Claude Code, Codex, Junie) instead of the OpenClaw gateway. The agent polls sinain-core via HTTP, responds to escalations on the HUD, and maintains a playbook through a local knowledge pipeline.

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | 18+ | `node -v` |
| Python 3 | 3.10+ | `python3 --version` |
| Coding agent | see [Using Other Agents](#using-other-agents) |
| sinain-core | built | `cd sinain-core && npm install` |
| macOS | 12.3+ | ScreenCaptureKit for sck-capture |

## Architecture

```
sinain-core (port 9500)          run.sh (bash poll loop)
  ├─ agent loop (local LLM)       ├─ polls GET /escalation/pending
  ├─ escalation scorer             ├─ invokes $SINAIN_AGENT per escalation
  ├─ HTTP escalation slot  ←────→ │   ├─ MCP agents: agent calls sinain tools
  ├─ feed buffer → overlay WS     │   └─ Pipe agents: bash handles HTTP
  └─ SITUATION.md                  └─ heartbeat every 15 min
```

No gateway, no WebSocket RPC, no server. Just HTTP polling + any coding agent.

## Quick Start

### Option A: npx (recommended)

```bash
npx @geravant/sinain start --agent=claude
```

On first run, create `~/.sinain/.env` with your OpenRouter API key:
```bash
mkdir -p ~/.sinain
echo "OPENROUTER_API_KEY=sk-or-..." > ~/.sinain/.env
```

The launcher starts sinain-core, sense_client, and the agent poll loop in one process. Use `--agent=codex`, `--agent=goose`, or `--agent=aider` to switch agents.

```bash
npx @geravant/sinain start --no-sense     # skip screen capture
npx @geravant/sinain start --no-overlay   # skip Flutter overlay
npx @geravant/sinain stop                 # stop all services
npx @geravant/sinain status               # check what's running
```

### Option B: From source (for development)

#### Step 1: Configure sinain-core for HTTP transport

Add to `sinain-core/.env`:

```bash
ESCALATION_TRANSPORT=http
```

This routes all escalations to the HTTP pending slot instead of the WebSocket gateway. The gateway connection is skipped entirely.

> **Tip**: Use `ESCALATION_TRANSPORT=auto` to fall back to HTTP only when the gateway is disconnected. Use `http` to bypass it completely.

#### Step 2: Restore knowledge (optional)

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

#### Step 3: Start

Terminal 1 — sinain-core:
```bash
cd sinain-core && npm run dev
```

Terminal 2 — bare agent (default: Claude Code):
```bash
cd sinain-agent && ./run.sh
```

Or with a different agent:
```bash
SINAIN_AGENT=codex ./run.sh    # Codex with MCP
SINAIN_AGENT=goose ./run.sh    # Goose with MCP
SINAIN_AGENT=aider ./run.sh    # Aider in pipe mode
```

The agent polls every 5 seconds, invokes the selected agent per escalation, and runs a heartbeat every 15 minutes.

## What You'll See

```
sinain bare agent started
  Agent: claude (MCP)
  Core: http://localhost:9500
  Poll: every 5s
  Heartbeat: every 900s
  Press Ctrl+C to stop

[14:32:15] Escalation 3cc5a765f53d4164 (score=3, coding=True)
[14:32:22] Responded (1 total): The TypeError at message-builder.ts:145...
```

Responses appear on the HUD overlay as `[🤖]` messages, identical to OpenClaw gateway responses.

## Configuration

All configuration lives in the project root `.env` (copy from `.env.example`):

```bash
cp .env.example .env
```

### Agent Environment Variables (in project root `.env`)

| Variable | Default | Description |
|---|---|---|
| `SINAIN_AGENT` | `claude` | Agent to use: `claude`, `codex`, `junie`, `goose`, `aider`, or any command |
| `SINAIN_CORE_URL` | `http://localhost:9500` | sinain-core URL |
| `SINAIN_POLL_INTERVAL` | `5` | Seconds between escalation polls |
| `SINAIN_HEARTBEAT_INTERVAL` | `900` | Seconds between heartbeat ticks (15 min) |
| `SINAIN_WORKSPACE` | `~/.openclaw/workspace` | Workspace directory for knowledge files |
| `SINAIN_ALLOWED_TOOLS` | (auto-derived) | MCP tools auto-approved for bare agent. Auto-derived from `mcp-config.json` if unset. |

### Escalation Variables (in project root `.env`)

| Variable | Default | Description |
|---|---|---|
| `ESCALATION_TRANSPORT` | `auto` | `http` = bare agent only, `ws` = gateway only, `auto` = gateway when connected, HTTP fallback |
| `ESCALATION_MODE` | `rich` | `off` / `selective` / `focus` / `rich` — controls escalation frequency |
| `ESCALATION_COOLDOWN_MS` | `30000` | Minimum time between escalations |

### MCP Server Registration

MCP agents need access to the sinain MCP server (`sinain-mcp-server/index.ts`). How it's configured depends on the agent:

| Agent | MCP setup | Config location |
|-------|-----------|-----------------|
| Claude | Automatic — `--mcp-config` flag per invocation | `sinain-agent/mcp-config.json` |
| Codex | Auto-registered on first `run.sh` via `codex mcp add` | `~/.codex/config.toml` |
| Junie | Automatic — copies `mcp-config.json` to `--mcp-location` dir | `sinain-agent/.junie-mcp/mcp.json` |
| Goose | Manual one-time `goose configure` | `~/.config/goose/` |
| Aider | N/A — no MCP support (uses pipe mode) | — |

**Manual registration** (if auto-setup fails or you need to customize):

```bash
# Codex
codex mcp remove sinain 2>/dev/null
codex mcp add sinain \
  --env "SINAIN_CORE_URL=http://localhost:9500" \
  --env "SINAIN_WORKSPACE=$HOME/.openclaw/workspace" \
  -- ./sinain-core/node_modules/.bin/tsx ./sinain-mcp-server/index.ts

# Goose (interactive)
goose configure
# → Add MCP server: name=sinain
# → Command: ./sinain-core/node_modules/.bin/tsx
# → Args: ./sinain-mcp-server/index.ts

# Verify registration
codex mcp list          # Codex
goose mcp list          # Goose
```

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

Set `SINAIN_AGENT` to switch agents. The script auto-detects whether the agent supports MCP (calls sinain tools directly) or needs pipe mode (bash handles HTTP, agent just generates text).

```bash
SINAIN_AGENT=claude|codex|junie|goose|aider|<command>   # default: claude
```

### Supported Agents

| Agent | Mode | One-shot flag | MCP config | Auto-approve |
|-------|------|---------------|------------|--------------|
| `claude` | MCP | `-p "$prompt"` | `--mcp-config file.json` | `--enable-auto-mode` |
| `codex` | MCP | `exec "$prompt"` | `codex mcp add` (persistent) | `-s danger-full-access` |
| `junie` | MCP | `--task "$prompt"` | `--mcp-location dir` (auto-configured) | N/A |
| `goose` | MCP | `run --text "$prompt"` | `goose configure` (persistent) | N/A |
| `aider` | pipe | `--yes -m "$prompt"` | N/A (no MCP) | `--yes` |
| custom | pipe | stdin | N/A | N/A |

### MCP Agents (claude, codex, junie, goose)

These agents receive the sinain MCP server config and call tools (`sinain_get_escalation`, `sinain_respond`, etc.) autonomously. No extra HTTP wiring needed.

**Claude Code** (default) — works out of the box:
```bash
./run.sh
```

**Codex** — MCP server auto-registered on first run (see [MCP Server Registration](#mcp-server-registration) to customize):
```bash
SINAIN_AGENT=codex ./run.sh
```

**Junie** — `mcp-config.json` is auto-copied to a `--mcp-location` directory on startup:
```bash
SINAIN_AGENT=junie ./run.sh
```
Junie expects `mcp.json` (not `mcp-config.json`) in a directory. The script handles the rename automatically. You can also place it in `~/.junie/mcp/mcp.json` for global access.

**Goose** — requires one-time `goose configure` first (see [MCP Server Registration](#mcp-server-registration)):
```bash
SINAIN_AGENT=goose ./run.sh
```

### Pipe Agents (aider, custom)

Agents without MCP support run in **pipe mode**: bash polls for escalations via HTTP, pipes the escalation message to the agent's stdin, captures the text response, and POSTs it back to sinain-core.

Pipe mode also runs heartbeat scripts (signal_analyzer, playbook_curator) directly via Python instead of through MCP tools.

**Aider:**
```bash
SINAIN_AGENT=aider ./run.sh
```

**Custom command** — any command that reads stdin and writes to stdout:
```bash
# Use any CLI that accepts piped input
SINAIN_AGENT="llm -m gpt-4o" ./run.sh

# Even a simple echo for testing
SINAIN_AGENT="cat" ./run.sh
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
