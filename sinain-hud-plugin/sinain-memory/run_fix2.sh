#!/usr/bin/env bash
# Surgical re-run of ONLY the 2 timeout/gap regressions (852ce960, gpt4_fa19884c):
# delete their stores -> re-distill with the new 90s+retry budget -> re-QA just those
# two via --resume (the other 34 keep their results, no QA re-roll). Re-score full 36.
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=5
OUT=eval/benchmarks/results/lme-36q-recon-guard2
PROG="$OUT/longmemeval_progress.jsonl"
STORES=eval/benchmarks/data/longmemeval/stores
LOG=/tmp/run_fix2.log
SCORE=/tmp/fix2_score.txt
echo "[fix2] start" > "$LOG"

# 1) delete the two affected stores (dir + raw-chunks sidecar) so they re-distill
for h in 3dc85e0dbdc9f258 880ab68e594e6b9a; do
  rm -rf "$STORES/$h.db" "$STORES/$h.db.raw-chunks.jsonl"
  echo "[fix2] removed store $h" >> "$LOG"
done

# 2) drop the two target rows from progress so --resume re-processes them
cp "$PROG" "$PROG.bak.fix2"
grep -v '"852ce960"' "$PROG.bak.fix2" | grep -v '"gpt4_fa19884c"' > "$PROG"
echo "[fix2] progress lines now: $(wc -l < "$PROG") (was 36)" >> "$LOG"

# 3) resume — re-distills the 2 deleted stores (90s+retry) and re-QAs them
while true; do
  python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 36 --stratified --judge-mode paper --output-dir "$OUT" --resume >> "$LOG" 2>&1
  rc=$?
  [ $rc -eq 0 ] && break
  echo "[fix2] runner rc=$rc, resume in 5s" >> "$LOG"
  sleep 5
done

# 4) score
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
open(sp, "w").write("FIX2_FINAL: %d/%d\nFAILS: %s\n" % (p, len(seen), " ".join(fails)))
PY
echo "[fix2] ALL_DONE: $(cat "$SCORE")" >> "$LOG"
