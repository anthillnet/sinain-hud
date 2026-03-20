# Bare Knuckles Agent: sinain without OpenClaw

## Context

sinain-hud currently requires an OpenClaw gateway (remote server or local) to handle escalations — the rich analysis loop where the agent responds to HUD context. The gateway provides session management, memory, a curation pipeline, and tools via the sinain-hud plugin.

**Goal**: Design a path where a "bare knuckles" agent — Claude Code CLI, Codex, or Junie — connects directly to sinain-core's HTTP API, bypasses OpenClaw entirely, and still runs the main loops: respond to escalations on the HUD, maintain a playbook, and learn from feedback. This sacrifices some capabilities (spawn tasks, server-side curation, resilience watchdog) but dramatically simplifies deployment and makes sinain work with *any* coding agent.

---

## Architecture

```
Mac
──────────────────────────────────────────────────────────

sinain-core (port 9500)          Bare Agent (Claude Code / Codex / Junie)
  ├─ agent loop (local LLM)       ├─ long-running process
  ├─ escalation scorer             ├─ MCP: sinain-mcp-server
  ├─ NEW: http escalation slot     │    ├─ HTTP tools (escalation, context, feed)
  │                                │    └─ Knowledge tools (triplestore, modules, curation)
  │  GET /escalation/pending ←──── │
  │  POST /escalation/respond ──→  │  sinain-memory/ (Python scripts, called by MCP)
  │  GET /learning/feedback ←───── │    ├─ triple_query.py → triplestore.db (SQLite)
  │                                │    ├─ signal_analyzer.py, insight_synthesizer.py
  ├─ feed buffer ──→ overlay WS    │    ├─ playbook_curator.py, memory_miner.py
  ├─ sense buffer                  │    └─ git_backup.sh
  └─ SITUATION.md (local)          │
                                   └─ workspace/ (~/.openclaw/workspace/)
overlay (ghost window)                  ├─ memory/ (playbook, logs, triplestore.db)
sense_client (OCR)                      ├─ modules/ (registry + knowledge modules)
sck-capture (audio + screen)            └─ sinain-memory/ (deployed Python scripts)
```

**Key insight**: sinain-core already has all the scoring, message building, and context assembly. The only missing piece is a polling-based HTTP interface instead of WebSocket RPC. Two new endpoints + a lightweight MCP server is all it takes.

---

## What's Preserved vs Lost

### Fully preserved
- Escalation scoring & decision logic (sinain-core, unchanged)
- Context assembly: digest, OCR, audio, errors, app history
- Privacy stripping — sinain-core strips `<private>` tags before building escalation messages, and the MCP server applies `/<private>[\s\S]*?<\/private>/g` to all tool outputs (same regex the plugin uses)
- Response delivery to HUD overlay
- Feedback signal collection (errorCleared, dwellTime, etc.)
- SITUATION.md (sinain-core writes it locally on every agent tick)
- All sinain-core HTTP endpoints

### Preserved with local execution
- **Playbook + curation pipeline** — the Python scripts (`playbook_curator.py`, `memory_miner.py`, `signal_analyzer.py`, `insight_synthesizer.py`) are standalone CLIs. The bare agent calls them via subprocess, same as `GenericAdapter` already does. No reimplementation needed.
- **Triple store / knowledge graph** — `triplestore.py` is pure SQLite, `triple_query.py` and `triple_ingest.py` are standalone CLIs. Agent queries context with `python3 triple_query.py --memory-dir memory/ --context "..." --max-chars 1500` and ingests after each tick.
- **Knowledge modules** — `module-registry.json` + `modules/` directory are disk-based. Module guidance is read from `guidance.md` files, patterns from `patterns.md`. The `module_manager.py` CLI handles activation/suspension. Agent reads active module guidance before each escalation response.
- **Heartbeat cycle** — agent runs its own 15-min timer calling the same scripts: `git_backup.sh` → `signal_analyzer.py` → `insight_synthesizer.py` → `playbook_curator.py`
- **Decision logging** — local JSONL via `playbook-logs/YYYY-MM-DD.jsonl`
- **Git backup** — `git_backup.sh` already standalone
- **Eval pipeline** — `tick_evaluator.py` + `eval_reporter.py` run as standalone CLIs

### Preserved differently
- **Spawn tasks / subagents** — no `sessions_spawn` RPC, but CLI agents spawn subprocesses natively. Claude Code: `claude -p "task..." --output-format text > ~/.sinain/agent-memory/tasks/task-ID.txt &`. The parent spawns a background process, continues its loop, reads result file later.
- **Telegram routing** — if agent has telegram-claude-mcp configured, heartbeat tips route there. Otherwise, tips go to HUD via `sinain_post_feed`.

### Lost
- **Cross-session history** — no `sessions_history` RPC (only current HTTP context + local decision logs)
- **Resilience watchdog** — no overflow/outage detection (not needed — bare agent manages its own context window)

### Net assessment
The bare agent is **nearly at feature parity** with the OpenClaw version. The entire Python knowledge stack (triple store, modules, curation, eval) runs standalone — the `GenericAdapter` already proves this. The main loss is cross-session history and the resilience watchdog, both of which are less critical for a locally-managed agent.

---

## Implementation: 3 Layers

### Layer 1: HTTP Escalation Bridge (sinain-core changes)

**Files to modify:**

| File | Change |
|------|--------|
| `sinain-core/src/server.ts` | Add `GET /escalation/pending` + `POST /escalation/respond` routes (~40 lines) |
| `sinain-core/src/escalation/escalator.ts` | Add `httpPending` slot, `getPendingHttp()`, `respondHttp()`, transport branching (~60 lines) |
| `sinain-core/src/config.ts` | Add `ESCALATION_TRANSPORT` env var (http / ws / auto, default: auto) |
| `sinain-core/src/types.ts` | Extend `EscalationConfig` with `transport` field |

**How it works:**

In `Escalator.onAgentAnalysis()`, after the scorer decides to escalate and the message builder assembles context:

```
if transport === "http" OR (transport === "auto" AND WS disconnected):
  → store in httpPending slot (single-slot buffer, newest wins)
else:
  → existing WS EscalationSlot flow (unchanged)
```

`GET /escalation/pending` returns the httpPending slot contents (or `null`).
`POST /escalation/respond` matches by `id`, calls the existing response handler (push to feed, record feedback), clears the slot.

**Response format from GET:**
```json
{
  "ok": true,
  "escalation": {
    "id": "sha256-based-idempotency-key",
    "message": "[sinain-hud live context — tick #42]\n\n## Digest\n...",
    "score": 5,
    "codingContext": true,
    "ts": 1710900000000
  }
}
```

**`auto` transport** means: WS when gateway is connected, HTTP when it's not. Zero-config transition — just start a bare agent when OpenClaw isn't running.

### Layer 2: MCP Server (new package)

**File to create:** `sinain-mcp-server/index.ts` (~150 lines)

A single-file MCP server using `@modelcontextprotocol/sdk` that wraps sinain-core HTTP:

| MCP Tool | Source | Purpose |
|----------|--------|---------|
| `sinain_get_escalation` | `GET /escalation/pending` | Poll for pending escalation |
| `sinain_respond` | `POST /escalation/respond` | Submit response (→ HUD) |
| `sinain_get_context` | `GET /agent/context` | Full context window |
| `sinain_get_digest` | `GET /agent/digest` | Current analysis summary |
| `sinain_get_feedback` | `GET /learning/feedback` | Feedback signals for learning |
| `sinain_post_feed` | `POST /feed` | Push arbitrary message to HUD |
| `sinain_health` | `GET /health` | System health check |
| `sinain_knowledge_query` | `python3 triple_query.py` | Query knowledge graph for relevant context |
| `sinain_heartbeat_tick` | runs curation scripts | Execute full heartbeat: git backup → signals → insights → curation |
| `sinain_module_guidance` | reads `modules/` dir | Get active module guidance for prompt injection |

Config: `SINAIN_CORE_URL` (default `http://localhost:9500`), `SINAIN_WORKSPACE` (default `~/.openclaw/workspace`).

**Why MCP, not just curl?** Claude Code natively supports MCP servers. The agent gets typed tool definitions, automatic retries, and tools show up in its tool list. Codex/Junie can use the same HTTP API + Python scripts directly.

**Knowledge tools**: The last 3 tools wrap the standalone Python scripts from `sinain-memory/`. The MCP server runs them via `child_process.execFile` (same pattern as `GenericAdapter`). This gives the bare agent full access to the knowledge graph, curation pipeline, and module system without reimplementing anything.

**Privacy**: All tool outputs pass through `stripPrivateTags()` before returning to the agent — a single regex (`/<private>[\s\S]*?<\/private>/g`) matching the plugin's `tool_result_persist` hook. This prevents `<private>`-tagged content (credit cards, API keys, bearer tokens) from entering the agent's context.

### Layer 3: Agent Configuration

**Files to create:**

| File | Purpose |
|------|---------|
| `sinain-agent/CLAUDE.md` | System instructions for Claude Code (adapted from SKILL.md + HEARTBEAT.md) |
| `sinain-agent/mcp-config.json` | MCP server config pointing to sinain-mcp-server |
| `sinain-agent/run.sh` | Launch script: starts sinain-mcp-server, runs claude with --mcp-config |
| `sinain-agent/seed-playbook.md` | Initial playbook (seeded from current production playbook patterns) |

**CLAUDE.md structure** (adapted from SKILL.md + HEARTBEAT.md):

```markdown
# Sinain HUD Agent

You are a coding assistant connected to sinain-hud. You observe the user's screen
and audio context and provide real-time advice on their HUD overlay.

## Main Loop
1. Call `sinain_get_escalation` every few seconds
2. When an escalation arrives, analyze the context and call `sinain_respond`
3. Never respond with "NO_REPLY" — always provide value

## Heartbeat (every 15 minutes)
1. Call `sinain_heartbeat_tick` — runs the full pipeline:
   - git backup (commits memory/ to backup repo)
   - signal analysis (detects opportunities from session context)
   - insight synthesis (generates suggestions from patterns)
   - playbook curation (updates playbook based on feedback + mining)
2. Act on the result: if output is non-null, post suggestion to HUD via `sinain_post_feed`
3. Optionally call `sinain_get_feedback` for manual review of recent scores

## Response Guidelines
- 5-10 sentences, address errors first
- Reference specific screen text or audio when relevant
- If coding context: focus on code fixes, not general advice
- Max 4000 chars for code context, 3000 otherwise

## Spawning Background Tasks
When an escalation suggests deeper research would help:
1. Respond to the escalation first (user sees immediate HUD response)
2. Spawn a background task:
   claude -p "Research task description..." --output-format text > ~/.sinain/agent-memory/tasks/task-ID.txt &
3. On next heartbeat or escalation, check for completed task files
4. Integrate findings into your response or playbook
Rules: max 2 spawns per hour, never duplicate recent tasks

## Files You Manage
- ~/.sinain/agent-memory/playbook.md
- ~/.sinain/agent-memory/decision-log.jsonl
- ~/.sinain/agent-memory/playbook-archive/
- ~/.sinain/agent-memory/tasks/ (spawn task results)
```

**run.sh:**
```bash
#!/usr/bin/env bash
# Start MCP server + Claude Code
claude --dangerously-skip-permissions \
  --mcp-config sinain-agent/mcp-config.json \
  -p "You are the sinain HUD agent. Start your main loop by calling sinain_get_escalation."
```

---

## Minimal Path (MVP)

If we want the smallest possible change to get this working:

1. **2 endpoints in server.ts** — `GET /escalation/pending`, `POST /escalation/respond` (~40 lines)
2. **httpPending slot in escalator.ts** — single-slot buffer + transport branching (~60 lines)
3. **Config + types** — `ESCALATION_TRANSPORT` env var (~7 lines)
4. **A curl poll loop** — ~15 lines of bash, no MCP, no SDK:

```bash
while true; do
  ESC=$(curl -s http://localhost:9500/escalation/pending)
  if [ "$(echo "$ESC" | jq -r '.escalation')" != "null" ]; then
    ID=$(echo "$ESC" | jq -r '.escalation.id')
    MSG=$(echo "$ESC" | jq -r '.escalation.message')
    RESP=$(echo "$MSG" | claude -p "Respond to this HUD escalation concisely:")
    curl -s -X POST http://localhost:9500/escalation/respond \
      -H 'Content-Type: application/json' \
      -d "{\"id\":\"$ID\",\"response\":$(echo "$RESP" | jq -Rs .)}"
  fi
  sleep 5
done
```

This gets escalation responses on the HUD with zero MCP, zero SDK. No playbook or memory management — but escalations flow and responses appear on screen. Everything else is enhancement.

---

## Implementation Order

1. **Layer 1**: HTTP escalation bridge in sinain-core (server.ts, escalator.ts, config.ts, types.ts)
2. **Layer 2**: sinain-mcp-server/index.ts
3. **Layer 3**: sinain-agent/ (CLAUDE.md, mcp-config.json, run.sh, seed-playbook.md)
4. **Test**: Run with `ESCALATION_TRANSPORT=http`, verify escalations appear via GET, responses show on HUD

## Verification

1. Start sinain-core with `ESCALATION_TRANSPORT=http` (no gateway running)
2. `curl http://localhost:9500/escalation/pending` — should return `null` initially
3. Trigger screen activity → wait for agent tick + escalation score ≥ threshold
4. `curl http://localhost:9500/escalation/pending` — should return escalation message
5. `curl -X POST http://localhost:9500/escalation/respond -d '{"id":"...","response":"test"}'`
6. Verify response appears on HUD overlay
7. Run full bare agent (run.sh) and verify end-to-end loop

## Existing Code to Reuse

**sinain-core (modify):**
- `escalator.ts` — `handleEscalationResponse()` for response processing; add httpPending slot
- `message-builder.ts` — `buildEscalationMessage()` assembles context (unchanged)
- `scorer.ts` — `shouldEscalate()` + `calculateEscalationScore()` (unchanged)

**sinain-memory/ Python scripts (call directly from MCP server):**
- `triple_query.py` — `--memory-dir --context --max-chars` → JSON context
- `triple_ingest.py` — `--memory-dir --signal-result|--ingest-playbook|--ingest-session` → ingest to SQLite
- `signal_analyzer.py` — `--memory-dir --session-summary --current-time` → JSON signals
- `insight_synthesizer.py` — `--memory-dir --session-summary` → JSON suggestion + insight
- `playbook_curator.py` — `--memory-dir --mining-result --feedback-directive` → updated playbook
- `memory_miner.py` — `--memory-dir` → JSON mining findings
- `module_manager.py` — `guidance|list|activate|suspend` → module operations
- `git_backup.sh` — `$1=memory-dir` → commits + pushes

**Templates:**
- `sinain-hud-plugin/SKILL.md` — template for agent CLAUDE.md escalation instructions
- `sinain-hud-plugin/HEARTBEAT.md` — template for heartbeat cycle instructions
- `sinain-knowledge/adapters/generic/adapter.ts` — GenericAdapter pattern (proof of standalone operation)
- `sinain-knowledge/curation/engine.ts` — `executeTick()` logic to replicate in MCP heartbeat tool
