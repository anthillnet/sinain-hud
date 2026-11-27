#!/bin/bash
# Sequential single-runner retry loop (NO overlap: each runner runs to exit before the next).
# Cache accumulates across retries, so each fresh process re-distills fewer haystacks until
# one run completes all 36 without OOM and writes results.json.
cd /Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-hud-plugin/sinain-memory
set -a && source ../../.env 2>/dev/null; set +a
OUT=eval/benchmarks/results/lme-36q-recon2
uniq_done () { python3 -c "import json;s=set()
[s.add((json.loads(l).get('id'))) for l in open('$OUT/longmemeval_progress.jsonl')]
print(len(s))" 2>/dev/null || echo 0; }
for i in $(seq 1 10); do
  pkill -9 -f "eval.benchmarks.runner" 2>/dev/null; sleep 2
  u=$(uniq_done); echo "[retry $i] unique_done=$u/36 $(date +%H:%M:%S)"
  [ "${u:-0}" -ge 36 ] && { echo "ALL 36 DONE"; break; }
  SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1 SINAIN_QA_VOTES=9 \
    python3 -u -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 36 --stratified --judge-mode paper --output-dir "$OUT" --resume
  echo "[retry $i] runner exited rc=$?"
done
python3 -c "import json;d=json.load(open('$OUT/longmemeval_results.json'));det=d['details'];u=len(set(r['id'] for r in det));p=sum(int(r['answers']['sinain-memory']['paper_label']) for r in det);base={'06878be2','0a995998','0edc2aef','32260d93','51a45a95','830ce83f','d7c942c3','gpt4_59c863d7'};gf=set(r['id'] for r in det if not int(r['answers']['sinain-memory']['paper_label']));print(f'RECON_FINAL: {p}/{len(det)} unique={u}');print('fixed_vs_28:',sorted(base-gf));print('regressed:',sorted(gf-base))" > /tmp/recon2_score.txt 2>&1
echo "===== FINAL ====="; cat /tmp/recon2_score.txt; echo "ALL_DONE"
