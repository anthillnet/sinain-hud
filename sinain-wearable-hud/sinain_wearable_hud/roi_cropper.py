"""Classification-aware ROI cropping for the wearable HUD pipeline.

Adapted from sense_client/roi_extractor.py but:
- Works with numpy/cv2 BGR arrays (not PIL)
- Classification-aware strategy (TEXT → MSER boxes, MOTION → motion bbox)
- Wider padding / merge gaps for physical-world camera (vs screen capture)

The key insight: the SceneGate already computes SSIM maps, motion masks, and
MSER text regions — we just crop to the interesting region before sending to
the cloud vision API.  This turns ~50 KB of background noise into a focused
crop that yields readable OCR and relevant descriptions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np

from .protocol import FrameClass

log = logging.getLogger(__name__)

# Cropper parameters (tuned for physical-world wearable camera)
_PADDING = 30        # px — more than sense_client's 20 for camera shake
_TEXT_MERGE_GAP = 40  # px — physical text more spread out than screens
_MIN_ROI_SIZE = 128   # px — smaller crops aren't useful for vision API
_MIN_FRACTION = 0.05  # skip noise ROIs smaller than 5% of frame
_MAX_FRACTION = 0.85  # just send full frame if ROI covers >85%

# Downscale coordinate space for motion/change bboxes
_CLASSIFY_SIZE = (320, 180)


@dataclass
class CropResult:
    """Result of ROI cropping."""
    image: np.ndarray                     # BGR cropped image (or full frame)
    bbox: tuple[int, int, int, int] | None  # (x, y, w, h) or None
    is_full_frame: bool


def crop_roi(frame: np.ndarray, classification: FrameClass,
             meta: dict) -> CropResult:
    """Crop frame to ROI based on classification + spatial metadata.

    Strategy:
    - SCENE / AMBIENT: full frame (need full context)
    - TEXT: merge MSER text bboxes → single crop
    - MOTION: use motion_bbox → single crop
    """
    if classification in (FrameClass.SCENE, FrameClass.AMBIENT):
        return CropResult(image=frame, bbox=None, is_full_frame=True)

    h, w = frame.shape[:2]
    frame_area = h * w

    bbox: tuple[int, int, int, int] | None = None

    if classification == FrameClass.TEXT:
        text_bboxes = meta.get("text_bboxes", [])
        if text_bboxes:
            bbox = _merge_text_bboxes(text_bboxes, w, h)

    elif classification == FrameClass.MOTION:
        motion_bbox = meta.get("motion_bbox")
        if motion_bbox is not None:
            # motion_bbox is in downscaled coordinate space — scale up
            bbox = _scale_bbox(motion_bbox, _CLASSIFY_SIZE, (w, h))

    if bbox is None:
        return CropResult(image=frame, bbox=None, is_full_frame=True)

    x, y, bw, bh = bbox
    roi_area = bw * bh

    # Skip tiny noise ROIs
    if roi_area < frame_area * _MIN_FRACTION:
        return CropResult(image=frame, bbox=None, is_full_frame=True)

    # Skip huge ROIs — just send the full frame
    if roi_area > frame_area * _MAX_FRACTION:
        return CropResult(image=frame, bbox=None, is_full_frame=True)

    # Enforce minimum dimension
    if bw < _MIN_ROI_SIZE or bh < _MIN_ROI_SIZE:
        return CropResult(image=frame, bbox=None, is_full_frame=True)

    crop = frame[y:y + bh, x:x + bw].copy()
    log.debug("ROI crop: (%d,%d,%d,%d) %.0f%% of frame",
              x, y, bw, bh, roi_area / frame_area * 100)
    return CropResult(image=crop, bbox=(x, y, bw, bh), is_full_frame=False)


def _scale_bbox(bbox: tuple[int, int, int, int],
                from_size: tuple[int, int],
                to_size: tuple[int, int]) -> tuple[int, int, int, int]:
    """Scale a bbox from one coordinate space to another."""
    sx = to_size[0] / from_size[0]
    sy = to_size[1] / from_size[1]
    x, y, w, h = bbox
    return (int(x * sx), int(y * sy), int(w * sx), int(h * sy))


def _merge_text_bboxes(bboxes: list[tuple[int, int, int, int]],
                       frame_w: int, frame_h: int
                       ) -> tuple[int, int, int, int] | None:
    """Merge MSER text bboxes into a single padded ROI.

    Adapted from sense_client/roi_extractor.py:_merge_boxes() but with:
    - Wider merge gap (40px vs 20px) for physical text
    - More padding (30px vs 20px) for camera shake
    - Returns (x, y, w, h) format
    """
    if not bboxes:
        return None

    # Convert (x, y, w, h) → (x1, y1, x2, y2) for merge logic
    rects = [(x, y, x + w, y + h) for x, y, w, h in bboxes]

    # Sort by x1
    rects.sort(key=lambda r: r[0])
    merged = [list(rects[0])]

    for x1, y1, x2, y2 in rects[1:]:
        last = merged[-1]
        # Merge if overlapping or within gap threshold
        if (x1 <= last[2] + _TEXT_MERGE_GAP and
                y1 <= last[3] + _TEXT_MERGE_GAP and
                y2 >= last[1] - _TEXT_MERGE_GAP):
            last[0] = min(last[0], x1)
            last[1] = min(last[1], y1)
            last[2] = max(last[2], x2)
            last[3] = max(last[3], y2)
        else:
            merged.append([x1, y1, x2, y2])

    # Pick largest merged region
    merged.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
    x1, y1, x2, y2 = merged[0]

    # Add padding, clamp to frame
    x1 = max(0, x1 - _PADDING)
    y1 = max(0, y1 - _PADDING)
    x2 = min(frame_w, x2 + _PADDING)
    y2 = min(frame_h, y2 + _PADDING)

    return (x1, y1, x2 - x1, y2 - y1)
