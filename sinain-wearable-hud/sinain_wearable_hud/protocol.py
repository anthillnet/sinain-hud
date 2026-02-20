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
    description: str = ""  # scene description from vision model
    ocr_text: str = ""     # extracted text from vision model


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
    gateway_status: str = "disconnected"  # disconnected, connected, error
    response_text: str = ""         # latest agent response
    debug_text: str = ""            # camera classification / debug info
    last_update: float = field(default_factory=time.time)

    def update(self, text: str, priority: Priority = Priority.NORMAL,
               status: str | None = None) -> None:
        self.text = text
        self.priority = priority
        if status is not None:
            self.status = status
        self.last_update = time.time()

    def set_response(self, text: str) -> None:
        """Update the latest agent response text."""
        self.response_text = text
        self.last_update = time.time()

    def set_debug(self, text: str) -> None:
        """Update the debug/camera info text."""
        self.debug_text = text
        self.last_update = time.time()

    # Pipeline debug streams (for debug server)
    scene_description: str = ""     # latest scene description from vision model
    ocr_text: str = ""              # latest OCR text from vision model
    observation_sent: str = ""      # latest observation message sent to agent
    last_ocr_ms: float = 0.0       # vision latency in ms

    def set_ocr(self, text: str, latency_ms: float) -> None:
        """Update the latest OCR result."""
        self.ocr_text = text
        self.last_ocr_ms = latency_ms
        self.last_update = time.time()

    def set_observation(self, text: str) -> None:
        """Update the latest observation message sent to agent."""
        self.observation_sent = text
        self.last_update = time.time()

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "priority": self.priority.value,
            "status": self.status,
            "gateway_status": self.gateway_status,
            "response_text": self.response_text,
            "debug_text": self.debug_text,
            "scene_description": self.scene_description,
            "ocr_text": self.ocr_text,
            "observation_sent": self.observation_sent,
            "last_ocr_ms": self.last_ocr_ms,
            "last_update": self.last_update,
        }
