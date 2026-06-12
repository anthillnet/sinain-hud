#!/usr/bin/env python3
"""diag_prompt.py — reconstruct the EXACT QA prompt for a (store, question).

Runs the production retrieval path (query_facts_hybrid + format_facts_compact,
including raw-excerpts) so we can see precisely what the QA model is shown and
whether the gold answer is present. Read-only; no LLM call.

Usage: python3 -m eval.benchmarks.diag_prompt <results_dir> [qid ...]
"""
import json
import os
import re
import sys

STORES = "eval/benchmarks/data/longmemeval/stores"
# qid -> store hash (cloud run mapping; same haystacks across runs)
HASHMAP = {
    "6a1eabeb": "5f46a05de12589a4", "6aeb4375": "c91e464dc5e426a1", "830ce83f": "c84cdf27b0fee280",
    "0a995998": "9a412228a23e075c", "6d550036": "96ad954260a3e9f4", "gpt4_59c863d7": "9b70561f1aa22f96",
    "7161e7e2": "1cfd46292e3291d9", "c4f10528": "ba74574075b29b0f", "89527b6b": "de31f5e20489597f",
    "8a2466db": "f80267e722d1e51d", "06878be2": "48c5055736e621d1", "75832dbd": "4bb8236cf0a41b48",
    "e47becba": "f98f91aa7a13a3de", "118b2229": "6da2e83365fa5123", "51a45a95": "135abdb49ff3f2c5",
    "gpt4_59149c77": "67c35ab121496ae5", "gpt4_f49edff3": "c75b28a407e5ad28", "71017276": "6b1097b0d30fb25d",
}


def main():
    results_dir = sys.argv[1]
    want = set(sys.argv[2:])
    det = {r["id"]: r for r in json.load(open(f"{results_dir}/longmemeval_results.json"))["details"]}
    from graph_query import query_facts_hybrid, format_facts_compact
    from eval.benchmarks.config import MAX_FACTS_PER_QUERY

    for qid, r in det.items():
        if want and qid not in want:
            continue
        h = HASHMAP.get(qid)
        db = f"{STORES}/{h}.db"
        q = r["question"]
        gold = r["gold_answer"]
        lab = r["answers"]["sinain-memory"]["paper_label"]
        facts = query_facts_hybrid(db, q, max_facts=MAX_FACTS_PER_QUERY)
        prompt = format_facts_compact(facts, max_chars=1200)
        gold_in_prompt = any(g in prompt.lower() for g in [gold.lower()]) or \
            sum(1 for w in re.findall(r"[a-z0-9]+", gold.lower()) if len(w) > 3 and w in prompt.lower())
        print("=" * 80)
        print(f"{qid} | {r['category']} | lab={lab} | r@10={r['retrieval']['content_recall@10']}")
        print(f"Q: {q}")
        print(f"GOLD: {gold}")
        print(f"n_facts={len(facts)}  prompt_chars={len(prompt)}")
        print(f"--- PROMPT ---\n{prompt}")
        print(f"--- given answer: {r['answers']['sinain-memory']['text'][:200]}")


if __name__ == "__main__":
    main()
