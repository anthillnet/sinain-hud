"""Entry point: python -m sense_client"""

import argparse
import concurrent.futures
import json
import os
import resource
import time

import requests as _requests

from .capture import ScreenCapture, create_capture
from .change_detector import ChangeDetector
from .roi_extractor import ROIExtractor
from .ocr import OCRResult, create_ocr
from .gate import DecisionGate
from .sender import SenseSender, package_full_frame, package_roi
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
    ocr_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)

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
    ocr_errors = 0
    last_stats = time.time()
    start_time = time.time()
    event_latencies: list[float] = []
    detect_times: list[float] = []
    ocr_times: list[float] = []
    send_times: list[float] = []

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
        t0 = time.time()
        change = detector.detect(frame)
        detect_times.append((time.time() - t0) * 1000)
        if len(detect_times) > 500: detect_times.clear()
        if change is None and not app_changed and not window_changed:
            continue

        # 3. Extract ROIs
        rois = []
        if change:
            rois = extractor.extract(frame, change.contours)

        # 4. OCR on ROIs (parallel if multiple)
        t0 = time.time()
        ocr_result = OCRResult(text="", confidence=0, word_count=0)
        try:
            if rois:
                if len(rois) == 1:
                    ocr_result = ocr.extract(rois[0].image)
                else:
                    futures = [ocr_pool.submit(ocr.extract, roi.image) for roi in rois]
                    results = [f.result() for f in concurrent.futures.as_completed(futures)]
                    best = max(results, key=lambda r: len(r.text))
                    ocr_result = best
        except Exception as e:
            ocr_errors += 1
            log(f"OCR error: {e}")
        ocr_times.append((time.time() - t0) * 1000)
        if len(ocr_times) > 500: ocr_times.clear()

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

        # Send small thumbnail for ALL event types (agent uses vision)
        if event.type == "context":
            event.roi = package_full_frame(frame)
        elif rois:
            event.roi = package_roi(rois[0])
        else:
            # Fallback: send full frame thumbnail for text-only events
            event.roi = package_full_frame(frame)
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

            avg_detect = sum(detect_times) / len(detect_times) if detect_times else 0
            avg_ocr = sum(ocr_times) / len(ocr_times) if ocr_times else 0
            avg_send = sum(send_times) / len(send_times) if send_times else 0

            log(f"stats: captures={capture.stats_ok}ok/{capture.stats_fail}fail"
                f" events={events_sent}sent/{events_failed}fail/{events_gated}gated"
                f"{latency_info}"
                f" detect={avg_detect:.1f}ms ocr={avg_ocr:.1f}ms send={avg_send:.1f}ms")

            # POST profiling snapshot to sinain-core
            usage = resource.getrusage(resource.RUSAGE_SELF)
            snapshot = {
                "rssMb": round(usage.ru_maxrss / 1048576, 1),
                "uptimeS": round(now - start_time),
                "ts": int(now * 1000),
                "extra": {
                    "capturesOk": capture.stats_ok,
                    "capturesFail": capture.stats_fail,
                    "eventsSent": events_sent,
                    "eventsFailed": events_failed,
                    "eventsGated": events_gated,
                    "ocrErrors": ocr_errors,
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
    main()
