<!-- refreshed: 2026-05-08 -->
# Architecture

**Analysis Date:** 2026-05-08

## System Overview

SinainHUD is a privacy-first AI overlay system for macOS and Windows. It operates as three independent processes communicating over localhost, each specialized for a specific function: capture, analysis, and display. A fourth executable (sck-capture) handles unified audio and screen capture.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CAPTURE & SENSING                                  │
├──────────────────────────────────────┬──────────────────────────────────────┤
│  sck-capture (Swift binary)          │  sense_client (Python)               │
│  `tools/sck-capture/main.swift`      │  `sense_client/__main__.py`          │
│  • ScreenCaptureKit stream           │  • Frame IPC polling                 │
│  • Audio PCM → stdout                │  • SSIM change detection             │
│  • Screen JPEG → IPC ~/.sinain/      │  • Vision OCR (OpenRouter)           │
└──────────────────────┬───────────────┴───────────────┬──────────────────────┘
                       │ PCM stdin                      │ POST /sense
                       │ JPEG IPC                       │ (rate-limited)
                       ▼                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CENTRAL HUB                                        │
│                    sinain-core (Node.js/TypeScript)                          │
│              `sinain-core/src/index.ts` (port 9500)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  Audio Pipeline              │  Screen Analysis         │  Agent Loop        │
│  `audio/pipeline.ts`         │  `server.ts` /sense      │  `agent/loop.ts`   │
│  • VAD + transcription       │  • Buffer OCR events     │  • Debounced 3s    │
│  • Feed buffer push          │  • Cost tracking         │  • Max interval 30s│
│                              │                          │  • Cooldown 10s    │
│                              │                          │                     │
│  Learning Pipeline           │  Escalation Engine       │  Cost Accumulator  │
│  `learning/local-curation.ts`│  `escalation/escala...` │  `cost/tracker.ts` │
│  • Incremental distillation  │  • Pattern scoring       │  • Real-time tracking
│  • Buffer onFull callback    │  • OpenClaw gateway WS   │  • Broadcast to HUD│
│  • Session distiller.py (LLM)│  • HTTP bare-agent fallback                  │
│  • Knowledge integrator (code)│ • Atomic SITUATION.md writes               │
│                              │                          │                     │
│  Buffers (Ring)              │  Embedding Service       │  WebSocket Server  │
│  • FeedBuffer (100 max)      │  `embedding/service.ts` │  `server.ts`       │
│  • SenseBuffer (30 max)      │  • all-MiniLM-L6-v2     │  • HUD broadcast    │
│                              │  • Semantic dedup + rank│  • Client feed sync │
└─────────────────────────────┬───────────────────────────┬──────────────────────┘
                               │ WebSocket + HTTP          │
                               │ (HUD commands & updates)  │
                               ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DISPLAY & UI                                      │
│                   overlay (Flutter/Dart + Native)                            │
│              `overlay/lib/main.dart` + Swift/C++ plugins                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  macOS                                   │  Windows                          │
│  • NSPanel (sharingType=.none)          │  • SetWindowDisplayAffinity       │
│  • Swift: WindowControlPlugin.swift     │  • C++: window_control_plugin.cpp │
│  • Swift: AppDelegate.swift (hotkeys)   │  • C++: hotkey_handler.cpp        │
│  • Dart: overlay_shell.dart (3-state)   │  • Dart: overlay_shell.dart       │
│  • Drag/resize via native callbacks     │  • Hotkeys: Ctrl+Shift (not Cmd)  │
└─────────────────────────────────────────────────────────────────────────────┘

Optional: OpenClaw Gateway Integration
┌─────────────────────────────────────────────────────────────────────────────┐
│                          OPENCLAW GATEWAY                                    │
│        sinain-hud Plugin (TypeScript) + sinain-memory (Python)               │
│              `sinain-hud-plugin/index.ts`                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  Knowledge Graph (SQLite EAV)    │  Session Pipeline        │  Curation      │
│  • `triplestore.py`              │  • session_distiller.py │  • Feedback miner
│  • 4 covering indexes            │  • knowledge_integrator │  • Memory curator
│  • FTS5 search                   │  • playbook_curator.py  │  • Eval reporter
│  • Entity graph + refs           │                         │                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **sck-capture** | Unified audio (PCM) + screen (JPEG) capture via ScreenCaptureKit, atomic writes to IPC | `tools/sck-capture/main.swift` |
| **AudioPipeline** | Consume PCM from sck-capture stdout, VAD + transcription via OpenRouter, push to feed buffer | `sinain-core/src/audio/pipeline.ts` |
| **FeedBuffer** | Ring buffer (100 max) for all feed items; fires onFull callback for incremental distillation | `sinain-core/src/buffers/feed-buffer.ts` |
| **sense_client** | Poll IPC JPEG, detect changes (SSIM), call vision OCR, POST to sinain-core /sense | `sense_client/__main__.py` |
| **SenseBuffer** | Ring buffer (30 max) for screen events; tracks OCR results, change flags | `sinain-core/src/buffers/sense-buffer.ts` |
| **AgentLoop** | Event-driven debounced analyzer: fires on context change (3s debounce, 30s max interval) | `sinain-core/src/agent/loop.ts` |
| **Analyzer** | Build LLM prompt from feed + sense buffers, call OpenRouter, return HUD + digest JSON | `sinain-core/src/agent/analyzer.ts` |
| **Escalator** | Score digest against patterns; deliver to OpenClaw gateway WS or bare-agent HTTP | `sinain-core/src/escalation/escalator.ts` |
| **LocalCurationService** | Trigger incremental distillation on buffer full; run session distillation on shutdown | `sinain-core/src/learning/local-curation.ts` |
| **CostTracker** | Accumulate `usage.cost` from all sources (analysis, transcription, vision); broadcast to HUD | `sinain-core/src/cost/tracker.ts` |
| **EmbeddingService** | In-process all-MiniLM-L6-v2 for semantic dedup (write) + retrieval ranking (read) | `sinain-core/src/embedding/service.ts` |
| **OverlayShell** | Flutter top-level state machine: 3-state UI (Eye → Controls → Chat) + hotkey handling | `overlay/lib/ui/overlay_shell.dart` |
| **WebSocketService** | Dart WS client with auto-reconnect; pushes feed updates + cost to overlay | `overlay/lib/core/services/websocket_service.dart` |
| **WindowService** | Dart-to-native bridge; macOS: NSPanel window ops; Windows: SetWindowDisplayAffinity + hotkeys | `overlay/lib/core/services/window_service.dart` |
| **sinain-hud Plugin** | OpenClaw extension: auto-deploy HEARTBEAT.md, track tool usage, generate session summaries | `sinain-hud-plugin/index.ts` |
| **session_distiller** | LLM extracts facts/entities/decisions from transcript + OCR | `sinain-hud-plugin/sinain-memory/session_distiller.py` |
| **knowledge_integrator** | Deterministic: convert facts → triplestore ops + entity graph (no LLM in this step) | `sinain-hud-plugin/sinain-memory/knowledge_integrator.py` |
| **triplestore** | SQLite EAV store with FTS5 + 4 covering indexes for hybrid retrieval | `sinain-hud-plugin/sinain-memory/triplestore.py` |

## Pattern Overview

**Overall:** Event-driven reactive system with bounded memory via ring buffers and incremental knowledge distillation.

**Key Characteristics:**
- **Async-first, debounce-driven:** No polling loops. Agent runs on context change (audio/screen events) with 3s debounce, 30s forced tick, 10s cooldown.
- **Immutable buffers for thread safety:** FeedBuffer and SenseBuffer are append-only; snapshots passed to analysis/distillation to prevent concurrent modification.
- **Atomic file operations:** SITUATION.md writes use tmp → rename for safe concurrent reads by OpenClaw.
- **Two-output LLM responses:** Agent produces JSON with `hud` (short display text) and `digest` (rich context for escalation scoring).
- **Callback-driven distillation:** Feed buffer's onFull callback triggers incremental distillation, re-armed after each run. On shutdown, remaining items saved to pending-session.json and processed on next startup.
- **Fallback chains:** Agent retries with configurable model chain on failure. Vision OCR falls back to Ollama if OpenRouter unavailable.
- **Cost tracking across subsystems:** OpenRouter usage costs from analyzer, transcription, and vision (POSTed from sense_client) accumulated in-memory, broadcast to HUD every 60s.
- **Knowledge graph determinism:** Distiller (LLM) extracts facts, integrator (code) converts to graph ops. No LLM in the integration step — deterministic conversion eliminates variance.
- **Local-first knowledge:** Two-layer knowledge: local (~/.sinain/memory) processed on-demand, workspace (~/.openclaw/workspace/memory) synced via OpenClaw plugin.
- **Privacy layering:** Client-side <private> tag stripping in sense_client + server-side in OpenClaw plugin. Auto-redaction covers credit cards, API keys, tokens.

## Layers

**Capture Layer:**
- Purpose: Unified audio and screen capture with minimal overhead and privacy assurance.
- Location: `tools/sck-capture/` (Swift binary), `sense_client/` (Python daemon)
- Contains: ScreenCaptureKit stream, SSIM change detection, vision OCR, privacy masking
- Depends on: macOS ScreenCaptureKit / Windows DirectX, OpenRouter API (optional, falls back to Ollama)
- Used by: sinain-core AudioPipeline and /sense endpoint

**Analysis Layer:**
- Purpose: Real-time context analysis and escalation orchestration.
- Location: `sinain-core/src/agent/`, `sinain-core/src/escalation/`
- Contains: Debounced agent loop, LLM prompt assembly, scoring, message builder
- Depends on: FeedBuffer, SenseBuffer, OpenRouter API, embedding service
- Used by: WebSocket server (broadcast to overlay), escalator (routes to OpenClaw/bare-agent)

**Knowledge Layer:**
- Purpose: Incremental distillation and persistent fact storage.
- Location: `sinain-core/src/learning/` (local pipeline), `sinain-hud-plugin/sinain-memory/` (OpenClaw plugin)
- Contains: Session distiller (LLM), knowledge integrator (code), triplestore (SQLite), graph query
- Depends on: FeedBuffer snapshots, sense_client OCR output, Python subprocess calls
- Used by: Agent context window (knowledge facts injected into prompts), evaluation pipeline

**Display Layer:**
- Purpose: Private overlay UI with hotkey handling and state persistence.
- Location: `overlay/lib/` (Dart), `overlay/macos/Runner/`, `overlay/windows/runner/` (native)
- Contains: Flutter widgets (Eye, Controls, Chat, Feed, Tasks), native window control, settings storage
- Depends on: WebSocket client, native window APIs (NSPanel, SetWindowDisplayAffinity)
- Used by: User interaction, sinain-core broadcast (feed updates, cost, HUD text)

**Infrastructure Layer:**
- Purpose: HTTP/WebSocket server, ring buffers, tracing, profiling.
- Location: `sinain-core/src/server.ts`, `sinain-core/src/buffers/`, `sinain-core/src/trace/`
- Contains: Express-like routing, WebSocket handler, feed/sense buffers, tracer
- Depends on: Node.js ecosystem (ws, better-sqlite3), TypeScript
- Used by: All subsystems

## Data Flow

### Primary Request Path: Audio Transcription → Agent Analysis → HUD Display

1. **Capture** — `sck-capture` via ScreenCaptureKit streams 16-bit PCM to stdout (`tools/sck-capture/main.swift`)
2. **Audio Ingest** — `AudioPipeline` reads from spawned sck-capture process, buffers PCM (`sinain-core/src/audio/pipeline.ts`)
3. **VAD + Transcription** — AudioPipeline triggers OpenRouter transcription when energy threshold crossed (`sinain-core/src/audio/transcription.ts`)
4. **Feed Push** — Transcript added to FeedBuffer (ring buffer, 100 max) with priority "info" (`sinain-core/src/buffers/feed-buffer.ts`)
5. **Event Trigger** — New feed item emits `context:audio` event, debounced 3s (`sinain-core/src/agent/loop.ts:96`)
6. **Agent Loop Tick** — After debounce, assemble ContextWindow from FeedBuffer + SenseBuffer snapshots (`sinain-core/src/agent/context-window.ts`)
7. **LLM Analysis** — Call analyzer with assembled context → return JSON with `hud` + `digest` (`sinain-core/src/agent/analyzer.ts`)
8. **HUD Broadcast** — Extract `hud` text, broadcast via WebSocket to overlay clients (`sinain-core/src/server.ts`)
9. **Escalation Check** — Score `digest` against patterns in scorer; if ≥ threshold, route to escalator (`sinain-core/src/escalation/scorer.ts`)
10. **Display** — Overlay receives HUD update via WebSocket, renders in Eye or Chat state (`overlay/lib/ui/feed/feed_view.dart`)

**State Management:**
- FeedBuffer: Immutable snapshots, append-only ring buffer, version counter tracks onFull re-arm cycles
- SenseBuffer: Similar ring buffer for OCR + change events
- AgentLoop: Debounce state (timer + last run timestamp), running flag to prevent concurrent ticks
- OverlayShell: Flutter State with notifiers for eye animation, window position, settings
- CostTracker: In-memory accumulation per source/model, reset on restart, broadcast every 60s

### Secondary Flow: Screen Change Detection → Incremental Distillation → Knowledge Graph

1. **Screen Polling** — `sense_client` reads JPEG from IPC every 100-500ms (`sense_client/capture.py`)
2. **Change Detection** — SSIM comparison against previous frame; if ≥ threshold, continue to OCR (`sense_client/change_detector.py`)
3. **Vision OCR** — OpenRouter vision API (or Ollama fallback) extracts text from screen (`sense_client/vision.py`)
4. **Cost + Privacy** — Extract usage.cost, apply <private> tag stripping (`sense_client/ocr.py`)
5. **HTTP POST** — Send SenseEvent to sinain-core `/sense` endpoint (`sense_client/sender.py`)
6. **SenseBuffer Append** — Event added to 30-item ring buffer, emits `context:sense` event (`sinain-core/src/buffers/sense-buffer.ts`)
7. **Buffer Full Check** — When FeedBuffer reaches 20 items with 20+ new since last distillation, fire onFull callback (`sinain-core/src/buffers/feed-buffer.ts:51-62`)
8. **Distillation Spawn** — LocalCurationService calls session_distiller.py with feed snapshot + screen OCR as context (`sinain-core/src/learning/local-curation.ts`)
9. **Fact Extraction** — LLM produces facts[], entities[], decisions[] (`sinain-hud-plugin/sinain-memory/session_distiller.py`)
10. **Deterministic Integration** — knowledge_integrator converts facts to EAV triples + entity graph ops, writes to SQLite triplestore (`sinain-hud-plugin/sinain-memory/knowledge_integrator.py`)
11. **Re-arm onFull** — After distillation, re-arm callback by updating version marker (`sinain-core/src/buffers/feed-buffer.ts:32-36`)
12. **Shutdown Flush** — On SIGINT/SIGTERM, save remaining feed items to pending-session.json, process on next startup

### Tertiary Flow: Escalation Decision → OpenClaw Gateway or Bare Agent

1. **After Analysis** — Agent loop's onAnalysis callback invoked with AgentEntry + ContextWindow (`sinain-core/src/agent/loop.ts`)
2. **Scoring** — Escalator calls scorer.shouldEscalate() with digest + escalation mode → boolean + score (`sinain-core/src/escalation/scorer.ts`)
3. **Message Builder** — Fetch knowledge facts, build escalation message with coding context detection (`sinain-core/src/escalation/message-builder.ts`)
4. **Router Selection** — If escalation agent is gateway-typed ("openclaw"), route via WebSocket; else HTTP to bare-agent (`sinain-core/src/escalation/escalator.ts:198-220`)
5. **WS Delivery** (if OpenClaw):
   - Connect to OpenClawWsClient, send escalation frame with message + metadata
   - Await "accepted" frame within 10s → worker unblocks
   - Await final frame (async, never trips timeout) → response arrives, appended to HUD
6. **HTTP Delivery** (if bare-agent):
   - POST to configured bare-agent endpoint with escalation message
   - Maintain stale ID grace window (60s, 5 IDs) for responses mid-analysis
7. **HUD Append** — Response injected into FeedBuffer as priority "high" source "escalation"
8. **SITUATION.md Write** — After tick, if shouldWriteSituation() returns true, write assembled context to ~/.openclaw/workspace/SITUATION.md (tmp → rename) (`sinain-core/src/agent/situation-writer.ts`)

## Key Abstractions

**Ring Buffers (FeedBuffer, SenseBuffer):**
- Purpose: Bounded memory; fixed max sizes prevent unbounded growth
- Examples: `sinain-core/src/buffers/feed-buffer.ts`, `sinain-core/src/buffers/sense-buffer.ts`
- Pattern: Append-only; when full, shift oldest item. Track version counter for onFull re-arm cycles. Snapshots passed immutably to analysis.

**Debounced Agent Loop:**
- Purpose: Reactive event-driven analysis without polling; batches rapid context changes
- Examples: `sinain-core/src/agent/loop.ts:128-180` (tick method)
- Pattern: On context event, clear debounce timer and schedule new tick after 3s. If no events for 30s, force tick. Cooldown 10s prevents re-analysis within that window.

**Two-Output LLM Response:**
- Purpose: Separate short HUD display from rich escalation context
- Examples: `sinain-core/src/agent/analyzer.ts:135-160`
- Pattern: Prompt returns JSON with `hud` (1-2 sentences) and `digest` (full reasoning). Agent loop broadcasts `hud` to overlay immediately; passes `digest` to escalator for scoring.

**Atomic File Writes (SITUATION.md):**
- Purpose: Safe concurrent reads by OpenClaw while sinain-core is writing
- Examples: `sinain-core/src/agent/situation-writer.ts:40-65`
- Pattern: Write to temp file first, then rename. Prevents partial reads if sinain-core crashes mid-write.

**Callback-Driven Distillation:**
- Purpose: Incremental knowledge extraction without blocking analysis loop
- Examples: `sinain-core/src/buffers/feed-buffer.ts:26-30`, `sinain-core/src/learning/local-curation.ts:100-160`
- Pattern: FeedBuffer registers onFull callback; when buffer reaches 20 items and 20+ new items since last distillation, callback fires with snapshot. After distillation completes, re-arm via rearmOnFull().

**Fallback Model Chains:**
- Purpose: Graceful degradation when preferred model/provider unavailable
- Examples: `sinain-core/src/agent/analyzer.ts:200-250`, `sense_client/vision.py:45-80`
- Pattern: Try primary model (e.g., OpenRouter). On failure, retry with secondary (e.g., Ollama). Preserve error state for metrics.

**Cost Tracking Accumulation:**
- Purpose: Real-time LLM cost visibility across all subsystems
- Examples: `sinain-core/src/cost/tracker.ts`
- Pattern: CostTracker accepts cost contributions from analyzer, transcription, vision (piped from sense_client). In-memory map per source/model. Every 60s, log breakdown and broadcast to HUD. Reset on restart.

**Two-Layer Knowledge Graph:**
- Purpose: Local-first knowledge for bare-agent sessions; workspace sync for OpenClaw
- Examples: `sinain-core/src/index.ts:49-100` (queryKnowledgeFactsMulti), `sinain-hud-plugin/sinain-memory/triplestore.py`
- Pattern: Query local knowledge (~/.sinain/memory/knowledge-graph.db) first, then workspace (~/.openclaw/workspace/memory). RRF merge, re-rank by embedding similarity, return top N.

**Entity Cache:**
- Purpose: Real-time knowledge injection from OpenClaw entity subscriptions
- Examples: `sinain-core/src/learning/entity-cache.ts`
- Pattern: Plugin registers entities of interest; cache receives updates via WebSocket. Agent context window queries cache during analysis.

## Entry Points

**sinain-core:**
- Location: `sinain-core/src/index.ts`
- Triggers: `npm run dev` (watch mode), `npm start` (compiled), or spawned via `start.sh`
- Responsibilities: Load config, initialize services (AudioPipeline, AgentLoop, Escalator, CostTracker), create HTTP/WS server, wire event handlers, run main event loop

**overlay:**
- Location: `overlay/lib/main.dart`
- Triggers: Pre-built .app/.exe via GitHub Releases, or `flutter run -d macos/windows --debug`
- Responsibilities: Initialize native window (NSPanel on macOS, SetWindowDisplayAffinity on Windows), create WebSocketService, load settings, display OverlayShell, handle hotkey events

**sense_client:**
- Location: `sense_client/__main__.py`
- Triggers: `python -m sense_client` or spawned via `start.sh`
- Responsibilities: Initialize capture (SCKCapture or fallback), OCR provider (OpenRouter or Ollama), change detector, main loop: poll IPC JPEG, detect change, OCR if needed, POST to sinain-core /sense

**sck-capture:**
- Location: `tools/sck-capture/main.swift`
- Triggers: Compiled binary, spawned by sinain-core AudioPipeline or sense_client
- Responsibilities: Parse CLI args, initialize ScreenCaptureKit stream, output PCM to stdout, write JPEG frames to IPC directory atomically

**sinain-hud Plugin:**
- Location: `sinain-hud-plugin/index.ts`
- Triggers: OpenClaw gateway initialization (plugin system loads extensions listed in openclaw.json)
- Responsibilities: Auto-deploy HEARTBEAT.md and SKILL.md to workspace on agent start, track tool usage, generate session summaries on agent end, manage knowledge curation pipeline

## Architectural Constraints

- **Threading:** Node.js is single-threaded event loop; expensive operations (LLM calls, Python subprocess) spawned as child processes or Promises. Flutter uses Dart's isolate model for async work.
- **Global state:** CostTracker, ConfigLoader results, EmbeddingService (singleton, loaded once at startup) are module-level singletons. FeedBuffer and SenseBuffer are global to agent loop (accessed via AgentLoopDeps). No circular imports enforced by ES module system.
- **Ring buffer limits:** FeedBuffer max 100 items; when full, oldest shifts out. This guarantees bounded memory (~10MB for 100 transcript items). SenseBuffer max 30 events. Distillation triggered every ~20 new items (~1.7 min at 12 items/min).
- **WebSocket delivery:** Two-phase protocol: Phase 1 (10s) awaits "accepted" frame, Phase 2 (120s async) awaits response. Never blocks if no response — escalation slot tracks pending.
- **Privacy constraint:** SITUATION.md must not leak <private> tags. Stripped at capture layer (sense_client) and OpenClaw plugin layer (index.ts regex PRIVATE_TAG_RE).
- **Embedding deadlock prevention:** Knowledge fact queries use Python subprocess (RRF ranking) to avoid holding embedding model lock. Node.js re-ranks results in-process if model ready, otherwise uses Python order.
- **Atomic file safety:** SITUATION.md writes use tmp → rename pattern. OpenClaw can read while sinain-core writes without torn reads.

## Anti-Patterns

### Polling Loops in Agent Analysis

**What happens:** Early version of agent loop used `setInterval(tick, 30000)` to analyze every 30s regardless of context changes.

**Why it's wrong:** Causes 30-60s latency to respond to new context (user starts speaking), battery drain on idle, noisy LLM calls with stale data.

**Do this instead:** Use event-driven debounce (`sinain-core/src/agent/loop.ts`). FeedBuffer and SenseBuffer emit events on push. Agent debounces on those events with 3s delay. Forced tick every 30s ensures minimum responsiveness. Cooldown 10s prevents thrashing.

### Unbounded Ring Buffers

**What happens:** Early feed buffer used `items.push(item)` without a max size, growing unbounded in long sessions.

**Why it's wrong:** Memory leaks; distillation didn't prevent accumulation if triggered frequently. Expensive snapshot copies for analysis.

**Do this instead:** Implement fixed-size ring buffers with shift() on overflow (`sinain-core/src/buffers/feed-buffer.ts`). Track high-water mark for metrics. Trigger distillation before buffer fills, not after.

### Synchronous Knowledge Queries Blocking Agent Loop

**What happens:** Agent loop directly called `execFileSync("python3 graph_query.py")` during context assembly, blocking node event loop.

**Why it's wrong:** If query takes 5s and tick fires every 3s, pending ticks queue up and agent appears frozen.

**Do this instead:** Make queryKnowledgeFacts async (`sinain-core/src/index.ts:49-100`). Spawn Python process asynchronously. If result not ready before analyst starts LLM call, omit facts for this tick (will be available next tick). Cache results in-process.

### Concurrent SITUATION.md Writes Without Atomicity

**What happens:** Early version wrote directly to SITUATION.md in-place, causing OpenClaw to read partial JSON mid-write.

**Why it's wrong:** Gateway plugin crashes or misinterprets truncated state. Lost escalation context.

**Do this instead:** Write to tmp file first, then `fs.renameSync()` atomic rename (`sinain-core/src/agent/situation-writer.ts:40-65`). Ensures OpenClaw always sees complete JSON or old content.

### Blocking Escalation on Gateway Response

**What happens:** Escalator awaited OpenClaw response before continuing agent loop, causing 10-30s freeze if gateway was slow.

**Why it's wrong:** Agent loop stalled; new audio/screen events pile up, old analysis runs on stale context.

**Do this instead:** Two-phase protocol with timeout (`sinain-core/src/escalation/escalator.ts:320-350`). Phase 1: await "accepted" frame 10s (confirms delivery). Phase 2: response arrives async, appended to HUD when ready, never blocks agent loop.

## Error Handling

**Strategy:** Graceful degradation with fallback chains. Never crash core on subsystem failure.

**Patterns:**
- **Audio pipeline failure:** If sck-capture crashes, AudioPipeline emits 'error' event but keeps running. On restart, spawns new sck-capture process. If all retries exhausted, HUD shows warning "Audio unavailable".
- **Transcription failure:** If OpenRouter transcription fails, retry with fallback model (e.g., Whisper via Ollama). If all fail, log and skip this chunk (don't append to feed, prevents stale duplicates).
- **Vision OCR failure:** If OpenRouter vision API fails, retry with Ollama. If both fail, use last known OCR or skip this frame.
- **Knowledge query failure:** If Python graph_query.py times out (5s), return empty string (no facts this tick). Next tick will retry.
- **LLM analysis failure:** If OpenRouter analysis fails, retry with fallback model chain. If all fail, use cached response from last successful tick.
- **Escalation failure:** If gateway WS connection fails, fall back to HTTP bare-agent. If bare-agent unavailable, queue to pending escalations on disk (taskstore.json). Process on restart.
- **WebSocket delivery:** If overlay client disconnects, HUD updates queue in-memory (500 item cap). On reconnect, send queued items. Old items discarded if queue fills.

## Cross-Cutting Concerns

**Logging:** `sinain-core/src/log.ts` provides tagged log functions (log, warn, error, debug). Each subsystem uses const TAG = "subsystem" and logs via log(TAG, msg). Stderr output with color codes. No persistent log file (output to stderr, user captures via redirects).

**Validation:** Input validation at API endpoints (sinain-core/src/server.ts). FeedBuffer.push() validates priority enum. SenseEvent type-checked at endpoint. Config loader validates env vars against schema.

**Authentication:** WebSocket clients authenticate via token in initial connection URL (`ws://localhost:9500?token=...`). Token generated from config (SINAIN_WS_TOKEN env var or random on startup). overlay passes token in WebSocketService.

**Rate limiting:** sense_client POST /sense throttled via DecisionGate (custom debounce logic). Max 1 request per 500ms even if screen changes constantly. Prevents overwhelming sinain-core.

---

*Architecture analysis: 2026-05-08*
