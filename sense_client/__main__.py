"""Entry point: python -m sense_client"""

import argparse
import json
import os
import time

from .capture import ScreenCapture
from .change_detector import ChangeDetector
from .roi_extractor import ROIExtractor
from .ocr import LocalOCR, OCRResult
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

    capture = ScreenCapture(
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
    ocr = LocalOCR(
        lang=config["ocr"]["lang"],
        psm=config["ocr"]["psm"],
        min_confidence=config["ocr"]["minConfidence"],
        enabled=config["ocr"]["enabled"],
    )
    gate = DecisionGate(
        min_ocr_chars=config["gate"]["minOcrChars"],
        major_change_threshold=config["gate"]["majorChangeThreshold"],
        cooldown_ms=config["gate"]["cooldownMs"],
    )
    sender = SenseSender(
        url=config["relay"]["url"],
        max_image_kb=config["relay"]["maxImageKB"],
        send_thumbnails=config["relay"]["sendThumbnails"],
    )
    app_detector = AppDetector()

    log("sense_client started")
    log(f"  relay: {config['relay']['url']}")
    log(f"  fps: {config['capture']['fps']}, scale: {config['capture']['scale']}")
    log(f"  control: {args.control}")

    for frame, ts in capture.capture_loop():
        # Check control file (pause/resume)
        if not is_enabled(args.control):
            time.sleep(1)
            continue

        # 1. Check app change
        app_changed, app_name = app_detector.detect_change()

        # 2. Detect frame change
        change = detector.detect(frame)
        if change is None and not app_changed:
            continue

        # 3. Extract ROIs
        rois = []
        if change:
            rois = extractor.extract(frame, change.contours)

        # 4. OCR on primary ROI
        ocr_result = OCRResult(text="", confidence=0, word_count=0)
        if rois:
            ocr_result = ocr.extract(rois[0].image)

        # 5. Decision gate
        event = gate.classify(
            change=change,
            ocr=ocr_result,
            app_changed=app_changed,
        )
        if event is None:
            continue

        # 6. Package and send
        event.meta.app = app_name
        event.meta.screen = config["capture"]["target"]

        if event.type == "context":
            event.roi = package_full_frame(frame, max_px=720)
        elif rois:
            event.roi = package_roi(rois[0], thumb=(event.type == "text"))

        if change and change.diff_image and event.type == "visual":
            event.diff = package_diff(change.diff_image)

        ok = sender.send(event)
        if ok:
            ssim = f"{change.ssim_score:.3f}" if change else "n/a"
            log(f"-> {event.type} sent (app={app_name}, ssim={ssim})")
        else:
            log(f"-> {event.type} FAILED to send")


if __name__ == "__main__":
    main()
