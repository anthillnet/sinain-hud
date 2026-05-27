#!/usr/bin/env bash
# Local retrieval-drift check — re-runs a captured NDJSON baseline through the
# current graph_query.py code and reports Jaccard@k / top-1 stability / latency Δ.
# Wired into .git/hooks/pre-commit; safe to run standalone.
#
# Usage:
#   scripts/memory-replay-check.sh              # check current code vs baseline
#   scripts/memory-replay-check.sh --refresh    # capture a new baseline (slow, ~1min)
#
# Baseline and reports live at ~/.sinain/eval/ (never committed — eval-as-private).

set -euo pipefail

# EVAL-05 safety: refuse to capture or replay against an ablated baseline.
# An ablated baseline would silently corrupt drift gating — ablation runs
# stub out retrieval/distiller/integrator and replay against them produces
# nonsense Jaccard@10.
if [[ -n "${SINAIN_ABLATE:-}" && "${SINAIN_ABLATE}" != "none" ]]; then
  echo "[replay-check] ERROR: SINAIN_ABLATE=${SINAIN_ABLATE} set — refusing to capture or replay against an ablated baseline. Unset SINAIN_ABLATE and retry." >&2
  exit 3
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEM_DIR="$ROOT/sinain-hud-plugin/sinain-memory"

BASELINE_HOME="${SINAIN_EVAL_HOME:-$HOME/.sinain/eval}"
BASELINE_PATH="$BASELINE_HOME/baseline.ndjson"
REPORT_PATH="$BASELINE_HOME/last-replay.json"

SUBSET="${SINAIN_REPLAY_SUBSET:-30}"
JACCARD_K="${SINAIN_REPLAY_K:-10}"
THRESHOLD="${SINAIN_REPLAY_THRESHOLD:-0.85}"
TOP1_THRESHOLD="${SINAIN_REPLAY_TOP1_THRESHOLD:-0.85}"

mkdir -p "$BASELINE_HOME"

# Pull OPENROUTER_API_KEY etc. from project .env so bootstrap-ingestion works
# in a clean shell (pre-commit hook runs without inherited env).
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ "${1:-}" == "--refresh" ]]; then
  # Reminder: SINAIN_ABLATE must remain unset (or 'none') during --refresh; the guard above enforces this.
  echo "[replay-check] capturing fresh baseline (subset=$SUBSET) ..."
  rm -f "$BASELINE_PATH"
  CAPTURE_TMP="${SINAIN_MEMORY_DIR:-$HOME/.sinain/memory}/eval-captures.ndjson"
  rm -f "$CAPTURE_TMP"
  cd "$MEM_DIR"
  SINAIN_EVAL_CAPTURE=1 python3 -m eval.local_models.bench_retrieval \
    --subset "$SUBSET" --reps 1 --seed 42 \
    --out "$BASELINE_HOME/refresh-bench.json" >&2
  if [[ ! -s "$CAPTURE_TMP" ]]; then
    echo "[replay-check] ERROR: capture file $CAPTURE_TMP is empty — hook not firing?" >&2
    exit 2
  fi
  mv "$CAPTURE_TMP" "$BASELINE_PATH"
  ROWS=$(wc -l < "$BASELINE_PATH" | tr -d ' ')
  echo "[replay-check] baseline captured: $ROWS rows → $BASELINE_PATH" >&2
  exit 0
fi

if [[ ! -s "$BASELINE_PATH" ]]; then
  echo "[replay-check] no baseline at $BASELINE_PATH — skipping (run with --refresh to create one)" >&2
  exit 0
fi

cd "$MEM_DIR"
python3 -m eval.local_models.replay \
  --against "$BASELINE_PATH" \
  --reps 1 \
  --jaccard-k "$JACCARD_K" \
  --out "$REPORT_PATH" >&2

# Parse Jaccard mean + top-1 stability from the report; both must clear thresholds.
python3 - "$REPORT_PATH" "$JACCARD_K" "$THRESHOLD" "$TOP1_THRESHOLD" <<'PY'
import json, sys
report_path, k = sys.argv[1], int(sys.argv[2])
j_threshold, t1_threshold = float(sys.argv[3]), float(sys.argv[4])
report = json.loads(open(report_path).read())
cfg = report.get("config", {})
n_scored = cfg.get("n_scored", 0)
# If no queries could be scored (e.g. baseline DB paths absent in a fresh worktree),
# thresholds are meaningless — skip gracefully rather than falsely failing.
if n_scored == 0:
    n_skip = cfg.get("n_skipped", cfg.get("n_baseline_rows", 0))
    print(f"[replay-check] SKIP — 0/{n_skip} queries scored (DB paths unavailable); no drift to measure", file=sys.stderr)
    sys.exit(0)
agg = report["aggregate"]
key = f"jaccard_at_{k}_mean"
mean = agg[key]
top1 = agg["top1_stability_rate"]
delta = agg["latency_delta_ms_median"]
print(f"[replay-check] jaccard@{k}_mean={mean:.3f} (≥{j_threshold:.2f})  top1={top1*100:.1f}% (≥{t1_threshold*100:.0f}%)  Δlat={delta:+.1f}ms", file=sys.stderr)
fails = []
if mean < j_threshold:
    fails.append(f"jaccard@{k}_mean {mean:.3f} < {j_threshold:.2f} — result SET diverged")
if top1 < t1_threshold:
    fails.append(f"top1_stability {top1:.3f} < {t1_threshold:.2f} — top result ORDER diverged")
if fails:
    print(f"[replay-check] FAIL: {len(fails)} threshold(s) breached", file=sys.stderr)
    for f in fails:
        print(f"  - {f}", file=sys.stderr)
    print(f"[replay-check] inspect: {report_path}", file=sys.stderr)
    print(f"[replay-check] intentional change? rebaseline:  scripts/memory-replay-check.sh --refresh", file=sys.stderr)
    sys.exit(1)
print("[replay-check] OK", file=sys.stderr)
PY
