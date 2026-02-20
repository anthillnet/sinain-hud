"""Message types, enums, and dataclasses for the wearable HUD pipeline."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum


class FrameClass(Enum):
    """Scene gate classification for captured camera frames."""
    DROP = "drop"
    AMBIENT = "ambient"
    SCENE = "scene"
    TEXT = "text"
    MOTION = "motion"


class Priority(Enum):
    """Display urgency levels — controls OLED color."""
    NORMAL = "normal"    # green
    HIGH = "high"        # yellow
    URGENT = "urgent"    # red + blink


@dataclass
class RoomFrame:
    """A classified camera frame ready for sending."""
    jpeg_bytes: bytes
    classification: FrameClass
    timestamp: float = field(default_factory=time.time)
    ssim: float = 1.0
    motion_pct: float = 0.0
    text_hint_count: int = 0
    width: int = 0
    height: int = 0


@dataclass
class AudioChunk:
    """A speech segment from the microphone."""
    pcm_data: bytes
    sample_rate: int = 16000
    duration_s: float = 0.0
    timestamp: float = field(default_factory=time.time)


@dataclass
class DisplayState:
    """Current state of the HUD display — shared between OLED and debug server."""
    text: str = ""
    priority: Priority = Priority.NORMAL
    status: str = "idle"            # idle, listening, thinking, connected
    last_update: float = field(default_factory=time.time)

    def update(self, text: str, priority: Priority = Priority.NORMAL,
               status: str | None = None) -> None:
        self.text = text
        self.priority = priority
        if status is not None:
            self.status = status
        self.last_update = time.time()

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "priority": self.priority.value,
            "status": self.status,
            "last_update": self.last_update,
        }
