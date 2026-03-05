# Plugin Architecture

Full reference for the OpenClaw plugins running on the strato server. For gateway setup, see [OPENCLAW-SETUP.md](./OPENCLAW-SETUP.md).

## Overview

One plugin is deployed on the server:

| Plugin | Purpose | Location |
|---|---|---|
| **sinain-hud** | Agent lifecycle management (file sync, heartbeat tool, privacy, compliance, curation, session summaries) | `/mnt/openclaw-state/extensions/sinain-hud/` |

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
│   ├── SKILL.md
│   ├── sinain-koog/                     # reflection scripts (auto-deployed)
│   │   ├── common.py
│   │   ├── signal_analyzer.py
│   │   ├── feedback_analyzer.py
│   │   ├── memory_miner.py
│   │   ├── playbook_curator.py
│   │   ├── insight_synthesizer.py
│   │   ├── tick_evaluator.py
│   │   ├── eval_reporter.py
│   │   ├── git_backup.sh
│   │   ├── koog-config.json
│   │   └── eval/
│   │       ├── assertions.py
│   │       ├── schemas.py
│   │       ├── judges/
│   │       │   ├── base_judge.py
│   │       │   ├── signal_judge.py
│   │       │   ├── curation_judge.py
│   │       │   ├── insight_judge.py
│   │       │   └── mining_judge.py
│   │       └── scenarios/
│   │           └── *.jsonl
│   └── modules/                         # knowledge modules (auto-deployed)
│       ├── module-registry.json
│       └── <module-id>/
│           ├── manifest.json
│           └── patterns.md
├── workspace/                           # agent workspace
│   ├── HEARTBEAT.md                     # deployed by plugin from sinain-sources/
│   ├── SKILL.md
│   ├── SITUATION.md
│   ├── sinain-koog/                     # deployed scripts
│   ├── modules/                         # deployed knowledge modules
│   └── memory/
│       ├── sinain-playbook.md
│       ├── sinain-playbook-effective.md # merged base + module patterns
│       ├── session-summaries.jsonl      # written by sinain-hud plugin
│       ├── playbook-archive/
│       ├── playbook-logs/               # heartbeat tick logs (YYYY-MM-DD.jsonl)
│       ├── eval-logs/
│       └── eval-reports/
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
            └─► Register hooks, commands, tools, services
                 │
                 ▼
         Hooks fire on agent events:
           session_start → before_agent_start → tool_result_persist → agent_end → session_end

         Tools available during agent sessions:
           sinain_heartbeat_tick — deterministic heartbeat execution

         Services run in background:
           Curation pipeline — 30-minute timer
```

Plugins register hooks via `api.on(eventName, handler)`. The `tool_result_persist` hook is synchronous (can modify tool results before they're saved); all others are async. Tools are registered via `api.registerTool()` and become available to the agent during sessions.

## sinain-hud Plugin

See [sinain-hud-plugin/README.md](../sinain-hud-plugin/README.md) for the full reference.

**Hooks:**
- `session_start` — initializes per-session tracking (tool usage, heartbeat compliance)
- `before_agent_start` — syncs HEARTBEAT.md, SKILL.md, sinain-koog/ (recursively, including eval/ subdirectory), and modules/ from `sinain-sources/` to workspace; generates effective playbook; creates memory directories
- `tool_result_persist` — strips `<private>` tags from tool results; tracks `sinain_heartbeat_tick` calls for compliance
- `agent_end` — writes session summary; validates heartbeat compliance (logs warnings on skip, escalates after 3 consecutive skips)

**Tool:**
- `sinain_heartbeat_tick` — executes all heartbeat mechanical work (git backup, signal analysis, insight synthesis, log writing) and returns structured JSON with results, recommended actions, and Telegram output

**Commands:**
- `/sinain_status` — shows persistent session data from disk (update time, token count, compactions, transcript size) and resilience metrics
- `/sinain_modules` — shows active knowledge module stack and suspended modules
- `/sinain_eval` — shows latest evaluation report and metrics
- `/sinain_eval_level` — sets evaluation level (mechanical, sampled, full)

**Service:**
- Curation pipeline on 30-minute timer:
  1. Feedback analysis (`feedback_analyzer.py`) → extracts `curateDirective` + effectiveness metrics
  2. Memory mining (`memory_miner.py`) → reads unread daily memory files
  3. Playbook curation (`playbook_curator.py`) → archives, applies changes
  4. Effectiveness footer update → writes metrics into playbook
  5. Effective playbook regeneration → merges base playbook + active module patterns
  6. Tick evaluation (`tick_evaluator.py`) → runs mechanical + sampled judges (120s timeout)
  7. Daily eval report (`eval_reporter.py`) → generates report once per day after 03:00 UTC

**Auto-deploy flow:**
```
sinain-hud repo                  Server                          Agent workspace
skills/sinain-hud/    ──SCP──►  sinain-sources/   ──plugin──►  workspace/
  HEARTBEAT.md                    HEARTBEAT.md                   HEARTBEAT.md
  SKILL.md                        SKILL.md                       SKILL.md
sinain-koog/          ──SCP──►  sinain-sources/   ──plugin──►  workspace/
  *.py, *.sh, *.json              sinain-koog/                   sinain-koog/
  eval/                           sinain-koog/eval/              sinain-koog/eval/
```

SCP is manual (or via `/deploy-heartbeat` skill). Plugin sync happens automatically on each agent start.

**Directory sync policy:**
- `.json`, `.sh`, `.txt` — always overwritten (infra/config files)
- `.py` — deploy-once only (skip if already exists; agent owns these after first deploy)
- `modules/manifest.json` — always overwrite
- `modules/module-registry.json`, `modules/*/patterns.md` — deploy-once
- `eval/` — synced recursively; `.py` deploy-once, `.json`/`.jsonl` always overwritten

## Heartbeat Tool

The `sinain_heartbeat_tick` tool replaces the old multi-phase heartbeat protocol. Instead of the agent manually running 5 phases of scripts, the tool handles everything deterministically:

1. **Git backup** (30s timeout) — commits and pushes workspace changes
2. **Signal analysis** (60s timeout) — analyzes session history for actionable signals
3. **Insight synthesis** (60s timeout) — generates suggestions/insights
4. **Log writing** — appends structured JSON to `memory/playbook-logs/YYYY-MM-DD.jsonl`

Returns structured JSON:
```json
{
  "status": "ok",
  "gitBackup": "abc1234 | nothing to commit",
  "signals": [...],
  "recommendedAction": { "action": "skip|sessions_spawn|telegram_tip", "task": "...", "confidence": 0.8 },
  "output": { "suggestion": "...", "insight": "..." },
  "skipped": false,
  "skipReason": null,
  "logWritten": true
}
```

The agent's only responsibilities are:
1. Fetch session history and compose a summary
2. Call `sinain_heartbeat_tick` with the summary
3. Act on `recommendedAction` (spawn subagent or send Telegram tip)
4. Reply HEARTBEAT_OK

### Heartbeat Compliance Validation

The plugin tracks whether `sinain_heartbeat_tick` was called during heartbeat agent runs:
- `tool_result_persist` hook sets `heartbeatToolCalled = true` when the tool is invoked
- `agent_end` hook checks if the agent was a heartbeat run (`messageProvider === "heartbeat"`)
- If the tool wasn't called: logs a warning, increments `consecutiveHeartbeatSkips`
- After 3 consecutive skips: logs an ESCALATION warning

This prevents the agent from replying HEARTBEAT_OK without actually executing the heartbeat work.

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

## Context Overflow Watchdog

Protects against runaway context growth that causes repeated agent failures.

**Detection:** The `session_end` hook tracks consecutive errors on `cfg.sessionKey` that match `/overloaded|context.*too.*long|token.*limit/i`.

**Trigger:** 5 consecutive matching errors AND transcript file ≥ 1 MB.

**Action:**
1. Archive transcript via `copyFileSync` → `<name>.archived.<timestamp>.jsonl`
2. Truncate original transcript to empty
3. Reset `contextTokens` to 0 in `sessions.json`
4. Clear all resilience counters (overflow, outage, consecutive failures)

**Counter resets:**
- On any successful session completion (for the monitored session key)
- On `gateway_start` (full tracking state reset)

The 1 MB minimum guard prevents resets caused by transient API outages when the transcript is actually small.

## Deploying Plugin Updates

**IMPORTANT:** Always use `docker-compose.openclaw.yml` — the default `docker-compose.yml` uses unset env vars and will fail.

### sinain-hud plugin

```bash
# Upload updated plugin code
scp -i ~/.ssh/<your-key> \
  sinain-hud-plugin/index.ts sinain-hud-plugin/openclaw.plugin.json \
  root@<your-server-ip>:/mnt/openclaw-state/extensions/sinain-hud/

# Restart to reload (MUST use -f flag)
ssh -i ~/.ssh/<your-key> root@<your-server-ip> \
  'cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml restart'
```

### Skill files (HEARTBEAT.md, SKILL.md)

```bash
# Upload to persistent source dir (plugin auto-deploys to workspace)
scp -i ~/.ssh/<your-key> \
  skills/sinain-hud/HEARTBEAT.md \
  root@<your-server-ip>:/mnt/openclaw-state/sinain-sources/HEARTBEAT.md

# No restart needed — plugin syncs on next agent start
```

### sinain-koog scripts

```bash
# Upload updated scripts (top-level files)
scp -i ~/.ssh/<your-key> \
  sinain-koog/*.py sinain-koog/*.sh sinain-koog/*.json sinain-koog/*.txt \
  root@<your-server-ip>:/mnt/openclaw-state/sinain-sources/sinain-koog/

# Upload eval/ subdirectory (judges, scenarios, assertions)
scp -ri ~/.ssh/<your-key> \
  sinain-koog/eval/ \
  root@<your-server-ip>:/mnt/openclaw-state/sinain-sources/sinain-koog/eval/

# No restart needed — .json/.sh/.txt/.jsonl always overwritten on agent start
# .py files are deploy-once: only copied if not already present in workspace
```

### Gateway config (openclaw.json)

```bash
# Read current config
ssh -i ~/.ssh/<your-key> root@<your-server-ip> \
  'cat /mnt/openclaw-state/openclaw.json'

# Edit (note: em-dashes are stored as \u2014 in JSON)
ssh -i ~/.ssh/<your-key> root@<your-server-ip> \
  'sed -i "s|old text|new text|" /mnt/openclaw-state/openclaw.json'

# Restart required after config changes
ssh -i ~/.ssh/<your-key> root@<your-server-ip> \
  'cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml restart'
```

## Troubleshooting

### Plugin not loading

```bash
# Check gateway logs for plugin registration
ssh -i ~/.ssh/<your-key> root@<your-server-ip> \
  'cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml logs --tail 50 openclaw-gateway 2>&1 | grep -i plugin'

# Expected: "sinain-hud: plugin registered"
# If missing: check openclaw.plugin.json is valid JSON, check extensions/ path
```

### Auto-deploy not working

If HEARTBEAT.md or SKILL.md aren't being synced to the workspace:
1. Verify source files exist: `ls /mnt/openclaw-state/sinain-sources/`
2. Check plugin config has correct `heartbeatPath` / `skillPath`
3. Check gateway logs for sync messages: `grep "sinain-hud: synced" <logs>`

### Gateway restart fails

If `docker compose restart` fails with "invalid spec" or empty variable errors:
- You're using the wrong compose file. Use `-f docker-compose.openclaw.yml`
- The default `docker-compose.yml` references `${OPENCLAW_CONFIG_DIR}` which is not set on the host

### Context overflow auto-reset fired

If logs show "OVERFLOW THRESHOLD REACHED — attempting transcript reset":
- This is expected when the agent hits context limits repeatedly (5 consecutive overload errors + transcript ≥ 1 MB)
- Check `memory/` for the archived transcript: `*.archived.<timestamp>.jsonl`
- The agent should recover automatically on the next tick
- If resets happen frequently, check compaction settings (`maxHistoryShare`, `reserveTokensFloor`) in openclaw.json
- If resets are skipped ("transcript only XKB"), the errors are likely transient API outages, not real overflow

### Heartbeat compliance warnings

If logs show "heartbeat compliance violation — tool not called":
- The agent replied HEARTBEAT_OK without calling `sinain_heartbeat_tick`
- Check HEARTBEAT.md content is the tool-based version (should reference `sinain_heartbeat_tick`)
- Check the heartbeat prompt in `openclaw.json` mentions the tool call requirement
