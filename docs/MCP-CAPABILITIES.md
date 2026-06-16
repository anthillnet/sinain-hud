# Sinain MCP Capabilities

What you can actually do once your agent (Claude Code, Cursor, Codex, Goose, Junie, Claude Desktop, …) is connected to the sinain MCP server.

This doc describes the **15 `sinain_*` tools**, when to reach for each, what to ask the agent so it actually uses them, and a handful of end-to-end recipes. For *how to install* the MCP server in each agent, see [MCP-INTEGRATION.md](MCP-INTEGRATION.md) (or just run `npx @geravant/sinain mcp install`).

---

## Quick Orientation

Five families of tools. Pick by intent, not by name:

| You want to… | Reach for | Family |
|---|---|---|
| Recall what sinain learned across past sessions | `sinain_get_knowledge`, `sinain_knowledge_query` | Knowledge |
| Distill what just happened into the graph | `sinain_distill_session`, `sinain_heartbeat_tick` | Knowledge |
| See what the user is doing right now | `sinain_get_context`, `sinain_get_digest` | Real-time |
| Drive the escalation loop from your own agent | `sinain_get_escalation`, `sinain_respond` | Escalation |
| Surface text or a question to the user's HUD | `sinain_post_feed`, `sinain_ask_user` | HUD |
| Fork a background task or queue a follow-up | `sinain_spawn`, `sinain_user_command` | Background |
| Confirm sinain-core is up | `sinain_health` | Health |

Every tool result is filtered through `stripPrivateTags()` (`sinain-mcp-server/index.ts:29`). Anything wrapped in `<private>...</private>` is replaced with `[REDACTED]` before your agent sees it.

---

## Knowledge tools

The most-used family. Knowledge is split across two SQLite triplestores (local at `~/.sinain/memory/knowledge-graph.db` and workspace at `~/.openclaw/workspace/memory/knowledge-graph.db`); these tools merge results from both via the sinain-core `/knowledge/*` HTTP API, with a workspace-only Python fallback when sinain-core is offline.

### `sinain_get_knowledge`

**Returns** the portable knowledge document — playbook + top long-term facts + recent session digests, merged from both DBs.

**Parameters:** none.

**When to use:** at the start of a chat where you want long-term context — "what does sinain remember about me?". Cheap, idempotent, no side effects.

**Example prompt:** *"Use `sinain_get_knowledge` to load my playbook, then tell me what's on top of mind based on it."*

### `sinain_knowledge_query`

**Returns** facts about specific entities. Hybrid retrieval (FTS5 + tag-based + entity-graph backrefs, RRF fusion) over both DBs.

**Parameters:**
- `entities: string[]` — one or more entity names/keywords (e.g. `["nadia", "al-futtaim"]`)
- `max_facts: number` — default 5

**When to use:** targeted recall. Strictly better than `sinain_get_knowledge` when you already know the entities.

**Example prompt:** *"Use `sinain_knowledge_query` with entities `['mena', 'webinar']` to find what was distilled today."*

### `sinain_distill_session`

**Triggers** end-of-session distillation: pulls feed items + agent history from sinain-core, runs `session_distiller.py` (LLM extracts `{facts, entities, decisions}`), then `knowledge_integrator.py` (deterministic graph writes).

**Parameters:** `session_summary: string` (optional label — default `"Bare agent session distillation"`)

**When to use:** end of a focused work block, before quitting, or any time you want today's screen+audio captured into the graph instead of evaporating with the feed buffer.

**Side effects:** writes to the workspace knowledge graph DB. Idempotent — running twice on the same feed re-distills harmlessly (deduplicated downstream).

**Example prompt:** *"I'm done with the Al Futtaim prep — call `sinain_distill_session` with `session_summary='Al Futtaim discovery prep'`."*

### `sinain_heartbeat_tick`

**Runs** the full curation pipeline: signal analysis → insight synthesis → memory mining → playbook curation. The same pipeline the heartbeat skill runs every 15 minutes.

**Parameters:** `session_summary: string` (default `"Bare agent heartbeat tick"`)

**When to use:** force a curation pass between scheduled heartbeats. Useful after a significant event (you fixed a bug, learned a pattern, finished a meeting). Heavier than `sinain_distill_session` — runs four LLM scripts.

**Side effects:** updates the playbook, may post insights to the feed.

**Example prompt:** *"Just shipped the MCP wizard step. Run `sinain_heartbeat_tick` so the playbook picks up the lesson about idempotent agent-config writes."*

### `sinain_module_guidance`

**Returns** the concatenated `guidance.md` from every active module in `~/.openclaw/workspace/modules/`.

**Parameters:** none.

**When to use:** at the start of work that should follow your active modules' rules (tone, constraints, domain knowledge). Cheap.

**Example prompt:** *"Before you respond, call `sinain_module_guidance` and follow whatever's active."*

---

## Real-time context tools

These read sinain-core's live ring buffers. They tell you what is happening *right now*, not what was learned.

### `sinain_get_context`

**Returns** the full agent context window: recent screen OCR, audio transcripts, app history, feed messages.

**Parameters:** none.

**When to use:** "what's on screen?", "what was I just doing?", "summarize the last few minutes". Output can be very large (often 100KB+) — prefer `sinain_get_digest` if you only need a summary.

**Example prompt:** *"Use `sinain_get_context` to see what I'm looking at, then explain it to me."*

### `sinain_get_digest`

**Returns** the latest agent digest — a short LLM-generated `{hud, digest}` summary of the current context window.

**Parameters:** none.

**When to use:** lightweight "what is the user doing" check. ~1 KB, fast, already summarized.

**Example prompt:** *"Call `sinain_get_digest` and react to whatever I'm doing."*

### `sinain_get_feedback`

**Returns** recent learning-feedback entries (escalation scores, user reactions, missed-opportunities log).

**Parameters:** `limit: number` (default 20)

**When to use:** retrospective on agent quality. "Have my escalations been useful lately?" Pairs naturally with `sinain_heartbeat_tick`.

**Example prompt:** *"Use `sinain_get_feedback` and tell me which escalation scored worst — what would you have done differently?"*

---

## Escalation flow

These two tools let any MCP agent become a sinain escalation responder, replacing or complementing the `sinain-agent-runner/run.sh` poll loop.

### `sinain_get_escalation`

**Returns** the current pending escalation (if any), including screen OCR, audio transcript, app history, and the local agent's digest. Returns `"No pending escalation"` when idle.

**Parameters:** none.

**When to use:** in a poll loop (every 3–5 seconds) when you want this MCP-connected agent to handle escalations live.

### `sinain_respond`

**Submits** a response to a pending escalation. The response appears on the user's HUD overlay.

**Parameters:**
- `id: string` — the escalation ID from `sinain_get_escalation`
- `response: string` — your response text

**Constraints:** keep it under 4000 chars (coding contexts) or 3000 chars (everything else). Quote specific screen text or audio when relevant. Never narrate what the user is already seeing.

**Example workflow:**
```
1. sinain_get_escalation         → { id: "esc-123", message: "..." }
2. (think; optionally enrich with sinain_knowledge_query)
3. sinain_respond({ id: "esc-123", response: "..." })
```

---

## HUD interaction

Push text or a blocking question to the user without going through escalation.

### `sinain_post_feed`

**Posts** an arbitrary message to the HUD feed.

**Parameters:**
- `text: string`
- `priority: "normal" | "high" | "urgent"` (default `normal`)

**When to use:** silent notifications. "Build finished." "PR merged." "Recent commit by Alice mentions the bug you were chasing."

**Example prompt:** *"Once the deploy passes, post `Deploy green` to the feed via `sinain_post_feed` with priority high."*

### `sinain_ask_user`

**Asks** the user a question via the HUD overlay and **blocks** until they reply (timeout 5 min, internal HTTP timeout 6 min).

**Parameters:** `question: string`

**When to use:** when you genuinely cannot proceed without a human decision. Prefer it over guessing — but use sparingly; it interrupts.

**Example prompt:** *"You're about to delete `~/.sinain/memory/knowledge-graph.db`. Call `sinain_ask_user('Confirm DB delete? [yes/no]')` and proceed only on `yes`."*

---

## Background work

### `sinain_spawn`

**Spawns** a background agent task via sinain-core. Runs asynchronously; the result is delivered later through the spawn task lane.

**Parameters:**
- `task: string` — the task description
- `label: string` — default `"background-task"`

**Limits:** by convention max 2 spawns/hour, no duplicates of recent spawns.

**Example prompt:** *"While I keep coding, spawn a background task to research the Cursor MCP config format and post findings to the feed."*

### `sinain_user_command`

**Queues** a user command to be injected into the next escalation context, forcing escalation on the next agent tick.

**Parameters:** `text: string`

**When to use:** you want to nudge the next escalation with a hint without typing it on the HUD. Mostly useful for orchestration scripts and other agents.

**Example prompt:** *"Use `sinain_user_command` to inject 'focus on TypeScript errors' so the next escalation prioritizes them."*

---

## Health

### `sinain_health`

**Returns** sinain-core's `/health` JSON: gateway connection status, ring-buffer sizes, last activity timestamps, etc.

**Parameters:** none.

**When to use:** first call when something feels off. Confirms whether the issue is sinain-core down vs. something else.

**Example prompt:** *"Run `sinain_health` and tell me if sinain-core looks healthy."*

---

## End-to-end recipes

### 1. Respond to escalations from any MCP agent

The `sinain-agent-runner/run.sh` bare-agent loop is just a polling driver around `sinain_get_escalation` + `sinain_respond`. Any MCP-connected agent can do the same — useful when you want Cursor or Goose handling escalations instead of Claude Code.

```
loop:
  health = sinain_health
  if !health.ok: sleep 5; continue
  esc = sinain_get_escalation
  if esc == "No pending escalation": sleep 3; continue
  ctx = optional sinain_knowledge_query(entities=esc.tags)
  guidance = optional sinain_module_guidance
  reply = compose(esc, ctx, guidance)
  sinain_respond({ id: esc.id, response: reply })
```

A natural-language version: *"Every 5 seconds, call `sinain_get_escalation`. When you get one, optionally call `sinain_knowledge_query` to enrich, then call `sinain_respond` with a 5–10 sentence reply."*

### 2. Distill a workday into the graph

End-of-day knowledge capture without restarting sinain-core.

1. *"Call `sinain_get_digest` and `sinain_get_context` to remind yourself what I worked on."*
2. *"Call `sinain_distill_session` with `session_summary='Tuesday work block — MCP wizard, doc cleanup'`."*
3. *"Then call `sinain_heartbeat_tick` so the playbook picks up any new patterns."*
4. *"Verify with `sinain_knowledge_query` for the main entities."*

### 3. Cross-machine knowledge sync

Pair the MCP read tools with the export/import CLI for portable knowledge.

```bash
# Machine A
npx @geravant/sinain export-knowledge --output ~/snapshot.tar.gz

# Machine B
npx @geravant/sinain import-knowledge ~/snapshot.tar.gz
```

Then on machine B, *"Use `sinain_get_knowledge` and `sinain_knowledge_query` to confirm everything from machine A is in the merged view."*

### 4. Route a question to the user inside a long task

When an MCP agent is mid-research and hits a fork:

```
1. sinain_post_feed("Hit a Cursor-specific edge case — pausing for input")
2. answer = sinain_ask_user("Skip Cursor for v1, or wait while I figure it out? [skip|wait]")
3. branch on answer.startsWith("skip") vs "wait"
```

The `sinain_ask_user` blocks until the human replies on the HUD — the agent stays waiting up to ~5 minutes.

---

## See also

- [MCP-INTEGRATION.md](MCP-INTEGRATION.md) — installing the MCP server (Claude Code, Claude Desktop, alternate config dirs).
- [INSTALL-BARE-AGENT.md](INSTALL-BARE-AGENT.md) § *MCP Server Registration* — manual registration recipes for Codex, Goose, Junie, Aider in the bare-agent context.
- [KNOWLEDGE-API.md](KNOWLEDGE-API.md) — the HTTP endpoints these tools bridge to. Useful when you want to call them directly (curl, web UI at `http://localhost:9500/knowledge/ui`) instead of via an MCP agent.
- [knowledge-system.md](knowledge-system.md) — architecture and design of the dual-DB triplestore + entity graph.
