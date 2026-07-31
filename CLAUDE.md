# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SinainHUD is a privacy-first AI overlay system for macOS. It captures screen and audio context, analyzes it with LLMs via OpenRouter, and displays real-time advice in an invisible overlay (invisible to screen capture/recording). It escalates to an OpenClaw agent system when deeper analysis is needed.

## Architecture

Three main processes communicate over localhost:

- **sinain-core** (Node.js/TypeScript, port 9500) — Central hub. HTTP + WebSocket server, agent analysis loop, escalation orchestrator, ring buffers (feed: 100 items, sense: 30 events). ES modules (`"type": "module"`).
- **overlay** (Flutter/Dart, macOS) — Private overlay UI. NSPanel with `sharingType = .none` (invisible to screen capture). 2 display modes: Eye (notch-parked agent island or detached) and Chat — no hidden mode. Connects via WebSocket to sinain-core.
- **sense_client** (Python) — Reads screen frames from sck-capture IPC (`~/.sinain/capture/frame.jpg`), SSIM change detection, OCR via OpenRouter vision API, privacy stripping. POSTs to sinain-core `/sense`.
- **sck-capture** (Swift, `tools/sck-capture/`) — Unified ScreenCaptureKit binary. Single `SCStream` captures both system audio (raw PCM → stdout → sinain-core AudioPipeline) and screen frames (JPEG → IPC → sense_client). Replaces separate Python SCKCapture + old sck-audio.

Data flow: `sck-capture → stdout PCM → sinain-core AudioPipeline → VAD → transcription → feed buffer → WebSocket → overlay`. Screen: `sck-capture → IPC JPEG → sense_client → OCR → POST /sense → sinain-core`. Cost: `OpenRouter usage.cost → analyzer/transcription/vision → CostTracker → WebSocket → overlay`.

Knowledge: distillation is gesture-gated — the user's Save runs `feed items + screen OCR → session_distiller.py (LLM) → {facts, entities, decisions} → knowledge_integrator.py (code) → triplestore + entity graph`. Buffer-full and shutdown perform deterministic T1 episode capture to memoryd only (local, no LLM); un-saved window content expires with the rolling window. Memory dir: `SINAIN_MEMORY_DIR` (default `~/.sinain/memory`).

Escalation: Agent loop scores digests against patterns. If score >= threshold (or rich/focus mode), escalates to OpenClaw gateway via HTTP+WebSocket.

## Build & Run Commands

### sinain-core (from `sinain-core/`)
```bash
npm install                    # Install dependencies
npm run dev                    # Watch mode with tsx (development)
npm run build                  # Compile TypeScript to dist/
npm start                      # Run compiled dist/index.js
npm run eval                   # Evaluation harness (3 runs, reports to eval/reports/)
npm run eval:quick             # Quick evaluation (1 run, stdout)
npx tsc --noEmit               # Type-check only (used in CI)
```

### overlay
```bash
# Pre-built (users — no Flutter needed):
npx @geravant/sinain setup-overlay    # Downloads .app/.exe from GitHub Releases
npx @geravant/sinain setup-overlay --update  # Force re-download

# From source (developers, from overlay/):
flutter pub get                # Install dependencies
flutter run -d macos --debug   # Run in debug mode (macOS)
flutter run -d windows --debug # Run in debug mode (Windows)
flutter build macos            # Production build (macOS)
flutter build windows          # Production build (Windows)
flutter analyze                # Dart static analysis
flutter test                   # Run widget tests
npx @geravant/sinain setup-overlay --from-source  # Clone + build
```

### Windows overlay (`overlay/windows/runner/`)
- `window_control_plugin.cpp` — Platform channel `sinain_hud/window` (mirrors Swift WindowControlPlugin)
- `hotkey_handler.cpp` — Platform channel `sinain_hud/hotkeys` (mirrors Swift AppDelegate hotkeys)
- Private overlay via `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` — Windows 10 2004+
- Hotkeys use `Ctrl+Shift` (not `Cmd+Shift`)

### sense_client (from project root)
```bash
python -m sense_client         # Run screen capture pipeline
```

### Full system
```bash
./start.sh                     # Launch all services (core + sense + overlay)
./start.sh --no-sense          # Skip sense_client
./start.sh --no-overlay        # Skip overlay
```

## CI Pipeline (`.github/workflows/ci.yml`)

CI (`ci.yml`) — two jobs:
1. **sinain-core-typecheck** — Node 22, `npm ci` + `npx tsc --noEmit`
2. **overlay-analyze** — Flutter 3.27.x, `flutter pub get` + `flutter analyze` + `flutter test`

Release — **read [docs/RELEASING.md](docs/RELEASING.md) before releasing anything.**
Unified flow (`release.yml`): merge a `RELEASE_VERSIONS.json` bump (per-component
series) to main → overlay zips + npm + sck-capture + signed DMG all build in one
run (merge-driven; no tags needed). A release is NOT done until the sinain.com download CTA
(`docs/index.html`, pinned to `macos-v<ver>`) is bumped and merged — merging to
main deploys the site via Firebase. Per-component tags (`overlay-v*` etc.) still
work for one-off releases.

## Key Source Locations

### sinain-core (`sinain-core/src/`)
- `index.ts` — Entry point, service wiring
- `config.ts` — All env var loading (see `.env.example` for full list)
- `types.ts` — Shared TypeScript interfaces (FeedMessage, SenseEvent, AgentResult, etc.)
- `server.ts` — HTTP endpoints + WebSocket setup
- `agent/loop.ts` — Event-driven agent analysis loop (debounced 3s, max 30s)
- `agent/analyzer.ts` — LLM prompt builder + OpenRouter API calls
- `agent/context-window.ts` — Context assembly with richness presets
- `escalation/escalator.ts` — Escalation orchestration (largest file ~28KB)
- `escalation/scorer.ts` — Pattern-based scoring for escalation decisions
- `buffers/feed-buffer.ts` — Ring buffer for feed items (100 max, `onFull` callback for incremental distillation)
- `buffers/sense-buffer.ts` — Ring buffer for screen events
- `learning/local-curation.ts` — Local knowledge pipeline: incremental distillation on buffer full, session distillation on shutdown, periodic curation
- `embedding/service.ts` — In-process sentence embeddings (all-MiniLM-L6-v2, 384 dims) for semantic dedup + retrieval
- `cost/tracker.ts` — CostTracker: in-memory LLM cost accumulator, periodic logging, WS broadcast
- `eval/` — Evaluation framework with LLM-as-Judge, JSONL scenarios

### overlay (`overlay/lib/`)
- `main.dart` — App entry, service init
- `core/services/websocket_service.dart` — WebSocket bridge with auto-reconnect
- `core/services/window_service.dart` — Platform channel to Swift native code
- `ui/hud_shell.dart` — Main shell, mode switching
- `macos/Runner/MainFlutterWindow.swift` — NSPanel subclass (private overlay window)
- `macos/Runner/AppDelegate.swift` — Global hotkeys, window config

### sinain-memory (`sinain-hud-plugin/sinain-memory/`)
- `session_distiller.py` — LLM-based extraction: transcript → `{facts[], entities[], decisions[]}`
- `knowledge_integrator.py` — Deterministic pipeline: facts → graph ops + entity graph + playbook curation (no LLM)
- `triplestore.py` — SQLite EAV store with 4 covering indexes (EAVT, AEVT, VAET, AVET), FTS5, confidence decay
- `graph_query.py` — Hybrid retrieval: RRF fusion of FTS5 + tag-based + entity graph backrefs
- `embed_client.py` — Python client for sinain-core `/embed` endpoint (semantic dedup + retrieval ranking)
- `common.py` — Shared LLM call utilities with fallback chains

### sense_client (`sense_client/`)
- `capture.py` — Screen capture (IPC from sck-capture, CGDisplayCreateImage fallback)
- `ocr.py` — OpenRouter vision OCR pipeline
- `change_detector.py` — SSIM-based frame change detection
- `privacy.py` — `<private>` tag stripping, auto-redaction (credit cards, API keys, tokens)
- `vision.py` — OpenRouter vision provider for screen analysis, extracts `usage.cost` for cost tracking

## Configuration

All config via environment variables or `.env` file at project root. Key vars:
- `OPENROUTER_API_KEY` — Required (unless `ANALYSIS_PROVIDER=ollama`). Used for analysis + transcription.
- `ANALYSIS_PROVIDER` — `openrouter` (cloud) or `ollama` (local). Default: `openrouter`.
- `ANALYSIS_MODEL` — Context analysis model (default: `google/gemini-2.5-flash-lite`)
- `ANALYSIS_VISION_MODEL` — Vision model for image ticks (default: `google/gemini-2.5-flash`)
- `ANALYSIS_ENDPOINT` — Auto-set per provider. Override for custom OpenAI-compatible endpoints.
- `ESCALATION_MODE` — `off | selective | focus | rich` (default: `off` — gesture-gated contract)
- `OPENCLAW_WS_URL` / `OPENCLAW_HTTP_URL` — OpenClaw gateway endpoints
- `AUDIO_DEVICE` — macOS audio device for sox/ffmpeg fallback (default: `BlackHole 2ch`)
- `SINAIN_MEMORY_DIR` — Knowledge graph directory (default: `~/.sinain/memory`)
- `LEARNING_ENABLED` — Enable/disable knowledge distillation pipeline (default: `true`)
- Autonomous distillation lanes were REMOVED (2026-07-12): the LLM distills only on the explicit Save gesture; buffer-full triggers deterministic T1 episode capture to memoryd only
- `AGENT_ENABLED` — Ambient analyzer loop. Default `false` since the deliberate-capture rework

See `.env.example` for the complete list and [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full reference.

## Architectural Patterns

- **Ring buffers** with fixed max sizes for bounded memory usage
- **Event-driven agent loop** — debounces on new context rather than fixed polling
- **Two-output LLM response** — structured JSON splits `hud` (short display text) from `digest` (rich context for escalation)
- **SITUATION.md** — Atomic file writes (tmp → rename) to `~/.openclaw/workspace/SITUATION.md` for safe concurrent reads by OpenClaw
- **Privacy layering** — Client-side `<private>` tag stripping in sense_client, plus server-side stripping in OpenClaw plugin
- **Fallback models** — Agent retries with configurable fallback model chain on failure
- **Cost tracking** — CostTracker accumulates `usage.cost` from OpenRouter responses across analyzer, transcription, and vision. Vision costs piped from sense_client via POST `/sense` with retry dedup (`cost_id`). In-memory (resets on restart), broadcasts to overlay via WebSocket, logs breakdown by source/model every 60s
- **Knowledge graph** — Two-layer EAV triplestore: `fact:*` entities store individual claims, `entity:*` nodes represent real-world entities connected by ref edges. Four covering indexes (EAVT/AEVT/VAET/AVET) + FTS5. Incremental distillation on buffer full prevents data loss in long sessions.
- **Deterministic integration** — Distiller (LLM) extracts facts, integrator (code) stores them. No LLM in the integration step — deterministic conversion of facts to graph ops eliminates variance.
- **Embedding service** — In-process all-MiniLM-L6-v2 (384 dims) loaded at sinain-core startup for semantic dedup (write path) and retrieval re-ranking (read path). POST `/embed` endpoint.

## Privacy Design

The overlay is invisible to screen capture (`NSWindow.sharingType = .none`). Audio is transcribed in memory, never persisted to disk. Screen text wrapped in `<private>` tags is stripped before transmission. Auto-redaction covers credit cards, API keys, bearer tokens, AWS keys, and passwords via regex patterns.
