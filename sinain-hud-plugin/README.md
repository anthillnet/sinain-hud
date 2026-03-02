# sinain-hud OpenClaw Plugin

OpenClaw plugin that manages the sinain-hud agent lifecycle on the server.

## What It Does

Five lifecycle hooks, one tool, four commands, and a background service:

### Hooks

| Hook | Purpose |
|---|---|
| `session_start` | Initializes per-session tool usage and compliance tracking |
| `before_agent_start` | Syncs HEARTBEAT.md, SKILL.md, sinain-koog/ (recursively, including eval/), and modules/ from `sinain-sources/` to workspace; generates effective playbook; creates memory directories |
| `tool_result_persist` | Strips `<private>` tags from tool results; tracks `sinain_heartbeat_tick` calls for compliance validation |
| `agent_end` | Writes structured session summary; validates heartbeat compliance (warns on skip, escalates after 3 consecutive skips) |
| `session_end` | Cleans up orphaned session state |

### Tool

| Tool | Purpose |
|---|---|
| `sinain_heartbeat_tick` | Executes all heartbeat mechanical work (git backup, signal analysis, insight synthesis, log writing). Returns structured JSON with results, recommended actions, and Telegram output. |

The heartbeat tool accepts `{ sessionSummary: string, idle: boolean }` and runs:
1. `bash sinain-koog/git_backup.sh` (30s timeout)
2. `uv run python3 sinain-koog/signal_analyzer.py` (60s timeout)
3. `uv run python3 sinain-koog/insight_synthesizer.py` (60s timeout)
4. Writes log entry to `memory/playbook-logs/YYYY-MM-DD.jsonl`

### Commands

| Command | Purpose |
|---|---|
| `/sinain_status` | Shows persistent session data from `sessions.json` (update time, tokens, compactions, transcript size) and resilience metrics |
| `/sinain_modules` | Shows active knowledge module stack, suspended and disabled modules |
| `/sinain_eval` | Shows latest evaluation report and recent tick evaluation metrics |
| `/sinain_eval_level` | Sets evaluation level: `mechanical`, `sampled`, or `full` |

### Service

**Curation pipeline** — runs every 30 minutes in the background:
1. Feedback analysis (`feedback_analyzer.py`) → extracts `curateDirective` + effectiveness metrics
2. Memory mining (`memory_miner.py`) → reads unread daily memory files
3. Playbook curation (`playbook_curator.py`) → archives, applies changes
4. Effectiveness footer update → writes metrics into playbook
5. Effective playbook regeneration → merges base playbook + active module patterns
6. Tick evaluation (`tick_evaluator.py`) → runs mechanical + sampled judges (120s timeout)
7. Daily eval report (`eval_reporter.py`) → generates report once per day after 03:00 UTC

## Configuration

Configured in `openclaw.json` under `plugins.entries.sinain-hud`:

```json
{
  "plugins": {
    "entries": {
      "sinain-hud": {
        "enabled": true,
        "config": {
          "heartbeatPath": "/home/node/.openclaw/sinain-sources/HEARTBEAT.md",
          "skillPath": "/home/node/.openclaw/sinain-sources/SKILL.md",
          "koogPath": "/home/node/.openclaw/sinain-sources/sinain-koog",
          "modulesPath": "/home/node/.openclaw/sinain-sources/modules",
          "sessionKey": "agent:main:sinain"
        }
      }
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `heartbeatPath` | string | Path to HEARTBEAT.md source (resolved relative to state dir) |
| `skillPath` | string | Path to SKILL.md source |
| `koogPath` | string | Path to sinain-koog/ scripts directory |
| `modulesPath` | string | Path to modules/ directory for knowledge module system |
| `sessionKey` | string | Session key for the sinain agent |

## File Auto-Deploy

The `before_agent_start` hook copies files from the persistent source directory to the agent workspace:

```
/mnt/openclaw-state/sinain-sources/     →  /home/node/.openclaw/workspace/
  HEARTBEAT.md                               HEARTBEAT.md
  SKILL.md                                   SKILL.md
  sinain-koog/                               sinain-koog/
    *.json, *.sh, *.txt                        (always overwritten)
    *.py                                       (deploy-once — skip if exists)
  modules/                                   modules/
    manifest.json                              (always overwritten)
    module-registry.json                       (deploy-once)
    */patterns.md                              (deploy-once)
  sinain-koog/eval/                          sinain-koog/eval/   (recursive)
    *.py                                       (deploy-once)
    *.json, *.jsonl                             (always overwritten)
```

Only writes if content has actually changed (avoids unnecessary git diffs).

Also ensures these directories exist:
- `memory/`, `memory/playbook-archive/`, `memory/playbook-logs/`
- `memory/eval-logs/`, `memory/eval-reports/`

The `git_backup.sh` script is automatically made executable (chmod 755) after sync.

After syncing modules, the plugin generates `memory/sinain-playbook-effective.md` — a merged view of active module patterns (sorted by priority) plus the base playbook.

## Heartbeat Compliance Validation

The plugin enforces that the agent actually calls `sinain_heartbeat_tick` during heartbeat runs:

1. `tool_result_persist` sets `heartbeatToolCalled = true` when `sinain_heartbeat_tick` is invoked
2. `agent_end` checks if the run was a heartbeat (`messageProvider === "heartbeat"`)
3. If tool wasn't called: logs warning, increments `consecutiveHeartbeatSkips` counter
4. After 3 consecutive skips: logs ESCALATION warning
5. A successful tool call resets the counter to 0

## Privacy Tag Stripping

The `tool_result_persist` hook intercepts tool results before they're saved to session history. Any `<private>...</private>` blocks are removed from:
- String content (simple tool results)
- Text blocks in array content (structured tool results)

This is the server-side complement to sense_client's client-side `apply_privacy()` filter.

## Session Summaries

On `agent_end`, the plugin appends a JSON line to `memory/session-summaries.jsonl`:

```json
{
  "ts": "2026-02-18T12:00:00.000Z",
  "sessionKey": "agent:main:sinain",
  "agentId": "...",
  "durationMs": 45000,
  "success": true,
  "error": null,
  "toolCallCount": 12,
  "toolBreakdown": { "sessions_history": 3, "sinain_heartbeat_tick": 1, "Write": 5 },
  "messageCount": 8
}
```

## Context Overflow Watchdog

Automatically recovers from runaway context growth that causes repeated agent failures.

- **Detection:** Tracks consecutive errors matching `/overloaded|context.*too.*long|token.*limit/i` on `cfg.sessionKey`
- **Trigger:** 5 consecutive errors + transcript ≥ 1 MB
- **Action:** Archives transcript via `copyFileSync`, truncates to empty, resets `contextTokens` in `sessions.json`
- **Resets:** Counter clears on any successful session completion and on `gateway_start`

The 1 MB minimum guard prevents resets from transient API outages when the transcript is small.

## Deployment

**IMPORTANT:** Use `docker-compose.openclaw.yml` — the default compose file uses unset env vars and will fail.

```bash
# Upload plugin files to the server
scp -i ~/.ssh/id_ed25519_strato \
  sinain-hud-plugin/index.ts sinain-hud-plugin/openclaw.plugin.json \
  root@85.214.180.247:/mnt/openclaw-state/extensions/sinain-hud/

# Restart gateway to load updated plugin
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml restart'

# Verify plugin loaded
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml logs --tail=30 openclaw-gateway 2>&1 | grep sinain'
```

## Files

| File | Purpose |
|---|---|
| `index.ts` | Plugin implementation (hooks, tool, commands, curation service) |
| `openclaw.plugin.json` | Plugin manifest (metadata, config schema, UI hints) |
