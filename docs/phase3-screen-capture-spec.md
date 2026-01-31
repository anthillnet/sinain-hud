# Phase 3: Screen Capture Pipeline — Implementation Spec

## Overview

Add screen awareness to Sinain via a client-side preprocessing pipeline. Captures the screen at 1 fps, detects meaningful changes via SSIM, extracts ROIs, runs local OCR, and sends only relevant events to the relay. Sinain processes text events as context (no VLM) and visual events via VLM (Gemini Flash Vision). The overlay stays text-only.

**Goal**: Sinain sees AND hears the user's world. Combined audio + visual context enables proactive, situation-aware advice.

---

## 1. Architecture

```
Mac (client-side)                                              Server (Sinain)
─────────────────                                              ───────────────

  ┌─────────────────────┐
  │  sense_client (Py)  │
  │                     │
  │  screencapture 1fps │
  │        ↓            │
  │  SSIM change detect │──→ ~90% frames dropped
  │        ↓            │
  │  ROI extraction     │──→ crop to changed region
  │        ↓            │
  │  Tesseract OCR      │──→ extract text from ROI
  │        ↓            │
  │  Decision gate      │──→ classify: text / visual / drop
  │        ↓            │
  └────────┬────────────┘
           │ POST /sense
           ↓
  ┌────────────────────┐        ┌──────────────────────────┐
  │  hud-relay (18791) │        │  Sinain (OpenClaw agent) │
  │                    │        │                          │
  │  /sense endpoint   │◄──────│  GET /sense?after=N      │
  │  ring buffer (30)  │        │                          │
  │                    │        │  text → add to context   │
  │                    │        │  visual → VLM on ROI     │
  │                    │        │  context → VLM on frame  │
  │                    │        │        ↓                  │
  │  /feed endpoint    │◄──────│  POST /feed (advice)     │
  └────────┬───────────┘        └──────────────────────────┘
           │ GET /feed
           ↓
  ┌────────────────────┐
  │  Bridge (9500)     │──→ WS ──→ Overlay (text only)
  │                    │
  │  + polls /sense    │──→ screen status + combined context
  │    metadata only   │
  └────────────────────┘
```

**Two consumers of /sense**:
1. **Sinain** — polls full events (including images) for VLM processing and context
2. **Bridge** — polls lightweight metadata for overlay status updates and combined audio+visual context relay

---

## 2. Client-Side Pipeline (Python)

Separate Python process running alongside the bridge. Handles all CPU-intensive image preprocessing locally.

### 2.1 Module Structure

```
sense_client/
├── __init__.py
├── __main__.py           # Entry point: python -m sense_client
├── capture.py            # Screen capture (macOS screencapture CLI)
├── change_detector.py    # SSIM-based change detection
├── roi_extractor.py      # ROI crop + contour merging
├── ocr.py                # Tesseract OCR wrapper
├── gate.py               # Decision gate (classify + filter)
├── sender.py             # POST to relay /sense
├── app_detector.py       # Active app detection (osascript)
├── config.py             # Configuration loader
└── tests/
    ├── test_change_detector.py
    ├── test_roi_extractor.py
    ├── test_gate.py
    └── fixtures/          # Test screenshots
```

### 2.2 capture.py — Screen Capture

```python
class ScreenCapture:
    """Captures screen frames at configurable rate."""

    def __init__(self, mode="screen", target=0, fps=1, scale=0.5):
        self.mode = mode        # "screen" | "window" | "region"
        self.target = target    # screen index | window name | (x,y,w,h)
        self.fps = fps
        self.scale = scale

    def capture_frame(self) -> tuple[Image.Image, float]:
        """Returns (PIL Image, timestamp).
        Uses macOS `screencapture -x -C -t png /dev/stdout` piped to PIL.
        Downscales by self.scale factor before returning.
        """

    def capture_loop(self) -> Generator[tuple[Image.Image, float], None, None]:
        """Yields frames at self.fps rate."""
```

**macOS capture method**: `screencapture -x -C -t png <tmpfile>` (silent, no sound, cursor included). At 1 fps, process-spawn overhead is negligible (~20ms per capture). Temp file in `/tmp/` — created and deleted each frame.

**Alternative for lower latency**: Swift helper using `CGWindowListCreateImage`. Not needed for 1 fps MVP.

**Privacy**: Capture must respect the overlay's `sharingType = .none` — the overlay window is automatically excluded from `screencapture` output. Verified behavior on macOS 12+.

### 2.3 change_detector.py — SSIM Change Detection

```python
class ChangeDetector:
    """SSIM-based frame change detection. Ported from SenseAction."""

    def __init__(self, threshold=0.95, min_area=100):
        self.threshold = threshold   # SSIM below this = significant
        self.min_area = min_area     # min changed region in px²
        self.prev_frame = None       # grayscale of last frame

    def detect(self, frame: Image.Image) -> ChangeResult | None:
        """Compare frame to previous. Returns ChangeResult if significant,
        None if static or too small.

        Returns:
            ChangeResult {
                ssim_score: float,       # 0.0-1.0
                diff_image: Image.Image, # visualization of changed pixels
                contours: list[ndarray], # list of changed region contours
                bbox: tuple[int,int,int,int]  # merged bounding box (x,y,w,h)
            }
        """
```

**SSIM thresholds** (tuned empirically):
| Score | Meaning | Action |
|-------|---------|--------|
| > 0.99 | Identical (clock tick, cursor blink) | Drop |
| 0.95–0.99 | Minor change (scroll, highlight) | Drop |
| 0.85–0.95 | Moderate change (new text, dialog) | Detect |
| < 0.85 | Major change (window switch, new app) | Detect + flag |

**Implementation**: `skimage.metrics.structural_similarity` with `full=True` to get the diff map. Convert diff map to binary mask → `cv2.findContours` or `skimage.measure.find_contours` → filter by area.

### 2.4 roi_extractor.py — Region of Interest Extraction

```python
class ROIExtractor:
    """Extracts and crops the changed region from a frame."""

    def __init__(self, padding=20, min_size=(64, 64), max_rois=3):
        self.padding = padding
        self.min_size = min_size
        self.max_rois = max_rois

    def extract(self, frame: Image.Image, contours: list) -> list[ROI]:
        """Returns list of ROI crops.

        ROI {
            image: Image.Image,  # cropped region
            bbox: (x, y, w, h), # coordinates in original frame
        }

        Steps:
        1. Compute bounding boxes for each contour
        2. Merge overlapping/adjacent boxes (IoU > 0.3 or gap < padding)
        3. Add padding, clamp to frame bounds
        4. Crop and return
        """
```

**Merging strategy**: Non-maximum suppression (NMS) with generous overlap threshold. Two changes 50px apart get merged into one ROI. Prevents sending 10 tiny crops for a dialog box.

### 2.5 ocr.py — Local Text Extraction

```python
class LocalOCR:
    """Tesseract OCR wrapper for UI text extraction."""

    def __init__(self, lang="eng", psm=11, min_confidence=30):
        self.lang = lang
        self.psm = psm                  # 11 = sparse text (UI elements)
        self.min_confidence = min_confidence

    def extract(self, image: Image.Image) -> OCRResult:
        """Returns extracted text with confidence.

        OCRResult {
            text: str,           # extracted text, cleaned
            confidence: float,   # average word confidence 0-100
            word_count: int,
        }

        Uses pytesseract.image_to_data() for per-word confidence,
        filters words below min_confidence, joins remaining.
        """
```

**PSM modes** (Page Segmentation Mode):
- PSM 6: Assume uniform text block — good for code editors
- PSM 11: Sparse text — good for UIs with buttons, menus, mixed content
- PSM 3: Fully automatic — fallback

**Post-processing**: Strip control chars, collapse whitespace, remove lines that are all symbols/noise.

### 2.6 gate.py — Decision Gate

```python
class DecisionGate:
    """Classifies sense events and decides what to send."""

    def __init__(self, min_ocr_chars=10, major_change_threshold=0.85,
                 cooldown_ms=2000):
        self.min_ocr_chars = min_ocr_chars
        self.major_change_threshold = major_change_threshold
        self.cooldown_ms = cooldown_ms
        self.last_send_ts = 0
        self.last_ocr_hash = ""         # dedup identical OCR text

    def classify(self, change: ChangeResult, ocr: OCRResult,
                 app_changed: bool) -> SenseEvent | None:
        """Returns SenseEvent to send, or None to drop.

        Classification rules:
        1. app_changed → type="context" (full frame, downscaled)
        2. ocr.text >= min_ocr_chars → type="text" (OCR + ROI thumbnail)
        3. ssim < major_change_threshold → type="visual" (ROI + diff)
        4. Otherwise → None (drop)

        Additional filters:
        - Cooldown: don't send faster than cooldown_ms
        - Dedup: skip if OCR text identical to last send
        - Stability: wait 500ms after change, re-check (debounce)
        """
```

**SenseEvent types**:

| Type | When | Payload | Sinain action |
|------|------|---------|---------------|
| `text` | OCR extracted meaningful text | OCR string + ROI thumbnail (low-res) | Add to context (no VLM) |
| `visual` | Major visual change, OCR insufficient | ROI image + diff image + OCR (if any) | VLM call on ROI |
| `context` | App switch or startup baseline | Full frame (downscaled to 720p) | VLM call on full frame |

### 2.7 sender.py — Relay Communication

```python
class SenseSender:
    """POSTs sense events to the relay server."""

    def __init__(self, relay_url="http://54.228.25.196:18791",
                 max_image_kb=500, send_thumbnails=True):
        self.relay_url = relay_url
        self.max_image_kb = max_image_kb
        self.send_thumbnails = send_thumbnails

    def send(self, event: SenseEvent) -> bool:
        """POST /sense with JSON payload.

        Images are JPEG-encoded, quality reduced until < max_image_kb.
        ROI thumbnails downscaled to max 480px on longest side.
        Full frames (context type) downscaled to 720p.

        Returns True on success (HTTP 200).
        """
```

**Payload format** (JSON POST body):
```json
{
    "type": "text",
    "ts": 1706713200000,
    "ocr": "TypeError: Cannot read property 'map' of undefined",
    "roi": {
        "data": "<base64 jpeg, ≤500KB>",
        "bbox": [120, 340, 580, 520],
        "thumb": true
    },
    "diff": {
        "data": "<base64 jpeg>"
    },
    "meta": {
        "ssim": 0.87,
        "app": "Terminal",
        "screen": 0
    }
}
```

**Image size budget**:
- ROI thumbnail (text type): ≤100KB (low-res, just for reference)
- ROI image (visual type): ≤500KB
- Full frame (context type): ≤800KB (720p JPEG q=70)
- Diff image: ≤200KB

### 2.8 app_detector.py — Active Application

```python
class AppDetector:
    """Detects the frontmost application on macOS."""

    def get_active_app(self) -> str:
        """Returns the name of the frontmost application.
        Uses osascript:
          tell application "System Events"
            name of first application process whose frontmost is true
          end tell
        """

    def detect_change(self) -> tuple[bool, str]:
        """Returns (changed: bool, app_name: str).
        Compares to last known app. Used to trigger 'context' events.
        """
```

### 2.9 __main__.py — Main Loop

```python
def main(config_path: str):
    config = load_config(config_path)
    capture = ScreenCapture(**config["capture"])
    detector = ChangeDetector(**config["detection"])
    extractor = ROIExtractor(padding=config["detection"]["roiPadding"])
    ocr = LocalOCR(**config["ocr"])
    gate = DecisionGate(**config["gate"])
    sender = SenseSender(**config["relay"])
    app_detector = AppDetector()

    log("sense_client started")

    for frame, ts in capture.capture_loop():
        # 1. Check app change
        app_changed, app_name = app_detector.detect_change()

        # 2. Detect frame change
        change = detector.detect(frame)
        if change is None and not app_changed:
            continue  # static frame

        # 3. Extract ROI (if change detected)
        rois = []
        if change:
            rois = extractor.extract(frame, change.contours)

        # 4. OCR on primary ROI
        ocr_result = OCRResult(text="", confidence=0, word_count=0)
        if rois:
            ocr_result = ocr.extract(rois[0].image)

        # 5. Decision gate
        event = gate.classify(
            change=change,
            ocr=ocr_result,
            app_changed=app_changed,
        )
        if event is None:
            continue

        # 6. Package and send
        event.meta.app = app_name
        event.meta.screen = config["capture"]["target"]

        if event.type == "context":
            event.roi = package_full_frame(frame, max_px=720)
        elif rois:
            event.roi = package_roi(rois[0], thumb=(event.type == "text"))

        if change and change.diff_image and event.type == "visual":
            event.diff = package_diff(change.diff_image)

        ok = sender.send(event)
        if ok:
            log(f"→ {event.type} sent (app={app_name}, ssim={change.ssim_score:.3f})")
```

### 2.10 Configuration

```json
{
    "capture": {
        "mode": "screen",
        "target": 0,
        "fps": 1,
        "scale": 0.5
    },
    "detection": {
        "ssimThreshold": 0.95,
        "minArea": 100,
        "roiPadding": 20,
        "cooldownMs": 2000
    },
    "ocr": {
        "enabled": true,
        "lang": "eng",
        "psm": 11,
        "minConfidence": 30
    },
    "gate": {
        "minOcrChars": 10,
        "majorChangeThreshold": 0.85,
        "cooldownMs": 2000
    },
    "relay": {
        "url": "http://54.228.25.196:18791",
        "sendThumbnails": true,
        "maxImageKB": 500
    }
}
```

### 2.11 Dependencies

```
# requirements.txt
pillow>=10.0
scikit-image>=0.22
numpy>=1.24
pytesseract>=0.3
requests>=2.31
```

System:
```bash
brew install tesseract
```

---

## 3. Relay Server Changes

### File: `server/hud-relay.mjs`

Add `/sense` endpoints alongside existing `/feed`.

### 3.1 New Endpoints

**POST /sense** — Receive sense events from the Python client.

```
Request:
  Content-Type: application/json
  Body: { type, ts, ocr, roi, diff, meta }

Response:
  200: { ok: true, id: <int> }
  400: { ok: false, error: "..." }
```

**GET /sense?after=N** — Poll for sense events after ID N.

```
Response:
  200: {
    events: [
      { id: 1, type: "text", ts: ..., ocr: "...", roi: {...}, meta: {...} },
      { id: 2, type: "visual", ts: ..., ocr: "...", roi: {...}, diff: {...}, meta: {...} }
    ]
  }
```

**GET /sense?after=N&meta_only=true** — Lightweight poll (bridge uses this). Returns events without `roi.data` and `diff.data` fields. For status tracking only.

### 3.2 Storage

Separate ring buffer from /feed:

```javascript
const senseBuffer = [];       // max 30 events
let senseNextId = 1;

// On POST /sense:
const event = { id: senseNextId++, ...body, receivedAt: Date.now() };
senseBuffer.push(event);
if (senseBuffer.length > 30) senseBuffer.shift();
```

### 3.3 Size Limits

Request body limit: 2MB (base64 images can be large). The existing /feed stays at its current limit.

```javascript
// In request handler for /sense:
const MAX_SENSE_BODY = 2 * 1024 * 1024; // 2MB
```

---

## 4. Bridge Integration

### 4.1 New Module: `bridge/src/sense-poller.ts`

Lightweight poller that tracks screen state from /sense metadata. Does NOT download full images — that's Sinain's job.

```typescript
interface SenseEventMeta {
    id: number;
    type: "text" | "visual" | "context";
    ts: number;
    ocr: string;
    meta: {
        ssim: number;
        app: string;
        screen: number;
    };
}

class SensePoller extends EventEmitter {
    // Events: 'sense' (SenseEventMeta), 'app_change' (string)

    private lastSeenId = 0;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private currentApp = "";

    constructor(private relayUrl: string) { super(); }

    startPolling(intervalMs = 5000): void
    // GET /sense?after=N&meta_only=true every 5s

    stopPolling(): void

    // Emits:
    // 'sense' — for each new event (bridge can log/count)
    // 'app_change' — when meta.app differs from last known
}
```

### 4.2 index.ts Wiring

```typescript
// In index.ts initialization:
const sensePoller = new SensePoller(config.openclawGatewayUrl);

// Update screen status when sense events arrive
sensePoller.on("sense", (event) => {
    wsServer.updateState({ screen: "active" });
});

// Track app changes for combined context
sensePoller.on("app_change", (app) => {
    contextRelay.setScreenContext(`Active app: ${app}`);
    wsServer.broadcast(`[👁] App: ${app}`, "normal");
});

// Broadcast sense event summaries (with [👁] prefix for client-side filtering)
sensePoller.on("sense", (event) => {
    wsServer.updateState({ screen: "active" });
    if (event.type === "text" && event.ocr) {
        wsServer.broadcast(`[👁] text: ${event.ocr.slice(0, 80)}`, "normal");
    }
});

// Handle hotkeys
// toggle_screen: full pipeline start/stop (saves money)
} else if (msg.action === "toggle_screen") {
    if (screenActive) {
        // Signal sense_client to stop (via control file)
        sensePoller.stopPolling();
        wsServer.updateState({ screen: "off" });
        wsServer.broadcast("Screen capture stopped", "normal");
    } else {
        sensePoller.startPolling();
        wsServer.updateState({ screen: "active" });
        wsServer.broadcast("Screen capture started", "normal");
    }
}
// toggle_screen_feed: handled client-side in overlay (no bridge action needed)
```

### 4.3 Context Relay Update

Add screen context field to `context-relay.ts`:

```typescript
class ContextRelay {
    private screenContext = "";

    setScreenContext(ctx: string): void {
        this.screenContext = ctx;
    }

    // In escalate(), include screenContext in the package:
    // "[TRIGGER] (priority) summary\nScreen: {screenContext}\nContext (N entries):\n..."
}
```

### 4.4 New Types

```typescript
// In types.ts:
interface SenseConfig {
    enabled: boolean;
    pollIntervalMs: number;
}

// Add to BridgeConfig:
senseConfig: SenseConfig;
```

### 4.5 Config

```typescript
// In config.ts:
function loadSenseConfig(): SenseConfig {
    return {
        enabled: env.SENSE_ENABLED === "true",
        pollIntervalMs: Number(env.SENSE_POLL_INTERVAL_MS) || 5000,
    };
}
```

---

## 5. OpenClaw / Sinain Integration

### 5.1 Sense Consumer Skill

New skill (or extension to existing HUD skill) that gives Sinain access to screen context.

**Polling mechanism**: Sinain's agent loop includes a tool that fetches new /sense events. This runs periodically (every agent loop tick, or on a timer).

### 5.2 SKILL.md Update

Add sense event handling to the existing HUD skill:

```markdown
## Sense Events (Screen Context)

You receive screen context via `[HUD:sense]` messages. These describe what's
on the user's screen.

### Event Types

**`[HUD:sense type=text]`**
Screen text changed. OCR extracted:
```
{ocr_text}
App: {app_name} | SSIM: {score}
```
→ Add to your context window. No image processing needed.

**`[HUD:sense type=visual]`**
Significant visual change. Image attached.
```
App: {app_name} | SSIM: {score} | OCR: {text_if_any}
[IMAGE: base64 ROI attached]
```
→ Analyze the ROI image. Describe what changed. Update context.

**`[HUD:sense type=context]`**
App switch or baseline capture. Full frame attached.
```
App: {app_name}
[IMAGE: base64 frame attached]
```
→ Analyze frame. Establish what user is doing. Update rolling context.

### Behavior Rules for Screen Context

1. **Text events are cheap** — just note them, don't respond unless actionable
2. **Visual events need analysis** — describe what you see, store in context
3. **Context events are baselines** — "user switched to Figma, working on wireframes"
4. **Combine with audio** — screen + audio together > either alone
5. **Proactive triggers from screen**:
   - Error message visible → offer to help debug
   - Meeting app opens → switch to meeting advisor mode
   - Documentation page → preload relevant technical context
   - Terminal with failing tests → analyze error output
6. **Stay silent unless valuable** — seeing a code editor is not noteworthy,
   seeing a stack trace in a code editor IS
```

### 5.3 Sinain Sense Processing Loop

On the OpenClaw/Sinain side, implement a background task:

```
Every 10s (or on notification):
    GET /sense?after=lastId
    For each event:
        switch event.type:
            "text":
                screenContext.append(f"[{event.meta.app}] {event.ocr}")
                // No VLM call — text is sufficient
                if isActionable(event.ocr):
                    push to HUD feed

            "visual":
                description = VLM(event.roi.data, prompt="Describe this screen region change")
                screenContext.append(f"[{event.meta.app}] {description}")
                if isActionable(description):
                    push to HUD feed

            "context":
                baseline = VLM(event.roi.data, prompt="Describe what the user is doing")
                screenContext.setBaseline(f"[{event.meta.app}] {baseline}")
```

### 5.4 VLM Integration

Sinain uses Gemini Flash Vision (via OpenRouter) for image analysis:

```
POST https://openrouter.ai/api/v1/chat/completions
{
    "model": "google/gemini-2.5-flash",
    "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": "Describe what changed in this screen region. Be concise (1-2 sentences). Focus on: error messages, UI state changes, content that the user might need help with."},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
        ]
    }]
}
```

**Cost per VLM call**: ~$0.001 (Gemini Flash Vision, small ROI image)
**Expected rate**: 50-100 visual events/hour → $0.05-0.10/hour

### 5.5 Combined Context Window

Sinain maintains a rolling context that combines audio + screen:

```
Rolling Context (last 5 minutes):
├── [2m ago, audio] "Discussion about Q1 pricing strategy"
├── [1m30s ago, screen] "User in Google Sheets, revenue tab open"
├── [1m ago, audio] "Client asked about enterprise discount"
├── [45s ago, screen] "User switched to Slack, #sales channel"
├── [30s ago, audio] "User hesitating on discount authority"
└── [10s ago, screen] "Terminal: error in deploy script"
```

This combined context feeds into Sinain's responses, enabling advice like:
> "You have pricing authority up to 15% — check cell B14 in the sheet you had open."

---

## 6. Overlay Changes

### 6.1 Status Bar

Update `overlay/lib/ui/status/status_bar.dart` to show screen capture status.

```dart
// Dynamic screen icon based on ws.screenState
Icon(
    screenActive ? Icons.visibility : Icons.visibility_off,
    color: screenActive ? Colors.green : Colors.white.withValues(alpha: 0.3),
    size: 14,
)
```

### 6.2 New Hotkeys

| Shortcut | Action | Swift ID | Cost impact |
|----------|--------|----------|-------------|
| `Cmd+Shift+S` | Toggle screen capture pipeline on/off | 10 | Stops capture + VLM entirely ($0/hr when off) |
| `Cmd+Shift+V` | Toggle screen feed on HUD | 11 | Pipeline keeps running, just hides `[👁]` items from overlay |

Two levels of control (same pattern as audio `Cmd+Shift+T` / `Cmd+Shift+A`):
- **`Cmd+Shift+S`** — full stop. Kills the sense client capture loop, stops bridge polling, no VLM calls. Use when you don't need screen awareness at all.
- **`Cmd+Shift+V`** — cosmetic toggle. Pipeline + Sinain still process screen context (stays aware), but `[👁]` prefixed feed items are hidden from the overlay. Use when you want Sinain to see your screen but don't want the chatter on the HUD.

**AppDelegate.swift**: Register hotkey IDs 10 (`Cmd+Shift+S`) and 11 (`Cmd+Shift+V`).

**main.dart**:
- `onToggleScreen` → send `toggle_screen` command (starts/stops pipeline)
- `onToggleScreenFeed` → call `wsService.toggleScreenFeed()` (client-side filter)

**WebSocketService**:
- Track `screenState` from status messages (same pattern as `audioState`)
- Add `_screenFeedEnabled` flag + `toggleScreenFeed()` method
- Filter incoming feed items: skip items starting with `[👁]` when screen feed is disabled

### 6.3 Feed Items

Screen events that the bridge broadcasts appear as normal feed items with `[👁]` prefix:
- `[👁] App: Terminal` — app switch notification
- `[👁] text: TypeError in console` — OCR text detected
- `[👁] visual: new dialog appeared` — VLM description

The `[👁]` prefix enables the client-side filter (`Cmd+Shift+V`). When screen feed is
disabled, items starting with `[👁]` are silently dropped in WebSocketService (same as
`[📝]` filter for audio transcripts with `Cmd+Shift+A`).

No special UI treatment — the overlay stays text-only per the design principle.

---

## 7. Sense Client ↔ Bridge Control

The sense client runs as an independent Python process. The bridge controls it via a simple mechanism:

### 7.1 Control File (simplest)

```
/tmp/sinain-sense-control.json
{
    "enabled": true,
    "fps": 1,
    "target": 0
}
```

- Bridge writes `enabled: false` when `Cmd+Shift+S` (toggle_screen) is pressed → sense client pauses capture loop, no frames captured, no VLM calls, $0 spend
- Bridge writes `enabled: true` when toggled back on → sense client resumes
- Sense client polls this file every 1s
- When paused, sense client stays alive but idle (no CPU usage)

### 7.2 Cost Control Summary

| Hotkey | What stops | What keeps running | Cost when off |
|--------|------------|-------------------|---------------|
| `Cmd+Shift+S` | Capture + SSIM + OCR + relay POST + Sinain VLM | Nothing (full stop) | $0.00/hr |
| `Cmd+Shift+V` | `[👁]` items on overlay display | Capture + processing + Sinain analysis | ~$0.06-0.11/hr (Sinain still aware) |

Use `Cmd+Shift+S` when you want to save money. Use `Cmd+Shift+V` when you want a clean HUD but still want Sinain to have screen awareness.

### 7.3 Startup

```bash
# In bridge startup or as a separate service:
python -m sense_client --config sense_config.json --control /tmp/sinain-sense-control.json
```

The bridge can spawn this as a child process, or it can run independently.

---

## 8. Configuration Summary

### New Environment Variables (Bridge)

| Variable | Default | Description |
|----------|---------|-------------|
| `SENSE_ENABLED` | `false` | Enable sense event polling |
| `SENSE_POLL_INTERVAL_MS` | `5000` | How often bridge polls /sense metadata |

### Sense Client Config (`sense_config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `capture.mode` | `screen` | screen / window / region |
| `capture.target` | `0` | Screen index |
| `capture.fps` | `1` | Captures per second |
| `capture.scale` | `0.5` | Downscale before processing |
| `detection.ssimThreshold` | `0.95` | Change sensitivity |
| `detection.minArea` | `100` | Min changed region (px²) |
| `detection.roiPadding` | `20` | Padding around ROI (px) |
| `detection.cooldownMs` | `2000` | Min time between events |
| `ocr.enabled` | `true` | Run OCR on ROIs |
| `ocr.lang` | `eng` | Tesseract language |
| `ocr.psm` | `11` | Page segmentation mode |
| `ocr.minConfidence` | `30` | Min word confidence |
| `gate.minOcrChars` | `10` | Min chars for text event |
| `gate.majorChangeThreshold` | `0.85` | SSIM below = major change |
| `relay.url` | `http://54.228.25.196:18791` | Relay server URL |
| `relay.sendThumbnails` | `true` | Include ROI thumbs in text events |
| `relay.maxImageKB` | `500` | Max image size |

---

## 9. Cost Model

### Per-hour estimates (1 fps capture, typical desktop use)

| Stage | Volume | Cost |
|-------|--------|------|
| Screen capture | 3,600 frames/hr | $0 (local) |
| SSIM detection | 3,600 comparisons | $0 (local, ~5ms each) |
| OCR (Tesseract) | ~200 events/hr (5%) | $0 (local, ~200ms each) |
| Decision gate | ~200 events/hr | $0 (local) |
| VLM calls (visual) | ~50-100/hr | ~$0.05-0.10 |
| VLM calls (context) | ~2-5/hr (app switches) | ~$0.01 |
| **Total** | | **~$0.06-0.11/hr** |

Compare raw pipeline (every frame → VLM): ~$10.80/hr. **~100× cost reduction.**

### Client CPU

| Operation | Per-frame | At 1 fps | CPU impact |
|-----------|-----------|----------|-----------|
| Screen capture | ~20ms | 2% | Negligible |
| SSIM comparison | ~5ms | 0.5% | Negligible |
| OCR (5% of frames) | ~200ms | ~1% avg | Minimal |
| **Total** | | | **< 3%** |

---

## 10. Implementation Order

### Phase 3a — Client Pipeline MVP

| # | Task | Files |
|---|------|-------|
| 1 | Relay: add /sense endpoint + ring buffer | `server/hud-relay.mjs` |
| 2 | Sense client: capture.py (screencapture wrapper) | `sense_client/capture.py` |
| 3 | Sense client: change_detector.py (SSIM) | `sense_client/change_detector.py` |
| 4 | Sense client: roi_extractor.py (crop + merge) | `sense_client/roi_extractor.py` |
| 5 | Sense client: ocr.py (Tesseract wrapper) | `sense_client/ocr.py` |
| 6 | Sense client: gate.py (decision classification) | `sense_client/gate.py` |
| 7 | Sense client: sender.py (POST /sense) | `sense_client/sender.py` |
| 8 | Sense client: app_detector.py + __main__.py | `sense_client/app_detector.py`, `__main__.py` |
| 9 | End-to-end test: run sense client → verify events in relay | Manual |

### Phase 3b — Bridge + Overlay Integration

| # | Task | Files |
|---|------|-------|
| 10 | Bridge: sense-poller.ts (poll /sense metadata) | `bridge/src/sense-poller.ts` |
| 11 | Bridge: wire sense-poller in index.ts, broadcast with `[👁]` prefix | `bridge/src/index.ts` |
| 12 | Bridge: add screen context to context-relay | `bridge/src/context-relay.ts` |
| 13 | Bridge: add SenseConfig to types + config | `bridge/src/types.ts`, `config.ts` |
| 14 | Overlay: Cmd+Shift+S hotkey (toggle pipeline) | `AppDelegate.swift`, `main.dart` |
| 15 | Overlay: Cmd+Shift+V hotkey (toggle screen feed on HUD) | `AppDelegate.swift`, `main.dart` |
| 16 | Overlay: screen status icon | `status_bar.dart` |
| 17 | Overlay: screenState + screenFeedEnabled in websocket_service | `websocket_service.dart` |
| 18 | Overlay: client-side `[👁]` filter (same pattern as `[📝]` filter) | `websocket_service.dart` |

### Phase 3c — Sinain Integration

| # | Task | Files |
|---|------|-------|
| 19 | Extension: update SKILL.md with sense event rules | `extension/SKILL.md` |
| 20 | Sinain: sense event polling loop | OpenClaw agent config |
| 21 | Sinain: VLM dispatch for visual/context events | OpenClaw agent config |
| 22 | Sinain: combined audio+screen context window | OpenClaw agent config |
| 23 | Sinain: proactive triggers from screen context | OpenClaw agent config |

### Phase 3d — Refinements

| # | Task |
|---|------|
| 24 | Perceptual hash dedup (skip near-identical ROIs) |
| 25 | Window-specific capture mode |
| 26 | Adaptive SSIM thresholds per app |
| 27 | Multi-monitor support |
| 28 | Sense client tests |

---

## 11. Verification

### 3a — Client Pipeline

1. Start relay server
2. Run `python -m sense_client --config sense_config.json`
3. Switch between apps, open menus, trigger errors
4. `curl localhost:18791/sense?after=0` — verify events stored
5. Check logs: ~90% frames dropped, ~5-10% as events, correct types

### 3b — Bridge + Overlay

1. Start relay, bridge, overlay, sense client
2. Press `Cmd+Shift+S` → screen icon turns green, overlay shows "Screen capture started"
3. Switch apps → overlay shows `[👁] App: Terminal`
4. Bridge logs show sense metadata polling
5. Context relay includes screen context in escalations
6. Press `Cmd+Shift+V` → `[👁]` items stop appearing on HUD (pipeline still running in background)
7. Press `Cmd+Shift+V` again → `[👁]` items reappear
8. Press `Cmd+Shift+S` → screen icon dims, overlay shows "Screen capture stopped", no more events
9. Verify VLM calls stop when pipeline is off (check Sinain/OpenRouter logs — $0 spend)

### 3c — Sinain Integration

1. Full stack running
2. Open a terminal, trigger an error (e.g. `node -e "throw new Error('test')"`)
3. Sinain detects error via screen OCR → pushes advice to HUD
4. Open a meeting app → Sinain notes the switch in context
5. Combined context: Sinain references both audio and screen in responses

---

## 12. Open Questions (Decisions Needed)

1. **Capture method**: `screencapture` CLI (simple, 20ms overhead) vs Swift CGWindowListCreateImage helper (faster, no process spawn). **Recommendation**: CLI for MVP, upgrade later if needed.

2. **OCR language**: English only for MVP? **Recommendation**: English-only, add `SENSE_OCR_LANG` env var for easy extension.

3. **Sense client lifecycle**: Bridge spawns it as child process vs independent service? **Recommendation**: Independent process with control file. Simpler, can restart independently.

4. **VLM model for Sinain**: Gemini Flash Vision (cheap, fast) vs Gemini Pro Vision (better quality)? **Recommendation**: Flash for MVP, configurable.

5. **Image storage**: Keep images in relay memory (2MB per event × 30 = 60MB max) vs store on disk with references? **Recommendation**: Memory for MVP. 60MB is fine.
