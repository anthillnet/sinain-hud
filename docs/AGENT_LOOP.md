# Agent Analysis Loop — Implementation Spec v2

> The relay is Sinain's eyes, not Sinain's brain. It reports what it sees.
> Sinain does the thinking.

## 1. Current State

The relay (`server/hud-relay.mjs`) runs on port 18791 with:
- **`/feed`** — text messages ring buffer (Sinain → HUD, bridge transcripts → relay). Max 100.
- **`/sense`** — screen capture events ring buffer (sense_client → relay). Max 30.
- **`/agent/*`** — agent analysis loop (v1, implemented). Calls flash-lite every 10s.
- **`/health`** — health check including agent stats.

**Problem with v1**: The agent produces a terse ~30-word summary good for HUD display but useless for Sinain to act on. Sinain needs the full picture to provide real advice.

## 2. Design Change: Two-Output Architecture

One LLM call per tick, structured JSON response with two outputs:

```
Relay (every 30s):
  1. Build context window from feedBuffer + senseBuffer
  2. Call flash-lite with structured output prompt
  3. Parse response:
     a. "hud"    → short line for overlay    → push to /feed
     b. "digest" → rich context for Sinain   → store in /agent/digest
  4. Sinain polls /agent/digest, acts when warranted → pushes advice to /feed
```

```
sense_client ──► /sense ──┐
                          ├──► context window ──► flash-lite ──► { hud, digest }
bridge ──────► /feed  ────┘                                          │      │
                                                                     ▼      ▼
                                                              /feed (HUD)  /agent/digest (Sinain)
                                                                              │
                                                                              ▼
                                                                    Sinain reads, thinks
                                                                              │
                                                                              ▼
                                                                    POST /feed (advice)
                                                                              │
                                                                              ▼
                                                                         HUD overlay
```

## 3. Context Window (unchanged from v1)

Built from existing buffers on every tick. Sliding view, max 2 minutes.

```javascript
function buildContextWindow(feedBuffer, senseBuffer, maxAgeMs = 120_000) {
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  // Extract transcript text from feed items (bridge sends with [PERIODIC] prefix)
  const audioEvents = feedBuffer
    .filter(m => m.ts >= cutoff)
    .filter(m => m.text.includes('[PERIODIC]') || m.text.includes('openrouter]'))
    .map(m => {
      const lines = m.text.split('\n')
        .filter(l => l.includes('openrouter]'))
        .map(l => l.replace(/^\[.*?openrouter\]\s*/, '').trim())
        .filter(Boolean);
      return { ts: m.ts, text: lines.join(' ') };
    })
    .filter(e => e.text.length > 0);

  // Extract sense events — include MORE OCR text than v1
  const screenEvents = senseBuffer
    .filter(e => e.receivedAt >= cutoff)
    .map(e => ({
      ts: e.ts,
      type: e.type,        // "text" | "visual" | "context"
      app: e.meta?.app || 'unknown',
      ocr: e.ocr || '',    // full OCR text, not truncated
      ssim: e.meta?.ssim
    }));

  // Current app from latest sense event
  const latestSense = screenEvents[screenEvents.length - 1];
  const currentApp = latestSense?.app || 'unknown';

  // Deduplicate consecutive identical OCR
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

  // Recent app history (for tracking switches)
  const appHistory = [];
  let lastApp = '';
  for (const e of screenEvents) {
    if (e.app !== lastApp) {
      appHistory.push({ app: e.app, ts: e.ts });
      lastApp = e.app;
    }
  }

  return {
    currentApp,
    appHistory,                            // NEW: app switch timeline
    audio: audioEvents.slice(-5),          // last 5 transcript chunks
    screen: dedupedScreen.slice(-10),      // last 10 unique screen events
    audioCount: audioEvents.length,
    screenCount: screenEvents.length,
    windowMs: maxAgeMs
  };
}
```

### Changes from v1
- **App history**: track app switch timeline (not just current app)
- **Full OCR text**: don't truncate — let the prompt handle length management
- Context events (app switches with empty OCR) always included

## 4. LLM Prompt — Structured JSON Output

### Prompt template

```javascript
function buildPrompt(ctx) {
  // Format screen events — include generous OCR (up to 200 chars per event)
  const screenLines = ctx.screen
    .map(e => {
      const app = normalizeAppName(e.app);
      const ocr = e.ocr ? e.ocr.replace(/\n/g, ' ').slice(0, 200) : '(no text)';
      return `[${app}] ${ocr}`;
    })
    .join('\n');

  // Format audio
  const audioLines = ctx.audio
    .map(e => e.text.slice(0, 300))
    .join('\n');

  // Format app history
  const appSwitches = ctx.appHistory
    .map(a => normalizeAppName(a.app))
    .join(' → ');

  return `You are an AI monitoring a user's screen and audio in real-time.
You produce TWO outputs as JSON.

Active app: ${normalizeAppName(ctx.currentApp)}
App history: ${appSwitches || '(none)'}

Screen (OCR text, newest last):
${screenLines || '(no screen data)'}

Audio transcript (newest last):
${audioLines || '(silence)'}

Respond with ONLY valid JSON, no markdown:
{
  "hud": "<max 15 words: what user is doing NOW. Terse. No filler.>",
  "digest": "<3-5 sentences: detailed description of user activity, what's on screen, what was said, what they might need help with. Include specifics from OCR text. Mention errors, questions, or tasks if visible.>"
}

Rules:
- "hud" is for a minimal overlay display. Example: "Editing hud-relay.mjs in IDEA"
- "digest" is for an AI assistant to understand the full situation and offer help.
- If nothing is happening, hud="Idle" and digest explains what was last seen.
- Include specific filenames, URLs, error messages, UI text from OCR in digest.
- Do NOT suggest actions in digest — just describe the situation factually.`;
}
```

### App name normalization

```javascript
const APP_NAMES = {
  'idea': 'IntelliJ IDEA',
  'code': 'VS Code',
  'code - insiders': 'VS Code Insiders',
  'webstorm': 'WebStorm',
  'pycharm': 'PyCharm',
  'datagrip': 'DataGrip',
  'google chrome': 'Chrome',
  'firefox': 'Firefox',
  'safari': 'Safari',
  'telegram lite': 'Telegram',
  'telegram': 'Telegram',
  'iterm2': 'iTerm',
  'terminal': 'Terminal',
  'finder': 'Finder',
  'audio midi setup': 'Audio MIDI Setup',
};

function normalizeAppName(app) {
  return APP_NAMES[app.toLowerCase()] || app;
}
```

### LLM call

```javascript
async function callAgent(contextWindow, config) {
  const prompt = buildPrompt(contextWindow);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openrouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,           // more room for digest
      temperature: 0.3,
    }),
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';

  // Parse JSON response
  try {
    // Handle potential markdown wrapping
    const jsonStr = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonStr);
    return {
      hud: parsed.hud || '—',
      digest: parsed.digest || '—',
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
    };
  } catch (e) {
    // Fallback: treat entire response as hud line
    return { hud: raw.slice(0, 80) || '—', digest: raw || '—', tokensIn: 0, tokensOut: 0 };
  }
}
```

## 5. Agent Tick (revised)

```javascript
async function agentTick() {
  // 1. Build context
  const ctx = buildContextWindow(feedBuffer, senseBuffer, agentConfig.maxAgeMs);

  // 2. Idle check — skip if no new events since last tick
  const currentFeedLen = feedBuffer.length;
  const currentSenseLen = senseBuffer.length;
  if (currentFeedLen === lastTickFeedLen && currentSenseLen === lastTickSenseLen) {
    if (agentConfig.logVerbose) console.log('[agent] no new events, skipping');
    return;
  }
  lastTickFeedLen = currentFeedLen;
  lastTickSenseLen = currentSenseLen;

  // 3. Empty context check
  if (ctx.audioCount === 0 && ctx.screenCount === 0) {
    if (agentConfig.logVerbose) console.log('[agent] empty context, skipping');
    return;
  }

  // 4. Call LLM
  const start = Date.now();
  try {
    const result = await callAgent(ctx, agentConfig);
    const latencyMs = Date.now() - start;

    // 5. Store in agent buffer
    const entry = {
      id: agentNextId++,
      ts: Date.now(),
      hud: result.hud,
      digest: result.digest,
      context: {
        currentApp: ctx.currentApp,
        appHistory: ctx.appHistory.map(a => a.app),
        audioCount: ctx.audioCount,
        screenCount: ctx.screenCount,
      },
      pushed: false,
      model: agentConfig.model,
      latencyMs,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    };

    agentBuffer.push(entry);
    if (agentBuffer.length > MAX_AGENT_RESULTS) agentBuffer.shift();

    // 6. Update stats
    agentStats.totalCalls++;
    agentStats.totalTokensIn += result.tokensIn;
    agentStats.totalTokensOut += result.tokensOut;
    agentStats.lastAnalysisTs = entry.ts;

    // 7. Push HUD line to feed (if different from last)
    if (agentConfig.pushToFeed && result.hud !== '—' && result.hud !== 'Idle' && result.hud !== lastPushedAnalysis) {
      const msg = { id: nextId++, text: `[🧠] ${result.hud}`, priority: 'normal', ts: Date.now(), source: 'agent' };
      messages.push(msg);
      if (messages.length > 100) messages.splice(0, messages.length - 100);
      lastPushedAnalysis = result.hud;
      entry.pushed = true;
      console.log(`[agent] → HUD: ${result.hud}`);
    }

    // 8. Store digest separately for Sinain
    latestDigest = {
      id: entry.id,
      ts: entry.ts,
      digest: result.digest,
      currentApp: ctx.currentApp,
      appHistory: ctx.appHistory,
      latencyMs,
    };

    if (agentConfig.logVerbose) {
      console.log(`[agent] #${entry.id} (${latencyMs}ms) hud="${result.hud}" digest="${result.digest.slice(0, 100)}..."`);
    }

  } catch (err) {
    console.error('[agent] LLM error:', err.message || err);
  }
}
```

## 6. New/Changed Endpoints

### GET /agent/digest (NEW)

Returns the latest rich digest for Sinain. This is the primary endpoint Sinain polls.

```jsonc
{
  "ok": true,
  "digest": {
    "id": 42,
    "ts": 1769901200000,
    "digest": "User is in IntelliJ IDEA editing server/hud-relay.mjs. Screen shows the agentTick function around line 250. The code handles context window construction and LLM calls. Recent app switches: Chrome → Telegram → IDEA. Audio has been silent for 3 minutes. Previously the user was discussing agent output quality in Telegram with Sinain. No errors visible on screen.",
    "currentApp": "IntelliJ IDEA",
    "appHistory": [
      { "app": "Chrome", "ts": 1769901000000 },
      { "app": "Telegram", "ts": 1769901060000 },
      { "app": "IntelliJ IDEA", "ts": 1769901120000 }
    ],
    "latencyMs": 612
  }
}
```

### GET /agent/last (CHANGED)

Now includes both hud and digest:

```jsonc
{
  "ok": true,
  "result": {
    "id": 42,
    "ts": 1769901200000,
    "hud": "Editing hud-relay.mjs in IDEA",
    "digest": "User is in IntelliJ IDEA editing...",
    "context": {
      "currentApp": "IntelliJ IDEA",
      "appHistory": ["Chrome", "Telegram", "IntelliJ IDEA"],
      "audioCount": 0,
      "screenCount": 5
    },
    "pushed": true,
    "model": "google/gemini-2.5-flash-lite",
    "latencyMs": 612,
    "tokensIn": 310,
    "tokensOut": 85
  }
}
```

### GET /agent/history?limit=N (CHANGED)

Each entry now has both `hud` and `digest` fields.

### GET /agent/context (unchanged)

Raw context window. Still useful for debugging.

### POST /agent/config (unchanged)

Runtime config. All existing fields apply.

### /health (CHANGED)

```jsonc
{
  "ok": true,
  "messages": 15,
  "senseEvents": 30,
  "agent": {
    "enabled": true,
    "lastAnalysis": 1769901200000,
    "lastDigest": "User is in IntelliJ IDEA editing...",  // NEW: latest digest preview
    "totalCalls": 42,
    "totalTokens": { "in": 12600, "out": 3400 },
    "estimatedCost": 0.005,
    "model": "google/gemini-2.5-flash-lite",
    "idleSkips": 15        // NEW: how many ticks were skipped (idle)
  }
}
```

## 7. Interval & Cost

### Changed from v1
- **Interval**: 30s (was 10s) — digest doesn't need to be real-time, and 10s was spammy
- **max_tokens**: 200 (was 100) — digest needs more room
- **Estimated tokens per call**: ~350 in, ~90 out
- **Cost per call**: ~$0.00007
- **Cost per hour**: ~$0.008/hr (at 30s interval with 50% idle skips)
- **Still essentially free**

### Idle savings
With proper idle suppression (skip when no new events), expect 40-60% of ticks to be skipped. Actual cost closer to $0.004/hr.

## 8. Sinain's Consumption Pattern

Sinain polls `/agent/digest` during "start looking" mode:

```
1. Every heartbeat (or 60s poll):
   - GET /agent/digest
   - If digest describes something Sinain can help with:
     - Sinain thinks (using own model, e.g. claude)
     - POST /feed with advice → HUD overlay
   - If digest is boring ("idle", "browsing HN"): do nothing

2. On user request:
   - GET /agent/context for raw data
   - Full analysis with capable model
```

The key separation: **relay sees → Sinain thinks → HUD shows**

## 9. Environment Variables

```bash
# Required
OPENROUTER_API_KEY=sk-or-...

# Agent config (defaults shown)
AGENT_ENABLED=true
AGENT_INTERVAL_MS=30000              # 30s (was 10s in v1)
AGENT_MODEL=google/gemini-2.5-flash-lite
AGENT_MAX_AGE_MS=120000              # 2 min context window
AGENT_MAX_TOKENS=200                 # output tokens (was 100)
AGENT_TEMPERATURE=0.3
AGENT_PUSH_TO_FEED=true              # auto-push hud line to /feed
AGENT_LOG_VERBOSE=false
```

## 10. Migration from v1

Changes to existing `server/hud-relay.mjs`:

1. **`callAgent()`**: new prompt (structured JSON output), new response parsing
2. **`agentTick()`**: add idle suppression, store `hud` + `digest` separately
3. **Agent buffer entries**: add `hud` and `digest` fields (was just `analysis`)
4. **New global**: `latestDigest` object for quick `/agent/digest` access
5. **New endpoint**: `GET /agent/digest`
6. **Updated endpoints**: `/agent/last`, `/agent/history`, `/health`
7. **New function**: `normalizeAppName()`
8. **New function**: `buildPrompt()` (extracted from inline)
9. **Default interval**: 30s (env var default change)
10. **Default max_tokens**: 200

### No breaking changes
- All existing endpoints continue to work
- `/feed`, `/sense` unchanged
- `/agent/config` same fields
- New `digest` field is additive

## 11. Testing

```bash
# Start relay with agent
OPENROUTER_API_KEY=sk-or-... AGENT_ENABLED=true AGENT_LOG_VERBOSE=true node server/hud-relay.mjs

# Push test data
curl -X POST localhost:18791/sense -H 'Content-Type: application/json' \
  -d '{"type":"text","ts":'$(date +%s000)',"ocr":"export function buildContextWindow(feedBuffer, senseBuffer) {\n  const now = Date.now();\n  // TODO: fix idle detection","meta":{"app":"idea","ssim":0.85}}'

curl -X POST localhost:18791/feed -H 'Content-Type: application/json' \
  -d '{"text":"[PERIODIC] (normal)\nContext (1 entries):\n[2s ago, openrouter] So what we need to fix is the idle detection in the agent loop","priority":"normal"}'

# Wait for tick
sleep 35

# Check both outputs
curl -s localhost:18791/agent/last | python3 -m json.tool
# Should show: hud = short line, digest = detailed description

curl -s localhost:18791/agent/digest | python3 -m json.tool
# Should show: rich context for Sinain

# Verify idle suppression — wait another tick with no new events
sleep 35
curl -s localhost:18791/health | python3 -m json.tool
# agent.idleSkips should increment
```

## 12. Future: OCR Quality

Current OCR from sense_client is noisy (UI chrome, repeated elements, encoding artifacts). Future improvements (not in this PR):
- **OCR denoising**: strip common UI patterns (menu bars, status bars)
- **Diff-only OCR**: only send OCR of the CHANGED region, not the full screen
- **Window title as context**: cheaper signal than full OCR for app-level understanding
- **OCR language detection**: handle mixed en/ru/de text better
