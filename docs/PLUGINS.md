# Plugin Architecture

Full reference for the OpenClaw plugins running on the strato server. For gateway setup, see [OPENCLAW-SETUP.md](./OPENCLAW-SETUP.md).

## Overview

Two plugins are deployed on the server:

| Plugin | Purpose | Location |
|---|---|---|
| **sinain-hud** | Agent lifecycle management (file sync, privacy, session summaries) | `/mnt/openclaw-state/extensions/sinain-hud/` |
| **claude-mem** | Persistent memory, vector search, observation feed | `/mnt/openclaw-state/extensions/claude-mem/` |

## Server File Layout

```
/mnt/openclaw-state/                     # bind-mounted as /home/node/.openclaw
├── openclaw.json                        # main gateway config (plugins, agents, auth)
├── extensions/
│   ├── sinain-hud/
│   │   ├── index.ts                     # plugin implementation
│   │   └── openclaw.plugin.json         # plugin manifest
│   └── claude-mem/
│       ├── index.ts
│       ├── openclaw.plugin.json
│       └── worker/                      # background worker (port 37777)
├── sinain-sources/
│   ├── HEARTBEAT.md                     # source of truth for auto-deploy
│   └── SKILL.md
├── claude-mem/                          # memory data (symlinked from ~/.claude-mem)
├── start-services.sh                    # starts background workers on container boot
├── workspace/                           # agent workspace
│   ├── HEARTBEAT.md                     # deployed by plugin from sinain-sources/
│   ├── SKILL.md
│   ├── SITUATION.md
│   └── memory/
│       ├── sinain-playbook.md
│       ├── session-summaries.jsonl      # written by sinain-hud plugin
│       ├── playbook-archive/
│       └── playbook-logs/
├── agents/                              # agent state and session transcripts
├── credentials/                         # API keys
└── telegram/                            # Telegram channel state
```

## Plugin Lifecycle

```
Gateway starts
  └─► Scan extensions/ directory
       └─► For each openclaw.plugin.json:
            ├─► Load plugin (require index.ts)
            ├─► Call plugin export with api object
            └─► Register hooks, commands, services
                 │
                 ▼
         Hooks fire on agent events:
           session_start → before_agent_start → tool_result_persist → agent_end → session_end
```

Plugins register hooks via `api.on(eventName, handler)`. The `tool_result_persist` hook is synchronous (can modify tool results before they're saved); all others are async.

## sinain-hud Plugin

See [sinain-hud-plugin/README.md](../sinain-hud-plugin/README.md) for the full reference.

**Hooks:**
- `session_start` — initializes per-session tracking
- `before_agent_start` — syncs HEARTBEAT.md + SKILL.md from `sinain-sources/` to workspace
- `tool_result_persist` — strips `<private>` tags from tool results
- `agent_end` — writes session summary to `memory/session-summaries.jsonl`

**Auto-deploy flow:**
```
sinain-hud repo                  Server                          Agent workspace
skills/sinain-hud/    ──SCP──►  sinain-sources/   ──plugin──►  workspace/
  HEARTBEAT.md                    HEARTBEAT.md                   HEARTBEAT.md
  SKILL.md                        SKILL.md                       SKILL.md
```

SCP is manual (or via deploy-heartbeat skill). Plugin sync happens automatically on each agent start.

## claude-mem Plugin

Persistent memory with vector search, structured observations, and a Telegram observation feed.

### Worker

The claude-mem worker runs on port 37777 inside the container. It provides:
- Vector similarity search over stored observations
- Structured memory storage and retrieval
- SSE event stream for the observation feed

### Startup

The worker is started by `/mnt/openclaw-state/start-services.sh`, which is chained into the docker-compose startup command. This means:
- `docker compose restart` — worker survives (compose command re-runs)
- `docker compose down/up` — container recreated, `start-services.sh` re-starts the worker
- Container rebuild — Bun needs to be re-installed (it's at `/home/node/.bun/bin/bun`)

### Data Persistence

Worker data is persisted via a symlink inside the container:
```
~/.claude-mem → ~/.openclaw/claude-mem → /mnt/openclaw-state/claude-mem (host)
```

### Observation Feed

The observation feed streams structured observations from the agent to Telegram via SSE:

```
Agent produces observation → claude-mem stores it → SSE stream → Telegram bot → Chat 59835117
```

Configured in `openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "claude-mem": {
        "observationFeed": {
          "enabled": true,
          "channel": "telegram",
          "targetId": "59835117"
        }
      }
    }
  }
}
```

## Structured Observations (SenseObservation)

sense_client auto-populates structured observations on every sense event:

```python
@dataclass
class SenseObservation:
    title: str       # e.g. "text in IntelliJ IDEA"
    subtitle: str    # window title (first 80 chars)
    facts: list[str] # ["app: IntelliJ IDEA", "window: analyzer.ts", "ssim: 0.850", "ocr: ..."]
    narrative: str   # enriched by sinain-core's agent layer
    concepts: list[str]  # enriched by sinain-core
```

`title` and `facts` are populated by sense_client from OCR/app context. `narrative` and `concepts` are added by sinain-core's agent layer before forwarding to OpenClaw.

## Privacy Pipeline

Privacy is enforced at two levels:

### Client-side (sense_client)

`sense_client/privacy.py` runs on every OCR result before sending to sinain-core:

1. **`<private>` tag stripping** — removes `<private>...</private>` blocks
2. **Auto-redaction** — pattern-matches and replaces:
   - Credit card numbers → `[REDACTED:card]`
   - API keys (`sk-`, `pk-`, `api_key=`) → `[REDACTED:apikey]`
   - Bearer tokens → `[REDACTED:bearer]`
   - AWS access keys (`AKIA`, `ASIA`) → `[REDACTED:awskey]`
   - Passwords in assignments → `[REDACTED:password]`

### Server-side (sinain-hud plugin)

The `tool_result_persist` hook strips any remaining `<private>` tags from tool results before they're saved to session history. This catches content that bypassed the client filter (e.g., tool outputs generated server-side).

## 2-Pass Context Reading

HEARTBEAT.md implements a progressive disclosure strategy to minimize token usage:

**Pass 1 (lightweight, every tick):**
```javascript
sessions_history({ sessionKey: "agent:main:sinain", limit: 50, includeTools: false })
```
Message summaries only — scans for signals (errors, feedback, spawn results, topic changes).

**Pass 2 (targeted, only if Pass 1 found signals):**
```javascript
sessions_history({ sessionKey: "agent:main:sinain", limit: 10, includeTools: true })
```
Full tool details for the most recent active window. Skipped entirely on idle ticks with no signals — saves 3-5x in token usage.

## Deploying Plugin Updates

### sinain-hud plugin

```bash
# Upload updated plugin code
scp -i ~/.ssh/id_ed25519_strato \
  sinain-hud-plugin/index.ts sinain-hud-plugin/openclaw.plugin.json \
  root@85.214.180.247:/mnt/openclaw-state/extensions/sinain-hud/

# Restart to reload
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose restart'
```

### Skill files (HEARTBEAT.md, SKILL.md)

```bash
# Upload to persistent source dir (plugin auto-deploys to workspace)
scp -i ~/.ssh/id_ed25519_strato \
  skills/sinain-hud/HEARTBEAT.md \
  root@85.214.180.247:/mnt/openclaw-state/sinain-sources/HEARTBEAT.md

# No restart needed — plugin syncs on next agent start
```

### claude-mem plugin

```bash
# Upload updated plugin
scp -i ~/.ssh/id_ed25519_strato \
  <claude-mem-dir>/index.ts <claude-mem-dir>/openclaw.plugin.json \
  root@85.214.180.247:/mnt/openclaw-state/extensions/claude-mem/

# Restart (also restarts the worker via start-services.sh)
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose restart'
```

## Troubleshooting

### Plugin not loading

```bash
# Check gateway logs for plugin registration
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose logs --tail 50 | grep -i plugin'

# Expected: "sinain-hud: plugin registered"
# If missing: check openclaw.plugin.json is valid JSON, check extensions/ path
```

### Worker not starting

```bash
# Check if start-services.sh ran
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose exec openclaw-gateway ps aux | grep bun'

# Check worker health
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose exec openclaw-gateway curl -s http://localhost:37777/health'

# If bun not found: it needs to be installed (doesn't survive container rebuilds)
```

### Observation feed disconnecting

The SSE connection from claude-mem to Telegram can drop if:
- The Telegram bot token is invalid or rate-limited
- The worker crashed (check worker health above)
- Network issues between server and Telegram API

Check worker logs and restart if needed:
```bash
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose logs --tail 30 | grep -i "observation\|feed\|sse"'
```

### Auto-deploy not working

If HEARTBEAT.md or SKILL.md aren't being synced to the workspace:
1. Verify source files exist: `ls /mnt/openclaw-state/sinain-sources/`
2. Check plugin config has correct `heartbeatPath` / `skillPath`
3. Check gateway logs for sync messages: `grep "sinain-hud: synced" <logs>`
