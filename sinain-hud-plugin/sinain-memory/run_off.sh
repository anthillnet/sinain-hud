#!/usr/bin/env bash
# ISOLATION: RECON-OFF baseline with the COMMITTED code (determinism + HF changes in
# the default path). Reuses existing off-stores (det-k5 built them) -> QA-only, faster.
# Answers: did committing determinism/HF regress the 28/36 baseline?
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
unset SINAIN_RECON
export SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=5
LOG=/tmp/run_off.log
SCORE=/tmp/off_score.txt
OUT=eval/benchmarks/results/lme-36q-off-verify
echo "[run_off] start (RECON OFF, committed code)" > "$LOG"
while true; do
  python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 36 --stratified --judge-mode paper --output-dir "$OUT" --resume >> "$LOG" 2>&1
  rc=$?
  [ $rc -eq 0 ] && break
  echo "[run_off] runner rc=$rc, resume in 5s" >> "$LOG"
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
fails = sorted(q for q, v in seen.items() if v < 1)
open(sp, "w").write("OFF_VERIFY_FINAL: %d/%d\nFAILS: %s\n" % (p, len(seen), " ".join(fails)))
PY
echo "[run_off] ALL_DONE: $(cat "$SCORE")" >> "$LOG"
