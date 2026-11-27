#!/usr/bin/env bash
# #2 determinism harness (IG_features.md prescribed): re-distill the 75832dbd haystack 2x
# WITHOUT and 2x WITH manifold canonicalization, measure run-to-run SEMANTIC Jaccard.
# #2 succeeds if J_on > J_off (canonicalization converts string variance into semantic
# stability). Same config both conditions except SINAIN_MANIFOLD_CANON. ~4 full distills.
set -u
cd "$(dirname "$0")"
set -a; source ../../.env 2>/dev/null; set +a
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export SINAIN_RECON=1 SINAIN_SUPERSEDE=1 SINAIN_TEMPORAL_DATES=1 SINAIN_RAW_CHUNKS=1
LOG=/tmp/manifold_harness.log
echo "[mh] start $(date)" > "$LOG"
python3 -u - >> "$LOG" 2>&1 <<'PY'
import sys, os, shutil; sys.path.insert(0,".")
from pathlib import Path
from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.ingest import ingest_instance
from eval.benchmarks.config import DATA_DIR
from embed_client import embed
from triplestore import TripleStore

QID="75832dbd"
ad=LongMemEvalAdapter(); insts=ad.load_dataset(str(DATA_DIR))
inst=next(i for i in insts if any(q.id==QID for q in i.questions))
cache=Path("eval/benchmarks/data/longmemeval")

def fresh_ingest():
    # force a fresh distill: remove the cached .db dir for the current salt config
    # (ingest_instance returns cached if present); sidecar (deterministic raw) is kept.
    ch_db=None
    # discover path by a dry call then rm, or just rm any matching after first build:
    p=ingest_instance(inst, cache)           # builds or cache-hits
    if p and Path(p).exists(): shutil.rmtree(p)   # remove so next call rebuilds fresh
    p=ingest_instance(inst, cache)           # FRESH distill
    return str(p)

def facts_of(db):
    st=TripleStore(db); out=[]
    for fid,_ in st.entities_with_attr("value"):
        if not str(fid).startswith("fact:"): continue
        a=st.entity(fid)
        if a.get("valid_to"): continue            # current-state only
        v=a.get("value",[""]); v=v[0] if isinstance(v,list) else v
        if v and isinstance(v,str) and len(v)>8: out.append(v)
    st.close(); return out

def sem_jaccard(A,B,th=0.85):
    if not A or not B: return 0.0
    ea,eb=embed(A),embed(B)
    if not ea or not eb: return -1.0
    def mcount(src,tgt):
        c=0
        for u in src:
            if any(sum(x*y for x,y in zip(u,w))>=th for w in tgt): c+=1
        return c
    inter=(mcount(ea,eb)+mcount(eb,ea))/2.0
    return inter/(len(A)+len(B)-inter)

res={}
for cond,val in (("off","0"),("on","1")):
    os.environ["SINAIN_MANIFOLD_CANON"]=val
    print(f"\n=== condition manifold={cond} ===", flush=True)
    d1=fresh_ingest(); h1=Path("/tmp")/f"mh_{cond}_1.db"
    if h1.exists(): shutil.rmtree(h1)
    shutil.copytree(d1,h1)
    A=facts_of(str(h1)); print(f"  run1 facts(current)={len(A)}", flush=True)
    d2=fresh_ingest(); h2=Path("/tmp")/f"mh_{cond}_2.db"
    if h2.exists(): shutil.rmtree(h2)
    shutil.copytree(d2,h2)
    B=facts_of(str(h2)); print(f"  run2 facts(current)={len(B)}", flush=True)
    j=sem_jaccard(A,B); res[cond]=(len(A),len(B),j)
    print(f"  semantic Jaccard(run1,run2) = {j:.4f}", flush=True)

print("\n===== MANIFOLD DETERMINISM RESULT =====")
print(f"  OFF: facts {res['off'][0]}/{res['off'][1]}  semJaccard={res['off'][2]:.4f}")
print(f"  ON : facts {res['on'][0]}/{res['on'][1]}  semJaccard={res['on'][2]:.4f}")
verdict = "WIN (more stable)" if res['on'][2] > res['off'][2] else "no improvement"
print(f"  VERDICT: manifold {verdict}  (delta={res['on'][2]-res['off'][2]:+.4f})")
open("/tmp/manifold_harness_score.txt","w").write(
  f"OFF semJ={res['off'][2]:.4f} ({res['off'][0]}/{res['off'][1]})  "
  f"ON semJ={res['on'][2]:.4f} ({res['on'][0]}/{res['on'][1]})  delta={res['on'][2]-res['off'][2]:+.4f}\n")
PY
echo "[mh] ALL_DONE: $(cat /tmp/manifold_harness_score.txt 2>/dev/null)" >> "$LOG"
