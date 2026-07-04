"""sinain-sense — shared perception layer for sinain surfaces (L2 of DESIGN-SHARED-MODULES).

Video half: privacy redaction, SenseEvent shapes, /sense sender, vision
providers, scene gates. Gates live in `sinain_sense.gates` (imported lazily —
they need the `ssim` / `hash` extras). The audio half (VAD, transcription)
lands per DESIGN-SHARED-MODULES §5.
"""

from .events import SenseEvent, SenseMeta, SenseObservation
from .privacy import apply_privacy, redact_sensitive, strip_private
from .sender import (
    SenseSender,
    encode_image,
    frame_dims,
    package_diff,
    package_full_frame,
    package_roi,
)
from .vision import OpenRouterVisionProvider, VisionProvider, VisionResult, encode_image_b64

__version__ = "0.1.0"

__all__ = [
    "SenseEvent", "SenseMeta", "SenseObservation",
    "apply_privacy", "redact_sensitive", "strip_private",
    "SenseSender", "encode_image", "frame_dims",
    "package_diff", "package_full_frame", "package_roi",
    "VisionProvider", "VisionResult", "OpenRouterVisionProvider", "encode_image_b64",
    "__version__",
]
