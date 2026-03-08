# Sinain Triple Store & Graph RAG — Design Document

> **Status:** Design complete, pending implementation
> **Date:** 2026-03-05
> **Inspired by:** RhizomeDB (JetBrains), Graph RAG research, Git Context Controller

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Research Foundation](#2-research-foundation)
3. [Architecture Overview](#3-architecture-overview)
4. [Phase 1: EAV Triple Store](#4-phase-1-eav-triple-store)
5. [Phase 2: Embedding Generation](#5-phase-2-embedding-generation)
6. [Phase 3: Context Branching](#6-phase-3-context-branching)
7. [Phase 4: Graph RAG Retrieval](#7-phase-4-graph-rag-retrieval)
8. [Knowledge Module Integration](#8-knowledge-module-integration)
9. [Example Records](#9-example-records)
10. [Performance Analysis](#10-performance-analysis)
11. [File Map](#11-file-map)
12. [Design Decisions & Trade-offs](#12-design-decisions--trade-offs)
13. [Verification Strategy](#13-verification-strategy)

---

## 1. Problem Statement

The sinain memory system is a 4-layer text-based architecture:

```
Layer 4: Knowledge Modules (hot-swappable domain expertise)
Layer 3: Koog Reflection Pipeline (7-step LLM-powered analysis every 30 min)
Layer 2: sinain-hud Plugin (sync engine, session tracking, context overflow watchdog)
Layer 1: OpenClaw Built-in Memory (memory.md, daily logs, compaction)
```

It currently has **no local vector/embedding infrastructure** and no entity-relationship
graph. Retrieval is purely text-based: LLMs read full playbooks and recent logs.

### Three Limitations

1. **No semantic retrieval** — patterns/observations are found by recency, not relevance.
   A signal about "OCR backpressure" requires scanning the entire playbook to find
   related patterns, even if the relevant pattern was written weeks ago.

2. **No relationship traversal** — "what concepts are related to X?" requires full
   re-reading. The system cannot answer "which patterns relate to screen capture?"
   without feeding the entire playbook to an LLM.

3. **No context branching** — subagents share the same flat fact space as the main
   agent. A research subagent exploring an alternative approach pollutes the shared
   state, and there's no way to isolate or merge experimental knowledge.

### Goal

Add a **knowledge graph layer** (EAV triple store + embeddings + Graph RAG) that
enables semantic retrieval, relationship traversal, and context branching — while
integrating cleanly with the existing 4-layer architecture.

---

## 2. Research Foundation

### 2.1 RhizomeDB (JetBrains)

RhizomeDB is JetBrains' in-memory database for Fleet and Air IDEs. It implements an
**Entity-Attribute-Value (EAV) triple store** inspired by Datomic/Datalog.

**Core insight**: Everything is stored as flat triples `[Entity_ID, Attribute, Value]`.
No nested objects, no deep hierarchies — just facts.

**4 Hash-Map Indexes** (the "3-hash-map" pattern plus one optional):

| Index | Key Order | Query Pattern | Use Case |
|-------|-----------|---------------|----------|
| **EAVT** | Entity → Attr → Value | `[18, ?, ?]` | "All attributes of entity 18" |
| **AEVT** | Attr → Entity → Value | `[?, :type, ?]` | "All entities with a :type attribute" |
| **VAET** | Value → Attr → Entity | `[?, :ref, 19]` | "What references entity 19?" (backrefs) |
| **AVET** | Attr → Value → Entity | `[?, :name, "X"]` | "Find entity by exact value" |

**Immutable snapshots**: MVCC-style model where transactions produce novelty deltas
(added/retracted triples). Previous states remain accessible for time-travel queries.

**Application to agent memory**:
- VAET index → instant backref queries ("what patterns relate to this concept?")
- Immutable snapshots → context branching (each reasoning path gets its own snapshot)
- Novelty deltas → precise change tracking for incremental updates
- Transaction lineage → audit trail for all knowledge mutations

### 2.2 Graph RAG (Dual-Channel Retrieval)

Modern research (2025-2026) confirms that combining **vector similarity search** with
**graph traversal** outperforms either approach alone for multi-hop reasoning:

- **Vector-only**: Finds semantically similar entities but misses relationship chains
- **Graph-only**: Traverses relationships but requires knowing the entry point
- **Graph RAG**: Vector search finds entry points, then graph traversal discovers
  connected knowledge that pure vector search would miss

Example: Query "OCR issues" → vector finds `pattern:ocr-stall-check` (high similarity)
→ graph traversal follows `concept:ocr-pipeline → concept:screen-capture →
pattern:sck-zero-copy` → discovers a related pattern that text similarity alone misses.

### 2.3 CAG vs RAG Decision

**Cache-Augmented Generation (CAG)** outperforms RAG for bounded corpora (<1M tokens).
Sinain's total knowledge base is well under this threshold. However, we still need
**selective retrieval** — not all knowledge is relevant to every context. Graph RAG
provides this selectivity while the corpus remains fully cacheable.

### 2.4 Git Context Controller (GCC)

GCC applies version control semantics to agent memory:
- **COMMIT**: Consolidate observations into persistent milestones
- **BRANCH**: Create isolated exploration spaces
- **MERGE**: Integrate branches with provenance tracking
- **CONTEXT**: Multi-level retrieval (roadmap → branch → execution trace)

We adapt the branch/merge semantics for subagent context isolation using the triple
store's transaction lineage.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GRAPH RAG LAYER (Phase 4)                   │
│                                                                     │
│   graph_rag.py ─── dual-channel retrieval ─── context injection     │
│       ▲ vector search              ▲ graph traversal                │
├───────┼────────────────────────────┼────────────────────────────────┤
│       │                            │                                │
│   embedder.py (Phase 2)     triplestore.py (Phase 1)               │
│   OpenRouter primary        SQLite EAV with 4 indexes              │
│   MiniLM fallback           EAVT, AEVT, VAET, AVET                │
│       │                     BranchView (Phase 3)                    │
│       │                            │                                │
├───────┴────────────────────────────┴────────────────────────────────┤
│                    EXTRACTION LAYER                                  │
│                                                                     │
│   triple_extractor.py ─── 3-tier: JSON → regex+validate → LLM      │
│   triple_ingest.py    ─── CLI entry point for plugin calls          │
│   triple_query.py     ─── Query utilities for koog scripts          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   EXISTING 4-LAYER SYSTEM (unchanged, integrated via hooks)         │
│                                                                     │
│   Layer 4: Knowledge Modules ──── module patterns → triples         │
│   Layer 3: Koog Pipeline ──────── signals/mining/curation → triples │
│   Layer 2: sinain-hud Plugin ──── session summaries → triples       │
│   Layer 1: OpenClaw Memory ────── (untouched)                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Heartbeat Tick
    ├→ signal_analyzer.py → JSON result
    │   └→ triple_ingest.py --signal-result (fire-and-forget)
    │       └→ Tier 1: direct JSON → triples + embeddings
    │
    ├→ memory_miner.py ← graph_rag context injection
    │   └→ triple_ingest.py --ingest-mining
    │
    ├→ playbook_curator.py
    │   └→ triple_ingest.py --ingest-playbook
    │       └→ Tier 2: regex → patterns + concepts
    │       └→ Tier 3: LLM fallback if regex fails
    │
    └→ insight_synthesizer.py ← graph_rag context enrichment

Agent Start
    ├→ generateEffectivePlaybook()
    │   └→ triple_ingest.py --ingest-module (for each active module)
    │
    └→ graph_rag_query.py → [KNOWLEDGE GRAPH CONTEXT] block injected

Agent End
    └→ session-summaries.jsonl
        └→ triple_ingest.py --ingest-session

Subagent Start → triple_branch.py --action create
Subagent End   → triple_branch.py --action merge
```

---

## 4. Phase 1: EAV Triple Store

### 4.1 SQLite Schema

File: `memory/triplestore.db` (created automatically on first use)

```sql
-- Core fact table: EAV triples with temporal metadata
CREATE TABLE IF NOT EXISTS triples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT NOT NULL,
    attribute   TEXT NOT NULL,
    value       TEXT NOT NULL,
    value_type  TEXT NOT NULL DEFAULT 'string',  -- 'string'|'number'|'ref'|'json'
    tx_id       INTEGER NOT NULL,
    retracted   INTEGER NOT NULL DEFAULT 0,       -- 1 = retracted in this tx
    created_at  TEXT NOT NULL,                     -- ISO timestamp
    source      TEXT NOT NULL                      -- pipeline step that created this
);

-- EAVT: entity lookup ("all attributes of entity X")
CREATE INDEX IF NOT EXISTS idx_eavt
    ON triples (entity_id, attribute, value, tx_id);

-- AEVT: column scan ("all entities with attribute Y")
CREATE INDEX IF NOT EXISTS idx_aevt
    ON triples (attribute, entity_id, value, tx_id);

-- VAET: reverse reference lookup ("what references entity Z?")
CREATE INDEX IF NOT EXISTS idx_vaet
    ON triples (value, attribute, entity_id, tx_id)
    WHERE value_type = 'ref';

-- AVET: exact value lookup ("find entity where attr=val")
CREATE INDEX IF NOT EXISTS idx_avet
    ON triples (attribute, value, entity_id, tx_id);

-- Transaction log for snapshots, branching, novelty deltas
CREATE TABLE IF NOT EXISTS transactions (
    tx_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    source      TEXT NOT NULL,
    session_key TEXT,
    parent_tx   INTEGER,
    metadata    TEXT                               -- JSON blob
);

-- Entity type registry (denormalized for fast type filtering)
CREATE TABLE IF NOT EXISTS entity_types (
    entity_id   TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL
);
```

### 4.2 Entity Naming Convention

| Prefix | Example | Source |
|--------|---------|--------|
| `pattern:<slug>` | `pattern:ocr-stall-check` | Playbook, module patterns |
| `concept:<name>` | `concept:ocr-pipeline` | Extracted from text |
| `session:<ts>` | `session:2026-03-05T14:00` | Session summaries |
| `signal:<ts>` | `signal:2026-03-05T14:30` | Signal analyzer |
| `observation:<date>-<idx>` | `observation:2026-03-05-1` | Sense observations |
| `tool:<name>` | `tool:bash` | Tool usage tracking |
| `module:<id>` | `module:react-native-dev` | Module registry |

### 4.3 TripleStore API

```python
class TripleStore:
    """RhizomeDB-inspired EAV triple store backed by SQLite."""

    def __init__(self, db_path: str):
        """Open or create the SQLite database with WAL mode."""

    # --- Transaction management ---
    def begin_tx(self, source: str, session_key: str = None,
                 parent_tx: int = None, metadata: dict = None) -> int:
    def latest_tx(self) -> int:

    # --- Write operations ---
    def assert_triple(self, tx_id: int, entity_id: str, attribute: str,
                      value: str, value_type: str = 'string') -> int:
    def retract_triple(self, tx_id: int, entity_id: str, attribute: str,
                       value: str = None) -> int:

    # --- Query operations (4 index patterns) ---
    def entity(self, entity_id: str, as_of_tx: int = None) -> dict[str, list]:
        """EAVT: All attributes/values for an entity."""
    def entities_with_attr(self, attribute: str, as_of_tx: int = None) -> list[tuple]:
        """AEVT: Column scan — all (entity_id, value) for attribute."""
    def backrefs(self, target: str, attribute: str = None,
                 as_of_tx: int = None) -> list[tuple]:
        """VAET: Reverse reference — what entities point to target?"""
    def lookup(self, attribute: str, value: str,
               as_of_tx: int = None) -> list[str]:
        """AVET: Find entity IDs by exact attribute=value match."""

    # --- Graph traversal ---
    def neighbors(self, entity_id: str, depth: int = 1,
                  as_of_tx: int = None) -> dict[str, dict]:
        """BFS traversal via ref edges, up to `depth` hops."""

    # --- Temporal queries ---
    def novelty(self, since_tx: int, until_tx: int = None) -> list[dict]:
        """Triples added/retracted between two transactions."""
    def snapshot_at(self, tx_id: int) -> 'TripleStoreView':
        """Read-only view as of a specific transaction."""

    # --- Maintenance ---
    def stats(self) -> dict:
        """Triple count, entity count, tx count, db size."""
    def gc(self, older_than_days: int = 30) -> int:
        """Garbage-collect retracted triples older than threshold."""
```

### 4.4 Triple Extraction — 3-Tier Strategy

```
Input Data ──┬── JSON (signal, session, mining, manifest) ── Tier 1: Direct key access (~70%)
             │
             ├── Markdown (playbook, patterns.md) ── Tier 2: Regex + validation (~20%)
             │                                           │
             │                                     valid? ──┬── yes → triples
             │                                              └── no ──┐
             │                                                       │
             └── Free text (daily memory, observations) ─────────────┴── Tier 3: LLM fallback (~10%)
```

**Tier 1 — Direct JSON access** (zero LLM cost):
```python
def _extract_structured(self, data: dict, source_type: str) -> list[Triple]:
    """Map JSON keys directly to EAV triples."""
    # Signal: data["description"] → [signal:ts, description, "..."]
    # Session: data["toolBreakdown"] → [session:ts, used_tool, tool:X] for each tool
    # Mining: data["newPatterns"] → [pattern:slug, text, "..."] for each pattern
```

**Tier 2 — Regex with validation gate**:
```python
def _extract_regex(self, markdown: str) -> list[Triple]:
    """Parse playbook markdown patterns via regex."""
    # Match patterns like: "- Pattern text (score: 0.8) [since: 2026-02-28]"
    # Extract: text, score, since_date, section header

def _validate(self, triples: list[Triple]) -> bool:
    """Sanity check: non-empty, valid entity IDs, refs point to existing entities."""
```

**Tier 3 — LLM fallback** (Gemini Flash, ~$0.001/call):
```python
def _extract_llm(self, text: str, source_type: str) -> list[Triple]:
    """LLM-powered extraction when regex fails."""
    raw = call_llm(EXTRACT_PROMPT, text, script="triple_extractor")
    return self._parse_llm_triples(extract_json(raw))
```

**Concept extraction** — 3-tier with vocabulary cache:
```python
def _extract_concepts(self, text: str) -> list[str]:
    # Tier 1: Match against known concepts in the store (improves over time)
    # Tier 2: Regex noun-phrase extraction for new concepts
    # Tier 3: LLM fallback if both tiers found nothing
```

### 4.5 CLI Entry Points

**`triple_ingest.py`** — called by plugin as subprocess:
```
python3 triple_ingest.py --memory-dir memory/ --tick-ts <ISO> --signal-result <JSON>
python3 triple_ingest.py --memory-dir memory/ --ingest-playbook
python3 triple_ingest.py --memory-dir memory/ --ingest-session <JSON>
python3 triple_ingest.py --memory-dir memory/ --ingest-mining <JSON>
python3 triple_ingest.py --memory-dir memory/ --ingest-module <id> --modules-dir modules/
python3 triple_ingest.py --memory-dir memory/ --retract-module <id>
python3 triple_ingest.py --memory-dir memory/ --embed  # trigger embedding after ingestion
```

**`triple_query.py`** — importable utilities for koog scripts:
```python
def get_related_concepts(memory_dir: str, keywords: list[str]) -> str
def get_related_context(memory_dir: str, seed_texts: list[str], max_chars: int) -> str
def build_entity_text(store: TripleStore, entity_id: str) -> str
```

### 4.6 Config Addition (`koog-config.json`)

```json
{
  "scripts": {
    "triple_extractor": { "model": "fast", "maxTokens": 1500, "timeout": 30 }
  },
  "triplestore": {
    "dbPath": "memory/triplestore.db",
    "maxTriplesPerTx": 100,
    "conceptExtractionMode": "tiered",
    "gcOlderThanDays": 30
  }
}
```

---

## 5. Phase 2: Embedding Generation

### 5.1 Dual-Strategy Architecture

**Primary — OpenRouter** `openai/text-embedding-3-small`:
- 1536 dimensions, multilingual (Russian + English)
- Uses existing `OPENROUTER_API_KEY` — no new auth config
- ~200-400ms per batch via HTTPS
- Cost: ~$0.01/day at sinain's volume (~50 embeddings/day)
- Critical for Russian text in observations and session notes

**Fallback — Local** `all-MiniLM-L6-v2`:
- 384 dimensions, English-biased (poor for Russian)
- ~100 sentences/sec on CPU, 1-2s cold start
- Activates on network/API failure
- Same resilience pattern as `call_llm_with_fallback` in common.py

```python
class Embedder:
    """Dual-strategy embedding: OpenRouter primary, local MiniLM fallback."""

    def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            return self._embed_openrouter(texts)
        except (RequestError, Timeout):
            return self._embed_local(texts)

    def _embed_openrouter(self, texts: list[str]) -> list[list[float]]:
        """OpenRouter text-embedding-3-small (1536-dim, multilingual)."""
        # POST https://openrouter.ai/api/v1/embeddings

    def _embed_local(self, texts: list[str]) -> list[list[float]]:
        """Local MiniLM-L6-v2 fallback (384-dim, English)."""
        # sentence_transformers.SentenceTransformer('all-MiniLM-L6-v2')
```

### 5.2 Embedding Storage

Extends `triplestore.db` with an embeddings table:

```sql
CREATE TABLE IF NOT EXISTS embeddings (
    entity_id   TEXT PRIMARY KEY,
    vector      BLOB NOT NULL,        -- float32 array serialized
    text_hash   TEXT NOT NULL,         -- SHA256 of source text
    model       TEXT NOT NULL,         -- 'text-embedding-3-small' or 'all-MiniLM-L6-v2'
    dimensions  INTEGER NOT NULL,      -- 1536 or 384
    created_at  TEXT NOT NULL
);
```

- **Model-aware**: dimension field distinguishes OpenRouter (1536) vs MiniLM (384)
- **Dedup via text_hash**: skip re-embedding unchanged entities
- **Re-compute on model change**: if primary → fallback or vice versa, stale embeddings
  with different model name are refreshed

### 5.3 What Gets Embedded

Each entity's key attributes are concatenated into an embedding source text:

| Entity Type | Embedding Source |
|-------------|-----------------|
| `pattern:*` | `"pattern: {text} (concepts: {related_to list})"` |
| `concept:*` | `"concept: {name} — referenced by: {backref summary})"` |
| `session:*` | `"session: {summary}"` |
| `signal:*` | `"signal: {description} (priority: {priority})"` |
| `module:*` | `"module: {name} — {description}"` |

### 5.4 Search

Brute-force cosine similarity (corpus <10K entities):

```python
def vector_search(self, query_vec: list[float], top_k: int = 10,
                  entity_types: list[str] = None) -> list[tuple[str, float]]:
    """Return [(entity_id, score)] sorted by cosine similarity."""
    # Load all vectors matching optional type filter
    # Compute scores = np.dot(stored_vecs, query_vec)
    # Return top-K by score
```

At 10K entities: `(10000, 1536) @ (1536, 1)` = **<1ms**.

---

## 6. Phase 3: Context Branching

### 6.1 Branch Semantics

```
Main Agent (agent:main:sinain)
    tx_id: 1 → 2 → 3 → ... → 42
                                 ↑
                            parent_tx
                                 │
    Subagent (subagent:research:abc)
        branch_tx: 43 → 44 → 45
                              │
                        merge into main
                              ↓
    Main Agent continues: tx_id: 46 (contains branch novelties)
```

- **Create branch**: `branch(parent_tx=42, session_key="subagent:research:abc")`
  → returns `branch_tx=43`
- **Branch view**: Queries see `(tx_id <= 42) UNION (43 <= tx_id <= 45 AND session_key matches)`
- **Merge**: Copy novelties from branch into new main tx
- **Conflicts**: Last-writer-wins (simple, appropriate since subagents explore different topics)

### 6.2 BranchView Class

```python
class BranchView:
    """Scoped read-through view of the triple store for a branch."""

    def __init__(self, store: TripleStore, branch_tx: int,
                 parent_tx: int, session_key: str):
        self._store = store
        self._branch_tx = branch_tx
        self._parent_tx = parent_tx
        self._session_key = session_key

    def entity(self, entity_id: str) -> dict:
        """See main facts up to parent_tx + this branch's additions."""

    def assert_triple(self, entity_id: str, attribute: str,
                      value: str, **kwargs):
        """Write to this branch only."""

    def merge_into(self, target_tx: int) -> int:
        """Copy branch novelties into target, return new tx_id."""
```

### 6.3 Plugin Integration

**Subagent start** (`before_agent_start`, ~line 582):
```typescript
if (isSubagent) {
  runScript(["sinain-koog/triple_branch.py",
    "--memory-dir", "memory/",
    "--session-key", sessionKey,
    "--action", "create"
  ], 10_000).catch(() => {});
}
```

**Subagent end** (`agent_end`, ~line 720):
```typescript
if (isSubagentSession(sessionKey) && isSuccess) {
  runScript(["sinain-koog/triple_branch.py",
    "--memory-dir", "memory/",
    "--session-key", sessionKey,
    "--action", "merge"
  ], 10_000).catch(() => {});
}
```

---

## 7. Phase 4: Graph RAG Retrieval

### 7.1 Dual-Channel Architecture

```
Query: "What's relevant to OCR issues?"
    │
    ├── Vector Channel ──────────────────────────────────────────┐
    │   embed("OCR issues") → cosine top-5:                      │
    │   [signal:..T14:30 (0.91), pattern:ocr-stall (0.89), ...]  │
    │                                                             │
    ├── Graph Channel ───────────────────────────────────────────┐│
    │   BFS from seed entities, depth=2:                         ││
    │   concept:ocr-pipeline → pattern:capture-fps-tuning        ││
    │   concept:screen-capture → pattern:sck-zero-copy           ││
    │                                                            ││
    └── Merge & Re-rank ─────────────────────────────────────────┘│
        score = α · vec_score + (1-α) · graph_score               │
        α = 0.6 (tunable)                                         │
        │                                                          │
        ▼                                                          │
    Ranked results → format as markdown context block              │
```

### 7.2 GraphRAG Class

```python
class GraphRAG:
    """Dual-channel retrieval: vector similarity + graph traversal."""

    def __init__(self, store: TripleStore, embedder: Embedder):
        self.store = store
        self.embedder = embedder

    def retrieve(
        self,
        query: str,
        top_k: int = 10,
        graph_depth: int = 2,
        alpha: float = 0.6,
        entity_types: list[str] | None = None,
    ) -> list[RetrievalResult]:
        """
        1. Embed query, vector search for top-K seeds
        2. BFS from seeds via ref edges to depth
        3. Score graph neighbors: 1/hop_distance
        4. Merge: α·vec_score + (1-α)·graph_score
        5. Deduplicate, return top_k
        """

    def retrieve_for_context(
        self,
        query: str,
        max_chars: int = 1500,
    ) -> str:
        """Retrieve and format as markdown for context injection."""
```

### 7.3 Integration Points

1. **Agent start** (`before_agent_start`): Inject `[KNOWLEDGE GRAPH CONTEXT]` block
   into session context. 10s timeout, non-critical — skipped on failure.

2. **Heartbeat tick**: Enrich session summary with related facts before signal analysis.
   Helps signal_analyzer detect patterns it wouldn't see from the summary alone.

3. **Memory miner** (`memory_miner.py`): Add graph context section to LLM prompt.
   Helps the miner find cross-references between daily memory files and existing
   knowledge graph entities.

---

## 8. Knowledge Module Integration

The existing export/import system (`module_manager.py` + `generateEffectivePlaybook()`
+ module registry) integrates with the triple store at 5 points:

### 8.1 Module Patterns as Triple Entities

When `generateEffectivePlaybook()` runs, each active module's `patterns.md` is
ingested into the triple store:

```
[module:react-native-dev,  type,     "module"]
[module:react-native-dev,  status,   "active"]
[module:react-native-dev,  priority, "80"]

[pattern:rn-metro-cache,   type,       "pattern"]
[pattern:rn-metro-cache,   module,     module:react-native-dev]   ← ref
[pattern:rn-metro-cache,   text,       "Clear Metro cache after native dep changes"]
[pattern:rn-metro-cache,   section,    "established"]
[pattern:rn-metro-cache,   related_to, concept:metro-bundler]     ← ref
[pattern:rn-metro-cache,   related_to, concept:react-native]      ← ref
```

This creates traversable `module → pattern → concept` chains.

### 8.2 Module Lifecycle Triggers Triple Retraction

- `cmd_activate()` → assert module pattern triples (ingest patterns.md)
- `cmd_suspend()` → retract module pattern triples (new tx with `retracted=1`)
- Graph RAG results automatically exclude suspended module patterns

### 8.3 `cmd_extract()` Enriched by Graph RAG

Before calling LLM for domain pattern extraction, query the triple store:

```python
graph_context = get_related_concepts(memory_dir, domain_keywords)
# Inject alongside playbook + logs → more precise extraction
```

### 8.4 Cross-Module Relationship Discovery

VAET index enables: "which modules share concepts?"

```python
backrefs("concept:xcode-build")
→ [("pattern:rn-ios-build", "related_to"),
   ("pattern:flutter-xcode-config", "related_to")]
# Both modules reference xcode-build — potential overlap
```

### 8.5 CLI Commands

```
python3 triple_ingest.py --ingest-module react-native-dev --modules-dir modules/
python3 triple_ingest.py --retract-module react-native-dev
```

---

## 9. Example Records

### 9.1 Heartbeat Tick — Signal Detection

A heartbeat tick at `2026-03-05T14:30:00Z` detects OCR backpressure:

**Transaction:**
```
tx_id=42 | created_at=2026-03-05T14:30:00Z | source=signal_analyzer
         | session_key=agent:main:sinain
```

**Triples written:**
```
┌────┬───────────────────────────┬──────────────┬────────────────────────────────┬────────────┬───────┐
│ id │ entity_id                 │ attribute    │ value                          │ value_type │ tx_id │
├────┼───────────────────────────┼──────────────┼────────────────────────────────┼────────────┼───────┤
│  1 │ signal:2026-03-05T14:30   │ type         │ signal                         │ string     │ 42    │
│  2 │ signal:2026-03-05T14:30   │ description  │ OCR queue depth exceeding 3    │ string     │ 42    │
│  3 │ signal:2026-03-05T14:30   │ priority     │ high                           │ string     │ 42    │
│  4 │ signal:2026-03-05T14:30   │ action       │ sessions_spawn                 │ string     │ 42    │
│  5 │ signal:2026-03-05T14:30   │ related_to   │ concept:ocr-pipeline           │ ref        │ 42    │
│  6 │ signal:2026-03-05T14:30   │ related_to   │ concept:screen-capture         │ ref        │ 42    │
│  7 │ signal:2026-03-05T14:30   │ session      │ session:2026-03-05T14:00       │ ref        │ 42    │
│  8 │ concept:ocr-pipeline      │ type         │ concept                        │ string     │ 42    │
│  9 │ concept:ocr-pipeline      │ name         │ OCR Pipeline                   │ string     │ 42    │
│ 10 │ concept:screen-capture    │ type         │ concept                        │ string     │ 42    │
│ 11 │ concept:screen-capture    │ name         │ Screen Capture                 │ string     │ 42    │
└────┴───────────────────────────┴──────────────┴────────────────────────────────┴────────────┴───────┘
```

### 9.2 Session Summary

```
┌────┬───────────────────────────┬──────────────┬────────────────────────────────────┬────────────┬───────┐
│ 12 │ session:2026-03-05T14:00  │ type         │ session                            │ string     │ 43    │
│ 13 │ session:2026-03-05T14:00  │ duration_ms  │ 45000                              │ number     │ 43    │
│ 14 │ session:2026-03-05T14:00  │ tool_count   │ 12                                 │ number     │ 43    │
│ 15 │ session:2026-03-05T14:00  │ success      │ true                               │ string     │ 43    │
│ 16 │ session:2026-03-05T14:00  │ used_tool    │ tool:bash                          │ ref        │ 43    │
│ 17 │ session:2026-03-05T14:00  │ used_tool    │ tool:write                         │ ref        │ 43    │
│ 18 │ session:2026-03-05T14:00  │ used_tool    │ tool:sinain_heartbeat_tick         │ ref        │ 43    │
│ 19 │ session:2026-03-05T14:00  │ summary      │ Investigated OCR backpressure,     │ string     │ 43    │
│    │                           │              │ spawned subagent to optimize queue  │            │       │
└────┴───────────────────────────┴──────────────┴────────────────────────────────────┴────────────┴───────┘
```

### 9.3 Index Query Examples

**EAVT** — "All attributes of signal:2026-03-05T14:30":
```sql
SELECT attribute, value, value_type FROM triples
WHERE entity_id = 'signal:2026-03-05T14:30' AND retracted = 0
ORDER BY attribute;
```
→ Returns 7 rows (type, description, priority, action, 2× related_to, session)

**AEVT** — "All high-priority entities":
```sql
SELECT entity_id FROM triples
WHERE attribute = 'priority' AND value = 'high' AND retracted = 0;
```

**VAET** — "What references concept:ocr-pipeline?" (backrefs):
```sql
SELECT entity_id, attribute FROM triples
WHERE value = 'concept:ocr-pipeline' AND value_type = 'ref' AND retracted = 0;
```
→ `signal:2026-03-05T14:30` (related_to), `pattern:ocr-stall-check` (related_to), ...

**AVET** — "Find entity named 'OCR Pipeline'":
```sql
SELECT entity_id FROM triples
WHERE attribute = 'name' AND value = 'OCR Pipeline' AND retracted = 0;
```
→ `concept:ocr-pipeline`

### 9.4 Graph RAG Traversal Example

Query: "What's relevant to OCR issues?"

```
Step 1 (Vector): embed("OCR issues") → cosine top-5:
  signal:2026-03-05T14:30   (score: 0.91)
  pattern:ocr-stall-check   (score: 0.89)
  concept:ocr-pipeline      (score: 0.85)

Step 2 (Graph): BFS from top-3 seeds, depth=2:
  concept:ocr-pipeline
    hop 1: signal:2026-03-05T14:30, pattern:ocr-stall-check, pattern:capture-fps-tuning
    hop 2: concept:screen-capture → pattern:sck-zero-copy, session:2026-03-04T10:00

Step 3 (Merge): α=0.6 vec + 0.4 graph:
  1. pattern:ocr-stall-check       (vec:0.89 + graph:1.0)  → 0.93
  2. signal:2026-03-05T14:30       (vec:0.91 + graph:0.5)  → 0.75
  3. pattern:sck-zero-copy         (vec:0.32 + graph:0.5)  → 0.39  ← found via graph only!
```

The last result (`pattern:sck-zero-copy`) is the key win — pure vector search would
miss it (low text similarity to "OCR issues"), but graph traversal discovers it through
the `concept:ocr-pipeline → concept:screen-capture → pattern:sck-zero-copy` chain.

---

## 10. Performance Analysis

### 10.1 Query Performance

| Operation | Expected Latency | Notes |
|-----------|-----------------|-------|
| Triple write (single) | <0.1ms | SQLite WAL mode |
| EAVT lookup | <0.5ms | Indexed, <100K rows |
| VAET backref | <0.5ms | Filtered index on value_type='ref' |
| BFS depth=2 | <5ms | ~10-50 entities per hop |
| Cosine search (10K vectors) | <1ms | `(1, 1536) @ (10000, 1536).T` |
| Full Graph RAG query | <10ms | Vector + BFS + merge |

### 10.2 Embedding Performance

| Component | OpenRouter (primary) | MiniLM (fallback) |
|-----------|---------------------|-------------------|
| Latency per batch | 200-400ms (network) | 1-2s cold start + <10ms/sentence |
| Throughput | ~100 texts/request | ~100 texts/sec |
| Quality (MTEB) | ~0.62 | ~0.63 |
| Multilingual | Yes (Russian + English) | English only |
| Cost | ~$0.01/day | Free |

### 10.3 Heartbeat Latency Impact

| Step | Time | Blocking? |
|------|------|-----------|
| Triple ingestion (signal) | ~0.5s | No (fire-and-forget) |
| Triple ingestion (playbook) | ~1s | No (fire-and-forget) |
| Embedding (5-20 new entities) | ~0.5s OpenRouter | No (fire-and-forget) |
| Graph RAG query | ~0.5s | Yes (10s timeout, skipped on failure) |
| **Net impact on tick** | **~0.5s** | Only the RAG query is synchronous |

### 10.4 Storage

| Component | Expected Size | After 6 months |
|-----------|--------------|----------------|
| Triples (10K entities, ~50K rows) | ~5MB | ~15MB |
| Embeddings (10K × 1536-dim float32) | ~60MB | ~60MB (plateau) |
| Transactions log | ~0.5MB | ~2MB |
| **Total triplestore.db** | ~65MB | ~80MB |

---

## 11. File Map

### New Files

| File | Phase | ~Lines | Purpose |
|------|-------|--------|---------|
| `sinain-koog/triplestore.py` | 1+3 | ~400 | Core EAV store + BranchView |
| `sinain-koog/triple_extractor.py` | 1 | ~250 | 3-tier entity/relationship extraction |
| `sinain-koog/triple_ingest.py` | 1+2 | ~150 | CLI entry point for plugin subprocess calls |
| `sinain-koog/triple_query.py` | 1 | ~100 | Query utilities for koog scripts |
| `sinain-koog/embedder.py` | 2 | ~200 | OpenRouter primary + MiniLM fallback |
| `sinain-koog/triple_branch.py` | 3 | ~120 | Branch create/merge CLI |
| `sinain-koog/graph_rag.py` | 4 | ~250 | Dual-channel retrieval engine |
| `sinain-koog/graph_rag_query.py` | 4 | ~80 | CLI entry point for Graph RAG queries |
| `sinain-koog/tests/test_triplestore.py` | 1 | ~200 | Store CRUD, indexes, transactions |
| `sinain-koog/tests/test_triple_extractor.py` | 1 | ~150 | Extraction from all data formats |
| `sinain-koog/tests/test_embedder.py` | 2 | ~100 | Embedding + search |
| `sinain-koog/tests/test_branching.py` | 3 | ~150 | Branch isolation + merge |
| `sinain-koog/tests/test_graph_rag.py` | 4 | ~150 | Retrieval relevance |

### Modified Files

| File | Changes |
|------|---------|
| `sinain-hud-plugin/index.ts` | 7 integration points (heartbeat, curation×2, agent_end, before_agent_start, module sync, effective playbook gen) |
| `sinain-koog/koog-config.json` | Add `triplestore` config block + `triple_extractor` script entry |
| `sinain-koog/module_manager.py` | Enrich `cmd_extract()` with Graph RAG; add triple assert/retract on activate/suspend |
| `sinain-koog/memory_miner.py` | Add graph context injection into LLM prompt |
| `sinain-koog/requirements.txt` | Add `sentence-transformers>=2.2.0` (optional), `numpy>=1.24.0` |

---

## 12. Design Decisions & Trade-offs

### SQLite, not Neo4j/Memgraph

Zero infrastructure overhead. The data volume is trivially small (~10K triples, ~50K
rows). The 4-index pattern gives us all RhizomeDB query patterns. SQLite is in Python's
stdlib (no new dependencies). WAL mode enables concurrent reads from multiple scripts.

### OpenRouter embeddings primary, local MiniLM fallback

OpenRouter handles Russian+English mixed content, which is critical since observations
and session notes contain Russian. MiniLM fallback ensures offline resilience when the
API is unreachable. Cost is negligible (~$0.01/day).

### 3-tier extraction (JSON → regex+validation → LLM fallback)

Most inputs are already JSON (~70%), so direct key access dominates with zero LLM cost.
Regex handles markdown with a validation gate — if results look wrong, LLM fallback
fires automatically. The concept vocabulary cache improves over time as the store grows,
reducing LLM fallback frequency.

### Branch-per-session, not branch-per-reasoning-chain

Maps naturally to OpenClaw's session model with clear boundaries. The more granular
Git Context Controller pattern (branch per reasoning chain) can be added later.
Last-writer-wins conflict resolution is appropriate since subagents explore different
topics.

### Fire-and-forget ingestion

Triple store updates never block the critical path (heartbeat, curation). All
subprocess calls have timeouts and are wrapped in `.catch(() => {})`. The only
synchronous Graph RAG query (at agent start) has a 10s timeout and is skipped on
failure.

### EAV over property graph

EAV is simpler and more flexible for this scale. We don't need typed edge properties
or complex relationship metadata. If needed later, relationship metadata can be encoded
as additional triples on a relationship entity (`rel:123` with its own attributes).

---

## 13. Verification Strategy

### Unit Tests

```bash
cd sinain-koog && uv run pytest tests/test_triplestore.py tests/test_triple_extractor.py \
    tests/test_embedder.py tests/test_branching.py tests/test_graph_rag.py
```

Test coverage:
- Triple CRUD, all 4 index queries, transaction isolation
- 3-tier extraction from sample playbook/session/signal data
- Embedding generation (mock OpenRouter) and cosine search accuracy
- Branch isolation (subagent writes invisible to main until merge)
- Graph RAG retrieval relevance (precision@K against known-good test cases)

### Smoke Test (server deploy)

```bash
uv run python3 sinain-koog/triplestore.py --self-test
```

Standalone test: creates temp DB, writes/reads/queries, verifies all indexes, cleans up.

### Eval Framework Integration

Extend `eval/schemas.py`:
- Schema for `triple_ingest.py` output
- Assertion: `assert_triple_store_consistent` (no orphan refs, no duplicate entity IDs)
- Assertion: `assert_context_enrichment_relevant` (RAG context overlaps session topics)

### Monitoring

- `triplestore.db` size (expect <80MB after months)
- Heartbeat latency delta (expect <2s additional)
- LLM fallback rate for extraction (should decrease over time as vocab cache grows)
- Embedding model usage ratio (OpenRouter vs MiniLM fallback frequency)
