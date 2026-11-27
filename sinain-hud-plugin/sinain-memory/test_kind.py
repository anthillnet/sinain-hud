#!/usr/bin/env python3
"""Does retrieval surface kind=recon on fact dicts? Direct test on a RECON-on store."""
import os, sys
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
sys.path.insert(0, ".")
from graph_query import query_facts_hybrid

store = "eval/benchmarks/data/longmemeval/stores/0b900d20a2c930b1.db"  # 830ce83f recon-on
q = "Where did Rachel move to after her recent relocation?"
out = []
out.append("store_exists=%s" % os.path.exists(store))
if os.path.exists(store):
    facts = query_facts_hybrid(store, q, max_facts=15)
    out.append("n_facts=%d" % len(facts))
    out.append("keys_of_first=%s" % (sorted(facts[0].keys()) if facts else "NONE"))
    kinds = [f.get("kind") for f in facts]
    out.append("kinds=%s" % kinds)
    for f in facts[:15]:
        out.append("  kind=%r val=%r" % (f.get("kind"), str(f.get("value"))[:55]))
open("/tmp/test_kind.txt", "w").write("\n".join(out) + "\n")
print("TEST_KIND_DONE")
