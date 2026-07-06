"""Transcription router + backends — port of sinain-core's TranscriptionService.

One router, three backends (the stacks both surfaces use today):

- ``OpenRouterAudioBackend`` — cloud multimodal transcription (Gemini audio via
  sinain-llm), with the entity-preservation prompt from transcription.ts.
- ``WhisperServerBackend`` — HTTP client for a resident whisper.cpp
  whisper-server /inference endpoint. Server LIFECYCLE stays surface-side
  (spawn/supervision is capture-adjacent, like sck-capture — see
  DESIGN-SHARED-MODULES §2/§4); this client only probes and posts.
- ``FasterWhisperBackend`` — in-process faster-whisper (ARSinain's stack,
  subsumes the per-chunk whisper-cli path). The ``whisper`` extra.

The router owns what was in TranscriptionService: rolling same-source context
(age-gated), hotword/context prompt composition, min-length + hallucination
filters, and usage/cost surfacing for the OpenRouter path. Synchronous by
design — call it from a worker thread (hud) or asyncio.to_thread (AR).
Cross-stream dedup is separate (`filters.TranscriptDeduper`) since it belongs
at the consumer, where both sources meet.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional, Protocol, runtime_checkable

from .filters import is_hallucination
from .vad import WavChunk


@dataclass
class TranscriptResult:
    """Mirror of sinain-core types.ts TranscriptResult."""
    text: str
    source: str                 # "openrouter" | "whisper" | "faster-whisper"
    confidence: float
    ts: float
    audio_source: str           # "system" | "mic"
    refined: bool = False
    cost: dict | None = None    # {cost, tokens_in, tokens_out, model} when reported


def compose_whisper_prompt(hotwords: str | None, context: str | None,
                           max_len: int = 220) -> str | None:
    """Hotwords + rolling context, tail-clipped (port of composeWhisperPrompt)."""
    combined = " ".join(p.strip() for p in (hotwords, context) if p and p.strip())
    return combined[-max_len:] if combined else None


@runtime_checkable
class TranscriptionBackend(Protocol):
    name: str

    def transcribe(self, chunk: WavChunk, prompt: str | None = None
                   ) -> Optional[TranscriptResult]: ...


class OpenRouterAudioBackend:
    """Cloud transcription: WAV chunk → input_audio message via sinain-llm.

    Prompt policy ported from transcription.ts: language gate ("auto" →
    transcribe as heard; else strict single-language with empty-output guard)
    + the entity-preservation directive (favor phonetic transcription over
    substituting similar-sounding common names) + optional hotword context.
    """

    name = "openrouter"

    def __init__(self, model: str = "google/gemini-2.5-flash",
                 language: str = "auto", timeout: float = 30.0,
                 api_key: str | None = None):
        self.model = model
        self.language = language
        self.timeout = timeout
        self.api_key = api_key

    def _prompt_text(self, hotwords: str | None) -> str:
        lang = self.language
        if lang and lang != "auto":
            base = f"Transcribe this audio in {lang}."
            guard = f" If the audio is not in {lang}, output an empty string."
        else:
            base = "Transcribe this audio in the language it was spoken."
            guard = " If the audio is silent or unintelligible, output an empty string."
        entity_guard = (
            " Preserve proper nouns, person names, brand names, and company names"
            " EXACTLY as spoken. If unsure of a name's spelling, write the phonetic"
            " form — never substitute a similar-sounding common name. Numbers,"
            " dates, and quantities must be transcribed precisely."
        )
        hotword_ctx = f" Known proper nouns that may appear: {hotwords}." if hotwords else ""
        return f"{base}{entity_guard}{hotword_ctx} Output ONLY the transcript text, nothing else.{guard}"

    def transcribe(self, chunk: WavChunk, prompt: str | None = None
                   ) -> Optional[TranscriptResult]:
        import base64

        import sinain_llm

        b64 = base64.b64encode(chunk.buffer).decode("ascii")
        try:
            result = sinain_llm.chat(
                model=self.model, timeout=self.timeout, api_key=self.api_key,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "input_audio",
                         "input_audio": {"data": b64, "format": "wav"}},
                        {"type": "text", "text": self._prompt_text(prompt)},
                    ],
                }],
            )
        except sinain_llm.LLMError:
            return None
        text = result["text"].strip()
        if not text:
            return None
        usage = result["usage"]
        cost = None
        if usage.get("cost") is not None:
            cost = {"cost": usage["cost"],
                    "tokens_in": usage.get("prompt_tokens") or 0,
                    "tokens_out": usage.get("completion_tokens") or 0,
                    "model": self.model}
        return TranscriptResult(text=text, source="openrouter", confidence=0.8,
                                ts=time.time(), audio_source=chunk.audio_source,
                                cost=cost)


class WhisperServerBackend:
    """HTTP client for a resident whisper.cpp whisper-server.

    POSTs the WAV chunk to /inference (multipart), same request shape as the
    TS backend. Does NOT spawn or supervise the server — the surface owns that
    lifecycle (hud: capture_owner/start.sh; a Docker image just runs it).
    """

    name = "whisper"

    def __init__(self, base_url: str = "http://127.0.0.1:8910",
                 language: str = "auto", timeout: float = 30.0,
                 inference_path: str = "/inference"):
        self.base_url = base_url.rstrip("/")
        self.lang = (language or "auto").split("-")[0].lower()
        self.timeout = timeout
        self.inference_path = inference_path

    def is_available(self, timeout: float = 0.8) -> bool:
        import requests
        try:  # any HTTP response means the server is up
            requests.get(f"{self.base_url}/", timeout=timeout)
            return True
        except Exception:
            return False

    def transcribe(self, chunk: WavChunk, prompt: str | None = None
                   ) -> Optional[TranscriptResult]:
        import requests
        files = {"file": ("chunk.wav", chunk.buffer, "audio/wav")}
        data = {"response_format": "json", "language": self.lang}
        if prompt:
            data["prompt"] = prompt
        try:
            res = requests.post(f"{self.base_url}{self.inference_path}",
                                files=files, data=data, timeout=self.timeout)
            res.raise_for_status()
            text = (res.json().get("text") or "").strip()
        except Exception:
            return None
        if not text:
            return None
        return TranscriptResult(text=text, source="whisper", confidence=0.85,
                                ts=time.time(), audio_source=chunk.audio_source)


class FasterWhisperBackend:
    """In-process faster-whisper (ARSinain's stack; the `whisper` extra).

    Loads the model once; decodes the WavChunk's PCM to float32 and runs
    greedy decoding with the composed prompt as initial_prompt.
    """

    name = "faster-whisper"

    def __init__(self, model: str = "base.en", language: str | None = "en",
                 device: str = "cpu", compute_type: str = "int8",
                 beam_size: int = 1):
        from faster_whisper import WhisperModel  # lazy — optional dependency
        self._model = WhisperModel(model, device=device, compute_type=compute_type)
        self.language = language
        self.beam_size = beam_size

    @staticmethod
    def _wav_to_float32(wav: bytes):
        import array
        import io
        import struct
        import wave

        import numpy as np
        with wave.open(io.BytesIO(wav)) as w:
            pcm = w.readframes(w.getnframes())
        samples = array.array("h")
        samples.frombytes(pcm[: (len(pcm) // 2) * 2])
        if struct.pack("<h", 1) != struct.pack("=h", 1):
            samples.byteswap()
        return np.asarray(samples, dtype=np.float32) / 32768.0

    def transcribe(self, chunk: WavChunk, prompt: str | None = None
                   ) -> Optional[TranscriptResult]:
        audio = self._wav_to_float32(chunk.buffer)
        kw = {"language": self.language} if self.language else {}
        segments, _info = self._model.transcribe(
            audio, beam_size=self.beam_size, initial_prompt=prompt, **kw)
        text = " ".join(s.text for s in segments).strip()
        if not text:
            return None
        return TranscriptResult(text=text, source="faster-whisper",
                                confidence=0.85, ts=time.time(),
                                audio_source=chunk.audio_source)


@dataclass
class _SourceContext:
    text: str = ""
    ts: float = 0.0


class TranscriptionRouter:
    """Backend-agnostic front door (port of TranscriptionService minus the
    event emitter): composes the prompt (hotwords + age-gated rolling context
    per audio source, so system/mic don't contaminate each other), calls the
    backend, and applies the min-length + hallucination filters.
    """

    def __init__(self, backend: TranscriptionBackend, *,
                 hotwords: str | None = None, use_context: bool = True,
                 context_max_age_s: float = 12.0, min_chars: int = 3):
        self.backend = backend
        self.hotwords = hotwords
        self.use_context = use_context
        self.context_max_age_s = context_max_age_s
        self.min_chars = min_chars
        self._last: dict[str, _SourceContext] = {}

    def _context_for(self, chunk: WavChunk) -> str | None:
        if not self.use_context:
            return None
        prev = self._last.get(chunk.audio_source or "system")
        if not prev or time.time() - prev.ts > self.context_max_age_s:
            return None
        tail = prev.text[-140:].strip()
        return tail if len(tail) >= 8 else None

    def transcribe(self, chunk: WavChunk) -> Optional[TranscriptResult]:
        prompt = compose_whisper_prompt(self.hotwords, self._context_for(chunk))
        result = self.backend.transcribe(chunk, prompt)
        if result is None:
            return None
        text = result.text.strip()
        if len(text) < self.min_chars:
            return None
        if is_hallucination(text):
            return None
        if self.use_context:
            self._last[chunk.audio_source or "system"] = _SourceContext(text, time.time())
        return result
