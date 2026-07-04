"""Audio perception — VAD + segmentation (DESIGN-SHARED-MODULES §5, audio half).

Ported from sinain-hud's TypeScript AudioPipeline (sinain-core/src/audio/
pipeline.ts) into Python so one perception layer owns both modalities. The
segmenter turns a raw 16-bit PCM stream into WAV utterance chunks cut on
silence; the per-frame speech decision is a pluggable strategy — EnergyDetector
(adaptive noise floor, zero native deps, the default) or WebrtcDetector
(py-webrtcvad, the `webrtcvad` extra), the two strategies the doc names.

The transcription router (backends + hallucination/dedup filters) is the next
slice per §5; this module is the capture-adjacent, network-free core.
"""

from .vad import (
    EnergyDetector,
    Segmenter,
    SpeechDetector,
    WavChunk,
    WebrtcDetector,
    rms_energy,
    wav_header,
)

__all__ = [
    "Segmenter",
    "SpeechDetector",
    "EnergyDetector",
    "WebrtcDetector",
    "WavChunk",
    "wav_header",
    "rms_energy",
]
