# Bundled chat harness — evaluation & recommendation

Evaluating whether to **fork a permissively-licensed OSS agent harness and bundle
it into `sinain-core` for chat**, replacing the current "roster agent behind the
terminal" path to cut response latency. Status: **research complete, recommendation
proposed — no harness adopted yet.** Star counts / versions are *reported* figures
(web research, June 2026); re-verify before committing.

## 1. The problem: latency is plumbing, not inference

Today chat does **not** run in `sinain-core`. It is dispatched out to an external
agent process:

```
overlay/MCP chat → WsHandler → escalator.setUserCommand()
   → single-slot httpPending queue
   → sinain-agent/run.sh  POLLS GET /escalation/pending every 2–5s
   → invoke_agent(): fork+exec Claude Code / OpenClaude SUBPROCESS (per message)
   → MCP stdio handshake → spawns sinain-mcp-server child
   → tool loop (7 sinain MCP tools) → LLM round-trips
   → run.sh captures stdout → POST /escalation/respond
```

Citations (from a repo trace): `escalator.ts:209-231` (user command injection),
`run.sh:978-1064` (2–5s poll loop), `run.sh:262-398` (`invoke_agent` subprocess
spawn), `escalator.ts:432-488` (HTTP-vs-WS dispatch), `agents.example.json:61-64`
(`analyzer.debounceMs` default 6000).

**Latency budget, current HTTP path:**

| Stage | Cost | Removable by going in-process? |
|---|---|---|
| Analyzer debounce | 0–6 s | partly (chat can bypass) |
| Poll interval before pickup | 0–5 s | **yes — entirely** |
| Subprocess fork+exec + CLI init | 100–300 ms | **yes — entirely** |
| MCP stdio handshake | tens of ms | **yes** (in-process tool calls) |
| Knowledge enrichment (non-first) | ~5 s | tunable |
| LLM inference | 0.2–3 s | no (irreducible) |

The headline: **most of the wall-clock is structural** — poll + debounce +
spawn + handshake — and an in-process harness deletes that chain. The model
round-trip is the only irreducible cost.

## 2. Requirements a bundled chat harness must satisfy

Derived from the current system (CLAUDE.md + repo trace):

1. **Runtime fit — bundlable.** DMG already ships Node + Python + a Swift binary
   (`tools/dmg/stage-backend.sh`). A **Node/TS** harness is free to bundle (runs in
   the existing `sinain-core` process); Python = sidecar (already a proven pattern,
   higher cold-start); Rust = new toolchain + signed binary in the DMG.
2. **In-process for latency.** The whole point. Prefer a **library** (`import` and
   call) over a CLI/daemon/subprocess.
3. **Provider matrix.** OpenRouter (OpenAI-compatible) + Anthropic + Ollama +
   **arbitrary OpenAI-compatible base URL** (`config.ts`, `.env.example`). Must not
   be single-provider.
4. **Tool-calling loop + MCP.** The agent answers by calling tools. Sinain exposes
   7 MCP tools (`sinain-mcp-server/index.ts:50-214`: `sinain_get_escalation`,
   `sinain_respond`, `sinain_context`, `sinain_memory_query`, `sinain_memory_store`,
   `sinain_notify`, `sinain_health`). In-process, the harness could even call
   sinain-core functions directly and skip MCP — but MCP keeps it modular.
5. **Permissive license.** Sinain is MIT. MIT/BSD ideal; Apache-2.0 fine (NOTICE +
   attribution + patent grant); **GPL/AGPL disqualifying** for bundling.
6. **Lightweight / forkable.** "We don't want to write a harness from scratch" but
   also want *lightweight* — so a thin, strip-down-able core beats a batteries-included
   platform.

## 3. Candidate comparison

| Harness | License | Lang / runtime | In-process in Node? | MCP | Providers (OR/Anthropic/Ollama/custom) | Maturity (reported) | Fit |
|---|---|---|---|---|---|---|---|
| **Cline `@cline/sdk`** | Apache-2.0 | TS, Node ≥22 ESM | **Yes — purpose-built lib** | native | all ✔ | ~63k★, SDK v0.0.47 (pre-1.0) | **Top in-process** |
| **Open Harness** | **MIT** | TS (Vercel AI SDK) | **Yes — tiny lib** | native | all ✔ (via AI SDK) | youngest/smallest | **Lightest** |
| **Mastra** | Apache-2.0 | TS | **Yes — lib** | native | all ✔ | mature, large | Heavier, batteries-incl. |
| **opencode** | MIT | TS but **Bun-coupled** | No — daemon/HTTP by design | native | all ✔ (AI SDK) | ~175k★, daily | Sidecar daemon only |
| **Goose** | Apache-2.0 | **Rust** binary | No — binary/daemon | native (only ext mech) | all ✔ built-in | ~49k★, ~weekly | Out-of-stack, heavy |
| **OpenHands SDK** | MIT (excl. `enterprise/`) | **Python** | No — Python sidecar | first-class | all ✔ (LiteLLM) | ~77k★ app / SDK V1 | Coding-agent, Python cold-start |
| **Hermes agent** (Nous) | **MIT** | **Python** | No — CLI/gateway sidecar | yes | all ✔ | standalone | Sidecar; self-learning skills |
| **Claude Code** | **Proprietary** | — | — | — | — | — | **Not forkable** |
| **Claude Agent SDK** | wrapper open / **Commercial ToS runtime** | TS/Py | as dependency only | yes | Anthropic-centric | — | Not a clean fork target |

### Name disambiguation (you said "openclaude, hermes")
- **"openclaude"** → most likely the **Claude Code / Claude Agent SDK** family
  (informally "open Claude"). **Not a viable fork target**: Claude Code is
  proprietary ("All rights reserved", Anthropic Commercial Terms); the Agent SDK
  is an SDK bound to Anthropic's commercial runtime, not a re-skinnable harness.
  (Community repos literally named `openclaude` exist but are immature / depend on
  proprietary Claude Code.) *Distinct from your own OpenClaw gateway.* — medium confidence.
- **"hermes"** → **NousResearch/hermes-agent** (MIT, Python, MCP, model-agnostic) —
  a *real* forkable harness, **not** the Hermes *model* (that's Llama-Community-
  licensed open-weights). Viable, but Python sidecar, not in-process TS. — high confidence.

## 4. Recommendation

**Go in-process, in TypeScript. Benchmark the three TS library candidates; do not
pick blind.** The ranking that matters for *this* product (Node/TS core, latency-
driven, lightweight, permissive):

1. **Open Harness (MIT, TS)** — the *lightest* fork: a thin tool-calling loop over
   the Vercel AI SDK with MCP built in. Gives you the pre-built loop you didn't want
   to write, with the least baggage to strip. **Risk: youngest/smallest project —
   audit its maturity and be ready to own it (it's small enough to fully absorb).**
2. **Cline `@cline/sdk` (Apache-2.0, TS)** — the most *capable* in-process lib;
   `new Agent({tools}).run()` runs in your process, all providers, native MCP,
   custom tool injection. **Risk: pre-1.0 API churn, plus coding-agent DNA +
   telemetry/hub layers to strip for a privacy-first chat use case.**
3. **Mastra (Apache-2.0, TS)** — fallback if you want a mature, supported ecosystem
   and accept a heavier footprint; verify cold-start.

**Out-of-process fallbacks** only if in-process proves limiting: **opencode** as a
warm local daemon (MIT, but Bun), **Goose** as a warm `goosed` daemon (Apache-2.0,
Rust — adds a signed binary + Rust build), **OpenHands SDK / Hermes** as a resident
Python sidecar (reuses your existing Python-process pattern; worse cold-start than
in-process TS).

Rejected: **Claude Code / "openclaude"** (proprietary, can't bundle); **Aider**
(Python CLI, cross-language subprocess — the cost we're removing).

### Why "lightweight + in-process" outranks "most powerful"
For *chat*, the harness needs a tool-calling loop + MCP + provider routing — not a
full coding agent's file-edit/shell/browser stack or web UI. Every heavyweight
candidate (Goose, OpenHands, Cline) you'd fork primarily to **strip weight**. A
thin TS lib (Open Harness) or a strip-down of Cline gets you there with the loop
pre-built, which is exactly the stated constraint ("don't write a harness from
scratch, but keep it light").

## 5. Benchmark plan — "their modifications against each other"

To compare the shortlist on *responsiveness* (the actual decision criterion), build
one apples-to-apples harness-bench:

- **Fixtures:** same N chat prompts (mix of: no-tool answer, single-tool
  `sinain_memory_query`, multi-tool chain), same model (one fast OpenRouter model,
  e.g. a Flash/Haiku-class, pinned), same 7 sinain MCP tools wired identically.
- **Adapters:** wrap each candidate (Open Harness, Cline SDK, Mastra; + opencode
  daemon and an OpenHands/Hermes sidecar as out-of-process controls) behind one
  interface: `run(prompt) → {firstTokenMs, finalMs, toolCalls, tokens}`.
- **Metrics:**
  - **Cold-start ms** (process/lib init to ready) — the current pain point.
  - **Time-to-first-token** and **time-to-final-response** (warm).
  - **Per-tool-call overhead** (in-process vs MCP-stdio vs HTTP).
  - **Resident memory** added to `sinain-core` / sidecar RSS.
  - **Bundle delta** (added MB to the DMG).
- **Baseline:** the *current* subprocess path, so every number is a delta vs status quo.
- **Output:** a table per candidate; decision gate = lowest warm final-response +
  acceptable cold-start + smallest bundle/license cost.

This is the natural next phase and matches the request to "benchmark their
modifications against each other" — it requires building the thin adapters above,
which is a focused spike, not a full integration.

## 7. Chosen direction: resident Python sidecar

**Decided: the *runtime shape* is a resident Python sidecar (not in-process TS).
The *harness* is NOT decided — it is chosen by the bake-off in §9.** Rationale for
the runtime:
Sinain already runs Python (`sense_client`, `sinain-memory`), so a Python harness
adds **no new runtime to the DMG** and reuses an established process pattern. The
latency objection to Python only applies to *per-request spawn* — the exact
anti-pattern we're removing. Kept **resident**, the Python import cost is paid once
at boot; steady-state latency ≈ in-process TS (LLM round-trip + a sub-ms localhost
hop). This trades a few hundred MB RSS and one IPC boundary for staying entirely in
the team's existing stack.

**Non-negotiable design rule:** the sidecar is a **long-lived daemon that
sinain-core pushes to**, replacing today's `run.sh` poll-every-2–5s + fork-exec.
No per-message process spawn. No polling.

### Scope (clarified 2026-06)

- **Two chat contexts, both gain the new responsive harness:**
  - **MAIN thread** — main conversation, seeded with the current digest.
  - **ROI** — a user-selected screen region, seeded with region context
    (`/region/<id>/task`).
- **Two modes per context, only one changes:**
  - **Chat mode** → the **new responsive harness sidecar** (candidate TBD by §9
    bake-off). *This is what we build.*
  - **Terminal mode** → the **user-selected roster agent** via
    `run.sh --interactive-main` / `--interactive-region` — **unchanged.**
- **OpenClaw** is treated as **legacy/out-of-scope** ("no OpenClaw path" going
  forward). It is still referenced across ~10 `sinain-core` files; we build the new
  harness **alongside** it and do **not** remove it unless explicitly asked.
- **The harness is a full agent, not a chat box.** It must "orient itself on the
  machine on par with Claude Code" — so it keeps OpenHands' native **bash + file
  read/edit** tools (DNA we previously said to strip — *keep it*) **plus** sinain's
  own tools. This reverses §7's earlier "strip coding DNA" note for this use case.

### Tool surface the harness gets

| Source | Tools | Purpose |
|---|---|---|
| Sinain MCP (`sinain-mcp-server`) | `sinain_memory_query` / `_store`, `sinain_context` (screen OCR + audio + app history = **vision today**), `sinain_notify`, `sinain_health` | memory + situational/vision awareness |
| OpenHands native | **bash**, file read/edit, (browser optional) | machine orientation, "Claude-Code-like" |
| Generic MCP | any user-configured MCP server | extensibility |

*Vision note:* there is no dedicated on-demand vision tool today — screen
understanding comes through `sinain_context`'s OCR. If the harness needs to *look*
at a fresh frame with a vision model on demand, that's a small **new** sinain tool
to add (out of scope for the first cut).

### Architecture & transport (WebSocket)

Transport decision: **WebSocket** for the sinain-core ↔ sidecar link. SSE streams
tokens fine but is one-directional; a bash-running, multi-step agent needs
**mid-run interrupt/cancel and follow-up input** (client→server *during* the
stream), which WS carries on one connection — and WS matches the overlay's existing
pattern, so events fan through end-to-end with one vocabulary.

```
overlay  ──WS──►  sinain-core (new ChatService)  ──WS──►  resident sinain-chat-agent (Python, warm)
   ▲                      ▲                                        │
   │   token/tool/progress frames  ◄───── relays ──────  harness agent loop (candidate)
   │   + interrupt/follow-up up                              ├─ tools: sinain MCP + bash/file + MCP
   └──────────────────────┘                                 └─ LLM ← sinain env
                                                                (OpenRouter/Anthropic/Ollama/custom)
```

The harness emits structured events (message / action / observation) via callbacks
→ the sidecar maps each to a WS frame → sinain-core relays to the overlay's existing
WS. One event vocabulary, three hops, interrupt travels back up the same socket.
**Every candidate must satisfy this same WS event contract** — that contract is the
adapter interface the bake-off (§9) implements per harness, so swapping the winner
in later is a one-adapter change.

The sidecar holds a **resident `Conversation`** (warm); sinain-core owns its
lifecycle (start at boot, health-check, restart on crash) — same supervision
`launch-backend.sh` already gives the other Python pipelines. Context (MAIN digest
or ROI region) is injected per chat turn via `send_message`.

### Candidate harnesses (decided by bake-off, §9 — not pre-picked)

The resident-sidecar runtime admits several permissive, MCP-capable, Python
harnesses. We compare them empirically rather than choosing on paper. Leading
candidates and their *shape* (which predicts integration cost, not winner):

| Harness | License | Form | MCP | Providers | Notes |
|---|---|---|---|---|---|
| **OpenHands SDK** | MIT | **library** (`Conversation`) | first-class | LiteLLM (all) | embeds cleanly; coding+bash DNA = asset here; young V1 API |
| **Hermes agent** (Nous) | MIT | CLI + gateway app | yes | broad | self-learning skills (nondeterminism to govern); more to adopt |
| **smolagents** (HF) | Apache-2.0 | **library** (~1k LOC) | yes | broad | lightest; code-execution-centric loop |
| **gptme** | MIT | CLI + REST server | yes | OR/Anthropic/Ollama/local | personal-agent; drive via its REST server |

*Earlier OpenHands-vs-Hermes shape comparison (kept for reference, not a verdict):*

| | OpenHands `openhands-sdk` | Hermes agent (Nous) |
|---|---|---|
| Form | **Library/SDK** — `Agent`/`Conversation`/`Tool`/`LLM` primitives built to embed | Standalone **CLI + messaging gateway** app |
| Embed a resident loop | `Conversation` object held warm, driven programmatically — clean | Adopt its gateway/runtime model — more to inherit |
| Providers | LiteLLM (OpenRouter/Anthropic/Ollama/custom) — 1:1 with sinain | model-agnostic, also broad |
| Docker | **optional** (`LocalConversation` runs in-process, no container) | optional |
| Extra DNA to manage | coding tools (bash/file-edit/browser) + workspace → **strip** | **self-learning skill loop** → nondeterminism to govern |
| Maturity | ~77k★ app / SDK V1, weekly releases | smaller, standalone |

*Read-out (shape only, not a decision):* OpenHands' library form maps most directly
onto a resident-`Conversation` daemon; Hermes is more an app to adopt wholesale, with
self-learning skills a privacy-first product must constrain. This predicts
integration cost — **the bake-off decides the winner on measured latency + tool-use
quality**, not shape.

### Risks to manage (vary by candidate; OpenHands shown as example)
1. **Coding-agent DNA** — for harnesses built for software tasks (OpenHands,
   smolagents), keep bash/file (we *want* machine orientation) but ensure the default
   agent spec is chat-shaped, not workspace/task-shaped.
2. **API maturity + fork-drift** — pin a version, vendor it, track upstream cadence
   (OpenHands SDK is young V1, ~weekly releases; Hermes/smolagents differ).
3. **Resident-daemon lifecycle** — must be supervised (crash → restart, warm
   re-init) so it never silently dies and reintroduces latency. *Applies to all.*
4. **License hygiene** — e.g. don't vendor OpenHands' monorepo `enterprise/` tree
   (non-MIT); use the `openhands-sdk` package only. Check each candidate's NOTICE.

### Benchmark fixed parameters (confirmed 2026-06)
- **Candidates (6):** OpenHands SDK, Hermes, smolagents, gptme (Python) + Open
  Harness, Cline SDK (TS controls).
- **Model:** `deepseek/deepseek-v4-flash` (OpenRouter slug verified) — **a reasoning
  model**: tool-calling supported, 1M context, ~$0.098/$0.196 per M tokens. Because
  it reasons before answering, the headline latency metric is **time-to-first-
  *content*-token** (not first token), and every adapter's OpenAI-compatible client
  must handle DeepSeek `reasoning` (the `openrouter-proxy.mjs` multi-turn 400 issue).
- **Tools:** the real sinain MCP tools (memory/context-vision/notify/health) + bash/
  file — verify each candidate actually *operates* them, not just that it loads them.
- **Key:** OpenRouter key kept in a **gitignored `.env`**, never committed; rotate
  after the spike (it was pasted in plaintext).

### Benchmark scope
The §5 bench runs **each candidate as a resident sidecar against a shared baseline**
(today's subprocess path). Cold-start is now boot-once, so headline metrics are warm
time-to-first-token, time-to-final, per-tool-call overhead, and — critically —
**tool-use quality** (does it actually use memory/vision/bash to orient like Claude
Code, or stall?). The winner is adopted behind the §9 adapter contract.

## 9. Build plan (phased)

**Phase 0 — multi-candidate bake-off (pick the harness on data).** New
`sinain-chat-agent/` Python package defines ONE **adapter interface** —
`run(message, context) → async stream of {token | tool_call | tool_result |
progress | done}` plus `cancel()` — i.e. the WS event contract from §7. Implement
the adapter for each candidate (start: OpenHands SDK, Hermes; optionally smolagents,
gptme), each wired to the **same** sinain MCP tools + bash/file and the **same**
pinned fast model. A throwaway CLI runs identical fixtures against every adapter:
  - **Fixtures:** no-tool answer; single `sinain_memory_query`; `sinain_context`
    (vision/OCR) use; a bash/file machine-orientation task; a multi-tool chain.
  - **Metrics:** warm time-to-first-token, time-to-final, per-tool-call overhead,
    resident RSS, **tool-use quality** (did it orient like Claude Code?), plus
    integration friction notes per adapter.
  - **Baseline:** the current subprocess path, so every number is a delta.
  - **Gate:** pick the candidate with the best latency × tool-use quality at
    acceptable footprint/license cost. The chosen one proceeds to Phase 1 behind the
    same adapter interface (swap = one adapter).

**Phase 1 — wire MAIN chat.** Add a `ChatService` + WS endpoint in `sinain-core`;
sidecar speaks WS (token/tool/progress down, interrupt/follow-up up). Overlay's
existing WS renders the stream. Chat mode only, MAIN thread only. Terminal mode and
OpenClaw untouched.

**Phase 2 — ROI chat.** Seed the `Conversation` with region context
(`/region/<id>/task`) so chat mode works in a selected screen region too.

**Phase 3 — lifecycle + bundle.** Supervise the sidecar in `launch-backend.sh`
(boot, health-check, restart). Add `openhands-sdk` (pinned, vendored; **not** the
monorepo `enterprise/` tree) to `tools/dmg/stage-backend.sh`. Measure bundle delta.

**Phase 4 — polish.** Interrupt/cancel UX, context condensation
(`LLMSummarizingCondenser`), privacy audit of any OpenHands telemetry, optional
on-demand vision tool.

## 9d. FORK-FOUNDATION EVALUATION (we fork & build on top — not adopt a ready solution)

Decision reframed: pick the best **base to fork and enhance**, not the best out-of-box
harness. The bench numbers are now *diagnostics of each base's architecture*, not the
verdict. Axes that matter for a fork foundation:

| axis | OpenHands SDK | Hermes | Goose |
|---|---|---|---|
| License (fork+bundle) | **MIT** ✅ | **MIT** ✅ | Apache-2.0 ✅ |
| Language vs team (TS/Py/Kotlin/Swift) | **Python** — in stack, already bundled ✅ | **Python** — in stack ✅ | **Rust** — new toolchain to own ⚠️ |
| Surface we'd OWN | small, focused SDK ✅ | **huge** (gateway/LSP/skills/messaging/kanban/browser/…) ⚠️ | medium-large Rust workspace |
| Extension seams (proven firsthand) | declare `Agent.tools`, subclass `ToolDefinition`+`ToolExecutor` — built sinain tools ✅ | toolset-gating + skills + clean callbacks — patched tool-deference in **1 block** ✅ | extensions + ACP (not modified firsthand) |
| What you get FREE | clean tool-calling loop, streaming, MCP | **full agent platform** (skills, ACP, LSP, messaging gateways, kanban, computer-use) | mature MCP agent + ACP, memory |
| Build direction | **build UP** (add features to a minimal core) | **prune DOWN** (disable toolsets you don't want) | mature; prune/extend |
| Fork-maintenance cost | **low** (small, Python, declare-everything) | **high** (large surface, fast upstream) | **high** (Rust, not in stack) |
| Bundle/runtime cost | in-process Python, **0 new runtime** | Python sidecar, 0 new runtime | **new Rust binary** in DMG |

**Firsthand modifiability evidence (the key fork signal):** I extended *both* Python
bases trivially — built sinain tools as OpenHands `ToolDefinition`s, and fixed Hermes'
tool-competition with a single `disabled_toolsets` block in `_make_agent`. Both have
clean seams. Goose I drove (ACP) but did not modify (Rust).

**The real question is build-direction, not "which is better":**
- **OpenHands** = fork a **minimal, in-stack, low-maintenance core and build UP** sinain's
  exact chat agent. Best if chat stays focused and you want to own little.
- **Hermes** = fork a **feature-rich platform and prune DOWN**; its toolset-gating is a
  superb modification seam (= sinain's chat-vs-terminal mode switch for free) and you
  inherit skills/ACP/messaging toward the full chat→agent vision. Cost: you own a large
  Python surface + a maintained fork delta.
- **Goose** = only if the team will take on **Rust**; otherwise the language tax outweighs
  its maturity, regardless of the `sinain_context` timeout (which is fixable in a fork).

Both Python bases are MIT, in-stack, and proven-modifiable — so **Goose's Rust is the
main eliminator**, and OpenHands-vs-Hermes reduces to **build-up-minimal vs
prune-down-rich**, a product call about how big a codebase sinain wants to own.

## 9e. THE RESPONSIVENESS UNLOCK — fast model + reasoning OFF (2026-06-15)

"How fast can we get" — tested qwen/qwen3.5-flash-02-23 (1M ctx, tools ✓). It's *also*
a reasoning model (1291–1456 reasoning tokens by default → ~7–8s), BUT OpenRouter's
`reasoning:{enabled:false}` turns it off → **~850ms** raw call. Baseline floor (raw loop,
reasoning OFF, real sinain tools, N=3):

| fixture | ttfc / final ms | deepseek-v4-flash (reasoning) | speedup |
|---|---|---|---|
| no_tool | **601 / 806** | 12056 / 16115 | **~20×** |
| memory | 1694 / 3811 | 12772 / 41818 | ~11× |
| vision_context | 1437 / 2309 | 7603 / 12899 | ~6× |
| machine_orient | 2091 / 2729 | 11963 / 26325 | ~10× |
| multi_tool | 2308 / 3169 | 23773 / 24277 | ~8× |

**This is the decisive lever.** Sub-second first token, 0.8–4s end-to-end *with real tool
calls* — genuinely responsive chat. Two bonus wins: (1) **variance collapsed** (no_tool
range [796–886] vs the reasoning model's [10538–41196]) — so latency rankings become
reliable; (2) tool-quality still PASS, still streams. Implication: **model + reasoning-off
dwarfs harness choice for responsiveness** (lever #3 ≫ everything). Use a fast
non-reasoning chat model (qwen3.5-flash, reasoning off) for the chat path; the harness
debate (OpenHands vs Hermes) is about *capability/forkability*, not speed. NOTE: must pass
`reasoning:{enabled:false}` through whatever harness is chosen (baseline does via
`BENCH_NO_REASONING`; OpenHands/Hermes need the LiteLLM `reasoning_effort`/extra_body equivalent).

### Harnesses on the fast path (qwen3.5-flash, reasoning OFF) — sanity (N≤2), full N=3 pending
Reasoning-disable wired per harness: OpenHands `LLM(litellm_extra_body={"reasoning":{"enabled":False}})`;
Hermes `_make_agent reasoning_config={"enabled":False}` (→ request `reasoning` field). Both gated by `BENCH_NO_REASONING`.

OpenHands N=3 (fast, reasoning off): no_tool 637/1289, memory 1870/2710, vision 2120/3233,
machine_orient 2066/3274, multi_tool 3679/4285 — all sub-5s, tight, pass. (The earlier 14091
memory was a one-off outlier; N=3 median is 2710.)

**Fast-path head-to-head (qwen3.5-flash, reasoning OFF, N=3, real sinain tools):**

| fixture | baseline | OpenHands | Hermes |
|---|---|---|---|
| no_tool | 601/806 | **637/1289** | 6079/6987 [6396–14489] |
| memory | 1694/3811 | **1870/2710** | 4892/30942 [21184–39337] |
| vision_context | 1437/2309 | **2120/3233** | –/37374 [6668–73570] **FAIL** |
| machine_orient | 2091/2729 | **2066/3274** | 14986/16654 |
| multi_tool | 2308/3169 | **3679/4285** | 5665/20836 |

**Reconciliation (resolves the "Hermes was faster on reasoning model" point):** both true.
On the reasoning model Hermes' memory beat OpenHands (23 vs 26s). The fast model reveals WHY
and reverses it — **Hermes' latency is step-count-bound, not reasoning-bound.** Hermes does
many steps/turn (think→tool→tool→synthesize); OpenHands does few. At ~7s/call (reasoning)
step-count was hidden and Hermes' smarter path sometimes won; at ~0.8s/call OpenHands
collapses to 1–4s (few cheap steps) while Hermes stays 7–31s (many cheap steps add up). The
fast model didn't speed Hermes up — it **exposed eagerness, not reasoning, as its cost.**
Suppressing that eagerness would undercut its value as a full agent → direct conflict.
Hermes also FAILed vision_context (choked on the 281k-char `sinain_context` payload, like Goose).

**Verdict:** **OpenHands for responsive chat** (5–11× faster, consistent, sub-5s all
fixtures — inherits the model floor because its loop is minimal). **Hermes for
full-agent/terminal mode** (step-heavy = thorough; competitive only when per-call cost is
high). Maps onto sinain's chat-vs-terminal split: OpenHands-style chat mode, Hermes-style
agent mode — if two bases are acceptable; else fork one and accept the tradeoff.

## 9b. ARCHITECTURE CONCLUSIONS — how to build/run for responsiveness + keep sinain tools

This is the real deliverable: the bake-off's purpose was to learn *how to run a harness*,
not just *which*. Evidence (deepseek-v4-flash, real sinain-core/MCP):

1. **Resident, never per-spawn — the #1 lever.** openclaude one-shot `-p` per message
   ≈ **18s/turn** (reloads Claude-Code init + MCP connections + skills every call);
   the SAME binary run **resident** (`--input-format stream-json`, one process) pays that
   **once** (setup ~9.3s) and per-turn drops to the model round-trip. This is exactly
   today's sinain chat anti-pattern (run.sh poll + fork-exec Claude/OpenClaude per message).
   **Fix the architecture before picking a harness.**
2. **Lean per-turn context — the #2 lever.** Even *resident*, openclaude stays ~16s/turn
   because Claude Code ships its ENTIRE system prompt every turn (50+ tools, all skills,
   every MCP server) → huge input tokens → slow time-to-first-token. A responsive chat
   harness must send a **minimal chat-shaped system prompt + only the tools chat needs**
   (sinain memory/context/health, + bash if "orient like Claude Code"), NOT a coding
   agent's full tool dump. This is why a lean harness (OpenHands configured minimally, or
   the raw loop) beats a kitchen-sink one on latency.
3. **Fast model for the chat path — the #3 lever.** The reasoning model alone is a ~5s
   floor + high variance; reserve reasoning models for terminal/escalation.
4. **Keep sinain tools via MCP connected ONCE at boot** (resident), reused across turns —
   openclaude already showed sinain MCP "connected"; the win is not reconnecting per spawn.
5. **Stream tokens** (partial messages / token callbacks) so first-content-token is early —
   smolagents' no-streaming (`ttfc==final`) is a UX disqualifier.

**So "how to build it":** a **resident sidecar** (Python, or via **ACP**) with MCP
connected once, a **minimal chat system prompt + only sinain tools (+bash)**, a **fast
model**, and **token streaming**. The harness *choice* matters less than these four
decisions — OpenHands SDK (resident `Conversation`, you own the prompt+toolset, it
streams) fits them best of the shippable options; openclaude/Claude-Code-grade loops are
capability-optimized, not latency-optimized, and are license-blocked anyway.

## 9c. Recommended chat toolset (from ranking openclaude's inherited 51 tools)

openclaude loaded **51 tools** (25 built-in + 26 MCP) on this machine — but ~40% are
noise it inherited from the user's `~/.claude` config (17 reddit + 2 auth stubs) or
belong to a different loop (2 sinain escalation tools), plus ~13 coding-session workflow
tools chat doesn't need. **Ship ~7 core, not 51.** Each unused tool is system-prompt
tokens = slower TTFT (lever #2 in §9b).

**KEEP (core, ~7):** `sinain_memory_query`, `sinain_context` (vision/OCR+audio+apps),
`sinain_memory_store`, `Read`, `Bash` (read-only-sandboxed), `Grep`, `Glob`.
**CONDITIONAL (add only if chat scope needs it):** `WebSearch`+`WebFetch` (answer
current-info Qs), `Edit`+`Write` (only if chat may *act*, not just answer — blurs into
terminal mode), `sinain_notify`, `AskUserQuestion`, `Skill` (if sinain ships skills).
**DROP (~15):** `sinain_get_escalation`/`sinain_respond` (escalation loop, not chat);
Cron×3, Enter/ExitPlanMode, Enter/ExitWorktree, Monitor, NotebookEdit, Task, TaskOutput,
TaskStop, TodoWrite, LSP, snip (coding-session/agentic-workflow machinery — overkill for
responsive chat). Safety: `Bash`/`Edit`/`Write` must be sandboxed (read-only or
workspace-scoped) since chat runs on the user's real machine.

**RECONSIDER — user-connected MCP connectors (this run: reddit×17, gmail, unabyss):**
NOT noise as a category — they're external **knowledge/context reach**, which is exactly
sinain's "Context OS" mission. Split them:
- **Knowledge/context connectors** (GSuite/Drive/Gmail-read, Slack, Glean, Notion,
  Calendar, unabyss): **high value** for chat — and double as **memory/distillation
  sources**, not just live tools. reddit was just *this* user's low-value instance.
- **Action/side-effect tools** (reddit create/delete/post, gmail send): conditional +
  higher risk; gate behind confirmation, exclude from read-only chat.
- **Auth stubs** (`*__authenticate`): plumbing; surface only when a connector needs (re)auth.

**The tension & the fix:** breadth (many connectors) vs lever #2 (every tool's schema is
per-turn prompt tokens → slower TTFT). Resolve with **deferred/lazy tool loading** — keep
the ~7 core always-loaded, expose connectors via an on-demand **tool-search/discovery**
meta-tool (the same pattern this very runtime uses: deferred tools fetched via ToolSearch).
That gives unlimited connector breadth at ~constant per-turn prompt cost. Caveat: the
harness must support dynamic tool discovery — eager-MCP-load harnesses (load all tools at
session start) forfeit this, so **"supports lazy/deferred tool loading" becomes a harness
selection criterion** for keeping chat fast as the user connects more MCP servers.

## 9a. Phase 0 results so far (baseline floor, 2026-06-15)

Bench built at `chat-harness-bench/` (baseline adapter = raw OpenAI tool loop = the
latency floor; 4 candidate stubs + 2 TS controls pending). Baseline against
`deepseek/deepseek-v4-flash`, sinain-core down (sinain_* tools returned MOCK, but
tool-selection still scored). Tool-use quality: **pass on every fixture** — the loop
correctly reached for `sinain_memory_query`, `sinain_context`, `sinain_health`, `bash`.

| fixture | ttfc_ms (first content) | final_ms | tool quality |
|---|---|---|---|
| no_tool | ~5000 | ~5500 | n/a |
| memory | ~15000 | ~27000 | pass |
| vision_context | ~12000 | ~14800 | pass |
| machine_orient (bash) | ~13600 | ~15600 | pass |
| multi_tool | ~14600 | ~20500 | pass |

### smolagents (implemented 2026-06-15, deepseek-v4-flash, tools MOCK)
Tool-use quality: pass on all tool fixtures (memory/context/health/bash). But two
real harness costs vs baseline: **(1) no answer streaming** — `ttfc==final` every row
(answer delivered whole via the synthetic `final_answer` tool), so the user stares at
nothing for ~14s vs baseline streaming from ~5s; **(2) over-tooling** — called
`sinain_memory_query` twice on the *no-tool* definitional question (13.9s vs 5s). setup ~0.9s.

| fixture | smolagents ttfc≈final_ms | baseline ttfc / final_ms |
|---|---|---|
| no_tool | ~13900 | ~5000 / ~5500 |
| memory | ~19100 | ~15000 / ~27000 |
| machine_orient | ~14400 | ~13600 / ~15600 |

### OpenHands SDK (implemented 2026-06-15, deepseek-v4-flash, tools MOCK)
Custom sinain tools wired as native `ToolDefinition`s (executors → `sinain_tools.dispatch`,
emit contract events); content streamed via `LocalConversation.token_callbacks` (needs
`LLM(stream=True)`). Tool-use quality: **pass on all** (memory/context/health/bash). And
unlike smolagents it **streams the answer** (ttfc < final on every row — good perceived
responsiveness). setup ~9ms (resident).

| fixture | OH ttfc_ms | OH final_ms | smolagents ttfc≈final | baseline ttfc/final |
|---|---|---|---|---|
| no_tool | 2700–8700 ⚠️ | 3000–10000 | ~13900 | ~5000/5500 |
| memory | ~26500 | ~27000 | ~19100 | ~15000/27000 |
| vision_context | ~15000 | ~16400 | — | ~12000/14800 |
| machine_orient | ~14000–17700 | ~16400–35900 ⚠️ | ~14400 | ~13600/15600 |
| multi_tool | ~14500 | ~16000 | — | ~14600/20500 |

⚠️ **High run-to-run variance** (no_tool 2.7s→8.7s; machine_orient final 16s→36s) — driven
by reasoning-token count, which varies per call. **Final numbers require averaging N≥3
runs/fixture** (runner enhancement). Single-shot ordering between harnesses is not yet reliable.

### Adapter status (2026-06-15)
- ✅ baseline (floor), ✅ smolagents, ✅ **OpenHands** — implemented + validated (in-process, main `.venv`).
- ✅ runner: **N-run averaging added** (`--runs`, default 3; reports median + range) — variance demanded it.
- ✅ `SubprocessAdapter` (NDJSON over stdio = the production WS protocol in miniature) —
  the isolation mechanism for the remaining four.
- 🟢 **ACP adapter** (`adapters/acp_adapter.py`) — **the reusable bridge** for any
  ACP-capable harness (Hermes now, Goose's `goose-acp-server` later). Real ACP
  JSON-RPC-over-stdio client: initialize / session/new (with MCP servers) / session/prompt
  + session/update streaming + auto-allow permission + fs serving. **Bridge validated**:
  round-trips with `hermes-acp` (initialize→session/new→prompt→stopReason, 0 errors).
- 🟢 **Goose (via ACP)** — **WORKING + measured** (Apache-2.0, Rust, v1.28.0, `goose acp`).
  Drives through the same ACP adapter as Hermes (proves the bridge is reusable). sinain
  tools wired via ACP `mcpServers` (the real `sinain-mcp-server`) → **tool-quality PASS**
  (it called Sinain Memory Query + Context; single-shot memory ttfc ~4.9s). setup ~0.9s.
  Needed two ACP-adapter fixes (now in): (1) `authenticate` step, (2) tool-name
  normalization — ACP `tool_call` gives a human *title* ("Sinain: Sinain Memory Query",
  "Shell", "Read") not a raw name. Full N=3 bench running.
- 🟢 **Hermes (via ACP)** — **DEBUGGED + FIXED + working** (2026-06-15).
  - **Root cause:** the user's `~/.hermes/.env` had a **stale/unfunded OpenRouter key**;
    Hermes swallowed the auth/credit failure as "no final response → empty" (bisected:
    `hermes -z` CLI also returned empty with both gemini AND deepseek → not model, not our
    ACP client). `hermes doctor` also flagged a stale root-level `provider/base_url`.
  - **Fix (non-intrusive):** isolated **`HERMES_HOME=.hermes-bench`** (copy of `~/.hermes`,
    `doctor --fix`'d, key overridden with the funded bench key, model pinned to
    `deepseek/deepseek-v4-flash`) — **never mutates the user's real `~/.hermes`**. Plus the
    ACP tool-title normalizer extended for Hermes's `mcp_sinain_*` + `terminal:` forms.
  - **Result:** streams content (`agent_message_chunk`×315) + reasoning, AND calls
    `sinain_memory_query` → **tool-quality PASS**. BUT very **agentic/slow**: memory fixture
    ~99s doing 8 tool calls (memory add/remove, recent sessions, git log, ls + sinain query).
    Capable, not snappy — a responsive-chat concern. Full N=3 running. Earlier note:
  - **TOOL-COMPETITION FIXED (2026-06-15)** — Hermes was inconsistently using its OWN
    `memory`/`session_search` toolsets instead of sinain's. Patched `_make_agent` (ACP
    session.py) to set `disabled_toolsets=["memory","session_search","skills","todo",
    "kanban","delegation","messaging","cronjob","moa"]` → Hermes now defers **exclusively**
    to `mcp_sinain_sinain_memory_query` (verified: 2 sinain calls, zero built-in memory
    calls). Hermes' **toolset system is the lever**: this is config (a small fork patch
    here; ideally `config.disabled_toolsets`). **Strategic payoff:** ONE Hermes harness,
    two toolset profiles — **lean chat** (sinain tools only, skills off) AND **full agent**
    (re-enable terminal/skills/kanban/delegation/messaging for terminal/escalation mode).
    That maps directly onto sinain's chat-vs-terminal split. Median latency (~23s memory
    @N=3) is ~on par with OpenHands (~26s); residual slowness is reasoning-model + verbose
    loop, not tool competition. Cost: the patch is a maintained fork delta.
  `initialize` advertises `authMethods` ("authenticate using configured openrouter") and
  without an ACP `authenticate` call the prompt returns `end_turn` + `usage_update` but no
  `agent_message_chunk`. **Next: add `authenticate` step.** Bonus discovered: `session/new`
  returns `availableModels` (incl. `openrouter:deepseek/deepseek-v4-flash`) → select the
  bench model PER SESSION via ACP, no need to mutate the user's `~/.hermes` default
  (which is currently `google/gemini-2.5-flash`). Hermes is already installed+configured on this machine.
- 🟡 **Cline** — full embed API discovered (recipe in `adapters/cline_ad.py`):
  `ClineCore.create({clientName,backendMode:"local"})` → `start({config:{providerId,modelId}})`
  → `subscribe(event=>)` + `send(sessionId,{type:"user_message",text})`; OpenRouter key via
  `ProviderSettingsManager`; native MCP for sinain tools. NOT ACP-native → stays a bespoke
  Node sidecar. Impl pending.
- 🔴 **Open Harness** — npm `open-harness@0.0.1-beta.1` has **empty metadata** (no description/repo);
  too immature to rely on. **Recommend dropping** from the bake-off unless a maintained
  package identity is confirmed.
- ⛔ **openclaude (Gitlawb/openclaude)** — investigated 2026-06-15. **NOT clean MIT —
  do NOT bundle.** It's a **Claude Code reskin**: LICENSE is `NOASSERTION` (GitHub) /
  "SEE LICENSE FILE" (npm); the MIT grant covers **modifications only**, the derived
  code remains **Anthropic proprietary "All rights reserved, Commercial ToS"**, and the
  repo itself states it has **no Anthropic authorization to distribute** ("evaluate your
  own legal position"). Bundling would embed unlicensed proprietary code + bind Sinain's
  runtime to Anthropic ToS. *Confirms the earlier "openclaude = Claude Code family =
  not forkable" read.*
  - Technically it ticks every functional box: TS/Node≥22, **env-driven** OpenRouter +
    `deepseek/deepseek-v4-flash` (documented), MCP support, streaming via
    `openclaude -p "<msg>" --output-format stream-json` (NDJSON) — drops into our
    `SubprocessAdapter` (per-message `-p` spawn, like today's chat path; **not** resident,
    **not** ACP). ~29k★ but 2.5 months old, ~single-maintainer, 31MB minified dist.
  - **Use only as a black-box capability REFERENCE** (measure a Claude-Code-grade loop on
    deepseek-v4-flash); if it wins on behavior, replicate with an independent harness — never ship it.
- 🟡 gptme — **wired** behind `SubprocessAdapter`
  with discovered recipes (see each `adapters/*_ad.py`); sidecar scripts not yet
  implemented. Blockers found:
  - **Dependency conflict (hard):** gptme pins `openai<2.0`; litellm (OpenHands/smolagents)
    needs `openai>=2.20` → **cannot share a venv**. Forces per-adapter isolation — which
    *validates the sidecar architecture*. `.venv-gptme` created.
  - **gptme is CLI/REST-shaped**, not a library (`chat()` drives its own stdout/confirm
    loop, returns None) — sidecar via its REST server or ToolSpec+hooks.
  - **Cline `@cline/sdk@0.0.47`**: `Agent` has run/continue/abort/subscribe, but the
    constructor config (provider/model/key/tools) is **not in the shipped d.ts/README**
    (bundled dist) — needs decompiling or GitHub SDK docs. Installed in `sidecars/ts`.
  - **Open Harness**: npm package is `0.0.1-beta.1` (very immature) — verify identity first.
- 🔜 re-run all with sinain-core UP (real tool results, not MOCK) for final numbers.

### Averaged results — N=3, deepseek-v4-flash, sinain-core UP (knowledge empty but tools real)
median ttfc / median final / [final min–max] ms. Tool-quality: **pass on all, all adapters**.

| fixture | baseline | smolagents | openhands |
|---|---|---|---|
| no_tool | 12056 / 16115 | 10487 / 10487 | **3734 / 5006** |
| memory | 12772 / 41818 | 15730 / 15730 | 25803 / 26145 |
| vision_context | 7603 / 12899 | 13382 / 13382 | 14815 / 16277 |
| machine_orient | 11963 / 26325 | 20055 / 20055 | 10988 / 22386 |
| multi_tool | 23773 / 24277 | **63039 / 63039** ⚠️ | 18695 / 19773 |

**What's robust (survives the noise):**
- **smolagents never streams** — `ttfc == final` on every row (answer delivered whole via
  its synthetic `final_answer` tool). Bad for perceived responsiveness.
- **smolagents multi-tool chains blow up** — 63s median [45–92s] vs openhands 19.8s /
  baseline 24s. Over-tooling + re-reasoning per step compounds. Robust, large signal.
- **openhands streams and handles multi-tool best**; fastest no_tool (3.7s ttfc) too.
- **All three drive sinain tools correctly** (real sinain-core, knowledge empty).

**What's NOT reliable at N=3:** raw latency ranking. Ranges overlap massively
(baseline no_tool [10.5–41s], openhands vision [6.6–32s]) — the reasoning-model +
OpenRouter latency variance swamps harness differences. Single-shot numbers earlier
(baseline no_tool ~5s) vs this batch (~16s) differ ~3× → **the model/endpoint is the
dominant, high-variance term.** Need N≥10 (or a faster/non-reasoning model) to rank latency.

**Decision read:** on *behavior* (streaming + multi-tool efficiency), **openhands >
smolagents** clearly; smolagents' no-streaming + multi-tool blowup are real
"responsive chat" disqualifiers. On *latency*, the model dominates — pick a fast model
for the chat path and choose the harness on tool discipline + streaming, where
OpenHands leads so far. (gptme/Cline/Open Harness still pending; may change the picture.)

### Findings (single-shot; superseded by averaged table above)
- **OpenHands strongest on behavior:** streams the answer (ttfc < final) AND uses every
  tool correctly — matches its clean-library shape. **smolagents: no streaming + over-tools.**
- **Latency is model-bound + high-variance** (no_tool 2.7s↔8.7s across runs) → averaging
  required; single-shot can't rank.
- **Integration cost is a real axis:** in-process (smolagents/openhands, just `pip install`)
  vs forced-sidecar (gptme, dep conflict) vs cross-language sidecar (TS controls). The
  bake-off surfaces this; the paper research could not.

**Headline finding — latency is model-bound, not harness-bound.** With *zero harness
overhead*, a trivial no-tool answer still takes ~5s to first content token because
the model reasons first; every tool hop triggers another reasoning pass (~10–15s to
first content, 15–27s to final). **No harness can beat this floor with this model.**
Implications:
- The bake-off across harnesses measures *overhead on top of this floor* + tool-use
  quality + integration cost — but **the dominant lever for "responsive chat" is the
  model**, not the harness.
- **Recommend a fast/non-reasoning model for the chat path** (or a reasoning-effort=low
  setting), reserving reasoning models for terminal/escalation. Re-run the bench with
  a non-reasoning model to quantify the gap.
- Harness selection should therefore optimize **tool-use quality + clean WS streaming
  + integration cost**, treating per-turn latency as a secondary (model-capped) axis.

## 10. Open questions

- **MCP vs direct calls in-process:** once the harness runs inside `sinain-core`, it
  could call knowledge/context functions directly (zero IPC) instead of via the MCP
  server. Lowest latency, but loses the clean tool boundary. Decide per-tool.
- **Chat vs escalation unification:** should the bundled harness also serve
  escalation, or only fast chat (escalation stays on OpenClaw WS)? Leaning: chat
  first, escalation unchanged, to de-risk.
- **Streaming to the overlay:** the overlay WS already streams; the harness must
  emit token/tool events to it (all TS candidates expose callbacks/streams).
- **Privacy/telemetry audit:** Cline ships telemetry + remote-config/hub layers; any
  adopted fork must be audited and stripped to honor sinain's privacy posture.
