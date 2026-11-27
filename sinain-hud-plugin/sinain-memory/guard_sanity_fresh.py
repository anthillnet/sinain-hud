#!/usr/bin/env python3
"""Post-bench confirmation: do freshly re-distilled stores carry kind=recon facts?
Scans recently-modified .db stores and counts kind values. Informational only."""
import os, glob
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
from collections import Counter
import time
STORES = "eval/benchmarks/data/longmemeval/stores"
out = []
try:
    from triplestore import TripleStore
    dbs = sorted(glob.glob(os.path.join(STORES, "*.db")), key=os.path.getmtime, reverse=True)[:6]
    for db in dbs:
        c = Counter()
        try:
            st = TripleStore(db)
            for eid, _ in st.entities_with_attr("value"):
                a = st.entity(eid)
                k = a.get("kind", [None])
                k = k[0] if isinstance(k, list) else k
                c[k] += 1
            st.close()
        except Exception as e:
            c["ERR"] = str(e)[:60]
        out.append("%s -> %s" % (os.path.basename(db), dict(c)))
except Exception as e:
    out.append("FATAL %s" % (repr(e)[:120]))
open("/tmp/guard_fresh.txt", "w").write("\n".join(out) + "\n")
print("\n".join(out))
