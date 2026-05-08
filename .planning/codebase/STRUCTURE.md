# Codebase Structure

**Analysis Date:** 2026-05-08

## Directory Layout

```
sinain-hud/
├── sinain-core/                        # Central hub: analysis, escalation, buffers
│   ├── src/
│   │   ├── index.ts                    # Entry point, service wiring
│   │   ├── config.ts                   # Env var loading
│   │   ├── types.ts                    # Shared TypeScript interfaces
│   │   ├── server.ts                   # HTTP + WebSocket server (port 9500)
│   │   ├── log.ts                      # Logging utilities
│   │   ├── agent/
│   │   │   ├── loop.ts                 # Debounced event-driven agent loop
│   │   │   ├── analyzer.ts             # LLM prompt + OpenRouter API calls
│   │   │   ├── context-window.ts       # Richness presets, context assembly
│   │   │   └── situation-writer.ts     # Atomic SITUATION.md writes
│   │   ├── escalation/
│   │   │   ├── escalator.ts            # Message delivery orchestration
│   │   │   ├── scorer.ts               # Pattern-based escalation scoring
│   │   │   ├── message-builder.ts      # Knowledge facts + context formatting
│   │   │   ├── openclaw-ws.ts          # WebSocket client to gateway
│   │   │   └── escalation-slot.ts      # Pending escalation queue
│   │   ├── buffers/
│   │   │   ├── feed-buffer.ts          # Ring buffer for feed items (100 max)
│   │   │   └── sense-buffer.ts         # Ring buffer for screen events (30 max)
│   │   ├── audio/
│   │   │   ├── pipeline.ts             # PCM accumulation, VAD, chunking
│   │   │   ├── capture-spawner.ts      # Abstract capture process launcher
│   │   │   ├── capture-spawner-macos.ts # macOS sck-capture spawner
│   │   │   ├── capture-spawner-win.ts  # Windows audio device spawner
│   │   │   ├── transcription.ts        # OpenRouter transcription
│   │   │   └── transcription-local.ts  # Ollama/local fallback
│   │   ├── learning/
│   │   │   ├── local-curation.ts       # Incremental distillation + shutdown flush
│   │   │   ├── entity-cache.ts         # Real-time entity subscriptions
│   │   │   ├── signal-collector.ts     # Signal aggregation for feedback
│   │   │   └── feedback-store.ts       # Persistent feedback log
│   │   ├── embedding/
│   │   │   └── service.ts              # all-MiniLM-L6-v2 in-process embeddings
│   │   ├── cost/
│   │   │   └── tracker.ts              # LLM cost accumulation + broadcast
│   │   ├── privacy/
│   │   │   ├── index.ts                # Privacy level management
│   │   │   ├── redact.ts               # Text redaction utilities
│   │   │   └── presets.ts              # Privacy level definitions
│   │   ├── trace/
│   │   │   ├── tracer.ts               # Distributed tracing spans
│   │   │   └── trace-store.ts          # Trace persistence
│   │   ├── util/
│   │   │   ├── dedup.ts                # Transcript deduplication
│   │   │   ├── event-bus.ts            # Global event emitter
│   │   │   └── task-store.ts           # Pending escalation persistence
│   │   ├── eval/
│   │   │   ├── harness.ts              # Evaluation runner
│   │   │   ├── judges.ts               # LLM-as-Judge for eval
│   │   │   └── scenarios/              # JSONL scenario files
│   │   ├── overlay/
│   │   │   ├── ws-handler.ts           # WebSocket message dispatch
│   │   │   └── commands.ts             # HUD command handlers
│   │   ├── web-db/
│   │   │   └── store.ts                # SQLite session metadata
│   │   ├── profiler.ts                 # Performance metrics
│   │   ├── recorder.ts                 # Trace recording
│   │   └── agents-loader.ts            # Load agents.json configuration
│   ├── dist/                           # Compiled JavaScript (npm run build)
│   ├── package.json                    # Node dependencies
│   └── tsconfig.json                   # TypeScript configuration
│
├── overlay/                            # Flutter HUD app
│   ├── lib/
│   │   ├── main.dart                   # Entry point, service initialization
│   │   ├── core/
│   │   │   ├── constants.dart          # UI constants (colors, sizes)
│   │   │   ├── models/
│   │   │   │   ├── hud_settings.dart   # Persisted overlay settings
│   │   │   │   ├── feed_item.dart      # Feed message model
│   │   │   │   └── spawn_task.dart     # Agent task model
│   │   │   └── services/
│   │   │       ├── websocket_service.dart    # WS client + auto-reconnect
│   │   │       ├── window_service.dart       # Native window bridge (platform channels)
│   │   │       ├── settings_service.dart     # SharedPreferences + persistence
│   │   │       └── onboarding_service.dart   # Onboarding state
│   │   ├── ui/
│   │   │   ├── overlay_shell.dart      # 3-state shell: Eye → Controls → Chat
│   │   │   ├── eye/
│   │   │   │   └── eye_widget.dart     # Animated eye icon + state indicator
│   │   │   ├── feed/
│   │   │   │   ├── feed_view.dart      # Scrollable feed display
│   │   │   │   ├── feed_item_widget.dart  # Single feed item rendering
│   │   │   │   └── idle_animation.dart    # Idle breathing animation
│   │   │   ├── input/
│   │   │   │   └── command_input.dart  # Text input for commands
│   │   │   ├── tasks/
│   │   │   │   └── tasks_view.dart     # Spawn task list + status
│   │   │   ├── settings/
│   │   │   │   ├── display_settings_panel.dart    # UI customization
│   │   │   │   └── agent_selector_panel.dart      # Agent selection
│   │   │   ├── onboarding/
│   │   │   │   ├── onboarding_view.dart
│   │   │   │   ├── step_permissions.dart
│   │   │   │   ├── step_audio_check.dart
│   │   │   │   ├── step_connecting.dart
│   │   │   │   └── step_orientation.dart
│   │   │   ├── hud_tooltip.dart        # Tooltip + popover
│   │   │   └── hud_shell.dart          # Legacy shell (may be deprecated)
│   │   └── fonts/                      # Custom fonts
│   ├── macos/
│   │   └── Runner/
│   │       ├── MainFlutterWindow.swift # NSPanel subclass (private overlay)
│   │       ├── AppDelegate.swift       # App lifecycle + hotkey registration
│   │       ├── WindowControlPlugin.swift   # Platform channel: window control
│   │       └── GeneratedPluginRegistrant.swift (generated)
│   ├── windows/
│   │   └── runner/
│   │       ├── window_control_plugin.cpp   # Platform channel: window control
│   │       ├── hotkey_handler.cpp          # Platform channel: hotkey dispatch
│   │       └── main.cpp                    # Windows app entry
│   ├── pubspec.yaml                   # Flutter dependencies
│   ├── pubspec.lock                   # Dependency lock
│   └── test/                          # Widget tests
│
├── sense_client/                       # Python screen capture + OCR
│   ├── __init__.py
│   ├── __main__.py                    # Entry point (python -m sense_client)
│   ├── capture.py                     # IPC JPEG polling + fallbacks (SCK, CGDisplay)
│   ├── capture_win.py                 # Windows screenshot capture
│   ├── change_detector.py             # SSIM-based frame change detection
│   ├── ocr.py                         # Vision OCR orchestration
│   ├── vision.py                      # OpenRouter vision provider
│   ├── ollama_vision.py               # Ollama fallback vision
│   ├── privacy.py                     # Auto-redaction + <private> tag stripping
│   ├── roi_extractor.py               # Region of interest extraction
│   ├── app_detector.py                # macOS active application detection
│   ├── app_detector_win.py            # Windows active application detection
│   ├── gate.py                        # Rate-limiting decision gate
│   ├── sender.py                      # POST to sinain-core /sense
│   ├── config.py                      # Env var loading
│   └── tests/
│       └── test_*.py                  # Unit tests
│
├── tools/
│   ├── sck-capture/
│   │   ├── main.swift                 # ScreenCaptureKit binary (audio + screen)
│   │   └── Package.swift              # Swift package manifest
│   └── win-audio-capture/             # Windows audio capture utility
│
├── sinain-hud-plugin/                 # OpenClaw plugin + knowledge graph
│   ├── index.ts                       # Plugin entry point (loaded by gateway)
│   ├── package.json                   # npm metadata + openclaw.extensions
│   ├── openclaw.plugin.json           # Plugin configuration
│   ├── sinain-memory/                 # Python knowledge graph scripts
│   │   ├── session_distiller.py       # LLM: transcript → facts/entities/decisions
│   │   ├── knowledge_integrator.py    # Deterministic: facts → triplestore
│   │   ├── triplestore.py             # SQLite EAV + FTS5 + 4 covering indexes
│   │   ├── graph_query.py             # Hybrid retrieval: FTS5 + entity graph
│   │   ├── embed_client.py            # Client for sinain-core /embed endpoint
│   │   ├── common.py                  # Shared LLM utilities + fallback chains
│   │   ├── playbook_curator.py        # Curation: facts → playbooks
│   │   ├── feedback_analyzer.py       # Feedback mining for improvement signals
│   │   ├── insight_synthesizer.py     # Generate suggestions from insights
│   │   ├── tick_evaluator.py          # Evaluate tick effectiveness
│   │   ├── eval_reporter.py           # Daily eval report generation
│   │   ├── signal_analyzer.py         # Aggregate improvement signals
│   │   ├── memory_miner.py            # Extract patterns from sessions
│   │   ├── concept_import.py          # Import concepts into graph
│   │   ├── concept_export.py          # Export concepts from graph
│   │   ├── triple_query.py            # Low-level triple queries
│   │   ├── triple_ingest.py           # Batch triple ingestion
│   │   ├── triple_extract.py          # Fact-to-triple conversion
│   │   ├── eval/                      # Evaluation harness (not in npm distribution)
│   │   │   ├── benchmarks/            # Benchmark suite
│   │   │   └── results/               # Benchmark reports
│   │   └── eval/benchmarks/           # Evaluation data and scenarios
│   ├── sinain-knowledge/              # Knowledge distillation + retrieval
│   │   ├── data/
│   │   │   ├── schema.js              # TypeScript schema + types
│   │   │   ├── store.js               # SQLite wrapper + queries
│   │   │   └── git-store.js           # Git snapshot versioning
│   │   ├── curation/
│   │   │   ├── engine.js              # Main curation orchestrator
│   │   │   ├── resilience.js          # Context overflow watchdog
│   │   │   └──*.js                   # Curation pipeline stages
│   │   └── deploy/
│   │       └── cli.ts                 # CLI commands for plugin
│   ├── sinain-mcp-server/             # MCP server (Claude tool integration)
│   │   ├── index.ts
│   │   └── package.json
│   └── HEARTBEAT.md                   # Auto-deployed agent heartbeat
│
├── sinain-agent/                      # Bare-agent CLI interface
│   ├── run.sh                         # Agent runner script
│   ├── agents.example.json            # Agent configuration example
│   ├── mcp-config.json                # MCP server configuration
│   ├── openrouter-proxy.mjs           # OpenRouter API wrapper
│   ├── hooks/
│   │   └── approve-tool.sh            # Tool approval hook
│   └── CLAUDE.md                      # Bare-agent documentation
│
├── sinain-mcp-server/                 # MCP server for Claude
│   ├── index.ts
│   └── package.json
│
├── sinain-mobile/                     # Mobile app (under development)
│   ├── ios/
│   └── android/
│
├── sinain-wearable-hud/               # Wearable HUD (under development)
│
├── docs/                              # Documentation
│   ├── CONFIGURATION.md               # Env vars reference
│   ├── CONTRIBUTING.md
│   └── *.md                           # Other guides
│
├── skills/                            # GSD skills directory
│   └── sinain-hud/                    # Plugin skills
│       ├── SKILL.md
│       └── HEARTBEAT.md
│
├── .planning/
│   └── codebase/                      # Architecture documentation (written by gsd-map-codebase)
│       ├── ARCHITECTURE.md
│       ├── STRUCTURE.md
│       ├── CONVENTIONS.md
│       ├── TESTING.md
│       ├── CONCERNS.md
│       ├── STACK.md
│       └── INTEGRATIONS.md
│
├── start.sh                           # Launch all services (core + sense + overlay)
├── start-local.sh                     # Local development launcher
├── setup-local.sh                     # Local environment setup
├── setup-remote.sh                    # Remote deployment setup
├── setup-nemoclaw.sh                  # NemoClaw-specific setup
├── setup-windows.sh                   # Windows setup
├── .env.example                       # Env var template
├── package.json                       # Root npm config (minimal)
├── package-lock.json
├── CLAUDE.md                          # Project guidance
├── README.md                          # Project overview
├── AGENTS.md                          # Agent configuration guide
├── LICENSE
└── .gitignore
```

## Directory Purposes

**sinain-core/**
- Purpose: Central hub for context analysis, escalation routing, and knowledge integration
- Contains: TypeScript/Node.js backend, HTTP+WebSocket server, agent loop, escalation orchestrator, ring buffers
- Key files: `src/index.ts` (entry), `src/agent/loop.ts` (debounced analysis), `src/escalation/escalator.ts` (routing)

**overlay/**
- Purpose: Private HUD display layer (invisible to screen capture)
- Contains: Flutter Dart UI (Eye/Controls/Chat states), native Swift/C++ window control, WebSocket client, settings persistence
- Key files: `lib/main.dart` (entry), `lib/ui/overlay_shell.dart` (3-state shell), `macos/Runner/MainFlutterWindow.swift` (NSPanel)

**sense_client/**
- Purpose: Screen capture and vision-based change detection
- Contains: ScreenCaptureKit polling, SSIM change detection, OpenRouter/Ollama vision OCR, privacy masking
- Key files: `__main__.py` (entry), `capture.py` (frame polling), `vision.py` (OCR provider)

**tools/sck-capture/**
- Purpose: Unified audio and screen capture via ScreenCaptureKit
- Contains: Swift binary, ScreenCaptureKit stream handler, PCM output to stdout, JPEG IPC writes
- Key files: `main.swift` (single-file binary)

**sinain-hud-plugin/**
- Purpose: OpenClaw gateway integration and knowledge graph persistence
- Contains: Plugin lifecycle hooks, knowledge curation pipeline (Python scripts), SQLite triplestore, entity graph
- Key files: `index.ts` (plugin entry), `sinain-memory/session_distiller.py` (LLM extraction), `sinain-memory/triplestore.py` (EAV store)

**sinain-agent/**
- Purpose: Bare-agent CLI wrapper for non-gateway deployments
- Contains: Agent runner script, MCP server config, tool approval hooks
- Key files: `run.sh` (launcher)

**docs/**
- Purpose: User and developer documentation
- Contains: Configuration guide, contribution guidelines, architecture notes
- Key files: `CONFIGURATION.md` (env var reference)

**skills/**
- Purpose: GSD skill definitions (auto-deployed by gateway plugin)
- Contains: SKILL.md (tool definitions), HEARTBEAT.md (agent heartbeat messages)

**.planning/codebase/**
- Purpose: GSD codebase analysis (written by `/gsd-map-codebase` command)
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md, STACK.md, INTEGRATIONS.md

## Key File Locations

**Entry Points:**
- `sinain-core/src/index.ts` — Node.js main; loads config, wires services, starts HTTP+WS server
- `overlay/lib/main.dart` — Flutter app main; initializes native window, WebSocket client
- `sense_client/__main__.py` — Python screen capture main; polls IPC JPEG, POSTs OCR to sinain-core
- `tools/sck-capture/main.swift` — ScreenCaptureKit binary; outputs PCM to stdout, JPEG to IPC
- `sinain-hud-plugin/index.ts` — OpenClaw plugin main; auto-deploys HEARTBEAT.md, manages curation

**Configuration:**
- `sinain-core/src/config.ts` — All env var loading and validation
- `.env.example` — Template for all configuration
- `overlay/lib/core/services/settings_service.dart` — Persisted settings (SharedPreferences)
- `sinain-agent/agents.example.json` — Agent configuration example

**Core Logic:**
- `sinain-core/src/agent/loop.ts` — Debounced event-driven agent loop (3s debounce, 30s max, 10s cooldown)
- `sinain-core/src/buffers/feed-buffer.ts` — Ring buffer for feed items with onFull callbacks
- `sinain-core/src/escalation/escalator.ts` — Escalation routing and message delivery
- `sinain-core/src/learning/local-curation.ts` — Incremental distillation + shutdown flush
- `sinain-hud-plugin/sinain-memory/knowledge_integrator.py` — Deterministic fact → triplestore conversion

**Testing:**
- `sinain-core/eval/harness.ts` — Evaluation framework runner
- `sinain-core/eval/scenarios/` — JSONL test scenarios
- `overlay/test/` — Flutter widget tests
- `sense_client/tests/` — Python unit tests
- `sinain-hud-plugin/sinain-memory/eval/benchmarks/` — Knowledge graph benchmarks

**Utilities:**
- `sinain-core/src/log.ts` — Tagged logging
- `sinain-core/src/util/dedup.ts` — Transcript deduplication
- `sinain-core/src/util/task-store.ts` — Pending escalation persistence
- `sense_client/privacy.py` — Privacy masking and auto-redaction
- `sinain-hud-plugin/sinain-knowledge/data/store.js` — SQLite wrapper

## Naming Conventions

**Files:**
- TypeScript/JavaScript: `camelCase.ts`, `camelCase.js` (e.g., `agent-loop.ts`, `context-window.ts`)
- Dart: `snake_case.dart` (e.g., `websocket_service.dart`, `hud_shell.dart`)
- Python: `snake_case.py` (e.g., `session_distiller.py`, `triplestore.py`)
- Swift: `PascalCase.swift` (e.g., `MainFlutterWindow.swift`, `AppDelegate.swift`, `WindowControlPlugin.swift`)
- C++: `snake_case.cpp` (e.g., `window_control_plugin.cpp`, `hotkey_handler.cpp`)

**Directories:**
- Feature areas (lowercase, hyphenated): `agent/`, `escalation/`, `learning/`, `buffers/`, `embedding/`
- Package modules (PascalCase): `Runner/`, `Sources/`
- Test directories: `tests/`, `test/`, `eval/` (with `scenarios/`, `results/`, `benchmarks/` subdirs)

**Type/Class Names:**
- TypeScript: `PascalCase` (e.g., `AgentLoop`, `FeedBuffer`, `Escalator`)
- Dart: `PascalCase` (e.g., `OverlayShell`, `WebSocketService`, `HudSettings`)
- Python: `PascalCase` (e.g., `SessionDistiller`, `KnowledgeIntegrator`, `TripleStore`)
- Swift: `PascalCase` (e.g., `MainFlutterWindow`, `WindowControlPlugin`)

**Functions/Methods:**
- TypeScript: `camelCase()` (e.g., `buildContextWindow()`, `calculateEscalationScore()`)
- Dart: `camelCase()` (e.g., `setTransparent()`, `makeKeyWindow()`)
- Python: `snake_case()` (e.g., `session_distiller()`, `apply_privacy()`)
- Swift: `camelCase()` (e.g., `awakeFromNib()`, `configureWindow()`)

**Constants:**
- TypeScript: `SCREAMING_SNAKE_CASE` (e.g., `PREALLOC_BUFFER_SIZE`, `STALE_ID_GRACE_MS`)
- Dart: `camelCase` (constants are not screaming in Dart convention; e.g., `wsUrl`, `accentColor`)
- Python: `SCREAMING_SNAKE_CASE` (e.g., `MAX_FACTS`, `CONTROL_FILE`)

## Where to Add New Code

**New Feature (end-to-end):**
- Primary code: `sinain-core/src/agent/` or `sinain-core/src/escalation/` depending on scope
- UI: `overlay/lib/ui/` + new Dart widget
- Tests: `sinain-core/eval/scenarios/` for integration; `overlay/test/` for widget tests
- Config: Add env vars to `sinain-core/src/config.ts` and `.env.example`
- Docs: Update `docs/` and inline comments

**New Component/Module:**
- If analysis-related: `sinain-core/src/agent/` or create subfolder under `src/`
- If escalation-related: `sinain-core/src/escalation/`
- If knowledge-related: `sinain-hud-plugin/sinain-memory/` (if Python) or `sinain-hud-plugin/sinain-knowledge/` (if TypeScript)
- If UI-related: `overlay/lib/ui/` with Dart widget
- If capture-related: `sense_client/` (Python) or `tools/sck-capture/` (Swift)

**Utilities/Helpers:**
- Shared helpers: `sinain-core/src/util/` (TS) or `sense_client/` module root (Python)
- Type definitions: `sinain-core/src/types.ts` (shared TS interfaces)
- Logging: Use existing `sinain-core/src/log.ts` functions (don't create new log files)

**Tests:**
- Unit tests: Co-located with source or in `*/test*/` or `*/eval/` directories
- Integration tests: `sinain-core/eval/scenarios/` (JSONL format)
- Widget tests: `overlay/test/`
- Benchmarks: `sinain-hud-plugin/sinain-memory/eval/benchmarks/`

**Configuration & Secrets:**
- Env vars: Declare in `sinain-core/src/config.ts` and add to `.env.example`
- Settings UI: `overlay/lib/ui/settings/display_settings_panel.dart` or create new settings panel
- Secrets: Use `.env` (git-ignored) or environment variables, never commit inline credentials

## Special Directories

**dist/ (sinain-core)**
- Purpose: Compiled TypeScript output
- Generated: Yes (by `npm run build`)
- Committed: No (git-ignored)
- When to update: Run `npm run build` before deployment

**build/ (overlay)**
- Purpose: Flutter build artifacts
- Generated: Yes (by `flutter build`)
- Committed: No (git-ignored)
- When to update: Run `flutter build macos/windows` for release

**node_modules/**
- Purpose: npm dependencies
- Generated: Yes (by `npm install`)
- Committed: No (git-ignored, use package-lock.json)

**eval/reports/ (sinain-core)**
- Purpose: Evaluation results from `npm run eval`
- Generated: Yes (by evaluation harness)
- Committed: No (git-ignored)
- When to update: Run `npm run eval` to generate new reports

**eval/benchmarks/results/ (sinain-memory)**
- Purpose: Benchmark results from knowledge graph evaluation
- Generated: Yes (by benchmark runner)
- Committed: No (git-ignored)
- When to update: Run benchmark suite to generate new results

**.pytest_cache/**
- Purpose: Python test cache
- Generated: Yes (by pytest)
- Committed: No (git-ignored)

**~/.sinain/memory/**
- Purpose: Local knowledge graph (SQLite database + associated files)
- Generated: Yes (at runtime by LocalCurationService)
- Committed: No (user directory, not in repo)
- Default path: `~/.sinain/memory/knowledge-graph.db`

**~/.openclaw/workspace/**
- Purpose: OpenClaw workspace (shared with gateway plugin if deployed)
- Generated: Yes (at runtime by both sinain-core and gateway)
- Committed: No (user directory, not in repo)
- Key file: `SITUATION.md` (atomic writes for safe concurrent access)

---

*Structure analysis: 2026-05-08*
