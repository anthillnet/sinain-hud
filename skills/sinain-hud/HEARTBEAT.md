# HEARTBEAT.md

> **Execution contract — no exceptions, no short-circuiting:**
> 1. Setup → Phase 1 → Phase 2 → Phase 3 Steps 1–5 — **mandatory every tick**
> 2. Phase 3 Step 5 output — only if synthesizer says `skip: false`
> 3. HEARTBEAT_OK — only permitted after Step 4 log entry is written
>
> You may NOT reply HEARTBEAT_OK until Step 4 is complete. Step 4 is the gate.

All reflection scripts live in `sinain-koog/` and are invoked via:
```
uv run --with requests python3 sinain-koog/<script>.py [args...]
```
Each prints a single JSON line to stdout. Capture it and parse it.

---

## Setup: Shared data fetch

Run once at the start of each tick — both Phase 2 and Phase 3 consume this data.

1. `sessions_history({ sessionKey: "agent:main:sinain", limit: 50, includeTools: false })`
2. Determine **IDLE** status: no user activity in the last 30 minutes
3. Compose **SESSION_SUMMARY**: 2–3 sentences describing the current state (what the user is doing, key topics, errors seen). This string is passed to every script via `--session-summary`.

---

## Phase 1: Git Backup

```bash
bash sinain-koog/git_backup.sh
```

Commits and pushes any uncommitted workspace changes (playbook, archives, logs). Outputs the short commit hash or "nothing to commit".

---

## Phase 2: Signal Analysis (reactive)

```bash
uv run --with requests python3 sinain-koog/signal_analyzer.py \
  --memory-dir memory/ \
  --session-summary "$SESSION_SUMMARY" \
  [--idle]
```

Parse the JSON output → `SIGNAL_RESULT`.

**Act on `recommendedAction`:**

| `action` value | What you do |
|---|---|
| `sessions_spawn` | Spawn a subagent with the task described in `.task` |
| `telegram_tip` | Send the tip in `.task` to Telegram |
| `skip` | No action needed — continue to Phase 3 |

**Spawn outcome tracking:** After spawning, record `spawnId` (task label or timestamp) in Step 4 log. On the NEXT tick, check session history for the spawn result:
- Result found → evaluate: `"spawnOutcome": "useful|ignored|error"`
- No result yet → `"spawnOutcome": "pending"` (check again next tick, max 3 ticks then `"timeout"`)
- If the last 3 spawn outcomes are `ignored`, raise the spawn threshold — require stronger signals. Reset after a `useful` outcome.

**Daily action minimum:** Check `memory/playbook-logs/*.jsonl` for the last 24h. If no Phase 2 action was taken AND user was active, lower the threshold — execute the best available action even if uncertain. Target: at least one spawn or Telegram suggestion per active day.

**Rules:** Max 2 subagents. NEVER repeat a recent action. Prefer depth over breadth.

---

## Phase 3: Reflect & Curate (self-improving)

### Step 1: Memory Mining (idle ticks only)

Only run when `--idle` was set in Setup:

```bash
uv run --with requests python3 sinain-koog/memory_miner.py \
  --memory-dir memory/
```

Parse → `MINING_RESULT`. The script reads unread daily memory files, updates the mining index in the playbook, and returns findings.

On active ticks, set `MINING_RESULT = null`.

### Step 2: Feedback Analysis

```bash
uv run --with requests python3 sinain-koog/feedback_analyzer.py \
  --memory-dir memory/ \
  --session-summary "$SESSION_SUMMARY"
```

Parse → `FEEDBACK_RESULT`. Extract `curateDirective` for Step 3.

### Step 3: Playbook Curation

```bash
uv run --with requests python3 sinain-koog/playbook_curator.py \
  --memory-dir memory/ \
  --session-summary "$SESSION_SUMMARY" \
  --curate-directive "$FEEDBACK_RESULT.curateDirective" \
  [--mining-findings "$MINING_RESULT.findings"]
```

Only pass `--mining-findings` if `MINING_RESULT` is not null.

Parse → `CURATOR_RESULT`. The script archives the playbook, applies changes, and returns what was added/pruned/promoted.

### Step 4: MANDATORY GATE — Log assembly

**This step MUST execute before any HEARTBEAT_OK or output.**

YOU (the main agent) write ONE JSON line to `memory/playbook-logs/YYYY-MM-DD.jsonl` assembling all script outputs:

```json
{
  "ts": "ISO-8601",
  "idle": true|false,
  "sessionHistorySummary": "$SESSION_SUMMARY",
  "signals": SIGNAL_RESULT.signals,
  "actionsConsidered": [{ "action": "...", "chosen": true|false, "spawnId": "..." }],
  "spawnOutcome": "useful|ignored|pending|timeout|null",
  "feedbackScores": FEEDBACK_RESULT.feedbackScores,
  "effectivenessRate": FEEDBACK_RESULT.effectiveness.rate,
  "effectivenessAlert": (rate < 0.4),
  "curateDirective": FEEDBACK_RESULT.curateDirective,
  "minedSources": MINING_RESULT.minedSources or [],
  "miningFindings": MINING_RESULT.findings or null,
  "playbookChanges": CURATOR_RESULT.changes,
  "staleItemActions": CURATOR_RESULT.staleItemActions,
  "output": { "suggestion": "...", "insight": "..." } or null,
  "skipped": true|false,
  "skipReason": "..." or null
}
```

### Step 5: Insight Synthesis & Output

```bash
uv run --with requests python3 sinain-koog/insight_synthesizer.py \
  --memory-dir memory/ \
  --session-summary "$SESSION_SUMMARY" \
  [--curator-changes 'JSON of CURATOR_RESULT.changes'] \
  [--idle]
```

Parse → `SYNTH_RESULT`.

**If `skip: false`:**
- Send to Telegram: `Suggestion: {suggestion}\n\nInsight: {insight}`
- Update Step 4 log entry's `output` field (or append a correction line)

**If `skip: true`:**
- Record `skipReason` in Step 4 log
- Reply **HEARTBEAT_OK**
