# Technology Stack

**Analysis Date:** 2026-05-08

## Languages

**Primary:**
- **TypeScript** 5.9.3 — Node.js backend (sinain-core), ESM modules (`"type": "module"`)
- **Dart** >=3.2.0 — Flutter overlay UI (macOS + Windows)
- **Python** 3.11+ — Screen capture pipeline (sense_client), knowledge distillation (sinain-memory)
- **Swift** — macOS native plugins, ScreenCaptureKit audio/video capture (`tools/sck-capture/`)

**Secondary:**
- **C++** — Windows overlay platform channels (window control, hotkey handling)
- **Bash/Shell** — System orchestration (`start.sh`, CI/CD)

## Runtime

**Environment:**
- **Node.js** 22 (CI via GitHub Actions `ubuntu-latest`)
- **Python** 3.9+ (sense_client, sinain-memory evaluation)
- **macOS** 11.0+ (overlay deployment target)
- **Windows** 10 2004+ (WDA_EXCLUDEFROMCAPTURE API requirement)

**Package Manager:**
- **npm** (Node packages) — with `package-lock.json` versioning
- **pip/pip3** (Python) — requirements.txt per module
- **pub** (Dart/Flutter) — `pubspec.yaml` with locked dependency versions

## Frameworks

**Core:**
- **Node.js HTTP** (node:http) — sinain-core HTTP server on port 9500
- **WebSocket** (ws 8.18.0) — two-way overlay ↔ core communication
- **Flutter** 3.27.x (stable) — Cross-platform overlay rendering (macOS/Windows)
- **ScreenCaptureKit** (Swift, macOS 13+) — Zero-copy video + audio capture via SCStream

**Analysis & LLM:**
- **OpenRouter API** — Primary LLM provider (Gemini Flash Lite default, fallback chain)
- **Ollama** — Optional local LLM provider (http://localhost:11434), compatible with OpenAI endpoint
- **@huggingface/transformers** 4.0.1 — In-process sentence embeddings (Xenova/all-MiniLM-L6-v2, 384 dims, ONNX)

**Testing & Dev:**
- **tsx** 4.21.0 — TypeScript executor + watch mode
- **Flutter Test** — Widget test suite (run via `flutter test`)
- **LLM-as-Judge** — Evaluation harness in `sinain-core/eval/` (3-run default, JSONL scenarios)

## Key Dependencies

**Critical (sinain-core):**
- **ws** 8.18.0 — WebSocket server for overlay streaming
- **better-sqlite3** 11.7.0 — SQLite for web-db (bookmarks, settings)
- **@huggingface/transformers** 4.0.1 — Embedding service startup, no Python dependency
- **tsx** 4.21.0 — Development/production TypeScript runner

**Overlay (Flutter):**
- **provider** 6.1.1 — State management (services: WebSocket, Settings, Window)
- **web_socket_channel** 2.4.0 — WebSocket client for core connection
- **window_manager** 0.3.7 — Window lifecycle (macOS + Windows)
- **flutter_acrylic** 1.1.3 — Acrylic/transparency effects for overlay
- **hotkey_manager** 0.2.0 — Global hotkey binding (Cmd+Shift macOS, Ctrl+Shift Windows)
- **shared_preferences** 2.2.2 — User settings persistence

**Screen Capture (Python):**
- **pillow** >=10.0 — Image processing (JPEG encode/decode, resizing)
- **scikit-image** >=0.22 — SSIM change detection
- **numpy** >=1.24 — Numeric arrays for image processing
- **pytesseract** >=0.3 — OCR fallback (Windows WinRT OCR primary)
- **requests** >=2.31 — HTTP client for sinain-core POST /sense
- **pyobjc-framework-Quartz** >=10.0 — macOS Core Graphics (legacy CGDisplayCreateImage)
- **pyobjc-framework-Vision** >=10.0 — macOS Vision framework for OCR

**Memory/Knowledge (Python):**
- **requests** >=2.28 — HTTP client for sinain-core /embed endpoint
- **numpy** >=1.24.0 — Vector operations
- **sentence-transformers** >=2.2.0 — Embedding inference (local all-MiniLM-L6-v2)

**Windows Capture (PyObjC/WinRT):**
- **mss** >=9.0 — Screenshot capture (fallback)
- **psutil** >=5.9 — Process info
- **winrt-Windows.Media.Ocr** >=2.0 — Windows 10+ OCR API
- **winrt-Windows.Globalization** — Language support
- **winrt-Windows.Graphics.Imaging** — Image handling
- **winrt-Windows.Storage.Streams** — Async I/O
- **winrt-Windows.Foundation** — Async patterns

## Configuration

**Environment:**
- **.env file** (project root or `sinain-core/.env`)
  - Loaded by `sinain-core/src/config.ts` at startup
  - Fallback: environment variables only (CI/Docker)
- **agents.json** (`sinain-agent/agents.example.json`) — New single source of truth for agent + OpenClaw config (per-profile overrides)
- See `.env.example` for 50+ configuration variables (API keys, model selection, device config, privacy levels)

**Build:**
- **tsconfig.json** (sinain-core) — ES2022 target, strict mode, CommonJS interop disabled
- **CMakeLists.txt** (overlay/windows) — Windows native build (C++, Flutter platform channels)
- **pubspec.yaml** (overlay) — Flutter dependencies, Material Design, no font override (TTF commented out)
- **.github/workflows/ci.yml** — GitHub Actions: Node 22 TypeScript check, Flutter 3.27.x analyze + test

## Platform Requirements

**Development:**
- **macOS 11.0+** for building sinain-core (ScreenCaptureKit bindings in sck-capture)
- **Flutter SDK** >=3.10.0 for overlay (stable channel, cache via action)
- **Xcode** (macOS) — For building sck-capture and overlay native plugins
- **Visual Studio** (Windows) — For building overlay C++ plugins

**Production:**
- **macOS 11.0+** — Overlay deployment target; ScreenCaptureKit requires macOS 13+
- **Windows 10 2004+** — SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) required for invisible overlay
- **Node.js** 22+ runtime (sinain-core server)
- **Python** 3.9+ runtime (sense_client, optional local knowledge distillation)

**Optional Runtime Dependencies:**
- **sox** or **ffmpeg** — Audio capture fallback (if AUDIO_CAPTURE_CMD not screencapturekit)
- **BlackHole 2ch** — Loopback audio device for macOS audio capture
- **whisper.cpp** — Local speech-to-text (brew install whisper-cpp, if TRANSCRIPTION_BACKEND=local)
- **Ollama** — Local LLM server on http://localhost:11434 (if ANALYSIS_PROVIDER=ollama)

---

*Stack analysis: 2026-05-08*
