# Sinain Knowledge Web — "Living Confluence" Redesign

Design document for transforming the current bare-bones `/knowledge/ui` (a single inline-HTML fact browser at `sinain-core/src/server.ts:15–149`) into a search-driven, LLM-rendered, transferable knowledge surface.

## 1. Goals & Non-Goals

### Goals
- Single search bar entry → ranked entity/topic results.
- Per-entity page rendered as a structured document: LLM-written summary, sectioned fact bullets, collapsable graph tree, citations.
- Bookmark system (favorite / archive / recent).
- Fact retraction from the UI (soft-delete with undo).
- Concept transfer between machines (export bundle + import + copy-link).
- Pages feel "alive" — re-render when new facts arrive, but cheap on cache hits.
- Backwards-compatible: keep existing `/knowledge/entities`, `/knowledge/facts`, `/knowledge/export` endpoints; add new ones.

### Non-Goals (v1)
- Multi-user auth — single-user system today.
- Editing facts from the page (read-only mutations except retract; new facts still go through distillation).
- Real-time push (WebSocket) page updates — polling on focus is fine.
- Full graph visualization (D3 force layout). v1 is a tree, not a graph.
- Bulk retraction (single-fact only in v1).

---

## 2. UX Flow

```
┌─ /knowledge/ui (HOME) ─────────────────────────────────────┐
│   [🔎 Search entities, topics, people…           ]        │
│                                                            │
│   ★ Favorites          📚 Recent          🗄  Archive        │
│   • Citibank           • migration plan   • old-vendor      │
│   • Parloa interview   • shipping freeze  • discarded-poc   │
│                                                            │
│   [⬆ Import concept]                                       │
└────────────────────────────────────────────────────────────┘
            │
            ▼ (user clicks entity OR types & hits ↵)
┌─ /knowledge/ui/entity/citibank ────────────────────────────┐
│  Citibank · org · 247 facts · last seen 2026-05-04         │
│  [★] [🗄] [↻] [🔗 Copy link] [⬇ Export concept]            │
│  ┌─ Tree ────┐  ┌─ Page ──────────────────────────────┐    │
│  │ Citibank  │  │  Summary                            │    │
│  │ ├ People  │  │  Citibank is the org employing the  │    │
│  │ │ ├ CTO   │  │  CTO Sinain has spoken with…        │    │
│  │ ├ Projects│  │  ## Key People                      │    │
│  │ │ └ …     │  │  • CTO has 17 yrs tenure [F-184]    │    │
│  │ └ Decisions│ │  • Director rejected proposal [F-201]│   │
│  └───────────┘  │  ## Decisions                       │    │
│                 │  • …                                │    │
│                 └─────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

### Search Resolution Modes

| User typed | Resolves to | Page type |
|---|---|---|
| "Citibank" → matches `entity:citibank` | Entity page | Standard |
| "shipping deadlines" → no entity match | Synthesized topic page | Topic — same layout, FTS+semantic-seeded, no graph tree |

One bar → both lookup and exploration.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (vanilla JS or Preact via CDN — no build step)      │
│  - SearchBar  - EntityPage  - GraphTree  - Bookmarks         │
└─────────────────────┬────────────────────────────────────────┘
                      │ HTTP (existing :9500)
┌─────────────────────▼────────────────────────────────────────┐
│  sinain-core (TS) — server.ts adds:                          │
│   GET    /knowledge/search?q=...                             │
│   GET    /knowledge/page?entity=...&refresh=0|1              │
│   GET    /knowledge/graph/children?entity=...&depth=1        │
│   GET    /knowledge/bookmarks?status=...                     │
│   POST   /knowledge/bookmarks                                │
│   DELETE /knowledge/bookmarks/:entity                        │
│   DELETE /knowledge/facts/:fact_id                           │
│   POST   /knowledge/facts/:fact_id/restore                   │
│   GET    /knowledge/concepts/export?entity=...&depth=1       │
│   POST   /knowledge/concepts/import                          │
└────┬───────────────────────────────────────────────┬─────────┘
     │ subprocess (existing pattern)                 │ better-sqlite3
     ▼                                               ▼
┌─────────────────────────┐         ┌───────────────────────────┐
│ sinain-memory (Python)  │         │ ~/.sinain/memory/web.db   │
│  graph_query.py         │         │  user_bookmarks           │
│  page_renderer.py NEW   │         │  page_cache               │
│  retract.py NEW         │         │  retraction_undo          │
│  concept_export.py NEW  │         │  concept_imports          │
│  concept_import.py NEW  │         │  search_log               │
└─────────────────────────┘         └───────────────────────────┘
```

**Why subprocess for triplestore writes/reads, in-process SQLite for `web.db`:**
- Triplestore schema knowledge owned by `triplestore.py` — forking that into TS would create drift on every schema change.
- `web.db` is UI metadata only (bookmarks, page cache, undo tokens) — no schema overlap with triplestore. Keep it close to the HTTP handlers (faster, simpler, no spawn cost).

---

## 4. API Surface

### 4.1 `GET /knowledge/search?q=<term>&limit=20`

Ranks **entities** (not facts) by:
1. Exact `entity:<slug>` hit (boost +1.0)
2. FTS5 over `fact.value` joined back to referenced entities, grouped by entity, summed score
3. Embedding similarity of `q` against entity centroid (top-3 facts averaged)

```json
{
  "results": [
    { "entity": "entity:citibank", "type": "org", "fact_count": 247,
      "snippet": "CTO with 17 yrs tenure mentioned…",
      "score": 0.91, "last_seen": "2026-05-04T11:02Z" }
  ],
  "topic_fallback": false
}
```

If `score_max < 0.4`, set `topic_fallback: true`.

### 4.2 `GET /knowledge/page?entity=<id>&refresh=0`

```json
{
  "entity": "entity:citibank",
  "generated_at": "2026-05-06T09:14Z",
  "tx_watermark": 14823,
  "from_cache": true,
  "summary": "Citibank is …",
  "sections": [
    { "heading": "Key People",
      "bullets": [
        { "fact_id": "fact:citibank-cto-17yrs",
          "text": "CTO has 17 yrs tenure",
          "confidence": 0.92, "domain": "people",
          "first_seen": "2026-04-12" }
      ],
      "subsections": [...]
    }
  ],
  "stats": { "fact_count": 247, "facts_used": 247,
             "tokens_in": 18420, "tokens_out": 1380, "cost_usd": 0.014 }
}
```

Behavior:
- Top-K (default 1000) facts via `query_facts_by_entities` + RRF.
- `tx_watermark` = max `tx_id` in result set.
- Cache lookup by `(entity, tx_watermark)`. Hit → return cached.
- Miss → LLM call (see §7), persist, return.
- `refresh=1` bypasses cache.

### 4.3 `GET /knowledge/graph/children?entity=<id>&depth=1`

Lazy-load tree expansion via VAET backref index (cheap):

```json
{
  "entity": "entity:citibank",
  "groups": [
    { "label": "People", "edge_attr": "employed_by",
      "children": [
        { "entity": "entity:citibank-cto", "fact_count": 12, "expandable": true } ] }
  ]
}
```

### 4.4 Bookmarks

```
GET    /knowledge/bookmarks?status=favorite|archive|recent
POST   /knowledge/bookmarks   { entity, status, note? }
DELETE /knowledge/bookmarks/:entity
```

### 4.5 Fact Retraction

```
DELETE /knowledge/facts/:fact_id
Body: { "reason"?: string, "actor"?: string }

Response:
  { "fact_id": "fact:...", "retracted": true,
    "retracted_tx": 14823, "triples_retracted": 7,
    "undo_token": "f9c3…", "expires_at": "2026-05-06T09:24Z" }
```

```
POST /knowledge/facts/:fact_id/restore
Body: { "undo_token": "f9c3…" }
```

Backed by `triplestore.retract_triple` (already exists at `triplestore.py:237`).
Soft-retract — flips `retracted=1`, sets `retracted_tx`, closes `valid_to`. Bi-temporal queries can still see the fact "as it existed at tx N." Physical removal only via `gc_retracted_triples` (off by default).

Two extra audit triples added at retraction:
- `(fact_id, "retracted_reason", reason, value_type=string)`
- `(fact_id, "retracted_by", actor)`

Pre-retraction snapshot stored in `web.db.retraction_undo` with 10-min TTL.

### 4.6 Concept Transfer

```
GET /knowledge/concepts/export
    ?entity=entity:citibank
    &depth=1
    &redact=private,creditcard,apikey
    &include_retracted=0
    &include_page=1
```

Returns `application/json` with `Content-Disposition: attachment; filename="citibank.sinain-concept.json"`.

```
POST /knowledge/concepts/import?conflict=skip|merge|overwrite
Body: { ...full sinain-concept/v1 envelope... }
```

---

## 5. Data Model — `~/.sinain/memory/web.db` (new, separate from triplestore)

```sql
CREATE TABLE user_bookmarks (
  entity_id     TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('favorite','archive','recent')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  last_visited  INTEGER NOT NULL
);
CREATE INDEX idx_bookmarks_status_visited
  ON user_bookmarks(status, last_visited DESC);

CREATE TABLE page_cache (
  entity_id     TEXT NOT NULL,
  tx_watermark  INTEGER NOT NULL,
  page_json     TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  PRIMARY KEY (entity_id, tx_watermark)
);
CREATE INDEX idx_page_cache_entity
  ON page_cache(entity_id, generated_at DESC);

CREATE TABLE retraction_undo (
  token         TEXT PRIMARY KEY,
  fact_id       TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,    -- serialized triples to restore
  retracted_tx  INTEGER NOT NULL,
  reason        TEXT,
  actor         TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);
CREATE INDEX idx_retraction_undo_expires
  ON retraction_undo(expires_at);

CREATE TABLE retraction_log (
  ts            INTEGER NOT NULL,
  fact_id       TEXT NOT NULL,
  reason        TEXT,
  actor         TEXT,
  undone_at     INTEGER,
  source_entity TEXT
);

CREATE TABLE concept_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at     INTEGER NOT NULL,
  root_entity     TEXT NOT NULL,
  source_tool     TEXT,
  source_version  TEXT,
  envelope_format TEXT NOT NULL,
  bundle_sha256   TEXT NOT NULL,
  conflict_mode   TEXT NOT NULL,
  triples_count   INTEGER,
  redactions_seen TEXT,
  notes           TEXT
);
CREATE INDEX idx_concept_imports_root
  ON concept_imports(root_entity, imported_at DESC);

CREATE TABLE search_log (
  ts            INTEGER NOT NULL,
  query         TEXT NOT NULL,
  resolved_to   TEXT,
  result_count  INTEGER
);
```

**Why `web.db` is separate from triplestore:** Triples are *claims about the world* (with confidence, retraction, bi-temporal validity). User preferences and UI cache are *metadata about UI state* — they shouldn't pollute the EAV graph or risk being "distilled" by the curator.

---

## 6. UI Layout

```
<KnowledgeApp>
├── <SearchBar>            // sticky top, ⌘K-bound
├── <Router>
│   ├── <HomeView>         // /knowledge/ui
│   │   ├── <BookmarkRow status="favorite" />
│   │   ├── <BookmarkRow status="recent" />
│   │   ├── <BookmarkRow status="archive" />
│   │   └── <ImportDropzone />
│   ├── <EntityPage entity>
│   │   ├── <PageHeader>      // name, type, badges, [★][🗄][↻][🔗][⬇]
│   │   ├── <Layout 3-col>
│   │   │   ├── <GraphTree root=entity />        // left rail, lazy
│   │   │   ├── <PageBody>                       // middle
│   │   │   │   ├── <Summary>
│   │   │   │   ├── <Section *>
│   │   │   │   │   └── <FactBullet fact_id />   // hover: source + ⋯ menu
│   │   │   │   └── <RawFactsAccordion />        // "Show all 1000"
│   │   │   └── <MetaPanel>                      // right rail: stats, timeline
│   ├── <TopicPage q>      // same shell, different data source
│   └── <MissingConcept entity />  // 404 → import dropzone with redirect
└── <CommandPalette ⌘K>    // search bar's backing
```

### Key Components

- **`<RawFactsAccordion>`** — escape hatch when LLM grouping is wrong. Lists every fact returned by retrieval with stable `fact_id`. `<FactBullet>`'s `[F-184]` chip links here.
- **`<FactBullet>` overflow menu** — hidden behind `⋯` (not a primary inline action; misclicks are costly). Reveals: source, confidence, domain, "Retract".
- **`<MetaPanel>`** — entity attributes (EAVT view), timeline sparkline of fact creation by week, cost & token counts for the page render (transparency).

---

## 7. LLM Page Generation

New script: **`sinain-memory/page_renderer.py`** — modeled on `insight_synthesizer.py` and `session_distiller.py`.

### Input

```python
{
  "entity_id": "entity:citibank",
  "entity_attrs": [...],       # from EAVT for the entity itself
  "facts": [                    # top-K, sorted: confidence * recency * graph_centrality
    { "fact_id": "fact:...", "value": "...", "domain": "people",
      "confidence": 0.92, "tags": ["cto","tenure"], "first_seen": "..." }
  ],
  "related_entities": [         # 1-hop, top 20 by edge count
    { "entity": "entity:cto-john-doe", "edge_attr": "employed_by", "fact_count": 12 }
  ]
}
```

### Prompt skeleton

```
You are organizing knowledge into a Confluence-style page about <entity_id>.
INPUT: a list of facts with stable fact_id values.
OUTPUT: JSON matching schema below.
RULES:
  - Group facts into 4–8 themed sections. Order: Overview → People →
    Projects/Work → Decisions → Open Questions → Recent Activity
    (only include sections that fit).
  - EVERY bullet must reference a real fact_id from the input. Do not invent.
  - The bullet `text` should be ≤ 140 chars, present-tense, plain English.
  - The summary is 2–4 sentences synthesizing the entity at a glance.
  - If facts contradict, prefer higher confidence and note disagreement
    in the `notes` field.
  - Output ONLY JSON.
SCHEMA: { summary, sections:[{ heading, bullets:[{fact_id,text,confidence}], notes? }] }
```

**fact_ids are pass-through.** Post-validate: every `fact_id` in LLM output must exist in input set — drop hallucinated bullets, log discrepancy. Same defensive pattern as `knowledge_integrator.py`.

### Token budget

- Naïve: 1000 facts × ~80 tokens ≈ 80k tokens in. Output ~2k. Gemini 2.5 Flash Lite (current `ANALYSIS_MODEL`) handles this at ~$0.01–0.02 per render.
- Two-tier render for entities with > 200 facts:
  1. Cluster facts by `domain` + tag co-occurrence → per-cluster summaries (LLM call 1, cheap).
  2. Aggregate cluster summaries + top-50 high-confidence facts into final page (LLM call 2).

### Streaming

Stream LLM response and emit Server-Sent Events on the page endpoint:
```
event: summary    data: {"text":"…"}
event: section    data: {"heading":"Key People","bullets":[…]}
event: section    data: {…}
event: done       data: {"stats":{…}}
```
Existing `agent/analyzer.ts` handles streaming OpenRouter responses — copy that pattern.

### Cache invalidation

Cache key is `(entity, tx_watermark)`. Invalidation is implicit: new facts → entity's max tx_id advances → cache key no longer matches → regenerate. Old entries kept (useful for "view as of last week" via existing `/knowledge/as-of`).

LRU pruning: cap `page_cache` at 500 rows, drop oldest by `generated_at` on each write.

---

## 8. Fact Retraction

### Backend — `sinain-memory/retract.py`

Mirrors `graph_query.py` subprocess pattern. Accepts `--retract-fact <id> --reason <text> --actor <text>`.

### Behavior

1. Open write tx on triplestore.
2. Look up all triples for `entity_id = :fact_id, retracted = 0`.
3. For each `(attribute, value)`, call `retract_triple(tx, fact_id, attribute, value)`.
4. Insert audit triples: `retracted_reason`, `retracted_by`.
5. Commit. Return `tx_id` as `retracted_tx`.
6. Persist pre-retraction snapshot to `web.db.retraction_undo` (10-min TTL).

### UI

- Trash icon hidden behind `⋯` overflow on `<FactBullet>`.
- Confirmation modal shows fact text, confidence, domain, link count, optional reason field, "I understand this hides from future searches" checkbox.
- Optimistic update: bullet strikethrough+fade for 300ms, then collapses.
- Snackbar: "✓ Retracted "<text>" [Undo]" with 10s timer bar. Server-side undo window is 10 minutes.
- `<MetaPanel>` toggle: "☐ Show retracted facts (12)" → adds `?include_retracted=1` to fact queries; retracted bullets render with strikethrough + `[restore]` chip.

### Edge Cases

| Case | Handling |
|---|---|
| Fact already retracted (race) | 409 + current state; toast "already retracted." |
| Retracted fact referenced by other facts as `ref` | Retract anyway. Other facts become dangling refs — `graph_query.py` already filters `retracted=0` at every join. |
| Distiller re-extracts a previously-retracted fact | New `fact:*` slug (encodes content+timing). Different entity. Retracted one stays retracted. |
| GC physically removes retracted triples | Undo token still in `retraction_undo` becomes dead. UI shows "this retraction can no longer be undone." Mitigation: only enable GC for triples > 30 days old. |

### Telemetry

Every retraction logs to `retraction_log`. Lets us answer "what % of LLM-extracted facts get retracted by the user, by domain/model?" — feeds back into evaluator quality. Add to daily eval report.

---

## 9. Concept Transfer (Copy-Link, Export, Import)

### Reproducibility Invariant

> "On a new machine: import the bundle → open the copied link → see the same page."

Three things must hold after import:
1. Entity ID resolves locally → **stable content-addressed slugs** (already true).
2. Fact set is identical → **deterministic triple replay** via `triplestore.assert_triple`.
3. Rendered page looks the same → **bundle the rendered page JSON** (LLM nondeterminism otherwise).

### Export Format — `sinain-concept/v1`

File extension: `.sinain-concept.json`

```json
{
  "format": "sinain-concept/v1",
  "exported_at": "2026-05-06T11:14:32Z",
  "exporter": {
    "tool": "sinain-core", "tool_version": "1.14.0",
    "schema_version": "triplestore/v3",
    "embedding_model": "all-MiniLM-L6-v2"
  },
  "root_entity": "entity:citibank",
  "depth": 1,
  "stats": { "entities": 38, "facts": 247, "triples": 1820 },
  "entities": [
    {
      "id": "entity:citibank",
      "type": "org",
      "triples": [
        { "attribute": "name", "value": "Citibank",
          "value_type": "string", "tx_id": 14001, "created_at": 1714823452000,
          "retracted": 0, "valid_to": null }
      ]
    }
    /* ... triples preserved verbatim including created_at ... */
  ],
  "rendered_page": {
    "rendered_at": "2026-05-06T09:14Z",
    "rendered_with": { "model": "google/gemini-2.5-flash-lite", "tokens_in": 18420, "tokens_out": 1380 },
    "tx_watermark": 14823,
    "summary": "Citibank is …",
    "sections": [ /* exactly the shape returned by GET /knowledge/page */ ]
  },
  "redactions": {
    "applied": ["private-tags", "credit-card", "api-key"],
    "rules_version": "1.2",
    "redacted_count": 3
  },
  "checksum": "sha256:9c2af3…"
}
```

**Notes:**
- Triples (not facts) — lossless round-trip through `triplestore.assert_triple`.
- `created_at` preserved; `tx_id` renumbered on import (see §9.4).
- Retracted triples included if `include_retracted=1`.
- `rendered_page` optional — toggle in dialog. Without it, receiver re-renders on first view.
- Embeddings NOT bundled — same model on both ends → same vectors. Saves ~1.5KB/fact.

### Export Preflight Dialog

```
Export concept: Citibank
  Scope
    ◉ Just this entity                   (38 entities, 247 facts, ~210 KB)
    ○ Include 1-hop neighbors            (94 entities, 612 facts, ~520 KB)
    ○ Include 2-hop neighbors            (218 entities, 1840 facts, ~1.6 MB)
  Privacy
    ☑ Strip <private>-tagged content
    ☑ Redact credit cards / API keys / passwords (default rules v1.2)
    ☐ Include retracted facts (audit trail)
  Page rendering
    ☑ Include rendered page (recipient gets instant view, no LLM call)
                                    [ Cancel ]  [ Export ]
```

Scope-preview tab below lists entities that would be included (especially important for 2-hop).

### Privacy Rules

Reuse regex set from `sense_client/privacy.py` (credit cards, API keys, AWS keys, bearer tokens, passwords). Extract to shared `sinain-memory/redaction.py` to avoid forking rules.

`<private>`-tagged fact values dropped entirely (not redacted).

**Redaction must apply to `rendered_page` text too** — not just triple values. The LLM may have woven sensitive content into its summary.

### Import — Conflict Modes

| Mode | Behavior on `(entity_id, attribute, value)` collision |
|---|---|
| **skip** | Existing wins; imported triple dropped. |
| **merge** (default) | Exact triple → reinforce or skip. Different value → insert as new triple (preserves bi-temporal history). |
| **overwrite** | Retract conflicting local triples, then assert imported. |

### Tx_id Remapping

1. `next_tx = max(local_tx) + 1`
2. Sort imported triples by `(source_tx_id, created_at)`.
3. Group triples sharing source tx into one receiver tx (preserves digest atomicity — `knowledge_integrator.py` writes use a shared tx).
4. Insert with re-issued tx_ids; store mapping in response for debugging.

### Page Cache Reuse

If `rendered_page` in bundle:
1. Validate `tx_watermark` corresponds to imported triples.
2. Insert into local `page_cache` keyed by `(entity, new_tx_watermark)` after tx remap.
3. First render on receiver = cache hit. Zero LLM cost. **This is the magic.**

### Idempotency

Re-importing the same bundle is a no-op in `merge` mode. `(entity_id, attribute, value)` triples map to "skip — duplicate." Stats reflect this.

### Copy-Link + Missing-Concept Landing

URL is just the entity URL: `http://localhost:9500/knowledge/ui/entity/citibank`.

On a new machine, that URL hits an entity that doesn't exist locally → 404. UI turns this into a useful action:

```
   ┌──────────────────────────────────────────────────────┐
   │  Concept "entity:citibank" not found on this machine │
   │  Did the sender share a .sinain-concept.json file?   │
   │  Drop it here or click to upload:                    │
   │      [📥 Drop concept bundle]                        │
   │  After import, this page will load automatically.    │
   └──────────────────────────────────────────────────────┘
```

The home view's `<ImportDropzone>` and `<MissingConcept>` are the **same component** — different entry points.

### Optional (Phase 5+): Embedded Bundle in URL

For small concepts (< ~30 KB after gzip+base64), encode bundle in URL fragment:
```
http://localhost:9500/knowledge/ui/entity/citibank#bundle=H4sIAAAAA...
```
Auto-import on missing entity. Warn in export dialog: "Embed in URL? Convenient but the bundle data travels with the link."

---

## 10. Acceptance Test for Reproducibility Invariant

CI-runnable:

```
1. On machine A: distill a session → get entity:foo → render page → checksum text.
2. Export entity:foo with --include-page=1 to bundle.json.
3. On a *fresh* machine B (empty triplestore, web.db, page_cache):
   a. POST /knowledge/concepts/import < bundle.json
   b. GET /knowledge/page?entity=entity:foo
   c. Assert: page text checksum == machine A's checksum.
4. On machine B with --include-page=0:
   a. Re-import without page cache.
   b. GET /knowledge/page?entity=entity:foo  → triggers LLM render.
   c. Assert: facts identical (set equality on fact_ids); page structure
      similar but may differ in exact wording.
```

---

## 11. Edge Cases & Failure Modes

### Page Generation
| Case | Handling |
|---|---|
| Entity has 0 facts | Empty-state with "no knowledge yet" + suggestion to capture more. No LLM call. |
| Entity has > 5000 facts | Sample top 1000 by composite score; banner "showing top 1000 of 5247." |
| LLM returns invalid JSON | Retry once with stricter prompt; fall back to ungrouped raw fact list. |
| LLM hallucinates fact_ids | Filter unknown ids; if > 30% dropped, regenerate once. |
| Subprocess timeout | 30s budget; return cached or empty page with banner. |
| Concurrent regenerate for same entity | Coalesce via in-memory `Map<entity, Promise>`. |

### Concept Transfer
| Case | Handling |
|---|---|
| Bundle from older `schema_version` | Best-effort import with migration log; reject if too old. |
| Imported tx_ids overlap with local | Always remap. |
| Imported `created_at` in future | Clamp to import time; warn. |
| Bundle > 100 MB | Reject unless user opts in. |
| `rendered_page.tx_watermark` mismatch | Drop cache; receiver re-renders. |
| Imported fact higher confidence than local (in merge) | Insert as new triple. |
| Local fact retracted, imported version not | Skip (don't resurrect retracted facts). |
| Bundle has fact referencing entity NOT in bundle | Allowed — dangling ref tolerated. |

### Reproducibility Invariant Failures
| Symptom | Likely cause |
|---|---|
| Receiver sees fewer facts | Depth too low at export, or `retracted` filter mismatch |
| Receiver's page text differs | `rendered_page` not bundled; receiver's LLM drifted |
| Graph tree shows missing children | Refs out of bundle scope |
| Receiver sees more facts than expected | Pre-existing local facts (merge mode) — show "12 imported, 4 existing" hint |

---

## 12. Phased Rollout

| Phase | Scope |
|---|---|
| **0** | `web.db` schema, bookmarks CRUD, `/knowledge/search`, `page_renderer.py`, `/knowledge/page` (no streaming). Old UI still served. |
| **1** | New SPA shell. Search → entity page with summary + sections + raw-facts accordion. `KNOWLEDGE_UI_V2` flag; legacy at `/knowledge/ui-legacy`. |
| **2** | Graph tree (`/knowledge/graph/children`, lazy-load). |
| **3** | Bookmarks UI (Favorites / Recent / Archive rows on home). |
| **4a** | Concept transfer (export, import, copy link, missing-concept landing). File-based bundles only. |
| **4b** | Topic mode (free-text → synthesized topic page). |
| **5** | Polish: streaming SSE, citation hovercards, timeline sparkline, cost-aware regenerate confirmation, retraction telemetry → eval reporter. |
| **5+** | URL-embedded bundles for small concepts. |

Fact retraction (`DELETE /knowledge/facts/:id`, restore, undo) ships in **Phase 1** alongside the entity page — without it the UI feels read-only.

---

## 13. Open Questions

1. **Framework choice** — vanilla JS + `lit-html` or Preact via CDN. Avoid heavy SPA frameworks for an internal tool. Decision needed before Phase 1.
2. **Auth** — none today, served on localhost. Bookmarks need `user_id` if remote ever exposed.
3. **Page-as-data export format** — should `/knowledge/page` also return Markdown (`?format=md`) for users who want to copy into actual Confluence/Notion? Cheap addition.
4. **Deep-render toggle** — offer Claude Sonnet 4.6 for high-stakes summaries via fallback chain pattern from `common.py`?
5. **Server-pushed concepts** — should the OpenClaw `sinain-hud` server plugin be able to push concepts to user machines, not just receive them? Natural Phase 6.

---

## 14. Key Insights from Codebase Exploration

- **`graph_query.py` already does heavy retrieval** (RRF tag-fusion, FTS5, VAET backrefs). The redesign is mostly UI + LLM rendering, not new retrieval.
- **Facts are addressable as `fact:*` entities with stable IDs** — lets us preserve `fact_id` through LLM rendering and link bullets back to sources.
- **`triplestore.retract_triple` exists** (line 237) — soft-retract via `retracted=1` + `retracted_tx`. Bi-temporal history preserved.
- **Entity IDs are content-addressed slugs** — same fact distilled on two machines collides on same ID, no UUID remapping.
- **Integrator is deterministic** — given same digest input, two machines produce same triples. Concept import is dumb triple-replay.
- **Dangling-ref tolerance** in `graph_query.py` is load-bearing for retraction — every join filters `retracted=0`, so retracting one fact doesn't cascade.
- **`sense_client/privacy.py` regex set** should be extracted to shared module so client-side and export-side stripping stay in sync.
