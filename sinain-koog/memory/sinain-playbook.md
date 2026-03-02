<!-- mining-index: 2026-03-01 -->

# Sinain Playbook

## Established Patterns
- When OCR pipeline stalls, check camera frame queue depth (score: 0.8)
- When user explores new framework, spawn research agent proactively (score: 0.6)
- When OCR backend switches (e.g., Tesseract → vision API), validate latency and cost tradeoffs before committing (score: 0.7)

## Observed
- User prefers concise Telegram messages over detailed ones
- Late evening sessions tend to be exploratory/research-heavy
- Scene-gating (drop frames on low scene change) is preferred approach for OCR backpressure
- JPEG quality tuning is part of wearable pipeline optimization workflow
- User converging on 3-panel HUD layout for wearable debug interface
- Flutter overlay on macOS is an active exploration area (not settled)

## Stale
- Flutter overlay rendering glitch on macOS 15 [since: 2026-02-18]

<!-- effectiveness: outputs=8, positive=5, negative=1, neutral=2, rate=0.63, updated=2026-02-21 -->
