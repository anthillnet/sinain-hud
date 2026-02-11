"""SSIM-based frame change detection."""

from dataclasses import dataclass

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity


@dataclass
class ChangeResult:
    ssim_score: float
    diff_image: Image.Image
    contours: list  # list of (y, x) coordinate arrays
    bbox: tuple[int, int, int, int]  # (x, y, w, h)


class ChangeDetector:
    """SSIM-based frame change detection."""

    def __init__(self, threshold: float = 0.95, min_area: int = 100):
        self.threshold = threshold
        self.min_area = min_area
        self.prev_frame: np.ndarray | None = None

    def set_threshold(self, threshold: float) -> None:
        """Dynamically adjust the SSIM change threshold."""
        self.threshold = threshold

    def detect(self, frame: Image.Image) -> ChangeResult | None:
        """Compare frame to previous. Returns ChangeResult if significant."""
        gray = np.array(frame.convert("L"))

        if self.prev_frame is None:
            self.prev_frame = gray
            return None

        if gray.shape != self.prev_frame.shape:
            self.prev_frame = gray
            return None

        score, diff_map = structural_similarity(
            self.prev_frame, gray, full=True
        )

        if score >= self.threshold:
            return None

        # Keyframe update: only advance prev_frame when change IS detected.
        # This lets diffs accumulate against the last accepted keyframe,
        # which is essential at high FPS where consecutive frames differ by <1%.
        self.prev_frame = gray

        # Convert diff map to binary mask
        diff_binary = ((1.0 - diff_map) * 255).astype(np.uint8)
        mask = diff_binary > 30  # threshold for "changed" pixels

        # Find contours via connected components
        from skimage.measure import label, regionprops
        labeled = label(mask)
        regions = regionprops(labeled)

        # Filter by area
        contours = []
        for region in regions:
            if region.area >= self.min_area:
                contours.append(region.coords)

        if not contours:
            return None

        # Compute merged bounding box
        all_coords = np.vstack(contours)
        min_y, min_x = all_coords.min(axis=0)
        max_y, max_x = all_coords.max(axis=0)
        bbox = (int(min_x), int(min_y), int(max_x - min_x), int(max_y - min_y))

        diff_img = Image.fromarray(diff_binary)

        return ChangeResult(
            ssim_score=score,
            diff_image=diff_img,
            contours=contours,
            bbox=bbox,
        )
