#!/usr/bin/env python3
"""Re-distill ONE haystack (830ce83f) with the kind=recon dedup-exemption fix and
confirm recon facts now persist with kind=recon. Writes /tmp/validate_recon.txt."""
import os, sys
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ["SINAIN_RECON"] = "1"
os.environ.setdefault("SINAIN_SUPERSEDE", "1")
os.environ.setdefault("SINAIN_TEMPORAL_DATES", "1")
os.environ.setdefault("SINAIN_RAW_CHUNKS", "1")
sys.path.insert(0, ".")
from pathlib import Path
from collections import Counter
from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.config import DATA_DIR
from eval.benchmarks.ingest import ingest_instance

QID = "830ce83f"
adapter = LongMemEvalAdapter()
instances = adapter.load_dataset(str(DATA_DIR))
inst = None
for i in instances:
    if any(q.id == QID for q in i.questions):
        inst = i
        break
assert inst, "instance not found for %s" % QID

cache_dir = Path("eval/benchmarks/data/longmemeval")
db = ingest_instance(inst, cache_dir)  # fresh distill (integrator hash changed)
out = ["store=%s" % (db.name if db else None)]

from triplestore import TripleStore
st = TripleStore(str(db))
c = Counter()
recon_samples = []
for eid, _ in st.entities_with_attr("value"):
    a = st.entity(eid)
    k = a.get("kind", [None]); k = k[0] if isinstance(k, list) else k
    c[k] += 1
    if k == "recon":
        v = a.get("value", [""]); v = v[0] if isinstance(v, list) else v
        recon_samples.append(str(v)[:70])
st.close()
out.append("kind_counts=%s" % dict(c))
out.append("recon_facts=%d" % c.get("recon", 0))
for s in recon_samples[:12]:
    out.append("  recon: %s" % s)
Path("/tmp/validate_recon.txt").write_text("\n".join(out) + "\n")
print("VALIDATE_DONE recon=%d" % c.get("recon", 0))
