Here is the consolidated design in one copy-ready version.

Sinain Work Resumption Model / Resume Card — Full Design

1. Core thesis

Sinain should learn from existing WSM, ROI, interruption, enrichment, thread-state, and agent-session signals to predict what a user is returning to, how costly it will be to resume, and what minimal support should be shown.

The first product artifact is the Resume Card:

When you return to a thread, Sinain tells you what you left, how big it is, and how to continue.

The system should not claim to understand the user’s psychology. It should model work resumption: return-to-thread situations, re-entry cost, likely next action, likely duration band, and appropriate support.

Internal thesis:

Treat work as a behavioral token stream. Use retrieval first, then sequence modeling to predict likely next work states, while a calibrated explanatory layer prices re-entry cost and controls what the Resume Card is allowed to claim.

External product thesis:

Your agents keep working. Sinain helps you keep your thread.

⸻

2. Product object: Resume Card

The Resume Card is a calibrated, evidence-backed re-entry cue.

It should answer:

1. What was I doing?
2. How hard is this to resume?
3. How much time might this take?
4. What should I probably do next?
5. What changed while I was away?
6. Why is Sinain showing this?

Example:

Resume: WSM attention cockpit
You likely left off:
Freezing the latest per-thread “lastwork” snapshot for the Resume Card.
Re-entry:
Medium · likely 15–30 min work block
Why:
Long thread · 3 interruptions since · ROI engaged twice · latest snapshot exists
Next likely actions:
1. Continue implementation
2. Review agent output
3. Decide P0/P1 boundary
Changed while away:
2 agent outputs arrived. No clear blocker detected.
Was this useful?
Saved me re-loading · Somewhat · Not useful

Compact HUD version:

WSM resume · medium re-entry · ~15–30 min
Left off: lastwork snapshot → Resume Card
Next: continue implementation or review agent output

Low-confidence version:

Possible resume point found
This may relate to WSM lastwork snapshot work.
Evidence is partial — verify before continuing.

The card is not an authoritative AI summary. It is a nudge-to-resume with checkable evidence and calibrated uncertainty.

⸻

3. What the model predicts

The system predicts five heads.

3.1 Resume brief

Field:

"resume_brief"

Purpose:

What was the user probably doing when they left?

User-facing style:

You likely left off around...
Looks like this thread was about...
Evidence suggests the last work state was...

Avoid:

You were definitely doing X.
The correct next step is Y.

Build rule:

Show only claims that can be backed by visible evidence.

Evidence examples:

* last selected ROI
* latest WSM snapshot
* ThreadState
* selected region
* OCR content
* file path
* error state
* recent agent output
* explicit TODO/action language

⸻

3.2 Re-entry cost

Field:

"reentry_cost"

Purpose:

How hard is this thread to resume?

User-facing values:

Low re-entry · quick continuation
Medium re-entry · brief recommended
High re-entry · summary + next-step recommended

Use tiers, not precise scores.

Internal drivers:

* thread length
* time since last touch
* interruption count
* app/window switches
* agent backlog
* unresolved decisions
* unresolved errors
* number of branches
* topic drift
* missing lastwork marker

Internal reducers:

* frozen lastwork marker exists
* strong ROI engagement
* recent user edit
* clear next action
* summarized agent output
* same app/project/file resumed
* repeated return pattern

⸻

3.3 Estimated focus time / work block

Field:

"estimated_focus_time"

Purpose:

How large is the likely return block?

Use bands, not point estimates.

Suggested bands:

2–5 min       Quick return
5–15 min      Short continuation
15–30 min     Work block
30–60 min     Deep continuation
60+ min       Large thread / planning block

User-facing examples:

Likely short continuation · 5–15 min
Likely work block · 15–30 min
Likely deep continuation · 30–60 min

Avoid:

Estimated: 18.7 minutes

Unless the model is strongly calibrated and the UX can justify that precision.

⸻

3.4 Continuation probability

Field:

"continuation_probability"

Purpose:

How likely is the user to continue this thread now?

Use this mostly internally for UI policy.

Do not show:

You are 74% likely to continue.

Use it to decide:

no-op
quiet chip
compact card
full card
what-changed card
one-tap feedback prompt

Example policy:

Low continuation probability → quiet chip or no-op
Medium continuation probability → compact card
High continuation probability → full Resume Card
High continuation + high re-entry → full card with “what changed”

⸻

3.5 Next likely action

Field:

"next_likely_actions"

Purpose:

What action is the user likely to need next?

Use a closed vocabulary.

Initial action vocabulary:

read
continue implementation
review agent output
fix blocker
make decision
respond
summarize
defer
archive / close
create task
ask agent

Show top-k, not one authoritative action.

Example:

Next likely actions:
1. Continue implementation
2. Review agent output
3. Decide P0/P1 boundary

Avoid open-ended “AI knows your intent” claims.

⸻

4. Signals already available

4.1 Thread-structure signals

These describe the complexity and state of the thread.

Examples:

thread length
thread age
time since last touch
number of branches
latest work snapshot
last unresolved state
thread title/topic
project
file path
app context
ROI identity

Used for:

resume brief
re-entry cost
duration band
next-action candidates

⸻

4.2 Attention / interruption signals

These describe fragmentation.

Examples:

interruption count
app/window switches
idle gaps
agent completions while away
time since ROI engagement
number of active agent sessions
return after break
return after context switch

Used for:

re-entry cost
continuation probability
card loudness
duration band

⸻

4.3 Engagement signals

These describe intent and usefulness.

Examples:

ROI engaged
ROI ignored
ROI dismissed
enrichment clicked
resume card opened
resume card dismissed
agent output copied/used
user edited after card
user returned again later

Used for:

continuation probability
personalization
label loop
card timing
next-action prediction

⸻

4.4 Content signals

These describe semantic task content.

Examples:

OCR text
selected region
file names
error messages
TODOs
agent messages
code symbols
document headings
lastwork summary
enrichment content

Used for:

brief content
semantic matching
next-action candidates
WorkState semantic IDs

⸻

5. System architecture

The full system has four layers.

WSM / ROI / interruption / enrichment / thread-state signals
        ↓
WorkState tokenizer
        ↓
WorkState retrieval / embedding / sequence model
        ↓
calibrated resumption scorer
        ↓
Resume Card UI policy

⸻

6. Layer 1: WorkState tokenizer

The WorkState tokenizer converts raw signals into stable behavioral tokens.

Example input:

{
  "project": "sinain-hud",
  "app": "Zed",
  "file": "WSM SIGNAL-INVENTORY.md",
  "roi": "resume-card",
  "gap_minutes": 42,
  "interruptions": 3,
  "thread_length": "long",
  "agent_backlog": 2,
  "state": "unresolved_decision",
  "roi_engagement": "repeated",
  "lastwork_exists": true
}

Example tokens:

PROJECT_SINAIN
APP_ZED
FILE_WSM_SIGNAL_INVENTORY
ROI_RESUME_CARD
GAP_15_60M
INTERRUPTIONS_3_5
THREAD_LEN_LONG
AGENT_BACKLOG_2
STATE_UNRESOLVED_DECISION
ROI_REPEATED
LASTWORK_EXISTS

Outcome tokens after observation:

CARD_SHOWN
CARD_OPENED
NEXT_ACTION_CONTINUE_IMPLEMENTATION
OUTCOME_CONTINUED_15_30M
FEEDBACK_SAVED_RELOADING

This token stream is the training material for future prediction.

⸻

7. Layer 2: WorkState2Vec / retrieval layer

In the MVP, WorkState2Vec should be a retrieval/ranking layer, not the source of calibrated truth.

Purpose:

Find similar past work states.
Rank likely active threads.
Retrieve similar return outcomes.
Generate candidate next actions.
Generate candidate duration bands.
Precompute likely Resume Cards.

Each return situation becomes a behavioral document.

Example:

project:sinain app:zed file:wsm-signal-inventory roi:resume-card
gap:15-60m interruptions:3-5 thread_len:long
state:unresolved_decision agent_backlog:2
engagement:roi_repeated lastwork:exists

Use hybrid retrieval:

sparse symbolic matching
+ content embedding
+ behavioral token embedding

Nearest-neighbor aggregation example:

Nearest 20 similar returns:
- 12 continued 15–30 min
- 5 continued 5–15 min
- 3 abandoned quickly
- 14 opened the resume card
- 11 next action = continue implementation

Candidate prediction:

Likely duration: 15–30 min
Likely next action: continue implementation / review agent output
Recommended support: compact resume card

Important rule:

Embedding proximity is not probability. Use retrieval for candidates, then use calibrated scoring for final claims.

⸻

8. Layer 3: Semantic WorkState IDs

Eventually, Sinain can learn discrete codes for work states.

These codes should be based on vector quantization, not arbitrary hashing.

Bad:

hash(embedding) → A91F

This is only useful for cache keys or deduplication.

Better:

embedding → nearest cluster / codebook entries → semantic ID

Recommended path:

P1: k-means / centroid ID

embedding → WS_CLUSTER_184

P2: hierarchical cluster IDs

WS_COARSE_18
WS_FINE_184

P3: product / residual quantization

embedding → [18, 241, 7, 93]

Token form:

WS_SID_18_241_7_93

P4: learned semantic IDs

Use RQ-VAE / semantic-ID training when enough data exists.

Purpose:

Fuse semantic content + behavioral signal into discrete tokens that a sequence model can predict.

Store codebook metadata:

{
  "semantic_id": ["18", "241", "7", "93"],
  "codebook_version": "workstate_sid_v1",
  "embedding_model": "local-embed-v3",
  "created_at": "2026-06-30"
}

Do not assume codes are stable across embedding model or codebook versions.

⸻

9. Layer 4: Generative WorkState model

Long term, the system should move from retrieval to behavioral-token sequence prediction.

Goal:

Given previous work-state tokens, predict the next work-state tokens.

Example input:

RETURN_TO_THREAD
PROJECT_SINAIN
APP_ZED
THREAD_LEN_LONG
GAP_15_60M
INTERRUPTIONS_3_5
ROI_REPEATED
STATE_UNRESOLVED_DECISION
AGENT_BACKLOG_2
LASTWORK_EXISTS

Predicted tokens:

SUPPORT_COMPACT_RESUME_CARD
NEXT_ACTION_CONTINUE_IMPLEMENTATION
DURATION_15_30M
OUTCOME_CARD_HELPFUL

This is the long-term moat:

Generative work-state prediction, calibrated into trustworthy resume cards.

But this should not be the MVP. Single-user workstream data is sparse. Start with deterministic signals and retrieval, then train sequence models once enough data exists.

⸻

10. Layer 5: Calibrated resumption scorer

The calibrated scorer turns candidates into trustworthy outputs.

It should answer:

How costly is this return?
How large is the likely work block?
Which action is likely next?
How confident are we?
What should the UI show?

Recommended components:

LLTM / GLMM → explainable re-entry difficulty
survival model → duration / time-to-event bands
conformal prediction → calibrated uncertainty sets
closed-vocab classifier → next likely action
calibration layer → Brier / reliability tracking

⸻

11. LLTM / GLMM role

The re-entry cost formula should be treated as an explanatory item difficulty model.

Original heuristic:

reentry_cost =
  thread_length
+ interruptions
+ agent_backlog
+ unresolved_branches
- good_lastwork_marker
- repeated_roi_engagement

Principled version:

return_situation_difficulty =
  feature_weights
+ user_random_effect
+ item_random_residual

Why this matters:

1. Cold start
    A new return situation can be scored from features.
2. Personalization
    The same situation can be harder for one user than another.
3. Explainability
    The model can say which signals drove the tier.
4. Partial pooling
    User estimates shrink toward the population prior until enough personal data exists.
5. Honest uncertainty
    If the model is uncertain, the UI can soften.

Important caveat:

The latent parameters are model parameters, not validated psychological traits. Do not call them psychometrics externally.

⸻

12. Survival / duration modeling

Duration should be modeled as time-to-event or duration-band prediction.

Why:

Sessions may be censored.
The user may leave for unrelated reasons.
The actual endpoint may be ambiguous.

Predict bands:

2–5 min
5–15 min
15–30 min
30–60 min
60+ min

Possible target events:

user reaches checkpoint
user switches away
user abandons thread
user stays active for N minutes
user returns again later

Use conformal prediction to produce honest calibrated sets.

Internal example:

{
  "prediction_set": ["15_30m", "30_60m"],
  "coverage_target": 0.85
}

User-facing simplification:

Likely 15–30 min work block.

⸻

13. UI policy

The UI policy decides what to show and how loudly.

Inputs:

continuation probability
re-entry cost
duration band
confidence tier
lastwork reliability
agent backlog
user preference
recent card dismissals

Possible surfaces:

no-op
quiet chip
compact resume card
full resume card
what-changed card
one-tap feedback prompt

Policy examples:

Low re-entry + low confidence:
No-op or quiet chip.
Medium re-entry + medium confidence:
Compact Resume Card.
High re-entry + good evidence:
Full Resume Card.
High agent backlog:
Add “what changed while away.”
Repeated dismissals:
Reduce loudness.
High continuation probability:
Precompute and surface earlier.
Low continuation probability:
Do not interrupt.

⸻

14. Confidence and uncertainty wording

Never show uncalibrated decimals.

Avoid:

Confidence: 0.74
You are likely to continue for 23 minutes.

Use:

Good evidence
Partial evidence
Possible resume point
Likely work block
Verify before acting

Confidence controls wording strength.

Examples:

High confidence

You likely left off freezing the lastwork snapshot for the Resume Card.
Evidence: same file, same ROI, latest snapshot, recent edit.

Medium confidence

Looks like this relates to the lastwork snapshot → Resume Card work.
Evidence: same project and ROI, but no recent edit found.

Low confidence

Possible resume point found.
This may relate to WSM lastwork work. Verify before continuing.

⸻

15. Feedback and labels

The system needs a closed feedback loop.

Behavioral labels

Log:

card shown
card opened
card dismissed
card ignored
user stayed in thread
user switched away
user used agent output
user edited related file
user reached next checkpoint
actual active duration
thread returned to later
agent output copied
enrichment clicked
ROI engaged

Explicit one-tap labels

Ask only one at a time.

Options:

Saved me re-loading
Somewhat
Not useful

or:

Was this the right thread?
Yes
Close
No

or:

Was the time estimate useful?
About right
Too short
Too long

Rotate these prompts. Do not overload the user.

Main validation labels:

card helpfulness
resume correctness
duration calibration
support timing
next-action correctness

⸻

16. Data schema

Recommended event record:

{
  "event_type": "thread_return",
  "thread_id": "wsm_resume_marker",
  "timestamp": "2026-06-30T11:20:00+02:00",
  "return_event": {
    "gap_minutes": 42,
    "surface_match": "same_project_same_doc",
    "return_confidence": "high"
  },
  "tokens_before": [
    "PROJECT_SINAIN",
    "APP_ZED",
    "THREAD_LEN_LONG",
    "GAP_15_60M",
    "INTERRUPTIONS_3_5",
    "ROI_REPEATED",
    "STATE_UNRESOLVED_DECISION",
    "AGENT_BACKLOG_2",
    "LASTWORK_EXISTS"
  ],
  "semantic_ids": {
    "workstate_sid": ["WS_C18", "WS_R241", "WS_R007", "WS_R093"],
    "codebook_version": "workstate_sid_v1"
  },
  "resume_brief": {
    "claim": "You likely left off deciding how to freeze the latest per-thread lastwork snapshot for the Resume Card.",
    "evidence": [
      "Selected region mentioned P0/P1 capture",
      "Latest ROI engagement was on resume-marker → resumption card",
      "ThreadState contains unresolved implementation decision"
    ],
    "reliability": "medium"
  },
  "calibrated_prediction": {
    "reentry_cost": "medium",
    "duration_band": "15_30m",
    "next_actions": [
      "continue_implementation",
      "review_agent_output",
      "decide_scope"
    ],
    "support_mode": "compact_resume_card",
    "confidence_tier": "medium"
  },
  "ui_policy": {
    "surface": "compact_resume_card",
    "loudness": "medium",
    "ask_feedback": true
  },
  "tokens_after": [
    "CARD_OPENED",
    "NEXT_ACTION_CONTINUE_IMPLEMENTATION",
    "OUTCOME_CONTINUED_15_30M",
    "FEEDBACK_SAVED_RELOADING"
  ]
}

⸻

17. Resume Card rendering schema

{
  "title": "WSM resume",
  "subtitle": "Medium re-entry · likely 15–30 min",
  "left_off": "Freezing the latest per-thread lastwork snapshot for the Resume Card.",
  "why": [
    "Long thread",
    "3 interruptions since",
    "ROI engaged twice",
    "Latest snapshot exists"
  ],
  "next_likely": [
    "Continue implementation",
    "Review agent output",
    "Decide P0/P1 boundary"
  ],
  "changed_while_away": [
    "2 agent outputs arrived",
    "No clear blocker detected"
  ],
  "confidence_copy": "Good evidence, but verify before acting.",
  "feedback_prompt": "Was this useful?",
  "feedback_options": [
    "Saved me re-loading",
    "Somewhat",
    "Not useful"
  ]
}

⸻

18. MVP implementation path

P0 — Deterministic Resume Card

No ML required.

Build:

return detection
lastwork snapshot retrieval
ThreadState summary
ROI engagement count
interruption count
agent backlog count
simple re-entry tier
broad duration band
evidence bullets
one-tap feedback

Output:

compact Resume Card

Goal:

Validate whether users value re-entry support.

Success metrics:

card open rate
card usefulness feedback
“saved me re-loading” rate
repeat usage
dismissal rate

⸻

P1 — WorkState token log

Start logging all return situations as token streams.

Build:

WorkState tokenizer
token vocabulary
return-event schema
outcome tokens
feedback tokens
storage/indexing

Goal:

Create training data for retrieval and sequence modeling.

Important:

Log the token stream now even if prediction remains heuristic.

⸻

P2 — Hybrid retrieval / WorkState2Vec

Build:

behavioral document per return
sparse token retrieval
content embedding
behavioral embedding
nearest-neighbor outcome aggregation

Use for:

candidate next actions
candidate duration bands
related thread ranking
resume card precomputation

Do not rely on proximity as probability.

⸻

P3 — Calibrated scorer

Build:

LLTM-style re-entry cost model
GLMM partial pooling
duration-band / survival model
post-hoc calibration
Brier score tracking
reliability diagrams

Use for:

re-entry tier
duration band
confidence wording
card loudness
support policy

⸻

P4 — Conformal duration bands

Build:

conformal prediction sets for duration bands
coverage tracking
uncertainty-aware UI policy

Use for:

honest time bands
safe confidence
avoid overclaiming

⸻

P5 — Generative WorkState model

Only after enough data.

Build:

sequence model over work-state tokens
predict next action
predict support mode
predict duration band
predict abandonment / continuation
predict card helpfulness

Goal:

Move from retrieval over similar past states to direct next-work-state prediction.

⸻

P6 — Learned semantic IDs

Build:

embedding quantization
residual/product quantization
semantic-ID codebooks
event/thread discrete codes
versioned codebook storage

Eventually:

RQ-VAE / semantic-ID training optimized for next-action prediction

⸻

19. Initial heuristic scoring

Example initial re-entry cost formula:

score = 0
+ 1 if thread is medium
+ 2 if thread is long
+ 1 if gap is 15–60 min
+ 2 if gap is 1d+
+ 1 if interruptions since touch = 1–2
+ 2 if interruptions since touch = 3+
+ 1 if agent backlog = 1
+ 2 if agent backlog >= 2
+ 2 if unresolved decision exists
+ 2 if blocker/error exists
+ 1 if topic drift detected
- 2 if frozen lastwork marker exists
- 1 if ROI was recently engaged
- 1 if same file/project resumed
- 1 if clear next action exists

Tier mapping:

0–2: Low re-entry
3–6: Medium re-entry
7+: High re-entry

Duration band heuristic:

reading/checking        → 2–15 min
copy/editing            → 5–20 min
implementation          → 15–45 min
debugging               → 20–60 min
strategy/planning       → 15–60 min
admin/responding        → 2–15 min
high re-entry modifier  → shift one band upward
low re-entry modifier   → shift one band downward

⸻

20. Validation plan

Validate three product claims.

Claim 1: Re-entry dread exists and Resume Cards help

Metrics:

card open rate
saved-me-reloading feedback
repeat use
time to first meaningful action after return

Question:

Did this save you re-loading?

⸻

Claim 2: Re-entry tier and duration band are useful

Metrics:

predicted band vs actual active return duration
Brier score
calibration curve
too short / about right / too long feedback

Question:

Was the time estimate useful?
About right · Too short · Too long

⸻

Claim 3: Card timing/loudness can be personalized

Metrics:

dismissal rate
ignored card rate
card-open-after-return rate
user disables/re-enables
card helpfulness by surface type

Question:

Was this the right moment?
Yes · Too early · Not needed

⸻

21. What is novel vs borrowed

Borrowed machinery

Item2Vec / Prod2Vec → tokens-as-items embedding
Airbnb embeddings → real-time personalization from action sequences
BERT4Rec / SASRec → sequence order matters
YouTube two-stage recommender → retrieve candidates, then rank/score
TIGER / semantic IDs → quantized discrete semantic codes
LLTM / IRT → item difficulty from feature weights
GLMM partial pooling → cold-start-safe personalization
survival modeling → duration / time-to-event bands
conformal prediction → calibrated uncertainty sets
Memory-for-Goals → cognitive basis for interruption and resumption cost

Novel application

The item is a return-to-thread situation.
The metric is re-entry cost.
The product is a calibrated Resume Card.
The domain is parallel human+agent knowledge work.
The moat is per-user closed-loop calibration of when and how to help.

Sharp novelty statement:

The novel object is not the embedding. The novel object is the priced resumption unit: a thread return with predicted re-entry cost, duration band, next-action candidates, and calibrated support timing.

⸻

22. User-facing positioning

Avoid:

AI psychometrics
attention diagnosis
fatigue detection
focus score
behavioral surveillance

Use:

Resume where you left off
Context restoration
Re-entry support
Thread resumption
Work-state memory
Attention recovery

One-liners:

When you return to a thread, Sinain tells you what you left, how big it is, and how to continue.
Your agents keep working. Sinain helps you keep your thread.
Context restoration for parallel agent work.
A resume layer for people working across too many agents.

⸻

23. Safety and trust rules

1. Do not claim ground truth.
2. Do not diagnose the user.
3. Do not expose uncalibrated scores.
4. Do not show “you seem distracted/fatigued.”
5. Use evidence-backed claims.
6. Use “likely,” “looks like,” and “possible” when uncertainty exists.
7. Show predictions as bands, not precise numbers.
8. Use next-action top-k, not one authoritative instruction.
9. Let users dismiss, correct, and reduce card loudness.
10. Keep the system local/private where possible.

Good wording:

Looks like you left off here.
Medium re-entry.
Likely 15–30 min work block.
Evidence: long thread · 3 interruptions · ROI engaged twice.

Bad wording:

You are distracted.
Your focus is low.
You will spend 23 minutes here.
You should do this next.

⸻

24. Final architecture summary

1. Detect return
   User comes back to a known thread, ROI, project, file, or agent session.
2. Reconstruct lastwork
   Use WSM, ThreadState, ROI, OCR, enrichment, and agent outputs.
3. Tokenize work state
   Convert raw signals into WorkState tokens.
4. Retrieve similar states
   Use hybrid sparse + dense retrieval over prior return situations.
5. Generate candidates
   Candidate duration band, next action, support mode, related threads.
6. Score and calibrate
   LLTM/GLMM for re-entry cost, survival/conformal for duration, calibrated classifier for next action.
7. Decide UI policy
   No-op, chip, compact card, full card, what-changed card, feedback prompt.
8. Render Resume Card
   Show left-off state, re-entry tier, time band, evidence, next likely actions, changes while away.
9. Observe outcome
   Log card use, continuation, duration, dismissals, edits, feedback.
10. Update model
   Improve retrieval, calibration, personalization, and future sequence prediction.

⸻

25. Final concise thesis

Sinain should treat every return-to-thread moment as a work-resumption item. Existing WSM, ROI, interruption, enrichment, and thread-state signals become WorkState tokens. The system first retrieves similar past returns, then uses a calibrated explanatory model to estimate re-entry cost, duration band, and next likely actions. The user sees only the safe artifact: a Resume Card that says what they likely left, how big the return is, why Sinain thinks so, and how to continue.

Short version:

Generative work-state prediction, calibrated into trustworthy resume cards.

This version is ready to paste into a design doc.
