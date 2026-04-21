# sinain-memory

Local-first knowledge pipeline for SinainHUD. Captures what the user sees and hears, distills it into a knowledge graph, and makes it retrievable for the agent's context.

## Architecture

Two-step pipeline: **LLM extraction** (what to remember) + **deterministic integration** (how to store it).

```
Audio transcripts + Screen OCR
        |
  session_distiller.py (LLM)
  Extracts: facts[], entities[], decisions[]
        |
  knowledge_integrator.py (code — no LLM)
  - Converts facts to graph assertions (deterministic)
  - Creates entity:* nodes with freeform types
  - Links facts to entities via ref edges
  - Infers cross-entity relationships from fact content
  - Deduplicates via embedding similarity (cosine 0.78)
  - Auto-curates playbook (tag overlap, no LLM)
        |
  triplestore.py (SQLite EAV)
  - 4 covering indexes: EAVT, AEVT, VAET, AVET
  - FTS5 full-text search on fact values
  - Confidence decay (60-day half-life)
  - Touched-entities tracking for cache invalidation
```

## Key Design Decisions

**Deterministic integration.** The integrator does NOT use an LLM. Early experiments showed that LLM-based integration produced 0-20 facts per run depending on model mood, token truncation, and format errors. The deterministic approach converts every distiller fact to a graph assertion — consistent, fast, and reliable.

**Two-layer entity model.** `fact:*` entities store individual claims (searchable via FTS5 and tags). `entity:*` nodes represent real-world entities connected by typed ref edges. The VAET index enables backref traversal: "find all facts about Citibank" is an O(log n) index lookup.

**Incremental distillation.** Long sessions (>8 min) trigger distillation when the feed buffer reaches capacity, before items are lost to the ring buffer. The `onFull` callback fires when 50% new items have accumulated since the last pass.

**Embedding-based dedup.** sinain-core hosts an in-process all-MiniLM-L6-v2 model (384 dims, 2-4ms per embedding). The `/embed` endpoint is used for both write-time dedup (prevent storing semantic duplicates) and read-time re-ranking (surface most relevant facts for a query).

## Triplestore

SQLite-backed EAV store inspired by Datomic/RhizomeDB with 4 covering indexes:

| Index | Query Pattern | Example |
|-------|-------------|---------|
| **EAVT** | What does entity X look like? | `store.entity("entity:citibank")` |
| **AEVT** | Which entities have attribute Y? | `store.entities_with_attr("type")` |
| **VAET** | What references entity Z? (backrefs) | `store.backrefs("entity:citibank")` |
| **AVET** | Find entity by attribute+value | `store.lookup("type", "person")` |

Additional features:
- **FTS5** full-text search on fact values with auto-sync triggers
- **Confidence decay**: exponential half-life (60 days) — facts lose relevance without reinforcement
- **Temporal queries**: `entity_as_of(id, date)` for point-in-time knowledge
- **Touched-entities index**: O(1) "was entity X modified since tx Y?" for cache invalidation
- **Soft retraction**: facts are marked retracted, not deleted — preserves history

## Retrieval

Hybrid retrieval with Reciprocal Rank Fusion (RRF):

1. **FTS5** keyword search on fact values
2. **Tag-based** entity matching via AVET index
3. **Top-confidence** facts as baseline
4. **Entity graph boost**: facts linked to query-mentioned entities via backrefs get an RRF score bonus
5. **Embedding re-ranking** (when sinain-core is running): semantic similarity between query and facts
6. **Confidence decay** applied as tiebreaker

Results are grouped by entity for cross-fact reasoning.

## Distiller Output Schema

```json
{
  "whatHappened": "2-3 sentence summary",
  "facts": ["self-contained factual sentence", ...],
  "decisions": ["who decided what, with deadline", ...],
  "entities": [{"name": "entity-slug", "type": "freeform-type"}, ...],
  "patterns": ["reusable technique or workflow", ...],
  "preferences": ["user preference or habit", ...],
  "isEmpty": false
}
```

Facts are guided by 5 diversity dimensions: **WHO** (people, roles), **WHAT** (properties, descriptions), **HOW MUCH** (numbers, dates), **WHAT CHANGED** (decisions, agreements), **WHAT'S NEXT** (commitments, plans).

## Files

| File | Role |
|------|------|
| `session_distiller.py` | LLM extraction: transcript to structured digest |
| `knowledge_integrator.py` | Deterministic storage: digest to graph ops + playbook |
| `triplestore.py` | SQLite EAV with 4 indexes + FTS5 + temporal |
| `graph_query.py` | Hybrid retrieval with RRF fusion |
| `embed_client.py` | Python client for sinain-core `/embed` endpoint |
| `common.py` | Shared LLM call utilities |
| `memory-config.json` | Model selection, token limits, timeouts |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `SINAIN_MEMORY_DIR` | `~/.sinain/memory` | Knowledge graph directory |
| `LEARNING_ENABLED` | `true` | Enable/disable distillation pipeline |
| `AGENT_ENABLED` | `true` | Set `false` for capture-only mode |
