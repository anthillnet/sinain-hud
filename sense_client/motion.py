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
        H, W = gray.shape

        # 1. WHERE did pixels change? A global phase correlation is washed out by
        # static UI chrome (file tree, tabs) — when only the text pane scrolls,
        # the fixed majority drags the estimate to ~0. So localize to the changed
        # region and correlate THERE.
        diff = np.abs(prev.astype(np.int16) - gray.astype(np.int16))
        cmask = diff > 25
        if cmask.mean() < 0.004:  # <0.4% of pixels → essentially static
            return None
        ys, xs = np.where(cmask)
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        if (y1 - y0) < 24 or (x1 - x0) < 24:
            return None  # too small to be a scroll (cursor blink, badge, etc.)

        pc = prev[y0:y1, x0:x1]
        cc = gray[y0:y1, x0:x1]
        try:
            shift, _err, _ = phase_cross_correlation(pc, cc, upsample_factor=1)
        except Exception:
            return None
        # phase_cross_correlation(ref, moving) returns [-dy, -dx] of content
        # motion (verified), so the eye moves by (-shift_x, -shift_y).
        sy, sx = float(shift[0]), float(shift[1])
        dx, dy = -sx, -sy

        # 2. Motion-compensated residual WITHIN the changed crop → content that
        # changed beyond the scroll (replaced/gone). Offset boxes to full frame.
        iy, ix = int(round(dy)), int(round(dx))
        aligned = np.roll(pc, shift=(iy, ix), axis=(0, 1))
        resid = np.abs(aligned.astype(np.int16) - cc.astype(np.int16))
        if iy > 0: resid[:iy, :] = 0
        elif iy < 0: resid[iy:, :] = 0
        if ix > 0: resid[:, :ix] = 0
        elif ix < 0: resid[:, ix:] = 0

        boxes: list[list[int]] = []
        rmask = resid > self.resid_thresh
        if rmask.any():
            from skimage.measure import label, regionprops
            for r in regionprops(label(rmask)):
                if r.area >= self.min_box_area:
                    by0, bx0, by1, bx1 = r.bbox
                    boxes.append([int(bx0 + x0), int(by0 + y0),
                                  int(bx1 - bx0), int(by1 - by0)])
                    if len(boxes) >= self.max_boxes:
                        break

        if abs(dx) < self.min_shift and abs(dy) < self.min_shift and not boxes:
            return None
        return dx, dy, boxes
