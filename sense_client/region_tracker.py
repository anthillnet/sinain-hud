"""Region stability tracking for smart change detection.

Divides the screen into a grid and tracks which regions are stable (toolbars,
status bars) vs dynamic (editor, terminal). This reduces unnecessary processing
of known-static regions.
"""

import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from PIL import Image

try:
    import imagehash
    HASH_AVAILABLE = True
except ImportError:
    imagehash = None
    HASH_AVAILABLE = False


@dataclass
class RegionStats:
    """Statistics for a screen region."""
    last_hash: Optional[str] = None
    last_change_ts: float = 0.0
    change_count: int = 0
    stability_score: float = 0.0  # 0 = dynamic, 1 = stable


@dataclass
class ChangedRegion:
    """A region that has changed."""
    index: int  # Grid index (0-255 for 16x16)
    row: int
    col: int
    bbox: tuple[int, int, int, int]  # (x, y, w, h) in pixels
    is_stable: bool  # Whether this is normally a stable region


class RegionTracker:
    """Tracks stable vs dynamic screen regions using a grid-based approach.

    The screen is divided into a grid (default 16x16 = 256 cells). Each cell
    is tracked independently. Regions that haven't changed in a while are
    marked as stable and can be deprioritized in OCR and analysis.

    Benefits:
    - Skip OCR on static UI elements (toolbars, status bars)
    - Focus analysis on dynamic content areas
    - Reduce false positives from minor UI fluctuations
    """

    def __init__(self, grid_size: int = 16, stability_threshold_s: float = 30.0,
                 stability_min_samples: int = 5):
        """
        Args:
            grid_size: Number of cells per dimension (grid_size x grid_size).
            stability_threshold_s: Seconds without change to consider stable.
            stability_min_samples: Minimum samples before marking stable.
        """
        self.grid_size = grid_size
        self.stability_threshold_s = stability_threshold_s
        self.stability_min_samples = stability_min_samples

        # Grid state: dict[index] -> RegionStats
        self.grid: dict[int, RegionStats] = {}

        # Frame dimensions (updated on each analyze call)
        self.frame_width = 0
        self.frame_height = 0
        self.cell_width = 0
        self.cell_height = 0

        # Stats
        self.total_analyses = 0
        self.stable_regions_skipped = 0

    def _compute_region_hash(self, region: Image.Image) -> str:
        """Compute a fast hash for a region."""
        if HASH_AVAILABLE:
            # Use average hash for speed (faster than pHash for small regions)
            return str(imagehash.average_hash(region, hash_size=4))
        else:
            # Fallback: simple pixel mean/std signature
            arr = np.array(region.convert("L"))
            return f"{arr.mean():.1f}_{arr.std():.1f}"

    def _get_cell_bbox(self, index: int) -> tuple[int, int, int, int]:
        """Get pixel bounding box for a grid cell."""
        row = index // self.grid_size
        col = index % self.grid_size
        x = col * self.cell_width
        y = row * self.cell_height
        return (x, y, self.cell_width, self.cell_height)

    def analyze(self, frame: Image.Image, skip_stable: bool = True) -> list[ChangedRegion]:
        """Analyze frame and return list of changed regions.

        Args:
            frame: PIL Image to analyze.
            skip_stable: If True, don't report changes in stable regions.

        Returns:
            List of ChangedRegion objects for regions that have changed.
        """
        self.total_analyses += 1
        now = time.time()

        # Update dimensions if needed
        if frame.width != self.frame_width or frame.height != self.frame_height:
            self.frame_width = frame.width
            self.frame_height = frame.height
            self.cell_width = frame.width // self.grid_size
            self.cell_height = frame.height // self.grid_size

        changed_regions: list[ChangedRegion] = []

        for row in range(self.grid_size):
            for col in range(self.grid_size):
                index = row * self.grid_size + col

                # Extract region
                x = col * self.cell_width
                y = row * self.cell_height
                region = frame.crop((x, y, x + self.cell_width, y + self.cell_height))

                # Compute hash
                current_hash = self._compute_region_hash(region)

                # Get or create region stats
                if index not in self.grid:
                    self.grid[index] = RegionStats(last_hash=current_hash, last_change_ts=now)
                    continue

                stats = self.grid[index]

                # Check if changed
                if stats.last_hash != current_hash:
                    # Update stats
                    stats.last_hash = current_hash
                    stats.last_change_ts = now
                    stats.change_count += 1

                    # Reset stability score on change
                    stats.stability_score = max(0, stats.stability_score - 0.2)

                    # Check if this is normally a stable region
                    is_stable = stats.stability_score > 0.5

                    if is_stable and skip_stable:
                        self.stable_regions_skipped += 1
                        continue

                    changed_regions.append(ChangedRegion(
                        index=index,
                        row=row,
                        col=col,
                        bbox=(x, y, self.cell_width, self.cell_height),
                        is_stable=is_stable,
                    ))
                else:
                    # No change - increase stability score
                    time_since_change = now - stats.last_change_ts
                    if time_since_change > self.stability_threshold_s:
                        if stats.change_count >= self.stability_min_samples:
                            stats.stability_score = min(1.0, stats.stability_score + 0.1)

        return changed_regions

    def get_dynamic_regions(self) -> list[int]:
        """Get indices of regions that are dynamic (not stable)."""
        return [
            idx for idx, stats in self.grid.items()
            if stats.stability_score < 0.5
        ]

    def get_stable_regions(self) -> list[int]:
        """Get indices of regions that are stable."""
        return [
            idx for idx, stats in self.grid.items()
            if stats.stability_score >= 0.5
        ]

    def get_region_bbox(self, index: int) -> tuple[int, int, int, int]:
        """Get pixel bounding box for a region index."""
        return self._get_cell_bbox(index)

    def merge_adjacent_regions(self, regions: list[ChangedRegion]) -> list[tuple[int, int, int, int]]:
        """Merge adjacent changed regions into larger bounding boxes.

        Returns list of merged (x, y, w, h) bounding boxes.
        """
        if not regions:
            return []

        # Build a set of changed indices for fast lookup
        changed_indices = {r.index for r in regions}

        # Group adjacent regions using flood fill
        visited = set()
        merged_bboxes = []

        for region in regions:
            if region.index in visited:
                continue

            # Flood fill to find connected region
            group = []
            stack = [region.index]
            while stack:
                idx = stack.pop()
                if idx in visited or idx not in changed_indices:
                    continue
                visited.add(idx)
                group.append(idx)

                # Check 4-connected neighbors
                row = idx // self.grid_size
                col = idx % self.grid_size
                neighbors = []
                if row > 0:
                    neighbors.append(idx - self.grid_size)
                if row < self.grid_size - 1:
                    neighbors.append(idx + self.grid_size)
                if col > 0:
                    neighbors.append(idx - 1)
                if col < self.grid_size - 1:
                    neighbors.append(idx + 1)
                stack.extend(neighbors)

            # Compute merged bbox
            if group:
                min_row = min(idx // self.grid_size for idx in group)
                max_row = max(idx // self.grid_size for idx in group)
                min_col = min(idx % self.grid_size for idx in group)
                max_col = max(idx % self.grid_size for idx in group)

                x = min_col * self.cell_width
                y = min_row * self.cell_height
                w = (max_col - min_col + 1) * self.cell_width
                h = (max_row - min_row + 1) * self.cell_height
                merged_bboxes.append((x, y, w, h))

        return merged_bboxes

    def get_stats(self) -> dict:
        """Get tracking statistics."""
        stable_count = len(self.get_stable_regions())
        dynamic_count = len(self.get_dynamic_regions())
        total = len(self.grid)

        return {
            "total_regions": total,
            "stable_regions": stable_count,
            "dynamic_regions": dynamic_count,
            "stable_pct": f"{stable_count / total * 100:.1f}%" if total > 0 else "0%",
            "total_analyses": self.total_analyses,
            "stable_skipped": self.stable_regions_skipped,
        }

    def reset(self) -> None:
        """Reset all tracking state."""
        self.grid.clear()
        self.frame_width = 0
        self.frame_height = 0
