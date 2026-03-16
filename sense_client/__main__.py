"""Entry point: python -m sense_client"""

import io
import sys
import traceback

# Force UTF-8 stdout/stderr on Windows to prevent UnicodeEncodeError crashes
# when window titles contain non-cp1251 characters (e.g. Telegram's \u200e).
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

import argparse
import concurrent.futures
import json
import os
import time

import numpy as np
import requests as _requests
from skimage.metrics import structural_similarity

# Platform-specific memory reporting
if sys.platform != "win32":
    import resource

from .capture import ScreenCapture, create_capture
from .change_detector import ChangeDetector
from .roi_extractor import ROIExtractor
from .ocr import OCRResult, create_ocr
from .gate import DecisionGate, SenseObservation
from .sender import SenseSender, package_full_frame, package_roi
from .app_detector import AppDetector
from .config import load_config
from .privacy import apply_privacy

if sys.platform == "win32":
    CONTROL_FILE = os.path.join(os.environ.get("TEMP", "C:\\Temp"), "sinain-sense-control.json")
else:
    CONTROL_FILE = "/tmp/sinain-sense-control.json"


def log(msg: str):
    print(f"[sense] {msg}", flush=True)


def _gate_reason(gate, change, ocr, app_changed, window_changed):
    """Diagnose why the gate dropped an event."""
    now = time.time() * 1000
    ocr_len = len(ocr.text) if ocr.text else 0

    # Check cooldown
    recent_app = (now - gate.last_app_change_ts) < 10000
    effective_cd = gate.adaptive_cooldown_ms if recent_app else gate.cooldown_ms
    elapsed = now - gate.last_send_ts
    if elapsed < effective_cd:
        return f"cooldown ({elapsed:.0f}ms < {effective_cd}ms)"
    if change is None:
        return "no_change"
    if ocr_len < gate.min_ocr_chars:
        return f"too_few_chars ({ocr_len} < {gate.min_ocr_chars})"
    if ocr.text and gate._is_duplicate(ocr.text):
        return "duplicate (similar to recent text)"
    if ocr.text and not gate._ocr_quality_ok(ocr.text):
        return "bad_quality (ocr noise)"
    if change.ssim_score >= gate.major_change_threshold:
        return f"no_visual (ssim={change.ssim_score:.3f} >= {gate.major_change_threshold})"
    return f"unknown (ocr={ocr_len}, ssim={change.ssim_score:.3f})"


def _run_ocr(ocr, ocr_pool, rois) -> OCRResult:
    """Run OCR on extracted ROIs (parallel if multiple). Returns best result."""
    if not rois:
        return OCRResult(text="", confidence=0, word_count=0)
    if len(rois) == 1:
        return ocr.extract(rois[0].image)
    futures = [ocr_pool.submit(ocr.extract, roi.image) for roi in rois]
    results = [f.result() for f in concurrent.futures.as_completed(futures)]
    return max(results, key=lambda r: len(r.text))


def is_enabled(control_path: str) -> bool:
    """Check control file to see if capture is enabled."""
    try:
        with open(control_path) as f:
            data = json.load(f)
        return data.get("enabled", True)
    except (FileNotFoundError, json.JSONDecodeError):
        return True  # default enabled if no control file


def main():
    parser = argparse.ArgumentParser(description="Sinain screen capture pipeline")
    parser.add_argument("--config", default=None, help="Path to config JSON")
    parser.add_argument("--control", default=CONTROL_FILE, help="Path to control file")
    args = parser.parse_args()

    config = load_config(args.config)

    log("initializing capture...")
    capture = create_capture(
        mode=config["capture"]["mode"],
        target=config["capture"]["target"],
        fps=config["capture"]["fps"],
        scale=config["capture"]["scale"],
    )
    detector = ChangeDetector(
        threshold=config["detection"]["ssimThreshold"],
        min_area=config["detection"]["minArea"],
    )
    extractor = ROIExtractor(
        padding=config["detection"]["roiPadding"],
    )
    log("initializing OCR...")
    ocr = create_ocr(config)
    gate = DecisionGate(
        min_ocr_chars=config["gate"]["minOcrChars"],
        major_change_threshold=config["gate"]["majorChangeThreshold"],
        cooldown_ms=config["gate"]["cooldownMs"],
        adaptive_cooldown_ms=config["gate"].get("adaptiveCooldownMs", 2000),
        context_cooldown_ms=config["gate"].get("contextCooldownMs", 10000),
    )
    sender = SenseSender(
        url=config["relay"]["url"],
        max_image_kb=config["relay"]["maxImageKB"],
        send_thumbnails=config["relay"]["sendThumbnails"],
    )
    app_detector = AppDetector()
    ocr_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)

    # Adaptive SSIM threshold state
    ssim_stable_threshold = config["detection"]["ssimThreshold"]  # 0.92
    ssim_sensitive_threshold = 0.85
    last_app_change_time = 0.0

    opt = config.get("optimization", {})
    use_backpressure = opt.get("backpressure", False)
    use_text_dedup = opt.get("textDedup", False)
    use_shadow = opt.get("shadowValidation", False)

    # Privacy matrix env vars (gate what leaves this process toward sinain-core/openrouter)
    _privacy_ocr_openrouter = os.environ.get("PRIVACY_OCR_OPENROUTER", "full")
    _privacy_images_openrouter = os.environ.get("PRIVACY_IMAGES_OPENROUTER", "full")

    log("sense_client started")
    log(f"  relay: {config['relay']['url']}")
    log(f"  fps: {config['capture']['fps']}, scale: {config['capture']['scale']}")
    log(f"  ocr backend: {config['ocr'].get('backend', 'auto')}")
    log(f"  privacy: ocr_openrouter={_privacy_ocr_openrouter} images_openrouter={_privacy_images_openrouter}")
    log(f"  control: {args.control}")
    if use_backpressure:
        log("  optimization: backpressure ON")
    if use_text_dedup:
        log("  optimization: textDedup ON")
    if use_shadow:
        log("  optimization: shadowValidation ON")

    events_sent = 0
    events_failed = 0
    events_gated = 0
    ocr_errors = 0
    ocr_skipped_backpressure = 0
    shadow_divergences = 0
    last_stats = time.time()
    start_time = time.time()
    event_latencies: list[float] = []
    detect_times: list[float] = []
    ocr_times: list[float] = []
    send_times: list[float] = []

    # Backpressure state: latest changed frame waiting for gate
    pending_frame = None
    pending_rois = None
    pending_change = None

    # Diagnostic state
    _logged_first_ssim = False
    _logged_first_frame = False
    _last_heartbeat = time.time()

    for frame, ts in capture.capture_loop():
        # Check control file (pause/resume)
        if not is_enabled(args.control):
            time.sleep(1)
            continue

        # First-frame log
        if not _logged_first_frame:
            log(f"first frame: {frame.size[0]}x{frame.size[1]} (scale={config['capture']['scale']})")
            _logged_first_frame = True

        # 1. Check app/window change
        app_changed, window_changed, app_name, window_title = app_detector.detect_change()

        # Adaptive SSIM threshold
        now_sec = time.time()
        if app_changed:
            last_app_change_time = now_sec
            detector.set_threshold(ssim_sensitive_threshold)
            log(f"SSIM threshold lowered to {ssim_sensitive_threshold} (app change)")
        elif now_sec - last_app_change_time > 10.0 and detector.threshold != ssim_stable_threshold:
            detector.set_threshold(ssim_stable_threshold)
            log(f"SSIM threshold restored to {ssim_stable_threshold} (stable)")

        # 2. Detect frame change
        t0 = time.time()
        change = detector.detect(frame)
        detect_times.append((time.time() - t0) * 1000)
        if len(detect_times) > 500: detect_times.clear()
        if change is None and not app_changed and not window_changed:
            # Log first SSIM so we can see the range
            if not _logged_first_ssim and detector.prev_frame is not None:
                gray = np.array(frame.convert("L"))
                score = structural_similarity(detector.prev_frame, gray)
                log(f"first ssim sample: {score:.4f} (threshold={detector.threshold})")
                _logged_first_ssim = True
            # Periodic heartbeat
            if time.time() - _last_heartbeat >= 30:
                log(f"heartbeat: {capture.stats_ok} frames, {events_sent} sent, "
                    f"{events_gated} gated, threshold={detector.threshold}")
                _last_heartbeat = time.time()
            continue

        if change:
            log(f"change detected: ssim={change.ssim_score:.4f} contours={len(change.contours)}")

        # 3. Extract ROIs + stash as pending
        rois = []
        if change:
            rois = extractor.extract(frame, change.contours)
            if rois:
                roi_sizes = [f"{r.bbox[2]}x{r.bbox[3]}" for r in rois]
                log(f"rois: {len(rois)} regions ({', '.join(roi_sizes)})")
            else:
                log(f"rois: 0 (contours={len(change.contours)} all too small)")
            if use_backpressure:
                pending_frame = frame
                pending_rois = rois
                pending_change = change

        # 4. Backpressure: check if gate is ready before running OCR
        if use_backpressure:
            if not gate.is_ready(app_changed, window_changed):
                ocr_skipped_backpressure += 1
                events_gated += 1
                continue
            # Gate is ready — OCR the latest pending frame
            use_frame = pending_frame or frame
            use_rois = pending_rois or rois
            use_change = pending_change or change
        else:
            use_frame = frame
            use_rois = rois
            use_change = change

        # 5. OCR on ROIs
        t0 = time.time()
        ocr_result = OCRResult(text="", confidence=0, word_count=0)
        try:
            ocr_result = _run_ocr(ocr, ocr_pool, use_rois)
        except Exception as e:
            ocr_errors += 1
            log(f"OCR error: {e}")
        ocr_times.append((time.time() - t0) * 1000)
        if len(ocr_times) > 500: ocr_times.clear()

        if ocr_result.text:
            log(f"ocr: {len(ocr_result.text)} chars, {ocr_result.word_count} words")
        else:
            log(f"ocr: empty (rois={len(use_rois)})")

        # Shadow validation: run baseline OCR on original frame for comparison
        if use_shadow and use_backpressure and rois:
            try:
                baseline_result = _run_ocr(ocr, ocr_pool, rois)
                if baseline_result.text != ocr_result.text:
                    shadow_divergences += 1
                    log(f"SHADOW DIVERGENCE: baseline={len(baseline_result.text)}chars "
                        f"optimized={len(ocr_result.text)}chars")
                # Use baseline for actual sending (safety)
                ocr_result = baseline_result
            except Exception as e:
                log(f"Shadow OCR error: {e}")

        # Clear pending state after OCR
        if use_backpressure:
            pending_frame = pending_rois = pending_change = None

        # 5b. Privacy filter — strip <private> tags and redact secrets
        if ocr_result.text:
            ocr_result = OCRResult(
                text=apply_privacy(ocr_result.text),
                confidence=ocr_result.confidence,
                word_count=ocr_result.word_count,
            )

        # 5c. Privacy matrix: apply OCR gating for openrouter destination
        if ocr_result.text and _privacy_ocr_openrouter != "full":
            if _privacy_ocr_openrouter == "none":
                ocr_result = OCRResult(text="", confidence=0, word_count=0)
            elif _privacy_ocr_openrouter == "summary":
                ocr_result = OCRResult(
                    text=f"[SCREEN: {len(ocr_result.text)} chars]",
                    confidence=ocr_result.confidence,
                    word_count=1,
                )
            # "redacted" is already handled by apply_privacy above

        # 6. Decision gate
        event = gate.classify(
            change=use_change,
            ocr=ocr_result,
            app_changed=app_changed,
            window_changed=window_changed,
        )
        if event is None:
            reason = _gate_reason(gate, use_change, ocr_result, app_changed, window_changed)
            log(f"gate dropped: {reason}")
            events_gated += 1
            continue

        # 7. Package and send
        event.meta.app = app_name
        event.meta.window_title = window_title
        event.meta.screen = config["capture"]["target"]

        # 7b. Auto-populate structured observation from available context
        facts = []
        if app_name:
            facts.append(f"app: {app_name}")
        if window_title:
            facts.append(f"window: {window_title}")
        if use_change and use_change.ssim_score:
            facts.append(f"ssim: {use_change.ssim_score:.3f}")
        if ocr_result.text:
            # Extract first meaningful line as subtitle
            first_line = ocr_result.text.split("\n")[0][:120]
            facts.append(f"ocr: {first_line}")

        title = f"{event.type} in {app_name}" if app_name else f"{event.type} event"
        subtitle = window_title[:80] if window_title else ""
        event.observation = SenseObservation(
            title=title, subtitle=subtitle, facts=facts,
        )

        # Send small thumbnail for ALL event types (agent uses vision)
        # Privacy matrix: gate image sending based on PRIVACY_IMAGES_OPENROUTER
        if _privacy_images_openrouter == "none":
            pass  # Skip image packaging entirely
        elif event.type == "context":
            event.roi = package_full_frame(use_frame)
        elif use_rois:
            event.roi = package_roi(use_rois[0])
        else:
            # Fallback: send full frame thumbnail for text-only events
            event.roi = package_full_frame(use_frame)
        # Diff images removed — agent doesn't use binary diff masks

        t0 = time.time()
        ok = sender.send(event)
        send_times.append((time.time() - t0) * 1000)
        if len(send_times) > 500: send_times.clear()
        if ok:
            events_sent += 1
            send_latency = time.time() * 1000 - event.ts
            event_latencies.append(send_latency)
            if len(event_latencies) > 500: event_latencies.clear()
            ssim = f"{use_change.ssim_score:.3f}" if use_change else "n/a"
            ctx = f"app={app_name}"
            if window_title:
                ctx += f", win={window_title[:40]}"
            log(f"-> {event.type} sent ({ctx}, ssim={ssim}, latency={send_latency:.0f}ms)")
        else:
            events_failed += 1
            log(f"-> {event.type} FAILED to send")

        # Periodic pipeline stats
        now = time.time()
        if now - last_stats >= 60:
            latency_info = ""
            if event_latencies:
                sorted_lat = sorted(event_latencies)
                p50 = sorted_lat[len(sorted_lat) // 2]
                p95 = sorted_lat[int(len(sorted_lat) * 0.95)]
                latency_info = f" latency_p50={p50:.0f}ms p95={p95:.0f}ms"
                event_latencies.clear()

            avg_detect = sum(detect_times) / len(detect_times) if detect_times else 0
            avg_ocr = sum(ocr_times) / len(ocr_times) if ocr_times else 0
            avg_send = sum(send_times) / len(send_times) if send_times else 0

            bp_info = ""
            if use_backpressure:
                bp_info = f" ocrSkipped={ocr_skipped_backpressure}"
            shadow_info = ""
            if use_shadow:
                shadow_info = f" shadowDiv={shadow_divergences}"

            log(f"stats: captures={capture.stats_ok}ok/{capture.stats_fail}fail"
                f" events={events_sent}sent/{events_failed}fail/{events_gated}gated"
                f"{bp_info}{shadow_info}{latency_info}"
                f" detect={avg_detect:.1f}ms ocr={avg_ocr:.1f}ms send={avg_send:.1f}ms")

            # POST profiling snapshot to sinain-core
            if sys.platform == "win32":
                try:
                    import psutil
                    rss_mb = round(psutil.Process().memory_info().rss / 1048576, 1)
                except Exception:
                    rss_mb = 0.0
            else:
                usage = resource.getrusage(resource.RUSAGE_SELF)
                rss_mb = round(usage.ru_maxrss / 1048576, 1)
            snapshot = {
                "rssMb": rss_mb,
                "uptimeS": round(now - start_time),
                "ts": int(now * 1000),
                "extra": {
                    "capturesOk": capture.stats_ok,
                    "capturesFail": capture.stats_fail,
                    "eventsSent": events_sent,
                    "eventsFailed": events_failed,
                    "eventsGated": events_gated,
                    "ocrErrors": ocr_errors,
                    "ocrSkippedBackpressure": ocr_skipped_backpressure,
                    "shadowDivergences": shadow_divergences,
                    "detectAvgMs": round(avg_detect, 1),
                    "ocrAvgMs": round(avg_ocr, 1),
                    "sendAvgMs": round(avg_send, 1),
                },
            }
            try:
                _requests.post(
                    f"{config['relay']['url']}/profiling/sense",
                    json=snapshot, timeout=2,
                )
            except Exception:
                pass

            detect_times.clear()
            ocr_times.clear()
            send_times.clear()
            last_stats = now


if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = traceback.format_exc()
        print(f"[sense] CRASH:\n{tb}", file=sys.stderr, flush=True)
        # Report crash to sinain-core so it's visible in health
        try:
            import requests as _req
            _req.post(
                "http://localhost:9500/profiling/sense",
                json={"crash": tb, "ts": int(__import__("time").time() * 1000)},
                timeout=2,
            )
        except Exception:
            pass
        raise
