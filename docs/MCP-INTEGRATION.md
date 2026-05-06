# Connecting Claude to Sinain (MCP)

> **Easiest path** — let the wizard do it:
> ```bash
> npx @geravant/sinain@latest mcp install
> ```
> Detects which MCP-aware agents you have (Claude Code, Claude Desktop, Cursor, Codex, Goose, Junie) and registers sinain for the ones you pick. Idempotent. Same step runs as **`[6/6]`** of `sinain onboard --advanced`. Re-run any time to re-point stale paths after upgrades.
>
> See **[MCP Capabilities](MCP-CAPABILITIES.md)** for what each of the 15 tools enables.
>
> The rest of this doc covers the manual recipe — useful for `pclaude` / alternate `CLAUDE_CONFIG_DIR`, or when scripting registrations outside the wizard.

Sinain ships an [MCP](https://modelcontextprotocol.io) server that lets Claude — running locally via Claude Code or any other MCP-aware client — read and write the sinain knowledge graph, post to the HUD feed, drive escalations, and run the heartbeat pipeline. This is the **default way** to give Claude access to everything sinain has captured.

## What you get

Once registered, Claude sees 15 `sinain_*` tools. The three most useful for knowledge access:

| Tool | What it does |
|---|---|
| `sinain_get_knowledge` | Fetch the portable knowledge doc (playbook + long-term facts), merged from local + workspace databases. |
| `sinain_knowledge_query` | Look up facts about specific entities/domains. Hybrid retrieval over both DBs. |
| `sinain_distill_session` | Distill the current session into the graph (playbook updates + new facts). |

The full tool list is in [Tool Reference](#tool-reference) below.

All tool results pass through `stripPrivateTags()` — content wrapped in `<private>...</private>` is automatically redacted before reaching Claude, consistent with the rest of sinain's [privacy model](privacy-protection-design.md).

## Prerequisites

1. **Sinain-hud cloned** with the MCP server's deps installed:
   ```bash
   cd $SINAIN_HOME/sinain-mcp-server && npm install
   ```
   (Where `$SINAIN_HOME` is your sinain-hud checkout.)

2. **`sinain-core` running** on `localhost:9500` so the merged-DB knowledge tools have a backend:
   ```bash
   cd $SINAIN_HOME/sinain-core && npm run dev
   ```
   The knowledge tools fall back to a workspace-only Python query when sinain-core is unreachable, so you get partial results offline — but a running core gives you the unified view.

## Install — Claude Code

Register the server at **user scope** so it follows you into every project, not just the sinain repo:

```bash
claude mcp add sinain --scope user \
  --env SINAIN_CORE_URL=http://localhost:9500 \
  --env SINAIN_WORKSPACE=$HOME/.openclaw/workspace \
  -- $SINAIN_HOME/sinain-mcp-server/node_modules/.bin/tsx \
     $SINAIN_HOME/sinain-mcp-server/index.ts
```

Substitute `$SINAIN_HOME` with the absolute path to your checkout (e.g. `~/IdeaProjects/sinain-hud`). The registration writes to `~/.claude.json`.

## Install — `pclaude` or any alternate Claude config dir

If you use `pclaude` (the common alias `pclaude=CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude`) or another wrapper that points Claude at a different config directory, **register again under that config dir**. Each `CLAUDE_CONFIG_DIR` has its own MCP registry — adding to one does not add to the other.

```bash
CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude mcp add sinain --scope user \
  --env SINAIN_CORE_URL=http://localhost:9500 \
  --env SINAIN_WORKSPACE=$HOME/.openclaw/workspace \
  -- $SINAIN_HOME/sinain-mcp-server/node_modules/.bin/tsx \
     $SINAIN_HOME/sinain-mcp-server/index.ts
```

## Verify

```bash
claude mcp list                                              # default claude
CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude mcp list    # pclaude
```

Both should list `sinain` with status `✓ Connected` (or equivalent).

Then in a fresh Claude Code session, ask:

> "Use `sinain_knowledge_query` to find facts about Project X."

Claude should call the tool and return matching facts. Tail `sinain-core`'s logs in another terminal to confirm `GET /knowledge/facts?...` is being hit — that proves the HTTP bridge to the merged DB is engaged, not just the offline Python fallback.

## Tool Reference

| Tool | Description |
|---|---|
| `sinain_get_knowledge` | Get the portable knowledge document (playbook + long-term facts from both local and workspace databases). |
| `sinain_knowledge_query` | Query the knowledge graph for facts about specific entities/domains (searches both local and workspace databases). |
| `sinain_distill_session` | Distill the current session into knowledge (playbook updates + graph facts). |
| `sinain_heartbeat_tick` | Run the full heartbeat knowledge pipeline (signal analysis, insight synthesis, memory mining, playbook curation). |
| `sinain_module_guidance` | Read guidance from all active modules in the workspace. |
| `sinain_get_context` | Get the current agent context window from sinain-core (screen + audio + feed). |
| `sinain_get_digest` | Get the latest agent digest from sinain-core. |
| `sinain_get_feedback` | Get recent learning feedback entries. |
| `sinain_get_escalation` | Get the current pending escalation from sinain-core. |
| `sinain_respond` | Respond to a pending escalation. |
| `sinain_post_feed` | Post a message to the sinain-core HUD feed. |
| `sinain_spawn` | Spawn a background agent task via sinain-core. |
| `sinain_user_command` | Queue a user command to augment the next escalation context. |
| `sinain_ask_user` | Ask the user a question via the HUD overlay; blocks until they respond. |
| `sinain_health` | Check sinain-core health status. |

## Privacy

Every tool result is filtered through `stripPrivateTags()` (`sinain-mcp-server/index.ts:29`). Anything between `<private>` and `</private>` tags — wherever those originate (sense_client, the heartbeat pipeline, manual annotations) — is replaced with `[REDACTED]` before Claude sees it. This is the same redaction layer used elsewhere in sinain.

## Troubleshooting

**`claude mcp list` shows the server, but tools don't appear in Claude:** the most common cause is a stale Claude session. Quit and reopen Claude Code — registrations are loaded at session start.

**`sinain_knowledge_query` returns "Error querying graph":** sinain-core is down *and* the workspace DB doesn't exist or isn't readable. Start sinain-core, or verify `~/.openclaw/workspace/memory/knowledge-graph.db` exists.

**`tsx: command not found` style errors when Claude tries to launch the MCP:** the absolute path to `tsx` in your registration no longer points anywhere — usually because the sinain-hud checkout was moved or `node_modules/` was wiped. Re-run `npm install` in `sinain-mcp-server/`, or update the registration with `claude mcp remove sinain` followed by re-running `claude mcp add` with the corrected path.

**Tool results look truncated or contain unexpected `[REDACTED]` markers:** that's `stripPrivateTags()` doing its job — text inside `<private>` tags. Inspect the underlying source (`sinain-core` logs, the knowledge graph) if you need to see the originals.

**`tsx` or `index.ts` path looks stale after an upgrade:** the wizard bakes absolute paths into each agent's MCP config at registration time. After major npm cache rotations or moving your sinain-hud checkout, the registration may point at a directory that no longer exists. Re-run `npx @geravant/sinain mcp install` to repair every detected agent in one pass, or `sinain mcp install --agent=<id>` to fix one.

## Other Claude clients

- **Claude Desktop** (the macOS app, separate from Claude Code) registers MCP servers via `~/Library/Application Support/Claude/claude_desktop_config.json`. The same JSON shape works:
  ```json
  {
    "mcpServers": {
      "sinain": {
        "command": "/path/to/sinain-mcp-server/node_modules/.bin/tsx",
        "args": ["/path/to/sinain-mcp-server/index.ts"],
        "env": {
          "SINAIN_CORE_URL": "http://localhost:9500",
          "SINAIN_WORKSPACE": "/Users/<you>/.openclaw/workspace"
        }
      }
    }
  }
  ```
- **claude.ai web** cannot connect to a localhost stdio server — there's no path from a browser session to a local MCP. Not supported.

## See also

- [Sinain Knowledge API](KNOWLEDGE-API.md) — the HTTP endpoints under `/knowledge/*` that the MCP tools bridge to. Useful when you want to call the knowledge graph directly (curl, web UI at `http://localhost:9500/knowledge/ui`) instead of via Claude.
- [Knowledge System](knowledge-system.md) — architecture and design of the triplestore + entity graph.
- [Agent Roster & Profiles](AGENT-ROSTER.md) — how `pclaude`/`nemoclaw`/etc. are configured as escalation/spawn agents.
