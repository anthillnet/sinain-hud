"""Audio perception — VAD + segmentation (DESIGN-SHARED-MODULES §5, audio half).

Ported from sinain-hud's TypeScript AudioPipeline (sinain-core/src/audio/
pipeline.ts) into Python so one perception layer owns both modalities. The
segmenter turns a raw 16-bit PCM stream into WAV utterance chunks cut on
silence; the per-frame speech decision is a pluggable strategy — EnergyDetector
(adaptive noise floor, zero native deps, the default) or WebrtcDetector
(py-webrtcvad, the `webrtcvad` extra), the two strategies the doc names.

On top sits the transcription router (port of sinain-core's
TranscriptionService): three backends — OpenRouter audio via sinain-llm,
whisper-server HTTP, in-process faster-whisper (the `whisper` extra) — plus
the hallucination filter, rolling-context prompting, and the per-source /
cross-stream TranscriptDeduper.
"""

from .filters import (
    TranscriptDeduper,
    bigram_similarity,
    is_duplicate_transcript,
    is_hallucination,
)
from .transcription import (
    FasterWhisperBackend,
    OpenRouterAudioBackend,
    TranscriptResult,
    TranscriptionBackend,
    TranscriptionRouter,
    WhisperServerBackend,
    compose_whisper_prompt,
)
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
    "TranscriptionRouter",
    "TranscriptionBackend",
    "TranscriptResult",
    "OpenRouterAudioBackend",
    "WhisperServerBackend",
    "FasterWhisperBackend",
    "compose_whisper_prompt",
    "is_hallucination",
    "bigram_similarity",
    "is_duplicate_transcript",
    "TranscriptDeduper",
]
