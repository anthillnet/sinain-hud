"""Frame-to-frame visual motion estimation for precise ROI tracking.

Reuses the same grayscale frames the change detector works on. Per frame it
estimates the global scroll translation (phase correlation) AND the regions that
changed BEYOND that translation (motion-compensated residual). The core uses the
translation to glide region eyes with content and the changed regions to retire
eyes whose content was replaced — all at capture rate, no OCR/LLM.
"""
from __future__ import annotations

import numpy as np
from skimage.registration import phase_cross_correlation


class MotionEstimator:
    def __init__(self, min_shift: float = 2.0, resid_thresh: int = 45,
                 min_box_area: int = 600, max_boxes: int = 16):
        self.prev: np.ndarray | None = None
        self.min_shift = min_shift
        self.resid_thresh = resid_thresh
        self.min_box_area = min_box_area
        self.max_boxes = max_boxes

    def reset(self) -> None:
        """Drop history (e.g. on app/display switch — content is discontinuous)."""
        self.prev = None

    def estimate(self, gray: np.ndarray):
        """gray: 2D uint8 (current frame, same resolution as the OCR boxes).
        Returns (dx, dy, changed_boxes) where dx/dy move an eye WITH the content
        and changed_boxes are [x,y,w,h] regions of replaced content — or None
        when there's nothing worth sending."""
        prev = self.prev
        self.prev = gray
        if prev is None or prev.shape != gray.shape:
            return None
        try:
            shift, _err, _ = phase_cross_correlation(prev, gray, upsample_factor=1)
        except Exception:
            return None
        # phase_cross_correlation(ref, moving) returns [-dy, -dx] of content
        # motion (verified empirically), so eye moves by (-shift_x, -shift_y).
        sy, sx = float(shift[0]), float(shift[1])
        dx, dy = -sx, -sy

        # Motion-compensated residual: roll prev by the CONTENT motion (dy,dx)
        # so it lines up with the current frame, then diff — regions that remain
        # different are content that actually changed (not just scrolled).
        iy, ix = int(round(dy)), int(round(dx))
        aligned = np.roll(prev, shift=(iy, ix), axis=(0, 1))
        resid = np.abs(aligned.astype(np.int16) - gray.astype(np.int16))
        # np.roll wraps; blank the wrapped margins so they aren't counted.
        if iy > 0: resid[:iy, :] = 0
        elif iy < 0: resid[iy:, :] = 0
        if ix > 0: resid[:, :ix] = 0
        elif ix < 0: resid[:, ix:] = 0

        boxes: list[list[int]] = []
        mask = resid > self.resid_thresh
        if mask.any():
            from skimage.measure import label, regionprops
            for r in regionprops(label(mask)):
                if r.area >= self.min_box_area:
                    min_y, min_x, max_y, max_x = r.bbox
                    boxes.append([int(min_x), int(min_y),
                                  int(max_x - min_x), int(max_y - min_y)])
                    if len(boxes) >= self.max_boxes:
                        break

        if abs(dx) < self.min_shift and abs(dy) < self.min_shift and not boxes:
            return None
        return dx, dy, boxes
