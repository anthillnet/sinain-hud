# Sinain Knowledge API

HTTP endpoints for querying, browsing, exporting, and importing knowledge from the sinain knowledge graph.

**Base URL**: `http://localhost:9500`
**Web UI**: `http://localhost:9500/knowledge/ui`

## Storage

Knowledge is stored in SQLite triplestore databases. The API queries **both** databases and merges results:

| Database | Path | Purpose |
|---|---|---|
| Local | `~/.sinain/memory/knowledge-graph.db` | Local session distillation (German lessons, meetings, etc.) |
| Workspace | `~/.openclaw/workspace/memory/knowledge-graph.db` | Server-side heartbeat curation |

Override paths with environment variables:
- `SINAIN_MEMORY_DIR` — local memory directory (default: `~/.sinain/memory`)
- `SINAIN_WORKSPACE` — workspace path (default: `~/.openclaw/workspace`)

---

## Endpoints

### GET /knowledge

Returns the portable knowledge document (`sinain-knowledge.md`) containing the playbook and top facts.

```bash
curl http://localhost:9500/knowledge
```

**Response:**
```json
{
  "ok": true,
  "content": "# Sinain Knowledge\n## Playbook...\n## Long-Term Knowledge..."
}
```

---

### GET /knowledge/facts

Query the knowledge graph for facts matching specific entities/keywords.

```bash
# Search by keywords
curl "http://localhost:9500/knowledge/facts?entities=german,grammar&max=10"

# Multiple keywords (comma-separated)
curl "http://localhost:9500/knowledge/facts?entities=react-native,metro,cache&max=5"
```

**Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `entities` | string | (required) | Comma-separated keywords to match against fact tags |
| `max` | number | 5 | Maximum facts to return (capped at 20) |

**Response:**
```json
{
  "ok": true,
  "facts": "- [german-language] German grammar (confidence: 0.9, confirmed 1x)\n- [culture] German culture (confidence: 0.8, confirmed 1x)"
}
```

The `facts` field is a text string (one fact per line), formatted for direct injection into agent prompts.

---

### GET /knowledge/entities

List all entities in the knowledge graph with full attribute details.

```bash
curl "http://localhost:9500/knowledge/entities?max=50"
```

**Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `max` | number | 50 | Maximum entities to return (capped at 200) |

**Response:**
```json
{
  "ok": true,
  "entities": "[{\"entityId\":\"fact:temporal-clauses-...\",\"domain\":\"german-language\",\"entity\":\"Temporal clauses (als vs. wenn)\",\"value\":\"German grammar\",\"confidence\":\"0.9\",\"reinforce_count\":\"1\"}]"
}
```

The `entities` field is a JSON string containing an array of fact objects. Each fact includes:
- `entityId` — unique identifier (e.g., `fact:temporal-clauses-17a02a92c2ec`)
- `entity` — human-readable name
- `attribute` — fact type (concept, description, focus, etc.)
- `value` — the fact content
- `domain` — category (german-language, culture, tools, etc.)
- `confidence` — score 0.0-1.0 (higher = more reliable)
- `reinforce_count` — how many times this fact has been confirmed

---

### GET /knowledge/export

Export knowledge facts as a portable JSON module. Use for transferring knowledge between sinain instances.

```bash
# Export all facts
curl "http://localhost:9500/knowledge/export" > sinain-knowledge-all.json

# Export by domain
curl "http://localhost:9500/knowledge/export?domain=german-language" > german-facts.json

# Limit export size
curl "http://localhost:9500/knowledge/export?max=20"
```

**Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `domain` | string | (all) | Filter by domain (e.g., `german-language`, `culture`, `tools`) |
| `max` | number | 100 | Maximum facts to export (capped at 500) |

**Response** (downloads as file):
```json
{
  "format": "sinain-knowledge-export",
  "version": 1,
  "exportedAt": "2026-04-10T09:53:52.103Z",
  "domain": "german-language",
  "count": 5,
  "facts": [
    {
      "entityId": "fact:temporal-clauses-17a02a92c2ec",
      "entity": "Temporal clauses (als vs. wenn)",
      "attribute": "concept",
      "value": "German grammar",
      "confidence": "0.9",
      "domain": "german-language",
      "reinforce_count": "1",
      "first_seen": "2026-04-10T07:03:00Z"
    }
  ]
}
```

---

### POST /knowledge/import

Import a knowledge module into the local knowledge graph. Deduplicates against existing facts.

```bash
# Import from file
curl -X POST http://localhost:9500/knowledge/import -d @german-facts.json

# Import from another sinain instance
curl -s http://other-sinain:9500/knowledge/export?domain=german-language | \
  curl -X POST http://localhost:9500/knowledge/import -d @-
```

**Request body:** JSON in sinain export format (`{"facts": [...]}`) or a bare JSON array of facts.

**Response:**
```json
{
  "ok": true,
  "stats": {"asserted": 3, "skipped": 2},
  "imported": 3,
  "skipped": 2
}
```

- `imported` — new facts added to the knowledge graph
- `skipped` — facts that already exist (same entity+attribute+value hash)

---

### GET /knowledge/ui

Web UI for browsing and managing knowledge. Open in a browser:

```
http://localhost:9500/knowledge/ui
```

**Features:**
- Browse all entities with search and domain filtering
- One-click export (all facts or filtered by domain)
- Import from pasted JSON or from a remote sinain instance URL
- Shows entity count, domain breakdown, confidence scores

---

## Knowledge Transfer Between Instances

### Export from Instance A → Import to Instance B

```bash
# On Instance A (source):
curl "http://A:9500/knowledge/export?domain=german-language" > german.json

# On Instance B (target):
curl -X POST "http://B:9500/knowledge/import" -d @german.json
# → {"ok":true,"imported":5,"skipped":0}
```

### Direct transfer via URL (from the Web UI)

1. Open `http://B:9500/knowledge/ui` in browser
2. In the import textarea, enter: `http://A:9500/knowledge/export?domain=german-language`
3. Click "Import from URL"

**Note:** Cross-origin requests may be blocked by the browser. For cross-machine transfer, use curl or download+paste the JSON.

---

## Local Knowledge Pipeline

Knowledge is created locally by the `LocalCurationService` (sinain-core):

### Session Distillation (on shutdown)
When sinain-core receives SIGINT/SIGTERM (Ctrl+C), it:
1. Collects all feed items from the current session
2. Calls `session_distiller.py` → condenses into a structured digest
3. Calls `knowledge_integrator.py` → updates playbook + knowledge graph
4. Writes daily session notes to `~/.sinain/memory/YYYY-MM-DD.md`

### Periodic Curation (every 30 minutes)
Runs automatically:
- `feedback_analyzer.py` → effectiveness scoring
- `memory_miner.py` → extract patterns from daily files
- `playbook_curator.py` → prune stale items, promote patterns

### Triplestore Schema

Each fact is stored as multiple triples:

| Attribute | Description | Example |
|---|---|---|
| `entity` | Human-readable name | "Temporal clauses (als vs. wenn)" |
| `attribute` | Fact type | "concept" |
| `value` | Fact content | "German grammar" |
| `confidence` | Reliability score | "0.9" |
| `domain` | Category | "german-language" |
| `first_seen` | When first observed | "2026-04-10T07:03:00Z" |
| `last_reinforced` | Last confirmed | "2026-04-10T07:03:00Z" |
| `reinforce_count` | Times confirmed | "1" |
| `tag` | Searchable keywords | "german", "grammar" |
| `valid_to` | Expiration (if retracted) | null or ISO timestamp |

### Confidence Decay

Facts lose confidence over time via exponential decay (60-day half-life):
```
decayed = confidence × e^(-0.693 × age_days / 60)
```

A fact with confidence 0.8 at 60 days old effectively becomes 0.4. Reinforcement resets the clock.

### Entity Canonicalization

Before asserting new facts, entity names are normalized (lowercase, hyphenated) and checked against existing entities. Near-matches (edit distance ≤ 2 or substring) are merged — converting a duplicate `assert` into a `reinforce` to prevent fragmentation.

---

## Compact Encoding

For escalation context injection, facts can be encoded in compact format:

```bash
python3 graph_query.py --db ~/.sinain/memory/knowledge-graph.db \
  --entities '["german"]' --format compact
```

Output: `german-language/german-language-lessons: cultural differences, politeness (0.95,2x)`

This uses ~3-5x fewer tokens than the full text format.
