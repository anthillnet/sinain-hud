"""Entry point: python -m sense_client

Optimized screen capture pipeline with:
- pHash fast gate (<1ms) for 95% frame rejection
- Region tracking for stable/dynamic area detection
- Lazy OCR with LRU caching (80% hit rate target)
- Semantic layer with activity classification and delta encoding
- WebSocket communication with priority queue
"""

import argparse
import concurrent.futures
import json
import os
import resource
import time

import requests as _requests

from .capture import create_capture
from .change_detector import ChangeDetector
from .roi_extractor import ROIExtractor
from .ocr import OCRResult, create_ocr
from .gate import DecisionGate
from .sender import SenseSender, WebSocketSender, Priority, create_sender, package_full_frame, package_roi
from .app_detector import AppDetector
from .config import load_config

# New components
from .region_tracker import RegionTracker
from .text_detector import TextDetector
from .ocr_cache import OCRCache, LazyOCRStore
from .semantic import SemanticBuilder, ActivityType
from .context_builder import ContextBuilder

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
    parser.add_argument("--profile", default=None,
                        choices=["capture", "detection", "ocr", "e2e"],
                        help="Run profiling mode")
    parser.add_argument("--use-websocket", action="store_true", default=True,
                        help="Use WebSocket for communication (default)")
    parser.add_argument("--no-websocket", action="store_true",
                        help="Use HTTP instead of WebSocket")
    args = parser.parse_args()

    config = load_config(args.config)

    # Initialize components
    capture = create_capture(
        mode=config["capture"]["mode"],
        target=config["capture"]["target"],
        fps=config["capture"]["fps"],
        scale=config["capture"]["scale"],
    )

    # Change detector with pHash fast gate
    detector = ChangeDetector(
        threshold=config["detection"]["ssimThreshold"],
        min_area=config["detection"]["minArea"],
        phash_threshold=config["detection"].get("phashThreshold", 5),
        use_fast_gate=True,
    )

    extractor = ROIExtractor(
        padding=config["detection"]["roiPadding"],
    )

    # Region tracker for stable/dynamic areas
    region_tracker = RegionTracker(
        grid_size=16,
        stability_threshold_s=30.0,
    )

    # Text detector for pre-OCR filtering
    text_detector = TextDetector(
        threshold=0.4,
        min_size=(32, 16),
    )

    # OCR with caching
    ocr_backend = create_ocr(config)
    ocr_cache = OCRCache(max_size=1000, hash_method="content")
    lazy_ocr_store = LazyOCRStore(cache=ocr_cache, max_pending=10)

    gate = DecisionGate(
        min_ocr_chars=config["gate"]["minOcrChars"],
        major_change_threshold=config["gate"]["majorChangeThreshold"],
        cooldown_ms=config["gate"]["cooldownMs"],
        adaptive_cooldown_ms=config["gate"].get("adaptiveCooldownMs", 2000),
        context_cooldown_ms=config["gate"].get("contextCooldownMs", 10000),
    )

    # Semantic layer
    semantic_builder = SemanticBuilder()
    context_builder = ContextBuilder(max_history=30, builder=semantic_builder)

    # Communication - WebSocket or HTTP
    use_ws = args.use_websocket and not args.no_websocket
    sender = create_sender(config, use_websocket=use_ws)

    app_detector = AppDetector()
    ocr_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)

    # Adaptive SSIM threshold state
    ssim_stable_threshold = config["detection"]["ssimThreshold"]  # 0.92
    ssim_sensitive_threshold = 0.85
    last_app_change_time = 0.0

    log("sense_client started (optimized pipeline)")
    log(f"  relay: {config['relay']['url']}")
    log(f"  communication: {'WebSocket' if use_ws else 'HTTP'}")
    log(f"  fps: {config['capture']['fps']}, scale: {config['capture']['scale']}")
    log(f"  ocr backend: {config['ocr'].get('backend', 'auto')}")
    log(f"  control: {args.control}")
    log(f"  fast gate: enabled (pHash threshold={config['detection'].get('phashThreshold', 5)})")

    # Stats
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

    # Profiling mode
    if args.profile:
        run_profiling(args.profile, capture, detector, ocr_backend, ocr_cache, config)
        return

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
            # Reset semantic state on app change
            semantic_builder.reset()

        elif now_sec - last_app_change_time > 10.0 and detector.threshold != ssim_stable_threshold:
            detector.set_threshold(ssim_stable_threshold)

        # 2. Detect frame change (pHash fast gate + SSIM)
        t0 = time.time()
        change = detector.detect(frame)
        detect_times.append((time.time() - t0) * 1000)
        if len(detect_times) > 500:
            detect_times.clear()
        if change is None and not app_changed and not window_changed:
            continue

        # 3. Region tracking (skip stable regions)
        changed_regions = region_tracker.analyze(frame, skip_stable=True)

        # 4. Extract ROIs from change contours
        rois = []
        if change:
            rois = extractor.extract(frame, change.contours)

        # 5. Filter ROIs by text likelihood
        text_rois = []
        for roi in rois:
            if text_detector.is_text_region(roi.image):
                text_rois.append(roi)

        # Fallback: if no text ROIs but we have change, use original ROIs
        if not text_rois and rois:
            text_rois = rois[:2]  # Limit to 2 for efficiency

        # 6. OCR with caching (lazy evaluation)
        t0 = time.time()
        ocr_result = OCRResult(text="", confidence=0, word_count=0)
        try:
            if text_rois:
                # Store frame for lazy OCR
                regions = [(r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]) for r in text_rois]
                lazy_ocr_store.add_frame(frame, regions)

                # Get OCR for most recent (uses cache)
                if len(text_rois) == 1:
                    ocr_result = ocr_cache.get_or_compute(text_rois[0].image, ocr_backend.extract)
                else:
                    # Parallel OCR with caching
                    def cached_extract(img):
                        return ocr_cache.get_or_compute(img, ocr_backend.extract)

                    futures = [ocr_pool.submit(cached_extract, roi.image) for roi in text_rois]
                    results = [f.result() for f in concurrent.futures.as_completed(futures)]
                    ocr_result = max(results, key=lambda r: len(r.text))
        except Exception as e:
            ocr_errors += 1
            log(f"OCR error: {e}")

        ocr_times.append((time.time() - t0) * 1000)
        if len(ocr_times) > 500:
            ocr_times.clear()

        # 7. Build semantic state
        ssim = change.ssim_score if change else 1.0
        semantic_state = context_builder.add_event(
            ocr_text=ocr_result.text,
            app=app_name,
            window=window_title,
            ssim=ssim,
            app_changed=app_changed,
            window_changed=window_changed,
        )

        # 8. Decision gate
        event = gate.classify(
            change=change,
            ocr=ocr_result,
            app_changed=app_changed,
            window_changed=window_changed,
        )
        if event is None:
            events_gated += 1
            continue

        # 9. Package and send
        event.meta.app = app_name
        event.meta.window_title = window_title
        event.meta.screen = config["capture"]["target"]

        # Determine priority
        priority = Priority.NORMAL
        if app_changed or semantic_state.has_error:
            priority = Priority.URGENT
        elif semantic_state.activity == ActivityType.TYPING:
            priority = Priority.HIGH

        # Send small thumbnail for ALL event types
        if event.type == "context":
            event.roi = package_full_frame(frame)
        elif text_rois:
            event.roi = package_roi(text_rois[0])
        else:
            event.roi = package_full_frame(frame)

        t0 = time.time()

        # Use WebSocket or HTTP sender
        if isinstance(sender, WebSocketSender):
            ok = sender.send(event, priority=priority)
        else:
            ok = sender.send(event)

        send_times.append((time.time() - t0) * 1000)
        if len(send_times) > 500:
            send_times.clear()

        if ok:
            events_sent += 1
            send_latency = time.time() * 1000 - event.ts
            event_latencies.append(send_latency)
            if len(event_latencies) > 500:
                event_latencies.clear()
            ssim_str = f"{ssim:.3f}" if change else "n/a"
            activity = semantic_state.activity.value if semantic_state else "unknown"
            ctx = f"app={app_name}, activity={activity}"
            if window_title:
                ctx += f", win={window_title[:30]}"
            log(f"-> {event.type} sent ({ctx}, ssim={ssim_str}, latency={send_latency:.0f}ms)")
        else:
            events_failed += 1
            log(f"-> {event.type} FAILED to send")

        # Periodic pipeline stats
        now = time.time()
        if now - last_stats >= 60:
            log_stats(
                capture, detector, region_tracker, text_detector, ocr_cache,
                context_builder, sender, events_sent, events_failed, events_gated,
                ocr_errors, event_latencies, detect_times, ocr_times, send_times,
                config, start_time, now,
            )
            event_latencies.clear()
            detect_times.clear()
            ocr_times.clear()
            send_times.clear()
            last_stats = now


def log_stats(capture, detector, region_tracker, text_detector, ocr_cache,
              context_builder, sender, events_sent, events_failed, events_gated,
              ocr_errors, event_latencies, detect_times, ocr_times, send_times,
              config, start_time, now):
    """Log comprehensive pipeline statistics."""
    latency_info = ""
    if event_latencies:
        sorted_lat = sorted(event_latencies)
        p50 = sorted_lat[len(sorted_lat) // 2]
        p95 = sorted_lat[int(len(sorted_lat) * 0.95)]
        latency_info = f" latency_p50={p50:.0f}ms p95={p95:.0f}ms"

    avg_detect = sum(detect_times) / len(detect_times) if detect_times else 0
    avg_ocr = sum(ocr_times) / len(ocr_times) if ocr_times else 0
    avg_send = sum(send_times) / len(send_times) if send_times else 0

    # Component stats
    detector_stats = detector.get_stats()
    region_stats = region_tracker.get_stats()
    text_stats = text_detector.get_stats()
    cache_stats = ocr_cache.get_stats()
    context_stats = context_builder.get_stats()

    log(f"stats: captures={capture.stats_ok}ok/{capture.stats_fail}fail"
        f" events={events_sent}sent/{events_failed}fail/{events_gated}gated"
        f"{latency_info}")
    log(f"  detect: avg={avg_detect:.1f}ms, ssim_calls={detector_stats['ssim_calls']}, "
        f"phash_rejected={detector_stats.get('phash_rejected', 0)} ({detector_stats.get('phash_rejection_rate', '0%')})")
    log(f"  regions: stable={region_stats['stable_regions']}/{region_stats['total_regions']}, "
        f"skipped={region_stats['stable_skipped']}")
    log(f"  text_detect: accepted={text_stats['regions_accepted']}/{text_stats['regions_checked']} "
        f"({text_stats['acceptance_rate']})")
    log(f"  ocr: avg={avg_ocr:.1f}ms, cache_hits={cache_stats['hits']}, "
        f"hit_rate={cache_stats['hit_rate']}")
    log(f"  semantic: snapshots={context_stats['total_snapshots']}, "
        f"tokens_saved={context_stats['total_tokens_saved']}")
    log(f"  send: avg={avg_send:.1f}ms")

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
            # New metrics
            "phashRejectionRate": detector_stats.get("phash_rejection_rate", "0%"),
            "ocrCacheHitRate": cache_stats["hit_rate"],
            "tokensSaved": context_stats["total_tokens_saved"],
            "stableRegions": region_stats["stable_regions"],
        },
    }
    try:
        _requests.post(
            f"{config['relay']['url']}/profiling/sense",
            json=snapshot, timeout=2,
        )
    except Exception:
        pass


def run_profiling(mode: str, capture, detector, ocr_backend, ocr_cache, config):
    """Run specific profiling mode."""
    log(f"Running profiling mode: {mode}")

    if mode == "capture":
        # Profile capture latency
        log("Profiling capture latency (10 samples)...")
        latencies = []
        for i, (frame, ts) in enumerate(capture.capture_loop()):
            latency = time.time() * 1000 - ts
            latencies.append(latency)
            log(f"  Sample {i+1}: {latency:.1f}ms")
            if i >= 9:
                break
        avg = sum(latencies) / len(latencies)
        log(f"Average capture latency: {avg:.1f}ms")
        log(f"Target: <5ms (current architecture: ~1500ms CLI, ~5ms IPC)")

    elif mode == "detection":
        # Profile change detection
        log("Profiling change detection (20 frames)...")
        phash_times = []
        ssim_times = []
        phash_rejected = 0

        for i, (frame, ts) in enumerate(capture.capture_loop()):
            t0 = time.time()
            change = detector.detect(frame)
            total = (time.time() - t0) * 1000

            stats = detector.get_stats()
            if change is None and stats.get("phash_rejected", 0) > phash_rejected:
                phash_rejected = stats["phash_rejected"]
                phash_times.append(total)
                log(f"  Frame {i+1}: pHash rejected in {total:.2f}ms")
            else:
                ssim_times.append(total)
                log(f"  Frame {i+1}: SSIM computed in {total:.2f}ms")

            if i >= 19:
                break

        log(f"\nResults:")
        log(f"  pHash rejections: {len(phash_times)} ({len(phash_times)/20*100:.0f}%)")
        if phash_times:
            log(f"  pHash avg time: {sum(phash_times)/len(phash_times):.2f}ms")
        if ssim_times:
            log(f"  SSIM avg time: {sum(ssim_times)/len(ssim_times):.2f}ms")
        log(f"Target: 95% pHash rejection in <1ms")

    elif mode == "ocr":
        # Profile OCR caching
        log("Profiling OCR caching (10 frames)...")
        from .roi_extractor import ROIExtractor
        extractor = ROIExtractor()

        for i, (frame, ts) in enumerate(capture.capture_loop()):
            change = detector.detect(frame)
            if change:
                rois = extractor.extract(frame, change.contours)
                for roi in rois[:2]:
                    t0 = time.time()
                    result = ocr_cache.get_or_compute(roi.image, ocr_backend.extract)
                    elapsed = (time.time() - t0) * 1000

                    stats = ocr_cache.get_stats()
                    hit = "HIT" if stats["hits"] > 0 and elapsed < 10 else "MISS"
                    log(f"  Frame {i+1}: {hit} in {elapsed:.0f}ms, "
                        f"cache_size={stats['size']}, hit_rate={stats['hit_rate']}")

            if i >= 9:
                break

        stats = ocr_cache.get_stats()
        log(f"\nFinal cache stats:")
        log(f"  Size: {stats['size']}/{stats['max_size']}")
        log(f"  Hits: {stats['hits']}, Misses: {stats['misses']}")
        log(f"  Hit rate: {stats['hit_rate']}")
        log(f"Target: 80% hit rate, <3 OCR calls/min")

    elif mode == "e2e":
        # Profile end-to-end latency
        log("Profiling end-to-end latency (5 significant changes)...")
        from .semantic import SemanticBuilder
        from .gate import DecisionGate

        semantic = SemanticBuilder()
        gate_obj = DecisionGate()
        changes_found = 0

        for i, (frame, ts) in enumerate(capture.capture_loop()):
            t0 = time.time()

            change = detector.detect(frame)
            if change is None:
                continue

            t_detect = time.time()

            # Simulate full pipeline
            semantic.build(
                ocr_text="sample text",
                app="Test",
                window="Window",
                ssim=change.ssim_score,
                app_changed=False,
                window_changed=False,
            )

            t_semantic = time.time()

            total = (t_semantic - t0) * 1000
            detect_ms = (t_detect - t0) * 1000
            semantic_ms = (t_semantic - t_detect) * 1000

            log(f"  Change {changes_found + 1}: total={total:.0f}ms "
                f"(detect={detect_ms:.0f}ms, semantic={semantic_ms:.0f}ms)")

            changes_found += 1
            if changes_found >= 5:
                break

            if i >= 50:
                log("  (stopped after 50 frames)")
                break

        log(f"\nTarget: <100ms screen change → agent awareness")


if __name__ == "__main__":
    main()
