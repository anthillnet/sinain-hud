#!/usr/bin/env bash
# Commit guard+RECON work, then run the full RECON-on 36-q bench (fresh re-distill
# where the store hash changed — the integrator kind-preservation edit changes the
# pipeline hash, so recon facts are re-tagged kind=recon and the read-side guard
# fires). The completed results.json is the gate. SINGLE runner, SIGTERM-only
# (NEVER kill -9), no watchdog. The stale-store guard_sanity gate is intentionally
# REMOVED — it false-negatived on a pre-edit store.
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=5
LOG=/tmp/run_all.log
SCORE=/tmp/guarded_score.txt
OUT=eval/benchmarks/results/lme-36q-recon-guard9
echo "[run_all] start (DETERMINISTIC clean: all fixes + recon input order)" > "$LOG"
# reconstruct.py + ingest grounding are NOT in the pipeline hash, so recon facts are
# baked stale in cached stores. Clear stores once for a clean, fully-deterministic
# rebuild (distiller is deterministic, so re-distill reproduces the same facts).
rm -rf eval/benchmarks/data/longmemeval/stores/*.db eval/benchmarks/data/longmemeval/stores/*.jsonl 2>/dev/null
echo "[run_all] cleared stores for clean re-distill" >> "$LOG"

# ---- Commit the work (local only; never pushed) ----
ROOT=../..
git -C "$ROOT" add \
  sinain-hud-plugin/sinain-memory/graph_query.py \
  sinain-hud-plugin/sinain-memory/reconstruct.py \
  sinain-hud-plugin/sinain-memory/knowledge_integrator.py \
  sinain-hud-plugin/sinain-memory/rdf_store.py \
  sinain-hud-plugin/sinain-memory/raw_store.py \
  sinain-hud-plugin/sinain-memory/embedder.py >> "$LOG" 2>&1
git -C "$ROOT" commit -F /tmp/commit_msg.txt >> "$LOG" 2>&1
echo "[run_all] committed: $(git -C "$ROOT" log --oneline -1)" >> "$LOG"

# ---- Full RECON-on 36-q bench (resume-on-crash; fresh stores re-distill) ----
while true; do
  python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 36 --stratified --judge-mode paper --output-dir "$OUT" --resume >> "$LOG" 2>&1
  rc=$?
  [ $rc -eq 0 ] && break
  echo "[run_all] runner rc=$rc, resume in 5s" >> "$LOG"
  sleep 5
done

# ---- Post-hoc guard confirmation on a freshly-built store (informational) ----
python3 guard_sanity_fresh.py >> "$LOG" 2>&1 || true

# ---- Score the completed run ----
python3 - "$OUT" "$SCORE" >> "$LOG" 2>&1 <<'PY'
import json, sys, os
out, sp = sys.argv[1], sys.argv[2]
seen = {}
prog = os.path.join(out, "longmemeval_progress.jsonl")
for line in open(prog):
    try: r = json.loads(line)
    except Exception: continue
    a = r.get("answers", {}).get("sinain-memory", {})
    v = a.get("paper_label")
    if v is None: v = a.get("score") or 0
    seen[r["id"]] = float(v or 0)
p = sum(1 for v in seen.values() if v >= 1)
open(sp, "w").write("RECON_GUARD_FINAL: %d/%d\n" % (p, len(seen)))
PY
echo "[run_all] ALL_DONE: $(cat "$SCORE")" >> "$LOG"
