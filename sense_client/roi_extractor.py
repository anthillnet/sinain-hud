"""Region of Interest extraction from changed regions."""

from dataclasses import dataclass

import numpy as np
from PIL import Image


@dataclass
class ROI:
    image: Image.Image
    bbox: tuple[int, int, int, int]  # (x, y, w, h)


class ROIExtractor:
    """Extracts and crops changed regions from a frame."""

    def __init__(self, padding: int = 20, min_size: tuple[int, int] = (64, 64),
                 max_rois: int = 3):
        self.padding = padding
        self.min_size = min_size
        self.max_rois = max_rois

    def extract(self, frame: Image.Image, contours: list) -> list[ROI]:
        """Returns list of ROI crops from frame based on contours."""
        if not contours:
            return []

        # Compute bounding boxes for each contour
        boxes = []
        for coords in contours:
            arr = np.array(coords)
            min_y, min_x = arr.min(axis=0)
            max_y, max_x = arr.max(axis=0)
            boxes.append((int(min_x), int(min_y), int(max_x), int(max_y)))

        # Merge overlapping/adjacent boxes
        merged = self._merge_boxes(boxes)

        # Add padding, clamp, crop
        rois = []
        w, h = frame.size
        for x1, y1, x2, y2 in merged[:self.max_rois]:
            x1 = max(0, x1 - self.padding)
            y1 = max(0, y1 - self.padding)
            x2 = min(w, x2 + self.padding)
            y2 = min(h, y2 + self.padding)

            roi_w = x2 - x1
            roi_h = y2 - y1
            if roi_w < self.min_size[0] or roi_h < self.min_size[1]:
                continue

            crop = frame.crop((x1, y1, x2, y2))
            rois.append(ROI(image=crop, bbox=(x1, y1, roi_w, roi_h)))

        return rois

    def _merge_boxes(self, boxes: list[tuple]) -> list[tuple]:
        """Merge overlapping or adjacent bounding boxes."""
        if not boxes:
            return []

        # Sort by x1
        boxes = sorted(boxes, key=lambda b: b[0])
        merged = [list(boxes[0])]

        for x1, y1, x2, y2 in boxes[1:]:
            last = merged[-1]
            # Check if boxes overlap or are within padding distance
            if (x1 <= last[2] + self.padding and
                    y1 <= last[3] + self.padding and
                    y2 >= last[1] - self.padding):
                # Merge
                last[0] = min(last[0], x1)
                last[1] = min(last[1], y1)
                last[2] = max(last[2], x2)
                last[3] = max(last[3], y2)
            else:
                merged.append([x1, y1, x2, y2])

        # Sort by area (largest first)
        merged.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
        return [tuple(b) for b in merged]
