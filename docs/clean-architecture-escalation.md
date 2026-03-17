# SinainHUD: Clean Architecture Brainstorm
## Escalation, Agent Messaging & Session Design

> If we started fresh, knowing every failure we've hit — how would we design this?
> Date: 2026-03-17

---

## The One Core Insight

The current system uses **FIFO queue semantics** for what is fundamentally a **real-time display system**.

A FIFO queue is the right model when every item must be processed (email, task queue). But the HUD goal is different: **the agent should always be responding to the most current context**. A 30-second-old digest sitting in a queue is noise, not value.

The entire class of problems we've hit — queue overflow, Phase 2 orphans, backpressure, stale accepted entries, revert after revert — all trace to this mismatch.

**The right model is latest-wins, not FIFO.**

---

## Part 1: What We Know Now

### The product

The whole point of the system is `[🤖]` agent responses in the HUD. The `[🧠]` local LLM step is a context preprocessor — it produces SITUATION.md and a scoring signal. It is not the product.

### The bottlenecks

| Problem | Root cause |
|---------|-----------|
| Phase 2 orphans (accepted entries stuck forever) | FIFO queue; accepted entries have no TTL |
| Backpressure / overflow reverts | Queue accumulates stale ticks faster than it drains |
| "No responses for minutes" after restart | Session hard-reset loses context → agent must re-bootstrap from scratch |
| Phase 1 timeout trips circuit breaker | 10s is too tight; transient latency (gateway under load) looks like a failure |
| Content-hash dedup blocks context updates | Same situation with slightly different wording → silently skipped |
| Plugin God-object | One 900-line file doing file sync, playbook gen, overflow watchdog, session tracking, RPC, Telegram, triple ingestion — all coupled |

---

## Part 2: Design Principles

### P1 — Latest-wins, not FIFO
New context replaces old context in the pending slot. The agent always responds to the *current* situation when it becomes free, not to a snapshot from 45 seconds ago.

### P2 — SITUATION.md is the source of truth
The escalation signal says "something changed, please respond." The agent reads SITUATION.md at execution time to get the actual context. This means a signal sent 10s ago still gets a fresh response — it reads the current SITUATION.md, not the stale message body.

### P3 — Two items max in-flight
At most: 1 entry in Phase 2 (agent processing) + 1 pending latest. No queue depth beyond 2. No backpressure needed. No overflow possible.

### P4 — Session = rolling window, not append-only log
Sessions auto-compact by summarizing the oldest portion when the window fills. No overflow event. No hard reset. No minutes of silence after restart.

### P5 — Local LLM = context preprocessor, not the product
In rich mode: local LLM compiles raw sense+audio into SITUATION.md. That's its job. HUD shows `[🤖]` responses. The local LLM output (`[🧠]`) is a secondary signal.

### P6 — Observable, not heuristic
Health monitoring via real metrics: Phase 1 latency, Phase 2 latency, response rate, session token count. No threshold counters, no "5 consecutive overflows" heuristics.

---

## Part 3: Clean Architecture

### 3.1 Data Flow (revised)

```
                sck-capture
               /           \
        PCM stdout        IPC JPEG
             |                |
       AudioPipeline     sense_client
             |                |
      VAD → Transcript     OCR text
             \                /
              FeedBuffer + SenseBuffer
                      |
              ContextPrep (local LLM)
              - Produces: digest, SITUATION.md
              - Does NOT produce HUD text (rich mode)
                      |
                      ├── SITUATION.md ← atomic write → Gateway reads on demand
                      |
              EscalationSlot (latest-wins, depth=2)
                      |
              sendSignal("context:updated", id)
                      |
              Gateway Agent (OpenClaw)
              - Reads SITUATION.md
              - Produces: response text
                      |
              FeedBuffer → WebSocket → Overlay HUD [🤖]
```

### 3.2 EscalationSlot (replaces OutboundQueue)

```typescript
class EscalationSlot {
  private inFlight: SlotEntry | null = null;  // Phase 2 pending
  private latest: SlotEntry | null = null;    // waiting to send

  onNewContext(context: SlotEntry): void {
    // Latest always wins — replace, never queue
    this.latest = context;
    this.tryAdvance();
  }

  private tryAdvance(): void {
    if (this.inFlight !== null) return;  // busy
    if (this.latest === null) return;    // nothing to do
    this.inFlight = this.latest;
    this.latest = null;
    this.sendToAgent(this.inFlight);
  }

  private async sendToAgent(entry: SlotEntry): Promise<void> {
    try {
      // Phase 1: deliver signal (30s — not 10s)
      await this.ws.sendSignal(entry.signalId, entry.sessionKey, PHASE1_TIMEOUT_MS);

      // Phase 2: async, never blocks
      entry.responsePromise.then(response => {
        this.pushToHud(response);
        this.inFlight = null;
        this.tryAdvance();  // pick up any waiting latest
      }).catch(() => {
        this.inFlight = null;
        this.tryAdvance();  // move on even if this one failed
      });

    } catch (phase1Err) {
      // Phase 1 failed: retry with LATEST context, not this stale entry
      this.inFlight = null;
      this.scheduleRetry(() => this.tryAdvance());
    }
  }
}
```

**Benefits over current OutboundQueue:**
- No accumulation — queue depth is always 0, 1, or 2
- No orphaned accepted entries — inFlight has a Phase 2 promise that always resolves/rejects
- Phase 1 failure retries with latest context (not stale entry)
- No `dropAccepted()`, no backpressure, no overflow watchdog needed

**Content-hash idempotency:** Keep it — still useful for Phase 1 delivery dedup on WS retry. But signals are tiny (no message body), so collision probability drops.

### 3.3 The Escalation Signal (no message body)

```typescript
interface EscalationSignal {
  id: string;           // sha256(sessionKey + ts)[0:16] — idempotency
  sessionKey: string;
  priority: 'normal' | 'urgent';
  reasons: string[];    // ['always:rich', 'error:runtime']
  ts: number;
}
```

**How SITUATION.md reaches the agent:**
Already solved — the existing `situation.update` RPC writes content to the **gateway server's disk** (`/home/node/.openclaw/workspace/SITUATION.md`). The agent reads it from the same filesystem. No "second connection" needed — sinain-core pushes via `situation.update` RPC after every tick; the file is always current on the server before the signal arrives.

```
sinain-core                 gateway server (docker)
──────────────────────────────────────────────────
write SITUATION.md content
  → situation.update RPC ──→ plugin writes to server disk
                              (/home/node/.openclaw/workspace/SITUATION.md)

send EscalationSignal ──────→ plugin triggers agent.run()
                              agent reads SITUATION.md from local filesystem
                              agent responds → WS → HUD
```

**Why no message body?**
- Signal is <200 bytes → Phase 1 delivery is near-instant
- Agent reads SITUATION.md at execution time → always gets current context
- Even if signal is delayed 10s, response is to *current* situation
- Message assembly (currently the second-largest source of complexity) → deleted

**Content-hash dedup → solved by design:**
In the current queue, content-hash dedup blocks re-escalation when the situation changes slightly but the first 500 chars of the assembled message haven't changed. With latest-wins and signal-only delivery, there's no message body to hash — every signal gets a fresh timestamp-based id. The dedup problem disappears automatically. This is one of the cleaner "eliminated by design" wins.

### 3.4 Background Agent Spawning (parallel lane — fire & forget + WS event)

Spawn tasks are **long-running by design**: transcript accumulation for a long video, code development, multi-tool chains. They can take minutes. The current architecture handles this via polling (`agent.wait` RPC every 5s, 5-min cap), but polling is fragile — it can miss events, accumulates zombie entries on timeout, and requires complex result extraction from multiple fallback paths.

**Relationship to EscalationSlot:**
- EscalationSlot → main session (`agent:main:sinain`) — immediate context + response
- SpawnTaskManager → child sessions (`agent:main:subagent:<uuid>`) — background work
- Completely separate WS channels, no shared locks — correctly separated already

**Current pain:**
- 45s synchronous timeout for short tasks (`expectFinal: true`) — too short for real long tasks
- Polling path: `agent.wait` every 5s + `chat.history` fallback = 5 possible result paths, all fragile
- Zombie entries: `pendingSpawnTasks` map never cleaned up after timeout
- `spawnInFlight` prevents new spawns while long task runs — user can't spawn a second task

**Clean design — fire-and-forget + WS completion event:**

```
sinain-core                          gateway
──────────────────────────────────────────────────────
dispatch("accumulate transcript", {
  sessionKey: childKey,
  lane: "subagent",
  deliver: false,
  returnViaEvent: true,           ← new: don't wait, push event when done
  ttlMs: 10 * 60 * 1000,         ← 10-minute hard limit
})
    → RPC response: { runId, status: "started" }  ← immediate, no wait

                                   [gateway runs agent for minutes...]

                                   task.complete WS event →
                                   { type: "task.complete",
                                     runId, label, result: "..." }
    ← WS event received
    → pushToHud(`${label}:\n${result}`)
```

**SpawnTaskManager (clean):**

```typescript
class SpawnTaskManager {
  private activeTasks = new Map<string, SpawnTaskEntry>();
  private lastFingerprint = "";
  private lastSpawnTs = 0;

  // Called on WS message handler
  onWsEvent(event: WsEvent): void {
    if (event.type !== "task.complete") return;
    const entry = this.activeTasks.get(event.runId);
    if (!entry) return;
    this.activeTasks.delete(event.runId);
    if (event.result) pushToHud(`${entry.label}:\n${event.result}`);
    broadcastTaskEvent(event.runId, "completed", entry.label, entry.startedAt, event.result);
  }

  async dispatch(task: string, label?: string): Promise<void> {
    const fingerprint = sha256(task.trim()).slice(0, 16);
    const now = Date.now();
    if (fingerprint === this.lastFingerprint &&
        now - this.lastSpawnTs < 60_000) return;

    this.lastFingerprint = fingerprint;
    this.lastSpawnTs = now;
    const childKey = `agent:main:subagent:${uuid()}`;

    // Fire-and-forget: immediate RPC, no expectFinal
    const result = await ws.sendRpc("agent", {
      message: task, sessionKey: childKey,
      lane: "subagent", deliver: false,
      returnViaEvent: true, ttlMs: 600_000,
      spawnedBy: mainSessionKey,
    }, 10_000);  // ← 10s just for "accepted", not for completion

    const runId = result?.payload?.runId;
    if (runId) {
      this.activeTasks.set(runId, { label, startedAt: now, childKey });
      broadcastTaskEvent(runId, "spawned", label, now);
    }
  }
}
```

**Key improvements:**
- **No polling** — single `task.complete` WS event is the completion path
- **No concurrent cap** — multiple long tasks can run simultaneously (they're independent child sessions)
- **No zombie map** — `activeTasks` is keyed by `runId`; gateway TTL cleans up server-side
- **No fallback paths** — one result channel: the WS event payload
- **No `spawnInFlight` bottleneck** — fingerprint dedup (60s cooldown) prevents re-dispatching the same task, but different tasks run in parallel

**On WS reconnect:** sinain-core re-registers the runIds it's tracking. Gateway re-sends any completed events it missed during disconnect (idempotent delivery). Or: for tasks that completed during disconnect, they show up via the existing `sessions_history` query at startup.

### 3.5 Session Rolling Window (replaces overflow watchdog, gateway-side)

```
Session at 80% of token limit:
  ├─ Take oldest 25% of conversation messages
  ├─ Summarize with fast model (haiku): "Summary of earlier context: ..."
  ├─ Replace those messages with 1 summary message
  └─ Session is now at ~60% — continue normally

Invariants:
  ├─ permanentContext (HEARTBEAT.md, key facts) — never summarized, always present
  ├─ summary chain (rolling history) — grows slowly, one item per rotation
  └─ recent window (last N turns) — preserved verbatim
```

**Why this is better:**
- No overflow event — context continuously degrades gracefully
- No hard reset — agent never loses everything at once
- No "minutes of silence" after session wipe
- Memory decay mirrors how human working memory works

**Implementation:** In the gateway plugin. After each agent run, check session token count. If > `ROLLING_WINDOW_THRESHOLD` (e.g. 70% of `maxContextTokens`), run one rotation cycle before the next escalation.

### 3.6 Context Preparation (local LLM — simplified role)

In rich mode, the local LLM's job becomes:

```
ContextPrep.run():
  1. Assemble raw context: recent audio (5), recent OCR (3), active app, errors
  2. Call LLM: "Summarize the current situation in 2-3 sentences"
  3. Write SITUATION.md (digest + raw context + score)
  4. Emit: { situationChanged: bool, score: 0-10 }
  5. (No HUD push in rich mode — agent does that)
```

The LLM output fields needed:
- `digest` — for SITUATION.md and escalation dedup
- `score` — for non-rich mode gate decisions

NOT needed (rich mode):
- `hud` — agent provides this
- `task` / `record` — can remain in local LLM output but not primary path

**Latency gain:** Without building and pushing a HUD line, the local LLM call can use a smaller/cheaper model. Or be skipped when there's truly no new context.

### 3.7 Scoring & Escalation Gate (simplified)

For rich mode: always send (trivially true). The EscalationSlot's latest-wins design means this causes no accumulation.

For selective mode: use LLM-produced score (0–10) rather than regex keyword matching. The LLM already understands context; having it output `"score": 7` is zero extra cost and far more accurate than `\berror\b` patterns.

```typescript
function shouldEscalate(score: number, mode: EscalationMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'rich' || mode === 'focus') return true;
  if (mode === 'selective') return score >= 6;  // LLM-graded, not regex-counted
  return false;
}
```

No more: `score.errors * 3 + score.questions * 2 + ...`

### 3.8 Plugin Architecture (decomposed)

**Current:** 1 file, 900+ lines, all concerns coupled

**Clean:**

```
sinain-hud plugin/index.ts  (~200 lines — thin adapter)
  ├─ register RPC: situation.update → write SITUATION.md
  ├─ register RPC: escalation.signal → route to AgentRunner
  ├─ hook: agent.start → inject permanentContext (HEARTBEAT.md + tiny facts)
  └─ start sub-services

Sub-services (independent, own restart):
  ├─ SessionManager
  │   ├─ tracks session token count after each run
  │   └─ performs rolling window rotation when needed
  │
  ├─ PlaybookService
  │   ├─ generates effective playbook (5-min debounce)
  │   └─ writes to workspace/
  │
  ├─ TelemetryService
  │   ├─ collects: Phase1 latency, Phase2 latency, session token count, response rate
  │   ├─ alerts via Telegram on SLO breach (not on heuristic counters)
  │   └─ no state machine, just metrics + thresholds
  │
  └─ KnowledgeService
      ├─ triple ingestion (with retry, not fire-and-forget)
      └─ module registry + effective guidance
```

**Key rules:**
- Plugin restart ≠ sub-service restart
- Each sub-service has one clear SLA
- Context injection at `agent.start` is **bounded** — budget cap of 2000 tokens for all injected content

---

## Part 4: What Stays the Same

These things work well and should survive a redesign:

| Component | Keep | Why |
|-----------|------|-----|
| Two-phase RPC split | Yes | Phase 1/Phase 2 separation is correct — delivery ≠ response time |
| Atomic SITUATION.md writes | Yes | tmp → rename prevents corruption |
| WS ping keepalive (30s) | Yes | Prevents silent connection stalls |
| Exponential reconnect backoff | Yes | Well-calibrated |
| Spawn task fingerprint dedup | Yes | Correct — prevents re-running identical work |
| Feedback recording | Yes | Valuable signal for curation |
| Privacy layering (sense_client + gateway) | Yes | Core privacy architecture |
| Content-hash idempotency keys | Yes | Useful for Phase 1 delivery dedup |

---

## Part 5: Migration Path

Clean migration without a full rewrite:

| Phase | Change | Removes pain |
|-------|--------|-------------|
| **1** | Increase Phase 1 timeout 10s → 30s | Transient latency trips circuit |
| **2** | Replace OutboundQueue with EscalationSlot (max depth 2, latest-wins) | Queue accumulation, orphaned accepted entries, backpressure |
| **3** | Drop message body from escalation; agent reads SITUATION.md directly | Message assembly complexity, stale content-hash dedup |
| **4** | LLM outputs `score: 0-10` field; replace regex scorer | False positives on keyword matches |
| **5** | Rolling window session compaction in plugin | Hard overflow reset, minutes of silence |
| **6** | Decompose plugin into sub-services | Monolith coupling, restart propagation |

Each phase is independently deployable. Phase 1 is a one-line change. Phases 2–3 together are the core redesign.

**Rollout discipline:** Phases 2–3 (queue replacement) and Phase 6 (plugin decomposition) are independent failure domains with different rollback paths — do not combine them in one pass. Implement and verify Phases 2–3 in isolation first. Plugin decomposition changes are not load-bearing for the core HUD flow; they can wait until the new slot design is proven stable.

Phases 2–3 can use **manual approval** mode — the queue replacement is the highest-risk change and deserves explicit per-commit review before deploy.

---

## Summary

> "The queue exists only because we don't trust the agent to respond to current state.
> If the agent reads SITUATION.md at execution time, the queue's only job is
> delivery confirmation — and for that, depth-1 with latest-wins is enough."

The clean design collapses the escalation pipeline from:

```
queue → Phase1 → accepted → Phase2 → response
        ↑ overflow? backpressure? drain? orphan?
```

to:

```
latest-wins slot (depth ≤ 2) → signal → agent reads SITUATION.md → response
```

Everything else (session, plugin, scorer) becomes simpler as a consequence.
