# Reverted OCR Optimization Layers

## Summary

On 2026-02-11, commit `6db1a8a` ("feat: add adaptive capture, OCR optimization,
and semantic context pipeline") introduced five new modules and modified five
existing files in `sense_client/`. The changes aimed to reduce OCR calls by ~80%
and agent token usage by ~70% through caching, pre-filtering, region tracking,
activity classification, and structured context output.

**The optimizations degraded text recognition quality.** Whole categories of
on-screen text were missed, stale results were returned for changing content,
and the agent lost access to raw OCR output. The entire `sense_client/`
directory was reverted to its `fcfee8a` state in commit `ac70e39` ("revert:
restore sense_client to pre-optimization state") the same day.

The `sinain-core/` changes from that commit (sense-buffer, escalation
improvements, task store) were **not** reverted — only the capture pipeline.

---

## Reverted Modules

### `ocr_cache.py` — LRU cache for OCR results

**Approach:** Cache OCR results keyed on a perceptual content hash of image
regions. On a cache hit, return the stored OCR text instead of re-running
Tesseract. Supported two hash methods: `"content"` (perceptual, default) and
`"pixel"` (exact). LRU eviction with a default capacity of 1000 entries.

**Why it regressed:** The perceptual hash (`"content"` mode) was too
aggressive — visually similar but textually different regions produced hash
collisions. For example, two lines of code with the same visual weight but
different variable names could hash identically, returning stale cached text
for the second line. The `"pixel"` mode avoided this but had near-zero hit
rate, defeating the purpose.

**Lessons:**
- Perceptual hashing is useful for duplicate-image detection but unreliable for
  text content identity — small visual differences often mean entirely different
  text.
- A safer approach: cache keyed on *exact pixel hash* of the cropped region
  (e.g., SHA-256 of raw pixel bytes). Hit rate will be lower but correctness is
  preserved. Combine with region stability tracking to only re-OCR regions that
  actually changed.

---

### `text_detector.py` — Heuristic pre-filter for text regions

**Approach:** Score screen regions on three visual signals — horizontal edge
density (letter baselines), contrast ratio, and pattern regularity — to
determine likelihood of containing text. Regions scoring below a configurable
threshold (default 0.4) were skipped entirely, avoiding unnecessary OCR calls.

**Why it regressed:** False negatives. The heuristics were tuned for
conventional dark-on-light text and missed:
- Light-colored text on dark backgrounds (terminal themes, dark mode IDEs)
- Code with low contrast (syntax highlighting with muted colors)
- Small or thin fonts that produced weak edge signals

Skipping these regions meant the agent received incomplete screen content.

**Lessons:**
- A pre-filter that can *silently drop real text* is too dangerous for a
  pipeline that depends on OCR completeness. Any false negative is worse than
  the OCR cost saved.
- If re-attempting: use the detector only as a *prioritization hint* (OCR
  high-confidence regions first) rather than a hard gate. Never skip a region
  entirely based on heuristics alone.
- Alternatively, use a lightweight ML text detector (e.g., EAST or CRAFT) that
  generalizes better than hand-tuned heuristics.

---

### `region_tracker.py` — Grid-based stability tracking

**Approach:** Divide the screen into a 16×16 grid (256 cells). Track each
cell's perceptual hash over time and compute a stability score. Cells that
haven't changed for >30 seconds (configurable) with ≥5 samples are marked
"stable" and deprioritized in OCR processing. Required the `imagehash` package.

**Why it regressed:** The stability detection was too eager. Regions were
classified as stable after only a brief quiet period, but real content often
pauses and then resumes changing (e.g., a user reads for 30 seconds then starts
typing again). Once marked stable, those regions were silently skipped, causing
the agent to miss new content until the stability score decayed.

**Lessons:**
- Stability thresholds need hysteresis — it should take much longer to mark a
  region stable than to mark it active again. A single change should immediately
  revoke stable status.
- The 16×16 grid granularity was too coarse for code editors where a single cell
  could span both static line numbers and dynamic code content.
- Region tracking can still be valuable but should only reduce OCR *frequency*
  for stable regions, never skip them entirely. Even "stable" regions should be
  re-OCR'd periodically (e.g., every 5th frame).

---

### `semantic.py` — Activity classification + delta encoding

**Approach:** Classify the user's current activity (typing, scrolling,
navigation, reading, error, loading, idle) from visual change signals. Then
delta-encode text changes — instead of sending full OCR text each frame, compute
a diff and send only additions/removals/modifications. This reduced token usage
by an estimated 70%.

**Why it regressed:** Delta encoding broke the agent's ability to understand
screen context. The agent received diffs like `+  const x = 5` / `- const x = 4`
instead of the full visible text, losing surrounding context. When the
baseline text drifted (due to accumulated diff errors or missed frames), the
deltas became meaningless. Activity classification itself was not harmful, but
the delta encoding that depended on it was.

**Lessons:**
- The agent needs full text context to reason about what's on screen. Delta
  encoding optimizes the wrong layer — token reduction should happen in the
  agent's context window management, not in the capture pipeline.
- Activity classification is still potentially useful as *metadata* (e.g., the
  agent knowing "the user is scrolling" vs "the user is typing") but must not
  gate or transform the OCR output itself.
- If re-attempting delta encoding: always include enough surrounding context to
  be self-contained, and send full snapshots periodically to reset drift.

---

### `context_builder.py` — Structured JSON context

**Approach:** Replace raw OCR text with a structured JSON payload containing
activity type, text deltas, visible summary, cursor line, error/unsaved flags,
and token estimates. Maintained a rolling history of up to 30 semantic snapshots
for the agent to query.

**Why it regressed:** Depended entirely on `semantic.py` for input. Inherited
all its delta-encoding issues, and additionally lost raw text fidelity by
summarizing visible content. The structured format was also tightly coupled to
the agent's expected input format — any mismatch between the context builder's
output schema and the agent's parsing logic caused silent data loss.

**Lessons:**
- Structured context is a good idea *in principle* but must be built on reliable
  inputs. When the underlying semantic layer drifts, the structured output
  amplifies rather than contains errors.
- The raw OCR text should always be available as a fallback or alongside
  structured data — never replace it entirely.
- Schema changes between the capture pipeline and agent must be versioned to
  avoid silent incompatibilities.

---

## Modified Files (Also Reverted)

These existing files were modified to integrate the five new modules and were
reverted along with them:

| File | Changes | Why reverted |
|------|---------|--------------|
| `__main__.py` | Rewired the capture loop to route frames through `TextDetector` → `RegionTracker` → `OCRCache` → `SemanticBuilder` → `ContextBuilder` before sending | The entire optimized pipeline was removed; capture loop restored to direct OCR → send |
| `change_detector.py` | Added region-aware change detection using `RegionTracker`; pHash-based fast gate for skipping unchanged regions | Region tracking caused missed changes; pHash gate too aggressive |
| `config.py` | Added config sections for `regions`, `textDetection`, `semantic`, and new keys in `diff`/`ocr`/`sender` blocks; added `get_default_config()` | Config knobs for removed modules; no longer needed |
| `sender.py` | Replaced raw OCR text payload with structured semantic/context JSON; added WebSocket transport alongside HTTP | Structured payloads lost text fidelity; WebSocket transport was an unrelated change bundled in |
| `requirements.txt` | Added `imagehash>=4.3` and `websockets>=12.0` | Dependencies for removed modules |

---

## Recommendations for Re-Attempting

1. **Never drop raw OCR text.** Any optimization layer (caching, filtering,
   delta encoding) must preserve the full OCR output as ground truth. Optimized
   representations should be *additive*, not *replacing*.

2. **Introduce one layer at a time.** The original commit introduced all five
   modules simultaneously, making it impossible to isolate which layer caused
   the regression. Each optimization should be a separate, independently
   toggleable change with its own validation.

3. **Validate against a ground-truth corpus.** Before merging any OCR
   optimization, run the pipeline against a set of known screenshots with
   expected OCR output. Compare precision and recall — any drop in recall
   (missed text) is a regression, even if precision improves.

4. **Prefer frequency reduction over skipping.** Instead of *not* OCR-ing a
   region at all, reduce how often stable regions are OCR-ed (e.g., every 5th
   frame instead of every frame). This preserves correctness while still
   reducing CPU load.

5. **Cache on exact content, not perceptual hash.** Use pixel-exact hashes
   (SHA-256 of raw region bytes) for OCR caching. The hit rate will be lower
   than perceptual hashing but eliminates false cache hits that return wrong
   text.

6. **Keep optimization layers optional.** Use feature flags (config knobs) with
   all optimizations disabled by default. This allows gradual rollout and easy
   rollback without full directory reverts.

7. **Activity classification is safe as metadata.** Classifying user activity
   (typing, scrolling, reading) adds useful signal for the agent without
   modifying OCR output. Re-introduce this independently of delta encoding.

---

## Camera Conflict Constraint (2026-02-14, commit `44e7f6d`)

Any future capture optimization must respect the **macOS CoreMediaIO contention
constraint**: continuous screen capture at high frame rates blocks the FaceTime
camera for other apps (e.g., Google Meet). This was diagnosed and fixed across
three layers:

### Root Cause

On macOS 14+ (Sonoma/Sequoia), three capture-related subsystems independently
contribute to CoreMediaIO resource exhaustion:

| Subsystem | Mechanism | Impact |
|-----------|-----------|--------|
| **sox `rec`** (audio capture) | CoreAudio HAL device enumeration triggers CoreMediaIO initialization as a side effect (shared IOKit/DriverKit infrastructure) | Camera blocked on sinain-core startup |
| **`screencapture` CLI** (screen capture) | On macOS 14+, `screencapture` uses ScreenCaptureKit internally, which initializes CoreMediaIO | Camera blocked whenever sense_client runs |
| **Capture rate >0.5 FPS** | Continuous `CGDisplayCreateImage` calls saturate IOSurface/GPU resources shared between screen capture and camera hardware | Camera blocked even with CoreGraphics-only capture |

### Fixes Applied

1. **Audio capture**: Switched from sox to ffmpeg with `"none:<device>"` format.
   The `none` prefix tells AVFoundation to skip video device enumeration entirely,
   avoiding CoreMediaIO initialization. Changed in `sinain-core/src/audio/pipeline.ts`
   and `sinain-core/src/config.ts` (default: `"ffmpeg"`).

2. **Screen capture**: Replaced `screencapture` CLI with `CGDisplayCreateImage`
   via PyObjC Quartz. This uses the CoreGraphics → IOSurface path, bypassing
   ScreenCaptureKit and CoreMediaIO. Changed in `sense_client/capture.py`.

3. **Capture rate**: Reduced default FPS from 10 to 0.5 (one frame every 2s).
   This is sufficient because the sense gate cooldown is 5s (`gate.cooldownMs`)
   and adaptive cooldown is 2s (`gate.adaptiveCooldownMs`). Changed in
   `sense_client/config.py`.

4. **Dead code removal**: Deleted `overlay/macos/Runner/ScreenCapturePlugin.swift`
   and its `CaptureEngine` singleton. This ScreenCaptureKit-based plugin was
   registered at overlay launch but never called from Dart — zero references to
   the `sinain_hud/screen_capture` MethodChannel existed in `overlay/lib/`.

### Constraints for Future Optimization

- **Capture FPS ceiling**: Do not exceed ~0.5 FPS for continuous screen capture
  without verifying camera access. The threshold may vary by macOS version and
  hardware. The safe range is ≤0.2 FPS (every 5s); 2 FPS is confirmed to block
  the camera on macOS 15.2 / Apple Silicon.

- **Avoid `screencapture` CLI**: Always use `CGDisplayCreateImage` (Quartz) for
  screen capture. The `screencapture` binary uses ScreenCaptureKit internally on
  macOS 14+ and will block the camera regardless of rate.

- **Avoid sox for audio**: Use ffmpeg with explicit `"none:<device>"` input
  format. Sox's CoreAudio HAL initialization enumerates all system devices,
  triggering CoreMediaIO as a side effect.

- **Adaptive capture must respect the ceiling**: If re-introducing adaptive FPS
  (burst on activity, idle on stability), the burst rate must stay ≤0.5 FPS.
  The previous `ScreenCapturePlugin` had burst rates up to 30 FPS — this is
  incompatible with camera coexistence.

- **Test with Google Meet**: Any capture pipeline change should be validated by
  running the full stack (`./start.sh`) and confirming Google Meet can access
  the FaceTime camera simultaneously.
