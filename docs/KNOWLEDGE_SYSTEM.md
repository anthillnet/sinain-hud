# Sinain Knowledge System

A self-improving, feedback-driven knowledge layer that augments every OpenClaw agent turn with
curated patterns and graph context. The system runs three interlocking loops: ingest (raw signals
→ triplestore), curation (feedback → playbook evolution), and injection (playbook + graph →
agent context).

---

## 1. Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INGEST LOOP                                 │
│  sinain-core tick                                                   │
│     └─ escalation digest ──→ triple_extractor ──→ triplestore.db   │
│                                                 └─→ embeddings      │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│                        CURATION LOOP (every 30 min)                 │
│  heartbeat tick output (playbook-logs/YYYY-MM-DD.jsonl)             │
│     └─ feedback_analyzer ──→ curateDirective + effectivenessScore   │
│          └─ memory_miner  ──→ newPatterns + contradictions          │
│               └─ playbook_curator ──→ sinain-playbook.md (archived) │
│                    └─ generateEffectivePlaybook() ──→               │
│                         sinain-playbook-effective.md                │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│                        INJECTION LOOP (every agent turn)            │
│  before_agent_start (sinain-hud-plugin)                             │
│     └─ prependContext:                                              │
│          [CURRENT TIME]                                             │
│          [SYSTEM] Recovery Context     (one-shot after outage)      │
│          [PARENT SESSION CONTEXT]      (subagents only, TTL-gated)  │
│          [HEARTBEAT PROTOCOL]                                       │
│          [SITUATION]                   (SITUATION.md from RPC)      │
│          [PLAYBOOK PATTERNS]           (effective playbook)         │
│          [KNOWLEDGE TRANSFER]          (if transferred patterns)    │
│          [MODULE GUIDANCE]             (active modules, priority ↓) │
│          [KNOWLEDGE GRAPH CONTEXT]     (triple_query, 10s timeout)  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Triplestore

### Format & Storage

- **SQLite EAV** (Entity–Attribute–Value), file at `memory/triplestore.db`
- 4 covering indexes: `idx_eavt`, `idx_aevt`, `idx_vaet` (backrefs), `idx_avet` (lookup)
- **Immutable append + retract model** (Datomic-style): triples are never updated in place;
  retraction sets `retracted=1` and records the retracting transaction ID
- **GC:** physically deletes retracted triples older than 30 days (`gcOlderThanDays` in
  `koog-config.json`). Live (non-retracted) triples are never garbage-collected.

### Entity ID Prefixes

| Prefix | Example | Meaning |
|--------|---------|---------|
| `signal:` | `signal:2026-03-12T14:00:00Z` | Detected signal from a tick |
| `concept:` | `concept:flutter` | Domain concept |
| `pattern:` | `pattern:ocr-queue-depth` | Playbook/mined pattern |
| `session:` | `session:1741780000` | Session summary |
| `tool:` | `tool:grep` | Tool usage |
| `module:` | `module:cairo2e-rules` | Knowledge module |
| `guidance:` | `guidance:use-dx-over-pixels` | Module-specific instruction |

### Key Files

| File | Role |
|------|------|
| `triplestore.py` | SQLite EAV store (read/write/GC) |
| `triple_extractor.py` | 3-tier triple extraction pipeline |
| `triple_ingest.py` | CLI ingest entry point |
| `triple_query.py` | Context generation (vector + keyword) |

### Writing Triples

`triple_ingest.py` drives a **3-tier extractor**:

1. **JSON direct** (~70% of cases) — escalation payloads arrive as structured JSON
2. **Regex + validate** (~20%) — pattern-matched extraction with schema validation
3. **LLM fallback** (~10%) — unstructured text parsed by `fast` model

### Querying Triples

`triple_query.py --context "<seed text>" --max-chars 1500` runs vector search via `embedder.py`
with keyword fallback, returning a markdown block (capped at 1500 chars). The plugin calls this
with `--context "current session"` on every agent turn with a 10-second timeout; the block is
silently skipped on failure or empty result.

---

## 3. Playbook System

### Files

| File | Purpose |
|------|---------|
| `memory/sinain-playbook.md` | Base playbook (50-line limit, curator-managed) |
| `memory/sinain-playbook-effective.md` | Merged: active module patterns (priority ↓) + base playbook |
| `memory/playbook-archive/` | Timestamped snapshots before each curation run |

### Playbook Anatomy

```markdown
<!-- mining-index: 2026-03-10,2026-03-09,... -->
# Sinain Playbook
## Established Patterns
- Pattern text (score: 0.8)
## Observed
- Medium-confidence observation
## Stale
- Old item [since: 2026-02-18]
<!-- effectiveness: outputs=8, positive=5, negative=1, neutral=2, rate=0.63, updated=2026-03-10 -->
```

### Curation Rules (`playbook_curator.py`)

The curator receives a `curateDirective` from `feedback_analyzer.py` and applies different rules:

| Directive | Trigger | ADD threshold |
|-----------|---------|---------------|
| `stability` | High effectiveness | score > 0.5 only |
| `normal` | Default | score > 0.3 |
| `aggressive_prune` | Low effectiveness | Prune unverified items |
| `insufficient_data` | Too few ticks | No curation |

Additional rules:
- **PRUNE** entries older than 7 days without reinforcement
- **PROMOTE** after 3+ observations: `## Observed` → `## Established Patterns`
- **DEDUPLICATE** against active module patterns (merge same-concept variants)
- **PRESERVE** error-prevention patterns unconditionally
- **Stale lifecycle:** new fixable item → `[since: YYYY-MM-DD]` → `[deferred: YYYY-MM-DD, reason: "..."]`
  after 3 actions without resolution → max 5 deferred items (oldest pruned at 6th)

---

## 4. Knowledge Modules

### Registry

`modules/module-registry.json` — tracks `id`, `status` (`active`/`suspended`/`disabled`),
`priority` (0–100), and `locked` flag.

### Module Structure

```
modules/{id}/
  manifest.json   — id, name, priority, locked, importedAt?
  patterns.md     — markdown patterns, deduplicated into effective playbook
  guidance.md     — optional behavioral instructions → injected as [MODULE GUIDANCE]
```

### Lifecycle (`module_manager.py`)

Commands: `activate`, `suspend`, `export`, `import`

- **Export** → portable `.sinain-module.json` bundle
- **Import + `--activate`** → register + fire-and-forget `triple_ingest --ingest-module`
- Transferred module patterns are tagged `[Transferred knowledge: id]` in the effective playbook,
  triggering a `[KNOWLEDGE TRANSFER]` attribution hint in `prependContext`

**`base-behaviors` module:** priority 0, `locked=true`, always active.

---

## 5. Curation Pipeline

Runs every 30 minutes on the server (triggered by the heartbeat curation service in the plugin).

```
playbook-logs/YYYY-MM-DD.jsonl   (heartbeat tick outputs)
        │
        ▼
feedback_analyzer.py  ──→  effectivenessScore + curateDirective
        │                  (aggressive_prune | normal | stability | insufficient_data)
        ▼
memory_miner.py       ──→  newPatterns, contradictions, preferences
(smart model,                (reads daily memory + KG context via triple_query)
 idle sessions only)
        │
        ▼
playbook_curator.py   ──→  updated sinain-playbook.md + archive snapshot
(curate directive applied)
        │
        ▼
generateEffectivePlaybook()  ──→  sinain-playbook-effective.md
(plugin, before curation)         (module patterns sorted priority ↓ + base playbook)
```

### Playbook Log Format (JSONL)

```json
{
  "ts": "2026-03-12T14:00:00Z",
  "idle": false,
  "sessionHistorySummary": "...",
  "feedbackScores": {"avg": 0.35},
  "signals": [...],
  "curateDirective": "normal",
  "effectivenessRate": 0.63,
  "output": {"suggestion": "...", "insight": "..."}
}
```

---

## 6. Context Injection (prependContext)

Called on every agent turn via the `before_agent_start` hook in `sinain-hud-plugin/index.ts`.
This is the **only** injection point — sinain-core no longer injects knowledge client-side
(removed in `feat/knowledge-augmented-escalation`).

### Injection Order

1. **`[CURRENT TIME]`** — always; formatted in `userTimezone` from plugin config
2. **`[SYSTEM] Recovery Context`** — one-shot after API outage clears; includes outage duration
3. **`[PARENT SESSION CONTEXT]`** — subagents only; skipped if cache is older than 10 minutes
4. **`[HEARTBEAT PROTOCOL]`** — present when `HEARTBEAT.md` exists in workspace
5. **`[SITUATION]`** — content of `SITUATION.md`, pushed by sinain-core via `situation.update` RPC
6. **`[PLAYBOOK PATTERNS]`** — `sinain-playbook-effective.md`
7. **`[KNOWLEDGE TRANSFER]`** — appended after playbook if it contains `[Transferred knowledge:]` tags
8. **`[MODULE GUIDANCE]`** — `guidance.md` from active modules, sorted by priority descending
9. **`[KNOWLEDGE GRAPH CONTEXT]`** — `triple_query.py` output (10s timeout, silently skipped on failure or short result)

All parts joined with `\n\n` and returned as `{ prependContext }`.

---

## 7. sinain-core Feedback Loop

**Location:** `sinain-core/src/learning/`

### feedback-store.ts

JSONL log at `~/.sinain-core/feedback/YYYY-MM-DD.jsonl`. Each record is written at escalation
time with `null` signals, then patched in-place by `signal-collector` at +60s, +120s, and +300s.

`getSummary(days=3)` aggregates scored records into a `FeedbackSummary`:
- `avg` — mean compositeScore over the window
- `high` — escalation reason tags from records with compositeScore > 0.5
- `low`  — escalation reason tags from records with compositeScore < -0.2
- `count` / `since` — record count and oldest timestamp

### signal-collector.ts

Schedules three deferred checks after each escalation (partial at 60s + 120s, final at 300s).
Computes 5 signals per record:

| Signal | Max positive contribution | Meaning |
|--------|--------------------------|---------|
| `errorCleared` | 0.50 | All error patterns absent from next 3 agent digests |
| `noReEscalation` | 0.30 | Same escalation reasons didn't fire within 5 min |
| `dwellTimeMs` | 0.15 | Time until next HUD push (>60s = positive, <10s = negative) |
| `quickAppSwitch` | 0.05 | App changed within 10s of escalation (negative signal) |
| `compositeScore` | — | Raw sum of contributions, clamped to [-1, +1] (not normalized) |

> **Note on `quickAppSwitch`:** The internal weight is 0.10 (used only to gate the "no data" early
> return), but the actual contribution is `+0.05` when `quickAppSwitch=false` and `-0.15` when
> `quickAppSwitch=true`. Positive contributions sum to exactly 1.0.

### Cross-machine feedback delivery

`compositeScore` is computed on the user's machine (sinain-core) but the curation pipeline runs
on the OpenClaw server. The two sides are bridged via the `feedback.report` RPC — the same
pattern as `situation.update`:

```
sinain-core (user machine)
  FeedbackStore.getSummary(days=3)
       → { avg, high[], low[], count, since }
  Escalator.pushFeedbackSummary()
       → sendRpc("feedback.report", { summary })   [on WS connect + every 10 min]

OpenClaw plugin (server)
  registerGatewayMethod("feedback.report")
       → cachedFeedbackSummary updated in-memory
       → memory/feedback-summary.json written atomically (tmp→rename)
       → cache restored from disk on gateway restart

sinain_heartbeat_tick tool handler
       → logEntry.feedbackScores = { avg, high, low }

feedback_analyzer.py
       → reads feedbackScores.avg → real effectivenessScore + curateDirective
```

`feedbackScores: null` in a log entry means sinain-core hasn't pushed a summary yet (handled
gracefully by `feedback_analyzer.py` via `entry.get("feedbackScores", {})`).

### Key files

| File | Role |
|------|------|
| `sinain-core/src/types.ts` | `FeedbackSummary` interface |
| `sinain-core/src/learning/feedback-store.ts` | `getSummary()` method |
| `sinain-core/src/escalation/escalator.ts` | `pushFeedbackSummary()` + 10-min interval |
| `sinain-hud-plugin/index.ts` | `feedback.report` RPC handler + heartbeat log injection |
| `memory/feedback-summary.json` | Persisted summary cache (runtime, gitignored) |

---

## 8. Evaluation System

### tick_evaluator.py (every 30 min)

- Finds unevaluated ticks by diffing `playbook-logs/` vs `memory/eval-logs/`
- Per tick: schema validation → behavioral assertions → optional LLM judges
- **Eval levels:** `mechanical` (zero LLM calls), `sampled` (30% sampled), `full`
- Writes to `memory/eval-logs/YYYY-MM-DD.jsonl`

### eval_reporter.py (daily, 03:00 UTC)

- Aggregates `eval-logs/` over 24 hours
- Computes: schema validity rate, assertion pass rate, judge scores, failure histogram
- Detects regressions against configured thresholds
- Writes `memory/eval-reports/YYYY-MM-DD.md` with LLM-interpreted trend analysis

### Judges

`judge_signal`, `judge_curation`, `judge_insight`, `judge_mining`
All run the `smart` model (see `koog-config.json`), 200 token budget, 30s timeout.

### Regression Thresholds (`koog-config.json → eval.regressionThresholds`)

| Metric | Threshold |
|--------|-----------|
| `assertionPassRate` | 0.85 |
| `effectivenessRate` | 0.40 |
| `skipRate` | 0.80 |

---

## 9. File Map

### sinain-koog/ (Python)

| File | Role |
|------|------|
| `triplestore.py` | SQLite EAV store (read/write/GC) |
| `triple_extractor.py` | 3-tier triple extraction pipeline |
| `triple_ingest.py` | CLI ingest entry point |
| `triple_query.py` | Context generation (vector + keyword) |
| `embedder.py` | Dual-strategy embeddings (OpenRouter + MiniLM) |
| `feedback_analyzer.py` | Mechanical effectiveness computation |
| `memory_miner.py` | Deep-mining daily memory files (smart model) |
| `playbook_curator.py` | Archive + curate playbook |
| `module_manager.py` | Module activate/suspend/export/import |
| `tick_evaluator.py` | Per-tick eval (schema + assertions + judges) |
| `eval_reporter.py` | Daily aggregated eval report |
| `eval_delta.py` | Eval diff utility |
| `insight_synthesizer.py` | Insight synthesis from session history |
| `signal_analyzer.py` | Signal analysis helpers |
| `triple_migrate.py` | Triplestore schema migration utility |
| `common.py` | Shared LLM calls, JSON extraction, memory readers |
| `koog-config.json` | Model assignments, eval thresholds, triplestore config |

### sinain-hud-plugin/

| File | Role |
|------|------|
| `index.ts` | prependContext + curation service + RPC handlers |

### sinain-core/src/learning/

| File | Role |
|------|------|
| `feedback-store.ts` | JSONL feedback log |
| `signal-collector.ts` | Deferred signal backfill (+60s/+120s/+300s) |

### memory/ (runtime state, gitignored)

| Path | Contents |
|------|---------|
| `sinain-playbook.md` | Base playbook (curator-managed) |
| `sinain-playbook-effective.md` | Merged playbook (plugin-generated) |
| `triplestore.db` | Knowledge graph (SQLite) |
| `playbook-logs/*.jsonl` | Heartbeat tick outputs |
| `eval-logs/*.jsonl` | Per-tick eval results |
| `eval-reports/*.md` | Daily eval reports |
| `playbook-archive/` | Timestamped playbook snapshots |

### modules/ (runtime state)

| Path | Contents |
|------|---------|
| `module-registry.json` | Active module registry |
| `{id}/manifest.json` | Module metadata (id, priority, locked) |
| `{id}/patterns.md` | Patterns merged into effective playbook |
| `{id}/guidance.md` | Behavioral instructions injected as [MODULE GUIDANCE] |

---

## 10. Configuration (`koog-config.json`)

```json
{
  "models": {
    "fast":  "google/gemini-3-flash-preview",
    "smart": "anthropic/claude-sonnet-4.6"
  }
}
```

- **fast model** — used for: `signal_analyzer`, `feedback_analyzer`, `playbook_curator`,
  `module_manager`, `triple_extractor`
- **smart model** — used for: `memory_miner`, `insight_synthesizer`, `tick_evaluator`,
  `eval_reporter`, LLM judges
- **Token budgets and timeouts** per script are set in the `scripts` block
- **Triplestore:** `gcOlderThanDays: 30`, `maxTriplesPerTx: 100`,
  `conceptExtractionMode: "tiered"`
- **Eval:** `level: "sampled"`, `sampleRate: 0.3`; regression thresholds in `eval.regressionThresholds`

Reference `koog-config.json` directly for current model assignments and sampler rates.
