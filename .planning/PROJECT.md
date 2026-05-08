# Sinain

## What This Is

Sinain is a **Context OS** for AI-powered work: it ambiently captures what you see and hear on your laptop, distills the stream into a private, queryable knowledge graph, and exposes that graph through four interfaces — **MCP server, HTTP API, web UI, and a screen-recording-invisible HUD overlay** — so any agent or tool you use already has the right context loaded. For AI builders, dev power-users, and anyone running modern coding agents who's hit the wall of "the model is smart, but its memory is a single chat thread."

This `.planning/` initialization is for a **public-launch milestone**: the existing system is shipped and used daily; this milestone scopes the work to take it to a general AI-builder audience over the weekend of May 9–13, 2026, modeled on OpenClaw-pattern technical-audience launches.

## Core Value

**A private, persistent knowledge graph built from ambient screen + audio capture, exposed through every interface that needs it.**

If a feature doesn't strengthen the graph or its accessibility, deprioritize. The capture is the moat (no one else has this data source). The graph is the artifact. Same graph, every interface. Lose any one channel, the pitch still works. Lose the graph itself, nothing else matters.

## Requirements

### Validated

<!-- Shipped, in production, used daily by founders. Inferred from .planning/codebase/* and yc-application.md. Locked unless explicitly invalidated. -->

- ✓ **Ambient screen + audio capture (macOS)** — `tools/sck-capture` Swift binary built on ScreenCaptureKit; single SCStream delivers both system audio (PCM → stdout) and screen frames (JPEG → IPC) — existing
- ✓ **Privacy-aware sensing pipeline** — `sense_client` runs SSIM change detection, vision OCR, `<private>` tag stripping, regex auto-redaction (credit cards, API keys, AWS keys, bearer tokens) before any data leaves the machine — existing
- ✓ **Knowledge graph: distill → integrate → store** — LLM-based `session_distiller.py` extracts `{facts, entities, decisions}`; **deterministic** (non-LLM) `knowledge_integrator.py` writes to SQLite EAV triplestore (4 covering indexes EAVT/AEVT/VAET/AVET, FTS5, confidence decay) plus entity graph — existing
- ✓ **65% relative recall uplift on public memory benchmark** (37.9% → 62.7%) — driven by moving the integration step off LLM and into deterministic graph operations; eval harness ships in-tree (`sinain-core/eval/`) and re-runs on every meaningful pipeline change — existing
- ✓ **In-process embedding service** — all-MiniLM-L6-v2 (384 dims), `POST /embed`, used for semantic dedup (write path) + retrieval re-ranking (read path) — existing
- ✓ **MCP server** — `sinain-hud-plugin/sinain-mcp-server/` exposes capture, knowledge, and escalation tools to any MCP-compatible agent — existing
- ✓ **HTTP API** — `sinain-core/src/server.ts` exposes feed, sense, embed, situation update endpoints; web UI served at `/knowledge/ui/` — existing
- ✓ **Web UI** — knowledge graph browser served by sinain-core at `/knowledge/ui/entity/<id>`; supports concept browsing, search, source/timestamp inspection — existing
- ✓ **HUD overlay (macOS)** — Flutter shell with native Swift `MainFlutterWindow`/`AppDelegate`; NSPanel `sharingType = .none` (invisible to screen capture); 4 display modes (Feed / Ticker / Alert / Hidden) + global hotkeys — existing
- ✓ **Four privacy modes** — `off` / `standard` / `strict` / `paranoid` (Ollama + whisper.cpp = zero cloud) — single env-var flip — existing
- ✓ **MCP-agnostic agent roster** — README claims tested with Claude Code, OpenClaude, Codex, Goose, Junie, Aider; `agents.json` is source of truth; per-lane agent selection (escalation vs spawn) — claim asserted, regression-test pending in Active
- ✓ **OpenClaw gateway integration** — escalation orchestrator (`sinain-core/src/escalation/`) routes high-score digests via HTTP+WebSocket to OpenClaw; `situation.update` RPC pushes SITUATION.md content; sinain-hud plugin handles server-side — existing
- ✓ **Local curation pipeline** — incremental distillation on `FeedBuffer` full (prevents data loss in long sessions); session distillation on shutdown; `pending-session.json` resume on next startup — existing
- ✓ **Cost tracking** — `CostTracker` accumulates OpenRouter `usage.cost` across analyzer / transcription / vision; broadcast over WebSocket to overlay; logged every 60s — existing
- ✓ **P2P knowledge transfer (no server)** — concept export/import via URL-fragment bundles (`docs/share.html` redirector → `localhost:9500/knowledge/ui/entity/...`); fragment never sent to any server — existing
- ✓ **npm-distributed installer** — `npx @geravant/sinain@latest start` runs interactive wizard, auto-downloads overlay + sck-capture, starts all services; published as `@geravant/sinain` v1.23.0 — existing
- ✓ **CI** — sinain-core typecheck + overlay flutter analyze + flutter test on every PR (`.github/workflows/ci.yml`); `overlay-v*` tags trigger macOS release build (`release-overlay.yml`) — existing

### Active

<!-- Launch milestone scope. All hypotheses until validated by Wed May 13 EOD success metric. -->

**Engineering readiness (target: complete by Sat May 9 PM)**

- [ ] Cold-install audit on a fresh macOS machine: `npx @geravant/sinain@latest start` reaches first knowledge-graph entry in ≤ 5 minutes, no manual fallback steps
- [ ] Verify all four channels (MCP / HTTP API / Web UI / HUD) functional and demo-grade
- [ ] Regression-test all six advertised agent integrations end-to-end (Claude Code, OpenClaude, Codex, Goose, Junie, Aider) — pre-empts the inevitable HN commenter who tries theirs and reports failure
- [ ] Verify `paranoid` mode (Ollama + whisper.cpp, zero cloud) works without OpenRouter key
- [ ] Friendly Windows blocker — detect non-macOS platform on install, surface "macOS-only for now, Windows in progress" instead of silent breakage
- [ ] README rewrite: lead with "Context OS" framing, soften Windows badge, link the 65% recall benchmark methodology
- [ ] Pre-launch security/secret pass — confirm no `.env` content, tokens, or PII surfaces in published release artifacts

**Demo production (target: complete by Sat May 9 PM)**

- [ ] Primary 90s demo recorded — adapt yc-application.md 101s "ideas filter" storyboard, swap YC-specific framing for a personal-research / past-projects flow
- [ ] Short cut (~25s) for Twitter / LinkedIn / PH gallery
- [ ] Demo hosting (Loom or self-hosted MP4 + GitHub Releases asset)

**Launch copy + assets (target: complete by Sun May 10 EOD)**

- [ ] Show HN title + first-paragraph copy (Context OS framing, 65% benchmark, four channels)
- [ ] r/LocalLLaMA post (technical depth, paranoid mode angle, P2P knowledge transfer)
- [ ] r/MachineLearning post (benchmark methodology, deterministic integrator argument)
- [ ] Twitter thread (5–7 tweets, demo clips inline)
- [ ] LinkedIn post (personal-network amplification)
- [ ] Product Hunt: tagline, gallery, first comment, hunter coordination
- [ ] Pre-written response templates for predictable HN/Reddit comment categories (privacy, comparison vs Rewind / Mem0 / Letta, performance, OS support)

**Distribution + execution**

- [ ] Sat May 9: push `overlay-v*` release tag, GitHub release published, soft Twitter + LinkedIn signal
- [ ] Mon May 11 ~9am ET: Show HN submitted, r/LocalLLaMA + r/MachineLearning posted, Twitter thread fired, LinkedIn pushed
- [ ] Mon launch-day comment monitoring + response (multi-hour staffed shift)
- [ ] Wed May 13: Product Hunt launch with hunter
- [ ] Daily metrics dashboard (HN rank, GitHub stars, install count via npm telemetry, comment-thread quality)

### Out of Scope

<!-- Explicit boundaries with reasoning to prevent re-adding. -->

- **Windows support** — deferred. 72h launch window cannot absorb cross-platform regression + bug-fix budget. Friendly blocker on install is in scope; everything beyond that is deferred to a later milestone.
- **Mobile (`sinain-mobile/`)** — deferred. Not part of launch narrative. Stays in-tree but unmentioned in public copy.
- **Enterprise / company-brain framing** — deferred to a later milestone. Audience for *this* launch is consumer/builder/dev-power-user; enterprise muddles the message and triggers procurement-shaped questions in HN/Reddit threads. yc-application.md material parked for internal use; only consumer/builder excerpts feed public copy.
- **Hosted instances / SaaS pricing** — deferred. Launch is OSS self-hosted only. Pay-and-go hosted ($10–20/mo band) is the next milestone after launch validates demand.
- **New features beyond polish + positioning** — feature freeze for the launch window. Only fixes, install-path hardening, README rewrite, demo recording, and channel-specific copy are in scope.
- **Polished consumer onboarding (`.dmg`, hand-held permission flow)** — out of scope. Dev-friendly install bar (npx + OpenRouter key + System Settings permissions) is accepted as the bar for this audience.
- **Founder video / pitch video** — out of scope. yc-application.md has a 60s founder-video script; it's YC-specific and not part of this launch.
- **PH-as-primary-channel** — out of scope. PH is the second wave (Wed); HN + Reddit + Twitter on Mon are the primary fire. Splitting attention across PH-day on Mon would dilute monitoring/response.

## Context

- **System status**: existing, shipped, used daily by founders during development. Eight components across four runtimes (TypeScript, Python, Swift, Dart) and one OS (macOS for launch); Windows code in-tree but out of scope. npm package `@geravant/sinain` at v1.23.0.
- **Codebase mapped** to `.planning/codebase/` (7 documents totaling ~2.7K lines). CONCERNS.md flagged: 28KB `escalator.ts` as a refactor candidate, race conditions in `LocalCurationService.onFull` during incremental distillation, OpenClaw WS reconnect behavior, embedding-service startup-failure modes. None block the launch but are kept visible.
- **Recent merged work** (last ~2 weeks): combined entity recall (PR #107 — AND logic + semantic expansion + topic page), overlay knowledge browser button (current feature branch), Dart `replaceFirst` `$1` backref bug fix.
- **Reference launches**: GSD (get-shit-done-cc CLI) and OpenClaw — sibling projects in the same builder lineage that achieved AI-builder-audience traction. Audience overlap with this launch is high; positioning lessons applicable.
- **Headline proof point**: 65% relative recall uplift on public memory benchmark (37.9% → 62.7%). The result was driven by *removing* LLM variance from the integration step (deterministic graph ops), not by adding model sophistication. This story plays well in r/MachineLearning.
- **Positioning bible**: `yc-application.md` (consumer/builder portion only). Enterprise sections explicitly out of scope for public copy.
- **Pitch headline**: *"Eyes and ears for your context."* / *"Personal Context OS, locally."*
- **Privacy story is non-negotiable**: 4 modes, `paranoid` = Ollama + whisper.cpp + zero cloud, HUD invisible to screen capture, P2P transfer via URL fragments (no server sees the bundle). This is *the* differentiator vs Rewind / Mem0 / Letta / Glean.

## Constraints

- **Timeline**: 72h to first launch beat (Sat May 9 PM); ~96h to peak HN attempt (Mon May 11 ~9am ET); ~120h to PH (Wed May 13). Hard deadlines, not aspirational.
- **Tech stack (launch surface)**: macOS 12.3+ only. Node 18+, Python 3.10+, Flutter, Swift. OpenRouter required by default; Ollama + whisper.cpp for paranoid mode.
- **Distribution**: OSS, MIT license, npm (`@geravant/sinain`) + GitHub Releases. No hosted/paid offering for this milestone.
- **Audience**: AI-builders, dev-power-users (r/LocalLLaMA-shaped). Comfortable with terminal + API key. Will check claims (regression-test agents, run benchmarks, audit privacy claims).
- **Channel mix**: Mon — Show HN + r/LocalLLaMA + r/MachineLearning + Twitter + LinkedIn. Wed — Product Hunt with hunter. No PH on Mon.
- **Privacy**: existing privacy story is locked. Any feature that would weaken `paranoid` mode or the screen-capture invisibility is out of scope.
- **Engineering bandwidth**: solo / small team, working through the weekend. Scope discipline matters more than ambition.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Launch model: **OpenClaw-pattern** (Show HN + r/LocalLLaMA-led, technical depth in copy, demo-driven) | Audience shape (AI builders) and product nature (multi-component, local-first, technical) match this lineage; consumer-PH-first would not land for this product | — Pending |
| **macOS-only** for launch; Windows + Mobile out of scope | 72h window cannot absorb cross-platform regression and bug-fix budget; focus reduces risk and clarifies install path | — Pending |
| Lead with **"Context OS"** framing, not "Ambient intelligence" or "Memory OS" | "Context" aligns with current LLM-ecosystem zeitgeist (context engineering); "Memory" reads Rewind-adjacent and backward-looking; "Ambient" is good but vaguer about what the artifact is | — Pending |
| **Four-channel** pitch (MCP / API / Web UI / HUD) front and center | The four-channel access is the structural differentiator vs Mem0/Letta (libraries) and Rewind/Granola (closed apps); each channel is shipped — no aspirational claims | — Pending |
| Demo anchor: **yc-application.md 101s "ideas filter" storyboard**, adapted for non-YC context | Already storyboarded with proven feature coverage (HUD modes, web UI, agent panel, MCP, knowledge graph); highest visual moat-density per second of viewer attention | — Pending |
| **Drop enterprise framing** for public copy | Audience for this launch is consumer/builder; enterprise muddles the story and triggers procurement-shaped HN comment threads; deferred to next milestone | — Pending |
| **PH = second wave** (Wed May 13), not Mon-launch primary | PH wants Tue–Thu and consumer-app shape; Mon Show HN + Reddit is primary fire; PH-on-Mon would split monitoring attention | — Pending |
| **Dev-friendly install bar** (npx + API key + permissions) for this launch | Audience comfortable with terminal; full polish to `.dmg` and hand-held onboarding deferred | — Pending |
| **Success metric**: HN top-30 for 2+ hours Mon, 1K GitHub stars by Wed EOD, PH top-5 Wed | Quantitative criteria for unambiguous hit/miss judgment; modeled on observed traction shapes for similar launches | — Pending |
| **65% benchmark as headline proof point** in HN/Reddit copy | Public, replicable, methodology-shipped-in-tree; defensible under technical-audience scrutiny; differentiates from competitor "AI memory" claims that lack measurement | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-08 after initialization*
