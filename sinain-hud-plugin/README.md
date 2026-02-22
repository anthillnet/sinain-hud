# sinain-hud OpenClaw Plugin

OpenClaw plugin that manages the sinain-hud agent lifecycle on the server.

## What It Does

Four lifecycle hooks + one command:

| Hook | Purpose |
|---|---|
| `session_start` | Initializes per-session tool usage tracking |
| `before_agent_start` | Syncs HEARTBEAT.md, SKILL.md, and sinain-koog/ scripts from `sinain-sources/` to the agent workspace; creates `memory/` directories |
| `tool_result_persist` | Strips `<private>` tags from tool results before they're saved to session history |
| `agent_end` | Writes structured session summary to `memory/session-summaries.jsonl` |

**Command:** `/sinain_status` — shows active sessions, uptime, and tool call counts.

## Configuration

Configured in `openclaw.json` under `plugins.entries.sinain-hud`:

```json
{
  "plugins": {
    "entries": {
      "sinain-hud": {
        "heartbeatPath": "sinain-sources/HEARTBEAT.md",
        "skillPath": "sinain-sources/SKILL.md",
        "koogPath": "sinain-sources/sinain-koog",
        "sessionKey": "agent:main:sinain",
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

| Field | Type | Description |
|---|---|---|
| `heartbeatPath` | string | Path to HEARTBEAT.md source (resolved relative to state dir) |
| `skillPath` | string | Path to SKILL.md source |
| `koogPath` | string | Path to sinain-koog/ scripts directory |
| `sessionKey` | string | Session key for the sinain agent |
| `observationFeed.enabled` | boolean | Enable observation streaming |
| `observationFeed.channel` | string | Delivery channel (`telegram`, `discord`, `slack`) |
| `observationFeed.targetId` | string | Target chat/channel ID |

## File Auto-Deploy

The `before_agent_start` hook copies files from the persistent source directory to the agent workspace:

```
/mnt/openclaw-state/sinain-sources/     →  /home/node/.openclaw/workspace/
  HEARTBEAT.md                               HEARTBEAT.md
  SKILL.md                                   SKILL.md
  sinain-koog/                               sinain-koog/
    common.py                                  common.py
    signal_analyzer.py                         signal_analyzer.py
    feedback_analyzer.py                       feedback_analyzer.py
    memory_miner.py                            memory_miner.py
    playbook_curator.py                        playbook_curator.py
    insight_synthesizer.py                     insight_synthesizer.py
    git_backup.sh                              git_backup.sh  (chmod 755)
    requirements.txt                           requirements.txt
```

Only writes if content has actually changed (avoids unnecessary git diffs). Also ensures `memory/`, `memory/playbook-archive/`, and `memory/playbook-logs/` directories exist. The `git_backup.sh` script is automatically made executable after sync.

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
  "toolBreakdown": { "sessions_history": 3, "sessions_spawn": 1, "Write": 5 },
  "messageCount": 8
}
```

## Deployment

```bash
# Upload plugin files to the server
scp -i ~/.ssh/id_ed25519_strato \
  sinain-hud-plugin/index.ts sinain-hud-plugin/openclaw.plugin.json \
  root@85.214.180.247:/mnt/openclaw-state/extensions/sinain-hud/

# Restart gateway to load updated plugin
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247 \
  'cd /opt/openclaw && docker compose restart'
```

## Files

| File | Purpose |
|---|---|
| `index.ts` | Plugin implementation (hooks, commands, services) |
| `openclaw.plugin.json` | Plugin manifest (metadata, config schema, UI hints) |
