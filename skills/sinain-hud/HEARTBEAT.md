# HEARTBEAT.md

> **Execution contract — no exceptions, no short-circuiting:**
> 1. Phase 1 (Git Backup) → Phase 2 (Observe & Act) → Phase 3 Steps 1-4 — **mandatory every tick**
> 2. Phase 3 Step 5 (Output) — only if quality bar is met
> 3. HEARTBEAT_OK — only permitted after Step 4 log entry is written with `"skipped": true`
>
> You may NOT reply HEARTBEAT_OK until Step 4 is complete. Step 4 is the gate.

## Phase 1: Git Backup (persists playbook & logs)

If there are uncommitted changes in the workspace:
1. `git add -A` — captures `memory/sinain-playbook.md`, `memory/playbook-archive/*`, and `memory/playbook-logs/*`
2. `git commit -m "auto: heartbeat backup"` (or meaningful message if context is clear, e.g. "playbook: added 2 patterns, pruned 1")
3. `git push origin main`

This ensures the playbook, all archived versions, and decision logs survive redeployments.

## Phase 2: Observe & Act (reactive)

Quick scan of current user state. Respond to what's happening NOW.

**1. Observe** — Use the Pass 1 session history already fetched in Phase 3 Step 1 (the `limit: 50, includeTools: false` call covers Phase 2's needs). Examine the 10 most recent entries for Phase 2 signals. If Phase 3 Step 1 hasn't run yet this tick, move the Pass 1 `sessions_history` call to the START of the tick as a shared data fetch. Only trigger Pass 2 (with tool details) if Phase 2 finds a signal worth acting on.
- What app, what content, what errors, what audio
- Is the user stuck? (same error repeated, searching the same thing)

**2. Act** — pick ONE action if valuable:

| Signal | Action |
|--------|--------|
| Error or issue in context | `sessions_spawn`: "Find root cause for: [error]" |
| New tech/topic being explored | `sessions_spawn`: "Research [topic]: key findings, best practices, pitfalls" |
| Clear next action to suggest | Send quick suggestion to Telegram |

**3. Skip** if no sinain activity in >30 min (user idle). Phase 3 always runs regardless.

**Rules:** Max 2 subagents. NEVER repeat a recent action. Prefer depth over breadth.

**Spawn outcome tracking:** After spawning a subagent, record `spawnId` (task label or timestamp) in the Step 4 log. On the NEXT tick, check for the spawn result:
1. Search session history for spawn-task completion messages matching the `spawnId`
2. If result found: evaluate — was the output actionable? Did it surface in a later Telegram tip? Record `"spawnOutcome": "useful|ignored|error"` in this tick's Step 4 log.
3. If no result yet: record `"spawnOutcome": "pending"` — check again next tick, up to 3 ticks max then mark `"timeout"`.
4. If the last 3 spawn outcomes are `ignored`, raise the spawn threshold — require stronger signals before the next spawn. Reset after a `useful` outcome.

**Daily action minimum:** Check `memory/playbook-logs/*.jsonl` for the last 24h. If no Phase 2 action was taken (no entry with `actionsConsidered` containing `"chosen": true`) AND user was active at any point during that period, lower the threshold — execute the best available action even if uncertain. Document the uncertainty in the log. Target: at least one subagent spawn or direct Telegram suggestion per active day.

## Phase 3: Reflect & Curate (self-improving)

Close the feedback loop by maintaining an evolving playbook.

### Step 1: Gather context (2-pass progressive disclosure)

**Always collect (every tick) — Pass 1 (lightweight scan):**
1. `sessions_history({sessionKey: "agent:main:sinain", limit: 50, includeTools: false})` — message summaries only, NO tool details
2. Read `memory/sinain-playbook.md` — current patterns
3. Read recent `memory/playbook-logs/*.jsonl` — prior decisions, what was suggested/skipped

**Scan Pass 1 results for relevance signals:**
- Error messages, re-escalations, feedback summaries
- Spawn-task requests and completions
- New topics, app changes, audio mentions
- Any `[sinain-core:feedback-summary]` or `[sinain-core:spawn-task]` tags

**Pass 2 (targeted drill-down) — only if Pass 1 found signals:**
- `sessions_history({sessionKey: "agent:main:sinain", limit: 10, includeTools: true})` — full tool details for the most recent active window
- Only run this pass if Pass 1 found errors, spawn results, feedback, or topics worth investigating
- On idle ticks with no signals, skip Pass 2 entirely — the savings are 3-5x in token usage

**If active (fresh session data available):**
Scan the full window — topics, tools, errors, resolutions, app patterns, audio themes, feedback summaries.

**If idle (>30 min no activity) — deep mining is MANDATORY, not optional:**

You MUST read at least 2 daily memory files (`memory/YYYY-MM-DD.md`) per idle tick. Maintain a mining index at the TOP of `memory/sinain-playbook.md` as a comment block:
```
<!-- mining-index: 2026-02-17,2026-02-16,2026-02-15,2026-02-14,2026-02-11 -->
```
This is a comma-separated list of dates already mined in the last 7 days. When selecting files to mine, pick dates NOT in this list. After mining, update the index (remove dates older than 7 days, append newly mined dates). This avoids scanning JSONL logs for `minedSources`.

After reading, you MUST do all of the following:
1. Cross-reference playbook entries against what you read — do patterns hold up? Are there observations in daily memory that should be playbook patterns but aren't?
2. Review `memory/devmatrix-summary.md` and other summary files for broader context
3. Look for multi-day trends: recurring errors, evolving interests, productivity rhythms
4. Re-evaluate existing playbook — do any entries contradict each other? Should any be pruned or promoted?

**"No new data" is NOT a valid skip reason when daily memory files exist unread.** The session history being stale does not mean there is nothing to mine — daily memory files contain rich session notes, architectural decisions, user preferences, and research results that may reveal patterns not yet in the playbook.

### Step 2: Check feedback signals

Look for recent `[sinain-core:feedback-summary]` messages in history. Extract:
- Which escalation responses had high compositeScore (>0.3) — **successful patterns**
- Which had low compositeScore (<0) — **failed patterns**
- What tags/contexts correlate with success vs failure

### Step 2b: Compute playbook effectiveness score

Maintain a rolling effectiveness metric at the bottom of `memory/sinain-playbook.md`:
```
<!-- effectiveness: outputs=12, positive=8, negative=2, neutral=2, rate=0.67, updated=2026-02-17 -->
```

Update every tick using Step 4 log data from the last 7 days:
- `outputs`: ticks where Step 5 produced output (not skipped)
- `positive`: ticks where the NEXT tick's feedback showed avg compositeScore > 0.2
- `negative`: ticks where the NEXT tick's feedback showed avg compositeScore < -0.1
- `neutral`: remainder
- `rate`: positive / outputs (the "hit rate")

**Effectiveness-driven rules:**
- If `rate < 0.4` over 7 days: bias Step 3 toward **pruning** weak patterns. Log `"effectivenessAlert": true`.
- If `rate > 0.7` over 7 days: bias toward **stability** — only add patterns with strong evidence (score > 0.5).
- If `outputs < 5` in 7 days: insufficient data — skip effectiveness-driven adjustments.

### Step 3: Archive & Update playbook — `memory/sinain-playbook.md`

**3a. Archive current version** before making changes:
```
cp memory/sinain-playbook.md memory/playbook-archive/sinain-playbook-$(date +%Y-%m-%d-%H%M).md
```
Keep all archived versions — they form a dataset for evaluating playbook evolution.

**3b. Update** using the **Generate-Reflect-Curate** cycle:

**Curate rules:**
- **Add** new successful patterns: "When [context], responding with [approach] worked (score: X)"
- **Add** new failed patterns: "When [context], [approach] failed because [reason]"
- **Add** user preference observations: recurring topics, preferred tools, work rhythms
- **Prune** entries older than 7 days without reinforcement (no new evidence)
- **Promote** patterns seen 3+ times from "observed" to "established"
- Keep the playbook under 50 lines — density over completeness
- Follow the Three Laws: (1) don't remove patterns that prevent errors, (2) preserve high-scoring approaches, (3) then evolve

### Step 4: Log the decision process — `memory/playbook-logs/YYYY-MM-DD.jsonl`

**This step is the mandatory gate — it must execute before any HEARTBEAT_OK or output.**

Append ONE JSON line per heartbeat tick documenting the full decision chain:
```json
{
  "ts": "ISO-8601",
  "idle": true,
  "minedSources": ["memory/2026-02-14.md", "memory/2026-02-11.md"],
  "miningFindings": "brief summary of what was discovered from deep mining",
  "sessionHistorySummary": "brief summary of what was observed",
  "feedbackScores": { "avg": 0.45, "high": ["coding+error->fix worked"], "low": ["restart suggestion->error persisted"] },
  "spawnOutcome": null,
  "actionsConsidered": [
    { "action": "spawn research on topic", "reason": "user browsing docs", "chosen": true, "spawnId": "research-topic-1708..." },
    { "action": "send tip", "reason": "user in IDE", "chosen": false, "skipReason": "too generic" }
  ],
  "effectivenessRate": 0.67,
  "effectivenessAlert": false,
  "playbookChanges": {
    "added": ["When TypeScript null error, suggest optional chaining (score: 0.8)"],
    "pruned": ["Old pattern about restart suggestions"],
    "promoted": []
  },
  "output": {
    "suggestion": "the suggestion text",
    "insight": "the insight text"
  },
  "skipped": false,
  "skipReason": null
}
```

### Step 5: Synthesize & Output

Using BOTH the deep context (Step 1) AND the updated playbook (Step 3b), produce ONE Telegram message:

> **Suggestion:** [1-2 sentences] A practical, actionable recommendation. Draw from established playbook patterns + current observations. Could be: workflow improvement, recurring problem to automate, successful pattern to replicate, error pattern to address at root.
>
> **Insight:** [1-2 sentences] A surprising, non-obvious connection from accumulated data. Cross-domain patterns, unexpected correlations, things the user hasn't noticed. Cite specific observations. Connect dots between different sessions, topics, or timeframes.

### Phase 3 Rules
- **Steps 1-4 always execute** — every tick, even when user is idle. During idle ticks, deep mining of daily memory files is mandatory (see Step 1 idle section).
- Step 5 output is conditional on quality — if you cannot produce BOTH a genuinely useful suggestion AND a genuinely surprising insight, log `"skipped": true` with a `skipReason` in Step 4, then reply HEARTBEAT_OK.
- **Idle tick skip reasons must be specific**: "no new data" is invalid. Valid: "mined 2026-02-11.md and 2026-02-06.md — OCR backpressure pattern already in playbook, no new cross-references found." Prove you actually read the files.
- **Stale action items**: When adding a failed or fixable pattern to the playbook, tag it `[since: YYYY-MM-DD]`. If 48h pass and the underlying behavior hasn't changed (check recent feedback scores or session data), the item becomes a **mandatory Phase 2 action** on the next tick — send a Telegram message with exact fix steps, or spawn a subagent to investigate/implement the fix. Do not keep documenting the same regression without acting on it.
- **Stale item ceiling**: After a stale item has triggered 3 mandatory Phase 2 actions without resolution, move it to `[deferred: YYYY-MM-DD, reason: "..."]` state. Deferred items are excluded from mandatory Phase 2 triggering and re-evaluated once per week (next check = deferral date + 7 days). They return to active `[since: ...]` state if new evidence appears (feedback score change, user mentions the topic, or the blocking condition resolves). Maximum 5 deferred items in the playbook — if adding a 6th, prune the oldest deferred item entirely.
- The suggestion MUST reference a playbook pattern or concrete observation, not generic advice
- The insight MUST connect 2+ distinct observations that aren't obviously related
- NEVER repeat a suggestion or insight from recent heartbeats (check `memory/playbook-logs/`)
- Keep total message under 500 characters
