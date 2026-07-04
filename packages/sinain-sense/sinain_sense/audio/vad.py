"""VAD endpointing + segmentation — faithful port of sinain-core's AudioPipeline.

Segment audio on SILENCE boundaries (end of an utterance) instead of a fixed
wall-clock timer, so chunks are cut at natural pauses, never mid-word. A
frame-level detector classifies each frame speech/silence; after speech, a run
of silence >= hangover (or the max-segment cap) ends the utterance and emits it
as a WAV chunk with a pre-roll lead-in so the onset isn't clipped.

Pure stdlib (struct/array) except the optional WebrtcDetector. The reference is
sinain-hud sinain-core/src/audio/pipeline.ts; parameters and the running-minimum
noise-floor behavior match it 1:1.
"""

from __future__ import annotations

import array
import struct
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

# ── VAD endpointing defaults (mirror pipeline.ts) ──
FRAME_MS = 30            # analysis frame size
HANGOVER_MS = 700       # trailing silence that ends an utterance
MAX_SEGMENT_MS = 18000  # force-cut a long monologue
MIN_SEGMENT_MS = 300    # drop blips (clicks / coughs)
PREROLL_MS = 300        # lead-in kept before speech onset
SPEECH_FACTOR = 3.5     # speech = energy > noiseFloor x this
_NOISE_CREEP = 0.0005   # how fast the floor rises toward louder ambient


@dataclass
class WavChunk:
    """One emitted utterance: a self-contained 16-bit PCM WAV + metadata."""
    buffer: bytes          # full WAV (44-byte header + PCM)
    source: str            # capture device / stream name
    ts: float              # emit time (epoch seconds), stamped by the caller
    duration_ms: int
    energy: float          # RMS of the utterance PCM (0..1)
    audio_source: str      # "system" | "mic"
    forced: bool = False   # True if cut by the max-segment cap, not a pause


def wav_header(data_len: int, sample_rate: int, channels: int, bits: int = 16) -> bytes:
    """44-byte PCM WAV header for `data_len` bytes of sample data."""
    byte_rate = sample_rate * channels * (bits // 8)
    block_align = channels * (bits // 8)
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_len, b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate, byte_rate, block_align, bits,
        b"data", data_len,
    )


def rms_energy(pcm: bytes) -> float:
    """RMS energy of little-endian 16-bit PCM, normalized to 0..1."""
    n = len(pcm) // 2
    if n == 0:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm[: n * 2])
    if struct.pack("<h", 1) != struct.pack("=h", 1):  # host is big-endian
        samples.byteswap()
    total = 0.0
    for s in samples:
        norm = s / 32768.0
        total += norm * norm
    return (total / n) ** 0.5


@runtime_checkable
class SpeechDetector(Protocol):
    """Per-frame speech/silence decision. `frame` is one FRAME_MS window of
    16-bit PCM (already gained); `sample_rate` is needed by native detectors."""

    def is_speech(self, frame: bytes, sample_rate: int) -> bool: ...

    def reset(self) -> None: ...


class EnergyDetector:
    """Energy VAD with an adaptive noise floor (the pipeline.ts strategy).

    The floor tracks the running MINIMUM energy: it snaps down instantly to any
    new quiet (true silence / room tone) and creeps up slowly toward rising
    ambient. Speech then reads as energy a few x above the floor, at any
    absolute level (independent of gain/source loudness). `threshold` never
    drops below `min_threshold`.
    """

    def __init__(self, speech_factor: float = SPEECH_FACTOR,
                 min_threshold: float = 0.0):
        self.speech_factor = speech_factor
        self.min_threshold = min_threshold
        self.noise_floor = 0.0

    def reset(self) -> None:
        self.noise_floor = 0.0

    def is_speech(self, frame: bytes, sample_rate: int) -> bool:
        energy = rms_energy(frame)
        if self.noise_floor == 0.0 or energy < self.noise_floor:
            self.noise_floor = energy
        else:
            self.noise_floor += (energy - self.noise_floor) * _NOISE_CREEP
        threshold = max(self.min_threshold, self.noise_floor * self.speech_factor)
        return energy >= threshold


class WebrtcDetector:
    """py-webrtcvad strategy (from ARSinain talk.py). Requires the `webrtcvad`
    extra. webrtcvad needs 10/20/30ms frames at 8/16/32/48 kHz — FRAME_MS=30 at
    16 kHz satisfies this."""

    def __init__(self, mode: int = 2):
        import webrtcvad  # lazy — optional dependency
        self._vad = webrtcvad.Vad(mode)

    def reset(self) -> None:
        pass  # stateless

    def is_speech(self, frame: bytes, sample_rate: int) -> bool:
        try:
            return self._vad.is_speech(frame, sample_rate)
        except Exception:
            return False  # malformed frame length at stream edges — treat as silence


class Segmenter:
    """Turns a raw 16-bit PCM stream into WAV utterance chunks.

    Feed arbitrary-sized `bytes` via `feed()`; it frames them, applies gain,
    asks the detector per frame, and returns any utterances completed by that
    input (0, 1, or more). Call `flush()` at end-of-stream to emit an
    in-progress utterance. Not thread-safe: drive from one reader.
    """

    def __init__(self, *, sample_rate: int = 16000, channels: int = 1,
                 gain_db: float = 0.0, detector: SpeechDetector | None = None,
                 source: str = "capture", audio_source: str = "system",
                 hangover_ms: int = HANGOVER_MS, max_segment_ms: int = MAX_SEGMENT_MS,
                 min_segment_ms: int = MIN_SEGMENT_MS, preroll_ms: int = PREROLL_MS):
        self.sample_rate = sample_rate
        self.channels = channels
        self.source = source
        self.audio_source = audio_source
        self.detector: SpeechDetector = detector or EnergyDetector()
        self.hangover_ms = hangover_ms
        self.max_segment_ms = max_segment_ms
        self.min_segment_ms = min_segment_ms

        self._gain_mult = 10 ** (gain_db / 20) if gain_db else 1.0
        bytes_per_ms = sample_rate * channels * 2 / 1000
        self._frame_bytes = max(2, round(bytes_per_ms * FRAME_MS))
        self._preroll_bytes = max(self._frame_bytes, round(bytes_per_ms * preroll_ms))

        self._leftover = b""            # partial frame carried between feeds
        self._utterance = bytearray()   # current utterance PCM (gained)
        self._preroll = bytearray()     # sliding lead-in ring (last preroll_bytes)
        self._in_utterance = False
        self._trailing_silence_ms = 0

    # ── framing / gain ──

    def _bytes_to_ms(self, n: int) -> int:
        return round((n / (2 * self.channels) / self.sample_rate) * 1000)

    def _apply_gain(self, frame: bytes) -> bytes:
        if self._gain_mult == 1.0:
            return frame
        n = len(frame) // 2
        samples = array.array("h")
        samples.frombytes(frame[: n * 2])
        if struct.pack("<h", 1) != struct.pack("=h", 1):
            samples.byteswap()
        for i in range(n):
            v = int(round(samples[i] * self._gain_mult))
            samples[i] = -32768 if v < -32768 else (32767 if v > 32767 else v)
        if struct.pack("<h", 1) != struct.pack("=h", 1):
            samples.byteswap()
        return samples.tobytes()

    def _push_preroll(self, frame: bytes) -> None:
        self._preroll.extend(frame)
        if len(self._preroll) > self._preroll_bytes:
            del self._preroll[: len(self._preroll) - self._preroll_bytes]

    # ── public API ──

    def feed(self, data: bytes) -> list[WavChunk]:
        """Process a PCM chunk; return any utterances it completed."""
        out: list[WavChunk] = []
        buf = self._leftover + data if self._leftover else data
        fb = self._frame_bytes
        n_frames = len(buf) // fb
        self._leftover = buf[n_frames * fb:]
        for f in range(n_frames):
            frame = self._apply_gain(buf[f * fb:(f + 1) * fb])
            speech = self.detector.is_speech(frame, self.sample_rate)
            chunk = self._process_frame(frame, speech)
            if chunk is not None:
                out.append(chunk)
        return out

    def flush(self) -> WavChunk | None:
        """Emit an in-progress utterance (end of stream / stop)."""
        if self._in_utterance:
            return self._flush_utterance()
        return None

    def reset(self) -> None:
        self._leftover = b""
        self._utterance = bytearray()
        self._preroll = bytearray()
        self._in_utterance = False
        self._trailing_silence_ms = 0
        self.detector.reset()

    # ── endpointing state machine (mirrors pipeline.ts processFrame) ──

    def _process_frame(self, frame: bytes, is_speech: bool) -> WavChunk | None:
        if is_speech:
            if not self._in_utterance:
                self._in_utterance = True
                self._trailing_silence_ms = 0
                if self._preroll:  # prepend lead-in so the onset isn't clipped
                    self._utterance.extend(self._preroll)
                    self._preroll = bytearray()
            self._utterance.extend(frame)
            self._trailing_silence_ms = 0
        elif self._in_utterance:
            self._utterance.extend(frame)  # keep short trailing silence in-segment
            self._trailing_silence_ms += FRAME_MS
            if self._trailing_silence_ms >= self.hangover_ms:
                return self._flush_utterance()
        else:
            self._push_preroll(frame)
        if self._in_utterance and self._bytes_to_ms(len(self._utterance)) >= self.max_segment_ms:
            return self._flush_utterance(forced=True)
        return None

    def _flush_utterance(self, forced: bool = False) -> WavChunk | None:
        pcm = bytes(self._utterance)
        self._utterance = bytearray()
        self._in_utterance = False
        self._trailing_silence_ms = 0
        aligned = len(pcm) - (len(pcm) % 2)
        if aligned == 0:
            return None
        pcm = pcm[:aligned]
        duration_ms = self._bytes_to_ms(aligned)
        if duration_ms < self.min_segment_ms:
            return None  # drop blips
        wav = wav_header(len(pcm), self.sample_rate, self.channels) + pcm
        return WavChunk(
            buffer=wav, source=self.source, ts=0.0, duration_ms=duration_ms,
            energy=rms_energy(pcm), audio_source=self.audio_source, forced=forced,
        )
