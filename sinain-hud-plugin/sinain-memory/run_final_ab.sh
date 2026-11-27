#!/usr/bin/env bash
# Definitive same-store A/B over all 36 trio2 stores (cache-hit, NO re-distill): proves the
# read-side trio (#3b/#4/#5 + temporal-duration fix) is regression-free. Variance is held
# constant (identical stores), so any ON-vs-OFF per-question delta is PURELY the read-side code.
#   ON  = default (all features on, with the temporal-duration fix)
#   OFF = all read-side features disabled (= baseline retrieval on the same stores)
# QA_VOTES=3. Does NOT clear stores.
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=3
LOG=/tmp/final_ab.log
echo "[ab] start $(date)" > "$LOG"
run() { # $1=label $2=outdir extra-env...
  local lab=$1; local out=$2; shift 2
  rm -rf "$out" 2>/dev/null
  echo "[ab] === $lab ===" >> "$LOG"
  env "$@" python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 36 --stratified --judge-mode paper --output-dir "$out" --resume >> "$LOG" 2>&1
}
run "ON (default+fix)"  eval/benchmarks/results/lme-36q-final-on
run "OFF (read-side off)" eval/benchmarks/results/lme-36q-final-off \
  SINAIN_ENTROPY_FUSION=0 SINAIN_RECON_RETRACT=0 SINAIN_DPP_COUNTING=0
python3 - <<'PY' >> "$LOG" 2>&1
import json
def load(p):
    d={}
    for l in open(p):
        try:r=json.loads(l)
        except:continue
        a=r.get("answers",{}).get("sinain-memory",{})
        v=a.get("paper_label"); v=float(v if v is not None else (a.get("score") or 0) or 0)
        d[r["id"]]=(r.get("category"),v)
    return d
on=load("eval/benchmarks/results/lme-36q-final-on/longmemeval_progress.jsonl")
off=load("eval/benchmarks/results/lme-36q-final-off/longmemeval_progress.jsonl")
P=lambda d:sum(1 for _,v in d.values() if v>=1)
print(f"ON(default+fix): {P(on)}/{len(on)}   OFF(read-side off): {P(off)}/{len(off)}")
regr=[q for q in on if on[q][1]<1 and off.get(q,(None,0))[1]>=1]
gain=[q for q in on if on[q][1]>=1 and off.get(q,(None,0))[1]<1]
print("CODE-CAUSED REGRESSIONS (ON fail, OFF pass):", regr)
print("CODE GAINS (ON pass, OFF fail):", gain)
open("/tmp/final_ab_score.txt","w").write(f"ON {P(on)}/{len(on)} OFF {P(off)}/{len(off)} regr={regr} gain={gain}\n")
PY
echo "[ab] ALL_DONE: $(cat /tmp/final_ab_score.txt)" >> "$LOG"
