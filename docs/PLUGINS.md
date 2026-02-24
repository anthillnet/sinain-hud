# Plugin Architecture

Full reference for the OpenClaw plugins running on the strato server. For gateway setup, see [OPENCLAW-SETUP.md](./OPENCLAW-SETUP.md).

## Overview

One plugin is deployed on the server:

| Plugin | Purpose | Location |
|---|---|---|
| **sinain-hud** | Agent lifecycle management (file sync, privacy, session summaries) | `/mnt/openclaw-state/extensions/sinain-hud/` |

## Server File Layout

```
/mnt/openclaw-state/                     # bind-mounted as /home/node/.openclaw
├── openclaw.json                        # main gateway config (plugins, agents, auth)
├── extensions/
│   └── sinain-hud/
│       ├── index.ts                     # plugin implementation
│       └── openclaw.plugin.json         # plugin manifest
├── sinain-sources/
│   ├── HEARTBEAT.md                     # source of truth for auto-deploy
│   └── SKILL.md
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

## Troubleshooting

### Plugin not loading

```bash
# Check gateway logs for plugin registration
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose logs --tail 50 | grep -i plugin'

# Expected: "sinain-hud: plugin registered"
# If missing: check openclaw.plugin.json is valid JSON, check extensions/ path
```

### Auto-deploy not working

If HEARTBEAT.md or SKILL.md aren't being synced to the workspace:
1. Verify source files exist: `ls /mnt/openclaw-state/sinain-sources/`
2. Check plugin config has correct `heartbeatPath` / `skillPath`
3. Check gateway logs for sync messages: `grep "sinain-hud: synced" <logs>`
