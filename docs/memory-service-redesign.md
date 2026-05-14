# Sinain Memory: Knowledge Service Redesign

## Purpose

This document proposes a principled redesign of the `sinain-memory` subsystem to serve **multiple consumers** — sinain-core's agent loop, OpenClaw escalation, external MCP clients, the overlay browse path, and future agents we have not yet built — through a **parameterized retrieval API** over a **temporally-aware fact store**.

The motivation comes from two observations:

1. **Benchmark performance**: a recent investigation of a competing memory system that achieved ~95% accuracy on LongMemEval (vs sinain's 82.8%) showed the gap is driven by **temporal fact representation**, **contradiction-as-state-evolution handling**, and **multi-strategy retrieval with reranking** — not by model size or embedding choice.
2. **Production shape**: sinain-memory is not a backend for one agent. It is exposed via MCP tools (`sinain_get_knowledge`, `sinain_knowledge_query`, `sinain_get_context`, `sinain_module_guidance`) to any MCP client. The right design surface is therefore a **library with knobs**, not an optimization for any one caller.

The redesign separates **policy from mechanism**: stages live in the pipeline, callers select which stages run via query parameters with sensible defaults.

## Current State

`sinain-memory` today (`sinain-hud-plugin/sinain-memory/`):

- `triplestore.py` — SQLite EAV store with 4 covering indexes (EAVT/AEVT/VAET/AVET), FTS5, soft retraction (`retracted`, `retracted_tx`, `valid_to`), `touched_entities` tracking, and `decayed_confidence()` utility.
- `session_distiller.py` — LLM extraction of `{facts, decisions, entities, patterns, preferences}` from a session transcript. Single LLM call.
- `knowledge_integrator.py` — Deterministic conversion of distiller output to graph ops. Embedding-based dedup (cosine 0.78). Tag extraction. Entity name normalization with edit-distance ≥ 0.90.
- `graph_query.py` — `query_facts_hybrid(db_path, query, max_facts)` runs RRF across FTS5, tag lookup, top-confidence, with entity-graph pre-filter, community expansion, decay boost, and final embedding rerank.
- `eval/benchmarks/` — LongMemEval adapter and runner (newly added).

### Strengths
- Deterministic integration (no LLM in the write hot path beyond distillation).
- 4-index covering design — fast EAV traversal.
- RRF fusion of 4 independent signals.
- Embedding-based dedup at write time.
- Confidence decay (60-day half-life).

### Gaps (driving the 82.8% → 95% delta and limiting production utility)

1. **No temporal representation of facts**. `created_at` and `valid_to` exist but only model *when we learned the fact* and *when it was retracted*, not *when the fact was true in the world*. LongMemEval temporal questions and production "is this still current?" questions both depend on this distinction.
2. **Contradictions are treated as duplicates**. `_consolidate_entity_facts` joins values with `"; "` only at shutdown. State evolution ("Acme moved from prospect to customer") is flattened. Over weeks/months the live graph accumulates contradictions silently.
3. **Entity fragmentation**. `_find_matching_entity` is edit-distance on names only. Coreferences ("the CEO", "Sarah", "my manager") fragment into separate entities. No cooccurrence signal.
4. **No retrieval-time policy surface**. `query_facts_hybrid` accepts `(query, max_facts)` only. Fast callers can't ask for speed; precise callers can't ask for cross-encoder rerank or multi-hop expansion.
5. **No format pluggability**. Every caller gets the same list-of-dicts shape; the agent prompt assembly path has to re-format on every call.

## Design Principles

1. **Universal write-time, parameterized read-time.** Data-quality changes (temporal fields, coreference, consolidation) go into the schema and write path — every reader inherits them. Latency/precision/format tradeoffs go into query parameters — each caller picks its profile.
2. **Backwards-compatible by default.** Schema migrations are additive. New parameters default to current behavior. No existing caller breaks.
3. **Policy as parameters, not configuration.** `precision_mode=precise` belongs in the call, not in a global config. The same memory backend should serve a hot 100ms tick and a 30s escalation in the same process.
4. **Versioned MCP API surface.** The query parameter contract is the long-lived surface; new stages can ship behind new parameter values without breaking existing clients.
5. **Local-first / lazy loading.** Heavy models (cross-encoder, multi-hop traversal) load only when their parameter value is requested.

## Architecture Target

```
                                    sinain-memory service
                              ┌─────────────────────────────────┐
sinain-core agent loop ───────┤                                 │
OpenClaw escalation ──────────┤    query_facts_hybrid(          │
External MCP clients ─────────┤      query, max_facts,          │
Overlay browse ───────────────┤      *,                         │
Future agents ────────────────┤      precision_mode=fast,       │
                              │      temporal_mode=current,     │
                              │      confidence_floor=0.4,      │
                              │      hop_depth=0,               │
                              │      latency_budget_ms=200,     │
                              │      format="facts",            │
                              │    ) → list[dict] | str | ...   │
                              └─────────────────────────────────┘
                                            │
                       ┌────────────────────┴────────────────────┐
                       │                                         │
              Stage pipeline (toggled by params):                │
              1. Candidate generation (FTS5, tags, graph, top)   │
              2. RRF fusion                                      │
              3. Temporal filter (if temporal_mode != any)       │
              4. Confidence floor (if confidence_floor > 0)      │
              5. Bi-encoder rerank (default)                     │
              6. Cross-encoder rerank (if precision=precise)     │
              7. Multi-hop expansion (if hop_depth > 1)          │
              8. Format adapter (triples/facts/narrative/struct) │
                       │                                         │
                       └────────────────────┬────────────────────┘
                                            │
                                   ┌────────┴────────┐
                                   │   triplestore   │
                                   │  (EAV + FTS5 +  │
                                   │  temporal cols) │
                                   └─────────────────┘
```

## Schema Changes (Universal, Write-time)

### Added columns on `triples`

| Column | Type | Default | Purpose |
|---|---|---|---|
| `occurred_start` | TEXT (ISO) | `created_at` | Earliest time the fact was true in the world |
| `occurred_end` | TEXT (ISO) | NULL | Most recent time the fact was true (NULL = still true / unbounded) |
| `mentioned_at` | TEXT (ISO) | `created_at` | When the fact was last referenced in a session |

`occurred_start` and `occurred_end` are extracted by the distiller when the LLM detects a temporal anchor in the source text ("yesterday", "in September", "last Tuesday"); otherwise default to `created_at`. `mentioned_at` updates every time the fact is reinforced.

**Migration**: additive `ALTER TABLE` with `IF NOT EXISTS`-style probing via `PRAGMA table_info`. Existing rows backfill to `created_at`. No reads break — the new columns are optional in all queries.

### New table: `entity_aliases`

| Column | Type | Purpose |
|---|---|---|
| `canonical_id` | TEXT | The canonical `entity:*` ID |
| `alias` | TEXT | The surface form ("the CEO", "Sarah", "Sarah Chen") |
| `confidence` | REAL | How sure we are this alias maps to the canonical |
| `source` | TEXT | `extracted`, `inferred`, `manual` |
| `created_at` | TEXT | When this alias was first observed |

Indexed on `(alias)` and `(canonical_id)`. Maintained by `knowledge_integrator.py` during distillation, populated from a new `aliases: list[str]` field in distiller output and from LLM-assisted coreference resolution.

### New table: `entity_cooccurrence`

| Column | Type | Purpose |
|---|---|---|
| `entity_a` | TEXT | First entity (lexicographic order) |
| `entity_b` | TEXT | Second entity |
| `session_count` | INTEGER | Sessions where both appeared |
| `last_seen` | TEXT | Most recent co-occurrence |

PRIMARY KEY `(entity_a, entity_b)`. Updated incrementally per session. Used by coreference resolution ("the CEO" cooccurs with "Sarah" in 80% of sessions → link them) and by retrieval as a soft graph-expansion signal.

## Query Parameter API (Parameterized, Read-time)

### `query_facts_hybrid` extended signature

```python
def query_facts_hybrid(
    db_path: str,
    query: str,
    max_facts: int = 10,
    *,
    precision_mode: str = "balanced",          # "fast" | "balanced" | "precise"
    temporal_mode: str = "any",                # "current" | "historical" | "any"
    confidence_floor: float = 0.0,             # suppress facts below this
    hop_depth: int = 1,                        # 0 | 1 | 2 | 3 (multi-hop budget)
    latency_budget_ms: int | None = None,      # cap pipeline time, skip stages
    format: str = "facts",                     # "facts" | "triples" | "narrative" | "structured"
    as_of: str | None = None,                  # ISO date for point-in-time queries
) -> list[dict] | str:
```

### Parameter semantics

| Parameter | Value | Effect |
|---|---|---|
| `precision_mode` | `fast` | Skip bi-encoder rerank, skip cross-encoder, smaller candidate pool. Target <100ms. |
| | `balanced` | Current behavior: RRF + bi-encoder rerank. Default. |
| | `precise` | Add cross-encoder rerank on top-30 → top-K. Target <500ms. |
| `temporal_mode` | `current` | Filter to facts with `occurred_end IS NULL OR occurred_end > now()`. Boost by `mentioned_at` recency. |
| | `historical` | No filter; boost by `occurred_start` proximity to `as_of` if provided. |
| | `any` | No filter, no boost. Default. |
| `confidence_floor` | `0.6` | Drop any fact with `decayed_confidence < 0.6` before scoring. |
| `hop_depth` | `0` | Skip graph expansion entirely (fastest). |
| | `1` | Current behavior: 1-hop fallback if undersized. |
| | `2-3` | Budget-constrained spreading activation across `mentions` and `ref` edges. |
| `latency_budget_ms` | `200` | Pipeline checks elapsed time between stages; skips later stages if budget exceeded. |
| `format` | `facts` | Current `list[dict]` shape. Default. |
| | `triples` | Raw EAV records for code consumers. |
| | `narrative` | LLM-summarized 1-2 sentence entity briefs (cached). |
| | `structured` | Per-fact context with provenance, temporal bounds, source chunks. |
| `as_of` | ISO string | Point-in-time query using `triplestore.entity_as_of`. |

### Caller profiles (recommended defaults)

| Caller | Recommended profile |
|---|---|
| sinain-core agent tick | `precision_mode=fast, temporal_mode=current, confidence_floor=0.5, hop_depth=0, latency_budget_ms=150, format=facts` |
| OpenClaw escalation | `precision_mode=precise, temporal_mode=any, confidence_floor=0.3, hop_depth=2, latency_budget_ms=5000, format=structured` |
| External MCP query | `precision_mode=balanced, format=facts` (today's defaults — backwards-compatible) |
| Overlay user browse | `precision_mode=balanced, hop_depth=1, format=narrative` |
| Eval / benchmark | `precision_mode=precise, hop_depth=2, format=structured` |

## Stage-by-stage Description

### 1. Candidate generation
Unchanged from today: FTS5 (with AND-then-OR fallback), tag lookup (single + intersection), top-confidence baseline, entity-graph pre-filter, community expansion via `mentions` edges. Skipped tiers if `latency_budget_ms` is tight.

### 2. RRF fusion
Unchanged. `K=60`, scores combined across all candidate tiers. Graph-link bonuses (`+0.10` intersection, `+0.05` direct, `+0.025` community).

### 3. Temporal filter (NEW)
If `temporal_mode == "current"`: drop facts where `occurred_end < now()`. Boost remaining facts by `exp(-decay * (now() - mentioned_at))`. If `temporal_mode == "historical"` with `as_of`: boost by `exp(-decay * |occurred_start - as_of|)`.

### 4. Confidence floor (NEW)
Drop facts with `decayed_confidence(confidence, created_at) < confidence_floor`. Applied before reranking so we don't waste cross-encoder cost on low-confidence noise.

### 5. Bi-encoder rerank (existing)
Sentence-transformers `all-MiniLM-L6-v2`. Cosine similarity query × fact value. Re-sort top RRF candidates. Skipped when `precision_mode=fast`.

### 6. Cross-encoder rerank (NEW, opt-in)
When `precision_mode=precise`: load ONNX-quantized `cross-encoder/ms-marco-MiniLM-L-6-v2` (lazy, cached). Pairwise score query × fact, re-sort top-30 → top-K. Expected +2-3 points on LongMemEval-style QA. Skipped in fast/balanced modes.

### 7. Multi-hop expansion (NEW, opt-in)
When `hop_depth >= 2`: budget-constrained spreading activation. Starts from top-K result entities, traverses `mentions` and `ref` edges with a per-query node budget (default 50). Newly discovered facts merged into the result set before formatting.

### 8. Format adapter (NEW)
- `facts` — `list[dict]` (today's shape).
- `triples` — `list[(entity, attribute, value, value_type, confidence, occurred_start, occurred_end)]`.
- `narrative` — per-entity LLM-summarized brief, cached by `(canonical_id, mentioned_at)` with 1h TTL.
- `structured` — Hindsight-style nested dict: fact + when-occurred + when-mentioned + source-chunk-refs + supporting-fact-ids.

## Distillation Changes (Universal, Write-time)

### Temporal extraction in `session_distiller.py`

Add to the LLM prompt:

> For each fact, if the source mentions a time-anchor (a date, day, or relative reference like "yesterday" / "last week" / "in September"), include an `occurredStart` ISO timestamp and optionally `occurredEnd`. If the fact describes a stable property (no time bounds), omit both.

Distiller output schema gains `occurredStart` and `occurredEnd` on each fact. Distiller continues to default to today's date for current-tense statements.

### Coreference resolution in `knowledge_integrator.py`

New helper `_resolve_coreferences(entities: list[dict], db: TripleStore) -> dict[str, str]`:

1. For each entity surface form in the distiller output, check `entity_aliases` for an existing mapping.
2. If not found and the surface looks like a descriptor ("the CEO", "my manager", "the project"), look up cooccurring entities of matching type in the current session window.
3. If a clear winner exists (cooccurrence count > threshold, or single candidate in session), record an alias mapping.
4. Otherwise, leave unresolved and let the LLM consolidator handle it later.

This populates `entity_aliases` over time without LLM cost on the hot path.

### Contradiction-aware consolidation

Replace `_consolidate_entity_facts` (currently `"; "` join) with an incremental LLM-judged classifier:

- Run per-batch (every N new facts about an entity), not only at shutdown.
- For each pair of facts about the same `entity`, classify: `redundant | contradictory | state-update | independent`.
- `redundant` → reinforce the earlier fact, retract the new one.
- `contradictory` → write a new "narrative" fact: `"Used to X; now Y as of {occurred_start}"`; retract both originals, preserve them via `valid_to`.
- `state-update` → set the prior fact's `occurred_end` to the new fact's `occurred_start`; assert the new fact with its own bounds.
- `independent` → keep both.

Cost is bounded: only fires when an entity has ≥3 facts and the embedding-dedup pass already passed. Most pairs are `independent`; the LLM only needs to discriminate the small ambiguous set.

## MCP API Surface

The relevant MCP tools (`sinain_knowledge_query`, `sinain_get_knowledge`, `sinain_get_context`, `sinain_module_guidance`) accept the new parameters as optional. Defaults preserve today's behavior. Parameter validation lives in a single `validate_query_params()` helper to ensure consistency across tools.

### Versioning

The parameter contract is additive: new parameters with default-preserving values can ship without breaking existing clients. Removed parameters (none planned) would require a new tool name with a version suffix.

## Implementation Phases

### Phase 1 — Foundation (this PR)
- Schema migration: `occurred_start`, `occurred_end`, `mentioned_at` columns; `entity_aliases` and `entity_cooccurrence` tables.
- Query parameter API: extend `query_facts_hybrid` signature with all parameters; implement `temporal_mode`, `confidence_floor`, `as_of` stages; stub `precision_mode=precise`, `hop_depth>=2`, `format!=facts` to fall through to current behavior so callers get no regression.
- Self-tests covering the migration and the new parameters with their defaults.

### Phase 2 — Distillation upgrades
- Add `occurredStart`/`occurredEnd` to distiller output.
- Wire alias extraction into the integrator; populate `entity_aliases` and `entity_cooccurrence`.
- Replace `_consolidate_entity_facts` with contradiction-aware incremental consolidation.

### Phase 3 — Read-time stages
- Cross-encoder rerank (ONNX-quantized, lazy-loaded).
- Multi-hop spreading activation with budget control.
- `narrative` and `structured` formatters.

### Phase 4 — Eval, tuning, and MCP exposure
- Run LongMemEval before/after across phases to attribute gains.
- Expose new parameters through MCP tool schemas.
- Add benchmark profiles for each caller (agent-tick, escalation, browse).

## Risks

### Risk: Migration on a live database
The schema migration adds nullable columns and new tables. SQLite `ALTER TABLE ADD COLUMN` is O(1). New tables are empty. Read paths default to `created_at` if `occurred_start` is NULL. No data loss risk.

### Risk: Consolidation regressing recall
Replacing `_consolidate_entity_facts` could over-merge facts that should remain distinct. Mitigation: keep both `consolidated` and original facts initially (soft-retract originals with `valid_to`); a flag controls whether retracted facts surface to retrieval. Roll out behind a config switch with an A/B compare on benchmark.

### Risk: Parameter explosion
Six parameters is a lot of surface. Mitigation: caller-profile presets exposed alongside the raw parameters. Documentation pins the recommended profile per consumer type.

### Risk: Cross-encoder distribution cost
ONNX-quantized models add ~25-30MB to the bundle. Mitigation: lazy-load only when `precision_mode=precise` is first requested; never load on the hot path. For environments where the model is unavailable, gracefully fall back to bi-encoder rerank.

### Risk: API drift between MCP tool schemas and the Python function
The MCP tool definitions live in a separate codebase. Mitigation: a single `query_params.py` module owns the parameter schema; both the Python API and the MCP tool definitions import from it.

## Open Questions

- Should `entity_aliases` live in `triplestore.db` or a sibling DB? (Recommendation: same DB. Backups/copies stay atomic.)
- For `temporal_mode=current`, what's the right default for facts with `occurred_end IS NULL` — assume still-true or assume stale? (Recommendation: still-true. Force callers to ask for stale explicitly with `confidence_floor`.)
- Should `narrative` format use a local model or OpenRouter? (Recommendation: OpenRouter if configured, fall back to a templated join. Don't ship a local generation model in the bundle.)
- Should multi-hop expansion respect `confidence_floor` on hop neighbors? (Recommendation: yes — apply the floor at every hop.)
- Do we expose `latency_budget_ms` to MCP clients or keep it internal? (Recommendation: expose. Some clients legitimately need a tight cap.)

## Success Criteria

### Functional
- All existing callers continue to work with no code changes (defaults preserve behavior).
- New parameters round-trip through MCP tool schemas.
- Self-tests cover every parameter value combination at a smoke level.

### Performance
- `precision_mode=fast` on a warm cache returns in <150ms p99 on the meeting-memory benchmark.
- `precision_mode=precise` returns in <500ms p99 on the same benchmark.
- Schema migration completes in <1s on a 100k-triple database.

### Benchmark
- LongMemEval score improves to ≥87% on the existing eval harness after Phase 2.
- Target ≥92% after Phase 3.
- Production agent-tick latency (sinain-core) shows no regression on the existing meeting-memory benchmark.

## Final Note

This redesign is incremental. Today's `query_facts_hybrid` becomes the `precision_mode=balanced, hop_depth=1, format=facts` path. The new parameters are doors that callers open when they need to. Schema additions are universal because data quality is universal. The MCP surface becomes the long-lived contract.

The architecture optimizes for the next ten agents we will build on top of sinain-memory, not for any one we have today.
