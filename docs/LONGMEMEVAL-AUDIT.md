# LongMemEval Benchmark Audit Report

**Date:** 2026-05-08
**Benchmark:** [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) — 500 questions across 6 categories
**Dataset:** [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) (HuggingFace)
**System:** sinain-memory knowledge graph (triplestore + hybrid retrieval)

## Results Summary

**Information Preservation Rate (IPR): 82.8%**

| Condition | Mean Score (1-5) | Mean F1 | N |
|-----------|------------------|---------|---|
| full-context | 2.69 | 0.12 | 500 |
| sinain-memory | 2.22 | 0.05 | 500 |

### Retrieval Quality

| Metric | Score |
|--------|-------|
| content_recall@1 | 13.8% |
| content_recall@3 | 16.6% |
| content_recall@5 | 17.2% |
| content_recall@10 | 18.8% |

### By Category

| Category | full-context | sinain-memory | N |
|----------|-------------|---------------|---|
| knowledge-update | 2.46 | **2.58** | 78 |
| single-session-user | 3.14 | 2.81 | 70 |
| single-session-preference | 2.63 | 2.33 | 30 |
| single-session-assistant | 2.21 | 2.05 | 56 |
| temporal-reasoning | 2.54 | 2.07 | 133 |
| multi-session | 2.93 | 1.91 | 133 |

sinain-memory outperforms full-context on knowledge-update questions (2.58 vs 2.46) — distilled facts are more focused than searching raw conversation history.

## Improvement Journey

| Date | IPR | sinain-memory | recall@10 | Key Change |
|------|-----|---------------|-----------|------------|
| Apr 11 | 62.3% | 1.66/5 | 0.6% | Baseline (old distiller, old stores) |
| May 5 | 62.5% | 1.68/5 | 1.2% | Re-ingested with current distiller |
| May 7 | 56.4% | 1.60/5 | 19.3% | Full-fidelity KG (but query bug) |
| May 7 | 63.6% | 1.85/5 | 12.4% | Fixed benchmark query path |
| **May 8** | **82.8%** | **2.22/5** | **18.8%** | **Combined entity recall + all fixes** |

## Methodology

### Dataset

LongMemEval provides 500 questions spanning 6 categories:
- **knowledge-update** (78q): Facts that change over time ("What's my new job title?")
- **multi-session** (133q): Information spread across multiple conversations
- **single-session-user** (70q): Personal details stated by the user ("What breed is my dog?")
- **single-session-assistant** (56q): Information provided by the assistant
- **single-session-preference** (30q): User preferences and opinions
- **temporal-reasoning** (133q): Time-dependent questions ("How many days between X and Y?")

Each question includes a "haystack" of 40-53 conversation sessions (~100K tokens) containing the answer buried in one or two turns.

### Ingestion Pipeline

For each question's haystack:

1. **Batch sessions** into groups of 10 conversations
2. **Distill** each batch via `session_distiller.py` (Gemini 2.5 Flash Lite) — extracts facts, decisions, entities, patterns, preferences, and session summary
3. **Integrate** via `knowledge_integrator.py` (deterministic, no LLM):
   - All distiller output stored as `kind=distilled` facts
   - Raw audio quotes (top 20 by length) stored as `kind=verbatim`
   - Agent analysis responses (last 10) stored as `kind=verbatim`
   - Session ref edges link facts to originating session
   - Entity graph built: entity nodes + about/mentions ref edges
   - Entity canonicalization: Unicode transliteration + fuzzy dedup
4. **Cache** stores by content hash — identical haystacks reuse cached DBs

Result: ~40-50 facts per distillation pass (vs ~15 with old pipeline).

### Retrieval Pipeline

`query_facts_hybrid()` with 5 retrieval methods fused via Reciprocal Rank Fusion:

1. **FTS5 full-text search** — FTS5 AND mode for multi-word queries
2. **Tag-based search** — AVET index on auto-extracted keyword tags
3. **Top-N by confidence** — highest-confidence facts as fallback
4. **Tag intersection tier** — facts tagged with ALL query keywords (HAVING COUNT >= N)
5. **Semantic entity expansion** — expand keywords to similar entity names via cached sentence-transformers embeddings

Boost hierarchy:
- Graph intersection (fact linked to ALL query entities): +0.10
- Direct graph link (fact linked to any query entity): +0.05
- Community expansion (1-hop via mentions edges): +0.025
- Co-occurrence (same distillation session): +0.025
- Confidence decay: +0.01 × effective_confidence

In-process embedding re-ranking (sentence-transformers all-MiniLM-L6-v2) as final step when available.

### Evaluation

For each question, under each condition:

1. **sinain-memory**: Query the per-question knowledge graph via `query_facts_hybrid()`, format as compact text (1200 chars), generate answer via Gemini 2.5 Flash
2. **full-context**: Render the full conversation history (up to 100K chars), generate answer via Gemini 2.5 Flash

Scoring:
- **LLM-as-Judge**: GPT-4o scores each answer 1-5 against the gold answer
- **Token F1**: Mechanical token overlap between generated and gold answer
- **content_recall@K**: Are the gold answer's keywords in the top-K retrieved facts? (≥50% keyword overlap threshold)
- **IPR**: sinain-memory mean score / full-context mean score × 100%

### Models Used

| Role | Model | Provider |
|------|-------|----------|
| Distiller | google/gemini-2.5-flash-lite | OpenRouter |
| QA generation | google/gemini-2.5-flash | OpenRouter |
| QA judging | openai/gpt-4o | OpenRouter |
| Embedding re-ranking | all-MiniLM-L6-v2 | Local (sentence-transformers) |

## Reproduction

### Prerequisites

- Python 3.12+ with `sentence-transformers` installed
- `OPENROUTER_API_KEY` in `.env`
- ~$10-15 in OpenRouter credits (500 × 2 conditions × QA + judge calls)

### Steps

```bash
cd sinain-hud-plugin/sinain-memory

# 1. Source environment
set -a; source ../../.env; set +a

# 2. Clear previous results
rm -f eval/benchmarks/results/longmemeval_progress.jsonl
rm -f eval/benchmarks/results/longmemeval_results.*

# 3. Optionally clear cached stores to re-ingest from scratch
# rm -rf eval/benchmarks/data/longmemeval/stores/*.db

# 4. Run full benchmark (takes 2-4 hours)
python3 eval/benchmarks/runner.py \
  --benchmarks longmemeval \
  --conditions sinain-memory,full-context \
  --format json,markdown

# 5. Results in:
#    eval/benchmarks/results/longmemeval_results.md   (summary)
#    eval/benchmarks/results/longmemeval_results.json  (per-question detail)
```

### Quick iteration (subset)

```bash
# 12 stratified questions, no LLM judging (retrieval metrics only)
python3 eval/benchmarks/runner.py \
  --benchmarks longmemeval \
  --subset 12 --stratified --skip-llm \
  --conditions sinain-memory \
  --format json

# 20 questions with full scoring
python3 eval/benchmarks/runner.py \
  --benchmarks longmemeval \
  --subset 20 --stratified \
  --conditions sinain-memory,full-context \
  --format json,markdown
```

### Resume after interruption

The runner saves progress incrementally to `longmemeval_progress.jsonl`. To resume:

```bash
python3 eval/benchmarks/runner.py \
  --benchmarks longmemeval \
  --conditions sinain-memory,full-context \
  --format json,markdown \
  --resume
```

If API errors corrupted some entries, strip them and re-run:

```python
import json
clean = []
with open('eval/benchmarks/results/longmemeval_progress.jsonl') as f:
    for line in f:
        d = json.loads(line)
        for cond in ['sinain-memory', 'full-context']:
            t = d.get('answers',{}).get(cond,{}).get('text','')
            if 'error' in t.lower():
                d['answers'].pop(cond, None)
        clean.append(json.dumps(d, ensure_ascii=False))
with open('eval/benchmarks/results/longmemeval_progress.jsonl', 'w') as f:
    f.write('\n'.join(clean) + '\n')
```

Then re-run with `--resume`.

## Architecture

```
LongMemEval Dataset (500 questions × 40-53 sessions each)
  │
  ▼
Ingestion (per question):
  session_distiller.py (LLM) → knowledge_integrator.py (deterministic)
  → Per-question SQLite triplestore with:
    - fact:* entities (distilled + verbatim)
    - entity:* nodes + about/mentions ref edges
    - session:* anchors with session refs
    - FTS5 index, 4 covering indexes (EAVT/AEVT/VAET/AVET)
  │
  ▼
Retrieval (per question):
  query_facts_hybrid() → [FTS5 AND | Tags | Tag Intersection | Top-N]
  → RRF fusion → Graph boost (intersection/direct/community)
  → Embedding re-ranking (sentence-transformers)
  → format_facts_compact() (1200 chars)
  │
  ▼
Evaluation:
  QA generation (Gemini Flash) → LLM-as-Judge (GPT-4o) → Score 1-5
  + Token F1 (mechanical) + content_recall@K (retrieval quality)
```

## Key Findings

1. **Full-fidelity storage is essential.** Storing only topic-level distilled facts (the old pipeline) yielded 0.6% content_recall. Adding verbatim quotes and agent analysis raised it to 18.8% — the specific details users ask about are in the raw captures, not the summaries.

2. **The entityId/entity_id mismatch was a critical silent bug.** Tag search results were completely invisible to RRF scoring because of a camelCase vs snake_case key mismatch. Fixing this alone would have improved scores significantly.

3. **Combined entity retrieval matters.** FTS5 AND mode, tag intersection, and graph intersection boost all contribute to finding facts at the intersection of multiple concepts.

4. **Knowledge-update is sinain's strongest category** (2.58 vs full-context 2.46). The knowledge graph naturally tracks state changes through confidence reinforcement and temporal metadata.

5. **Multi-session is the hardest category** (1.91 vs 2.93). Information spread across many sessions requires cross-session association that the current pipeline handles via session refs and co-occurrence, but the sheer volume of facts makes ranking harder.

6. **Embedding re-ranking bridges the vocabulary gap.** Questions like "What breed is my dog?" don't share keywords with "Max is a 3-year-old golden retriever" — only embedding similarity connects them.
