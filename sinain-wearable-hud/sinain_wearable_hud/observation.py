"""Observation history buffer and structured message builder.

Port of sinain-core's message-builder.ts adapted for the wearable HUD.
Produces rich markdown context messages that replace the old one-liner metadata.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from .protocol import FrameClass, RoomFrame


@dataclass
class _Entry:
    """A single observation in the rolling history."""
    timestamp: float
    classification: FrameClass
    ssim: float
    motion_pct: float
    ocr_text: str = ""
    is_audio: bool = False
    audio_label: str = ""


class ObservationBuffer:
    """Rolling buffer of recent observations with age-based pruning."""

    def __init__(self, config: dict):
        obs_cfg = config.get("observation", {})
        self._max_entries = obs_cfg.get("max_entries", 20)
        self._max_age_s = obs_cfg.get("max_age_s", 300)
        self._buffer: deque[_Entry] = deque(maxlen=self._max_entries)
        self._tick = 0

    def add_frame(self, frame: RoomFrame) -> None:
        """Record a camera observation."""
        self._tick += 1
        self._prune()
        self._buffer.append(_Entry(
            timestamp=frame.timestamp,
            classification=frame.classification,
            ssim=frame.ssim,
            motion_pct=frame.motion_pct,
            ocr_text=frame.ocr_text,
        ))

    def add_audio(self, label: str, duration_s: float) -> None:
        """Record an audio observation."""
        self._prune()
        self._buffer.append(_Entry(
            timestamp=time.time(),
            classification=FrameClass.AMBIENT,
            ssim=1.0,
            motion_pct=0.0,
            is_audio=True,
            audio_label=label,
        ))

    @property
    def tick(self) -> int:
        return self._tick

    @property
    def recent(self) -> list[_Entry]:
        self._prune()
        return list(self._buffer)

    def _prune(self) -> None:
        """Remove entries older than max_age_s."""
        cutoff = time.time() - self._max_age_s
        while self._buffer and self._buffer[0].timestamp < cutoff:
            self._buffer.popleft()


# ── Error patterns for instruction selection ──────────────────────────

_ERROR_PATTERNS = [
    "error", "Error", "ERROR", "exception", "Exception",
    "failed", "Failed", "FAILED", "traceback", "Traceback",
    "fault", "panic", "WARN", "warning", "Warning",
    "denied", "refused", "timeout", "Timeout",
]


def _has_error_pattern(text: str) -> bool:
    return any(p in text for p in _ERROR_PATTERNS)


def _get_instructions(classification: FrameClass, ocr_text: str,
                      has_audio: bool) -> str:
    """Context-aware instructions — adapted from message-builder.ts."""
    if ocr_text and _has_error_pattern(ocr_text):
        return "Identify the error and suggest a fix."
    if classification == FrameClass.TEXT and ocr_text:
        return "Provide insight, translation, or context about what the user is reading."
    if has_audio:
        return "Respond to the question or note the key points."
    if classification in (FrameClass.SCENE, FrameClass.MOTION):
        return "Proactive observation about the new setting."
    return "Brief proactive tip. Never say 'standing by'."


def build_observation_message(frame: RoomFrame, buffer: ObservationBuffer) -> str:
    """Build a structured observation message for the agent RPC.

    Produces a markdown message with:
    - Current observation metadata + OCR text
    - Recent scene history with timestamps
    - Pattern summary
    - Context-aware instructions for the agent
    """
    now = time.time()
    size_kb = len(frame.jpeg_bytes) // 1024
    recent = buffer.recent

    parts: list[str] = []

    # Header
    parts.append(f"[sinain-wearable live context — tick #{buffer.tick}]")
    parts.append("")

    # Current observation
    parts.append("## Current Observation")
    parts.append(
        f"Scene: **{frame.classification.value}**"
        f" | ssim={frame.ssim:.2f} motion={frame.motion_pct:.0f}%"
        f" text_hints={frame.text_hint_count}"
        f" | {size_kb}KB {frame.width}x{frame.height}"
    )

    # OCR text block
    if frame.ocr_text:
        parts.append("")
        parts.append("### OCR Text (from camera)")
        parts.append("```")
        # Limit to first 500 chars to stay within RPC message budget
        ocr_display = frame.ocr_text[:500]
        if len(frame.ocr_text) > 500:
            ocr_display += "\n[...truncated]"
        parts.append(ocr_display)
        parts.append("```")

    # Recent history
    # Show up to 8 most recent entries (excluding the current frame which was just added)
    history_entries = recent[:-1] if len(recent) > 1 else []
    history_entries = history_entries[-8:]  # last 8

    if history_entries:
        parts.append("")
        parts.append("## Recent Scene History")
        for entry in reversed(history_entries):
            age = int(now - entry.timestamp)
            if entry.is_audio:
                parts.append(f"- [{age}s ago] audio: {entry.audio_label}")
            else:
                line = f"- [{age}s ago] **{entry.classification.value}** ssim={entry.ssim:.2f} motion={entry.motion_pct:.0f}%"
                if entry.ocr_text:
                    # Show first 60 chars of OCR as a hint
                    snippet = entry.ocr_text[:60].replace("\n", " ")
                    line += f' — "{snippet}"'
                parts.append(line)

    # Pattern summary
    last_10 = recent[-10:] if len(recent) >= 2 else []
    if last_10:
        scene_changes = sum(
            1 for e in last_10
            if e.classification in (FrameClass.SCENE, FrameClass.MOTION)
            and not e.is_audio
        )
        text_detections = sum(
            1 for e in last_10
            if e.classification == FrameClass.TEXT and not e.is_audio
        )
        audio_events = sum(1 for e in last_10 if e.is_audio)

        summary_parts = []
        if scene_changes:
            summary_parts.append(f"{scene_changes} scene changes")
        if text_detections:
            summary_parts.append(f"{text_detections} text detections")
        if audio_events:
            summary_parts.append(f"{audio_events} audio events")
        if summary_parts:
            parts.append("")
            parts.append(f"Pattern (last {len(last_10)}): {', '.join(summary_parts)}")

    # Instructions
    has_audio = any(e.is_audio for e in recent[-5:])
    instruction = _get_instructions(frame.classification, frame.ocr_text, has_audio)

    parts.append("")
    parts.append("## Instructions")
    parts.append("**Display constraint:** 128x128 OLED, ~18 chars wide, 8 lines max.")
    parts.append("2-4 short sentences. Plain text only, no markdown.")
    parts.append(f"[{instruction}]")
    parts.append("")
    parts.append("Respond naturally — this will appear on the user's wearable HUD.")

    return "\n".join(parts)
