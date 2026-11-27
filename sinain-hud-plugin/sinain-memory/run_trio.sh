#!/usr/bin/env bash
# Combined read-side-trio bench: #3 change-point supersession (reconstruct.py),
# #4 entropy-weighted fusion (graph_query.py, default-on), #5 DPP counting selection
# (graph_query.py, default-on). Mirrors run_f3.sh. Clean re-distill is REQUIRED:
# reconstruct.py is NOT in the pipeline hash, so cached stores hold stale recon — #3's
# new change-point facts only bake on a fresh ingest. #4/#5 are query-time (ride along).
# SINGLE runner, SIGTERM-only, no watchdog. No auto-commit: the completed results.json
# is the gate. Compare to f3 baseline (30/36).
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=5
# #4/#5 default-on in graph_query.py (SINAIN_ENTROPY_FUSION / SINAIN_DPP_COUNTING) — no export needed.
LOG=/tmp/trio.log
SCORE=/tmp/trio_score.txt
OUT=eval/benchmarks/results/lme-36q-trio
echo "[run] start clean re-distill $(date)" > "$LOG"
rm -rf eval/benchmarks/data/longmemeval/stores/*.db eval/benchmarks/data/longmemeval/stores/*.jsonl 2>/dev/null
rm -rf "$OUT" 2>/dev/null; echo "[run] cleared stores + output dir" >> "$LOG"
while true; do
  python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 36 --stratified --judge-mode paper --output-dir "$OUT" --resume >> "$LOG" 2>&1
  rc=$?
  [ $rc -eq 0 ] && break
  echo "[run] runner rc=$rc, resume in 5s" >> "$LOG"
  sleep 5
done
python3 - "$OUT" "$SCORE" >> "$LOG" 2>&1 <<'PY'
import json, sys, os
out, sp = sys.argv[1], sys.argv[2]
seen = {}
for line in open(os.path.join(out, "longmemeval_progress.jsonl")):
    try: r = json.loads(line)
    except Exception: continue
    a = r.get("answers", {}).get("sinain-memory", {})
    v = a.get("paper_label")
    if v is None: v = a.get("score") or 0
    seen[r["id"]] = float(v or 0)
p = sum(1 for v in seen.values() if v >= 1)
fails = sorted(k for k, v in seen.items() if v < 1)
open(sp, "w").write("TRIO: %d/%d\nFAILS: %s\n" % (p, len(seen), fails))
PY
echo "[run] ALL_DONE: $(cat "$SCORE")" >> "$LOG"
