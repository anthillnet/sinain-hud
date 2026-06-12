#!/usr/bin/env python3
"""Online streaming-mode speaker diarization with cross-chunk persistent identity.

Architecture (Lever-4-aware companion to tools/diarize-sidecar.py):

    tools/diarize-sidecar.py     — offline batch: clusters all segments in one
                                   pass via OfflineSpeakerDiarization. Loses
                                   streaming applicability but is the
                                   highest-quality reference for whole-file
                                   diarization.

    tools/diarize-online.py      — streaming-ish: slices audio into N-second
   (this file)                     chunks, extracts ONE embedding per chunk,
                                   matches against a persistent
                                   SpeakerEmbeddingManager. Labels are stable
                                   across chunks because the manager keeps
                                   centroids over the whole session — exactly
                                   what the production live-capture path
                                   would need. No HF token (uses 3D-Speaker
                                   CAM++ ONNX, same model as the offline
                                   sidecar).

For the production live-pipeline integration this module is a one-to-one
reference: a long-lived sidecar process holds the
SpeakerEmbeddingManager warm, accepts WAV chunks via stdin/socket, returns
{speaker} per chunk. The per-chunk inference cost is the same ~200-300ms
we measured.

Per-chunk vs per-segment granularity:
    Current implementation = one speaker per chunk. Trade-off documented in
    .planning/phases/diarization-levers/00-PLAN.md. Most 5s chunks are
    single-speaker; the cases where they aren't (rapid turn-taking) cost us
    attribution precision but not pipeline correctness.

Usage:
    python3 tools/diarize-online.py --wav path/to/audio.wav \\
        [--chunk-duration 5.0] [--threshold 0.5]

Output (stdout): JSON array of {chunk, start, end, speaker} entries.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import sherpa_onnx
import soundfile as sf
import librosa
import numpy as np


_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_EMBED_MODEL = _REPO_ROOT / "tools" / "diarization-models" / "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"

# 3D-Speaker CAM++ models expect 16 kHz mono audio.
_EMBED_SAMPLE_RATE = 16000


def online_diarize(
    wav_path: str,
    embed_model: str,
    chunk_duration: float,
    threshold: float,
    progress_fd=None,
) -> list[dict]:
    """Slide a fixed-size window across the audio; assign each chunk to a
    persistent speaker via SpeakerEmbeddingManager.

    Returns: list of {chunk, start, end, speaker, similarity}.
    """
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=embed_model)
    if not cfg.validate():
        raise RuntimeError(f"embedding-model config invalid: {embed_model}")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    mgr = sherpa_onnx.SpeakerEmbeddingManager(extractor.dim)

    audio, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
    audio = audio[:, 0]
    if sample_rate != _EMBED_SAMPLE_RATE:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=_EMBED_SAMPLE_RATE)
        sample_rate = _EMBED_SAMPLE_RATE

    chunk_samples = int(chunk_duration * sample_rate)
    total_chunks = (len(audio) + chunk_samples - 1) // chunk_samples
    out: list[dict] = []
    skipped = 0

    for i in range(total_chunks):
        start_sample = i * chunk_samples
        end_sample = min(start_sample + chunk_samples, len(audio))
        chunk = audio[start_sample:end_sample]
        # Reject very short tail chunks — embeddings on <0.5s windows are noisy.
        if len(chunk) < int(0.5 * sample_rate):
            skipped += 1
            continue

        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate, chunk)
        stream.input_finished()
        if not extractor.is_ready(stream):
            skipped += 1
            continue
        emb = extractor.compute(stream)
        emb_np = np.asarray(emb, dtype=np.float32)

        # Match against persistent manager. SpeakerEmbeddingManager.search
        # returns the matched name as a string (empty when below threshold).
        match = mgr.search(emb_np, threshold=threshold)
        similarity = None
        if match:
            speaker_label = match
            # Score for telemetry / debug.
            try:
                similarity = float(mgr.score(speaker_label, emb_np))
            except Exception:
                similarity = None
        else:
            speaker_label = f"SPEAKER_{mgr.num_speakers:02d}"
            mgr.add(speaker_label, emb_np)
            similarity = 1.0  # newly-registered, by definition matches self

        entry = {
            "chunk": i,
            "start": round(i * chunk_duration, 3),
            "end": round(i * chunk_duration + len(chunk) / sample_rate, 3),
            "speaker": speaker_label,
            "similarity": round(similarity, 3) if similarity is not None else None,
        }
        out.append(entry)

        if progress_fd is not None:
            print(
                f"[online] chunk {i+1}/{total_chunks} {entry['start']:.2f}-{entry['end']:.2f}s "
                f"-> {speaker_label} (sim={entry['similarity']}) | "
                f"known={mgr.num_speakers}",
                file=progress_fd,
                flush=True,
            )

    if progress_fd is not None:
        print(
            f"[online] done. {len(out)} chunks labelled, {skipped} skipped. "
            f"{mgr.num_speakers} unique speakers discovered. roster={list(mgr.all_speakers)}",
            file=progress_fd,
        )
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Online streaming-style speaker diarization")
    p.add_argument("--wav", required=True, help="Path to input WAV file (any rate; resampled if needed)")
    p.add_argument("--chunk-duration", type=float, default=5.0,
                   help="Seconds per chunk. Default 5.0 — matches sinain-core's live capture chunk size.")
    p.add_argument("--threshold", type=float, default=0.5,
                   help="Cosine similarity threshold for matching new embedding to existing "
                        "speaker centroid. Lower = more clusters, higher = fewer. Default 0.5.")
    p.add_argument("--embed-model", default=str(_DEFAULT_EMBED_MODEL))
    p.add_argument("--progress", action="store_true",
                   help="Emit progress lines to stderr (chunk-by-chunk decisions)")
    args = p.parse_args()

    if not Path(args.wav).is_file():
        print(f"error: WAV not found: {args.wav}", file=sys.stderr)
        sys.exit(2)
    if not Path(args.embed_model).is_file():
        print(f"error: embedding model not found: {args.embed_model}", file=sys.stderr)
        sys.exit(2)

    segments = online_diarize(
        args.wav, args.embed_model, args.chunk_duration, args.threshold,
        progress_fd=sys.stderr if args.progress else None,
    )
    json.dump(segments, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
