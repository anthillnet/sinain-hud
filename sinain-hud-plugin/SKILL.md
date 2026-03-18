# SinainHUD Skill

## What
Two-way communication with sinain-core on Geravant's Mac:
1. **Receive escalations** — respond to context, errors, and questions from sinain-core
2. **Delegate tasks** — spawn subagents for research and background work
3. **Read transcripts** — access sinain session history for context

---

## Architecture

```
sinain-core (Mac)                    OpenClaw Server
     │                                     │
     ├── Escalates ──────────────────────→ │ (message with inline context)
     │   [digest, OCR, audio, errors]      │
     │                                     ├── Main agent processes
     │                                     │
     │ ←───────────────────────────────────┤ Response via escalation reply
     │   (displayed on HUD overlay)        │
     │                                     │
     └── Session transcripts ────────────→ sessions_history (queryable)
```

**Key insight:** There is no separate relay server. sinain-core escalates directly to the OpenClaw server. Responses flow back through the escalation response mechanism and are displayed on the Mac's HUD overlay.

---

## Part 1: Handling Escalations

sinain-core monitors screen and audio on the Mac, then escalates to OpenClaw when it needs help or has context to share.

### Message Format

Escalation messages carry **inline context**:
- **Digest** — summarized screen/audio activity
- **OCR** — text extracted from screen
- **Audio transcripts** — recent speech-to-text
- **Errors** — detected errors from IDEs, terminals, logs

**Example incoming escalation:**
```
[sinain-hud live context — tick #42]

## Digest
User is editing analyzer.ts in IntelliJ IDEA. TypeScript error visible on line 45.

## OCR
TypeError: Cannot read property 'map' of undefined
  at processItems (analyzer.ts:45:12)

## Audio
"Why isn't this working... I already checked for null"
```

### Response Guidelines

- **Respond directly** — your reply goes back to the HUD overlay
- **Be detailed** — 5-10 sentences for escalation responses, drawing on the digest/OCR/audio context provided
- **Address errors first** — prioritize fixing what's broken
- **Reference the context** — use the digest/OCR/audio to be specific
- **Never NO_REPLY** — always respond to escalations

**Example response:**
"The error suggests `ctx.items` is undefined before the `.map()` call. Add a guard: `ctx.items?.map(...)` or check the data source that populates `ctx.items`."

---

## Part 2: Spawn-Task Requests

Messages with `[sinain-core:spawn-task]` request a background subagent for longer work.

### How to Handle

1. Extract the task description
2. Call `sessions_spawn` with the task
3. **Include spawn result in your response** (sinain-core tracks this)

**Example incoming:**
```
[sinain-core:spawn-task] (label: "Team standup")

Please spawn a subagent to handle this task:

Clean up and summarize this recording transcript:

[00:00] Hey everyone, let's start the standup...
[00:15] I finished the authentication PR yesterday...
```

**Your response (must include JSON for tracking):**
```
Spawning subagent for 'Team standup'...
spawn_result: {"status":"accepted","childSessionKey":"agent:main:subagent:xxxxx","runId":"xxxxx"}
```

### sessions_spawn Usage

```javascript
sessions_spawn({
  task: "Clean up and summarize this recording transcript:\n\n[00:00] Hey everyone...",
  label: "standup-summary",  // optional, for tracking
  cleanup: "delete"          // auto-cleanup when done
})
```

**Note:** Subagent results are delivered via Telegram (the main channel), not directly to the HUD. The user sees completion notifications in their normal message flow.

---

## Part 3: Reading Sinain Session History

Use `sessions_history` to read past sinain session transcripts and context.

### When to Use
- Understanding what the user was working on earlier
- Finding context from past escalations
- Reviewing audio transcripts from earlier in the day
- Checking what errors were reported and whether they were resolved

### Usage

```javascript
// Get recent sinain session history
sessions_history({
  sessionKey: "agent:main:sinain",  // full session key (required)
  limit: 20,                        // number of messages (optional, default varies)
  includeTools: false                // include tool calls in output (optional, default false)
})
```

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionKey` | string | **yes** | The session to query. For sinain: `"agent:main:sinain"` |
| `limit` | number | no | Max messages to return |
| `includeTools` | boolean | no | Whether to include tool call messages |

**Important:** There is no `since` or `session` parameter. Always use the full `sessionKey`.

### What You Get Back
- Timestamped messages with inline context (digest, OCR, audio, errors)
- Your previous responses to escalations
- Spawn-task requests and their outcomes

---

## Output Routing

| Content Type | Destination | Why |
|--------------|-------------|-----|
| Escalation responses | **HUD** (via escalation reply) | Immediate, contextual help |
| Subagent completions | **Telegram** | Persistent notification |
| Urgent alerts | **Telegram** | Needs acknowledgment |
| Proactive research results | **Telegram** | Non-blocking, async delivery |

**Rule:** Your direct response to an escalation goes to the HUD. Everything else flows through normal Telegram messaging.

---

## Part 4: Learning from Feedback Signals

sinain-core tracks what happens **after** each escalation and computes feedback signals. These are sent periodically as `[sinain-core:feedback-summary]` messages.

### Feedback Signal Format

Each escalation gets scored on these signals:

| Signal | What It Measures | Good | Bad |
|--------|-----------------|------|-----|
| `errorCleared` | Error disappeared from screen after your response | `true` | `false` |
| `noReEscalation` | Same issue didn't re-escalate within 5 minutes | `true` | `false` |
| `dwellTimeMs` | Time user spent on app after response | > 60s | < 10s |
| `quickAppSwitch` | User switched apps within 10s of your response | `false` | `true` |
| `compositeScore` | Weighted combo of above signals | 0.5 to 1.0 | -1.0 to 0 |

### Reading a Feedback Summary

```
[sinain-core:feedback-summary]

Escalations: 12 | Avg score: 0.45 | Avg latency: 3200ms
Top tags: coding (8), error (5), app:intellij (7)

Recent (last 5):
  ✓ 0.80 [coding, error] — error cleared, no re-escalation
  ✓ 0.60 [coding] — no re-escalation, good dwell
  ✗ -0.20 [error, app:intellij] — error persisted, re-escalated
  ✓ 0.50 [coding] — no re-escalation
  ✓ 0.30 [general] — quick app switch but no re-escalation
```

### How to Use Feedback

**Positive patterns (score > 0.3):**
- Your approach is working — keep it up
- Note what tags/contexts correlate with high scores

**Negative patterns (score < 0):**
- `errorCleared: false` → your fixes aren't working. Try different approaches:
  - Ask for more context instead of guessing
  - Suggest debugging steps rather than direct fixes
  - Check if the error is a red herring (build artifact, stale cache)
- `quickAppSwitch: true` → user found your response unhelpful. Adjust:
  - Be more concise — user may be scanning quickly
  - Lead with the actionable fix, not the explanation
  - Match the urgency — if they're debugging, don't philosophize
- High re-escalation rate → same issues keep coming back:
  - Your fixes are superficial — address root cause
  - The issue might be environmental (config, dependency)
  - Consider suggesting a different tool or approach entirely

### Anti-Patterns to Watch

1. **Always suggesting restarts** — if `errorCleared` is often false after restart suggestions, stop suggesting restarts
2. **Too verbose** — if `quickAppSwitch` is consistently true, shorten your responses dramatically
3. **Missing the real error** — if the same error type keeps re-escalating, you're probably fixing symptoms not causes
4. **Ignoring audio context** — if user mentions something in audio that your response doesn't address, the feedback will be negative

### Inline Feedback in Escalations

Escalation messages may include a `## Recent Feedback` section at the bottom:

```
## Recent Feedback (last 5 escalations)
Score: 0.45 avg | Errors cleared: 3/5 | Re-escalated: 1/5
Recent: ✓ 0.8 (coding, error) | ✓ 0.6 (coding) | ✗ -0.2 (error, intellij) | ✓ 0.5 (coding) | ✓ 0.3 (general)
```

Use this inline context to calibrate your response — if recent scores are low, try a different approach than what you've been doing.

---

## Part 5: Proactive Research from Escalations

When processing escalation ticks, watch for opportunities to **spawn research subagents** proactively. This turns passive observation into active assistance.

### When to Spawn Research

| Signal in Escalation | Research to Spawn |
|---------------------|-------------------|
| User researching new tech/library | `sessions_spawn`: "Deep-dive on [tech]. Quickstart, gotchas, best practices, alternatives." |
| Environment-related error (config, deps, infra) | `sessions_spawn`: "Root cause analysis for [error]. Check known issues, changelogs, migration guides." |
| User asked a question in audio transcript | `sessions_spawn`: "Find answer to: [question]. Summarize with sources." |
| User reading docs/tutorials on a topic | `sessions_spawn`: "Compile key insights on [topic]. What matters most, common mistakes." |

### Rules

1. **Respond to the escalation first** — always send your HUD response before spawning
2. **Max 1 spawn per escalation** — don't flood with subagents
3. **Don't duplicate heartbeat research** — check recent chat history for overlapping spawns
4. **Non-blocking** — `sessions_spawn` returns immediately; the subagent works in the background
5. **Only spawn when the value is clear** — if the user's activity is routine (normal coding, switching apps), don't spawn

### Example Flow

```
Incoming escalation:
  Digest: User browsing Bun documentation. Switched from Node.js project.
  OCR: "Bun.serve() API reference — HTTP server"
  Audio: "I wonder if Bun handles websockets differently..."

Your response (to HUD):
  "Bun handles WebSockets natively via Bun.serve() with a `websocket` handler —
  no separate ws package needed. The API is: server.upgrade(req) in the fetch handler,
  then define open/message/close callbacks in the websocket config."

Then spawn (non-blocking):
  sessions_spawn({
    task: "Deep-dive: Bun WebSocket API vs Node.js ws package. Key differences, migration path, performance characteristics, gotchas. Include code examples.",
    label: "bun-websocket-research",
    cleanup: "delete"
  })
```

The subagent result will arrive via Telegram later, giving the user a thorough reference.

---

## Part 6: Self-Improving Heartbeat

The heartbeat (`HEARTBEAT.md`) runs every 15 minutes and implements a **self-improving feedback loop** — it doesn't just observe and act, it learns from accumulated experience.

### Three-Phase Cycle

| Phase | Purpose | Key Action |
|-------|---------|------------|
| **1. Git Backup** | Persist learning | Commit `memory/` (playbook, archive, logs) and push |
| **2. Observe & Act** | Reactive | Scan recent history, spawn subagents or send suggestions |
| **3. Reflect & Curate** | Self-improving | Update playbook from feedback signals, log decisions, synthesize output |

### Playbook — `memory/sinain-playbook.md`

The heartbeat maintains a curated playbook of what works and what doesn't, updated each tick:
- **Successful patterns** — approaches with high `compositeScore` (>0.3) from feedback signals
- **Failed patterns** — approaches that didn't work, with reasons
- **User preferences** — recurring topics, preferred tools, work rhythms
- Capped at 50 lines; stale entries are pruned, repeated patterns promoted from "observed" to "established"

### Decision Logs — `memory/playbook-logs/YYYY-MM-DD.jsonl`

Every heartbeat tick appends a structured JSON line capturing: what was observed, what actions were considered (and why some were skipped), playbook changes, and the output produced. This enables offline evaluation of the self-improvement process.

### Playbook Archive — `memory/playbook-archive/`

Before each mutation, the current playbook is archived with a timestamp. The archive forms a versioned dataset showing how the agent's strategy evolves over time.

### Output Format

Each heartbeat produces a Telegram message with two components:
- **Suggestion** — practical, actionable recommendation grounded in playbook patterns
- **Insight** — surprising, non-obvious connection from accumulated observations

Both must reference concrete data. Generic advice and repeated outputs are prohibited.

### Setup Requirements

The `openclaw-config-patch.json` documents the required server configuration:
- `agents.defaults.heartbeat.every: "15m"` — 15-minute heartbeat cadence
- `agents.defaults.sandbox.sessionToolsVisibility: "all"` — cross-session history access

---

## Quick Reference

| Task | Method |
|------|--------|
| Respond to live context | Reply directly (goes to HUD) |
| Spawn background work | `sessions_spawn({task: "...", cleanup: "delete"})` |
| Read past context (light) | `sessions_history({sessionKey: "agent:main:sinain", limit: 50, includeTools: false})` |
| Read past context (detailed) | `sessions_history({sessionKey: "agent:main:sinain", limit: 10, includeTools: true})` — only when signals found |
| Proactive research | Respond first, then `sessions_spawn` with research task (max 1 per escalation) |
| Process feedback | Read `[sinain-core:feedback-summary]`, adjust strategy |
| Self-improving loop | Heartbeat curates `memory/sinain-playbook.md` every 15m (see HEARTBEAT.md) |
