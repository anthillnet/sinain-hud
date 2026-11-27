#!/usr/bin/env bash
# Full 36-q bench, ALL new features ON (PRODUCTION setup): read-side trio (#3/#3b/#4/#5,
# default-on) + #1 surprisal salience + #2 manifold canonicalization. (#6 static gapfill excluded
# = noisy on LME; #6b recurrence excluded = no query-time read / recall-risk.) Clean re-distill
# (HASHED stages changed). Compare to f3 baseline 30/36.
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=5
export SINAIN_MANIFOLD_CANON=1 SINAIN_SURPRISAL_SALIENCE=1 SINAIN_GAPFILL=1 SINAIN_RECURRENCE=1 SINAIN_RECURRENCE_DROP=1
LOG=/tmp/full.log; SCORE=/tmp/full_score.txt; OUT=eval/benchmarks/results/lme-36q-full
echo "[run] start $(date)" > "$LOG"
rm -rf eval/benchmarks/data/longmemeval/stores/*.db eval/benchmarks/data/longmemeval/stores/*.jsonl 2>/dev/null
rm -rf "$OUT" 2>/dev/null
while true; do
  python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 36 --stratified --judge-mode paper --output-dir "$OUT" --resume >> "$LOG" 2>&1
  rc=$?; [ $rc -eq 0 ] && break
  echo "[run] rc=$rc resume in 5s" >> "$LOG"; sleep 5
done
python3 - "$OUT" "$SCORE" >> "$LOG" 2>&1 <<'PY'
import json,sys,os
out,sp=sys.argv[1],sys.argv[2]; seen={}
for l in open(os.path.join(out,"longmemeval_progress.jsonl")):
    try: r=json.loads(l)
    except: continue
    a=r.get("answers",{}).get("sinain-memory",{}); v=a.get("paper_label"); v=float(v if v is not None else (a.get("score") or 0) or 0)
    seen[r["id"]]=v
p=sum(1 for v in seen.values() if v>=1); fails=sorted(k for k,v in seen.items() if v<1)
open(sp,"w").write("FULL: %d/%d\nFAILS: %s\n"%(p,len(seen),fails))
PY
echo "[run] ALL_DONE: $(cat "$SCORE")" >> "$LOG"
