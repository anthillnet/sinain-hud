# Plan: Extract `sinain-protocol` Shared Core + Three Thin Clients

## Context

Three projects independently implement the same pipeline: capture input → analyze via cloud vision → build observation → send via OpenClaw WebSocket RPC → display response. The gateway protocol, observation format, circuit breaker, error patterns, and vision API integration are duplicated across all three:

| Project | Language | Platform | Location | Lines |
|---------|----------|----------|----------|-------|
| **sinain-core** | TypeScript (Node.js) | macOS desktop | `sinain-hud/sinain-core/` | ~3500 |
| **sinain-wearable-hud** | Python (asyncio) | Raspberry Pi Zero 2W | `sinain-hud/sinain-wearable-hud/` | ~2600 |
| **ISinain** | TypeScript (React Native) + Swift | iOS (Ray-Ban Meta glasses) | `/IdeaProjects/ISinain/` | ~1900 |

**Goal:** Extract shared logic into `sinain-protocol` (TypeScript) + `sinain-protocol-python` (conformant port), then make each project a thin client that only contains platform-specific I/O.

## Architecture

```
sinain-hud/
  packages/
    sinain-protocol/             ← NEW: shared TS core (npm workspace)
    sinain-protocol-python/      ← NEW: conformant Python port for Pi
  sinain-core/                   ← EXISTING: macOS thin client
  sinain-wearable-hud/           ← EXISTING: Pi thin client

/IdeaProjects/ISinain/           ← EXISTING (separate repo): iOS thin client
                                    consumes sinain-protocol via npm tarball
```

### What goes into the shared core vs what stays in clients

**`sinain-protocol` (shared):**
| Module | Extracted From | Lines (approx) |
|--------|---------------|-----------------|
| `gateway/openclaw-ws.ts` | All 3 gateway impls | ~300 |
| `gateway/circuit-breaker.ts` | Embedded in gateways | ~60 |
| `vision/openrouter-client.ts` | `visionApi.ts` / `ocr.py` / `analyzer.ts` | ~130 |
| `vision/response-parser.ts` | Parsing logic in all 3 | ~30 |
| `vision/prompts.ts` | Classification-aware prompt templates | ~50 |
| `observation/buffer.ts` | `observationBuilder.ts` / `observation.py` | ~50 |
| `observation/message-builder.ts` | All 3 observation builders | ~120 |
| `observation/error-patterns.ts` | Duplicated constant lists | ~30 |
| `sampling/frame-sampler.ts` | `frameSampler.ts` / `sender.py` | ~40 |
| `protocol/constants.ts` | Duplicated magic numbers | ~30 |
| `protocol/wire-types.ts` | Implicit in all 3 | ~40 |

**Stays in clients (platform-specific):**
| sinain-core (macOS) | sinain-wearable-hud (Pi) | ISinain (iOS) |
|---------------------|--------------------------|---------------|
| Audio pipeline (sox/ffmpeg) | Camera (picamera2/cv2) | MWDAT SDK (Swift bridge) |
| Screen capture + on-device OCR (sense_client) | Scene gate (SSIM/motion/MSER) | React Native UI |
| Flutter overlay (WS server) | ROI cropper (OpenCV) | RN state hooks |
| Escalation scoring engine | OLED display (luma.oled SPI) | - |
| Spawn task dispatch | Audio (sounddevice + VAD) | - |
| Agent loop (debounce/cooldown) | Debug web server | - |
| Learning/feedback system | - | - |
| Recorder, profiler, tracer | - | - |

**Note:** All three clients call OpenRouter (Gemini Flash) for vision analysis. macOS also has on-device OCR via sense_client. The shared `vision/` module covers the OpenRouter call + response parsing; image encoding/preprocessing stays platform-specific.

### Key design decisions

**1. WebSocket injection** — The core accepts `WebSocketImpl?` constructor param. Node.js passes `ws`, React Native uses global `WebSocket`. No platform imports inside the core.

**2. Fetch injection** — Vision API accepts optional `fetchImpl` for environments where global `fetch` differs.

**3. Callbacks over EventEmitter** — Gateway uses callback interface (`onStatusChange`, `onResponse`, `onRpcStatus`) instead of Node.js `EventEmitter` for React Native compatibility.

**4. Python is a port, not a wrapper** — The Pi Zero 2W has only 512MB RAM; running Node.js as a sidecar adds ~50MB overhead. The Python port is ~400 lines of gateway + observation, maintained in sync via shared JSON test fixtures.

**5. Message builder is configurable** — Each client passes display constraints and header prefix; the core builds the markdown. Custom `getInstructions` override for platform-specific instruction logic.

## Core Module API Surface

### Gateway
```typescript
// gateway/openclaw-ws.ts
export class OpenClawGateway {
  constructor(config: GatewayConfig, callbacks: GatewayCallbacks, options?: {
    WebSocketImpl?: typeof WebSocket;
  });
  get isConnected(): boolean;
  get isCircuitOpen(): boolean;
  start(): void;
  close(): void;
  sendAgentRpc(message: string, idempotencyKey: string): Promise<RpcResult>;
  sendRpc(method: string, params: Record<string, unknown>, timeoutMs?: number,
          opts?: { expectFinal?: boolean }): Promise<any>;
}
```

### Vision
```typescript
// vision/openrouter-client.ts
export async function analyzeFrame(
  base64Jpeg: string, config: VisionConfig,
  options?: { prompt?: string; detail?: 'low' | 'auto'; fetchImpl?: typeof fetch }
): Promise<VisionResult>;

// vision/response-parser.ts
export function parseVisionResponse(raw: string): { description: string; ocrText: string };

// vision/prompts.ts — classification-aware prompt templates
export type FrameClassification = 'scene' | 'text' | 'motion' | 'ambient' | 'generic';
export function getVisionPrompt(classification: FrameClassification): string;
```

All three clients use OpenRouter (Gemini Flash) for vision analysis. The classification parameter lets the Pi's scene gate and macOS's sense_client choose the right prompt for the frame type, while iOS defaults to `'generic'`.

### Observation
```typescript
// observation/buffer.ts
export class ObservationBuffer {
  constructor(config: BufferConfig);
  add(description: string, ocrText: string, metadata?: Record<string, unknown>): void;
  get tick(): number;
  get recent(): ObservationEntry[];
}

// observation/message-builder.ts
export function buildObservationMessage(
  description: string, ocrText: string, buffer: ObservationBuffer,
  config: MessageBuilderConfig
): string;
```

### Types (exported)
```typescript
interface GatewayConfig { wsUrl: string; token: string; sessionKey: string; clientId?: string; clientDisplayName?: string; clientPlatform?: string; }
interface GatewayCallbacks { onStatusChange: (status: GatewayStatus) => void; onResponse?: (text: string) => void; onRpcStatus?: (status: RpcStatus) => void; }
interface RpcResult { ok: boolean; responseText: string | null; rawPayload: any; runId?: string; }
interface VisionConfig { apiKey: string; model: string; timeoutMs: number; }
interface VisionResult { description: string; ocrText: string; latencyMs: number; }
interface BufferConfig { maxEntries: number; maxAgeS: number; }
interface MessageBuilderConfig { headerPrefix: string; displayConstraint: string; displayNote: string; getInstructions?: (description: string, ocrText: string) => string; }
```

## Migration Phases

### Phase 1: Scaffold + constants + types (no behavioral changes)

Create the package, extract shared constants and types. Wire up npm workspace. No client changes.

**Create:**
- `sinain-hud/package.json` — workspace root: `{ "private": true, "workspaces": ["packages/*", "sinain-core"] }`
- `packages/sinain-protocol/package.json` — `{ "name": "sinain-protocol", "type": "module", "main": "dist/index.js", "types": "dist/index.d.ts" }`
- `packages/sinain-protocol/tsconfig.json`
- `packages/sinain-protocol/src/protocol/constants.ts` — all shared magic numbers
- `packages/sinain-protocol/src/protocol/wire-types.ts` — WS req/res/event frame shapes
- `packages/sinain-protocol/src/observation/error-patterns.ts` — `ERROR_PATTERNS` + `hasErrorPattern()`
- `packages/sinain-protocol/src/observation/types.ts`
- `packages/sinain-protocol/src/vision/types.ts`
- `packages/sinain-protocol/src/gateway/types.ts`
- `packages/sinain-protocol/src/index.ts` — barrel export

**Modify:**
- `sinain-core/package.json` — add `"sinain-protocol": "workspace:*"` dep
- `sinain-core/src/escalation/scorer.ts` — import `ERROR_PATTERNS` from `sinain-protocol`
- `sinain-core/src/escalation/message-builder.ts` — import `ERROR_PATTERNS` from `sinain-protocol`

**Verify:** `npm install` at root, `npm run build` in sinain-protocol, sinain-core still runs normally.

### Phase 2: Extract ObservationBuffer + FrameSampler + Vision

Extract the observation, vision, and sampling modules. Migrate ISinain first (cleanest codebase, easiest to validate).

**Create:**
- `packages/sinain-protocol/src/observation/buffer.ts` — extracted from ISinain `observationBuilder.ts:119-158`
- `packages/sinain-protocol/src/observation/message-builder.ts` — extracted from ISinain `observationBuilder.ts:160-229`, made configurable via `MessageBuilderConfig`
- `packages/sinain-protocol/src/vision/response-parser.ts` — extracted from ISinain `visionApi.ts:23-49`
- `packages/sinain-protocol/src/vision/openrouter-client.ts` — extracted from ISinain `visionApi.ts:51-128`
- `packages/sinain-protocol/src/vision/prompts.ts` — classification-aware prompts from Pi's `ocr.py`
- `packages/sinain-protocol/src/sampling/frame-sampler.ts` — extracted from ISinain `frameSampler.ts`
- Tests for all extracted modules

**Modify (ISinain):**
- Delete `src/pipeline/observationBuilder.ts`, `src/pipeline/frameSampler.ts`, `src/pipeline/visionApi.ts`
- `src/pipeline/usePipeline.ts` — import from `sinain-protocol`
- `src/pipeline/types.ts` — re-export types from `sinain-protocol`
- `package.json` — add `sinain-protocol` (via `npm pack` tarball or `file:` path)

**Verify:** ISinain builds, sends observations to gateway, receives responses. Message format unchanged.

### Phase 3: Extract Gateway (highest value, medium risk)

Unify three independent gateway implementations into one. This is the critical path.

**Create:**
- `packages/sinain-protocol/src/gateway/circuit-breaker.ts` — standalone class
- `packages/sinain-protocol/src/gateway/openclaw-ws.ts` — unified gateway with WebSocket injection
- Gateway tests with mocked WebSocket

**Extraction source:** ISinain's `pipeline/gateway.ts` is the best starting point — it already uses the browser-compatible `WebSocket` API (onmessage/onclose pattern) and has clean callback interface. The sinain-core version adds `sendRpc()` for generic RPC calls (needed for escalation), which we add to the unified version.

**Merge strategy:**
1. Start with ISinain's gateway (callback-based, no EventEmitter)
2. Add `sendRpc()` from sinain-core's gateway (for generic RPC methods)
3. Extract circuit breaker into standalone class (shared by both gateways)
4. Add `WebSocketImpl` injection parameter
5. Add streaming event handling from ISinain's `handleMessage` (agent events)

**Migrate ISinain first:**
- Delete `src/pipeline/gateway.ts`
- `src/pipeline/usePipeline.ts` — use `sinain-protocol.OpenClawGateway`

**Migrate sinain-core second:**
- Delete `src/escalation/openclaw-ws.ts`
- `src/escalation/escalator.ts` — wraps `sinain-protocol.OpenClawGateway`, keeps scoring/spawn/feedback
- The `Escalator` calls `gateway.sendAgentRpc()` and `gateway.sendRpc()` via the shared gateway

**Verify:** Both clients connect, authenticate, exchange RPCs. Circuit breaker behavior matches. Run shared protocol test fixtures.

### Phase 4: Python Protocol Adapter

Create `sinain-protocol-python` as a conformant port for the Pi.

**Create:**
- `packages/sinain-protocol-python/sinain_protocol/__init__.py`
- `sinain_protocol/gateway.py` — asyncio port of `gateway/openclaw-ws.ts`
- `sinain_protocol/circuit_breaker.py` — port of `gateway/circuit-breaker.ts`
- `sinain_protocol/observation.py` — port of `observation/*.ts`
- `sinain_protocol/vision.py` — port of `vision/response-parser.ts` (parsing only; Pi keeps its own OpenCV image encoding in `ocr.py`)
- `sinain_protocol/constants.py` — generated from `protocol/constants.ts`
- `sinain_protocol/types.py` — dataclasses matching TS interfaces
- `sinain_protocol/frame_sampler.py`
- `pyproject.toml`
- Tests using shared JSON fixtures (symlinked from TS package)

**Modify (sinain-wearable-hud):**
- Delete `sinain_wearable_hud/gateway.py`
- Delete `sinain_wearable_hud/observation.py`
- `main.py` — import gateway from `sinain_protocol`
- `sender.py` — import `build_observation_message` from `sinain_protocol`
- `ocr.py` — use `sinain_protocol.vision.parse_vision_response` for SCENE:/TEXT: parsing
- `requirements.txt` — add sinain-protocol-python dep

**Verify:** Pi connects and communicates identically. Shared JSON fixtures pass both TS and Python.

### Phase 5: Cross-language conformance tests

**Create shared test fixtures** in `packages/sinain-protocol/__tests__/fixtures/`:
- `protocol-frames.json` — challenge → auth → RPC → response message sequences
- `observation-messages.json` — input + expected markdown output
- `vision-responses.json` — raw API response + expected parsed result
- `circuit-breaker-scenarios.json` — failure sequences + expected open/close states

Both TS and Python test suites load these fixtures and assert identical behavior.

## Known Challenges

| Challenge | Mitigation |
|-----------|------------|
| **WebSocket API differences** (Node `ws` vs browser `WebSocket`) | Core uses `onmessage`/`onclose` property pattern (browser-compatible). Node adapter wraps `ws` events. |
| **ISinain separate repo** | Consumes `sinain-protocol` via `npm pack` tarball committed to ISinain, or `file:../sinain-hud/packages/sinain-protocol` during development. |
| **Metro bundler (RN)** | `sinain-protocol` is pure TS (no native deps) → Metro can bundle it. Add to `metro.config.js` `watchFolders` for local dev. |
| **Python asyncio vs TS Promise** | Same protocol behavior, different concurrency model. Shared JSON fixtures test message sequences, not timing. |
| **sinain-core's advanced gateway usage** | `sendRpc()` exposed as generic method on shared gateway. Escalation scoring, spawn tasks, learning remain in sinain-core. |

## File Summary

| Phase | New Files | Modified Files | Deleted Files |
|-------|-----------|----------------|---------------|
| 1 | ~10 (package scaffold + constants) | 3 (sinain-core imports) | 0 |
| 2 | ~7 (buffer, builder, vision, sampler + tests) | 4 (ISinain pipeline files) | 3 (ISinain duplicates) |
| 3 | ~3 (gateway + circuit breaker + tests) | 4 (ISinain + sinain-core gateway swap) | 2 (both old gateways) |
| 4 | ~9 (Python adapter package) | 4 (sinain-wearable-hud imports) | 2 (Pi gateway + observation) |
| 5 | ~4 (shared fixtures) | 2 (add fixture tests) | 0 |

## Verification

After each phase:
1. **sinain-core:** `npm run dev` → connects to gateway, agent loop ticks, escalation works
2. **ISinain:** `npx react-native run-ios` → camera streams, vision API called, observations sent, responses displayed
3. **sinain-wearable-hud:** `python3 -m sinain_wearable_hud -c config.yaml` → camera capture, scene gate, OLED display, gateway connection
4. **Shared tests:** `npm test` in sinain-protocol → all unit tests + fixture conformance pass
5. **Python tests:** `pytest` in sinain-protocol-python → shared fixtures pass identically

## Key Source Files (Reference)

These files contain the current implementations to extract from:

| File | What to extract |
|------|-----------------|
| `sinain-core/src/escalation/openclaw-ws.ts` | Gateway + circuit breaker (Node.js/EventEmitter version) |
| `ISinain/src/pipeline/gateway.ts` | Gateway + circuit breaker (browser-WebSocket version, best extraction base) |
| `sinain-wearable-hud/sinain_wearable_hud/gateway.py` | Gateway + circuit breaker (Python/asyncio version) |
| `ISinain/src/pipeline/observationBuilder.ts` | ObservationBuffer + buildObservationMessage (cleanest) |
| `ISinain/src/pipeline/visionApi.ts` | analyzeFrame + parseResponse (cleanest) |
| `ISinain/src/pipeline/frameSampler.ts` | FrameSampler (simplest) |
| `sinain-wearable-hud/sinain_wearable_hud/ocr.py` | Classification-aware vision prompts |
| `sinain-core/src/escalation/scorer.ts` | Error patterns list |
| `sinain-wearable-hud/sinain_wearable_hud/observation.py` | Python observation buffer + message builder |
