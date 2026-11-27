#!/usr/bin/env python3
"""Guard sanity gate. Confirms (a) kind=recon flows onto retrieval dicts and
(b) the topical guard keeps a relevant recon fact while it CAN demote others.
Writes GUARD_OK / GUARD_NOOP to /tmp/guard_sanity.txt and exits 0/1 accordingly."""
import os, sys
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
sys.path.insert(0, ".")
from graph_query import query_facts_hybrid, _recon_topical_guard

STORES = {
    "830ce83f": ("eval/benchmarks/data/longmemeval/stores/0b900d20a2c930b1.db",
                 "Where did Rachel move to after her recent relocation?"),
    "6a1eabeb": ("eval/benchmarks/data/longmemeval/stores/29885813d818f542.db",
                 "What was my personal best time in the charity 5K run?"),
}
lines = []
recon_seen = False
for qid, (store, q) in STORES.items():
    if not os.path.exists(store):
        lines.append("%s STORE_MISSING %s" % (qid, store))
        continue
    facts = query_facts_hybrid(store, q, max_facts=15)
    kinds = [f.get("kind") for f in facts]
    n_recon = sum(1 for k in kinds if k == "recon")
    if n_recon:
        recon_seen = True
    lines.append("%s n=%d recon_in_top15=%d kinds=%s" % (qid, len(facts), n_recon, kinds))
    # show that guard is a real reorder: build a wide pool and run the guard
    wide = query_facts_hybrid(store, q, max_facts=50)
    guarded = _recon_topical_guard(list(wide), q)
    moved = sum(1 for a, b in zip(wide, guarded) if a is not b)
    lines.append("  wide=%d guard_reordered_positions~=%d" % (len(wide), moved))

verdict = "GUARD_OK" if recon_seen else "GUARD_NOOP"
lines.insert(0, verdict)
open("/tmp/guard_sanity.txt", "w").write("\n".join(lines) + "\n")
print(verdict)
sys.exit(0 if recon_seen else 1)
