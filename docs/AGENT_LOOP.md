# Agent Analysis Loop — Implementation Spec

> The relay becomes the brain. It holds both data streams, builds context, calls an LLM,
> and serves analysis to both Sinain and the HUD overlay.

## 1. Current State

The relay (`server/hud-relay.mjs`) is a single Node.js file, zero dependencies, running on port 18791. It has:

- **`/feed`** — ring buffer of text messages (Sinain → HUD). Max 100 items.
- **`/sense`** — ring buffer of screen capture events (sense_client → relay). Max 30 items.
- **`/health`** — health check.

Both buffers are in-memory arrays. The relay receives both audio transcripts (via `/feed` from the bridge) and screen events (via `/sense` from sense_client). It already has all the data needed for analysis.

## 2. What We're Adding

An **agent module** inside the relay that:
1. Maintains a **context window** (sliding view over both buffers)
2. Calls an LLM (gemini-2.5-flash-lite via OpenRouter) every N seconds
3. Pushes analysis results to a new **agent buffer**
4. Serves results via new `/agent/*` endpoints
5. Optionally auto-pushes insights to `/feed` for HUD display

## 3. Architecture

```
POST /feed (transcripts) ──► feedBuffer ──┐
                                          ├──► contextWindow ──► LLM (OpenRouter)
POST /sense (screen)    ──► senseBuffer ──┘         │                    │
                                                    │                    ▼
                                                    │              agentBuffer
                                                    │                    │
                                                    ▼                    ▼
                                          GET /agent/context    GET /agent/last
                                                                GET /agent/history
                                                                         │
                                                                         ▼
                                                                  auto-push to /feed
                                                                  (→ HUD agent tab)
```

## 4. Context Window

The context window is built on every analysis tick from the two existing buffers. No separate storage — it's a computed view.

### Construction logic

```javascript
function buildContextWindow(feedBuffer, senseBuffer, maxAgeMs = 120_000) {
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  // Extract transcript text from feed items
  // Transcripts arrive as feed items with [PERIODIC] prefix from bridge
  const audioEvents = feedBuffer
    .filter(m => m.ts >= cutoff)
    .filter(m => m.text.includes('[PERIODIC]') || m.text.includes('openrouter]'))
    .map(m => {
      // Extract individual transcript lines
      const lines = m.text.split('\n')
        .filter(l => l.includes('openrouter]'))
        .map(l => l.replace(/^\[.*?openrouter\]\s*/, '').trim())
        .filter(Boolean);
      return { ts: m.ts, text: lines.join(' ') };
    })
    .filter(e => e.text.length > 0);

  // Extract sense events (screen)
  const screenEvents = senseBuffer
    .filter(e => e.receivedAt >= cutoff)
    .map(e => ({
      ts: e.ts,
      type: e.type,
      app: e.meta?.app || 'unknown',
      ocr: e.ocr || '',
      ssim: e.meta?.ssim
    }));

  // Determine current app (from latest sense event)
  const latestSense = screenEvents[screenEvents.length - 1];
  const currentApp = latestSense?.app || 'unknown';

  // Deduplicate OCR text (consecutive identical entries)
  const dedupedScreen = [];
  let lastOcr = '';
  for (const e of screenEvents) {
    if (e.ocr && e.ocr !== lastOcr) {
      dedupedScreen.push(e);
      lastOcr = e.ocr;
    } else if (!e.ocr && e.type === 'context') {
      dedupedScreen.push(e); // app switches always included
    }
  }

  return {
    currentApp,
    audio: audioEvents.slice(-5),          // last 5 transcript chunks
    screen: dedupedScreen.slice(-10),       // last 10 unique screen events
    audioCount: audioEvents.length,
    screenCount: screenEvents.length,
    windowMs: maxAgeMs
  };
}
```

### Key decisions
- **Max age: 120 seconds** — older events are stale context
- **Audio: last 5 chunks** — enough for ~50s of speech
- **Screen: last 10 unique events** — deduped by OCR text to avoid repeats
- **No image data** — OCR text + app name only (keeps tokens minimal)

## 5. LLM Analysis

### Model

- **Model**: `google/gemini-2.5-flash-lite` via OpenRouter
- **Latency**: ~0.5s
- **Cost**: ~$0.000007/call (~$0.0025/hr at 10s interval)
- **Max tokens**: 100 (output), ~300 (input context)

### Prompt

```
You are Sinain, an AI monitoring a user's screen and audio in real-time.

Active app: {currentApp}

Screen activity (OCR, newest last):
{screen events formatted as: [app] ocr_text}

Audio (transcript, newest last):
{audio chunks, newest last}

Task: In 1-2 SHORT sentences:
1. What is the user doing right now?
2. One specific, actionable suggestion if you can help. If nothing useful, say "—".

Rules:
- Be terse. Max 30 words total.
- No filler ("I see that...", "It appears..."). Just state it.
- If screen shows code errors, suggest a fix.
- If audio is a lecture, note the topic.
- If nothing interesting, respond with just "—".
```

### Call implementation

```javascript
async function callAgent(contextWindow, config) {
  const screenLines = contextWindow.screen
    .map(e => `[${e.app}] ${e.ocr.slice(0, 120)}`)
    .join('\n');

  const audioLines = contextWindow.audio
    .map(e => e.text.slice(0, 200))
    .join('\n');

  const prompt = `You are Sinain, an AI monitoring a user's screen and audio in real-time.

Active app: ${contextWindow.currentApp}

Screen activity (OCR, newest last):
${screenLines || '(no screen data)'}

Audio (transcript, newest last):
${audioLines || '(silence)'}

Task: In 1-2 SHORT sentences:
1. What is the user doing right now?
2. One specific, actionable suggestion if you can help. If nothing useful, say "—".

Rules:
- Be terse. Max 30 words total.
- No filler. Just state it.
- If screen shows code errors, suggest a fix.
- If audio is a lecture, note the topic.
- If nothing interesting, respond with just "—".`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openrouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0.3,
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '—';
}
```

### Interval & rate limiting

- **Analysis interval**: configurable via `AGENT_INTERVAL_MS` env var (default: `10000` — every 10s)
- **Suppress duplicate output**: if LLM returns same text as last push, skip
- **Suppress "—" responses**: don't push to feed, just log
- **Cooldown**: min 10s between HUD pushes (inherent from interval)
- **Idle suppression**: if no new events in either buffer since last tick, skip LLM call entirely

## 6. Agent Buffer

Stores the last N analysis results:

```javascript
const agentBuffer = [];        // ring buffer
const MAX_AGENT_RESULTS = 50;  // keep last 50

// Each entry:
{
  id: 1,
  ts: Date.now(),
  analysis: "Browsing Telegram, reading Sinain's messages about agent architecture.",
  context: {                   // snapshot of what was analyzed
    currentApp: "Telegram Lite",
    audioCount: 0,
    screenCount: 5
  },
  pushed: true,                // whether it was pushed to /feed
  model: "google/gemini-2.5-flash-lite",
  latencyMs: 487,
  tokensIn: 280,
  tokensOut: 24
}
```

## 7. New Endpoints

### GET /agent/last

Returns the latest analysis result.

```jsonc
{
  "ok": true,
  "result": {
    "id": 42,
    "ts": 1769899800000,
    "analysis": "Browsing HN. No action needed.",
    "context": { "currentApp": "Chrome", "audioCount": 0, "screenCount": 3 },
    "latencyMs": 512
  }
}
```

### GET /agent/history?limit=N

Returns last N analysis results (default 10, max 50).

```jsonc
{
  "ok": true,
  "results": [ /* newest first */ ]
}
```

### GET /agent/context

Returns the current context window (what the LLM would see on the next tick). Useful for debugging and for Sinain to inspect directly.

```jsonc
{
  "ok": true,
  "context": {
    "currentApp": "Chrome",
    "audio": [ { "ts": ..., "text": "..." } ],
    "screen": [ { "ts": ..., "app": "Chrome", "ocr": "...", "type": "text" } ],
    "audioCount": 3,
    "screenCount": 7,
    "windowMs": 120000
  }
}
```

### POST /agent/config

Update agent configuration at runtime (no restart needed).

```jsonc
// Request body — all fields optional, only provided fields are updated
{
  "enabled": true,             // start/stop the analysis loop
  "intervalMs": 10000,         // analysis interval
  "model": "google/gemini-2.5-flash-lite",
  "maxAge": 120000,            // context window duration
  "pushToFeed": true,          // auto-push to /feed for HUD
  "temperature": 0.3
}

// Response
{ "ok": true, "config": { /* current full config */ } }
```

### GET /agent/config

Return current agent configuration.

### Updated /health

```jsonc
{
  "ok": true,
  "messages": 15,
  "senseEvents": 30,
  "agent": {
    "enabled": true,
    "lastAnalysis": 1769899800000,
    "totalCalls": 142,
    "totalTokens": { "in": 39200, "out": 3400 },
    "estimatedCost": 0.005,       // USD
    "model": "google/gemini-2.5-flash-lite"
  }
}
```

## 8. Auto-push to HUD Feed

When the agent produces a non-trivial result (not "—", not duplicate), it pushes to `/feed` with a special format:

```javascript
if (analysis !== '—' && analysis !== lastPushedAnalysis) {
  const msg = {
    id: nextId++,
    text: `[🧠] ${analysis}`,
    priority: 'normal',
    ts: Date.now(),
    source: 'agent'           // new field — bridge/overlay can filter on this
  };
  messages.push(msg);
  lastPushedAnalysis = analysis;
}
```

The `[🧠]` prefix and `source: "agent"` field let the bridge/overlay route these to the agent tab specifically.

## 9. Configuration (Environment Variables)

```bash
# Required
OPENROUTER_API_KEY=sk-or-...       # OpenRouter API key

# Optional (defaults shown)
AGENT_ENABLED=true                  # start analysis loop on boot
AGENT_INTERVAL_MS=10000             # analysis every 10s
AGENT_MODEL=google/gemini-2.5-flash-lite
AGENT_MAX_AGE_MS=120000             # context window: 2 minutes
AGENT_MAX_TOKENS=100                # max output tokens
AGENT_TEMPERATURE=0.3               # lower = more consistent
AGENT_PUSH_TO_FEED=true             # auto-push to HUD
AGENT_LOG_VERBOSE=false             # log full prompts/responses
```

## 10. Code Structure

All changes in `server/hud-relay.mjs` — single file, zero npm dependencies. Uses `fetch()` (built into Node 18+).

```
server/hud-relay.mjs
├── Existing: feedBuffer, senseBuffer, /feed, /sense, /health
├── New: agentConfig (loaded from env)
├── New: agentBuffer (ring buffer of results)
├── New: buildContextWindow(feedBuffer, senseBuffer, maxAgeMs)
├── New: callAgent(contextWindow, config) → string
├── New: agentTick() — called by setInterval
│   ├── Build context window
│   ├── Check if new events exist (skip if idle)
│   ├── Call LLM
│   ├── Store result in agentBuffer
│   ├── Auto-push to feed if non-trivial
│   └── Log stats
├── New: /agent/last, /agent/history, /agent/context, /agent/config
└── Updated: /health (includes agent stats)
```

### Minimal dependency approach

The relay uses **zero npm packages**. To keep it that way:
- `fetch()` is global in Node 18+ (no import needed)
- JSON parsing is built-in
- `setInterval` for the tick loop
- Environment variables via `process.env`

## 11. Error Handling

- **LLM call fails**: log error, skip tick, retry on next interval. Don't crash.
- **LLM returns garbage**: if response doesn't parse, treat as "—".
- **Rate limited by OpenRouter**: back off by doubling interval, reset after success.
- **No API key**: agent starts in disabled state, logs warning. Can be enabled later via `/agent/config` once key is provided.
- **Empty context**: if both buffers have zero events in window, skip LLM call (respond "—" locally).

## 12. Sinain's Consumption Pattern

Sinain (the OpenClaw agent) polls the relay to stay aware:

1. **Heartbeat**: check `/health` — see agent stats, confirm it's running
2. **On "start looking"**: verify agent is enabled via `/agent/config`
3. **Periodic**: poll `/agent/last` to see latest analysis (or just read HUD feed)
4. **Deep dive**: call `/agent/context` to see raw context window, then do own analysis with a more capable model if needed
5. **Reconfigure**: POST `/agent/config` to adjust interval, model, or disable

The separate pollers (`sense-poll.mjs`, `sense-watch.mjs`) become **optional** — only needed if Sinain wants raw event access. For most use cases, `/agent/last` is sufficient.

## 13. Example Flow

```
t=0s   sense_client → POST /sense { app: "Chrome", ocr: "GitHub - sinain-hud", type: "text" }
t=3s   bridge → POST /feed { text: "[PERIODIC] ... Laplace transforms ..." }
t=10s  agentTick():
         context = { currentApp: "Chrome", screen: [{app:"Chrome", ocr:"GitHub..."}], audio: [{text:"Laplace..."}] }
         LLM → "Reading sinain-hud repo on GitHub. Audio: math lecture (Laplace transforms)."
         → push to feed: "[🧠] Reading sinain-hud repo on GitHub. Audio: math lecture (Laplace transforms)."
         → store in agentBuffer
t=15s  sense_client → POST /sense { app: "IntelliJ IDEA", type: "context" }  (app switch)
t=20s  agentTick():
         context = { currentApp: "IDEA", screen: [{app:"Chrome",...}, {app:"IDEA", type:"context"}], audio: [...] }
         LLM → "Switched to IDEA. Lecture continues in background."
         → push to feed
t=25s  sense_client → POST /sense { app: "IDEA", ocr: "TypeError: Cannot read property 'config'", type: "text" }
t=30s  agentTick():
         LLM → "TypeError in IDEA — 'config' might be undefined. Try optional chaining (?.) or null check."
         → push to feed (this is actionable advice)
```

## 14. Testing

After implementation, test with:

```bash
# 1. Start relay with agent enabled
OPENROUTER_API_KEY=sk-or-... AGENT_ENABLED=true node server/hud-relay.mjs

# 2. Push fake sense events
curl -X POST localhost:18791/sense -H 'Content-Type: application/json' \
  -d '{"type":"text","ts":'$(date +%s000)',"ocr":"function main() { throw new Error(\"null ref\") }","meta":{"app":"VS Code","ssim":0.85}}'

# 3. Push fake transcript
curl -X POST localhost:18791/feed -H 'Content-Type: application/json' \
  -d '{"text":"[PERIODIC] (normal)\nContext (1 entries):\n[1s ago, openrouter] So the key insight with Laplace transforms is...","priority":"normal"}'

# 4. Wait 10s, check agent output
curl -s localhost:18791/agent/last | python3 -m json.tool

# 5. Check health for stats
curl -s localhost:18791/health | python3 -m json.tool

# 6. Check full context
curl -s localhost:18791/agent/context | python3 -m json.tool
```
