#!/usr/bin/env python3
"""Re-distill 6a1eabeb with the anti-fabrication distiller rule + deterministic temp0,
then check facts for the 55k hallucination and run QA. Writes /tmp/val6a1.txt."""
import os, sys
os.environ.setdefault("HF_HUB_OFFLINE","1"); os.environ.setdefault("TRANSFORMERS_OFFLINE","1")
os.environ["SINAIN_RECON"]="1"; os.environ.setdefault("SINAIN_SUPERSEDE","1")
os.environ.setdefault("SINAIN_TEMPORAL_DATES","1"); os.environ.setdefault("SINAIN_RAW_CHUNKS","1")
os.environ.setdefault("SINAIN_QA_VOTES","5")
sys.path.insert(0,".")
from pathlib import Path
from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.config import DATA_DIR, QA_MODEL, JUDGE_MODEL
from eval.benchmarks.ingest import ingest_instance
from eval.benchmarks.query import answer_question
from eval.benchmarks.judges.longmemeval_judge import judge_paper

ad=LongMemEvalAdapter(); insts=ad.load_dataset(str(DATA_DIR))
inst=next(i for i in insts if any(q.id=="6a1eabeb" for q in i.questions))
q=next(x for x in inst.questions if x.id=="6a1eabeb")
db=ingest_instance(inst, Path("eval/benchmarks/data/longmemeval"))
out=["store=%s"%db.name, "Q=%s"%q.text, "GOLD=%s"%q.gold_answer]
# scan distilled facts for 55k / times
from triplestore import TripleStore
st=TripleStore(str(db)); has55=0; t2712=0; t2550=0; kinds={}
for eid,_ in st.entities_with_attr("value"):
    a=st.entity(eid); v=a.get("value",[""]); v=v[0] if isinstance(v,list) else v
    k=a.get("kind",[""]); k=k[0] if isinstance(k,list) else k
    kinds[k]=kinds.get(k,0)+1
    low=(v or "").lower()
    if "55k" in low or "55 k" in low: has55+=1
    if "27:12" in low: t2712+=1
    if "25:50" in low: t2550+=1
    if ("best" in low or "25:50" in low or "27:12" in low):
        out.append("  FACT[%s]: %s"%(k, str(v)[:100]))
st.close()
out.append("counts: 55k=%d 27:12=%d 25:50=%d kinds=%s"%(has55,t2712,t2550,kinds))
# QA k=5
labels=[]; ans=[]
for _ in range(5):
    a=answer_question(q,"sinain-memory",db_path=str(db),model=QA_MODEL)
    ans.append(a)
    labels.append(1 if judge_paper(question_type=q.category,question_id=q.id,question=q.text,gold=q.gold_answer,response=a) else 0)
out.append("QA ones=%d/5  sample=%r"%(sum(labels), ans[0][:80]))
out.append("VERDICT=%s"%("PASS" if sum(labels)*2>5 else "FAIL"))
Path("/tmp/val6a1.txt").write_text("\n".join(out)+"\n")
print("VAL6A1_DONE", sum(labels))
