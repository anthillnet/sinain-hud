# Sinain Memory, Reflection & Module System — Technical Specification

> **Audience:** Engineers who need to understand how Sinain accumulates knowledge,
> reflects on its own effectiveness, and hot-swaps domain expertise across sessions.
>
> **Last updated:** 2026-02-28

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Layer 1: OpenClaw Built-in Memory](#2-layer-1-openclaw-built-in-memory)
3. [Layer 2: sinain-hud Plugin (Sync Engine)](#3-layer-2-sinain-hud-plugin-sync-engine)
4. [Layer 3: Koog Reflection Pipeline](#4-layer-3-koog-reflection-pipeline)
5. [Layer 4: Knowledge Modules](#5-layer-4-knowledge-modules)
6. [HEARTBEAT.md Execution Loop](#6-heartbeatmd-execution-loop)
7. [File Map](#7-file-map)
8. [Data Lifecycle](#8-data-lifecycle)

---

## 1. System Overview

Sinain's memory system is a four-layer architecture that transforms raw user
observations into curated, self-improving behavioral patterns. At the base,
**OpenClaw's built-in memory** provides session persistence, daily logs, and
context management. Above it, the **sinain-hud plugin** acts as a sync engine,
deploying files to the workspace and tracking sessions. The **koog reflection
pipeline** runs LLM-powered scripts every heartbeat tick to analyze signals,
mine memories, curate the playbook, and synthesize insights. At the top,
**knowledge modules** provide hot-swappable domain expertise that merges into
the effective playbook at each agent start.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Layer 4: KNOWLEDGE MODULES                       │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐ │
│  │ base-behaviors│  │ react-native-dev │  │ (future modules...)   │ │
│  │  priority: 0  │  │   priority: 80   │  │                       │ │
│  │   [locked]    │  │  [suspendable]   │  │                       │ │
│  └──────┬───────┘  └────────┬─────────┘  └───────────┬───────────┘ │
│         └──────────────┬────┘                         │             │
│                        ▼                              │             │
│            sinain-playbook-effective.md  ◄─────────────┘             │
├─────────────────────────────────────────────────────────────────────┤
│                 Layer 3: KOOG REFLECTION PIPELINE                   │
│                                                                     │
│  signal_analyzer → feedback_analyzer → memory_miner → playbook_    │
│       .py              .py               .py        curator.py     │
│                                                         │          │
│                                              insight_synthesizer   │
│                                                     .py            │
│                                                     │              │
│                                                 Telegram           │
├─────────────────────────────────────────────────────────────────────┤
│                 Layer 2: sinain-hud PLUGIN (Sync Engine)            │
│                                                                     │
│  before_agent_start ─── sync HEARTBEAT, SKILL, koog/, modules/     │
│  tool_result_persist ── strip <private> tags                        │
│  agent_end ──────────── write session-summaries.jsonl               │
├─────────────────────────────────────────────────────────────────────┤
│                 Layer 1: OPENCLAW BUILT-IN MEMORY                   │
│                                                                     │
│  memory.md (curated)  │  memory/YYYY-MM-DD.md (daily)              │
│  session-memory hook  │  context pruning + compaction               │
│  boot-md hook         │  command-logger audit trail                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Layer 1: OpenClaw Built-in Memory

OpenClaw provides the foundational memory infrastructure that Sinain builds on.
These are platform-level features configured in `openclaw.json` on the server.

### 2.1 memory.md — Curated Long-Term Memory

The file `memory.md` in the workspace root is OpenClaw's primary memory store.
It is **loaded into the agent's context at session start**, providing persistent
knowledge across conversations. The agent reads and writes to this file directly.

- **Loaded at:** Every session start (injected into system context)
- **Written by:** The agent itself, based on what it learns
- **Scope:** Cross-session, curated knowledge

### 2.2 Daily Memory Logs

OpenClaw's `session-memory` hook creates structured daily files:

| File Pattern | Created By | Purpose |
|---|---|---|
| `memory/YYYY-MM-DD.md` | session-memory hook on `/new` | Daily session log |
| `memory/YYYY-MM-DD-slug.md` | session-memory hook | Named session snapshots |

These daily files capture what happened in each session: decisions made, errors
encountered, research performed. They serve as the **raw input** for the koog
reflection pipeline's memory miner (Phase 3, Step 1).

### 2.3 Pre-Compaction Memory Flush

Before OpenClaw compacts the conversation context, a **silent agent turn** writes
key information to the daily memory file. This prevents knowledge loss during
compaction — the agent captures anything important from the conversation before
older messages are trimmed.

### 2.4 Context Pruning

OpenClaw's `cache-ttl` mode trims old tool results from the conversation context.
This keeps the context window focused on recent, relevant information while the
daily memory files preserve the full history.

### 2.5 Compaction

When the context grows too large, OpenClaw's `safeguard` compaction mode kicks in:

| Setting | Value | Effect |
|---|---|---|
| Mode | `safeguard` | Compacts when context exceeds threshold |
| `maxHistoryShare` | `0.3` | Keeps 30% of context for history, 70% for working space |

Compaction summarizes older conversation turns, preserving their essence while
freeing context for new work.

### 2.6 boot-md Hook

The `boot-md` hook runs `BOOT.md` when the OpenClaw gateway starts. This
provides initial instructions and configuration that persist across all sessions.

### 2.7 command-logger Hook

The `command-logger` hook maintains an audit trail in `commands.log`, recording
all commands executed during sessions. This provides accountability and debugging
capability.

### 2.8 Message Lifecycle

```
 ┌──────────────┐
 │  User sends   │
 │   message     │
 └──────┬───────┘
        ▼
 ┌──────────────┐     ┌──────────────────────┐
 │ Agent context │────▶│  memory.md loaded     │
 │  (session)    │     │  at session start     │
 └──────┬───────┘     └──────────────────────┘
        │
        ▼
 ┌──────────────┐     ┌──────────────────────┐
 │ Agent works   │────▶│  Tool results cached  │
 │ (tool calls)  │     │  in context           │
 └──────┬───────┘     └──────────────────────┘
        │
        ├─── context growing ───┐
        │                       ▼
        │              ┌────────────────┐
        │              │ cache-ttl prune │
        │              │ old tool results│
        │              └────────┬───────┘
        │                       │
        │              ┌────────▼───────┐
        │              │ safeguard mode  │
        │              │ compact at 30%  │
        │              └────────┬───────┘
        │                       │
        │  ┌────────────────────▼──────────┐
        │  │ pre-compaction flush:          │
        │  │ write to memory/YYYY-MM-DD.md │
        │  └───────────────────────────────┘
        │
        ▼
 ┌──────────────┐     ┌──────────────────────┐
 │  /new session │────▶│ session-memory hook   │
 │  or agent end │     │ creates daily log +   │
 │               │     │ session snapshot       │
 └──────────────┘     └──────────────────────┘
```

---

## 3. Layer 2: sinain-hud Plugin (Sync Engine)

**Source:** `sinain-hud-plugin/index.ts` (615 lines)
**Manifest:** `sinain-hud-plugin/openclaw.plugin.json`

The plugin is the orchestration layer between the local development repo and the
server workspace. It syncs files, tracks sessions, strips private data, and
generates the effective playbook.

### 3.1 Plugin Config Schema

Configured in `openclaw.json` under `plugins.entries.sinain-hud`:

```json
{
  "heartbeatPath": "sinain-sources/HEARTBEAT.md",
  "skillPath":     "sinain-sources/SKILL.md",
  "koogPath":      "sinain-sources/sinain-koog",
  "modulesPath":   "sinain-sources/modules",
  "sessionKey":    "agent:main:sinain"
}
```

| Field | Type | Description |
|---|---|---|
| `heartbeatPath` | `string` | Path to HEARTBEAT.md source (resolved relative to state dir) |
| `skillPath` | `string` | Path to SKILL.md source |
| `koogPath` | `string` | Path to sinain-koog/ scripts directory |
| `modulesPath` | `string` | Path to modules/ directory for knowledge modules |
| `sessionKey` | `string` | Session key for the sinain agent |

### 3.2 `before_agent_start` Hook — Sync Order

Every time the agent starts, the plugin syncs files in this order:

```
before_agent_start
        │
        ├─ 1. HEARTBEAT.md ──────────────▶ workspace/HEARTBEAT.md
        │      (syncFileToWorkspace)         always overwrite
        │
        ├─ 2. SKILL.md ──────────────────▶ workspace/SKILL.md
        │      (syncFileToWorkspace)         always overwrite
        │
        ├─ 3. sinain-koog/ ──────────────▶ workspace/sinain-koog/
        │      (syncDirToWorkspace)          selective policy
        │      + chmod 755 git_backup.sh
        │
        ├─ 4. modules/ ──────────────────▶ workspace/modules/
        │      (syncModulesToWorkspace)      selective policy
        │
        ├─ 5. generateEffectivePlaybook ─▶ workspace/memory/
        │      merge active modules +        sinain-playbook-effective.md
        │      base playbook
        │
        └─ 6. Ensure directories exist:
               memory/
               memory/playbook-archive/
               memory/playbook-logs/
```

### 3.3 Deploy Policies

The plugin uses two deploy strategies to prevent overwriting agent-modified files:

| Policy | Extensions / Files | Behavior |
|---|---|---|
| **always-overwrite** | `.json`, `.sh`, `.txt` | Plugin controls these — overwrite on every sync |
| **deploy-once** | `.py`, `.md` (non-manifest) | Skip if already exists in workspace |

**Module-specific policies:**

| File | Policy | Rationale |
|---|---|---|
| `manifest.json` | always-overwrite | Plugin controls module schema |
| `module-registry.json` | deploy-once | Agent manages via `module_manager.py` |
| `patterns.md` | deploy-once | Agent/extract may have modified patterns |
| Unknown files | deploy-once | Safe default |

This is implemented in `syncDirToWorkspace` (line 109) and
`syncModulesToWorkspace` (line 153):

```typescript
// sinain-hud-plugin/index.ts — syncDirToWorkspace
const ALWAYS_OVERWRITE = new Set([".json", ".sh", ".txt"]);

// Deploy-once files: skip if already present in workspace
if (!ALWAYS_OVERWRITE.has(ext) && existsSync(targetPath)) {
  continue;
}
```

```typescript
// sinain-hud-plugin/index.ts — syncModulesToWorkspace
const ALWAYS_OVERWRITE = new Set(["manifest.json"]);
const DEPLOY_ONCE = new Set(["module-registry.json", "patterns.md"]);

// Deploy-once: skip if already in workspace
if (isDeployOnce && existsSync(dstPath)) continue;
// Default for unknown files: deploy-once
if (!isAlwaysOverwrite && !isDeployOnce && existsSync(dstPath)) continue;
```

### 3.4 Effective Playbook Generation

`generateEffectivePlaybook` (line 213) merges active module patterns with the
base playbook:

1. Read `modules/module-registry.json`
2. Collect active modules, sort by **priority descending** (highest first)
3. Write `<!-- module-stack: id(prio), id(prio) -->` header
4. Concatenate each active module's `patterns.md` (wrapped in HTML comments)
5. Append the base `memory/sinain-playbook.md`
6. Write result to `memory/sinain-playbook-effective.md`

```
sinain-playbook-effective.md
├── <!-- module-stack: react-native-dev(80), base-behaviors(0) -->
├── <!-- module: react-native-dev (priority 80) -->
│   └── (react-native-dev/patterns.md content)
├── <!-- module: base-behaviors (priority 0) -->
│   └── (base-behaviors/patterns.md content)
└── <!-- base-playbook -->
    └── (memory/sinain-playbook.md content)
```

### 3.5 Session State Tracking

The plugin maintains an in-memory `Map<string, SessionState>` keyed by session
ID:

```typescript
type SessionState = {
  startedAt: number;
  toolUsage: ToolUsageEntry[];
  workspaceDir?: string;
};
```

- **`session_start`** — initializes tracking for the session
- **`tool_result_persist`** — appends tool usage entry on every tool call
- **`agent_end`** — writes summary to `session-summaries.jsonl`, then deletes state
- **`session_end`** / **`gateway_start`** — cleanup

### 3.6 `tool_result_persist` Hook — Privacy Stripping

Before any tool result is persisted to session history, the hook strips
`<private>...</private>` blocks:

```typescript
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/g;

function stripPrivateTags(text: string): string {
  return text.replace(PRIVATE_TAG_RE, "").trim();
}
```

This operates on both string content and structured content blocks (arrays with
`{ type: "text", text: "..." }` entries).

### 3.7 `agent_end` Hook — Session Summaries

On agent end, a JSON line is appended to `memory/session-summaries.jsonl`:

```json
{
  "ts": "2026-02-18T12:00:00.000Z",
  "sessionKey": "agent:main:sinain",
  "agentId": "...",
  "durationMs": 45000,
  "success": true,
  "error": null,
  "toolCallCount": 12,
  "toolBreakdown": { "sessions_history": 3, "sessions_spawn": 1, "Write": 5 },
  "messageCount": 8
}
```

---

## 4. Layer 3: Koog Reflection Pipeline

The koog reflection pipeline is a set of Python scripts that run during each
heartbeat tick to analyze signals, mine memories, curate the playbook, and
synthesize insights. All scripts live in `sinain-koog/` and are invoked via:

```bash
uv run --with requests python3 sinain-koog/<script>.py [args...]
```

Each script prints a single JSON line to stdout for the main agent to parse.

### 4.1 Pipeline Architecture

```
                      ┌─────────────────────┐
  Phase 1             │   git_backup.sh     │  commit + push workspace
                      └─────────┬───────────┘
                                │
  Phase 2             ┌─────────▼───────────┐
                      │  signal_analyzer.py  │  detect actionable signals
                      │                      │  → spawn / tip / skip
                      └─────────┬───────────┘
                                │
  Phase 3             ┌─────────▼───────────┐
  Step 1 (idle only)  │  memory_miner.py    │  deep-mine daily files
                      │                      │  → newPatterns, findings
                      └─────────┬───────────┘
                                │
  Step 2              ┌─────────▼───────────┐
                      │ feedback_analyzer.py │  score effectiveness
                      │                      │  → curateDirective
                      └─────────┬───────────┘
                                │
  Step 3              ┌─────────▼───────────┐
                      │ playbook_curator.py  │  archive + curate
                      │                      │  → add/prune/promote
                      └─────────┬───────────┘
                                │
  Step 4              ┌─────────▼───────────┐
                      │   MANDATORY GATE    │  agent writes JSON log
                      │   (main agent)       │  to playbook-logs/
                      └─────────┬───────────┘
                                │
  Step 5              ┌─────────▼───────────┐
                      │insight_synthesizer.py│  quality-gated output
                      │                      │  → Telegram or skip
                      └─────────────────────┘
```

### 4.2 common.py — Shared Utilities (374 lines)

The backbone module providing LLM calls, memory readers, and JSON handling.

**LLM Routing:**

```python
# common.py — model constants (overridden by koog-config.json)
MODEL_FAST  = "openai/gpt-oss-120b"
MODEL_SMART = "anthropic/claude-sonnet-4.6"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
```

`call_llm()` routes through OpenRouter. When a `script` name is provided, model
and parameters are loaded from `koog-config.json`:

```python
def call_llm(system_prompt, user_prompt, model=MODEL_FAST,
             max_tokens=1500, *, script=None, json_mode=False):
    if script:
        cfg = _load_config()
        script_cfg = cfg.get("scripts", {}).get(script, cfg.get("defaults", {}))
        model = _resolve_model(script_cfg.get("model", "fast"))
        max_tokens = script_cfg.get("maxTokens", max_tokens)
```

**Robust JSON Extraction (`extract_json`):**

A 3+1 stage extraction pipeline for messy LLM output:

1. Direct `json.loads` (clean case)
2. Regex extraction from markdown code fences
3. Balanced-brace scanner for JSON embedded in prose
4. Truncated JSON repair (close unclosed brackets/strings)

**Memory File Readers:**

| Function | Reads | Returns |
|---|---|---|
| `read_playbook()` | `memory/sinain-playbook.md` | Base playbook text |
| `read_effective_playbook()` | `memory/sinain-playbook-effective.md` (falls back to base) | Merged playbook |
| `parse_module_stack()` | `<!-- module-stack: ... -->` comment | `[{id, priority}]` |
| `read_recent_logs()` | `memory/playbook-logs/*.jsonl` (last N days) | `[dict]` newest first |
| `read_today_log()` | Today's playbook log file | `[dict]` |
| `list_daily_memory_files()` | `memory/YYYY-MM-DD.md` files | `[path]` newest first |
| `parse_mining_index()` | `<!-- mining-index: ... -->` comment | `[date_str]` |
| `parse_effectiveness()` | `<!-- effectiveness: ... -->` comment | `{outputs, positive, ...}` |

### 4.3 signal_analyzer.py — Phase 2 (121 lines)

**Purpose:** Scan recent session activity and detect actionable signals.

**Inputs:**
- `--memory-dir memory/` — reads effective playbook + last 3 log entries
- `--session-summary "..."` — current session state from main agent
- `--idle` (optional) — suppresses Phase 2 actions

**LLM Prompt → JSON Output:**

```json
{
  "signals": ["signal1 description", ...],
  "recommendedAction": {
    "action": "sessions_spawn|telegram_tip|skip",
    "task": "description if not skip",
    "confidence": 0.7
  },
  "idle": false
}
```

**Signal → Action mapping:**

| Signal | Recommended Action |
|---|---|
| Repeated error in context | `sessions_spawn`: "Find root cause for: [error]" |
| New tech/topic explored | `sessions_spawn`: "Research [topic]" |
| Clear next action | `telegram_tip`: concise suggestion |
| User stuck in loop | `sessions_spawn`: "Debug [issue]" |
| No meaningful signal | `skip` |

**Config:** Model `fast` (gpt-oss-120b), 1500 max tokens.

### 4.4 feedback_analyzer.py — Phase 3 Step 2 (184 lines)

**Purpose:** Score feedback from recent ticks and compute effectiveness metrics.

**Two-part analysis:**

1. **Mechanical computation** (Python, no LLM):

```python
def compute_effectiveness(logs):
    # output_ticks = ticks where Step 5 produced output
    # positive = next tick's avg compositeScore > 0.2
    # negative = next tick's avg compositeScore < -0.1
    # rate = positive / outputs
```

2. **LLM interpretation** (patterns in feedback scores):

```json
{
  "feedbackScores": {"avg": 0.45, "high": [...], "low": [...]},
  "effectiveness": {"outputs": 8, "positive": 4, "negative": 2, "neutral": 2, "rate": 0.5},
  "curateDirective": "normal",
  "interpretation": "Error-related patterns score well, generic tips score poorly"
}
```

**Curate Directive thresholds:**

| Directive | Condition | Effect on Curator |
|---|---|---|
| `aggressive_prune` | rate < 0.4 | Remove weak/unverified patterns aggressively |
| `normal` | 0.4 ≤ rate ≤ 0.7 | Balanced add/prune cycle |
| `stability` | rate > 0.7 | Only add patterns with score > 0.5 |
| `insufficient_data` | < 5 outputs in 7 days | Skip effectiveness adjustments |

**Config:** Model `fast`, 800 max tokens.

### 4.5 memory_miner.py — Phase 3 Step 1 (172 lines)

**Purpose:** Deep-mine unmined daily memory files (idle ticks only).

**Process:**
1. Read `<!-- mining-index: ... -->` from playbook to find already-mined dates
2. Find unmined `memory/YYYY-MM-DD.md` files
3. Pick up to **2 unmined files** + read `devmatrix-summary.md` for context
4. Send to LLM for cross-referencing with current playbook
5. On successful parse, update mining index (prune dates older than 7 days)
6. On LLM failure, **skip index update** so files are retried next tick

**Output:**

```json
{
  "findings": "2-3 sentence summary",
  "newPatterns": ["pattern description", ...],
  "contradictions": ["playbook entry X contradicts observation Y", ...],
  "preferences": ["user preference observed", ...],
  "minedSources": ["2026-02-17.md", "2026-02-16.md"]
}
```

**Mining Index** is stored as an HTML comment in the playbook:
```
<!-- mining-index: 2026-02-17,2026-02-16,2026-02-15 -->
```

**Config:** Model `fast`, 1000 max tokens.

### 4.6 playbook_curator.py — Phase 3 Step 3 (212 lines)

**Purpose:** Archive current playbook, then curate (add/prune/promote patterns).

**Process:**
1. **Archive** — copy `sinain-playbook.md` to `playbook-archive/sinain-playbook-YYYY-MM-DD-HHMM.md`
2. **Split** — extract header comments (`<!-- mining-index -->`) and footer
   comments (`<!-- effectiveness -->`) from body
3. **Curate via LLM** — send body + last 10 log entries + curate directive + mining findings
4. **Reassemble** — header + curated body + footer, enforce 50-line body limit
5. **Write** — overwrite `sinain-playbook.md`

**The Three Laws of Curation:**
1. Don't remove error-prevention patterns
2. Preserve high-scoring approaches
3. Then evolve

**Stale Item Lifecycle:**
- New fixable pattern → `[since: YYYY-MM-DD]` tag
- 48h without change → mandatory Phase 2 action
- After 3 actions without resolution → `[deferred: YYYY-MM-DD, reason: "..."]`
- Max 5 deferred items; oldest pruned when adding 6th

**Output:**

```json
{
  "changes": {
    "added": ["new pattern text", ...],
    "pruned": ["removed pattern text", ...],
    "promoted": ["pattern upgraded to established", ...]
  },
  "staleItemActions": ["description of stale item handling", ...],
  "playbookLines": 42
}
```

**Config:** Model `fast`, 3000 max tokens, 90s timeout (largest prompt).

### 4.7 insight_synthesizer.py — Phase 3 Step 5 (151 lines)

**Purpose:** Produce a quality-gated Telegram message with a suggestion + insight.

**Quality Gate — must skip if:**
- Cannot produce BOTH a useful suggestion AND a surprising insight
- Suggestion would repeat a recent heartbeat output
- Insight is obvious or doesn't connect distinct observations

**Output (send):**

```json
{
  "skip": false,
  "suggestion": "practical, actionable recommendation",
  "insight": "surprising, non-obvious connection",
  "totalChars": 287
}
```

**Output (skip):**

```json
{
  "skip": true,
  "skipReason": "specific reason citing files/patterns examined"
}
```

**Character limit:** Total message must be under 500 characters. If exceeded, the
insight is truncated. If truncation leaves < 50 chars for insight, the output is
skipped entirely.

**Config:** Model `smart` (claude-sonnet-4.6), 800 max tokens — the only script
using the expensive model, since output quality directly faces the user.

### 4.8 koog-config.json — Model Routing

```json
{
  "models": {
    "fast": "openai/gpt-oss-120b",
    "smart": "anthropic/claude-sonnet-4.6"
  },
  "scripts": {
    "signal_analyzer":     { "model": "fast",  "maxTokens": 1500 },
    "feedback_analyzer":   { "model": "fast",  "maxTokens": 800 },
    "memory_miner":        { "model": "fast",  "maxTokens": 1000 },
    "playbook_curator":    { "model": "fast",  "maxTokens": 3000, "timeout": 90 },
    "insight_synthesizer": { "model": "smart", "maxTokens": 800 },
    "module_manager":      { "model": "fast",  "maxTokens": 2000 }
  },
  "defaults": { "model": "fast", "maxTokens": 1500 }
}
```

This config is **always-overwrite** (`.json` extension), so the plugin controls
model routing and the agent cannot modify it.

### 4.9 git_backup.sh — Phase 1 (20 lines)

```bash
#!/usr/bin/env bash
set -euo pipefail

changes=$(git status --porcelain 2>/dev/null || true)
if [ -z "$changes" ]; then
    echo "nothing to commit"
    exit 0
fi

git add -A
git commit -m "auto: heartbeat $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push origin main
git rev-parse --short HEAD
```

Commits and pushes any uncommitted workspace changes (playbook, archives, logs).
Made executable by the plugin during `before_agent_start` sync.

### 4.10 Data Flow Diagram

```
                        ┌────────────────────┐
                        │  OpenClaw Session   │
                        │   History (API)     │
                        └────────┬───────────┘
                                 │ sessions_history()
                                 ▼
┌───────────────┐       ┌────────────────────┐
│ memory/       │       │  SESSION_SUMMARY    │ composed by main agent
│  YYYY-MM-DD.md│       │  (2-3 sentences)    │
│  (daily files)│       └────────┬───────────┘
└───────┬───────┘                │
        │                        ├──────────────────────┐
        │ read by                │                      │
        ▼                        ▼                      ▼
┌───────────────┐  ┌─────────────────────┐  ┌───────────────────┐
│ memory_miner  │  │  signal_analyzer    │  │ feedback_analyzer │
│   .py         │  │     .py             │  │     .py           │
│               │  │                     │  │                   │
│ reads:        │  │ reads:              │  │ reads:            │
│  daily files  │  │  effective playbook │  │  playbook-logs/   │
│  playbook     │  │  playbook-logs/     │  │  base playbook    │
│               │  │                     │  │                   │
│ writes:       │  │ outputs:            │  │ outputs:          │
│  mining-index │  │  signals[]          │  │  feedbackScores   │
│  (in playbook)│  │  recommendedAction  │  │  effectiveness    │
└───────┬───────┘  └──────────┬──────────┘  │  curateDirective  │
        │                     │             └─────────┬─────────┘
        │ findings            │ action                │ directive
        │                     │                       │
        ▼                     ▼                       ▼
   ┌────────────────────────────────────────────────────────┐
   │              playbook_curator.py                        │
   │                                                         │
   │ reads:  sinain-playbook.md, playbook-logs/              │
   │ writes: sinain-playbook.md (curated)                    │
   │         playbook-archive/sinain-playbook-YYYY-MM-DD.md  │
   └──────────────────────┬─────────────────────────────────┘
                          │ changes
                          ▼
   ┌─────────────────────────────────────────────────────────┐
   │                   MANDATORY GATE                         │
   │            (main agent writes log entry)                 │
   │                                                          │
   │  writes: playbook-logs/YYYY-MM-DD.jsonl                  │
   └──────────────────────┬──────────────────────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────────────────────┐
   │             insight_synthesizer.py                        │
   │                                                          │
   │ reads:  effective playbook (post-curation)               │
   │         playbook-logs/ (last 3 days)                     │
   │                                                          │
   │ outputs: suggestion + insight → Telegram                 │
   │      or: skip + skipReason                               │
   └─────────────────────────────────────────────────────────┘
```

---

## 5. Layer 4: Knowledge Modules

Knowledge modules are hot-swappable domain expertise packages that enrich the
agent's effective playbook. They allow Sinain to load specialized knowledge
on-demand without polluting the base playbook.

### 5.1 Module Directory Structure

```
modules/
├── module-registry.json           ← central registry (deploy-once)
├── base-behaviors/
│   ├── manifest.json              ← module metadata (always-overwrite)
│   └── patterns.md                ← behavioral patterns (deploy-once)
└── react-native-dev/
    ├── manifest.json
    └── patterns.md
```

### 5.2 Module Registry

`module-registry.json` tracks module state:

```json
{
  "version": 1,
  "modules": {
    "base-behaviors": {
      "status": "active",
      "priority": 0,
      "activatedAt": "2026-02-27T00:00:00Z",
      "lastTriggered": null,
      "locked": true
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `active\|suspended\|disabled` | Module state |
| `priority` | `number` | Merge order (higher = first in effective playbook) |
| `activatedAt` | `ISO-8601\|null` | When activated |
| `lastTriggered` | `ISO-8601\|null` | Last heartbeat that used this module |
| `locked` | `boolean` | Locked modules cannot be suspended or disabled |

### 5.3 Module Manifest

Each module has a `manifest.json` defining its metadata:

```json
{
  "id": "react-native-dev",
  "name": "React Native Development",
  "description": "Patterns for React Native mobile development",
  "version": "1.0.0",
  "priority": {
    "default": 80,
    "range": [50, 100]
  },
  "triggers": {
    "keywords": ["react-native", "metro", "expo"],
    "filePatterns": ["*.tsx", "*.kt", "*.swift"]
  },
  "locked": false
}
```

Priority ranges prevent modules from being set to unreasonable values.
`base-behaviors` has range `[0, 0]` — it's always at the bottom of the stack.

### 5.4 Module Lifecycle

```
                extract
    ┌─────────────────────────────┐
    │  LLM reads playbook + logs  │
    │  extracts domain patterns   │
    └─────────────┬───────────────┘
                  │
                  ▼
           ┌──────────┐
           │ suspended │  ◄── newly extracted modules start here
           └─────┬────┘
                 │ activate (explicit command)
                 ▼
           ┌──────────┐
           │  active   │  ◄── patterns merged into effective playbook
           └─────┬────┘
                 │ suspend (explicit command)
                 ▼
           ┌──────────┐
           │ suspended │  ◄── patterns excluded from effective playbook
           └──────────┘
```

**Locked modules** (e.g., `base-behaviors`) cannot be suspended or disabled.
They are always active and provide core behavioral patterns.

### 5.5 module_manager.py CLI (438 lines)

**Management subcommands** (no LLM required):

| Command | Description |
|---|---|
| `list` | List all registered + unregistered modules |
| `activate <id> [--priority N]` | Activate a module, optionally set priority |
| `suspend <id>` | Suspend a module (errors on locked modules) |
| `priority <id> <N>` | Change priority (validated against manifest range) |
| `stack` | Show active module stack sorted by priority |
| `info <id>` | Show manifest + registry entry + pattern line count |

**Extraction subcommand** (uses LLM):

```bash
uv run --with requests python3 sinain-koog/module_manager.py \
  --modules-dir modules/ extract new-domain \
  --domain "domain description" --memory-dir memory/
```

The extract command:
1. Reads base playbook + last 7 days of logs
2. Sends to LLM with extraction prompt
3. Creates `modules/<id>/manifest.json` and `modules/<id>/patterns.md`
4. Registers module as **suspended** (must be explicitly activated)
5. Outputs activation instructions

**Extracted patterns are categorized:**
- **Established** — patterns with strong evidence (multiple occurrences, high scores)
- **Emerging** — patterns seen once or twice, plausible but unconfirmed
- **Vocabulary** — domain-specific terms with definitions

### 5.6 Effective Playbook Merge

The plugin's `generateEffectivePlaybook` produces the merged document at each
agent start:

```
┌─────────────────────────────────────────────────────────────┐
│           sinain-playbook-effective.md                       │
│                                                              │
│  <!-- module-stack: react-native-dev(80), base-behaviors(0)│
│  -->                                                         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ <!-- module: react-native-dev (priority 80) -->        │ │
│  │                                                        │ │
│  │ # React Native Development                             │ │
│  │ ## Build & Metro                                       │ │
│  │ - Metro bundler cache invalidation...                  │ │
│  │ ## Native Bridges                                      │ │
│  │ - WearablesBridge pattern...                           │ │
│  │ ...                                                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ <!-- module: base-behaviors (priority 0) -->           │ │
│  │                                                        │ │
│  │ # Base Behaviors                                       │ │
│  │ ## Communication Style                                 │ │
│  │ - Keep Telegram messages under 500 characters          │ │
│  │ ## Error Prevention                                    │ │
│  │ - Always check for existing file...                    │ │
│  │ ...                                                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ <!-- base-playbook -->                                 │ │
│  │                                                        │ │
│  │ (evolving patterns from playbook_curator.py)           │ │
│  │ <!-- mining-index: 2026-02-17,2026-02-16 -->           │ │
│  │ ...                                                    │ │
│  │ <!-- effectiveness: outputs=8,positive=4,rate=0.5 -->  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Key property:** The curator ONLY modifies `sinain-playbook.md` (the base).
Module patterns in `modules/<id>/patterns.md` are managed separately via
`module_manager.py extract` or direct editing.

---

## 6. HEARTBEAT.md Execution Loop

**Source:** `skills/sinain-hud/HEARTBEAT.md` (186 lines)
**Cadence:** Every 30 minutes (`openclaw-config-patch.json`)

The heartbeat is the clock that drives the entire reflection system. It executes
as a mandatory, unbreakable sequence with a gate that prevents premature
completion.

### 6.1 Execution Contract

> 1. Setup → Phase 1 → Phase 2 → Phase 3 Steps 1–5 — **mandatory every tick**
> 2. Phase 3 Step 5 output — only if synthesizer says `skip: false`
> 3. HEARTBEAT_OK — only permitted after Step 4 log entry is written

### 6.2 Full Tick Flowchart

```
                    ┌──────────────────────┐
                    │    HEARTBEAT TICK     │
                    │   (every 30 min)      │
                    └──────────┬───────────┘
                               │
               ════════════════╪════════════════
                          SETUP PHASE
               ════════════════╪════════════════
                               │
                    ┌──────────▼───────────┐
                    │ 1. sessions_history   │
                    │   (limit: 50)         │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │ 2. Determine IDLE     │
                    │   (>30 min inactive?) │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │ 3. Compose            │
                    │   SESSION_SUMMARY     │
                    │   (2-3 sentences)     │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │ 4. Read module stack  │
                    │   from effective      │
                    │   playbook header     │
                    └──────────┬───────────┘
                               │
               ════════════════╪════════════════
                      PHASE 1: GIT BACKUP
               ════════════════╪════════════════
                               │
                    ┌──────────▼───────────┐
                    │ bash git_backup.sh   │
                    │ → commit hash or     │
                    │   "nothing to commit" │
                    └──────────┬───────────┘
                               │
               ════════════════╪════════════════
                   PHASE 2: SIGNAL ANALYSIS
               ════════════════╪════════════════
                               │
                    ┌──────────▼───────────┐
                    │ signal_analyzer.py    │
                    │  --session-summary    │
                    │  [--idle]             │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │ recommendedAction?    │
                    ├──────────────────────┤
                    │ sessions_spawn → run  │
                    │ telegram_tip → send   │
                    │ skip → continue       │
                    └──────────┬───────────┘
                               │
               ════════════════╪════════════════
                  PHASE 3: REFLECT & CURATE
               ════════════════╪════════════════
                               │
              ┌────────────────▼────────────────┐
              │         Is IDLE?                 │
              ├────────┐              ┌─────────┤
              │  YES   │              │   NO    │
              ▼        │              │         ▼
   ┌──────────────┐    │              │  MINING_RESULT
   │ Step 1:      │    │              │     = null
   │ memory_miner │    │              │
   │   .py        │    │              │
   └──────┬───────┘    │              │
          │            │              │
          ▼            │              │
     MINING_RESULT     │              │
              ├────────┘              │
              │◄──────────────────────┘
              ▼
   ┌──────────────────┐
   │ Step 2:          │
   │ feedback_analyzer│
   │   .py            │
   │ → curateDirective│
   └──────────┬───────┘
              │
              ▼
   ┌──────────────────┐
   │ Step 3:          │
   │ playbook_curator │
   │   .py            │
   │ → changes        │
   └──────────┬───────┘
              │
              ▼
   ┌──────────────────────────────────────────┐
   │ Step 4: MANDATORY GATE                    │
   │                                           │
   │ Write JSON log to                         │
   │ memory/playbook-logs/YYYY-MM-DD.jsonl     │
   │                                           │
   │ Contains: signals, actions, feedback,     │
   │ effectiveness, mining findings, playbook  │
   │ changes, output (if any)                  │
   │                                           │
   │ *** HEARTBEAT_OK blocked until done ***   │
   └──────────────────┬───────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────┐
   │ Step 5: insight_synthesizer.py            │
   │                                           │
   │  skip: false → send to Telegram           │
   │  skip: true  → record reason, reply       │
   │               HEARTBEAT_OK                │
   └──────────────────────────────────────────┘
```

### 6.3 Spawn Outcome Tracking

Phase 2 spawns are tracked across multiple ticks:

| Tick | Action |
|---|---|
| Tick N | Spawn subagent, record `spawnId` in log |
| Tick N+1 | Check session history for spawn result |
| Result found | Evaluate: `useful` / `ignored` / `error` |
| No result after 3 ticks | `timeout` |
| 3 consecutive `ignored` | Raise spawn threshold |
| 1 `useful` | Reset threshold |

### 6.4 Daily Action Minimum

If no Phase 2 action was taken in 24h AND user was active:
- Lower the threshold
- Execute the best available action even if uncertain
- Target: at least one spawn or Telegram suggestion per active day

### 6.5 Server Configuration

From `openclaw-config-patch.json`:

```json
{
  "agents.defaults.sandbox": {
    "sessionToolsVisibility": "all"
  },
  "agents.defaults.heartbeat": {
    "every": "30m",
    "prompt": "Execute HEARTBEAT.md — all phases, all steps, in order. Phase 3 Steps 1-4 are mandatory every tick. Complete Step 4 logging before responding. Do not infer or repeat old tasks from prior chats.",
    "ackMaxChars": 0
  }
}
```

- `sessionToolsVisibility: "all"` — enables `sessions_history` cross-session access
- `every: "30m"` — heartbeat cadence
- `ackMaxChars: 0` — suppresses acknowledgment messages (clean output)

---

## 7. File Map

### 7.1 Source Files (Local Repo)

| Path | Lines | Description |
|---|---|---|
| `sinain-hud-plugin/index.ts` | 615 | Plugin implementation |
| `sinain-hud-plugin/openclaw.plugin.json` | 55 | Plugin manifest + config schema |
| `sinain-koog/common.py` | 373 | Shared utilities (LLM, readers, JSON) |
| `sinain-koog/signal_analyzer.py` | 120 | Phase 2: signal detection |
| `sinain-koog/feedback_analyzer.py` | 183 | Phase 3.2: effectiveness metrics |
| `sinain-koog/memory_miner.py` | 171 | Phase 3.1: idle deep mining |
| `sinain-koog/playbook_curator.py` | 211 | Phase 3.3: archive + curate |
| `sinain-koog/insight_synthesizer.py` | 150 | Phase 3.5: quality-gated output |
| `sinain-koog/module_manager.py` | 437 | Module CLI (management + extraction) |
| `sinain-koog/koog-config.json` | 15 | Model routing config |
| `sinain-koog/git_backup.sh` | 19 | Phase 1: workspace backup |
| `modules/module-registry.json` | 12 | Module registry |
| `modules/base-behaviors/manifest.json` | 10 | Core behaviors manifest |
| `modules/base-behaviors/patterns.md` | 30 | Core behavioral patterns |
| `modules/react-native-dev/manifest.json` | 14 | RN dev manifest |
| `modules/react-native-dev/patterns.md` | 36 | RN dev patterns |

### 7.2 Skills Files

| Path | Description |
|---|---|
| `skills/sinain-hud/HEARTBEAT.md` | Execution loop protocol |
| `skills/sinain-hud/SKILL.md` | Agent skill definition (escalations, spawns, feedback) |
| `skills/sinain-hud/openclaw-config-patch.json` | Server config patch |

### 7.3 Server Source Files

Deployed to `/mnt/openclaw-state/sinain-sources/` on the Strato VPS:

| Server Path | Source |
|---|---|
| `sinain-sources/HEARTBEAT.md` | `skills/sinain-hud/HEARTBEAT.md` |
| `sinain-sources/SKILL.md` | `skills/sinain-hud/SKILL.md` |
| `sinain-sources/sinain-koog/` | `sinain-koog/` (all scripts) |
| `sinain-sources/modules/` | `modules/` (all modules) |

### 7.4 Workspace Files (Runtime)

Created/synced at `/home/node/.openclaw/workspace/` inside the container:

| Workspace Path | Sync Policy | Owner |
|---|---|---|
| `HEARTBEAT.md` | always-overwrite | Plugin |
| `SKILL.md` | always-overwrite | Plugin |
| `sinain-koog/*.json` | always-overwrite | Plugin |
| `sinain-koog/*.sh` | always-overwrite | Plugin |
| `sinain-koog/*.py` | deploy-once | Agent (after first deploy) |
| `modules/*/manifest.json` | always-overwrite | Plugin |
| `modules/module-registry.json` | deploy-once | Agent |
| `modules/*/patterns.md` | deploy-once | Agent |

### 7.5 Generated Files (Runtime)

| Path | Created By | Updated By |
|---|---|---|
| `memory/sinain-playbook.md` | playbook_curator.py | playbook_curator.py (each tick) |
| `memory/sinain-playbook-effective.md` | Plugin (generateEffectivePlaybook) | Plugin (each agent start) |
| `memory/playbook-logs/YYYY-MM-DD.jsonl` | Main agent (Step 4 gate) | Appended each tick |
| `memory/playbook-archive/sinain-playbook-*.md` | playbook_curator.py | Created each tick |
| `memory/session-summaries.jsonl` | Plugin (agent_end hook) | Appended each session |
| `memory/YYYY-MM-DD.md` | OpenClaw session-memory hook | Appended during sessions |
| `memory/devmatrix-summary.md` | External (sinain-core) | Updated periodically |

---

## 8. Data Lifecycle

How a user observation becomes a playbook pattern, then a module extraction,
and finally a Telegram insight.

### 8.1 End-to-End Trace

```
 1. USER ACTION
 ┌──────────────────────────────────────────────────────────────┐
 │ User writes code in IntelliJ → sinain-core captures screen   │
 │ OCR detects TypeError → sinain-core escalates to OpenClaw     │
 └──────────────────────────────────┬───────────────────────────┘
                                    │
 2. SESSION TRANSCRIPT              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ OpenClaw agent receives escalation with digest/OCR/audio      │
 │ Agent responds (goes to HUD overlay)                          │
 │ sinain-core records compositeScore feedback                   │
 │ Session transcript accumulates in OpenClaw history             │
 └──────────────────────────────────┬───────────────────────────┘
                                    │
 3. DAILY MEMORY                    ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ session-memory hook writes to memory/YYYY-MM-DD.md            │
 │ Pre-compaction flush captures key decisions                   │
 │ Session snapshot saved to memory/YYYY-MM-DD-slug.md           │
 └──────────────────────────────────┬───────────────────────────┘
                                    │
 4. HEARTBEAT MINING                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ Next idle tick: memory_miner.py reads unmined daily files     │
 │ LLM cross-references with current playbook                    │
 │ Returns: newPatterns, contradictions, preferences             │
 │ Updates mining-index in playbook                              │
 └──────────────────────────────────┬───────────────────────────┘
                                    │
 5. PLAYBOOK PATTERN                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ playbook_curator.py receives mining findings + feedback       │
 │ Adds new pattern: "When TypeError on nullable object,        │
 │   suggest optional chaining (score: 0.7)"                    │
 │ Archives old playbook, writes curated version                 │
 │ Pattern appears in sinain-playbook.md                         │
 └──────────────────────────────────┬───────────────────────────┘
                                    │
 6. MODULE EXTRACTION (on-demand)   ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ After enough patterns accumulate for a domain:                │
 │ module_manager.py extract typescript-dev --domain "..."       │
 │ LLM extracts established/emerging patterns + vocabulary       │
 │ Creates modules/typescript-dev/{manifest.json, patterns.md}  │
 │ Registered as suspended → explicit activation required        │
 └──────────────────────────────────┬───────────────────────────┘
                                    │
 7. EFFECTIVE PLAYBOOK              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ On next agent start: plugin runs generateEffectivePlaybook    │
 │ Active module patterns merged (priority-sorted)               │
 │ Base playbook appended                                        │
 │ Written to memory/sinain-playbook-effective.md                │
 │ All koog scripts read the effective playbook                  │
 └──────────────────────────────────┬───────────────────────────┘
                                    │
 8. INSIGHT OUTPUT                  ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ insight_synthesizer.py reads post-curation effective playbook │
 │ Generates suggestion + insight grounded in patterns           │
 │ Quality gate: skip if generic or repetitive                   │
 │ Telegram message: "The TypeError pattern in your TypeScript   │
 │   code correlates with late-night commits — consider adding   │
 │   strict null checks as a pre-commit hook."                   │
 └──────────────────────────────────────────────────────────────┘
```

### 8.2 Feedback Loop Closure

The lifecycle is circular. After the insight is delivered:

1. **User acts** on the suggestion (or ignores it)
2. **sinain-core** tracks the outcome (errorCleared? re-escalation? dwell time?)
3. **Feedback signals** arrive as compositeScore in the next escalation
4. **feedback_analyzer.py** computes effectiveness rate
5. **playbook_curator.py** adjusts:
   - High score → promote pattern to "established"
   - Low score → prune or refine pattern
   - Very low effectiveness → `aggressive_prune` directive

This creates a **self-improving loop** where the system's behavioral patterns
evolve based on measurable outcomes, not just LLM judgments.

### 8.3 Time Scales

| Time Scale | Activity |
|---|---|
| **Real-time** | Escalation handling (sinain-core → agent → HUD) |
| **30 minutes** | Heartbeat tick (signal analysis, curation, output) |
| **Idle periods** | Memory mining (deep analysis of daily files) |
| **On-demand** | Module extraction (manual trigger) |
| **Daily** | Git backup, daily action minimum check |
| **Weekly** | Mining index pruning (7-day window), log retention |

---

*Generated from source code analysis of sinain-hud repository (commit 7a2d709).*
