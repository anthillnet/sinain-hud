# Coding Conventions

**Analysis Date:** 2026-05-08

## Language-Specific Overview

This is a multi-language monorepo with distinct conventions per language:
- **TypeScript** (`sinain-core/`, `sinain-hud-plugin/`, `sinain-mcp-server/`) — ES modules, strict typing
- **Dart/Flutter** (`overlay/`) — nullable types, service-based architecture, ChangeNotifier pattern
- **Python** (`sense_client/`, `sinain-hud-plugin/sinain-memory/`) — type hints, dataclasses, logging
- **Swift** (`overlay/macos/Runner/`, `tools/sck-capture/`) — platform channels, memory safety
- **C++** (`overlay/windows/runner/`) — Windows platform, WDA exclusion

## TypeScript (sinain-core, sinain-hud-plugin, sinain-mcp-server)

### Configuration

**Compiler:**
- Target: `ES2022`
- Module: `NodeNext` (native ES modules)
- Strict mode: `true` — no implicit any, strict null checks
- ESM declaration: `"type": "module"` in `package.json`
- Config file: `tsconfig.json` in each package root

**Package Management:**
- Node 22+
- npm with `package-lock.json`
- Dependencies frozen via lock files (CI uses `npm ci`)

### Naming Patterns

**Files:**
- kebab-case for all `.ts` files: `feed-buffer.ts`, `context-window.ts`, `ws-handler.ts`
- Acronyms lowercase: `ws-handler.ts` (not `WS-Handler.ts`)
- Service/class files match class name with kebab-case: `FeedBuffer` → `feed-buffer.ts`, `Escalator` → `escalator.ts`

**Functions & Variables:**
- camelCase: `analyzeContext()`, `normalizeAppName()`, `pushFeedItem()`
- Prefer descriptive names over abbreviations: `escalationScore` not `escScore`
- Constants UPPERCASE_SNAKE_CASE: `MODEL_TIMEOUTS`, `RICHNESS_PRESETS`, `ESCALATION_THRESHOLD`
- Boolean prefixes: `isConnected`, `hasAudio`, `shouldEscalate`, `_disposed`, `_armed`
- Private properties prefix `_`: `_version`, `_onFullCb`, `_spawnAgent`

**Types & Interfaces:**
- PascalCase: `FeedMessage`, `SenseEvent`, `AgentResult`, `ContextWindow`
- Type unions: `Priority = "normal" | "high" | "urgent"`
- Interface prefix convention (none) — just use descriptive nouns: `FeedItem`, `AudioPipelineConfig`, `EscalatorDeps`
- Discriminated unions via `type` field for protocol messages: `{ type: "feed" }`, `{ type: "status" }`

### Code Style

**Formatting:**
- No ESLint/Prettier config detected in repo root — use project defaults (eslint + prettier inferred by IDE)
- Indentation: 2 spaces (evident from all source files)
- Line length: reasonable (no hard limit observed, but keep <120)
- Trailing commas: included in multiline arrays/objects

**Imports:**
1. Node.js built-ins (`import { ... } from "node:fs"`)
2. Third-party packages (alphabetical)
3. Local relative imports (alphabetical by path depth)
4. Use full `.js` extensions in ESM imports: `from "./log.js"` (required by Node.js ESM)

**Import Organization Example:**
```typescript
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AnalysisConfig, AgentResult } from "../types.js";
import { analyzeContext } from "./analyzer.js";
import { normalizeAppName } from "./context-window.js";
import { log, error } from "../log.js";
```

### Type Annotations

- Always annotate function parameters and returns: `function push(text: string, priority: Priority): FeedItem`
- Use `type` for discriminated unions and protocol types: `type OutboundMessage = FeedMessage | StatusMessage`
- Use `interface` for object shapes with methods or when extension is likely: `interface EscalatorDeps { ... }`
- Prefer `unknown` over `any` for API inputs: `input: unknown`
- Promise annotations: `Promise<string>`, `Promise<void>`
- Optional fields: `priority?: Priority` or `timestamp: number | null` (be explicit)

### Error Handling

**Pattern:**
- Use `throw new Error("message")` for synchronous errors
- Error messages start lowercase, are descriptive: `throw new Error("HTTP ${response.status}: ${body.slice(0, 200)}")`
- Check guards at entry: `if (!r.ok) throw new Error("export failed: " + r.status)`
- API response validation: always check `.ok` before reading body
- Fallback chains for LLM calls: attempt model, log, retry with fallback

**Example:**
```typescript
// From analyzer.ts
throw lastError || new Error("all models failed");

// From server.ts
if (!r.ok) throw new Error("export failed: " + r.status);

// From privacy/index.ts
if (!_privacy) throw new Error("Privacy not initialized — call initPrivacy() first");
```

### Logging

**Framework:** Built-in `console.log/warn/error` via custom wrapper `log.ts`

**Tagged logging:**
- Every module has `const TAG = "module-name"` at top
- Call signatures: `log(TAG, "message", value)`, `warn(TAG, ...)`, `error(TAG, ...)`
- Format: `[ISO-TIMESTAMP] [TAG] [icon] message value`
- Icons: debug=🐛, log=plain, warn=⚠, error=✘

**File:** `sinain-core/src/log.ts`

**Example:**
```typescript
const TAG = "agent";

export function log(tag: string, ...args: unknown[]): void {
  console.log(`[${ts()}] [${tag}]`, ...args);
}
```

**When to log:**
- Service initialization (`log(TAG, "starting...")`)
- State changes in loops (`debug(TAG, "buffer full, triggering distillation")`)
- Errors with context (`error(TAG, "transcription failed", err.message)`)
- Do NOT log every API call — too noisy
- Do log API failures and retries

### Module Design

**Exports:**
- Named exports preferred: `export class FeedBuffer { ... }`, `export interface FeedItem { ... }`
- Default exports avoided (except for entry point `index.ts`)
- Barrel files (`index.ts`) used in subdirectories to group related exports

**Example:** `sinain-core/src/types.ts` — single large types file, imported as:
```typescript
import type { FeedMessage, SenseEvent, AgentResult } from "../types.js";
```

**Modules have clear responsibilities:**
- `feed-buffer.ts` → FeedBuffer class only
- `analyzer.ts` → LLM analysis orchestration
- `escalator.ts` → Escalation decision + delivery (largest: 28KB)
- `context-window.ts` → Context assembly with richness presets

### Comments & Documentation

**JSDoc:**
- Use for public APIs and complex logic
- Format: `/** Description on one line */` or multiline with `@param`, `@returns`

**Example:**
```typescript
/**
 * Register a callback that fires when the buffer reaches capacity AND
 * at least half the buffer has been replaced with new items since the
 * last distillation. This prevents rapid-fire triggers on the same content.
 */
onFull(cb: (items: FeedItem[]) => void): void { ... }
```

**Inline comments:**
- Use `//` for clarifications on complex logic
- Prefix technical notes with `CRITICAL:`, `NOTE:`, `TODO:` (rare)

### Async Patterns

- Use `async/await` throughout (avoid Promise chaining)
- No `.then()` chains — prefer `await`
- Timeouts via `AbortSignal` or manual `Promise.race()`
- Model-specific timeouts: `MODEL_TIMEOUTS: Record<string, number>` per model

### Cross-Cutting Patterns

**Ring Buffers:** `sinain-core/src/buffers/feed-buffer.ts`, `sense-buffer.ts`
- Fixed-size circular arrays with callback on full
- Used for bounded memory (100 items feed, 30 events sense)
- Pattern: `push()`, `query(afterId)`, `onFull(cb)`, `rearmOnFull()`

**Atomic File Writes:** `sinain-core/src/agent/situation-writer.ts`
- Write to temp file, rename atomically: `writeFileSync(tmpPath)` → `renameSync(tmp, target)`
- Prevents partial reads during write

**Event-Driven Debounced Loops:** `sinain-core/src/agent/loop.ts`
- Agent loop debounced on new context (3s delay, max 30s)
- Fires when feed or sense buffer has new content, not on fixed timer

**Two-Output LLM JSON:** `analyzer.ts` output format
```typescript
{"hud":"...","digest":"...","record":{"command":"start"|"stop"}}
```
- `hud`: max 60 words for overlay display
- `digest`: 5-8 sentences for escalation context
- `record`: optional recording control command

**Privacy Tagging:** `sinain-core/src/privacy/`
- Client-side `<private>` tag stripping in OCR results
- Auto-redaction: credit cards, API keys, bearer tokens, AWS keys, passwords
- Server-side stripping in OpenClaw plugin

**Fallback Model Chains:**
```typescript
const MODEL_TIMEOUTS: Record<string, number> = {
  'google/gemini-2.5-flash': 15000,
  'anthropic/claude-3.5-sonnet': 30000,
  // ...
};
throw lastError || new Error("all models failed");
```

---

## Dart/Flutter (overlay)

### Configuration

**Analysis:**
- `analysis_options.yaml`: includes `package:flutter_lints/flutter.yaml`
- `flutter analyze` enforced in CI

**Deployment Target:**
- macOS 11.0 minimum

### Naming Patterns

**Files:**
- snake_case: `feed_item.dart`, `websocket_service.dart`, `window_service.dart`
- Pluralize for collections: `models/`, `services/`, `ui/`

**Classes & Types:**
- PascalCase: `FeedItem`, `WebSocketService`, `WindowService`, `HudSettings`
- Enums: `FeedPriority`, `FeedChannel`, `FeedSender`, `HudState`, `HudTab`

**Functions & Variables:**
- camelCase: `connect()`, `reconnect()`, `updateFeedItem()`, `nextTab`
- Boolean getters: `bool get connected => _connected`
- Private fields: underscore prefix `_channel`, `_connected`, `_disposed`

**Constants:**
- camelCase in class scope: `defaultChatWidth`, `defaultChatHeight`, `margin`
- SCREAMING_SNAKE_CASE only for compile-time constants

### Code Style

**Formatting:**
- `flutter analyze` enforces style
- Indentation: 2 spaces
- Use `const` for immutable values
- Null-safety: `int?`, `String?` explicit, not `int`

**Imports:**
1. Dart built-ins: `import 'dart:async'`, `import 'dart:convert'`
2. Flutter: `import 'package:flutter/..."`
3. Third-party packages: alphabetical
4. Relative imports: `import '../models/feed_item.dart'`

**Example:**
```dart
import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/feed_item.dart';
import '../models/spawn_task.dart';
```

### Type Annotations

- Always annotate function signatures: `Future<void> connect()`
- Nullable types explicit: `String?`, `DateTime?`
- Use `required` for mandatory named parameters: `required this.id`
- Factory constructors for parsing: `factory FeedItem.fromJson(Map<String, dynamic> json)`
- Type parameters: `Stream<FeedItem>`, `Map<String, SpawnTask>`

### Service Architecture

**Pattern:** Services extend `ChangeNotifier` for reactive updates

**WebSocketService example (`websocket_service.dart`):**
- Wraps WebSocket connection with auto-reconnect and exponential backoff
- Exposes multiple broadcast streams: `feedStream`, `statusStream`, `spawnTaskStream`
- Maintains canonical state: `_spawnTasks: Map<String, SpawnTask>`
- Getters for state: `bool get connected`, `String get audioState`
- Timers for profiling and reconnect: `_reconnectTimer`, `_profilingTimer`

**WindowService example (`window_service.dart`):**
- Platform channel to native Swift code: `sinain_hud/window`
- Methods: `setVisible()`, `bringToFront()`, `setSize()`
- Calls Swift `WindowControlPlugin.swift` via MethodChannel

### Widget Conventions

- StatelessWidget for pure UI
- StatefulWidget for local state only (prefer providers for global state)
- Build methods avoid deep nesting (extract to private `_buildXyz()` helpers)

### Enum Patterns

```dart
enum FeedPriority { normal, high, urgent }
enum FeedChannel { stream, agent }
enum FeedSender { agent, user, spawn }

class FeedItem {
  final FeedPriority priority;
  final FeedChannel channel;
  
  static FeedPriority _parsePriority(String? value) {
    switch (value) {
      case 'high': return FeedPriority.high;
      case 'urgent': return FeedPriority.urgent;
      default: return FeedPriority.normal;
    }
  }
}
```

### Comments & Documentation

- Use `///` for public documentation: `/// Creates a new FeedItem from JSON.`
- Use `//` for inline clarifications
- No docstring bloat — self-documenting code preferred

### Error Handling

- Use try/catch for network operations in services
- Emit errors via streams: `_errorController.add(error)`
- Log errors to stderr for debugging

---

## Python (sense_client, sinain-memory)

### Configuration

**Type Hints:**
- Full `from __future__ import annotations` at top (enables string forward refs)
- All function parameters and returns type-hinted: `def extract(self, image: Image.Image) -> OCRResult:`
- Use `str | Path` for overloaded types (Python 3.10+)

**Formatter:**
- No black/ruff config found — inferred Python 3.10+ idioms

### Naming Patterns

**Files:**
- snake_case: `capture.py`, `ocr.py`, `change_detector.py`, `privacy.py`
- Test files: `test_*.py` or `*_test.py` (none found in codebase)

**Classes & Types:**
- PascalCase: `ScreenCapture`, `LocalOCR`, `OCRResult`, `TripleStore`
- Dataclasses: `@dataclass class OCRResult: ...`

**Functions & Variables:**
- snake_case: `capture_frame()`, `capture_loop()`, `extract()`, `decayed_confidence()`
- Private functions: `_parse_priority()`, `_now_iso()`, `_entity_type()`
- Constants: SCREAMING_SNAKE_CASE: `MAX_FACTS_PER_QUERY`, `JUDGE_MODEL`, `DISTILLER_TIMEOUT_S`

**Database columns:**
- snake_case in SQL: `entity_id`, `attribute`, `value_type`, `created_at`
- Prefix patterns: `fact:*` for facts, `entity:*` for real-world entities, `signal:*` for observations

### Code Style

**Docstrings:**
- Use triple-quote docstrings for classes and public functions
- Format: one-line summary, then blank line, then description

**Example:**
```python
class ScreenCapture:
    """Captures screen frames via CGDisplayCreateImage (CoreGraphics/IOSurface).

    Uses Quartz CGDisplayCreateImage instead of the screencapture CLI.
    This avoids CoreMediaIO/ScreenCaptureKit, which blocks camera access
    for other apps (e.g. Google Meet) on macOS 14+.
    """
```

**Imports:**
1. `from __future__ import annotations` (if needed)
2. Built-ins: `import json`, `import sys`, `import time`
3. Third-party: `from PIL import Image`
4. Local: `from .ocr import LocalOCR`

**Type Annotations:**
- Use `->` for return types: `def capture_frame(self) -> tuple[Image.Image, float]:`
- Optional: `str | None` or `int | None`
- Use `Generator[Tuple[X, Y], None, None]` for generators
- Dataclass fields: `enabled: bool = True`

### Dataclasses

**Pattern:**
```python
@dataclass
class OCRResult:
    text: str
    confidence: float
    word_count: int
```

**Used extensively in:**
- `sinain-memory/triplestore.py` — no formal dataclasses (manual dicts), but SQL-backed
- `sense_client/ocr.py` — `@dataclass OCRResult`
- `sense_client/capture.py` — no dataclasses (class-based with `__init__`)

### Error Handling

**Pattern:**
- Specific exceptions: `raise RuntimeError("CGDisplayCreateImage returned None")`
- Broad catches for graceful degradation: `except Exception as e:`
- Re-raise with context when needed

**Example:**
```python
try:
    cg_image = Quartz.CGDisplayCreateImage(self._display_id)
    if cg_image is None:
        self.stats_fail += 1
        raise RuntimeError("CGDisplayCreateImage returned None")
finally:
    del cg_image
```

### Logging

**Framework:** Built-in `logging` module or `print()` to stderr

**Pattern:** Simple print-to-stderr for operational logs
```python
print(f"[{time.time()}] Starting capture loop", file=sys.stderr)
```

**No centralized logger detected** — each module logs independently.

### Module Organization

**sense_client:**
- `__main__.py` — entry point, orchestrates capture + OCR + gateway POST
- `capture.py` — ScreenCapture/ScreenKitCapture/SCKCapture (platform-specific)
- `ocr.py` — LocalOCR and Vision backends
- `privacy.py` — `<private>` tag stripping and auto-redaction
- `change_detector.py` — SSIM-based frame change detection
- `config.py` — configuration loading

**sinain-memory:**
- `session_distiller.py` — LLM-based fact extraction
- `knowledge_integrator.py` — Deterministic graph integration (no LLM)
- `triplestore.py` — SQLite EAV store (4 covering indexes, FTS5)
- `graph_query.py` — Hybrid retrieval (RRF fusion)
- `embed_client.py` — Calls `/embed` endpoint for semantic dedup

---

## Swift (overlay/macos/Runner, tools/sck-capture/Sources)

### Naming Patterns

**Files:**
- PascalCase: `AppDelegate.swift`, `MainFlutterWindow.swift`, `WindowControlPlugin.swift`, `HotKeyHandler.swift`
- One class per file (convention)

**Classes & Functions:**
- PascalCase: `AppDelegate`, `WindowControlPlugin`, `HotKeyHandler`
- Functions: camelCase: `configureWindow()`, `registerHotkeys()`
- Private functions: `private func configureWindow()`

### Code Style

**Formatting:**
- Indentation: 2-4 spaces (consistent with source)
- Nil safety: Use `guard let`, `if let` for optionals
- Early returns to avoid nesting

**Example:**
```swift
private func configureWindow() {
    guard let window = mainFlutterWindow else { return }
    
    // Setup window properties
    window.styleMask = [.borderless, .fullSizeContentView]
}
```

### Key Conventions (overlay/macos)

**AppDelegate:**
- Hotkey registration in `applicationDidFinishLaunching`
- Hotkey event handler via FlutterMethodChannel `sinain_hud/hotkeys`
- Window configuration in `configureWindow()` private method

**MainFlutterWindow:**
- NSPanel subclass (not NSWindow)
- `sharingType = .none` for privacy (invisible to screen capture)
- Collection behaviors: `canJoinAllSpaces`, `stationary`, `ignoresCycle`
- Non-activating (`styleMask.insert(.nonactivatingPanel)`) to avoid stealing focus

**Platform Channels:**
- Channel names: `sinain_hud/window`, `sinain_hud/hotkeys`
- Registers in AppDelegate during Flutter init
- Dart calls Swift via MethodChannel

---

## C++ (overlay/windows/runner)

### Naming Patterns

**Files:**
- snake_case: `window_control_plugin.cpp`, `hotkey_handler.cpp`

**Classes & Functions:**
- PascalCase for classes: `WindowControlPlugin`, `HotKeyHandler`
- snake_case for functions: `register_hotkey()`, `set_visible()`

### Windows Conventions

**Window Privacy:**
- `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Windows 10 2004+
- Makes window invisible to screen capture/recording

**Hotkeys:**
- `Ctrl+Shift` bindings (not `Cmd+Shift` like macOS)
- Platform channel `sinain_hud/window`, `sinain_hud/hotkeys`

---

## Commit Message Convention

**Format:** Semantic commits with scope

**Pattern:** `{type}({scope}): {description}`

**Types:**
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — dependency bumps, release tags, tooling
- `docs:` — documentation-only changes
- `refactor:` — code restructuring (no feature/bug change)

**Scopes:** `overlay`, `core`, `memory`, `knowledge-ui`, `onboard` (short identifiers)

**Examples:**
```
feat(overlay): add knowledge browser button in Controls + Chat header
fix(overlay): wsUrl→httpUrl conversion was a literal $1, not a backreference
chore: bump @geravant/sinain to 1.23.0
fix(core): gate OpenClaw WS lifecycle + SITUATION.md write on lane selection
feat: combined entity recall — AND logic, semantic expansion, topic page
```

**Description:**
- Lowercase start
- Imperative mood: "add feature" not "added feature"
- Reference issue numbers if applicable: `fix(core): #123 — gate OpenClaw...`

---

## Architecture Patterns (Cross-Language)

### Ring Buffers

**What it is:** Fixed-size circular array with event callback when full

**Used in:**
- `sinain-core/src/buffers/feed-buffer.ts` (100 items max)
- `sinain-core/src/buffers/sense-buffer.ts` (30 events max)

**Pattern:**
```typescript
class FeedBuffer {
  push(text: string, priority: Priority): FeedItem { ... }
  onFull(cb: (items: FeedItem[]) => void): void { ... }
  rearmOnFull(): void { ... }
  query(afterId: number): FeedItem[] { ... }
}
```

**Why:** Bounded memory for long-running processes. Callback fires when buffer capacity reached AND significant new items added (prevents hammer-on-same-content).

### Atomic File Writes

**Pattern:** Write to temp, rename atomically

**Used in:**
- `sinain-core/src/agent/situation-writer.ts` — SITUATION.md updates

**Code:**
```typescript
writeFileSync(tmpPath, content);
renameSync(tmp, targetPath); // Atomic on POSIX, pseudo-atomic on Windows
```

**Why:** Multiple readers (OpenClaw plugin) can read file safely without partial updates.

### Event-Driven Debounced Loops

**Pattern:** Loop debounced on new data, not fixed timer

**Used in:**
- `sinain-core/src/agent/loop.ts` — 3s debounce, max 30s

**Why:** Responds to data arrival (audio transcript, OCR) immediately after debounce, not on clock. Reduces latency vs polling.

### Two-Output LLM JSON

**Format:**
```json
{
  "hud": "max 60 words for overlay display",
  "digest": "5-8 sentences for escalation context",
  "record": {"command": "start|stop", "label": "optional"}
}
```

**Used in:**
- `sinain-core/src/agent/analyzer.ts` — system prompt defines format

**Why:** Splits short UI text (hud) from rich context (digest) in single LLM call. Recording control optional.

### Privacy Tagging

**Pattern:** `<private>` tags in OCR, auto-redaction regex

**Used in:**
- `sinain-core/src/privacy/` — client-side stripping
- `sense_client/privacy.py` — redaction patterns
- OpenClaw plugin — server-side stripping

**Auto-redacts:**
- Credit cards (16-digit patterns)
- API keys (sk-* patterns, AKIA-*)
- Bearer tokens (Bearer *)
- Passwords (pass=*, password=*)

### Fallback Model Chains

**Pattern:** Try primary model, log failure, retry with fallback

**Used in:**
- `sinain-core/src/agent/analyzer.ts` — `MODEL_TIMEOUTS` dict

**Code:**
```typescript
const MODEL_TIMEOUTS: Record<string, number> = {
  'anthropic/claude-3.5-sonnet': 30000,
  'default': 15000,
};
```

Retries with fallback if timeout or API error.

### Embedding Service

**Pattern:** In-process sentence embeddings (all-MiniLM-L6-v2, 384 dims)

**Used in:**
- `sinain-core/src/embedding/service.ts` — `/embed` POST endpoint

**Why:** Semantic dedup on write path, retrieval re-ranking on read path. No external API call.

### Deterministic Integration

**Pattern:** Distiller (LLM) extracts facts, integrator (code) stores them deterministically

**Used in:**
- `sinain-memory/session_distiller.py` — LLM extraction
- `sinain-memory/knowledge_integrator.py` — Deterministic graph ops

**Why:** Eliminates variance in graph storage. Same facts always map to same edges/properties.

---

*Convention analysis: 2026-05-08*
