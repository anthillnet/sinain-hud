"""Transcript quality filters — ports of sinain-core's hallucination and
dedup logic (transcription.ts isHallucination, util/dedup.ts).

Pure functions + one small stateful deduper; no I/O.
"""

from __future__ import annotations

from collections import deque


def is_hallucination(text: str) -> bool:
    """Detect repeated-token hallucinations like "kuch kuch kuch kuch..."."""
    words = [w for w in _split_words(text) if w]
    if len(words) < 6:
        return False
    freq: dict[str, int] = {}
    for w in words:
        lw = w.lower()
        freq[lw] = freq.get(lw, 0) + 1
    return max(freq.values()) / len(words) > 0.6


def _split_words(text: str) -> list[str]:
    return [w for chunk in text.split() for w in chunk.split(",")]


def _bigrams(text: str) -> set[str]:
    """Character bigrams, lowercased."""
    t = text.lower()
    return {t[i:i + 2] for i in range(len(t) - 1)}


def bigram_similarity(a: str, b: str) -> float:
    """Dice coefficient over character bigrams (0..1)."""
    if a == b:
        return 1.0
    ba, bb = _bigrams(a), _bigrams(b)
    if not ba and not bb:
        return 1.0
    if not ba or not bb:
        return 0.0
    return 2 * len(ba & bb) / (len(ba) + len(bb))


def is_duplicate_transcript(text: str, recent_texts: list[str] | deque,
                            threshold: float = 0.80) -> bool:
    """True if `text` is a near-duplicate of any recent transcript."""
    trimmed = text.strip()
    if len(trimmed) < 5:
        return False  # don't dedup very short text
    return any(bigram_similarity(trimmed, r) > threshold for r in recent_texts)


class TranscriptDeduper:
    """Per-source + cross-stream transcript dedup (port of the consumer logic
    in sinain-core index.ts): a same-source near-duplicate is dropped, and a
    mic transcript >70% similar to a recent system transcript is dropped as
    speaker pickup (the mic hearing the speakers).
    """

    def __init__(self, ring: int = 3, same_threshold: float = 0.80,
                 cross_threshold: float = 0.70):
        self.same_threshold = same_threshold
        self.cross_threshold = cross_threshold
        self._recent: dict[str, deque[str]] = {}
        self._ring = ring

    def _ring_for(self, source: str) -> deque[str]:
        if source not in self._recent:
            self._recent[source] = deque(maxlen=self._ring)
        return self._recent[source]

    def check(self, text: str, audio_source: str = "system") -> str | None:
        """Return None if the transcript should be dropped, else the reason-free
        text to keep (also records it in the ring)."""
        trimmed = text.strip()
        same = self._ring_for(audio_source)
        if is_duplicate_transcript(trimmed, same, self.same_threshold):
            return None
        if audio_source != "system":
            system = self._recent.get("system", ())
            for recent in system:
                if bigram_similarity(trimmed, recent) > self.cross_threshold:
                    return None  # speakers pickup
        same.append(trimmed)
        return trimmed
