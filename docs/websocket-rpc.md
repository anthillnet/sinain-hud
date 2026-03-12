# WebSocket & RPC Communication

This document describes all real-time communication between sinain's components: how messages are structured, how connections are established, and how data flows end-to-end.

---

## Architecture Overview

Three independent communication channels, each with different protocols and reliability requirements:

```
┌─────────────────┐          WS ws://localhost:9500         ┌────────────────────┐
│  Overlay        │◄────────────────────────────────────────►│                    │
│  (Flutter/macOS)│        feed · status · spawn_task        │                    │
└─────────────────┘                                          │   sinain-core      │
                                                             │   (Node.js :9500)  │
┌─────────────────┐    HTTP POST /sense  or  WS /sense/ws   │                    │
│  sense_client   │────────────────────────────────────────►│                    │
│  (Python)       │◄────────────────────────────────────────│                    │
└─────────────────┘            ack · backpressure            └────────┬───────────┘
                                                                      │
                                                              WS RPC (OpenClaw protocol)
                                                              req/res · agent · situation.update
                                                                      │
                                                             ┌────────▼───────────┐
                                                             │  OpenClaw Gateway  │
                                                             │  (Claude agent)    │
                                                             └────────────────────┘
```

---

## Channel 1: Overlay ↔ sinain-core

**Purpose:** sinain-core pushes display updates (feed text, status, task progress) to the HUD overlay. The overlay sends user commands and heartbeat data back.

**Transport:** WebSocket, `ws://localhost:9500`

**Source files:**
- Server: `sinain-core/src/overlay/ws-handler.ts`
- Client: `overlay/lib/core/services/websocket_service.dart`

### Connection Lifecycle

```
Overlay                           sinain-core
   │                                   │
   │──── WebSocket connect ───────────►│
   │                                   │ sends current status immediately
   │◄─── { type: "status", ... } ──────│
   │                                   │ replays last 20 feed messages
   │◄─── { type: "feed", ... } × N ────│
   │                                   │ replays active spawn tasks (< 120s old)
   │◄─── { type: "spawn_task", ... } ──│
   │                                   │
   │     [ connected — normal operation ]
   │                                   │
   │──── { type: "pong", ts } ─────────►│  every 10s ping/pong
   │──── { type: "profiling", ... } ───►│  every 30s memory report
```

**Reconnect:** Exponential backoff starting at 1s, capped at 30s. Automatic.

---

### sinain-core → Overlay messages

#### `feed` — Display text in the HUD

```json
{
  "type": "feed",
  "text": "User is reviewing a pull request for authentication changes",
  "priority": "normal",
  "ts": 1710245612000,
  "channel": "stream"
}
```

| Field | Values | Notes |
|---|---|---|
| `priority` | `"normal"` \| `"high"` \| `"urgent"` | Controls overlay highlight color |
| `channel` | `"stream"` \| `"agent"` | `agent` = from OpenClaw, `stream` = from local analysis |

**Sources:** Agent analysis output, OpenClaw escalation responses (prefixed `[🤖]`), transcription summaries.

**Buffer:** Last 20 messages replayed to new overlay connections.

---

#### `status` — System state update

```json
{
  "type": "status",
  "audio": "active",
  "mic": "muted",
  "screen": "active",
  "connection": "connected"
}
```

Sent immediately on overlay connect, and on any state change.

---

#### `spawn_task` — Background subagent task lifecycle

Emitted at each stage of a long-running OpenClaw subagent task.

```json
{
  "type": "spawn_task",
  "taskId": "spawn-task-1710245600000",
  "label": "Analyze auth PR in depth",
  "status": "spawned",
  "startedAt": 1710245600000,
  "completedAt": null,
  "resultPreview": null
}
```

**Status progression:**

```
spawned ──► polling ──► completed
                   └──► failed
                   └──► timeout
```

| Status | Meaning |
|---|---|
| `spawned` | RPC sent to OpenClaw child session |
| `polling` | Waiting for result (polls every 5s, up to 5min) |
| `completed` | Task finished; `resultPreview` = first 200 chars |
| `failed` | Subagent returned an error |
| `timeout` | No response within 5 minutes |

`resultPreview` is populated on `completed`. Terminal-state tasks are buffered for 120s for late-joining overlays.

---

#### `ping` — Keep-alive

```json
{ "type": "ping", "ts": 1710245612000 }
```

Sent every 10 seconds. Overlay responds with `pong`.

---

### Overlay → sinain-core messages

#### `message` — User text input

```json
{ "type": "message", "text": "What should I focus on?" }
```

Routed to the escalator's `sendDirect()` path.

#### `command` — Action trigger

```json
{ "type": "command", "action": "toggle_audio" }
```

#### `pong` — Ping response

```json
{ "type": "pong", "ts": 1710245612000 }
```

#### `profiling` — Overlay memory heartbeat

```json
{
  "type": "profiling",
  "rssMb": 124.5,
  "uptimeS": 3600,
  "ts": 1710245612000
}
```

Sent every 30 seconds. Used for monitoring overlay process health.

---

## Channel 2: sense_client → sinain-core

**Purpose:** sense_client continuously captures screen frames, runs OCR, and pushes observations to sinain-core for the agent to reason about.

**Transports:** HTTP POST `/sense` (simple) or WebSocket `/sense/ws` (low-latency, with backpressure).

**Source files:**
- Server: `sinain-core/src/server.ts`
- Client: `sense_client/sender.py`

### HTTP POST /sense

**Request** (max body 2MB):

```json
{
  "type": "text",
  "ts": 1710245612000,
  "ocr": "Pull request #142\nAuthentication middleware refactor",
  "meta": {
    "ssim": 0.12,
    "app": "Google Chrome",
    "windowTitle": "GitHub - Pull Request #142",
    "screen": 0
  },
  "roi": {
    "data": "<base64 JPEG>",
    "bbox": [100, 200, 800, 600]
  },
  "observation": {
    "title": "Code Review",
    "subtitle": "Auth middleware PR",
    "facts": ["PR has 3 reviewers", "2 files changed"],
    "narrative": "Developer is reviewing authentication changes",
    "concepts": ["code review", "authentication", "security"]
  }
}
```

| `type` | Meaning |
|---|---|
| `"text"` | OCR text extracted from screen |
| `"visual"` | Image region of interest attached |
| `"context"` | Semantic observation with structured fields |

**Response:**

```json
{
  "ok": true,
  "id": 42,
  "gated": false,
  "deduplicated": false
}
```

`gated: true` means the event was rate-limited and not stored. `deduplicated: true` means it matched the previous event and was dropped.

---

### WebSocket /sense/ws

Used for high-frequency streaming. Adds backpressure signaling so sense_client doesn't overwhelm the agent loop.

#### Delta message (preferred, low-latency)

Sends only what changed since the last frame:

```json
{
  "type": "delta",
  "app": "Xcode",
  "activity": "editing Swift source",
  "changes": [
    { "field": "windowTitle", "old": "AppDelegate.swift", "new": "ContentView.swift" },
    { "field": "ocr", "old": "func viewDidLoad", "new": "struct ContentView" }
  ],
  "priority": "urgent",
  "ts": 1710245612000
}
```

`priority: "urgent"` is set when SSIM delta is high (significant visual change).

#### Server ACK with backpressure

```json
{
  "type": "ack",
  "id": 42,
  "deduplicated": false,
  "gated": false,
  "backpressure": 0
}
```

`backpressure` is `100` (milliseconds) when there are more than 5 unacknowledged messages in flight. sense_client must wait before sending more. `0` means send freely.

**Backpressure flow:**

```
sense_client                      sinain-core
     │                                 │
     │──── delta (id=1) ──────────────►│ pending: {1}
     │──── delta (id=2) ──────────────►│ pending: {1,2}
     │◄─── ack { id:1, bp:0 } ─────────│ pending: {2}
     │──── delta (id=3) ──────────────►│ pending: {2,3}
     │◄─── ack { id:2, bp:0 } ─────────│ pending: {3}
     │──── delta (id=4,5,6,7) ────────►│ pending: {3,4,5,6,7}  ← 5 pending
     │◄─── ack { id:3, bp:100 } ───────│   backpressure triggered
     │  [wait 100ms]                   │
     │──── delta (id=8) ──────────────►│
```

---

### GET /sense — Query stored events

```
GET /sense?after=40&meta_only=true
```

| Param | Description |
|---|---|
| `after` | Return events with id > this value |
| `meta_only` | Omit OCR text and image data (lighter payloads) |

**Response:**

```json
{
  "events": [ { "id": 41, "type": "text", "meta": { ... }, "ts": ... }, ... ],
  "epoch": "a3f2b1c0"
}
```

`epoch` changes on server restart. Clients should reset their `after` cursor when it changes.

---

## Channel 3: sinain-core → OpenClaw Gateway (RPC)

**Purpose:** sinain-core escalates to a long-running Claude agent session for deep analysis. Also pushes live situational context (SITUATION.md) to the gateway.

**Transport:** WebSocket with custom request/response protocol. HTTP POST fallback.

**Source files:**
- `sinain-core/src/escalation/openclaw-ws.ts` — WS client, auth, circuit breaker
- `sinain-core/src/escalation/escalator.ts` — RPC call sites

---

### Connection & Authentication

```
sinain-core                       OpenClaw Gateway
     │                                   │
     │──── WebSocket connect ───────────►│
     │                                   │
     │◄─── { type: "connect.challenge" }─│
     │                                   │
     │──── { type: "req",               │
     │       method: "connect",          │
     │       id: "connect-1",            │
     │       params: {                   │
     │         minProtocol: 3,           │
     │         maxProtocol: 3,           │
     │         role: "operator",         │
     │         scopes: [                 │
     │           "operator.read",        │
     │           "operator.write",       │
     │           "operator.admin"        │
     │         ],                        │
     │         client: {                 │
     │           id: "gateway-client",   │
     │           displayName:            │
     │             "Sinain Core"         │
     │         },                        │
     │         auth: { token: "..." }    │
     │       }                           │
     │     } ───────────────────────────►│
     │                                   │
     │◄─── { type: "res",               │
     │       id: "connect-1",            │
     │       ok: true }──────────────────│
     │                                   │
     │     [ authenticated — RPC ready ] │
```

> **Note:** `operator.admin` scope is required for `registerGatewayMethod` calls (e.g. `situation.update`). Missing this scope silently blocks plugin-registered methods.

**Circuit breaker:** After 5 failures within a 2-minute window, the circuit opens and all RPC calls fail fast for 5 minutes (exponential backoff, max 30 minutes).

---

### RPC Wire Format

All RPC calls share the same envelope:

**Request:**
```json
{
  "type": "req",
  "id": "42",
  "method": "agent",
  "params": { ... }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "42",
  "ok": true,
  "payload": { ... }
}
```

**Error response:**
```json
{
  "type": "res",
  "id": "42",
  "ok": false,
  "error": { "code": "...", "message": "..." }
}
```

---

### RPC Method: `agent` — Escalate to Claude session

Used when the agent loop scores a context above the escalation threshold.

**Request:**
```json
{
  "type": "req",
  "method": "agent",
  "id": "7",
  "params": {
    "message": "## Digest\nUser is debugging a memory leak...\n\n## Playbook\n...",
    "idempotencyKey": "hud-88-1710245612000",
    "sessionKey": "agent:main:sinain",
    "deliver": false
  }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "7",
  "ok": true,
  "payload": {
    "runId": "run-abc123",
    "status": "completed",
    "result": {
      "payloads": [
        { "text": "This looks like a retain cycle in the view layer. Check..." }
      ]
    }
  }
}
```

**Response handling:** Text is extracted from `payload.result.payloads[].text`, prefixed with `[🤖]`, and broadcast to overlay as a `feed` message. If `payloads` is empty, treated as `NO_REPLY` — in `focus`/`rich` mode, the local digest is used as fallback.

**Timeout:** 90 seconds.

**Idempotency key format:** `hud-{entryId}-{timestamp}` — prevents duplicate escalations if the WS reconnects mid-flight.

---

### RPC Method: `agent` (spawn task) — Create child subagent session

For longer tasks, a separate child session is spawned so it runs in the background without blocking the main escalation flow.

**Request:**
```json
{
  "type": "req",
  "method": "agent",
  "id": "8",
  "params": {
    "message": "Review the diff in the current PR and summarize security implications",
    "sessionKey": "agent:main:subagent:f47ac10b",
    "lane": "subagent",
    "extraSystemPrompt": "You are a focused analysis assistant...",
    "deliver": false,
    "spawnedBy": "agent:main:sinain",
    "idempotencyKey": "spawn-task-1710245600000",
    "label": "Security review"
  }
}
```

**Timeout:** 120 seconds. Result is extracted from `payload.result.payloads[].text`.

---

### RPC Method: `agent.wait` — Poll spawn task completion

Called in a polling loop after spawning a child task.

**Request:**
```json
{
  "type": "req",
  "method": "agent.wait",
  "id": "9",
  "params": {
    "runId": "run-abc123",
    "timeoutMs": 5000
  }
}
```

**Response statuses that mean "done":** `ok`, `completed`, `done`, `finished`, `success`

**Response status `timeout`:** Task still running — poll again.

**Polling loop:** Every 5s, up to 5 minutes total before declaring `timeout`.

---

### RPC Method: `chat.history` — Fetch child session output

Used to retrieve messages from a child session after it completes.

**Request:**
```json
{
  "type": "req",
  "method": "chat.history",
  "id": "10",
  "params": {
    "sessionKey": "agent:main:subagent:f47ac10b",
    "limit": 10
  }
}
```

**Response extraction** (multiple formats supported for resilience):
- `payload.messages[]` → last assistant message
- `payload.result.messages[]` → same
- `payload.text` → direct text fallback

---

### RPC Method: `situation.update` — Push live context to gateway

Called after every agent tick to keep the gateway's SITUATION.md in sync. Fire-and-forget (failures are logged but don't block the agent loop).

**Request:**
```json
{
  "type": "req",
  "method": "situation.update",
  "id": "11",
  "params": {
    "content": "# Current Situation\n\n## What's happening\nUser is in a code review...\n\n## Recent activity\n..."
  }
}
```

**Timeout:** 10 seconds. Errors are swallowed — this is best-effort.

**Gateway side:** The `sinain-hud` plugin handles this via `registerGatewayMethod` and writes the file atomically (`writeFileSync` + `renameSync` to `~/.openclaw/workspace/SITUATION.md`).

---

### HTTP Fallback — When WebSocket is unavailable

If the WebSocket client is not connected, escalations fall back to HTTP POST:

```http
POST {OPENCLAW_HTTP_URL}/hooks/agent
Content-Type: application/json
Authorization: Bearer {HOOKS_TOKEN}

{
  "message": "## Digest\n...",
  "name": "sinain-core",
  "sessionKey": "agent:main:sinain",
  "wakeMode": "now",
  "deliver": false
}
```

> **Token:** Uses `hooks.token` from `openclaw.json` — **not** `gateway.auth.token`.

---

## End-to-End Data Flow

The complete path from a screen change to an agent response displayed in the HUD:

```
sck-capture (Swift)
    │ JPEG frame → IPC (~/.sinain/capture/frame.jpg)
    ▼
sense_client (Python)
    │ SSIM change detection → if changed:
    │   OCR via OpenRouter vision API
    │   privacy strip (<private> tags)
    │   POST /sense  or  WS /sense/ws delta
    ▼
sinain-core: /sense handler
    │ store in sense-buffer (ring, max 30)
    │ trigger agent loop (debounce 3s)
    ▼
sinain-core: agent loop
    │ buildContextWindow()
    │   ← feed-buffer (last 100 items)
    │   ← sense-buffer (last 30 events)
    │   ← playbook knowledge (injected)
    │ analyzeContext() → LLM call (OpenRouter)
    │ parse { hud, digest }
    │ writeSituationMd() → atomic file write
    │ sendRpc("situation.update", content)  ──────────────────────► Gateway SITUATION.md
    │ broadcast feed message to overlay  ─────────────────────────► HUD displays hud text
    ▼
sinain-core: escalator
    │ score digest against patterns
    │ if score >= threshold (or focus/rich mode):
    │   buildEscalationMessage(digest + playbook)
    │   sendAgentRpc(message, idemKey, sessionKey)  ──────────────► OpenClaw Claude session
    │                                               ◄────────────── agent text response
    │   broadcast [🤖] response to overlay  ──────────────────────► HUD displays agent reply
    │
    │ if spawn task detected in response:
    │   broadcastTaskEvent("spawned")  ────────────────────────────► HUD shows task indicator
    │   sendRpc("agent", { lane: "subagent", ... })
    │   poll agent.wait every 5s
    │   broadcastTaskEvent("completed", resultPreview)  ───────────► HUD updates task status
```

---

## Configuration Reference

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `9500` | sinain-core HTTP/WS port |
| `OPENCLAW_WS_URL` | — | Gateway WebSocket URL |
| `OPENCLAW_HTTP_URL` | — | Gateway HTTP URL (fallback) |
| `OPENCLAW_AUTH_TOKEN` | — | Gateway auth token (48-char hex) |
| `OPENCLAW_HOOKS_TOKEN` | — | Hooks endpoint token (different from auth) |
| `OPENCLAW_SESSION_KEY` | `agent:main:sinain` | Main agent session key |
| `ESCALATION_MODE` | `rich` | `off` \| `selective` \| `focus` \| `rich` |

---

## Reliability Summary

| Channel | Reconnect | Timeout | Retry | Notes |
|---|---|---|---|---|
| Overlay WS | Exponential backoff (1s–30s) | Ping/pong | Auto | Last 20 feed + active tasks replayed |
| Sense HTTP | Client-side | Per-request | sense_client | Dedup + gating on server |
| Sense WS | Client-side | — | Auto | Backpressure at 5 pending ACKs |
| OpenClaw RPC | Auto-reconnect | 90s/120s/10s | Circuit breaker | HTTP fallback; idempotency keys |
| situation.update | — | 10s | None | Fire-and-forget; failures logged only |
