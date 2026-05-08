# External Integrations

**Analysis Date:** 2026-05-08

## APIs & External Services

**LLM Providers:**
- **OpenRouter** (primary) — Multi-model proxy API for context analysis + transcription
  - SDK/Client: HTTP REST (no SDK, direct fetch)
  - Endpoint: `https://openrouter.ai/api/v1/chat/completions`
  - Auth: `OPENROUTER_API_KEY` environment variable
  - Models: Configurable via `ANALYSIS_MODEL` (default: `google/gemini-2.5-flash-lite`), `ANALYSIS_VISION_MODEL` (default: `google/gemini-2.5-flash`), fallback chains via `ANALYSIS_FALLBACK_MODELS`
  - Files: `sinain-core/src/agent/analyzer.ts:193`, `sinain-core/src/audio/transcription.ts`, `sense_client/ocr.py`

- **Ollama** (local, optional) — Local LLM compatibility
  - Endpoint: `http://localhost:11434` (default, overridable)
  - Auth: None required (local)
  - Used if: `ANALYSIS_PROVIDER=ollama` (OpenAI-compatible endpoint auto-routed)
  - Files: `sinain-core/src/agent/analyzer.ts:callOllama()`, `sense_client/ollama_vision.py`

## Data Storage

**Databases:**
- **SQLite (better-sqlite3)** — Primary: web-db for bookmarks + settings
  - Path: `~/.sinain-core/web-db.sqlite` (sinain-core working state)
  - Client: `better-sqlite3` 11.7.0 (Node.js native)
  - Schema: Bookmarks, user settings, feedback signals
  - Files: `sinain-core/src/web-db/store.ts`

- **SQLite (Python sqlite3)** — Knowledge graph triplestore (sinain-memory plugin)
  - Path: `~/.sinain/memory/knowledge-graph.db` or `~/.openclaw/workspace/memory/knowledge-graph.db`
  - Client: `sqlite3` (Python stdlib)
  - Schema: EAV (entity-attribute-value) with 4 covering indexes (EAVT, AEVT, VAET, AVET), FTS5 text search, confidence decay
  - Connections: WAL mode, 10s timeout for concurrent access
  - Files: `sinain-hud-plugin/sinain-memory/triplestore.py`

**File Storage:**
- **Local filesystem only** — IPC + session data
  - Frame capture IPC: `~/.sinain/capture/frame.jpg` (metadata: `meta.json`)
  - Session pending: `~/.sinain/memory/pending-session.json` (distilled on next startup)
  - Workspace: `~/.openclaw/workspace/SITUATION.md` (atomic write for OpenClaw integration)
  - Traces: `~/.sinain-core/traces/` (if `TRACE_ENABLED=true`)

**Caching:**
- **In-memory ring buffers** (no external cache service)
  - Feed buffer: 100 items max, triggers distillation on full
  - Sense buffer: 30 screen events max, semantic dedup via embeddings
  - Cost tracker: In-memory accumulation, broadcast to overlay every 60s, resets on restart

## Authentication & Identity

**Auth Provider:**
- **OpenRouter API Key** — Required for cloud analysis/transcription
  - Storage: `.env` file or `OPENROUTER_API_KEY` environment variable
  - Scope: Analysis + transcription (used by both sinain-core and sense_client)

- **OpenClaw Gateway Token** — Optional, for agent escalation
  - Tokens: `OPENCLAW_WS_TOKEN` (WebSocket auth, 48-char hex), `OPENCLAW_HTTP_TOKEN` (hook auth)
  - Location: `.env` file with indirection via `agents.json` `${OPENCLAW_WS_TOKEN}` syntax
  - Session Key: `agent:main:sinain` (fully-qualified session identifier)
  - Files: `sinain-core/src/escalation/escalator.ts`, `sinain-core/src/agents-loader.ts`

## Monitoring & Observability

**Error Tracking:**
- None detected — errors logged to stdout/stderr only

**Logs:**
- **Console (stdout/stderr)** — Tagged prefixes: `[core]`, `[agent]`, `[server]`, `[audio]`
- **Tracing** (optional) — TRACE_ENABLED=true writes event traces to `~/.sinain-core/traces/`
- **Cost tracking** — CostTracker logs breakdown by source (analysis, transcription, vision) every 60s
- **Files:** `sinain-core/src/log.ts`, `sinain-core/src/cost/tracker.ts`

## CI/CD & Deployment

**Hosting:**
- **GitHub** — Source control (origin + enterprise dual-remote setup)

**CI Pipeline (.github/workflows/):**
- **ci.yml** — Runs on: push to main + PRs
  - **sinain-core-typecheck** — Node 22, npm ci + TypeScript type-check (no ESLint/Prettier enforced in CI)
  - **overlay-analyze** — Flutter 3.27.x stable, flutter pub get + flutter analyze + flutter test

- **release-npm.yml** — Publishes @geravant/sinain to npm (triggered by version tag)
- **release-overlay.yml** — Builds Flutter macOS release, uploads .app to GitHub Releases (triggered by overlay-v* tags)
- **release-sck-capture.yml** — Builds Swift binary, uploads to Releases

**Deployment Target:**
- **npm registry** — @geravant/sinain (CLI + bundled sinain-core + overlay)
- **GitHub Releases** — Pre-built overlay .app, sck-capture binary
- **NemoClaw Brev VM** — OpenClaw gateway deployment (systemd service, not Docker)

## Environment Configuration

**Required env vars:**
- `OPENROUTER_API_KEY` — OpenRouter API key (unless `ANALYSIS_PROVIDER=ollama`)
- `SINAIN_CORE_URL` — URL for overlay to connect (default: `http://localhost:9500`)

**Optional env vars (key ones):**
- `ANALYSIS_PROVIDER` — `openrouter` (default) or `ollama`
- `ANALYSIS_MODEL` — LLM for context (default: `google/gemini-2.5-flash-lite`)
- `TRANSCRIPTION_BACKEND` — `openrouter` (default) or `local` (whisper.cpp)
- `AUDIO_CAPTURE_CMD` — `screencapturekit` (default), `sox`, or `ffmpeg`
- `PRIVACY_MODE` — `off` | `standard` | `strict` | `paranoid` (default: `off`)
- `ESCALATION_MODE` — `off` | `selective` | `focus` | `rich` (default: `rich`)
- `OPENCLAW_WS_URL` / `OPENCLAW_HTTP_URL` — Gateway endpoints (if using agent escalation)
- `SINAIN_MEMORY_DIR` — Knowledge graph directory (default: `~/.sinain/memory`)
- `LEARNING_ENABLED` — Enable knowledge distillation (default: `true`)

**Secrets location:**
- `.env` file (project root) — Not committed (in .gitignore)
- `agents.json` — Contains token references via `${VAR}` syntax (env var indirection)

## macOS Frameworks (PyObjC / Swift)

**Audio:**
- **AVFoundation** — Audio device enumeration, audio session management
- **CoreAudio** — Low-level audio I/O (HAL device access)
- **ScreenCaptureKit** — Zero-copy audio + video capture (macOS 13+)
  - File: `tools/sck-capture/main.swift`
  - Outputs: Raw PCM to stdout, JPEG frames to IPC directory

**Screen Capture:**
- **Core Graphics** (CoreGraphics) — `CGDisplayCreateImage` legacy fallback
- **Vision Framework** — macOS text recognition (OCR)
  - File: `sense_client/capture.py` (PyObjC-Vision)
- **PyObjC Framework Quartz** — CoreGraphics bindings

**Privacy:**
- **NSWindow** — `sharingType = .none` for invisible overlay (NSPanel subclass)
  - File: `overlay/macos/Runner/MainFlutterWindow.swift`

## Windows Platform APIs

**Window Control:**
- **SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)** — Hide window from screen capture (Win10 2004+)
  - Platform channel: `sinain_hud/window`
  - Implementation: `overlay/windows/runner/window_control_plugin.cpp`

**Hotkeys:**
- **GlobalHotkey API** — Ctrl+Shift+H (Windows), Cmd+Shift+H (macOS)
  - Platform channel: `sinain_hud/hotkeys`
  - Implementation: `overlay/windows/runner/hotkey_handler.cpp`

**OCR:**
- **Windows.Media.Ocr** (WinRT) — Native OCR (Windows 10+)
- **win-audio-capture.exe** — WASAPI audio capture (auto-built by setup-windows.sh)

## Audio Integration Points

**Capture Methods:**
1. **ScreenCaptureKit** (primary, macOS 13+) — Zero-copy, camera-safe
   - Location: `tools/sck-capture/main.swift`
   - Output: PCM to stdout (default: 16kHz, 1ch, s16le)

2. **sox** (fallback) — Requires BlackHole loopback device
   - Config: `AUDIO_DEVICE=BlackHole 2ch`, `AUDIO_CAPTURE_CMD=sox`

3. **ffmpeg** (fallback) — CoreAudio backend
   - Config: `AUDIO_CAPTURE_CMD=ffmpeg`, uses `none:<device>` to avoid CoreMediaIO conflicts

**Device Configuration:**
- `AUDIO_DEVICE` — macOS device name (default: `BlackHole 2ch`)
- `AUDIO_SAMPLE_RATE` — PCM sample rate (default: 16000 Hz)
- `AUDIO_CHUNK_MS` — Chunk size for VAD (default: 5000 ms)
- `AUDIO_VAD_ENABLED` — Voice activity detection (default: true)
- `AUDIO_VAD_THRESHOLD` — VAD threshold (default: 0.003)

**Transcription:**
- Model: `google/gemini-2.5-flash` (via OpenRouter, configurable)
- Fallback: Local whisper.cpp (if `TRANSCRIPTION_BACKEND=local`)

## Webhooks & Callbacks

**Incoming:**
- `POST /sense` — sense_client sends screen OCR + metadata
  - Body: SenseEvent JSON (screen_ocr, app, metadata, cost_id for dedup)
  - File: `sinain-core/src/server.ts:POST /sense`

- `POST /knowledge/*` — Knowledge browser UI updates
- `POST /profiling/*` — Profiling hooks (optional)

**Outgoing:**
- **OpenClaw Gateway (HTTP)** — Escalation hook
  - Endpoint: `OPENCLAW_HTTP_URL` (default: http://localhost:18789/hooks/agent)
  - Method: POST with JWT auth token
  - File: `sinain-core/src/escalation/escalator.ts`

- **OpenClaw Gateway (WebSocket)** — Persistent agent communication
  - Endpoint: `OPENCLAW_WS_URL` (default: ws://localhost:18789)
  - Auth: Bearer token from `OPENCLAW_WS_TOKEN`
  - File: `sinain-core/src/escalation/escalator.ts`

## IPC & Local Networking

**sinain-core Server:**
- Port: 9500 (HTTP + WebSocket)
- Endpoints:
  - `POST /sense` — Screen OCR ingestion
  - `GET /feed` — Feed item stream (Server-Sent Events)
  - `GET /knowledge/ui` — Knowledge graph browser (HTML)
  - `GET /knowledge/entities` — JSON entity export
  - `POST /embed` — Embedding inference endpoint (sentence-transformers)
  - WebSocket `/` — Overlay real-time updates (feed, cost, status)

**File-based IPC:**
- `~/.sinain/capture/frame.jpg` — Screen frame (sense_client writes, sck-capture provides)
- `~/.sinain/capture/meta.json` — Frame metadata (timestamp, app, window title)
- `~/.openclaw/workspace/SITUATION.md` — Atomic RPC response (sinain-core writes, OpenClaw reads)

**Embedding Service:**
- **In-process**: Xenova/all-MiniLM-L6-v2 (384 dims) loaded at sinain-core startup
- **API**: POST `/embed` endpoint (called by sense_client for dedup, sinain-memory for retrieval)
- **No external dependency** — ONNX runtime bundled with @huggingface/transformers

---

*Integration audit: 2026-05-08*
