# Local-First Knowledge Pipeline

## Problem

Sinain's knowledge pipeline (session distillation → knowledge integration → playbook curation) only runs server-side on the OpenClaw gateway. When the gateway WS is disconnected (common for bare-agent setups, or when the server is down), **zero knowledge is persisted** — even from 50-minute sessions with rich content.

The feedback JSONL (`~/.sinain-core/feedback/`) captures escalation decisions and signals, but nobody reads it back. Recording summaries (spawn tasks) appear in the feed but are ephemeral. The knowledge graph stays empty.

## Goal

Run the knowledge pipeline locally in sinain-core. No OpenClaw dependency. Knowledge persists between bare-agent sessions at `~/.sinain/memory/`.

## Architecture

```
sinain-core (always running)
  ├── agent loop → feed items, digests
  ├── escalator → spawn task results (recording summaries)
  ├── recorder → audio transcripts
  ├── feedback-store → ~/.sinain-core/feedback/YYYY-MM-DD.jsonl
  │
  ├── NEW: LocalCurationService (30-min timer)
  │   ├── session_distiller.py → condense feed into SessionDigest
  │   ├── knowledge_integrator.py → update playbook + knowledge graph
  │   ├── memory_miner.py → extract patterns from daily files
  │   └── playbook_curator.py → prune/promote/archive
  │
  └── NEW: onShutdown hook
      └── Final distillation on SIGINT/SIGTERM
```

## Local Memory Directory

```
~/.sinain/memory/
├── sinain-playbook.md              # Working playbook (curated patterns)
├── sinain-knowledge.md             # Top-30 facts for recap
├── knowledge-graph.db              # SQLite triplestore
├── playbook-logs/
│   └── YYYY-MM-DD.jsonl           # Heartbeat tick logs
├── playbook-archive/
│   └── sinain-playbook-YYYY-MM-DD-HHMM.md
├── YYYY-MM-DD.md                   # Daily session notes
├── eval-logs/
├── eval-reports/
└── session-summaries.jsonl         # Distilled session digests
```

Falls back to `~/.openclaw/workspace/memory/` if it exists (OpenClaw mode).

## Implementation Phases

### Phase 1: Session-end distillation

On SIGINT/SIGTERM, before shutdown:

1. Collect feed items from the current session (already in FeedBuffer)
2. Collect spawn task results (recording summaries, already in memory)
3. Call `session_distiller.py` with the transcript
4. Call `knowledge_integrator.py` with the digest
5. Write daily session notes to `~/.sinain/memory/YYYY-MM-DD.md`

**Files to modify:**
- `sinain-core/src/index.ts` — add shutdown distillation hook
- `sinain-core/src/learning/local-curation.ts` — new: LocalCurationService

### Phase 2: Periodic curation (30-min timer)

Mirror the server-side CurationEngine timer:

1. Every 30 minutes, run:
   - `feedback_analyzer.py` → effectiveness rate + curation directive
   - `memory_miner.py` → extract patterns from unread daily files
   - `playbook_curator.py` → apply changes, archive, update effectiveness

**Reuses**: The exact same Python scripts from `sinain-hud-plugin/sinain-memory/`. No code duplication — just invoke them locally.

### Phase 3: Startup knowledge injection

On startup:
1. Read `~/.sinain/memory/sinain-playbook.md` and `sinain-knowledge.md`
2. Inject established patterns into the agent's system prompt context
3. Query `knowledge-graph.db` for facts relevant to the current app/context

This already partially works (agent recap tick reads `sinain-knowledge.md`), but the local path needs to be wired.

### Phase 4: Knowledge graph enrichment on escalation

When escalation happens, call `graph_query.py` against the local knowledge graph:
- Extract entities from current context (app name, error types, tech keywords)
- Inject matching facts as "## Past Experience" in escalation message

This already works when OpenClaw is connected. Wire it for local-only mode too.

## Key Design Decisions

1. **Same scripts, different runner**: The Python scripts (`session_distiller.py`, `knowledge_integrator.py`, etc.) run identically whether called by OpenClaw plugin or sinain-core. The only difference is who calls them and where `--memory-dir` points.

2. **`~/.sinain/memory/` as canonical local path**: Independent of OpenClaw workspace. If OpenClaw workspace exists, sync is the user's responsibility (or a future feature).

3. **LLM calls required**: Distillation and curation use LLM calls (configured in `memory-config.json`). These use the same `OPENROUTER_API_KEY` as the agent loop. Cost is minimal (~$0.01 per distillation).

4. **Graceful degradation**: If LLM calls fail (no credits, rate limited), skip distillation but still write raw session notes to the daily file.

## Files Summary

| File | Change |
|------|--------|
| `sinain-core/src/index.ts` | Add shutdown distillation hook, startup knowledge injection |
| `sinain-core/src/learning/local-curation.ts` | New: LocalCurationService (30-min timer + shutdown hook) |
| `sinain-core/src/config.ts` | Add `SINAIN_MEMORY_DIR` env var (default: `~/.sinain/memory`) |
| `sinain-hud-plugin/sinain-memory/*.py` | No changes — invoked locally as-is |
| `sinain-core/package.json` | No changes — uses `execFileSync` for Python calls |

## Verification

1. Start sinain-core without OpenClaw → run for 5 minutes → Ctrl+C → check `~/.sinain/memory/` for daily notes + playbook updates
2. Run 30+ minutes → verify periodic curation fires (check `playbook-archive/` for new snapshot)
3. Restart → verify playbook is loaded and facts appear in escalation context
4. Query knowledge graph: `python3 graph_query.py --db ~/.sinain/memory/knowledge-graph.db --entities '["german", "lesson"]'`
