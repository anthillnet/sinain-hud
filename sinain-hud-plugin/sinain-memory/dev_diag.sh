#!/usr/bin/env bash
# Cheap dev-loop: run diag_oneq for a qid under RECON-on, no re-distill.
# Usage: ./dev_diag.sh <qid> [k]
set -e
cd "$(dirname "$0")"
set -a; source ../../.env; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1
python3 -m eval.benchmarks.diag_oneq "$1" "${2:-5}"
