"""Scene gates — "is this frame worth an LLM call?"

Two strategies, one convention: a gate is a stateful object fed frames in
capture order; its verdict decides whether downstream OCR/vision spend fires.

- `ssim.ChangeDetector` (from sinain-hud sense_client): SSIM keyframe diff with
  changed-region bboxes — precise, heavier (numpy + scikit-image, the `ssim`
  extra). `detect(frame) -> ChangeResult | None`.
- `hash.SceneGate` (from ARSinain, port of ISinain SceneGate.swift): blur /
  exposure / perceptual-dHash with cooldowns — cheap, per-frame (OpenCV, the
  `hash` extra). `classify(bgr) -> (verdict, reason)`.

Heavy deps import lazily inside each module so the base package stays light.
"""
