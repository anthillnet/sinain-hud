"""Fast text region detection using visual heuristics.

Identifies likely text regions before OCR to skip non-text areas like
images, icons, and gradients. This reduces unnecessary OCR calls.
"""

from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image


@dataclass
class TextRegionScore:
    """Confidence score for a region being text."""
    edge_score: float  # 0-1: horizontal edge density
    contrast_score: float  # 0-1: contrast ratio
    pattern_score: float  # 0-1: text-like patterns
    final_score: float  # 0-1: combined likelihood
    is_text_likely: bool  # Above threshold


class TextDetector:
    """Fast heuristic-based text region detector.

    Uses visual characteristics of text to quickly identify likely text regions:
    1. Edge density: Text has dense horizontal edges (letter baselines)
    2. Contrast: Text has high contrast (dark on light or light on dark)
    3. Pattern regularity: Text has regular spacing patterns

    This is NOT OCR - it's a fast pre-filter to avoid running OCR on
    clearly non-text regions (images, icons, gradients).
    """

    def __init__(self, threshold: float = 0.4, min_size: tuple[int, int] = (32, 16)):
        """
        Args:
            threshold: Minimum score (0-1) to consider a region as text.
            min_size: Minimum (width, height) for a valid text region.
        """
        self.threshold = threshold
        self.min_size = min_size

        # Stats
        self.regions_checked = 0
        self.regions_accepted = 0
        self.regions_rejected = 0

    def _compute_edge_score(self, gray: np.ndarray) -> float:
        """Compute horizontal edge density score.

        Text has characteristic horizontal edges from letter baselines.
        """
        # Simple gradient approximation (faster than Sobel)
        vert_diff = np.abs(np.diff(gray.astype(np.int16), axis=0))

        # Horizontal edges are detected as strong vertical gradients
        edge_strength = vert_diff.mean() / 255.0

        # Text typically has edge strength in 0.05-0.25 range
        # Too low = uniform area, too high = noise/image
        if edge_strength < 0.02:
            return 0.0
        if edge_strength > 0.4:
            return max(0, 1.0 - (edge_strength - 0.4) * 2)

        # Normalize to 0-1 with peak around 0.1-0.2
        return min(1.0, edge_strength * 5)

    def _compute_contrast_score(self, gray: np.ndarray) -> float:
        """Compute contrast ratio score.

        Text typically has bimodal distribution (dark text on light, or vice versa).
        """
        # Compute histogram
        hist, _ = np.histogram(gray.flatten(), bins=16, range=(0, 256))
        hist = hist / hist.sum()

        # Check for bimodal distribution (text characteristic)
        # Find the two largest peaks
        sorted_indices = np.argsort(hist)[::-1]
        peak1_idx = sorted_indices[0]
        peak2_idx = sorted_indices[1]

        # Distance between peaks (higher = more contrast)
        peak_distance = abs(peak1_idx - peak2_idx)

        # Score based on peak distance (0-15 range for 16 bins)
        contrast_score = peak_distance / 15.0

        # Also check that both peaks are significant
        peak1_val = hist[peak1_idx]
        peak2_val = hist[peak2_idx]
        if peak2_val < 0.05:  # Second peak too weak
            contrast_score *= 0.5

        return contrast_score

    def _compute_pattern_score(self, gray: np.ndarray) -> float:
        """Compute text-like pattern regularity score.

        Text has regular spacing patterns (character widths, line heights).
        """
        # Compute row-wise variance (text lines have alternating high/low)
        row_means = gray.mean(axis=1)
        row_variance = row_means.var()

        # Text typically has variance in 100-2000 range
        if row_variance < 10:
            return 0.0  # Too uniform
        if row_variance > 5000:
            return 0.5  # Very noisy, might still be text

        # Normalize
        pattern_score = min(1.0, row_variance / 1000.0)

        return pattern_score

    def score_region(self, image: Image.Image) -> TextRegionScore:
        """Score a region for likelihood of containing text.

        Args:
            image: PIL Image of the region to check.

        Returns:
            TextRegionScore with individual and combined scores.
        """
        self.regions_checked += 1

        # Size check
        if image.width < self.min_size[0] or image.height < self.min_size[1]:
            self.regions_rejected += 1
            return TextRegionScore(
                edge_score=0, contrast_score=0, pattern_score=0,
                final_score=0, is_text_likely=False
            )

        # Convert to grayscale numpy array
        gray = np.array(image.convert("L"))

        # Compute individual scores
        edge = self._compute_edge_score(gray)
        contrast = self._compute_contrast_score(gray)
        pattern = self._compute_pattern_score(gray)

        # Weighted combination
        # Edge is most important (text always has edges)
        # Contrast is second (text always has contrast)
        # Pattern is supporting evidence
        final = edge * 0.4 + contrast * 0.4 + pattern * 0.2

        is_text = final >= self.threshold

        if is_text:
            self.regions_accepted += 1
        else:
            self.regions_rejected += 1

        return TextRegionScore(
            edge_score=edge,
            contrast_score=contrast,
            pattern_score=pattern,
            final_score=final,
            is_text_likely=is_text,
        )

    def is_text_region(self, image: Image.Image) -> bool:
        """Quick check if a region likely contains text.

        Args:
            image: PIL Image of the region.

        Returns:
            True if likely contains text, False otherwise.
        """
        return self.score_region(image).is_text_likely

    def find_text_regions(self, image: Image.Image,
                          grid_size: int = 8) -> list[tuple[int, int, int, int]]:
        """Find likely text regions in an image using grid search.

        Divides image into grid and checks each cell for text likelihood.
        Returns merged bounding boxes of likely text areas.

        Args:
            image: Full frame image.
            grid_size: Number of cells per dimension.

        Returns:
            List of (x, y, w, h) bounding boxes for text regions.
        """
        cell_w = image.width // grid_size
        cell_h = image.height // grid_size

        text_cells: list[tuple[int, int]] = []  # (row, col) of text cells

        for row in range(grid_size):
            for col in range(grid_size):
                x = col * cell_w
                y = row * cell_h
                cell = image.crop((x, y, x + cell_w, y + cell_h))

                if self.is_text_region(cell):
                    text_cells.append((row, col))

        # Merge adjacent cells
        return self._merge_cells(text_cells, cell_w, cell_h, grid_size)

    def _merge_cells(self, cells: list[tuple[int, int]],
                     cell_w: int, cell_h: int,
                     grid_size: int) -> list[tuple[int, int, int, int]]:
        """Merge adjacent text cells into bounding boxes."""
        if not cells:
            return []

        cell_set = set(cells)
        visited = set()
        boxes = []

        def flood_fill(start_row: int, start_col: int) -> list[tuple[int, int]]:
            """Find connected component."""
            group = []
            stack = [(start_row, start_col)]
            while stack:
                r, c = stack.pop()
                if (r, c) in visited or (r, c) not in cell_set:
                    continue
                visited.add((r, c))
                group.append((r, c))
                # 4-connected neighbors
                for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < grid_size and 0 <= nc < grid_size:
                        stack.append((nr, nc))
            return group

        for row, col in cells:
            if (row, col) in visited:
                continue
            group = flood_fill(row, col)
            if group:
                # Compute bbox
                min_row = min(r for r, c in group)
                max_row = max(r for r, c in group)
                min_col = min(c for r, c in group)
                max_col = max(c for r, c in group)

                x = min_col * cell_w
                y = min_row * cell_h
                w = (max_col - min_col + 1) * cell_w
                h = (max_row - min_row + 1) * cell_h
                boxes.append((x, y, w, h))

        # Sort by area (largest first)
        boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
        return boxes

    def get_stats(self) -> dict:
        """Get detection statistics."""
        total = self.regions_checked
        return {
            "regions_checked": total,
            "regions_accepted": self.regions_accepted,
            "regions_rejected": self.regions_rejected,
            "acceptance_rate": f"{self.regions_accepted / total * 100:.1f}%" if total > 0 else "0%",
        }

    def reset_stats(self) -> None:
        """Reset statistics."""
        self.regions_checked = 0
        self.regions_accepted = 0
        self.regions_rejected = 0
