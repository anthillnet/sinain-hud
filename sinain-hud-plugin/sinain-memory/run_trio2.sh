#!/usr/bin/env bash
# Combined trio bench, RESUME variant: #3 + #3b (recon contradiction-retraction) + #4 + #5.
# Does NOT clear stores — reuses the ~11 already-built trio stores (cache-hit, no re-distill)
# and only distills the ~25 missing ones. #3's recon facts are already baked in the cached
# stores (reconstruct.py unchanged since they were built); #3b/#4/#5 are read-side (query-time,
# default-on in graph_query.py). FRESH output dir so ALL 36 are answered with #3b active
# (the old lme-36q-trio progress holds pre-#3b scores and must not be resumed).
# SINGLE runner, SIGTERM-only. Compare to f3 baseline (30/36).
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=5
# #3b/#4/#5 default-on in graph_query.py (SINAIN_RECON_RETRACT / ENTROPY_FUSION / DPP_COUNTING).
LOG=/tmp/trio2.log
SCORE=/tmp/trio2_score.txt
OUT=eval/benchmarks/results/lme-36q-trio2
echo "[run] start (reuse cached stores) $(date)" > "$LOG"
echo "[run] cached stores present: $(ls -d eval/benchmarks/data/longmemeval/stores/*.db 2>/dev/null | wc -l)" >> "$LOG"
rm -rf "$OUT" 2>/dev/null
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
open(sp, "w").write("TRIO2: %d/%d\nFAILS: %s\n" % (p, len(seen), fails))
PY
echo "[run] ALL_DONE: $(cat "$SCORE")" >> "$LOG"
