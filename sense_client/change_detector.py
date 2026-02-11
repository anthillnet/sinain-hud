"""Multi-level frame change detection: pHash fast gate → SSIM verification."""

from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

try:
    import imagehash
    PHASH_AVAILABLE = True
except ImportError:
    imagehash = None
    PHASH_AVAILABLE = False


@dataclass
class ChangeResult:
    ssim_score: float
    diff_image: Image.Image
    contours: list  # list of (y, x) coordinate arrays
    bbox: tuple[int, int, int, int]  # (x, y, w, h)
    phash_distance: int = 0  # Hamming distance from pHash comparison


class FastGate:
    """Perceptual hash (pHash) based fast gate for rejecting unchanged frames.

    Uses a 64-bit perceptual hash that captures image structure. Comparing two
    hashes via Hamming distance is <1ms vs 5ms for SSIM. This rejects ~95% of
    unchanged frames before the expensive SSIM computation.
    """

    def __init__(self, hash_size: int = 8, threshold: int = 5):
        """
        Args:
            hash_size: Size of the hash (hash_size^2 bits). Default 8 = 64 bits.
            threshold: Max Hamming distance to consider frames unchanged.
                       5 bits difference in 64 bits = ~8% visual difference.
        """
        self.hash_size = hash_size
        self.threshold = threshold
        self.prev_hash: Optional["imagehash.ImageHash"] = None
        self._available = PHASH_AVAILABLE

        # Stats
        self.frames_checked = 0
        self.frames_rejected = 0

    def check(self, frame: Image.Image) -> tuple[bool, int]:
        """Check if frame has changed enough to warrant SSIM analysis.

        Returns:
            (should_continue, hamming_distance)
            - should_continue: True if frame should proceed to SSIM
            - hamming_distance: Number of different bits (0-64)
        """
        if not self._available:
            return (True, 0)  # Skip pHash gate if library not available

        self.frames_checked += 1

        # Compute perceptual hash (resizes to hash_size x hash_size internally)
        current_hash = imagehash.phash(frame, hash_size=self.hash_size)

        if self.prev_hash is None:
            self.prev_hash = current_hash
            return (True, 64)  # First frame always passes

        # Hamming distance: number of bits that differ
        distance = current_hash - self.prev_hash

        if distance < self.threshold:
            # Frame is too similar - reject without SSIM
            self.frames_rejected += 1
            return (False, distance)

        # Frame might be different - update hash and proceed to SSIM
        self.prev_hash = current_hash
        return (True, distance)

    def reset(self) -> None:
        """Reset the gate state (e.g., after display/resolution change)."""
        self.prev_hash = None

    @property
    def rejection_rate(self) -> float:
        """Percentage of frames rejected by the fast gate."""
        if self.frames_checked == 0:
            return 0.0
        return self.frames_rejected / self.frames_checked * 100


class ChangeDetector:
    """Multi-level frame change detection with pHash fast gate.

    Pipeline:
    1. pHash fast gate (<1ms) - rejects ~95% of unchanged frames
    2. SSIM verification (~5ms) - confirms actual visual changes
    3. Contour extraction - finds changed regions
    """

    def __init__(self, threshold: float = 0.95, min_area: int = 100,
                 phash_threshold: int = 5, use_fast_gate: bool = True):
        """
        Args:
            threshold: SSIM threshold (0-1). Lower = more sensitive.
            min_area: Minimum pixel area for change contours.
            phash_threshold: Hamming distance threshold for pHash gate.
            use_fast_gate: Whether to use pHash pre-filtering.
        """
        self.threshold = threshold
        self.min_area = min_area
        self.prev_frame: np.ndarray | None = None

        # Fast gate (pHash)
        self.fast_gate = FastGate(threshold=phash_threshold) if use_fast_gate else None

        # Stats
        self.ssim_calls = 0
        self.ssim_bypassed = 0

    def set_threshold(self, threshold: float) -> None:
        """Dynamically adjust the SSIM change threshold."""
        self.threshold = threshold

    def detect(self, frame: Image.Image) -> ChangeResult | None:
        """Compare frame to previous. Returns ChangeResult if significant change.

        Uses multi-level detection:
        1. pHash fast gate (if enabled) - quick rejection of unchanged frames
        2. SSIM computation - precise measurement of visual similarity
        3. Contour extraction - identifies changed screen regions
        """
        # Level 1: pHash fast gate
        phash_distance = 0
        if self.fast_gate:
            should_continue, phash_distance = self.fast_gate.check(frame)
            if not should_continue:
                self.ssim_bypassed += 1
                return None

        # Level 2: SSIM verification
        gray = np.array(frame.convert("L"))

        if self.prev_frame is None:
            self.prev_frame = gray
            return None

        if gray.shape != self.prev_frame.shape:
            self.prev_frame = gray
            if self.fast_gate:
                self.fast_gate.reset()
            return None

        self.ssim_calls += 1
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
            phash_distance=phash_distance,
        )

    def get_stats(self) -> dict:
        """Get detection statistics."""
        stats = {
            "ssim_calls": self.ssim_calls,
            "ssim_bypassed": self.ssim_bypassed,
        }
        if self.fast_gate:
            stats.update({
                "phash_checked": self.fast_gate.frames_checked,
                "phash_rejected": self.fast_gate.frames_rejected,
                "phash_rejection_rate": f"{self.fast_gate.rejection_rate:.1f}%",
            })
        return stats
