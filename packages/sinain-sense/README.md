# sinain-sense

Shared perception layer for sinain surfaces — extraction step 3 (L2, video half) of
[DESIGN-SHARED-MODULES](../../docs/DESIGN-SHARED-MODULES.md). The audio half (VAD,
transcription router) lands per §5 of that doc.

## What's here

| Module | From | Role |
|---|---|---|
| `privacy` | sense_client | `<private>` strip + ~20 auto-redaction patterns (cards, keys, JWT, PII) |
| `events` | sense_client `gate.py` | `SenseEvent`/`SenseMeta`/`SenseObservation` — the `POST /sense` payload shapes |
| `sender` | sense_client | `/sense` client (3× retry, backoff, latency stats) + `/motion` fire-and-forget + image packaging |
| `gates.ssim` | sense_client | `ChangeDetector` — SSIM keyframe diff with region bboxes (`ssim` extra) |
| `gates.hash` | ARSinain `scene_gate.py` | `SceneGate` — blur/exposure/dHash with cooldowns (`hash` extra) |
| `vision` | both `vision.py`s | `VisionProvider` ABC + `VisionResult`; `OpenRouterVisionProvider` transported by sinain-llm (cost extraction included) |

Base install is light (requests + Pillow + sinain-llm); the gates' heavy deps are extras:

```
pip install "sinain-sense[ssim]"   # numpy + scikit-image
pip install "sinain-sense[hash]"   # opencv-python-headless
pip install "sinain-sense[all]"
```

## Consumers

- `sense_client/` (sinain-hud): `privacy.py`, `change_detector.py`, `sender.py` are
  re-export shims over this package; `gate.py` imports the event shapes; `vision.py` keeps
  the surface-specific Ollama backend + `create_vision` factory on the shared ABC.
- ARSinain: `scene_gate.py` is the donor of `gates.hash`; adoption (plus gaining `privacy`,
  which the AR surface never had) is tracked in DESIGN-SHARED-MODULES §6.

What stays per-surface by design: capture (sck-capture IPC / WebRTC / mss), platform OCR
backends (macOS Vision, WinRT), TTS/barge-in.
