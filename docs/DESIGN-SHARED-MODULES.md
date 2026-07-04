# DESIGN: Shared Modules Across Surfaces

**Status:** PROPOSAL · 2026-07-03
**Scope:** sinain-hud-2 (macOS HUD) ⇄ ARSinain (browser/AR + meetbot) — and any future surface.
**Companion docs:** [DESIGN-MEMORY-V2.md](DESIGN-MEMORY-V2.md) (§3.8 multi-surface memory),
ARSinain `docs/DESIGN-DESKTOP-INTEGRATION.md` (cross-surface command vocabulary),
ARSinain `docs/DESIGN-WORKSTATE.md` (WSM port intent).

## 1. Problem

Two surfaces of the same product have grown functional twins that are forked, not shared:

| Subsystem | sinain-hud-2 | ARSinain | State |
|---|---|---|---|
| Memory | `sinain-memory/memory_v2/` + memoryd + legacy Oxigraph KG | `memory_v2/` (port of ours) + `user_memory.py` | **Same code, actively drifting.** Their `llm.py` says "replaces sinain-hud-2's `common.call_llm`" verbatim. |
| Vision providers | `sense_client/vision.py` (OpenRouter/Ollama ABC, cost extraction) | `vision.py` (Cerebras/OpenRouter, JSON mode, prefix caching) | Same role, disjoint provider features |
| Scene gating | `change_detector.py` (SSIM) | `scene_gate.py` (dHash/blur/brightness) | Different algorithms, identical purpose: "is this frame worth an LLM call" |
| Privacy | `sense_client/privacy.py` (~20 redaction regexes) | **none** | Real gap on the AR side |
| LLM provider shim | `common.py` `call_llm` + `config.ts` fallback chains | `memory_v2/llm.py` + `vision.py` provider block + `search_agent.py` | Three-plus ad-hoc copies |
| Audio | energy VAD + whisper.cpp/whisper-server/OpenRouter (TS, `sinain-core/src/audio/`) | webrtcvad + faster-whisper (Python, `talk.py`) | Same pipeline shape, different language and stacks |
| Environment agent | OpenHands sidecar (`sinain-chat-agent/`) + MCP server; legacy escalation/OpenClaw lanes (obsolete) | `search_agent.py` one-shot; meetbot Docker spawn | Sidecar is the keeper; escalation/spawn/OpenClaw are excluded from extraction and slated for removal |

Every week the memory forks stay separate, reconciliation gets more expensive. The goal is to
extract the shared substance into versioned modules with clear surface/platform seams, distributed
as libraries (pip/npm) or as APIs (resident daemons), so each surface composes them instead of
forking them.

## 2. Principles

1. **One entity owns perception per surface** — audio and video are NOT decoupled; they are two
   modalities of one sense layer, fed by surface-specific capture adapters.
2. **Libraries for logic, APIs for state.** Stateless/embeddable layers (sense, llm, protocol)
   ship as libraries. Stateful shared services (memory) ship as an API (memoryd) — this also
   solves the TS⇄Python boundary without dual implementations.
3. **Contracts first.** Where implementations must stay per-surface (audio stacks, escalator),
   the shared artifact is the versioned protocol/schema, not the code.
4. **Capture is the platform seam.** sck-capture IPC/fifo (macOS), WebRTC tracks (AR),
   PulseAudio (meetbot), mss/DXGI (Windows) stay in their surfaces; everything above the
   "frame + PCM + timestamp" line is shared.

## 3. Layer architecture

```
┌─ SURFACES (stay in their repos) ─────────────────────────────────────────┐
│ sinain-hud-2: sck-capture, capture_owner.py, overlay, sinain-core hub    │
│ ARSinain:     WebRTC server, TTS/barge-in, meetbot, entitlements         │
└───────┬──────────────────┬──────────────────┬────────────────────────────┘
        │                  │                  │
  L3 sinain-agents   L2 sinain-sense    L2 sinain-memory
  (environment       (perception:       (memory_v2 unified;
   agent: OpenHands  video gates+OCR+   memoryd API, persona
   sidecar runtime,  vision, audio      layers per
   tool packs, MCP)  VAD+transcription, DESIGN-MEMORY-V2 §3.8)
        │             privacy, /sense)        │
        └──────────────────┼──────────────────┘
                 L1 sinain-llm
                 (provider shim: OpenRouter/Cerebras/Ollama,
                  fallback chains, JSON mode, usage/cost extraction)
                           │
                 L0 sinain-protocol
                 (versioned schemas → generated TS + Python types:
                  SenseEvent incl. transcript, /sense, /embed, memoryd ops,
                  escalation task-queue, WS command vocabulary, Episode/Fact)
```

### L0 `sinain-protocol` — contracts

Versioned schemas (JSON Schema source → generated TS types + Pydantic/dataclasses). Owns:

- **SenseEvent** family: `text | visual | context | transcript | motion` — the `POST /sense`
  payload including `vision_cost`/`cost_id` dedup fields.
- **`/embed`** request/response (embedding model + dims are deployment config, not constants —
  hud uses all-MiniLM-L6-v2/384 via sinain-core, ARSinain uses multilingual MiniLM-L12 in-process).
- **memoryd socket ops** (`ingest`, `episodes`, `context_block`, `health`, …) + Episode/Fact shapes.
- **Sidecar turn protocol** (from `sinain-chat-agent/sidecar.py`): request
  `{message, context:{kind, seed, source}}` / `{cancel:true}`; NDJSON event stream
  `token | tool_call | tool_result | progress | done{usage} | error`.
- **WS command vocabulary**: `message | user_command | spawn_command | fork_main |
  command{action}` — already real in `overlay/commands.ts`, reused verbatim by ARSinain's
  DESIGN-DESKTOP-INTEGRATION as the cross-surface control channel. This doc freezes it as the
  shared protocol rather than an overlay implementation detail (minus the escalation actions,
  which retire with the escalation lane).
- **Audio contracts**: capture adapter interface (16-bit PCM frames + JPEG frames, timestamps),
  `TranscriptResult`.

### L1 `sinain-llm` — provider shim (Python)

Unifies `sinain-memory/common.py::call_llm`, ARSinain `vision.py`'s provider block,
`memory_v2/llm.py`, and `search_agent.py`'s inline calls. One OpenAI-compatible client with:

- Providers: OpenRouter, Cerebras, Ollama (endpoint auto-derivation as in `config.ts`).
- Fallback model chains (port of `ANALYSIS_FALLBACK_MODELS` semantics).
- JSON mode, prefix-cache keys (Cerebras), provider routing preferences (OpenRouter `provider.order`).
- `usage.cost`/token extraction normalized to one `CostEntry` shape (feeds CostTracker / cost_id path).

The TS side (`config.ts` + analyzer fetch code) is NOT ported; it aligns by convention and by
sharing the `CostEntry`/model-name vocabulary from L0. Smallest extraction, unblocks everything.

### L2 `sinain-sense` — unified perception (Python)

One library, both modalities, instantiated per surface with injected capture adapters.

**Video path** (extraction of existing portable code):
- Scene gates behind one interface: `SsimGate` (from `change_detector.py`) and `HashGate`
  (from ARSinain `scene_gate.py` — dHash + blur + brightness). Surfaces pick per cost profile.
- `privacy.py` redaction (ARSinain gains it for free — it currently has none).
- Vision provider client (merge of both `vision.py`s, on top of L1).
- OCR backends behind `OCRResult`: Tesseract (portable), macOS Vision / WinRT (platform extras).
- `/sense` sender (from `sender.py`: retry, cost_id, ROI packaging).

**Audio path** (the TS→Python port — scoped in §5):
- VAD strategies behind one interface: `EnergyVad` (port of `pipeline.ts` adaptive-noise-floor
  endpointing — zero native deps, the default) and `WebrtcVad` (from `talk.py`).
- Segmentation: preroll ring, hangover, min/max segment, WAV framing.
- Transcription router (port of `transcription.ts`): hallucination filter, rolling-context
  prompts, entity-preservation prompt, concurrency cap; backends: OpenRouter audio (via L1),
  whisper-server HTTP, faster-whisper (subsumes whisper-cli; ARSinain already ships it).
- Transcript dedup (per-source ring + cross-stream bigram similarity, from `index.ts:1473`).

**Out of scope for the library:** TTS and barge-in (output/conversation — ARSinain surface),
the overlay, capture binaries.

### L2 `sinain-memory` — one package + memoryd API

Reconcile the two `memory_v2/` forks into one pip package; memoryd is the serving layer
(Unix socket now, optional HTTP later) exactly as DESIGN-MEMORY-V2 §3.8–3.9 already designs:
multiple registered clients (HUD, chat sidecar, escalator, MCP, external token, **ARSinain**),
each with an allowed persona-`layers[]` set enforced at candidate generation.

Fork reconciliation inputs:
- ours: memoryd daemon, narration gate, people pass, Oxigraph read-only integration;
- theirs: `user_memory.py` multi-user registry (becomes the "registered client identity"
  pattern §3.8 specifies), style persistence, multilingual embeddings, bi-temporal facts.
- Embedder becomes an interface: HTTP `/embed` client with local sentence-transformers
  fallback (`embed_client.py` already has the pattern); model/dims per deployment.

sinain-core (TS) keeps consuming memory via memoryd socket/CLI — the API mode is what makes
cross-language distribution free.

### L3 `sinain-agents` — the environment agent

The layer through which sinain **acts on and converses with the environment**. Its centerpiece
is the resident OpenHands sidecar (`sinain-chat-agent/sidecar.py`, 296 lines + `tools.py`) —
the default sinain agent — generalized from a HUD-private process into the shared package.

**Explicitly excluded (obsolete, slated for removal, NOT extracted):** the escalation and
spawn mechanics and all OpenClaw integration — `escalation/{escalator,openclaw-ws,
escalation-slot}.ts`, the `/escalation/pending`+`respond` and
`/spawn/pending`+`reply` poll queues, `sinain-agent-runner/run.sh`, the Ed25519 device-auth
handshake, `situation.update` RPC and the `SITUATION.md` delivery path, and the two MCP tools
that expose the escalation loop (`sinain_get_escalation`, `sinain_respond`).

**One kernel is salvaged before deletion — idle messages** (the last living use of the
escalation lane): the opt-in ambient chatter where sinain proactively speaks to the user.
It survives as the **ambient turn scheduler** (item 4 below); everything around it goes.

**What the package ships** (generalizing what the sidecar already proves):

1. **Sidecar runtime** — resident `Conversation` wrapper with the properties that make it
   production-grade: warm setup paid once, token streaming, turn arbitration (user turns
   preempt ambient turns; ambient turns are dropped, never queued, when the lane is busy),
   per-turn idle watchdog with lane rebuild (a wedged LLM stream can't kill the agent),
   per-turn usage deltas (cost/tokens/model) for CostTracker, provider switch
   (OpenRouter / Ollama) — to be routed through L1.
2. **Tool packs** — the `tools.py` pattern (lean registered tool surface, streaming via SINK
   into the turn's event queue) becomes a registry: the runtime is shared, the tool pack is
   the per-surface part. HUD pack: screen/knowledge/machine tools. ARSinain pack: memory,
   web search, meeting context. Memory tools speak to memoryd (L2) so every surface's agent
   shares the same knowledge substrate with persona-layer scoping.
3. **Turn seeding** — the surviving descendant of "handoff": `context:{kind, seed, source}`
   carries a portable context brief into a turn. One brief composer (privacy-redacted,
   destination-aware) feeds seeds from memoryd `context_block`, `/sense/context`, and thread
   transcripts. Replaces the escalation prompt builder and `SITUATION.md` as the way agents
   receive situational context.
4. **Ambient turn scheduler (unprompted speech)** — the policy layer deciding when sinain
   speaks WITHOUT being asked. Both surfaces already do this, each with a bespoke half:

   - *Novelty-triggered* (commenting on what's on screen): ARSinain's
     `HelpPipeline._infer` → `analyze_help` `speak` fields, gated by the
     `PROACTIVE_COOLDOWN_S` / `PROACTIVE_MAX_PER_SESSION` / `_maybe_speak` budget; the
     HUD analog is the analyzer's unprompted `hud` text pushed to the overlay on changed
     digests.
   - *Staleness-triggered* (idle chatter after prolonged silence): the HUD's idle-messages
     kernel salvaged from escalation — `scorer.ts::shouldEscalate`'s cooldown, digest dedup
     (a static screen never re-fires), and **stale override**, plus the escalator's gates
     (`escalator.ts:382-399`): opt-in toggle default OFF (persisted UI pref,
     `set_idle_messages_enabled`) and the activity-aware quiet period (user
     mid-conversation → ambient waits). Staleness is a **capability of the layer, not a
     default**: each surface enables trigger classes in its scheduler config. HUD enables
     both; ARSinain enables novelty only (unsolicited chatter into someone's ear or a live
     meeting is a different intrusion than a line on a private overlay).

   One scheduler unifies both: inputs are scene-novelty signals, the staleness clock, and
   user-activity; policy is the shared budget (cooldown, per-session cap, dedup, quiet
   period, opt-in gate); the fired turn's **producer** is either the fast analyzer path
   (cheap, novelty commentary) or a full sidecar ambient turn (stale chatter — composed via
   the brief composer, item 3, with the stale-prompt variant from `message-builder.ts:207`:
   "share a relevant insight/tip/connection, short clever joke if context is minimal, never
   describe the idle state, never NO_REPLY"). Sidecar delivery uses today's
   `runResidentChat` + `source:"escalation"` path renamed `source:"ambient"` — droppable
   when the lane is busy, preempted by user turns, superseded if a user message arrives
   mid-flight. The **output adapter** is per-surface: HUD renders text (overlay/chat),
   ARSinain speaks (TTS).
5. **One-shot async agent helper** — the `search_agent.py` pattern (fire a single-call agent
   as its own task, splice the answer back into the live stream) as a library utility on L1.
6. **Inbound MCP surface** — sinain-mcp-server minus the escalation tools: context, ROI,
   memory query/store, feed notify, health. This remains how *external* agents (Claude
   Desktop, ChatGPT) use sinain as context + memory.

**Client side:** the sidecar WS protocol lives in L0; sinain-core's existing `chatService`
(TS) is already a conforming client — it stays, but its reply path must be decoupled from
`escalator.respondHttp` as part of the escalation removal. ARSinain gains a Python client and
runs the same runtime with its own tool pack, giving the AR surface a resident environment
agent instead of only one-shot search.

**Stays surface-specific glue (not in the package):** meetbot's Docker Engine API lifecycle,
the planned WebRTC call-bridge + `HUD:` directive mapping, terminal-CLI launching.

## 4. Distribution & packaging

- **Home:** `packages/` workspace in this repo (public — architecture code is fine here; keep
  deployment/infra docs out). Each package: own `pyproject.toml`, semver, `sinain-*` names.
  Consumption starts as git-pinned pip deps (`pip install git+…@sinain-sense-v0.2.0`),
  PyPI when stable. Release series join `RELEASE_VERSIONS.json`.
- **Heavy deps are extras:** `sentence-transformers`, `faster-whisper`, `webrtcvad`, `skimage`
  → `sinain-sense[whisper]`, `sinain-memory[embed-local]` etc. (ARSinain already lazy-loads ST).
- **Nothing is packaged today** — neither repo has a single `pyproject.toml`; that's step zero.
- **npm:** `@geravant/sinain` continues to bundle sinain-core + the Python packages it needs
  (today sinain-memory; add sinain-sense when audio moves — see §5 decision).

## 5. Audio port scope (TS → Python)

The one non-trivial refactor. Current TS surface: 1,367 lines in `sinain-core/src/audio/`
(pipeline 506, transcription 344+182+194, spawners 141) + ~45 lines of dedup in `index.ts:1473`.

**Why it's smaller than it looks:**
- Process supervision (~150 lines of pipeline.ts: spawn, restart, compat retry) is NOT ported —
  `sense_client/capture_owner.py` (commit `bae20f7`) already does it for the single-owner model;
  only TCC-denial detection moves in.
- ARSinain `talk.py` donates webrtcvad, faster-whisper, and 16 kHz resampling.
- The fifo hand-off (`~/.sinain/capture/audio.pcm.fifo`, `AUDIO_CAPTURE_CMD=fifo`) already
  works, live-verified. This port is the natural second half of `bae20f7`.

**Net new Python: ~600–700 lines** (EnergyVad+segmentation ~200, transcription router+backends
~350, dedup ~50, control client ~80). Core-side: ~80 lines (transcript route + control
forwarding). Eventually deletes the 1,367 TS lines.

**The two real gaps:**
1. `/sense` gains `{type:"transcript", ts, text, audioSource, durationMs, confidence, cost?}`;
   the server routes it into the existing consumer chain — feed push, privacy `levelFor`,
   entity prefetch, agent trigger all **stay in core** (cognition, not perception).
   Transcription cost rides the existing `vision_cost`/`cost_id` dedup path.
2. **Core→sense control channel does not exist** (sense_client only POSTs; overlay
   `toggle_audio` calls `systemAudioPipeline.mute()` in-process, `overlay/commands.ts:197`).
   sense_client opens an outbound WS to core and receives control messages
   (mute/unmute/device-switch/toggles). Only genuinely new infrastructure in the port.

**Decision needed:** npm-standalone core currently does audio without Python (legacy core-owned
capture is the default; fifo is opt-in via start.sh). After the port, audio requires the sense
process. Plan: bundle sense in the npm package, keep the TS pipeline as a deprecated fallback
for one npm release series, then retire `sinain-core/src/audio/`.

**Phasing (lowest risk):**
1. Extract VAD + transcription into `sinain-sense`; **adopt in ARSinain first** (replaces
   `talk.py` internals — zero HUD disruption, validates the library on a live surface).
2. Add transcript event type + control channel to sinain-core.
3. Flip HUD dev setup (start.sh) to sense-owned audio; TS pipeline behind a flag.
4. Retire the TS audio directory in a later release series.

Estimated effort: 2–4 focused days incl. live verification. Risk concentrates in process
lifecycle edges (TCC, restarts, the separate `sck-capture --mic` process moving under
`capture_owner.py`) and npm-standalone continuity.

## 6. Extraction order

| # | Package | Why this order | First consumer win |
|---|---|---|---|
| 1 | `sinain-llm` ✅ **DONE** (2026-07-04) | Smallest; everything depends on it; kills 3+ duplicated provider blocks | One provider layer with Cerebras + fallback chains everywhere |
| 2 | `sinain-memory` | **Drift is the urgent problem** — diff the forks now, reconcile before it compounds | ARSinain becomes a memoryd client instead of a fork; persona layers land |
| 3 | `sinain-sense` (video) | Portable trio + `/sense` client is a lift-and-shift | ARSinain gets privacy redaction |
| 4 | `sinain-sense` (audio) | The §5 port; after the video half proves the package | One audio stack; talk.py shrinks to TTS/conversation |
| 5 | `sinain-agents` | Generalize the sidecar (small, self-contained) after memory/llm land, so tool packs sit on memoryd + L1 | ARSinain gets a resident environment agent; escalation/OpenClaw code deleted rather than carried |
| 0 | `sinain-protocol` | Grows alongside all of the above — each extraction freezes its contract here | — |

**Step 1 status (shipped 2026-07-04):** `packages/sinain-llm` (pyproject, 22 unit tests;
providers by model-id prefix `ollama/` / `cerebras/` / OpenRouter; strict+loose JSON modes,
fallback chains, `extra_body` passthrough for provider extensions like OpenRouter web
plugins, usage/cost extraction). Consumers wired: hud `sinain-memory/common.py` (transport
deleted — the package IS the transport; `koog-config.json` renamed `llm-config.json`;
`extract_json` single-sourced), ARSinain `memory_v2/llm.py` + `search_agent.py` (via
`sinain_llm_boot.py`: pip-installed → `SINAIN_LLM_DIR` → sibling checkout). npm bundling:
`packages/` symlink + pack-prepare + files list. ⚠️ ARSinain's requirements.txt pins
`git+https://…sinain-hud@main#subdirectory=packages/sinain-llm` — its Docker builds resolve
only after the hud packages/ extraction is merged to main.

**Step 2 scoping — memory_v2 fork diff (measured 2026-07-04):**

| File | hud / AR | Divergence | Reconciliation |
|---|---|---|---|
| `store.py` | 82/76 L | hud adds crash-tolerant journal read (skip partial trailing line) | take hud |
| `ingest.py` | 93/95 L | AR adds `first_index` (incremental ingest into a long-lived store) | merge both (trivial) |
| `retrieve.py` | 413/285 L | shared core (embedder, `_hybrid_rank`, `_BM25`, `search_episodes`) **byte-identical**; strategy split inside `search_facts`: AR = subject-join 1-hop expansion with dilution cap, hud = `person_profiles` dossier + parameterized `cos_floor` | keep shared core; ship both strategies behind retrieval config |
| `compact.py` | 787/267 L | the real fork: AR = v2-compact-1 baseline; hud = v3 pipeline (speech-act gate, JSON salvage, separate events+people passes, alias resolution, narration gate, bridge detection, `link_facts`, segment summaries) | hud becomes the package version; AR's only unique delta (model `""` → vision-provider fallthrough) is already absorbed by sinain-llm |
| `llm.py` | AR-only | — | ✅ resolved by step 1 (both surfaces on sinain-llm) |

Verdict: cheaper than feared — the substrate (store/ingest/retrieve core) is convergent;
review concentrates on `search_facts` strategy unification and adopting hud's v3 compaction
as the package default. **Sequencing:** hud's `compact.py`/`retrieve.py`/`memoryd.py` carry
uncommitted WSM-branch work — step 2 starts after that lands.

## 7. Layer APIs for external agents (ASSESSMENT — not being implemented yet)

Could each layer be exposed as an API product other agents integrate against, Twilio-style
(capability behind a versioned API + identity + metering)? Assessment per layer:

- **Memory (strongest candidate, already designed):** DESIGN-MEMORY-V2 §3.8 specifies
  memoryd as a multi-client worker with registered client identities, an *external API
  token* client class, and persona-`layers[]` scoping enforced at candidate generation —
  an API product spec in all but name. Market analog is Zep/mem0/Letta ("memory for
  agents"); the differentiator is memory fed by ambient perception and scoped by persona.
- **Sense:** "Perception API" — frames/PCM in, redacted SenseEvents out. `POST /sense` +
  the planned control channel already are this API. Bandwidth-heavy and privacy-sensitive,
  so it ships as a daemon API co-located with capture, not a third-party-hosted service.
- **Agents:** the sidecar turn protocol is already an API; for third-party agents the
  distribution channel is **MCP** — one facade whose tools fan out to the layers
  (context/sense, memory query/store, converse-with-environment-agent, feed notify).
- **LLM / protocol:** not products. L1 is commodity (OpenRouter *is* that product);
  L0 is the published contract that makes the rest consumable.

**What exists vs. what's missing (Twilio checklist):** client identity + scopes —
designed (§3.8; persona layers ≈ OAuth scopes with the *user* as granter), not built.
Metering — CostTracker + `cost_id` piping already meter per source; extend per client.
Billing/accounts — ARSinain's `entitlements/` service is the embryo. Gateway — today
three fronts (core :9500, sidecar :9610, memoryd socket); external sharing needs one
authenticated entry point.

**Topology — two deployments by design, not one:** the HUD surface is local-first
(perception and memory stay on the user's machine; the layer APIs bind to localhost).
ARSinain is **cloud by design** — its inference runs on the Cerebras API and its brain on
a VPS, so its instances of the same layers are already remote-consumable and multi-user
(per-user memory, entitlements). The layer contracts (L0) must therefore be
deployment-agnostic: same API whether the daemon sits on localhost or behind
`ar.sinain.com`; only the auth strength and network exposure differ. Memory is the layer
that most plausibly also runs hosted multi-tenant, since ARSinain already operates it
that way.

Sequencing (when/if implemented) rides the §6 extraction order: freeze L0 → memoryd
HTTP+token (§8.2) → MCP facade as the third-party channel → gateway + entitlements
integration for remote clients.

## 8. Open decisions

1. **npm audio fallback window** — how many release series keep the TS pipeline (§5).
2. **memoryd transport for remote surfaces** — Unix socket is local-only; ARSinain's VPS needs
   HTTP(S)+auth on memoryd or a per-deployment memoryd. (ARSinain is multi-user — per-user
   memory dirs — while hud memoryd is single-user; §3.8 client identity covers this, but the
   deployment topology needs choosing.)
3. **Embedding model unification** — one multilingual model everywhere vs. per-deployment
   (affects stored-embedding compatibility in memory).
4. **Schema tooling for L0** — JSON Schema + codegen vs. hand-maintained twin types with
   contract tests.
5. **Escalation/OpenClaw removal plan** — the obsolete lane is wired through core
   (`escalator.ts` ~28KB, `ESCALATION_MODE` config, scorer hooks in the agent loop, and the
   chat sidecar's reply path via `escalator.respondHttp`). Order of operations: first extract
   the ambient turn scheduler (idle messages — L3 item 4) and move reply supersession into
   chatService, then delete the rest. Decide whether that removal is a prerequisite for
   publishing `sinain-agents` (clean, recommended) or done in parallel behind a feature flag.
