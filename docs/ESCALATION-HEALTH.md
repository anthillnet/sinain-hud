# Escalation Health Monitoring

## Architecture

```
sense_client → sinain-core → OpenClaw WS → agent → reply → HUD overlay
                 (escalator)   (gateway)    (run)
```

sinain-core's `Escalator` sends escalation messages to the OpenClaw gateway via a persistent WebSocket. The gateway dispatches an agent run, which processes the message and returns a response. The response is pushed to the HUD overlay feed.

## Health Endpoint

```bash
curl localhost:9500/health | jq '.warnings'
```

### Warnings Array

The `/health` endpoint returns a `warnings` array computed from escalation metrics. An empty array means healthy.

| Warning | Condition | Meaning |
|---------|-----------|---------|
| `high_timeout_rate: N%` | >30% timeouts after 5+ attempts | Gateway overloaded or slow — runs queue up |
| `consecutive_timeouts: N` | 3+ timeouts in a row | Active cascade — no responses getting through |
| `stale_responses: Nmin` | >5min since last response | Agent may be stuck or session bloated |
| `no_direct_responses` | >5 spawns, 0 direct replies | Escalation RPC failing silently; only spawn tasks succeed |
| `slow_responses: Nms avg` | EMA response time >30s | Agent taking too long — context may be bloated |

### Key Metrics in `escalation` Object

| Metric | Description |
|--------|-------------|
| `totalTimeouts` | RPC calls that hit the timeout (120s) |
| `totalDirectResponses` | Successful escalation replies |
| `totalSpawnResponses` | Successful subagent task completions |
| `avgResponseMs` | Exponential moving average (alpha=0.2) of RPC latency |
| `consecutiveTimeouts` | Resets to 0 on any success |
| `lastTimeoutTs` | Unix timestamp of most recent timeout |

## Failure Modes

### 1. RPC Timeout Cascade

**Symptoms:** `high_timeout_rate`, `consecutive_timeouts`, HUD shows no `[🤖]` responses.

**Mechanism:** When `ESCALATION_COOLDOWN_MS` < actual response time, sinain-core fires new escalations before previous ones complete. Each creates a new agent run on the server. Old runs block new ones (`embedded run timeout: 600000ms`), creating a backlog.

**Fix:**
- Increase `ESCALATION_COOLDOWN_MS` (default: 60000ms)
- Check server for run backlog: `docker compose -f docker-compose.openclaw.yml logs --tail=50 openclaw-gateway | grep "embedded run"`
- The plugin's proactive session hygiene should auto-archive if the session is bloated

### 2. Session Context Bloat

**Symptoms:** `slow_responses`, runs taking >60s, `stale_responses`.

**Mechanism:** The sinain session transcript grows indefinitely. Once >2MB, the agent's context compaction slows dramatically, causing `embedded run timeout` errors. Each failed run adds error output to the transcript, accelerating the bloat.

**Fix:**
- Proactive: Plugin timer checks every 30min, archives if >2MB or >24h old
- Reactive: Plugin overflow watchdog triggers after 5 consecutive context errors
- Manual: SSH to server and truncate the session file
  ```bash
  ssh root@85.214.180.247
  cd /mnt/openclaw-state/agents/main/sessions
  ls -la *.jsonl  # Find the sinain session
  cp agent:main:sinain.jsonl agent:main:sinain.archived.$(date +%s).jsonl
  > agent:main:sinain.jsonl
  ```

### 3. Stale Context Pollution

**Symptoms:** Agent responses reference outdated state, `stale_responses`.

**Mechanism:** SITUATION.md not updating (sense_client disconnected or OCR stalled). Agent receives fresh escalations but makes decisions based on hours-old context.

**Fix:**
- Check `curl localhost:9500/health | jq '.agent.lastAnalysisTs'` — should be recent
- Verify sense_client is connected: overlay should show `[👁]` items
- Check audio pipeline status in health payload

### 4. Circuit Breaker Trip

**Symptoms:** No escalations at all, `gatewayConnected: false` or logs show "circuit breaker opened".

**Mechanism:** 5 RPC failures within 2min window triggers circuit breaker. Pauses all escalation for 5min (doubling on repeated trips, max 30min).

**Fix:**
- Wait for auto-reset (circuit breaker is self-healing)
- Check if gateway is actually down: `curl http://85.214.180.247:18789/health`
- If gateway is up but circuit tripped, restart sinain-core

## Runbook: Diagnosing "Agent Not Responding"

```bash
# 1. Check health
curl -s localhost:9500/health | jq '{warnings, escalation: {mode: .escalation.mode, connected: .escalation.gatewayConnected, timeouts: .escalation.totalTimeouts, responses: .escalation.totalDirectResponses, consecutive: .escalation.consecutiveTimeouts, avgMs: .escalation.avgResponseMs}}'

# 2. If warnings present — check gateway server
ssh root@85.214.180.247
docker compose -f /opt/openclaw/docker-compose.openclaw.yml logs --tail=30 openclaw-gateway

# 3. Check session size
ls -la /mnt/openclaw-state/agents/main/sessions/*.jsonl

# 4. If session is >2MB — manual reset
cd /mnt/openclaw-state/agents/main/sessions
cp <session>.jsonl <session>.archived.$(date +%s).jsonl
> <session>.jsonl

# 5. Restart gateway if needed
cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml restart

# 6. Verify recovery
curl -s localhost:9500/health | jq '.warnings'
# Should be empty after a successful escalation
```

## Configuration Knobs

| Variable | File | Default | Purpose |
|----------|------|---------|---------|
| `ESCALATION_COOLDOWN_MS` | `.env` | 60000 | Min interval between escalation attempts |
| RPC timeout | `openclaw-ws.ts` | 120000 | Max wait for agent RPC response |
| `OVERFLOW_TRANSCRIPT_MIN_BYTES` | `sinain-hud-plugin` | 1MB | Min size for reactive overflow reset |
| `SESSION_HYGIENE_SIZE_BYTES` | `sinain-hud-plugin` | 2MB | Proactive archive threshold |
| `SESSION_HYGIENE_AGE_MS` | `sinain-hud-plugin` | 24h | Max session age before proactive reset |
| Circuit breaker threshold | `openclaw-ws.ts` | 5 failures/2min | Trips circuit breaker |
| Circuit reset delay | `openclaw-ws.ts` | 5min (doubling, max 30min) | Auto-reset interval |

## Proactive Session Hygiene

The sinain-hud plugin runs a curation timer every 30 minutes. After the curation pipeline completes, it checks the sinain session transcript:

1. Reads `sessions.json` to find the session file path and creation time
2. If the transcript file is >2MB **or** the session is >24h old:
   - Archives the transcript (copies to `.archived.<timestamp>.jsonl`)
   - Truncates the active transcript to empty
   - Resets context token count in sessions.json
   - Clears outage and overflow error counters
3. Logs `proactive session hygiene — size=NKB, age=Nh`

This runs independently of error-triggered resets and prevents the slow context bloat that causes timeout cascades.
