"""Scene change detection + frame classification with adaptive cooldowns.

Inspired by sense_client's DecisionGate and ChangeDetector, but adapted for
physical-world scene awareness instead of screen OCR. Combines SSIM, histogram
comparison, motion estimation, text region hints, and blur rejection into a
single classification pipeline.
"""

from __future__ import annotations

import logging
import time
from collections import deque

import cv2
import numpy as np

from .protocol import FrameClass

log = logging.getLogger(__name__)

# Downscale resolution for SSIM / motion classification.
# 320x180 is 16× fewer pixels than 1280x720 — drops SSIM peak memory
# from ~70 MB (float64) to ~2 MB (float32).  Classification accuracy is
# unaffected because SSIM/motion only need structural similarity, not detail.
_CLASSIFY_SIZE = (320, 180)


class SceneGate:
    """Classifies camera frames and gates sends via adaptive cooldowns.

    Classification priority (highest to lowest):
        1. Blur rejection → DROP
        2. No change (high SSIM + low motion) → DROP
        3. Major scene change (low SSIM) → SCENE
        4. Text regions detected with change → TEXT
        5. Sustained motion → MOTION
        6. Periodic heartbeat timer → AMBIENT
        7. Default → DROP
    """

    def __init__(self, config: dict):
        cam = config.get("camera", {})
        self.scene_threshold = cam.get("scene_threshold", 0.80)
        self.stable_threshold = cam.get("stable_threshold", 0.90)
        self.motion_threshold = cam.get("motion_threshold", 8.0)
        self.blur_threshold = cam.get("blur_threshold", 50)
        self.text_cooldown = cam.get("text_cooldown", 5)
        self.motion_cooldown = cam.get("motion_cooldown", 3)
        self.ambient_interval = cam.get("ambient_interval", 30)

        # State
        self._prev_gray: np.ndarray | None = None
        self._last_send: dict[FrameClass, float] = {}
        self._last_ambient = 0.0
        self._sent_hists: deque[np.ndarray] = deque(maxlen=3)
        self._scene_active_until = 0.0  # Sensitive period after SCENE event

    def classify(self, frame: np.ndarray) -> tuple[FrameClass, dict]:
        """Classify a BGR frame. Returns (classification, metadata).

        Metadata dict contains: ssim, motion_pct, text_hint_count, blur_var,
        motion_bbox, change_bbox, text_bboxes
        """
        now = time.time()
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # --- Blur rejection (full-res for accuracy) ---
        blur_var = cv2.Laplacian(gray, cv2.CV_64F).var()
        if blur_var < self.blur_threshold:
            return FrameClass.DROP, {"blur_var": blur_var, "reason": "blurry"}

        # Downscaled greyscale for SSIM / motion (saves ~68 MB per frame)
        small = cv2.resize(gray, _CLASSIFY_SIZE,
                           interpolation=cv2.INTER_AREA)

        # --- First frame: always send as SCENE ---
        if self._prev_gray is None:
            self._prev_gray = small
            self._last_ambient = now
            text_hints, text_bboxes = self._count_text_regions(gray)
            return FrameClass.SCENE, self._meta(
                1.0, 0.0, text_hints, blur_var,
                text_bboxes=text_bboxes)

        # --- Change detection metrics ---
        ssim, ssim_map = self._compute_ssim(small, self._prev_gray)
        motion_pct, motion_mask = self._compute_motion(small, self._prev_gray)
        # MSER needs full-res detail for reliable text region detection
        text_hints, text_bboxes = self._count_text_regions(gray)

        # Spatial bounding boxes (on their respective coordinate spaces)
        motion_bbox = self._bbox_from_mask(motion_mask)
        change_bbox = self._bbox_from_mask(
            ((ssim_map < 0.5).astype(np.uint8) * 255))

        meta = self._meta(
            ssim, motion_pct, text_hints, blur_var,
            motion_bbox=motion_bbox,
            change_bbox=change_bbox,
            text_bboxes=text_bboxes)

        # --- No change: high SSIM + low motion ---
        if ssim > self.stable_threshold and motion_pct < 2.0:
            # Check ambient heartbeat
            if now - self._last_ambient >= self.ambient_interval:
                if not self._is_hist_duplicate(small):
                    self._accept(small, now, FrameClass.AMBIENT)
                    return FrameClass.AMBIENT, meta
            return FrameClass.DROP, meta

        # --- Major scene change ---
        if ssim < self.scene_threshold:
            if not self._in_cooldown(FrameClass.SCENE, now, 2.0):
                self._accept(small, now, FrameClass.SCENE)
                self._scene_active_until = now + 10.0
                return FrameClass.SCENE, meta

        # --- Text regions with change ---
        if text_hints > 5 and ssim < self.stable_threshold:
            if not self._in_cooldown(FrameClass.TEXT, now, self.text_cooldown):
                self._accept(small, now, FrameClass.TEXT)
                return FrameClass.TEXT, meta

        # --- Sustained motion ---
        if motion_pct > self.motion_threshold:
            if not self._in_cooldown(FrameClass.MOTION, now, self.motion_cooldown):
                self._accept(small, now, FrameClass.MOTION)
                return FrameClass.MOTION, meta

        # --- Ambient heartbeat (for moderate changes that didn't meet above) ---
        if now - self._last_ambient >= self.ambient_interval:
            if not self._is_hist_duplicate(small):
                self._accept(small, now, FrameClass.AMBIENT)
                return FrameClass.AMBIENT, meta

        return FrameClass.DROP, meta

    def _accept(self, gray: np.ndarray, now: float, cls: FrameClass) -> None:
        """Update state when a frame is accepted for sending."""
        self._prev_gray = gray
        self._last_send[cls] = now
        if cls == FrameClass.AMBIENT:
            self._last_ambient = now
        # Store histogram for dedup
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        self._sent_hists.append(hist)

    def _in_cooldown(self, cls: FrameClass, now: float,
                     cooldown: float) -> bool:
        """Check if we're still in cooldown for this classification."""
        last = self._last_send.get(cls, 0.0)
        # Shorter cooldown during active scene period
        if self._scene_active_until > now and cls != FrameClass.SCENE:
            cooldown = min(cooldown, 2.0)
        return (now - last) < cooldown

    def _compute_ssim(self, a: np.ndarray, b: np.ndarray
                      ) -> tuple[float, np.ndarray]:
        """Simplified SSIM. Returns (mean_score, ssim_map)."""
        c1 = (0.01 * 255) ** 2
        c2 = (0.03 * 255) ** 2

        a_f = a.astype(np.float32)
        b_f = b.astype(np.float32)

        mu_a = cv2.GaussianBlur(a_f, (11, 11), 1.5)
        mu_b = cv2.GaussianBlur(b_f, (11, 11), 1.5)

        mu_a_sq = mu_a ** 2
        mu_b_sq = mu_b ** 2
        mu_ab = mu_a * mu_b

        sigma_a_sq = cv2.GaussianBlur(a_f ** 2, (11, 11), 1.5) - mu_a_sq
        sigma_b_sq = cv2.GaussianBlur(b_f ** 2, (11, 11), 1.5) - mu_b_sq
        sigma_ab = cv2.GaussianBlur(a_f * b_f, (11, 11), 1.5) - mu_ab

        num = (2 * mu_ab + c1) * (2 * sigma_ab + c2)
        den = (mu_a_sq + mu_b_sq + c1) * (sigma_a_sq + sigma_b_sq + c2)

        ssim_map = num / den
        return float(ssim_map.mean()), ssim_map

    def _compute_motion(self, a: np.ndarray, b: np.ndarray
                        ) -> tuple[float, np.ndarray]:
        """Returns (motion_pct, binary_mask) of significant change."""
        diff = cv2.absdiff(a, b)
        _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
        changed = np.count_nonzero(thresh)
        total = thresh.shape[0] * thresh.shape[1]
        return (changed / total) * 100.0, thresh

    def _count_text_regions(self, gray: np.ndarray
                           ) -> tuple[int, list[tuple[int, int, int, int]]]:
        """Text presence hint via MSER. Returns (count, [(x,y,w,h)...])."""
        try:
            mser = cv2.MSER_create()
            regions, _ = mser.detectRegions(gray)
            bboxes = [cv2.boundingRect(r) for r in regions]
            return len(regions), bboxes
        except Exception:
            return 0, []

    @staticmethod
    def _bbox_from_mask(mask: np.ndarray) -> tuple[int, int, int, int] | None:
        """Convert a binary mask to a single merged bounding box (x,y,w,h)."""
        mask_u8 = mask.astype(np.uint8)
        if mask_u8.max() == 0:
            return None
        contours, _ = cv2.findContours(
            mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        # Merge all contours into one bounding rect
        all_pts = np.concatenate(contours)
        return cv2.boundingRect(all_pts)

    def _is_hist_duplicate(self, gray: np.ndarray) -> bool:
        """Check if frame histogram is too similar to recently sent frames."""
        if not self._sent_hists:
            return False
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        for sent_hist in self._sent_hists:
            similarity = cv2.compareHist(hist, sent_hist, cv2.HISTCMP_CHISQR)
            if similarity < 5.0:  # Very similar histograms
                return True
        return False

    @staticmethod
    def _meta(ssim: float, motion_pct: float, text_hints: int,
              blur_var: float, *,
              motion_bbox: tuple[int, int, int, int] | None = None,
              change_bbox: tuple[int, int, int, int] | None = None,
              text_bboxes: list[tuple[int, int, int, int]] | None = None,
              ) -> dict:
        return {
            "ssim": round(ssim, 3),
            "motion_pct": round(motion_pct, 1),
            "text_hint_count": text_hints,
            "blur_var": round(blur_var, 1),
            "motion_bbox": motion_bbox,
            "change_bbox": change_bbox,
            "text_bboxes": text_bboxes or [],
        }
