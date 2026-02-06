"""Entry point: python -m sense_client"""

import argparse
import concurrent.futures
import json
import os
import time

from .capture import ScreenCapture, create_capture
from .change_detector import ChangeDetector
from .roi_extractor import ROIExtractor
from .ocr import OCRResult, create_ocr
from .gate import DecisionGate
from .sender import SenseSender, package_full_frame, package_roi, package_diff
from .app_detector import AppDetector
from .config import load_config

CONTROL_FILE = "/tmp/sinain-sense-control.json"


def log(msg: str):
    print(f"[sense] {msg}")


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

    # Adaptive SSIM threshold state
    ssim_stable_threshold = config["detection"]["ssimThreshold"]  # 0.92
    ssim_sensitive_threshold = 0.85
    last_app_change_time = 0.0

    log("sense_client started")
    log(f"  relay: {config['relay']['url']}")
    log(f"  fps: {config['capture']['fps']}, scale: {config['capture']['scale']}")
    log(f"  ocr backend: {config['ocr'].get('backend', 'auto')}")
    log(f"  control: {args.control}")

    events_sent = 0
    events_failed = 0
    events_gated = 0
    last_stats = time.time()
    event_latencies: list[float] = []

    for frame, ts in capture.capture_loop():
        # Check control file (pause/resume)
        if not is_enabled(args.control):
            time.sleep(1)
            continue

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
        change = detector.detect(frame)
        if change is None and not app_changed and not window_changed:
            continue

        # 3. Extract ROIs
        rois = []
        if change:
            rois = extractor.extract(frame, change.contours)

        # 4. OCR on ROIs (parallel if multiple)
        ocr_result = OCRResult(text="", confidence=0, word_count=0)
        if rois:
            if len(rois) == 1:
                ocr_result = ocr.extract(rois[0].image)
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(rois), 4)) as pool:
                    futures = [pool.submit(ocr.extract, roi.image) for roi in rois]
                    results = [f.result() for f in concurrent.futures.as_completed(futures)]
                best = max(results, key=lambda r: len(r.text))
                ocr_result = best

        # 5. Decision gate
        event = gate.classify(
            change=change,
            ocr=ocr_result,
            app_changed=app_changed,
            window_changed=window_changed,
        )
        if event is None:
            events_gated += 1
            continue

        # 6. Package and send
        event.meta.app = app_name
        event.meta.window_title = window_title
        event.meta.screen = config["capture"]["target"]

        if event.type == "context":
            event.roi = package_full_frame(frame, max_px=720)
        elif event.type == "visual" and rois:
            event.roi = package_roi(rois[0], thumb=False)
        # text-only events: skip image encoding, send OCR text only

        if change and change.diff_image and event.type == "visual":
            event.diff = package_diff(change.diff_image)

        ok = sender.send(event)
        if ok:
            events_sent += 1
            send_latency = time.time() * 1000 - event.ts
            event_latencies.append(send_latency)
            ssim = f"{change.ssim_score:.3f}" if change else "n/a"
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
            log(f"stats: captures={capture.stats_ok}ok/{capture.stats_fail}fail"
                f" events={events_sent}sent/{events_failed}fail/{events_gated}gated"
                f"{latency_info}")
            last_stats = now


if __name__ == "__main__":
    main()
