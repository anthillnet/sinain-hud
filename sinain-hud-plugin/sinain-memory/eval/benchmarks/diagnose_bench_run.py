"""Diagnose why phi4-mini structured-output q1 returned 'I don't know'.

Recomputes the bench cache hash for q1's haystack under
SINAIN_BENCH_MODEL=ollama/phi4-mini:latest, opens the resulting RDF
store, and dumps (a) what facts got distilled, (b) what query_facts_hybrid
surfaces for the question.
"""
import os
import sys
import hashlib
import json
from pathlib import Path

os.environ.setdefault("SINAIN_BENCH_MODEL", "ollama/phi4-mini:latest")
os.environ.setdefault("SINAIN_ABLATE", "none")
os.environ.setdefault("SINAIN_ABLATE_MODE", "passthrough")

SCRIPTS = Path("/Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-hud-plugin/sinain-memory")
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "eval" / "benchmarks"))

os.chdir(str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "eval"))
from eval.benchmarks.ingest import _distillation_pipeline_version  # type: ignore
from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter

DATA_DIR = SCRIPTS / "eval" / "benchmarks" / "data"
adapter = LongMemEvalAdapter()
instances = adapter.load_dataset(str(DATA_DIR))

inst = next(i for i in instances if i.id == "lme-ccc5851f40de8b4e")
print(f"Instance: {inst.id}, sessions: {len(inst.sessions)}")

raw = json.dumps(inst.sessions, sort_keys=True, ensure_ascii=False)
model_salt = os.environ.get("SINAIN_BENCH_MODEL", "")
pipeline_salt = _distillation_pipeline_version()
ablate_salt = "none:passthrough"
ch = hashlib.sha256((raw + "|" + model_salt + "|" + pipeline_salt + "|" + ablate_salt).encode()).hexdigest()[:16]
print(f"Cache hash: {ch}")

cache_path = DATA_DIR / "longmemeval" / "stores" / f"{ch}.db"
print(f"Cache path: {cache_path}")
print(f"  exists: {cache_path.exists()}, is_dir: {cache_path.is_dir()}")
if cache_path.exists():
    files = list(cache_path.iterdir()) if cache_path.is_dir() else [cache_path]
    print(f"  files: {len(files)}")

print()
print("=" * 60)
print("What got distilled (all facts in the graph)")
print("=" * 60)

from triplestore import TripleStore  # type: ignore
store = TripleStore(str(cache_path))
print(f"Total triples: {len(store)}")

# Enumerate all fact entities and their values
fact_seen = set()
for eid, val in store.entities_with_attr("value"):
    if not eid.startswith("fact:"):
        continue
    if eid in fact_seen:
        continue
    fact_seen.add(eid)
print(f"Unique fact entities: {len(fact_seen)}")

# Show all fact values
print()
print("--- All distilled fact values ---")
for eid in sorted(fact_seen):
    attrs = store.entity(eid)
    val = attrs.get("value", [""])[0] if attrs.get("value") else ""
    ent = attrs.get("entity", [""])[0] if attrs.get("entity") else ""
    print(f"  [{ent}] {val[:200]}")

# Search for BA-related content
print()
print("--- Facts mentioning 'business' or 'administration' or 'degree' or 'graduate' ---")
hits = []
for eid in fact_seen:
    attrs = store.entity(eid)
    val = (attrs.get("value", [""])[0] if attrs.get("value") else "").lower()
    if any(k in val for k in ("business", "administration", "degree", "graduate", "bachelor", "ba ", " ba")):
        hits.append((eid, attrs))
if not hits:
    print("  (none — distiller did not retain a BA fact)")
else:
    for eid, attrs in hits:
        print(f"  {eid}:")
        for k, v in attrs.items():
            if k in ("tag",):
                continue
            print(f"    {k}: {v[0] if isinstance(v, list) and len(v) == 1 else v}")

print()
print("=" * 60)
print("What retrieval surfaces (query_facts_hybrid)")
print("=" * 60)

from graph_query import query_facts_hybrid  # type: ignore
question = "What degree did I graduate with?"
retrieved = query_facts_hybrid(str(cache_path), question, max_facts=10)
print(f"Retrieved {len(retrieved)} facts for: {question!r}")
for i, f in enumerate(retrieved):
    print(f"  {i+1}. [{f.get('entity', '?')}] {(f.get('value', '') or '')[:200]}")

store.close()
