# WSM Signal Inventory — what we can infer for a thread's "last work" summary

> Companion to `docs/DESIGN-WORK-STATE-MODEL.md`. Maps **every data field and
> metric the system already produces** and asks, per signal: *is it available
> per-thread, how fresh, and at what cost?* — so the resumption card (§9, P1) can
> show a real **summary of the user's last work in a thread**, not a thin
> evidence string.
>
> Scope: this is an inventory + a sourcing plan. Implementation is a follow-up.

## 0. The central constraint

The system is rich in signal but most of it is **global-latest** or
**per-topic**, not **per-thread**:

- **Global, single-latest** (overwritten every tick): the agent `hud`, the
  `digest`, `SITUATION.md`. These are the best ready-made *summaries of what the
  user is doing* — but they describe **now**, for **whatever thread is active**.
  They are not snapshotted per thread, so by the time you return to thread A,
  the digest already describes thread B.
- **Per-topic, decayed** (the KG): facts/entities/decisions about a *topic*,
  retrievable by topic id, time-decayed. Durable but coarse (a topic ≠ a live
  thread session) and only as fresh as the last distillation.
- **Per-thread, already held** (the WSM `ThreadState`): the belief vector,
  trajectory, breakpoints, timing, KG sub-focuses. Cheap and continuous, but
  *numbers and labels*, not prose.

**Implication:** a good "last work" summary must be **assembled** — and the one
thing missing is a per-thread **snapshot taken at switch-away** (the breakpoint
the engine already detects). That snapshot can capture the then-current
digest + top OCR + active regions + transcript tail, freezing "where you left
off" before the global state moves on. Everything else we already have.

---

## 1. Inventory by layer

Cost legend: **F** free/local · **L** LLM (already paid on the normal loop) ·
**K** local KG query. Per-thread legend: **PT** already per-thread · **G**
global-latest (needs capture) · **TOP** per-topic (KG) · **DER** derivable.

### A. Capture / screen — `sense_client → SenseBuffer` (ring: ~30–60 events, 5 images)

| Signal | Type | Source | Cost | Per-thread | Use for summary |
|---|---|---|---|---|---|
| `ocr` (full screen text) | string | `ocr.py`; `SenseEvent.ocr` | F | G (current surface) | The literal last screen — raw "where you left off" |
| `ocrLines[]` `{text,bbox}` | list | `ocr.py:212` | F | G | Line-level text for snippeting / anchoring |
| `meta.app` / `windowTitle` | string | `app_detector` | F | **PT** (in vector) | "coding in Zed · region-tracker.ts" |
| `meta.ssim` | float | `change_detector.py:43` | F | G | Change tempo (idle vs churning) |
| `meta.screen` / `frameSize` | int/[w,h] | capture | F | G | Display placement |
| motion `dx,dy,changedBoxes` | floats | `motion.py` (ephemeral, not stored) | F | — | Scroll/dwell kinematics (live only) |
| `semantic.context.activity` + `duration_s` | str/num | `sense-buffer.ts:20` | F | DER | Coarse activity + time-in-activity |
| `semantic.changes[]` (TextDelta, last 100) | list | `sense-buffer.ts:155` | F | G | **Recent edits** `{type,location,delta}` — what changed |
| `semantic.visible.has_error` / `has_unsaved` | bool | `sense-buffer.ts:34` | F | G | Error/unsaved state on screen |
| `imageData` (JPEG thumb, last 5) | b64 | sender | F | G | Visual snapshot (vision re-describe if needed) |
| event `type` (text/visual/context) | enum | `gate.py` | F | G | Was the leave a real edit vs app-switch |

### B. Audio / feed — `FeedBuffer` (ring 100, `onFull@20 → distill`)

| Signal | Type | Source | Cost | Per-thread | Use for summary |
|---|---|---|---|---|---|
| `FeedItem{text,source,audioSource,priority,ts}` | obj | `feed-buffer.ts` | F | G | Transcript / hud / system items, time-ordered |
| transcript `text` (per segment) | string | `transcription.ts` | L (paid) | G | What was said while on the thread |
| rolling context (per source, ≤12s, ~140c) | map | `transcription.ts:142` | F | G | Last utterance tail |
| VAD `energy`/`speechChunks`/`vadDensity` | num | `pipeline.ts` | F | DER | Was it a call/meeting (availability) |

### C. Agent analysis — `AgentLoop` (50-entry `AgentEntry` ring) — **the richest summaries**

| Signal | Type | Source | Cost | Per-thread | Use for summary |
|---|---|---|---|---|---|
| **`digest`** (5–8 sentences) | string | `analyzer.ts`; `getDigest()` | L (paid) | **G — single latest** | The ready-made "what the user is doing" narrative |
| `hud` (≤60 words) | string | `analyzer.ts` | L | G — single latest | One-line current state |
| `AgentEntry{id,ts,model,tokens,cost,latencyMs,parsedOk}` | obj | `loop.ts:389` | F | G (50 ring) | Recent ticks incl. recent digests |
| `AgentEntry.context{currentApp,appHistory,audio/screenCount}` | obj | `loop.ts:394` | F | G | Per-tick context snapshot |
| `knowledgeFacts` (injected) | string | `loop.ts:302` | K | DER | KG facts already pulled for the tick |
| `SITUATION.md` sections | md | `situation-writer.ts` | L/F | G (rewritten/tick) | digest + app + OCR + audio + **detected errors** + recording |
| escalation `score.total` + `reasons[]` | num/list | `scorer.ts` | F | G | error:/question:/appChurn: tags at leave time |

### D. Region tracker — within-surface ROI layer (already nested under the active thread)

| Signal | Type | Source | Cost | Per-thread | Use for summary |
|---|---|---|---|---|---|
| `RegionHighlight{issue,tip,action}` | obj | `analyzer.ts` | L | PT (active) | The open issues on the surface = concrete "what's unfinished" |
| `anchorText` / `sourceOcr` | string | `region-tracker.ts` | F | PT | The exact line(s) the issue sits on |
| `TrackedRegion{firstSeenTs,lastSeenTick,localMisses}` | obj | `region-tracker.ts` | F | PT | Age/persistence of each issue |

### E. WSM engine — `ThreadState` (already per-thread, persisted to `workstate-threads.json`)

| Signal | Type | Source | Cost | Per-thread | Use for summary |
|---|---|---|---|---|---|
| `label` + `kgContext` (sub-focuses) | string | engine | F | **PT** | "Athium / WSM · overlay-processes" |
| `vector` (WorkStateVector, verdict-tagged) | obj | estimator | F | **PT** | activity, app, difficulty, focus, topicAffinity, stuckness |
| `vector.matchedTopics[]` | list | estimator | F | **PT** | Topic ids → KG handle for facts |
| `decision{action,assistValue,interruptCost,why[]}` | obj | policy | F | **PT** | The checkable `why` strings (e.g. "repeated error on screen") |
| `trajectory[]` (assistValue history) | num[] | engine | F | **PT** | Sparkline / "was it degrading" |
| `breakpoints[]`, `firstSeenTs`, `lastAttendedTs`, `attendCount`, `cadenceMs` | nums | engine | F | **PT** | left Xh ago · seen N× · return cadence · at-risk |
| `workstate-history.jsonl` (created/switched-away/resumed/session-end) | jsonl | engine | F | **PT** | Per-event log incl. the moment of leaving |
| `PriorTopic.sampleFacts` (2 facts/topic) | str[] | `prior_builder.py:235` | F | TOP | Example facts — *carried in the prior but not yet surfaced per match* |
| `PriorTopic.frictionPrior` / `recurrence` / `distinctDays` / `lastSeen` | nums | prior | F | TOP | Friction + return-cadence priors |

### F. Knowledge graph — per-topic facts (`triplestore` + `graph_query`)

| Signal | Type | Source | Cost | Per-thread | Use for summary |
|---|---|---|---|---|---|
| `session_distiller` `whatHappened` (2–3 sentences) | string | `session_distiller.py` | L (paid at distill) | TOP/session | **A session-level "what happened" narrative** — closest existing summary |
| `facts[]` `{value,attributedTo,subject}` | list | distiller | L | TOP | Concrete claims about the topic |
| `decisions[]` (≤10) | str[] | distiller | L | TOP | Decisions/agreements made |
| `patterns[]` / `preferences[]` | str[] | distiller | L | TOP | Reusable techniques / habits |
| `entities[]` `{name,type}` | list | distiller | L | TOP | People/tools/concepts in play |
| fact `{value,confidence,first_seen,last_reinforced,kind,domain,tag[]}` | obj | `rdf_store.py` | K | TOP | Time-decayed claim w/ recency + provenance |
| retrieval: `query_facts_hybrid` / `backrefs(topic, about/mentions)` | API | `graph_query.py` | K | TOP | **"What was the user last doing on topic X"** — recency-ranked, decayed, supersession-aware |

---

## 2. Per-thread availability — the crux

| Tier | What we have *now*, keyed by thread | Sufficient for a summary? |
|---|---|---|
| **Already per-thread (free)** | app · window · activity · KG sub-focuses · difficulty/error state · trajectory · left-Xh-ago · seen-N× · return-cadence · active region issues+tips+anchors | Yes for a **structured** summary ("left mid-edit in region-tracker.ts, with errors, 2h ago, 3 open issues") — but no prose / no *content* of the work |
| **Global-latest (needs capture at breakpoint)** | the `digest` / `hud` / `SITUATION.md` / top OCR lines / transcript tail / `semantic.changes` edits / escalation reasons — *as they were when you left the thread* | This is the **prose summary + the literal last screen**. The richest ingredient; just not yet frozen per thread. |
| **Per-topic (KG, on demand)** | `whatHappened` narrative · decisions · facts · entities · patterns | Durable context ("this thread is about X; last decisions were Y") — coarser, distillation-fresh |

**Conclusion — what we can infer:** combining the three tiers, a thread's "last
work" can be summarized as:

> **{activity} in {app · window} — {what changed / open issue} — {state: with
> errors / unsaved / N issues}. Left {Xh} ago (seen {N}×). {1–2 KG facts /
> decisions}.**
>
> e.g. *"Editing `engine.ts` in Zed — added the resume-marker latch; 1 open
> issue: 'dashed ring overflow'. Left with errors 2h ago, seen 14×. Last
> decision: route threads by topic centroid."*

Every token of that is sourced above. The **only** missing piece is freezing the
global-latest prose (digest/OCR/edits) at the switch-away breakpoint.

---

## 3. The gap + recommended capture

The engine already fires a breakpoint on switch-away (`observe()` → `breakpoints.push`,
`appendHistory("switched-away")`). Add a **per-thread last-work snapshot** taken
there, holding what's otherwise global-latest:

```
ThreadState.lastWork = {
  ts,                      // when captured (= switch-away)
  digest,                  // agentLoop.getDigest()?.digest  (already paid)
  hud,                     // one-liner
  ocrLines: string[],      // top N lines of the last surface (free)
  edits: TextDelta[],      // semantic.changes tail — what they were changing (free)
  transcriptTail: string,  // last utterance(s) if any (free)
  regions: {issue,tip}[],  // open ROI issues at leave (already per-thread)
  errorReasons: string[],  // escalation reasons / has_error (free)
}
```

Wiring: `index.ts` already has `agentLoop`, the buffers, and the region source;
pass a `getLastWorkSnapshot()` accessor into the engine (mirrors the existing
`setRegionSource`), called inside the switch-away branch. Optionally enrich on
**resume** (not on leave) with a cheap `graph_query` for 1–2 topic facts.

### Tiering (cheapest first)
- **P0 (free, no new LLM):** structured summary from `ThreadState` + the captured
  `ocrLines`/`edits`/`regions`/`errorReasons`. Ships the card with real content.
- **P1 (already-paid):** include the captured `digest`/`hud` prose verbatim.
- **P2 (one local KG query on resume):** 1–2 recency-ranked topic facts/decisions
  via `backrefs(topic, about|mentions)` → richer "FACTS YOU'LL NEED".
- **P3 (optional, one cheap LLM):** a single distill call over the snapshot to
  produce a crisp 1-sentence "where you left off" — only if the raw prose reads
  poorly. Honors the WSM's keep-it-cheap stance by being resume-time-only.

---

## 4. Proposed resumption-card composition

| Card slot | Source (tier) |
|---|---|
| Title | `ThreadState.label` (+ `kgContext`) — **PT** |
| WHERE YOU LEFT OFF (prose) | captured `digest`/`hud` (P1), else structured line from app+activity+edits (P0) |
| The open loop / question | top `region.issue`/`tip` or `semantic.changes` tail (P0) |
| State chips | difficulty→"left with errors", `has_unsaved`, "N open issues", left-Xh, seen-N× (P0) |
| FACTS YOU'LL NEED | `sampleFacts` (free) → `graph_query` facts/decisions (P2) |
| Trajectory sparkline | `ThreadState.trajectory` — **PT** (already wired) |

---

## 6. The Calibrated Resume Card (P5) — the product object

> Supersedes the "AI summary" framing of §4. The card is **not** a smart summary
> and **not** affect ("you seem distracted"). It is a *calibrated re-entry
> instrument*: Sinain **predicts the cost and shape of returning** to a thread,
> then shows the smallest reliable cue needed to resume — each claim backed by
> visible evidence. Design: `ai-powered-screen-context-overlay 3` §5.

**Build rule (binding):** show only claims backed by **visible evidence**. Use
predictions to choose **timing and shape**, never to impersonate certainty.
Wording softens to *"likely / looks like / verify"* when reliability is low.

### The five heads (ranked by reliability) → what the user sees

| Head | Reliability | User sees | Sourced from (this doc) |
|---|---|---|---|
| `reentry_cost` | **RELIABLE** | Low / Medium / High **tier** (bars), never a score | additive over §2 per-thread signals (below) |
| `next_likely_action` | **RELIABLE** | **top-k** chips (closed vocab), not one instruction | thread state: open regions / agent backlog / unresolved decision |
| `estimated_focus_time` | PARTIAL | a **band** (~15–25 min), never an exact minute | mapped from tier × thread size |
| `resume_brief` | PARTIAL | "You likely left off…" + evidence — a nudge, not authority | `ThreadState.lastWork` (§3) — digest/OCR/edits captured at breakpoint |
| `continuation_probability` | INTERNAL | **card loudness only** — never shown as % | needScore / topicAffinity / recurrence |

Closed action vocab: `continue_implementation · review_agent_output ·
make_decision · fix_blocker · respond · summarize_defer · archive_close ·
create_task`.

### Deterministic re-entry scoring (P0/P1 — interpretable, additive)

```
reentry_cost  =  + long_thread            (age / attendCount / trajectory len)
                 + interruptions_since≥3  (switchCount − switchCountAtLeave)
                 + unresolved_decision    (difficulty high · open regions · has_error)
                 + agent_backlog          (feed items source∈{agent,openclaw} since leave)
                 − frozen_lastwork_marker (ThreadState.lastWork present)
                 − strong_roi_engagement  (regions active on the surface)
               →  tier:  ≤0 Low · 1–2 Medium · ≥3 High
```

Band map: Low → *short continuation* (5–15) · Medium → *work block* (15–30, "~15–25 min") · High → *deep continuation* (30–60).
Loudness map: low prob → hedged "possible resume point" · low/med → quiet chip (tier+band) · med → compact card · high → full card (+ "what changed" when re-entry is High).

### `ResumeCard` schema (computed in the engine when `resumeThreadId` is armed)

```ts
interface ResumeCard {
  threadId, label;
  brief: string; reliability: "low"|"medium"|"good";   // resume_brief
  reentryTier: "low"|"medium"|"high"; drivers: string[]; reducers: string[];
  focusBand: { label: string; display: string };        // estimated_focus_time
  nextActions: { action: string; label: string }[];     // next_likely_action top-k
  changedWhileAway: string | null;                       // agent outputs / blocker
  loudness: "low"|"quiet"|"compact"|"full";              // continuation_probability
}
```

### Labels to collect (the calibration loop)

Behavioral (free, already observable): card shown/opened/dismissed · stayed vs
switched · used agent output · actual active duration band · returned-later.
One-tap explicit (rotate, ask **one**): *Saved me re-loading / Somewhat / No* ·
*Right thread? Yes/Close/No* · *Time estimate? About right/Too short/Too long*.
Append to `workstate-labels.jsonl` (extends the existing P2 channel).

### Build ladder
- **P0 (this build):** deterministic card — additive tier, band, top-k actions,
  brief from `lastWork`, evidence chips, one-tap feedback. Marker = quiet form →
  unfolds to full card. No ML.
- **P1:** tune the additive weights; add the loudness variants.
- **P2:** fit the LLTM/GLMM (`return_situation_difficulty = feature_weights +
  user_random_effect + item_residual`) on collected labels → calibrate tiers,
  bands, timing. Never exposed; improves accuracy + softening only.
- **P3:** personalized bands / when-to-show / which-evidence / chip-vs-card.

---

## 5. Notably absent (system-wide)

- No per-thread digest/hud/SITUATION history — **the one gap to close** (§3).
- Raw frames/OCR not retained beyond the ring; transcripts not indexed by thread.
- KG facts are per-*topic*, not per live-thread-session; distillation-fresh only.
- `PriorTopic.sampleFacts` exist but the estimator doesn't propagate them into
  `matchedTopic` (cheap win for the card).
- No ground-truth labels yet (the `workstate-labels.jsonl` loop is the bridge).
