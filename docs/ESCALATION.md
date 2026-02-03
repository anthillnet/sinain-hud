# OpenClaw Escalation Pipeline

Technical reference for the SITUATION.md writer and OpenClaw escalation system in sinain-hud.

## Overview

The escalation pipeline connects sinain-hud's relay agent to an OpenClaw instance, enabling proactive AI assistance based on what the user is doing. It works through two mechanisms:

- **Passive (SITUATION.md)** — Every relay tick writes a structured markdown file to disk. OpenClaw reads it on demand when an agent starts. Local only.
- **Active (HTTP hooks + WebSocket)** — When certain conditions are met, the relay pushes context to OpenClaw via HTTP, then waits for the agent response over WebSocket. Works remotely.

The full flow:

```
Relay Agent Tick
  ├─ writeSituationMd()  →  ~/.openclaw/workspace/SITUATION.md  (passive, local only)
  │
  ├─ shouldEscalate()    →  score-based decision (selective) or always (focus)
  │
  └─ escalateToOpenClaw()
       ├─ POST /hooks/agent  →  OpenClaw Gateway (HTTP, remote OK)
       │     └─ returns runId
       └─ agent.wait RPC     →  OpenClaw Gateway (WebSocket)
             └─ response → /feed → overlay
```

## Escalation Modes

Controlled by `ESCALATION_MODE` env var. Switchable at runtime via `POST /agent/config`.

### `off`

No escalation. SITUATION.md is still written (if enabled), but no HTTP hooks or WebSocket calls are made.

### `selective` (default)

Score-based. The relay evaluates each digest against pattern lists and only escalates when the cumulative score reaches the threshold (>= 3 points). Recommended for production — balances responsiveness with API cost.

### `focus`

Every non-idle digest change triggers escalation. Useful during active debugging sessions where you want maximum agent involvement. High API usage.

### Runtime switching

```bash
# Switch to focus mode
curl -X POST http://localhost:9500/agent/config \
  -H 'Content-Type: application/json' \
  -d '{"escalationMode": "focus"}'

# Disable escalation
curl -X POST http://localhost:9500/agent/config \
  -d '{"escalationMode": "off"}'
```

When switching away from `off`, the gateway WebSocket connection is established. When switching to `off`, it is torn down.

## Score-Based Selective Escalation

In `selective` mode, each digest is scored against pattern categories:

| Category | Patterns | Score |
|----------|----------|-------|
| **Errors** | `error`, `failed`, `failure`, `exception`, `crash`, `traceback`, `typeerror`, `referenceerror`, `syntaxerror`, `cannot read`, `undefined is not`, `exit code`, `segfault`, `panic`, `fatal` | +3 |
| **Questions / help** (audio) | `how do i`, `how to`, `what if`, `why is`, `help me`, `not working`, `stuck`, `confused`, `any ideas`, `suggestions` | +2 |
| **Code complexity** | `todo`, `fixme`, `hack`, `workaround`, `deprecated` | +1 |
| **App switches** | 4+ apps in context window history | +1 |

**Threshold:** >= 3 points to trigger escalation.

Error patterns are matched against the digest text. Question patterns are matched against audio transcripts in the context window. Each category contributes at most once per tick.

### Guards

- **Cooldown:** Minimum `ESCALATION_COOLDOWN_MS` (default 30s) between escalations.
- **Duplicate suppression:** Identical consecutive digests are not re-escalated.
- **Idle suppression:** Digests of `Idle` or `—` never escalate.

## SITUATION.md Format

Written to `$OPENCLAW_WORKSPACE_DIR/SITUATION.md` (default `~/.openclaw/workspace/SITUATION.md`).

```markdown
# Situation

> Auto-updated by sinain-hud relay at 2025-01-15T10:30:00.000Z
> Tick #42 | Latency: 1200ms | Model: google/gemini-2.5-flash-lite

## Digest

User is debugging a TypeScript compilation error in VS Code. The terminal shows
a type mismatch in auth-handler.ts. They switched to the browser briefly to
check the docs, then returned to the editor.

## Active Application

Visual Studio Code

## App History

Visual Studio Code -> Google Chrome -> Visual Studio Code

## Screen (OCR)

- [5s ago] [Visual Studio Code] error TS2345: Argument of type 'string' is not ...
- [15s ago] [Visual Studio Code] import { AuthHandler } from './auth-handler' ...
- [35s ago] [Google Chrome] TypeScript Handbook - Utility Types ...

## Audio Transcripts

- [10s ago] okay so this type error is because the handler expects a number but ...
- [40s ago] let me check the docs for this

## Metadata

- Screen events in window: 8
- Audio events in window: 3
- Context window: 120s
- Parsed OK: true
```

### Size limits

| Field | Limit |
|-------|-------|
| OCR text per screen event | 500 characters |
| Audio text per transcript | 500 characters |
| Screen events displayed | All in context window (typically ~15) |
| Audio events displayed | All in context window (typically ~5) |

### Atomic writes

The file is written to `SITUATION.md.tmp` first, then renamed to `SITUATION.md`. This prevents partial reads by OpenClaw or other consumers.

## Hook Message Format

When escalation triggers, the relay POSTs to the OpenClaw hooks endpoint with full inline context (not a file reference — this allows remote deployments where the file isn't accessible):

```http
POST /hooks/agent HTTP/1.1
Content-Type: application/json
Authorization: Bearer <OPENCLAW_HOOK_TOKEN>

{
  "message": "<inline context>",
  "name": "sinain-hud",
  "wakeMode": "now",
  "deliver": false
}
```

### Payload fields

| Field | Value | Description |
|-------|-------|-------------|
| `message` | string | Full context: digest, current app, app history, screen OCR (up to 10 entries, 400ch each), audio transcripts (up to 5, 400ch each), and instructions for the agent |
| `name` | `"sinain-hud"` | Hook source identifier |
| `wakeMode` | `"now"` | Start agent immediately |
| `deliver` | `false` | Don't deliver to Telegram — response goes to HUD feed instead |

### Response

```json
{
  "runId": "abc123"
}
```

The `runId` is used to track the agent execution via WebSocket `agent.wait`.

## WebSocket Authentication

The relay connects to the OpenClaw gateway WebSocket for `agent.wait` RPC calls. Authentication uses a challenge-response protocol:

### Protocol sequence

```
Client                          Gateway
  │                                │
  ├── WebSocket connect ──────────►│
  │                                │
  │◄── event: connect.challenge ───┤  (includes nonce)
  │                                │
  ├── req: connect ───────────────►│  (includes auth token, client info)
  │    method: "connect"           │
  │    params.auth.token: <TOKEN>  │
  │    params.minProtocol: 3       │
  │    params.maxProtocol: 3       │
  │    params.client.mode: backend │
  │                                │
  │◄── res: ok ────────────────────┤  (authenticated)
  │                                │
  ├── req: agent.wait ────────────►│  (after escalation)
  │    params.runId: <runId>       │
  │    params.timeoutMs: 60000     │
  │                                │
  │◄── res: result ────────────────┤  (agent output)
  │                                │
```

### Token separation

- **`OPENCLAW_GATEWAY_TOKEN`** — Used for WebSocket authentication (`connect` request). This is the gateway's own auth token.
- **`OPENCLAW_HOOK_TOKEN`** — Used as `Authorization: Bearer` header on HTTP hook POSTs. This is the hooks subsystem token.

These may be different values depending on the OpenClaw deployment configuration.

### Fire-and-forget fallback

If the WebSocket is not connected or not authenticated when an escalation fires, the HTTP hook POST still goes through. The response simply won't be captured — it will arrive in OpenClaw but won't appear on the HUD. The relay logs this as:

```
[openclaw] no ws connection — fire-and-forget escalation
```

### Reconnection

The WebSocket auto-reconnects on disconnect with a 5-second delay. Authentication is re-performed on each new connection.

## Configuration Reference

All variables read from environment (or `.env` file). Relevant to escalation:

| Variable | Default | Description |
|----------|---------|-------------|
| `SITUATION_MD_ENABLED` | `true` | Write SITUATION.md on each tick |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | Directory for SITUATION.md |
| `OPENCLAW_GATEWAY_WS_URL` | `ws://localhost:18789` | Gateway WebSocket URL |
| `OPENCLAW_GATEWAY_TOKEN` | *(none)* | Token for WebSocket auth |
| `OPENCLAW_HOOK_URL` | `http://localhost:18789/hooks/agent` | HTTP hooks endpoint |
| `OPENCLAW_HOOK_TOKEN` | *(none)* | Token for HTTP hook auth |
| `ESCALATION_MODE` | `selective` | `off` / `selective` / `focus` |
| `ESCALATION_COOLDOWN_MS` | `30000` | Min ms between escalations |

Related agent config (affects what gets escalated):

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ENABLED` | `false` | Enable relay agent loop |
| `AGENT_INTERVAL_MS` | `30000` | Agent tick interval |
| `AGENT_MODEL` | `google/gemini-2.5-flash-lite` | LLM for digest generation |
| `AGENT_MAX_AGE_MS` | `120000` | Context window duration (2 min) |
| `AGENT_MAX_TOKENS` | `300` | Max digest tokens |
| `AGENT_DEBOUNCE_MS` | `3000` | Debounce before tick |

## EC2 Deployment

For remote OpenClaw instances (e.g., on EC2), hooks must be explicitly enabled in the gateway config:

### Enable hooks

In `openclaw.json` (or equivalent gateway config):

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-hook-token"
  }
}
```

The gateway must be restarted after changing this config. Hooks are served on port **18789** — the same port as the gateway WebSocket.

### Common setup

```bash
# On the Mac (sinain-hud .env)
OPENCLAW_GATEWAY_WS_URL=ws://your-ec2-host:18789
OPENCLAW_GATEWAY_TOKEN=your-gateway-token
OPENCLAW_HOOK_URL=http://your-ec2-host:18789/hooks/agent
OPENCLAW_HOOK_TOKEN=your-hook-token
ESCALATION_MODE=selective
```

### Limitations

- **SITUATION.md is local-only.** The file is written to the Mac's filesystem. Remote OpenClaw instances can't read it. The HTTP hook message embeds the full context inline to work around this.
- **WebSocket must be reachable.** If the gateway is behind a firewall, ensure port 18789 is open for both HTTP and WS traffic.

## OpenClaw Bootstrap (SITUATION.md)

How OpenClaw consumes the SITUATION.md file:

1. **Workspace resolver** — OpenClaw's `workspace.ts` resolves `SITUATION.md` from the workspace directory when an agent starts or when explicitly referenced.
2. **Subagent allowlist** — SITUATION.md is included in the file allowlist for subagents, so they can read it without permission escalation.
3. **Local-only** — Only works when OpenClaw and sinain-hud run on the same machine (or share a filesystem). For remote deployments, the inline hook message is the primary context delivery mechanism.

## Troubleshooting

### Hook returns 405 Method Not Allowed

Hooks are not enabled on the gateway. Add `hooks.enabled: true` and `hooks.token` to `openclaw.json`, then restart the gateway.

### WebSocket auth failure

```
[openclaw] auth failed: <error>
```

Check that `OPENCLAW_GATEWAY_TOKEN` matches the token the gateway expects. The gateway token and hook token are separate — make sure you're using the right one for each.

### Timeout on agent.wait

```
[openclaw] agent.wait failed: timeout
```

The OpenClaw agent took longer than 60 seconds. The escalation still went through — the agent is running, but the relay gave up waiting for the response. The agent's output may still appear in OpenClaw's own interface.

### No escalations firing in selective mode

Check the relay logs for score output. Common reasons:
- Digest doesn't contain error/complexity patterns
- No question patterns in audio transcripts
- Cooldown hasn't elapsed (default 30s)
- Same digest as last escalation (duplicate suppression)

Switch to `focus` mode temporarily to verify the pipeline works end-to-end.

### Gateway WebSocket keeps reconnecting

```
[openclaw] ws connected: ws://... (awaiting challenge)
[openclaw] ws closed (code=1006)
```

The connection drops before authentication completes. Likely causes:
- Wrong WebSocket URL
- Gateway not running or not accepting connections on that port
- Network/firewall blocking persistent connections

### SITUATION.md not being written

Check `SITUATION_MD_ENABLED` is `true` (the default). Verify the directory exists and is writable:

```bash
ls -la ~/.openclaw/workspace/SITUATION.md
```

The relay creates the directory automatically, but filesystem permission issues can prevent this.
