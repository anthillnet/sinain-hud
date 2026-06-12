#!/usr/bin/env python3
"""Speaker diarization sidecar — runs sherpa-onnx on a WAV file, emits JSON segments.

Output (stdout): JSON array of {speaker, start, end} where speaker is "SPEAKER_NN"
and start/end are seconds (float).

Usage:
    python3 tools/diarize-sidecar.py --wav path/to/audio.wav [--num-speakers N]

Why sherpa-onnx and not pyannote.audio:
    sherpa-onnx uses the same pyannote-segmentation-3.0 backbone but redistributes
    the weights as ONNX without HF gating. CAM++/3D-Speaker for embeddings. No HF
    token, no torch dependency, ~35MB total.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import sherpa_onnx
import soundfile as sf
import librosa


_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_SEG_MODEL = _REPO_ROOT / "tools" / "diarization-models" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
_DEFAULT_EMBED_MODEL = _REPO_ROOT / "tools" / "diarization-models" / "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"


def init_diarization(seg_model: str, embed_model: str, num_speakers: int, cluster_threshold: float) -> sherpa_onnx.OfflineSpeakerDiarization:
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg_model),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=embed_model),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=cluster_threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Diarization config invalid — check model paths")
    return sherpa_onnx.OfflineSpeakerDiarization(config)


def diarize(wav_path: str, sd: sherpa_onnx.OfflineSpeakerDiarization, progress_fd=None) -> list[dict]:
    audio, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
    audio = audio[:, 0]  # mono
    if sample_rate != sd.sample_rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=sd.sample_rate)

    if progress_fd is not None:
        def _cb(processed: int, total: int) -> int:
            print(f"[diarize] {processed}/{total} chunks ({processed/total*100:.1f}%)", file=progress_fd, flush=True)
            return 0
        result = sd.process(audio, callback=_cb).sort_by_start_time()
    else:
        result = sd.process(audio).sort_by_start_time()

    return [
        {
            "speaker": f"SPEAKER_{r.speaker:02d}",
            "start": round(float(r.start), 3),
            "end": round(float(r.end), 3),
        }
        for r in result
    ]


def main() -> None:
    p = argparse.ArgumentParser(description="sherpa-onnx speaker diarization sidecar")
    p.add_argument("--wav", required=True, help="Path to input WAV file (any sample rate; resampled if needed)")
    p.add_argument("--num-speakers", type=int, default=-1,
                   help="Force speaker count. Default -1 = auto-cluster.")
    p.add_argument("--cluster-threshold", type=float, default=0.5,
                   help="Clustering threshold when num-speakers=-1. Lower = more clusters.")
    p.add_argument("--seg-model", default=str(_DEFAULT_SEG_MODEL))
    p.add_argument("--embed-model", default=str(_DEFAULT_EMBED_MODEL))
    p.add_argument("--progress", action="store_true",
                   help="Emit progress lines to stderr")
    args = p.parse_args()

    if not Path(args.wav).is_file():
        print(f"error: WAV not found: {args.wav}", file=sys.stderr)
        sys.exit(2)
    if not Path(args.seg_model).is_file():
        print(f"error: segmentation model not found: {args.seg_model}", file=sys.stderr)
        sys.exit(2)
    if not Path(args.embed_model).is_file():
        print(f"error: embedding model not found: {args.embed_model}", file=sys.stderr)
        sys.exit(2)

    sd = init_diarization(args.seg_model, args.embed_model, args.num_speakers, args.cluster_threshold)
    segments = diarize(args.wav, sd, progress_fd=sys.stderr if args.progress else None)
    json.dump(segments, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
