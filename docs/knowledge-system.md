# Sinain Knowledge System

The knowledge system gives sinain long-term memory that persists across sessions, transfers between instances, and enriches every agent interaction with accumulated know-how.

## Architecture

Two-tier memory model:

```
┌─────────────────────────────────────────────────────┐
│  PLAYBOOK (Working Memory)                          │
│  ~50 lines, actively curated, injected into every   │
│  agent prompt. Prunes after 7 days without          │
│  reinforcement. Answers: "what should I do NOW?"    │
├─────────────────────────────────────────────────────┤
│  KNOWLEDGE GRAPH (Long-Term Memory)                 │
│  SQLite triplestore, auto-tagged facts with         │
│  confidence tracking. Survives playbook pruning.    │
│  Answers: "what did we learn EVER that's relevant?" │
└─────────────────────────────────────────────────────┘
```

Both tiers are rendered into a single **portable knowledge document** (`sinain-knowledge.md`, <8KB) that any agent can consume.

## Knowledge Flow

```
                    ┌──────────────┐
                    │  sinain-core │
                    │  (port 9500) │
                    └──────┬───────┘
                           │ GET /feed, /agent/history
                           ▼
┌──────────────────────────────────────────────────────┐
│  HEARTBEAT TICK (every 15 min)                       │
│                                                       │
│  1. Git backup                                        │
│  2. Signal analysis (proactive suggestions)           │
│  3. Distillation check:                               │
│     └─ Fetch new feed items since last watermark      │
│     └─ session_distiller.py → SessionDigest           │
│     └─ knowledge_integrator.py:                       │
│        ├─ Update playbook (add/prune/promote)         │
│        ├─ Assert/reinforce/retract graph facts        │
│        └─ Render sinain-knowledge.md                  │
│  4. Insight synthesis (Telegram tips)                 │
└──────────────────────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Playbook │ │ Knowledge│ │ Knowledge│
        │   .md    │ │ Graph.db │ │   .md    │
        │ (working)│ │ (long-   │ │(portable)│
        │          │ │  term)   │ │          │
        └──────────┘ └──────────┘ └──────────┘
```

### Escalation Enrichment

When sinain-core escalates to an agent (OpenClaw or bare), the escalation message is enriched:

```
Escalation fires → extract keywords from digest (app, errors, tech)
                 → query knowledge graph via tag index
                 → inject "Past Experience" section into message
                 → agent sees current context + long-term knowledge
```

## Files

All files live in the workspace memory directory (`~/.openclaw/workspace/memory/`):

| File | Purpose |
|------|---------|
| `sinain-playbook.md` | Working memory (~50 lines). Actively curated patterns, anti-patterns, preferences. |
| `sinain-playbook-effective.md` | Merged playbook: active module patterns + base playbook. |
| `knowledge-graph.db` | Long-term memory. SQLite triplestore with auto-tagged facts. |
| `sinain-knowledge.md` | Portable knowledge doc (<8KB). Playbook + top graph facts + recent sessions. |
| `session-digests.jsonl` | Append-only log of session distillations. |
| `distill-state.json` | Watermark: `{ lastDistilledFeedId, lastDistilledTs }`. |
| `playbook-archive/` | Timestamped playbook snapshots (before each mutation). |
| `playbook-logs/YYYY-MM-DD.jsonl` | Heartbeat tick and integration decision logs. |

## Knowledge Graph

### Storage

The graph uses an EAV (Entity-Attribute-Value) triplestore (`triplestore.py`) with 4 covering indexes:

- **EAVT**: "What does entity X look like?" (entity lookup)
- **AEVT**: "Which entities have attribute Y?" (attribute scan)
- **VAET**: "What references entity Z?" (reverse traversal)
- **AVET**: "Find entity by attribute+value" (tag search)

### Fact Structure

Each fact is an entity with multiple attributes:

```
(fact:metro-bundler-d4ae7447d607, entity,          "metro-bundler")
(fact:metro-bundler-d4ae7447d607, attribute,        "crash-fix")
(fact:metro-bundler-d4ae7447d607, value,            "After installing native RN deps, Metro may crash. Fix: npx react-native start --reset-cache")
(fact:metro-bundler-d4ae7447d607, confidence,       "0.85")
(fact:metro-bundler-d4ae7447d607, domain,           "react-native")
(fact:metro-bundler-d4ae7447d607, first_seen,       "2026-03-21T21:10:00Z")
(fact:metro-bundler-d4ae7447d607, last_reinforced,  "2026-03-21T21:10:00Z")
(fact:metro-bundler-d4ae7447d607, reinforce_count,  "1")
(fact:metro-bundler-d4ae7447d607, tag,              "metro")
(fact:metro-bundler-d4ae7447d607, tag,              "react-native")
(fact:metro-bundler-d4ae7447d607, tag,              "cache")
(fact:metro-bundler-d4ae7447d607, tag,              "native")
(fact:metro-bundler-d4ae7447d607, tag,              "crash")
```

### Auto-Tag Index

Facts are auto-tagged with keywords extracted from their value text at assert time. Tags enable keyword-based discovery across all domains — searching "metro" finds facts regardless of whether they're tagged domain "react-native" or "general".

Tags use the AVET index for O(log n) lookup. Results are ranked by match count: a fact matching 3/5 search keywords scores higher than one matching 1/5.

### Confidence Lifecycle

```
Assert:     confidence = 0.7-0.9 (set by LLM)
Reinforce:  confidence = min(1.0, old + 0.15), reinforce_count++
Decay:      confidence -= 0.03/day since last_reinforced
Prune:      retracted when confidence < 0.2 AND last_reinforced > 30 days ago
```

Retraction is soft — the fact stays in the transaction history and can be re-asserted if the same pattern reappears in a later session.

### Retraction (Soft Forgetting)

`retract_triple(tx, entity, attribute, value)` marks a fact as logically deleted. The fact remains in the database with a `retracted_tx` reference, enabling:

- **Recovery**: If the same fact is learned again, the integrator re-asserts it. The history shows "forgotten at T1, remembered at T2."
- **Seasonal knowledge**: Facts like "merge freeze before release" can cycle between active and retracted.
- **Correction**: Retract a wrong fact, assert a corrected version.

## Session Distillation

### How It Works

`session_distiller.py` takes feed items from sinain-core and produces a structured `SessionDigest`:

```json
{
  "whatHappened": "User debugged React Native Metro crash after adding BLE module. Cache reset fixed it.",
  "patterns": ["Metro cache reset fixes module resolution after native dep install"],
  "antiPatterns": ["Direct metro restart without cache clear doesn't fix module resolution"],
  "preferences": [],
  "entities": ["react-native", "metro-bundler", "react-native-ble-plx", "BLE"],
  "toolInsights": [],
  "isEmpty": false
}
```

Single LLM call (smart model), ~10 seconds, ~1,200 tokens.

### Distillation Watermark

The heartbeat tracks what's been distilled via `distill-state.json`:

```json
{ "lastDistilledFeedId": 42, "lastDistilledTs": "2026-03-21T21:00:00Z" }
```

Each heartbeat fetches `GET /feed?after=lastDistilledFeedId`. If >3 significant new items exist, distillation runs. This ensures:

- No duplicate distillation of the same content
- Works across session boundaries (sessions get killed, heartbeat persists)
- Backend-agnostic: uses sinain-core HTTP API, not OpenClaw sessions_history

## Knowledge Integration

`knowledge_integrator.py` takes a SessionDigest + current playbook + graph facts and produces:

1. **Updated playbook** — add novel patterns, reinforce existing ones, prune contradicted ones
2. **Graph operations** — assert new facts, reinforce confirmed facts, retract contradicted facts
3. **Integration log** — appended to `playbook-logs/YYYY-MM-DD.jsonl`

Single LLM call (smart model), ~15 seconds, ~3,700 tokens.

### Bootstrap

Seed a fresh knowledge graph from an existing playbook:

```bash
cd ~/.openclaw/workspace
python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --bootstrap
```

### Re-Tag

After upgrading from entity-based to tag-based search, retag all existing facts:

```bash
python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --retag
```

## Commands (MCP Tools)

Available via `sinain-mcp-server` for any MCP-capable agent:

| Tool | Description |
|------|-------------|
| `sinain_get_knowledge` | Read the portable knowledge document (playbook + facts + sessions) |
| `sinain_knowledge_query` | Query knowledge graph by keywords. Returns ranked facts matching any provided keyword. |
| `sinain_distill_session` | Trigger session distillation + knowledge integration manually |
| `sinain_heartbeat_tick` | Run full heartbeat pipeline (backup, signals, distillation, insights) |

### Examples

```bash
# Query graph for React Native knowledge
sinain_knowledge_query(entities=["react-native", "metro", "gradle"], max_facts=5)

# Read full knowledge document
sinain_get_knowledge()

# Manually distill current session
sinain_distill_session(session_summary="debugging BLE integration")
```

## HTTP Endpoints

Available from sinain-core (`localhost:9500`):

| Endpoint | Description |
|----------|-------------|
| `GET /knowledge` | Returns `sinain-knowledge.md` content as JSON `{ ok, content }` |
| `GET /knowledge/facts?entities=x,y&max=5` | Query graph by keywords, returns formatted text |

## CLI Scripts

Run from the workspace directory (`~/.openclaw/workspace/`):

```bash
# Bootstrap graph from playbook
python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --bootstrap

# Re-tag all facts (after upgrade)
python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --retag

# Distill a transcript manually
python3 sinain-memory/session_distiller.py --memory-dir memory/ \
  --transcript '[{"text":"...","source":"agent","ts":1234}]' \
  --session-meta '{"ts":"2026-03-21T12:00:00Z","sessionKey":"test"}'

# Integrate a digest
python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ \
  --digest '{"whatHappened":"...","patterns":[...],"entities":[...]}'

# Query graph
python3 sinain-memory/graph_query.py --db memory/knowledge-graph.db \
  --entities '["react-native","metro"]' --max-facts 5 --format text

# Top facts by confidence
python3 sinain-memory/graph_query.py --db memory/knowledge-graph.db --top 20

# Domain distribution
python3 sinain-memory/graph_query.py --db memory/knowledge-graph.db --domain-counts
```

## Export & Transfer

### Knowledge Snapshot (Full Instance)

The snapshot system exports the entire knowledge state for cross-instance transfer:

```
Version 3 snapshot:
├── playbook (base + effective + archive)
├── modules (registry + manifests + patterns + guidance)
├── graphFacts (top 500 facts as JSON array — not the raw SQLite DB)
├── knowledgeDoc (rendered sinain-knowledge.md)
├── logs (session summaries + playbook logs + eval logs)
└── config (memory + eval)
```

Import creates a fresh `knowledge-graph.db` from the facts JSON and writes all files to the target workspace.

### Module Export (Domain-Scoped)

Export a specific domain's knowledge as a portable bundle:

```bash
python3 sinain-memory/module_manager.py --modules-dir modules/ export react-native-dev
```

The bundle includes module files (manifest, patterns, guidance) plus graph facts scoped to the module's domain.

Import on another instance:

```bash
python3 sinain-memory/module_manager.py --modules-dir modules/ import react-native-dev.sinain-module.json --activate
```

### Bootstrap: OpenClaw Instance

1. Install the plugin:
   ```bash
   npx @geravant/sinain install
   ```

2. Bootstrap the knowledge graph:
   ```bash
   cd ~/.openclaw/workspace
   python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --bootstrap
   python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --retag
   ```

3. Restart the gateway to pick up new plugin code:
   ```bash
   systemctl restart openclaw-gateway  # native
   # or
   docker compose -f docker-compose.openclaw.yml restart  # Docker
   ```

4. The heartbeat will begin distilling sessions automatically.

### Bootstrap: Bare Agent

1. Install:
   ```bash
   npx @geravant/sinain install
   ```

2. If you have a snapshot from another instance:
   ```bash
   python3 sinain-agent/restore-snapshot.py
   ```

3. Or bootstrap from scratch:
   ```bash
   cd ~/.openclaw/workspace
   cp sinain-agent/seed-playbook.md memory/sinain-playbook.md
   python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --bootstrap
   python3 sinain-memory/knowledge_integrator.py --memory-dir memory/ --retag
   ```

4. Start the bare agent:
   ```bash
   cd sinain-agent && ./run.sh
   ```

5. The agent's heartbeat will distill sessions and grow the knowledge graph over time.

## Configuration

### memory-config.json / koog-config.json

Controls model selection and timeouts for all Python scripts:

```json
{
  "models": {
    "fast": "google/gemini-3-flash-preview",
    "smart": "anthropic/claude-sonnet-4.6"
  },
  "scripts": {
    "session_distiller":    { "model": "smart", "maxTokens": 1500, "timeout": 30 },
    "knowledge_integrator": { "model": "smart", "maxTokens": 3000, "timeout": 60 },
    "signal_analyzer":      { "model": "fast",  "maxTokens": 1500 },
    "insight_synthesizer":  { "model": "smart", "maxTokens": 800 }
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` or `OPENROUTER_API_KEY_REFLECTION` | Required for LLM calls in Python scripts |
| `SINAIN_CORE_URL` | sinain-core address (default: `http://localhost:9500`) |
| `SINAIN_WORKSPACE` | Workspace path (default: `~/.openclaw/workspace`) |

## Evaluation

The eval pipeline monitors knowledge system quality:

- **tick_evaluator.py**: Per-tick schema validation + behavioral assertions + optional LLM judges
- **eval_reporter.py**: Daily aggregate report with quality gates and regression detection

Quality gates:
- Schema validity >= 85%
- Assertion pass rate >= 85%
- Mean judge score >= 3.0/4.0
- Skip rate <= 80%
