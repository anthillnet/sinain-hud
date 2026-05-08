# Codebase Concerns

**Analysis Date:** 2026-05-08

## Tech Debt

### Large Monolithic Modules

**Escalation orchestrator:**
- Issue: `sinain-core/src/escalation/escalator.ts` is 1132 lines — mixes escalation scoring, message building, OpenClaw WebSocket dispatch, spawn task polling, and slot management in a single class
- Files: `sinain-core/src/escalation/escalator.ts`
- Impact: Hard to test individual concerns; changes to one responsibility ripple across the whole module. High surface area for bugs.
- Fix approach: Extract spawn/task polling to separate `SpawnTaskManager`, move slot lifecycle to `EscalationSlotManager`, split message building into dedicated builder classes

**Core HTTP server:**
- Issue: `sinain-core/src/server.ts` is 2862 lines — handles all HTTP endpoints (health, sense, knowledge graph, WebSocket upgrade, agent HUD commands, chat), WebSocket message routing, knowledge UI HTML
- Files: `sinain-core/src/server.ts`
- Impact: Hard to find where a specific endpoint is handled; middleware ordering issues are invisible; any change requires touching a large file
- Fix approach: Migrate to route/handler pattern with separate modules per domain (`/routes/health.ts`, `/routes/sense.ts`, `/routes/knowledge.ts`, `/websocket/handler.ts`)

**Core entry point:**
- Issue: `sinain-core/src/index.ts` is 1386 lines — service initialization, configuration wiring, ring buffer setup, feed/sense event listeners, learning pipeline, escalation trigger logic, signal handlers, all in one file
- Files: `sinain-core/src/index.ts`
- Impact: Startup logic is hard to follow; threading concerns are implicit; if one service fails to initialize, entire startup can cascade
- Fix approach: Extract to explicit setup phases (`setupServices()`, `setupBuffers()`, `setupAgent()`, `setupEscalation()`, `setupLearning()`) with clear ordering

### Fragile Ring Buffer Coordination

**onFull callback race condition:**
- Issue: `sinain-core/src/buffers/feed-buffer.ts` uses `queueMicrotask()` to fire the incremental distillation callback (`onFull`). If buffer fills again before distillation completes, the second callback is suppressed by `_onFullArmed` flag. However, if distillation is slow (>1s) and many feed items arrive, the flag re-arm happens AFTER distillation completes, potentially missing a window where the buffer was filled again.
- Files: `sinain-core/src/buffers/feed-buffer.ts:26-36`, `sinain-core/src/learning/local-curation.ts:149-150`
- Impact: If distillation is slow and feed items arrive in bursts, some feed items may age out of the ring buffer without being distilled, losing knowledge
- Fix approach: Use versioning (not just a boolean flag) to detect when buffer has been refilled with NEW items since distillation started; only suppress callback if version hasn't changed

**Sense buffer deduplication is conservative:**
- Issue: `sinain-core/src/buffers/sense-buffer.ts` only deduplicates when BOTH SSIM >= 0.97 AND OCR similarity >= 0.9. This means identical screens (e.g., reading the same webpage for 30s) create multiple buffer entries with minimal dedup.
- Files: `sinain-core/src/buffers/sense-buffer.ts:77-103`
- Impact: Sense buffer fills with redundant events; memory usage grows; context window queries return duplicated screen descriptions
- Fix approach: Increase thresholds or use OR logic (dedup if EITHER visual OR text is nearly identical); measure impact on context quality

## Known Bugs

### String.replaceFirst Dart Backreference Bug

**Dart replaceFirst doesn't interpret `$1` as backreference:**
- Symptoms: The fix commit `bad20f8` changed `replaceFirst(Pattern, "$1")` to `replaceFirstMapped(...)` because Dart's `replaceFirst(Pattern, String)` method does NOT interpret capture group syntax (`$1`, `$2`) as backreferences, unlike JavaScript
- Files: `overlay/lib/core/services/websocket_service.dart` (fixed in recent commit)
- Trigger: Any regex-based string replacement in Dart that expects capture groups
- Workaround: Always use `replaceFirstMapped((match) => "literal")` for dynamic replacements in Dart; never use `$N` syntax
- Prevention: Code review gate for regex operations in Dart

### File Handle Leak in Audio Pipeline (Potential)

**Audio capture spawner doesn't explicitly close stdin:**
- Issue: `sinain-core/src/audio/pipeline.ts` spawns sox/ffmpeg processes for audio capture. The process's stdin is never explicitly closed if the parent process terminates early, potentially causing zombie processes.
- Files: `sinain-core/src/audio/pipeline.ts`
- Impact: Long-running sinain-core sessions may accumulate zombie sox/ffmpeg processes, consuming system resources
- Workaround: Monitor `ps aux | grep sox` or `ps aux | grep ffmpeg` during extended sessions
- Fix approach: Ensure spawned process stdin/stdout/stderr are properly closed in cleanup handlers (`process.kill()`, stream close events)

## Security Considerations

### Privacy Redaction Regex Coverage May Have Gaps

**Auto-redaction patterns may miss variants:**
- Risk: `sense_client/privacy.py` uses regex patterns for 15 categories (CC, API keys, AWS, bearer tokens, GitHub PAT, Slack, Google OAuth, JWT, email, phone, SSN, CVV, PIN, private keys, MRN). However:
  - Bearer tokens only match `.{20,}` — shorter tokens (e.g., `Bearer token123`) slip through
  - API keys only match `sk-`, `pk-`, or `api[_-]?key=` — non-standard key naming (e.g., `OPENROUTER_API_KEY=xxx`) won't redact unless the value is 20+ chars AND includes non-alphanumeric separators
  - Email redaction catches standard format but may miss + addressing variants or internationalized domains
- Files: `sense_client/privacy.py:5-43`
- Current mitigation: Client-side stripping of `<private>` tags upstream in sense_client + server-side stripping in OpenClaw plugin
- Recommendations:
  1. Add test cases for edge cases (short tokens, non-standard key names, +addressing)
  2. Consider stricter patterns: bearer token `Bearer\s+\S{10,}` (lower threshold), API key pattern `(?:api|token|secret|key)\s*[:=]\s*[A-Za-z0-9_\-\.]{8,}` (more flexible)
  3. Add human-in-the-loop: log suspected PII that doesn't match patterns for manual review (store in secure log, never in cache)

### Server-Side Privacy Stripping in OpenClaw Plugin

**Plugin's `stripPrivateTags` may not run on all code paths:**
- Risk: `sinain-hud-plugin/index.ts` defines `stripPrivateTags()` at line 94-96 and applies it in `extractRecentContext()` for parent context injection. However, it's unclear if this is applied to ALL tool results before persistence (e.g., in session summaries, in feedback store, in artifact saves).
- Files: `sinain-hud-plugin/index.ts:94-96`, context used in line 47-92
- Impact: Tool results containing user's manually-marked `<private>` blocks may escape to OpenClaw workspace files if not uniformly stripped
- Recommendations:
  1. Audit all code paths that persist tool results or session artifacts
  2. Create a middleware wrapper that auto-strips `<private>` tags from ALL message content before persistence
  3. Add a test suite: create mock sessions with `<private>` blocks, verify they don't appear in workspace artifacts

### SITUATION.md Atomic Write May Race with OpenClaw Reader

**Concurrent reads on non-atomic rename:**
- Risk: `sinain-core/src/agent/situation-writer.ts:162-164` uses write-to-temp + rename for atomicity. However, on some filesystems or NFS mounts, the rename is not atomic at the application level, and OpenClaw may start reading SITUATION.md mid-write.
- Files: `sinain-core/src/agent/situation-writer.ts:162-164`
- Current mitigation: Uses tmp→rename pattern (correct, but filesystem-dependent)
- Recommendations:
  1. Test on target deployment filesystem (ext4, APFS, NFS) to verify atomicity
  2. Add version marker in SITUATION.md header (e.g., `<!-- v123 -->`) so OpenClaw can detect partial reads
  3. Consider write-lock file (`SITUATION.md.lock`) to block concurrent reads during write

## Performance Bottlenecks

### Embedding Model Load Time at Startup

**Problem:** EmbeddingService (`sinain-core/src/embedding/service.ts`) loads the all-MiniLM-L6-v2 model async at startup. The ONNX runtime download + model load takes ~9-15s depending on network. If the model fails to load, the service degrades silently (embeddings always unavailable).
- Files: `sinain-core/src/embedding/service.ts:36-43`
- Cause: Lazy async load without blocking startup; no retry on network error
- Improvement path:
  1. Add exponential backoff retry loop (3 attempts, 2s/4s/8s delays)
  2. Log failures to stderr with actionable message ("model download failed; knowledge retrieval will use RRF ranking only")
  3. Consider shipping pre-cached ONNX model with npm package to skip network download

### Knowledge Graph Query Latency (Python subprocess call)

**Problem:** Every context-window knowledge query spawns a Python subprocess (`execFileSync("python3", [...graph_query.py])`) with 5s timeout. If multiple queries stack, or Python startup is slow, latency compounds.
- Files: `sinain-core/src/index.ts:63-79`, `sinain-core/src/index.ts:126-149`
- Cause: No connection pooling; subprocess overhead (fork + exec + init) on every query
- Improvement path:
  1. Keep a persistent Python subprocess (`ChildProcess`) and IPC via stdin/stdout (vs fork per query)
  2. Cache recent entity lists in-memory with TTL (5min); skip Python call for repeated queries
  3. Pre-warm graph_query.py subprocess at startup, catch initialization errors early

### Vision API Cost Per `/sense` POST

**Problem:** Every screen capture that triggers OCR via OpenRouter costs ~$0.001-0.005 per vision call. If screen changes 2x per second, cost is $7.2/hour (generous estimate). In rich mode, this is expensive.
- Files: `sense_client/vision.py:86-141`, `sinain-core/src/server.ts:/sense` POST endpoint
- Cause: Vision model is run on every SENSE POST; no request deduplication
- Improvement path:
  1. Add vision cost budgeting: allow config `MAX_VISION_COST_PER_HOUR` with automatic throttling (skip vision if budget exceeded)
  2. Skip vision if OCR text hasn't changed significantly (compare against last vision call)
  3. Use cheaper vision model for non-critical updates (e.g., `google/gemini-2.0-flash` instead of `gemini-2.5-flash`)

## Fragile Areas

### OpenClaw WebSocket Reconnect Backoff

**Component/Module:**
- Files: `sinain-core/src/escalation/openclaw-ws.ts:121-200` (approximate range for connection logic)
- Why fragile: WebSocket reconnect uses exponential backoff but doesn't handle gateway restart gracefully. If gateway is down, escalations queue up and may timeout before gateway comes back.
- Safe modification:
  1. Add a "gateway health check" that runs independently of escalation (every 10s), tries a lightweight RPC, and pre-empts escalation if gateway is unreachable
  2. When gateway is down, queue escalations to disk (like `OutboundQueue` but for WS messages)
  3. When gateway reconnects, drain queued escalations in FIFO order
- Test coverage: Create test that kills and restarts OpenClaw server mid-session, verify escalations resume without loss

### Distillation Failure Recovery

**Component/Module:**
- Files: `sinain-hud-plugin/sinain-memory/session_distiller.py`, `sinain-hud-plugin/sinain-memory/knowledge_integrator.py`
- Why fragile: If `session_distiller.py` (LLM call) fails, the distillation is skipped silently. Items remain in feed buffer. On next startup, they're re-distilled, but if failure persists, knowledge is lost.
- Safe modification:
  1. Catch distillation errors in `sinain-core/src/learning/local-curation.ts` and log them with context (feed size, item count)
  2. If distillation fails 3+ times in a row, write undistilled items to `distillation-failures.jsonl` for manual review
  3. Add a recovery endpoint: `GET /learning/retry-failed` that re-runs distillation on saved failures
- Test coverage: Mock session_distiller.py to fail, verify items are logged and recovery works

### SQLite Triplestore Index Corruption

**Component/Module:**
- Files: `sinain-hud-plugin/sinain-memory/triplestore.py` (schema + FTS index)
- Why fragile: FTS5 index can become corrupted if database is accessed concurrently by multiple processes (e.g., graph_query.py reads while knowledge_integrator.py writes). SQLite's default locking is coarse and may not prevent this.
- Safe modification:
  1. Always use `BEGIN IMMEDIATE` instead of `BEGIN` for write transactions (exclusive lock)
  2. Add WAL mode: `PRAGMA journal_mode = WAL` (enables concurrent reads)
  3. Implement corruption detection: `PRAGMA integrity_check` on startup, auto-rebuild FTS if corrupted
  4. Add PRAGMA lock timeout: `PRAGMA busy_timeout = 5000` (wait 5s for lock)
- Test coverage: Simulate concurrent writes (knowledge_integrator + graph_query), verify index stays consistent

## Scaling Limits

### Ring Buffer Hard Limits

**Resource/System:** Feed buffer (100 items max), sense buffer (60 events max)
- Current capacity: 100 feed items ≈ 1.7 min of transcription at ~12 items/min. Sense buffer 60 events at ~2 FPS ≈ 30 seconds.
- Limit: If distillation is slow (>1.7 min) or network fails, buffer fills and oldest items are discarded
- Scaling path:
  1. Monitor high-water mark: `feedBuffer.hwm` should stay <80. If it approaches 100 consistently, increase buffer size (200-300).
  2. Profile distillation: measure `LocalCurationService.lastDistilledTs`. If distillation takes >30s regularly, scale down buffer backpressure (trigger at 50 items instead of 100).
  3. Consider per-session buffers: if multiple users/sessions, each needs separate buffers (current design is single-user).

### Escalation Concurrency

**Resource/System:** Max concurrent spawn RPC polls capped at 5 (`MAX_CONCURRENT_POLLS` in escalator.ts)
- Current capacity: 5 concurrent polls means max 5 spawn tasks being polled for results simultaneously
- Limit: If >5 escalations spawn in parallel, queue builds up and response times degrade
- Scaling path:
  1. Monitor `activePolls` metric: if it's consistently at 5, increase to 10
  2. Implement priority queue for spawn tasks (urgent escalations polled first)
  3. Add timeout for spawn tasks: if no result after 300s, retry or fail gracefully

### Cost Tracking In-Memory State

**Resource/System:** CostTracker accumulates costs in memory, resets on restart
- Current capacity: Unbounded map of `costBySource` and `costByModel`
- Limit: No practical limit (maps grow as new sources/models are added), but restart loses all cost history
- Scaling path:
  1. Persist cost snapshots to disk (hourly JSON file in `~/.sinain/memory/cost-logs/`)
  2. Load previous day's costs on startup for continuity
  3. Add cost ceiling: if total daily cost exceeds `MAX_DAILY_COST`, pause analysis until next day

## Scaling Limits (continued)

### OpenClaw Gateway Connection State

**Resource/System:** Single OpenClawWsClient per instance, no connection pooling
- Current capacity: One WebSocket per sinain-core instance, handles all escalations
- Limit: If gateway is slow to respond (>120s), escalations may timeout; no circuit breaker limits retry load
- Scaling path:
  1. Implement circuit breaker: after 3 consecutive failures, skip escalation for 60s, then retry
  2. Add request deduplication: if same escalation context has been pending >30s, drop newer duplicate
  3. Consider separate connection per escalation lane (spawn vs escalation agent)

## Dependencies at Risk

### Hugging Face Transformers Model Download (Offline Risk)

**Package:** `@huggingface/transformers` (JavaScript ONNX runtime wrapper)
- Risk: Model download happens at runtime from Hugging Face CDN. If CDN is down, model load fails silently (no escalation, no knowledge retrieval).
- Impact: Core knowledge retrieval feature degrades without alerting user
- Migration plan:
  1. Ship pre-cached model with npm package (adds ~50MB to package)
  2. Add offline-first flag: `OFFLINE_MODE=true` skips model load, disables embedding-based features
  3. Fallback to RRF-only retrieval (no semantic re-ranking) when model unavailable

### OpenRouter API Key as Single Point of Failure

**Package:** OpenRouter API (external dependency)
- Risk: If `OPENROUTER_API_KEY` is invalid or rate-limited, all LLM analysis fails (agent analysis, transcription, vision OCR)
- Impact: System becomes non-functional; no graceful degradation
- Migration plan:
  1. Support fallback provider: `FALLBACK_ANALYSIS_PROVIDER=ollama` (local Ollama instance)
  2. Add rate limit detection: cache responses, reuse recent analysis if rate limit hit
  3. Implement cost cap: stop making API calls if daily cost exceeds threshold, log and alert

## Missing Critical Features

### No Config Validation at Startup

**Problem:** Config vars are loaded in `config.ts` but not validated. Missing required vars (e.g., `OPENROUTER_API_KEY`) are discovered at runtime when first analysis is attempted, not at startup.
- Blocks: Can't give user immediate feedback on misconfiguration
- Fix approach: Add `validateConfig()` function that runs at startup, checks all required vars, and exits with clear error message if any are missing

### No Health Check for Knowledge Graph Database

**Problem:** If knowledge graph database is corrupted or locked, the system continues running but knowledge queries fail silently.
- Blocks: Can't proactively alert user to database issues
- Fix approach: Add health check endpoint `/health/knowledge` that tests database connectivity and index integrity; include in startup checks

## Test Coverage Gaps

### Cross-Platform Hotkey Coverage

**Untested area:** Windows hotkey registration vs macOS global hotkeys
- What's not tested: Windows `RegisterHotKey` may fail if another app claims the same hotkey; the system doesn't validate upfront, only at hotkey trigger time
- Files: `overlay/windows/runner/hotkey_handler.cpp:46-70`
- Risk: Users on Windows may silently lose hotkey functionality if another app conflicts; no error is reported
- Priority: MEDIUM — affects Windows users only; discoverable at runtime but no fallback

### Privacy Redaction Edge Cases

**Untested area:** Malformed PII patterns, unicode, edge cases
- What's not tested: SSN pattern `\d{3}-\d{2}-\d{4}` doesn't account for variations like `\d{3} \d{2} \d{4}`; email regex doesn't match subdomains with hyphens; CVV may not match 4-digit codes
- Files: `sense_client/privacy.py:5-43`
- Risk: Sensitive data escapes redaction due to pattern mismatches
- Priority: HIGH — security-related; should have comprehensive test suite

### OpenClaw Plugin Session Persistence

**Untested area:** Session state recovery after gateway crash
- What's not tested: If OpenClaw gateway crashes mid-escalation, does sinain-core recover correctly? Are escalations replayed or lost?
- Files: `sinain-core/src/escalation/escalator.ts`, `sinain-hud-plugin/index.ts`
- Risk: Data loss during escalations, inconsistent state between sinain-core and gateway
- Priority: HIGH — data integrity

### Incremental Distillation Re-entrancy

**Untested area:** What happens if distillation is triggered while previous distillation is still running?
- What's not tested: Feed buffer's `_onFullArmed` flag suppresses callback, but if distillation takes >20 items (the threshold), a new callback will fire while previous is still running
- Files: `sinain-core/src/buffers/feed-buffer.ts:56-62`, `sinain-core/src/learning/local-curation.ts`
- Risk: Concurrent distillation calls, race condition on triplestore writes
- Priority: HIGH — data consistency

## In-Flight Work

### Current Feature Branch: `feat/overlay-knowledge-button`

**Description:** Adding knowledge browser button to overlay UI (Controls + Chat header)
- Status: Branch created, recent commits include wsUrl→httpUrl fix (`bad20f8`)
- Related issue: Issue #37 (overlay redesign)
- Related feature: Memory benchmark results show 37.9%→62.7% improvement (deterministic integrator, entity graph)

### Untracked Evaluation Benchmarks

**Description:** Benchmark framework under `sinain-hud-plugin/sinain-memory/eval/benchmarks/`
- Status: Untracked files; populated but not committed
- Contents:
  - `base_adapter.py`, `config.py` — benchmark infrastructure
  - `evaluate.py`, `ingest.py`, `runner.py` — test harness
  - `judges/`, `data/`, `results/` — judge definitions, test data, result artifacts
  - `longmemeval_adapter.py` — compatibility adapter
  - `query.py` (recent, as of 2026-05-08)
- Impact: Results directory exists but code is not versioned; benchmarks can't be reproduced without manual setup
- Fix approach: Commit benchmark code to repo, add CI job to run benchmarks on commits, archive results to S3

## Release & Deployment Risks

### Dual-Remote PR Coordination

**Risk:** Per CLAUDE.md memory, PRs must go to BOTH origin + enterprise remotes, but npm-v* tags go to origin-only. Manual coordination required.
- Files: Not in codebase; process issue
- Impact: If tag is pushed to enterprise by mistake, release is duplicated; if tag is skipped on origin, npm publish fails
- Mitigation: Pre-release checklist in README.md or GitHub issue template

### Flask App Entitlements Sandboxed on macOS

**Risk:** Flutter overlay app is sandboxed with home-relative-path.read-write entitlements. If entitlements are missing or misconfigured, IPC with sense_client fails.
- Files: `overlay/macos/Runner/`, Xcode project entitlements
- Impact: Overlay can't read frame.jpg from ~/.sinain/capture/, screen capture appears broken
- Mitigation: Add startup check: try to read frame.jpg file, log clear error if permission denied

### sck-capture Binary Build Brittleness

**Risk:** `start.sh` builds sck-capture if source is newer than binary. If build fails (e.g., Xcode tools missing), system falls back to CGDisplayCreateImage (deprecated, conflicts with camera).
- Files: `start.sh:195-207`, `tools/sck-capture/main.swift`
- Impact: On fresh setup or Xcode update, screen capture degrades to legacy method, which breaks Google Meet camera
- Mitigation: Add warning in start.sh if sck-capture build fails; require manual `cd tools/sck-capture && bash build.sh` to proceed

---

*Concerns audit: 2026-05-08*
