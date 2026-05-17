# Sinain Memory v2 — Local-as-First-Class Architecture

> **Default deployment uses OpenRouter** (matches sinain's current behavior).
> v2 makes the **local pipeline a first-class coequal** rather than a paranoid-mode
> opt-in. Same code paths, same fact schema, same retrieval surface — the only
> variable is which model runs at each LLM consumption point. Users with the
> hardware get local-only; others stay on OpenRouter; both produce
> indistinguishable downstream artifacts.

## Origin

This design supersedes `memory-service-redesign.md` (May 14, 2026). That doc
proposed a parameter API + Phase 1-5 augmentations on top of the existing
pipeline. Two weeks of LongMemEval iteration revealed two things:

1. The cloud-distiller + RRF-retrieval baseline tops out at ~22% paper-aligned
   accuracy. Reaching the published 50-65% baseline range (let alone Hindsight's
   95%) requires structural changes, not incremental tuning.
2. Competitor analysis (Hindsight, Mem0, Graphiti) confirmed: temporal grounding,
   multi-pass extraction, and entity-resolution-as-first-class deliver the
   accuracy. The session-end consolidation pattern is wrong for ambient capture.

Constraints that shape this redesign:
- **Local-first**: no server-side strong models. All inference on-device.
- **Ambient continuous capture**: no `session.end()` boundary. Triggers are
  event-driven (sense_client change events, audio VAD).
- **Apple Silicon primary target**: MLX optimization is table-stakes.
- **Bundle-shippable**: models ship via npm/Flutter distribution.
- **Privacy-preserving**: no fact ever leaves the user's machine by default.

## Architecture target

```
┌─────────────────────────────────────────────────────────────────────┐
│ L1 — Capture (unchanged)                                            │
│   sck-capture: ScreenCaptureKit → audio PCM + screen frames        │
│   sense_client: SSIM change detection + ROI extraction              │
│   privacy: <private> tag stripping + auto-redaction at edge         │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ event-driven (frame change OR audio VAD)
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ L2 — Local perception                                               │
│   Vision: Gemma 4 E4B-it via MLX → OCR + scene description          │
│   ASR:    whisper.cpp → transcribed speech segments                 │
│   Output: perceived events with timestamps to buffered stream       │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ buffer-fill OR N-second timeout
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ L3 — Streaming extraction (Tier 1)                                  │
│   Local LLM: Qwen3.5-9B-Instruct via Ollama (MLX backend)           │
│   Output: typed facts with mentioned_at always set,                 │
│           occurred_start when relative dates detected                │
│   Entity resolution: continuous via aliases table                   │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ assert into triplestore
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ L4 — Incremental consolidation (Tier 2, event-driven)               │
│   Trigger: per-entity fact-count crosses threshold (≥3) OR          │
│            contradiction heuristic detects same entity + conflict   │
│   Local LLM: shares weights with L3 (Qwen3.5-9B-Instruct)           │
│   Scope: ≤10 facts about ONE entity                                 │
│   Action: dedupe / state-update / contradict / independent          │
│   Cost: ~2s of inference per trigger, runs in background pool       │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ L5 — Storage (local SQLite, unchanged surface)                      │
│   Triplestore EAV + FTS5 (today's design)                           │
│   + three-timestamp model (occurred_start, occurred_end,            │
│     mentioned_at) — populated this time                             │
│   + entity_aliases + entity_cooccurrence (today's tables)           │
│   + local HNSW index via hnswlib (~5MB, bundled)                   │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ L6 — Retrieval                                                      │
│   Multi-strategy: FTS5 + HNSW + graph + temporal filter             │
│   RRF fusion                                                        │
│   Cross-encoder rerank (ms-marco-MiniLM-L6 ONNX, ~22MB bundled)     │
│   Question-typed candidate pool sizing                              │
│   Parameter API: precision_mode / temporal_mode / hop_depth / etc   │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ L7 — MCP API (Phase 4 surface, unchanged contract)                  │
│   sinain_knowledge_query with parameter API                         │
│   format adapters (facts / triples / structured / narrative)        │
│   consuming agents: Claude Code, Cursor, OpenClaw — cloud-class OK  │
└─────────────────────────────────────────────────────────────────────┘
```

## Model choices (May 2026 verified)

| Layer | Model | Size (Q4) | License | Why |
|---|---|---|---|---|
| L2 Vision | **Gemma 4 E4B-it** | ~3.5 GB | Gemma Terms (Apache-equivalent commercial) | MLX day-0, Russian/Cyrillic, scene-description tuning, OCR strong on UI patches |
| L3 Extraction | **Qwen3.5-9B-Instruct** | ~5.2 GB | Apache 2.0 | Strong JSON adherence, multilingual, Ollama 0.19 MLX backend gives +93% decode |
| L4 Consolidation | **Same as L3** (shared weights) | — | Apache 2.0 | Avoids second cold-start; bounded context |
| L6 Rerank (default) | **ms-marco-MiniLM-L-6-v2** (int8 ONNX) | ~22 MB | Apache 2.0 | Fits 50MB bundle, ~30-60ms for 30 pairs on Apple Silicon |
| L6 Rerank (multilingual opt-in) | jina-reranker-v2-base-multilingual | ~280 MB | Apache 2.0 | Cyrillic + 100 languages; first-use download, not bundled |

**Hardware tiers:**
- M1/M2 base 8GB: ship Gemma 4 E2B + Qwen3.5-4B (smaller variants)
- M1-M3 16GB: default stack as above
- M3 Max / M4 Pro 32GB+: opt-in Gemma 4 26B-A4B MoE for L3

Runtime feature-detection picks the right tier; single bundle ships all variants.

## What changes vs current sinain

| Today (v1) | v2 (this design) |
|---|---|
| OpenRouter for vision OCR | Local Gemma 4 E4B-it via MLX |
| OpenRouter for distillation (gemini-flash-lite) | Local Qwen3.5-9B-Instruct via Ollama |
| Session-end / buffer-fill consolidation (mostly unused) | Per-entity event-triggered consolidation |
| Bi-encoder rerank (Phase 3 cross-encoder dormant) | Cross-encoder always-on, MiniLM-L6 bundled |
| Temporal columns exist but NULL | L3 distiller required to emit, L4 fills occurred_end |
| Cooccurrence recorded but unused | Used by L4 contradiction-detection heuristic |
| Cloud QA expected | Cloud QA still consumed by external agents (Claude Code etc); local pipeline produces facts |

## What stays

- **Capture pipeline** (L1) — sinain's real moat, unchanged
- **MCP exposure** (Phase 4) — parameter API contract
- **Triplestore EAV + FTS5** (Phase 1 schema) — three-timestamp columns become canonical
- **Privacy at edge** — `<private>` stripping, regex redaction
- **HUD invisible overlay** — UX moat
- **Eval methodology** — paper-aligned judge, deterministic temperature=0

## Phased rollout

### Phase A — Local model evaluation (Track A, 1-2 weeks)

Two eval surfaces run in parallel, serving different purposes:

**Public-facing benchmark: LongMemEval-S (500q, paper-aligned)**

This is the number we **report externally** for comparisons against Hindsight,
Mem0, A-Mem, LangMem, etc. Methodology is already established (see
`eval/benchmarks/longmemeval_adapter.py`):

- GPT-4o judge, paper-aligned binary rubric (CORRECT / PARTIAL / INCORRECT)
- Deterministic QA (temperature=0)
- Per-category accuracy + overall
- LongMemEval-S 500 questions
- Each candidate L3 model swapped in, full re-ingestion, full re-judge
- Target: 50-65% (paper-baseline parity)

**Internal-only ground truth: al-futaim capture set (DO NOT EXTERNALIZE)**

This is sinain's **private eval set** — never published, never used in
comparison reports, never shared. It tests the actual capture-to-fact
pipeline at sinain's natural granularity (real audio, multi-speaker
dialogue, real domain entities), which LongMemEval's synthetic
text-only conversations cannot exercise.

- **Data**: real recorded JetBrains meeting (~30 min, multi-speaker prep
  discussion). Contains live business context; remains confidential.
- **Source paths** (operator machines only, do not commit, do not export):
  - Video: `~/Desktop/compressed_720p/al-futaim prep.mp4`
  - Transcript: ResearchOps SpeechKit export (scratch file, local-only)
- **Methodology**: play video → sinain capture pipeline runs end-to-end →
  compare extracted facts against expected facts from the transcript.
- **Scoring**: per-model recall on a fixed internal set of ~30 ground-truth
  facts derivable from the meeting. Also measure: false-positive rate
  (hallucinated facts), latency per buffer-fill, total cost per session.
- **Storage**: scores live in a private `.planning/eval-internal/` directory,
  gitignored.
- **Why it's load-bearing internally**: LongMemEval is synthetic text and
  doesn't test our audio + screen capture path, our multi-speaker handling,
  or our Russian/English code-switching. al-futaim does. A model that
  scores well on LongMemEval but loses Citibank/IntelliJ/Singapore from
  the al-futaim transcript is unfit for sinain's production.

**Phase A tasks (run both eval surfaces, every candidate stack):**

1. Build the bench harness: pluggable model adapter, runs against both eval
   surfaces (public LongMemEval-S + private al-futaim).
2. Score per-model on each surface. Report LongMemEval numbers in public
   docs / commits; report al-futaim numbers only in `.planning/eval-internal/`.
3. Validate Mistral Small 4 specs (size + license) as an L3 alternative.
4. Decide: Gemma 4 E4B vs Qwen3-VL-4B for L2; Qwen3.5-9B vs Mistral Small 4 for L3.

Exit criteria: a `model-choices.md` document with public LongMemEval scores
+ a private notes-only reference to al-futaim performance, hardware-tier
mapping, and verified winners + fallback chains.

### Phase B — Local perception layer (Track B.1, ~1 week after Phase A)

1. Add Ollama integration to sinain-core (or extend existing paranoid-mode Ollama path).
2. Replace `sense_client/vision.py` OpenRouter call with local Gemma 4 E4B call.
3. Replace `session_distiller.py` OpenRouter call with local Qwen3.5-9B call.
4. Keep cloud fallback configurable for users with weak hardware.

Exit criteria: end-to-end capture → distillation runs without OpenRouter,
producing facts at parity with today's output. Existing LongMemEval pipeline
runs against the new local distillation.

### Phase C — Per-entity consolidation (Track B.2, ~2 weeks)

1. New module `entity_consolidator.py` — listens for fact-arrival events.
2. Per-entity trigger logic: count threshold (≥3 facts) + contradiction
   heuristic (same entity, conflicting predicate).
3. Background task pool — consolidation never blocks ingestion.
4. Wire into integrator: every successful assert publishes an event, the
   consolidator subscribes.
5. Use cooccurrence + alias tables (already exist) as input signals.

Exit criteria: re-run LongMemEval and beat today's 22% baseline. Target: 35-50%.

### Phase D — Retrieval upgrades (Track B.3, ~1 week)

1. Ship `ms-marco-MiniLM-L-6-v2` int8 ONNX in the npm bundle.
2. Wire cross-encoder rerank into default profile (not opt-in).
3. Add local HNSW index via `hnswlib` for vector retrieval.
4. Implement question-typed routing (counting → wide pool, lookup → narrow).
5. Boost facts by `mentioned_at` recency in default ranking.
6. Boost facts about entities mentioned in the query (entity-first retrieval).
7. Cooccurrence-weighted second-pass boost.

Exit criteria: incremental retrieval improvements lift LongMemEval another
10-15 points. Target: 50-65% (paper-baseline territory).

### Phase E — Polish & MCP exposure (Track B.4, ~1 week)

1. Expose new local-first parameters via MCP `sinain_knowledge_query`.
2. Format adapters: `structured` format with provenance + temporal anchors for
   escalation consumers.
3. Document hardware tiers for users.
4. Ship.

## Open questions

1. **Mistral Small 4 viability** — could replace Qwen3.5-9B if specs are better.
   Need verification.
2. **L4 trigger frequency tuning** — too aggressive (every fact) wastes compute;
   too lax (every N facts) misses contradictions. Heuristic + telemetry required.
3. **Cross-platform Ollama distribution** — npm bundle assumes Ollama is
   user-installed or sinain bundles a binary. Decision needed.
4. **Russian/Cyrillic rerank** — opt-in download is the answer, but UX of
   "download 280MB first time you query in Russian" needs design.
5. **Pro-tier opt-in for larger MoE** — does this fit sinain's distribution
   model? (Free local first, then optional download for big-RAM users.)

## Success criteria

| Metric | Today | v2 target | Hindsight reference |
|---|---|---|---|
| LongMemEval-S accuracy (strict, paper judge) | 22.4% | 50-65% | ~95% |
| LongMemEval-S accuracy (lenient) | 24.7% | 55-70% | ~95% |
| Distillation cost per active hour | ~$0.05 (cloud) | $0 (local) | N/A |
| End-to-end privacy (zero cloud) | No (vision OCR is cloud) | Yes | No |
| Bundle size | ~50MB (npm) | ~9 GB models + 50MB code | N/A |

The 85% target from the Hindsight comparison is not realistic on a
fully-local stack with current open models. **The realistic, defensible v2
target is paper-baseline parity (50-65%) with zero cloud dependency.** That's
a different product from Hindsight — and a better one for sinain's positioning.

## Final note

This design treats sinain's continuous ambient capture as the constraint that
defines the architecture, rather than as a bolt-on to a memory-system pattern
borrowed from elsewhere. Hindsight, Mem0, and Graphiti all assume "caller
decides when to add." Sinain doesn't have that caller. The event-driven
streaming + per-entity consolidation pattern proposed here is the architectural
innovation that emerges when you take ambient capture seriously.
