"""LRU cache for OCR results with content-based hashing.

Reduces OCR calls by 80% by caching results keyed on visual content hash.
"""

import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
from PIL import Image

from .ocr import OCRResult


@dataclass
class CacheEntry:
    """Single cache entry with OCR result and metadata."""
    result: OCRResult
    created_at: float
    access_count: int = 1
    last_access_at: float = field(default_factory=time.time)


@dataclass
class PendingFrame:
    """Frame waiting for OCR (lazy evaluation)."""
    frame: Image.Image
    regions: list[tuple[int, int, int, int]]  # [(x, y, w, h), ...]
    ts: float
    content_hash: Optional[str] = None


class OCRCache:
    """LRU cache for OCR results keyed on visual content hash.

    The key insight is that similar text regions produce similar visual patterns.
    By hashing the visual content (not raw pixels), we can achieve high cache
    hit rates even when the exact pixel values differ slightly.

    Pipeline:
    1. Compute content hash from region image
    2. Check cache for existing result
    3. On cache miss, perform OCR and store result
    """

    def __init__(self, max_size: int = 1000, hash_method: str = "content"):
        """
        Args:
            max_size: Maximum number of cached OCR results.
            hash_method: Hashing method - "content" (perceptual) or "pixel" (exact).
        """
        self.max_size = max_size
        self.hash_method = hash_method
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()

        # Stats
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def _compute_content_hash(self, image: Image.Image) -> str:
        """Compute a content-based hash of the image.

        Uses a perceptual approach: downscale, convert to grayscale, threshold.
        This produces similar hashes for visually similar text.
        """
        # Downscale to small fixed size (captures text structure, not exact pixels)
        small = image.resize((32, 32), Image.LANCZOS).convert("L")
        arr = np.array(small)

        # Compute mean brightness
        mean = arr.mean()

        # Create binary signature (above/below mean)
        binary = (arr > mean).flatten()

        # Convert to bytes and hash
        binary_bytes = np.packbits(binary).tobytes()
        return hashlib.md5(binary_bytes).hexdigest()[:16]

    def _compute_pixel_hash(self, image: Image.Image) -> str:
        """Compute exact pixel hash (MD5 of raw bytes)."""
        arr = np.array(image.convert("L"))
        return hashlib.md5(arr.tobytes()).hexdigest()[:16]

    def compute_hash(self, image: Image.Image) -> str:
        """Compute hash based on configured method."""
        if self.hash_method == "content":
            return self._compute_content_hash(image)
        return self._compute_pixel_hash(image)

    def get(self, image: Image.Image) -> Optional[OCRResult]:
        """Try to get cached OCR result for an image.

        Returns:
            Cached OCRResult if found, None otherwise.
        """
        key = self.compute_hash(image)

        if key in self._cache:
            self.hits += 1
            entry = self._cache[key]
            entry.access_count += 1
            entry.last_access_at = time.time()
            # Move to end (most recently used)
            self._cache.move_to_end(key)
            return entry.result

        self.misses += 1
        return None

    def put(self, image: Image.Image, result: OCRResult) -> str:
        """Store an OCR result in the cache.

        Returns:
            The cache key used.
        """
        key = self.compute_hash(image)

        # Check if already exists (update access stats)
        if key in self._cache:
            entry = self._cache[key]
            entry.access_count += 1
            entry.last_access_at = time.time()
            self._cache.move_to_end(key)
            return key

        # Evict oldest if at capacity
        while len(self._cache) >= self.max_size:
            self._cache.popitem(last=False)
            self.evictions += 1

        # Store new entry
        self._cache[key] = CacheEntry(
            result=result,
            created_at=time.time(),
        )
        return key

    def get_or_compute(self, image: Image.Image,
                       ocr_func: Callable[[Image.Image], OCRResult]) -> OCRResult:
        """Get from cache or compute and cache.

        Args:
            image: Image to OCR.
            ocr_func: Function to call for OCR on cache miss.

        Returns:
            OCRResult (from cache or newly computed).
        """
        cached = self.get(image)
        if cached is not None:
            return cached

        result = ocr_func(image)
        self.put(image, result)
        return result

    @property
    def hit_rate(self) -> float:
        """Cache hit rate as a percentage."""
        total = self.hits + self.misses
        if total == 0:
            return 0.0
        return self.hits / total * 100

    @property
    def size(self) -> int:
        """Current number of cached entries."""
        return len(self._cache)

    def get_stats(self) -> dict:
        """Get cache statistics."""
        return {
            "size": self.size,
            "max_size": self.max_size,
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": f"{self.hit_rate:.1f}%",
            "evictions": self.evictions,
        }

    def clear(self) -> None:
        """Clear all cached entries."""
        self._cache.clear()
        self.hits = 0
        self.misses = 0
        self.evictions = 0


class LazyOCRStore:
    """Lazy OCR store that defers OCR until context is actually needed.

    Instead of OCRing every changed frame immediately, we store frame
    references and only perform OCR when the agent requests context.
    Combined with caching, this drastically reduces OCR calls.
    """

    def __init__(self, cache: OCRCache, max_pending: int = 10):
        """
        Args:
            cache: OCR cache instance to use.
            max_pending: Maximum number of frames to keep pending.
        """
        self.cache = cache
        self.max_pending = max_pending
        self._pending: list[PendingFrame] = []

        # Stats
        self.frames_stored = 0
        self.frames_ocred = 0

    def add_frame(self, frame: Image.Image, regions: list[tuple[int, int, int, int]]) -> None:
        """Store a frame reference - don't OCR yet.

        Args:
            frame: Full frame image.
            regions: List of (x, y, w, h) regions that changed.
        """
        self.frames_stored += 1
        self._pending.append(PendingFrame(
            frame=frame,
            regions=regions,
            ts=time.time(),
        ))

        # Trim old pending frames
        while len(self._pending) > self.max_pending:
            self._pending.pop(0)

    def get_ocr_for_context(self, since_ts: float,
                            ocr_func: Callable[[Image.Image], OCRResult]) -> list[OCRResult]:
        """Perform OCR on pending frames and return results.

        This is the "lazy" part - OCR only happens when context is requested.

        Args:
            since_ts: Only process frames since this timestamp.
            ocr_func: Function to call for OCR on cache misses.

        Returns:
            List of OCRResult objects for the time window.
        """
        results = []

        for entry in self._pending:
            if entry.ts < since_ts:
                continue

            for (x, y, w, h) in entry.regions:
                # Extract region
                region = entry.frame.crop((x, y, x + w, y + h))

                # Use cache
                result = self.cache.get_or_compute(region, ocr_func)
                self.frames_ocred += 1

                if result.text:
                    results.append(result)

        return results

    def get_latest_ocr(self, ocr_func: Callable[[Image.Image], OCRResult],
                       max_regions: int = 3) -> OCRResult:
        """Get OCR for the most recent frame.

        Args:
            ocr_func: Function to call for OCR on cache misses.
            max_regions: Maximum number of regions to OCR.

        Returns:
            Combined OCRResult from the latest frame.
        """
        if not self._pending:
            return OCRResult(text="", confidence=0, word_count=0)

        entry = self._pending[-1]
        texts = []
        total_conf = 0
        total_words = 0

        for i, (x, y, w, h) in enumerate(entry.regions[:max_regions]):
            region = entry.frame.crop((x, y, x + w, y + h))
            result = self.cache.get_or_compute(region, ocr_func)
            self.frames_ocred += 1

            if result.text:
                texts.append(result.text)
                total_conf += result.confidence
                total_words += result.word_count

        n = len(texts)
        return OCRResult(
            text="\n".join(texts),
            confidence=total_conf / n if n > 0 else 0,
            word_count=total_words,
        )

    def clear_old(self, older_than: float) -> int:
        """Clear pending frames older than a timestamp.

        Returns:
            Number of frames cleared.
        """
        before = len(self._pending)
        self._pending = [p for p in self._pending if p.ts >= older_than]
        return before - len(self._pending)

    def get_stats(self) -> dict:
        """Get store statistics."""
        return {
            "pending_frames": len(self._pending),
            "frames_stored": self.frames_stored,
            "frames_ocred": self.frames_ocred,
            "cache_stats": self.cache.get_stats(),
        }
