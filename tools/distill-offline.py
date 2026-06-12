#!/usr/bin/env python3
"""Distill a labeled transcript file directly into a fresh knowledge-graph.db.

Bypasses the live audio capture pipeline. Used for the diarization ablation:
compare three graphs built from the acme ground-truth transcript with
different speaker-label conditions:

    --label-mode none       -> source="audio" on every line (baseline shape)
    --label-mode speaker    -> source=SPEAKER_NN (from the transcript)
    --label-mode merge      -> source="audio" but text is "SPEAKER_NN: text"
                               (preserves attribution inline; works without
                                distiller-prompt changes)

Input transcript format (JetBrains speech-kit style):

    [HH:MM:SS] SPEAKER_NN
    text spanning one or more lines until the next [HH:MM:SS] header

Output: prints the path of the produced knowledge-graph.db on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "sinain-hud-plugin" / "sinain-memory"


_HEADER_RE = re.compile(r"^\[(\d+):(\d+):(\d+)\]\s+(SPEAKER_\d+)\s*$", re.MULTILINE)


def parse_transcript(path: Path) -> list[dict]:
    """Return list of {speaker, ts_seconds, text} items in transcript order."""
    raw = path.read_text(encoding="utf-8")
    matches = list(_HEADER_RE.finditer(raw))
    items: list[dict] = []
    for i, m in enumerate(matches):
        hh, mm, ss, speaker = m.group(1), m.group(2), m.group(3), m.group(4)
        ts_seconds = int(hh) * 3600 + int(mm) * 60 + int(ss)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        text = raw[start:end].strip()
        if not text:
            continue
        items.append({"speaker": speaker, "ts_seconds": ts_seconds, "text": text})
    return items


def _load_online_speakers(path: Path) -> list[dict]:
    """Load the online-diarizer JSON output: list of {chunk, start, end, speaker}."""
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"online-diarization JSON must be a list, got {type(data).__name__}")
    return data


def _resolve_online_speaker(timeline: list[dict], ts_seconds: int) -> str | None:
    """Find which online chunk's window contains the given utterance timestamp.

    timeline is sorted by start (the online diarizer emits in chunk order).
    Returns the speaker label of the containing chunk, or None if past end.
    """
    for seg in timeline:
        if seg["start"] <= ts_seconds < seg["end"]:
            return seg["speaker"]
    # Tail utterance past the last chunk — bind to the final chunk's speaker.
    return timeline[-1]["speaker"] if timeline else None


def to_feed_items(
    parsed: list[dict],
    label_mode: str,
    base_ts_ms: int,
    online_timeline: list[dict] | None = None,
) -> list[dict]:
    """Convert parsed transcript items to the feed-item shape session_distiller.py expects.

    Always carries `speaker` as a separate field — Lever 4 (mentioned_by triples)
    in knowledge_integrator picks it up regardless of label_mode. label_mode
    only controls how speaker info appears (or doesn't) in the distiller's view
    of the transcript text/source.

    online_timeline: when provided (JSON loaded from tools/diarize-online.py
    output), the speaker label for each utterance is REPLACED by the online-
    derived speaker for the chunk containing the utterance's timestamp. This
    is the diarization-from-real-audio path; without it, transcript-baked GT
    speaker labels are used.
    """
    out: list[dict] = []
    for it in parsed:
        ts_ms = base_ts_ms + it["ts_seconds"] * 1000
        # Override the speaker from the online diarization timeline when present.
        effective_speaker = it["speaker"]
        if online_timeline:
            resolved = _resolve_online_speaker(online_timeline, it["ts_seconds"])
            if resolved:
                effective_speaker = resolved

        if label_mode == "none":
            text = it["text"]
            source = "audio"
        elif label_mode == "speaker":
            text = it["text"]
            source = effective_speaker
        elif label_mode == "merge":
            text = f"{effective_speaker}: {it['text']}"
            source = "audio"
        else:
            raise ValueError(f"unknown label_mode: {label_mode}")
        out.append({
            "source": source,
            "text": text,
            "ts": ts_ms,
            "speaker": effective_speaker,  # consumed by integrator for mentioned_by
        })
    return out


def _build_batches(feed_items: list[dict], batch_size: int, per_speaker: bool) -> list[list[dict]]:
    """Group feed items into batches for distillation.

    Default (per_speaker=False) preserves the original chunked-by-size behavior
    that keeps cross-speaker interaction context together.

    per_speaker=True groups items by their `speaker` field (Lever 4 — gives
    each speaker's utterances their own distillation pass, so resulting facts
    carry `mentioned_by` triples discriminative at the speaker level).
    Trades cross-speaker interaction context for attribution precision.
    """
    if not per_speaker:
        return [feed_items[i:i + batch_size] for i in range(0, len(feed_items), batch_size) if feed_items[i:i + batch_size]]

    by_speaker: dict[str, list[dict]] = {}
    for it in feed_items:
        spk = it.get("speaker") or "unknown"
        by_speaker.setdefault(spk, []).append(it)

    batches: list[list[dict]] = []
    for spk, items in by_speaker.items():
        # Within each speaker, still respect batch_size cap
        for i in range(0, len(items), batch_size):
            chunk = items[i:i + batch_size]
            if chunk:
                batches.append(chunk)
    return batches


def run_distillation(feed_items: list[dict], mem_dir: Path, batch_size: int = 50, per_speaker: bool = False) -> bool:
    """Invoke session_distiller.py + knowledge_integrator.py over the feed items.

    Returns True if at least one batch produced facts.

    per_speaker: when True, batches by speaker rather than by chunk window.
        See _build_batches docstring for the trade-off.
    """
    distiller = _SCRIPTS_DIR / "session_distiller.py"
    integrator = _SCRIPTS_DIR / "knowledge_integrator.py"
    if not distiller.is_file() or not integrator.is_file():
        raise RuntimeError(f"scripts not found in {_SCRIPTS_DIR}")

    env = os.environ.copy()
    # Make sure scripts can import from their own directory
    env["PYTHONPATH"] = str(_SCRIPTS_DIR) + ":" + env.get("PYTHONPATH", "")

    batches = _build_batches(feed_items, batch_size, per_speaker)
    print(f"[distill] grouping mode: {'per-speaker' if per_speaker else 'chunked'} -> {len(batches)} batch(es)", file=sys.stderr)

    any_facts = False
    for batch_index, batch in enumerate(batches):
        if not batch:
            continue
        meta = json.dumps({
            "ts": batch[0]["ts"],
            "sessionKey": f"offline-distill-batch-{batch_index}",
            "durationMs": (batch[-1]["ts"] - batch[0]["ts"]) if len(batch) > 1 else 30_000,
        })

        print(f"[distill] batch {batch_index}: {len(batch)} items "
              f"({batch[0]['ts']} .. {batch[-1]['ts']})", file=sys.stderr, flush=True)

        # 1) session_distiller.py
        try:
            result = subprocess.run(
                ["python3", str(distiller),
                 "--memory-dir", str(mem_dir),
                 "--transcript", json.dumps(batch),
                 "--session-meta", meta],
                env=env, capture_output=True, text=True, timeout=180, check=False,
            )
        except subprocess.TimeoutExpired:
            print(f"[distill] timeout on batch {batch_index}", file=sys.stderr)
            continue
        if result.returncode != 0:
            print(f"[distill] distiller exit {result.returncode}: {result.stderr[-400:]}", file=sys.stderr)
            continue

        digest_text = result.stdout.strip()
        try:
            digest = json.loads(digest_text)
        except json.JSONDecodeError:
            print(f"[distill] non-JSON output: {digest_text[:200]}", file=sys.stderr)
            continue

        if digest.get("isEmpty") or digest.get("error"):
            print(f"[distill] empty/error digest, skipping", file=sys.stderr)
            continue

        n_facts = len(digest.get("facts", []))
        print(f"[distill] batch {batch_index}: {n_facts} facts extracted", file=sys.stderr, flush=True)
        if n_facts > 0:
            any_facts = True

        # 2) knowledge_integrator.py
        try:
            result = subprocess.run(
                ["python3", str(integrator),
                 "--memory-dir", str(mem_dir),
                 "--digest", json.dumps(digest),
                 "--transcript", json.dumps(batch)],
                env=env, capture_output=True, text=True, timeout=120, check=False,
            )
        except subprocess.TimeoutExpired:
            print(f"[distill] integrator timeout", file=sys.stderr)
            continue
        if result.returncode != 0:
            print(f"[distill] integrator exit {result.returncode}: {result.stderr[-400:]}", file=sys.stderr)

    return any_facts


def main() -> None:
    p = argparse.ArgumentParser(description="Offline distillation from a labeled transcript")
    p.add_argument("--transcript", required=True, help="Path to transcript file (JetBrains speech-kit format)")
    p.add_argument("--out-dir", required=True, help="Destination directory for memory/ + knowledge-graph.db")
    p.add_argument("--label-mode", choices=["none", "speaker", "merge"], default="speaker",
                   help="How to expose speaker labels to the distiller")
    p.add_argument("--base-ts-ms", type=int, default=1717200000000,
                   help="Base epoch-ms timestamp for the synthesized chunk timeline (default ~2024-06-01 anchor)")
    p.add_argument("--batch-size", type=int, default=50)
    p.add_argument("--per-speaker", action="store_true",
                   help="Lever 4: group items by speaker rather than by chunk window. "
                        "Each speaker's utterances get their own distillation pass, so "
                        "facts carry discriminative mentioned_by triples (single-speaker per fact). "
                        "Trade-off: loses cross-speaker interaction context.")
    p.add_argument("--online-diarization", default=None,
                   help="Path to JSON output of tools/diarize-online.py. When set, the speaker "
                        "labels in transcript items are REPLACED by the online-derived speaker for "
                        "each utterance's containing chunk. Tests the real diarization pipeline "
                        "(audio embeddings → cross-chunk speaker manager) rather than relying on "
                        "ground-truth transcript labels.")
    args = p.parse_args()

    transcript_path = Path(args.transcript)
    if not transcript_path.is_file():
        print(f"error: transcript not found: {transcript_path}", file=sys.stderr)
        sys.exit(2)

    parsed = parse_transcript(transcript_path)
    if not parsed:
        print(f"error: parsed 0 items from {transcript_path}", file=sys.stderr)
        sys.exit(2)
    print(f"[distill] parsed {len(parsed)} transcript items "
          f"(speakers: {sorted({i['speaker'] for i in parsed})})", file=sys.stderr)

    online_timeline = None
    if args.online_diarization:
        ot_path = Path(args.online_diarization)
        if not ot_path.is_file():
            print(f"error: online-diarization JSON not found: {ot_path}", file=sys.stderr)
            sys.exit(2)
        online_timeline = _load_online_speakers(ot_path)
        print(f"[distill] online diarization: {len(online_timeline)} chunks, "
              f"{len({s['speaker'] for s in online_timeline})} unique speakers", file=sys.stderr)

    feed_items = to_feed_items(parsed, args.label_mode, args.base_ts_ms, online_timeline)
    print(f"[distill] mode={args.label_mode} -> {len(feed_items)} feed items", file=sys.stderr)
    if online_timeline:
        from collections import Counter
        replaced = Counter(i["speaker"] for i in feed_items)
        print(f"[distill] online-derived speaker dist in feed items: {dict(replaced)}", file=sys.stderr)

    out_dir = Path(args.out_dir).resolve()
    mem_dir = out_dir / "memory"
    if mem_dir.exists():
        shutil.rmtree(mem_dir)
    for sub in ["", "playbook-logs", "playbook-archive"]:
        (mem_dir / sub).mkdir(parents=True, exist_ok=True)
    (mem_dir / "sinain-playbook.md").write_text("# Sinain Playbook\n\n(offline distillation run)\n")

    ok = run_distillation(feed_items, mem_dir, batch_size=args.batch_size, per_speaker=args.per_speaker)
    db_path = mem_dir / "knowledge-graph.db"
    if not ok or not db_path.exists():
        print(f"error: distillation produced no graph at {db_path}", file=sys.stderr)
        sys.exit(3)

    print(str(db_path))


if __name__ == "__main__":
    main()
