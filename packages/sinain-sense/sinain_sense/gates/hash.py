"""Event-driven scene-change gating (from ARSinain, port of ISinain SceneGate.swift).

Cheap per-frame classification (blur / brightness / perceptual dHash) so the
expensive vision call only fires when the scene meaningfully changes.
Requires the `hash` extra (OpenCV); the import is lazy.
"""
import time


def _dhash(gray, size=8):
    import cv2
    small = cv2.resize(gray, (size + 1, size), interpolation=cv2.INTER_AREA)
    bits = 0
    for row in (small[:, 1:] > small[:, :-1]):
        for v in row:
            bits = (bits << 1) | int(v)
    return bits


def _hamming(a, b):
    return bin(a ^ b).count("1")


class SceneGate:
    """Returns ('scene'|'motion'|'ambient'|'drop', reason). Only non-drop fires inference."""

    def __init__(self, blur_min=18, bright_min=20, bright_max=240,
                 dup_dist=5, scene_dist=15, scene_cd=1.2, motion_cd=2.0):
        self.blur_min, self.bright_min, self.bright_max = blur_min, bright_min, bright_max
        self.dup_dist, self.scene_dist = dup_dist, scene_dist
        self.scene_cd, self.motion_cd = scene_cd, motion_cd
        self.last_hash = None
        self.last_emit = 0.0

    def classify(self, bgr):
        import cv2
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        if cv2.Laplacian(gray, cv2.CV_64F).var() < self.blur_min:
            return "drop", "blur"
        b = gray.mean()
        if b < self.bright_min or b > self.bright_max:
            return "drop", "exposure"
        h, now = _dhash(gray), time.monotonic()
        if self.last_hash is None:
            self.last_hash, self.last_emit = h, now
            return "scene", "first frame"
        dist = _hamming(h, self.last_hash)
        # Unchanged vs the LAST ANALYZED scene -> drop (no model call, no heartbeat).
        # Do NOT advance the reference here: keep it anchored to the last emitted scene
        # so accumulated drift as you pan to a new object eventually crosses the
        # threshold and re-fires. (Advancing per-frame made the gate compare
        # frame-to-frame, so gradual moves never triggered and the marker stuck.)
        if dist < self.dup_dist:
            return "drop", "unchanged"
        if dist > self.scene_dist and now - self.last_emit > self.scene_cd:
            self.last_hash, self.last_emit = h, now
            return "scene", "major change"
        if now - self.last_emit > self.motion_cd:
            self.last_hash, self.last_emit = h, now
            return "motion", "change"
        return "drop", "cooldown"
