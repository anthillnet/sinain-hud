# sinain-sense

Shared perception layer for sinain surfaces — steps 3 (video) and 4 (audio) of
[DESIGN-SHARED-MODULES](../../docs/DESIGN-SHARED-MODULES.md). One entity owns both
modalities; capture stays per-surface, everything above the frame/PCM line is shared.

## What's here

| Module | From | Role |
|---|---|---|
| `privacy` | sense_client | `<private>` strip + ~20 auto-redaction patterns (cards, keys, JWT, PII) |
| `events` | sense_client `gate.py` | `SenseEvent`/`SenseMeta`/`SenseObservation` — the `POST /sense` payload shapes |
| `sender` | sense_client | `/sense` client (3× retry, backoff, latency stats) + `/motion` fire-and-forget + image packaging |
| `gates.ssim` | sense_client | `ChangeDetector` — SSIM keyframe diff with region bboxes (`ssim` extra) |
| `gates.hash` | ARSinain `scene_gate.py` | `SceneGate` — blur/exposure/dHash with cooldowns (`hash` extra) |
| `vision` | both `vision.py`s | `VisionProvider` ABC + `VisionResult`; `OpenRouterVisionProvider` transported by sinain-llm (cost extraction included) |
| `audio` | sinain-core `pipeline.ts` (+ ARSinain `talk.py`) | `Segmenter` (silence-cut VAD endpointing → WAV chunks) with pluggable `EnergyDetector` / `WebrtcDetector` (`webrtcvad` extra) |

Base install is light (requests + Pillow + sinain-llm); heavy deps are extras:

```
pip install "sinain-sense[ssim]"       # numpy + scikit-image (SSIM gate)
pip install "sinain-sense[hash]"       # opencv-python-headless (dHash gate)
pip install "sinain-sense[webrtcvad]"  # py-webrtcvad (alt VAD; EnergyDetector needs nothing)
pip install "sinain-sense[all]"
```

## Audio (step 4, this package)

`Segmenter` turns a raw 16-bit PCM stream into WAV utterance chunks cut on silence — a
faithful Python port of sinain-core's `AudioPipeline` (adaptive-noise-floor endpointing,
300 ms pre-roll, 700 ms hangover, min/max segment caps). The per-frame speech decision is a
pluggable `SpeechDetector`: `EnergyDetector` (zero native deps, the default) or
`WebrtcDetector` (from ARSinain's `talk.py`). **Next slice (§5):** the transcription router
(OpenRouter-audio / whisper-server / faster-whisper backends + hallucination & cross-stream
dedup filters), then surface adoption — ARSinain's `talk.py` internals first, then
sinain-core retires `src/audio/` behind a transcript `/sense` event + control channel.

## Consumers

- `sense_client/` (sinain-hud): `privacy.py`, `change_detector.py`, `sender.py` are
  re-export shims over this package; `gate.py` imports the event shapes; `vision.py` keeps
  the surface-specific Ollama backend + `create_vision` factory on the shared ABC.
- ARSinain: `scene_gate.py` is the donor of `gates.hash`; adoption (plus gaining `privacy`,
  which the AR surface never had) is tracked in DESIGN-SHARED-MODULES §6.

What stays per-surface by design: capture (sck-capture IPC / WebRTC / mss), platform OCR
backends (macOS Vision, WinRT), TTS/barge-in.
