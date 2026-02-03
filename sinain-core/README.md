# sinain-core

Unified HUD-sense-audio-bridge-relay: single process replacing relay + bridge.

## Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │              sinain-core  :9500             │
                        │                                             │
   BlackHole 2ch        │  ┌────────┐    ┌────────────┐              │
   ─────────────────────┼─▸│ Audio   │───▸│Transcription│             │
   (sox / ffmpeg)       │  │Pipeline │    │ (Gemini)    │             │
                        │  └────────┘    └──────┬─────┘              │
                        │                       │                     │
                        │                       ▼                     │
   sense_client         │  ┌────────┐    ┌────────────┐              │
   (screen capture)     │  │ Sense   │   │            │              │
   ─────────────────────┼─▸│ Buffer  │──▸│ Feed Buffer│              │
   POST /sense          │  └────────┘   │   (100)    │              │
                        │               └──────┬─────┘              │
                        │                      │                     │
                        │                      ▼                     │
                        │               ┌─────────────┐             │
                        │               │  Agent Loop  │             │
                        │               │ (Gemini Lite)│             │
                        │               └──────┬──────┘             │
                        │                      │                     │
                        │                      ▼                     │
                        │               ┌─────────────┐             │
                        │               │  Escalation  │             │
                        │               │  (scorer)    │             │
                        │               └──────┬──────┘             │
                        │                      │                     │
                        └──────────────────────┼─────────────────────┘
                                               │
                             ┌─────────────────┼──────────────────┐
                             ▼                 ▼                  ▼
                      ┌────────────┐   ┌──────────────┐   ┌──────────┐
                      │ Overlay WS │   │ OpenClaw GW  │   │SITUATION │
                      │  clients   │   │  (WS + HTTP) │   │   .md    │
                      └────────────┘   └──────────────┘   └──────────┘
```

**Data flow:** Audio → Transcription → FeedBuffer → Agent Loop → Escalation → OpenClaw gateway.
Screen captures flow through SenseBuffer and merge into the same Agent context window.
Overlay WS clients receive real-time feed broadcasts and can send commands back.

## Quick Start

### Prerequisites

- **Node.js 22+**
- **sox** — `brew install sox`
- **BlackHole 2ch** — virtual audio device ([existential.audio](https://existential.audio/blackhole/))

### Install & Run

```bash
cd sinain-core
npm install
cp .env.example .env    # fill in your API keys
npm start               # run with tsx
```

For development with auto-reload:

```bash
npm run dev
```

## Configuration Reference

All configuration is via environment variables (or `.env` file). Variables are grouped by section.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9500` | HTTP + WebSocket listen port |

### Audio

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIO_DEVICE` | `BlackHole 2ch` | macOS audio device name (sox `AUDIODEV`) |
| `AUDIO_SAMPLE_RATE` | `16000` | Sample rate in Hz |
| `AUDIO_CHUNK_MS` | `5000` | Chunk duration in milliseconds |
| `AUDIO_VAD_ENABLED` | `true` | Enable Voice Activity Detection |
| `AUDIO_VAD_THRESHOLD` | `0.003` | VAD energy threshold (0.0–1.0, RMS) |
| `AUDIO_CAPTURE_CMD` | `sox` | Capture backend: `sox` or `ffmpeg` |
| `AUDIO_AUTO_START` | `true` | Auto-start audio capture on boot |
| `AUDIO_GAIN_DB` | `20` | Gain in decibels |
| `AUDIO_ALT_DEVICE` | `BlackHole 2ch` | Alternate device for `switch_device` command |

### Transcription

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSCRIPTION_BACKEND` | `openrouter` | Backend: `openrouter`, `aws-gemini`, or `whisper` |
| `TRANSCRIPTION_MODEL` | `google/gemini-2.5-flash` | Model for audio-to-text |
| `OPENROUTER_API_KEY` | *(empty)* | **Required** — OpenRouter API key |
| `REFINE_INTERVAL_MS` | `30000` | Refinement interval for AWS+Gemini hybrid |
| `TRANSCRIPTION_LANGUAGE` | `en-US` | Language code |
| `AWS_REGION` | `eu-west-1` | AWS region (only for `aws-gemini` backend) |
| `AWS_ACCESS_KEY_ID` | *(empty)* | AWS credentials (only for `aws-gemini`) |
| `AWS_SECRET_ACCESS_KEY` | *(empty)* | AWS credentials (only for `aws-gemini`) |

### Agent

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ENABLED` | `true` | Enable agent analysis loop |
| `AGENT_MODEL` | `google/gemini-2.5-flash-lite` | Primary LLM model |
| `AGENT_FALLBACK_MODELS` | `google/gemini-2.5-flash,anthropic/claude-3.5-haiku` | Comma-separated fallback chain |
| `AGENT_MAX_TOKENS` | `300` | Max output tokens |
| `AGENT_TEMPERATURE` | `0.3` | Sampling temperature (0.0–2.0) |
| `AGENT_PUSH_TO_FEED` | `true` | Push HUD text to feed |
| `AGENT_DEBOUNCE_MS` | `3000` | Wait time before analysis after new context |
| `AGENT_MAX_INTERVAL_MS` | `30000` | Force a tick even with no new events |
| `AGENT_COOLDOWN_MS` | `10000` | Minimum time between analyses |
| `AGENT_MAX_AGE_MS` | `120000` | Context window lookback (2 minutes) |

### Escalation

| Variable | Default | Description |
|----------|---------|-------------|
| `ESCALATION_MODE` | `selective` | Mode: `off`, `selective`, `focus`, or `rich` |
| `ESCALATION_COOLDOWN_MS` | `30000` | Minimum cooldown between escalations |

### OpenClaw

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_WS_URL` | `ws://localhost:18789` | Gateway WebSocket URL (alias: `OPENCLAW_GATEWAY_WS_URL`) |
| `OPENCLAW_WS_TOKEN` | *(empty)* | Gateway auth token — 48-char hex (alias: `OPENCLAW_GATEWAY_TOKEN`) |
| `OPENCLAW_HTTP_URL` | `http://localhost:18789/hooks/agent` | HTTP hook endpoint (alias: `OPENCLAW_HOOK_URL`) |
| `OPENCLAW_HTTP_TOKEN` | *(empty)* | HTTP hook token (alias: `OPENCLAW_HOOK_TOKEN`) |
| `OPENCLAW_SESSION_KEY` | `agent:main:main` | Session key for RPC calls |

### Tracing

| Variable | Default | Description |
|----------|---------|-------------|
| `TRACE_ENABLED` | `true` | Enable trace collection |
| `TRACE_DIR` | `~/.sinain-core/traces` | Trace storage directory |

### Other

| Variable | Default | Description |
|----------|---------|-------------|
| `SITUATION_MD_PATH` | `~/.openclaw/workspace/SITUATION.md` | Path to SITUATION.md output |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | Workspace directory (fallback for SITUATION path) |

## Escalation Modes

The escalation system decides when to forward agent analysis to OpenClaw for human-in-the-loop review.

| Mode | Behavior |
|------|----------|
| **`off`** | Escalation disabled entirely |
| **`selective`** | Score-based (threshold ≥ 3) with deduplication of identical digests |
| **`focus`** | Always escalate every tick (except idle). Returns fallback response on `NO_REPLY` |
| **`rich`** | Same as focus but with maximum context (4000 OCR chars, 2000 transcript chars) |

### Scoring (selective mode)

| Signal | Score | Trigger |
|--------|-------|---------|
| Error pattern in digest | **+3** | `error`, `failed`, `exception`, `crash`, `traceback`, `TypeError`, etc. |
| Question in audio | **+2** | `how do i`, `how to`, `what if`, `help me`, `not working`, `stuck`, etc. |
| Code issue in digest | **+1** | `todo`, `fixme`, `hack`, `workaround`, `deprecated` |
| App churn (≥ 4 apps) | **+1** | Rapid app switching suggests confusion |

**Threshold: 3** — an error alone triggers escalation; a question + code issue also triggers.

### Context Richness by Mode

| Preset | Mode | Screen Events | Audio Entries | OCR Chars | Transcript Chars |
|--------|------|---------------|---------------|-----------|------------------|
| lean | selective | 10 | 5 | 400 | 400 |
| standard | focus | 20 | 10 | 1,000 | 800 |
| rich | rich | 50 | 30 | 4,000 | 2,000 |

## HTTP API Reference

All endpoints return JSON. CORS is enabled (`Access-Control-Allow-Origin: *`).

### `GET /health`

System health check with stats.

```bash
curl http://localhost:9500/health
```

```json
{
  "ok": true,
  "epoch": "m3k7f2-a1b2",
  "messages": 42,
  "senseEvents": 12,
  "overlayClients": 1,
  "agent": { "enabled": true, "model": "google/gemini-2.5-flash-lite", "totalCalls": 15, "..." : "..." },
  "escalation": { "mode": "selective", "totalEscalations": 3, "gatewayConnected": true, "..." : "..." },
  "situation": { "path": "/Users/you/.openclaw/workspace/SITUATION.md" },
  "traces": { "..." : "..." }
}
```

### `GET /feed?after=N`

Retrieve feed messages (transcripts, agent HUD, system messages).

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `after` | int | `0` | Return items with id > after |

```bash
curl "http://localhost:9500/feed?after=0"
```

```json
{
  "messages": [
    { "id": 1, "text": "[📝] Hello world", "priority": "normal", "source": "audio", "channel": "stream", "ts": 1706900000000 }
  ],
  "epoch": "m3k7f2-a1b2"
}
```

### `POST /feed`

Inject a message into the feed manually.

```bash
curl -X POST http://localhost:9500/feed \
  -H "Content-Type: application/json" \
  -d '{"text": "Manual note", "priority": "normal"}'
```

### `GET /sense?after=N&meta_only=bool`

Query screen capture events.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `after` | int | `0` | Return events with id > after |
| `meta_only` | bool | `false` | Omit OCR text, return metadata only |

```bash
curl "http://localhost:9500/sense?after=0&meta_only=true"
```

### `POST /sense`

Ingest a screen capture event (used by sense_client).

```bash
curl -X POST http://localhost:9500/sense \
  -H "Content-Type: application/json" \
  -d '{"type": "text", "ts": 1706900000000, "ocr": "screen text...", "meta": {"app": "Chrome", "ssim": 0.95}}'
```

Max body size: 2 MB.

### `GET /agent/digest`

Latest agent analysis result.

```bash
curl http://localhost:9500/agent/digest
```

```json
{ "ok": true, "digest": { "hud": "User debugging API", "digest": "Working on REST endpoint..." } }
```

### `GET /agent/history?limit=N`

Recent analysis history (max 50).

```bash
curl "http://localhost:9500/agent/history?limit=5"
```

### `GET /agent/context`

Current context window (debug).

```bash
curl http://localhost:9500/agent/context
```

### `GET /agent/config`

Current agent configuration (API keys hidden).

```bash
curl http://localhost:9500/agent/config
```

### `POST /agent/config`

Update agent configuration at runtime.

```bash
curl -X POST http://localhost:9500/agent/config \
  -H "Content-Type: application/json" \
  -d '{"model": "google/gemini-2.5-flash", "temperature": 0.5, "escalationMode": "focus"}'
```

### `GET /traces?after=N&limit=N`

Query collected trace data.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `after` | int | `0` | Return traces with id > after |
| `limit` | int | `50` | Max traces to return (cap: 500) |

```bash
curl "http://localhost:9500/traces?after=0&limit=10"
```

## WebSocket Protocol

The overlay WebSocket runs on the same port as HTTP.

**Connection:** `ws://localhost:9500`

### Server → Client

| Type | Fields | Description |
|------|--------|-------------|
| `feed` | `text`, `priority`, `ts`, `channel` | Feed message broadcast |
| `status` | `audio`, `screen`, `connection` | State update (`active`/`muted`/`off`/`connected`/`disconnected`) |
| `ping` | `ts` | App-level heartbeat (for clients that don't handle protocol pings) |

### Client → Server

| Type | Fields | Description |
|------|--------|-------------|
| `message` | `text` | User message (forwarded to OpenClaw) |
| `command` | `action` | Command: `toggle_audio`, `toggle_screen`, `switch_device` |
| `pong` | `ts` | Heartbeat response |

### Heartbeat

- Server pings every **10 seconds** (both WS protocol ping and app-level `{ type: "ping" }`)
- Client must respond with pong; connection closes on miss
- Replay: last **20 messages** sent to newly connected clients

## Project Structure

```
sinain-core/src/
├── index.ts                  — entry point, wiring, lifecycle
├── config.ts                 — env var loading, .env parser
├── server.ts                 — HTTP endpoints + WS server setup
├── types.ts                  — shared TypeScript types
├── log.ts                    — logging utilities
├── agent/
│   ├── loop.ts               — event-driven agent analysis loop
│   ├── analyzer.ts           — LLM prompt builder + OpenRouter calls
│   ├── context-window.ts     — context assembly + richness presets
│   └── situation-writer.ts   — SITUATION.md file writer
├── audio/
│   ├── pipeline.ts           — sox/ffmpeg audio capture + VAD
│   └── transcription.ts      — audio-to-text (OpenRouter/AWS/Whisper)
├── buffers/
│   ├── feed-buffer.ts        — ring buffer for feed items (100)
│   └── sense-buffer.ts       — ring buffer for screen events (30)
├── escalation/
│   ├── escalator.ts          — escalation orchestration
│   ├── scorer.ts             — score-based escalation decisions
│   ├── message-builder.ts    — builds escalation payloads
│   └── openclaw-ws.ts        — WebSocket client to OpenClaw gateway
├── overlay/
│   ├── ws-handler.ts         — overlay WS connections + replay
│   └── commands.ts           — toggle_audio, toggle_screen, switch_device
└── trace/
    ├── tracer.ts             — instrumentation + metrics
    └── trace-store.ts        — trace file persistence
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run with tsx |
| `npm run dev` | Watch mode (auto-reload on file changes) |
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm run eval` | Evaluation harness — 3 runs, reports to `eval/reports/` |
| `npm run eval:quick` | Quick eval — 1 run, fast mode, output to stdout |

## OpenClaw Integration

sinain-core connects to an OpenClaw gateway for escalation — forwarding analysis results when the scoring threshold is met (or always, in focus/rich mode).

**Connection methods:**
1. **WebSocket** (primary) — persistent connection to `OPENCLAW_WS_URL` with challenge-response auth
2. **HTTP** (fallback) — fire-and-forget POST to `OPENCLAW_HTTP_URL` if WS is down

### Getting Your OpenClaw Token

The gateway uses a config-file token (`gateway.auth.token` in `openclaw.json`) that takes precedence over the `OPENCLAW_GATEWAY_TOKEN` env var. The token is a 48-char hex string auto-generated during `openclaw onboard`.

**Same machine (localhost):**
No token needed — local connections auto-pair.

**Remote (cloud instance):**

SSH in and read the config file:

```bash
# Find the container name
docker ps --format '{{.Names}}'

# Read the token from the config (volume-mounted state)
cat /mnt/openclaw-state/openclaw.json | jq '.gateway.auth.token'

# OR from inside the container
docker exec <container> cat /home/node/.openclaw/openclaw.json | jq '.gateway.auth.token'
```

> **⚠️ Gotcha:** `printenv OPENCLAW_GATEWAY_TOKEN` inside the container may show a *different* token (set by CloudFormation). The config file token always wins due to the precedence chain: `authConfig.token ?? env.OPENCLAW_GATEWAY_TOKEN`.

**After redeployment / new instance:**
The token regenerates on every `openclaw onboard`. After deploying a new cloud instance, re-run the retrieval steps above.

**HTTP hooks token:**
Only needed if hooks are explicitly configured on the gateway (`hooks.token` in gateway config). If not configured, leave `OPENCLAW_HTTP_TOKEN` empty — the WS path is primary.

### Circuit Breaker & Reconnection

If the token is wrong or the gateway is unreachable, the WS client retries with exponential backoff (1 s → 60 s max). The circuit breaker trips after **5 consecutive failures** and resets after **5 minutes**. Fix the token, restart sinain-core, and it auto-recovers.
