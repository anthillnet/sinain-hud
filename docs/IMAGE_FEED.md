# SinainHUD Image Feed — Spec v2

> Images are input to Sinain, not output for the overlay. The overlay stays text-only.
> Client-side preprocessing reduces what Sinain needs to see by ~100×.

## 1. Problem

Sinain is blind. Operates on text — messages, files, API responses. Has no continuous awareness of what's happening on the user's screen. Screen context would enable:

- Proactive assistance ("you're looking at a Terraform error — want me to check the state?")
- Activity-aware responses (knows user is in a meeting vs coding vs browsing)
- Visual question answering without manual screenshots

Raw screen capture → VLM is wasteful: most frames are static, most changes are text-based. SenseAction's preprocessing pipeline solves this — filter, crop, OCR locally, send only what matters.

## 2. Architecture

```
Mac (client-side)                                    Server (Sinain)
─────────────────                                    ───────────────

Screen Capture (1 fps)                               
       │                                              
       ▼                                              
 Change Detector (SSIM)                               
       │ significant change?                          
       │ no → drop frame                              
       ▼                                              
  ROI Extractor                                       
       │ crop to changed region                       
       ▼                                              
  OCR (Tesseract)                                     
       │ extract text from ROI                        
       ▼                                              
  Decision Gate ─────────────────────────────────────► POST /sense
       │                                               (relay 18791)
       ├─ text change → { type: "text", ocr, roi_thumb }
       └─ visual change → { type: "visual", roi, diff, ocr }
                                                       │
                                                       ▼
                                                  Sinain consumes
                                                  (VLM only when needed)
                                                       │
                                                       ▼
                                                  HUD text feed
                                                  (overlay unchanged)
```

All heavy lifting happens on the Mac. Sinain receives pre-digested events.

## 3. Client-Side Pipeline

### 3.1 Screen Capture

Captures the target at configurable rate. macOS uses `screencapture` CLI or CGWindowListCreateImage via a Swift helper.

```jsonc
{
  "capture": {
    "mode": "screen",                    // "screen" | "window" | "region"
    "target": 0,                         // screen index, window name, or region rect
    "fps": 1,                            // captures per second
    "scale": 0.5                         // downscale factor before processing (saves CPU)
  }
}
```

Output: raw frame (numpy array or PIL Image), timestamp.

### 3.2 Change Detection

SSIM-based, ported from SenseAction's `ChangeDetector`.

```python
class ChangeDetector:
    def __init__(self, threshold=0.95, min_area=100):
        self.threshold = threshold     # SSIM score below this = significant change
        self.min_area = min_area       # minimum changed region in px²

    def detect(self, prev_frame, curr_frame):
        """Returns (changed: bool, diff_image, contours, ssim_score)"""
```

- **Threshold 0.95**: typical screen idle scores >0.99. Menu opens, window switches score 0.80-0.92.
- Filters out cursor blinks, clock updates, minor redraws.
- Tunable per use case — lower threshold = less sensitive.

**Expected filtering**: ~80-95% of frames dropped as static.

### 3.3 ROI Extraction

From SenseAction's `ROIExtractor`. Finds the bounding box of the changed region, adds padding, crops.

```python
class ROIExtractor:
    def __init__(self, padding=20, min_size=(64, 64)):
        self.padding = padding
        self.min_size = min_size

    def extract(self, frame, contours):
        """Returns cropped ROI image + bounding box coordinates"""
```

- Merges nearby contours (non-max suppression)
- Padding ensures context around the change
- Output is typically 10-50× smaller than the full frame

### 3.4 OCR (Tesseract)

Local text extraction on the ROI. From SenseAction's upgrade design.

```python
class LocalOCR:
    def __init__(self, lang="eng", config="--psm 11", min_confidence=30):
        ...

    def extract(self, roi_image):
        """Returns extracted text string"""
```

- PSM 11 = sparse text, good for UI elements
- Runs in ~50-200ms on a typical ROI crop
- Captures button labels, menu text, error messages, code snippets

### 3.5 Decision Gate

Classifies each change event and decides what to send:

```python
class DecisionGate:
    def classify(self, ocr_text, roi_image, diff_image, ssim_score):
        """
        Returns:
          - "text"   → OCR captured meaningful text, image optional
          - "visual" → significant visual change, image needed
          - "drop"   → noise (tiny change, OCR empty, below thresholds)
        """
```

**Rules:**
| Condition | Classification | Payload |
|---|---|---|
| OCR extracted ≥10 chars of meaningful text | `text` | OCR text + ROI thumbnail (low-res) |
| SSIM < 0.85 (major visual change) | `visual` | ROI image + diff image + OCR (if any) |
| SSIM 0.85-0.95, OCR < 10 chars | `drop` | Nothing sent |
| New window / app switch detected | `visual` | Full frame (downscaled) + context |

**Expected result**: of the ~5-20% of frames that pass change detection, roughly half are text-only (no VLM needed), half need visual analysis.

## 4. Relay Extension

### POST /sense (new endpoint)

Dedicated endpoint for sense events (separate from `/feed` which remains text-only for HUD display).

```jsonc
{
  "type": "text",                              // "text" | "visual" | "context"
  "ts": 1706713200000,
  "ocr": "TypeError: Cannot read property...", // extracted text (may be empty)
  "roi": {
    "data": "<base64 jpeg>",                   // ROI image (≤500KB)
    "bbox": [120, 340, 580, 520],              // [x, y, w, h] in original frame
    "thumb": true                              // true if downscaled
  },
  "diff": {
    "data": "<base64 jpeg>"                    // diff visualization (optional)
  },
  "meta": {
    "ssim": 0.87,                              // similarity score
    "app": "Terminal",                         // active application (if detectable)
    "screen": 0                                // source screen index
  }
}
```

**`type: "context"`** — sent once at startup or on app switch. Contains full frame (downscaled) for Sinain to establish baseline awareness. Equivalent to SenseAction's initial context gathering.

### Storage

Sense events stored in a separate ring buffer (last 30 events). Sinain polls or receives via push notification.

### GET /sense?after=N

Sinain polls for new sense events. Same pattern as `/feed`.

## 5. Sinain Consumption

Sinain processes sense events in a lightweight loop:

```
sense event arrives
    │
    ├─ type=text → log to context window (no VLM call)
    │   "User is looking at: TypeError in Terminal"
    │
    ├─ type=visual → VLM call on ROI image
    │   "User opened Figma, working on a wireframe"
    │
    └─ type=context → VLM call on full frame
        "Baseline: user has VS Code, Terminal, and Chrome open"
```

**Context window**: Sinain maintains a rolling summary of recent screen activity (last ~10 events). This feeds into responses without explicit user prompting.

**Proactive triggers**: Sinain can push to HUD text feed when screen context warrants it:
- Error detected → "Saw that TypeError — want me to look into it?"
- Meeting app opens → switch to quiet mode
- New tab with docs → preload relevant context

## 6. Cost Model

### Per-hour estimates (1 fps capture)

| Stage | Input | Output | Cost |
|---|---|---|---|
| Capture | 3,600 frames | 3,600 frames | $0 (local) |
| Change detection | 3,600 frames | ~180-360 events (5-10%) | $0 (local CPU, ~5ms/frame) |
| ROI + OCR | 180-360 events | 180-360 classified events | $0 (local CPU, ~200ms/event) |
| Decision gate | 180-360 events | ~90-180 text, ~50-100 visual, rest dropped | $0 (local) |
| VLM calls (visual only) | ~50-100 ROI images | descriptions | ~$0.05-0.10/hr |
| Context calls | ~2-5 app switches | baselines | ~$0.01/hr |
| **Total** | | | **~$0.06-0.11/hr** |

Compare to raw pipeline (every frame → VLM): **~$10.80/hr**. Preprocessing delivers **~100× cost reduction**.

### Client CPU impact

- SSIM comparison: ~5ms per frame pair → 5ms × 1fps = negligible
- OCR (Tesseract): ~200ms per event, ~5-10% of frames → ~1-2% CPU average
- Total: <3% CPU on a modern Mac. Unnoticeable.

## 7. Client Implementation

Single Python process, runs on the Mac alongside the HUD bridge.

### Dependencies

```
pip install pillow scikit-image numpy pytesseract requests
brew install tesseract
```

No OpenCV required for MVP — scikit-image handles SSIM, Pillow handles image ops.

### Entry point

```bash
python sense_client.py --config sense_config.json
```

### Module structure

```
sense_client/
├── __init__.py
├── capture.py          # Screen capture (macOS screencapture CLI)
├── change_detector.py  # SSIM change detection (from SenseAction)
├── roi_extractor.py    # ROI crop + merge (from SenseAction)
├── ocr.py              # Tesseract OCR wrapper
├── gate.py             # Decision gate (classify, filter)
├── sender.py           # POST to relay /sense endpoint
└── config.py           # Configuration loader
```

### Config

```jsonc
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
    "majorChangeThreshold": 0.85
  },
  "relay": {
    "url": "http://54.228.25.196:18791",
    "sendThumbnails": true,
    "maxImageKB": 500
  }
}
```

## 8. Phasing

### Phase 1 — Client Pipeline MVP
- [ ] `capture.py` — screen capture via `screencapture` CLI (macOS)
- [ ] `change_detector.py` — SSIM change detection (port from SenseAction)
- [ ] `roi_extractor.py` — ROI extraction + contour merging
- [ ] `ocr.py` — Tesseract wrapper
- [ ] `gate.py` — decision classification
- [ ] `sender.py` — POST to relay
- [ ] `sense_client.py` — main loop tying it all together
- [ ] Relay: add `/sense` endpoint + ring buffer

### Phase 2 — Sinain Integration
- [ ] Sense event consumption loop (poll /sense or push notification)
- [ ] Context window (rolling screen activity summary)
- [ ] VLM dispatch for visual events
- [ ] Proactive HUD alerts based on screen context

### Phase 3 — Refinements
- [ ] Window-specific capture (target a single app)
- [ ] App detection (which application is active)
- [ ] Perceptual hash deduplication (skip near-identical ROIs)
- [ ] Adaptive thresholds (learn noise floor per app)
- [ ] Multi-monitor support

## 9. Open Questions

1. **Capture method**: `screencapture` CLI (simple, spawns process each frame) vs Swift helper using CGWindowListCreateImage (faster, no process spawn). CLI is fine for 1fps.
2. **OCR language**: English only for MVP, or multi-lang from the start? Tesseract supports both.
3. **App detection**: macOS can report the frontmost app via `osascript`. Worth adding to metadata from phase 1?
4. **Relay or direct**: Should sense events go through the relay (18791), or should the client POST directly to Sinain's API? Relay keeps the architecture uniform; direct is lower latency.
