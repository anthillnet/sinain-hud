# DESIGN: Memory System v2 — Audit & Architectural Redesign

Status: PROPOSAL (2026-07-02). Companion to DESIGN-WORK-STATE-MODEL.md, DESIGN-WSM-SIGNAL-INVENTORY.md.

## 0. Why

Four converging failures of the current memory system:

1. **Junk facts.** The store fills with non-durable observations ("Working in zed on
   memory system redesign for hackathon project", "The user was browsing X on Chrome",
   `fact:user-* | "already"`). 342/890 facts in the live store are `kind=verbatim`.
2. **Spin-up crashes and total memory loss.** Startup-time distillation of
   `pending-session.json` stacks 4–5 Python spawns against the kg_daemon, prior_builder,
   ONNX load, and any buffer-full incremental distillation — all contending for one
   exclusive RocksDB write lock. `~/.sinain/memory` contains **11
   `knowledge-graph.db.corrupt-*` quarantines from Jun 24 – Jul 1**; the recovery path
   starts a fresh empty store, so every corruption event erases all accumulated memory.
3. **Cannot summarize the dialogue that just happened.** Episodic artifacts exist
   (`session-digests.jsonl`, raw-chunks, verbatim facts) but every production read
   surface filters them out or never reads them. The chat sidecar's context tops out at
   30 audio entries / 2,000 transcript chars; the feed ring holds ~8–10 minutes.
4. **Mismatch with WSM/Athium.** WSM needs per-thread/per-session episodic memory,
   project-grade entities, and sub-second warm retrieval. The KG offers per-topic facts,
   entities so noisy that `prior_builder.py` carries a ~90-entry blocklist, and 5–10s
   cold queries. WSM consequently grew a **shadow memory system**
   (`workstate-returns.jsonl`, `workstate-history.jsonl`, `workstate-threads.json`,
   `lastWork` snapshots) entirely outside the KG.

## 1. Audit findings (current system)

Full agent audit 2026-07-02; file references verified against `feat/wsm-attention-cockpit`.

### 1.1 What actually exists

- Store is **Oxigraph/RocksDB** (`rdf_store.py`), not the SQLite EAV + FTS5 that
  CLAUDE.md describes (stale docs). "FTS" is an in-memory Python inverted index rebuilt
  from all value-triples on first use, per process.
- Write pipeline per distillation: `session_distiller.py` (1 LLM call) →
  `knowledge_integrator.py` (deterministic) → `reconstruct.py` (1 more LLM call) →
  `prior_builder.py` (throttled). Each is a fresh `execFile` Python spawn; the
  integrator reloads a local SentenceTransformer every run and scans the **464 MB**
  `raw-chunks.jsonl` just to count lines before appending.
- Triggers: buffer-full (~every 100s of active audio), shutdown, and **startup +5s**
  for pending sessions (`index.ts:2706-2717`).

### 1.2 Root causes per symptom

**Junk facts** — five compounding causes:
- Distiller prompt is a recall maximizer ("breadth over depth", enumerate everything;
  tuned for LongMemEval) with **no durability criterion** (`session_distiller.py:120-165`).
- The only salience gate (`knowledge_integrator.py:688-809`) drops generic non-user
  facts; "user is doing X in app Y" passes by design.
- Top-20 verbatim audio quotes auto-asserted **every batch at confidence 0.95**, agent
  responses at 0.8 (`knowledge_integrator.py:1259-1302`).
- **~80% batch overlap**: buffer-full re-arms after 20 new items but distills the whole
  100-item snapshot; audio items aren't watermark-filtered (`local-curation.ts:216-225`).
  Dedup converts the overlap into reinforcement inflation — the playbook contains
  `"The user executed 'npm run build' multiple times. (seen 2259)"`.
- Confidence decay (60-day) exists but the default read floor is 0.0 and `gc()` is
  never called — nothing is ever forgotten.

**Spin-up crashes** — lock contention by architecture:
- Multiple processes open the store **writable**, including logical readers
  (`asr_nec.py:116`; fallback `graph_query.py` spawns get no `SINAIN_KG_READONLY`).
- Startup pending-distillation can overlap the next buffer-full distillation; shutdown
  awaits up to ~2.5 min of distillation, inside which `start.sh` `pkill -9` lands
  mid-RocksDB-write → corruption → quarantine → **fresh empty store**.
- `pending-session.json` is deleted *before* distilling, so a crash mid-distill silently
  loses the session. Transcripts passed as a single argv risk ARG_MAX spawn failures.

**No recent-dialogue summary** — episodic layer is write-only:
- `session-digests.jsonl` (7.1 MB) has **no reader anywhere** in the codebase.
- The production read path explicitly filters `kind=verbatim` and session-digest facts
  (`index.ts:260-274`); raw-chunk excerpts are disabled on the hot path (`--no-raw-excerpts`).

**WSM mismatch** (see DESIGN-WSM-SIGNAL-INVENTORY.md §2):
- Topic ≠ thread session; facts are only distillation-fresh; entities describe surfaces
  ("chrome", "zsh") not projects; topic matching at ~0.37 sim mislabeled threads, so
  thread identity was demoted to structural window-title parsing.
- `temporal_mode`/`as_of` accepted but not honored; slot supersession env-gated OFF;
  `begin_tx/commit_tx` are no-op stubs.

### 1.3 Cost profile

Per ~100s of active audio: 2 LLM calls (distill + recon) + SentenceTransformer load +
464 MB file scan. Plus 3 LLM scripts every 30 min. Raw-chunks grew 464 MB in ~3 weeks
(80%-duplicate transcripts with inline float-JSON embeddings); no rotation or GC anywhere.

## 2. Competitor analysis

### 2.1 Synthius-Mem (arXiv 2604.11563, LoCoMo 94.4% vs mem0 ~67%)

Persona memory as **six typed domains** (Biography, Experiences, Preferences, Social,
Work, Psychometrics), each with its own JSON schema, extraction module, deterministic
per-category consolidation, and retrieval tool. Key transferable mechanisms:
- **Salience threshold as a feature**: deliberately drops peripheral detail (accepts
  57.7% accuracy there) to protect retrieval precision and store size. Configurable.
- **Closed-world attested-fact store**: absence of evidence is a machine-readable
  refusal signal → 99.55% on false-premise questions. Vector stores can't do this.
- **Temporal data as structured fields** (dates, durations, `temporal_status` on
  preferences), not prose — their biggest win over embedding RAG was temporal
  (94.2% vs 26.8%).
- **Reversible diff engine** for memory updates (add/edit/delete + rollback).
- Plain JSON files + rule-based field matching → 21.8 ms retrieval; no vector/graph DB
  at persona scale. LLM only at extraction; consolidation is code.
- Gaps: no decay (future work), no streaming ingestion, conversational input only.

### 2.2 mem0

Vector store of extracted fact strings; ADD/UPDATE/DELETE/NOOP LLM loop at write time
(2026 OSS: ADD-only, staleness resolved at ranking). **Its production failure mode is
exactly ours**: a public 32-day audit (mem0 issue #4573) found **97.8% junk** across
10,134 memories — permissive extraction prompt, no quality gate before storage, no
REJECT action, re-extraction amplification (808 copies of one hallucinated preference).
Upgrading the model barely helped. Lessons: the gate must be structural, recalled
memories must be marked to prevent re-extraction, and there must be an explicit
REJECT/discard outcome.

### 2.3 graphiti / Zep

Bi-temporal knowledge graph in three tiers: **episodes (raw, lossless, provenance-linked)
→ entities/fact-edges → community summaries**. Contradicted facts get `invalid_at`
timestamps, never deleted; history stays queryable. **No LLM at query time** — hybrid
cosine + BM25 + graph-BFS with pluggable rerankers, ~300 ms P95. Zep's production
wrapper assembles a **"context block"** per thread (user summary + currently-valid,
thread-relevant facts with validity ranges) in <200 ms — precisely the shape of WSM's
planned resume-card query. Weakness: multi-LLM-call ingestion is slow/expensive —
mitigated by async queues, which we also need.

(All vendor LoCoMo scores are mutually discredited; we adopt mechanisms, not numbers.)

### 2.4 Gap matrix

| Mechanism | Synthius | mem0 | graphiti/Zep | Sinain today | Sinain v2 |
|---|---|---|---|---|---|
| Typed domain schemas | ✅ | ❌ | ontology opt-in | ❌ generic EAV | ✅ |
| Salience/durability gate | ✅ threshold | ❌ (97.8% junk) | partial | ❌ (junk) | ✅ two-stage + REJECT |
| Episodic tier, readable | partial | ❌ discarded | ✅ lossless | write-only | ✅ first-class |
| Bi-temporal validity | fields only | ❌ | ✅ flagship | half-built, off | ✅ on by default |
| Deterministic consolidation | ✅ | ❌ LLM loop | LLM-assisted | ✅ (keep) | ✅ |
| Query-time LLM | planner only | ❌ | ❌ | ❌ (keep) | ❌ |
| Async ingestion, single writer | n/a | ✅ platform | ✅ queue | ❌ ad-hoc spawns | ✅ memoryd |
| Forgetting/GC | ❌ | ❌ | partial | dead code | ✅ |
| Closed-world refusal | ✅ | ❌ | partial | ❌ | ✅ |

## 3. Proposed architecture

### 3.1 Shape: one resident worker, three memory tiers

```
                        ┌──────────────────────────────────────────┐
 sinain-core (Node)     │  memoryd (Python, resident, ONE process) │
 ┌───────────────┐      │                                          │
 │ feed/sense    │ enq  │  ingest queue (WAL journal on disk)      │
 │ ring buffers ─┼─────▶│    ├─ episode writer   (no LLM, instant) │
 │               │      │    ├─ distiller        (LLM, batched,    │
 │ WSM engine ◀──┼──────┤    │                    idle-scheduled)  │
 │ chat sidecar◀─┼──────┤    └─ consolidator     (deterministic)   │
 └───────────────┘ query│                                          │
      (unix socket,     │  store: Oxigraph — sole write handle     │
       sub-second)      │    T1 episodes │ T2 domains │ T3 derived │
                        └──────────────────────────────────────────┘
```

**memoryd** absorbs `kg_daemon.py` and replaces every per-distillation Python spawn
(`session_distiller`/`knowledge_integrator`/`reconstruct` become modules inside it).
It is the **only process that ever opens the store writable**. It holds the embedding
client, FTS index, and raw-chunk offsets warm. Ingestion is a durable queue: sinain-core
enqueues and forgets; a `pkill -9` can kill memoryd mid-batch and the WAL journal
replays — no corruption, no data loss, no delete-before-distill.

**Storage: keep Oxigraph — fix ownership, not the engine.** Oxigraph was a recent,
deliberate consolidation of the previous SQLite zoo; the corruption wipes are not an
engine defect but a multi-process access pattern: short-lived spawns and
readers-opened-writable contending for one exclusive RocksDB lock, with `pkill -9`
landing mid-write. Single-writer memoryd removes that class entirely, and improves
Oxigraph's other pain points for free:
- The per-process in-memory FTS rebuild happens once, warm, in memoryd (as kg_daemon
  already does).
- The no-op `begin_tx/commit_tx` stubs become real atomicity by applying each
  distillation batch as one SPARQL UPDATE — a killed batch is all-or-nothing.
- Typed domains and bi-temporal fields map onto RDF cleanly (named graph per domain,
  typed predicates); no schema pressure to leave.

The T1 episodic tier stays OUT of Oxigraph by design: high-volume raw episodes go to
append-only rotated segment files with an offset index (kills the 464 MB
scan-to-append), with episode metadata rows in the graph for provenance joins.
Embeddings move out of inline JSON into a compact binary sidecar owned by memoryd.

### 3.2 Tier 1 — Episodic (new, first-class, readable)

Append-only episode records; **no LLM required to write**:

```
episode(id, context_id, t_start, t_end, kind: session|segment|breakpoint|return,
        summary_text, transcript_ref, ocr_ref, entities[], source: audio|screen|agent,
        layers[]: work|personal|<custom>  — empty set ⇒ unclassified)
```

- Every distillation window, shutdown snapshot, and WSM breakpoint/return event writes
  an episode. WSM's shadow JSONL files (`workstate-history.jsonl`,
  `workstate-returns.jsonl`, `lastWork` snapshots) migrate here — one episodic store
  instead of two.
- Raw transcripts/OCR go to rotated, offset-indexed segment files referenced by
  `transcript_ref` (kills the 464 MB scan-to-append and 80%-duplicate storage).
- **Solves "summarize the dialogue that just happened"**: the chat sidecar gets a
  `memory_episodes(thread?, since?, until?)` tool that returns episode summaries +
  on-demand transcript slices. No ring-buffer cap, no distillation freshness dependency.
- Facts in T2 carry `episode_id` provenance (graphiti pattern) — every semantic claim
  is traceable to the moment it was observed.

### 3.3 Tier 2 — Semantic: typed domains instead of generic facts

Replace the undifferentiated `fact:*` EAV space with **five typed domains**
(Synthius pattern, adapted to an ambient work assistant):

| Domain | Contents | Primary consumer |
|---|---|---|
| `endeavors` | recurring undertakings — project, case, course, trip, engagement: context ids (§3.4), names, status, friction, decisions | WSM priors, resume cards |
| `people` | collaborators, aliases, relationships | chat, escalation |
| `preferences` | tools, workflows, likes/dislikes; `temporal_status` current/past | HUD advice, chat |
| `decisions` | atomic decisions/commitments with rationale + episode provenance | resume cards, chat |
| `procedures` | recurring workflows/routines (value-ranked, not position-truncated) — the playbook, generalized | HUD advice |

Every row carries a **persona layer set** (`layers[]`, §3.9) and is **bi-temporal**:
`valid_at, invalid_at, created_at, superseded_by`.
Contradiction = close the old row's validity window (graphiti), never delete;
supersession ON by default (currently env-gated off). `temporal_mode`/`as_of` become
real. Read path filters `invalid_at IS NULL` and applies a confidence floor.

**Entity identity**: `endeavors` entities are keyed by context ids from §3.4. The KG
no longer mints `entity:chrome`/`entity:zsh` — apps, OSes, and generic tools are
fingerprint *features*, not entities. This deletes `prior_builder.py`'s 90-entry
blocklist, the cosine-0.85 synonym merging, and the umbrella-label filters, and
re-enables KG-based thread naming that had to be demoted (`estimator.ts:12-14`).

### 3.4 Context identity — learned co-occurrence, not domain rules

Anti-overfit constraint: Sinain is a general ambient assistant, not a
software-engineering tool. Any shipped taxonomy of sources (repo → work,
IDE-window-title parsing → project, calendar → meeting) encodes *our* workflow and
breaks for a lawyer's matters, a clinician's patients, a student's courses. The WSM
extractor's `projectKey` window-title parsing is the existing instance of this
overfit; this section replaces it rather than generalizing it.

The generalizable primitive is **recurring co-occurrence structure**:

- **Deterministic, domain-blind feature extraction** per time window: app/bundle id,
  window-title *tokens* (never parsed for meaning), URL domain, participant set
  (audio speakers, meeting attendees), input-modality mix, time-of-day. All are
  observable on any platform and mean nothing by themselves.
- **Context identity = incremental clustering** over those fingerprints: a window
  joins the nearest context prototype above a similarity threshold (with hysteresis,
  as WSM thread routing already does) or mints a new context id. Contexts accrue the
  statistics prior_builder needs (recurrence, distinctDays, friction) identically
  regardless of what the context "is".
- **Names are decoration, identity is not**: contexts are lazily named by the user or
  a tier-1 LLM pass; renames never change the id.
- **Split/merge history**: context ids keep alias links so layer labels, priors and
  facts survive cluster drift, splits, and merges.
- **No shipped domain rules.** "Repo means work" is something an instance *learns*
  because its user labeled coding contexts as work — never a product default. Users
  may add personal predicates as config, but the default rule set is empty.
- **Clustering proposes, the user disposes.** Cluster assignments and layer labels
  are trial output — we will not guess it all. Every context is user-relabelable at
  any time; a manual label is permanent and the clusterer may never re-override it
  (it only proposes for unlabeled contexts). Relabeling a context re-scopes its
  episodes and facts via provenance in one operation.

Episodes carry `context_id`; `endeavors` entities anchor to context ids; WSM threads
key on context ids (replacing window-title parsing in `extractor.ts`).

### 3.5 Tier 3 — Derived

`workstate-prior.json`, community/topic summaries, daily notes — rebuilt from T1+T2 by
memoryd on idle schedule. Unchanged in role, now fed clean inputs.

### 3.6 Write path

1. **Delta-only distillation.** Watermark ALL item types (fixes the 80% overlap —
   immediate ~5x cut in LLM spend and reinforcement inflation).
2. **Two-stage quality gate** (the mem0 lesson — structural, not prompt-hoped):
   - Distiller prompt rewritten from recall-maximizer to a **durability rubric**:
     extract only what changes behavior in ≥1 week (decisions, preferences, project
     state changes, people). Current-activity narration goes to the episode summary,
     never to T2.
   - Integrator scores each candidate against its domain schema with an explicit
     **REJECT** outcome (schema mismatch, ephemeral predicate, no durable referent).
     Rejected candidates are logged (tunable threshold, Synthius-style).
   - Facts injected into LLM context are **marked as recalled** so the distiller never
     re-extracts them (mem0's 808-copy amplification bug).
3. **No verbatim auto-assertion.** Quotes live in T1 episodes; T2 confidence reflects
   evidence, not a per-kind constant.
4. **No distillation at spin-up.** Startup enqueues pending sessions at low priority;
   memoryd processes them when the queue is idle and core is warm. Episode capture at
   startup is instant (no LLM) so nothing is lost meanwhile.
5. **Consolidation stays deterministic** (our existing strength, validated by both
   Synthius and graphiti), now per-domain: dedup never merges across domains.
   Updates go through a **reversible diff log** (rollback for bad distillation batches).
6. **Retention:** decay applied at read with a real floor; weekly GC pass (compact old
   episodes into summaries, drop invalidated + fully-decayed rows, rotate segments).

### 3.7 Read path

Every read API takes a mandatory **persona scope** (§3.9); memoryd filters by layer
before ranking — scope is enforcement, not a rerank signal.

- **`get_context_block(context_id, scope)`** (Zep pattern): user summary +
  currently-valid facts for this thread + last episode summary, assembled by memoryd,
  **<300 ms warm**. This is WSM's P2 "FACTS YOU'LL NEED" resume query and the
  escalation context source.
- **`get_episodes(filter, scope)`**: recent-dialogue summaries for chat (§3.2).
- **`query(text, scope, domains?)`**: hybrid FTS + vector + entity-edge expansion, RRF
  fused, MiniLM-reranked — the existing pipeline, warm, over typed tables. No LLM at
  query time.
- **Closed-world refusal**: retrieval distinguishes "no matching fact" from "low-score
  match"; chat/HUD surface "not in memory" instead of confabulating (Synthius's
  load-bearing mechanism).

### 3.8 WSM/Athium contract (explicit)

| WSM need | v2 answer |
|---|---|
| Idiographic priors from clean endeavor entities | `endeavors` domain keyed by context ids (§3.4); prior_builder drops its blocklists |
| Sub-second resume-time facts | `get_context_block` from resident memoryd |
| Episodic per-thread sessions/gaps/returns | T1 episodes absorb the shadow JSONL store |
| Two temporal regimes, not conflated | T1 = minutes–hours (exact, no LLM); T2 = days–weeks (bi-temporal, decayed) |
| Entity anchoring of ephemeral threads (WSM §9) | context_id IS the entity key — anchoring becomes a join, not a fuzzy match; replaces `extractor.ts` window-title parsing |

**Ownership border — memory owns what happened; WSM owns what's probably happening.**
The WSM engine is not a second memory system; it is the working-memory tier: a 2.5s
control loop producing a *belief state* — probabilistic, constantly revised, honesty-
tiered. Belief states never enter the store: the store's closed-world guarantee
("only attested facts; absence of evidence ⇒ refusal") would be destroyed by
retrievable estimates. Estimates earn their way into memory only by becoming events —
a breakpoint occurred, a snapshot was frozen, a prediction was made at t and resolved
to outcome Y (itself an attested fact, and the training log the prediction roadmap
needs).

Conversely, the engine keeps **no durable state of its own**: `workstate-history/
returns/threads` JSONL and `lastWork` snapshots — grown only because the old KG
couldn't hold them — are replaced by episode events into memoryd's ingest queue
(instant, deterministic, no LLM). The engine becomes stateless across restarts,
hydrating from memory at boundaries: priors + context blocks on startup, thread
switch, and resume (a few hundred ms from warm memoryd — never on the 2.5s tick path,
which stays in-process).

This also settles the freshness question: nothing sub-minute is ever *retrieved from*
memory, because anything that fresh is working memory — the engine computed it from
the same ring buffers. T1 episodes are readable seconds after capture for any consumer
that needs "what was just said"; only typed T2 facts lag behind compaction, and no
consumer needs facts-as-facts in under a minute.

### 3.9 Persona layers

**Requirement:** memories are partitioned into persona layers — `work`, `personal`,
and user-defined others — so different clients receive different personas. A work
client (e.g. an escalation to a work-scoped agent, an MCP consumer, a shared HUD
surface) must never see personal facts, and vice versa. None of the surveyed systems
do intra-user layering (Synthius scopes per conversation participant, mem0 by
`user_id`/`agent_id`, Zep by user graph); this is our extension of their scoping
models one level down.

**Write side — layer assignment:**
- Every T1 episode and T2 row carries `layers[]` — a **set**, because a fact can
  legitimately belong to several personas at once ("meeting with Alex moved to
  Friday" can be both work and personal). Empty set ⇒ `unclassified`.
- **User signals outrank everything below:**
  - *Write-time persona pin*: a HUD toggle — "next hour is work-related" — that
    stamps every episode captured while active. Pin beats inheritance and
    propagation.
  - *Record-level relabel*: any single episode or fact can be moved between layers
    afterwards (the stray personal email captured during a pinned work hour).
    Stored as an explicit override, never as a recomputed value, so recompaction
    and re-clustering can't silently restore the wrong label.
- Automatic assignment at ingestion, cheapest signal first:
  1. **Context inheritance** (deterministic, dominant path): layers live on
     *contexts* (§3.4), the way a Wi-Fi network gets "trusted" — the user labels a
     context once when it first matters, and every episode and fact in that context
     inherits through `context_id` / `episode_id` provenance. No per-fact labeling,
     and no shipped source taxonomy (no "repo → work" defaults — that's our own
     workflow overfit; a user's instance may *learn* it from their labels).
  2. **Similarity propagation**: a new context sharing strong fingerprint features
     with a labeled one (same participant set, same URL domain) inherits its layers
     at lower confidence, pending user confirmation.
  3. **Distiller tag** as fallback: the extraction schema gains a `layers` field with
     confidence; low-confidence → empty set (`unclassified`).
- Signals are additive: a fact inheriting `work` structurally can also gain `personal`
  from the distiller tag — the union is stored.
- `unclassified` (empty set) is a **quarantine state**: visible only to the
  owner-scoped surface (the private overlay/chat), never served to any restricted
  client. Misclassification therefore fails closed.
- Entities (a person who is both colleague and friend) naturally carry the union of
  their facts' layers; a work-scoped client sees only the work-layered facts about
  them.

**Read side — enforcement, not ranking:**
- Persona scope is resolved from the *client identity*, not the query: each consumer
  (chat sidecar, HUD, escalator target, MCP client, external API token) is registered
  in memoryd with an allowed-layer set. A record is visible iff
  `layers ∩ allowed ≠ ∅` (so a work+personal fact serves to both scopes; an
  empty-set record serves only to owner scope). Scope filtering happens before
  candidate generation (FTS/vector search runs over the permitted partition only), so
  restricted content can't even influence ranking or leak via "no results for X but
  results for Y" shapes.
- Combined with §3.7's closed-world semantics: a work-scoped query about personal life
  returns the same machine-readable "no attested facts" refusal as a false premise.
- **Active-persona switching**: sinain-core holds an active persona; it defaults the
  layer of newly captured episodes (overridable by context inheritance, which wins) and
  selects the default serving scope for owner surfaces. Switching personas is a scope
  change in serving — never a data migration.
- T3 derived artifacts are built **per scope** (a work `workstate-prior.json` must not
  embed personal topic centroids); the prior file gains a scope dimension.

## 4. Migration & phasing

**P0 — Stop the bleeding (no schema change).** ✅ SHIPPED 2026-07-02 (7f13f25).
Delta-only distillation watermark; remove startup distillation (queue instead, keep
delete-after-success not before); `SINAIN_KG_READONLY` on every logical reader incl.
`asr_nec.py`; transcripts via stdin/tempfile not argv; call `gc()`; graceful-shutdown
ordering in `start.sh` (SIGTERM memoryd children before core, bounded wait).
*Exit criteria: zero corrupt-quarantines over 2 weeks; distillation LLM calls −80%.*

**P1 — memoryd + episodic tier.** ◐ IN PROGRESS — shipped 2026-07-03: memoryd
resident worker on the kg socket, journaled T1 episode capture (windows +
shutdown + WSM breakpoint/return events), /memory/episodes, chat episodes
tool (4989592, dc2c947). Remaining: T2 compaction moves in-daemon; retire
the per-spawn distillation chain.
Fold kg_daemon + distiller + integrator + reconstruct into one resident worker with a
journaled ingest queue; memoryd becomes the sole Oxigraph opener; add the T1 episode
store (segment files + metadata in the graph); ship `get_episodes` to the chat sidecar
→ **recent-dialogue summary works**. The `layer` field ships in the schema from day
one (default `unclassified`) even though assignment rules and scope enforcement land
in P2 — retrofitting the column later means reclassifying history.

**P2 — Typed domains + quality gate + bi-temporal + persona layers.**
Domain schemas, durability rubric prompt, REJECT gate, supersession on, verbatim
removal; layer assignment (context inheritance + similarity propagation + distiller
tag) and scoped read enforcement in memoryd; backfill: one-off migration distilling
the existing Oxigraph store + `session-digests.jsonl` into the new schema (the store
only holds ~1 day of facts, so the real backfill source is the JSONL sidecar files) —
backfilled rows land in `unclassified` and surface for one-time project-level
classification.

**P3 — WSM unification + context block.** ◔ STARTED — breakpoint/return
events already flow to T1 (dc2c947); side-JSONL migration + get_context_block
hydration remain.
Engine goes stateless: breakpoint/return/snapshot events flow into memoryd's ingest
queue instead of side JSONL files (one-off migration of existing
workstate-history/returns/threads into T1); engine hydrates from `get_context_block`
+ priors at startup/switch/resume; prior_builder v2 without blocklists.

**Eval harness** (before P2 ships): extend `npm run eval` with memory scenarios —
junk-rate sampling (target: <10% non-durable facts in T2, from ~40%+ today),
recent-dialogue summary fidelity, false-premise refusal, resume-card fact relevance,
temporal queries against superseded facts, and **cross-layer leakage** (adversarial
probes from a work-scoped client for known personal facts and vice versa — target:
zero leaks; `unclassified` never served to restricted scopes). Binary LLM-as-judge,
always including an adversarial category (Synthius's methodology note).

## 5. Open questions

1. **memoryd language**: Python (reuse distiller/integrator/embedding code as-is) vs
   folding into sinain-core Node (fewer processes, but rewrites the integrator).
   Proposal assumes Python behind a unix socket, mirroring kg_daemon.
2. **Vector index vs brute-force scan** — at <10⁵ facts, brute-force MiniLM cosine
   over an in-memory matrix held by memoryd is likely fine; decide by benchmark.
3. **Psychometrics-style user-model domain** (Synthius's most distinctive tier) —
   valuable for Athium's interruption-cost model (personality-calibrated τ)? Deferred;
   revisit after P3.
4. How much of `reconstruct.py` (T1-RECON) survives — its LLM pass may be redundant
   once the durability gate exists. Candidate for deletion in P2.
5. **Persona-layer granularity of episodes**: an episode (e.g. a call mixing work and
   personal topics) carries the union of its facts' layers, which makes its transcript
   slices visible to every scope in that union — a mixed call's raw transcript would
   serve to a work-scoped client. Mitigations: serve only the (scope-filtered) facts
   and summary to restricted scopes and keep raw transcript slices owner-only, or
   split episodes at layer boundaries. Proposal assumes the former.
6. **Client identity for scope resolution**: how external MCP/API clients authenticate
   to a layer set (per-token scope registry in memoryd vs. sinain-core mediating all
   access). Localhost-only today, but escalation targets already cross trust
   boundaries.
7. **Context-cluster stability** (§3.4): clustering is fuzzier than parsing a repo
   name — thresholds/hysteresis need tuning per fingerprint feature, and drift,
   splits and merges must not orphan layer labels or priors (hence alias history).
   Also the labeling UX: how the "new context — work or personal?" prompt surfaces
   (HUD card? cockpit?) and how often is tolerable. Validate on real multi-week
   fingerprint logs before P2; window-title parsing stays as the WSM fallback until
   cluster quality beats it on thread-identity accuracy.
