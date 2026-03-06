#!/usr/bin/env python3
"""Before/after benchmark delta tool.

Loads two daily snapshots and computes per-metric deltas to determine
whether a change (e.g. prompt tuning) helped or hurt.

Usage:
    python3 sinain-koog/eval_delta.py --memory-dir memory/ --after 2026-03-08
    python3 sinain-koog/eval_delta.py --memory-dir memory/ --before 2026-03-06 --after 2026-03-08 --label "tuned insight prompt"
"""

import argparse
import json
import sys
from pathlib import Path

_koog_dir = str(Path(__file__).resolve().parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from eval_reporter import compute_delta, load_previous_snapshot


def load_snapshot(report_dir: Path, date_str: str) -> dict | None:
    """Load a snapshot for the given date."""
    snap_path = report_dir / f"{date_str}.snapshot.json"
    if not snap_path.exists():
        return None
    try:
        return json.loads(snap_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def format_human(delta: dict[str, dict], label: str = "") -> str:
    """Format delta as a human-readable summary."""
    lines = []
    if label:
        lines.append(f"Label: {label}")
    lines.append("")

    improved = [k for k, v in delta.items() if v["status"] == "IMPROVED"]
    regressed = [k for k, v in delta.items() if v["status"] == "REGRESSED"]
    same = [k for k, v in delta.items() if v["status"] == "SAME"]

    for metric, info in sorted(delta.items()):
        marker = {"IMPROVED": "↑", "REGRESSED": "↓", "SAME": "→"}[info["status"]]
        sign = "+" if info["delta"] > 0 else ""
        lines.append(f"  {marker} {metric}: {info['before']} → {info['after']} ({sign}{info['delta']})")

    lines.append("")
    lines.append(f"Summary: {len(improved)} improved, {len(regressed)} regressed, {len(same)} same")

    if regressed:
        lines.append(f"Regressions: {', '.join(regressed)}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Before/after benchmark delta comparison")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--before", default=None, help="Date of 'before' snapshot (YYYY-MM-DD). Auto-detected if omitted")
    parser.add_argument("--after", required=True, help="Date of 'after' snapshot (YYYY-MM-DD)")
    parser.add_argument("--label", default="", help="Optional label for the change being measured")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of human-readable text")
    args = parser.parse_args()

    report_dir = Path(args.memory_dir) / "eval-reports"
    if not report_dir.is_dir():
        print(f"[eval-delta] report directory not found: {report_dir}", file=sys.stderr)
        sys.exit(1)

    # Load "after" snapshot
    after_snap = load_snapshot(report_dir, args.after)
    if not after_snap:
        print(f"[eval-delta] no snapshot found for --after {args.after}", file=sys.stderr)
        sys.exit(1)

    # Load "before" snapshot
    if args.before:
        before_date = args.before
        before_snap = load_snapshot(report_dir, before_date)
        if not before_snap:
            print(f"[eval-delta] no snapshot found for --before {before_date}", file=sys.stderr)
            sys.exit(1)
    else:
        before_date, before_snap = load_previous_snapshot(report_dir, args.after)
        if not before_snap:
            print(f"[eval-delta] no previous snapshot found before {args.after}", file=sys.stderr)
            sys.exit(1)

    delta = compute_delta(before_snap, after_snap)

    if args.json:
        output = {
            "before": before_date,
            "after": args.after,
            "label": args.label,
            "delta": delta,
        }
        print(json.dumps(output, indent=2))
    else:
        print(f"Delta: {before_date} → {args.after}")
        print(format_human(delta, args.label))


if __name__ == "__main__":
    main()
