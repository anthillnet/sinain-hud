#!/usr/bin/env bash
# Batched FULL LongMemEval (all 500 questions, not the 36-q subset). Runs in contiguous batches via
# the runner's --offset, scoring + CI + per-type breakdown after each batch so we get incremental
# signal instead of waiting hours for one monolithic run. Resumable (offset batches + --resume skip
# by id). Stores cleaned per batch to bound disk (500 re-distilled haystacks otherwise balloon).
#
# DO NOT run concurrently with run_full.sh (36-q) — both re-distill + clear stores and would collide.
# Launch this only after the 36-q run finishes. Output dir is separate (lme-500) so it won't clash.
#
# Tunables (env): BATCH (default 50), TOTAL (500), START (0), CLEAN_STORES (1), and the flag line below.
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

# SAFE PRODUCTION flag set (handoff verdict): base + read-side trio (#3/#3b/#4/#5 default-on) + #2 + #1
# + #6b score-only. GAPFILL + RECURRENCE_DROP gated OFF. Scaffolds (COUNT/PREF/REDUCE) OFF for this
# first full-500 BASELINE — toggle them on later for the same-store A/B at scale.
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=5
export SINAIN_MANIFOLD_CANON=1 SINAIN_SURPRISAL_SALIENCE=1 SINAIN_RECURRENCE=1
export SINAIN_GAPFILL=0 SINAIN_RECURRENCE_DROP=0

BATCH="${BATCH:-50}"; TOTAL="${TOTAL:-500}"; START="${START:-0}"; CLEAN_STORES="${CLEAN_STORES:-1}"
OUT=eval/benchmarks/results/lme-500
STORES=eval/benchmarks/data/longmemeval/stores
LOG=/tmp/lme500.log
mkdir -p "$OUT"
echo "[run] start $(date)  BATCH=$BATCH TOTAL=$TOTAL START=$START" | tee -a "$LOG"

report() {  # cumulative score + per-type breakdown + CI over OUT/progress.jsonl
  python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
prog = os.path.join(out, "longmemeval_progress.jsonl")
ds = json.load(open("eval/benchmarks/data/longmemeval/longmemeval_s_cleaned.json"))
typ = {(q.get("question_id") or q.get("id")): q.get("question_type", "?") for q in ds}
seen = {}
for l in open(prog):
    try: r = json.loads(l)
    except: continue
    a = r.get("answers", {}).get("sinain-memory", {})
    v = a.get("paper_label"); v = float(v if v is not None else (a.get("score") or 0) or 0)
    seen[r["id"]] = v
from collections import Counter
tot = Counter(); pas = Counter()
for k, v in seen.items():
    t = typ.get(k, "?"); tot[t] += 1; pas[t] += (1 if v >= 1 else 0)
P = sum(1 for v in seen.values() if v >= 1); N = len(seen)
print(f"  CUMULATIVE: {P}/{N} = {100*P/max(1,N):.1f}%")
for t in sorted(tot):
    print(f"    {t:26s} {pas[t]:3d}/{tot[t]:<3d}  {100*pas[t]/tot[t]:.0f}%")
# Wilson 95% CI on the overall rate
if N:
    import math
    p = P / N; z = 1.96; den = 1 + z*z/N
    c = (p + z*z/(2*N)) / den; h = z*math.sqrt(p*(1-p)/N + z*z/(4*N*N)) / den
    print(f"  Wilson 95% CI: [{100*(c-h):.1f}%, {100*(c+h):.1f}%]")
PY
}

for ((O=START; O<TOTAL; O+=BATCH)); do
  echo "[run] === batch offset=$O size=$BATCH ($(date)) ===" | tee -a "$LOG"
  while true; do
    python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
      --offset "$O" --subset "$BATCH" --judge-mode paper --output-dir "$OUT" --resume >> "$LOG" 2>&1
    rc=$?; [ $rc -eq 0 ] && break
    echo "[run] rc=$rc resume in 5s" >> "$LOG"; sleep 5
  done
  echo "[report] after batch offset=$O:" | tee -a "$LOG"; report | tee -a "$LOG"
  [ "$CLEAN_STORES" = "1" ] && rm -rf "$STORES"/*.db "$STORES"/*.jsonl 2>/dev/null  # scored → stores disposable (resume skips by id)
done
echo "[run] ALL_DONE $(date)" | tee -a "$LOG"; report | tee -a "$LOG"
