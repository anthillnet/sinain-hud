"""One-shot crop-OCR for manual ROI selection (tier-2 fallback).

When the user drag-selects a screen region and the sense buffer has no
recent OCR covering it (the area never changed, so the SSIM gate never
OCR'd it), sinain-core shells this entry point: read the current frame
sck-capture already writes to IPC, crop to the selection, OCR it.

Usage:
    python3 -m sense_client.ocr_once '{"x":100,"y":200,"w":400,"h":300,
                                       "screenW":1728,"screenH":1117}'

Selection rect is in screen points (top-left origin); we scale into the
frame's pixel space via the frame/screen ratio. Output JSON on stdout:
    {"ok": true, "text": "...", "lines": [{"text": "...", "bbox": [x,y,w,h]}],
     "frame_size": [w, h]}
with line bboxes in SCREEN points (already scaled back), so the caller
needs no further coordinate math.
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image

FRAME_PATH = os.path.expanduser("~/.sinain/capture/frame.jpg")


def main() -> int:
    try:
        sel = json.loads(sys.argv[1])
        x, y, w, h = (float(sel[k]) for k in ("x", "y", "w", "h"))
        screen_w = float(sel["screenW"])
        screen_h = float(sel["screenH"])
    except (IndexError, KeyError, ValueError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": f"bad args: {e}"}))
        return 1

    if not os.path.exists(FRAME_PATH):
        print(json.dumps({"ok": False, "error": f"no frame at {FRAME_PATH} — is sck-capture running?"}))
        return 1

    try:
        img = Image.open(FRAME_PATH)
        img.load()
    except OSError as e:
        # Partially-written frame — one retry after the writer finishes
        import time
        time.sleep(0.3)
        try:
            img = Image.open(FRAME_PATH)
            img.load()
        except OSError:
            print(json.dumps({"ok": False, "error": f"unreadable frame: {e}"}))
            return 1

    fw, fh = img.size
    sx, sy = fw / screen_w, fh / screen_h
    # Screen points → frame pixels, clamped to frame bounds
    fx = max(0, min(fw, x * sx))
    fy = max(0, min(fh, y * sy))
    fx2 = max(0, min(fw, (x + w) * sx))
    fy2 = max(0, min(fh, (y + h) * sy))
    if fx2 - fx < 4 or fy2 - fy < 4:
        print(json.dumps({"ok": False, "error": "selection too small"}))
        return 1
    crop = img.crop((int(fx), int(fy), int(fx2), int(fy2)))

    from .ocr import VisionOCR

    ocr = VisionOCR()
    result = ocr.extract(crop)

    # Crop-relative frame pixels → absolute screen points
    lines = []
    for ln in result.lines or []:
        bx, by, bw, bh = ln["bbox"]
        lines.append({
            "text": ln["text"],
            "bbox": [
                round((fx + bx) / sx, 1),
                round((fy + by) / sy, 1),
                round(bw / sx, 1),
                round(bh / sy, 1),
            ],
        })

    print(json.dumps({
        "ok": True,
        "text": result.text,
        "lines": lines,
        "frame_size": [fw, fh],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
