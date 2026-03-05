# sense_client

Screen capture and change detection pipeline for SinainHUD. Captures the screen via ScreenCaptureKit, detects meaningful changes, runs OCR, applies privacy filters, and sends observations to sinain-core.

## Architecture

```
SCKCapture (ScreenCaptureKit)
    │
    ▼
ChangeDetector (SSIM diff)
    │
    ▼
ROIExtractor (contour → regions of interest)
    │
    ▼
OCR (Tesseract via pytesseract)
    │
    ▼
Privacy filter (strip <private> tags + auto-redact secrets)
    │
    ▼
DecisionGate (cooldown + significance check)
    │
    ▼
SenseSender ──POST──► sinain-core :9500/sense
```

### Capture backends

| Backend | API | Notes |
|---------|-----|-------|
| `SCKCapture` (default) | ScreenCaptureKit | macOS 12.3+, async zero-copy, camera-safe |
| `ScreenKitCapture` | IPC file read | Reads `~/.sinain/capture/frame.jpg` from overlay |
| `ScreenCapture` | `CGDisplayCreateImage` | Legacy fallback, deprecated on macOS 15 |

## Requirements

- macOS 12.3+ (for ScreenCaptureKit)
- Python 3.10+
- Tesseract OCR: `brew install tesseract`

## Setup

```bash
cd sense_client
pip install -r requirements.txt
```

## Running

```bash
# From the sinain-hud repo root:
python -m sense_client

# With a custom config file:
python -m sense_client --config path/to/config.json
```

On first run, macOS will prompt for Screen Recording permission.

## Configuration

The pipeline reads from a JSON config file (passed via `--config`). All fields are optional — defaults are used for anything unspecified.

| Section | Key | Default | Description |
|---------|-----|---------|-------------|
| `capture` | `mode` | `screen` | Capture mode |
| `capture` | `target` | `0` | Display index |
| `capture` | `fps` | `2.0` | Frames per second |
| `capture` | `scale` | `0.5` | Downscale factor |
| `detection` | `ssimThreshold` | `0.92` | SSIM score below which a frame is "changed" |
| `detection` | `cooldownMs` | `5000` | Min ms between change events |
| `gate` | `minOcrChars` | `20` | Minimum OCR text length to pass gate |
| `gate` | `cooldownMs` | `5000` | Min ms between gated events |
| `relay` | `url` | `http://localhost:9500` | sinain-core endpoint |

## Privacy

- **`<private>` tags**: any on-screen text wrapped in `<private>...</private>` is stripped before sending
- **Auto-redaction**: credit card numbers, API keys, bearer tokens, AWS keys, and passwords are automatically redacted from OCR output
- Server-side stripping provides an additional layer via the sinain-hud plugin
