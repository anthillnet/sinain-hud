"""SenseEvent shapes — the /sense payload contract (sinain-protocol L0 seed).

Moved from sense_client/gate.py so every surface emits the same shapes; the
server counterpart is sinain-core/src/server.ts POST /sense.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SenseMeta:
    ssim: float = 0.0
    app: str = ""
    window_title: str = ""
    screen: int = 0


@dataclass
class SenseObservation:
    """Structured observation fields (claude-mem compatible schema).

    Populated by sinain-core's agent layer, not by the sense layer.
    The sense layer sets `title` and `facts` from OCR/app context;
    sinain-core enriches with `narrative` and `concepts`.
    """
    title: str = ""
    subtitle: str = ""
    facts: list[str] = field(default_factory=list)
    narrative: str = ""
    concepts: list[str] = field(default_factory=list)
    scene: str = ""  # Local vision model scene description (Ollama)


@dataclass
class SenseEvent:
    type: str  # "text" | "visual" | "context"
    ts: float = 0.0
    ocr: str = ""
    roi: dict | None = None
    diff: dict | None = None
    meta: SenseMeta = field(default_factory=SenseMeta)
    observation: SenseObservation = field(default_factory=SenseObservation)
    vision_cost: dict | None = None  # {cost, tokens_in, tokens_out, model}
    # Per-line OCR boxes in FULL-FRAME pixels (top-left origin):
    # [{"text": str, "bbox": [x, y, w, h]}] — for precise region-eye anchoring.
    ocr_lines: list | None = None
